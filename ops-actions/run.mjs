#!/usr/bin/env node
/**
 * ops-actions/run.mjs -- the only way an `ops`-profile safe-mode job may take an operational
 * action (restart a service, run a scheduled task) instead of editing files or running tests.
 *
 * Why this exists (safe-mode-profiles, 2026-11-09, ITEM 3): the `ops` profile needs SOME path to
 * do real operational work, but a bare allow rule for schtasks/taskkill/Stop-Process would let a
 * job run ANY such command with ANY argument -- there is no narrower prefix that only matches "the
 * two actions Erick actually wants automated". So, same pattern as scripts/publish-branch.mjs and
 * tools/http-get-loopback.mjs: ONE script, a FIXED registry of named actions (ACTIONS below), no
 * free-form command arguments (the CLI only accepts an action name from that registry plus
 * --dry-run), and every invocation -- allowed, refused, or failed -- is appended to an audit log
 * under the user's home directory (never inside this repo, so it survives a worktree/branch swap
 * and is never accidentally committed).
 *
 * Honesty about what this does NOT do (see the PR description for the full writeup): this script
 * refuses to run unless process.env.CLAUDE_ASYNC_JOB_PROFILE is exactly "ops", but that check is a
 * convention this script enforces on itself, not a host-level sandboxing boundary -- `node` is an
 * allowed prefix in every safe-mode profile (code and ops alike), so a determined job could still
 * write and run a different script that does the same thing with no such check. The audited
 * registry is a norm a well-behaved job follows, not a hard boundary against one that doesn't want
 * to. Judge/human sign-off for actually RUNNING an `ops` action (as opposed to --dry-run) is a
 * follow-up, not implemented here (see RUNBOOK.md's safe-mode-profiles section).
 *
 * Each action's real (non-dry-run) steps are only ever exercised here via --dry-run in CI/tests;
 * see docs/publishing.md's sibling doc, RUNBOOK.md, for why: these steps stop/start real services.
 *
 * Usage: node ops-actions/run.mjs <action> [--dry-run]
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLoopback } from "../tools/http-get-loopback.mjs";

export const EXIT = Object.freeze({
  OK: 0, USAGE: 2, PROFILE_REFUSED: 10, UNKNOWN_ACTION: 11, CONFIG_REFUSED: 12,
  STEP_FAILED: 20, AUDIT_FAILED: 16, INTERNAL: 30,
});

class Refusal extends Error { constructor(code, message) { super(message); this.code = code; } }

function run(cmd, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, shell: false, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// Lists PIDs of node.exe processes whose command line contains `needle` (case-insensitive).
async function findPidsByCommandLine(needle) {
  const psCmd = `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains(${JSON.stringify(String(needle).toLowerCase())}) } | ` +
    `Select-Object -ExpandProperty ProcessId) -join ","`;
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd]);
  if (!r.ok) return [];
  return r.stdout.trim().split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isInteger);
}

function portListening(port, host = "127.0.0.1", timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

async function waitForPort(port, { attempts = 10, intervalMs = 1_000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await portListening(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// A "step" is { describe(): string, exec(): Promise<{ok, detail}> }. describe() must never throw
// and must never depend on anything that isn't already known at dry-run time.
function step(describe, exec) { return { describe, exec }; }

// --- hostapi-restart --------------------------------------------------------------------------
// Steps taken from past job logs (per the task's own summary, ~/.claude-async-jobs): stop/start
// the ClaudeAsyncHostApi scheduled task, stop the host-api.mjs node process, verify a new listener
// on port 7850.
const HOSTAPI_TASK_NAME = "ClaudeAsyncHostApi";
const HOSTAPI_PORT = 7850;

function hostapiRestartSteps() {
  return [
    step(() => `schtasks /End /TN "${HOSTAPI_TASK_NAME}"`,
      async () => { const r = await run("schtasks", ["/End", "/TN", HOSTAPI_TASK_NAME]); return { ok: r.ok, detail: r.stdout || r.stderr }; }),
    step(() => `find node.exe process(es) whose command line contains "host-api.mjs" and taskkill /F each`,
      async () => {
        const pids = await findPidsByCommandLine("host-api.mjs");
        if (pids.length === 0) return { ok: true, detail: "no matching process found (already stopped)" };
        const results = [];
        for (const pid of pids) results.push(await run("taskkill", ["/PID", String(pid), "/F"]));
        return { ok: results.every((r) => r.ok), detail: `pids=${pids.join(",")} ${results.map((r) => r.stdout || r.stderr).join(" | ")}` };
      }),
    step(() => `schtasks /Run /TN "${HOSTAPI_TASK_NAME}"`,
      async () => { const r = await run("schtasks", ["/Run", "/TN", HOSTAPI_TASK_NAME]); return { ok: r.ok, detail: r.stdout || r.stderr }; }),
    step(() => `verify a new listener on 127.0.0.1:${HOSTAPI_PORT} (poll up to 10s)`,
      async () => { const ok = await waitForPort(HOSTAPI_PORT); return { ok, detail: ok ? "listening" : "no listener after 10s" }; }),
  ];
}

// --- agentglass-update-restart ----------------------------------------------------------------
// Steps per the task's own summary: fetch tags, back up the DB, stop the process, start the
// AgentGlassNative task, verify health. The referenced job log
// (claunker.agentglass-update-restart-20261108-k7bscqgf) does not exist on this machine (checked
// via Glob under ~/.claude-async-jobs during the earlier job; see the PR description), so the repo
// path, DB path, process-match string, and health URL are deliberately NOT hardcoded guesses -- they
// are REQUIRED env vars the action refuses to run (even in dry-run's config-resolution sense) without.
const AGENTGLASS_TASK_NAME = "AgentGlassNative";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Refusal(EXIT.CONFIG_REFUSED, `${name} is required for agentglass-update-restart and is not set`);
  return v;
}

function agentglassUpdateRestartSteps() {
  // Reading env here (not at module load) so a --dry-run with env unset can still list the
  // actions it WOULD take, each naming the specific missing variable instead of a real path.
  const repo = process.env.AGENTGLASS_REPO || "<AGENTGLASS_REPO unset>";
  const dbPath = process.env.AGENTGLASS_DB_PATH || "<AGENTGLASS_DB_PATH unset>";
  const processMatch = process.env.AGENTGLASS_PROCESS_MATCH || "<AGENTGLASS_PROCESS_MATCH unset>";
  const healthUrl = process.env.AGENTGLASS_HEALTH_URL || "<AGENTGLASS_HEALTH_URL unset>";
  return [
    step(() => `git -C ${repo} fetch --tags`,
      async () => { const r = await run("git", ["-C", requireEnv("AGENTGLASS_REPO"), "fetch", "--tags"]); return { ok: r.ok, detail: r.stdout || r.stderr }; }),
    step(() => `copy ${dbPath} to ${dbPath}.bak-<timestamp>`,
      async () => {
        const db = requireEnv("AGENTGLASS_DB_PATH");
        const backup = `${db}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.copyFileSync(db, backup);
        return { ok: true, detail: backup };
      }),
    step(() => `find node.exe process(es) whose command line contains "${processMatch}" and taskkill /F each`,
      async () => {
        const pids = await findPidsByCommandLine(requireEnv("AGENTGLASS_PROCESS_MATCH"));
        if (pids.length === 0) return { ok: true, detail: "no matching process found (already stopped)" };
        const results = [];
        for (const pid of pids) results.push(await run("taskkill", ["/PID", String(pid), "/F"]));
        return { ok: results.every((r) => r.ok), detail: `pids=${pids.join(",")} ${results.map((r) => r.stdout || r.stderr).join(" | ")}` };
      }),
    step(() => `schtasks /Run /TN "${AGENTGLASS_TASK_NAME}"`,
      async () => { const r = await run("schtasks", ["/Run", "/TN", AGENTGLASS_TASK_NAME]); return { ok: r.ok, detail: r.stdout || r.stderr }; }),
    step(() => `GET ${healthUrl} (loopback only, via tools/http-get-loopback.mjs's getLoopback())`,
      async () => {
        const url = requireEnv("AGENTGLASS_HEALTH_URL");
        const out = await getLoopback(url);
        return { ok: out.ok && out.status >= 200 && out.status < 300, detail: JSON.stringify(out) };
      }),
  ];
}

export const ACTIONS = Object.freeze({
  "hostapi-restart": hostapiRestartSteps,
  "agentglass-update-restart": agentglassUpdateRestartSteps,
});

export function parseArgs(argv) {
  const out = { action: null, dryRun: false };
  const rest = [];
  for (const a of argv) {
    if (a === "--dry-run") { out.dryRun = true; continue; }
    rest.push(a);
  }
  if (rest.length !== 1) throw new Refusal(EXIT.USAGE, `usage: run.mjs <action> [--dry-run] (got positional args: ${JSON.stringify(rest)})`);
  out.action = rest[0];
  return out;
}

function auditLogPath(env = process.env) {
  return env.OPS_ACTIONS_AUDIT_LOG || path.join(os.homedir(), ".claude-async-jobs", "ops-actions-audit.jsonl");
}

function appendAudit(line, env = process.env) {
  const p = auditLogPath(env);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(line) + "\n"); return null; }
  catch (e) { return e.message; }
}

export async function runAction(argv, env = process.env) {
  const startedAt = new Date().toISOString();
  const base = { ts: startedAt, jobId: env.CLAUDE_ASYNC_JOB_ID || null };
  let args;
  try { args = parseArgs(argv); }
  catch (e) {
    appendAudit({ ...base, action: null, args: argv, dryRun: null, exitCode: e.code, result: "refused", error: e.message }, env);
    return { ok: false, exitCode: e.code, error: e.message };
  }

  // Audit log first, same fail-closed rule as scripts/publish-branch.mjs: refuse to do (or even
  // plan) anything we provably cannot record.
  const auditPath = auditLogPath(env);
  try { fs.mkdirSync(path.dirname(auditPath), { recursive: true }); fs.closeSync(fs.openSync(auditPath, "a")); }
  catch (e) {
    return { ok: false, exitCode: EXIT.AUDIT_FAILED, error: `audit log ${auditPath} is not writable (${e.code || e.message}); refusing to act unaudited` };
  }

  const audit = (extra) => appendAudit({ ...base, action: args.action, args: argv.filter((a) => a !== "--dry-run"), dryRun: args.dryRun, ...extra }, env);

  if (env.CLAUDE_ASYNC_JOB_PROFILE !== "ops") {
    const msg = `ops-actions/run.mjs refuses: CLAUDE_ASYNC_JOB_PROFILE must be "ops" (got ${JSON.stringify(env.CLAUDE_ASYNC_JOB_PROFILE ?? null)})`;
    const auditErr = audit({ exitCode: EXIT.PROFILE_REFUSED, result: "refused", error: msg });
    return { ok: false, exitCode: EXIT.PROFILE_REFUSED, error: msg, ...(auditErr ? { auditError: auditErr } : {}) };
  }

  const build = ACTIONS[args.action];
  if (!build) {
    const msg = `unknown action ${JSON.stringify(args.action)} (known: ${Object.keys(ACTIONS).join(", ")})`;
    const auditErr = audit({ exitCode: EXIT.UNKNOWN_ACTION, result: "refused", error: msg });
    return { ok: false, exitCode: EXIT.UNKNOWN_ACTION, error: msg, ...(auditErr ? { auditError: auditErr } : {}) };
  }

  let steps;
  try { steps = build(); }
  catch (e) {
    const code = e instanceof Refusal ? e.code : EXIT.INTERNAL;
    const auditErr = audit({ exitCode: code, result: "refused", error: e.message });
    return { ok: false, exitCode: code, error: e.message, ...(auditErr ? { auditError: auditErr } : {}) };
  }

  if (args.dryRun) {
    const plan = steps.map((s) => s.describe());
    const auditErr = audit({ exitCode: EXIT.OK, result: "dry-run", steps: plan });
    return { ok: true, exitCode: EXIT.OK, dryRun: true, action: args.action, steps: plan, ...(auditErr ? { auditError: auditErr } : {}) };
  }

  const results = [];
  let failedAt = -1;
  for (let i = 0; i < steps.length; i++) {
    const describe = steps[i].describe();
    try {
      const r = await steps[i].exec();
      results.push({ describe, ...r });
      if (!r.ok) { failedAt = i; break; }
    } catch (e) {
      const code = e instanceof Refusal ? e.code : EXIT.INTERNAL;
      results.push({ describe, ok: false, detail: e.message });
      const auditErr = audit({ exitCode: code, result: "failed", steps: results });
      return { ok: false, exitCode: code, error: e.message, steps: results, ...(auditErr ? { auditError: auditErr } : {}) };
    }
  }
  const ok = failedAt === -1;
  const exitCode = ok ? EXIT.OK : EXIT.STEP_FAILED;
  const auditErr = audit({ exitCode, result: ok ? "ok" : "failed", steps: results });
  return { ok, exitCode, action: args.action, steps: results, ...(auditErr ? { auditError: auditErr } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await runAction(process.argv.slice(2));
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = out.exitCode;
}
