#!/usr/bin/env node
/**
 * test/detach-survival.mjs — proves job-runner.mjs survives its ancestor's Job Object being
 * killed, and that it did NOT survive before the win32 breakaway fix.
 *
 * Mechanism: creates a throwaway Job Object J with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
 * JOB_OBJECT_LIMIT_BREAKAWAY_OK (deliberately WITHOUT SILENT_BREAKAWAY_OK -- see job-core.mjs's
 * win32 comment for why: this repo's Electron-managed job already has SILENT_BREAKAWAY_OK set,
 * which means a plain detached spawn already escapes it silently on this machine, so a test
 * built against that exact job would pass even without the fix and prove nothing. Dropping
 * SILENT_BREAKAWAY_OK reproduces the failure mode for any ambient job that permits explicit
 * breakaway but not silent breakaway -- the scenario the fix actually targets), assigns a
 * throwaway node "parent" process (P) to J, has P call startJob() from a given job-core.mjs
 * (old snapshot or the current fixed one), waits for the spawned runner's heartbeat to appear,
 * then kills the process holding J's only handle (never with taskkill /T -- the point is to
 * trigger Windows' own kill-on-close, not taskkill's tree-walk) and checks 5s later whether the
 * runner is still alive and its heartbeat has advanced.
 *
 * Run: node test/detach-survival.mjs   (exit 0 = before dies AND after survives)
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pidAlive(pid) {
  if (!pid) return false;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  const line = (r.stdout || "").trim().split(/\r?\n/)[0];
  return !!line && !line.startsWith("INFO:");
}

async function runScenario(label, coreModulePath, dummyCli) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), `detach-survival-${label}-`));
  const markerPath = path.join(jobDir, "parent-marker.json");
  const parentPidFile = path.join(jobDir, "parent.pid");
  const parentScript = path.join(REPO, "test", "test-parent.mjs");
  const harnessScript = path.join(REPO, "test", "job-object-harness.ps1");

  const env = { ...process.env, DUMMY_SLEEP_SECONDS: "20", CLAUDE_ASYNC_HEARTBEAT_MS: "1000" };

  const harness = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", harnessScript,
    "-NodeExe", process.execPath, "-ParentScript", parentScript, "-JobDir", jobDir,
    "-DummyCli", dummyCli, "-CoreModule", coreModulePath, "-ParentPidFile", parentPidFile,
    "-MarkerPath", markerPath,
  ], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  let harnessOut = "", harnessErr = "";
  harness.stdout.on("data", (d) => { harnessOut += d.toString(); });
  harness.stderr.on("data", (d) => { harnessErr += d.toString(); });

  const readyDeadline = Date.now() + 10000;
  let readyMatch = null;
  while (!(readyMatch = harnessOut.match(/READY pid=(\d+)/)) && Date.now() < readyDeadline) await sleep(100);
  if (!readyMatch) {
    try { process.kill(harness.pid, "SIGKILL"); } catch {}
    return { label, ok: false, reason: `harness never reported READY. stdout=${harnessOut} stderr=${harnessErr}` };
  }
  const pPid = Number(readyMatch[1]);

  const markerDeadline = Date.now() + 15000;
  while (!fs.existsSync(markerPath) && Date.now() < markerDeadline) await sleep(100);
  if (!fs.existsSync(markerPath)) {
    spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
    return { label, ok: false, reason: "parent process (P) never wrote its marker -- startJob() likely hung or threw" };
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const runnerPid = marker.result && marker.result.pid;

  // win32-breakaway.ps1 logs every outcome unconditionally to <jobdir>/launch.log (2026-09-09
  // runner-termination investigation) -- captured here, before jobDir gets cleaned up below, so
  // the caller can assert on it independent of pid/heartbeat survival.
  const launchLogPath = path.join(jobDir, "survival-job", "launch.log");
  const launchLog = fs.existsSync(launchLogPath) ? fs.readFileSync(launchLogPath, "utf8") : null;

  const hbPath = path.join(jobDir, "survival-job", "runner_heartbeat");
  const hbDeadline = Date.now() + 10000;
  while (!fs.existsSync(hbPath) && Date.now() < hbDeadline) await sleep(100);
  if (!fs.existsSync(hbPath)) {
    spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
    try { process.kill(runnerPid, "SIGKILL"); } catch {}
    return { label, ok: false, reason: `runner_heartbeat never appeared (marker=${JSON.stringify(marker)})` };
  }
  const hbBefore = fs.readFileSync(hbPath, "utf8").trim();

  // Kill ONLY the job holder, by pid, no /T: this must be pure Job Object kill-on-close, not
  // taskkill's own process-tree walk.
  spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);

  await sleep(1500);
  const pStillAlive = pidAlive(pPid); // sanity: P must die, or the kill did nothing

  await sleep(5000);
  const runnerAliveAfter = pidAlive(runnerPid);
  const hbAfter = fs.existsSync(hbPath) ? fs.readFileSync(hbPath, "utf8").trim() : null;
  const hbAdvanced = hbAfter !== null && hbAfter !== hbBefore;

  try { process.kill(runnerPid, "SIGKILL"); } catch {}
  spawnSync("taskkill", ["/PID", String(runnerPid), "/T", "/F"]);
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}

  const killFired = !pStillAlive;
  const ok = killFired && runnerAliveAfter && hbAdvanced;
  return {
    label, ok, launchLog,
    detail: { pPid, runnerPid, killFired, runnerAliveAfter, hbBefore, hbAfter, hbAdvanced },
  };
}

const REAL_CORE = path.join(REPO, "job-core.mjs");
const OLD_CORE_SNAPSHOT = path.join(REPO, ".job-core-before.mjs");
const DUMMY_CLI = path.join(REPO, "test", "dummy-claude.exe");

// Pinned to 7effb28762c58a43e260aad7e655802a9579b68f (5a09feb^), the last commit before the
// win32 breakaway fix. HEAD~1 is not safe here: as more commits land on top of the fix, HEAD~1
// drifts forward and stops pointing at the true pre-fix baseline.
const PRE_FIX_COMMIT = "7effb28762c58a43e260aad7e655802a9579b68f";
const gitShow = spawnSync("git", ["show", `${PRE_FIX_COMMIT}:job-core.mjs`], { cwd: REPO, encoding: "utf8" });
if (gitShow.status !== 0) {
  console.error(`Could not obtain pre-fix job-core.mjs via \`git show ${PRE_FIX_COMMIT}:job-core.mjs\`:`, gitShow.stderr);
  process.exit(1);
}
fs.writeFileSync(OLD_CORE_SNAPSHOT, gitShow.stdout);

const build = spawnSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
   "-File", path.join(REPO, "test", "build-dummy-claude.ps1"), "-OutputPath", DUMMY_CLI],
  { encoding: "utf8" });
if (build.status !== 0) {
  console.error("Could not build test/dummy-claude.exe:", build.stdout, build.stderr);
  process.exit(1);
}

try {
  console.log("=== BEFORE (pre-fix job-core.mjs launch(), from git HEAD) ===");
  const before = await runScenario("before", OLD_CORE_SNAPSHOT, DUMMY_CLI);
  console.log(JSON.stringify(before, null, 2));

  console.log("\n=== AFTER (current, fixed job-core.mjs launch()) ===");
  const after = await runScenario("after", REAL_CORE, DUMMY_CLI);
  console.log(JSON.stringify(after, null, 2));

  // The "after" scenario's ambient job (JOB_OBJECT_LIMIT_BREAKAWAY_OK, no SILENT) permits explicit
  // breakaway, so on this machine win32-breakaway.ps1 should always log the plain "ok" outcome,
  // not a fallback -- confirming the wrapper itself is doing the escape, not silently no-op'ing.
  const afterBreakawayOk = !!(after.launchLog && /breakaway=ok\b/.test(after.launchLog));

  console.log("\n=== SUMMARY ===");
  console.log(`before: ${before.ok ? "SURVIVED (unexpected -- pre-fix code shouldn't escape)" : "DIED (bug reproduced)"}`
    + (before.reason ? ` -- ${before.reason}` : ""));
  console.log(`after:  ${after.ok ? "SURVIVED (fix confirmed)" : "DIED (fix NOT working)"}`
    + (after.reason ? ` -- ${after.reason}` : ""));
  console.log(`after launch.log: ${afterBreakawayOk ? "breakaway=ok confirmed" : "MISSING/unexpected"}`
    + (after.launchLog ? ` -- ${after.launchLog.trim()}` : " -- file absent"));

  const expected = !before.ok && after.ok && afterBreakawayOk;
  console.log(expected
    ? "\nPASS — before dies, after survives, launch.log confirms breakaway=ok"
    : "\nFAIL — did not see the expected before/after contrast and/or launch.log evidence");
  process.exit(expected ? 0 : 1);
} finally {
  try { fs.rmSync(OLD_CORE_SNAPSHOT, { force: true }); } catch {}
}
