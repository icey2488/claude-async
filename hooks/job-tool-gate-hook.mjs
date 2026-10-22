#!/usr/bin/env node
/**
 * job-tool-gate-hook.mjs — PreToolUse hook that routes a claude-async job's Claude Code tool
 * calls through claunker-hermes's classifier/dispatcher (hermes_cli.claude_code_gate), so an
 * unattended `claude -p` job gets the same tiered review surface the live chassis's own tool
 * calls get instead of running entirely outside it. See
 * D:\code\reviews\job-tool-gate-design-20261020.md for the full design and rollout plan.
 *
 * DEFAULT OFF: only wired into a job's --settings when CLAUDE_ASYNC_JOB_TOOL_GATE=1 is passed to
 * startJob() (job-core.mjs's buildJobToolGateHookSettings(), ADDITIVE to and independent of
 * buildNoBackgroundHookSettings() -- both hooks run; this one never replaces the background-work
 * hook). This script itself does not re-check that flag; if it is invoked at all, the launching
 * job already opted in by having it wired into --settings.
 *
 * Fail-closed, same discipline as no-background-hook.mjs: any error resolving the gate repo/
 * module, any failure to spawn the subprocess, a timeout, a signal, an unexpected exit code, or
 * unparseable/invalid stdout, is a deny. The Python side (hermes_cli/claude_code_gate_cli.py) is
 * ALSO independently fail-closed on its own malformed input or internal errors -- this script
 * does not trust its exit code alone; it validates the JSON shape before honoring an "allow".
 *
 * Wire contract with the Python entry point (mirrors no-background-hook.mjs's own PreToolUse
 * contract, since claude.exe expects the same shape from every PreToolUse hook):
 *   stdin:  {"tool_name": <str>, "tool_input": <object>, "cwd"?: <str>}
 *   stdout: {"hookSpecificOutput": {"hookEventName": "PreToolUse",
 *            "permissionDecision": "allow"|"deny", "permissionDecisionReason"?: <str>}}
 *   exit:   0 on allow, 2 on deny -- any other code is treated as a gate failure (deny), not as
 *           "exit 0 wins regardless of stdout": the Python side promises 0-or-2 and nothing else,
 *           so a different code means the subprocess crashed before it could decide anything.
 *
 * 2026-10-21 fix (D:\code\reviews\safe-perms-finish-20261021.md, hook-"allow" audit): this script
 * used to forward the Python side's "allow" verbatim as an explicit permissionDecision:"allow" on
 * ITS OWN stdout. Per the same rehearsal finding that fixed no-background-hook.mjs (see that
 * file's header and RUNBOOK.md), a PreToolUse hook's explicit "allow" is honored as a real
 * permission grant that bypasses permissions.allow/deny entirely -- so a gate that only CLASSIFIES
 * (Tier 1-4) and was never meant to be the sole authority for every tool call was silently acting
 * as one. This hook now only ever emits "deny" on its own stdout; an "allow" from the Python side
 * is translated to "pass" (print nothing, exit 0 -- no decision, defer to the static
 * permissions.allow/deny floor and any other hook). The Python gate's own internal tiering logic
 * is unchanged; only this script's OUTER translation of "allow" to the claude.exe hook contract
 * changed.
 *
 * Configuration (env vars set on the claude CLI's own spawn() env by job-core.mjs's startJob(),
 * inherited by this hook subprocess the same way CLAUDE_ASYNC_JOB_EFFORT is -- see
 * no-background-hook.mjs's header for why that inheritance is confirmed to work):
 *   CLAUDE_ASYNC_GATE_REPO        path to the claunker-hermes checkout carrying
 *                                 hermes_cli/claude_code_gate_cli.py. REQUIRED -- unset means
 *                                 this hook has nothing to call and denies everything.
 *   CLAUDE_ASYNC_GATE_PYTHON      python executable to run (default: "python")
 *   CLAUDE_ASYNC_GATE_TIMEOUT_MS  subprocess timeout in ms (default: 8000 -- generous for a
 *                                 classifier-only call; still bounded so a hung gate can't hang
 *                                 the whole job)
 *
 * Known gap (prototype scope, see the design doc's known-gaps section): this hook calls the gate
 * SYNCHRONOUSLY on every single tool call via spawnSync, which pays a fresh Python interpreter
 * startup cost (unlike no-background-hook.mjs's ~31.6ms node-only cost) on every call. Acceptable
 * for the classifier-only prototype; a production rollout should consider a persistent gate
 * daemon rather than one subprocess per tool call, if per-call latency matters at scale.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function respond(decision, reason) {
  // "pass" (not an explicit allow): see the 2026-10-21 fix note in this file's header. Must never
  // print an explicit permissionDecision:"allow" on this hook's own behalf.
  if (decision === "pass") { process.exitCode = 0; return; }
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } };
  if (reason) {
    out.hookSpecificOutput.permissionDecisionReason = reason;
    out.systemMessage = reason;
  }
  process.stdout.write(JSON.stringify(out));
  process.exitCode = decision === "deny" ? 2 : 0;
}

const DEFAULT_TIMEOUT_MS = 8000;

function runGate(input, env) {
  const repo = env.CLAUDE_ASYNC_GATE_REPO;
  if (!repo) {
    return ["deny", "job-tool-gate-hook: CLAUDE_ASYNC_GATE_REPO is not set; denying to fail closed " +
      "(this hook is wired in but has no claunker-hermes checkout to call)."];
  }
  const cliModulePath = path.join(repo, "hermes_cli", "claude_code_gate_cli.py");
  if (!fs.existsSync(cliModulePath)) {
    return ["deny", `job-tool-gate-hook: ${cliModulePath} does not exist; denying to fail closed.`];
  }

  const pythonBin = env.CLAUDE_ASYNC_GATE_PYTHON || "python";
  const timeoutMs = Number(env.CLAUDE_ASYNC_GATE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify({ tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd });
  const res = spawnSync(pythonBin, ["-m", "hermes_cli.claude_code_gate_cli"], {
    input: payload, encoding: "utf8", timeout: timeoutMs, cwd: repo, env,
  });

  if (res.error) {
    return ["deny", `job-tool-gate-hook: gate subprocess failed to start (${res.error.message}); denying to fail closed.`];
  }
  if (res.signal) {
    return ["deny", `job-tool-gate-hook: gate subprocess was killed (signal ${res.signal}, likely timeout); denying to fail closed.`];
  }
  if (res.status !== 0 && res.status !== 2) {
    return ["deny", `job-tool-gate-hook: gate subprocess exited ${res.status} (expected 0 or 2); denying to fail closed. ` +
      `stderr: ${(res.stderr || "").slice(0, 500)}`];
  }

  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* left null */ }
  const decision = parsed?.hookSpecificOutput?.permissionDecision;
  if (decision !== "allow" && decision !== "deny") {
    return ["deny", "job-tool-gate-hook: gate subprocess produced unparseable/invalid output; denying to fail closed. " +
      `stdout: ${(res.stdout || "").slice(0, 500)}`];
  }
  return [decision, parsed.hookSpecificOutput.permissionDecisionReason];
}

try {
  const raw = fs.readFileSync(0, "utf8");
  const input = JSON.parse(raw);
  if (typeof input.tool_name !== "string" || input.tool_input === null || typeof input.tool_input !== "object") {
    respond("deny", "job-tool-gate-hook: malformed PreToolUse hook input (missing tool_name/tool_input); " +
      "denying to fail closed.");
  } else {
    const [decision, reason] = runGate(input, process.env);
    // Translate the gate's "allow" to "pass" here, at the very last step, so runGate()'s own
    // fail-closed validation above (exactly "allow" or "deny" from the subprocess, nothing else)
    // stays unchanged and easy to reason about -- only this outer translation to the claude.exe
    // hook contract changed. See respond()'s and this file's header comment for why.
    respond(decision === "allow" ? "pass" : decision, reason);
  }
} catch (e) {
  respond("deny", `job-tool-gate-hook: hook script error (${e && e.message}); denying to fail closed.`);
}
