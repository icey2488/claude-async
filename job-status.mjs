/**
 * job-status.mjs — the exit-code + exit.json classification shared by job-core.mjs's
 * checkJob() and card-hook.mjs's closeCard(). One rule, two callers: job-core needs it for
 * claude_check's `status` field, card-hook needs the identical rule so a card's done/fail
 * disposition can never disagree with what claude_check reports for the same run.
 *
 * Deliberately NOT the full checkJob() state machine (running/died/timed_out have no meaning
 * once an exit code exists) — just the three outcomes a finished process can have.
 */

// Failed takes precedence over incomplete: a run that never wrote its final-report marker AND
// was killed by the CLI's own background-task wait ceiling is "failed", not "incomplete" --
// bg_tasks_terminated already means something went wrong beyond a merely-missing report.
export function classifyFinalStatus(exitCode, exitRecord) {
  if (exitCode === 0 && exitRecord?.exitReason !== "bg_tasks_terminated") {
    return exitRecord?.reportComplete === false ? "incomplete" : "completed";
  }
  return "failed";
}
