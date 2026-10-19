// Unit tests for hooks/no-background-hook.mjs: feeds crafted PreToolUse hook stdin JSON straight
// to the script (the same way the claude CLI invokes it, per the real contract captured live
// against claude.exe 2.1.303 on 2026-10-19 -- see that script's own header) and asserts the
// allow/deny decision and exit code. Run: node --test test/no-background-hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "no-background-hook.mjs");

function runHook(stdin) {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8",
    timeout: 5000,
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* left null for malformed-output assertions */ }
  return { status: res.status, stdout: res.stdout, parsed };
}

function assertDenied(stdin) {
  const { status, parsed } = runHook(stdin);
  assert.equal(status, 2, `expected exit 2 (deny), got ${status}; stdout=${JSON.stringify(parsed)}`);
  assert.ok(parsed, "deny response must be valid JSON");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(typeof parsed.hookSpecificOutput.permissionDecisionReason, "string");
  assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length > 0);
}

function assertAllowed(stdin) {
  const { status, parsed } = runHook(stdin);
  assert.equal(status, 0, `expected exit 0 (allow), got ${status}; stdout=${JSON.stringify(parsed)}`);
  assert.ok(parsed, "allow response must be valid JSON");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
}

// --- Bash / PowerShell: foreground is the default, run_in_background:true is denied ---

for (const toolName of ["Bash", "PowerShell"]) {
  test(`${toolName}: run_in_background omitted -> allow`, () => {
    assertAllowed({ tool_name: toolName, tool_input: { command: "echo hi" } });
  });

  test(`${toolName}: run_in_background:false -> allow`, () => {
    assertAllowed({ tool_name: toolName, tool_input: { command: "echo hi", run_in_background: false } });
  });

  test(`${toolName}: run_in_background:true -> deny`, () => {
    assertDenied({ tool_name: toolName, tool_input: { command: "echo hi", run_in_background: true } });
  });
}

// --- Agent / Task: background is the DEFAULT (confirmed live), only explicit false is foreground ---

for (const toolName of ["Agent", "Task"]) {
  test(`${toolName}: run_in_background omitted -> deny (defaults to background)`, () => {
    assertDenied({ tool_name: toolName, tool_input: { prompt: "do something", subagent_type: "general-purpose" } });
  });

  test(`${toolName}: run_in_background:true -> deny`, () => {
    assertDenied({ tool_name: toolName, tool_input: { prompt: "do something", run_in_background: true } });
  });

  test(`${toolName}: run_in_background:false -> allow`, () => {
    assertAllowed({ tool_name: toolName, tool_input: { prompt: "do something", run_in_background: false } });
  });
}

// --- Monitor: always a background mechanism, no foreground escape hatch ---

test("Monitor: always denied, even with no background-ish field at all", () => {
  assertDenied({ tool_name: "Monitor", tool_input: { command: "tail -f x.log", description: "watch x" } });
});

test("Monitor: denied even if caller tries run_in_background:false", () => {
  assertDenied({ tool_name: "Monitor", tool_input: { command: "tail -f x.log", description: "watch x", run_in_background: false } });
});

// --- Tools this hook doesn't police: allowed regardless of shape ---

test("unrelated tool (Read) -> allow", () => {
  assertAllowed({ tool_name: "Read", tool_input: { file_path: "C:/x" } });
});

test("unrelated tool (Workflow) -> allow (sanctioned background mechanism, out of scope)", () => {
  assertAllowed({ tool_name: "Workflow", tool_input: { script: "export const meta = {}" } });
});

// --- Fail closed: malformed input must never fall through to allow ---

test("malformed JSON on stdin -> deny", () => {
  assertDenied("not json at all {{{");
});

test("empty stdin -> deny", () => {
  assertDenied("");
});

test("missing tool_name -> deny", () => {
  assertDenied({ tool_input: { run_in_background: true } });
});

test("missing tool_input -> deny", () => {
  assertDenied({ tool_name: "Bash" });
});

test("tool_input is not an object -> deny", () => {
  assertDenied({ tool_name: "Bash", tool_input: "not-an-object" });
});

test("tool_input is null -> deny", () => {
  assertDenied({ tool_name: "Bash", tool_input: null });
});

test("tool_name is not a string -> deny", () => {
  assertDenied({ tool_name: 42, tool_input: {} });
});
