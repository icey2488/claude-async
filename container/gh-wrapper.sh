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
# Reads the token file (review round 3): it must hold exactly one line, an installation token
# (ghs_ + at least 36 letters/digits). The runner publishes each generation with an atomic rename, so
# a reader normally sees one complete file; anything else (a torn in-place rewrite from the runner's
# fallback path, a foreign value) is retried every 100 ms, 20 times, and then refused. Only the first
# line is ever used (IFS= read -r), and a second non-empty line makes the content invalid. Sets
# $token, or leaves it empty and returns 1. A missing file returns 2 at once (nothing to wait for).
read_token() {
  local i t1 t2
  token=""
  [ -e "$file" ] || return 2
  for i in $(seq 1 20); do
    t1=""; t2=""
    { IFS= read -r t1 || true; IFS= read -r t2 || true; } < "$file" 2>/dev/null
    t1="${t1%$'\r'}"
    if [ -z "$t2" ] && [[ "$t1" =~ ^ghs_[A-Za-z0-9]{36,}$ ]]; then token="$t1"; return 0; fi
    sleep 0.1
  done
  echo "${0##*/}: ${file} is not a single valid installation token after 20 attempts; refusing to use it" >&2
  return 1
}
if [ -z "${GH_TOKEN:-}" ]; then
  # A missing file: gh runs unauthenticated, as before. A file that never holds a valid token: fail
  # here rather than hand gh a torn or foreign value.
  rc=0; read_token || rc=$?
  if [ "$rc" -eq 0 ]; then export GH_TOKEN="$token"; elif [ "$rc" -eq 1 ]; then exit 1; fi
fi
exec "$real" "$@"
