// Behavior tests for tools/ollama-generate.mjs (2026-11-13 review round, fix 2): runs the REAL
// generate()/parseArgs() against a local HTTP test server on an EPHEMERAL port, never the real
// Ollama daemon. The destination is injected through generate()'s {host,port,path} function
// parameter (never an environment variable a job could set itself) -- production call sites (the
// CLI entrypoint) never pass this override, so this is purely a test seam.
// Run: node --test test/ollama-generate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generate, parseArgs, EXIT } from "../tools/ollama-generate.mjs";

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
function stopServer(server) { return new Promise((r) => server.close(r)); }
const portOf = (server) => server.address().port;

test("parseArgs: requires --model and --prompt, rejects unknown flags and a bad model shape", () => {
  assert.match(parseArgs([]).error, /--model is required/);
  assert.match(parseArgs(["--model", "qwen3:8b"]).error, /--prompt is required/);
  assert.match(parseArgs(["--model", "qwen3:8b", "--prompt", "hi", "--proxy", "evil"]).error, /unrecognized argument/);
  assert.match(parseArgs(["--model", "../../etc/passwd", "--prompt", "hi"]).error, /does not look like a valid model name/);
  const ok = parseArgs(["--model", "qwen2.5-coder:7b", "--prompt", "hi"]);
  assert.ok(!ok.error, JSON.stringify(ok));
});

test("parseArgs: --model/--prompt/--system/--format are the only recognized flags (no file I/O, no proxy, no custom URL)", () => {
  for (const bad of ["--url", "--output", "-o", "--infile", "--outfile"]) {
    assert.match(parseArgs(["--model", "qwen3:8b", "--prompt", "y", bad, "z"]).error, /unrecognized argument/, `${bad} must be refused`);
  }
});

test("generate(): posts to /api/generate and returns the server's JSON body", async () => {
  let received = null;
  const server = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = { method: req.method, url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ response: "ok from test server", done: true }));
    });
  });
  try {
    const out = await generate(["--model", "qwen2.5-coder:7b", "--prompt", "say hi"], { port: portOf(server) });
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.status, 200);
    assert.match(out.body, /ok from test server/);
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/api/generate");
    assert.equal(received.body.model, "qwen2.5-coder:7b");
    assert.equal(received.body.prompt, "say hi");
    assert.equal(received.body.stream, false);
  } finally {
    await stopServer(server);
  }
});

test("generate(): --system and --format are forwarded in the JSON body", async () => {
  let received = null;
  const server = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ response: "{}" }));
    });
  });
  try {
    await generate(["--model", "qwen3:8b", "--prompt", "y", "--system", "be terse", "--format", "json"], { port: portOf(server) });
    assert.equal(received.system, "be terse");
    assert.equal(received.format, "json");
  } finally {
    await stopServer(server);
  }
});

test("generate(): never passes a proxy or follows a redirect even if the server offers one", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(302, { location: "http://evil.example/steal" });
    res.end();
  });
  try {
    const out = await generate(["--model", "qwen3:8b", "--prompt", "y"], { port: portOf(server) });
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.status, 302, "a redirect must be reported, never silently followed");
  } finally {
    await stopServer(server);
  }
});

test("generate(): aborts and reports truncated once the byte cap is exceeded, never buffers past it", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const iv = setInterval(() => {
      if (sent >= 2 * 1024 * 1024 || res.destroyed) { clearInterval(iv); try { res.end(); } catch {} return; }
      res.write(chunk);
      sent += chunk.length;
    }, 5);
    res.on("close", () => clearInterval(iv));
  });
  try {
    const out = await generate(["--model", "qwen3:8b", "--prompt", "y"], { port: portOf(server) });
    assert.ok(out.ok, JSON.stringify(out));
    assert.ok(out.body.length <= 512 * 1024 + 1024, `response body not bounded: ${out.body.length} bytes`);
  } finally {
    await stopServer(server);
  }
});

test("generate(): an absolute deadline reports EXIT.DEADLINE_EXCEEDED rather than hanging", async () => {
  const server = await startServer((_req, res) => {
    setTimeout(() => { try { res.end(); } catch {} }, 5_000); // never responds within the test's deadline
  });
  try {
    const out = await generate(["--model", "qwen3:8b", "--prompt", "y"], { port: portOf(server), deadlineMs: 150 });
    assert.ok(!out.ok, JSON.stringify(out));
    assert.equal(out.exitCode, EXIT.DEADLINE_EXCEEDED);
  } finally {
    await stopServer(server);
  }
});

test("generate(): a transport failure (nothing listening) reports TRANSPORT_FAILED, not a hang", async () => {
  const server = await startServer((_req, res) => res.end("{}"));
  const freePort = portOf(server);
  await stopServer(server); // port is now closed; a connection attempt must fail fast
  const out = await generate(["--model", "qwen3:8b", "--prompt", "y"], { port: freePort, deadlineMs: 3_000 });
  assert.ok(!out.ok, JSON.stringify(out));
  assert.equal(out.exitCode, EXIT.TRANSPORT_FAILED);
});

test("only configured local models are accepted", () => {
 for (const model of ["other:7b", "gpt-oss:120b-cloud", "qwen3:8b-cloud"]) assert.match(parseArgs(["--model",model,"--prompt","canary"]).error,/allowlisted/);
});
