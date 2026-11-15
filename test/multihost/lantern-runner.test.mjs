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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTmp, TMP } from "./_setup.mjs";
import { projectDirNameForCwd, claudeProjectsDir } from "../../lantern-session.mjs";

after(cleanupTmp);

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "..", "job-runner.mjs");
const FAKE = path.join(here, "lantern-fake-cli.mjs");
const REPO_ROOT = path.join(here, "..", "..");
let seq = 0;

// Prepares a job dir + spec.json + meta.json (no `intent` unless the test adds one later) with a
// FRESH cwd dir standing in for the job's workFolder, without running the runner yet. `cwdOverride`
// lets one test point the job at a real git checkout (this repo) instead of the usual
// not-a-git-checkout TMP dir, to prove the worktree-resolution fix end to end, through the real
// job-runner.mjs and a real `git`, not a fake.
function prepareJob({ sleepMs = 0, exitCode = 0, extraArgv = [], cwdOverride } = {}) {
  const id = ++seq;
  const dir = path.join(TMP, `lantern-job-${id}`);
  const cwd = cwdOverride || path.join(TMP, `lantern-cwd-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  if (!cwdOverride) fs.mkdirSync(cwd, { recursive: true });
  const spec = {
    command: process.execPath, argv: [FAKE, "--sleep-ms", String(sleepMs), "--exit", String(exitCode), ...extraArgv],
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

test("no row the runner cannot clear: no post before a session id, exactly one status post once it's found, done clears that same session", async () => {
  // Generous margins (plenty of slack past job-runner's own 400ms session-poll interval): this
  // test is part of a full-suite run spawning many concurrent child processes, where Windows
  // process-creation contention can stretch a tight window past its budget.
  const { dir, cwd, jobId } = prepareJob({ sleepMs: 4000, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  const sessionId = "11111111-2222-3333-4444-555555555555";
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  // Give the (now session-gated) first post every chance to fire too early before asserting it
  // didn't -- this window is well past the 400ms session-poll interval, with no transcript planted.
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(requests.length, 0, "no row is posted until a session id is actually known");
  plantTranscript(cwd, sessionId);
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);

  for (const body of requests) {
    assert.ok(body, "every request must have a valid JSON body");
    const keys = Object.keys(body).sort();
    for (const k of keys) assert.ok(["name", "doing", "worktree", "session", "done"].includes(k), `unexpected field ${k}`);
    assert.equal(body.name, jobId);
  }

  const statusPosts = requests.filter((b) => b.done === undefined);
  assert.equal(statusPosts.length, 1, "exactly one status post: the first post is held back until the session id is known");
  assert.deepEqual(statusPosts[0], { name: jobId, doing: "", worktree: cwd, session: sessionId });

  const donePosts = requests.filter((b) => b.done === true);
  assert.equal(donePosts.length, 1, "exactly one done post, matching the posted session");
  assert.deepEqual(donePosts[0], { name: jobId, done: true, session: sessionId });
});

test("meta.json's intent, discovered before the session, is carried into the job's only post rather than getting its own", async () => {
  const { dir, cwd } = prepareJob({ sleepMs: 3000, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  const sessionId = "22222222-3333-4444-5555-666666666666";
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  await new Promise((r) => setTimeout(r, 400));
  addIntent(dir, "investigate the flaky test");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(requests.filter((b) => b.done === undefined).length, 0, "the intent alone never triggers a post -- no session id yet");
  plantTranscript(cwd, sessionId);
  await runnerDone;
  await close(server);
  const statusPosts = requests.filter((b) => b.done === undefined);
  assert.equal(statusPosts.length, 1);
  assert.equal(statusPosts[0].doing, "investigate the flaky test");
  assert.equal(statusPosts[0].session, sessionId);
});

test("no session id is ever resolved: no status row is posted, and the job dir logs why instead of leaving a row AgentGlass can never clear", async () => {
  // Short enough that the session watcher (400ms poll interval) never gets a single tick before
  // the job exits, and no transcript is ever planted -- a session id is simply never discovered.
  const { dir } = prepareJob({ sleepMs: 200, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const { code } = await spawnRunner(dir, {});
  await close(server);
  assert.equal(code, 0);
  assert.equal(requests.length, 0, "nothing is ever posted without a session id -- not a status row, not a done");
  const err = fs.readFileSync(path.join(dir, "err.log"), "utf8");
  assert.match(err, /no session id was resolved.*no status.*row was ever posted/i);
});

test("connection refused is silent: job still completes, nothing lantern-related reaches stdout", async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const { dir, cwd } = prepareJob({ sleepMs: 1200, exitCode: 0 });
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(cwd, "33333333-4444-5555-6666-777777777777");
  const { code } = await runnerDone;
  assert.equal(code, 0);
  const out = fs.readFileSync(path.join(dir, "out.log"), "utf8");
  assert.doesNotMatch(out, /lantern/i, "a telemetry failure must never reach the job's own stdout");
  const err = fs.readFileSync(path.join(dir, "err.log"), "utf8");
  assert.match(err, /lantern/i, "the failure is still visible in the job dir's own diagnostic log");
});

// 2026-11-13 live-board incident guard, reworked: the old version of this test bound the REAL
// default Lantern port (resolveLanternPort(), almost always 4000) to prove nothing arrives there --
// but that port is held by a real AgentGlass on any machine that runs one, including this one, so
// the bind always failed and the test always skipped itself, silently proving nothing on this
// machine. Instead of depending on 4000 being free, this test injects what the default resolves to
// via CLAUDE_ASYNC_LANTERN_PORT (the one documented operator override -- see resolveLanternPort()),
// pointing it at an ephemeral port this test owns outright, then asserts the test-mode block (no
// fallthrough to the default destination without an explicit `server` -- see lantern-notify.mjs's
// blockedRealSendInTestMode) still holds even though the resolved destination is now reachable. A
// second job, given the SAME ephemeral-port mechanism but as an explicit `server`, proves requests
// really do flow over it -- so the zero-request result above isn't just a runner that posts nothing.
test("decoy-listener guard: a job with no explicit server sends nothing to the (injected) default destination; the identical explicit path still delivers", async () => {
  const { server: defaultDecoy, requests: defaultHits } = startServer();
  const defaultPort = await listen(defaultDecoy);
  const { dir: implicitDir, cwd: implicitCwd } = prepareJob({ sleepMs: 1200, exitCode: 0 });
  // No setLanternServer call: the only way this job could ever reach defaultDecoy is by falling
  // through to the default destination, which CLAUDE_ASYNC_LANTERN_PORT here points right at it.
  const implicitRunnerDone = spawnRunner(implicitDir, { CLAUDE_ASYNC_LANTERN_PORT: String(defaultPort) });
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(implicitCwd, "44444444-5555-6666-7777-888888888888");
  const { code: implicitCode } = await implicitRunnerDone;
  await close(defaultDecoy);
  assert.equal(implicitCode, 0);
  assert.equal(defaultHits.length, 0, "zero requests reach the destination the default resolution would have picked");

  const { server: explicitDecoy, requests: explicitHits } = startServer();
  const explicitPort = await listen(explicitDecoy);
  const { dir: explicitDir, cwd: explicitCwd } = prepareJob({ sleepMs: 1200, exitCode: 0 });
  setLanternServer(explicitDir, `http://127.0.0.1:${explicitPort}`);
  const explicitRunnerDone = spawnRunner(explicitDir, {});
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(explicitCwd, "55555555-6666-7777-8888-999999999999");
  const { code: explicitCode } = await explicitRunnerDone;
  await close(explicitDecoy);
  assert.equal(explicitCode, 0);
  assert.ok(explicitHits.length >= 1, "the identical mechanism delivers once the destination is given explicitly");
});

test("a redirect from the Lantern server is never followed", async () => {
  const { server: targetServer, requests: targetRequests } = startServer();
  const targetPort = await listen(targetServer);
  const { server, requests } = startServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/agents/status` });
    res.end();
  });
  const port = await listen(server);
  const { dir, cwd } = prepareJob({ sleepMs: 1200, exitCode: 0 });
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(cwd, "66666666-7777-8888-9999-000000000000");
  const { code } = await runnerDone;
  await close(server);
  await close(targetServer);
  assert.equal(code, 0);
  assert.ok(requests.length >= 1, "the redirecting server still receives the attempt");
  assert.equal(targetRequests.length, 0, "the redirect target must never be contacted");
});

// Review point #2: the runner must refuse any Lantern destination that isn't a literal loopback
// address, no matter where the value came from -- including a job's own spec.json, which a job
// itself can write files into (the field is never set by job-core.mjs in production, but nothing
// stops a job process from editing its own spec.json). 203.0.113.10 is an RFC 5737 TEST-NET-3
// address: guaranteed non-routable, so even if the refusal somehow failed, no real host is dialed.
test("a non-loopback lanternServer in spec.json is refused: no request is ever sent", async () => {
  const { dir, cwd } = prepareJob({ sleepMs: 1200, exitCode: 0 });
  setLanternServer(dir, "http://203.0.113.10:4000");
  const runnerDone = spawnRunner(dir, {});
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(cwd, "77777777-8888-9999-0000-111111111111");
  const { code } = await runnerDone;
  assert.equal(code, 0);
  const err = fs.readFileSync(path.join(dir, "err.log"), "utf8");
  assert.match(err, /refusing to post.*not a loopback destination/i);
});

// Fix 5 (readonly compatibility, PR #7 follow-up): job-runner.mjs's Lantern posting is driven only
// by spec.json's command/argv/cwd and meta.json's intent/transcript discovery -- it never inspects
// what the CLI's own argv looks like. This plants argv shaped like a real readonly launch (job-core
// .mjs's --setting-sources "", --append-system-prompt denial guidance, --append-system-prompt-file
// memory file) to prove that shape never gates or breaks the runner-side status/done posts.
test("readonly-shaped argv (--setting-sources \"\", --append-system-prompt, --append-system-prompt-file) still produces runner-side Lantern posts", async () => {
  const memoryFile = path.join(TMP, `lantern-readonly-memory-${++seq}.txt`);
  fs.writeFileSync(memoryFile, "some CLAUDE.md memory text");
  const { dir, cwd, jobId } = prepareJob({
    sleepMs: 1200, exitCode: 0,
    extraArgv: ["--setting-sources", "", "--append-system-prompt", "Safe mode is on for this job (profile: \"readonly\").",
                "--append-system-prompt-file", memoryFile],
  });
  const { server, requests } = startServer();
  const port = await listen(server);
  const sessionId = "88888888-9999-0000-1111-222222222222";
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(cwd, sessionId);
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);
  const statusPosts = requests.filter((b) => b.done === undefined);
  assert.equal(statusPosts.length, 1, "a readonly-shaped launch still gets exactly one status post");
  assert.deepEqual(statusPosts[0], { name: jobId, doing: "", worktree: cwd, session: sessionId });
  const donePosts = requests.filter((b) => b.done === true);
  assert.equal(donePosts.length, 1, "a readonly-shaped launch still gets a done post clearing the same session");
  assert.deepEqual(donePosts[0], { name: jobId, done: true, session: sessionId });
});

// Lantern working-state fix: job-runner.mjs's 60s heartbeat loop now reposts the same status line
// (see job-runner.mjs's hbInterval), so AgentGlass's agentboard.ts:306 FRESH_MS staleness window
// never trips for a job that is still actually running. CLAUDE_ASYNC_HEARTBEAT_MS overrides the
// production 60s interval so these tests observe several ticks in well under a second.
test("heartbeat repost: the same status line is posted again on every heartbeat tick while the job runs", async () => {
  const { dir, cwd, jobId } = prepareJob({ sleepMs: 1500, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  const sessionId = "99999999-0000-1111-2222-333333333333";
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, { CLAUDE_ASYNC_HEARTBEAT_MS: "100" });
  // The session watcher snapshots the transcript directory at start, so the file must appear
  // AFTER spawn, not before -- 400ms gives the runner's own startup plenty of margin (same
  // delay the other tests in this file use), leaving the rest of the 1500ms sleep for the fast
  // heartbeat below to repost into.
  await new Promise((r) => setTimeout(r, 400));
  plantTranscript(cwd, sessionId);
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);
  const statusPosts = requests.filter((b) => b.done === undefined);
  assert.ok(statusPosts.length > 1, `expected more than one status post, got ${statusPosts.length}`);
  for (const body of statusPosts) assert.deepEqual(body, { name: jobId, doing: "", worktree: cwd, session: sessionId });
  const donePosts = requests.filter((b) => b.done === true);
  assert.equal(donePosts.length, 1, "still exactly one done post regardless of how many reposts preceded it");
});

test("heartbeat repost: no post is sent on any tick before a session id is known", async () => {
  const { dir, cwd } = prepareJob({ sleepMs: 900, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, { CLAUDE_ASYNC_HEARTBEAT_MS: "100" });
  // Several 100ms heartbeat ticks fire in this window with no session known yet.
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(requests.length, 0, "heartbeat ticks before a session id is known must never post");
  plantTranscript(cwd, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);
  assert.ok(requests.length >= 1, "a post still happens once the session id is found");
});

test("heartbeat repost: no repost ever lands after the done post clears the row", async () => {
  const { dir, cwd } = prepareJob({ sleepMs: 1500, exitCode: 0 });
  const { server, requests } = startServer();
  const port = await listen(server);
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, { CLAUDE_ASYNC_HEARTBEAT_MS: "100" });
  await new Promise((r) => setTimeout(r, 400));
  plantTranscript(cwd, "bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);
  assert.ok(requests.length > 2, "expected at least one repost between the first post and done");
  assert.equal(requests[requests.length - 1].done, true, "the done post must be the last request received, with nothing racing in after it");
});

test("heartbeat repost: test mode without an explicit server still sends nothing, even across many fast ticks", async () => {
  const { server: decoy, requests: decoyHits } = startServer();
  const decoyPort = await listen(decoy);
  const { dir, cwd } = prepareJob({ sleepMs: 900, exitCode: 0 });
  // No setLanternServer: the only way this job could reach the decoy is by falling through to the
  // default destination, which CLAUDE_ASYNC_LANTERN_PORT here points right at (see the
  // decoy-listener test above for why this is the only way to prove the test-mode block holds).
  const runnerDone = spawnRunner(dir, { CLAUDE_ASYNC_LANTERN_PORT: String(decoyPort), CLAUDE_ASYNC_HEARTBEAT_MS: "100" });
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(cwd, "cccccccc-dddd-eeee-ffff-000000000000");
  const { code } = await runnerDone;
  await close(decoy);
  assert.equal(code, 0);
  assert.equal(decoyHits.length, 0, "the test-mode block covers heartbeat reposts exactly as it covers the first post");
});

// Lantern working-state fix, runner-side half: a job whose cwd is a REAL git checkout (this repo,
// not a TMP dir) must have its posted worktree match exactly what `git worktree list --porcelain`
// prints for it -- the form AgentGlass's agentboard.ts compares by exact string equality
// (stillThere) and by a forward-slash-only prefix test (under()). Goes through the real
// job-runner.mjs and a real `git rev-parse --show-toplevel`, not a fake, to prove the fix holds
// end to end on whatever OS this suite actually runs on (forward slashes already on POSIX, so this
// is a no-op assertion there; the Windows-backslash case is what regressed before this fix).
test("a job whose cwd is a real git checkout posts the worktree in the exact form `git worktree list --porcelain` prints", async () => {
  const want = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  assert.ok(want, "this suite must itself be running inside a git checkout for this test to mean anything");
  const { dir, jobId } = prepareJob({ sleepMs: 1200, exitCode: 0, cwdOverride: REPO_ROOT });
  const { server, requests } = startServer();
  const port = await listen(server);
  const sessionId = "ffffffff-0000-1111-2222-333333333333";
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, {});
  await new Promise((r) => setTimeout(r, 450));
  plantTranscript(REPO_ROOT, sessionId);
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);
  const statusPosts = requests.filter((b) => b.done === undefined);
  assert.equal(statusPosts.length, 1);
  assert.equal(statusPosts[0].worktree, want, "the posted worktree must byte-for-byte match git's own worktree-list form, not the raw cwd string");
  assert.deepEqual(statusPosts[0], { name: jobId, doing: "", worktree: want, session: sessionId });
});

test("heartbeat repost: a failed post disables lantern for the rest of the job, so no repost and no done follow it", async () => {
  const { server, requests } = startServer((req, res) => { res.writeHead(500); res.end("nope"); });
  const port = await listen(server);
  const { dir, cwd } = prepareJob({ sleepMs: 1200, exitCode: 0 });
  setLanternServer(dir, `http://127.0.0.1:${port}`);
  const runnerDone = spawnRunner(dir, { CLAUDE_ASYNC_HEARTBEAT_MS: "100" });
  await new Promise((r) => setTimeout(r, 400));
  plantTranscript(cwd, "dddddddd-eeee-ffff-0000-111111111111");
  const { code } = await runnerDone;
  await close(server);
  assert.equal(code, 0);
  assert.equal(requests.length, 1, "the first failed post must disable lanternAlive, so neither a heartbeat repost nor the done post is attempted again");
});
