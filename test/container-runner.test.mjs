// End-to-end tests for job-runner.mjs's container-job handling, using the REAL runner and a fake
// docker CLI (test/fixtures/fake-docker.mjs) so no Docker daemon is needed: stdout/stderr capture,
// exit.json, the completeness marker, kill-by-name on SIGTERM and in finish(), the entrypoint's
// clone-failure exit, the reported PR URL, and that no host git ever runs for a container job. Host-job behavior of the runner is covered by test/multihost/exit-reason.test.mjs.
// Run: node --test test/container-runner.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "job-runner.mjs");
const FAKE_DOCKER = path.join(here, "fixtures", "fake-docker.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-container-runner-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// The fake docker is a node script; on win32 a .mjs can't be spawned directly, so the "docker
// binary" in spec.json is a small launcher: node itself, with the script as the first argv entry.
// spec.container.dockerBin gets the same treatment through a wrapper file.
function makeDockerShim(dir) {
  if (process.platform === "win32") return null; // covered on Linux/macOS; see skip below
  const shim = path.join(dir, "docker");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

let seq = 0;
const REPO = "icey2488/container-job-scratch";
function setup(extraEnv = {}, { meta = {} } = {}) {
  const dir = path.join(TMP, `job-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const docker = makeDockerShim(dir);
  const name = `claude-async-cjob-${seq}`;
  const log = path.join(dir, "docker-calls.jsonl");
  const spec = { command: docker, argv: ["run", "--rm", "--name", name, "img", "/usr/local/bin/claude-async-job-entry", REPO, "", "--", "claude", "-p", "--", "x"],
                 cwd: dir, out: path.join(dir, "out.log"), err: path.join(dir, "err.log"), exit: path.join(dir, "exit_code"),
                 container: { name, dockerBin: docker, repo: REPO } };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId: `cjob-${seq}`, pid: 1, ...meta }));
  const env = { ...process.env, FAKE_DOCKER_LOG: log, CLAUDE_ASYNC_TEST: "1", HOME: path.join(TMP, "home"),
                USERPROFILE: path.join(TMP, "home"), CLAUDE_ASYNC_CONFIG_DIR: path.join(TMP, "home", ".claude-async"),
                CLAUNKER_JOBCARD_CMD: JSON.stringify(["__no_such_jobcard_binary__"]), ...extraEnv };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).argv) : []);
  const exitRecord = () => JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
  return { dir, name, env, calls, exitRecord, spec: path.join(dir, "spec.json") };
}

const SKIP = process.platform === "win32" ? "fake docker shim is POSIX-only" : false;

test("container job: docker output is captured, exit.json written, container killed by name in finish()", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_STDOUT: "DELEGATION-METRICS: zero calls" });
  const r = spawnSync(process.execPath, [RUNNER, j.spec], { env: j.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0);
  const out = fs.readFileSync(path.join(j.dir, "out.log"), "utf8");
  assert.match(out, /container stdout/);
  assert.match(fs.readFileSync(path.join(j.dir, "err.log"), "utf8"), /container stderr/);
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.reportComplete, true, "the DELEGATION-METRICS marker is still detected through docker");
  assert.equal(rec.container.name, j.name);
  assert.equal(rec.container.repo, REPO);
  assert.equal(rec.container.newGitFindings, undefined, "no host .git audit any more");
  assert.equal(fs.readFileSync(path.join(j.dir, "exit_code"), "utf8"), "0");
  const calls = j.calls();
  assert.equal(calls[0][0], "run");
  assert.deepEqual(calls.at(-1), ["kill", j.name], "finish() always kills by name");
});

test("container job: a nonzero container exit is recorded as-is; docker run failure (125) gets a warning", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_RUN_EXIT: "125", FAKE_DOCKER_KILL_GONE: "1" });
  spawnSync(process.execPath, [RUNNER, j.spec], { env: j.env, encoding: "utf8", timeout: 60_000 });
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 125);
  assert.ok(rec.warnings.some((w) => /docker run itself failed/.test(w)));
  assert.equal(fs.readFileSync(path.join(j.dir, "exit_code"), "utf8"), "125");
  assert.doesNotMatch(fs.readFileSync(path.join(j.dir, "err.log"), "utf8"), /docker kill .* failed/, "an already-gone container is not an error");
});

test("container job: SIGTERM to the runner kills the container by name and the job still records its exit", { skip: SKIP }, async () => {
  const j = setup({ FAKE_DOCKER_RUN_MS: "20000" });
  const child = spawn(process.execPath, [RUNNER, j.spec], { env: j.env, stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  while (!j.calls().some((a) => a[0] === "run") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 0, "the runner itself exits normally after recording");
  const kills = j.calls().filter((a) => a[0] === "kill");
  assert.ok(kills.length >= 1);
  assert.ok(kills.every((a) => a.length === 2 && a[1] === j.name), "every kill names the container");
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 137, "the docker client reports the killed container's status");
  assert.match(fs.readFileSync(path.join(j.dir, "err.log"), "utf8"), /SIGTERM received; killing container/);
});

test("container job: the entrypoint's clone failure (exit 70) gets its own warning", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_RUN_EXIT: "70", FAKE_DOCKER_KILL_GONE: "1" });
  spawnSync(process.execPath, [RUNNER, j.spec], { env: j.env, encoding: "utf8", timeout: 60_000 });
  const rec = j.exitRecord();
  assert.equal(rec.exitCode, 70);
  assert.ok(rec.warnings.some((w) => /could not clone icey2488\/container-job-scratch/.test(w)), JSON.stringify(rec.warnings));
});

test("container job: the PR URL the job printed for its own repo is recorded; other repos' URLs are not", { skip: SKIP }, () => {
  const j = setup({ FAKE_DOCKER_STDOUT: "see https://github.com/someone/else/pull/9\nPR: https://github.com/icey2488/container-job-scratch/pull/12\nDELEGATION-METRICS: zero calls" });
  spawnSync(process.execPath, [RUNNER, j.spec], { env: j.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(j.exitRecord().container.prUrl, "https://github.com/icey2488/container-job-scratch/pull/12");
  const k = setup({ FAKE_DOCKER_STDOUT: "no pr: https://github.com/someone/else/pull/9" });
  spawnSync(process.execPath, [RUNNER, k.spec], { env: k.env, encoding: "utf8", timeout: 60_000 });
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
  spawnSync(process.execPath, [RUNNER, j.spec], { env: j.env, encoding: "utf8", timeout: 60_000 });
  assert.equal(j.exitRecord().exitCode, 0);
  assert.ok(!fs.existsSync(log), `host git ran for a container job: ${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""}`);
});
