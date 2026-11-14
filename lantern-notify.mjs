/**
 * lantern-notify.mjs — best-effort status reporting to AgentGlass's Lantern board
 * (POST /agents/status on a local AgentGlass server), fired by job-runner.mjs for every
 * claude-async job so headless jobs show up on Starboard even though they never run the
 * UserPromptSubmit hook's own curl (denied under safe mode -- see RUNBOOK.md).
 *
 * Mirrors discord-notify.mjs's shape: strictly best-effort, strictly bounded
 * (LANTERN_TIMEOUT_MS), never throws, never follows a redirect, and reports failures only
 * through a caller-supplied logLine() -- job-runner.mjs wires that to err.log, never to the
 * job's own stdout, so a telemetry failure can never be mistaken for the job's own output.
 *
 * Destination: the host is fixed to the literal loopback address 127.0.0.1 (LANTERN_HOST,
 * never configurable -- only the port can move). Port resolution, in order:
 *   1. an explicit `server` passed by the caller (tests; a future caller that already knows it)
 *   2. CLAUDE_ASYNC_LANTERN_PORT (operator override)
 *   3. the port AgentGlass itself last published at $XDG_CONFIG_HOME/agentglass/port (or
 *      ~/.config/agentglass/port) -- see D:\code\agentglass\server\src\portfile.ts: AgentGlass's
 *      desktop shell walks to :4001 when :4000 is already taken, and a client that only ever
 *      assumes 4000 silently posts to whatever else happens to be listening there (that file's
 *      own header cites exactly this as a measured failure: "Lantern posts and hook events went
 *      to the stranger on :4000, which answers 200 and so reports no error").
 *   4. 4000, AgentGlass's own built-in default (server/src/index.ts: `Number(process.env.
 *      AGENTGLASS_PORT || 4000)`).
 *
 * Off switch: CLAUDE_ASYNC_LANTERN=0 disables every call in this module (lanternEnabled()
 * below) -- on by default. "On by default" does not mean noisy: a machine with no AgentGlass
 * running gets exactly one quick, silently-logged connection failure for the whole job (the
 * start post), because job-runner.mjs stops calling this module for the rest of that job the
 * first time a post fails -- see its lanternPost() wrapper.
 *
 * Test isolation (2026-11-13 live-board incident: node job-runner.mjs children spawned by tests
 * with no Lantern-specific setup at all -- e.g. test/runner-lock.test.mjs's `job1`, `job2`, ... --
 * posted real start lines to Erick's board, because the destination is loopback:4000 by default,
 * which is exactly AgentGlass's own default port; config-dir isolation (CLAUDE_ASYNC_CONFIG_DIR)
 * does nothing for Lantern, since resolveLanternPort() never reads it):
 * postLanternStatus/postLanternDone refuse to fall through to the real default destination
 * whenever CLAUDE_ASYNC_TEST/NODE_TEST_CONTEXT is set (isTestMode(), from discord-notify.mjs) --
 * UNLESS the caller passed an explicit `server` argument. This is a function parameter only, never
 * an env var: CLAUDE_ASYNC_LANTERN_PORT (the one documented operator knob, for a human pointing
 * their own real AgentGlass at a non-default port) does NOT exempt the block any more -- it used
 * to, and that was the hole test/multihost/lantern-runner.test.mjs's integration tests fell through
 * via the ambient env, which every *other* test-spawned job-runner.mjs child also inherits for
 * free. A test that needs job-runner.mjs (a separate OS process) to hit its own fake server now
 * writes a `lanternServer` field into the job's own spec.json instead (see job-runner.mjs) --
 * something only that one test's spec.json ever contains, never ambient, never leaked across jobs.
 * No test has to remember to opt out: the default is "blocked" for every job-runner.mjs child
 * started during a test run, whether or not that test has ever heard of Lantern.
 *
 * Only the fields named in postLanternStatus/postLanternDone's own parameter lists ever leave
 * this process: name, doing, worktree, session, done. Never the prompt, environment, or file
 * contents -- this module has no access to any of those in the first place, by construction.
 *
 * Deliberately node:http, not the global fetch(): on this machine (Windows, Node 24.19.0), three
 * or more fetch() calls in one process followed by process.exit() reliably crash with "Assertion
 * failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94" -- reproduced with
 * nothing but three sequential `await fetch(...)` calls against a local http server, no
 * AbortController, no body, no redirect, no custom headers involved. job-runner.mjs's finish()
 * always calls process.exit(0) right after, and between the start post, a session/intent repost,
 * and the done post, a single job can easily make 3+ Lantern calls -- on top of discord-notify.mjs's
 * own fetch() call in the same process. node:http.request()'s own connections close per-request
 * (no keep-alive agent) and do not trigger this; it also never follows a redirect on its own, so
 * "never follow a redirect" falls out for free rather than needing `redirect: "manual"`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { isTestMode } from "./discord-notify.mjs";

export const LANTERN_TIMEOUT_MS = 2000;
export const DEFAULT_LANTERN_PORT = 4000;
export const LANTERN_HOST = "127.0.0.1"; // never configurable -- see header

export function lanternEnabled() {
  return process.env.CLAUDE_ASYNC_LANTERN !== "0";
}

export function agentglassConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentglass");
}

export function agentglassPortFilePath() {
  return path.join(agentglassConfigDir(), "port");
}

// The port AgentGlass's own server last published (see portfile.ts). null on any failure (file
// absent, unreadable, not a positive integer) -- never throws.
export function readPublishedPort(fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(agentglassPortFilePath(), "utf8").trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

export function resolveLanternPort(fsImpl = fs) {
  const envPort = Number(process.env.CLAUDE_ASYNC_LANTERN_PORT);
  if (Number.isInteger(envPort) && envPort > 0) return envPort;
  const published = readPublishedPort(fsImpl);
  return published ?? DEFAULT_LANTERN_PORT;
}

export function lanternServerUrl(fsImpl = fs) {
  return `http://${LANTERN_HOST}:${resolveLanternPort(fsImpl)}`;
}

// True only for the literal loopback hostnames node:http will ever dial for a Lantern post --
// never a hostname that merely *resolves* to loopback (dns lookups are not attempted here; this
// is a string check against the URL's own hostname). Guards every call in this module, no matter
// where a `server`/`url` argument came from (an explicit test server, the default destination, or
// a per-job spec.json field a job's own files could have written) -- see postJson() below.
export function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// Single bounded POST over node:http (see the header for why not fetch()). Never throws, never
// rejects. No redirect is ever followed -- http.request() has no such behavior to opt out of; a
// 3xx response is just reported as !ok, the same as any other non-2xx status.
function postJson(url, body, { timeoutMs = LANTERN_TIMEOUT_MS, logLine, httpImpl = http } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) {
      try { logLine && logLine(`lantern: ${url} is not a valid URL (${e.message})`); } catch {}
      resolve({ ok: false, error: "bad url" });
      return;
    }
    if (!isLoopbackHost(u.hostname)) {
      try { logLine && logLine(`lantern: refusing to post to ${url} -- not a loopback destination`); } catch {}
      resolve({ ok: false, error: "non-loopback destination refused" });
      return;
    }
    const payload = JSON.stringify(body);
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; try { req.destroy(); } catch {} resolve(result); };
    const req = httpImpl.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      res.resume(); // drain, never inspected: the board's own 200 "ok"/error bodies carry nothing this caller needs.
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) { try { logLine && logLine(`lantern: ${url} returned HTTP ${res.statusCode}`); } catch {} }
        finish({ ok, status: res.statusCode });
      });
    });
    req.on("timeout", () => {
      try { logLine && logLine(`lantern: request to ${url} timed out`); } catch {}
      finish({ ok: false, error: "timed out" });
    });
    req.on("error", (e) => {
      const reason = (e && e.message) || String(e);
      try { logLine && logLine(`lantern: request to ${url} failed (${reason})`); } catch {}
      finish({ ok: false, error: reason });
    });
    req.end(payload);
  });
}

// See the header's "Test isolation" note: true when a caller is about to fall through to the
// REAL default destination (no explicit `server`) while a test harness's env markers are set.
// CLAUDE_ASYNC_LANTERN_PORT deliberately does NOT exempt this -- an env var can't be the gate,
// since every job-runner.mjs child a test spawns inherits the same ambient environment.
function blockedRealSendInTestMode(server) {
  return !server && isTestMode();
}

// Posts/replaces this job's status line. Only `name` is required -- AgentBoard.saidBy treats a
// blank doing/worktree/session as "not said", not an error, so a caller that doesn't know one
// of these yet can safely pass "".
export async function postLanternStatus({ name, doing = "", worktree = "", session = "", server, timeoutMs, logLine, httpImpl } = {}) {
  if (!name) return { ok: false, skipped: "no name" };
  // Silent, not logged: this is an expected, routine no-op for every test that never heard of
  // Lantern (see the header's "Test isolation" note), not a failure worth a line in a job dir
  // some other test asserts byte-for-byte against.
  if (blockedRealSendInTestMode(server)) return { ok: false, skipped: "test mode" };
  const base = server || lanternServerUrl();
  return postJson(`${base}/agents/status`, { name, doing, worktree, session }, { timeoutMs, logLine, httpImpl });
}

// Clears this job's line. The board requires a non-empty session that matches the one the
// status line was last posted with (agentboard.ts's forgetAgent is keyed on name AND session,
// precisely so a bystander process can't clear someone else's line on this tokenless-on-loopback
// route) -- a job that never resolved a session id cannot clear its own row this way, and the
// caller should not even attempt the call in that case (see job-runner.mjs), since the server
// would just answer 400.
export async function postLanternDone({ name, session, server, timeoutMs, logLine, httpImpl } = {}) {
  if (!name || !session) return { ok: false, skipped: "no name or session" };
  if (blockedRealSendInTestMode(server)) return { ok: false, skipped: "test mode" };
  const base = server || lanternServerUrl();
  return postJson(`${base}/agents/status`, { name, done: true, session }, { timeoutMs, logLine, httpImpl });
}

// Generic bounded poll: calls checkFn() every intervalMs until it returns a truthy value (then
// calls onFound with it and stops) or timeoutMs elapses (then stops silently). Returns a stop()
// function. Used for two independent "wait for something job-core writes later" cases in
// job-runner.mjs: meta.json's `intent` field, and a new Claude Code session transcript file
// (lantern-session.mjs). unref()'d so it never holds the process open on its own.
export function pollUntil(checkFn, { intervalMs, timeoutMs, onFound }) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - startedAt > timeoutMs) { clearInterval(timer); return; }
    let v;
    try { v = checkFn(); } catch { v = null; }
    if (v) { clearInterval(timer); onFound(v); }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// meta.json is written by job-core.mjs AFTER the runner is already launched (card minting can
// be slow -- a network call), so it may not exist yet when job-runner.mjs starts. null on any
// failure (missing file, unparseable, no/blank intent) -- never throws.
export function readIntentFromMeta(metaPath, fsImpl = fs) {
  try {
    const m = JSON.parse(fsImpl.readFileSync(metaPath, "utf8"));
    return typeof m.intent === "string" && m.intent ? m.intent : null;
  } catch { return null; }
}
