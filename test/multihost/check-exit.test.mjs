// claude_check (job-core.mjs's checkJob) surfaces the runner's exit.json record under an `exit`
// field so a dead or failed job is attributable without opening the job dir. This is purely
// additive reporting: it must never change the running/completed/failed/died/timed_out
// classification, must never throw on a missing/partial/unparseable/oversized exit.json, and must
// omit the key entirely (never null) for jobs that predate exit.json.
//
// died jobs additionally get `diedCause` (also purely additive, never changes `status`), derived
// from `exit`: exitReason spawn-error/signal/exit map 1:1, and "unknown" covers both no exit.json
// and an unparseable one.
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

// diedCause narrows the `died` bucket using exit.json's exitReason. makeJob's default meta.pid
// (999999) and no runner.pid/heartbeat file put every job below through checkJob's "legacy: no
// runner_heartbeat file" path, which classifies as `died` once pidAlive/healMetaPid both fail --
// exactly the "process gone without writing exit_code" case diedCause exists to explain.

test("diedCause \"spawn-error\": exit.json exitReason spawn-error", () => {
  makeJob("died-spawn-error", { exitJson: { exitCode: null, exitSignal: null, exitReason: "spawn-error",
    spawnError: "ENOENT", endedAt: new Date().toISOString(), stderrTail: [], stdoutTail: [] } });
  const r = core.checkJob("died-spawn-error");
  assert.equal(r.status, "died");
  assert.equal(r.diedCause, "spawn-error");
});

test("diedCause \"signal\": exit.json exitReason signal", () => {
  makeJob("died-signal", { exitJson: { exitCode: null, exitSignal: "SIGKILL", exitReason: "signal",
    endedAt: new Date().toISOString(), stderrTail: [], stdoutTail: [] } });
  const r = core.checkJob("died-signal");
  assert.equal(r.status, "died");
  assert.equal(r.diedCause, "signal");
});

test("diedCause \"exit\": exit.json exitReason exit (a code was recorded, but exit_code never was)", () => {
  makeJob("died-exit", { exitJson: { exitCode: 1, exitSignal: null, exitReason: "exit",
    endedAt: new Date().toISOString(), stderrTail: ["boom"], stdoutTail: [] } });
  const r = core.checkJob("died-exit");
  assert.equal(r.status, "died");
  assert.equal(r.diedCause, "exit");
});

test("diedCause \"unknown\": no exit.json at all (pre-exit.json job, or runner died before writing one)", () => {
  makeJob("died-no-exit-json");
  const r = core.checkJob("died-no-exit-json");
  assert.equal(r.status, "died");
  assert.equal("exit" in r, false);
  assert.equal(r.diedCause, "unknown");
});

test("diedCause \"unknown\": exit.json is unparseable", () => {
  const dir = makeJob("died-bad-exit-json");
  fs.writeFileSync(path.join(dir, "exit.json"), "{not valid json");
  const r = core.checkJob("died-bad-exit-json");
  assert.equal(r.status, "died");
  assert.deepEqual(r.exit, { error: "unparseable exit.json" });
  assert.equal(r.diedCause, "unknown");
});

test("diedCause is absent for non-died statuses, even with an exit.json present", () => {
  makeJob("done-with-exit", { exitCode: 0, exitJson: RECORD_OK });
  const r = core.checkJob("done-with-exit");
  assert.equal(r.status, "completed");
  assert.equal("diedCause" in r, false);
});

test("listJobs surfaces diedCause for a died job, same convention as pidNote", () => {
  makeJob("died-listed", { exitJson: { exitCode: 1, exitSignal: null, exitReason: "exit",
    endedAt: new Date().toISOString(), stderrTail: [], stdoutTail: [] } });
  const rows = core.listJobs();
  const row = rows.find((r) => r.jobId === "died-listed");
  assert.equal(row.status, "died");
  assert.equal(row.diedCause, "exit");
});

// meta.json's `intent` (persisted by startJob when claude_start was given one -- see
// postlaunch.test.mjs) needs no extra plumbing in checkJob: checkJob already spreads `...meta`
// into its return value, so any meta field -- intent included -- surfaces for free.
test("checkJob surfaces meta.intent for free via its ...meta spread; absent intent means no key", () => {
  makeJob("with-intent", { exitCode: 0, meta: { intent: "Fix the flaky test" } });
  assert.equal(core.checkJob("with-intent").intent, "Fix the flaky test");
  makeJob("no-intent", { exitCode: 0 });
  assert.equal("intent" in core.checkJob("no-intent"), false);
});

// listJobs builds its row explicitly (jobId/status/exitCode/startedAt plus conditional extras like
// pidNote/diedCause) rather than spreading meta, so intent needs the same one-line conditional as
// those other optional fields.
test("listJobs surfaces intent for a job that has one, same convention as pidNote/diedCause; omitted when absent", () => {
  makeJob("intent-listed", { exitCode: 0, meta: { intent: "Ship the release" } });
  makeJob("intent-absent", { exitCode: 0 });
  const rows = core.listJobs();
  assert.equal(rows.find((r) => r.jobId === "intent-listed").intent, "Ship the release");
  assert.equal("intent" in rows.find((r) => r.jobId === "intent-absent"), false);
});

// Known gap (reported, not fixed): job-runner.mjs's finish() writes exit.json BEFORE exit_code, so
// a runner killed in that window leaves a clean exit.json (exitCode 0, exitReason "exit") behind a
// job that still classifies `died`, because exit_code was never written and there is no heartbeat
// file. diedCause reads "exit" here, same as any other unfinished-write death -- it does not, and
// per the task must not, reclassify status to "completed" just because exit.json looks clean.
test("classification gap: a died job can have a clean exit.json (exitCode 0) behind it", () => {
  makeJob("died-but-exit-json-clean", { exitJson: { exitCode: 0, exitSignal: null, exitReason: "exit",
    endedAt: new Date().toISOString(), stderrTail: [], stdoutTail: [] } });
  const r = core.checkJob("died-but-exit-json-clean");
  assert.equal(r.status, "died");
  assert.equal(r.exit.exitCode, 0);
  assert.equal(r.diedCause, "exit");
});
