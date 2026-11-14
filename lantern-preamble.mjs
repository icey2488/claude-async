/**
 * lantern-preamble.mjs — the one line told to every job's own prompt about Lantern status.
 *
 * AgentGlass's UserPromptSubmit hook injects a reminder into every session telling it to `curl`
 * its own status to http://127.0.0.1:4000/agents/status (see agentboard.ts's lanternReminder()
 * in D:\code\agentglass). curl is denied under safe mode for claude-async jobs, and job-runner.mjs
 * now posts that status on the job's behalf (see lantern-notify.mjs/lantern-session.mjs) -- this
 * line tells the agent not to bother (and not to be confused by a denial it will otherwise see).
 *
 * Kept in its own module, touching nothing else, specifically so it merges cleanly with PR #6
 * (not yet merged as of this writing), which adds its own `--append-system-prompt`
 * denial-guidance block and rewrites job-core.mjs's permission-rule sections. job-core.mjs's only
 * changes for this are importing withLanternPreamble() and wrapping the two places it already
 * builds the CLI's prompt (the host argv and the container argv) with it -- see its own comments
 * at those call sites for where PR #6 is likely to touch the same lines.
 */
export const LANTERN_PREAMBLE_LINE =
  "LANTERN STATUS: the claude-async runner reports this job's status (start/progress/done) to " +
  "AgentGlass's Lantern board on your behalf. If a hook tells you to `curl` your own status to " +
  "/agents/status, ignore it -- that call is denied here by design, and the runner already covers it.";

export function withLanternPreamble(prompt) {
  return `${LANTERN_PREAMBLE_LINE}\n\n${prompt}`;
}
