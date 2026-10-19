#!/usr/bin/env node
/**
 * no-background-hook.mjs — PreToolUse hook enforcing "claude-async jobs never background work"
 * (CLAUDE.md, 2026-10-18) mechanically instead of relying on the prompt-level rule, which two
 * jobs ignored on 2026-10-19 (an Agent launched with run_in_background, and a backgrounded shell
 * `find` later killed at its time limit).
 *
 * Wired ONLY into the --settings object job-core.mjs builds for claude-async job launches (see
 * buildNoBackgroundHookSettings() there) -- never into Erick's interactive ~/.claude/settings.json
 * -- via a matcher scoped to the tool names that can run work outside the current turn:
 * Bash, PowerShell, Agent, Task, Monitor. Everything else is unmatched and never invokes this
 * script at all.
 *
 * Contract (empirically verified against this machine's claude.exe 2.1.303 on 2026-10-19 --
 * public Claude Code docs describe a similar but not necessarily identical contract, since this
 * build carries tools, e.g. Agent "fork"/Workflow, that aren't in the public product):
 *   stdin:  JSON with at least tool_name (string) and tool_input (object).
 *   allow:  print {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
 *           to stdout, exit 0.
 *   deny:   print {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 *           "permissionDecisionReason":<reason>},"systemMessage":<reason>} to stdout AND exit 2
 *           (belt-and-suspenders: exit 2 is also the older "stderr fed back to Claude, call
 *           blocked" protocol, so a client honoring only exit code still blocks).
 *
 * Fail closed: any exception (malformed JSON, unreadable stdin, unexpected shape) hits the catch
 * below and denies -- it never falls through to an implicit allow.
 *
 * Tool-specific defaults (verified empirically, not assumed from docs):
 *   - Bash / PowerShell: tool_input.run_in_background absent or false => foreground, allowed.
 *     === true => background, denied.
 *   - Agent / Task: tool_input.run_in_background ABSENT defaults to BACKGROUND (confirmed via a
 *     live probe on 2026-10-19: omitting the field still launched the subagent asynchronously).
 *     So this is the inverse of Bash's default -- only an explicit `false` is allowed.
 *   - Monitor: inherently a background mechanism (starts an unattended long-running watch with no
 *     foreground mode at all) -- always denied for job sessions, regardless of tool_input.
 *
 * Deliberately NOT matched/denied: the Workflow tool. It always runs in the background by
 * design (it returns a task id immediately), but it is a separate, sanctioned, explicitly opt-in
 * mechanism (job-core.mjs's own `effort: "ultracode"` path turns it on via
 * --settings '{"ultracode":true}') -- not the ad hoc "hand off and forget" pattern this hook
 * exists to stop. See RUNBOOK.md for the reasoning and how to revisit it.
 */
import fs from "node:fs";

function respond(decision, reason) {
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } };
  if (reason) {
    out.hookSpecificOutput.permissionDecisionReason = reason;
    out.systemMessage = reason;
  }
  process.stdout.write(JSON.stringify(out));
  process.exitCode = decision === "deny" ? 2 : 0;
}

const FOREGROUND_FLAG_TOOLS = new Set(["Bash", "PowerShell"]);
const BACKGROUND_BY_DEFAULT_TOOLS = new Set(["Agent", "Task"]);
const ALWAYS_BACKGROUND_TOOLS = new Set(["Monitor"]);

function decide(input) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input;
  if (typeof toolName !== "string" || toolInput === null || typeof toolInput !== "object") {
    return ["deny", "no-background-hook: malformed PreToolUse hook input (missing tool_name/tool_input); " +
      "denying to fail closed. Retry the call; if this persists, run the work yourself without this tool."];
  }

  if (ALWAYS_BACKGROUND_TOOLS.has(toolName)) {
    return ["deny", `no-background-hook: claude-async jobs may not use ${toolName} -- it is inherently a ` +
      "background/unattended mechanism with no foreground mode. Run the underlying command directly " +
      "and synchronously instead."];
  }

  if (FOREGROUND_FLAG_TOOLS.has(toolName)) {
    if (toolInput.run_in_background === true) {
      return ["deny", `no-background-hook: claude-async jobs may not run ${toolName} with ` +
        "run_in_background:true. Re-run the same command in the foreground (omit run_in_background, " +
        "or set it to false) and wait for its result before continuing."];
    }
    return ["allow"];
  }

  if (BACKGROUND_BY_DEFAULT_TOOLS.has(toolName)) {
    // This tool defaults to background when the field is omitted (verified live, see header) --
    // so only an explicit `false` is foreground, unlike Bash/PowerShell above.
    if (toolInput.run_in_background !== false) {
      return ["deny", `no-background-hook: claude-async jobs may not launch background ${toolName} calls. ` +
        "Pass run_in_background:false and wait for the result in this same turn before continuing."];
    }
    return ["allow"];
  }

  return ["allow"];
}

try {
  const raw = fs.readFileSync(0, "utf8");
  const input = JSON.parse(raw);
  const [decision, reason] = decide(input);
  respond(decision, reason);
} catch (e) {
  respond("deny", `no-background-hook: hook script error (${e && e.message}); denying to fail closed.`);
}
