# claude-async container job image (design: docs/container-jobs.md).
#
# Build on claunker from the repo root:
#   docker build -t claude-async-job:local -f container/Dockerfile container
#
# Contents: Node 24 (the bridge's own major, see README "Linux receiver"), git, gh, python3 + uv,
# ripgrep, curl, the Claude Code CLI, and the job entrypoint (job-entry.sh), which clones the job's
# repo into /workspace inside the container. No host folder is mounted read-write. NO secrets: the
# bot's GitHub token and the Claude Code OAuth token arrive at `docker run` time through --env-file, never at build time, and nothing in
# this file reads them. The image never contains any host path, config or credential.
#
# Pinning: every downloaded tool is pinned to an exact version AND a checksum. gh, uv: SHA-256 from
# the release's checksum file. Claude Code: the sha512 of the downloaded wrapper and linux-x64
# tarballs themselves is checked against the pinned integrity values below, and the binary is placed
# from those verified bytes (no npm install, no package script; see that step). The base
# image is pinned to a Node major tag rather than a digest because a digest can't be verified from
# where this file was written; docs/container-jobs.md's rollout step "Pin the base image" records
# the digest after the first build. Debian packages come from the base image's apt sources at
# build time (unpinned; rebuild to pick up security fixes).
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG GH_VERSION=2.89.0
ARG GH_SHA256=d0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8
ARG UV_VERSION=0.13.6
ARG UV_SHA256=f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645
# Claude Code: the npm "stable" dist-tag on 2026-11-01. Bump deliberately; jobs never auto-update.
ARG CLAUDE_CODE_VERSION=2.1.309
ARG CLAUDE_CODE_INTEGRITY=sha512-+lBYZRuXOJpiKJcRv/CK7gF+5UFNWyJE7hSxkgGUKDZOWgANl9MAabfTkrJk183Tp3B0Nv4xF/DU1t0BaKXOPw==
ARG CLAUDE_CODE_LINUX_X64_INTEGRITY=sha512-36D6kMC0fWdWLwBA8XYaJTSTXEWvw0Kc3WQYqterieKDtplIfUsE5jurZAYilhzOeF+uNL9SNn4DkwhQmUrRMg==

# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssl python3 python3-venv ripgrep jq less procps openssh-client \
 && rm -rf /var/lib/apt/lists/*

# gh: release tarball, checksum-verified (no third-party apt repo to trust).
RUN set -eu; \
    curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"

# uv (and uvx): release tarball, checksum-verified.
RUN set -eu; \
    curl -fsSL -o /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz"; \
    echo "${UV_SHA256}  /tmp/uv.tgz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tgz -C /tmp; \
    install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/; \
    rm -rf /tmp/uv.tgz /tmp/uv-x86_64-unknown-linux-gnu

# Claude Code CLI, from VERIFIED BYTES ONLY, with no npm install and no package script:
#   1. `npm pack` downloads the exact wrapper and linux-x64 tarballs (the registry is untrusted:
#      whatever metadata it serves, only the bytes are judged).
#   2. Each tarball's sha512 is computed here (openssl, base64) and compared with the pinned
#      integrity values above. A mismatch fails the build before anything is extracted.
#   3. The wrapper's package.json must name the same version and pin the same linux-x64 version.
#   4. The native binary is placed explicitly. This is exactly what the wrapper's postinstall
#      (install.cjs) would do -- copy the platform binary over bin/claude.exe -- so neither the
#      postinstall nor npm's optional-dependency fetch from the registry ever runs.
# NPM_CONFIG_REGISTRY can point at a mirror; the pinned hashes still decide.
# Root-owned in /usr/local: the non-root job user can run it but can neither update nor replace it.
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
RUN set -eu; \
    mkdir /tmp/cc && cd /tmp/cc; \
    npm pack --silent --ignore-scripts \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@anthropic-ai/claude-code-linux-x64@${CLAUDE_CODE_VERSION}" > /dev/null; \
    verify() { got="sha512-$(openssl dgst -sha512 -binary "$1" | base64 -w0)"; \
      if [ "$got" != "$2" ]; then echo "INTEGRITY MISMATCH for $1: got $got, pinned $2" >&2; exit 1; fi; \
      echo "verified $1"; }; \
    verify "anthropic-ai-claude-code-${CLAUDE_CODE_VERSION}.tgz" "${CLAUDE_CODE_INTEGRITY}"; \
    verify "anthropic-ai-claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz" "${CLAUDE_CODE_LINUX_X64_INTEGRITY}"; \
    mkdir wrapper native; \
    tar -xzf "anthropic-ai-claude-code-${CLAUDE_CODE_VERSION}.tgz" -C wrapper; \
    tar -xzf "anthropic-ai-claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz" -C native; \
    V="${CLAUDE_CODE_VERSION}" node -e ' \
      const w = require("/tmp/cc/wrapper/package/package.json"), n = require("/tmp/cc/native/package/package.json"); \
      const v = process.env.V; \
      if (w.name !== "@anthropic-ai/claude-code" || w.version !== v) throw new Error("wrapper is not claude-code@" + v); \
      if (n.name !== "@anthropic-ai/claude-code-linux-x64" || n.version !== v) throw new Error("native package is not linux-x64@" + v); \
      if ((w.optionalDependencies || {})["@anthropic-ai/claude-code-linux-x64"] !== v) throw new Error("wrapper pins a different linux-x64"); \
    '; \
    install -d -m 0755 /usr/local/lib/claude-code; \
    install -m 0755 native/package/claude /usr/local/lib/claude-code/claude; \
    ln -sf /usr/local/lib/claude-code/claude /usr/local/bin/claude; \
    cd / && rm -rf /tmp/cc /root/.npm; \
    test "$(claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)"

# Non-root job user, uid/gid 1000 (job-core.mjs passes --user 1000:1000). Whatever user/group the
# base image already has at 1000 ("node" in the official node images) is removed first, so the name
# in `id`/git output is unambiguous.
RUN set -eu; \
    old_user="$(getent passwd 1000 | cut -d: -f1 || true)"; [ -z "$old_user" ] || userdel -r "$old_user" 2>/dev/null || userdel "$old_user"; \
    old_group="$(getent group 1000 | cut -d: -f1 || true)"; [ -z "$old_group" ] || groupdel "$old_group"; \
    groupadd --gid 1000 agent \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/agent --shell /bin/bash agent \
 && mkdir -p /workspace /opt/claude-async/hooks /home/agent/.claude \
 && printf '{\n  "hasCompletedOnboarding": true\n}\n' > /home/agent/.claude.json \
 && chown -R agent:agent /home/agent /workspace

# ~/.claude is ROOT-owned (0755), so a job can't create ~/.claude/settings.json (user settings, the
# one settings source --setting-sources user still loads), settings.local.json, agents/, commands/
# or skills/, and can't replace the read-only CLAUDE.md mount point. Only the directories the CLI
# writes during a headless run are agent-owned. The list was taken by running claude -p (with a
# Bash tool call) in this image against a local fake API and listing what it created under HOME:
# backups, projects, session-env, sessions, shell-snapshots. The rest are created up front because
# other code paths write them (todos/plans/file-history/debug/statsig/paste-cache/ide); an
# unlisted directory the CLI can't create shows up as a CLI error, not as a security hole.
#
# /home/agent itself is ROOT-owned too (review round 2): rename(2) needs write permission on the
# PARENT, not on the directory being renamed, so an agent-owned $HOME would let a job
# `mv ~/.claude ~/.old && mkdir ~/.claude` and write its own settings.json. (On the overlayfs
# builds tested here that rename happens to fail with EXDEV because ~/.claude is a lower-layer
# directory; that is a storage-driver detail, not a permission.) So only the top-level entries the
# job's tools need are agent-owned: .claude.json (the CLI's state file), .cache / .config / .local
# (gh, uv, pip, misc XDG; git's global config lives at .config/git/config, which git uses for
# writes when ~/.gitconfig does not exist, since `git config --global` needs to create a lock file
# next to it), .npm, .bash_history. Anything else a job tries to create directly under $HOME fails
# with EACCES, visibly (an `npm config set` that wants ~/.npmrc, for one).
RUN set -eu; \
    chown root:root /home/agent/.claude && chmod 0755 /home/agent/.claude; \
    for d in backups projects session-env sessions shell-snapshots todos plans file-history debug statsig paste-cache ide; do \
      install -d -o agent -g agent -m 0700 "/home/agent/.claude/$d"; \
    done; \
    for d in .cache .config .config/git .local .npm; do install -d -o agent -g agent -m 0700 "/home/agent/$d"; done; \
    for f in .config/git/config .bash_history; do install -o agent -g agent -m 0600 /dev/null "/home/agent/$f"; done; \
    chown agent:agent /home/agent/.claude.json; \
    chown root:root /home/agent && chmod 0755 /home/agent

# Defaults for every job. None of these is a secret.
#   DISABLE_AUTOUPDATER: the CLI version is the image's; a job must not change it.
#   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: no telemetry/error reporting/update checks, which also
#     shrinks the phase-2 egress allowlist to the inference endpoint.
#   GH_PROMPT_DISABLED / GIT_TERMINAL_PROMPT: never block waiting for input.
ENV HOME=/home/agent \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    GH_PROMPT_DISABLED=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    GIT_TERMINAL_PROMPT=0 \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1
# git over https to github.com asks gh, which answers from GH_TOKEN in the environment: the token is
# never written to a file or put in a remote URL. System config (root-owned, /etc/gitconfig), so it
# is in place before the job's first command and a job's own ~/.gitconfig can only add to it.
RUN git config --system init.defaultBranch main \
 && git config --system credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'

# The entrypoint that clones the job's repo (see job-entry.sh). CRs are stripped in case the file
# came from a Windows checkout without the .gitattributes rule.
COPY job-entry.sh /usr/local/bin/claude-async-job-entry
RUN sed -i 's/\r$//' /usr/local/bin/claude-async-job-entry && chmod 0755 /usr/local/bin/claude-async-job-entry

USER agent
WORKDIR /workspace
# No ENTRYPOINT: job-core.mjs names the command (claude-async-job-entry <repo> <ref> -- claude ...)
# explicitly, and the smoke test runs plain `git --version` etc. `docker run --init` supplies PID 1.
CMD ["claude", "--version"]
