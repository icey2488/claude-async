/**
 * lantern-session.mjs — best-effort discovery of the Claude Code CLI's own session id for a
 * claude-async job, by watching the transcript directory the CLI itself writes to.
 *
 * There is no documented API for this. job-core.mjs invokes the CLI in plain `-p` text mode (no
 * --output-format json/stream-json), so nothing on the child's stdout carries its session id,
 * and adding that flag would change what job-runner.mjs's own exitReason/completeness-marker
 * parsing sees on stdout -- too invasive for what this needs. What the CLI DOES do,
 * unconditionally, is write every session's transcript to
 *   ~/.claude/projects/<escaped-cwd>/<session-id>.jsonl
 * confirmed by inspecting this machine's own ~/.claude/projects directory: a session run with
 * cwd D:\code\_worktrees\claude-async-lantern produced the file
 *   D--code--worktrees-claude-async-lantern\a23d2871-7da2-45fa-9749-c04eccefb5f5.jsonl
 * whose first line is {"sessionId":"a23d2871-...",...} -- filename stem and sessionId agree.
 * Checked against three more real examples on the same machine (D:\code\claude-async,
 * C:\Users\Raide\code\gemini-mcp, C:\WINDOWS\system32), the escaping rule that fits all four
 * (including the drive-letter colon, every path separator, AND the literal underscore in
 * "_worktrees" each becoming their own "-", with no collapsing of adjacent separators) is:
 * replace every character that is not [A-Za-z0-9-] with "-". This is NOT documented upstream
 * and could change with a future CLI release, so findNewSessionId() below is written to fail
 * closed (return null) rather than guess when the shape doesn't match -- per the job's
 * instruction, never guess a session id.
 *
 * Ambiguity: if two claude-async jobs happen to share the same cwd and both start around the
 * same time, more than one new transcript file can appear in the watch window with no reliable
 * way from here to tell which one is "ours". findNewSessionId() refuses (returns null) rather
 * than picking one -- the row stays without a session, exactly the documented fallback.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pollUntil } from "./lantern-notify.mjs";

export function claudeProjectsDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".claude", "projects");
}

export function projectDirNameForCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9-]/g, "-");
}

// Reads just enough of `file` to parse its first line's sessionId. null on any failure (missing
// file, truncated/invalid JSON, no sessionId key) -- never throws.
export function readSessionIdFromTranscript(file, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fsImpl.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    const firstLine = nl === -1 ? text : text.slice(0, nl);
    const obj = JSON.parse(firstLine);
    return typeof obj.sessionId === "string" && obj.sessionId ? obj.sessionId : null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch {} } }
}

// `before`/`now`: directory entries (filenames only) from before the job's CLI was spawned and
// at the current poll tick. Returns the session id of the one new transcript file, or null when
// there is no new file yet, or more than one (see the header's "Ambiguity" note).
export function findNewSessionId({ dir, before, now, fsImpl = fs }) {
  const seen = new Set(before);
  const fresh = now.filter((f) => f.endsWith(".jsonl") && !seen.has(f));
  if (fresh.length !== 1) return null;
  const file = fresh[0];
  const id = readSessionIdFromTranscript(path.join(dir, file), fsImpl);
  // Sanity cross-check: the CLI names the file after its own session id. A mismatch means this
  // isn't the shape this module assumes, so refuse rather than report something unverified.
  return id && file === `${id}.jsonl` ? id : null;
}

// Snapshots the transcript directory for `cwd` and polls for exactly one new *.jsonl file,
// calling onFound(sessionId) at most once. MUST be called before the job's CLI is spawned (the
// snapshot has to predate the file the CLI will create); job-runner.mjs does this. Returns a
// stop() function; also stops on its own once onFound fires or timeoutMs elapses.
export function watchForSessionId({ cwd, onFound, intervalMs = 400, timeoutMs = 20_000, fsImpl = fs, homeDir }) {
  const dir = path.join(claudeProjectsDir(homeDir), projectDirNameForCwd(cwd));
  let before;
  try { before = fsImpl.readdirSync(dir); } catch { before = []; }
  return pollUntil(
    () => {
      let now;
      try { now = fsImpl.readdirSync(dir); } catch { return null; } // dir may not exist yet
      return findNewSessionId({ dir, before, now, fsImpl });
    },
    { intervalMs, timeoutMs, onFound },
  );
}
