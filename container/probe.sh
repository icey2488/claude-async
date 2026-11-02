#!/bin/bash
# Network probe used by container/smoke-test.ps1 (docs/container-jobs.md, rollout step 7). Runs
# INSIDE a throwaway job container. Reads targets from stdin, one per line:
#
#   <label> <host> <port>
#
# and prints exactly one result line per target, in input order, then a trailer:
#
#   RESULT <label> <host> <port> <OPEN|CLOSED|DNSFAIL>
#   PROBE_DONE <number of targets>
#
# OPEN: a TCP connection completed within 3 s. CLOSED: refused, unreachable or timed out.
# DNSFAIL: the name did not resolve, so nothing was measured (the smoke test treats that as a
# failure, never as "closed"). Anything else (a bad input line) exits 2 without a trailer, so the
# caller can tell an incomplete run from a clean one.
set -u
n=0
while read -r label host port rest; do
  [ -z "${label:-}" ] && continue
  case "$label" in \#*) continue ;; esac
  if [ -n "${rest:-}" ] || ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || ! [[ "$host" =~ ^[A-Za-z0-9.:-]+$ ]] || ! [[ "$label" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    echo "BADINPUT $label $host $port" >&2
    exit 2
  fi
  n=$((n + 1))
  if ! getent hosts "$host" > /dev/null 2>&1; then
    echo "RESULT $label $host $port DNSFAIL"
    continue
  fi
  if timeout 3 bash -c "exec 3<>/dev/tcp/$host/$port" 2> /dev/null; then
    echo "RESULT $label $host $port OPEN"
  else
    echo "RESULT $label $host $port CLOSED"
  fi
done
echo "PROBE_DONE $n"
