// lantern-session.mjs: best-effort discovery of the Claude Code CLI's own session id, by
// watching ~/.claude/projects/<escaped-cwd>/ for the one new transcript file a job's CLI writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeProjectsDir, projectDirNameForCwd, readSessionIdFromTranscript, findNewSessionId, watchForSessionId,
} from "../lantern-session.mjs";

// ---------------------------------------------------------------------------
// projectDirNameForCwd: regression-pinned against real examples observed on a live machine's
// ~/.claude/projects (see lantern-session.mjs's header for the full citation).
// ---------------------------------------------------------------------------

test("projectDirNameForCwd: matches real ~/.claude/projects directory names", () => {
  assert.equal(projectDirNameForCwd("D:\\code\\claude-async"), "D--code-claude-async");
  assert.equal(projectDirNameForCwd("D:\\code\\_worktrees\\claude-async-lantern"), "D--code--worktrees-claude-async-lantern");
  assert.equal(projectDirNameForCwd("C:\\Users\\Raide\\code\\gemini-mcp"), "C--Users-Raide-code-gemini-mcp");
  assert.equal(projectDirNameForCwd("C:\\WINDOWS\\system32"), "C--WINDOWS-system32");
});

test("claudeProjectsDir: joins the given home dir with .claude/projects", () => {
  assert.equal(claudeProjectsDir("/home/erick"), path.join("/home/erick", ".claude", "projects"));
});

// ---------------------------------------------------------------------------
// readSessionIdFromTranscript
// ---------------------------------------------------------------------------

function withTmpDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-session-"));
    try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test("readSessionIdFromTranscript: reads sessionId off the first line", withTmpDir((dir) => {
  const f = path.join(dir, "abc.jsonl");
  fs.writeFileSync(f, '{"type":"queue-operation","sessionId":"abc-123","other":"stuff"}\n{"second":"line"}\n');
  assert.equal(readSessionIdFromTranscript(f), "abc-123");
}));

test("readSessionIdFromTranscript: null for a missing file, bad JSON, or no sessionId key", withTmpDir((dir) => {
  assert.equal(readSessionIdFromTranscript(path.join(dir, "missing.jsonl")), null);
  const bad = path.join(dir, "bad.jsonl");
  fs.writeFileSync(bad, "{ not json\n");
  assert.equal(readSessionIdFromTranscript(bad), null);
  const noId = path.join(dir, "noid.jsonl");
  fs.writeFileSync(noId, '{"type":"queue-operation"}\n');
  assert.equal(readSessionIdFromTranscript(noId), null);
}));

// ---------------------------------------------------------------------------
// findNewSessionId
// ---------------------------------------------------------------------------

test("findNewSessionId: exactly one new, well-formed transcript is reported", withTmpDir((dir) => {
  fs.writeFileSync(path.join(dir, "existing.jsonl"), '{"sessionId":"existing"}\n');
  fs.writeFileSync(path.join(dir, "fresh.jsonl"), '{"sessionId":"fresh"}\n');
  const before = ["existing.jsonl"];
  const now = ["existing.jsonl", "fresh.jsonl"];
  assert.equal(findNewSessionId({ dir, before, now }), "fresh", "the new, matching file's sessionId is returned");
}));

test("findNewSessionId: filename stem must equal the sessionId inside it", withTmpDir((dir) => {
  const id = "a23d2871-7da2-45fa-9749-c04eccefb5f5";
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ sessionId: id }) + "\n");
  assert.equal(findNewSessionId({ dir, before: [], now: [`${id}.jsonl`] }), id);
}));

test("findNewSessionId: a filename that does not match its own sessionId is refused, not guessed", withTmpDir((dir) => {
  fs.writeFileSync(path.join(dir, "mismatched.jsonl"), '{"sessionId":"something-else"}\n');
  assert.equal(findNewSessionId({ dir, before: [], now: ["mismatched.jsonl"] }), null);
}));

test("findNewSessionId: no new file yet is null, not a guess", withTmpDir((dir) => {
  assert.equal(findNewSessionId({ dir, before: ["a.jsonl"], now: ["a.jsonl"] }), null);
}));

test("findNewSessionId: two new files (a racing concurrent job) is ambiguous and refused", withTmpDir((dir) => {
  fs.writeFileSync(path.join(dir, "s1.jsonl"), '{"sessionId":"s1"}\n');
  fs.writeFileSync(path.join(dir, "s2.jsonl"), '{"sessionId":"s2"}\n');
  assert.equal(findNewSessionId({ dir, before: [], now: ["s1.jsonl", "s2.jsonl"] }), null);
}));

test("findNewSessionId: non-.jsonl files in the directory are ignored", withTmpDir((dir) => {
  const id = "real-id";
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ sessionId: id }) + "\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "irrelevant");
  assert.equal(findNewSessionId({ dir, before: [], now: [`${id}.jsonl`, "notes.txt"] }), id);
}));

// ---------------------------------------------------------------------------
// watchForSessionId: real (short) timers, real temp directory.
// ---------------------------------------------------------------------------

test("watchForSessionId: finds the one new transcript written after the snapshot", withTmpDir(async (dir) => {
  // Directory is empty at snapshot time (simulates the CLI not having started yet). The fsImpl
  // ignores the path it's asked for and always resolves to `dir` -- projectDirNameForCwd's own
  // mapping is covered separately above; this test only cares that watchForSessionId polls
  // readdirSync and reacts to a new file appearing.
  const found = [];
  // readdirSync is redirected wholesale to the real temp dir; openSync is redirected by basename
  // (watchForSessionId/findNewSessionId build their own, fictional directory path internally --
  // only the filename it picks matters here), readSync/closeSync operate on real fds either way.
  const fsImpl = {
    readdirSync: () => fs.readdirSync(dir),
    openSync: (p, flags) => fs.openSync(path.join(dir, path.basename(p)), flags),
    readSync: (...a) => fs.readSync(...a),
    closeSync: (...a) => fs.closeSync(...a),
  };
  const stop = watchForSessionId({ cwd: "ignored", onFound: (id) => found.push(id), intervalMs: 15, timeoutMs: 2000, fsImpl });
  await new Promise((r) => setTimeout(r, 40));
  const id = "watch-found-id";
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ sessionId: id }) + "\n");
  await new Promise((r) => setTimeout(r, 200));
  stop();
  assert.deepEqual(found, [id]);
}));

test("watchForSessionId: a directory that doesn't exist yet is tolerated, not an error", () => {
  const stop = watchForSessionId({
    cwd: "/does/not/exist", onFound: () => { throw new Error("must not be called"); },
    intervalMs: 10, timeoutMs: 40,
    fsImpl: { readdirSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } },
  });
  return new Promise((resolve) => setTimeout(() => { stop(); resolve(); }, 80));
});

test("watchForSessionId: stop() prevents any further callback", withTmpDir(async (dir) => {
  const found = [];
  const fsImpl = { readdirSync: () => fs.readdirSync(dir) };
  const stop = watchForSessionId({ cwd: "ignored", onFound: (id) => found.push(id), intervalMs: 10, timeoutMs: 2000, fsImpl });
  stop();
  fs.writeFileSync(path.join(dir, "late.jsonl"), '{"sessionId":"late"}\n');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(found, []);
}));
