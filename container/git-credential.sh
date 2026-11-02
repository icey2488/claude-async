#!/bin/bash
# claude-async container job git credential helper (design: docs/container-jobs.md, "The clone
# inside the container"). Baked into the image at /usr/local/bin/claude-async-git-credential and
# set as the system-level helper for https://github.com (/etc/gitconfig, root-owned).
#
# git calls it with "get" and the request on stdin (protocol=, host=, path=...). For host github.com
# over https it answers with the GitHub App installation token the host runner keeps at
# /run/claude-async/creds/token (a read-only bind mount; the runner rewrites the file in place
# every 45 minutes, so every git call reads the CURRENT token, never a cached one):
#
#   username=x-access-token
#   password=<token>
#
# For any other host or protocol it prints nothing, so git falls through to no credential. "store"
# and "erase" are ignored: there is nothing to store (the file is the source) and nothing to erase.
# Never logs. Exit 0 always, so a missing file reads as "no credential" (git then fails the
# operation with its own authentication error rather than hanging on a prompt: GIT_TERMINAL_PROMPT=0).
# CLAUDE_ASYNC_CREDS_FILE overrides the path for the host-side test (test/job-entry.test.mjs); the
# image never sets it.
set -u
file="${CLAUDE_ASYNC_CREDS_FILE:-/run/claude-async/creds/token}"
[ "${1:-}" = "get" ] || exit 0
host=""; protocol=""
while IFS= read -r line; do
  case "$line" in
    host=*) host="${line#host=}" ;;
    protocol=*) protocol="${line#protocol=}" ;;
    "") break ;;
  esac
done
[ "$host" = "github.com" ] && [ "$protocol" = "https" ] || exit 0
[ -r "$file" ] || exit 0
token="$(cat "$file")"
[ -n "$token" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$token"
