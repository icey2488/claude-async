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

function makeJob({ pid, heartbeatAgeMs, exitCode, noHeartbeat = false } = {}) {
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

// ---- summary ---------------------------------------------------------------
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) console.error("HEARTBEAT TESTS FAILED");
else console.log("ALL HEARTBEAT TESTS PASS");
process.exit(failed > 0 ? 1 : 0);
