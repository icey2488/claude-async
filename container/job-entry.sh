#!/bin/bash
# claude-async container job entrypoint (design: docs/container-jobs.md). Baked into the image at
# /usr/local/bin/claude-async-job-entry; job-core.mjs (container.mjs buildDockerRunArgv) runs:
#
#   claude-async-job-entry <owner/repo> <base-ref or ""> -- claude <cli args...>
#
# It clones https://github.com/<owner/repo> into /workspace (container-local storage; nothing is
# mounted there), checks out <base-ref> when one is given, then execs the CLI in that clone.
# <base-ref> is resolved LOCALLY in the fresh clone, never fetched: refs/remotes/origin/<ref> (a
# branch), refs/tags/<ref>, or a 7-40 hex abbreviation of a commit the clone already has. So a ref
# can only ever name something on a branch or tag of the repo itself: `git fetch origin <sha>` or
# refs/pull/N/head would pull objects from GitHub's shared fork network that are on no branch of the
# allowed repo (and an abbreviated SHA is not fetchable at all).
# CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE overrides /workspace for the host-side test
# (test/job-entry.test.mjs); the image never sets it.
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
workspace="${CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE:-/workspace}"
cd "$workspace" || die 78 "${workspace} does not exist"
[ -z "$(ls -A "$workspace")" ] || die 78 "${workspace} is not empty; refusing to clone over it"

echo "[job-entry] cloning https://github.com/${repo} into ${workspace}" >&2
git clone --quiet -- "https://github.com/${repo}.git" "$workspace" || die 70 "git clone of ${repo} failed"
if [ -n "$base" ]; then
  target=""
  if git show-ref --verify --quiet "refs/remotes/origin/${base}"; then
    target="refs/remotes/origin/${base}"
  elif git show-ref --verify --quiet "refs/tags/${base}"; then
    target="refs/tags/${base}"
  elif [[ "$base" =~ ^[0-9a-fA-F]{7,40}$ ]] && git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    target="${base}^{commit}"
  else
    die 70 "baseRef ${base} not found in ${repo} (not a branch, a tag, or a commit the clone has)"
  fi
  git checkout --quiet --detach "$target" || die 70 "checkout of ${base} failed"
  echo "[job-entry] at ${base} ($(git rev-parse --short HEAD)), detached; create a branch before committing" >&2
fi

exec "$@"
