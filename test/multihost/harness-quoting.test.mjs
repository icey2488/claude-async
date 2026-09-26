// test/job-close-harness.ps1 started its "parent" node process with Start-Process -ArgumentList.
// Windows PowerShell 5.1 joins that array with spaces WITHOUT quoting, so a repo path containing a
// space (the laptop's is ...\CC bridge\claude-async) reached node split in two: "Cannot find module
// '...\CC'", no marker written, harness TIMEOUT. These tests run each survival-test harness from a
// directory whose path (and every argument) contains spaces, with a harmless stub as the child, so
// survival.mjs's scenario (b)/(c) plumbing is checked without touching the live queue, job root or
// scheduled task.
//
// CLOSE_HARNESS_SCRIPT=<path> runs another copy of the job-close harness (e.g. `git show 72ef9bb:
// test/job-close-harness.ps1`) to see the old failure.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ca harness "));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const skip = process.platform !== "win32" && "Job Objects are Windows-only";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// resolves to the promise's value, or null after ms; the timer is cleared so a lost race holds nothing open
async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

// A ".../CC bridge/claude-async/test" look-alike, plus spaced names for every argument.
function spacedSetup(label, harnessSource, harnessName) {
  const dir = path.join(ROOT, label, "CC bridge", "claude-async", "test");
  const jobDir = path.join(dir, "job dir");
  fs.mkdirSync(jobDir, { recursive: true });
  const harness = path.join(dir, harnessName);
  fs.copyFileSync(harnessSource, harness);
  const stub = path.join(dir, "harness stub parent.mjs");
  fs.copyFileSync(path.join(HERE, "harness-stub-parent.mjs"), stub);
  const a = { harness, stub, jobDir, dummyCli: path.join(dir, "dummy claude.exe"), // never executed
    coreModule: path.join(dir, "job core.mjs"),                                      // never imported
    markerPath: path.join(dir, "parent marker.json"), parentPidFile: path.join(dir, "parent pid.txt"),
    hbPath: path.join(jobDir, "hb") };
  return a;
}

function startHarness(args, extra) {
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", args.harness, "-NodeExe", process.execPath, "-ParentScript", args.stub, "-JobDir", args.jobDir,
    "-DummyCli", args.dummyCli, "-CoreModule", args.coreModule, "-ParentPidFile", args.parentPidFile,
    "-MarkerPath", args.markerPath, ...extra,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const h = { child, out: "", err: "" };
  child.stdout.on("data", (d) => { h.out += d; });
  child.stderr.on("data", (d) => { h.err += d; });
  h.exited = new Promise((res) => child.once("exit", (code, signal) => res({ code, signal })));
  h.closed = new Promise((res) => child.once("close", res));
  return h;
}

test("job-close-harness.ps1 works from a path with spaces: every argument reaches the child intact", { skip, timeout: 90_000 }, async (t) => {
  const a = spacedSetup("close", process.env.CLOSE_HARNESS_SCRIPT || path.join(REPO, "test", "job-close-harness.ps1"),
    "job-close-harness.ps1");
  const h = startHarness(a, ["-HeartbeatPath", a.hbPath]);
  let stubPid = null;
  try {
    // The harness closes its own job once the stub's marker and heartbeat exist, which kills the
    // harness itself, so it exits without help.
    assert.ok(await withTimeout(h.exited, 60_000), `harness never exited: ${h.out}${h.err}`);
    await withTimeout(h.closed, 2000); // 'exit' can beat the last stdout chunk
    t.diagnostic(`harness output: ${h.out.trim().split(/\r?\n/).join(" | ")}`);

    assert.match(h.out, /READY pid=\d+/, `harness never reported READY: ${h.out}${h.err}`);
    assert.ok(!/TIMEOUT/.test(h.out), `harness timed out (the child never got its arguments?): ${h.out}${h.err}`);
    assert.ok(fs.existsSync(a.markerPath), `stub never wrote its marker: ${h.out}${h.err}`);
    const marker = JSON.parse(fs.readFileSync(a.markerPath, "utf8"));
    stubPid = marker.pid;
    assert.deepEqual(marker.argv, [a.jobDir, a.dummyCli, a.coreModule, a.markerPath], "each path must arrive as ONE argument");
    assert.ok(h.out.indexOf("READY") < h.out.indexOf("CLOSING"), `expected READY then CLOSING: ${h.out}${h.err}`);

    // The close fires KILL_ON_JOB_CLOSE on the harness and on the stub, which nested into the job.
    const deadline = Date.now() + 5000;
    while (alive(stubPid) && Date.now() < deadline) await sleep(100);
    assert.ok(!alive(stubPid), "the stub should have died with the job");
  } finally {
    try { h.child.kill(); } catch {}
    if (stubPid && alive(stubPid)) { try { process.kill(stubPid); } catch {} }
  }
});

test("job-object-harness.ps1 works from a path with spaces (it already quoted its CreateProcessW command line)", { skip, timeout: 90_000 }, async (t) => {
  const a = spacedSetup("object", path.join(REPO, "test", "job-object-harness.ps1"), "job-object-harness.ps1");
  const h = startHarness(a, []);
  let stubPid = null;
  try {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(a.markerPath) && Date.now() < deadline) await sleep(100);
    t.diagnostic(`harness output so far: ${h.out.trim().split(/\r?\n/).join(" | ")}`);
    assert.match(h.out, /READY pid=\d+/, `harness never reported READY: ${h.out}${h.err}`);
    assert.ok(fs.existsSync(a.markerPath), `stub never wrote its marker: ${h.out}${h.err}`);
    const marker = JSON.parse(fs.readFileSync(a.markerPath, "utf8"));
    stubPid = marker.pid;
    assert.deepEqual(marker.argv, [a.jobDir, a.dummyCli, a.coreModule, a.markerPath], "each path must arrive as ONE argument");
    assert.ok(alive(stubPid));

    // This harness holds the job open until it is killed by pid (no /T), which kills the stub via
    // KILL_ON_JOB_CLOSE; that is scenario (b)'s trigger.
    spawnSync("taskkill", ["/PID", String(h.child.pid), "/F"]);
    const until = Date.now() + 5000;
    while (alive(stubPid) && Date.now() < until) await sleep(100);
    assert.ok(!alive(stubPid), "the stub should have died with the job");
  } finally {
    try { spawnSync("taskkill", ["/PID", String(h.child.pid), "/F"]); } catch {}
    if (stubPid && alive(stubPid)) { try { process.kill(stubPid); } catch {} }
  }
});
