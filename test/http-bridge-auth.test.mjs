// http-bridge.mjs / claude-async-http.mjs (the loopback HTTP MCP bridge, 127.0.0.1:7842): optional bearer-token auth
// (~/.claude-async/http.json holding only a sha256, same scheme as host-api.mjs), and container.mjs's
// checkHttpBridgeLocked(), which refuses container mode unless the bridge is token-locked -- a
// container reaches the host's 127.0.0.1 through host.docker.internal on Docker Desktop.
// Run: node --test test/http-bridge-auth.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-http-auth-"));
process.env.CLAUDE_ASYNC_JOB_DIR = path.join(TMP, "jobs");
process.env.CLAUDE_ASYNC_CONFIG_DIR = path.join(TMP, "cfg");
process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);
const bridge = await import("../http-bridge.mjs");
const c = await import("../container.mjs");
const { hashToken } = await import("../host-api.mjs");
const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); fs.rmSync(TMP, { recursive: true, force: true }); });

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
}
const TOKEN = "bridge-token-" + "y".repeat(32);
const mcpList = (port, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

test("bridge with a token hash: /mcp without, or with a wrong, bearer token is a bare 401", async () => {
  let port;
  port = await listen((req, res) => app(req, res));
  const app = bridge.createHttpApp({ port, tokenSha256: hashToken(TOKEN) });
  for (const h of [{}, { authorization: "Bearer wrong" }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${hashToken(TOKEN)}` }]) {
    const r = await mcpList(port, h);
    assert.equal(r.status, 401, JSON.stringify(h));
    assert.equal(await r.text(), "");
  }
  const ok = await mcpList(port, { authorization: `Bearer ${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /claude_start/);
});

test("bridge without a token hash: unchanged (the existing loopback client keeps working)", async () => {
  let port;
  port = await listen((req, res) => app(req, res));
  const app = bridge.createHttpApp({ port, tokenSha256: null });
  const r = await mcpList(port);
  assert.equal(r.status, 200);
});

test("newHttpToken: stores only the sha256 in http.json and returns the token once", () => {
  const file = path.join(TMP, "cfg", "http.json");
  const { token } = bridge.newHttpToken(file);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.tokenSha256, hashToken(token));
  assert.ok(!fs.readFileSync(file, "utf8").includes(token));
  assert.equal(c.readHttpBridgeTokenHash(file), hashToken(token));
});

test("checkHttpBridgeLocked: refuses with no token file, or when the port answers an unauthenticated request", async () => {
  const noFile = path.join(TMP, "none.json");
  assert.match((await c.checkHttpBridgeLocked({ port: 1, configFile: noFile })).error, /not token-locked/);
  const file = path.join(TMP, "locked.json");
  fs.writeFileSync(file, JSON.stringify({ tokenSha256: hashToken(TOKEN) }));
  // an OLD bridge (no auth) still running on the port
  const openPort = await listen((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  assert.match((await c.checkHttpBridgeLocked({ port: openPort, configFile: file })).error, /answered an unauthenticated MCP request with HTTP 200/);
  // the real bridge, locked
  let lockedPort;
  lockedPort = await listen((req, res) => app(req, res));
  const app = bridge.createHttpApp({ port: lockedPort, tokenSha256: hashToken(TOKEN) });
  assert.deepEqual(await c.checkHttpBridgeLocked({ port: lockedPort, configFile: file }), { ok: true, listening: true });
  // nothing listening: fine, the token file means a bridge started later enforces it
  const free = await listen(() => {});
  const freePort = servers.at(-1).address().port;
  await new Promise((r) => servers.pop().close(r));
  assert.deepEqual(await c.checkHttpBridgeLocked({ port: freePort, configFile: file }), { ok: true, listening: false });
  assert.ok(free);
});

// ------------------------------------------------------------ review round 2, finding A2 ---
import { spawn } from "node:child_process";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HTTP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-async-http.mjs");

async function freePort() {
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
// Starts the real bridge script; resolves { code, out } when it exits, or { listening, kill, out } once
// it prints its listening line.
function startBridge(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HTTP_SCRIPT], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (c) => { out += c; if (/listening on/.test(out)) resolve({ listening: true, out, kill: () => child.kill("SIGKILL") }); };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("A2: resolveHttpBridgeAuth: no valid token hash refuses startup whenever container mode is allowed; opt-out never applies then", () => {
  const h = hashToken(TOKEN);
  assert.deepEqual(bridge.resolveHttpBridgeAuth({ tokenSha256: h, allowedSandboxes: "host,container" }), { tokenSha256: h });
  assert.deepEqual(bridge.resolveHttpBridgeAuth({ tokenSha256: h, allowedSandboxes: undefined }), { tokenSha256: h });
  for (const pol of [{ allowedSandboxes: "host,container" }, { allowedSandboxes: "container" }, { sandboxDefault: "container" }]) {
    const r = bridge.resolveHttpBridgeAuth({ tokenSha256: null, ...pol });
    assert.match(r.error, /--new-token/, JSON.stringify(pol));
    const r2 = bridge.resolveHttpBridgeAuth({ tokenSha256: null, allowUnauthenticated: "1", ...pol });
    assert.match(r2.error, /CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED/, "the opt-out is named and rejected");
  }
  // host-only policy, no token: since round 3 (B1) a refusal too (a token is required by default);
  // only the explicit opt-out on a machine without the container-mode marker starts unauthenticated
  const noMarker = path.join(TMP, "a2-no-marker");
  const host = bridge.resolveHttpBridgeAuth({ tokenSha256: null, allowedSandboxes: undefined, markerFile: noMarker });
  assert.match(host.error, /token is required/);
  const optOut = bridge.resolveHttpBridgeAuth({ tokenSha256: null, allowedSandboxes: "host", allowUnauthenticated: "1", markerFile: noMarker });
  assert.equal(optOut.tokenSha256, null);
  assert.match(optOut.warning, /CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED/);
  // an invalid policy value refuses too (the bridge would refuse every start anyway)
  assert.match(bridge.resolveHttpBridgeAuth({ tokenSha256: null, allowedSandboxes: "nonsense" }).error, /CLAUDE_ASYNC_ALLOWED_SANDBOXES/);
});

test("A2: the bridge script refuses to start unauthenticated when container mode is allowed (missing, malformed, unreadable token file; opt-out)", async () => {
  const cases = [];
  const none = path.join(TMP, "a2-none"); fs.mkdirSync(none, { recursive: true });
  cases.push(["missing http.json", { CLAUDE_ASYNC_CONFIG_DIR: none, CLAUDE_ASYNC_ALLOWED_SANDBOXES: "host,container" }]);
  const bad = path.join(TMP, "a2-bad"); fs.mkdirSync(bad, { recursive: true }); fs.writeFileSync(path.join(bad, "http.json"), '{"tokenSha256":"nope"}');
  cases.push(["malformed hash", { CLAUDE_ASYNC_CONFIG_DIR: bad, CLAUDE_ASYNC_ALLOWED_SANDBOXES: "host,container" }]);
  const unr = path.join(TMP, "a2-unreadable"); fs.mkdirSync(path.join(unr, "http.json"), { recursive: true }); // a directory: EISDIR
  cases.push(["unreadable http.json", { CLAUDE_ASYNC_CONFIG_DIR: unr, CLAUDE_ASYNC_ALLOWED_SANDBOXES: "container" }]);
  cases.push(["opt-out with container allowed", { CLAUDE_ASYNC_CONFIG_DIR: none, CLAUDE_ASYNC_ALLOWED_SANDBOXES: "host,container", CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED: "1" }]);
  cases.push(["CLAUDE_ASYNC_JOB_SANDBOX=container alone", { CLAUDE_ASYNC_CONFIG_DIR: none, CLAUDE_ASYNC_JOB_SANDBOX: "container" }]);
  for (const [label, env] of cases) {
    const port = await freePort();
    const r = await startBridge({ ...env, CLAUDE_ASYNC_HTTP_PORT: String(port) });
    if (r.listening) r.kill();
    assert.equal(r.listening, undefined, `${label}: must not listen`);
    assert.notEqual(r.code, 0, `${label}: nonzero exit`);
    assert.match(r.out, /--new-token/, `${label}: points at --new-token: ${r.out}`);
    assert.ok(!r.out.includes("listening"), label);
  }
  // host-only policy and no token: since round 3 (B1) it starts unauthenticated only with the explicit
  // opt-out (and no container-mode marker under its home; see the B1 tests)
  const port = await freePort();
  const home = path.join(TMP, "a2-home"); fs.mkdirSync(home, { recursive: true });
  const r = await startBridge({ CLAUDE_ASYNC_CONFIG_DIR: none, CLAUDE_ASYNC_HTTP_PORT: String(port), CLAUDE_ASYNC_ALLOWED_SANDBOXES: "host",
                                CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED: "1", HOME: home, USERPROFILE: home });
  try {
    assert.equal(r.listening, true, r.out);
    assert.match(r.out, /no token: unauthenticated loopback/);
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(h.auth, false);
  } finally { if (r.kill) r.kill(); }
});

// Argon #5 (c): the transport's DNS-rebinding protection answers 403 to any Host but 127.0.0.1 /
// localhost, which is what a probe from host.docker.internal sees on an UNLOCKED bridge. 403 is not
// "locked": a container that sends Host: 127.0.0.1:<port> gets 200. The smoke test sends that header.
test("A2: an unlocked bridge answers 403 to Host: host.docker.internal and 200 to Host: 127.0.0.1 (why the probe sets Host)", async () => {
  let port;
  port = await listen((req, res) => app(req, res));
  const app = bridge.createHttpApp({ port, tokenSha256: null });
  const req = (host) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/mcp",
      headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", reject); r.end(body);
  });
  assert.equal(await req(`host.docker.internal:${port}`), 403);
  assert.equal(await req(`127.0.0.1:${port}`), 200);
  // and a LOCKED bridge is 401 either way (auth runs before the transport)
  let lockedPort;
  lockedPort = await listen((rq, rs) => locked(rq, rs));
  const locked = bridge.createHttpApp({ port: lockedPort, tokenSha256: hashToken(TOKEN) });
  const req2 = (host) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: lockedPort, method: "POST", path: "/mcp", headers: { host, "content-length": 0 } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", reject); r.end();
  });
  assert.equal(await req2(`host.docker.internal:${lockedPort}`), 401);
  // the preflight probe itself treats 403 as NOT locked
  const file = path.join(TMP, "locked-a2.json");
  fs.writeFileSync(file, JSON.stringify({ tokenSha256: hashToken(TOKEN) }));
  const forbidden = await listen((rq, rs) => { rs.writeHead(403); rs.end(); });
  assert.match((await c.checkHttpBridgeLocked({ port: forbidden, configFile: file })).error, /HTTP 403, not 401/);
});

// Argon #5 (a): a bridge serving TLS (CLAUDE_ASYNC_TLS_CERT/KEY) must be probed with https, or the
// preflight fails with a socket error and blocks every container job.
test("A2: checkHttpBridgeLocked probes with https when the bridge is configured for TLS", { skip: spawnSync("openssl", ["version"]).status !== 0 ? "no openssl" : false }, async () => {
  const dir = path.join(TMP, "tls"); fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
                                  "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(TMP, "locked-tls.json");
  fs.writeFileSync(file, JSON.stringify({ tokenSha256: hashToken(TOKEN) }));
  let port;
  const app = bridge.createHttpApp({ port: 0, tokenSha256: hashToken(TOKEN) });
  const server = https.createServer({ cert: fs.readFileSync(path.join(dir, "cert.pem")), key: fs.readFileSync(path.join(dir, "key.pem")) }, (rq, rs) => app(rq, rs));
  servers.push(server);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  port = server.address().port;
  const plain = await c.checkHttpBridgeLocked({ port, configFile: file });
  assert.ok(plain.error, "a plain-http probe of a TLS bridge is an error (that is the bug when tls is not passed)");
  const tls = await c.checkHttpBridgeLocked({ port, configFile: file, tls: true });
  assert.deepEqual(tls, { ok: true, listening: true });
  // the config carries the flag from the same env the bridge reads
  assert.equal(c.loadContainerConfig({ CLAUDE_ASYNC_TLS_CERT: "c", CLAUDE_ASYNC_TLS_KEY: "k" }).httpBridgeTls, true);
  assert.equal(c.loadContainerConfig({}).httpBridgeTls, false);
});

// ------------------------------------------------------------ review round 3, finding B1 ---
// The bridge's startup policy must not depend on ITS OWN process environment: a bridge launched with
// another config dir and no sandbox variables while another process runs containers would otherwise
// start unauthenticated. Now: a token is required by default; the explicit opt-out
// CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1 is refused whenever the machine-wide container-mode
// marker exists (a fixed path under the user's home, independent of CLAUDE_ASYNC_CONFIG_DIR), which
// container preflight writes before any container launches and never removes.
const homeWith = (label, marker) => {
  const home = path.join(TMP, `b1-home-${label}`);
  fs.mkdirSync(home, { recursive: true });
  if (marker) { fs.mkdirSync(path.join(home, ".claude-async"), { recursive: true }); fs.writeFileSync(path.join(home, ".claude-async", "container-mode"), "{}\n"); }
  return home;
};
const b1Env = (home, extra = {}) => {
  const env = { HOME: home, USERPROFILE: home, CLAUDE_ASYNC_CONFIG_DIR: path.join(TMP, `b1-cfg-${crypto.randomUUID()}`), ...extra };
  return env;
};
import crypto from "node:crypto";
const unsetSandboxEnv = () => {
  const saved = {};
  for (const k of ["CLAUDE_ASYNC_ALLOWED_SANDBOXES", "CLAUDE_ASYNC_JOB_SANDBOX", "CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED"]) { saved[k] = process.env[k]; delete process.env[k]; }
  return saved;
};

test("B1: containerModeMarkerPath is under the user's home and ignores CLAUDE_ASYNC_CONFIG_DIR", () => {
  const p = c.containerModeMarkerPath();
  assert.equal(p, path.join(os.homedir(), ".claude-async", "container-mode"));
  assert.ok(!p.startsWith(process.env.CLAUDE_ASYNC_CONFIG_DIR), "not under the configured config dir");
});

test("B1: resolveHttpBridgeAuth: no token and no opt-out refuses by default; the opt-out is refused while the marker exists", () => {
  const none = path.join(TMP, "b1-no-marker");
  const marker = path.join(TMP, "b1-marker"); fs.writeFileSync(marker, "{}\n");
  const def = bridge.resolveHttpBridgeAuth({ tokenSha256: null, allowedSandboxes: undefined, markerFile: none });
  assert.match(def.error || "", /token is required/i, JSON.stringify(def));
  assert.match(def.error, /--new-token/);
  assert.match(def.error, /CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1/, "names the opt-out");
  const withMarker = bridge.resolveHttpBridgeAuth({ tokenSha256: null, allowedSandboxes: undefined, allowUnauthenticated: "1", markerFile: marker });
  assert.match(withMarker.error || "", /container-mode/, JSON.stringify(withMarker));
  const optOut = bridge.resolveHttpBridgeAuth({ tokenSha256: null, allowedSandboxes: undefined, allowUnauthenticated: "1", markerFile: none });
  assert.equal(optOut.tokenSha256, null);
  assert.match(optOut.warning, /starting UNAUTHENTICATED/);
  // a token always wins, marker or not
  assert.deepEqual(bridge.resolveHttpBridgeAuth({ tokenSha256: hashToken(TOKEN), markerFile: marker }), { tokenSha256: hashToken(TOKEN) });
  // an unreadable marker location (not ENOENT) counts as present: fail closed
  const weird = path.join(marker, "child"); // ENOTDIR
  assert.equal(c.containerModeMarkerPresent(weird), true);
  assert.equal(c.containerModeMarkerPresent(none), false);
});

test("B1: the bridge script with no token and no opt-out refuses before listening", async () => {
  const port = await freePort();
  const saved = unsetSandboxEnv();
  try {
    const r = await startBridge(b1Env(homeWith("default", false), { CLAUDE_ASYNC_HTTP_PORT: String(port) }));
    if (r.listening) r.kill();
    assert.equal(r.listening, undefined, `must not listen: ${r.out}`);
    assert.equal(r.code, 78);
    assert.match(r.out, /token is required/i);
  } finally { Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined))); }
});

test("B1 (reviewer's scenario): empty config dir, no sandbox env, container-mode marker present: refuses before listening, even with the opt-out", async () => {
  const saved = unsetSandboxEnv();
  try {
    for (const optOut of [false, true]) {
      const port = await freePort();
      const r = await startBridge(b1Env(homeWith(`marker-${optOut}`, true),
        { CLAUDE_ASYNC_HTTP_PORT: String(port), ...(optOut ? { CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED: "1" } : {}) }));
      if (r.listening) r.kill();
      assert.equal(r.listening, undefined, `optOut=${optOut}: must not listen: ${r.out}`);
      assert.equal(r.code, 78);
      assert.match(r.out, /container-mode/);
    }
  } finally { Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined))); }
});

test("B1: the opt-out with no marker starts unauthenticated, with a loud warning", async () => {
  const saved = unsetSandboxEnv();
  const port = await freePort();
  const r = await startBridge(b1Env(homeWith("optout", false), { CLAUDE_ASYNC_HTTP_PORT: String(port), CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED: "1" }));
  try {
    assert.equal(r.listening, true, r.out);
    assert.match(r.out, /WARNING: .*starting UNAUTHENTICATED/);
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(h.auth, false);
  } finally { if (r.kill) r.kill(); Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined))); }
});

test("B1: writeContainerModeMarker creates the marker atomically and keeps an existing one", () => {
  const dir = path.join(TMP, "b1-write", ".claude-async");
  const file = path.join(dir, "container-mode");
  assert.deepEqual(c.writeContainerModeMarker(file), { ok: true, created: true });
  const first = fs.readFileSync(file, "utf8");
  assert.match(first, /container mode/i);
  assert.deepEqual(c.writeContainerModeMarker(file), { ok: true, created: false });
  assert.equal(fs.readFileSync(file, "utf8"), first, "never rewritten");
  assert.deepEqual(fs.readdirSync(dir), ["container-mode"], "no temp file left behind");
});
