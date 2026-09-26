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

## Multi-host dispatch (`feat/multihost`)

Design and config are in README's "Multi-host" section. Operational notes:

- **Before restarting a bridge that runs this code, create `~/.claude-async/hosts.json`**
  (`{"localHost": "claunker"}` on Claunker, `{"localHost": "laptop", "hosts": {"claunker": {...}}}`
  on the laptop). Without it every `claude_start` refuses with an error naming the file
  (un-prefixed `claude_check` keeps working).
- **Every `claude_start` now needs `host`.** Callers or prompts that omit it fail schema validation
  on purpose.
- **Caps are per executing host** (4 running / 6 starts per minute by default): 4 or more
  still-running jobs (including `stalled`) block the 5th start. Raise them via `hosts.json` `caps`, not by retrying.
- **Host API live test** (Claunker, Tailscale up): `node host-api.mjs --new-token`, then
  `node host-api.mjs`. It prints `listening on http://100.x.y.z:7850` or refuses with the reason.
  Before merge, run it from a non-live checkout **only with
  `CLAUDE_ASYNC_WIN32_LAUNCH_MODE=breakaway`** (see the next point).

**Test hazards discovered while building this (2026-09-25):**

- **Any `startJob()` from a checkout other than the live one re-registers `ClaudeAsyncRunner`.**
  `ensureLauncherTask()` treats a different `job-launcher.mjs` path as "drift" and repoints the
  live task at that checkout. `test-card-hook.mjs` and `--selftest` go through that path by
  default. From a worktree or scratch copy, run them with `CLAUDE_ASYNC_WIN32_LAUNCH_MODE=breakaway`
  (and a temp `USERPROFILE` so the launcher queue is a temp dir). `test/survival.mjs` exercises
  the task path deliberately, so run it only from the live checkout. `test/multihost/*` never
  reaches `launch()` (it injects a fake that writes the real ticket into a temp queue).
- **Never export `GIT_DIR` around the test suites.** `test-card-hook.mjs` runs `git init` /
  `git config user.*` / `git commit` in a temp dir. With `GIT_DIR` set, those hit the real repo:
  `core.bare` flips to `true`, `[user]` is overwritten, and junk commits land on the checked-out branch.
- **Smart App Control can block `test/dummy-*.exe`.** The build scripts recompile them on every
  run, and some fresh unsigned compiles are blocked by hash ("An Application Control policy has
  blocked this file", CodeIntegrity event 3077). Then `pathext-integrity` / `env-integrity` /
  `pid-heal` fail with `spawn UNKNOWN`. That is the environment, not the code: re-run with a
  known-allowed binary.

## Dispatch defaults (model + effort)

- `claude_start` accepts a `model` param (any `--model` value, e.g. `claude-opus-4-8` /
  `claude-sonnet-5`). The default is `claude-sonnet-5` (override via the
  `CLAUDE_ASYNC_DEFAULT_MODEL` env var). This is deliberately the cheapest/fastest broadly-capable
  tier — an unspecified `model` used to inherit the `claude` CLI's own default (Fable), which
  combined with the old xhigh effort default absorbed 99.6% of dispatch spend on 2026-07-23.
  Explicit `model` always overrides the default.

## Effort levels

- `claude_start` accepts an `effort` param: `low | medium | high | xhigh | max | ultracode`.
  The default is `medium` (override the default via the `CLAUDE_ASYNC_DEFAULT_EFFORT` env var).
- `max` = highest reasoning effort.
- `ultracode` = xhigh effort **plus** standing dynamic-workflow orchestration (parallel
  subagents). The bridge wires it via both `--effort xhigh` **and**
  `--settings '{"ultracode":true}'`: the `--effort xhigh` is now passed explicitly, so
  `ultracode`'s xhigh reasoning is guaranteed regardless of the ambient `effortLevel`
  (it previously relied on `settings.json` to govern effort). (See the effort routing in
  `job-core.mjs`.)
- The resolved effort level is recorded in each job's `meta.json` and shown by `claude_check`.

## Field notes — 2026-08 migration

- **Ollama restarts must kill `llama-server.exe` by name.** Killing the parent `ollama.exe`
  process leaves orphaned `llama-server.exe` children running — they survive the parent kill
  and continue holding VRAM, so a "restart" that only stops the parent doesn't free GPU memory.
- **Dispatched jobs may spawn without the user's PATH.** A detached job's environment isn't
  guaranteed to include the interactive shell PATH, so invoke `ollama.exe`, `nvidia-smi`, and
  `setx` by absolute path rather than relying on PATH resolution.
- **The Desktop install on this machine is Squirrel (`%APPDATA%\Claude`), not MSIX.** Prior
  docs assumed MSIX packaging; that assumption is stale for this machine and any install-path
  or update-mechanism logic should check for the Squirrel layout first.
- **Detached jobs cannot answer questions.** A background job has no one to prompt mid-run, so
  every stop-condition needs a pre-decided answer or a hard abort baked in up front — decisions
  can only come back in the *next* dispatch, not mid-job.
- **Models larger than 14B at Q4 CPU-split on the 8GB 4060 Ti.** Anything above that size
  exceeds available VRAM and falls back to partial CPU offload, with the expected throughput hit.
- **An external exe invoked bare in a job shell can fail silently: empty stdout AND an empty
  exit code**, distinct from a normal PATH-less-spawn error. Observed with `python.exe` invoked
  via `&` — both stdout and `$LASTEXITCODE` came back empty, giving no signal that anything went
  wrong. `Start-Process` with `-RedirectStandardOutput`/`-RedirectStandardError` and `-PassThru`
  revealed the real exit code and output. Mitigation: prefer PowerShell cmdlets over external
  exes in dispatched jobs; when an exe must be called, capture via `Start-Process` redirection
  rather than `&`/pipeline capture, and treat empty-output-empty-exit-code as an anomaly to
  retry, never as evidence the call did nothing (card d03c097d).

## Field notes — 2026-09-09 win32 detach investigation (`fix/win32-detach`)

- **`node.exe`'s `detached: true` does not escape the caller's Windows Job Object.** It only
  requests `CREATE_NEW_PROCESS_GROUP`; a plain `spawn(..., {detached:true})` child still
  inherits ambient Job Object membership. Claude Desktop runs this bridge in a job with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set (confirmed via `IsProcessInJob` +
  `QueryInformationJobObject`), so a detached `job-runner.mjs` can die when the bridge does.
  Fixed by shelling out to `win32-breakaway.ps1`, which calls `CreateProcessW` directly with
  `CREATE_BREAKAWAY_FROM_JOB`. See the win32 comment on `launchWin32()` in `job-core.mjs`.
- **A Job Object's own `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` flag can silently mask this bug.**
  On the machine where this was diagnosed, the *actual* live bridge's job already had
  `SILENT_BREAKAWAY_OK` set, so plain `detached: true` children were *already* escaping it
  without any explicit request — verified directly via `IsProcessInJob` against the specific
  job handle (not just "is in a job", but "is in THIS job"). A test built against that exact
  job would pass even without the fix. `test/detach-survival.mjs` deliberately constructs its
  test Job Object with `BREAKAWAY_OK` but *not* `SILENT_BREAKAWAY_OK`, to reproduce the failure
  mode for any ambient job policy that doesn't happen to have silent breakaway on.
- **`CreateProcessW` with `lpCurrentDirectory = NULL` failed unpredictably with
  `ERROR_INVALID_NAME` (123)** in at least one real PowerShell host process during this
  investigation, even though `.NET`'s own `Directory.GetCurrentDirectory()` reported a valid
  path for that same process. Passing an explicit, known-valid directory (`$PSScriptRoot`)
  instead of relying on the null/inherit-from-caller behavior fixed it reliably and is used in
  both `win32-breakaway.ps1` and `test/job-object-harness.ps1`.
- **`child_process.spawn()` cannot run a `.cmd`/`.bat` directly** (no `shell` option): it fails
  with `spawn EINVAL`, since `CreateProcess` can't launch a batch file as a PE image. Hit this
  building the survival test's dummy "claude" stand-in; fixed by compiling a real (trivial)
  `.exe` via `Add-Type -OutputType ConsoleApplication` instead (`test/build-dummy-claude.ps1`).
- **PowerShell's console host silently no-ops when spawned with `detached: true` on Windows.**
  Node's `detached: true` maps to the `DETACHED_PROCESS` creation flag (no console at all, not
  merely hidden); `powershell.exe`'s host appears to need a console to fully initialize, and
  without one it exits 0 without running the `-File` script at all — no error, no output.
  `windowsHide: true` (`STARTF_USESHOWWINDOW`/`SW_HIDE`) does not have this problem, since the
  process still gets a (hidden) console. `job-core.mjs`'s `launchWin32()` spawns the
  `win32-breakaway.ps1` wrapper with `detached: false` for this reason.
- **The breakaway fix above introduced a second bug: Claude Desktop omits `PATHEXT` from this
  bridge's environment entirely, and the new `powershell.exe` hop turns that into a corrupted
  `PATHEXT` for every downstream process.** PowerShell's startup appends `.CPL` to whatever
  `PATHEXT` it inherits; appended to an absent value that's a `PATHEXT` of exactly `.CPL`, which
  then flows unchanged (by design — see `win32-breakaway.ps1`'s `lpEnvironment=NULL` comment)
  through `job-runner.mjs` into the `claude` CLI and any shell its tools invoke, breaking bare
  resolution of `node`/`npm`/`npx`/`cmd`/`tsc` (`'tsc' is not recognized as an internal or
  external command`). The pre-breakaway direct spawn path tolerated the same absent `PATHEXT`
  because `cmd.exe` fills in a sane default when it's missing — the powershell hop is what broke
  the assumption. Fixed by `sanitizeEnvForWin32()` in `job-core.mjs`, which repairs `PATHEXT`
  (missing, empty, or lacking `.EXE`) before both spawns that matter: the `launchWin32()` wrapper
  spawn and `job-runner.mjs`'s spawn of the `claude` CLI. See `test/pathext-integrity.mjs`.
- **The `powershell.exe` hop is not a byte-identical pass-through of the environment it inherits,
  even before `CreateProcessW`/`lpEnvironment=NULL` come into play.** Confirmed empirically
  (`powershell.exe -NoProfile -NonInteractive`, variables stripped from the parent first):
  PowerShell's own startup sets `PSModulePath` if it was absent, and defaults `TEMP` (not `TMP`)
  if absent. `test/env-integrity.mjs` only asserts `PATH`/`PATHEXT`/a sentinel survive intact — it
  does not (and given the above, cannot) claim the full environment block is byte-for-byte
  identical across the win32-breakaway path. See `win32-breakaway.ps1`'s header for detail.
- **A wrapper-fallback `meta.pid` can heal wrong if the poll window races a job dir reused across
  restarts.** `launchWin32Breakaway()`'s `readRunnerPid()` polls `runner.pid` for 2s before
  falling back to the PowerShell wrapper's own (short-lived) pid; `checkJob()`'s `healMetaPid()`
  re-reads `runner.pid` later and adopts it if that pid is alive and looks like ours.
  `launchWin32Breakaway()` deletes any stray `runner.pid` before spawning to keep this from ever
  reading a stale file. See `test/pid-heal.mjs`.

## Field notes — 2026-09-09 Task Scheduler launcher (`fix/win32-detach`, continued)

**Why breakaway alone wasn't enough.** Runners launched through `win32-breakaway.ps1` reported
`breakaway=ok` yet still self-queried as members of a Job Object with `limitFlags 0x3C00`
(`KILL_ON_JOB_CLOSE | BREAKAWAY_OK | SILENT_BREAKAWAY_OK`) — the same flags as Claude Desktop's
job. Multiple runners were hard-terminated in the same second with no exit code. Breakaway only
asks Windows to detach a process from an *existing* job ancestry; it doesn't change the fact that
the runner's ultimate ancestor is still Claude Desktop. The fix instead gives the runner an
ancestor that was never inside Desktop's process tree or job at all: the Windows Task Scheduler
service.

**⚠️ `inJob`/`limitFlags` are NOT reliable evidence of nesting inside a *specific* job.** While
verifying this fix, a completely unrelated `node -e ...` process launched from a plain terminal —
zero relation to Claude Desktop — self-reported `inJob:true, limitFlags:0x3C00,
killOnClose:true` via the exact same self-query mechanism `job-runner.mjs` uses. Windows places
essentially any console-attached process into a default per-console job with those flags,
independent of ancestry. **The `jobMembership`/`runnerJobMembership` fields in `meta.json` /
`claude_check` are diagnostic breadcrumbs, not proof of escape or failure to escape.** The only
reliable test is behavioral: does the runner keep running after the *specific* job/process tree
it descended from is torn down? That's what `test/survival.mjs` does, with three independent kill
mechanisms (process-tree kill, external job-close, self job-close) — trust that over the flags.

**Design: the `ClaudeAsyncRunner` scheduled task.**
- A single, fixed, user-scope, no-elevation scheduled task named `ClaudeAsyncRunner` whose action
  is always `node.exe job-launcher.mjs` — never a per-job command line, because
  registering/reconfiguring a task (`Register-ScheduledTask`) is a slow COM round-trip, too slow
  to pay on every `claude_start`.
- `job-core.mjs`'s `ensureLauncherTask()` checks (`schtasks /Query /TN ClaudeAsyncRunner /FO LIST
  /V`, fast) whether the task exists and its `Task To Run:` line matches the current `node.exe` +
  `job-launcher.mjs` path, and only calls `tools/register-launcher-task.ps1`
  (`Register-ScheduledTask`, slow) when it's missing or stale (e.g. after a Node reinstall or the
  repo moving). Steady state: one fast query per launch, no registration calls.
- `job-core.mjs` writes a work ticket to `<LAUNCHER_QUEUE_DIR>/<jobId>.json` (see below for why
  this is a fixed location, not under the job's own directory) and runs `schtasks /Run /TN
  ClaudeAsyncRunner`. The task's `MultipleInstances Parallel` setting means concurrent
  `claude_start` calls each spawn their own `job-launcher.mjs` instance rather than queuing behind
  one another.
- Each `job-launcher.mjs` instance scans the queue directory and claims **at most one** ticket by
  atomically renaming `<jobId>.json` → `<jobId>.claimed.json` (`fs.renameSync`, atomic on the same
  NTFS volume — a losing instance sees `ENOENT` and moves to the next candidate, or exits 0
  quietly if nothing is left). The winner spawns `job-runner.mjs` detached and writes
  `launched.marker` (pid + timestamp) into the job's own directory.
- `job-core.mjs`'s existing `readRunnerPid()` poll (unchanged mechanism) is what actually confirms
  the runner started — just with a longer timeout on this path (`TASK_RUNNER_PID_POLL_MS`,
  15s, vs 2s for the direct breakaway wrapper spawn) since Task Scheduler scheduling has more hops.

**`LAUNCHER_QUEUE_DIR` is deliberately NOT under `JOB_ROOT`.** `job-launcher.mjs` is started by
the Task Scheduler service with its own fresh environment, not a copy of the bridge process's —
a `CLAUDE_ASYNC_JOB_DIR` override on the bridge would never reach it. `LAUNCHER_QUEUE_DIR`
(`~/.claude-async-launcher-queue`) is computed identically in both processes from nothing but
`os.homedir()`, and each ticket carries the job's real (possibly `JOB_ROOT`-overridden) directory
as an absolute path. Discovered by an early manual test: with a `CLAUDE_ASYNC_JOB_DIR` override
pointed at a temp dir, the task path silently timed out every time until this was fixed, because
`job-launcher.mjs` was scanning the *default* `~/.claude-async-jobs` for a ticket that only ever
existed in the temp dir.

**Logon type: `Interactive`, not `S4U`.** `S4U` (doesn't require the user to be interactively
logged on) was tried first and failed outright on this machine for a non-elevated, non-admin
account: `Register-ScheduledTask` threw "Access is denied", no task created — most likely because
granting/verifying `SeBatchLogonRight` for the account is itself a privileged operation this
unelevated process can't perform. `Interactive` works unelevated and is used instead; it means the
task can only run while that user has an interactive logon session, which is fine here since
Claude Desktop itself is a desktop GUI app and is never running when nobody's logged on anyway.

**Fallback order:** `task` (default) → `breakaway-fallback` (`win32-breakaway.ps1`, used only if
`ensureLauncherTask()` fails, `schtasks /Run` fails, or the runner never appears within
`TASK_RUNNER_PID_POLL_MS`) → (non-win32 only) `spawn`. The chosen path is recorded as
`launchPath` in `meta.json` / `claude_check`. Override via `CLAUDE_ASYNC_WIN32_LAUNCH_MODE=
breakaway` to force the old path directly (used by `test/pid-heal.mjs`, `test/pathext-integrity.mjs`,
and `test/env-integrity.mjs`, which specifically exercise breakaway-only mechanics — the PowerShell
hop's PATHEXT repair and the wrapper-fallback pid path — that the task path never goes through).

**Inspecting/removing the task:**
```powershell
Get-ScheduledTask ClaudeAsyncRunner | Get-ScheduledTaskInfo   # LastTaskResult 0 = healthy
schtasks /Query /TN ClaudeAsyncRunner /FO LIST /V             # human-readable, incl. action path
Get-Content "$env:USERPROFILE\.claude-async-launcher-queue\job-launcher.log" -Tail 50
Unregister-ScheduledTask -TaskName ClaudeAsyncRunner -Confirm:$false   # remove entirely
```
Removing the task doesn't break anything — the next `claude_start` on win32 re-registers it
automatically via `ensureLauncherTask()` (or falls back to `breakaway-fallback` if registration
itself fails, e.g. `register-launcher-task.ps1` missing).

**A stuck/orphaned `<jobId>.claimed.json` with no corresponding `launched.marker`** in the job's
directory means a `job-launcher.mjs` instance claimed the ticket but died before spawning
`job-runner.mjs` (e.g. killed mid-claim). This is rare and currently requires manual cleanup —
delete the stale `.claimed.json` from `LAUNCHER_QUEUE_DIR` and retry `claude_start` with the same
`jobId` if the job never actually started (check for an absent `runner.pid` in the job's directory
to confirm before deleting).

**IMPORTANT: restart the bridge to pick this up.** The running `claude-async` MCP server process
has the pre-Task-Scheduler `job-core.mjs` loaded in memory; it keeps using the old
`win32-breakaway.ps1`-only launch path until Claude Desktop (and this bridge with it) is
restarted. This is true of any `job-core.mjs` change while the bridge is live, per the "Restarting
the bridge" section above.
