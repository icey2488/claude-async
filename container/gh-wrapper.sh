#!/bin/bash
# claude-async container job `gh` wrapper (design: docs/container-jobs.md, "How jobs open PRs").
# Baked into the image at /usr/local/bin/gh; the real gh binary is at /usr/local/lib/gh/gh.
#
# gh reads its token from GH_TOKEN. The GitHub App installation token lives in a file
# (/run/claude-async/creds/token, read-only bind mount, rewritten in place by the host runner), and
# it is NOT exported into the job's environment: a job shell's `env` shows no GH_TOKEN, and child
# processes (test suites, npm scripts, anything the job runs) do not inherit it. This wrapper reads
# the file at each call and exports GH_TOKEN for the exec'd gh process only, so `gh pr create`
# works as the App without the token being sprayed into every process. The job runs as the same
# uid and can read the file itself; this is about not leaking by default, not about hiding it.
# The token is exported, never put on gh's command line, so it is not in /proc/<pid>/cmdline.
# A GH_TOKEN the job set itself is respected (not overridden). GH_ENTERPRISE_TOKEN is untouched.
# CLAUDE_ASYNC_CREDS_FILE / CLAUDE_ASYNC_GH_BIN override the paths for the host-side test only.
set -u
file="${CLAUDE_ASYNC_CREDS_FILE:-/run/claude-async/creds/token}"
real="${CLAUDE_ASYNC_GH_BIN:-/usr/local/lib/gh/gh}"
if [ -z "${GH_TOKEN:-}" ] && [ -r "$file" ]; then
  token="$(cat "$file")"
  if [ -n "$token" ]; then
    export GH_TOKEN="$token"
  fi
fi
exec "$real" "$@"
