#!/usr/bin/env node
/**
 * test-resilience.mjs — proves the stdio self-heal in claude-async-server.mjs.
 *
 * Spawns the real server over piped stdio with a fast watchdog, completes the MCP
 * handshake, then checks the two failure paths actually kill the process:
 *   1) graceful release  : peer closes the server's stdin (EOF) -> server exits ~immediately
 *   2) half-open zombie  : peer stays connected but stops answering pings -> watchdog exits
 *
 * Run: node test-resilience.mjs   (exit 0 = all pass)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-async-server.mjs");
const FAST = { ...process.env, CLAUDE_ASYNC_PING_MS: "800", CLAUDE_ASYNC_PING_TIMEOUT_MS: "800" };
const send = (c, m) => c.stdin.write(JSON.stringify(m) + "\n");

// Spawn a server, complete initialize + initialized, and return the child + a queue of
// parsed JSON-RPC messages it emits. `onMessage` lets a scenario react (or deliberately not).
function start(onMessage) {
  const c = spawn(process.execPath, [SERVER], { env: FAST, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  c.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onMessage(JSON.parse(line), c);
    }
  });
  return c;
}

const waitExit = (c, ms) => new Promise((res) => {
  const t = setTimeout(() => res({ timedOut: true }), ms);
  c.on("exit", (code, signal) => { clearTimeout(t); res({ code, signal }); });
});

function handshake(c) {
  send(c, { jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
}

async function scenario(name, { respondToPing, closeStdinAfterInit }) {
  let initialized = false;
  const c = start((msg, child) => {
    if (msg.id === 0 && msg.result) {                 // initialize response
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      initialized = true;
      if (closeStdinAfterInit) child.stdin.end();      // scenario 1: graceful EOF
    } else if (msg.method === "ping" && "id" in msg) { // server -> client ping
      if (respondToPing) send(child, { jsonrpc: "2.0", id: msg.id, result: {} });
      // scenario 2: do nothing -> watchdog times out
    }
  });
  handshake(c);
  const r = await waitExit(c, 6000);
  try { c.kill(); } catch {}
  const ok = !r.timedOut && r.code === 0 && initialized;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name} (initialized=${initialized}, exit=${JSON.stringify(r)})`);
  return ok;
}

// Sanity: a healthy client that pongs must NOT be killed by the watchdog within the window.
async function healthyStaysUp() {
  let initialized = false;
  const c = start((msg, child) => {
    if (msg.id === 0 && msg.result) { send(child, { jsonrpc: "2.0", method: "notifications/initialized" }); initialized = true; }
    else if (msg.method === "ping" && "id" in msg) send(child, { jsonrpc: "2.0", id: msg.id, result: {} });
  });
  handshake(c);
  const r = await waitExit(c, 4000);          // expect to STILL be running after several ping cycles
  const ok = r.timedOut && initialized;       // timedOut here = good (process stayed alive)
  try { c.kill(); } catch {}
  console.log(`${ok ? "PASS" : "FAIL"} — healthy client stays up while ponging (initialized=${initialized}, exit=${JSON.stringify(r)})`);
  return ok;
}

const results = [];
results.push(await healthyStaysUp());
results.push(await scenario("graceful stdin EOF -> exit 0", { respondToPing: true, closeStdinAfterInit: true }));
results.push(await scenario("half-open zombie (stops ponging) -> watchdog exit 0", { respondToPing: false, closeStdinAfterInit: false }));

const passed = results.every(Boolean);
console.log(passed ? "\nALL RESILIENCE TESTS PASS" : "\nRESILIENCE TESTS FAILED");
process.exit(passed ? 0 : 1);
