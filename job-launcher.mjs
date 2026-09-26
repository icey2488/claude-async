#!/usr/bin/env node
/**
 * job-launcher.mjs — fixed action target of the `ClaudeAsyncRunner` scheduled task.
 *
 * 2026-09-09 runner-termination investigation, continued: win32-breakaway.ps1's
 * CREATE_BREAKAWAY_FROM_JOB escape still leaves the runner self-reporting membership in a Job
 * Object with limitFlags 0x3C00 (KILL_ON_JOB_CLOSE | BREAKAWAY_OK | SILENT_BREAKAWAY_OK) --
 * identical to Claude Desktop's own job -- and runners have been hard-killed in the same second
 * with no exit code. Breakaway only ever asks Windows to detach from an *existing* ancestry;
 * Task Scheduler sidesteps the question by giving the runner an ancestor (svchost's Task
 * Scheduler service, via this script) that was never inside Desktop's job in the first place.
 *
 * Why a fixed action + a claim queue, instead of registering a new task per job: registering or
 * reconfiguring a scheduled task (Register-ScheduledTask/Set-ScheduledTask) is a slow COM
 * round-trip to the Task Scheduler service -- too slow to pay on every claude_start. So the task
 * itself never changes; job-core.mjs's ensureLauncherTask() registers it once (idempotently, and
 * only when missing or stale) and every claude_start just writes a work ticket and pokes the
 * task to run:
 *
 *   1. job-core.mjs writes <LAUNCHER_QUEUE_DIR>/<jobId>.json (the job's spec path + node/runner
 *      paths + any env overrides), then runs `schtasks /Run /TN ClaudeAsyncRunner`.
 *      LAUNCHER_QUEUE_DIR is a FIXED location derived only from os.homedir() (see its own
 *      comment in job-core.mjs) -- deliberately NOT under JOB_ROOT, because JOB_ROOT can be
 *      overridden per-bridge-process via CLAUDE_ASYNC_JOB_DIR, and this script is started by the
 *      Task Scheduler service with its own fresh environment, not a copy of the bridge's; it
 *      would never see that override. The ticket carries the job's real (possibly
 *      JOB_ROOT-overridden) directory as an absolute path instead.
 *   2. Task Scheduler spawns a fresh instance of THIS script (MultipleInstances=Parallel, so
 *      concurrent claude_start calls each get their own instance running at the same time).
 *   3. Each instance scans LAUNCHER_QUEUE_DIR for *.json tickets (not *.claimed.json) and claims AT
 *      MOST ONE, under an exclusive-create lock (<jobId>.lock, fs.openSync "wx") and then renaming
 *      <jobId>.json -> <jobId>.claimed.json. The lock is required: two concurrent renameSync calls
 *      on the same ticket can BOTH succeed on Windows, so the rename alone let one job run twice.
 *      An instance that loses the lock moves on to the next candidate. The whole protocol, including
 *      stale-lock handling, lives in launcher-claim.mjs.
 *   4. The winning instance spawns job-runner.mjs (detached, unref'd, stdio ignored -- it opens
 *      its own out/err files from spec.json) and writes launched.marker (with the runner's pid)
 *      into the JOB's own directory (from the ticket), not the queue dir.
 *   5. An instance that finds nothing left to claim exits 0 quietly -- this is the expected
 *      outcome whenever two `schtasks /Run` calls race for the same trigger tick, or a launcher
 *      starts after another has already drained the queue.
 *
 * job-core.mjs's readRunnerPid() (unchanged) is what actually learns the runner's real pid --
 * it polls the job dir's runner.pid the same way it always has, just with a longer timeout on
 * this path (task scheduling has more hops than a direct spawn). launched.marker is not consumed
 * by job-core.mjs at all; it exists so a stuck/orphaned claim (a launcher that claimed a ticket
 * but died before spawning) is distinguishable on disk from a healthy one.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeEnvForWin32, logIfPathextSanitized, LAUNCHER_QUEUE_DIR } from "./job-core.mjs";
import { writeJsonAtomic } from "./atomic.mjs";
import { claimOneTicket } from "./launcher-claim.mjs";

function log(line) {
  try {
    fs.appendFileSync(path.join(LAUNCHER_QUEUE_DIR, "job-launcher.log"),
      `${new Date().toISOString()} [pid=${process.pid}] ${line}\n`);
  } catch {}
}

// Env vars job-core.mjs's launch() captured from the bridge's own process.env at claude_start
// time (see ensureLauncherTask()/writeLaunchTicket() in job-core.mjs) that job-runner.mjs's own
// spawn of the CLI should also see -- e.g. CLAUDE_ASYNC_HEARTBEAT_MS test overrides, an
// ANTHROPIC_API_KEY set directly on the bridge rather than resolved from a config file. Merged
// ON TOP of this launcher's own (Task-Scheduler-provided) environment, never replacing it: PATH/
// PATHEXT/USERPROFILE etc. must keep coming from the launcher's real environment, not a snapshot
// of the bridge's, which may be stale or (per the design this task exists to defeat) missing
// pieces the bridge's own Job Object-nested process never needed.
function buildRunnerEnv(envOverrides, errPath) {
  const merged = { ...process.env, ...(envOverrides || {}) };
  const sanitized = sanitizeEnvForWin32(merged);
  logIfPathextSanitized(errPath, merged, sanitized, "job-launcher spawning job-runner.mjs");
  return sanitized;
}

// spec.json's `command` field is resolved once by job-core.mjs at claude_start time (CLAUDE_BIN
// = CLAUDE_CLI_PATH override, or the bare string "claude" relying on PATH resolution wherever it
// finally spawns). On this machine PATH resolution works fine under Task Scheduler (HKLM+HKCU
// PATH both flow through -- see RUNBOOK.md for how this was verified) --
// but a bare command name that fails to resolve in *this* process's PATH would otherwise fail
// silently inside job-runner.mjs's spawn() with ENOENT. Belt-and-suspenders: if `command` is a
// bare token (no path separator, so PATH-resolution is actually in play) and `where.exe` can't
// find it in the env about to be handed to job-runner.mjs, fall back to the one well-known
// install location this repo's own RUNBOOK documents (~/.local/bin/<command>.exe) before giving
// up and leaving it bare (job-runner.mjs's own spawn() error handling takes it from there).
function resolveCommand(command, env) {
  if (!command || /[\\/]/.test(command)) return command;
  const where = spawnSync("where.exe", [command], { env, encoding: "utf8" });
  if (where.status === 0 && where.stdout.trim()) return command; // resolvable as-is
  const fallback = path.join(os.homedir(), ".local", "bin", `${command}.exe`);
  if (fs.existsSync(fallback)) {
    log(`resolveCommand: "${command}" not on PATH under Task Scheduler env; using fallback ${fallback}`);
    return fallback;
  }
  log(`resolveCommand: "${command}" not on PATH and no fallback at ${fallback}; leaving bare (will likely ENOENT)`);
  return command;
}

function main() {
  const claim = claimOneTicket({ queueDir: LAUNCHER_QUEUE_DIR, log });
  if (!claim) {
    log("no pending ticket found; exiting quietly");
    process.exit(0);
  }
  const { claimedPath, ticket } = claim;
  if (!ticket) {
    log(`aborting claim ${claimedPath}: unparseable ticket`);
    process.exit(1);
  }

  const { jobId, jobDir, specPath, errPath, nodeExe, runnerScript, envOverrides } = ticket;
  log(`claimed jobId=${jobId} specPath=${specPath}`);

  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, "utf8")); }
  catch (e) {
    log(`jobId=${jobId}: could not read spec.json at ${specPath}: ${e.message}`);
    try { fs.appendFileSync(errPath, `\n[job-launcher] could not read spec.json: ${e.message}\n`); } catch {}
    process.exit(1);
  }

  const env = buildRunnerEnv(envOverrides, errPath);
  const resolvedCommand = resolveCommand(spec.command, env);
  if (resolvedCommand !== spec.command) {
    // job-runner.mjs reads spec.json fresh (it hasn't started yet -- we spawn it below), so
    // rewriting the command field in place here is what actually takes effect. Nothing else in
    // the codebase reads spec.json besides job-runner.mjs (verified: only its own specPath argv).
    spec.command = resolvedCommand;
    try { writeJsonAtomic(specPath, spec, { space: 0 }); }
    catch (e) { log(`jobId=${jobId}: failed to rewrite resolved command into spec.json: ${e.message}`); }
  }

  const child = spawn(nodeExe, [runnerScript, specPath],
    { detached: true, stdio: "ignore", windowsHide: true, env });
  child.on("error", (e) => {
    log(`jobId=${jobId}: failed to spawn job-runner.mjs: ${e.message}`);
    try { fs.appendFileSync(errPath, `\n[job-launcher] failed to spawn job-runner: ${e.message}\n`); } catch {}
  });
  child.unref();

  try {
    fs.writeFileSync(path.join(jobDir, "launched.marker"),
      JSON.stringify({ pid: child.pid, launchedAt: new Date().toISOString() }, null, 2));
  } catch (e) { log(`jobId=${jobId}: failed to write launched.marker: ${e.message}`); }

  log(`jobId=${jobId}: spawned job-runner.mjs pid=${child.pid}`);
  process.exit(0);
}

main();
