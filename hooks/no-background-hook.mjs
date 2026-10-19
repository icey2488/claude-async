#!/usr/bin/env node
/**
 * no-background-hook.mjs — PreToolUse hook enforcing "claude-async jobs never background work"
 * (CLAUDE.md, 2026-10-18) mechanically instead of relying on the prompt-level rule, which two
 * jobs ignored on 2026-10-19 (an Agent launched with run_in_background, and a backgrounded shell
 * `find` later killed at its time limit).
 *
 * Wired into the --settings object job-core.mjs builds for claude-async job launches (see
 * buildNoBackgroundHookSettings() there) -- never into Erick's interactive ~/.claude/settings.json
 * -- via a CATCH-ALL matcher ("*", empirically confirmed on this machine's claude.exe 2.1.303 on
 * 2026-10-19 to invoke this hook for every tool call, including Read/Glob which carry no
 * background-capable fields at all; proven by probing with a wildcard-matched logging hook, not
 * assumed from docs). The old matcher hardcoded a tool-name list (Bash|PowerShell|Agent|Task|
 * Monitor), which meant a renamed or newly-added background-capable tool would silently bypass
 * the hook entirely -- unmatched tool calls never reach this script, so that failure mode is NOT
 * fail-closed, it's just invisible. The catch-all matcher moves every tool-specific decision into
 * this script instead, where "I don't recognize this tool" safely falls through to "allow" for
 * ordinary tools while the explicit `run_in_background === true` check below still catches ANY
 * tool -- known or not -- that sets it.
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
 * Decision order (first match wins -- see decide() below):
 *   1. tool_input.run_in_background === true, on ANY tool (known or not): deny. This is the
 *      catch-all's whole point -- a future tool with a run_in_background flag is covered without
 *      this script needing to know its name.
 *   2. Known always-background tools (ALWAYS_BACKGROUND_TOOLS, currently just Monitor): deny
 *      unconditionally, regardless of tool_input shape -- there is no foreground mode to opt into.
 *   3. The Workflow tool: gated by job effort, NOT by run_in_background (it has no such field --
 *      it always runs in the background by design, returning a task id immediately). Allowed only
 *      when the launching job's effort is "ultracode" (CLAUDE_ASYNC_JOB_EFFORT env var, set by
 *      job-core.mjs's startJob() into the launched CLI's environment and inherited by this hook
 *      subprocess -- empirically confirmed on 2026-10-19 that env vars set on the claude CLI's own
 *      spawn() env propagate down to hook subprocesses the CLI spawns). Every other effort level:
 *      deny with a clear message naming the job's actual effort.
 *   4. Known subagent-launcher tools (BACKGROUND_BY_DEFAULT_TOOLS, currently Agent/Task): deny
 *      UNLESS tool_input.run_in_background === false explicitly (confirmed live that these default
 *      to background when the field is omitted -- the inverse of Bash/PowerShell's default).
 *   5. Everything else (including Bash/PowerShell with run_in_background absent/false, and any
 *      tool this script doesn't specifically recognize): allow. Kept cheap on purpose -- no file
 *      I/O beyond stdin, no network, no heavy parsing -- since every tool call in every job now
 *      pays this script's startup cost (measured ~31.6ms/call average over 300 direct invocations
 *      via spawnSync, almost entirely node startup, on this machine on 2026-10-19; see
 *      RUNBOOK.md's benchmark note).
 *
 * Known gap (reduced, not eliminated, by the catch-all matcher): BACKGROUND_BY_DEFAULT_TOOLS and
 * ALWAYS_BACKGROUND_TOOLS are still a maintained list of tool NAMES this script recognizes as
 * having background semantics worth a special rule. The catch-all matcher guarantees this script
 * is invoked for every tool, so a future subagent-launcher tool with a `run_in_background` field
 * is still caught by rule 1 if it ever sets that field to `true` -- but if such a tool defaults to
 * background when the field is OMITTED (like Agent/Task do today) and this list hasn't been
 * updated to include it, an omitted-field call from that tool falls through to rule 5's fast
 * allow. That is a judgment call this script cannot make on its own (it would need to know the
 * tool's documented default, not just its name) -- revisit this list when a new subagent-launcher-
 * shaped tool appears. See RUNBOOK.md.
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

const ALWAYS_BACKGROUND_TOOLS = new Set(["Monitor"]);
const BACKGROUND_BY_DEFAULT_TOOLS = new Set(["Agent", "Task"]);
const WORKFLOW_TOOL = "Workflow";
const WORKFLOW_ALLOWED_EFFORT = "ultracode";

function decide(input, jobEffort) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input;
  if (typeof toolName !== "string" || toolInput === null || typeof toolInput !== "object") {
    return ["deny", "no-background-hook: malformed PreToolUse hook input (missing tool_name/tool_input); " +
      "denying to fail closed. Retry the call; if this persists, run the work yourself without this tool."];
  }

  if (toolInput.run_in_background === true) {
    return ["deny", `no-background-hook: claude-async jobs may not run ${toolName} with ` +
      "run_in_background:true. Re-run the same call in the foreground (omit run_in_background, " +
      "or set it to false) and wait for its result before continuing."];
  }

  if (ALWAYS_BACKGROUND_TOOLS.has(toolName)) {
    return ["deny", `no-background-hook: claude-async jobs may not use ${toolName} -- it is inherently a ` +
      "background/unattended mechanism with no foreground mode. Run the underlying command directly " +
      "and synchronously instead."];
  }

  if (toolName === WORKFLOW_TOOL) {
    if (jobEffort === WORKFLOW_ALLOWED_EFFORT) return ["allow"];
    return ["deny", "no-background-hook: the Workflow tool is only permitted for jobs launched with " +
      `effort "${WORKFLOW_ALLOWED_EFFORT}" (this job's effort is ${jobEffort ? JSON.stringify(jobEffort) : "unset"}). ` +
      "Do the work directly, or with Agent (run_in_background:false), instead of Workflow."];
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
  const [decision, reason] = decide(input, process.env.CLAUDE_ASYNC_JOB_EFFORT);
  respond(decision, reason);
} catch (e) {
  respond("deny", `no-background-hook: hook script error (${e && e.message}); denying to fail closed.`);
}
