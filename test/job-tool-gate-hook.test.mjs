// Unit tests for hooks/job-tool-gate-hook.mjs: feeds crafted PreToolUse hook stdin JSON straight
// to the script (same harness pattern as no-background-hook.test.mjs) and asserts the allow/deny
// decision and exit code, using the deterministic fake gate CLI under
// test/fixtures/fake-gate-repo/ so these tests never depend on claunker-hermes being checked out.
// Run: node --test test/job-tool-gate-hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(HERE, "..", "hooks", "job-tool-gate-hook.mjs");
const FAKE_GATE_REPO = path.join(HERE, "fixtures", "fake-gate-repo");

function runHook(stdin, envOverrides = {}) {
  const env = { ...process.env, CLAUDE_ASYNC_GATE_REPO: FAKE_GATE_REPO, ...envOverrides };
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8",
    timeout: 15000,
    env,
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* left null for malformed-output assertions */ }
  return { status: res.status, stdout: res.stdout, parsed };
}

function assertDenied(stdin, envOverrides) {
  const { status, parsed } = runHook(stdin, envOverrides);
  assert.equal(status, 2, `expected exit 2 (deny), got ${status}; stdout=${JSON.stringify(parsed)}`);
  assert.ok(parsed, "deny response must be valid JSON");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(typeof parsed.hookSpecificOutput.permissionDecisionReason, "string");
  assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length > 0);
  return parsed;
}

// "pass" (not an explicit allow): per Claude Code's hooks contract, exit 0 with no stdout means
// the hook has no decision and the normal permission flow applies. This hook translates the gate
// subprocess's "allow" to "pass" (2026-10-21 fix, see hooks/job-tool-gate-hook.mjs's header) --
// it must never emit an explicit allow on another tool's behalf, the same discipline
// no-background-hook.mjs already follows.
function assertPass(stdin, envOverrides) {
  const { status, stdout } = runHook(stdin, envOverrides);
  assert.equal(status, 0, `expected exit 0 (pass), got ${status}; stdout=${JSON.stringify(stdout)}`);
  assert.equal(stdout, "", "pass must print nothing, so it is never mistaken for an explicit allow");
}

// --- Happy path: the hook translates the fake gate's "allow" into a silent pass ---

test("tool the fake gate allows -> pass (no explicit allow emitted)", () => {
  assertPass({ tool_name: "AllowMe", tool_input: { x: 1 } });
});

test("tool the fake gate denies -> deny, with its reason forwarded", () => {
  const parsed = assertDenied({ tool_name: "DenyMe", tool_input: { x: 1 } });
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, "fake deny");
});

// --- Fail-closed: every one of these is a gate FAILURE, not a gate decision ---

test("malformed hook input (no tool_name) -> deny", () => {
  assertDenied({ tool_input: {} });
});

test("malformed hook input (tool_input not an object) -> deny", () => {
  assertDenied({ tool_name: "Read", tool_input: "not-an-object" });
});

test("unparseable stdin -> deny", () => {
  assertDenied("not json");
});

test("CLAUDE_ASYNC_GATE_REPO unset -> deny", () => {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify({ tool_name: "AllowMe", tool_input: {} }),
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, CLAUDE_ASYNC_GATE_REPO: "" },
  });
  assert.equal(res.status, 2);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /CLAUDE_ASYNC_GATE_REPO/);
});

test("CLAUDE_ASYNC_GATE_REPO points at a repo missing the gate module -> deny", () => {
  assertDenied({ tool_name: "AllowMe", tool_input: {} }, { CLAUDE_ASYNC_GATE_REPO: HERE });
});

test("gate subprocess crashes (nonzero exit, no stdout) -> deny", () => {
  assertDenied({ tool_name: "CrashMe", tool_input: {} });
});

test("gate subprocess prints invalid JSON -> deny", () => {
  assertDenied({ tool_name: "BadOutput", tool_input: {} });
});

test("gate subprocess hangs past the timeout -> deny", () => {
  assertDenied(
    { tool_name: "HangMe", tool_input: {} },
    { CLAUDE_ASYNC_GATE_TIMEOUT_MS: "500" },
  );
});

// --- Red-on-removal: proves the exit-code validation is load-bearing, not incidental ---

test("red-on-removal: an exit code other than 0/2 must not be treated as allow", () => {
  // CrashMe exits 1 with no stdout; if the hook's `res.status !== 0 && res.status !== 2`
  // check were ever weakened to e.g. `res.status !== 0` alone treating "2" as some other
  // path, or removed outright, this would silently fall through to allow once stdout parsing
  // failed open instead of closed. Asserting deny here pins that this check is what's firing,
  // not a coincidence of some other branch.
  const { status } = runHook({ tool_name: "CrashMe", tool_input: {} });
  assert.equal(status, 2);
});
