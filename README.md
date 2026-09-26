# claude-async

A fire-and-poll [MCP](https://modelcontextprotocol.io) server that lets Claude Code run **long background jobs** without hitting the Claude app's tool-call timeout.

**Requirements:** Node.js 18+ (20+ recommended) and the [`claude` CLI](https://docs.claude.com/en/docs/claude-code) installed and authenticated.
**License:** MIT

## The problem

The Claude desktop app caps how long any single MCP tool call can run — roughly 60s per call, with a ~4–5 minute transport ceiling. A long Claude Code task (a big refactor, a multi-step build) outlives that window, the call drops, and you lose the in-flight work and start over.

## The fix

`claude-async` spawns Claude Code as a **detached background process** and hands back a `jobId` in milliseconds. You poll for results whenever you like.

- No single tool call lives long enough to time out.
- Jobs are detached, so they **survive a bridge restart** — reconnect with the same `jobId`.
- Output and exit status are written to disk per job, so nothing is lost.

Three tools: `claude_start`, `claude_check`, `claude_jobs`.

## Set it up with Claude

Paste this prompt to Claude Code, or to Claude in the desktop app with this repo open. It stands the server up end to end and verifies it:

```
You're installing the `claude-async` MCP server from this repository. Work through
these steps in order and report the result of each. If any step fails, stop and show
me the exact error — do not continue.

1. Confirm prerequisites: `node -v` (must be 18+) and `claude --version` (the Claude
   CLI must be installed and authenticated).
2. From the repo root, run `npm install`.
3. Verify the fire-and-poll plumbing without needing a live model:
   `node claude-async-server.mjs --selftest`. It must report the detach → poll → exit
   cycle passing.
4. Register the server with Claude Desktop by running `node register-desktop.mjs`.
   (On Windows Store / MSIX installs this writes to the virtualized config path that
   the in-app "Edit Config" button does NOT open — that mismatch is a known
   silent-failure trap.) If you are not on Windows, add the config block from the
   "Manual setup" section of the README instead.
5. Tell me to fully quit and relaunch Claude Desktop, then confirm `claude-async`
   appears with status `running` under Settings → Connectors.
6. Smoke-test the round trip: call `claude_start` with the prompt "print hello world",
   take the returned `jobId`, and poll `claude_check` until `status` is `completed`
   and `exitCode` is 0. Show me the output.
```

## Manual setup

If you'd rather not use the prompt above, or you're not on Windows:

1. **Install dependencies:** `npm install`
2. **Verify the plumbing:** `node claude-async-server.mjs --selftest`
3. **Register the server** by adding it to your Claude Desktop config file:

   - **Windows (Store / MSIX install):**
     `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
     *(The in-app "Edit Config" button opens `%APPDATA%\Claude\` instead, which the
     Store build does not read. Edit the path above, or just run
     `node register-desktop.mjs`.)*
   - **Windows (standard install):** `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

   Add:

```json
   {
     "mcpServers": {
       "claude-async": {
         "command": "node",
         "args": ["/absolute/path/to/claude-async/claude-async-server.mjs"]
       }
     }
   }
```

4. **Fully quit and relaunch** Claude Desktop — closing the window is not enough. The
   server should then show as `running`.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `claude_start` | `host` (required: `claunker` \| `laptop`), `prompt` (required), `workFolder?`, `jobId?` (descriptor), `model?`, `effort?`, `intent?` | `jobId` (`<host>.<descriptor>-YYYYMMDD-<8 chars>`), `hostname`, `preflight`; the job runs detached |
| `claude_check` | `jobId` (required), `tailBytes?` | `hostname`, `status`, `exitCode`, and a tail of stdout/stderr (routed by the id's host prefix) |
| `claude_jobs` | — | every job on this host and every `hosts.json` host, each row tagged `host` + `hostname`; an unreachable host is an explicit `unreachable (last seen <time>)` row |

`status` is one of `running | completed | failed | orphaned | unknown`. `completed` is
reported only when the job exited with code 0; a non-zero exit is `failed`.

> Field names are camelCase throughout — it's `jobId`, not `job_id`.

## Configuration

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CLI_PATH` | `claude` (on PATH) | Path to the `claude` binary |
| `CLAUDE_ASYNC_JOB_DIR` | `~/.claude-async-jobs` | Where per-job logs and exit codes are stored |
| `CLAUDE_ASYNC_DEFAULT_CWD` | `$HOME` | Default working directory for jobs |
| `CLAUDE_ASYNC_DEFAULT_MODEL` | `claude-sonnet-5` | Model used when `claude_start`'s `model` param is omitted |
| `CLAUDE_ASYNC_DEFAULT_EFFORT` | `medium` | Reasoning effort used when `claude_start`'s `effort` param is omitted |
| `CLAUDE_ASYNC_CONFIG_DIR` | `~/.claude-async` | Where `hosts.json`, `api.json`, `last-seen.json` live (see Multi-host) |
| `CLAUDE_ASYNC_MAX_CONCURRENT` | `4` | Max running jobs on this host (`hosts.json` `caps.maxConcurrent` wins) |
| `CLAUDE_ASYNC_MAX_STARTS_PER_MINUTE` | `6` | Max starts per rolling 60s on this host (`hosts.json` `caps.maxStartsPerMinute` wins) |

## Multi-host (Claunker + laptop)

Two hosts, one-way: **`claunker` is the only remote dispatch target**; the laptop never
exposes an API. `claude_start` requires `host` (no default):

| This machine (`localHost`) | `host: claunker` | `host: laptop` |
|---|---|---|
| `laptop` | forwarded to Claunker's host API over Tailscale | runs locally (fallback when Claunker is offline) |
| `claunker` | runs locally | error: `laptop is not a remote dispatch target` |

Job ids are `<host>.<descriptor>-YYYYMMDD-<8 random [a-z0-9]>`, minted by the executing host.
A prefix counts only if it exactly matches `claunker`/`laptop`, so older un-prefixed ids are
still checked locally. The forwarder stores nothing: the job record lives only on the executing
host, and `claude_check` / `claude_jobs` ask it live.

**Config (user profile, never the repo; `CLAUDE_ASYNC_CONFIG_DIR` overrides the directory):**

- `~/.claude-async/hosts.json` (both machines). Local-host identity is explicit, never guessed:

  ```json
  { "localHost": "laptop",
    "hosts": { "claunker": { "url": "http://100.x.y.z:7850", "token": "<token from --new-token>" } },
    "caps": { "maxConcurrent": 4, "maxStartsPerMinute": 6 } }
  ```

  On Claunker: `{ "localHost": "claunker" }` (a registry is not needed there). With no
  `hosts.json`, `claude_start` refuses with an error naming the file; un-prefixed
  `claude_check` still works.
- `~/.claude-async/api.json` (Claunker only): `{ "port": 7850, "tokenSha256": "<hex>",
  "bindAddress": "100.x.y.z" }`. Holds only the token's sha256; `bindAddress` is optional
  (required only if more than one Tailscale address is present).
- `~/.claude-async/last-seen.json`: last successful contact per remote host, used only for the
  `unreachable (last seen …)` row.

**Host API (`host-api.mjs`, Claunker only).** `POST /v1/start`, `GET /v1/check?jobId=`,
`GET /v1/jobs`, all behind `Authorization: Bearer <token>` (bare `401` on failure, checked before
anything is read or written). It binds only to a Tailscale address (100.64.0.0/10) that is present
on an interface and refuses to start otherwise; it never binds `0.0.0.0` or loopback. Starts go
through the same guarded `startJob()` and the same launcher queue as the MCP bridge.

```
node host-api.mjs --new-token   # once: stores sha256 in api.json, prints the token once
node host-api.mjs               # run (foreground)
```

**Guard (one, server-side).** Every start on the executing host, local or via the API, is
checked for caps: max concurrent running jobs (default 4) and max starts per rolling minute
(default 6). Over a cap it is rejected with a clear error and no ticket. Duplicate ids are rejected
at create time. A preflight checks that the Claude binary and `workFolder` exist (errors name the
host). Success says exactly `preflight passed, execution unverified`: the runner may still fail,
and records that in the job. `CLAUDE_ASYNC_DEPTH` / `X-Claude-Async-Depth` (depth > 1 rejected)
is an **accident guard only, not a security control**. Anyone can send any value.

The guard **fails closed on corrupt state**. A job dir whose `meta.json` is missing or unreadable
still counts as running if it changed in the last 2 minutes; an older one is not counted but is named
in a `warnings` array on the start response (repair or delete it). A missing or corrupt
`.start-ledger.json` is rebuilt from the job dirs created in the last 60 s, never treated as empty.
State files (`meta.json`, tickets, the ledger, `last-seen.json`, `api.json`) are written
atomically (temp file + rename), so a crash mid-write cannot truncate them.

## How it works

`claude_start` writes a small job record and spawns a detached worker
(`job-runner.mjs`) that runs the `claude` CLI, streaming stdout/stderr to that job's
log files and recording the exit code when it finishes. The parent returns the `jobId`
immediately and the worker is `unref`'d, so it keeps running even if the MCP bridge is
recycled. `claude_check` simply reads that job's status and log tail from disk — also
instant. Because state lives on disk rather than in the live connection, a dropped or
restarted bridge never costs you a running job.

**On Windows**, "detached" alone isn't enough for that guarantee. `detached: true` only
puts the worker in a new process group — it does not remove it from whatever Windows Job
Object the bridge itself is running in, and Claude Desktop runs MCP servers in a job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set (confirmed via `IsProcessInJob` +
`QueryInformationJobObject` during the 2026-09-09 investigation on `fix/win32-detach`), so a
naively-detached worker can die when the bridge does. An initial fix shelled out to
`win32-breakaway.ps1` (`CreateProcessW` with `CREATE_BREAKAWAY_FROM_JOB`), but runners still
self-reported job membership afterward and were still observed being hard-killed. The launch
path now defaults instead to a small Windows Task Scheduler-based launcher
(`job-launcher.mjs`, registered as the `ClaudeAsyncRunner` task by `job-core.mjs`'s
`ensureLauncherTask()`) that gives the worker an ancestor — the Task Scheduler service — that
was never inside Claude Desktop's process tree or job to begin with; `win32-breakaway.ps1` is
kept as an automatic fallback if the task can't be registered or triggered. See
`RUNBOOK.md`'s "Task Scheduler launcher" section for the full design and its verification, and
`test/survival.mjs` for the tests (three independent kill mechanisms plus a launcher claim-race
test).

## Gotchas

- **Server shows `running` but tools don't respond:** fully quit and relaunch the app;
  closing the window doesn't reload MCP servers.
- **Windows Store install, config edits ignored:** you're editing the wrong file — see
  the MSIX path under Manual setup, or run `register-desktop.mjs`.
- **Very large `claude_start` prompts fail on Windows (`ENAMETOOLONG`):** the prompt is
  passed as a CLI argument, so keep it modest and have the job read large inputs from a
  file instead.

## Known issues

- **`claude_check` trusts the stored job record.** If the bridge restarts between job
  completion and record close (e.g. a Claude Desktop swap), the record shows `running`
  forever while the detached job has finished and its work landed. Observed 2026-07-04
  (job `kanbantt-remember-token-optin`: commit pushed at 01:52Z, record never closed).
  Fix direction: `claude_check` should re-stat the pid and reap exit state from the job
  directory rather than trusting the record.

## License

MIT — see [LICENSE](LICENSE).
