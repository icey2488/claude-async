// runner.lock (review round 3, finding B4): exactly one job-runner.mjs per job dir, host and container
// jobs alike. The lock is published fully initialised (temp file + link) and a stale lock is taken
// over through a verified rename, so neither "A created the lock but has not written its pid yet"
// nor "two runners judged the same stale lock" can let two runners proceed.
// The interleavings are driven deterministically through runner-lock.mjs's hooks; the end-to-end
// cases run the REAL runner on a host-job spec whose command appends one line to a file.
// Run: node --test test/runner-lock.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "job-runner.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-runner-lock-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const { acquireRunnerLock, parseLock, LOCK_INIT_GRACE_MS } = await import("../runner-lock.mjs");

let seq = 0;
const lockDir = () => { const d = path.join(TMP, `l${++seq}`); fs.mkdirSync(d); return d; };
const DEAD = 999_999;                                     // a pid that is not alive
const liveSet = (...pids) => (pid) => pids.includes(pid);

test("parseLock: '<pid>\\n<nonce>\\n' and the older '<pid>' form; anything else is unparsable", () => {
  assert.deepEqual(parseLock("123\nabcdef0123456789\n"), { pid: 123, nonce: "abcdef0123456789" });
  assert.deepEqual(parseLock("123"), { pid: 123, nonce: null });
  for (const bad of ["", "\n", "abc", "12 3", "0", "-1", "123\nZZ\n"]) assert.equal(parseLock(bad), null, JSON.stringify(bad));
});

test("acquire: the lock is published complete in one step (never empty), with pid and nonce", () => {
  const d = lockDir(); const lock = path.join(d, "runner.lock");
  const r = acquireRunnerLock(lock, { pid: 4242, isLive: liveSet() });
  assert.equal(r.acquired, true);
  assert.deepEqual(parseLock(fs.readFileSync(lock, "utf8")).pid, 4242);
  assert.deepEqual(fs.readdirSync(d), ["runner.lock"], "no temp or stale file left behind");
  // a second contender while 4242 is alive: refused
  assert.deepEqual(acquireRunnerLock(lock, { pid: 4343, isLive: liveSet(4242) }), { acquired: false, holder: 4242, reason: "held" });
});

test("(a) an empty lock just created by another runner (the old O_EXCL window) is NOT taken over; an old empty one is", () => {
  const d = lockDir(); const lock = path.join(d, "runner.lock");
  fs.writeFileSync(lock, "");                           // A: created, pid not written yet
  const b = acquireRunnerLock(lock, { pid: 5000, isLive: liveSet() });
  assert.equal(b.acquired, false, "B must not take over a lock that is still being written");
  assert.equal(b.reason, "initialising");
  assert.equal(fs.readFileSync(lock, "utf8"), "", "A's lock is untouched");
  // the same empty file, older than the grace period: stale
  const later = Date.now() + LOCK_INIT_GRACE_MS + 1000;
  const c = acquireRunnerLock(lock, { pid: 5001, isLive: liveSet(), now: () => later });
  assert.equal(c.acquired, true);
});

test("(b) two runners judging the same stale lock: exactly one acquires (B runs entirely between A's read and A's rename)", () => {
  const d = lockDir(); const lock = path.join(d, "runner.lock");
  fs.writeFileSync(lock, `${DEAD}\n0123456789abcdef\n`);
  let b;
  const a = acquireRunnerLock(lock, { pid: 6000, isLive: liveSet(6001), hooks: {
    afterRead: () => { b = acquireRunnerLock(lock, { pid: 6001, isLive: liveSet(6000) }); },
  } });
  assert.equal(b.acquired, true, "B took the stale lock over");
  assert.equal(a.acquired, false, `A, acting on its earlier stale observation, must not also proceed: ${JSON.stringify(a)}`);
  assert.equal(parseLock(fs.readFileSync(lock, "utf8")).pid, 6001, "B's lock is still in place (A put it back)");
  assert.deepEqual(fs.readdirSync(d), ["runner.lock"]);
});

test("(b') B renames the stale lock away while A is between its read and its rename: A sees it gone, then finds B's lock", () => {
  const d = lockDir(); const lock = path.join(d, "runner.lock");
  fs.writeFileSync(lock, `${DEAD}\n0123456789abcdef\n`);
  let b;
  const a = acquireRunnerLock(lock, { pid: 7000, isLive: liveSet(7001), hooks: {
    afterRead: () => { b = acquireRunnerLock(lock, { pid: 7001, isLive: liveSet(7000) }); },
  } });
  assert.equal([a.acquired, b.acquired].filter(Boolean).length, 1, JSON.stringify({ a, b }));
  // and the opposite interleaving: B starts after A's verified rename, before A links
  const d2 = lockDir(); const lock2 = path.join(d2, "runner.lock");
  fs.writeFileSync(lock2, `${DEAD}\n0123456789abcdef\n`);
  let b2;
  const a2 = acquireRunnerLock(lock2, { pid: 7100, isLive: liveSet(7101), hooks: {
    afterRename: () => { b2 = acquireRunnerLock(lock2, { pid: 7101, isLive: liveSet(7100) }); },
  } });
  assert.equal([a2.acquired, b2.acquired].filter(Boolean).length, 1, JSON.stringify({ a2, b2 }));
});

// ------------------------------------------------------------------- end to end, real runner ---

function hostJob() {
  const dir = path.join(TMP, `job${++seq}`);
  fs.mkdirSync(dir);
  const ran = path.join(dir, "ran.txt");
  const spec = { command: process.execPath, argv: ["-e", `require("fs").appendFileSync(${JSON.stringify(ran)}, process.pid + "\\n"); setTimeout(() => {}, 400)`],
                 cwd: dir, out: path.join(dir, "out.log"), err: path.join(dir, "err.log"), exit: path.join(dir, "exit_code") };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId: `job${seq}`, pid: 1 }));
  // CLAUDE_ASYNC_TEST: belt-and-suspenders alongside lantern-notify.mjs's own NODE_TEST_CONTEXT
  // detection -- this job-runner.mjs child must never reach AgentGlass's real default port with
  // a fake job named `job${seq}` (see lantern-notify.mjs's "Test isolation" header note).
  const env = { ...process.env, CLAUDE_ASYNC_TEST: "1", CLAUNKER_JOBCARD_CMD: JSON.stringify(["__no_such_jobcard_binary__"]), HOME: path.join(TMP, "home"), USERPROFILE: path.join(TMP, "home") };
  const run = () => new Promise((resolve) => { const c = spawn(process.execPath, [RUNNER, path.join(dir, "spec.json")], { env, stdio: "ignore" }); c.on("exit", (code) => resolve(code)); });
  const runs = () => { try { return fs.readFileSync(ran, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  return { dir, run, runs, lock: path.join(dir, "runner.lock") };
}

test("(a, e2e) a runner that finds a freshly created EMPTY runner.lock exits 3 and runs nothing", async () => {
  const j = hostJob();
  fs.writeFileSync(j.lock, "");
  assert.equal(await j.run(), 3);
  assert.equal(j.runs(), 0, "the command never ran");
  assert.match(fs.readFileSync(path.join(j.dir, "err.log"), "utf8"), /runner\.lock/);
});

test("(c, e2e) two runners started at the same instant for one job dir: exactly one runs the command (fresh dir and stale lock)", async () => {
  for (let round = 0; round < 6; round++) {
    const j = hostJob();
    if (round % 2) fs.writeFileSync(j.lock, `${DEAD}`);   // odd rounds: a stale lock from a dead runner (older format)
    const codes = await Promise.all([j.run(), j.run()]);
    assert.equal(j.runs(), 1, `round ${round}: exactly one command execution (codes ${codes})`);
    assert.deepEqual([...codes].sort(), [0, 3], `round ${round}: one runner finished, the other exited 3`);
  }
});

// Argon #4 addition: on Windows, link/rename/unlink against a lock another process holds open can
// fail with EPERM/EACCES/EBUSY instead of EEXIST. That is "held" (exit 3), never an exception.
test("Argon #4: EPERM / EACCES / EBUSY while linking or renaming the lock read as held, not as an exception", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    for (const op of ["linkSync", "renameSync"]) {
      const d = lockDir(); const lock = path.join(d, "runner.lock");
      if (op === "renameSync") fs.writeFileSync(lock, `${DEAD}\n0123456789abcdef\n`);
      else fs.writeFileSync(lock, "4242\n0123456789abcdef\n");
      const fsImpl = { ...fs, [op]: (...a) => { if (a.includes(lock)) { const e = new Error(code); e.code = code; throw e; } return fs[op](...a); } };
      let r;
      assert.doesNotThrow(() => { r = acquireRunnerLock(lock, { pid: 9000, isLive: liveSet(), fsImpl }); }, `${op} ${code}`);
      assert.equal(r.acquired, false, `${op} ${code}`);
      assert.equal(r.reason, "busy", `${op} ${code}`);
    }
  }
});
