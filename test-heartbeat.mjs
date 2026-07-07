#!/usr/bin/env node
/**
 * test-heartbeat.mjs — unit tests for runner heartbeat + honest timeout classification.
 *
 * Tests all five checkJob classification branches:
 *   1. Fresh heartbeat             -> running  (+ elapsed, lastAlive)
 *   2. Stale beyond 4h timeout     -> timed_out
 *   3. Stale (3-4h window) + dead pid       -> died
 *   4. Stale + recycled pid (foreign image) -> died  (pidNote set)
 *   5. Legacy record (no heartbeat) + dead pid -> died
 *   6. exit_code present           -> completed (heartbeat state irrelevant)
 *   7. Stale + alive node pid (self) -> running + stalled:true
 *
 * Run: node test-heartbeat.mjs   (exit 0 = all pass)
 */
import { checkJob, JOB_ROOT, JOB_TIMEOUT_MS } from "./job-core.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---- helpers ---------------------------------------------------------------

function makeJob({ pid, heartbeatAgeMs, exitCode, noHeartbeat = false, cardId } = {}) {
  const id = `test-hb-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
  const dir = path.join(JOB_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });

  // Touch empty log files so readTail doesn't throw.
  fs.writeFileSync(path.join(dir, "out.log"), "");
  fs.writeFileSync(path.join(dir, "err.log"), "");

  const meta = {
    jobId: id,
    pid: pid ?? 99999999,
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    workFolder: JOB_ROOT,
  };
  if (cardId !== undefined) meta.cardId = cardId;
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  if (!noHeartbeat && heartbeatAgeMs !== undefined) {
    const ts = new Date(Date.now() - heartbeatAgeMs).toISOString();
    fs.writeFileSync(path.join(dir, "runner_heartbeat"), ts);
  }

  if (exitCode !== undefined) {
    fs.writeFileSync(path.join(dir, "exit_code"), String(exitCode));
  }

  return { id, dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS — ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL — ${msg}`);
    failed++;
  }
}

// ---- tests -----------------------------------------------------------------

// 1. Fresh heartbeat -> running with elapsed + lastAlive
{
  console.log("\nTest 1: fresh heartbeat -> running");
  const { id, dir } = makeJob({ heartbeatAgeMs: 30_000 }); // 30s ago
  const s = checkJob(id);
  assert(s.status === "running",   `status=running, got "${s.status}"`);
  assert(!!s.lastAlive,            `lastAlive present`);
  assert(!!s.elapsed,              `elapsed present (got "${s.elapsed}")`);
  assert(!s.stalled,               `stalled is falsy`);
  cleanup(dir);
}

// 2. Stale beyond timeout -> timed_out
{
  console.log("\nTest 2: heartbeat stale beyond timeout -> timed_out");
  const overAge = JOB_TIMEOUT_MS + 60 * 60 * 1000; // timeout + 1h
  const { id, dir } = makeJob({ heartbeatAgeMs: overAge });
  const s = checkJob(id);
  assert(s.status === "timed_out", `status=timed_out, got "${s.status}"`);
  assert(!!s.lastAlive,            `lastAlive present`);
  cleanup(dir);
}

// 3. Stale (3min–timeout) + dead pid -> died
{
  console.log("\nTest 3: stale heartbeat + dead pid -> died");
  const { id, dir } = makeJob({ heartbeatAgeMs: 10 * 60 * 1000, pid: 99999999 }); // 10min, dead pid
  const s = checkJob(id);
  assert(s.status === "died",      `status=died, got "${s.status}"`);
  assert(!!s.lastAlive,            `lastAlive present`);
  assert(!s.pidNote,               `no pidNote for dead pid case`);
  cleanup(dir);
}

// 4. Stale + recycled pid to foreign image -> died + pidNote
// On Windows we use PID 4 (System process) — alive but not node/claude.
// On POSIX we use PID 1 (init/systemd) — alive but not node/claude.
{
  console.log("\nTest 4: stale heartbeat + pid recycled to foreign image -> died");
  const foreignPid = process.platform === "win32" ? 4 : 1;
  let foreignPidAlive;
  try { process.kill(foreignPid, 0); foreignPidAlive = true; }
  catch (e) { foreignPidAlive = (e.code === "EPERM"); } // EPERM = alive but no permission

  const { id, dir } = makeJob({ heartbeatAgeMs: 10 * 60 * 1000, pid: foreignPid });
  const s = checkJob(id);

  if (!foreignPidAlive) {
    // Pid is dead -> pidAlive() returns false -> status "died" via dead-pid path (still correct)
    assert(s.status === "died", `status=died (foreign pid not alive on this OS), got "${s.status}"`);
  } else {
    // Pid alive -> recycling path: expect died+pidNote, or running+stalled if image lookup unavailable
    const acceptDied    = s.status === "died" && !!s.pidNote;
    const acceptStalled = s.status === "running" && s.stalled; // image name unknown -> benefit of doubt
    assert(acceptDied || acceptStalled,
      `status=died+pidNote or running+stalled, got status="${s.status}" pidNote="${s.pidNote}"`);
  }
  cleanup(dir);
}

// 5. Legacy record (no heartbeat file) + dead pid -> died
{
  console.log("\nTest 5: legacy record (no heartbeat) + dead pid -> died");
  const { id, dir } = makeJob({ noHeartbeat: true, pid: 99999999 });
  const s = checkJob(id);
  assert(s.status === "died",      `status=died, got "${s.status}"`);
  cleanup(dir);
}

// 6. exit_code present -> completed (heartbeat state irrelevant)
{
  console.log("\nTest 6: exit_code=0 written -> completed");
  const { id, dir } = makeJob({ heartbeatAgeMs: 10 * 60 * 1000, exitCode: 0 }); // stale hb, but completed
  const s = checkJob(id);
  assert(s.status === "completed", `status=completed, got "${s.status}"`);
  assert(s.exitCode === 0,         `exitCode=0`);
  cleanup(dir);
}

{
  console.log("\nTest 6b: exit_code=1 written -> failed");
  const { id, dir } = makeJob({ heartbeatAgeMs: 10 * 60 * 1000, exitCode: 1 });
  const s = checkJob(id);
  assert(s.status === "failed",    `status=failed, got "${s.status}"`);
  assert(s.exitCode === 1,         `exitCode=1`);
  cleanup(dir);
}

// 7. Stale + alive node pid (self) -> running + stalled:true
{
  console.log("\nTest 7: stale heartbeat + alive node pid (self) -> running+stalled");
  const { id, dir } = makeJob({ heartbeatAgeMs: 10 * 60 * 1000, pid: process.pid }); // self = alive node
  const s = checkJob(id);
  assert(s.status === "running",   `status=running, got "${s.status}"`);
  assert(s.stalled === true,       `stalled=true`);
  assert(!!s.lastAlive,            `lastAlive present`);
  assert(!!s.elapsed,              `elapsed present`);
  cleanup(dir);
}

// ---- card-reap tests -------------------------------------------------------
// Mock jobcard: logs invocation args to MOCK_CALLS_FILE; exits MOCK_FAIL (0|1).
const MOCK_SCRIPT = path.join(JOB_ROOT, "_mock_jobcard.mjs");
const MOCK_CALLS_FILE = path.join(JOB_ROOT, "_mock_calls.json");

fs.writeFileSync(MOCK_SCRIPT, [
  "import fs from 'node:fs';",
  "const cf = process.env.MOCK_CALLS_FILE;",
  "const calls = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf,'utf8')) : [];",
  "calls.push(process.argv.slice(2).join(' '));",
  "fs.writeFileSync(cf, JSON.stringify(calls));",
  "process.exit(Number(process.env.MOCK_FAIL || '0'));",
].join("\n"));

function resetMockCalls() { fs.writeFileSync(MOCK_CALLS_FILE, "[]"); }
function getMockCallCount() {
  try { return JSON.parse(fs.readFileSync(MOCK_CALLS_FILE, "utf8")).length; } catch { return 0; }
}

function withMock(fail, fn) {
  const save = { cmd: process.env.CLAUNKER_JOBCARD_CMD, fail: process.env.MOCK_FAIL, cf: process.env.MOCK_CALLS_FILE };
  process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify([process.execPath, MOCK_SCRIPT]);
  process.env.MOCK_CALLS_FILE = MOCK_CALLS_FILE;
  process.env.MOCK_FAIL = fail ? "1" : "0";
  try { return fn(); }
  finally {
    if (save.cmd === undefined) delete process.env.CLAUNKER_JOBCARD_CMD;
    else process.env.CLAUNKER_JOBCARD_CMD = save.cmd;
    if (save.fail === undefined) delete process.env.MOCK_FAIL;
    else process.env.MOCK_FAIL = save.fail;
    if (save.cf === undefined) delete process.env.MOCK_CALLS_FILE;
    else process.env.MOCK_CALLS_FILE = save.cf;
  }
}

// Test 8+9: died + cardId + no flag -> reap once; idempotent on second check
{
  console.log("\nTest 8: died + cardId -> reap invoked once, cardReaped set");
  const { id, dir } = makeJob({ heartbeatAgeMs: 10 * 60 * 1000, pid: 99999999, cardId: "card-reap-test-1" });
  resetMockCalls();

  withMock(false, () => {
    const s = checkJob(id);
    assert(s.status === "died",   `status=died, got "${s.status}"`);
    assert(!s.reapError,          `no reapError on success`);
  });
  assert(getMockCallCount() === 1, `mock called exactly once`);
  const meta1 = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  assert(meta1.cardReaped === true, `cardReaped=true in meta after reap`);

  console.log("\nTest 9: second check -> no second invocation (idempotent)");
  withMock(false, () => {
    const s2 = checkJob(id);
    assert(s2.status === "died", `status=died on re-check`);
    assert(!s2.reapError,        `no reapError on re-check`);
  });
  assert(getMockCallCount() === 1, `mock still invoked exactly once after second check`);

  cleanup(dir);
}

// Test 10: timed_out + cardId -> reap invoked
{
  console.log("\nTest 10: timed_out + cardId -> reap invoked");
  const overAge = JOB_TIMEOUT_MS + 60 * 60 * 1000;
  const { id, dir } = makeJob({ heartbeatAgeMs: overAge, cardId: "card-reap-test-2" });
  resetMockCalls();

  withMock(false, () => {
    const s = checkJob(id);
    assert(s.status === "timed_out", `status=timed_out, got "${s.status}"`);
    assert(!s.reapError,             `no reapError`);
  });
  assert(getMockCallCount() === 1, `mock called once for timed_out`);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  assert(meta.cardReaped === true, `cardReaped=true after timed_out reap`);

  cleanup(dir);
}

// Test 11: reap-failure -> flag unset, reapError surfaced, classification still returned
{
  console.log("\nTest 11: reap failure -> flag unset, reapError surfaced, status still returned");
  const { id, dir } = makeJob({ heartbeatAgeMs: 10 * 60 * 1000, pid: 99999999, cardId: "card-reap-test-3" });
  resetMockCalls();

  withMock(true, () => {
    const s = checkJob(id);
    assert(s.status === "died",  `status=died even on reap failure`);
    assert(!!s.reapError,        `reapError set on failure`);
  });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  assert(!meta.cardReaped,       `cardReaped NOT set when reap failed`);

  cleanup(dir);
}

// Test 12: completed job with cardId -> never reaped
{
  console.log("\nTest 12: completed job with cardId -> never reaped");
  const { id, dir } = makeJob({ exitCode: 0, cardId: "card-reap-test-4" });
  resetMockCalls();

  withMock(false, () => {
    const s = checkJob(id);
    assert(s.status === "completed", `status=completed, got "${s.status}"`);
    assert(!s.reapError,             `no reapError`);
  });
  assert(getMockCallCount() === 0, `mock never called for completed job`);

  cleanup(dir);
}

// Test 13: legacy record without cardId -> classification only, no error
{
  console.log("\nTest 13: legacy record without cardId -> classification only, no reapError");
  const { id, dir } = makeJob({ noHeartbeat: true, pid: 99999999 });
  resetMockCalls();

  withMock(false, () => {
    const s = checkJob(id);
    assert(s.status === "died", `status=died, got "${s.status}"`);
    assert(!s.reapError,        `no reapError when cardId absent`);
  });
  assert(getMockCallCount() === 0, `mock never called without cardId`);

  cleanup(dir);
}

// ---- summary ---------------------------------------------------------------
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) console.error("HEARTBEAT TESTS FAILED");
else console.log("ALL HEARTBEAT TESTS PASS");
process.exit(failed > 0 ? 1 : 0);
