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
function runJob(command, argv) {
  const dir = path.join(TMP, `exit-reason-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const spec = { command, argv, cwd: dir, out: path.join(dir, "out.log"), err: path.join(dir, "err.log"),
                 exit: path.join(dir, "exit_code") };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify({ jobId: `j${seq}`, pid: 1, status: "running", custom: "keep" }));
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
