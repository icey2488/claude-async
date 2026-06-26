# claude-async — Operations / Runbook

Operational notes for the claude-async MCP bridge (the detached-job bridge that lets a
Claude session start, poll, and collect background `claude` jobs via `claude_start` /
`claude_check` / `claude_jobs`).

Job state is durable on disk under `JOB_ROOT` (`CLAUDE_ASYNC_JOB_DIR`, default
`~/.claude-async-jobs`), so jobs survive bridge restarts and can be re-attached by `jobId`.

## Restarting the bridge

- **Warm up first.** After restarting the bridge, fire a `claude_jobs` call once as a
  throwaway warmup **before** any `claude_start`. A cold start path can otherwise hang the
  full 4-minute wall on the first call.
- **If `claude_start` still hangs the full 4 minutes after the warmup**, the previous bridge
  process is probably still alive and squatting on the start path (a plain relaunch may not
  have killed it). Force-close the old process in Task Manager, then warm up again. The
  warmup clears a cold start path; it does **not** clear a stale process holding it.
- **A job absent from the `claude_jobs` ledger after a restart never started** and is safe to
  re-fire — reusing the same `jobId` is fine.
- **A `claude_start` that hangs the full 4 minutes means the server is unresponsive**, not
  that a job timed out. A healthy bridge returns a `jobId` immediately, and you poll with
  `claude_check`.

## Gotchas

- **Use Bash for `npm`/`git`, not the PowerShell `npm` wrapper** — the wrapper misbehaves.
- **Keep job prompts modest.** Very large prompts (roughly >8–32 KB) passed as a CLI arg can
  cause `spawn ENAMETOOLONG` (exit 127). Pass large content via files instead of inline in
  the prompt.

## Effort levels

- `claude_start` accepts an `effort` param: `low | medium | high | xhigh | max | ultracode`.
  The default is `xhigh` (override the default via the `CLAUDE_ASYNC_DEFAULT_EFFORT` env var).
- `max` = highest reasoning effort.
- `ultracode` = xhigh effort **plus** standing dynamic-workflow orchestration (parallel
  subagents). The bridge wires it via both `--effort xhigh` **and**
  `--settings '{"ultracode":true}'`: the `--effort xhigh` is now passed explicitly, so
  `ultracode`'s xhigh reasoning is guaranteed regardless of the ambient `effortLevel`
  (it previously relied on `settings.json` to govern effort). (See the effort routing in
  `job-core.mjs`.)
- The resolved effort level is recorded in each job's `meta.json` and shown by `claude_check`.
