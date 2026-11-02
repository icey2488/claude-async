# Container jobs (`sandbox: "container"`)

Container jobs run the Claude Code CLI inside a Docker container on claunker instead of on the bare
Windows host. A container job gets a full shell and runs with `--dangerously-skip-permissions`. It
names a GitHub repo; the container clones that repo itself, works in container-local storage,
pushes a branch and opens a PR as a dedicated GitHub machine account (the bot), never as Erick.
**No host folder is mounted read-write.** Nothing the job writes reaches the host disk except the
runner's captured stdout/stderr. `main` requires a PR with the owner's approval: the bot opens PRs,
Erick approves and merges them, and the bot cannot push to or merge into `main`.

Container mode is **opt-in, off by default, and gated twice**: the call (or
`CLAUDE_ASYNC_JOB_SANDBOX`) must ask for it, and the host policy `CLAUDE_ASYNC_ALLOWED_SANDBOXES`
must allow it (default: `host` only). Windows-admin jobs (scheduled tasks, services, firewall checks)
stay on the host under the existing modes: skip-permissions, or safe mode
(`CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS=1`). When container mode is not used, every job's argv,
environment and `spec.json` are unchanged (a test asserts the literal host argv).

| piece | file |
|---|---|
| argv building, validation, cleanup by label, redaction, bridge lock check | `container.mjs` |
| launch integration (`sandbox`/`repo`/`baseRef`, preflight, `cancelJob`, cleanup state) | `job-core.mjs` |
| runner: cancel intent, cleanup on every stop, wall-clock limit, redaction, PR URL | `job-runner.mjs` |
| `claude_start` params, `claude_cancel`, `POST /v1/start`, `POST /v1/cancel` | `dispatch.mjs`, `host-api.mjs` |
| HTTP bridge token lock | `http-bridge.mjs`, `claude-async-http.mjs` |
| job image and its entrypoint (the clone) | `container/Dockerfile`, `container/job-entry.sh` |
| rules mounted read-only into every job | `container/CLAUDE.md` |
| image build + checks on claunker | `container/smoke-test.ps1`, `container/probe.sh` |
| tests | `test/container.test.mjs`, `test/container-runner.test.mjs`, `test/container-dispatch.test.mjs`, `test/http-bridge-auth.test.mjs`, `test/job-entry.test.mjs` |

## Why

Today a job either runs with `--dangerously-skip-permissions`, where everything Erick's Windows
account can read is reachable, or in safe mode. Safe mode's pattern rules leak: `node -e`,
`python -c` and `git -C x push` all get past them (see `docs/publishing.md`, "Threat model"). In
both modes `git push` would use Erick's own full GitHub credential from Git Credential Manager.
Container jobs change the boundary from "what the permission rules happen to match" to "what is in
the container and which credential is present". A job can do anything inside the container. That
covers one fresh clone and a bot token that can't do anything Erick's repos don't allow the bot to do.

## The interface

```
claude_start { host, prompt, sandbox: "container", repo: "owner/repo", baseRef?: "branch|tag|sha",
               model?, effort?, intent?, jobId? }
POST /v1/start  (same body; forwarded by claude_start for a remote host)
claude_cancel { jobId }        POST /v1/cancel { jobId }   (routed by the job id's host prefix)
```

- **`repo`** (required for a container job): `owner/repo` on GitHub. It must be listed in the
  executing host's `CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS` (comma, semicolon or space separated,
  case-insensitive). There is no default: unset means every container job is refused.
- **`baseRef`** (optional): a branch, tag or commit to start from. Plain names only (no leading
  `-`, no `..`, no `@{`, no `refs/...`). Default: the repo's default branch. It is resolved
  **locally in the fresh clone** (`origin/<ref>`, then `tags/<ref>`, then a 7-40 hex commit the
  clone already has), never fetched, so it can only name something on a branch or tag of the repo
  itself; `refs/pull/N/head` or a fork's SHA from GitHub's shared object network is exit 70.
- **`workFolder` is refused** for a container job ("container jobs do not take workFolder"), and
  **`repo`/`baseRef` are refused** for a host job. So no call can mean two things, and every
  existing host-mode call is unaffected. `repo`, `baseRef` and `sandbox` are only forwarded to a
  remote host when given, so a forwarded host-mode body is byte-for-byte what it was.

Why a `repo` parameter rather than a mapping from `workFolder`: a mapping would keep a host path in
the interface that no longer means anything (nothing is mounted), and would need a second table
from folders to repos that could drift from the bot's real collaborator list. `owner/repo` is what
the container actually acts on, it is checked against one explicit allowlist, and it reads the same
in a prompt, in `meta.json` and on GitHub.

## Threat model

Read this before you count on the container for anything.

**What the container boundary protects:**

- **Erick's files, repos and credentials.** No host folder is mounted read-write, and nothing from
  `%USERPROFILE%` is mounted at all: not `.ssh`, `.claunker`, `.claude` (Erick's own Claude Code
  login), `.claude-async` (Discord webhook, hosts.json, api.json, http.json), `.claude-async-jobs`
  (other jobs' logs), Git Credential Manager, the Windows Credential Manager or gh's stored token.
  No working copy under `D:\code` is visible, and neither is the live chassis (`D:\claunker`). The
  only host mounts are two read-only ones (CLAUDE.md and hooks/, below). The smoke test checks the
  mount table.
- **The host from the job's git activity.** Earlier drafts bind-mounted a host clone and audited its
  `.git` afterwards. That design is gone: the clone lives and dies in the container, and no host git
  ever runs in a job's repo (the card hook's HEAD lookup is skipped for container jobs). So
  `.git/config` tricks (`core.fsmonitor`, hooks, `commondir`, a `.git` file swap) have nothing on the
  host to act on.
- **Erick's GitHub identity, and `main`.** The only GitHub credential in the container is the bot's
  token. A job can push only where the bot is a collaborator (or to the bot's own forks). `main`
  requires a pull request with 1 approval from the owner, set by a ruleset, so the bot cannot push
  to `main` or merge into it, even with write access. Erick reviews and merges every PR.
- **The host OS.** The job runs as uid 1000, not root, with `--cap-drop ALL` and
  `--security-opt no-new-privileges`. It has no Docker socket and gets CPU, memory, PID and
  wall-clock limits.
- **Concurrent jobs from each other's files.** Each container has its own clone. Two jobs never
  share a working tree or a `.git`, so one can't change another's repo mid-run.
- **Repo-controlled Claude settings.** A hostile repo's `.claude/settings.json`,
  `.claude/settings.local.json` or `.mcp.json` could set env (`ANTHROPIC_BASE_URL`), an
  `apiKeyHelper`, hooks or MCP servers, all of which act at CLI startup before the model sees the
  prompt. The CLI runs with `--setting-sources user` (only user settings plus our `--settings`) and
  `--strict-mcp-config` with an empty config, and the image makes `~/.claude` root-owned so a job
  can't create user settings either. Verified in a local build against a fake API: with the flag a
  repo carrying all of the above sends nothing to its endpoint and runs none of its hooks or its
  `apiKeyHelper`; without the flag (control) the repo's `ANTHROPIC_BASE_URL` beat the process
  environment, its SessionStart hook and `apiKeyHelper` ran, and the OAuth bearer went to the
  repo's endpoint. That control also shows why `ANTHROPIC_BASE_URL` is **not** set in the container
  env: a settings file outranks the process environment, so it would not have helped, and with
  project/local settings off no remaining source can change it.

**What it does NOT protect:**

- **The two tokens, in phase 1. This is an accepted risk for a limited pilot.** With open egress a
  job (or code it runs: `npm install` scripts, test suites, anything from the repo or its
  dependencies) can send `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` anywhere, and use them after the
  container is gone. The PAT reaches every repo the bot can write to; the OAuth token is a
  long-lived credential on Erick's subscription. Revocation (see Rollback) helps recovery but does
  not contain a compromise nobody noticed. Measured detail: Claude Code 2.1.309 already leaves
  `CLAUDE_CODE_OAUTH_TOKEN` out of the environment of its Bash tool's commands (the env names a
  Bash call saw were listed in a local run), but the same uid can read it from
  `/proc/<claude pid>/environ` (also verified), and `GH_TOKEN` is in every command's environment by
  necessity. The CLI has a `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` mode, but it requires bubblewrap
  (user namespaces) and forces the permission mode back to default, which defeats
  skip-permissions; it was not adopted. A wrapper that hides the token somewhere the same uid can
  still read would not change this. The real mitigation is phase 2 egress. Until then the pilot
  repo should have no third-party install scripts (no dependencies with `postinstall`, no
  `prepare`, no build steps pulling code), and the bot should be a collaborator on as few repos as
  possible.
- **The bot token, against the bot's own reach.** The job can do anything the token allows: push
  branches to every repo the bot can write to, open or close issues and PRs, comment. A classic PAT
  can't be scoped to selected repos (see "Identity"), so the bot's reach is exactly its collaborator
  list. Keep that list short.
- **CI on repos the bot can push to.** Leaving the `workflow` scope off stops a push that edits
  `.github/workflows/`. It does not stop a job from editing a script, Makefile, test or package
  script that an existing workflow already runs on a PR or branch push. Whether that exposes secrets
  or a self-hosted runner depends on the workflow's triggers, permissions, secrets and runner. **Do
  not invite the bot to any repo whose CI holds secrets (or runs on a self-hosted runner) until that
  CI has been reviewed for this.**
- **The network (phase 1).** On the default bridge network a job can reach the whole internet,
  claunker's own LAN and tailnet addresses, and other machines on the LAN and tailnet (Hermes,
  Spine, AgentGlass, Home Assistant and so on) with claunker's source address. Anything that trusts
  "it came from claunker" or "it came from the LAN/tailnet" is exposed. The smoke test probes
  claunker's own addresses and any `-LanTargets` you give it; reachable LAN services are WARNs, not
  failures, because phase 1 accepts this. Phase 2 (below) removes these routes.
- **Host loopback services.** `host.docker.internal` reaches the Windows host, which is how host
  Ollama is reachable. On Docker Desktop that path forwards to the host's `127.0.0.1` as well; the
  smoke test measures it directly with a temporary listener on a random loopback port. So assume
  every loopback service is reachable from a job:
  - `claude-async-http.mjs` on `127.0.0.1:7842` is an MCP endpoint that can start host jobs.
    **Container mode refuses to start unless that bridge is token-locked**: `~/.claude-async/http.json`
    must hold a token hash (`node claude-async-http.mjs --new-token`), and whatever listens on the
    port must answer an unauthenticated MCP request with 401 (so an old bridge that was not restarted
    also refuses). That preflight probe is a one-time check, not a durable boundary, so **on a host
    that allows container mode the bridge itself requires the token to start**: with
    `CLAUDE_ASYNC_ALLOWED_SANDBOXES` including `container` (or `CLAUDE_ASYNC_JOB_SANDBOX=container`)
    and no valid `tokenSha256` in its `http.json` (missing, malformed, unreadable, or a different
    `CLAUDE_ASYNC_CONFIG_DIR` than the one the token was minted under), `claude-async-http.mjs`
    refuses to start (exit 78, message naming `--new-token`). It can therefore never be restarted
    into an unauthenticated state during a running container job. The explicit opt-out
    `CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1` is logged and is rejected whenever container mode is
    allowed. On a host-only policy a missing token keeps the pre-existing unauthenticated loopback
    behaviour (with a warning), because the bridge's documented client (the app's Connectors UI)
    cannot, as far as I know, send a static header; on claunker container mode therefore requires
    either giving the bridge's clients the token or stopping the bridge. The bridge supervisor
    (pm2 `ecosystem.config.cjs`, or the Task Scheduler entry) must run it with the same
    `CLAUDE_ASYNC_CONFIG_DIR` (default `%USERPROFILE%\.claude-async`) and `CLAUDE_ASYNC_HTTP_PORT` as
    the process that admits container jobs; the refusal message prints the path it read. If the
    bridge serves TLS (`CLAUDE_ASYNC_TLS_CERT`/`_KEY`), the preflight probe uses https (certificate
    not verified: it only wants the status code). The smoke test probes 7842 with
    `Host: 127.0.0.1:7842` (any other Host gets 403 from the transport's DNS-rebinding filter, which
    would make an open bridge look closed) and, when the port is closed, still requires `http.json`
    to hold a 64-hex hash.
  - The host API on `7850` is bearer-token gated and binds only to the tailnet address. A job can
    reach it (WARN in the smoke test) but can't use it without the token, which is not in the
    container.
  - The Docker Engine TCP API on `2375`/`2376` exists only if "Expose daemon on tcp://localhost:2375
    without TLS" is turned on in Docker Desktop. Never enable it; the smoke test fails if it is
    reachable.
  - **Ollama's write endpoints** (`/api/pull`, `/api/create`, `/api/copy`, `/api/delete`,
    `/api/push`) are unauthenticated and reachable. A job could delete or replace host models.
    Phase 1 accepts this; `container/CLAUDE.md` tells jobs to use only generate/chat/tags/show, and
    phase 2's proxy allows only those.
- **The Docker daemon itself.** Anyone who can talk to the Docker daemon controls the host:
  `docker run -v C:\:/host` mounts the whole disk. So a job must **never** get the Docker socket
  (`//./pipe/docker_engine`, `/var/run/docker.sock`), `DOCKER_HOST`, or the TCP API. The tests
  assert the argv never mentions a socket or pipe. A container job therefore can't run Docker
  itself (no docker-in-docker). Jobs that need Docker stay on the host.
- **Container escapes.** The container shares a Linux kernel with Docker Desktop's WSL2 VM. A
  kernel or runtime escape would land in that VM, which can reach the Windows filesystem through its
  file-sharing mounts. Non-root, no capabilities and no-new-privileges make that much harder. They
  don't make it impossible. This is a sandbox for confused or over-eager jobs, not for hostile code.
- **Prompt injection still steers the job.** Content the job reads (issues, web pages, dependency
  READMEs) can steer what it does inside the sandbox, including what it pushes. The PR rule on
  `main` and Erick's review of every PR are the backstop. Review the PR before you build or run it
  locally: files in it (a `Makefile`, `package.json` scripts, `.vscode/tasks.json`, `.envrc`) run on
  whatever machine runs them.

### Why `--dangerously-skip-permissions` inside

Inside the container the permission system has nothing left worth guarding. A job could already run
arbitrary code through `node`, `python`, `uv` or `npm`, and the leaks safe mode documented
(`node -e`, `git -C x push`) go away because there is nothing else on the box to reach. What a job
can touch is decided by what is in the container, the token and the network, not by pattern rules.

The **no-background hook still runs**, from the read-only hooks mount, as
`env -u NODE_OPTIONS /usr/local/bin/node /opt/claude-async/hooks/no-background-hook.mjs`, so neither
a `PATH` entry nor `NODE_OPTIONS` the job sets can replace it. It is a **reliability guard** (it
keeps jobs from backgrounding work and ending their turn early), **not a security boundary**: a job
already runs arbitrary code in its own container. The job-tool-gate and Ollama-guard hooks stay
host-only (the gate needs the host's claunker-hermes checkout; the Ollama guard exists for dontAsk
mode, which container jobs don't use).

Claude Code refuses `--dangerously-skip-permissions` as root outside a recognized sandbox. The image
runs as uid 1000, so that check never fires.

## What is mounted

Two **read-only** bind mounts, nothing else:

| host | container |
|---|---|
| `container/CLAUDE.md` (or `CLAUDE_ASYNC_CONTAINER_CLAUDE_MD`) | `/home/agent/.claude/CLAUDE.md` |
| this repo's `hooks/` | `/opt/claude-async/hooks` |

`/home/agent/.claude/CLAUDE.md` is Claude Code's user-level memory file, so the job rules apply in
addition to the repo's own `CLAUDE.md`. `/workspace` is container-local (the image's writable layer)
and starts empty; the entrypoint clones into it.

Mounted vs baked: these two stay mounted so a rules or hook change takes effect on the next job
without rebuilding the image. The entrypoint (`container/job-entry.sh`) is baked into the image
instead, because it is tied to the image's tools; **a change to `job-entry.sh` (or the Dockerfile)
needs an image rebuild** (`container\smoke-test.ps1`). Baking CLAUDE.md and hooks too would remove
the last host mounts at the cost of a rebuild for every rules or hook edit.

The image makes `/home/agent/.claude` root-owned (0755). Only the directories the CLI writes during
a headless run are agent-owned: `backups`, `projects`, `session-env`, `sessions` and
`shell-snapshots` were observed in a local run with a Bash tool call; `todos`, `plans`,
`file-history`, `debug`, `statsig`, `paste-cache` and `ide` are created up front for other code
paths (not observed). A job can't create `~/.claude/settings.json`, `agents/`, `commands/` or
`skills/`. `~/.claude.json` (the CLI's own state file in `$HOME`) stays writable, because the CLI
writes it.

## The clone inside the container

`docker run ... <image id> /usr/local/bin/claude-async-job-entry <owner/repo> <baseRef or ""> -- claude <args>`

`job-entry.sh` re-validates the repo and ref with the same rules as `container.mjs`, refuses a
non-empty `/workspace`, then:

```
git clone -- https://github.com/<owner/repo>.git /workspace
# only when baseRef is given: resolved locally, never fetched
git checkout --detach refs/remotes/origin/<baseRef> | refs/tags/<baseRef> | <sha>^{commit}
exec claude ...
```

Why local resolution: `git fetch origin <ref>` accepts full SHAs and full ref names, so
`refs/pull/123/head` or a commit from a fork would pull objects from GitHub's shared fork network
that are on no branch or tag of the allowed repo, and it rejects abbreviated SHAs outright
(`couldn't find remote ref`), although the interface advertises "a commit". Resolving against what
`git clone` already brought over keeps `baseRef` within the repo and makes short SHAs work. Not
found is exit 70 (`baseRef <x> not found in <repo>`).

- **Credentials.** The image's system git config (`/etc/gitconfig`, root-owned) sets
  `credential.https://github.com.helper = !/usr/local/bin/gh auth git-credential`. git asks gh, and
  gh answers from `GH_TOKEN` in the environment. The token is never in argv, a remote URL or a
  file; `gh auth setup-git` is not needed. Verified in the image: the helper answers from the env
  token, and a clone leaves no token in `.git/config`.
- **Exit codes** of the entrypoint itself: 64 usage/validation, 70 clone failed or `baseRef` not
  found / not checked out (the runner adds a warning naming the repo), 78 configuration (no
  `GH_TOKEN`, `/workspace` not empty). `test/job-entry.test.mjs` runs the script on the host against
  a local bare repo (URL rewritten with `url.insteadOf`): branch, tag and 8-char SHA check out,
  `refs/pull/1/head`, an unreachable SHA and an unknown name exit 70, and the fork commit never
  reaches the clone.
- `CLAUDE_ASYNC_REPO` and `CLAUDE_ASYNC_BASE_REF` are set in the container so the job knows what it
  cloned and what to open its PR against.

## How secrets reach the container

Only two secrets ever enter a container: the bot's GitHub token (`GH_TOKEN`) and the Claude Code
OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`). They live in one host file, the "secrets env file", in
Docker's `--env-file` format:

```
GH_TOKEN=ghp_...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

- **By path, never by value.** job-core passes `--env-file <path>` and Docker reads the file itself.
  Neither the docker argv nor `spec.json` nor `meta.json` ever holds a value (the tests assert this).
  Every non-secret variable goes in as an explicit `-e NAME=value`; a bare `-e NAME` is never used,
  and any `-e` name that looks like a credential throws.
- **Checked before every job, values never echoed.** `checkEnvFile()` returns key names, never
  values. It refuses: a key other than the two above (notably `ANTHROPIC_API_KEY`, which outranks
  `CLAUDE_CODE_OAUTH_TOKEN` and would silently switch billing to the API), a missing, empty or
  duplicate key, a bare `KEY` line, CRLF line endings, a UTF-8 BOM, a file inside the claude-async
  checkout or at/under either read-only mount source (the CLAUDE.md file, the hooks dir: as
  CLAUDE.md the tokens would be in the model's instructions), and any value with quotes, leading/trailing or inner whitespace (how a trailing
  `# comment` shows up) or control characters, since Docker's `--env-file` keeps all of those
  literally.
- **Never in the image.** The Dockerfile takes no secret build args, and nothing in it reads one.
- **Output redaction.** A job can print its own environment (or read `/proc/*/environ`).
  `out.log`/`err.log` in the job dir keep exactly what the job printed. Everything that **leaves the
  runner** is redacted with the env file's two values (read into memory once by
  `readEnvFileSecretValues()`, never written), their base64 forms (`base64("x-access-token:<GH_TOKEN>")`
  is the Basic header `GIT_TRACE_CURL`/`GIT_CURL_VERBOSE` print, plus `base64(<value>)`), plus the
  GitHub (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`) and Anthropic (`sk-ant-`) token
  shapes with no word-boundary anchor (so `TOKEN_ghp_...` is caught too). Redaction always runs on
  whole lines or on a window wider than the caller sees: `claude_check`'s `tailBytes` is
  caller-controlled, so `readRedactedTail()` reads `tailBytes` plus a margin (at least 512 bytes and
  twice the longest value), redacts that, drops the partial first line, and only then cuts to
  `tailBytes`; the runner's 64 KiB exit-tail window drops its partial first line before redacting.
  A window that would start inside a token can therefore never return the token's suffix.
  - `exit.json`'s `stdoutTail`/`stderrTail` (the runner redacts before writing);
  - the Discord ping: its headline is the first meaningful stdout line, and every candidate line is
    redacted before one is picked;
  - `claude_check` and `GET /v1/check`: `checkJob()` redacts a container job's stdout/stderr tails
    and exit tails before returning them (they go to a chat session, or to another host).
  The dispatch card never carries job output: it holds the intent or prompt summary from the
  dispatcher and a done/fail disposition (host jobs also get a delivery HEAD sha; container jobs
  don't), so it needs no redaction.
- **Who can read the raw logs.** The job dirs live in `%USERPROFILE%\.claude-async-jobs` and inherit
  the profile's ACL: Erick's account, SYSTEM and the local Administrators group. Anything running as
  Erick (including host-mode jobs) can read them. Treat them as holding the tokens.
- **Why not Docker secrets?** Docker secrets (`/run/secrets/...`) are a Swarm/Compose feature, and a
  mounted secrets file would be readable by the same job user anyway. gh and Claude Code read their
  tokens from environment variables, so the env file is simplest.

## Claude Code authentication inside the container

Verified against Anthropic's authentication docs
(<https://code.claude.com/docs/en/authentication>, section "Generate a long-lived token"; fetched
by an earlier run of this work, not re-fetched this time):

> For CI pipelines, scripts, or other environments where interactive browser login isn't
> available, generate a one-year OAuth token with `claude setup-token` ... copy it and set it as
> the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate ... This
> token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise
> plan. It can only make model requests.

The same page's precedence list ranks `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then
`apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then `/login` credentials. That is why the env file
may not carry `ANTHROPIC_API_KEY`, and why a repo-supplied `apiKeyHelper` mattered (it outranks the
OAuth token). `--bare` mode does not read `CLAUDE_CODE_OAUTH_TOKEN`, so container jobs never pass
`--bare`.

Run `claude setup-token` once on claunker, in a browser session logged in to Erick's subscription,
and put the printed token in the secrets file. It lasts one year; set a reminder to regenerate it.
The container never sees `%USERPROFILE%\.claude`, so Erick's interactive login is untouched. The
image sets `hasCompletedOnboarding` in `/home/agent/.claude.json`, so `claude -p` doesn't stop at
first-run setup.

## Ollama delegation

Jobs delegate eligible work to `qwen2.5-coder:7b` on the host's Ollama. Inside the container,
`localhost:11434` is the container itself, so `--add-host host.docker.internal:host-gateway` is
passed (phase 1) and `OLLAMA_HOST`/`CLAUDE_ASYNC_OLLAMA_URL` are set to
`http://host.docker.internal:11434` (override: `CLAUDE_ASYNC_CONTAINER_OLLAMA_URL`). Erick's global
CLAUDE.md names `127.0.0.1:11434`, which is wrong inside the container; the container's CLAUDE.md
overrides it, and job prompts should say "use `$OLLAMA_HOST`". If Ollama is reachable on the host
but not from the container, set `OLLAMA_HOST=0.0.0.0:11434` for the Ollama service and allow the
port through Windows Firewall for the WSL/Docker virtual adapter only. The smoke test checks
reachability and that `qwen2.5-coder:7b` is listed.

## Git identity

job-core sets `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` and `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL`
from `CLAUDE_ASYNC_CONTAINER_GIT_NAME` and `CLAUDE_ASYNC_CONTAINER_GIT_EMAIL` (required). Use the
bot's noreply address (`<id>+<login>@users.noreply.github.com`, under the bot's Settings, Emails) so
commits link to the bot account. The clone is made on Linux inside the container, so the old
`core.autocrlf` pass-through for Windows checkouts is gone.

## How jobs open PRs

```
git switch -c feat/short-slug
... work, commit ...
git push -u origin feat/short-slug
gh pr create --base <branch> --fill
```

`--base` must be a **branch**: `$CLAUDE_ASYNC_BASE_REF` when it names one (a detached checkout of
`origin/<branch>`), otherwise the job has to pick one, normally the default branch, since a PR
cannot target a tag or a commit. `container/CLAUDE.md` says the same. The job prints `PR: <url>` in
its final message. The runner records the URL in
`exit.json.container.prUrl` when it names the job's own repo, so `claude_check` shows what was
delivered. `scripts/publish-branch.mjs` is not used inside the container: its checks would be
advisory there, and the real limits are server-side (collaborator list, token scopes, the `main`
ruleset).

**Cross-owner contributions (forks):** when the bot isn't a collaborator,
`gh repo fork --remote --remote-name fork`, push to `fork`, and
`gh pr create --repo <owner>/<repo> --head <bot-login>:<branch>`. That needs a classic token. The
upstream repo still has to be in `CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS`, since that is what is cloned.

## Identity: the bot account and its token

### One machine account is allowed

GitHub's Terms of Service, section B.3 "Account Requirements"
(<https://docs.github.com/en/site-policy/github-terms/github-terms-of-service>):

> One person or legal entity may maintain no more than one free Account ... We do permit machine
> accounts: A machine account is an Account set up by an individual human who accepts the Terms on
> behalf of the Account, provides a valid email address, and is responsible for its actions. A
> machine account is used exclusively for performing automated tasks. ... You may maintain no more
> than one free machine account in addition to your free Personal Account.

### Classic PAT, not fine-grained

Fine-grained tokens can't "contribute to repositories where the user is an outside or repository
collaborator" and can't write to public repos the user doesn't own
(<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>).
The bot is a repository collaborator on Erick's repos, so it needs a **classic** PAT.

| scope | why |
|---|---|
| `repo` | Push branches and open PRs on Erick's **private** repos where the bot is a collaborator. If every target repo is public, use `public_repo` instead. |
| `workflow` | **Leave it off.** Without it GitHub rejects pushes that touch `.github/workflows/`. It does not stop a job editing a script an existing workflow runs (see the threat model). |

Nothing else: no `delete_repo`, `admin:*`, `write:packages`, `gist` or `user`. A classic `repo`
token reaches every repo the bot is a collaborator on, so the collaborator list is the token's scope.
Set an expiration (90 days is reasonable) and rotate.

### Server-side backstops

- **`main` requires a PR with 1 approval from the owner** (a repository ruleset on each repo the bot
  can push to, with Erick as a bypass actor so his own workflow is unchanged). The bot cannot push to
  `main`, and a PR author can't approve its own PR, so nothing the bot writes reaches `main` without
  Erick's approval. Plus the existing no-deletion and no-force-push rules. Two details to set in the
  same ruleset: **"Dismiss stale pull request approvals when new commits are pushed"** and **"Require
  approval of the most recent reviewable push"**, so the bot can't add commits after Erick approves.
  Note that with only the approval rule, the bot (write access) could still press merge on a PR
  Erick has approved; the merged content is then exactly what he approved. If only Erick should ever
  merge, also turn on **"Restrict updates"** with Erick as the bypass actor (I believe that blocks
  merges by anyone else too, but have not verified it on GitHub). `container/CLAUDE.md` tells the
  bot never to merge or approve.
- **Collaborator permission level.** Personal-account repos have one collaborator level (write), so
  the bot could otherwise merge PRs and close issues; the approval rule is what stops it merging.
  (The single-level statement is from prior knowledge; GitHub's page could not be fetched.)

## Network egress

### Phase 1 (implemented): default bridge network

`--network bridge` (configurable with `CLAUDE_ASYNC_CONTAINER_NETWORK`; `host` and `none` are
refused). The job can reach the internet, the LAN and the tailnet (see the threat model). The image
sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`, so the CLI itself
makes no telemetry, error-reporting or update calls.

Inter-container traffic: Docker's default `bridge` network allows container-to-container
connections, so concurrent jobs can reach each other's listening ports (they share the same tokens
anyway; what this exposes is one job tampering with a service another job started). A dedicated
user network with ICC off keeps normal egress and removes that:

```powershell
docker network create -o com.docker.network.bridge.enable_icc=false claude-jobs-p1
# then: CLAUDE_ASYNC_CONTAINER_NETWORK=claude-jobs-p1
```

This is recommended but was not tested on Docker Desktop here.

### Phase 2 (designed, not implemented): egress allowlist

The job runs on an **internal** Docker network with no route out. A small proxy container is the
only thing attached to both that network and a normal one, and it allows a fixed list of hosts.

```
            claude-jobs  (internal, 172.30.0.0/24, ICC off)
  +--------------------+          +--------------------------+       bridge
  |  job container     | -------> | egress-proxy (squid)     | ----> internet (allowlisted hosts)
  |  HTTPS_PROXY=      |  :3128   | on claude-jobs + bridge  | ----> host.docker.internal:11434
  |  http://egress-    |          +--------------------------+       (GET/POST to 4 Ollama paths)
  |  proxy:3128        |
  +--------------------+   no other route out, no host gateway
```

One-time setup on claunker (an explicit subnet, so the squid ACL can name it exactly):

```powershell
docker network create --internal --subnet 172.30.0.0/24 `
  -o com.docker.network.bridge.enable_icc=false claude-jobs
docker run -d --name egress-proxy --restart unless-stopped `
  --network bridge --add-host host.docker.internal:host-gateway `
  -v D:\claude-async-proxy\squid.conf:/etc/squid/squid.conf:ro ubuntu/squid:<pinned>
docker network connect --ip 172.30.0.2 claude-jobs egress-proxy
```

`squid.conf` (CONNECT-only for TLS, so squid sees hostnames, never content; Ollama is plain HTTP, so
it is never a CONNECT target and is limited to the four read/generate paths):

```
http_port 3128
acl jobs src 172.30.0.0/24
acl ssl_ports port 443
acl CONNECT method CONNECT
acl allowed_tls dstdomain github.com api.github.com codeload.github.com uploads.github.com
acl allowed_tls dstdomain objects.githubusercontent.com release-assets.githubusercontent.com raw.githubusercontent.com
acl allowed_tls dstdomain registry.npmjs.org pypi.org files.pythonhosted.org
acl allowed_tls dstdomain api.anthropic.com
acl ollama_host dstdomain host.docker.internal
acl ollama_port port 11434
acl ollama_methods method GET POST
acl ollama_paths urlpath_regex ^/api/(generate|chat|tags|show)$
http_access allow jobs CONNECT ssl_ports allowed_tls
http_access allow jobs !CONNECT ollama_host ollama_port ollama_methods ollama_paths
http_access deny all
access_log stdio:/proc/self/fd/1
```

Then on the bridge: `CLAUDE_ASYNC_CONTAINER_NETWORK=claude-jobs` and
`CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY=http://172.30.0.2:3128` (or `http://egress-proxy:3128`).
With the proxy set, `container.mjs` adds `HTTPS_PROXY`/`HTTP_PROXY` (both cases) and `NO_PROXY`, and
**omits** `--add-host host.docker.internal:host-gateway`, so the only way to the host is through the
proxy's Ollama rule. The CLI's proxy support is unverified (its network-config page could not be
fetched); the smoke test should confirm one real call through the proxy. With the two traffic
variables set, Claude Code should need only `api.anthropic.com`; verify with squid's access log.

Trade-offs: the proxy sees hostnames, not content, so `github.com` allows pushing to any repo the
token can reach, and a job can still exfiltrate through an allowed host (a gist, a PR comment).
Phase 2 removes "send it anywhere", the LAN/tailnet routes and the host-loopback path. It doesn't
remove "send it to GitHub".

## Resource limits

| flag | default | env override |
|---|---|---|
| `--cpus` | `4` (clamped to the CPUs the host reports) | `CLAUDE_ASYNC_CONTAINER_CPUS` |
| `--memory` and `--memory-swap` (same value, no swap on top) | `8g` | `CLAUDE_ASYNC_CONTAINER_MEMORY` |
| `--pids-limit` | `1024` | `CLAUDE_ASYNC_CONTAINER_PIDS_LIMIT` |
| wall-clock limit (runner-enforced) | 4h | `CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS` (60000 to 604800000) |

The runner's heartbeat never goes stale while it is alive, so `CLAUDE_ASYNC_JOB_TIMEOUT_MS` alone
would never stop a hung container. Past the wall-clock limit the runner removes the container (the
bounded stop under "Lifecycle"), and the job reads `status: "timed_out"` with
`exit.exitReason: "container_max_runtime"`, also when the client had to be killed. These limits
apply inside Docker Desktop's WSL2 VM, whose size is set in `%USERPROFILE%\.wslconfig`. Disk isn't
limited per container; the clone and everything else live in the writable layer and go with `--rm`.

## Lifecycle, cancel and cleanup

- `--rm`, `--init`, `--name claude-async-<jobId>` (for humans) and
  **`--label claude-async.job=<jobId>`, the identity every cleanup uses.** Job ids are unique per job
  dir, so the label is too.
- **Cleanup = remove by label.** `docker ps -a --filter label=claude-async.job=<jobId>` lists the
  job's containers by immutable ID, `docker rm -f <id>` removes each (a running one is killed first;
  one still in the Created state is removed, which `docker kill` would miss), and the list is taken
  again. Nothing is ever killed by name, and a container named like ours without the label is never
  touched.
- **Cleanup state is separate from the CLI's exit.** `exit_code` says the docker client exited; it
  does not say nothing is running (the client can exit, or be killed, while its container keeps
  going, and the final removal can fail while the daemon is unreachable). Cleanup is **confirmed**
  only when, in this order, (1) no launch can still be pending and (2) docker then lists nothing
  with the label. "No launch pending" is decided from the runner's **launch state file**
  `docker_launch`, written `pending` *before* `docker run` is spawned, `spawned` (with the client's
  pid, also in `docker_client.pid`) right after, `exited` when the client ended on its own, or
  `killed` when a stop fallback had to kill it. A launch is still pending while the recorded client
  pid is alive (even after `exit_code` exists), while the runner is alive, while any process whose
  command line carries the job's `--label claude-async.job=<id>` exists (a process scan, which also
  finds a client whose pid was never recorded because the runner died between the spawn and the pid
  write, and on Windows the `com.docker.cli.exe` child that `docker.exe` hands its work to), and for
  `CLAUDE_ASYNC_CONTAINER_CONFIRM_HOLD_MS` (2 min) after a client was killed, because its create
  request may still be in flight daemon-side. Liveness first, listing second: a client that creates
  its container and exits between the two observations is then seen by the listing. The runner
  records its result in `exit.json.container.cleanup.confirmed`; job-core records a later
  confirmation in `meta.json.containerCleanup`. `claude_check` shows
  `containerCleanup: "confirmed" | "unconfirmed"` for a finished job and retries an unconfirmed
  cleanup on every call. The concurrency-cap count never does docker housekeeping, but **a container
  job holds a `CLAUDE_ASYNC_MAX_CONCURRENT` slot until its cleanup is confirmed**, whatever its
  status, since its container may still be using the VM's CPUs and memory; a `claude_check` (or
  `claude_jobs`) is what confirms it.
- **Cancel = `claude_cancel`** (routed by host prefix; `POST /v1/cancel` on a remote host):
  1. The cancel intent is written first, as `cancel_requested` in the job dir.
  2. The job's containers are removed by label. If none exists yet, the answer says so
     (`cleanup: "pending"`), never "done".
  3. The runner checks `cancel_requested` before `docker run` (the container is then never started)
     and polls it while the client runs, so a container that was still being created when the cancel
     arrived is removed the moment it exists. The client then exits 137 and the runner records
     `exitReason: "cancelled"`, the card close and the Discord ping through its normal path. If the
     client does not exit (the daemon ignores or fails the removal), the **bounded stop** below
     applies: after `CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS` the runner kills the client and finishes
     with `exitReason: "cancelled"` and cleanup NOT confirmed; `claude_check` keeps retrying.
  4. On a job that already finished, `claude_cancel` is the cleanup retry: it returns
     `alreadyFinished: true` only once cleanup is confirmed.
- **One bounded stop for cancel, the wall-clock limit and SIGTERM/SIGINT/SIGHUP/SIGBREAK**: remove
  by label now, retry at most every `CLAUDE_ASYNC_CONTAINER_RM_RETRY_MS` (5 s; the docker calls are
  synchronous, so a retry per poll tick would starve the heartbeat), and wait for the client up to
  `CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS` (30 s). If it never exits (a wedged or unreachable daemon),
  the runner kills the client, finishes with the terminal result (`cancelled`, `container_max_runtime`
  which reads `timed_out`, or `signal`), records `docker_launch` = `killed` and the cleanup as NOT
  confirmed (`clientKilled: true`), and never claims the container was removed; `claude_check`
  confirms it later under the launch-state rules.
- **A runner that died** (`taskkill /F`, `TerminateProcess`): `claude_check` classifies the job
  `died`/`timed_out`, writes `cancel_requested` (so a slow runner never starts docker), removes by
  label, and confirms only under the launch-state rules above (recorded client gone, no process with
  the job's label, hold after a kill). On Docker Desktop for Windows `docker.exe` may spawn
  `com.docker.cli.exe` to do the actual work; `TerminateProcess` on `docker.exe` does not kill that
  child (not verified here: no Windows). The label-based process scan and the label-based container
  listing are the backstop for that case, not the pid.
- Verified with a real Docker engine (Linux, not Docker Desktop): cancel right after launch never
  started the container; cancel while running and SIGTERM gave exit 137 with cleanup confirmed; the
  wall-clock limit gave `timed_out`; a normal run confirmed cleanup; no labelled container was left.
  `docker rm -f` of a running attached container makes the client exit 137, and `docker rm -f` of a
  missing container exits 0 on Docker 29, which is why absence is confirmed by listing, not by exit
  status.

## Windows specifics

- **Mount paths** (only the two read-only ones now): `toDockerMountSource()` turns `D:\code\x` into
  `D:/code/x`. Commas, quotes and UNC paths are refused.
- **The docker binary.** `CLAUDE_ASYNC_DOCKER_BIN` (default `docker`). Under Task Scheduler, PATH
  may not include Docker Desktop's `C:\Program Files\Docker\Docker\resources\bin`, so set the full
  path to `docker.exe`.
- **Docker Desktop must be running.** Preflight runs `docker image inspect` and refuses the job with
  "is Docker Desktop running?" otherwise.
- **Line endings.** `.gitattributes` keeps `*.sh` and the Dockerfile LF in a Windows checkout, and the
  Dockerfile strips CRs from the entrypoint as a belt.

## What keeps working, and how

| feature | container jobs |
|---|---|
| job record (`meta.json`, `spec.json`) | plus `sandbox: "container"` and `container: {name, jobId, image, imageId, dockerBin, repo, baseRef, envFile}` in meta (envFile is a path); `workFolder` is `null` |
| heartbeat, `runner.pid`, Job Object records | unchanged |
| stdout/stderr capture | unchanged on disk; redacted in exit.json, claude_check and the ping |
| `exit.json`, `exit_code`, status | unchanged, plus `exit.container` = `{name, repo, prUrl, cleanup, cancelled, maxRuntimeExceeded}`; 125 = docker run failed, 70 = clone failed, 137 = removed/killed |
| DELEGATION-METRICS completeness | unchanged (read off stdout) |
| card hook | mint and close unchanged; no HEAD lookup and no delivery check for container jobs (no host git). The PR URL is in `exit.container.prUrl` |
| Discord ping | unchanged apart from headline redaction |
| concurrency and rate caps, depth guard | unchanged; `CLAUDE_ASYNC_DEPTH` is forwarded into the container |
| HERMES_HOME isolation | not applied (the container never sees the host env) |
| multi-host | `sandbox`/`repo`/`baseRef` are forwarded when given; `claude_cancel` routes by host prefix |

## Sandbox policy

`CLAUDE_ASYNC_ALLOWED_SANDBOXES` lists the modes a host runs at all: `host` (default),
`container`, or `host,container`. The mode a job ends up with (requested, or from
`CLAUDE_ASYNC_JOB_SANDBOX`) must be in the list; an invalid value refuses every start. It is checked
in `startJob()` before the job dir exists, so the local MCP tools and `POST /v1/start` are covered
alike. A host with `CLAUDE_ASYNC_JOB_SANDBOX=container` and `CLAUDE_ASYNC_ALLOWED_SANDBOXES=container`
refuses `sandbox: "host"` from any caller; a host on the default policy refuses `sandbox: "container"`.

## Configuration reference

All set on the bridge process (ecosystem.config.cjs `env`, or the Claude Desktop MCP server entry's
`env`). They are read by job-core at start time.

| variable | default | notes |
|---|---|---|
| `CLAUDE_ASYNC_ALLOWED_SANDBOXES` | `host` | `host`, `container` or `host,container` |
| `CLAUDE_ASYNC_JOB_SANDBOX` | unset (host) | exactly `container` makes container mode the default |
| `CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS` | **none** (required) | `owner/repo` entries; only repos the bot is a collaborator on |
| `CLAUDE_ASYNC_CONTAINER_ENV_FILE` | **none** (required) | the host secrets file, outside the claude-async checkout |
| `CLAUDE_ASYNC_CONTAINER_GIT_NAME` / `_GIT_EMAIL` | **none** (required) | the bot's commit identity |
| `~/.claude-async/http.json` | absent | **required for container mode**: the HTTP bridge's token hash (`node claude-async-http.mjs --new-token`); the bridge refuses to start without it once container mode is allowed |
| `CLAUDE_ASYNC_HTTP_PORT` | `7842` | the bridge port the lock check probes |
| `CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED` | unset | bridge only: explicit, logged opt-out to start without a token; rejected when container mode is allowed |
| `CLAUDE_ASYNC_TLS_CERT` / `_KEY` | unset | bridge TLS; when set on the admitting process too, the lock probe uses https |
| `CLAUDE_ASYNC_CONTAINER_IMAGE` | `claude-async-job:local` | built on claunker, never pulled; jobs run its inspected ID |
| `CLAUDE_ASYNC_DOCKER_BIN` | `docker` | set the full path to `docker.exe` |
| `CLAUDE_ASYNC_CONTAINER_CPUS` / `_MEMORY` / `_PIDS_LIMIT` | `4` / `8g` / `1024` | |
| `CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS` | `14400000` (4h) | runner-enforced wall-clock limit |
| `CLAUDE_ASYNC_CONTAINER_NETWORK` | `bridge` | `host` and `none` are refused |
| `CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY` | unset | phase 2 |
| `CLAUDE_ASYNC_CONTAINER_OLLAMA_URL` | `http://host.docker.internal:11434` | |
| `CLAUDE_ASYNC_CONTAINER_CLAUDE_MD` | `container/CLAUDE.md` | |
| `CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS` | `30000` | runner: how long to wait for the client after a signal, cancel or the wall-clock limit before killing it |
| `CLAUDE_ASYNC_CONTAINER_RM_RETRY_MS` | `5000` | runner: minimum gap between removal retries during a stop |
| `CLAUDE_ASYNC_CONTAINER_CONFIRM_HOLD_MS` | `120000` | job-core: how long after a killed docker client an empty listing does not yet confirm cleanup |

Removed in review round 1: `CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS`, `_DENIED_ROOTS` and
`_GIT_AUTOCRLF` (no host folder is mounted any more).

The `docker run` argv a job gets (sample job; placeholder secrets path and image ID):

```
docker run --rm --pull=never --name claude-async-claunker.demo-20261101-abcd1234
  --label claude-async.job=claunker.demo-20261101-abcd1234 --init --user 1000:1000
  --security-opt no-new-privileges --cap-drop ALL
  --cpus 4 --memory 8g --memory-swap 8g --pids-limit 1024
  --network bridge --add-host host.docker.internal:host-gateway
  --env-file C:\Users\Raide\.claude-async-secrets\container.env
  -e CLAUDE_ASYNC_JOB_ID=claunker.demo-20261101-abcd1234 -e CLAUDE_ASYNC_SANDBOX=container
  -e CLAUDE_ASYNC_REPO=icey2488/container-job-scratch
  -e CLAUDE_ASYNC_DEPTH=1 -e CLAUDE_ASYNC_JOB_EFFORT=medium
  -e CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=7200000 -e CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
  -e BASH_MAX_TIMEOUT_MS=1200000
  -e GIT_AUTHOR_NAME=claunker-bot -e GIT_COMMITTER_NAME=claunker-bot
  -e GIT_AUTHOR_EMAIL=<id>+claunker-bot@users.noreply.github.com -e GIT_COMMITTER_EMAIL=<same>
  -e OLLAMA_HOST=http://host.docker.internal:11434 -e CLAUDE_ASYNC_OLLAMA_URL=http://host.docker.internal:11434
  --mount type=bind,source=D:/code/claude-async/container/CLAUDE.md,target=/home/agent/.claude/CLAUDE.md,readonly
  --mount type=bind,source=D:/code/claude-async/hooks,target=/opt/claude-async/hooks,readonly
  --workdir /workspace
  sha256:<64 hex>
  /usr/local/bin/claude-async-job-entry icey2488/container-job-scratch "" --
  claude -p --dangerously-skip-permissions --setting-sources user --strict-mcp-config
    --mcp-config {"mcpServers":{}} --model=claude-sonnet-5 --effort medium
    --settings {"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"env -u NODE_OPTIONS /usr/local/bin/node /opt/claude-async/hooks/no-background-hook.mjs","timeout":5}]}]}}
    -- <prompt>
```

Each token is one argv element (no shell). The prompt is last, after `--`, and the model is bound
with `=`.

## The image

`container/Dockerfile`, built on claunker (never pulled):

- Base: `node:24-bookworm-slim`, pinned to the major tag until the first build records its digest
  (rollout step 7).
- gh 2.89.0 and uv 0.13.6 from GitHub release tarballs, each checked against a pinned SHA-256.
- **Claude Code 2.1.309 from verified bytes, with no `npm install` and no package script.** The
  build `npm pack`s the exact wrapper and linux-x64 tarballs, computes each sha512 itself (openssl,
  base64) and compares it with the pinned integrity before extracting anything, checks the wrapper's
  package.json names the same version and pins the same linux-x64 version, and places the native
  binary at `/usr/local/lib/claude-code/claude` (root-owned) with a `/usr/local/bin/claude` link.
  That is exactly what the wrapper's `install.cjs` postinstall does, so neither it nor npm's
  optional-dependency fetch ever runs. `NPM_CONFIG_REGISTRY` may name a mirror; the hashes decide.
  Verified in local builds against a controlled registry that serves the pinned metadata first and a
  self-consistent malicious wrapper afterwards: the previous Dockerfile passed both `npm view` checks,
  installed the substitute and ran its postinstall; this one fails with `INTEGRITY MISMATCH` before
  extraction and produces no image; against the real registry it verifies both tarballs and builds.
  To bump: change `CLAUDE_CODE_VERSION` and the two integrity args (`npm view
  @anthropic-ai/claude-code@<v> dist.integrity`, same for `-linux-x64`), ideally checked against a
  second network path.
- Debian packages aren't version-pinned. Rebuild to pick up security fixes.
- User `agent`, uid/gid 1000; `~/.claude` root-owned as described above; the entrypoint and the
  github.com credential helper as described in "The clone inside the container".
- **Built and checked in this sandbox** on a test-only base (Ubuntu noble plus Node 24, because Docker
  Hub isn't reachable from here). Every other line ran as written. The real `node:24-bookworm-slim`
  build happens on claunker in the smoke test.

## Rollout checklist

Do these in order on claunker. Each step says how to check it.

1. **Install Docker Desktop** (admin) with the WSL2 backend. In Settings: "Start Docker Desktop when
   you sign in" on; **leave "Expose daemon on tcp://localhost:2375 without TLS" off**. Size the VM in
   `%USERPROFILE%\.wslconfig`, then `wsl --shutdown` and restart Docker Desktop.
   Check: `docker version` shows a Server section; `docker run --rm hello-world` works.
2. **Create the bot account** (one free machine account next to `icey2488`; ToS B.3 above), with its
   own email and 2FA, "Keep my email address private" on, and note its noreply address.
3. **Rulesets first, then invite.** On each repo the bot will push to, add a ruleset for the default
   branch: require a pull request with **1 approval** (with "dismiss stale approvals" and "require
   approval of the most recent reviewable push"), Erick (`icey2488`) as a bypass actor, plus no
   deletion and no force-push; optionally "Restrict updates" so only Erick can merge (see
   "Server-side backstops"). Then invite the bot as a collaborator, starting with one scratch
   repo (`icey2488/container-job-scratch`, private). Don't invite it to any repo whose CI holds
   secrets or runs on a self-hosted runner until that CI is reviewed.
   Check: as the bot, `git push origin HEAD:main` to the scratch repo is rejected, and the bot
   cannot merge a PR it opened.
4. **Create the classic PAT** as the bot: scopes **`repo`** only (or `public_repo`), no `workflow`,
   90-day expiry.
5. **Generate the Claude Code token** as Erick: `claude setup-token`; one year; set a reminder.
6. **Write the host secrets file** outside every repo, readable only by Erick's user (values read
   as secure strings, never echoed, never on a command line):

   ```powershell
   $dir  = Join-Path $env:USERPROFILE ".claude-async-secrets"
   $file = Join-Path $dir "container.env"
   New-Item -ItemType Directory -Force -Path $dir | Out-Null
   $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   icacls $dir /inheritance:r /grant:r "${me}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
   function Read-Plain([string]$prompt) {
     $s = Read-Host -AsSecureString $prompt
     $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
     try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
   }
   $gh = Read-Plain "Bot classic PAT (GH_TOKEN)"
   $cc = Read-Plain "Claude Code token from 'claude setup-token' (CLAUDE_CODE_OAUTH_TOKEN)"
   # LF endings, no BOM, no quotes or spaces: docker keeps all of those in the values.
   $body = "GH_TOKEN=$($gh.Trim())`nCLAUDE_CODE_OAUTH_TOKEN=$($cc.Trim())`n"
   [IO.File]::WriteAllText($file, $body, (New-Object Text.UTF8Encoding($false)))
   Remove-Variable gh, cc, body
   icacls $file /inheritance:r /grant:r "${me}:F" "SYSTEM:F" | Out-Null
   ```

   Check: `(Get-Content $file | ForEach-Object { ($_ -split '=')[0] })` prints the two key names.
7. **Lock the HTTP bridge**: `node claude-async-http.mjs --new-token`, then restart it
   (`pm2 restart claude-async-http`, or stop it if nothing uses it). Give the token to anything that
   still needs the bridge (`Authorization: Bearer <token>`). Check:
   `curl -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:7842/mcp` prints `401`. Do this
   **before** step 9: once `CLAUDE_ASYNC_ALLOWED_SANDBOXES` includes `container`, the bridge refuses
   to start without the token (its log then says `refusing to start ... --new-token`), and its
   supervisor must pass the same `CLAUDE_ASYNC_CONFIG_DIR`/`CLAUDE_ASYNC_HTTP_PORT` as the MCP server
   process that admits jobs.
8. **Build the image and run the smoke test**, from `D:\code\claude-async`:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1 -SkipBuild `
     -EnvFile "$env:USERPROFILE\.claude-async-secrets\container.env" -RunClaude `
     -LanTargets "<hermes-host>:<port>","<ha-host>:8123"
   ```

   Every line must be PASS or WARN. Read the loopback-forwarding line (it is measured) and every
   WARN. A FAIL on 7842/2375/2376 means stop. Then pin the base image digest
   (`docker image inspect node:24-bookworm-slim --format "{{index .RepoDigests 0}}"` into
   `ARG NODE_IMAGE=...@sha256:...`) in a small commit.
9. **Configure the bridge** (container mode still off), then restart it with
   `tools\restart-bridge.ps1 -RequestedBy manual`:

   ```
   CLAUDE_ASYNC_ALLOWED_SANDBOXES=host,container
   CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS=icey2488/container-job-scratch
   CLAUDE_ASYNC_CONTAINER_ENV_FILE=C:\Users\Raide\.claude-async-secrets\container.env
   CLAUDE_ASYNC_CONTAINER_GIT_NAME=claunker-bot
   CLAUDE_ASYNC_CONTAINER_GIT_EMAIL=<id>+claunker-bot@users.noreply.github.com
   CLAUDE_ASYNC_DOCKER_BIN=C:\Program Files\Docker\Docker\resources\bin\docker.exe
   ```

   Remove any `CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS`/`_DENIED_ROOTS`/`_GIT_AUTOCRLF` from an earlier
   draft; they are ignored now. No job clones under `D:\code\jobs` are needed any more.
10. **Run one container job end to end**: `claude_start` with `host: "claunker"`,
    `sandbox: "container"`, `repo: "icey2488/container-job-scratch"`, and a prompt like "Create a
    branch docs/container-smoke, add a README line saying hello from the container, commit, push the
    branch, open a PR to main and print its URL. Delegate the README wording to qwen2.5-coder:7b
    through $OLLAMA_HOST. End with the delegation report." Check: `claude_check` shows
    `sandbox: "container"`, status `completed`, `containerCleanup: "confirmed"` and
    `exit.container.prUrl`; the commit author and PR opener are the bot; the delegation report shows
    an Ollama call; the card and the Discord ping arrived; `docker ps -a --filter
    label=claude-async.job` is empty. Then start a long job and `claude_cancel` it: it reports
    `failed`, `exitReason: "cancelled"`, cleanup confirmed. Review and merge the PR yourself.
11. **Widen slowly.** Add one real repo to the allowlist (and the ruleset on it) once the scratch runs
    are routine. Schedule phase 2 before any repo with third-party install scripts.

### Rollback

- **Stop using it:** set `CLAUDE_ASYNC_ALLOWED_SANDBOXES=host` (or unset it) and restart the bridge.
  Every container start is then refused before anything is written.
- **Cut off the credentials:**
  - Bot PAT: as the bot, Settings, Developer settings, Personal access tokens, Tokens (classic),
    Delete. Remove the bot as a collaborator on each repo.
  - Claude Code setup-token: **unverified**. I could not confirm a per-token revoke procedure for
    `claude setup-token` tokens (Anthropic's docs pages could not be fetched this time, and the CLI
    has no revoke command). Look in the claude.ai account settings for the Claude Code / authorized
    apps or sessions list and revoke it there; if no per-token control exists, ask Anthropic support,
    and treat the token as live until it expires (one year).
  - Then delete `%USERPROFILE%\.claude-async-secrets\container.env`. Container jobs fail in preflight.
- **Remove the code:** revert this PR's merge commit. Host mode is the same with or without it.
- **Remove Docker:** `docker image rm claude-async-job:local`, then uninstall Docker Desktop if
  nothing else uses it.

## Review round 1: questions answered

- **Can concurrent jobs share a clone?** No. Each container clones its own copy into its own
  writable layer, and nothing is shared or mounted read-write.
- **Token values in out.log?** A job can print `$GH_TOKEN` (or read the OAuth token from `/proc`), and
  `out.log` keeps it. The job dirs are readable by Erick's account, SYSTEM and Administrators. What
  leaves the runner (exit.json tails, the Discord ping, `claude_check`) is redacted; the card never
  carries output. See "Output redaction".
- **`workflow` scope?** Omitting it doesn't stop a job editing a script an existing workflow runs.
  Don't invite the bot to repos whose CI holds secrets until reviewed.
- **Does `findUnsafeConfig()` / the `.git` audit cover enough?** Moot: there is no host clone and no
  audit any more.
- **Mount-path races, NTFS junctions, container-created symlinks?** Moot for the repo: nothing
  writable is mounted. The two read-only mounts are files in the claude-async checkout.
- **Duplicate runners, name reuse?** Cleanup acts only on containers carrying this job's
  `claude-async.job` label, by immutable ID. A duplicate start is refused by the job-dir check.
- **Repo-local Claude settings, `apiKeyHelper`?** Ignored (`--setting-sources user`), verified.
- **Wall-clock limit?** Yes now: 4h default, runner-enforced.
- **Phase 1 risk.** Phase 1 is an accepted credential-theft risk for a limited pilot (one scratch repo
  first, no third-party install scripts, short collaborator list), with the revoke steps above.

## Verified here vs assumed

Verified in this sandbox (Linux, a real Docker engine, a test-only base image):

- the image builds; the verified-bytes install rejects a substituted tarball and the old method did
  not; `claude --version` and a full headless turn with a Bash tool call run in the image;
- `--setting-sources user` ignores a hostile repo's settings, hooks, `apiKeyHelper` and `.mcp.json`
  (fake API, control run included); `~/.claude` is unwritable; the CLI writes only the listed dirs;
- the Bash tool's environment lacks `CLAUDE_CODE_OAUTH_TOKEN` but `/proc/<pid>/environ` has it;
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` needs bubblewrap;
- the entrypoint's clone, base-ref and failure paths (against a local repo via a git URL rewrite),
  and the gh credential helper answering from `GH_TOKEN`;
- run-by-ID after a tag retarget, and `--pull=never` with a missing tag (exit 125);
- cancel at launch, cancel while running, SIGTERM, the wall-clock limit and cleanup confirmation with
  the real runner and engine; `docker rm -f` semantics;
- `container/probe.sh` against open, closed and unresolvable targets in a hardened container;
- the HTTP bridge script with and without a token (401 / 200).

Not verified here:

- Docker Desktop on Windows, the real `node:24-bookworm-slim` base, host Ollama, and whether
  `host.docker.internal` reaches the Windows host's `127.0.0.1` (the smoke test measures it);
- `container/smoke-test.ps1` itself: no PowerShell was available, so its PowerShell logic was
  reviewed but never run;
- a real `claude -p` on the subscription token, and real GitHub clone/push/PR as the bot;
- the ICC-off phase-1 network and the phase-2 proxy;
- whether the app's Connectors UI can send a bearer header to the HTTP bridge;
- a revoke path for `claude setup-token` tokens; GitHub's collaborator-level page; Anthropic's
  install and network-config pages (not fetchable from here).
