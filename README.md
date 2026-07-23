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
| `claude_start` | `prompt` (required), `workFolder?`, `jobId?`, `model?` | `jobId` immediately; the job runs detached |
| `claude_check` | `jobId` (required), `tailBytes?` | `status`, `exitCode`, and a tail of stdout/stderr |
| `claude_jobs` | — | every known job with its current status |

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
| `CLAUDE_ASYNC_DEFAULT_MODEL` | `claude-sonnet-4-6` | Model used when `claude_start`'s `model` param is omitted |
| `CLAUDE_ASYNC_DEFAULT_EFFORT` | `medium` | Reasoning effort used when `claude_start`'s `effort` param is omitted |

## How it works

`claude_start` writes a small job record and spawns a detached worker
(`job-runner.mjs`) that runs the `claude` CLI, streaming stdout/stderr to that job's
log files and recording the exit code when it finishes. The parent returns the `jobId`
immediately and the worker is `unref`'d, so it keeps running even if the MCP bridge is
recycled. `claude_check` simply reads that job's status and log tail from disk — also
instant. Because state lives on disk rather than in the live connection, a dropped or
restarted bridge never costs you a running job.

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
