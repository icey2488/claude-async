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
 * Crash visibility: uncaughtException/unhandledRejection are logged (stack + timestamp) to
 * stderr -- which Desktop captures into mcp-server-claude-async.log -- and to
 * bridge-crash.log next to the jobs directory, before exiting non-zero. SIGTERM/SIGINT/exit
 * also log a line, so a killed-from-outside bridge leaves a trace distinguishing "killed" from
 * "crashed". Caveat: on Windows, a forceful kill (TerminateProcess, e.g. Task Manager "End
 * Process" or `taskkill /F`) gives the process no chance to run any handler at all -- SIGTERM
 * isn't a real Windows signal, so process.kill(pid, "SIGTERM") maps to TerminateProcess too. The
 * SIGTERM/SIGINT handlers below are a best-effort trace for the cases Windows *can* deliver
 * (console Ctrl+C / Ctrl+Break), not a guarantee for every kill path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { runSelfTest, JOB_ROOT } from "./job-core.mjs";
import { registerTools } from "./dispatch.mjs";
import fs from "node:fs";
import path from "node:path";

const CRASH_LOG = path.join(JOB_ROOT, "bridge-crash.log");

function logTrace(kind, detail) {
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
  try { process.stderr.write(line); } catch {}
  try { fs.appendFileSync(CRASH_LOG, line); } catch {}
}

// On Windows, a piped process.stderr (Desktop captures ours into mcp-server-claude-async.log
// this way) is non-blocking: write() queues the data and returns before the OS has flushed it,
// so a process.exit() issued right after can truncate or drop the write entirely. These two
// handlers are the last-resort crash trace, so they wait for stderr's callback (falling back to
// exiting anyway if the stream errors) before exiting -- fs.appendFileSync above already landed
// synchronously regardless of platform, so CRASH_LOG never depends on this.
function logTraceThenExit(kind, detail, code) {
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
  try { fs.appendFileSync(CRASH_LOG, line); } catch {}
  try {
    process.stderr.write(line, () => process.exit(code));
  } catch {
    process.exit(code);
  }
}

process.on("uncaughtException", (err) => {
  logTraceThenExit("uncaughtException", (err && err.stack) || String(err), 1);
});
process.on("unhandledRejection", (reason) => {
  logTraceThenExit("unhandledRejection", (reason && reason.stack) || String(reason), 1);
});
process.on("SIGTERM", () => { logTrace("SIGTERM", "received, exiting"); process.exit(0); });
process.on("SIGINT", () => { logTrace("SIGINT", "received, exiting"); process.exit(0); });
process.on("exit", (code) => { logTrace("exit", `code=${code}`); });

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
