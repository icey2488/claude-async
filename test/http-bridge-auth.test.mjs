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
