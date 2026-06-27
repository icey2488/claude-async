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
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerTools, runSelfTest } from "./job-core.mjs";

if (process.argv.includes("--selftest")) {
  await runSelfTest();
} else {
  const server = new McpServer({ name: "claude-async", version: "1.0.0" });
  registerTools(server);
  const transport = new StdioServerTransport();

  const exit0 = () => process.exit(0);
  transport.onclose = exit0;                                  // explicit / in-band SDK close
  process.stdin.on("end", exit0);                             // graceful release (peer sends EOF)
  process.stdin.on("close", exit0);
  process.stdin.on("error", exit0);                           // hard pipe fault
  process.stdout.on("error", (e) =>                           // write to a closed read end
    process.exit(e && (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED") ? 0 : 1));

  await server.connect(transport);

  // Active liveness probe — the only signal that catches a HALF-OPEN zombie (no EOF, no write
  // error). The app's MCP client auto-pongs, so a healthy peer is never falsely killed.
  const pingMs = Number(process.env.CLAUDE_ASYNC_PING_MS) || 30000;
  const pingTimeout = Number(process.env.CLAUDE_ASYNC_PING_TIMEOUT_MS) || 10000;
  const watchdog = setInterval(() => {
    server.server.request({ method: "ping" }, EmptyResultSchema, { timeout: pingTimeout }).catch(exit0);
  }, pingMs);
  watchdog.unref();
}
