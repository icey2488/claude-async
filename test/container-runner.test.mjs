// End-to-end tests for job-runner.mjs's container-job handling, using the REAL runner and a fake
// docker CLI with a little shared "daemon" state (test/fixtures/fake-docker.mjs), so no Docker
// daemon is needed: stdout/stderr capture, exit.json, the completeness marker, cleanup by label
// (and its persisted state), cancel intent before/after the container exists, the signal fallback,
// the wall-clock limit, the entrypoint's clone-failure exit, the reported PR URL, and that no host
// git ever runs for a container job. checkJob()/cancelJob() run against the same job dirs, so the
// retry-until-confirmed behaviour is exercised across both processes.
// Host-job behavior of the runner is covered by test/multihost/exit-reason.test.mjs.
// Run: node --test test/container-runner.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "job-runner.mjs");
const FAKE_DOCKER = path.join(here, "fixtures", "fake-docker.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-container-runner-"));
process.env.CLAUDE_ASYNC_JOB_DIR = path.join(TMP, "jobs");
process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);
const core = await import("../job-core.mjs");
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// The fake docker is a node script; on win32 a .mjs can't be spawned directly, so the "docker
// binary" in spec.json is a small POSIX shim that execs node with the script.
function makeDockerShim(dir) {
  if (process.platform === "win32") return null; // covered on Linux/macOS; see skip below
  const shim = path.join(dir, "docker");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

let seq = 0;
const REPO = "icey2488/container-job-scratch";
const SECRET_GH = "ghp_RUNNERSECRET000000000000000000000000";
const SECRET_OAUTH = "sk-ant-oat01-RUNNERSECRET";
function setup(extraEnv = {}, { meta = {}, maxRuntimeMs = 4 * 3600_000 } = {}) {
  const jobId = `cjob-${process.pid}-${++seq}`;
  const dir = path.join(core.JOB_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const docker = makeDockerShim(dir);
  const name = `claude-async-${jobId}`;
  const log = path.join(dir, "docker-calls.jsonl");
  const spec = { command: docker,
                 argv: ["run", "--rm", "--pull=never", "--name", name, "--label", `claude-async.job=${jobId}`, "img",
                        "/usr/local/bin/claude-async-job-entry", REPO, "", "--", "claude", "-p", "--", "x"],
                 cwd: dir, out: path.join(dir, "out.log"), err: path.join(dir, "err.log"), exit: path.join(dir, "exit_code"),
                 container: { name, jobId, dockerBin: docker, repo: REPO, maxRuntimeMs, envFile: path.join(dir, "secrets.env") } };
  fs.writeFileSync(spec.container.envFile, `GH_TOKEN=${SECRET_GH}\nCLAUDE_CODE_OAUTH_TOKEN=${SECRET_OAUTH}\n`);
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId, pid: 1, startedAt: new Date().toISOString(),
    sandbox: "container", container: { name, jobId, dockerBin: docker, repo: REPO }, ...meta }));
  const env = { ...process.env, FAKE_DOCKER_LOG: log, CLAUDE_ASYNC_TEST: "1", HOME: path.join(TMP, "home"),
                USERPROFILE: path.join(TMP, "home"), CLAUDE_ASYNC_CONFIG_DIR: path.join(TMP, "home", ".claude-async"),
                CLAUNKER_JOBCARD_CMD: JSON.stringify(["__no_such_jobcard_binary__"]), CLAUDE_ASYNC_CONTAINER_POLL_MS: "100",
                ...extraEnv };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).argv) : []);
  const exitRecord = () => JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
  const containerExists = () => fs.existsSync(`${log}.state.json`);
  const patchMeta = (patch) => { const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
                                 fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...m, ...patch })); };
  return { jobId, dir, name, env, log, calls, exitRecord, containerExists, patchMeta, spec: path.join(dir, "spec.json") };
}
const pidGone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
// checkJob()/cancelJob() run in this process; point the fake at the job's daemon state while fn runs.
function withFakeDaemon(j, fn, extra = {}) {
  const saved = {};
  const set = { FAKE_DOCKER_LOG: j.log, ...extra };
  for (const k of Object.keys(set)) { saved[k] = process.env[k]; process.env[k] = set[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(set)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
// Makes checkJob classify a runner that is really dead as died now, instead of after the 3 min
// heartbeat-freshness window: the runner's last heartbeat is rewritten 10 minutes into the past.
const ageHeartbeat = (j) => fs.writeFileSync(path.join(j.dir, "runner_heartbeat"), new Date(Date.now() - 10 * 60_000).toISOString());
const runSync = (j, env = j.env) => spawnSync(process.execPath, [RUNNER, j.spec], { env, encoding: "utf8", timeout: 60_000 });
const waitFor = async (pred, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return pred();
};
const exited = (child) => new Promise((r) => child.on("exit", (c) => r(c)));

const SKIP = process.platform === "win32" ? "fake docker shim is POSIX-only" : false;

test("container job: output captured, exit.json written, cleanup by label confirmed in finish()", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_STDOUT: "DELEGATION-METRICS: zero calls" });
  const r = runSync(j);
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(path.join(j.dir, "out.log"), "utf8"), /container stdout/);
  assert.match(fs.readFileSync(path.join(j.dir, "err.log"), "utf8"), /container stderr/);
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.reportComplete, true, "the DELEGATION-METRICS marker is still detected through docker");
  assert.equal(rec.container.name, j.name);
  assert.equal(rec.container.repo, REPO);
  assert.equal(rec.container.newGitFindings, undefined, "no host .git audit any more");
  assert.equal(rec.container.cleanup.confirmed, true);
  assert.equal(fs.readFileSync(path.join(j.dir, "exit_code"), "utf8"), "0");
  const calls = j.calls();
  assert.equal(calls[0][0], "run");
  assert.deepEqual(calls.at(-1).slice(0, 5), ["ps", "-a", "--no-trunc", "--filter", `label=claude-async.job=${j.jobId}`],
    "finish() lists this job's containers by label");
  assert.ok(!calls.some((a) => a[0] === "kill"), "never by name");
  assert.equal(core.checkJob(j.jobId, 0).containerCleanup, "confirmed");
});

test("container job: a nonzero container exit is recorded as-is; docker run failure (125) gets a warning", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_RUN_EXIT: "125" });
  runSync(j);
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 125);
  assert.ok(rec.warnings.some((w) => /docker run itself failed/.test(w)));
  assert.equal(fs.readFileSync(path.join(j.dir, "exit_code"), "utf8"), "125");
});

// Astra #3: the client exits while its container keeps running, and the final cleanup fails
// because the daemon is unreachable. The job must not look cleaned up, and once the daemon is back
// checkJob()/cancelJob() must stop the container and only then confirm.
test("cleanup failure after client exit: unconfirmed in exit.json, retried by checkJob until the container is gone", { skip: SKIP }, () => {
  const down = path.join(TMP, `daemon-down-${seq + 1}`);
  fs.writeFileSync(down, "");
  const j = setup({ FAKE_DOCKER_LEAVE_RUNNING: "1", FAKE_DOCKER_DAEMON_DOWN: down });
  runSync(j);
  const rec = j.exitRecord();
  assert.equal(rec.container.cleanup.confirmed, false);
  assert.match(rec.container.cleanup.error, /Cannot connect to the Docker daemon/);
  assert.ok(j.containerExists(), "the container is still running");
  assert.match(fs.readFileSync(path.join(j.dir, "err.log"), "utf8"), /cleanup .* not confirmed/);
  // checkJob/cancelJob run in this process; point the fake at the same daemon state
  process.env.FAKE_DOCKER_LOG = j.log;
  process.env.FAKE_DOCKER_DAEMON_DOWN = down;
  try {
    const s1 = core.checkJob(j.jobId, 0);
    assert.equal(s1.containerCleanup, "unconfirmed");
    const c1 = core.cancelJob(j.jobId);
    assert.notEqual(c1.alreadyFinished, true, "never alreadyFinished while cleanup is unconfirmed");
    assert.equal(c1.ok, false);
    assert.equal(c1.cleanup, "unconfirmed");
    fs.rmSync(down);                                         // daemon back
    const s2 = core.checkJob(j.jobId, 0);
    assert.equal(s2.containerCleanup, "confirmed");
    assert.ok(!j.containerExists(), "checkJob removed the stranded container");
    assert.equal(JSON.parse(fs.readFileSync(path.join(j.dir, "meta.json"), "utf8")).containerCleanup.confirmed, true);
    const before = j.calls().length;
    assert.equal(core.cancelJob(j.jobId).alreadyFinished, true, "alreadyFinished once confirmed");
    core.checkJob(j.jobId, 0);
    assert.equal(j.calls().length, before, "no docker calls once confirmed");
  } finally { delete process.env.FAKE_DOCKER_LOG; delete process.env.FAKE_DOCKER_DAEMON_DOWN; }
});

// Astra #4 / Argon #5: cancel recorded before the runner gets to `docker run`.
test("cancel before launch: the runner never starts docker run and records a cancelled exit", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_RUN_MS: "20000" });
  fs.writeFileSync(path.join(j.dir, "cancel_requested"), new Date().toISOString());
  runSync(j);
  assert.ok(!j.calls().some((a) => a[0] === "run"), "docker run never invoked");
  const rec = j.exitRecord();
  assert.equal(rec.exitReason, "cancelled");
  assert.equal(rec.container.cancelled, true);
  assert.equal(rec.container.cleanup.confirmed, true);
  assert.equal(core.checkJob(j.jobId, 0).status, "failed");
});

// Cancel while `docker run` is still creating the container: cancelJob finds nothing ("No such
// container"), so it must NOT report cleanup done; the runner sees the persisted intent right
// after creation and removes the container immediately.
test("cancel while the container is being created: nothing confirmed early, the container is stopped at once", { skip: SKIP }, async () => {
  const j = setup({ FAKE_DOCKER_CREATE_DELAY_MS: "1500", FAKE_DOCKER_RUN_MS: "30000" });
  const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
  assert.ok(await waitFor(() => j.calls().some((a) => a[0] === "run")), "docker run started");
  process.env.FAKE_DOCKER_LOG = j.log;
  let c;
  try { c = core.cancelJob(j.jobId); } finally { delete process.env.FAKE_DOCKER_LOG; }
  assert.equal(c.ok, true);
  assert.equal(c.cancelRequested, true);
  assert.equal(c.removed, 0, "no container exists yet");
  assert.notEqual(c.cleanup, "confirmed", "a pending launch is never confirmed");
  assert.ok(fs.existsSync(path.join(j.dir, "cancel_requested")), "intent persisted");
  const t0 = Date.now();
  const code = await exited(child);
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 10_000, "stopped right after creation, not after its 30s run");
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 137);
  assert.equal(rec.exitReason, "cancelled");
  assert.equal(rec.container.cleanup.confirmed, true);
  assert.ok(!j.containerExists());
});

test("SIGTERM to the runner removes the container by label and the job still records its exit", { skip: SKIP }, async () => {
  const j = setup({ FAKE_DOCKER_RUN_MS: "20000" });
  const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
  assert.ok(await waitFor(() => j.containerExists()));
  child.kill("SIGTERM");
  assert.equal(await exited(child), 0, "the runner itself exits normally after recording");
  const rms = j.calls().filter((a) => a[0] === "rm");
  assert.ok(rms.length >= 1);
  assert.ok(rms.every((a) => a.length === 3 && a[1] === "-f" && /^[0-9a-f]{64}$/.test(a[2])), "rm -f by container ID");
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 137, "the docker client reports the killed container's status");
  assert.equal(rec.container.cleanup.confirmed, true);
  assert.match(fs.readFileSync(path.join(j.dir, "err.log"), "utf8"), /SIGTERM received; removing container/);
});

// Argon #9: the daemon accepts the remove but the container (and the attached client) keep going.
test("signal fallback: client killed after the wait, cleanup recorded as NOT confirmed", { skip: SKIP }, async () => {
  const j = setup({ FAKE_DOCKER_RUN_MS: "30000", FAKE_DOCKER_IGNORE_RM: "1", CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS: "1500" });
  const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
  assert.ok(await waitFor(() => j.containerExists()));
  const t0 = Date.now();
  child.kill("SIGTERM");
  assert.equal(await exited(child), 0);
  assert.ok(Date.now() - t0 < 10_000, "the runner does not wait for the 30s client");
  const rec = j.exitRecord();
  assert.equal(rec.exitReason, "signal");
  assert.equal(rec.container.cleanup.confirmed, false);
  const dockerPid = Number(fs.readFileSync(path.join(j.dir, "docker_client.pid"), "utf8"));
  assert.ok(await waitFor(() => { try { process.kill(dockerPid, 0); return false; } catch { return true; } }, 5000),
    "the docker client was killed");
});

test("wall-clock limit: the runner removes the container and the job reads timed_out", { skip: SKIP }, async () => {
  const j = setup({ FAKE_DOCKER_RUN_MS: "30000" }, { maxRuntimeMs: 1500 });
  const t0 = Date.now();
  runSync(j);
  assert.ok(Date.now() - t0 < 15_000);
  const rec = j.exitRecord();
  assert.equal(rec.exitReason, "container_max_runtime");
  assert.equal(rec.container.maxRuntimeExceeded, true);
  assert.ok(rec.warnings.some((w) => /wall-clock limit/.test(w)));
  assert.equal(core.checkJob(j.jobId, 0).status, "timed_out");
});

test("container job: the entrypoint's clone failure (exit 70) gets its own warning", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_RUN_EXIT: "70" });
  runSync(j);
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 70);
  assert.ok(rec.warnings.some((w) => /could not clone icey2488\/container-job-scratch/.test(w)), JSON.stringify(rec.warnings));
});

test("container job: the PR URL the job printed for its own repo is recorded; other repos' URLs are not", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_STDOUT: "see https://github.com/someone/else/pull/9\nPR: https://github.com/icey2488/container-job-scratch/pull/12\nDELEGATION-METRICS: zero calls" });
  runSync(j);
  assert.equal(j.exitRecord().container.prUrl, "https://github.com/icey2488/container-job-scratch/pull/12");
  const k = setup({ FAKE_DOCKER_STDOUT: "no pr: https://github.com/someone/else/pull/9" });
  runSync(k);
  assert.equal(k.exitRecord().container.prUrl, null);
});

test("container job: the card close never runs host git, even with a startHead in meta", { skip: SKIP }, () => {
  const bin = path.join(TMP, `gitshim-${seq}`);
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(bin, "git-calls.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$PWD $*" >> "${log}"\necho 0000000000000000000000000000000000000001\n`);
  fs.chmodSync(path.join(bin, "git"), 0o755);
  // A jobcard command that always succeeds, so closeCard gets as far as its delivery check.
  const okCard = JSON.stringify([process.execPath, "-e", "process.stdout.write('card-1')"]);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUNKER_JOBCARD_CMD: okCard,
                FAKE_DOCKER_STDOUT: "DELEGATION-METRICS: zero calls" };
  const j = setup(env, { meta: { cardId: "card-1", startHead: "ffffffffffffffffffffffffffffffffffffffff" } });
  runSync(j);
  assert.equal(j.exitRecord().exitCode, 0);
  assert.ok(!fs.existsSync(log), `host git ran for a container job: ${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""}`);
});

// Argon #6: a job that prints its tokens. out.log keeps them (documented); nothing that leaves the
// runner does: exit.json tails, and the Discord ping's headline (sent here to a local server).
test("redaction: printed tokens never reach exit.json or the Discord ping", { skip: SKIP }, async () => {
  const got = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(b); res.end("ok"); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const cfgDir = path.join(TMP, `notify-${seq + 1}`);
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "notify.json"), JSON.stringify({ discord: {
      webhookUrl: `http://127.0.0.1:${server.address().port}/hook`, includeHeadline: true } }));
    const leak = `LEAK ${SECRET_GH} ${SECRET_OAUTH} gho_${"k".repeat(36)}`;
    const j = setup({ CLAUDE_ASYNC_CONFIG_DIR: cfgDir, FAKE_DOCKER_STDOUT: `${leak}\nDELEGATION-METRICS: zero calls` });
    const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
    await exited(child);
    const rec = JSON.stringify(j.exitRecord());
    for (const v of [SECRET_GH, SECRET_OAUTH, "gho_kkk"]) assert.ok(!rec.includes(v), `exit.json leaks ${v}`);
    assert.match(rec, /LEAK \[REDACTED\]/);
    assert.equal(got.length, 1, "the ping was sent");
    for (const v of [SECRET_GH, SECRET_OAUTH, "gho_kkk"]) assert.ok(!got[0].includes(v), `ping leaks ${v}: ${got[0]}`);
    assert.match(got[0], /REDACTED/, "the headline was the leaking line, redacted");
    assert.match(fs.readFileSync(path.join(j.dir, "out.log"), "utf8"), new RegExp(SECRET_GH), "out.log on disk stays raw");
  } finally { await new Promise((r) => server.close(r)); }
});

// ------------------------------------------------------------ review round 2, finding A1 ---
// Cleanup must never be confirmed while a docker client that could still create the container is
// alive, or while a killed client's create request may still be in flight daemon-side.

// The runner dies right after spawning `docker run`, before it could persist the client's pid. The
// client survives and the daemon creates the container later. The first check must stay
// unconfirmed (nothing to list yet, but a client carrying this job's label is alive); a later one
// must find the container and remove it; confirmation comes only once the client is gone.
test("A1: runner killed between spawn and pid persistence; delayed creation is still found and removed", { skip: SKIP }, async () => {
  const j = setup({ CLAUDE_ASYNC_TEST_DIE_AFTER_SPAWN: "1", FAKE_DOCKER_DAEMON_CREATE_DELAY_MS: "2500", FAKE_DOCKER_RUN_MS: "60000" });
  const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
  j.patchMeta({ pid: child.pid });
  await exited(child);
  assert.ok(!fs.existsSync(path.join(j.dir, "docker_client.pid")), "the pid was never persisted (that is the scenario)");
  assert.ok(!fs.existsSync(path.join(j.dir, "exit_code")));
  assert.ok(!j.containerExists(), "the daemon has not created the container yet");
  ageHeartbeat(j);
  const s1 = withFakeDaemon(j, () => core.checkJob(j.jobId, 0));
  assert.equal(s1.status, "died");
  assert.equal(s1.containerCleanup, "unconfirmed", `an empty listing with a live docker client is not cleanup: ${JSON.stringify(s1)}`);
  assert.ok(await waitFor(() => j.containerExists(), 10_000), "the surviving client's create request was served");
  const s2 = withFakeDaemon(j, () => core.checkJob(j.jobId, 0));
  assert.ok(!j.containerExists(), "the later check found and removed the container");
  assert.ok(await waitFor(() => withFakeDaemon(j, () => core.checkJob(j.jobId, 0)).containerCleanup === "confirmed", 10_000),
    `confirmed once the client is gone (last: ${JSON.stringify(s2.containerCleanupError)})`);
});

// Signal fallback with a create request still in flight: SIGTERM lands while `docker run` is
// waiting on the daemon, the stop wait passes, the client is killed, and the daemon creates the
// container AFTER the runner finished. The runner recorded "unconfirmed"; the next check must not
// turn one empty listing into permanent success while the killed client's request may still land.
test("A1: delayed daemon creation after the signal fallback is reaped, not confirmed away", { skip: SKIP }, async () => {
  const j = setup({ FAKE_DOCKER_DAEMON_CREATE_DELAY_MS: "4000", FAKE_DOCKER_RUN_MS: "60000", CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS: "1000" });
  const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
  j.patchMeta({ pid: child.pid });
  assert.ok(await waitFor(() => j.calls().some((a) => a[0] === "run")), "docker run started");
  child.kill("SIGTERM");
  assert.equal(await exited(child), 0);
  const rec = j.exitRecord();
  assert.equal(rec.container.cleanup.confirmed, false);
  assert.ok(!j.containerExists(), "nothing exists yet when the runner finished");
  const hold = { CLAUDE_ASYNC_CONTAINER_CONFIRM_HOLD_MS: "3000" };
  const s1 = withFakeDaemon(j, () => core.checkJob(j.jobId, 0), hold);
  assert.equal(s1.containerCleanup, "unconfirmed", `right after a killed client, one empty listing is not confirmation: ${JSON.stringify(s1.containerCleanupError)}`);
  assert.ok(await waitFor(() => j.containerExists(), 10_000), "the killed client's create request was served by the daemon");
  withFakeDaemon(j, () => core.checkJob(j.jobId, 0), hold);
  assert.ok(!j.containerExists(), "the late container was removed");
  assert.ok(await waitFor(() => withFakeDaemon(j, () => core.checkJob(j.jobId, 0), hold).containerCleanup === "confirmed", 10_000));
});

// ------------------------------------------------------------ review round 2, finding A4 ---
// Cancel and the wall-clock limit go through the same bounded stop as a signal: remove by label,
// wait CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS, then kill the client and finish with the terminal
// status and cleanup NOT confirmed, so job-core keeps retrying. Removal attempts are throttled so
// the synchronous docker calls do not starve the heartbeat.

async function boundedStopCase({ trigger, env, maxRuntimeMs, recover, expectReason, expectStatus }) {
  const j = setup({ FAKE_DOCKER_RUN_MS: "60000", CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS: "2500", ...env }, { maxRuntimeMs });
  const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
  j.patchMeta({ pid: child.pid });
  assert.ok(await waitFor(() => j.containerExists()));
  const t0 = Date.now();
  if (trigger) await trigger(j);
  assert.equal(await exited(child), 0, "the runner exits normally after recording");
  const took = Date.now() - t0;
  assert.ok(took < 15_000, `bounded: finished in ${took} ms`);
  const rec = j.exitRecord();
  assert.equal(rec.exitReason, expectReason, JSON.stringify(rec));
  assert.equal(rec.container.cleanup.confirmed, false, "a container the daemon would not remove is never reported as removed");
  assert.ok(rec.container.cleanup.clientKilled, "the client was killed after the stop wait");
  const dockerPid = Number(fs.readFileSync(path.join(j.dir, "docker_client.pid"), "utf8"));
  assert.ok(await waitFor(() => pidGone(dockerPid), 5000), "the docker client is gone");
  for (const w of rec.warnings || []) assert.ok(!/was removed/.test(w), `must not claim removal: ${w}`);
  assert.ok(j.containerExists(), "the container is still there (daemon ignored rm / was down)");
  const psCalls = j.calls().filter((a) => a[0] === "ps").length;
  assert.ok(psCalls <= 6, `removal attempts are throttled, not one per 100 ms poll tick (${psCalls} docker ps calls)`);
  const hold = { CLAUDE_ASYNC_CONTAINER_CONFIRM_HOLD_MS: "300" };
  const s1 = withFakeDaemon(j, () => core.checkJob(j.jobId, 0), { ...hold, ...env });
  assert.equal(s1.status, expectStatus);
  assert.equal(s1.containerCleanup, "unconfirmed");
  recover(j);
  await new Promise((r) => setTimeout(r, 400));
  const s2 = withFakeDaemon(j, () => core.checkJob(j.jobId, 0), hold);
  assert.ok(!j.containerExists(), "after recovery the check removed the container");
  const s3 = withFakeDaemon(j, () => core.checkJob(j.jobId, 0), hold);
  assert.equal(s2.containerCleanup === "confirmed" || s3.containerCleanup === "confirmed", true, JSON.stringify([s2.containerCleanupError, s3.containerCleanupError]));
  assert.equal(s3.status, expectStatus);
  return j;
}

test("A4: wall-clock limit with a daemon that ignores rm: bounded timed_out, cleanup unconfirmed, confirmed after recovery", { skip: SKIP }, async () => {
  const ignore = path.join(TMP, `ignore-rm-${seq + 1}`);
  fs.writeFileSync(ignore, "");
  await boundedStopCase({ env: { FAKE_DOCKER_IGNORE_RM: ignore }, maxRuntimeMs: 1500,
    recover: () => fs.rmSync(ignore), expectReason: "container_max_runtime", expectStatus: "timed_out" });
});

test("A4: wall-clock limit with the daemon down: bounded timed_out, confirmed once the daemon is back", { skip: SKIP }, async () => {
  const down = path.join(TMP, `daemon-down-limit-${seq + 1}`);
  const j = setup({});                                    // just to learn the next seq's paths; not run
  assert.ok(j);
  await boundedStopCase({ env: { FAKE_DOCKER_DAEMON_DOWN: down }, maxRuntimeMs: 1500,
    trigger: () => { fs.writeFileSync(down, ""); },        // the daemon goes away while the job runs
    recover: () => fs.rmSync(down), expectReason: "container_max_runtime", expectStatus: "timed_out" });
});

test("A4: cancel with a daemon that ignores rm: bounded cancelled exit, cleanup unconfirmed, confirmed after recovery", { skip: SKIP }, async () => {
  const ignore = path.join(TMP, `ignore-rm-cancel-${seq + 1}`);
  fs.writeFileSync(ignore, "");
  await boundedStopCase({ env: { FAKE_DOCKER_IGNORE_RM: ignore }, maxRuntimeMs: 4 * 3600_000,
    trigger: (j) => { const c = withFakeDaemon(j, () => core.cancelJob(j.jobId), { FAKE_DOCKER_IGNORE_RM: ignore });
                      assert.equal(c.cancelRequested, true); },
    recover: () => fs.rmSync(ignore), expectReason: "cancelled", expectStatus: "failed" });
});

// Argon #1 (4): the fallback kill sets exitReason "signal"; the limit/cancel override must still win,
// or the job reads failed instead of timed_out. Covered by the two tests above through checkJob's
// status; this one pins the exit.json field for the wall-clock case with the client killed.
test("A4: a wall-clock stop that needed the fallback kill still records container_max_runtime, not signal", { skip: SKIP }, async () => {
  const j = setup({ FAKE_DOCKER_RUN_MS: "60000", FAKE_DOCKER_IGNORE_RM: "1", CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS: "1000" }, { maxRuntimeMs: 1200 });
  runSync(j);
  const rec = j.exitRecord();
  assert.equal(rec.exitSignal, "SIGKILL");
  assert.equal(rec.exitReason, "container_max_runtime");
  assert.equal(rec.container.maxRuntimeExceeded, true);
  assert.equal(core.checkJob(j.jobId, 0, { cleanupContainers: () => ({ ok: true, absent: true, removed: 0, remaining: [] }), findDockerClients: () => [] }).status, "timed_out");
});
