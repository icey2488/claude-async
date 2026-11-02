#!/bin/bash
# claude-async container job entrypoint (design: docs/container-jobs.md). Baked into the image at
# /usr/local/bin/claude-async-job-entry; job-core.mjs (container.mjs buildDockerRunArgv) runs:
#
#   claude-async-job-entry <owner/repo> <base-ref or ""> -- claude <cli args...>
#
# It clones https://github.com/<owner/repo> into /workspace (container-local storage; nothing is
# mounted there), checks out <base-ref> when one is given, then execs the CLI in that clone.
#
# Credentials: git asks the system-level credential helper the image configures
# (`!gh auth git-credential` for https://github.com), and gh answers from the GH_TOKEN environment
# variable that --env-file supplied. The token is never on a command line, in a URL, or in a file.
#
# Exit codes of its own: 64 usage/validation, 70 clone or checkout failed, 78 configuration
# (no GH_TOKEN, /workspace not empty). Anything else is the CLI's.
set -euo pipefail

die() { local code="$1"; shift; echo "[job-entry] $*" >&2; exit "$code"; }

[ "$#" -ge 3 ] || die 64 "usage: claude-async-job-entry <owner/repo> <base-ref> -- <command...>"
repo="$1"; base="$2"; shift 2
[ "$1" = "--" ] || die 64 "usage: expected -- before the command"
shift
[ "$#" -ge 1 ] || die 64 "usage: no command after --"

# The same rules as container.mjs's REPO_RE / validateBaseRef (re-checked here so the image never
# trusts its caller).
[[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]] || die 64 "invalid repo name"
case "$repo" in */.|*/..) die 64 "invalid repo name" ;; esac
if [ -n "$base" ]; then
  [[ "$base" =~ ^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$ ]] || die 64 "invalid base ref"
  case "$base" in *..*|*@\{*|*/|*.lock|*//*) die 64 "invalid base ref" ;; esac
fi

[ -n "${GH_TOKEN:-}" ] || die 78 "GH_TOKEN is not set (the host env file must supply it)"
cd /workspace
[ -z "$(ls -A /workspace)" ] || die 78 "/workspace is not empty; refusing to clone over it"

echo "[job-entry] cloning https://github.com/${repo} into /workspace" >&2
git clone --quiet -- "https://github.com/${repo}.git" /workspace || die 70 "git clone of ${repo} failed"
if [ -n "$base" ]; then
  git fetch --quiet origin "$base" || die 70 "git fetch of ${base} failed"
  git checkout --quiet --detach FETCH_HEAD || die 70 "checkout of ${base} failed"
  echo "[job-entry] at ${base} ($(git rev-parse --short HEAD)), detached; create a branch before committing" >&2
fi

exec "$@"
