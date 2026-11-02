# Container jobs (`sandbox: "container"`)

Container jobs run the Claude Code CLI inside a Docker container on claunker instead of on the bare
Windows host. A container job gets a full shell and runs with `--dangerously-skip-permissions`. It
names a GitHub repo; the container clones that repo itself, works in container-local storage,
pushes a branch and opens a PR as a **GitHub App** owned by Erick's account and installed only on
the repos jobs may touch, never as Erick himself. The host mints a one-hour installation token
scoped to that one repo per job and hands it to the container as a file; there is no bot account
and no long-lived GitHub token anywhere. **No host folder is mounted read-write.** Nothing the job
writes reaches the host disk except the runner's captured stdout/stderr. `main` requires a PR with
the owner's approval: the App opens PRs, Erick approves and merges them, and the App cannot push to
or merge into `main`.

Container mode is **opt-in, off by default, and gated twice**: the call (or
`CLAUDE_ASYNC_JOB_SANDBOX`) must ask for it, and the host policy `CLAUDE_ASYNC_ALLOWED_SANDBOXES`
must allow it (default: `host` only). Windows-admin jobs (scheduled tasks, services, firewall checks)
stay on the host under the existing modes: skip-permissions, or safe mode
(`CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS=1`). When container mode is not used, every job's argv,
environment and `spec.json` are unchanged (a test asserts the literal host argv).

| piece | file |
|---|---|
| argv building, validation, cleanup by label, redaction, bridge lock check | `container.mjs` |
| GitHub App: JWT, installation lookup, token minting, App identity, key-file checks | `github-app.mjs` |
| launch integration (`sandbox`/`repo`/`baseRef`, preflight incl. the App, `cancelJob`, cleanup state) | `job-core.mjs` |
| runner: token file mint/refresh/delete, cancel intent, cleanup on every stop, wall-clock limit, redaction, PR URL | `job-runner.mjs` |
| `claude_start` params, `claude_cancel`, `POST /v1/start`, `POST /v1/cancel` | `dispatch.mjs`, `host-api.mjs` |
| HTTP bridge token lock | `http-bridge.mjs`, `claude-async-http.mjs` |
| job image, its entrypoint (the clone), the git credential helper and the gh wrapper | `container/Dockerfile`, `container/job-entry.sh`, `container/git-credential.sh`, `container/gh-wrapper.sh` |
| rules mounted read-only into every job | `container/CLAUDE.md` |
| image build + checks on claunker; a by-hand mint of one installation token | `container/smoke-test.ps1`, `container/probe.sh`, `tools/mint-app-token.mjs` |
| tests | `test/container.test.mjs`, `test/container-runner.test.mjs`, `test/github-app.test.mjs`, `test/container-dispatch.test.mjs`, `test/http-bridge-auth.test.mjs`, `test/job-entry.test.mjs` |

## Why

Today a job either runs with `--dangerously-skip-permissions`, where everything Erick's Windows
account can read is reachable, or in safe mode. Safe mode's pattern rules leak: `node -e`,
`python -c` and `git -C x push` all get past them (see `docs/publishing.md`, "Threat model"). In
both modes `git push` would use Erick's own full GitHub credential from Git Credential Manager.
Container jobs change the boundary from "what the permission rules happen to match" to "what is in
the container and which credential is present". A job can do anything inside the container. That
covers one fresh clone and a one-hour GitHub App installation token that reaches exactly one repo
with contents and pull-request access, and nothing else of Erick's.

## The interface

```
claude_start { host, prompt, sandbox: "container", repo: "owner/repo", baseRef?: "branch|tag|sha",
               model?, effort?, intent?, jobId? }
POST /v1/start  (same body; forwarded by claude_start for a remote host)
claude_cancel { jobId }        POST /v1/cancel { jobId }   (routed by the job id's host prefix)
```

- **`repo`** (required for a container job): `owner/repo` on GitHub. It must be listed in the
  executing host's `CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS` (comma, semicolon or space separated,
  case-insensitive), **and the GitHub App must be installed on it** (preflight looks the
  installation up and refuses otherwise). There is no default: unset means every container job
  is refused.
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
from folders to repos that could drift from where the App is really installed. `owner/repo` is what
the container actually acts on, it is checked against one explicit allowlist and against the App's
installation, and it reads the same in a prompt, in `meta.json` and on GitHub.

## Threat model

Read this before you count on the container for anything.

**What the container boundary protects:**

- **Erick's files, repos and credentials.** No host folder is mounted read-write, and nothing from
  `%USERPROFILE%` is mounted at all: not `.ssh`, `.claunker`, `.claude` (Erick's own Claude Code
  login), `.claude-async` (Discord webhook, hosts.json, api.json, http.json), `.claude-async-jobs`
  (other jobs' logs), Git Credential Manager, the Windows Credential Manager, gh's stored token or
  the **GitHub App's private key** (`.claude-async-secrets`, read by the host only). No working copy
  under `D:\code` is visible, and neither is the live chassis (`D:\claunker`). The only host mounts
  are three read-only ones (CLAUDE.md, hooks/, and the job's own `creds` dir holding its
  installation token, below). The smoke test checks the mount table.
- **The host from the job's git activity.** Earlier drafts bind-mounted a host clone and audited its
  `.git` afterwards. That design is gone: the clone lives and dies in the container, and no host git
  ever runs in a job's repo (the card hook's HEAD lookup is skipped for container jobs). So
  `.git/config` tricks (`core.fsmonitor`, hooks, `commondir`, a `.git` file swap) have nothing on the
  host to act on.
- **Erick's GitHub identity, his other repos, and `main`.** The only GitHub credential in the
  container is a GitHub App **installation token**: minted by the host for this job, valid for 60
  minutes, scoped to this one repo with `contents: write`, `pull_requests: write` and
  `metadata: read`. It cannot reach any other repo (the App is installed only on the repos jobs may
  use, and the token is narrowed further to the job's repo), cannot create repos, gists, forks or
  issues, and cannot change settings, rulesets, secrets, workflows or collaborators. `main` requires
  a pull request with 1 approval from the owner, set by a ruleset, so the App cannot push to `main`
  or merge into it. Erick reviews and merges every PR.
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

- **The OAuth token, in phase 1. This is an accepted risk for a limited pilot, and it is
  unchanged by the move to a GitHub App.** With open egress a job (or code it runs: `npm install`
  scripts, test suites, anything from the repo or its dependencies) can send
  `CLAUDE_CODE_OAUTH_TOKEN` anywhere and use it after the container is gone; it is a long-lived
  credential on Erick's subscription with no verified per-token revoke. Measured detail: Claude Code
  2.1.309 already leaves `CLAUDE_CODE_OAUTH_TOKEN` out of the environment of its Bash tool's
  commands (the env names a Bash call saw were listed in a local run), but the same uid can read it
  from `/proc/<claude pid>/environ` (also verified). The CLI has a `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
  mode, but it requires bubblewrap (user namespaces) and forces the permission mode back to default,
  which defeats skip-permissions; it was not adopted. The real mitigation is phase 2 egress. Until
  then the pilot repo should have no third-party install scripts (no dependencies with
  `postinstall`, no `prepare`, no build steps pulling code).
- **The installation token, within its scope and its hour.** A stolen one is the smaller problem it
  used to be: it reaches one repo, with contents and pull requests only, and dies within 60 minutes
  of minting whatever anyone does (the runner mints a fresh one every 45 minutes while the job runs,
  so a 4-hour job hands out up to six, each as short-lived). It cannot create repos, gists or
  forks, cannot read or write any other repo, cannot touch settings, rulesets, secrets or
  collaborators, and cannot edit `.github/workflows/` (that needs the `workflows` permission, which
  the App does not have). What it **can** still do, until it expires: push branches to that repo
  (not `main`), open, edit and close pull requests there, and comment on PRs and their review
  threads. The `main` ruleset (PR with the owner's approval, no deletion, no force-push) still gates
  what reaches `main`. The token is readable by the job (same uid, same file), so this is not about
  hiding it from the job; it is about what a leaked one is worth. There is no long-lived GitHub
  credential to revoke after a leak: uninstalling the App from the repo ends new mints at once, and
  outstanding tokens are gone within the hour.
- **CI on the repos the App is installed on.** The token cannot push a change to
  `.github/workflows/`. It does not stop a job from editing a script, Makefile, test or package
  script that an existing workflow already runs on a PR or branch push. Whether that exposes secrets
  or a self-hosted runner depends on the workflow's triggers, permissions, secrets and runner. **Do
  not install the App on any repo whose CI holds secrets (or runs on a self-hosted runner) until that
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

Three **read-only** bind mounts, nothing else:

| host | container |
|---|---|
| `container/CLAUDE.md` (or `CLAUDE_ASYNC_CONTAINER_CLAUDE_MD`) | `/home/agent/.claude/CLAUDE.md` |
| this repo's `hooks/` | `/opt/claude-async/hooks` |
| `<job dir>\creds\` (the job's installation token file, written by the runner) | `/run/claude-async/creds` |

`/home/agent/.claude/CLAUDE.md` is Claude Code's user-level memory file, so the job rules are in
every job's instructions. **The repo's own `CLAUDE.md` is NOT loaded** under `--setting-sources user`
(Claude Code 2.1.309, measured in round 2: the control run without the flag loads it, the
production flags do not), and neither are the clone's `.claude/agents`, `.claude/skills` or
`.claude/commands` (see "Review round 2: questions"). A job that needs repo conventions has to read
the file itself; `container/CLAUDE.md` says so. `/workspace` is container-local (the image's
writable layer) and starts empty; the entrypoint clones into it.

Mounted vs baked: CLAUDE.md and hooks stay mounted so a rules or hook change takes effect on the
next job without rebuilding the image; the creds dir is mounted because its content changes while
the job runs (see "Token delivery and refresh"). The entrypoint (`container/job-entry.sh`), the git
credential helper and the gh wrapper are baked into the image instead, because they are tied to the
image's tools; **a change to any of them (or the Dockerfile) needs an image rebuild**
(`container\smoke-test.ps1`). Baking CLAUDE.md and hooks too would remove two of the three host
mounts at the cost of a rebuild for every rules or hook edit.

The image makes `/home/agent/.claude` root-owned (0755) **and `/home/agent` itself root-owned
(0755)**. The second part came out of round 2: `rename(2)` needs write permission on the parent,
not on the directory being moved, so with an agent-owned `$HOME` a job could `mv ~/.claude ~/.old;
mkdir ~/.claude` and plant its own `settings.json` (the one source `--setting-sources user` still
loads). On the overlayfs engine tested here that rename happened to fail with `EXDEV` because
`~/.claude` is a lower-layer directory; that is a storage-driver detail, not a permission, so the
parent is now root-owned and the refusal is `EACCES` (verified in the rebuilt image, and the smoke
test checks the rename, a new entry under `$HOME`, and that `$HOME` is root-owned). Only the
directories the CLI writes during a headless run are agent-owned under `~/.claude`: `backups`,
`projects`, `session-env`, `sessions` and `shell-snapshots` were observed in a local run with a
Bash tool call; `todos`, `plans`, `file-history`, `debug`, `statsig`, `paste-cache` and `ide` are
created up front for other code paths (not observed). Directly under `$HOME` the agent owns only
`.claude.json` (the CLI's state file; a full headless turn with a Bash tool call still runs and
writes only `.claude.json` and the `~/.claude` subdirs above), `.cache`, `.config` (git's global
config is `~/.config/git/config`, which git writes to when `~/.gitconfig` does not exist;
`git config --global` works), `.local`, `.npm` and `.bash_history`. Anything else a job creates
directly under `$HOME` (`~/.npmrc`, `~/.ssh`, `~/.gitconfig`) fails with `EACCES`, visibly. A job
can't create `~/.claude/settings.json`, `agents/`, `commands/` or `skills/`, and can't replace
`~/.claude`.

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
  `credential.https://github.com.helper = /usr/local/bin/claude-async-git-credential`
  (`container/git-credential.sh`). For `protocol=https` and `host=github.com` it answers
  `username=x-access-token` and, as the password, the current content of
  `/run/claude-async/creds/token`; for any other host, protocol or verb it prints nothing. Every git
  call reads the file afresh, so a token the runner refreshed is used by the next push without the
  job doing anything. The token is never in argv, a remote URL, the environment or `.git/config`;
  `gh auth setup-git` is not needed and `gh auth git-credential` is no longer configured. Verified
  in the rebuilt image against a local https `github.com` (see "Verified here vs assumed").
- **Exit codes** of the entrypoint itself: 64 usage/validation, 70 clone failed or `baseRef` not
  found / not checked out (the runner adds a warning naming the repo), 78 configuration (the token
  file missing or empty, `/workspace` not empty). `test/job-entry.test.mjs` runs the script on the host against
  a local bare repo (URL rewritten with `url.insteadOf`): branch, tag and 8-char SHA check out,
  `refs/pull/1/head`, an unreachable SHA and an unknown name exit 70, and the fork commit never
  reaches the clone.
- `CLAUDE_ASYNC_REPO` and `CLAUDE_ASYNC_BASE_REF` are set in the container so the job knows what it
  cloned and what to open its PR against.

## How secrets reach the container

Two secrets ever enter a container, by two different routes: the Claude Code OAuth token
(`CLAUDE_CODE_OAUTH_TOKEN`) as an environment variable from the host's "secrets env file", and the
job's GitHub App installation token as a **file** the runner writes and refreshes (next section).
The App's private key never enters the container at all.

The secrets env file holds exactly one line, in Docker's `--env-file` format:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

- **By path, never by value.** job-core passes `--env-file <path>` and Docker reads the file itself.
  Neither the docker argv nor `spec.json` nor `meta.json` ever holds a value (the tests assert this).
  Every non-secret variable goes in as an explicit `-e NAME=value`; a bare `-e NAME` is never used,
  and any `-e` name that looks like a credential throws.
- **Checked before every job, values never echoed.** `checkEnvFile()` returns key names, never
  values. It refuses: any key other than `CLAUDE_CODE_OAUTH_TOKEN` (notably `ANTHROPIC_API_KEY`,
  which outranks it and would silently switch billing to the API, and `GH_TOKEN`, the old bot PAT,
  with a message pointing at the App settings), a missing, empty or duplicate key, a bare `KEY`
  line, CRLF line endings, a UTF-8 BOM, a file inside the claude-async checkout or at/under a
  read-only mount source (the CLAUDE.md file, the hooks dir: as CLAUDE.md the token would be in the
  model's instructions) or equal to the App key file, and any value with quotes, leading/trailing or
  inner whitespace (how a trailing `# comment` shows up) or control characters, since Docker's
  `--env-file` keeps all of those literally.
- **Never in the image.** The Dockerfile takes no secret build args, and nothing in it reads one.
- **Output redaction.** A job can print its own environment, read `/proc/*/environ`, or `cat` the
  token file. `out.log`/`err.log` in the job dir keep exactly what the job printed. Everything that
  **leaves the runner** is redacted with the env file's value (read into memory once by
  `readEnvFileSecretValues()`, never written), **every installation token the runner minted for the
  job** (all generations, added to the set as each is minted), their base64 forms
  (`base64("x-access-token:<token>")` is the Basic header `GIT_TRACE_CURL`/`GIT_CURL_VERBOSE`
  print, plus `base64(<value>)`), plus the GitHub (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`,
  `github_pat_`) and Anthropic (`sk-ant-`) token shapes with no word-boundary anchor (so
  `TOKEN_ghp_...` is caught too) and the base64 shapes of a `ghs_` token on its own and inside a
  Basic header. `checkJob()` runs in another process and cannot know generations the runner has
  already replaced, so it uses the env file's value, the job's *current* token file (while it
  exists) and the shape patterns; the `ghs_` base64 patterns are what cover older generations
  there. Redaction always runs on
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
  Erick (including host-mode jobs) can read them, and, while a job runs, its `creds\token`. Treat
  them as holding the tokens.
- **Why not Docker secrets?** Docker secrets (`/run/secrets/...`) are a Swarm/Compose feature, and a
  mounted secrets file would be readable by the same job user anyway. Claude Code reads its token
  from the environment, so the env file is simplest for it; the GitHub token is a file because it
  has to change while the job runs (below).

## Token delivery and refresh (the GitHub App installation token)

Installation tokens live 60 minutes; a job may run 4 hours. So the token is not an environment
variable (fixed at `docker run`) but a file the host keeps current:

- **Before `docker run`** the runner (`job-runner.mjs`) creates `<job dir>\creds\` (mode 0700) and
  mints the first token through `github-app.mjs` (`createMinter().mint()`: read the key file, build
  a 9-minute App JWT, `POST /app/installations/<id>/access_tokens` with
  `{ repositories: [<repo name>], permissions: { contents: "write", pull_requests: "write", metadata: "read" } }`)
  and writes it to `creds\token` (mode 0600). On a Linux host where the runner is root, both are
  chowned to the container's uid 1000, since a 0600 root-owned file is unreadable to the job;
  through Docker Desktop's Windows file sharing the host mode bits are not what the container sees,
  and the directory's ACL (owner + SYSTEM, inherited from the job dir, see "Who can read the raw
  logs") is the protection on the host side. If that first mint fails, **no container is started**:
  the job ends with exit 78 and an `exit.json` warning naming the cause (`could not mint the GitHub
  App installation token: ...`).
- **The mount** is the *directory*, read-only, at `/run/claude-async/creds`, so the job cannot change
  what the next git call will present, and so the file the container sees is the same inode the
  host rewrites.
- **Every `CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS`** (default 45 minutes; 1 to 55 minutes allowed) while
  the container runs, the runner mints again and rewrites the file **in place**: open the existing
  file, write the new token at offset 0, truncate to its length, `fsync`, close. Never a rename.
  Why in place: the container holds the directory as a bind mount, and what has to reach it is new
  content in the same file. A rename inside the directory would also be visible on a Linux bind
  mount (the mount is the directory, not the file), so the choice is not forced on Linux; it is
  made because claunker's mounts go through Docker Desktop's Windows file sharing, where in-place
  content changes are the one propagation path the smoke test measures (section 5b), and one
  measured mechanism beats two. Writing at offset 0 before truncating means a reader never sees an
  empty file (tokens of one App have the same length; a reader racing the write could see a mix of
  the two for a moment, which costs one failed git call, retried by the job).
- **On a refresh failure** the runner logs once per distinct error, keeps the old token (still valid
  until its expiry) and retries on the next tick. If refresh keeps failing and the token is within
  5 minutes of expiry, or already expired, `exit.json` gets a warning
  (`the GitHub App installation token could not be refreshed ... within 5 minutes of its expiry`),
  because git/gh calls late in the job may have failed.
- **On finish** (any exit: normal, cancel, wall-clock limit, signal, runner error) the file and the
  directory are deleted, after the container is removed. A container that somehow survived loses
  its credential rather than keeping one on disk.
- **Every minted generation** is added to the runner's redaction set as it is minted, with its
  base64 forms (previous section).
- **The key** (`CLAUDE_ASYNC_GITHUB_APP_KEY_FILE`) is read by the runner at each mint and by job-core
  at preflight, never written anywhere, never put in argv, `spec.json`, `meta.json` or a log; the
  runner's spec carries its **path**. It must be readable only by its owner: on POSIX a group- or
  world-readable key is refused (`chmod 600`); on Windows the mode bits carry nothing, so the ACL
  expectation (Erick's account and SYSTEM only, set with `icacls` in the rollout) is documented and
  not checked. It may not be inside the claude-async checkout, a mount source, or the env file.
- **Verified** with a real Docker engine on Linux (the runner, `startJob()`'s argv, the rebuilt
  image, a fake `api.github.com` and a fake https `github.com`): the file is 0600/uid 1000 inside,
  the mount is read-only, the clone authenticated with generation 1 through the helper, and a
  `git ls-remote` seven seconds later authenticated with generation 4 after three in-place rewrites,
  with no restart of anything. **Not verified: propagation of an in-place rewrite through a Docker
  Desktop bind mount on Windows.** `container\smoke-test.ps1` section 5b measures it (a container
  tails a mounted file, the host rewrites it in place, the new content must appear within 5 s) and
  FAILS when it does not. Do not enable container mode until that line passes; a job longer than an
  hour would otherwise lose GitHub access mid-run.

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

Commits are authored by the App's bot user. At preflight job-core fetches the App's slug
(`GET /app` with the JWT) and the bot user's id (`GET /users/<slug>[bot]`) once, caches them in the
plan (and `meta.json.container.githubApp`), and sets `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` to
`<slug>[bot]` and `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` to
`<id>+<slug>[bot]@users.noreply.github.com`, which is the address GitHub links to the App's bot
user (commits show the App's avatar and name). `CLAUDE_ASYNC_CONTAINER_GIT_NAME` /
`CLAUDE_ASYNC_CONTAINER_GIT_EMAIL` still exist as **optional overrides** of one or both (rarely
needed: a display name other than the slug, or a GHES address); they are no longer required. The
clone is made on Linux inside the container, so the old `core.autocrlf` pass-through for Windows
checkouts is gone.

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
advisory there, and the real limits are server-side (the installation's repos, the token's
permissions, the `main` ruleset).

**How `gh` gets the token.** `gh` reads `GH_TOKEN`, and that variable is deliberately not in the
job's environment. `/usr/local/bin/gh` is a small wrapper (`container/gh-wrapper.sh`) that reads
`/run/claude-async/creds/token` at each call and exports `GH_TOKEN` for the exec'd real gh
(`/usr/local/lib/gh/gh`) only, never on its command line. So `gh pr create` just works, a job
shell's `env` shows no `GH_TOKEN`, and the test suites, `npm` scripts and other children the job
runs do not inherit it. The job runs as the same uid and can read the file itself, so this is about
not spraying the token into every child process by default, not about hiding it from the job. A
`GH_TOKEN` the job sets on purpose is respected. The wrapper and the `env` check are tested on the
host (`test/job-entry.test.mjs`) and were verified in the rebuilt image.

**Cross-owner contributions (forks) are not available to container jobs.** An installation token
cannot fork (no repository-creation permission) and cannot push to a repo the App is not installed
on. A job can only work on repos the App is installed on, which is the point. To let jobs work on a
repo, install the App on it (and add it to `CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS`).

## Identity: the GitHub App

### Why an App and not a bot account

Review round 2 left this as an open question ("Per-job, per-repo credentials"); it is decided now.
The owner chose **not** to create a machine account. A GitHub App owned by Erick's personal account
gives what the bot never could:

- **Per-repo scope.** The App is installed on selected repositories only, and each job's token is
  narrowed to its one repo. A classic PAT reached every repo the bot was a collaborator on; a
  fine-grained PAT could not contribute to repos the bot did not own.
- **Per-job lifetime.** Installation tokens expire 60 minutes after minting. Nothing long-lived
  exists on the host except the App's private key, which never enters a container and can be
  revoked and regenerated on the App's settings page in seconds.
- **Minimal permissions.** The App has exactly three repository permissions; the token cannot ask
  for more than the App has, and the runner asks for exactly these:

| permission | level | why |
|---|---|---|
| Contents | read and write | clone, push branches |
| Pull requests | read and write | `gh pr create`, PR comments |
| Metadata | read-only | mandatory for any App; repo lookup |

Nothing else: no Workflows (so `.github/workflows/` cannot be changed), no Issues, no
Administration, no account permissions, no webhook. The App is set to **"Only on this account"**, so
nobody else can install it.

### Registration (what the owner does once)

On GitHub as `icey2488`: Settings, Developer settings, GitHub Apps, **New GitHub App**.

- Name: anything (`claunker-jobs` is what the examples use; the slug GitHub derives from it becomes
  the commit author `<slug>[bot]`). Homepage URL: any URL (the claude-async repo).
- **Webhook: uncheck "Active".** No webhook URL, no secret.
- Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**,
  **Metadata: Read-only** (preselected). Leave every other repository, organization and account
  permission at "No access".
- "Where can this GitHub App be installed?": **Only on this account**.
- Create. Note the **App ID** at the top of the page (a number; not the Client ID).
- **Private keys: Generate a private key.** GitHub downloads a `.pem` once. Move it to
  `%USERPROFILE%\.claude-async-secrets\github-app.pem` on claunker (rollout step 6 sets the ACL).
  If it is ever exposed, delete it on that page and generate a new one; the runner picks the new
  file up at its next mint.
- **Install App** (left menu): install on `icey2488`, choose **Only select repositories**, select
  `icey2488/container-job-scratch` only. Add more repos later the same way (and to
  `CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS`); never "All repositories".

The installation id, the App slug and the bot user id are looked up by preflight, not configured.
`node tools\mint-app-token.mjs icey2488/container-job-scratch <file>` runs the same preflight by
hand and prints them.

### What the host does with it

`github-app.mjs`, on the bridge process at preflight and in the runner at each mint:

1. Read the key file (checks: regular file, PEM private key, owner-only mode on POSIX, outside the
   checkout and the mount sources).
2. Build the App JWT: RS256, `iat` 60 s in the past, `exp` 9 minutes ahead, `iss` = App ID.
3. `GET /repos/<owner>/<repo>/installation` (preflight): the installation id, or a refusal naming the
   repo ("not installed on ...; install the app on that repository") on 404, or "app id and key do
   not match" on 401.
4. `GET /app` and `GET /users/<slug>[bot]` (preflight): the commit identity.
5. `POST /app/installations/<id>/access_tokens` with the one repo and the three permissions (runner,
   before `docker run` and every 45 minutes): the token the container gets as a file.

### Server-side backstops

- **`main` requires a PR with 1 approval from the owner** (a repository ruleset on each repo the App
  is installed on, with Erick as a bypass actor so his own workflow is unchanged). The App cannot
  push to `main`, and a PR author can't approve its own PR, so nothing the App writes reaches `main`
  without Erick's approval. Plus the existing no-deletion and no-force-push rules. Two details to
  set in the same ruleset: **"Dismiss stale pull request approvals when new commits are pushed"** and
  **"Require approval of the most recent reviewable push"**, so the App can't add commits after Erick
  approves. Note that with only the approval rule, a token with `pull_requests: write` and
  `contents: write` could still press merge on a PR Erick has approved; the merged content is then
  exactly what he approved. If only Erick should ever merge, also turn on **"Restrict updates"** with
  Erick as the bypass actor (I believe that blocks merges by anyone else too, but have not verified
  it on GitHub). `container/CLAUDE.md` tells the job never to merge or approve.
- **The App's permissions are the ceiling.** A token can never carry more than the App was granted,
  and the runner asks for the three above. Changing the App's permissions later requires accepting
  them on the installation, which Erick does on the installation page.

## Network egress

### Phase 1 (implemented): default bridge network

`--network bridge` (configurable with `CLAUDE_ASYNC_CONTAINER_NETWORK`; `host` and `none` are
refused). The job can reach the internet, the LAN and the tailnet (see the threat model). The image
sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`, so the CLI itself
makes no telemetry, error-reporting or update calls.

Inter-container traffic: Docker's default `bridge` network allows container-to-container
connections, so concurrent jobs can reach each other's listening ports (they share the same OAuth
token anyway, and each has its own repo-scoped GitHub token; what this exposes is one job tampering
with a service another job started). A dedicated
user network with ICC off keeps normal egress and removes that:

```powershell
docker network create -o com.docker.network.bridge.enable_icc=false claude-jobs-p1
# then: CLAUDE_ASYNC_CONTAINER_NETWORK=claude-jobs-p1
```

This is recommended for phase 1 (there is no proxy to reach yet, so ICC off costs nothing) but was
not tested on Docker Desktop here. It does NOT carry over to phase 2: see below.

### Phase 2 (designed, not implemented, not tested): egress allowlist

The job runs on an **internal** Docker network with no route out. A small proxy container is the
only thing attached to both a job network and a normal one, and it allows a fixed list of hosts.

**Topology: one internal network per job, with the proxy connected to each.** Round-2 review
(finding A5) caught that the earlier recipe, one shared internal bridge with `enable_icc=false`
holding both the jobs and the proxy, blocks the job-to-proxy connection as well: that connection is
itself inter-container traffic on that bridge, and Docker's ICC switch has no per-pair exception.
Jobs would have had no route to GitHub or Anthropic at all. The recommended layout is:

```
   claude-job-<idA> (internal)      claude-job-<idB> (internal)
  +------------------+             +------------------+
  | job A            |             | job B            |
  +--------+---------+             +---------+--------+
           | :3128                           | :3128
           v                                 v
  +--------------------------------------------------+      bridge
  | egress-proxy (squid), connected to every job net |----> internet (allowlisted hosts)
  +--------------------------------------------------+----> host.docker.internal:11434 (4 Ollama paths)
     no other member on a job network; no host gateway on job networks
```

- **Why per-job networks and not a shared ICC-on network:** on one shared network with ICC on, the
  proxy is reachable, but so is every other job (job A can hit a dev server job B started). On one
  shared network with ICC off nothing can reach anything, the proxy included. A network per job
  with exactly two members (the job and the proxy) gives job-to-proxy and nothing else, with
  Docker's own network isolation doing the job-to-job separation instead of ICC. The cost is one
  `docker network create`/`connect` per job and a `rm` afterwards, which the runner can do around
  `docker run` (not implemented).
- **Alternative, same property:** the proxy on its own network and each job attached to it with
  `docker network connect`; that puts all jobs on one network with the proxy, so job-to-job
  isolation again depends on ICC off, which also cuts the proxy. Not recommended.
- The proxy's *own* egress network stays the default bridge (or a dedicated normal network), which
  is where `host.docker.internal` is added. Job networks get no `--add-host`.

One-time setup on claunker (the proxy; job networks are per job):

```powershell
docker run -d --name egress-proxy --restart unless-stopped `
  --network bridge --add-host host.docker.internal:host-gateway `
  -v D:\claude-async-proxy\squid.conf:/etc/squid/squid.conf:ro ubuntu/squid:<pinned>
```

Per job (what the runner would do around `docker run`; today this is a manual recipe):

```powershell
docker network create --internal claude-job-<jobId>
docker network connect claude-job-<jobId> egress-proxy
docker run ... --network claude-job-<jobId> -e HTTPS_PROXY=http://egress-proxy:3128 ...   # no --add-host
docker network disconnect claude-job-<jobId> egress-proxy ; docker network rm claude-job-<jobId>   # after the job
```

`squid.conf` (CONNECT-only for TLS, so squid sees hostnames, never content; Ollama is plain HTTP, so
it is never a CONNECT target and is limited to the four read/generate paths). With per-job networks
the client subnets vary, so the `jobs` ACL names the proxy's non-bridge interfaces by address range
or, simpler, every RFC1918 source except the proxy's own bridge subnet; the example below uses the
Docker default pool for user networks (`172.17.0.0/16` is the default bridge, excluded):

```
http_port 3128
acl jobs src 172.18.0.0/15 172.20.0.0/14 172.24.0.0/13 192.168.0.0/16
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

Check `docker network inspect` for the pool your Docker Desktop actually assigns and narrow the
`jobs` ACL to it. On the bridge: `CLAUDE_ASYNC_CONTAINER_NETWORK=<per-job network>` (the runner
would set it per job once implemented) and `CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY=http://egress-proxy:3128`.
With the proxy set, `container.mjs` adds `HTTPS_PROXY`/`HTTP_PROXY` (both cases) and `NO_PROXY`, and
**omits** `--add-host host.docker.internal:host-gateway`, so the only way to the host is through the
proxy's Ollama rule. The CLI's proxy support is unverified (its network-config page could not be
fetched); the smoke test should confirm one real call through the proxy. With the two traffic
variables set, Claude Code should need only `api.anthropic.com`; verify with squid's access log.

**Phase-2 acceptance test (to add to the smoke test before phase 2 is called done; not written):**
create two job networks, connect the proxy to both, start two hardened job containers (one per
network) each with a listener on some port, then assert: (1) each reaches the proxy and completes
one real `CONNECT api.github.com:443` through it (`curl --proxy http://egress-proxy:3128
https://api.github.com/`); (2) neither reaches the other's listener by address or by name
(`probe.sh` from each against the other's IP: CLOSED/unresolvable); (3) direct egress is blocked:
`curl https://api.github.com/` without the proxy fails, `host.docker.internal` does not resolve from
a job, and the Docker bridge gateway is unreachable; (4) a non-allowlisted host through the proxy
gets squid's 403; (5) `GET http://host.docker.internal:11434/api/tags` through the proxy works and
`POST /api/pull` is denied. None of this has been run anywhere yet. The existing automated test
checks only the argv (proxy env present, `--add-host` absent).

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
  Re-run in round 2 with the launch-state code, plus: a runner SIGKILLed between the spawn and the
  pid write left `docker_launch` = `pending`; the first `claude_check` found no container yet but
  reported `unconfirmed` (the process scan found the orphaned `docker run` by its label), the next
  one removed the container the daemon had created meanwhile, and the one after confirmed once the
  client was gone.
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
| job record (`meta.json`, `spec.json`) | plus `sandbox: "container"` and `container: {name, jobId, image, imageId, dockerBin, repo, baseRef, envFile, credsDir, githubApp: {appId, slug, botUserId, installationId}}` in meta (envFile and credsDir are paths); `workFolder` is `null` |
| heartbeat, `runner.pid`, Job Object records | unchanged |
| stdout/stderr capture | unchanged on disk; redacted in exit.json, claude_check and the ping |
| `exit.json`, `exit_code`, status | unchanged, plus `exit.container` = `{name, repo, prUrl, cleanup, cancelled, maxRuntimeExceeded}` and token warnings in `warnings`; 125 = docker run failed, 78 = the token could not be minted (no container started) or the entrypoint found no token file, 70 = clone failed, 137 = removed/killed |
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
| `CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS` | **none** (required) | `owner/repo` entries; only repos the GitHub App is installed on |
| `CLAUDE_ASYNC_CONTAINER_ENV_FILE` | **none** (required) | the host secrets file (`CLAUDE_CODE_OAUTH_TOKEN` only), outside the claude-async checkout |
| `CLAUDE_ASYNC_GITHUB_APP_ID` | **none** (required) | the App's numeric App ID |
| `CLAUDE_ASYNC_GITHUB_APP_KEY_FILE` | **none** (required) | path of the App's private key `.pem`; owner-readable only, outside every repo |
| `CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS` | `2700000` (45 min) | how often the runner re-mints the installation token (60000 to 3300000) |
| `CLAUDE_ASYNC_GITHUB_API_BASE` | `https://api.github.com` | the API origin; tests (a loopback fake) or GHES only |
| `CLAUDE_ASYNC_CONTAINER_GIT_NAME` / `_GIT_EMAIL` | derived from the App | optional overrides of the commit identity (`<slug>[bot]`, `<id>+<slug>[bot]@users.noreply.github.com`); rarely needed |
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
`_GIT_AUTOCRLF` (no host folder is mounted any more). Changed with the GitHub App: `GH_TOKEN` is
no longer an allowed env-file key (preflight refuses a file that still has it), and
`CLAUDE_ASYNC_CONTAINER_GIT_NAME`/`_EMAIL` went from required to optional.

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
  -e GIT_AUTHOR_NAME=claunker-jobs[bot] -e GIT_COMMITTER_NAME=claunker-jobs[bot]
  -e GIT_AUTHOR_EMAIL=<bot user id>+claunker-jobs[bot]@users.noreply.github.com -e GIT_COMMITTER_EMAIL=<same>
  -e OLLAMA_HOST=http://host.docker.internal:11434 -e CLAUDE_ASYNC_OLLAMA_URL=http://host.docker.internal:11434
  --mount type=bind,source=D:/code/claude-async/container/CLAUDE.md,target=/home/agent/.claude/CLAUDE.md,readonly
  --mount type=bind,source=D:/code/claude-async/hooks,target=/opt/claude-async/hooks,readonly
  --mount type=bind,source=C:/Users/Raide/.claude-async-jobs/claunker.demo-20261101-abcd1234/creds,target=/run/claude-async/creds,readonly
  --workdir /workspace
  sha256:<64 hex>
  /usr/local/bin/claude-async-job-entry icey2488/container-job-scratch "" --
  claude -p --dangerously-skip-permissions --setting-sources user --strict-mcp-config
    --mcp-config {"mcpServers":{}} --model=claude-sonnet-5 --effort medium
    --settings {"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"env -u NODE_OPTIONS /usr/local/bin/node /opt/claude-async/hooks/no-background-hook.mjs","timeout":5}]}]}}
    -- <prompt>
```

Each token is one argv element (no shell). The prompt is last, after `--`, and the model is bound
with `=`. Nothing about the GitHub App (id, key path, installation, token) is in the argv; the
runner's `spec.json` carries the app id, the key **path**, the installation id and the repo name,
and `meta.json.container.githubApp` the app id, slug, bot user id and installation id.

## The image

`container/Dockerfile`, built on claunker (never pulled):

- Base: `node:24-bookworm-slim`, pinned to the major tag until the first build records its digest
  (rollout step 7).
- gh 2.89.0 and uv 0.13.6 from GitHub release tarballs, each checked against a pinned SHA-256. gh
  lives at `/usr/local/lib/gh/gh`; `/usr/local/bin/gh` is the wrapper that reads the token file
  (see "How jobs open PRs").
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
- User `agent`, uid/gid 1000; `~/.claude` root-owned as described above; the entrypoint, the
  github.com credential helper (`claude-async-git-credential`, a script reading the token file) and
  the empty mount point `/run/claude-async/creds` as described in "The clone inside the container".
  `gh auth git-credential` is not configured anywhere.
- **Built and checked in this sandbox** on a test-only base (Ubuntu noble plus Node 24, because Docker
  Hub isn't reachable from here; for the round-3 rebuild the two Claude Code tarballs came from a
  local registry serving the previously verified bytes, and the pinned sha512 checks still ran
  against them). Every other line ran as written. The real `node:24-bookworm-slim` build happens on
  claunker in the smoke test.

## Rollout checklist

Do these in order on claunker. Each step says how to check it.

1. **Install Docker Desktop** (admin) with the WSL2 backend. In Settings: "Start Docker Desktop when
   you sign in" on; **leave "Expose daemon on tcp://localhost:2375 without TLS" off**. Size the VM in
   `%USERPROFILE%\.wslconfig`, then `wsl --shutdown` and restart Docker Desktop.
   Check: `docker version` shows a Server section; `docker run --rm hello-world` works.
2. **Register the GitHub App** as `icey2488` (details under "Identity: the GitHub App",
   "Registration"): Settings, Developer settings, GitHub Apps, New GitHub App; name it (e.g.
   `claunker-jobs`); **webhook off**; repository permissions **Contents: read and write**,
   **Pull requests: read and write**, **Metadata: read-only**, nothing else; **Only on this
   account**; create; note the **App ID**. Then **Generate a private key** and keep the downloaded
   `.pem` for step 6. No bot account is created, no PAT of any kind.
   Check: the App's page shows the three permissions and "Webhook: inactive".
3. **Rulesets first, then install.** On each repo jobs will push to, add a ruleset for the default
   branch: require a pull request with **1 approval** (with "dismiss stale approvals" and "require
   approval of the most recent reviewable push"), Erick (`icey2488`) as a bypass actor, plus no
   deletion and no force-push; optionally "Restrict updates" so only Erick can merge (see
   "Server-side backstops"). Then **install the App** (its page, "Install App", `icey2488`, **Only
   select repositories**) on `icey2488/container-job-scratch` (private) and nothing else. Don't
   install it on any repo whose CI holds secrets or runs on a self-hosted runner until that CI is
   reviewed.
   Check: after step 6, `node tools\mint-app-token.mjs icey2488/container-job-scratch $env:TEMP\t`
   prints the slug, bot id and installation; the same command for any other repo of yours says
   "not installed on"; delete `$env:TEMP\t` afterwards. With the minted token in a container (the
   smoke test's section 6), `git push origin HEAD:main` to the scratch repo is rejected by the
   ruleset.
4. (Removed: no classic PAT. The App's installation tokens are minted per job.)
5. **Generate the Claude Code token** as Erick: `claude setup-token`; one year; set a reminder.
6. **Write the host secrets file and place the App key** outside every repo, readable only by
   Erick's user (the token is read as a secure string, never echoed, never on a command line):

   ```powershell
   $dir  = Join-Path $env:USERPROFILE ".claude-async-secrets"
   $file = Join-Path $dir "container.env"
   $pem  = Join-Path $dir "github-app.pem"
   New-Item -ItemType Directory -Force -Path $dir | Out-Null
   $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   icacls $dir /inheritance:r /grant:r "${me}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
   function Read-Plain([string]$prompt) {
     $s = Read-Host -AsSecureString $prompt
     $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
     try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
   }
   $cc = Read-Plain "Claude Code token from 'claude setup-token' (CLAUDE_CODE_OAUTH_TOKEN)"
   # LF endings, no BOM, no quotes or spaces: docker keeps all of those in the value. ONLY this key.
   $body = "CLAUDE_CODE_OAUTH_TOKEN=$($cc.Trim())`n"
   [IO.File]::WriteAllText($file, $body, (New-Object Text.UTF8Encoding($false)))
   Remove-Variable cc, body
   icacls $file /inheritance:r /grant:r "${me}:F" "SYSTEM:F" | Out-Null
   # the App's private key: move the .pem GitHub downloaded in step 2, then lock it down the same way
   Move-Item "$env:USERPROFILE\Downloads\claunker-jobs.*.private-key.pem" $pem
   icacls $pem /inheritance:r /grant:r "${me}:F" "SYSTEM:F" | Out-Null
   ```

   Check: `(Get-Content $file | ForEach-Object { ($_ -split '=')[0] })` prints exactly
   `CLAUDE_CODE_OAUTH_TOKEN`; `icacls $pem` lists only your account and SYSTEM;
   `Get-Content $pem -First 1` is `-----BEGIN RSA PRIVATE KEY-----`. (On a Linux host the key must
   be `chmod 600`; preflight refuses a group- or world-readable key there. Windows ACLs are not
   checked by the code, so this step is the control.)
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
     -EnvFile "$env:USERPROFILE\.claude-async-secrets\container.env" `
     -AppId <App ID> -AppKeyFile "$env:USERPROFILE\.claude-async-secrets\github-app.pem" -RunClaude `
     -LanTargets "<hermes-host>:<port>","<ha-host>:8123"
   ```

   Every line must be PASS or WARN. Read the loopback-forwarding line (it is measured), the **token
   propagation** line (section 5b: an in-place rewrite of a bind-mounted file must reach a running
   container within 5 s, or jobs longer than an hour lose GitHub access; a FAIL there means stop)
   and every WARN. A FAIL on 7842/2375/2376 means stop. Section 6 mints one real installation token
   through `tools\mint-app-token.mjs` and shows the App's slug, bot id and installation. Then pin
   the base image digest
   (`docker image inspect node:24-bookworm-slim --format "{{index .RepoDigests 0}}"` into
   `ARG NODE_IMAGE=...@sha256:...`) in a small commit.
9. **Configure the bridge** (container mode still off), then restart it with
   `tools\restart-bridge.ps1 -RequestedBy manual`:

   ```
   CLAUDE_ASYNC_ALLOWED_SANDBOXES=host,container
   CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS=icey2488/container-job-scratch
   CLAUDE_ASYNC_CONTAINER_ENV_FILE=C:\Users\Raide\.claude-async-secrets\container.env
   CLAUDE_ASYNC_GITHUB_APP_ID=<App ID from step 2>
   CLAUDE_ASYNC_GITHUB_APP_KEY_FILE=C:\Users\Raide\.claude-async-secrets\github-app.pem
   CLAUDE_ASYNC_DOCKER_BIN=C:\Program Files\Docker\Docker\resources\bin\docker.exe
   ```

   `CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS` (45 min) and `CLAUDE_ASYNC_CONTAINER_GIT_NAME`/`_EMAIL`
   (derived from the App) need no setting. Remove any `GH_TOKEN` line from the env file and any
   `CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS`/`_DENIED_ROOTS`/`_GIT_AUTOCRLF` from an earlier draft; the
   first is refused, the rest are ignored. No job clones under `D:\code\jobs` are needed any more.
10. **Run one container job end to end**: `claude_start` with `host: "claunker"`,
    `sandbox: "container"`, `repo: "icey2488/container-job-scratch"`, and a prompt like "Create a
    branch docs/container-smoke, add a README line saying hello from the container, commit, push the
    branch, open a PR to main and print its URL. Delegate the README wording to qwen2.5-coder:7b
    through $OLLAMA_HOST. End with the delegation report." Check: `claude_check` shows
    `sandbox: "container"`, status `completed`, `containerCleanup: "confirmed"` and
    `exit.container.prUrl`; `exit.json` has no token warning; the commit author is
    `<slug>[bot]` and the PR opener is the App; the delegation report shows an Ollama call; the card
    and the Discord ping arrived; `docker ps -a --filter label=claude-async.job` is empty; the
    job dir has no `creds` folder left. Then start a long job and `claude_cancel` it: it reports
    `failed`, `exitReason: "cancelled"`, cleanup confirmed. Review and merge the PR yourself. Before
    widening, run one job that takes more than an hour (a prompt that sleeps, then pushes a second
    commit): the second push must succeed, which proves the refreshed token reached the container
    on Docker Desktop.
11. **Widen slowly.** Install the App on one real repo, add it to the allowlist (and the ruleset on
    it) once the scratch runs are routine. Schedule phase 2 before any repo with third-party install
    scripts.

### Rollback

- **Stop using it:** set `CLAUDE_ASYNC_ALLOWED_SANDBOXES=host` (or unset it) and restart the bridge.
  Every container start is then refused before anything is written.
- **Cut off the credentials:**
  - GitHub App: **uninstall the App from the repo(s)** (the App's page, Install App, the gear next
    to `icey2488`, Uninstall, or per repo under "Only select repositories"). New mints fail from
    that moment (preflight refuses: "not installed on"), and every outstanding installation token
    expires within the hour on its own; nothing else needs revoking. Then **delete the private key**
    on the App's settings page (Private keys, Delete) and remove
    `%USERPROFILE%\.claude-async-secrets\github-app.pem`. Deleting the App itself is optional.
  - Claude Code setup-token: **unverified**. I could not confirm a per-token revoke procedure for
    `claude setup-token` tokens (Anthropic's docs pages could not be fetched this time, and the CLI
    has no revoke command). Look in the claude.ai account settings for the Claude Code / authorized
    apps or sessions list and revoke it there; if no per-token control exists, ask Anthropic support,
    and treat the token as live until it expires (one year).
  - Then delete `%USERPROFILE%\.claude-async-secrets\container.env`. Container jobs fail in preflight
    (the App key or the env file missing is refused before anything is written).
- **Remove the code:** revert this PR's merge commit. Host mode is the same with or without it.
- **Remove Docker:** `docker image rm claude-async-job:local`, then uninstall Docker Desktop if
  nothing else uses it.

## Review round 1: questions answered

- **Can concurrent jobs share a clone?** No. Each container clones its own copy into its own
  writable layer, and nothing is shared or mounted read-write.
- **Token values in out.log?** A job can `cat` its token file (or read the OAuth token from
  `/proc`), and `out.log` keeps it. The job dirs are readable by Erick's account, SYSTEM and
  Administrators. What leaves the runner (exit.json tails, the Discord ping, `claude_check`) is
  redacted; the card never carries output. See "Output redaction".
- **`workflow` scope?** The App has no Workflows permission, so `.github/workflows/` cannot be
  pushed; that doesn't stop a job editing a script an existing workflow runs. Don't install the App
  on repos whose CI holds secrets until reviewed.
- **Does `findUnsafeConfig()` / the `.git` audit cover enough?** Moot: there is no host clone and no
  audit any more.
- **Mount-path races, NTFS junctions, container-created symlinks?** Moot for the repo: nothing
  writable is mounted. The two read-only mounts are files in the claude-async checkout.
- **Duplicate runners, name reuse?** Cleanup acts only on containers carrying this job's
  `claude-async.job` label, by immutable ID. A duplicate start is refused by the job-dir check, and
  since round 2 the runner itself takes `runner.lock` with O_EXCL (see "Review round 2").
- **Repo-local Claude settings, `apiKeyHelper`?** Ignored (`--setting-sources user`), verified.
- **Wall-clock limit?** Yes now: 4h default, runner-enforced.
- **Phase 1 risk.** Phase 1 is an accepted credential-theft risk for a limited pilot (one scratch repo
  first, no third-party install scripts, the App installed on as few repos as possible), with the
  revoke steps above. Round 2 objection, accepted: this must not be described as quickly reversible
  until the setup-token revocation is verified. The GitHub side is now self-limiting (a stolen
  installation token reaches one repo and dies within the hour; the App can be uninstalled in
  seconds); the one-year `CLAUDE_CODE_OAUTH_TOKEN` has no verified per-token revoke, so a stolen one
  must be assumed usable until it expires or Anthropic support revokes it. Rollback is quick for the
  GitHub side only.

## Review round 2: questions

Answers established from the code and, where marked, from the rebuilt image (`claude-async-job:r2`
on the test-only base, real Docker engine on Linux, Claude Code 2.1.309 against a local fake API).

- **What prevents duplicate runner execution for the same job dir?** Before round 2: only the
  launch side (the job dir is created once with a non-recursive `mkdir`, `startJob` refuses a
  duplicate id, and the Windows task launcher withdraws its ticket before falling back to the
  breakaway path, so one launch yields one runner). The runner itself had no exclusivity. Now
  `job-runner.mjs` creates `runner.lock` with O_EXCL as its first act, holding its pid; a second
  runner for the same spec exits 3 before touching docker, the logs or `exit.json`, and logs
  `another runner (pid N) owns this job dir`. A lock whose pid is dead (or, on Windows, reused by a
  non-node process) is stale and taken over. Test: two runners on one spec give exactly one
  `docker run`; a stale lock is taken over. This applies to host jobs too (one more file in the job
  dir; argv, env and spec.json are unchanged).
- **Are job-directory ACLs enforced in code?** No. `%USERPROFILE%\.claude-async-jobs` is created
  with `fs.mkdirSync` and inherits the profile's ACL (Erick, SYSTEM, Administrators). Nothing in
  job-core sets or checks an ACL; the "Who can read the raw logs" paragraph describes inheritance,
  not enforcement. The secrets file's ACL is set by the rollout script (`icacls`), also not checked
  at run time. If a stricter ACL is wanted, it is an operator step, not something the code asserts.
- **Can the agent rename or replace the root-owned `~/.claude` through its parent?** On the
  round-1 image, in principle yes (`/home/agent` was agent-owned), and in practice no only because
  overlayfs returned `EXDEV` for the lower-layer directory. Measured on the round-1 image: the
  rename fails `EXDEV`, `mv` falls back to copy and cannot delete the root-owned entries, so
  `~/.claude` survives. Fixed anyway: `/home/agent` is root-owned now, the rename is `EACCES`, and
  the smoke test checks it (above). On an image built before round 1 (`~/.claude` agent-owned) the
  agent could simply write `settings.json`; that image must not be used.
- **Does the bridge supervisor use the same config dir and port as the admitting process?** On
  claunker both come from `ecosystem.config.cjs` (pm2) or the Task Scheduler entry, which is also
  where `CLAUDE_ASYNC_ALLOWED_SANDBOXES` lives; the bridge now refuses to start when that policy
  allows container mode and its own `http.json` (under its own `CLAUDE_ASYNC_CONFIG_DIR`) has no
  hash, and prints the path it read, so a mismatch shows up as a refusal at the next restart
  rather than as an open port. Not verified on claunker from here.
- **Verified setup-token revocation?** Still unverified. No per-token revoke procedure for
  `claude setup-token` tokens could be confirmed from here (no CLI command, docs not fetchable).
  Treat a leaked token as live until it expires; see Rollback and the objection above.
- **What does the CLI still load from the clone under `--setting-sources user`?** Measured in the
  rebuilt image with a hostile repo fixture (`CLAUDE.md` with a marker, `.claude/settings.json`
  with a SessionStart hook and an `ANTHROPIC_BASE_URL` redirect, `.claude/agents/hostile-agent.md`
  and `.claude/skills/hostileskill/SKILL.md` each with a frontmatter `PreToolUse` hook,
  `.claude/commands/hostilecmd.md`, `.mcp.json`), driving the model through a fake API that
  requests `Skill`, `Agent` or `Bash` calls and logs every request body:
  - **Control (no flag):** the repo `CLAUDE.md` is in the system prompt; the agent, skill and
    command descriptions are advertised; `Skill hostileskill` launches it (its body reaches the
    model); `/hostilecmd` expands; `Agent hostile-agent` runs (its body reaches the subagent); the
    settings SessionStart hook runs; the `ANTHROPIC_BASE_URL` redirect takes effect (the run hangs
    on the dead port).
  - **Production flags (`--setting-sources user --strict-mcp-config --mcp-config '{"mcpServers":{}}'`):**
    none of it. The repo `CLAUDE.md` is not in any request; no agent, skill or command marker
    appears anywhere; `Skill hostileskill` returns `Unknown skill`; `Agent hostile-agent` returns
    `not found` (available: the built-ins only); `/hostilecmd` is sent as literal text; no hook
    marker file is created (the frontmatter hooks never had a chance to run because their owners
    never loaded); no request leaves for the repo's URL. Only the mounted user `CLAUDE.md` loads.
  So under the production flags the clone contributes nothing to the CLI's configuration or
  instructions. The flip side is the repo `CLAUDE.md` correction above.
- **Argon Q2, `com.docker.cli.exe`:** unverified (no Windows here). Docker Desktop's `docker.exe`
  may hand its work to a `com.docker.cli.exe` child that `TerminateProcess` on `docker.exe` does
  not kill. The cleanup design does not depend on killing it: a client that survives is found by
  the label-based process scan (its command line carries `--label claude-async.job=<id>`) and
  whatever it creates is found by the label-based listing; the hold after a kill covers the
  in-flight create. Confirm on claunker by killing a runner mid-launch and checking
  `claude_check` reports `unconfirmed` until the client is gone.

### Open design questions

- **Per-job, per-repo credentials (Argon): decided and implemented (round 3).** The owner chose not
  to create a bot account at all. Container jobs now act as a GitHub App owned by `icey2488`,
  installed only on the allowed repos; the host mints a one-hour installation token scoped to the
  job's one repo (`contents: write`, `pull_requests: write`, `metadata: read`) before `docker run`,
  delivers it as a read-only mounted file, refreshes it in place every 45 minutes and deletes it on
  finish (see "Identity: the GitHub App" and "Token delivery and refresh"). The blast radius of a
  leaked GitHub token is one repo's branches and PRs for at most an hour; it cannot create repos or
  gists even through phase 2's `github.com`/`api.github.com` allowlist. Still open on this path:
  whether an in-place rewrite propagates through a Docker Desktop bind mount (the smoke test
  measures it; a FAIL blocks rollout).
- **Setup-token revocation (Astra): still open.** Until a revoke path is verified, the one-year
  OAuth token is the part of a compromise that cannot be undone quickly. Unchanged by round 3.

## Verified here vs assumed

Verified in this sandbox (Linux, a real Docker engine, a test-only base image):

- the image builds; the verified-bytes install rejects a substituted tarball and the old method did
  not; `claude --version` and a full headless turn with a Bash tool call run in the image;
- `--setting-sources user` ignores a hostile repo's settings, hooks, `apiKeyHelper` and `.mcp.json`
  (fake API, control run included); `~/.claude` is unwritable; the CLI writes only the listed dirs;
- round 2, in the rebuilt image: `/home/agent` root-owned, `~/.claude` cannot be renamed (EACCES),
  `git config --global` still works, a full headless turn with a Bash tool call still runs; the
  clone's `CLAUDE.md`, `.claude/agents`, `.claude/skills`, `.claude/commands` do not load under
  `--setting-sources user` (control run loads all of them); `job-entry.sh` baseRef resolution against
  a local bare repo (host-side test);
- the Bash tool's environment lacks `CLAUDE_CODE_OAUTH_TOKEN` but `/proc/<pid>/environ` has it;
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` needs bubblewrap;
- the entrypoint's clone, base-ref and failure paths (against a local repo via a git URL rewrite);
  the round-1/2 check of `gh auth git-credential` answering from `GH_TOKEN` is superseded (that
  helper is gone);
- run-by-ID after a tag retarget, and `--pull=never` with a missing tag (exit 125);
- cancel at launch, cancel while running, SIGTERM, the wall-clock limit and cleanup confirmation with
  the real runner and engine; `docker rm -f` semantics;
- `container/probe.sh` against open, closed and unresolvable targets in a hardened container;
- the HTTP bridge script with and without a token (401 / 200);
- round 3 (the GitHub App), in a rebuilt image (`claude-async-job:r3`, test-only base) with the real
  engine, the real `startJob()` argv and the real runner, against a fake `api.github.com` (which
  verified every App JWT with the test key) and a fake https `github.com` serving a bare repo with
  Basic auth checked against the tokens the fake issued: the creds dir arrives read-only at
  `/run/claude-async/creds` with the token file 0600 and owned by uid 1000; `env` and
  `/proc/self/environ` in the job shell have no `GH_TOKEN`; `gh auth token` (the wrapper) returns
  the file's token; the entrypoint's clone authenticated through the credential helper with
  generation 1; a `git ls-remote` after three in-place rewrites authenticated with generation 4 (the
  rewrite propagated into the running container through the Linux bind mount); `.git/config` holds
  no token; `exit.json` tails show `[REDACTED]` for every generation; the creds dir is gone on
  finish; cleanup confirmed; no container left. The unit tests cover the JWT (`crypto.verify`), the
  request bodies, the error paths, the key-file permission check, the runner's modes/inode/refresh/
  failure/delete paths, the credential helper via `git credential fill`, and the gh wrapper.

Not verified here:

- Docker Desktop on Windows, the real `node:24-bookworm-slim` base, host Ollama, and whether
  `host.docker.internal` reaches the Windows host's `127.0.0.1` (the smoke test measures it);
- **whether an in-place rewrite of the token file propagates through a Docker Desktop bind mount**
  (Linux bind mounts do; the smoke test's section 5b measures it and fails if it does not);
- the real GitHub App endpoints (installation lookup, `access_tokens`, `/app`, `/users/<slug>[bot]`)
  and that GitHub links `<id>+<slug>[bot]@users.noreply.github.com` commits to the App: the request
  and response shapes follow GitHub's REST documentation from memory and were exercised only against
  the fake; `tools\mint-app-token.mjs` on claunker is the first real call;
- `container/smoke-test.ps1` itself: no PowerShell was available, so its PowerShell logic was
  reviewed but never run;
- a real `claude -p` on the subscription token, and real GitHub clone/push/PR as the App;
- the ICC-off phase-1 network and the phase-2 proxy;
- whether the app's Connectors UI can send a bearer header to the HTTP bridge;
- a revoke path for `claude setup-token` tokens; GitHub's collaborator-level page; Anthropic's
  install and network-config pages (not fetchable from here).
