// lantern-notify.mjs: best-effort status posts to AgentGlass's Lantern board, fired from
// job-runner.mjs. Pure unit tests against a local HTTP server on an ephemeral 127.0.0.1 port --
// the destination is always injected through the `server` parameter, never an env var, so these
// tests never depend on (or risk touching) a real AgentGlass install.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LANTERN_HOST, DEFAULT_LANTERN_PORT,
  lanternEnabled, agentglassPortFilePath, readPublishedPort, resolveLanternPort, lanternServerUrl,
  postLanternStatus, postLanternDone, pollUntil, readIntentFromMeta,
} from "../lantern-notify.mjs";

// Isolates every env var this module reads, restored after each test so other test files (run in
// the same `node --test` sweep) never see a value one of these tests set.
const ENV_KEYS = ["CLAUDE_ASYNC_LANTERN", "CLAUDE_ASYNC_LANTERN_PORT", "XDG_CONFIG_HOME"];
let savedEnv;
beforeEach(() => { savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function startServer(respond = (req, res) => { res.writeHead(200); res.end("ok"); }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      requests.push({ body, method: req.method, url: req.url });
      respond(req, res);
    });
  });
  return { server, requests };
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, LANTERN_HOST, resolve));
  return `http://${LANTERN_HOST}:${server.address().port}`;
}
function close(server) { return new Promise((r) => server.close(r)); }

// ---------------------------------------------------------------------------
// Config / enable switch
// ---------------------------------------------------------------------------

test("lanternEnabled: on by default, off only when explicitly \"0\"", () => {
  delete process.env.CLAUDE_ASYNC_LANTERN;
  assert.equal(lanternEnabled(), true);
  process.env.CLAUDE_ASYNC_LANTERN = "0";
  assert.equal(lanternEnabled(), false);
  process.env.CLAUDE_ASYNC_LANTERN = "1";
  assert.equal(lanternEnabled(), true);
  process.env.CLAUDE_ASYNC_LANTERN = "false"; // anything other than the literal "0" stays on
  assert.equal(lanternEnabled(), true);
});

test("resolveLanternPort: env override > published port file > default 4000", () => {
  delete process.env.CLAUDE_ASYNC_LANTERN_PORT;
  const fakeFs = { readFileSync: () => { throw new Error("ENOENT"); } };
  assert.equal(resolveLanternPort(fakeFs), DEFAULT_LANTERN_PORT);

  const publishedFs = { readFileSync: (p) => (p === agentglassPortFilePath() ? "4321\n" : (() => { throw new Error("ENOENT"); })()) };
  assert.equal(readPublishedPort(publishedFs), 4321);
  assert.equal(resolveLanternPort(publishedFs), 4321);

  process.env.CLAUDE_ASYNC_LANTERN_PORT = "9999";
  assert.equal(resolveLanternPort(publishedFs), 9999, "an explicit env override wins over the published port file");
});

test("readPublishedPort: garbage/empty content is not a port", () => {
  const notANumber = { readFileSync: () => "not-a-port\n" };
  assert.equal(readPublishedPort(notANumber), null);
  const empty = { readFileSync: () => "" };
  assert.equal(readPublishedPort(empty), null);
  const negative = { readFileSync: () => "-1" };
  assert.equal(readPublishedPort(negative), null);
});

test("lanternServerUrl: always the literal loopback host, whatever the port", () => {
  process.env.CLAUDE_ASYNC_LANTERN_PORT = "5555";
  assert.equal(lanternServerUrl(), `http://${LANTERN_HOST}:5555`);
  assert.equal(LANTERN_HOST, "127.0.0.1");
});

// ---------------------------------------------------------------------------
// postLanternStatus / postLanternDone
// ---------------------------------------------------------------------------

test("postLanternStatus: posts exactly {name, doing, worktree, session} to /agents/status", async () => {
  const { server, requests } = startServer();
  const base = await listen(server);
  const r = await postLanternStatus({ name: "job-a", doing: "writing tests", worktree: "/code/x", session: "s-1", server: base });
  await close(server);
  assert.equal(r.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/agents/status");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, { name: "job-a", doing: "writing tests", worktree: "/code/x", session: "s-1" });
});

test("postLanternStatus: never sends any field beyond name/doing/worktree/session", async () => {
  const { server, requests } = startServer();
  const base = await listen(server);
  await postLanternStatus({ name: "job-a", server: base });
  await close(server);
  assert.deepEqual(Object.keys(requests[0].body).sort(), ["doing", "name", "session", "worktree"]);
});

test("postLanternStatus: no name means no request at all", async () => {
  const { server, requests } = startServer();
  const base = await listen(server);
  const r = await postLanternStatus({ name: "", server: base });
  await close(server);
  assert.equal(r.ok, false);
  assert.equal(requests.length, 0);
});

test("postLanternDone: posts {name, done:true, session}", async () => {
  const { server, requests } = startServer();
  const base = await listen(server);
  const r = await postLanternDone({ name: "job-a", session: "s-1", server: base });
  await close(server);
  assert.equal(r.ok, true);
  assert.deepEqual(requests[0].body, { name: "job-a", done: true, session: "s-1" });
});

test("postLanternDone: a missing session never reaches the network (the board would 400 it anyway)", async () => {
  const { server, requests } = startServer();
  const base = await listen(server);
  const r = await postLanternDone({ name: "job-a", session: "", server: base });
  await close(server);
  assert.equal(r.ok, false);
  assert.equal(requests.length, 0);
});

test("connection refused: silent, no throw, resolves ok:false", async () => {
  // Nothing is listening on this port -- find an ephemeral port, bind briefly, close it, and use
  // the exact same port right after, which is about as close to a guaranteed-refused connection
  // as a test can get without hardcoding a port number.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, LANTERN_HOST, r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const logs = [];
  const r = await postLanternStatus({ name: "job-a", server: `http://${LANTERN_HOST}:${port}`, logLine: (m) => logs.push(m) });
  assert.equal(r.ok, false);
  assert.ok(logs.length >= 1, "the failure is logged via logLine, not thrown");
});

test("timeout does not hang: a server that never responds still resolves within the bound", async () => {
  const server = http.createServer(() => { /* never responds */ });
  const base = await listen(server);
  const t0 = Date.now();
  const r = await postLanternStatus({ name: "job-a", server: base, timeoutMs: 300 });
  const elapsed = Date.now() - t0;
  await close(server);
  assert.equal(r.ok, false);
  assert.ok(elapsed < 2000, `expected the 300ms timeout to bound the call, took ${elapsed}ms`);
});

test("redirect is never followed", async () => {
  const { server: target, requests: targetRequests } = startServer();
  const targetBase = await listen(target);
  const { server: redirector } = startServer((req, res) => {
    res.writeHead(302, { Location: `${targetBase}/agents/status` });
    res.end();
  });
  const redirectorBase = await listen(redirector);
  const logs = [];
  const r = await postLanternStatus({ name: "job-a", server: redirectorBase, logLine: (m) => logs.push(m) });
  await close(redirector);
  await close(target);
  assert.equal(r.ok, false);
  assert.equal(targetRequests.length, 0, "the redirect target must never receive a request (node:http.request never auto-follows)");
  assert.ok(logs.some((l) => /HTTP 302/.test(l)));
});

test("non-2xx response is reported through logLine, not thrown", async () => {
  const { server } = startServer((req, res) => { res.writeHead(500); res.end("boom"); });
  const base = await listen(server);
  const logs = [];
  const r = await postLanternStatus({ name: "job-a", server: base, logLine: (m) => logs.push(m) });
  await close(server);
  assert.equal(r.ok, false);
  assert.ok(logs.some((l) => /HTTP 500/.test(l)));
});

// ---------------------------------------------------------------------------
// pollUntil / readIntentFromMeta
// ---------------------------------------------------------------------------

test("pollUntil: calls onFound exactly once, as soon as checkFn turns truthy", async () => {
  let calls = 0;
  const found = [];
  const stop = pollUntil(() => { calls++; return calls >= 3 ? "value" : null; },
    { intervalMs: 10, timeoutMs: 1000, onFound: (v) => found.push(v) });
  await new Promise((r) => setTimeout(r, 100));
  stop();
  assert.deepEqual(found, ["value"]);
  assert.ok(calls <= 10, "stops polling once found, not every tick until timeoutMs");
});

test("pollUntil: gives up silently after timeoutMs with nothing found", async () => {
  const found = [];
  pollUntil(() => null, { intervalMs: 10, timeoutMs: 50, onFound: (v) => found.push(v) });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(found, []);
});

test("readIntentFromMeta: reads intent, or null for missing file/bad json/blank intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-meta-"));
  try {
    const p = path.join(dir, "meta.json");
    fs.writeFileSync(p, JSON.stringify({ intent: "fix the thing" }));
    assert.equal(readIntentFromMeta(p), "fix the thing");
    fs.writeFileSync(p, JSON.stringify({}));
    assert.equal(readIntentFromMeta(p), null);
    fs.writeFileSync(p, "{ not json");
    assert.equal(readIntentFromMeta(p), null);
    assert.equal(readIntentFromMeta(path.join(dir, "missing.json")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
