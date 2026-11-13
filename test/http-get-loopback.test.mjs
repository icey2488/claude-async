// Behavior tests for tools/http-get-loopback.mjs (2026-11-13 review round, fix 6): runs the REAL
// getLoopback()/validateLoopbackUrl() against local HTTP test servers on EPHEMERAL ports, with the
// allowlist injected through getLoopback()'s `allowedTargets` function parameter (never an
// environment variable a job could set itself) so these tests never depend on anything actually
// listening on 7842/11434.
// Run: node --test test/http-get-loopback.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getLoopback, validateLoopbackUrl, EXIT } from "../tools/http-get-loopback.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "http-get-loopback.mjs");

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
function stopServer(server) { return new Promise((r) => server.close(r)); }
const portOf = (server) => server.address().port;

// --- validateLoopbackUrl: the allowlist itself ---------------------------------------------------

test("validateLoopbackUrl: refuses a port/path pair not in the allowlist", () => {
  const targets = [{ port: 9999, path: "/ok" }];
  assert.ok(validateLoopbackUrl("http://127.0.0.1:9999/not-ok", targets).error);
  assert.ok(!validateLoopbackUrl("http://127.0.0.1:9999/ok", targets).error);
});

test("validateLoopbackUrl: refuses a hostname other than the literal 127.0.0.1 (no resolver dependence)", () => {
  const targets = [{ port: 9999, path: "/ok" }];
  assert.match(validateLoopbackUrl("http://localhost:9999/ok", targets).error, /127\.0\.0\.1/);
  assert.match(validateLoopbackUrl("http://[::1]:9999/ok", targets).error, /127\.0\.0\.1/);
});

test("validateLoopbackUrl: refuses userinfo, https, and a query string/fragment", () => {
  const targets = [{ port: 9999, path: "/ok" }];
  assert.ok(validateLoopbackUrl("http://user:pass@127.0.0.1:9999/ok", targets).error);
  assert.ok(validateLoopbackUrl("https://127.0.0.1:9999/ok", targets).error);
  assert.ok(validateLoopbackUrl("http://127.0.0.1:9999/ok?x=1", targets).error);
  assert.ok(validateLoopbackUrl("http://127.0.0.1:9999/ok#frag", targets).error);
});

test("the real production allowlist contains exactly the three verified pairs", async () => {
  const mod = await import("../tools/http-get-loopback.mjs");
  assert.deepEqual(mod.ALLOWED_TARGETS, [
    { port: 7842, path: "/healthz" },
    { port: 11434, path: "/api/tags" },
    { port: 11434, path: "/api/ps" },
  ]);
});

// --- getLoopback(): real HTTP exchange against an ephemeral-port test server ---------------------

test("getLoopback(): GETs the allowed target and returns status/body", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
  });
  try {
    const targets = [{ port: portOf(server), path: "/healthz" }];
    const out = await getLoopback(`http://127.0.0.1:${portOf(server)}/healthz`, { allowedTargets: targets });
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    const body = JSON.parse(out.body);
    assert.equal(body.method, "GET");
    assert.equal(body.url, "/healthz");
  } finally {
    await stopServer(server);
  }
});

test("getLoopback(): refuses a target not in the allowlist, never connects", async () => {
  const server = await startServer((_req, res) => res.end("should never be reached"));
  try {
    const out = await getLoopback(`http://127.0.0.1:${portOf(server)}/not-allowed`, { allowedTargets: [{ port: portOf(server), path: "/healthz" }] });
    assert.equal(out.exitCode, EXIT.REFUSED);
  } finally {
    await stopServer(server);
  }
});

test("getLoopback(): follows a redirect only while it stays within the allowlist", async () => {
  const server = await startServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(302, { location: `/api/tags` }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("final");
  });
  try {
    const targets = [{ port: portOf(server), path: "/healthz" }, { port: portOf(server), path: "/api/tags" }];
    const out = await getLoopback(`http://127.0.0.1:${portOf(server)}/healthz`, { allowedTargets: targets });
    assert.equal(out.status, 200);
    assert.equal(out.body, "final");
    assert.equal(out.redirects.length, 1);
  } finally {
    await stopServer(server);
  }
});

test("getLoopback(): does not follow a redirect off the allowlist, reports it instead", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:9/evil" });
    res.end();
  });
  try {
    const targets = [{ port: portOf(server), path: "/healthz" }];
    const out = await getLoopback(`http://127.0.0.1:${portOf(server)}/healthz`, { allowedTargets: targets });
    assert.equal(out.ok, true);
    assert.equal(out.status, 302);
    assert.match(out.warning, /not followed/);
  } finally {
    await stopServer(server);
  }
});

test("getLoopback(): aborts and reports truncated once the byte cap is exceeded", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(256 * 1024));
  });
  try {
    const targets = [{ port: portOf(server), path: "/healthz" }];
    const out = await getLoopback(`http://127.0.0.1:${portOf(server)}/healthz`, { allowedTargets: targets });
    assert.equal(out.truncated, true);
    assert.ok(out.body.length <= 64 * 1024 + 1024, `body not bounded: ${out.body.length}`);
  } finally {
    await stopServer(server);
  }
});

test("getLoopback(): an absolute deadline reports a transport failure rather than hanging", async () => {
  const server = await startServer((_req, res) => { setTimeout(() => { try { res.end(); } catch {} }, 5_000); });
  try {
    const targets = [{ port: portOf(server), path: "/healthz" }];
    const out = await getLoopback(`http://127.0.0.1:${portOf(server)}/healthz`, { allowedTargets: targets, timeoutMs: 150 });
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, EXIT.TRANSPORT_FAILED);
  } finally {
    await stopServer(server);
  }
});

test("getLoopback(): a disallowed port on an allowed path is refused, never connects", async () => {
  const targets = [{ port: 7842, path: "/healthz" }];
  const out = await getLoopback("http://127.0.0.1:59999/healthz", { allowedTargets: targets });
  assert.equal(out.exitCode, EXIT.REFUSED);
});

// --- CLI: forward-slash main-module bug (fix 6) ---------------------------------------------------

test("CLI: invoking with backslashes runs normally", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.stdout, /usage:/);
});

test("CLI: invoking with forward slashes also runs (not silently exit 0 with no output)", () => {
  const forwardSlash = SCRIPT.replace(/\\/g, "/");
  const r = spawnSync(process.execPath, [forwardSlash], { encoding: "utf8" });
  assert.equal(r.status, EXIT.USAGE, `forward-slash invocation must still run cliMain: stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.match(r.stdout, /usage:/);
});
