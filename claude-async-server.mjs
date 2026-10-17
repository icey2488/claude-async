#!/usr/bin/env node
/**
 * claude-async-server.mjs — STDIO entrypoint (Architecture A). Thin wrapper over job-core.
 *
 * Self-heals against the desktop app's renderer-port zombie: the app can drop its end of the
 * stdio pipe WITHOUT killing this process or sending EOF, so transport.onclose does NOT fire
 * in that case (verified). We therefore also watch stdin end/close/error and stdout EPIPE, and
 * run an unref'd server->client ping watchdog — a dead-peer signal exits the process so the app
 * respawns a fresh server. Nothing is lost: jobs are detached and durable on disk (re-attach
 * with claude_check by jobId). Tunable via the CLAUDE_ASYNC_PING_* env vars documented below.
 *
 * Exit visibility: every exit path in this file (ping watchdog, stdin/stdout/transport signals,
 * SIGTERM/SIGINT, uncaughtException/unhandledRejection) is routed through exitWith(), which logs
 * one `exit: code=N reason=<tag> pid=... ppid=... uptime=...` line to stderr (Desktop captures
 * ours into mcp-server-claude-async.log) and to bridge-crash.log next to the jobs directory
 * before exiting, so a dead/respawned bridge is attributable after the fact instead of leaving
 * only a bare "exit: code=0". Caveat: on Windows, a forceful kill (TerminateProcess, e.g. Task
 * Manager "End Process" or `taskkill /F`) gives the process no chance to run any handler at all
 * -- SIGTERM isn't a real Windows signal, so process.kill(pid, "SIGTERM") maps to TerminateProcess
 * too. The SIGTERM/SIGINT handlers below are a best-effort trace for the cases Windows *can*
 * deliver (console Ctrl+C / Ctrl+Break), not a guarantee for every kill path.
 *
 * Ping watchdog tolerance: a single missed pong used to exit immediately, which fired on a mere
 * Windows sleep/resume (Desktop's main process stalls for seconds after wake, missing the pong
 * with the peer very much alive). Misses now accumulate; see shouldExitOnMiss/isResumeGap in
 * ping-watchdog.mjs for the exact rule, and README.md for the CLAUDE_ASYNC_PING_* env vars.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { runSelfTest, JOB_ROOT, pidAlive } from "./job-core.mjs";
import { registerTools } from "./dispatch.mjs";
import { PING_DEFAULTS, shouldExitOnMiss, isResumeGap, formatExitLine } from "./ping-watchdog.mjs";
import fs from "node:fs";
import path from "node:path";

const CRASH_LOG = path.join(JOB_ROOT, "bridge-crash.log");

function logTrace(kind, detail) {
  const line = `[${new Date().toISOString()}] ${kind}: pid=${process.pid} ${detail}\n`;
  try { process.stderr.write(line); } catch {}
  try { fs.appendFileSync(CRASH_LOG, line); } catch {}
}

// True once exitWith has logged+initiated an exit, so the generic process.on("exit") handler
// below never double-logs a path that already identified itself.
let exitLogged = false;

// The single exit path for this process. On Windows, a piped process.stderr (how Desktop
// captures ours into mcp-server-claude-async.log) is non-blocking: write() queues the data and
// returns before the OS has flushed it, so a process.exit() issued right after can truncate or
// drop the write entirely. We therefore wait for stderr's callback (falling back to exiting
// anyway if the stream errors) before exiting -- fs.appendFileSync below already landed
// synchronously regardless of platform, so CRASH_LOG never depends on the stderr write landing.
function exitWith(code, reason, detail = "") {
  if (exitLogged) return; // a second exit signal (e.g. stdin "close" right after "end") is a no-op
  exitLogged = true;
  const body = formatExitLine({ code, reason, pid: process.pid, ppid: process.ppid,
                                 uptimeS: process.uptime().toFixed(1), detail });
  const line = `[${new Date().toISOString()}] ${body}\n`;
  try { fs.appendFileSync(CRASH_LOG, line); } catch {}
  try {
    process.stderr.write(line, () => process.exit(code));
  } catch {
    process.exit(code);
  }
}

process.on("uncaughtException", (err) => {
  exitWith(1, "uncaught", (err && err.stack) || String(err));
});
process.on("unhandledRejection", (reason) => {
  exitWith(1, "unhandled-rejection", (reason && reason.stack) || String(reason));
});
process.on("SIGTERM", () => exitWith(0, "sigterm"));
process.on("SIGINT", () => exitWith(0, "sigint"));
process.on("exit", (code) => { if (!exitLogged) logTrace("exit", `code=${code} reason=unknown (no exitWith call)`); });

if (process.argv.includes("--selftest")) {
  await runSelfTest();
} else {
  const server = new McpServer({ name: "claude-async", version: "1.0.0" });
  registerTools(server);
  const transport = new StdioServerTransport();

  // Consecutive missed-pong counter for the watchdog below. Any inbound message (a real,
  // in-band proof the peer is alive) resets it, same as a successful pong does. Set BEFORE
  // connect() so the Protocol class (server/protocol.js) chains our handler rather than
  // overwriting it -- same pattern already relied on for transport.onclose below.
  let misses = 0;
  transport.onmessage = () => { misses = 0; };

  transport.onclose = () => exitWith(0, "transport-onclose");  // explicit / in-band SDK close
  process.stdin.on("end", () => exitWith(0, "stdin-end"));     // graceful release (peer sends EOF)
  process.stdin.on("close", () => exitWith(0, "stdin-close"));
  process.stdin.on("error", (err) =>                           // hard pipe fault
    exitWith(0, "stdin-error", (err && err.code) || String(err)));
  process.stdout.on("error", (e) => {                          // write to a closed read end
    const code = e && e.code;
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") exitWith(0, "stdout-epipe", code);
    else exitWith(1, "stdout-error", String(e));
  });

  await server.connect(transport);

  // Active liveness probe — the only signal that catches a HALF-OPEN zombie (no EOF, no write
  // error). The app's MCP client auto-pongs, so a healthy peer is never falsely killed.
  //
  // A single missed pong used to exit immediately -- too eager: a Windows sleep/resume stalls
  // Desktop's main process for seconds on wake (observed 18.4s), missing one pong with the peer
  // very much alive. Misses now accumulate; shouldExitOnMiss (ping-watchdog.mjs) only exits once
  // CLAUDE_ASYNC_PING_MAX_MISSES consecutive misses have landed AND the parent process itself
  // looks gone (checked via pidAlive -> process.kill(ppid, 0), which on win32 just probes process
  // existence via OpenProcess/TerminateProcess-check semantics -- verified empirically, it does
  // NOT terminate the target), or unconditionally once CLAUDE_ASYNC_PING_HARD_CAP_MISSES misses
  // have landed regardless of parent liveness (covers a wedged-but-technically-alive parent, or
  // pid reuse making "alive" a false positive). A wall-clock jump between ticks bigger than
  // CLAUDE_ASYNC_PING_RESUME_FACTOR x the ping interval indicates the machine itself slept; that
  // tick's miss (if any) is forgiven rather than counted, giving the peer one full interval to
  // recover before misses resume counting against it. stdin end/close above are unaffected --
  // those are true in-band peer-gone signals, not probabilistic, so they still exit on first sight.
  const pingMs = Number(process.env.CLAUDE_ASYNC_PING_MS) || 30000;
  const pingTimeout = Number(process.env.CLAUDE_ASYNC_PING_TIMEOUT_MS) || 10000;
  const maxMisses = Number(process.env.CLAUDE_ASYNC_PING_MAX_MISSES) || PING_DEFAULTS.maxMisses;
  const hardCapMisses = Number(process.env.CLAUDE_ASYNC_PING_HARD_CAP_MISSES) || PING_DEFAULTS.hardCapMisses;
  const resumeFactor = Number(process.env.CLAUDE_ASYNC_PING_RESUME_FACTOR) || PING_DEFAULTS.resumeFactor;
  let lastTickAt = Date.now();
  let graceTicksRemaining = 0;
  const watchdog = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickAt;
    lastTickAt = now;
    if (isResumeGap(elapsed, pingMs, resumeFactor)) {
      graceTicksRemaining = 1;
      logTrace("ping-resume", `elapsed=${elapsed}ms pingMs=${pingMs} grace granted`);
    }
    server.server.request({ method: "ping" }, EmptyResultSchema, { timeout: pingTimeout })
      .then(() => { misses = 0; })
      .catch(() => {
        misses++;
        const parentAlive = pidAlive(process.ppid);
        const resumeDetected = graceTicksRemaining > 0;
        if (resumeDetected) graceTicksRemaining--;
        logTrace("ping-miss", `count=${misses} parentAlive=${parentAlive} resumeGrace=${resumeDetected}`);
        if (shouldExitOnMiss(misses, parentAlive, resumeDetected, { maxMisses, hardCapMisses })) {
          exitWith(0, "ping-timeout", `misses=${misses} parentAlive=${parentAlive}`);
        }
      });
  }, pingMs);
  watchdog.unref();
}
