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
 * Atomic write choice: write to runner_heartbeat.tmp then fs.renameSync -> runner_heartbeat.
 * On Windows NTFS, renameSync uses MoveFileExW(MOVEFILE_REPLACE_EXISTING) which is atomic
 * on the same volume. This prevents checkJob from reading a truncated file between the
 * open-for-write and the data flush of a direct overwrite.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeCard } from "./card-hook.mjs";

const specPath = process.argv[2];
if (!specPath) process.exit(2);

let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, "utf8")); }
catch { process.exit(2); }

const { command, argv, cwd, out, err, exit } = spec;

const heartbeatPath = path.join(path.dirname(specPath), "runner_heartbeat");

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

let done = false;
let hbInterval;

function finish(code) {
  if (done) return;
  done = true;
  if (hbInterval) clearInterval(hbInterval);
  writeHeartbeat(); // final heartbeat immediately before recording exit code
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
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  process.exit(0);
}

// Initial heartbeat at spawn so checkJob sees "alive" even before the first 60s tick.
writeHeartbeat();

// Periodic heartbeat while the child runs. unref() so the interval doesn't prevent exit if
// the child is already gone (child.on("exit") listener is what keeps the loop alive).
hbInterval = setInterval(writeHeartbeat, 60_000);
hbInterval.unref();

let child;
try {
  child = spawn(command, argv, { cwd, stdio: ["ignore", outFd, errFd], windowsHide: true });
} catch (e) {
  try { fs.writeSync(errFd, `\n[job-runner] failed to start ${command}: ${e.message}\n`); } catch {}
  finish(127);
}

if (child) {
  child.on("error", (e) => {
    try { fs.writeSync(errFd, `\n[job-runner] spawn error for ${command}: ${e.message}\n`); } catch {}
    finish(127);
  });
  child.on("exit", (code, signal) => {
    finish(code == null ? (signal ? 1 : 0) : code);
  });
}
