// job-runner.mjs records why the CLI ended (exitCode/exitSignal/exitReason, stderr/stdout tails
// read off out.log/err.log on disk, endedAt, spawnError) into its OWN file, exit.json, next to
// meta.json -- it never touches meta.json (job-core is meta.json's only writer). Each test runs
// the REAL runner against test/multihost/fake-cli.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTmp, TMP } from "./_setup.mjs";

after(cleanupTmp);

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "..", "job-runner.mjs");
const FAKE = path.join(here, "fake-cli.mjs");
let seq = 0;

// Runs the runner to completion over a pre-written meta.json; returns { meta, exitRecord, metaBefore, dir, res }.
// extraMeta is merged into the fixture meta.json (e.g. { cardId, startHead } to exercise closeCard).
function runJob(command, argv, extraMeta = {}) {
  const dir = path.join(TMP, `exit-reason-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const spec = { command, argv, cwd: dir, out: path.join(dir, "out.log"), err: path.join(dir, "err.log"),
                 exit: path.join(dir, "exit_code") };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify({ jobId: `j${seq}`, pid: 1, status: "running", custom: "keep", ...extraMeta }));
  const metaBefore = fs.readFileSync(metaPath); // raw bytes, before the runner touches anything
  const res = spawnSync(process.execPath, [RUNNER, path.join(dir, "spec.json")], { encoding: "utf8", timeout: 60_000 });
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const exitRecord = JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
  assert.deepEqual(fs.readFileSync(metaPath), metaBefore, "meta.json must be byte-identical: the runner is not one of its writers");
  return { meta, exitRecord, dir, res };
}
const fake = (...a) => runJob(process.execPath, [FAKE, ...a.map(String)]);
const lines = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix} ${from + i}`);

test("normal exit 0: exit.json present, meta.json untouched, no spawnError", () => {
  const { meta, exitRecord, dir } = fake("--exit", 0);
  assert.equal(exitRecord.exitCode, 0);
  assert.equal(exitRecord.exitSignal, null);
  assert.equal(exitRecord.exitReason, "exit");
  assert.deepEqual(exitRecord.stderrTail, []);
  assert.deepEqual(exitRecord.stdoutTail, []);
  assert.ok(!Number.isNaN(Date.parse(exitRecord.endedAt)) && new Date(exitRecord.endedAt).toISOString() === exitRecord.endedAt);
  assert.equal("spawnError" in exitRecord, false);
  assert.equal(exitRecord.usageLimitSuspected, null);
  assert.equal(meta.jobId, "j" + seq);
  assert.equal(meta.custom, "keep");
  assert.equal("exitCode" in meta, false, "meta.json must not gain exit fields; exit.json is the only writer of those");
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), "0");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "atomic write leaves no temp file");
});

test("nonzero exit with stderr: code, tails, and the log files still get the output", () => {
  const { exitRecord, dir } = fake("--stderr-lines", 3, "--stdout-lines", 2, "--exit", 2);
  assert.equal(exitRecord.exitCode, 2);
  assert.equal(exitRecord.exitReason, "exit");
  assert.deepEqual(exitRecord.stderrTail, lines("err line", 1, 3));
  assert.deepEqual(exitRecord.stdoutTail, lines("out line", 1, 2));
  assert.equal(fs.readFileSync(path.join(dir, "err.log"), "utf8").replace(/\r/g, ""), lines("err line", 1, 3).join("\n") + "\n");
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), "2");
});

test("death by signal: exitReason signal, exitSignal set, exitCode null", { skip: process.platform === "win32" && "Windows has no self-kill signal death: SIGTERM is a plain exit code 1 there" }, () => {
  const { exitRecord } = fake("--stderr-lines", 1, "--exit", 0, "--signal", "SIGTERM");
  assert.equal(exitRecord.exitReason, "signal");
  assert.equal(exitRecord.exitSignal, "SIGTERM");
  assert.equal(exitRecord.exitCode, null);
  assert.deepEqual(exitRecord.stderrTail, ["err line 1"]);
});

test("spawn failure (bad CLI path): spawn-error with message, null code and signal, empty stdout tail", () => {
  const bad = path.join(TMP, "no-such-cli-binary");
  const { exitRecord, dir } = runJob(bad, []);
  assert.equal(exitRecord.exitReason, "spawn-error");
  assert.equal(exitRecord.exitCode, null);
  assert.equal(exitRecord.exitSignal, null);
  assert.match(exitRecord.spawnError, /ENOENT/);
  // The runner's own diagnostic line lands in err.log (same fd the CLI would have used), so the
  // tail is the tail of THAT, not empty -- no CLI output was ever produced to make it otherwise.
  assert.ok(exitRecord.stderrTail.some((l) => l.includes("ENOENT")), "stderrTail should carry the runner's own diagnostic");
  assert.deepEqual(exitRecord.stdoutTail, []);
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), "127");
});

test("tails truncate to the last 20 lines, in order, on both streams", () => {
  const { exitRecord } = fake("--stderr-lines", 45, "--stdout-lines", 21, "--exit", 1);
  assert.equal(exitRecord.stderrTail.length, 20);
  assert.deepEqual(exitRecord.stderrTail, lines("err line", 26, 45));
  assert.deepEqual(exitRecord.stdoutTail, lines("out line", 2, 21));
});

test("exactly 20 lines are all kept", () => {
  const { exitRecord } = fake("--stderr-lines", 20, "--exit", 1);
  assert.deepEqual(exitRecord.stderrTail, lines("err line", 1, 20));
});

// Fixed-width helper matching fake-cli.mjs's --stderr-numbered format ("line NNNNNN\n", 12 bytes
// per line), used by the large-log and boundary tests below.
const numbered = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `line ${String(from + i).padStart(6, "0")}`);

test("large stderr (~5MB): stderrTail is exactly the last 20 lines, in order", () => {
  const N = 450_000; // 450,000 * 12 bytes = 5,400,000 bytes (~5.15 MB), well past the 64 KiB tail window
  const { exitRecord } = fake("--stderr-numbered", N, "--exit", 1);
  assert.equal(exitRecord.stderrTail.length, 20);
  assert.deepEqual(exitRecord.stderrTail, numbered(N - 19, N));
});

test("boundary: a log line straddles the 64 KiB tail cut point; tail has no partial/garbled first line", () => {
  // 20 lines of 4100 bytes each (padded with "x"). Total size 82,000 bytes > TAIL_BYTES (65536), so
  // the tail read starts at byte 82000 - 65536 = 16464, which lands inside line 5 (0-indexed line
  // 4, byte range [16400, 20500)) -- i.e. mid-line, 64 bytes into it. That leaves exactly 15 whole,
  // untouched lines (6..20) after the split, to the end of the file.
  //
  // This width is deliberately chosen (unlike the short lines in --stderr-numbered) so that fewer
  // than TAIL_LINES (20) real lines remain after the split point: if readTail() fails to drop the
  // partial/garbled first line of its read chunk, that corrupted fragment becomes a 16th element,
  // landing inside the final slice(-20) -- an observable difference from the correct 15-line result.
  // (With short lines, thousands of real lines survive the split, and slice(-20) never reaches back
  // far enough to touch a dropped-vs-not-dropped first element either way -- so this width choice is
  // what actually makes the boundary case fail under the mutations checked in the runbook.)
  const COUNT = 20, WIDTH = 4100;
  const size = COUNT * WIDTH;
  const start = size - 65536;
  assert.equal(start, 16464, "sanity: fixed geometry for this test");
  assert.ok(start % WIDTH !== 0 && start % WIDTH < WIDTH - 1, "sanity: the cut point must land mid-line for this test to be meaningful");
  const splitLine = Math.floor(start / WIDTH) + 1; // 1-indexed
  assert.equal(splitLine, 5, "sanity: fixed geometry for this test");

  const fixedLine = (n) => `line ${String(n).padStart(6, "0")}`.padEnd(WIDTH - 1, "x");
  const expected = Array.from({ length: COUNT - splitLine }, (_, i) => fixedLine(splitLine + 1 + i)); // lines 6..20

  const { exitRecord } = fake("--stderr-fixed", COUNT, WIDTH, "--exit", 1);
  assert.equal(exitRecord.stderrTail.length, expected.length, "a corrupted/un-dropped fragment would add a spurious extra element here");
  assert.deepEqual(exitRecord.stderrTail, expected);
  for (const l of exitRecord.stderrTail) assert.match(l, /^line \d{6}x*$/, `line must be clean, not a partial/garbled fragment: ${JSON.stringify(l)}`);
});

// card-hook.mjs's closeCard() only ever shells out to the jobcard command (CLAUNKER_JOBCARD_CMD,
// pointed by _setup.mjs at "__no_such_jobcard_binary__" so this never reaches a real board/network)
// and never writes meta.json itself -- job-core.mjs is meta.json's only writer. This test exercises
// that closeCard path (non-null cardId/startHead) end-to-end through the real runner and confirms
// it stays a safe no-op: meta.json is untouched (asserted inside runJob) and exit.json is still
// written correctly.
test("cardId present in meta.json: closeCard runs (fails open against the fake jobcard binary) without touching meta.json or exit.json", () => {
  const { meta, exitRecord, dir } = runJob(process.execPath, [FAKE, "--exit", "0"], { cardId: "mock-card", startHead: "deadbeef" });
  assert.equal(meta.cardId, "mock-card");
  assert.equal(meta.startHead, "deadbeef");
  assert.equal(exitRecord.exitCode, 0);
  assert.equal(exitRecord.exitReason, "exit");
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), "0");
});
