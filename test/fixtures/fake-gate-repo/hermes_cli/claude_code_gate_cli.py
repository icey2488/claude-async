"""Deterministic fake standing in for the real
hermes_cli/claude_code_gate_cli.py (claunker-hermes repo, feat/claude-code-
gate-entrypoint branch) so job-tool-gate-hook.mjs's OWN fail-closed
wrapping logic (timeout, bad exit code, malformed output, missing module)
can be unit tested without needing that repo checked out next to this one.
Not a stand-in for the real classifier's correctness -- that's covered by
claunker-hermes's own test_claude_code_gate.py.

Behavior keyed on tool_name, read from stdin JSON:
  "AllowMe"   -> allow
  "DenyMe"    -> deny, reason "fake deny"
  "CrashMe"   -> exit 1 with no stdout (simulates an uncaught crash)
  "BadOutput" -> exit 0 with invalid JSON on stdout
  "HangMe"    -> sleep 30s (simulates a hung subprocess; pair with a short
                 CLAUDE_ASYNC_GATE_TIMEOUT_MS in the test)
  anything else -> allow
"""
import json
import sys
import time


def main():
    payload = json.loads(sys.stdin.read())
    tool_name = payload.get("tool_name")

    if tool_name == "CrashMe":
        sys.exit(1)
    if tool_name == "BadOutput":
        sys.stdout.write("not json")
        sys.exit(0)
    if tool_name == "HangMe":
        time.sleep(30)
        sys.exit(0)

    if tool_name == "DenyMe":
        out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": "fake deny"}}
        sys.stdout.write(json.dumps(out))
        sys.exit(2)

    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
    sys.stdout.write(json.dumps(out))
    sys.exit(0)


if __name__ == "__main__":
    main()
