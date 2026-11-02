// End-to-end tests for job-runner.mjs's container-job handling, using the REAL runner and a fake
// docker CLI (test/fixtures/fake-docker.mjs) so no Docker daemon is needed: stdout/stderr capture,
// exit.json, the completeness marker, kill-by-name on SIGTERM and in finish(), and the post-run
// .git audit. Host-job behavior of the runner is covered by test/multihost/exit-reason.test.mjs.
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
const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;

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
function setup(extraEnv = {}) {
  const dir = path.join(TMP, `job-${++seq}`);
  const repo = path.join(TMP, `repo-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  const docker = makeDockerShim(dir);
  const name = `claude-async-cjob-${seq}`;
  const log = path.join(dir, "docker-calls.jsonl");
  const spec = { command: docker, argv: ["run", "--rm", "--name", name, "img", "claude", "-p", "--", "x"], cwd: repo,
                 out: path.join(dir, "out.log"), err: path.join(dir, "err.log"), exit: path.join(dir, "exit_code"),
                 container: { name, dockerBin: docker, repo, gitBaseline: [] } };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId: `cjob-${seq}`, pid: 1 }));
  const env = { ...process.env, FAKE_DOCKER_LOG: log, CLAUDE_ASYNC_TEST: "1", HOME: path.join(TMP, "home"),
                USERPROFILE: path.join(TMP, "home"), CLAUDE_ASYNC_CONFIG_DIR: path.join(TMP, "home", ".claude-async"),
                CLAUNKER_JOBCARD_CMD: JSON.stringify(["__no_such_jobcard_binary__"]), ...extraEnv };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).argv) : []);
  const exitRecord = () => JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
  return { dir, repo, name, env, calls, exitRecord, spec: path.join(dir, "spec.json") };
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
  assert.deepEqual(rec.container, { name: j.name, newGitFindings: [] });
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

test("container job: git config/hooks planted by the job are reported and the card's host git call is skipped",
  { skip: SKIP || (!HAVE_GIT && "git not available") }, () => {
  const j0 = setup();
  const plant = { [path.join(j0.repo, ".git", "hooks", "post-checkout")]: "#!/bin/sh\necho pwned\n",
                  [path.join(j0.repo, ".git", "config")]: "[core]\n\trepositoryformatversion = 0\n\tfsmonitor = /tmp/x.sh\n" };
  const env = { ...j0.env, FAKE_DOCKER_PLANT: JSON.stringify(plant) };
  spawnSync(process.execPath, [RUNNER, j0.spec], { env, encoding: "utf8", timeout: 60_000 });
  const rec = j0.exitRecord();
  assert.deepEqual(rec.container.newGitFindings, ["config:.git/config:core.fsmonitor", "hook:.git/hooks/post-checkout"]);
  assert.ok(rec.warnings.some((w) => /would run on the HOST/.test(w)));
  assert.match(fs.readFileSync(path.join(j0.dir, "err.log"), "utf8"), /new \.git findings/);
});

test("container job: findings present BEFORE the job (baseline) are not reported again", { skip: SKIP || (!HAVE_GIT && "git not available") }, () => {
  const j = setup();
  fs.writeFileSync(path.join(j.repo, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
  const spec = JSON.parse(fs.readFileSync(j.spec, "utf8"));
  spec.container.gitBaseline = ["hook:.git/hooks/pre-push"];
  fs.writeFileSync(j.spec, JSON.stringify(spec));
  spawnSync(process.execPath, [RUNNER, j.spec], { env: j.env, encoding: "utf8", timeout: 60_000 });
  assert.deepEqual(j.exitRecord().container.newGitFindings, []);
});
