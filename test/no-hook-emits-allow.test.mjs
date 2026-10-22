// Cross-hook audit (D:\code\reviews\safe-perms-finish-20261021.md, task 2): scans every PreToolUse
// hook claude-async wires into a job's --settings (hooks/*.mjs) across a battery of representative
// inputs and asserts NONE of them ever print an explicit permissionDecision:"allow" on their own
// stdout, regardless of flags/env. This is a structural, repo-wide guard on top of each hook's own
// unit tests (no-background-hook.test.mjs, job-tool-gate-hook.test.mjs, ollama-guard-hook.test.mjs)
// -- it exists so a FUTURE hook added under hooks/ is caught by the same rule automatically,
// without anyone having to remember to add it to a hand-maintained list.
//
// Why this matters: a PreToolUse hook's explicit "allow" is honored by claude.exe as a real
// permission grant that bypasses permissions.allow/deny entirely (confirmed live in the
// 2026-10-21 safe-permissions rehearsal -- see no-background-hook.mjs's header). A hook may only
// ever deny or pass (print nothing); "allow" belongs to the static permissions.allow floor alone.
// Run: node --test test/no-hook-emits-allow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.join(HERE, "..", "hooks");
const FAKE_GATE_REPO = path.join(HERE, "fixtures", "fake-gate-repo");

const hookScripts = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".mjs")).sort();

// A deliberately wide battery: ordinary tools, the specific shapes each existing hook is known to
// branch on (background flags, Workflow effort, Ollama-shaped commands), and malformed input. Not
// exhaustive of every hook's internal logic (that's what the per-hook unit test files are for) --
// wide enough that any hook which EVER has an "allow" code path will hit it here.
const BATTERY = [
  { tool_name: "Read", tool_input: { file_path: "x" } },
  { tool_name: "Bash", tool_input: { command: "git status" } },
  { tool_name: "Bash", tool_input: { command: "echo hi", run_in_background: true } },
  { tool_name: "Bash", tool_input: { command: "echo hi", run_in_background: false } },
  { tool_name: "PowerShell", tool_input: { command: "Get-ChildItem" } },
  { tool_name: "Agent", tool_input: { description: "x" } },
  { tool_name: "Agent", tool_input: { description: "x", run_in_background: false } },
  { tool_name: "Monitor", tool_input: {} },
  { tool_name: "Workflow", tool_input: { script: "x" } },
  { tool_name: "Bash", tool_input: { command: "curl http://127.0.0.1:11434/api/generate -d x" } },
  { tool_name: "Bash", tool_input: { command: "ollama run qwen2.5-coder:7b hi" } },
  { tool_name: "AllowMe", tool_input: { x: 1 } }, // job-tool-gate-hook's fake-gate "always allow" tool
  { tool_name: "AnythingElse", tool_input: {} },
  "not json",
  { tool_input: {} }, // missing tool_name
];

function runHook(scriptPath, stdin, env) {
  const res = spawnSync(process.execPath, [scriptPath], {
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8",
    timeout: 15000,
    env: env || process.env,
    cwd: path.join(HERE, ".."),
  });
  return res;
}

function assertNeverAllow(scriptName, res, inputDesc) {
  const stdout = res.stdout || "";
  assert.ok(
    !stdout.includes('"permissionDecision":"allow"') && !stdout.includes('"permissionDecision": "allow"'),
    `${scriptName} emitted an explicit permissionDecision:"allow" for input ${inputDesc} -- ` +
    `stdout=${JSON.stringify(stdout)}`,
  );
  // A hook that grants allow is specifically exit 0 + non-empty stdout carrying "allow"; this
  // second assertion is the mirror check -- a "pass" (exit 0) must carry NO decision at all once
  // the string check above already ruled out "allow" specifically. Not asserted here beyond the
  // string check, since some hooks (deny) legitimately print non-"allow" JSON on exit 2.
}

test("every hook script exists under hooks/ and the battery covers at least no-background-hook, job-tool-gate-hook, ollama-guard-hook", () => {
  assert.ok(hookScripts.includes("no-background-hook.mjs"));
  assert.ok(hookScripts.includes("job-tool-gate-hook.mjs"));
  assert.ok(hookScripts.includes("ollama-guard-hook.mjs"));
});

for (const script of hookScripts) {
  const scriptPath = path.join(HOOKS_DIR, script);
  for (const [i, input] of BATTERY.entries()) {
    test(`${script}: battery[${i}] (${typeof input === "string" ? input : JSON.stringify(input)}) never emits an explicit allow`, () => {
      const env = { ...process.env, CLAUDE_ASYNC_GATE_REPO: FAKE_GATE_REPO, CLAUDE_ASYNC_JOB_EFFORT: "medium" };
      const res = runHook(scriptPath, input, env);
      assertNeverAllow(script, res, typeof input === "string" ? input : JSON.stringify(input));
    });
  }
}

// --- The task's specific repro: job-tool-gate-hook, CLAUDE_ASYNC_JOB_TOOL_GATE on, a tier-1 (low)
//     tool call (the fake gate's "AllowMe" tool stands in for a classifier-tiered allow) ---

test("job-tool-gate-hook with CLAUDE_ASYNC_JOB_TOOL_GATE=1, tier-1 (gate-allowed) tool call -> no explicit allow", () => {
  const scriptPath = path.join(HOOKS_DIR, "job-tool-gate-hook.mjs");
  const env = {
    ...process.env,
    CLAUDE_ASYNC_JOB_TOOL_GATE: "1",
    CLAUDE_ASYNC_GATE_REPO: FAKE_GATE_REPO,
  };
  const res = runHook(scriptPath, { tool_name: "AllowMe", tool_input: { command: "git status" } }, env);
  assert.equal(res.status, 0, `expected exit 0 (pass), got ${res.status}; stdout=${JSON.stringify(res.stdout)}`);
  assert.equal(res.stdout, "", "a tier-1/gate-allowed call must produce a silent pass, never an explicit allow");
});
