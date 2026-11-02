# Container jobs (`sandbox: "container"`)

Container jobs run the Claude Code CLI inside a Docker container on claunker instead of on the bare
Windows host. A container job gets a full shell and runs with `--dangerously-skip-permissions`, but
it can see only the one repository it was given. It commits, pushes a branch and opens a PR as a
dedicated GitHub machine account (the bot), never as Erick. Erick then reviews and merges the PR.

Container mode is **opt-in per job and off by default**. Windows-admin jobs (scheduled tasks,
services, firewall checks) stay on the host under the existing modes: skip-permissions, or safe
mode (`CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS=1`). When container mode is off, every job's argv,
environment and `spec.json` are unchanged.

| piece | file |
|---|---|
| argv building, validation, kill, `.git` audit | `container.mjs` |
| launch integration (`sandbox` param, preflight, `cancelJob`, reap) | `job-core.mjs` |
| runner: kill on signal, kill in `finish()`, post-run `.git` audit | `job-runner.mjs` |
| `sandbox` on `claude_start` / `POST /v1/start`, new `claude_cancel` | `dispatch.mjs`, `host-api.mjs` |
| job image | `container/Dockerfile` |
| rules mounted read-only into every job | `container/CLAUDE.md` |
| image build + checks on claunker | `container/smoke-test.ps1` |
| tests | `test/container.test.mjs`, `test/container-runner.test.mjs` |

## Why

Today a job either runs with `--dangerously-skip-permissions`, where everything Erick's Windows
account can read is reachable, or in safe mode. Safe mode's pattern rules leak: `node -e`,
`python -c` and `git -C x push` all get past them (see `docs/publishing.md`, "Threat model"). In
both modes `git push` would use Erick's own full GitHub credential from Git Credential Manager.
Container jobs change the boundary from "what the permission rules happen to match" to "what is
mounted and what credential is present". A job can do anything inside the container. That covers
only one repo and a bot token that can't do anything Erick's repos don't allow the bot to do.

## Threat model

Read this before you count on the container for anything.

**What the container boundary protects:**

- **Erick's files and credentials.** Nothing from `%USERPROFILE%` is mounted. That includes
  `.ssh`, `.claunker`, `.claude` (Erick's own Claude Code login), `.claude-async` (Discord
  webhook, hosts.json, api.json), `.claude-async-jobs` (other jobs' logs), Git Credential Manager,
  the Windows Credential Manager and gh's stored token. No other repo under `D:\code` is mounted,
  and neither is the live chassis (`D:\claunker`). The container's mount table holds exactly three
  bind mounts. The smoke test checks this.
- **Erick's GitHub identity.** The only GitHub credential in the container is the bot's token. A
  job can push only where the bot is a collaborator (or to the bot's own forks). Main stays
  protected by the existing rules: no deletion, no force-push.
- **The host OS.** The job runs as uid 1000, not root, with `--cap-drop ALL` and
  `--security-opt no-new-privileges`. It has no Docker socket and gets CPU, memory and PID limits.

**What it does NOT protect:**

- **The mounted repo.** The repo is mounted read-write, including `.git`. A confused job can wreck
  the working tree, delete branches locally, rewrite local history, or delete `.git` entirely.
  Unpushed work in that clone is at risk. Mitigation: give container jobs **dedicated clones**
  (for example `D:\code\jobs\<repo>`), not the working copies Erick edits by hand.
  `CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS` should point at that folder only.
- **Code that runs on the host later.** The host runs git in the same repo after the job: the
  card hook's `git rev-parse HEAD`, and later Erick himself. A job can plant `.git/config` entries
  that execute on the host (`core.fsmonitor`, `core.hooksPath`, filter drivers, `include.path`,
  `credential.helper`), or a `.git/hooks/*` script. Mitigation: job-core records the repo's
  host-executing config keys and hooks before the job (`auditRepoGitState()`, using the same
  allowlist as `publish-branch.mjs`). After the container exits, the runner compares the repo
  against that list and reports anything new in `exit.json` (`container.newGitFindings` plus a
  warning) and in `err.log`. When there are findings, it also skips the card hook's host git
  call. **It reports. It does not clean up.** If `claude_check` shows that warning, inspect the repo
  before you run git in it. Planted files in the working tree, such as a `Makefile`,
  `package.json` scripts or a `.vscode/tasks.json`, also run on the host if Erick runs them there.
  Review the PR before you build it locally.
- **The bot token, against the bot's own reach.** The job holds the bot's token and can use it for
  anything that token allows: push branches to every repo the bot can write to, open or close
  issues and PRs, and comment. A classic PAT can't be scoped to selected repos (see "Identity"
  below), so the bot's reach is exactly its collaborator list. Keep that list short.
- **The network (phase 1).** On the default bridge network a job can reach the whole internet, so
  it can exfiltrate the repo's contents and the two tokens in its environment. Phase 2 (below)
  narrows egress to an allowlist.
- **Host loopback services.** `host.docker.internal` reaches the Windows host. That is how host
  Ollama is reachable, and the same path can reach other services listening on the host (whether
  that includes services bound only to `127.0.0.1` is unverified; assume it does). Two of them
  would be a way out of the sandbox:
  - `claude-async-http.mjs` on `127.0.0.1:7842` is an unauthenticated MCP endpoint. A job that
    reached it could start a `sandbox: "host"` job with skip-permissions.
  - The Docker Engine TCP API on `2375` exists if "Expose daemon on tcp://localhost:2375 without
    TLS" is ever turned on in Docker Desktop settings.

  The smoke test probes both ports and fails if either is reachable. Never enable the 2375 setting.
  If 7842 turns out to be reachable on claunker, the fix is to stop running the HTTP bridge (or
  front it with an auth token) before enabling container mode. Phase 2's internal network removes
  this path entirely, because the job then has no route to the host except through the proxy.
- **The Docker daemon itself.** Anyone who can talk to the Docker daemon controls the host:
  `docker run -v C:\:/host` mounts the whole disk. So a job must **never** get the Docker socket
  (`//./pipe/docker_engine`, `/var/run/docker.sock`), `DOCKER_HOST`, or the TCP API above.
  `container.mjs` mounts nothing beyond its three fixed mounts, and the tests assert that the argv
  never mentions a socket or pipe. This also means a container job can't run Docker itself
  (no docker-in-docker). Jobs that need Docker stay on the host.
- **Container escapes.** The container shares a Linux kernel with Docker Desktop's WSL2 VM. A
  kernel or runtime escape would land in that VM, which can reach the Windows filesystem through
  its file-sharing mounts. Non-root, no capabilities and no-new-privileges make that much harder.
  They don't make it impossible. This is a sandbox for confused or over-eager jobs, not for
  hostile code.
- **Prompt injection still steers the job.** Content the job reads (issues, web pages, dependency
  READMEs) can still steer what it does inside the sandbox, including what it pushes. Branch
  protection and Erick's review of every PR are the backstop.

### Why `--dangerously-skip-permissions` inside

Inside the container, the permission system has nothing left worth guarding. A job could already
run arbitrary code through `node`, `python`, `uv` or `npm`, and the leaks safe mode documented
(`node -e`, `git -C x push`) go away because there is nothing else on the box to reach. What a job
can touch is decided by the mounts, the token and the network, not by pattern rules. So container
jobs use skip-permissions, which gives them the full shell Erick wants. The **no-background hook
still runs**: it is mounted read-only from this repo's `hooks/` and wired by
`buildContainerSettings()`. The job-tool-gate and Ollama-guard hooks stay host-only. The gate
needs the host's claunker-hermes checkout. The Ollama guard exists for dontAsk mode, which
container jobs don't use.

Claude Code refuses `--dangerously-skip-permissions` when it runs as root outside a recognized
sandbox. The string "--dangerously-skip-permissions cannot be used with root/sudo privileges" is in
the 2.1.309 binary. The image runs as uid 1000, so that check never fires.

## What is mounted

Exactly three bind mounts, built by `buildDockerRunArgv()`:

| host | container | mode |
|---|---|---|
| the job's `workFolder` (realpath) | `/workspace` (also the working dir) | read-write |
| `container/CLAUDE.md` (or `CLAUDE_ASYNC_CONTAINER_CLAUDE_MD`) | `/home/agent/.claude/CLAUDE.md` | read-only |
| this repo's `hooks/` | `/opt/claude-async/hooks` | read-only |

`/home/agent/.claude/CLAUDE.md` is Claude Code's user-level memory file, so the job rules apply in
addition to the repo's own `CLAUDE.md`. Because the file is read-only, a job can't rewrite its
own rules.

**`workFolder` validation** (`validateWorkFolder()`, run before the job dir exists):

- It must be absolute and must exist. It is resolved with `fs.realpathSync.native`, which follows
  symlinks *and* Windows junctions, and a `\\?\` long-path prefix is stripped. The **target** is
  judged, so `D:\code\jobs\innocent` that is a junction to `C:\Users\Raide` is refused.
- It must be strictly inside one of `CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS`, using the same
  `isInside()` check as `publish-branch.mjs` (case-insensitive on win32, and `D:\code-private`
  doesn't count as inside `D:\code`). It can't be the root itself, which would mount every repo
  under it. There is **no default root**: if the variable is unset, every container job is refused.
- It must not overlap a denied path in either direction. The claude-async checkout is always
  denied, because a job editing it would be editing the code the bridge runs on the host.
  `CLAUDE_ASYNC_CONTAINER_DENIED_ROOTS` adds more (for example `D:\claunker`).
- It must be a git top-level with a real `.git` **directory**. A linked worktree or submodule has a
  `.git` file pointing at a git dir outside the mount, so git wouldn't work inside the container.
  Those are refused with a message saying to use a full clone.
- Paths with a comma, a double quote or a control character are refused, because `--mount` is a
  CSV field list. UNC paths are refused too, since Docker Desktop shares local drives.

## How secrets reach the container

Only two secrets ever enter a container: the bot's GitHub token (`GH_TOKEN`) and the Claude Code
OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`). They live in one host file, the "secrets env file", in
Docker's `--env-file` format:

```
GH_TOKEN=ghp_...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

- **By path, never by value.** job-core passes `--env-file <path>` and Docker reads the file
  itself. Neither the docker argv nor `spec.json` nor `meta.json` ever holds a value (the tests
  assert this). Every non-secret variable goes in as an explicit `-e NAME=value`. A bare `-e NAME`
  is never used, because it would copy the host's own value in. Any `-e` name that looks like a
  credential throws.
- **Checked before every job, values never echoed.** `checkEnvFile()` reads the file only to
  check its shape. It returns key names, never values. It refuses: a key other than the two above
  (notably `ANTHROPIC_API_KEY`, which outranks `CLAUDE_CODE_OAUTH_TOKEN` and would silently switch
  billing from the subscription to the API), a missing or empty key, a duplicate, a bare `KEY` line,
  CRLF line endings or a UTF-8 BOM (Docker would keep the `\r` in the value or put the BOM in the
  first key name), and a file inside the repo or any allowed root.
- **Never in the image.** `container/Dockerfile` takes no secret build args, and nothing in it
  reads one.
- **Never logged by claude-async.** The job itself can print its own environment, and
  `container/CLAUDE.md` tells it not to. A job that does anyway writes the tokens into `out.log` in
  the job dir on the host. That leak is bounded by what the tokens can do, which is why both are
  dedicated (bot-only GitHub token, revocable Claude Code token).
- **Why not Docker secrets?** Docker secrets (`/run/secrets/...`) are a Swarm/Compose feature. A
  plain `docker run` can't use them without Swarm. Mounting a secrets *file* read-only would be
  equivalent to `--env-file` here, because the job runs as the user that reads it either way. And
  gh and Claude Code read their tokens from environment variables, so the env file is simplest.

## Claude Code authentication inside the container

Verified against Anthropic's authentication docs
(<https://code.claude.com/docs/en/authentication>, section "Generate a long-lived token"):

> For CI pipelines, scripts, or other environments where interactive browser login isn't
> available, generate a one-year OAuth token with `claude setup-token` ... copy it and set it as
> the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate ... This
> token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise
> plan. It can only make model requests.

The same page's precedence list ranks `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then
`apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then `/login` credentials. That is why the env file
may not carry `ANTHROPIC_API_KEY`. The page also notes that `--bare` mode does not read
`CLAUDE_CODE_OAUTH_TOKEN`, so container jobs never pass `--bare`.

So: run `claude setup-token` once on claunker, in a browser session logged in to Erick's
subscription, and put the printed token in the secrets file. It lasts one year. Put a calendar
reminder to regenerate it before then. The container never sees `%USERPROFILE%\.claude`, so
Erick's interactive login is untouched.

The image sets `hasCompletedOnboarding` in `/home/agent/.claude.json`, so the first `claude -p`
run doesn't stop at first-run setup. Without a token, the image's CLI prints
`Not logged in · Please run /login` (observed in this sandbox). The end-to-end headless call with
a real token could not be run here. `container/smoke-test.ps1 -EnvFile ... -RunClaude` does it on
claunker.

## Ollama delegation

Jobs are expected to delegate eligible work to `qwen2.5-coder:7b` on the host's Ollama. Inside the
container, `localhost:11434` is the container itself, so:

- `--add-host host.docker.internal:host-gateway` is always passed. Docker Desktop already provides
  that name, and the flag makes it explicit and also works on a plain Linux engine.
- `OLLAMA_HOST` and `CLAUDE_ASYNC_OLLAMA_URL` are set to `http://host.docker.internal:11434`
  (override: `CLAUDE_ASYNC_CONTAINER_OLLAMA_URL`). `container/CLAUDE.md` tells jobs to use
  `$OLLAMA_HOST`. The `ollama` CLI isn't in the image. Use the HTTP API with curl.
- **Erick's global CLAUDE.md names `127.0.0.1:11434`.** Inside the container that address is wrong,
  and the container's `CLAUDE.md` overrides it. Job prompts written from the host's template should
  say "use `$OLLAMA_HOST`", or leave the URL out.
- Docker's docs say `host.docker.internal` "resolves to the internal IP address of your host" and
  show a container reaching a host service through it
  (<https://docs.docker.com/desktop/features/networking/networking-how-tos/>). They don't say
  whether a service bound only to the host's `127.0.0.1` is reachable that way. My understanding is
  that Docker Desktop forwards it, but that is unverified, and the smoke test checks it. If Ollama
  is reachable on the host but not from the container, set
  `OLLAMA_HOST=0.0.0.0:11434` for the Ollama service and allow the port through Windows Firewall
  for the WSL/Docker virtual adapter only. The smoke test checks reachability and that
  `qwen2.5-coder:7b` is listed.
- Phase 2 keeps this path through the proxy's allowlist (see below).

## Git identity and credentials inside

- **Identity.** job-core sets `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` and
  `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` from `CLAUDE_ASYNC_CONTAINER_GIT_NAME` and
  `CLAUDE_ASYNC_CONTAINER_GIT_EMAIL`, which are required. Environment variables beat the repo's
  `user.name`/`user.email`, so every commit is the bot's even in a repo whose local config names
  Erick. Use the bot's noreply address (`<id>+<login>@users.noreply.github.com`, shown under the
  bot's Settings, Emails) so commits link to the bot account.
- **Credentials.** `gh` reads `GH_TOKEN` directly. For `git push` over https, the job runs
  `gh auth setup-git` once, which registers gh as git's credential helper in the container's
  `~/.gitconfig`. That file lives in the container's own home and dies with `--rm`. It never
  touches the repo's `.git/config`, so the host never sees it. `container/CLAUDE.md` says to do
  this. There is no SSH key in the container, so remotes must be https (an `git@github.com:` origin
  needs `git remote set-url origin https://github.com/<o>/<r>.git` once, in the job clone).
- **Ownership.** The bind-mounted repo is owned by the Windows user, and git refuses a repo owned
  by someone else, so the image sets `safe.directory=/workspace` (system config, that one path only).
- **Line endings.** Git for Windows defaults to `core.autocrlf=true` in the host's *global*
  config, which the container doesn't see. A clone checked out on Windows has CRLF in the working
  tree, and Linux git without the same setting would show every text file as modified. job-core
  passes `core.autocrlf` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`
  (default `true`, override `CLAUDE_ASYNC_CONTAINER_GIT_AUTOCRLF`), so the container matches the
  host. Repos with a `.gitattributes` (this one has `* text=auto` plus CRLF for `*.ps1`) behave
  the same either way. Observed in this sandbox: a file the job wrote with LF got git's "LF will be
  replaced by CRLF" note, which is the expected behavior with autocrlf=true.

## How jobs open PRs

Inside the container the job uses `git` and `gh` directly, as the bot:

```
git switch -c feat/short-slug
... work, commit ...
gh auth setup-git
git push -u origin feat/short-slug
gh pr create --fill            # or --title/--body
```

**Should jobs use `scripts/publish-branch.mjs` inside the container?** No, not by default. That
script exists because safe mode can't allow raw `git push`, so it wraps one validated push and PR
behind an allow rule. Inside the container nothing stops a job from running `git push` itself, so
the script's checks would be advisory only. The real limits are server-side: the bot's
collaborator list, the token's scopes and branch protection. It isn't mounted today. If Erick
later wants its strict branch-name rule and idempotent PR step, mount `scripts/` read-only and set
`PUBLISH_ALLOWED_ROOTS=/workspace` and `PUBLISH_ALLOWED_OWNERS=<owners>` in the container. Its
audit log would also need a host mount, or it would vanish with `--rm`. For now, the runner's
`out.log` and GitHub's own event history are the audit trail for container jobs.

### Cross-owner contributions (forks)

When the repo belongs to someone else and the bot isn't a collaborator:

```
gh repo fork --remote --remote-name fork       # creates <bot>/<repo>, adds remote "fork"
git push -u fork feat/short-slug
gh pr create --repo <owner>/<repo> --head <bot-login>:feat/short-slug --fill
```

The bot forks the upstream under its own account, pushes to its fork, and opens the PR against the
upstream. That needs a classic token (next section). `container/CLAUDE.md` describes exactly this
flow.

## Identity: the bot account and its token

### One machine account is allowed

GitHub's Terms of Service, section B.3 "Account Requirements"
(<https://docs.github.com/en/site-policy/github-terms/github-terms-of-service>):

> One person or legal entity may maintain no more than one free Account ... We do permit machine
> accounts: A machine account is an Account set up by an individual human who accepts the Terms on
> behalf of the Account, provides a valid email address, and is responsible for its actions. A
> machine account is used exclusively for performing automated tasks. ... You may maintain no more
> than one free machine account in addition to your free Personal Account.

So Erick may run **one** free machine account next to `icey2488`. He is responsible for its
actions, it needs its own valid email, and it must be used only for automated tasks.

### Classic PAT, not fine-grained

GitHub's token docs
(<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>)
list what fine-grained tokens can't do. Among the gaps: "contribute to repositories where the user
is an outside or repository collaborator", "contribute to public repos where the user is not a
member", and "access multiple organizations at once". They also say: "Only personal access tokens
(classic) have write access for public repositories that are not owned by you." A fine-grained
token's resource owner is a single account, so a token owned by the bot can't target `icey2488`'s
repos at all. The bot is a *repository collaborator* on Erick's repos, which is exactly the
unsupported case. So the bot needs a **classic** PAT.

Minimum scopes (scope text from <https://docs.github.com/en/enterprise-cloud@latest/developers/apps/scopes-for-oauth-apps>):

| scope | why |
|---|---|
| `repo` | "Grants full access to public, internal, and private repositories including read and write access to code". Needed to push branches and open PRs on Erick's **private** repos where the bot is a collaborator. If every target repo is public, use `public_repo` instead ("Limits access to public repositories"): it covers pushing, forking and cross-owner PRs on public repos. |
| `workflow` (only if needed) | "Grants the ability to add and update GitHub Actions workflow files." Without it, GitHub rejects any push that touches `.github/workflows/`. **Leave it off** unless jobs are meant to edit CI. That is a useful guard: a job can't change what CI runs with repo secrets. |
| `read:org` | Not needed for personal-account repos. Add it only if a job must see org team membership. |

Nothing else. Specifically: no `delete_repo`, no `admin:*`, no `write:packages`, no `gist`, no
`user`. A classic `repo` token can reach **every** repo the bot is a collaborator on, so the bot's
collaborator list *is* the token's scope. Invite it only where jobs should push. Set an
expiration (90 days is reasonable) and rotate.

Server-side backstops that still apply:

- **Branch protection on main** (already there): no deletion, no force-push. Erick decided not to
  add a "require a PR" rule. Note what that means: the bot has write access, so a job *could* push
  directly to main (fast-forward only). `container/CLAUDE.md` forbids it. Nothing on GitHub
  enforces it. If that ever matters, a ruleset that restricts pushes to main to Erick (or requires
  a PR, with Erick as a bypass actor) closes it without changing his own workflow.
- **Collaborator permission level.** Personal-account repos have only one collaborator permission
  level (write: push, manage issues and PRs). There is no finer role there, so the bot can also
  merge PRs and close issues. Only branch protection, rulesets and Erick's review limit that.

## Network egress

### Phase 1 (implemented): default bridge network

`--network bridge` (configurable with `CLAUDE_ASYNC_CONTAINER_NETWORK`; `host` and `none` are
refused). The job can reach the whole internet. **Documented risk:** a job can exfiltrate the
repo, `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` to anywhere. That is acceptable only because both
tokens are dedicated and revocable, and the repo is one Erick chose to mount. The image sets
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`, so the CLI itself makes
no telemetry, error-reporting or update calls.

### Phase 2 (designed, not implemented): egress allowlist

The job runs on an **internal** Docker network, which has no route out at all. A small proxy
container is the only thing attached to both that network and a normal one, and it allows a fixed
list of hosts.

```
            claude-jobs  (docker network create --internal claude-jobs)
  +--------------------+          +--------------------------+       bridge
  |  job container     | -------> | egress-proxy (squid)     | ----> internet (allowlisted hosts)
  |  HTTPS_PROXY=      |  :3128   | on claude-jobs + bridge  | ----> host.docker.internal:11434
  |  http://egress-    |          +--------------------------+
  |  proxy:3128        |
  +--------------------+   no other route out, no host gateway
```

Setup (one time, on claunker):

```powershell
docker network create --internal claude-jobs
docker run -d --name egress-proxy --restart unless-stopped `
  --network bridge --add-host host.docker.internal:host-gateway `
  -v D:\claude-async-proxy\squid.conf:/etc/squid/squid.conf:ro ubuntu/squid:<pinned>
docker network connect claude-jobs egress-proxy
```

`squid.conf` (CONNECT-only for TLS; squid never decrypts, it only sees the hostname):

```
http_port 3128
acl jobs src 172.16.0.0/12
acl ssl_ports port 443
acl ollama_port port 11434
acl CONNECT method CONNECT
acl allowed_tls dstdomain github.com api.github.com codeload.github.com uploads.github.com
acl allowed_tls dstdomain objects.githubusercontent.com release-assets.githubusercontent.com raw.githubusercontent.com
acl allowed_tls dstdomain registry.npmjs.org pypi.org files.pythonhosted.org
acl allowed_tls dstdomain api.anthropic.com
acl ollama dstdomain host.docker.internal
http_access allow jobs CONNECT ssl_ports allowed_tls
http_access allow jobs ollama ollama_port
http_access deny all
access_log stdio:/proc/self/fd/1
```

Then set, on the bridge:

```
CLAUDE_ASYNC_CONTAINER_NETWORK=claude-jobs
CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY=http://egress-proxy:3128
```

`container.mjs` already supports this. With `CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY` set it adds
`HTTPS_PROXY`/`HTTP_PROXY` (both cases) and `NO_PROXY=localhost,127.0.0.1` to the container, and
`OLLAMA_HOST` keeps pointing at `host.docker.internal`, which goes through the proxy. `npm`,
`pip`, `uv`, `git`, `gh`, `curl` and Claude Code all honor `HTTPS_PROXY`. The string `HTTPS_PROXY`
appears 70 times in the 2.1.309 binary, but its docs page
(<https://code.claude.com/docs/en/network-config>) could not be fetched from here, so the CLI's
proxy support is unverified. The smoke test should confirm one real call through the proxy.

Which hosts Claude Code needs: the 2.1.309 binary references `api.anthropic.com` (inference),
`platform.claude.com`/`claude.ai` (login and OAuth, not needed with a setup-token),
`downloads.claude.ai` and a `storage.googleapis.com` bucket (updates, disabled by
`DISABLE_AUTOUPDATER`), `mcp-proxy.anthropic.com` (claude.ai connectors, which the setup-token
can't use), and Datadog/GrowthBook endpoints (telemetry and flags, disabled by
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). With those two variables set, the allowlist needs only
`api.anthropic.com`. Verify by running one job with squid's access log on and adding anything it
denies that is legitimate. Anthropic's network-config page lists the required hosts but could not
be fetched from here (see "Not verified").

Trade-offs: the proxy sees hostnames, not content, so `github.com` allows pushing to *any* repo on
GitHub. The token's reach limits that, not the proxy. A job can still exfiltrate through an
allowed host (a gist, a PR comment, an npm publish if it had a token, which it doesn't). Phase 2
removes the "send it anywhere" channel. It doesn't remove "send it to GitHub". It also closes the
host-loopback path (see the threat model), since the internal network has no host gateway.

## Resource limits

| flag | default | env override |
|---|---|---|
| `--cpus` | `4` (clamped to the CPUs the host reports; docker refuses more) | `CLAUDE_ASYNC_CONTAINER_CPUS` |
| `--memory` and `--memory-swap` (same value, so no swap on top) | `8g` | `CLAUDE_ASYNC_CONTAINER_MEMORY` |
| `--pids-limit` | `1024` (stops fork bombs; plenty for npm/pytest) | `CLAUDE_ASYNC_CONTAINER_PIDS_LIMIT` |

These apply inside Docker Desktop's WSL2 VM, whose own size is set in `%USERPROFILE%\.wslconfig`
(`[wsl2] memory=..., processors=...`). Give the VM enough for the concurrency cap
(`CLAUDE_ASYNC_MAX_CONCURRENT`, default 4) times the per-job memory, or lower one of them.
Disk isn't limited per container (the writable layer is ephemeral and `--rm`'d). The bind-mounted
repo is on the host disk.

## Lifecycle, cancel and cleanup

- `--rm`: the container is deleted when it exits. Nothing a job writes outside `/workspace`
  survives, including `~/.gitconfig` and the `gh auth setup-git` state.
- `--name claude-async-<jobId>`: one container per job, named after the job id. The job id is
  already restricted to `[A-Za-z0-9._-]`, which is also valid for container names. A duplicate
  start is refused by the job dir check first. `--label claude-async.job=<jobId>` allows
  `docker ps --filter label=claude-async.job` to list them.
- `--init`: tini as PID 1 reaps the CLI's children and forwards signals.
- **Cancel:** the new `claude_cancel` tool calls `cancelJob()`, which runs
  `docker kill claude-async-<jobId>`. Killing the docker *client* process alone doesn't stop the
  container (a Windows `TerminateProcess` on `docker.exe` sends nothing to the daemon). So every
  path kills **by name**:
  1. `cancelJob()` kills the container. The docker client then exits with the container's status
     (137), and the runner records `exit.json`, `exit_code`, the card close and the Discord ping
     through its normal path. claude_check reports `failed` with exit code 137.
  2. The runner kills the container by name on SIGTERM/SIGINT/SIGHUP (and SIGBREAK on Windows),
     then waits up to 30s for the client to exit before recording.
  3. The runner's `finish()` always runs `docker kill <name>` too. Normally it gets
     "No such container", which is treated as success.
  4. `checkJob()` kills the container (once, `meta.containerReaped`) when it classifies a container
     job as `died` or `timed_out`, which covers a runner killed by `TerminateProcess`.
- Verified end to end in this sandbox with a real Docker engine: cancel during a run gave exit 137
  and status `failed`; SIGTERM to the runner killed the container and recorded 137; no containers
  were left over in either case.

## Windows specifics

- **Bind mount paths.** `toDockerMountSource()` turns `D:\code\jobs\x` into `D:/code/jobs/x`,
  which Docker Desktop accepts as a bind source. Spaces are fine, because each `--mount` value is
  one argv element and no shell is involved. Commas and quotes are refused. UNC paths are refused.
- **The drive must be shared.** With the WSL2 backend, every local drive is available by default.
  If `D:` was excluded under Docker Desktop's Resources, File sharing, mounts fail with exit 125.
  The runner flags that in `exit.json` warnings ("docker run itself failed").
- **Performance.** A bind mount from NTFS into the WSL2 VM is noticeably slower than the VM's own
  filesystem for many small files (`npm install`, big test suites). It's acceptable for typical
  jobs. If it hurts, a later change can clone into a volume instead of bind-mounting, at the cost of
  the host not seeing the working tree.
- **Line endings:** see "Git identity and credentials inside".
- **The docker binary.** `CLAUDE_ASYNC_DOCKER_BIN` (default `docker`) is resolved the same way the
  `claude` binary is. Under Task Scheduler, PATH may not include Docker Desktop's
  `C:\Program Files\Docker\Docker\resources\bin`, so set the full path to `docker.exe`.
- **Docker Desktop must be running** and its engine started. Preflight runs
  `docker image inspect <image>` and refuses the job with "is Docker Desktop running?" otherwise.
  Docker Desktop starts at sign-in by default. Jobs started right after a reboot, before sign-in
  or before the engine is up, fail fast in preflight rather than mid-run.

## What keeps working, and how

The runner still owns the child process. The child is now `docker run` (attached, not `-d`),
whose stdout/stderr are the container's. So:

| feature | container jobs |
|---|---|
| job record (`meta.json`, `spec.json`) | unchanged, plus `sandbox: "container"` and `container: {name, image, dockerBin}` in meta, and `container: {name, dockerBin, repo, gitBaseline}` in spec |
| heartbeat, `runner.pid`, Job Object records | unchanged (the runner is the same process) |
| stdout/stderr capture | unchanged: docker's stdout/stderr are the container's, written to `out.log`/`err.log` |
| `exit.json`, `exit_code`, status | unchanged: docker exits with the CLI's exit code. 125 means docker itself failed (warning added), 137 means killed. Plus `exit.container` = `{name, newGitFindings}` |
| DELEGATION-METRICS completeness | unchanged (read off stdout). Verified end to end |
| card hook | mint and close unchanged. The delivery check's host `git rev-parse HEAD` is skipped when the post-run `.git` audit found new host-executing config |
| Discord ping | unchanged (runs in the runner, on the host) |
| concurrency and rate caps, depth guard | unchanged. `CLAUDE_ASYNC_DEPTH` is forwarded into the container |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `BASH_MAX_TIMEOUT_MS`, bg-wait ceiling | forwarded into the container |
| HERMES_HOME isolation | not applied: nothing from the host env reaches the container except an allowlist, so the job never sees `HERMES_HOME` at all |
| job-tool-gate, Ollama guard hooks | not wired (host-only, see above) |
| multi-host | `sandbox` is forwarded to a receiver when given. A Linux receiver can run container jobs with a plain Docker Engine (`--add-host ...:host-gateway` makes `host.docker.internal` work there too). `claude_cancel` is local-only for now |

## What stays on the host, and why

- **Windows-admin jobs**: scheduled tasks, services, firewall rules, registry, Task Scheduler
  checks, anything with PowerShell `Get-Service`/`schtasks`. A Linux container can't see or change
  any of that.
- **Jobs that need Docker**, or GPU access, or several repos at once (for example a
  cross-repo refactor). Mount several repos only after a design change. Today's rule is one repo
  per job.
- **Jobs on the live chassis** (`D:\claunker`): they stay forbidden in any mode.
- **The bridge, runner, launcher, card hook and Discord ping.** They run on the host and must,
  because they hold the host-side state and secrets (the webhook) that jobs must not see.

## Configuration reference

All set on the bridge process (ecosystem.config.cjs `env`, or the user environment that Task
Scheduler gives job-launcher.mjs). Only names starting `CLAUDE_` reach the runner through the
launch ticket. These are only read by job-core at start time, so they don't need to.

| variable | default | notes |
|---|---|---|
| `CLAUDE_ASYNC_JOB_SANDBOX` | unset (host) | exactly `container` makes container mode the default. A per-call `sandbox: "host"` still wins |
| `CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS` | **none** (required) | `;`-separated on win32. Recommended: one folder of dedicated job clones |
| `CLAUDE_ASYNC_CONTAINER_DENIED_ROOTS` | none | extra paths never mountable (the claude-async checkout is always denied) |
| `CLAUDE_ASYNC_CONTAINER_ENV_FILE` | **none** (required) | the host secrets file, outside every repo |
| `CLAUDE_ASYNC_CONTAINER_GIT_NAME` / `_GIT_EMAIL` | **none** (required) | the bot's commit identity |
| `CLAUDE_ASYNC_CONTAINER_IMAGE` | `claude-async-job:local` | built on claunker, never pulled |
| `CLAUDE_ASYNC_DOCKER_BIN` | `docker` | set the full path to `docker.exe` |
| `CLAUDE_ASYNC_CONTAINER_CPUS` / `_MEMORY` / `_PIDS_LIMIT` | `4` / `8g` / `1024` | |
| `CLAUDE_ASYNC_CONTAINER_NETWORK` | `bridge` | `host` and `none` are refused |
| `CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY` | unset | phase 2 |
| `CLAUDE_ASYNC_CONTAINER_OLLAMA_URL` | `http://host.docker.internal:11434` | |
| `CLAUDE_ASYNC_CONTAINER_GIT_AUTOCRLF` | `true` | match the host's `core.autocrlf` |
| `CLAUDE_ASYNC_CONTAINER_CLAUDE_MD` | `container/CLAUDE.md` | must be outside the mounted repo |

The `docker run` argv a job gets (sample job; placeholder secrets path):

```
docker run --rm --name claude-async-claunker.demo-20261101-abcd1234
  --label claude-async.job=claunker.demo-20261101-abcd1234 --init --user 1000:1000
  --security-opt no-new-privileges --cap-drop ALL
  --cpus 4 --memory 8g --memory-swap 8g --pids-limit 1024
  --network bridge --add-host host.docker.internal:host-gateway
  --env-file C:\Users\Raide\.claude-async-secrets\container.env
  -e CLAUDE_ASYNC_JOB_ID=claunker.demo-20261101-abcd1234 -e CLAUDE_ASYNC_SANDBOX=container
  -e CLAUDE_ASYNC_DEPTH=1 -e CLAUDE_ASYNC_JOB_EFFORT=medium
  -e CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=7200000 -e CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
  -e BASH_MAX_TIMEOUT_MS=1200000
  -e GIT_AUTHOR_NAME=claunker-bot -e GIT_COMMITTER_NAME=claunker-bot
  -e GIT_AUTHOR_EMAIL=<id>+claunker-bot@users.noreply.github.com -e GIT_COMMITTER_EMAIL=<same>
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=core.autocrlf -e GIT_CONFIG_VALUE_0=true
  -e OLLAMA_HOST=http://host.docker.internal:11434 -e CLAUDE_ASYNC_OLLAMA_URL=http://host.docker.internal:11434
  --mount type=bind,source=D:/code/jobs/scratch-repo,target=/workspace
  --mount type=bind,source=D:/code/claude-async/container/CLAUDE.md,target=/home/agent/.claude/CLAUDE.md,readonly
  --mount type=bind,source=D:/code/claude-async/hooks,target=/opt/claude-async/hooks,readonly
  --workdir /workspace
  claude-async-job:local
  claude -p --dangerously-skip-permissions --strict-mcp-config --mcp-config {"mcpServers":{}}
    --model=claude-sonnet-5 --effort medium
    --settings {"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node /opt/claude-async/hooks/no-background-hook.mjs","timeout":5}]}]}}
    -- <prompt>
```

Each token above is one argv element (no shell). The prompt is last, after `--`, and the model is
bound with `=`, the same argument-injection rule as the host path.

## The image

`container/Dockerfile`, built on claunker (never pulled):

- Base: `node:24-bookworm-slim`. Node 24 is the bridge's own major (README, "Linux receiver"), and
  the hooks run on the image's node. The tag is pinned to the major, not a digest, because the
  digest couldn't be checked from where this was written. Pin it after the first build (rollout
  step 7).
- gh 2.89.0 and uv 0.13.6 come from GitHub release tarballs, each checked against a pinned
  SHA-256 taken from the release's own checksum file. Debian's gh is too old, and a third-party
  apt repo would be one more thing to trust.
- Claude Code 2.1.309 is installed with `npm install -g` (the method in the package's own README)
  after the registry's `dist.integrity` for the wrapper and its linux-x64 native package is
  compared with pinned sha512 values. 2.1.309 was npm's `stable` tag on 2026-11-01. Anthropic's
  install page could not be fetched from here to confirm which method it currently recommends
  (see "Not verified"). The package's postinstall copies the native binary into place, so no Node
  process stays resident. `DISABLE_AUTOUPDATER=1` keeps it at the pinned version. Bump it
  deliberately by changing `CLAUDE_CODE_VERSION` and the two integrity args (`npm view
  @anthropic-ai/claude-code@<v> dist.integrity`, and the same for `-linux-x64`).
- Debian packages (git, python3, python3-venv, ripgrep, curl, jq, procps, openssh-client) aren't
  version-pinned. Rebuild to pick up security fixes.
- User `agent`, uid/gid 1000, home `/home/agent`. Any existing uid-1000 user (the base image's
  `node`) is removed first.
- Size: about 1.46 GB in this sandbox's test build. About 290 MB of that is the Claude Code native
  binary and about 300 MB is the apt layer. Most of the rest is the Node/Ubuntu test base, and
  bookworm-slim is smaller.
- **Built and checked in this sandbox** on a test-only base (Ubuntu noble via debootstrap, plus
  this sandbox's Node 24), because Docker Hub isn't reachable from here. Every other line of the
  Dockerfile ran as written. The real `node:24-bookworm-slim` build happens on claunker in the
  smoke test.

## Rollout checklist

Do these in order on claunker. Each step says how to check it before moving on.

1. **Install Docker Desktop** (admin) with the WSL2 backend. Run the installer as admin and keep
   "Use WSL 2 instead of Hyper-V" checked. Sign out and back in if it adds you to
   `docker-users`. In Settings: General, "Start Docker Desktop when you sign in" on; Resources,
   File sharing, make sure `D:` is shared; **leave "Expose daemon on tcp://localhost:2375 without
   TLS" off**. Set the VM size in `%USERPROFILE%\.wslconfig` (for example `memory=24GB`,
   `processors=8`), then `wsl --shutdown` and restart Docker Desktop.
   Check: `docker version` shows a Server section; `docker run --rm hello-world` works.

2. **Create the bot account.** Sign out of `icey2488` (or use a private window) and sign up for a
   new free account, for example `claunker-bot`. It needs its own email address. A plus-address
   like `erick+claunker-bot@...` works if the mail provider supports it. This is the one free
   machine account GitHub's ToS allows next to Erick's personal account (ToS section B.3, linked
   above). Turn on 2FA. In the bot's Settings, Emails, turn on "Keep my email address private" and
   note the `<id>+claunker-bot@users.noreply.github.com` address.

3. **Invite it as a collaborator**, only on the repos jobs should push to. Start with one scratch
   repo (for example `icey2488/container-job-scratch`, created empty and private). Add others,
   such as `icey2488/claude-async`, only once the scratch run is clean. As `icey2488`: repo
   Settings, Collaborators, Add people, the bot's login. Accept the invite as the bot. Check
   branch protection on each repo's main is still no deletion and no force-push (unchanged).
   Don't invite the bot to repos where jobs shouldn't push. The classic token can reach every repo
   the bot can.

4. **Create the classic PAT**, as the bot: Settings, Developer settings, Personal access tokens,
   Tokens (classic), Generate new token (classic). Note: `claude-async container jobs`.
   Expiration: 90 days. Scopes: **`repo`** only (or `public_repo` if every target repo is
   public). Leave `workflow` unchecked unless jobs must edit `.github/workflows/`. Leave everything
   else unchecked. Copy the token once. Step 6 is where it goes.

5. **Generate the Claude Code token**, as Erick, on claunker: `claude setup-token`, approve in the
   browser on Erick's subscription account, then copy the printed token. It's valid for one year.
   Add a reminder about 11 months out to regenerate it.

6. **Write the host secrets file** outside every repo, readable only by Erick's user. In
   PowerShell (the values are read as secure strings and never echoed, never put in history, and
   never passed on a command line):

   ```powershell
   $dir  = Join-Path $env:USERPROFILE ".claude-async-secrets"
   $file = Join-Path $dir "container.env"
   New-Item -ItemType Directory -Force -Path $dir | Out-Null
   # User-only ACL on the folder: drop inheritance, grant only the current user and SYSTEM.
   $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   icacls $dir /inheritance:r /grant:r "${me}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

   function Read-Plain([string]$prompt) {
     $s = Read-Host -AsSecureString $prompt
     $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
     try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
   }
   $gh = Read-Plain "Bot classic PAT (GH_TOKEN)"
   $cc = Read-Plain "Claude Code token from 'claude setup-token' (CLAUDE_CODE_OAUTH_TOKEN)"
   # LF line endings and no BOM: docker keeps a trailing CR in the value and a BOM in the key name.
   $body = "GH_TOKEN=$($gh.Trim())`nCLAUDE_CODE_OAUTH_TOKEN=$($cc.Trim())`n"
   [IO.File]::WriteAllText($file, $body, (New-Object Text.UTF8Encoding($false)))
   Remove-Variable gh, cc, body
   icacls $file /inheritance:r /grant:r "${me}:F" "SYSTEM:F" | Out-Null
   icacls $file    # shows the ACL only; check that nothing but you and SYSTEM is listed
   ```

   Check: `(Get-Content $file | ForEach-Object { ($_ -split '=')[0] })` prints the two key names
   (and only the names).

7. **Build the image and run the smoke test**, from `D:\code\claude-async`:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1
   powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1 -SkipBuild `
     -EnvFile "$env:USERPROFILE\.claude-async-secrets\container.env" -RunClaude
   ```

   Every line must be PASS: tools, uid 1000 with no capabilities, host Ollama with
   `qwen2.5-coder:7b`, **ports 7842/2375/2376 not reachable**, no socket or host credential paths,
   read-only CLAUDE.md and hooks, gh authenticated as the bot (it prints the login, which must be
   the bot's and not `icey2488`), git over https, and the headless claude call. If 7842 is
   reachable, stop: see the threat model's "Host loopback services".
   Then pin the base image. `docker image inspect node:24-bookworm-slim --format "{{index .RepoDigests 0}}"`
   prints `node@sha256:...`. Put it in the Dockerfile as `ARG NODE_IMAGE=node:24-bookworm-slim@sha256:...`
   in a small commit.

8. **Configure the bridge** (container mode stays off by default). Add to the bridge's environment
   (ecosystem.config.cjs `env`, or the Claude Desktop MCP server entry's `env`), then restart the
   bridge with `tools\restart-bridge.ps1 -RequestedBy manual`:

   ```
   CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS=D:\code\jobs
   CLAUDE_ASYNC_CONTAINER_DENIED_ROOTS=D:\claunker
   CLAUDE_ASYNC_CONTAINER_ENV_FILE=C:\Users\Raide\.claude-async-secrets\container.env
   CLAUDE_ASYNC_CONTAINER_GIT_NAME=claunker-bot
   CLAUDE_ASYNC_CONTAINER_GIT_EMAIL=<id>+claunker-bot@users.noreply.github.com
   CLAUDE_ASYNC_DOCKER_BIN=C:\Program Files\Docker\Docker\resources\bin\docker.exe
   ```

   Do **not** set `CLAUDE_ASYNC_JOB_SANDBOX` yet. Clone the scratch repo with an https origin into
   the jobs root: `git clone https://github.com/icey2488/container-job-scratch D:\code\jobs\container-job-scratch`.

9. **Run one container job end to end**: `claude_start` with `host: "claunker"`,
   `sandbox: "container"`, `workFolder: "D:\code\jobs\container-job-scratch"`, and a prompt like
   "Create a branch docs/container-smoke, add a README line saying hello from the container,
   commit, push the branch, and open a PR to main. Delegate the README wording to qwen2.5-coder:7b
   through $OLLAMA_HOST. End with the delegation report." Check:
   - `claude_check` shows `sandbox: "container"`, status `completed`, `exit.container.newGitFindings: []`.
   - On GitHub, the branch and PR exist, and the commit's author **and** the PR's opener are the bot.
   - The delegation report shows an Ollama call, which proves the host-Ollama path works.
   - The dispatch card and the Discord ping both arrived.
   - `docker ps -a --filter label=claude-async.job` is empty afterwards.
   - Cancel: start a second long job and run `claude_cancel`. The job reports `failed` with exit
     code 137, and `docker ps` shows no container left.
   Review and merge the PR yourself.

10. **Widen slowly.** Invite the bot to one real repo, clone that repo under `D:\code\jobs`, and use
    `sandbox: "container"` for code jobs there. Only once that's routine, consider
    `CLAUDE_ASYNC_JOB_SANDBOX=container` as the default (admin jobs then pass `sandbox: "host"`).
    Schedule phase 2 egress.

### Rollback

Container mode is opt-in, so rollback is cheap and goes from least to most drastic:

- **Stop using it:** stop passing `sandbox: "container"`, and unset `CLAUDE_ASYNC_JOB_SANDBOX` if
  you set it. Host jobs never went through any container code, so nothing else changes.
- **Cut off the bot:** revoke the classic PAT (bot account, Developer settings), remove the bot as
  a collaborator on each repo, and revoke the Claude Code token (claude.ai settings, or regenerate
  it with `claude setup-token`; the old one stays valid until it expires or is revoked). Then
  delete `%USERPROFILE%\.claude-async-secrets\container.env`. Container jobs then fail in preflight
  ("env file ... does not exist").
- **Remove the code:** revert this PR's merge commit. Host-mode behavior is the same with or
  without it (the tests assert the host argv is unchanged).
- **Remove Docker:** `docker image rm claude-async-job:local`, then uninstall Docker Desktop if
  nothing else uses it.
- **Clean the job clones:** `D:\code\jobs\*` are disposable clones. Delete them or re-clone them.
  If any `claude_check` ever showed a `newGitFindings` warning for a clone, delete that clone
  rather than running git in it.

## Not verified

- **Anthropic's install, devcontainer and network-config pages** (`https://code.claude.com/docs/en/setup`,
  `.../devcontainer`, `.../network-config`) could not be fetched from the sandbox this was written
  in: the fetch permission timed out, and direct access was blocked by its egress proxy. So the
  current recommended install method, the official list of hosts Claude Code needs, and its proxy
  support come from the npm package's README and from strings in the 2.1.309 binary, not from
  those pages. The authentication page *was* fetched and is quoted above.
- **The real `node:24-bookworm-slim` build, Docker Desktop on Windows, host Ollama, the
  host-loopback ports, and a real headless `claude -p` on the subscription token** were not run
  here. The smoke test covers each one on claunker.
- **GitHub's collaborator permission-level page** could not be fetched, so the statement that
  personal-account repos have a single collaborator role is from prior knowledge.
- **Whether `host.docker.internal` reaches services bound only to the Windows host's
  `127.0.0.1`** (Ollama, the 7842 bridge). The smoke test probes both.
- **Docker's daemon-security page** (<https://docs.docker.com/engine/security/>) could not be
  fetched. "Access to the Docker daemon is equivalent to root on the host" is standard Docker
  guidance stated from prior knowledge.
