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
| `claude_start` | `host` (required; one of the hosts in `hosts.json`, see Multi-host), `prompt` (required), `workFolder?`, `jobId?` (descriptor), `model?`, `effort?`, `intent?` | `jobId` (`<host>.<descriptor>-YYYYMMDD-<8 chars>`), `hostname`, `preflight`; the job runs detached |
| `claude_check` | `jobId` (required), `tailBytes?` | `hostname`, `status`, `exitCode`, and a tail of stdout/stderr (routed by the id's host prefix) |
| `claude_jobs` | — | every job on this host and every `hosts.json` host, each row tagged `host` + `hostname`; an unreachable host is an explicit `unreachable (last seen <time>)` row |

`status` is one of `running | completed | failed | orphaned | unknown`. `completed` is
reported only when the job exited with code 0; a non-zero exit is `failed`.

`claude_check` also includes an `exit` field when the runner's `exit.json` record (see
`job-runner.mjs`) exists in the job's dir: the parsed `{ exitCode, exitSignal, exitReason,
spawnError?, endedAt, stderrTail, stdoutTail, usageLimitSuspected }` object, letting a dead or
failed job be attributed without opening the job dir. It is omitted (never `null`) for jobs that
predate `exit.json`, and degrades to `{ error: "unparseable exit.json" }` if the file is missing,
partial, oversized (>256 KiB), or otherwise unparseable. This is purely additive: it never affects
the `status` classification above.

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
| `CLAUDE_ASYNC_ALLOW_ANY_URL` | unset | `1` skips the Tailscale-range check on `hosts.json` urls (never the http/https check). For tests and local development only; a config-sanity check, NOT a security control (the receiver's bind address and token are what protect it) |
| `CLAUDE_ASYNC_MAX_CONCURRENT` | `4` | Max running jobs on this host (`hosts.json` `caps.maxConcurrent` wins) |
| `CLAUDE_ASYNC_MAX_STARTS_PER_MINUTE` | `6` | Max starts per rolling 60s on this host (`hosts.json` `caps.maxStartsPerMinute` wins) |

## Multi-host (registry-driven)

Which hosts exist is configuration, not code. Each machine's `hosts.json` is its **registry**:
the known hosts are this machine (`localHost`) plus every key of `hosts`, and a host can be
dispatched to when it has an entry with a `url` and a `token`. Adding a host is a config change
on each machine, never a code change. `claude_start` requires `host` (no default):

| `host` names… | What happens |
|---|---|
| this machine (`localHost`) | runs locally, no network hop |
| a key of `hosts` | forwarded to that host's host API over Tailscale |
| anything else | error: `host "x" is not in <file> (known hosts: a, b, c)`, nothing written |

The topology is one-way **by config**: a machine that appears in nobody's registry (the laptop)
can never be dispatched to, and needs no special case in the code. A dispatcher lists the
receivers it may send to; a receiver lists nobody unless it also dispatches.

Job ids are `<host>.<descriptor>-YYYYMMDD-<8 random [a-z0-9]>`, minted by the executing host. The
prefix is any valid host name (below). `claude_check` requires the prefix to be a **known** host and
otherwise returns an error naming the prefix and the known hosts (it never falls back to a local
lookup). Older un-prefixed ids have no dot and are still checked locally. The forwarder stores
nothing: the job record lives only on the executing host, and `claude_check` / `claude_jobs` ask it
live; `claude_jobs` asks every registry host that has a `url`.

**Config (user profile, never the repo; `CLAUDE_ASYNC_CONFIG_DIR` overrides the directory):**

- `~/.claude-async/hosts.json` (every machine). Validated on every load; a file that fails
  validation is an error naming the file and the field, and `claude_start` refuses until it is fixed.

  | Field | Required | Rule |
  |---|---|---|
  | `localHost` | yes | this machine's name; matches `^[a-z0-9][a-z0-9-]{0,31}$` (no dots: `.` is the job-id separator; no uppercase; not a Windows device name: `con prn aux nul com1`-`com9` `lpt1`-`lpt9`; it becomes an id prefix and part of dir names) |
  | `receiver` | no (default `false`) | boolean; `true` lets this machine run `host-api.mjs` |
  | `hosts` | no | map name -> `{ "url", "token" }`; every name matches the pattern above and is not `localHost`; `url` is an http or https URL whose host is an IPv4 literal in the Tailscale range 100.64.0.0/10 (a receiver only binds a Tailscale address; hostnames, IPv6, loopback, RFC1918 and public addresses are rejected); `token` is a non-empty string |
  | `caps` | no | object; `maxConcurrent` and `maxStartsPerMinute`, each optional and an integer >= 1 (no strings, 0, negatives or floats); unknown keys are an error; `{}` means the defaults (4 and 6) |

  A **dispatcher** (here the laptop, which sends to two receivers and is itself in nobody's registry):

  ```json
  { "localHost": "laptop",
    "hosts": {
      "claunker": { "url": "http://100.x.y.z:7850", "token": "<token from claunker's --new-token>" },
      "ha":       { "url": "http://100.a.b.c:7850", "token": "<token from ha's --new-token>" } },
    "caps": { "maxConcurrent": 4, "maxStartsPerMinute": 6 } }
  ```

  A **receiver** (here `ha`; `hosts` is empty because it dispatches to nobody):

  ```json
  { "localHost": "ha", "receiver": true }
  ```

  With no `hosts.json`, `claude_start` refuses with an error naming the file; un-prefixed
  `claude_check` still works.
- `~/.claude-async/api.json` (receivers only): `{ "port": 7850, "tokenSha256": "<hex>",
  "bindAddress": "100.x.y.z" }`. Holds only the token's sha256; `bindAddress` is optional
  (required only if more than one Tailscale address is present).
- `~/.claude-async/last-seen.json`: last successful contact per remote host, used only for the
  `unreachable (last seen …)` row.

**Tool schema and restarts.** `host` is a required enum built when the bridge starts from the
registry (`localHost` plus the `hosts` keys), and its description lists the names. That list is
advertised once, so **to add a host: edit `hosts.json` and restart the bridge**. Routing re-reads the
file on every call and validates the requested host against the live registry too, so a stale enum
can never route to a host that has since been removed (that call errors with the known hosts).

**Adding a receiver (both sides):**

1. On the receiver: install this repo and Node, create its `hosts.json` `{ "localHost": "<name>", "receiver": true }`,
   run `node host-api.mjs --new-token` (prints the token once; stores only its hash in `api.json`),
   then start `node host-api.mjs` (a service on Linux, see below). It binds only to a Tailscale address
   and refuses to start if `receiver` is not `true`.
2. On each machine that should dispatch to it: add `"<name>": { "url": "http://<tailscale ip>:7850", "token": "<token>" }`
   under `hosts`, then restart the bridge (Claude Desktop) so the `host` enum includes it.
3. Do not add the receiver to a machine's registry unless that machine should be able to send to it;
   do not list a dispatcher-only machine (the laptop) anywhere.

**Host API (`host-api.mjs`, receivers only).** `POST /v1/start`, `GET /v1/check?jobId=`,
`GET /v1/jobs`, all behind `Authorization: Bearer <token>` (bare `401` on failure, checked before
anything is read or written). It rejects a start whose `host` is not this receiver's `localHost`. It
binds only to a Tailscale address (100.64.0.0/10) that is present
on an interface and refuses to start otherwise; it never binds `0.0.0.0` or loopback. Starts go
through the same guarded `startJob()` and the same launcher queue as the MCP bridge.

```
node host-api.mjs --new-token   # once: stores sha256 in api.json, prints the token once
node host-api.mjs               # run (foreground)
```

### Linux receiver (Debian LXC on Proxmox, e.g. `ha`)

> **Nothing in this repo has ever run on Linux.** The POSIX launch path (`spawn` detached + `unref`) and
> the receiver code are exercised by the test suite only on Windows so far. On a new receiver, run
> `npm run test:multihost` first, before pointing anything at it, and read any failure as a real finding.

- **Non-root service user.** The `claude` CLI refuses `--dangerously-skip-permissions` as root, and every job
  is started with it. Create a user (the sample unit uses `claude`), install the CLI for that user and log it in.
- **The `claude` binary.** Put it on the service's `PATH`, or set `CLAUDE_CLI_PATH` to its absolute path
  (a systemd unit does not read your shell profile, so set one of the two explicitly).
- **Node.** A current Node on the box (`/usr/bin/node` in the sample unit); `npm ci` in the checkout.
- **Tailscale in the container.** `host-api.mjs` binds only to a Tailscale address that is on a local
  interface. An LXC needs the TUN device passed through for `tailscaled` to create that interface
  (userspace-networking mode has no interface, so the API would refuse to start). This is Proxmox-side setup,
  not exercised here.
- **Service.** `deploy/claude-async-api.service` is a sample unit: `User=claude`, `WorkingDirectory=/home/claude/code/claude-async`,
  `Environment` for `HOME`, `PATH`, `CLAUDE_CLI_PATH`, `CLAUDE_ASYNC_DEFAULT_CWD`, `Restart=on-failure`, and
  **`KillMode=process`**. The POSIX launch is `spawn(detached)` + `unref`, so running jobs stay in the unit's cgroup;
  the default `KillMode=control-group` would kill them whenever the API restarts. Copy it to
  `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now claude-async-api`. The unit has not been run.
- **Optional:** `CLAUNKER_JOBCARD_CMD` overrides the dispatch-card command. Without the claunker-hermes venv the card step
  fails open (jobs still run; the start response carries an `UNCARDED` note), so set it only if the receiver has a card command.
- **Config:** `~/.claude-async/hosts.json` `{ "localHost": "ha", "receiver": true }` for the service user, then
  `node host-api.mjs --new-token` as that user, and add `ha` to the dispatchers' registries (steps above).

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
