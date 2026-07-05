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

// Append mode: each write goes to end-of-file, so the runner's own diagnostics never clobber
// the child's captured output.
const outFd = fs.openSync(out, "a");
const errFd = fs.openSync(err, "a");

let done = false;
function finish(code) {
  if (done) return;
  done = true;
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
