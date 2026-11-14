#!/usr/bin/env node
/**
 * PreToolUse guard for Bash and PowerShell commands that mention Ollama.
 * Recognized calls pass silently to the static permissions and other hooks.
 * Unrecognized Ollama commands are denied.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../tools/ollama-generate.mjs";

const helperPath = fileURLToPath(new URL("../tools/ollama-generate.mjs", import.meta.url));
const helperPaths = new Set([helperPath, helperPath.replace(/\\/g, "/")]);

function looksLikeOllamaAttempt(command) {
  return /11434|\bollama\b/i.test(command);
}

// The prefix must name this worktree's helper. Each argument must be a standalone
// literal word or a whole quoted value, with no shell expansion or extra command.
const helperCommand = /^[ \t]*node[ \t]+("[^"]+"|'[^']+'|[^ \t"']+)[ \t]+(.*)$/;
const argument = /(?:'([^'\\]*)'|"([^"\\]*)"|([A-Za-z0-9._:/-]+))(?=[ \t]+|$)/y;

function isSafeHelperCall(command) {
  const match = helperCommand.exec(command);
  if (!match) return false;
  const [, script, argumentsText] = match;
  const scriptPath = /^["']/.test(script) ? script.slice(1, -1) : script;
  if (!helperPaths.has(scriptPath)) return false;

  const args = [];
  let remaining = argumentsText.trimEnd();
  while (remaining) {
    argument.lastIndex = 0;
    const token = argument.exec(remaining);
    if (!token) return false;
    const [, singleQuoted, doubleQuoted, bare] = token;
    if (args.length % 2 === 0 && !bare) return false;
    args.push(singleQuoted ?? doubleQuoted ?? bare);
    remaining = remaining.slice(argument.lastIndex).trimStart();
  }
  return !parseArgs(args).error;
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
  if (typeof command !== "string" || !looksLikeOllamaAttempt(command)) return ["pass"];

  if (!/[\r\n\0\x60$!‘’“”]/u.test(command) &&
      (isSafeHelperCall(command) || /^[ \t]*ollama[ \t]+(?:list|ps)[ \t]*$/i.test(command))) {
    return ["pass"];
  }

  return ["deny", "ollama-guard-hook: use the repository's node tools/ollama-generate.mjs helper " +
    "with literal --model and --prompt values and optional --system and --format values, " +
    "or run ollama list or ollama ps as a standalone command."];
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
  respond("deny", "ollama-guard-hook: hook script error (" + e.message + "); denying to fail closed.");
}
