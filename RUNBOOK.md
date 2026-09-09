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
