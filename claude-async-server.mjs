#!/usr/bin/env node
/**
 * claude-async-server.mjs — STDIO entrypoint (Architecture A). Thin wrapper over job-core.
 *
 * Self-heals against the desktop app's renderer-port zombie: the app can drop its end of the
 * stdio pipe WITHOUT killing this process or sending EOF, so transport.onclose does NOT fire
 * in that case (verified). We therefore also watch stdin end/close/error and stdout EPIPE, and
 * run an unref'd server->client ping watchdog — any dead-peer signal exits the process so the
 * app respawns a fresh server. Nothing is lost: jobs are detached and durable on disk
 * (re-attach with claude_check by jobId). Tunable via CLAUDE_ASYNC_PING_MS / _PING_TIMEOUT_MS.
 *
 * TEMP DIAGNOSTIC (remove before publishing): flight recorder + watchdog tracing, gated
 * entirely behind CLAUDE_ASYNC_RECORD=<path>. No-op when that var is unset. Watchdog EXIT
 * behavior is intentionally UNCHANGED here so the suspected suicide reproduces under test.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import fsSync from "node:fs";
import { registerTools, runSelfTest } from "./job-core.mjs";

// --- FLIGHT RECORDER (temporary; enable with CLAUDE_ASYNC_RECORD=<path>) ---------------
const REC = process.env.CLAUDE_ASYNC_RECORD || null;
const rec = (m) => { if (REC) { try { fsSync.appendFileSync(REC, `${new Date().toISOString()} ${m}\n`); } catch {} } };
if (REC) {
  // Boot write-probe: a bad/unwritable RECORD path must SHOUT, not silently yield an empty log.
  try { fsSync.appendFileSync(REC, `${new Date().toISOString()} === recorder boot-probe pid=${process.pid} ===\n`); }
  catch (e) { try { fsSync.writeSync(2, Buffer.from(`[claude-async] CLAUDE_ASYNC_RECORD unwritable: ${e.message}\n`)); } catch {} }
  process.on("exit", (c) => rec(`PROCESS_EXIT code=${c}`));
  process.on("uncaughtException", (e) => {
    const errStr = `${e && e.stack || e}\n`;
    rec(`UNCAUGHT ${errStr}`);
    try { fsSync.writeSync(2, Buffer.from(errStr)); } catch {} // sync blast to fd 2 — survives the next-tick exit
    process.exit(1);
  });
}
// --------------------------------------------------------------------------------------

if (process.argv.includes("--selftest")) {
  await runSelfTest();
} else {
  const server = new McpServer({ name: "claude-async", version: "1.0.0" });
  registerTools(server);
  const transport = new StdioServerTransport();

  const exit0 = () => process.exit(0);
  transport.onclose = () => { rec("transport.onclose"); exit0(); };          // explicit / in-band SDK close
  process.stdin.on("end", () => { rec("stdin end"); exit0(); });             // graceful release (peer EOF)
  process.stdin.on("close", () => { rec("stdin close"); exit0(); });
  process.stdin.on("error", (e) => { rec(`stdin error ${e && e.code}`); exit0(); });  // hard pipe fault
  process.stdout.on("error", (e) => {                                        // write to a closed read end
    rec(`stdout error ${e && e.code}`);
    process.exit(e && (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED") ? 0 : 1);
  });

  await server.connect(transport);

  const pingMs = Number(process.env.CLAUDE_ASYNC_PING_MS) || 30000;
  const pingTimeout = Number(process.env.CLAUDE_ASYNC_PING_TIMEOUT_MS) || 10000;
  rec(`=== boot pid=${process.pid} pingMs=${pingMs} pingTimeout=${pingTimeout} ===`);

  // Heartbeat — the LAST line's timestamp is the exact instant of death (kernel-written to disk,
  // immune to DWM/Task-Manager UI stutter under heavy I/O).
  if (REC) { const hb = setInterval(() => rec(`heartbeat pid=${process.pid}`), 1000); hb.unref(); }

  // Active liveness probe. BEHAVIOR UNCHANGED FOR THE TEST: still exits on the first ping miss,
  // so a watchdog-suicide reproduces exactly as in the field. We only ADD tracing around it.
  // After the tape confirms the mechanism, swap the .catch for the consecutive-miss version (P1).
  const watchdog = setInterval(() => {
    const t0 = Date.now();
    server.server.request({ method: "ping" }, EmptyResultSchema, { timeout: pingTimeout })
      .then(() => rec(`ping ok (${Date.now() - t0}ms)`))
      .catch((e) => { rec(`ping MISS (${Date.now() - t0}ms) [${e && e.message}] -> WATCHDOG EXIT`); exit0(); });
  }, pingMs);
  watchdog.unref();
}
