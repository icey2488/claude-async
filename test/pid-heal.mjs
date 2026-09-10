#!/usr/bin/env node
/**
 * test/pid-heal.mjs — regression test for the wrapper-fallback pid bug (reviewer finding #2,
 * 2026-09-09 review of fix/win32-detach): if job-runner.mjs's runner.pid write is slow enough to
 * miss job-core.mjs's readRunnerPid() poll window (RUNNER_PID_POLL_MS, 2s), launchWin32() falls
 * back to the PowerShell wrapper's pid. The wrapper exits within milliseconds of spawning the
 * real runner, so meta.pid then points at an already-dead process even though the job is healthy.
 * checkJob()'s healMetaPid() is supposed to notice runner.pid has since appeared, confirm it's
 * alive and ours, and heal meta.json instead of declaring the job "died".
 *
 * Mechanism: CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS (honored by job-runner.mjs) forces the runner.pid
 * write past the poll window deterministically, using the real win32 launch path end to end
 * (real PowerShell wrapper, real CreateProcessW breakaway, real job-runner.mjs). Once the job is
 * confirmed running with pidSource "wrapper-fallback" and the wrapper pid confirmed dead, the
 * test hand-stales runner_heartbeat (same technique as test-heartbeat.mjs) to force checkJob into
 * its pid-recheck branch, then asserts it heals rather than reaping the job.
 *
 * Run: node test/pid-heal.mjs   (exit 0 = heal path works)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);
const DUMMY_CLI = path.join(REPO, "test", "dummy-claude.exe");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pidAlive(pid) {
  if (!pid) return false;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  const line = (r.stdout || "").trim().split(/\r?\n/)[0];
  return !!line && !line.startsWith("INFO:");
}

const build = spawnSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
   "-File", path.join(REPO, "test", "build-dummy-claude.ps1"), "-OutputPath", DUMMY_CLI],
  { encoding: "utf8" });
if (build.status !== 0) {
  console.error("Could not build test/dummy-claude.exe:", build.stdout, build.stderr);
  process.exit(1);
}

const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-heal-"));
process.env.CLAUDE_ASYNC_JOB_DIR = jobDir;
// This test exercises win32-breakaway.ps1-specific mechanics (the wrapper-fallback pid path) that
// the Task Scheduler launch path (default since 2026-09-09) doesn't go through at all -- force it.
process.env.CLAUDE_ASYNC_WIN32_LAUNCH_MODE = "breakaway";
process.env.CLAUDE_CLI_PATH = DUMMY_CLI;
process.env.DUMMY_SLEEP_SECONDS = "30";
process.env.CLAUDE_ASYNC_HEARTBEAT_MS = "1000";
// RUNNER_PID_POLL_MS in job-core.mjs is 2000ms; delay well past it so the poll always times out.
process.env.CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS = "3500";
process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);

const core = await import(pathToFileURL(path.join(REPO, "job-core.mjs")).href + "?scenario=pid-heal");

let ok = true;
const fail = (msg) => { ok = false; console.error(`FAIL — ${msg}`); };
const pass = (msg) => console.log(`PASS — ${msg}`);

let runnerPid;
try {
  const start = await core.startJob({ prompt: "pid heal test", jobId: "pid-heal-job", model: "n/a", effort: "low" });
  if (start.error) { fail(`startJob() error: ${start.error}`); throw new Error("abort"); }

  if (start.pidSource === "wrapper-fallback") pass(`startJob() fell back to the wrapper pid as expected (pid=${start.pid})`);
  else fail(`expected pidSource="wrapper-fallback", got "${start.pidSource}" (pid=${start.pid}) -- ` +
    "CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS may not be wired through; test proves nothing without this");

  const pidPath = path.join(jobDir, "pid-heal-job", "runner.pid");
  const pidDeadline = Date.now() + 10000;
  while (!fs.existsSync(pidPath) && Date.now() < pidDeadline) await sleep(100);
  if (!fs.existsSync(pidPath)) { fail("runner.pid never appeared"); throw new Error("abort"); }
  runnerPid = Number(fs.readFileSync(pidPath, "utf8").trim());
  if (runnerPid && runnerPid !== start.pid) pass(`runner.pid (${runnerPid}) differs from meta.pid (${start.pid}), confirming the wrapper/runner split`);
  else fail(`runner.pid=${runnerPid} unexpectedly equals meta.pid=${start.pid}`);

  // The wrapper exits within ms of spawning the runner -- confirm meta.pid is now dead.
  const deadDeadline = Date.now() + 5000;
  while (pidAlive(start.pid) && Date.now() < deadDeadline) await sleep(100);
  if (!pidAlive(start.pid)) pass(`wrapper pid ${start.pid} has exited (as expected)`);
  else fail(`wrapper pid ${start.pid} is still alive after 5s -- can't exercise the dead-meta.pid path`);

  if (!pidAlive(runnerPid)) { fail(`runner pid ${runnerPid} is not alive; job-runner.mjs may have crashed`); throw new Error("abort"); }

  // Force checkJob into its stale-heartbeat pid-recheck branch (HEARTBEAT_FRESH_MS=3min,
  // JOB_TIMEOUT_MS=4h by default) without waiting minutes in real time.
  const hbPath = path.join(jobDir, "pid-heal-job", "runner_heartbeat");
  fs.writeFileSync(hbPath, new Date(Date.now() - 10 * 60 * 1000).toISOString());

  const status = core.checkJob("pid-heal-job");
  if (status.status === "running") pass(`checkJob() reports "running", not "died" (stalled=${status.stalled} pidHealed=${status.pidHealed})`);
  else fail(`checkJob() reports status="${status.status}" -- healthy job was reaped`);

  if (status.pid === runnerPid) pass(`meta.pid healed to the runner pid (${runnerPid})`);
  else fail(`meta.pid did not heal: expected ${runnerPid}, got ${status.pid}`);

  if (status.pidSource === "runner-healed") pass('pidSource updated to "runner-healed"');
  else fail(`expected pidSource="runner-healed", got "${status.pidSource}"`);

  const metaOnDisk = JSON.parse(fs.readFileSync(path.join(jobDir, "pid-heal-job", "meta.json"), "utf8"));
  if (metaOnDisk.pid === runnerPid && metaOnDisk.pidSource === "runner-healed") pass("meta.json on disk persisted the heal");
  else fail(`meta.json on disk not healed: ${JSON.stringify(metaOnDisk)}`);
} catch (e) {
  if (e.message !== "abort") { console.error(e); ok = false; }
} finally {
  try { if (runnerPid) process.kill(runnerPid, "SIGKILL"); } catch {}
  try { if (runnerPid) spawnSync("taskkill", ["/PID", String(runnerPid), "/T", "/F"]); } catch {}
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
}

console.log(ok ? "\nPASS — wrapper-fallback pid heals instead of being reaped as died" : "\nFAIL — pid-heal regression");
process.exit(ok ? 0 : 1);
