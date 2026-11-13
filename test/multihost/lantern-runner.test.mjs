// lantern-notify.mjs / lantern-session.mjs, wired into the REAL job-runner.mjs: integration tests
// against a local (loopback) HTTP server standing in for AgentGlass, with no fakes inside
// job-runner.mjs itself. CLAUDE_ASYNC_LANTERN (the real, documented off-switch) still works via
// env; pointing the runner at the test server, instead of a real AgentGlass install, goes through
// spec.json's own `lanternServer` field (see job-runner.mjs) -- a per-job parameter only this
// test's own spec.json carries, never an env var every spawned job-runner.mjs would inherit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTmp, TMP } from "./_setup.mjs";
import { projectDirNameForCwd, claudeProjectsDir } from "../../lantern-session.mjs";
import { LANTERN_HOST, resolveLanternPort } from "../../lantern-notify.mjs";

after(cleanupTmp);

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "..", "job-runner.mjs");
const FAKE = path.join(here, "lantern-fake-cli.mjs");
let seq = 0;

// Prepares a job dir + spec.json + meta.json (no `intent` unless the test adds one later) with a
// FRESH cwd dir standing in for the job's workFolder, without running the runner yet.
function prepareJob({ sleepMs = 0, exitCode = 0 } = {}) {
  const id = ++seq;
  const dir = path.join(TMP, `lantern-job-${id}`);
  const cwd = path.join(TMP, `lantern-cwd-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const spec = {
    command: process.execPath, argv: [FAKE, "--sleep-ms", String(sleepMs), "--exit", String(exitCode)],
    cwd, out: path.join(dir, "out.log"), err: path.join(dir, "err.log"), exit: path.join(dir, "exit_code"),
  };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    jobId: `lantern-job-${id}`, pid: 1, status: "running", startedAt: new Date().toISOString(),
  }));
  return { dir, cwd, jobId: path.basename(dir) };
}

// Patches spec.json with the test's own fake-AgentGlass URL -- the only channel that lets a
// spawned job-runner.mjs child skip the test-mode block (see lantern-notify.mjs); never an env var.
function setLanternServer(dir, url) {
  const p = path.join(dir, "spec.json");
  const spec = JSON.parse(fs.readFileSync(p, "utf8"));
  spec.lanternServer = url;
  fs.writeFileSync(p, JSON.stringify(spec));
}

function addIntent(dir, intent) {
  const p = path.join(dir, "meta.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.intent = intent;
  fs.writeFileSync(p, JSON.stringify(m));
}

// Plants a fake Claude Code session transcript, as the real CLI would write one, under this
// test's isolated HOME (_setup.mjs points USERPROFILE/HOME at a temp dir; os.homedir() on
// win32 reads USERPROFILE).
function plantTranscript(cwd, sessionId) {
  const dir = path.join(claudeProjectsDir(process.env.USERPROFILE), projectDirNameForCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ sessionId, type: "queue-operation" }) + "\n");
}

function spawnRunner(dir, extraEnv = {}, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, path.join(dir, "spec.json")],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const killTimer = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", (code) => { clearTimeout(killTimer); resolve({ code, stdout, stderr }); });
  });
}

function startServer(respond = (req, res) => { res.writeHead(200); res.end("ok"); }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      requests.push(body);
      respond(req, res);
    });
  });
  return { server, requests };
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
function close(server) { return new Promise((r) => server.close(r)); }

test("off switch: CLAUDE_ASYNC_LANTERN=0 means no requests are ever made", async () => {
  const { dir } = prepareJob({ sleepMs: 50, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const { code } = await spawnRunner(dir, { CLAUDE_ASYNC_LANTERN: "0" });
  await close(server);
  assert.equal(code, 0);
  assert.equal(requests.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), "0");
});

test("on + reachable: start post, session discovered mid-run, done clears the line, only allowed fields", async () => {
  // Generous margins (plenty of slack past job-runner's own 400ms session-poll interval): this
  // test is part of a full-suite run spawning many concurrent child processes, where Windows
  // process-creation contention can stretch a tight window past its budget.
  const { dir, cwd, jobId } = prepareJob({ sleepMs: 4000, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  const sessionId = "11111111-2222-3333-4444-555555555555";
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  // Give the start post a moment to land before planting the transcript, so the test also
  // exercises the "doing/session still unknown" shape of the very first post.
  await new Promise((r) => setTimeout(r, 500));
  plantTranscript(cwd, sessionId);
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);
  assert.ok(requests.length >= 2, `expected at least a start post and a session repost, got ${requests.length}`);

  for (const body of requests) {
    assert.ok(body, "every request must have a valid JSON body");
    const keys = Object.keys(body).sort();
    for (const k of keys) assert.ok(["name", "doing", "worktree", "session", "done"].includes(k), `unexpected field ${k}`);
    assert.equal(body.name, jobId);
  }

  const statusPosts = requests.filter((b) => b.done === undefined);
  assert.ok(statusPosts.some((b) => b.worktree === cwd), "at least one status post names this job's own cwd");
  assert.ok(statusPosts.some((b) => b.session === sessionId), "a status post repeats once the session id is found");

  const donePosts = requests.filter((b) => b.done === true);
  assert.equal(donePosts.length, 1, "exactly one done post");
  assert.deepEqual(donePosts[0], { name: jobId, done: true, session: sessionId });
});

test("meta.json's intent, written after the runner starts, is picked up and reposted", async () => {
  const { dir } = prepareJob({ sleepMs: 3000, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  await new Promise((r) => setTimeout(r, 400));
  addIntent(dir, "investigate the flaky test");
  await runnerDone;
  await close(server);
  assert.ok(requests.some((b) => b && b.doing === "investigate the flaky test"));
});

test("connection refused is silent: job still completes, nothing lantern-related reaches stdout", async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const { dir } = prepareJob({ sleepMs: 50, exitCode: 0 });
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const { code } = await spawnRunner(dir, {});
  assert.equal(code, 0);
  const out = fs.readFileSync(path.join(dir, "out.log"), "utf8");
  assert.doesNotMatch(out, /lantern/i, "a telemetry failure must never reach the job's own stdout");
  const err = fs.readFileSync(path.join(dir, "err.log"), "utf8");
  assert.match(err, /lantern/i, "the failure is still visible in the job dir's own diagnostic log");
});

// 2026-11-13 live-board incident guard: a fake job spawned exactly like a test that has never
// heard of Lantern (no lanternServer in spec.json, no CLAUDE_ASYNC_LANTERN* env) must never reach
// the port AgentGlass's own default would resolve to -- a decoy listener stands in for the real
// board and must receive zero requests. If something on this machine already owns that port
// (most likely the real local AgentGlass, exactly the thing this guard exists to protect), the
// bind itself fails and this test is skipped rather than silently passing or risking a false pass
// against the real board.
test("decoy-listener guard: a job that never configured Lantern at all makes zero requests to the default destination", async () => {
  const port = resolveLanternPort();
  const decoy = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
  let bound = true;
  await new Promise((resolve) => {
    decoy.once("error", () => { bound = false; resolve(); });
    decoy.listen(port, LANTERN_HOST, resolve);
  });
  if (!bound) {
    console.log(`SKIP: something is already listening on ${LANTERN_HOST}:${port} (likely the real ` +
      "AgentGlass) -- can't bind the decoy, so this run relies solely on the structural fix " +
      "(no fallthrough to the default destination in test mode without an explicit server).");
    return;
  }
  const decoyHits = [];
  decoy.on("request", (req) => decoyHits.push(req.url));
  try {
    const { dir } = prepareJob({ sleepMs: 50, exitCode: 0 });
    // No setLanternServer call, no CLAUDE_ASYNC_LANTERN* env -- exactly the shape of every other
    // test in this repo that spawns job-runner.mjs without ever thinking about Lantern.
    const { code } = await spawnRunner(dir, {});
    assert.equal(code, 0);
    assert.equal(decoyHits.length, 0, `expected zero requests to the default Lantern destination, got ${decoyHits.length}`);
  } finally {
    await new Promise((r) => decoy.close(r));
  }
});

test("a redirect from the Lantern server is never followed", async () => {
  const { server: targetServer, requests: targetRequests } = startServer();
  const targetPort = await listen(targetServer);
  const { server, requests } = startServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/agents/status` });
    res.end();
  });
  const port = await listen(server);
  const { dir } = prepareJob({ sleepMs: 50, exitCode: 0 });
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const { code } = await spawnRunner(dir, {});
  await close(server);
  await close(targetServer);
  assert.equal(code, 0);
  assert.ok(requests.length >= 1, "the redirecting server still receives the attempt");
  assert.equal(targetRequests.length, 0, "the redirect target must never be contacted");
});
