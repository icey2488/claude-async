#!/usr/bin/env node
/**
 * job-runner.mjs — the detached worker behind claude-async.
 *
 * Reads a spec.json ({ command, argv, cwd, out, err, exit }), runs `command` with its
 * stdout/stderr redirected into the job's log files, and writes the process exit code to
 * the exit_code file when it finishes. It runs as its own DETACHED process (spawned with
 * detached + unref by the server), so the job keeps running and still records its exit code
 * even if the MCP server (the bridge) is restarted. No shell is involved — argv is passed
 * straight to the OS, so prompts/paths need no escaping and Windows works the same as POSIX.
 *
 * Heartbeat: writes runner_heartbeat (ISO timestamp) to the job dir once at spawn, every
 * 60s while the child runs, and once in finish(). checkJob reads this to classify
 * running vs timed_out vs died without relying solely on pid re-stat.
 *
 * runner_job.json: alongside every heartbeat (win32 only), writes this runner's own Job Object
 * membership (queried via tools/jobMembership.mjs), plus its parent pid and whether the parent is
 * still alive. Lets job-core.mjs's checkJob() (and a human reading the job dir after the fact)
 * see whether a runner was ever re-absorbed into a job mid-flight, not just at launch.
 *
 * runner.pid: writes its own process.pid to the job dir before doing anything else. On win32,
 * job-core.mjs's launch() may spawn us indirectly through a PowerShell/CreateProcessW shell-out
 * (to escape the caller's Job Object -- see the win32 note in job-core.mjs), in which case the
 * pid spawn() hands back to job-core is the shell's, not ours; it reads this file instead.
 *
 * Atomic write choice: write to runner_heartbeat.tmp then fs.renameSync -> runner_heartbeat.
 * On Windows NTFS, renameSync uses MoveFileExW(MOVEFILE_REPLACE_EXISTING) which is atomic
 * on the same volume. This prevents checkJob from reading a truncated file between the
 * open-for-write and the data flush of a direct overwrite.
 *
 * CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS: test-only knob (see test/pid-heal.mjs) that delays the
 * runner.pid write below by the given number of milliseconds, letting a test force job-core.mjs's
 * launchWin32()/readRunnerPid() poll window to expire so it falls back to the wrapper's pid --
 * exercising checkJob's healMetaPid() path deterministically instead of racing a real timing
 * window. Uses Atomics.wait for a synchronous block since the pid write happens before any async
 * machinery (heartbeat, child spawn) is set up. Production never sets this env var.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeCard } from "./card-hook.mjs";
import { sanitizeEnvForWin32, logIfPathextSanitized, pidAlive } from "./job-core.mjs";
import { createSelfMembershipQuerier } from "./tools/jobMembership.mjs";
import { writeJsonAtomic } from "./atomic.mjs";

const specPath = process.argv[2];
if (!specPath) process.exit(2);

const pidWriteDelayMs = Number(process.env.CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS) || 0;
if (pidWriteDelayMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pidWriteDelayMs);
}

// Written before anything else that could fail. On win32 the runner may be launched via the
// CREATE_BREAKAWAY_FROM_JOB shell-out (see job-core.mjs launch()), so the pid job-core gets
// back from spawn() is the wrapper's, not ours; it reads this file to learn our real pid.
try {
  const pidPath = path.join(path.dirname(specPath), "runner.pid");
  const tmp = pidPath + ".tmp";
  fs.writeFileSync(tmp, String(process.pid), "utf8");
  fs.renameSync(tmp, pidPath);
} catch { /* best-effort; launch() falls back to the wrapper's pid after a short timeout */ }

let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, "utf8")); }
catch { process.exit(2); }

const { command, argv, cwd, out, err, exit } = spec;

const heartbeatPath = path.join(path.dirname(specPath), "runner_heartbeat");

// 2026-09-09 runner-termination investigation: self-reported Job Object membership, refreshed on
// every heartbeat, so a job's death can be correlated against "was this runner actually free of
// its ambient job the whole time" instead of trusting the launch-time breakaway result alone. The
// helper process is spawned once (Add-Type JIT cost paid once) and polled cheaply thereafter --
// see tools/jobMembership.mjs and tools/query-job-membership.ps1 for why this only ever reports
// on the runner's OWN job (via Windows' automatic job-nesting of a plain, non-breakaway child).
const jobMembershipPath = path.join(path.dirname(specPath), "runner_job.json");
const membershipQuerier = createSelfMembershipQuerier();
// null = "no prior check yet" -- distinct from false, so the very first check never logs a
// spurious "became a member" transition for a runner that was already in a job from the start.
let lastMembershipInJob = null;

async function writeJobMembership() {
  const membership = await membershipQuerier.query(process.pid);
  const parentAlive = pidAlive(process.ppid);
  const record = { ts: new Date().toISOString(), pid: process.pid,
                    parentPid: process.ppid, parentAlive, ...membership };
  const tmp = jobMembershipPath + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(tmp, jobMembershipPath);
  } catch { /* best-effort, same as writeHeartbeat */ }

  if (membership.inJob && lastMembershipInJob === false) {
    try { fs.writeSync(errFd, `\n[job-runner] WARN: ${record.ts} pid=${process.pid} became a member of a ` +
      `Job Object (was not at the previous check) -- membership=${JSON.stringify(membership)}\n`); } catch {}
  }
  lastMembershipInJob = !!membership.inJob;
}

function writeHeartbeat() {
  const ts = new Date().toISOString();
  const tmp = heartbeatPath + ".tmp";
  try {
    fs.writeFileSync(tmp, ts, "utf8");
    fs.renameSync(tmp, heartbeatPath);
  } catch {
    // If rename fails (e.g., cross-device — shouldn't happen but belt-and-suspenders), fall
    // back to a direct write; a torn read is treated as stale (safe, conservative).
    try { fs.writeFileSync(heartbeatPath, ts, "utf8"); } catch {}
  }
}

// Append mode: each write goes to end-of-file, so the runner's own diagnostics never clobber
// the child's captured output.
const outFd = fs.openSync(out, "a");
const errFd = fs.openSync(err, "a");

// Exit record: written to its OWN file (exit.json, next to meta.json), never merged into
// meta.json. meta.json already has a writer (job-core), and a second, independent
// read-modify-write from this process racing that one would silently drop whichever side lost
// the rename -- one writer per file. Fields: exitCode/exitSignal/exitReason (+ spawnError on a
// spawn failure), endedAt, and stderrTail/stdoutTail -- the last TAIL_LINES lines read straight
// off out.log/err.log on disk at exit time (not a ring buffer kept in memory), since stdout/
// stderr go to those files' fds directly and the runner never sees the bytes itself.
const TAIL_LINES = 20;

function readTail(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline from the last write
  return lines.slice(-TAIL_LINES).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

let exitInfo = { exitCode: null, exitSignal: null, exitReason: "exit" };

// Best-effort: a runner that cannot record must still finish normally.
function recordExit() {
  const exitPath = path.join(path.dirname(specPath), "exit.json");
  const record = {
    exitCode: exitInfo.exitCode,
    exitSignal: exitInfo.exitSignal,
    exitReason: exitInfo.exitReason,
    endedAt: new Date().toISOString(),
    stderrTail: readTail(err),
    stdoutTail: readTail(out),
    // No reliable CLI usage-limit message pattern exists in this repo (no fixture or test carries
    // one), so this is deliberately unknown rather than a guessed regex.
    usageLimitSuspected: null,
  };
  if (exitInfo.spawnError !== undefined) record.spawnError = exitInfo.spawnError;
  try { writeJsonAtomic(exitPath, record); }
  catch (e) { try { fs.writeSync(errFd, `\n[job-runner] could not write exit.json: ${e.message}\n`); } catch {} }
}

let done = false;
let hbInterval;

function finish(code) {
  if (done) return;
  done = true;
  if (hbInterval) clearInterval(hbInterval);
  writeHeartbeat(); // final heartbeat immediately before recording exit code
  membershipQuerier.close();
  try { fs.writeFileSync(exit, String(code)); } catch {}
  // Card hook: read meta.json (written by job-core before launching us) for cardId/startHead.
  // Reading here (after child exits) avoids any startup race with job-core's meta write.
  let cardId = null, startHead = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(path.dirname(specPath), "meta.json"), "utf8"));
    cardId = m.cardId || null;
    startHead = m.startHead || null;
  } catch {}
  try { closeCard(cardId, code, cwd, startHead); } catch {}
  try { recordExit(); } catch {}
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  process.exit(0);
}

// Initial heartbeat at spawn so checkJob sees "alive" even before the first 60s tick.
writeHeartbeat();
writeJobMembership().catch(() => {});

// Periodic heartbeat while the child runs. unref() so the interval doesn't prevent exit if
// the child is already gone (child.on("exit") listener is what keeps the loop alive).
// Override for tests (e.g. test/detach-survival.mjs) that need to observe progression in
// seconds rather than minutes; production always uses the 60s default.
const HEARTBEAT_MS = Number(process.env.CLAUDE_ASYNC_HEARTBEAT_MS) || 60_000;
hbInterval = setInterval(() => {
  writeHeartbeat();
  writeJobMembership().catch(() => {});
}, HEARTBEAT_MS);
hbInterval.unref();

// Belt-and-suspenders: job-core.mjs's launchWin32() already sanitizes PATHEXT before spawning the
// wrapper that eventually leads here, but this repairs it again in case a future launch path ever
// gets us started some other way -- see sanitizeEnvForWin32()'s header comment in job-core.mjs.
const spawnEnv = sanitizeEnvForWin32(process.env);
logIfPathextSanitized(err, process.env, spawnEnv, `spawning ${command}`);

let child;
try {
  child = spawn(command, argv, { cwd, stdio: ["ignore", outFd, errFd], windowsHide: true, env: spawnEnv });
} catch (e) {
  try { fs.writeSync(errFd, `\n[job-runner] failed to start ${command}: ${e.message}\n`); } catch {}
  exitInfo = { exitCode: null, exitSignal: null, exitReason: "spawn-error", spawnError: e.message };
  finish(127);
}

if (child) {
  child.on("error", (e) => {
    try { fs.writeSync(errFd, `\n[job-runner] spawn error for ${command}: ${e.message}\n`); } catch {}
    if (!done) exitInfo = { exitCode: null, exitSignal: null, exitReason: "spawn-error", spawnError: e.message };
    finish(127);
  });
  child.on("exit", (code, signal) => {
    exitInfo = { exitCode: code, exitSignal: signal, exitReason: signal ? "signal" : "exit" };
    finish(code == null ? (signal ? 1 : 0) : code);
  });
}
