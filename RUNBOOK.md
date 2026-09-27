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
  A start response with a `warnings` entry names a job dir with an unreadable `meta.json` (or one whose
  status check failed) older than 2 minutes (not counted toward the cap); repair or delete that dir. A
  `warnings` entry "meta.json could not be written ... the job IS running" means the job launched but
  `claude_check` will not find it by id; its output is in the job dir. A stray `*.tmp` next to a state file
  is the orphan of a write interrupted before its rename and is safe to delete.
- **Ledger rebuild vs. birthtime.** After a corrupt start ledger, `rebuildStarts` dates each job dir by
  min(birthtime, mtime). On a filesystem without birthtime (`birthtimeMs` 0) it falls back to the dir mtime,
  which a running job's heartbeat keeps fresh, so running jobs read as recent starts and can block new starts
  for up to 60s until the rewritten ledger ages out. Claunker and the laptop are NTFS (birthtime supported).
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
  reaches `launch()` (it injects a fake that writes the real ticket into a temp queue). The one
  exception is `claim.test.mjs`, which runs real `job-launcher.mjs` copies, but only against a temp
  home it verifies first (see "Claim protocol" in the Task Scheduler notes below).
- **Never export `GIT_DIR` around the test suites.** `test-card-hook.mjs` runs `git init` /
  `git config user.*` / `git commit` in a temp dir. With `GIT_DIR` set, those hit the real repo:
  `core.bare` flips to `true`, `[user]` is overwritten, and junk commits land on the checked-out branch.
- **Smart App Control can block `test/dummy-*.exe`.** The build scripts recompile them on every
  run, and some fresh unsigned compiles are blocked by hash ("An Application Control policy has
  blocked this file", CodeIntegrity event 3077). Then `pathext-integrity` / `env-integrity` /
  `pid-heal` fail with `spawn UNKNOWN`. That is the environment, not the code: re-run with a
  known-allowed binary.

## Registry-driven hosts (`feat/receiver-registry`, 2026-09-26)

The host list is no longer hard-coded: `hosts.json` is the registry (schema and examples in README's
"Multi-host"). Operational notes:

- **Upgrade steps for existing machines.** Claunker's `hosts.json` (`{"localHost": "claunker"}`) still validates, but
  it now needs `"receiver": true` before `node host-api.mjs` will start (the API used to be gated on the name
  `claunker`; it is gated on that field now). The laptop's file (`localHost: laptop`, `hosts.claunker`) needs no change.
  A file that fails validation (uppercase or dotted name, a host equal to `localHost`, a bad `url`, an empty `token`, a
  non-boolean `receiver`) makes every `claude_start` refuse with the file and field named; fix the file, no restart needed.
- **A bridge restart IS required to change the `host` enum.** The enum is built from the registry when the bridge
  starts, so a host added to `hosts.json` is rejected client-side until the bridge restarts (follow "Restarting the
  bridge" above, including the warmup). Removing a host needs no restart to be *refused*: routing re-reads the file on
  every call and returns `host "x" is not in <file> (known hosts: ...)`, but the stale enum keeps advertising it until the
  restart. `job-core.mjs` is unchanged; `hosts.mjs`, `dispatch.mjs` and `host-api.mjs` are, so a running receiver also
  needs restarting to pick up the receiver gate.
- **Registry urls must be Tailscale addresses.** A `hosts.<name>.url` host must be an IPv4 literal in 100.64.0.0/10, since a
  receiver only binds a Tailscale address; anything else (hostname, IPv6, loopback, RFC1918, public) fails validation.
  `CLAUDE_ASYNC_ALLOW_ANY_URL=1` skips that range check (not the http/https check) for tests and local development. It is
  not a security control; do not set it in a bridge's environment on a real machine.
- **Renaming a receiver needs its API restarted.** `host-api.mjs` captures `localHost` at startup, so after changing a
  receiver's `localHost`, restart that receiver's API (the bridge's enum note above covers the bridge).
- **The "laptop is not a remote dispatch target" message is gone.** The one-way topology is that the laptop is in nobody's
  registry: on Claunker `host: laptop` is `host "laptop" is not in <file> (known hosts: claunker)`.
- **Job ids with an unknown prefix.** `claude_check` on `<name>.…` where `<name>` is a valid host name but not in the registry is an
  error naming the prefix and the known hosts, not a local lookup. Before this change only `claunker`/`laptop` counted as
  prefixes, so a *legacy* id containing a dot whose first segment is lowercase alphanumerics (e.g. `v1.2-fix`, from when
  startJob allowed `.`) now errors instead of resolving locally. Ids the multihost work minted are unaffected.
- **Adding a receiver:** README "Multi-host" ("Adding a receiver (both sides)"). **Linux receiver:** README "Linux receiver";
  `deploy/claude-async-api.service` is the sample unit (`KillMode=process` so an API restart does not take running jobs
  with it). `--new-token` now prints the target key as `hosts.<this host's localHost>.token`.
- **Tests:** `test/multihost/registry.test.mjs` (schema validation: each bad field is an error naming the file and field,
  and `claude_start` refuses with nothing written), `routing.test.mjs` (three-host registry: `ha` forwards, `laptop` is
  unknown), `mcp.test.mjs` (enum built from a three-name `hosts.json`; a host removed after startup is refused with no
  ticket), `ids.test.mjs`, `api.test.mjs` (receiver gate, an `ha` receiver).

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
- Each `job-launcher.mjs` instance scans the queue directory and claims **at most one** ticket
  (`launcher-claim.mjs`): it exclusive-creates `<jobId>.lock`, renames `<jobId>.json` →
  `<jobId>.claimed.json`, then removes the lock. A losing instance (`EEXIST` on the lock) moves to
  the next candidate, or exits 0 quietly if nothing is left. **The rename alone is not a safe
  claim** — see "Claim protocol" below. The winner spawns `job-runner.mjs` detached and writes
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
`ensureLauncherTask()` fails, the ticket write fails, `schtasks /Run` fails, or the runner never appears within
`TASK_RUNNER_PID_POLL_MS` **and the bridge has first taken its own pending ticket back out of the queue**;
if a launcher already owns the ticket there is no fallback, see "Fallback vs the pending ticket" below) → (non-win32 only) `spawn`. The chosen path is recorded as
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

**Claim protocol (`fix/claim-lock`, 2026-09-26; `launcher-claim.mjs`).**
- **Why a lock.** On Windows two launchers renaming the *same* ticket at nearly the same instant can
  **both succeed** (neither gets `ENOENT`): one job ran twice and another ticket was never claimed.
  Measured on Claunker with 4 aligned processes: the old rename-only claim double-claimed 1,149–1,404
  of 1,800 tickets per 600-round run; three real `job-launcher.mjs` copies double-claimed 64–88 of 360
  tickets per 120 rounds (and left other tickets pending, unclaimed). Exclusive create
  (`fs.openSync(path, "wx")`) let exactly one caller through (0 doubles over 3,000 tight rounds on the
  laptop, 0 over 5,400 tickets here). Rename-to-a-unique-name-then-verify still double-claimed 3–5%
  and must not be used.
- **Sequence.** `openSync(<jobId>.lock, "wx")` (`EEXIST`/any error: skip this ticket) → write
  `{pid, at}` → **read the lock back; it must parse to our pid, otherwise we lost it and skip the ticket
  (nothing is unlinked or renamed)** → `renameSync(<jobId>.json, <jobId>.claimed.json)` → unlink the lock
  **only if it still holds our pid**. The lock is
  **removed as soon as the rename returns**, not kept: the retry recipe below reuses a `jobId`, and a
  leftover lock would block that retry until it aged out. A launcher whose directory listing predates
  another's claim gets the lock, hits `ENOENT` on the rename, and moves on.
- **Only `<jobId>.json` is a ticket.** `*.claimed.json`, `*.lock`, `*.lock.break`, `job-launcher.log`
  and `*.tmp` are ignored by every scan (`isTicketName`).
- **Identity (a lock is only ever unlinked by the pid inside it).** Without this, a launcher suspended
  between creating the lock and writing its pid for over 60 s (VM pause, antivirus) looked like a dead owner:
  a breaker unlinked its lock, a second launcher created its own, and the first launcher's later
  unlink-by-name deleted the second's live lock, so a third could claim the same ticket. Now the read-back
  after the write shows the first launcher it lost (once our pid is written the lock is fresh with a live
  owner, so no breaker touches it), and the release after the rename, the write-failure cleanup and the
  break-marker cleanup all check the file still carries our pid first; otherwise they log
  `no longer ours ... leaving it alone` and leave it. The break marker has the same pre-write empty window
  and the same rule. Consequence: a lock whose pid write failed is empty, so it is left behind (logged) and
  breaks through the normal stale path after 60 s; an empty marker needs the manual delete below. One
  residue remains: the breaker's own check-then-unlink gap (microseconds) would have to coincide with the end
  of a 60 s+ stall of the owner; plain filesystem calls cannot make that step atomic.
- **Tickets are written atomically.** `writeLaunchTicket` uses `writeJsonAtomic` (temp file
  `<jobId>.json.<pid>.<rand>.tmp`, then rename), so a launcher never sees a half-written ticket to claim and
  drop. The temp name ends in `.tmp` and is not a ticket; an orphaned `*.tmp` from a crash is safe to delete.
- **Stale locks.** A launcher killed between creating the lock and the rename strands its ticket
  behind the lock. A lock is broken only if it is **at least 60 s old and its owner pid is dead (or
  unreadable — the owner died between creating and writing the file)**. Breaking first
  exclusive-creates `<jobId>.lock.break`, re-checks staleness while holding it, unlinks the lock, and
  removes the marker, so two launchers that see the same stale lock cannot both take it. Every break
  is logged: `grep "BROKE stale claim lock" job-launcher.log`. Everything else leaves the ticket
  **pending** and logs why: a live owner ("owner pid=N is alive"), a lock under 60 s old, a lock dated
  in the future, or an existing marker.
- **Manual cleanup** (rare; the log line names the file). A `<jobId>.lock` older than a minute whose pid
  was *reused* by an unrelated live process looks alive and is never broken: check
  `Get-Process -Id <pid>` in the lock's JSON, and if it is not a `node` running `job-launcher.mjs`,
  delete the lock. A `<jobId>.lock.break` older than a minute means its breaker crashed inside a
  microsecond window; it is deliberately not auto-cleared (that would need a marker for the marker) —
  delete it by hand. Neither loses work: the ticket is still `<jobId>.json` and the next launcher
  picks it up. (The bridge's breakaway fallback withdraws its own ticket before it starts a job, so a pending
  ticket is not a duplicate-run risk from that; still check for `runner.pid` in the job dir before deleting
  a pending ticket you do not want to run.) An empty `<jobId>.lock.break` left by a failed marker write is
  deleted the same way.
- **Fallback vs the pending ticket (`job-core.mjs`, `launchWin32Task`).** Before this fix, when the task
  path failed (`schtasks /Run` failed, or no `runner.pid` within 15 s) the bridge started the job through
  `win32-breakaway.ps1` and **left its ticket in the queue**, so any launcher that ran later (that job's slow
  instance, or one triggered by another `claude_start`) claimed the ticket and started the job a second time.
  Now the bridge first takes its ticket back with the same claim lock (`withdrawTicket` in
  `launcher-claim.mjs`: exclusive-create `<jobId>.lock`, unlink the ticket, release). If that succeeds it
  launches the fallback (`launchPath: "breakaway-fallback"`, err.log: `removed the still-pending launch
  ticket before falling back`). If it loses (the ticket is already `<jobId>.claimed.json`, a launcher holds
  the lock, or the unlink failed) a launcher owns the job, so the bridge does **not** launch it a second way:
  it keeps polling `runner.pid` for 15 s more and reports `launchPath: "task"` if it appears (err.log:
  `launch ticket not withdrawn (claimed|held|error)`). If it never appears the start returns
  `pid: null`, `pidSource: "task-claimed-no-runner"` and err.log says the launcher never started it; check
  `job-launcher.log`, then retry `claude_start` with the same `jobId` (after deleting the stale
  `.claimed.json` per the note below). `claude_check` heals a late runner's pid from `runner.pid`.
- **Not covered:** a launcher frozen for over a minute between creating the lock and writing its pid
  (VM pause) may still be judged stale and have its lock broken, but it can no longer damage anyone: its
  read-back fails, so it claims nothing and unlinks nothing (the ticket stays pending for the next launcher).
  A live launcher is never broken once its pid is written, apart from the microsecond gap named under
  Identity. A read-back that fails for a transient reason (antivirus holding the file) also gives up the
  ticket for that launcher and leaves its lock; launchers exit after one claim, so the dead pid lets the lock
  age out after 60 s. Launchers from before this fix still in flight during a deploy do not take the lock.
- **Tests** (`npm run test:multihost`, temp dirs only, no schtasks): `test/multihost/claim.test.mjs` has
  unit tests for the protocol; a 4-process race behind a shared high-resolution barrier (600 rounds ×
  3 tickets; claim starts land together, median spread measured 0.003–0.04 ms) asserting no ticket
  claimed twice, none lost, no lock left; a stale-lock break race (4 launchers, one stale lock, 300 rounds: claimed once,
  broken once); and the real `job-launcher.mjs`, 3 copies × 120 rounds against a temp home
  (`USERPROFILE`/`HOME`; it aborts before spawning if that override does not take, since a launcher
  that resolved the live queue would claim live tickets) with a stub runner. Unit tests also cover the
  identity checks (fs patched to inject the stall: lost lock, replaced lock at release, replaced marker) and
  `withdrawTicket`; `postlaunch.test.mjs` covers fallback-vs-ticket with fake seams.
  **The concurrency tests fail rather than pass when they were not actually concurrent:** every worker must be
  released together (median claim-start spread under 1 ms, printed in the failure message). A round with a worker
  released more than 5 ms after the shared instant is still checked for double claims but is redone instead of
  counted, within a budget of 2% of the rounds (about 1 round in 300 hits it on an idle box); a run that
  blows the budget, or whose median spread is over 1 ms, fails with its timing. `LEAD_MS` is 50.
  To re-measure the old behavior: `CLAIM_RACE_VARIANT=old node --test --test-name-pattern="claim race"
  test/multihost/claim.test.mjs` reports the double-claim count (and still asserts alignment); add
  `CLAIM_RACE_STRICT=1` to apply the normal assertions, which the old claim fails. For the real-launcher
  variant: `git show 72ef9bb:job-launcher.mjs > job-launcher.old.mjs` in the repo dir plus
  `CLAIM_RACE_VARIANT=old CLAIM_TEST_LAUNCHER=<that path>` (delete the copy afterwards). **The old variant
  without `CLAIM_TEST_LAUNCHER` skips the real-launcher tests with a message** (it used to run the new
  launcher under an "OLD" label). Measured on Claunker 2026-09-26: old claim 1,573 double-claimed of 1,800
  tickets (600 rounds); old launcher copy 49 double-claimed tickets and 101 jobs not started exactly once
  (120 rounds); new claim and new launcher 0.
  `CLAIM_RACE_ROUNDS`, `CLAIM_RACE_WORKERS`, `CLAIM_RACE_TICKETS` and `CLAIM_LAUNCHER_ROUNDS` resize them.
- **Deploying: a bridge restart IS required.** The fallback fix changes `job-core.mjs` (it now imports
  `launcher-claim.mjs` and withdraws the ticket), and the running bridge has the old `job-core.mjs` in memory,
  so it keeps leaving the ticket behind until Claude Desktop restarts it (follow "Restarting the bridge"
  above, including the warmup). The launcher side (`job-launcher.mjs`, `launcher-claim.mjs`) needs no
  restart: Task Scheduler starts a fresh `node` per launch; both files must be present in the checkout the
  task points at. (An earlier version of this note said no restart was needed; that was true only before
  `job-core.mjs` changed.)
- **After deploying, rerun `node test/survival.mjs` on BOTH hosts (Claunker and the laptop), from the
  live checkout.** It was not run as part of this change (it deliberately uses the live queue and the
  `ClaudeAsyncRunner` task). Its race scenario now exercises the lock claim, and scenario (c) now
  reports a harness timeout as a timeout instead of a silent vanish.
- **Spaces in the repo path** (the laptop's is `...\CC bridge\claude-async`).
  `test/job-close-harness.ps1` used `Start-Process -ArgumentList @(...)`, which Windows PowerShell 5.1
  joins with spaces and no quoting, so node received a split path (`Cannot find module '...\CC'`), no
  marker was written, and scenario (c) timed out. It now quotes each argument.
  `test/multihost/harness-quoting.test.mjs` runs both harnesses from a spaced temp path with a stub child
  (`CLOSE_HARNESS_SCRIPT=<path>` runs another copy of the close harness, e.g. the old one, to see the failure).

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
