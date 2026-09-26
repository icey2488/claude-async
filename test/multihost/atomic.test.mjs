// writeJsonAtomic: crash between temp write and rename leaves the old target intact; bounded
// EPERM/EBUSY/EACCES retry (~1s budget); and a source scan proving no state file in this branch is written with a
// truncating writeFileSync (red if one is reintroduced).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTmp, TMP } from "./_setup.mjs";
import { writeJsonAtomic } from "../../atomic.mjs";

after(cleanupTmp);

const dir = path.join(TMP, "atomic");
fs.mkdirSync(dir, { recursive: true });
const leftovers = (base) => fs.readdirSync(dir).filter((f) => f.startsWith(base) && f.endsWith(".tmp"));

test("writes valid JSON, replaces an existing file, honors indent and leaves no temp file", () => {
  const f = path.join(dir, "plain.json");
  writeJsonAtomic(f, { a: 1 });
  assert.equal(fs.readFileSync(f, "utf8"), '{\n  "a": 1\n}');
  writeJsonAtomic(f, [1, 2], { space: 0 });
  assert.equal(fs.readFileSync(f, "utf8"), "[1,2]");
  assert.deepEqual(leftovers("plain.json"), []);
});

test("a crash between the temp write and the rename leaves the old target intact and parseable", () => {
  const f = path.join(dir, "crash.json");
  writeJsonAtomic(f, { version: "old" });
  const crashing = { ...fs, renameSync() { throw Object.assign(new Error("simulated crash before rename"), { code: "EIO" }); } };
  assert.throws(() => writeJsonAtomic(f, { version: "new", pad: "x".repeat(10_000) }, { fsImpl: crashing }), /simulated crash/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { version: "old" });
  assert.deepEqual(leftovers("crash.json"), [], "a failed write cleans up its temp file");
});

test("a real crash leaves an orphan temp and an untouched target (the temp is never the target)", () => {
  const f = path.join(dir, "orphan.json");
  writeJsonAtomic(f, { version: "old" });
  // Model a process death: the temp write lands, the rename never happens, and nothing cleans up.
  const dies = { ...fs, renameSync() { throw new Error("process died"); }, unlinkSync() { throw new Error("no cleanup"); } };
  assert.throws(() => writeJsonAtomic(f, { version: "new" }, { fsImpl: dies }), /process died/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { version: "old" });
  const orphans = leftovers("orphan.json");
  assert.equal(orphans.length, 1);
  assert.notEqual(orphans[0], "orphan.json");
  fs.rmSync(path.join(dir, orphans[0]));
});

test("EPERM/EBUSY on rename is retried a bounded number of times, then succeeds", () => {
  const f = path.join(dir, "retry.json");
  let calls = 0;
  const flaky = { ...fs, renameSync(a, b) {
    if (++calls <= 3) throw Object.assign(new Error("locked"), { code: calls % 2 ? "EPERM" : "EBUSY" });
    return fs.renameSync(a, b);
  } };
  writeJsonAtomic(f, { ok: true }, { fsImpl: flaky });
  assert.equal(calls, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ok: true });
});

test("EACCES on rename (antivirus holding the temp file) is retried, then succeeds", () => {
  const f = path.join(dir, "eacces.json");
  let calls = 0;
  const av = { ...fs, renameSync(a, b) {
    if (++calls <= 4) throw Object.assign(new Error("access denied"), { code: "EACCES" });
    return fs.renameSync(a, b);
  } };
  writeJsonAtomic(f, { ok: true }, { fsImpl: av });
  assert.equal(calls, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ok: true });
  assert.deepEqual(leftovers("eacces.json"), []);
});

test("a permanent EACCES gives up after 11 attempts over ~1s (bounded), cleans up the temp and rethrows", () => {
  const f = path.join(dir, "stuck-eacces.json");
  writeJsonAtomic(f, { version: "old" });
  let calls = 0;
  const stuck = { ...fs, renameSync() {
    if (++calls > 50) throw new Error("unbounded retry");
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  } };
  const t0 = Date.now();
  assert.throws(() => writeJsonAtomic(f, { version: "new" }, { fsImpl: stuck }), (e) => e.code === "EACCES");
  const elapsed = Date.now() - t0;
  assert.equal(calls, 11);
  assert.ok(elapsed >= 800, `backoff budget is about 1s, only slept ${elapsed}ms`);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { version: "old" });
  assert.deepEqual(leftovers("stuck-eacces.json"), []);
});

test("a permanent EPERM gives up after 11 attempts (bounded), cleans up and rethrows", () => {
  const f = path.join(dir, "stuck.json");
  writeJsonAtomic(f, { version: "old" });
  let calls = 0;
  const stuck = { ...fs, renameSync() {
    if (++calls > 50) throw new Error("unbounded retry"); // fail the test instead of hanging on a regression
    throw Object.assign(new Error("locked"), { code: "EPERM" });
  } };
  assert.throws(() => writeJsonAtomic(f, { version: "new" }, { fsImpl: stuck }), (e) => e.code === "EPERM");
  assert.equal(calls, 11);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { version: "old" });
  assert.deepEqual(leftovers("stuck.json"), []);
});

test("a non-retryable rename error is not retried", () => {
  for (const code of ["ENOENT", "EIO", "ENOSPC"]) {
    const f = path.join(dir, "nonretry.json");
    let calls = 0;
    const bad = { ...fs, renameSync() { calls++; throw Object.assign(new Error("nope"), { code }); } };
    assert.throws(() => writeJsonAtomic(f, {}, { fsImpl: bad }), (e) => e.code === code);
    assert.equal(calls, 1, code);
  }
});

// Source scan: the only truncating writeFileSync calls left in the multihost files are the lock file
// (an O_EXCL mutex, not state) and the tiny exit_code marker (pre-existing, existence-checked flag).
test("no state file in the multihost sources is written with a bare writeFileSync", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const allowed = [/flag: "wx"/, /p\.exit, "126"/];
  const offenders = [];
  for (const f of ["job-core.mjs", "guard.mjs", "hosts.mjs", "host-api.mjs", "dispatch.mjs"]) {
    fs.readFileSync(path.join(root, f), "utf8").split(/\r?\n/).forEach((line, i) => {
      if (/\b(writeFileSync|createWriteStream)\b/.test(line) && !allowed.some((re) => re.test(line))) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
