#!/usr/bin/env node
/**
 * test/survival.mjs — replaces test/detach-survival.mjs. Proves job-runner.mjs survives losing
 * its ancestor entirely, under the CURRENT default win32 launch path (Task Scheduler, primary as
 * of the 2026-09-09 Task Scheduler launcher work; win32-breakaway.ps1 is now fallback-only -- see
 * job-core.mjs's launchWin32()). Unlike the old before/after test (which compared pre-fix vs
 * post-fix job-core.mjs snapshots), there is nothing to compare against here: this asserts the
 * property holds today, under three independent kill mechanisms, plus the launcher's claim race.
 *
 * Scenario (a) tree-kill: kills the ENTIRE OS process tree rooted at the process that called
 * startJob() (taskkill /T /F), not just a Job Object. This is the scenario that most directly
 * proves "ancestry independent of Claude Desktop": job-launcher.mjs is spawned by the Task
 * Scheduler service, not by the caller, so it is never a recorded descendant of it at all --
 * taskkill /T can't reach it regardless of job membership.
 *
 * Scenario (b) external job-close: reuses test/job-object-harness.ps1 (unchanged from the old
 * test) -- a separate holder process is assigned the job, the caller (P) nests into it as a
 * normal child, and the holder is killed directly by pid (no /T) so Windows' own
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE fires, not taskkill's tree-walk.
 *
 * Scenario (c) self-closing job (NEW): test/job-close-harness.ps1 assigns ITSELF to the job
 * before spawning the caller (P), so P nests into the same job the harness is in, then explicitly
 * CloseHandle()s its own last handle to that job -- terminating itself (and P, if not escaped)
 * synchronously inside that call.
 *
 * Race test: directly exercises job-launcher.mjs's claim logic (LAUNCHER_QUEUE_DIR, atomic
 * rename-to-claim) by writing two tickets and spawning two launcher instances concurrently,
 * bypassing schtasks entirely for determinism -- asserts both runners start and neither ticket is
 * claimed twice.
 *
 * IMPORTANT CAVEAT discovered while building this test: a foreign-pid IsProcessInJob(h, NULL, ...)
 * query (job-core.mjs's jobMembership, and job-runner.mjs's own self-query) reports true with
 * limitFlags 0x3C00 (KILL_ON_JOB_CLOSE|BREAKAWAY_OK|SILENT_BREAKAWAY_OK) for essentially ANY
 * console-attached Windows process, including a bare `node -e ...` launched from a plain terminal
 * with zero relation to Claude Desktop -- this is Windows' own default per-console job, not
 * evidence of nesting inside Desktop's specific job. inJob/limitFlags therefore CANNOT prove or
 * disprove escape from a *specific* job; only an actual kill-on-close test (what this file does)
 * can. See RUNBOOK.md for the verification that established this.
 *
 * Run: node test/survival.mjs   (exit 0 = all three kill scenarios + the race test pass)
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);
const REAL_CORE = path.join(REPO, "job-core.mjs");
const DUMMY_CLI = path.join(REPO, "test", "dummy-claude.exe");
const TEST_PARENT = path.join(REPO, "test", "test-parent.mjs");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pidAlive(pid) {
  if (!pid) return false;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  const line = (r.stdout || "").trim().split(/\r?\n/)[0];
  return !!line && !line.startsWith("INFO:");
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Common tail: given a runner already confirmed alive with a heartbeat file, kill the ancestor
// however the caller wants (killFn), then assert the runner keeps heartbeating for >=10s after.
async function assertSurvives(label, runnerPid, hbPath, killFn) {
  const hbBefore = fs.readFileSync(hbPath, "utf8").trim();
  await killFn();
  await sleep(10_000);
  const runnerAliveAfter = pidAlive(runnerPid);
  const hbAfter = fs.existsSync(hbPath) ? fs.readFileSync(hbPath, "utf8").trim() : null;
  const hbAdvanced = hbAfter !== null && hbAfter !== hbBefore;
  const ok = runnerAliveAfter && hbAdvanced;
  return { label, ok, detail: { runnerPid, hbBefore, hbAfter, hbAdvanced, runnerAliveAfter } };
}

// --- Scenario (a): kill the launching process's entire OS process tree ------------------------
async function scenarioTreeKill() {
  const label = "a-tree-kill";
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "survival-a-"));
  const markerPath = path.join(jobDir, "parent-marker.json");
  const env = { ...process.env, DUMMY_SLEEP_SECONDS: "90", CLAUDE_ASYNC_HEARTBEAT_MS: "1000" };

  const P = spawn(process.execPath, [TEST_PARENT, jobDir, DUMMY_CLI, REAL_CORE, markerPath],
    { env, stdio: "ignore", windowsHide: true });

  try {
    if (!await waitFor(() => fs.existsSync(markerPath), 15000)) {
      return { label, ok: false, reason: "parent (P) never wrote its marker" };
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const runnerPid = marker.result && marker.result.pid;
    const launchPath = marker.result && marker.result.launchPath;

    const hbPath = path.join(jobDir, "survival-job", "runner_heartbeat");
    if (!await waitFor(() => fs.existsSync(hbPath), 15000)) {
      return { label, ok: false, reason: `runner_heartbeat never appeared (marker=${JSON.stringify(marker)})` };
    }

    const result = await assertSurvives(label, runnerPid, hbPath, async () => {
      // /T walks the OS-recorded process tree rooted at P.pid -- NOT a Job Object mechanism.
      spawnSync("taskkill", ["/PID", String(P.pid), "/T", "/F"]);
      await waitFor(() => !pidAlive(P.pid), 5000);
    });
    return { ...result, launchPath };
  } finally {
    try { const m = JSON.parse(fs.readFileSync(markerPath, "utf8")); if (m.result?.pid) {
      process.kill(m.result.pid, "SIGKILL"); spawnSync("taskkill", ["/PID", String(m.result.pid), "/T", "/F"]);
    } } catch {}
    try { process.kill(P.pid, "SIGKILL"); } catch {}
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}

// --- Scenario (b): a separate holder process's Job Object handle closes on external kill -------
async function scenarioExternalJobClose() {
  const label = "b-external-job-close";
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "survival-b-"));
  const markerPath = path.join(jobDir, "parent-marker.json");
  const parentPidFile = path.join(jobDir, "parent.pid");
  const harnessScript = path.join(REPO, "test", "job-object-harness.ps1");
  const env = { ...process.env, DUMMY_SLEEP_SECONDS: "90", CLAUDE_ASYNC_HEARTBEAT_MS: "1000" };

  const harness = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", harnessScript, "-NodeExe", process.execPath, "-ParentScript", TEST_PARENT,
    "-JobDir", jobDir, "-DummyCli", DUMMY_CLI, "-CoreModule", REAL_CORE,
    "-ParentPidFile", parentPidFile, "-MarkerPath", markerPath,
  ], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  let harnessOut = "";
  harness.stdout.on("data", (d) => { harnessOut += d.toString(); });

  try {
    if (!await waitFor(() => /READY pid=\d+/.test(harnessOut), 10000)) {
      spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
      return { label, ok: false, reason: `harness never reported READY: ${harnessOut}` };
    }
    if (!await waitFor(() => fs.existsSync(markerPath), 15000)) {
      spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
      return { label, ok: false, reason: "parent (P) never wrote its marker" };
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const runnerPid = marker.result && marker.result.pid;
    const launchPath = marker.result && marker.result.launchPath;

    const hbPath = path.join(jobDir, "survival-job", "runner_heartbeat");
    if (!await waitFor(() => fs.existsSync(hbPath), 15000)) {
      spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
      return { label, ok: false, reason: `runner_heartbeat never appeared (marker=${JSON.stringify(marker)})` };
    }

    const result = await assertSurvives(label, runnerPid, hbPath, async () => {
      // Kill ONLY the holder, by pid, no /T -- pure Job Object kill-on-close, not a tree-walk.
      spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
      await waitFor(() => !pidAlive(harness.pid), 5000);
    });
    return { ...result, launchPath };
  } finally {
    try { const m = JSON.parse(fs.readFileSync(markerPath, "utf8")); if (m.result?.pid) {
      process.kill(m.result.pid, "SIGKILL"); spawnSync("taskkill", ["/PID", String(m.result.pid), "/T", "/F"]);
    } } catch {}
    try { spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]); } catch {}
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}

// --- Scenario (c): the launching process's own ancestor closes its OWN job handle ---------------
async function scenarioSelfJobClose() {
  const label = "c-self-job-close";
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "survival-c-"));
  const markerPath = path.join(jobDir, "parent-marker.json");
  const parentPidFile = path.join(jobDir, "parent.pid");
  const hbPath = path.join(jobDir, "survival-job", "runner_heartbeat");
  const harnessScript = path.join(REPO, "test", "job-close-harness.ps1");
  const env = { ...process.env, DUMMY_SLEEP_SECONDS: "90", CLAUDE_ASYNC_HEARTBEAT_MS: "1000" };

  const harness = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", harnessScript, "-NodeExe", process.execPath, "-ParentScript", TEST_PARENT,
    "-JobDir", jobDir, "-DummyCli", DUMMY_CLI, "-CoreModule", REAL_CORE,
    "-ParentPidFile", parentPidFile, "-MarkerPath", markerPath, "-HeartbeatPath", hbPath,
  ], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  let harnessOut = "";
  harness.stdout.on("data", (d) => { harnessOut += d.toString(); });

  try {
    if (!await waitFor(() => /READY pid=\d+/.test(harnessOut), 10000)) {
      spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
      return { label, ok: false, reason: `harness never reported READY: ${harnessOut}` };
    }
    // The harness itself waits for marker+heartbeat, then calls CloseHandle() on its own job --
    // no external trigger needed. We just wait for its own pid to disappear (proof the close+
    // kill-on-close actually fired), or for it to print CLOSED (proof it did NOT -- i.e. it
    // escaped its own job too, which would only happen if this harness itself broke away).
    const settled = await waitFor(
      () => !pidAlive(harness.pid) || /CLOSED|TIMEOUT/.test(harnessOut), 25000);
    if (!settled) {
      spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]);
      return { label, ok: false, reason: `harness never settled: ${harnessOut}` };
    }
    if (/TIMEOUT/.test(harnessOut)) {
      return { label, ok: false, reason: `harness reported a timeout: ${harnessOut}` };
    }
    if (!fs.existsSync(markerPath)) {
      return { label, ok: false, reason: `no marker despite harness settling: ${harnessOut}` };
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    const runnerPid = marker.result && marker.result.pid;
    const launchPath = marker.result && marker.result.launchPath;

    // The kill-on-close (if it fired) already happened by the time we get here -- assertSurvives'
    // killFn is a no-op wait, since the "kill" already occurred inside the harness.
    const result = await assertSurvives(label, runnerPid, hbPath, async () => { await sleep(200); });
    return { ...result, launchPath, harnessSelfTerminated: !pidAlive(harness.pid) };
  } finally {
    try { const m = JSON.parse(fs.readFileSync(markerPath, "utf8")); if (m.result?.pid) {
      process.kill(m.result.pid, "SIGKILL"); spawnSync("taskkill", ["/PID", String(m.result.pid), "/T", "/F"]);
    } } catch {}
    try { spawnSync("taskkill", ["/PID", String(harness.pid), "/F"]); } catch {}
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}

// --- Race test: two tickets, two launcher instances started at once, no double-claim -----------
async function raceClaimTest() {
  const label = "race-claim";
  const { LAUNCHER_QUEUE_DIR } = await import(pathToFileURL(REAL_CORE).href + "?scenario=race");
  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "survival-race-jobs-"));
  const runnerScript = path.join(REPO, "job-runner.mjs");
  const launcherScript = path.join(REPO, "job-launcher.mjs");

  const ids = ["race-job-1", "race-job-2"];
  const jobDirs = {};
  for (const id of ids) {
    const d = path.join(jobRoot, id);
    fs.mkdirSync(d, { recursive: true });
    const out = path.join(d, "out.log"), err = path.join(d, "err.log"), exit = path.join(d, "exit_code");
    fs.writeFileSync(path.join(d, "spec.json"), JSON.stringify({
      command: DUMMY_CLI, argv: [], cwd: jobRoot, out, err, exit,
    }));
    fs.writeFileSync(path.join(LAUNCHER_QUEUE_DIR, `${id}.json`), JSON.stringify({
      jobId: id, jobDir: d, specPath: path.join(d, "spec.json"), errPath: err,
      nodeExe: process.execPath, runnerScript,
      envOverrides: { DUMMY_SLEEP_SECONDS: "20", CLAUDE_ASYNC_HEARTBEAT_MS: "1000" },
      createdAt: new Date().toISOString(),
    }));
    jobDirs[id] = d;
  }

  try {
    // Two launcher instances started at (as close to) the same instant as node's event loop
    // allows -- exercises the same rename-to-claim race job-launcher.mjs faces when two
    // `schtasks /Run` calls land close together under MultipleInstances=Parallel.
    const launcherEnv = { ...process.env };
    const launchers = [0, 1].map(() => spawn(process.execPath, [launcherScript],
      { env: launcherEnv, stdio: "ignore", windowsHide: true }));

    const exits = await Promise.all(launchers.map((c) => new Promise((res) => c.on("exit", res))));
    if (exits.some((code) => code !== 0)) {
      return { label, ok: false, reason: `a launcher instance exited non-zero: ${JSON.stringify(exits)}` };
    }

    // Both tickets must be claimed (renamed to .claimed.json), neither left pending, neither
    // claimed by both (there's only one file per jobId regardless, but a double-spawn would show
    // up as two runner.pid writers racing -- checked via distinct, both-alive pids below).
    const stillPending = ids.filter((id) => fs.existsSync(path.join(LAUNCHER_QUEUE_DIR, `${id}.json`)));
    const bothClaimed = ids.every((id) => fs.existsSync(path.join(LAUNCHER_QUEUE_DIR, `${id}.claimed.json`)));

    const runnerPidPaths = ids.map((id) => path.join(jobDirs[id], "runner.pid"));
    await Promise.all(runnerPidPaths.map((p) => waitFor(() => fs.existsSync(p), 10000)));
    const runnerPids = runnerPidPaths.map((p) => fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8").trim()) : null);
    const bothStarted = runnerPids.every((pid) => pid && pidAlive(pid));
    const distinctPids = new Set(runnerPids).size === ids.length;

    const ok = stillPending.length === 0 && bothClaimed && bothStarted && distinctPids;
    return { label, ok, detail: { stillPending, bothClaimed, runnerPids, bothStarted, distinctPids } };
  } finally {
    for (const id of ids) {
      try { for (const p of [`${id}.json`, `${id}.claimed.json`]) fs.rmSync(path.join(LAUNCHER_QUEUE_DIR, p), { force: true }); } catch {}
    }
    for (const d of Object.values(jobDirs)) {
      try {
        const pidPath = path.join(d, "runner.pid");
        if (fs.existsSync(pidPath)) {
          const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
          process.kill(pid, "SIGKILL"); spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
        }
      } catch {}
    }
    try { fs.rmSync(jobRoot, { recursive: true, force: true }); } catch {}
  }
}

const build = spawnSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
   "-File", path.join(REPO, "test", "build-dummy-claude.ps1"), "-OutputPath", DUMMY_CLI],
  { encoding: "utf8" });
if (build.status !== 0) {
  console.error("Could not build test/dummy-claude.exe:", build.stdout, build.stderr);
  process.exit(1);
}

const results = [];
for (const [name, fn] of [
  ["a) tree-kill", scenarioTreeKill],
  ["b) external job-close", scenarioExternalJobClose],
  ["c) self job-close", scenarioSelfJobClose],
  ["race) claim race", raceClaimTest],
]) {
  console.log(`\n=== ${name} ===`);
  const r = await fn();
  console.log(JSON.stringify(r, null, 2));
  results.push(r);
}

console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`${r.label}: ${r.ok ? "PASS" : "FAIL"}` + (r.reason ? ` -- ${r.reason}` : "") +
    (r.launchPath ? ` (launchPath=${r.launchPath})` : ""));
}
const allOk = results.every((r) => r.ok);
console.log(allOk ? "\nPASS — all survival scenarios and the claim race hold"
                   : "\nFAIL — at least one scenario did not hold");
process.exit(allOk ? 0 : 1);
