# claude-async container job image (design: docs/container-jobs.md).
#
# Build on claunker from the repo root:
#   docker build -t claude-async-job:local -f container/Dockerfile container
#
# Contents: Node 24 (the bridge's own major, see README "Linux receiver"), git, gh, python3 + uv,
# ripgrep, curl, and the Claude Code CLI. NO secrets: the bot's GitHub token and the Claude Code
# OAuth token arrive at `docker run` time through --env-file, never at build time, and nothing in
# this file reads them. The image never contains any host path, config or credential.
#
# Pinning: every downloaded tool is pinned to an exact version AND a checksum. gh, uv: SHA-256 from
# the release's checksum file. Claude Code: the npm registry's sha512 `dist.integrity` for the
# wrapper package and its linux-x64 native package is compared with the values pinned below before
# installing (npm itself then verifies the downloaded tarballs against that same metadata). The base
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
      ca-certificates curl git python3 python3-venv ripgrep jq less procps openssh-client \
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

# Claude Code CLI via its npm package (the install method its own README documents). The package's
# postinstall copies the platform's native binary over bin/claude, so no Node process stays
# resident. Installed root-owned into the global prefix: the non-root job user can run it but can
# neither update nor replace it.
RUN set -eu; \
    test "$(npm view "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" dist.integrity)" = "${CLAUDE_CODE_INTEGRITY}"; \
    test "$(npm view "@anthropic-ai/claude-code-linux-x64@${CLAUDE_CODE_VERSION}" dist.integrity)" = "${CLAUDE_CODE_LINUX_X64_INTEGRITY}"; \
    npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

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

# Defaults for every job. None of these is a secret.
#   DISABLE_AUTOUPDATER: the CLI version is the image's; a job must not change it.
#   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: no telemetry/error reporting/update checks, which also
#     shrinks the phase-2 egress allowlist to the inference endpoint.
#   GH_PROMPT_DISABLED / GIT_TERMINAL_PROMPT: never block waiting for input.
#   /workspace is bind-mounted from the host and owned by the host user, so git's ownership check
#     would refuse it; safe.directory is set system-wide for exactly that one path.
ENV HOME=/home/agent \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    GH_PROMPT_DISABLED=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    GIT_TERMINAL_PROMPT=0 \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1
RUN git config --system safe.directory /workspace \
 && git config --system init.defaultBranch main

USER agent
WORKDIR /workspace
# No ENTRYPOINT: job-core.mjs names the command (`claude ...`) explicitly, and the smoke test runs
# plain `git --version` etc. `docker run --init` supplies PID 1.
CMD ["claude", "--version"]
