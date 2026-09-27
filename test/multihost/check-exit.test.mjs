// claude_check (job-core.mjs's checkJob) surfaces the runner's exit.json record under an `exit`
// field so a dead or failed job is attributable without opening the job dir. This is purely
// additive reporting: it must never change the running/completed/failed/died/timed_out
// classification, must never throw on a missing/partial/unparseable/oversized exit.json, and must
// omit the key entirely (never null) for jobs that predate exit.json.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { core, JOBS, cleanupTmp, resetState } from "./_setup.mjs";

after(cleanupTmp);
beforeEach(resetState);

// Builds a job dir directly (no launch/runner involved): meta.json always, exit_code and exit.json
// only if given. exitJson may be an object (JSON.stringify'd) or a raw string (written verbatim, to
// exercise malformed content).
function makeJob(id, { exitCode, exitJson, meta = {} } = {}) {
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"),
    JSON.stringify({ jobId: id, pid: 999999, status: "running", startedAt: new Date().toISOString(), ...meta }));
  if (exitCode !== undefined) fs.writeFileSync(path.join(dir, "exit_code"), String(exitCode));
  if (exitJson !== undefined) {
    fs.writeFileSync(path.join(dir, "exit.json"), typeof exitJson === "string" ? exitJson : JSON.stringify(exitJson));
  }
  return dir;
}

const RECORD_OK = { exitCode: 0, exitSignal: null, exitReason: "exit",
  endedAt: new Date().toISOString(), stderrTail: [], stdoutTail: [], usageLimitSuspected: null };
const RECORD_FAILED = { exitCode: 1, exitSignal: null, exitReason: "exit",
  endedAt: new Date().toISOString(), stderrTail: ["boom"], stdoutTail: [], usageLimitSuspected: null };

test("exit.json present: `exit` is the parsed file, verbatim", () => {
  makeJob("has-exit", { exitCode: 0, exitJson: RECORD_OK });
  const r = core.checkJob("has-exit");
  assert.deepEqual(r.exit, RECORD_OK);
});

test("exit.json absent (job predates it): no `exit` key at all, not null", () => {
  makeJob("no-exit", { exitCode: 0 });
  const r = core.checkJob("no-exit");
  assert.equal("exit" in r, false);
  assert.notEqual(r.exit, null); // belt: `in` already proves this, but null would be an easy regression
});

test("exit.json is malformed JSON: degrades to the fixed error shape, never throws", () => {
  makeJob("bad-exit", { exitCode: 1 });
  fs.writeFileSync(path.join(JOBS, "bad-exit", "exit.json"), "{not valid json");
  const r = core.checkJob("bad-exit");
  assert.deepEqual(r.exit, { error: "unparseable exit.json" });
});

test("exit.json over the 256 KiB cap: refused with the same error shape as unparseable, file never read for content", () => {
  makeJob("big-exit", { exitCode: 1 });
  const big = JSON.stringify({ exitCode: 1, stderrTail: ["x".repeat(300 * 1024)] });
  assert.ok(Buffer.byteLength(big) > 256 * 1024, "sanity: fixture must actually exceed the cap");
  fs.writeFileSync(path.join(JOBS, "big-exit", "exit.json"), big);
  const r = core.checkJob("big-exit");
  assert.deepEqual(r.exit, { error: "unparseable exit.json" });
});

test("exit.json is valid but partial (subset of fields): passed through as-is, not treated as an error", () => {
  makeJob("partial-exit", { exitCode: 1, exitJson: { exitCode: 1 } });
  const r = core.checkJob("partial-exit");
  assert.deepEqual(r.exit, { exitCode: 1 });
});

test("status classification for a completed job is unchanged by exit.json's presence", () => {
  makeJob("done", { exitCode: 0, exitJson: RECORD_OK });
  const r = core.checkJob("done");
  assert.equal(r.status, "completed");
  assert.equal(r.exitCode, 0);
});

test("status classification for a failed job is unchanged by exit.json's presence", () => {
  makeJob("boom", { exitCode: 1, exitJson: RECORD_FAILED });
  const r = core.checkJob("boom");
  assert.equal(r.status, "failed");
  assert.equal(r.exitCode, 1);
});

test("status classification for a completed job is unchanged when exit.json is unparseable", () => {
  makeJob("done-bad-json", { exitCode: 0 });
  fs.writeFileSync(path.join(JOBS, "done-bad-json", "exit.json"), "{not valid json");
  const r = core.checkJob("done-bad-json");
  assert.equal(r.status, "completed");
  assert.deepEqual(r.exit, { error: "unparseable exit.json" });
});
