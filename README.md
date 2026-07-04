# claude-async

MCP bridge for detached Claude Code jobs. Lets a Claude session start, poll, and collect
background `claude` processes via `claude_start` / `claude_check` / `claude_jobs`.

Jobs are durable on disk under `JOB_ROOT` (`CLAUDE_ASYNC_JOB_DIR`, default
`~/.claude-async-jobs`).

See [RUNBOOK.md](RUNBOOK.md) for operational notes.

## Known issues

- **`claude_check` trusts the stored job record.** If the bridge restarts between job
  completion and record close (e.g. a Claude Desktop swap), the record shows `running`
  forever while the detached job has finished and its work landed. Observed 2026-07-04
  (job `kanbantt-remember-token-optin`: commit pushed at 01:52Z, record never closed).
  Fix direction: `claude_check` should re-stat the pid and reap exit state from the job
  directory rather than trusting the record.
