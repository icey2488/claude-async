// guard.mjs's withStartLock: the cross-process lock around the count-then-reserve step (concurrency
// cap check, rate-ledger check, job-dir mkdir, recordStart). Before this fix it broke a "stale"
// (mtime-old) lock with NO check that the owner pid was actually dead, and released the lock in
// `finally` with NO check that the file at that path was still the one it created -- both differ from
// the identity-checked protocol in launcher-claim.mjs. See RUNBOOK.md "Start lock protocol" and the
// guard.mjs header for the fixed protocol.
//
// Part 1 (process race): a "holder" process acquires the lock, backdates its OWN lock's mtime past
// LOCK_STALE_MS (standing in for a real 30s+ stall between acquire and release, without waiting 30s
// for real), then stays inside its critical section for holdMs ms. A "racer" process, timed to land
// mid-hold, makes its own withStartLock call. Both append timestamped enter/exit lines to a shared
// append-only trace file. If the racer's "enter" lands before the holder's "exit", two processes held
// the lock at once -- exactly the bug. Run against the pre-fix code this reproduces on nearly every
// round (see RUNBOOK for the recorded counts); against the fixed code it must never happen.
//
// Part 1b (process race): two aligned processes find the SAME already-stale, dead-owner lock and race
// to break it (guard.mjs's own two-sided version of the bug the marker exists to prevent).
//
// Part 2 (deterministic unit tests): staleMs/pidAlive/now injection (same technique as
// launcher-claim.mjs / claim.test.mjs) covering each interleaving without any real waiting.
//
// Part 3 (identity via fs patching): a rival replaces the lock or marker file at the exact moment a
// write/unlink is about to happen, same technique claim.test.mjs uses against launcher-claim.mjs.
//
// Part 4 (write-failure file-identity cleanup): a write to a file we just exclusively created can
// fail, leaving it empty; content-based ownership (ownsLock) reads that as unowned and would leave it
// behind forever. The fix recognizes the file by dev+ino captured at create time instead.
//
// Part 5 (own-pid stale, live-owner ceiling): a lock bearing our own pid can never be a live self-hold
// (the lock is only ever held synchronously), and a lock whose owner pid still looks alive past
// LOCK_MAX_HOLD_MS is realistically pid reuse, not a genuine multi-minute hold -- both are broken.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { withStartLock, LOCK_TIMEOUT_MS } from "../../guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ca-startlock-"));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const nowHr = () => performance.timeOrigin + performance.now();
const DEAD_PID = 2_000_000_000; // above every real pid range: process.kill(pid, 0) -> ESRCH
let dirSeq = 0;
const mkRoot = (label) => { const d = path.join(ROOT, `${label}-${dirSeq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const putLock = (jobRoot, { pid = DEAD_PID, ageMs = 0, raw } = {}) => {
  const file = path.join(jobRoot, ".start.lock");
  fs.writeFileSync(file, raw !== undefined ? raw : JSON.stringify({ pid, at: new Date().toISOString() }));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
};
const lockPid = (file) => JSON.parse(fs.readFileSync(file, "utf8")).pid;

// ---------------------------------------------------------------------------------------------
// Part 1: two-process race
// ---------------------------------------------------------------------------------------------

const WORKER = path.join(HERE, "startlock-worker.mjs");
const ROUNDS = Number(process.env.STARTLOCK_RACE_ROUNDS) || 15;
const HOLD_MS = 250; // holder's simulated critical-section duration
const DELTA_MS = 120; // racer's attempt lands this far after the holder's, i.e. mid-hold
const LEAD_MS = 60;

function startWorker() {
  return new Promise((resolve, reject) => {
    const w = fork(WORKER, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    w.once("message", (m) => (m && m.ready ? resolve(w) : reject(new Error(`unexpected first message ${JSON.stringify(m)}`))));
    w.once("error", reject);
    w.once("exit", (code) => reject(new Error(`worker exited early (${code})`)));
  });
}
const stopWorkers = (ws) => { for (const w of ws) { try { w.kill(); } catch {} } };

function runRound(holder, racer, round, jobRoot, tracePath) {
  const goAt1 = nowHr() + LEAD_MS;
  const goAt2 = goAt1 + DELTA_MS;
  const ask = (w, role, goAt) => new Promise((resolve, reject) => {
    const onExit = (code) => reject(new Error(`worker ${w.pid} exited (${code}) mid-round ${round}`));
    w.once("exit", onExit);
    w.once("message", (m) => { w.off("exit", onExit); resolve(m); });
    w.send({ round, jobRoot, tracePath, goAt, role, holdMs: HOLD_MS });
  });
  return Promise.all([ask(holder, "holder", goAt1), ask(racer, "racer", goAt2)]);
}

// Parses "TAG enter/exit pid=... at=<float>" lines and returns whether P2 (racer) entered before P1
// (holder) exited -- i.e. both were inside fn() at the same time.
function parseOverlap(tracePath) {
  const lines = fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean);
  const at = (tag, kind) => {
    const l = lines.find((l) => l.startsWith(`${tag} ${kind} `));
    if (!l) return null;
    return Number(l.match(/at=([\d.]+)/)[1]);
  };
  const p1Enter = at("P1", "enter"), p1Exit = at("P1", "exit");
  const p2Enter = at("P2", "enter"), p2Exit = at("P2", "exit");
  if (p1Enter === null || p1Exit === null || p2Enter === null || p2Exit === null) {
    return { overlap: null, lines }; // one side never entered/exited: round proves nothing either way
  }
  const overlap = p2Enter < p1Exit; // racer got inside fn() before the holder left it
  return { overlap, p1Enter, p1Exit, p2Enter, p2Exit, lines };
}

test(`start lock race: ${ROUNDS} rounds, a stalled holder vs a concurrent racer -> never two holders inside the critical section`,
  { timeout: 60_000 }, async (t) => {
    const [holder, racer] = await Promise.all([startWorker(), startWorker()]);
    const overlaps = [];
    const inconclusive = [];
    try {
      for (let r = 0; r < ROUNDS; r++) {
        const jobRoot = mkRoot(`race${r}`);
        const tracePath = path.join(jobRoot, "trace.log");
        fs.writeFileSync(tracePath, "");
        await runRound(holder, racer, r, jobRoot, tracePath);
        const result = parseOverlap(tracePath);
        if (result.overlap === null) inconclusive.push(`round ${r}: ${result.lines.join(" | ")}`);
        else if (result.overlap) overlaps.push(`round ${r}: P2 entered at ${result.p2Enter.toFixed(3)}, ` +
          `before P1 exited at ${result.p1Exit.toFixed(3)} (P1 entered ${result.p1Enter.toFixed(3)})`);
      }
    } finally { stopWorkers([holder, racer]); }

    const summary = `start lock race: ${ROUNDS} rounds, ${overlaps.length} rounds with two concurrent ` +
      `holders, ${inconclusive.length} inconclusive`;
    t.diagnostic(summary);
    if (overlaps.length) t.diagnostic(overlaps.slice(0, 5).join("\n"));
    assert.deepEqual(inconclusive, [], `every round must produce a complete trace: ${summary}`);
    assert.deepEqual(overlaps, [], summary);
  });

// ---------------------------------------------------------------------------------------------
// Part 1b: two-breaker race -- two aligned processes find the SAME stale, dead-owner lock and race
// to break it. Mirrors claim.test.mjs's "stale-lock break race" (same redo-late-rounds alignment
// discipline: a round whose workers were not released together proves nothing and is redone, not
// budgeted, up to an attempt cap, rather than passing vacuously on a loaded box).
// ---------------------------------------------------------------------------------------------

const BREAK_ROUNDS = Number(process.env.STARTLOCK_BREAK_ROUNDS) || 15;
const BREAK_LEAD_MS = 50;
const BREAK_MAX_LATE_MS = 5; // a worker released this long after the shared instant did not race anyone
const BREAK_HOLD_MS = 50;
const BREAK_STALE_MS = 100;
const BREAK_ATTEMPT_FACTOR = 3;
const breakAttemptCap = (target) => BREAK_ATTEMPT_FACTOR * target;
function newBreakAlignment(target) { return { target, lateRounds: 0, attempts: 0, aligned: 0 }; }
// Returns true if the round was aligned (and so counts toward the target).
function noteBreakAlignment(al, lates) {
  al.attempts++;
  if (lates.some((l) => l > BREAK_MAX_LATE_MS)) { al.lateRounds++; return false; }
  al.aligned++;
  return true;
}
const breakRoundsWanted = (al) => Math.max(0, Math.min(al.target - al.aligned, breakAttemptCap(al.target) - al.attempts));
const breakAlignmentText = (al) => `${al.aligned}/${al.target} aligned rounds; ${al.lateRounds} late rounds ` +
  `(a worker >${BREAK_MAX_LATE_MS} ms late) redone, ${al.attempts}/${breakAttemptCap(al.target)} attempts used`;

function runBreakRound(w1, w2, round, jobRoot, staleMs, holdMs) {
  const goAt = nowHr() + BREAK_LEAD_MS;
  const ask = (w) => new Promise((resolve, reject) => {
    const onExit = (code) => reject(new Error(`worker ${w.pid} exited (${code}) mid-round ${round}`));
    w.once("exit", onExit);
    w.once("message", (m) => { w.off("exit", onExit); resolve(m); });
    w.send({ round, jobRoot, goAt, role: "breaker", staleMs, holdMs });
  });
  return Promise.all([ask(w1), ask(w2)]);
}

test(`two-breaker race: ${BREAK_ROUNDS} rounds, two aligned processes break the same stale lock -> ` +
  "never two holders at once, lock broken at most once per round",
  { timeout: 60_000 }, async (t) => {
    const [b1, b2] = await Promise.all([startWorker(), startWorker()]);
    const overlaps = [], multiBreaks = [];
    const align = newBreakAlignment(BREAK_ROUNDS);
    try {
      for (let r = 0; breakRoundsWanted(align) > 0; r++) {
        const jobRoot = mkRoot(`break${r}`);
        putLock(jobRoot, { pid: DEAD_PID, ageMs: BREAK_STALE_MS + 200 });

        const [r1, r2] = await runBreakRound(b1, b2, r, jobRoot, BREAK_STALE_MS, BREAK_HOLD_MS);
        if (!noteBreakAlignment(align, [r1.late, r2.late])) continue;

        if (r1.enter !== null && r2.enter !== null && r1.enter < r2.exit && r2.enter < r1.exit) {
          overlaps.push(`round ${r}: [${r1.enter.toFixed(3)},${r1.exit.toFixed(3)}] vs ` +
            `[${r2.enter.toFixed(3)},${r2.exit.toFixed(3)}]`);
        }
        const breaks = [...r1.logs, ...r2.logs].filter((l) => /BROKE stale start lock/.test(l)).length;
        if (breaks > 1) multiBreaks.push(`round ${r}: lock broken ${breaks} times`);
      }
    } finally { stopWorkers([b1, b2]); }

    const summary = `two-breaker race: ${align.attempts} rounds run, ${overlaps.length} overlaps, ` +
      `${multiBreaks.length} rounds broken >1x; ${breakAlignmentText(align)}`;
    t.diagnostic(summary);
    assert.equal(align.aligned, align.target, `workers were not aligned, so the race proved nothing: ${summary}`);
    assert.deepEqual(overlaps, [], summary);
    assert.deepEqual(multiBreaks, [], summary);
  });

// ---------------------------------------------------------------------------------------------
// Part 2: deterministic unit tests via staleMs/pidAlive/now injection
// ---------------------------------------------------------------------------------------------

test("a fresh lock (age < staleMs) is never broken, even with an unreadable/dead owner; times out", async () => {
  const jobRoot = mkRoot("fresh");
  const lock = putLock(jobRoot, { pid: DEAD_PID, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  let calls = 0;
  // 1st call anchors the acquire deadline; every later call (staleness checks AND deadline checks
  // alike) reports a time just past that deadline but still well under staleMs of the lock's mtime,
  // so the lock reads "fresh" on every staleness check while the acquirer still gives up on time.
  const now = () => (calls++ === 0 ? mtime : mtime + LOCK_TIMEOUT_MS + 500);
  const r = await withStartLock(jobRoot, () => ({ ok: true }), { staleMs: LOCK_TIMEOUT_MS + 10_000, now, pidAlive: () => false });
  assert.match(r.error, /could not acquire/);
  assert.equal(lockPid(lock), DEAD_PID, "an unexpired lock must never be touched");
});

test("a stale lock (age >= staleMs) whose owner is dead is broken, fn runs, lock released", async () => {
  const jobRoot = mkRoot("stale-dead");
  const lock = putLock(jobRoot, { pid: DEAD_PID, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  const log = [];
  const r = await withStartLock(jobRoot, () => "ran", {
    staleMs: 1_000, now: () => mtime + 1_000, pidAlive: () => false, log: (l) => log.push(l),
  });
  assert.equal(r, "ran");
  assert.ok(!fs.existsSync(lock), "lock must be released after fn returns");
  assert.ok(log.some((l) => /BROKE stale start lock/.test(l)), log.join("\n"));
});

test("a stale-by-age lock whose owner pid is still alive is NEVER broken: caller waits and times out", async () => {
  const jobRoot = mkRoot("stale-alive");
  const lock = putLock(jobRoot, { pid: 999, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  let calls = 0;
  // Deadline computed from the first now() call; the second (post-break-check) call reports past it,
  // so the caller gives up after one poll instead of really waiting LOCK_TIMEOUT_MS.
  const now = () => (calls++ === 0 ? mtime + 2_000 : mtime + 2_000 + 6_000);
  const log = [];
  const r = await withStartLock(jobRoot, () => "ran", {
    staleMs: 1_000, now, pidAlive: (pid) => pid === 999, log: (l) => log.push(l),
  });
  assert.match(r.error, /could not acquire/);
  assert.equal(lockPid(lock), 999, "a lock whose owner is alive must never be unlinked");
  assert.ok(log.some((l) => /owner pid=999 is alive/.test(l)), log.join("\n"));
});

test("a lock dated in the future (clock stepped back) is never broken", async () => {
  const jobRoot = mkRoot("future");
  const lock = putLock(jobRoot, { pid: DEAD_PID, ageMs: -10 * 60_000 });
  let calls = 0;
  const now = () => (calls++ === 0 ? Date.now() : Date.now() + 6_000);
  const r = await withStartLock(jobRoot, () => "ran", { staleMs: 1_000, now, pidAlive: () => false });
  assert.match(r.error, /could not acquire/);
  assert.ok(fs.existsSync(lock));
});

test("pidAlive is injectable: a lock owned by a 'live' pid per pidAlive is not broken, a 'dead' one is", async () => {
  const live = mkRoot("inject-live");
  putLock(live, { pid: DEAD_PID, ageMs: 0 });
  const mtimeLive = fs.statSync(path.join(live, ".start.lock")).mtimeMs;
  let calls = 0;
  const rLive = await withStartLock(live, () => "ran", {
    staleMs: 1_000, now: () => (calls++ === 0 ? mtimeLive + 1_000 : mtimeLive + 1_000 + 6_000), pidAlive: () => true,
  });
  assert.match(rLive.error, /could not acquire/);

  const dead = mkRoot("inject-dead");
  putLock(dead, { pid: DEAD_PID, ageMs: 0 });
  const mtimeDead = fs.statSync(path.join(dead, ".start.lock")).mtimeMs;
  const rDead = await withStartLock(dead, () => "ran", { staleMs: 1_000, now: () => mtimeDead + 1_000, pidAlive: () => false });
  assert.equal(rDead, "ran");
});

// ---------------------------------------------------------------------------------------------
// Part 3: identity -- fs is patched in place to land a rival's lock exactly where the identity check
// must catch it (same technique claim.test.mjs uses against launcher-claim.mjs).
// ---------------------------------------------------------------------------------------------

const OTHER_PID = 4242;
const otherOwner = () => JSON.stringify({ pid: OTHER_PID, at: "2026-01-01T00:00:00.000Z" });

async function withPatchedFs(name, before, body) {
  const orig = fs[name];
  let calls = 0;
  fs[name] = function (...args) {
    if (before(calls++, args) === "throw-eio") throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return orig.apply(this, args);
  };
  try { return await body(); } finally { fs[name] = orig; }
}
function replaceLockWithOthers(lock) {
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, otherOwner());
}

test("identity: our lock replaced between create and write -> we lose it; the release does not touch it", async () => {
  const jobRoot = mkRoot("id-lost");
  const lock = path.join(jobRoot, ".start.lock");
  const log = [];
  const r = await withPatchedFs("writeSync", (n) => { if (n === 0) replaceLockWithOthers(lock); },
    () => withStartLock(jobRoot, () => "ran", { log: (l) => log.push(l), now: () => Date.now() + 6_000 }));
  assert.match(r.error, /could not acquire/);
  assert.equal(lockPid(lock), OTHER_PID, "the other holder's live lock must survive untouched");
  assert.ok(log.some((l) => /lost the start lock/.test(l)), log.join("\n"));
});

test("identity: the release in finally leaves a replaced lock alone (fn's result still returned)", async () => {
  const jobRoot = mkRoot("id-finally");
  const lock = path.join(jobRoot, ".start.lock");
  const log = [];
  // fn() itself stands in for a stall long enough that a breaker plus a second holder replaced our
  // lock while we were inside the critical section (no fs patching needed: fn already runs while we
  // hold the lock, so mutating it here is the direct equivalent of the writeSync-patch technique used
  // for the acquire-side identity tests above).
  const r = await withStartLock(jobRoot, () => { replaceLockWithOthers(lock); return "ran"; }, { log: (l) => log.push(l) });
  assert.equal(r, "ran", "the claim itself (fn's work) still stands even though release found a replaced lock");
  assert.equal(lockPid(lock), OTHER_PID, "the other holder's lock must survive our release");
  assert.ok(log.some((l) => /start lock \.start\.lock is no longer ours/.test(l)), log.join("\n"));
});

test("identity: a break marker replaced while we hold it is left alone; the break and fn still complete", async () => {
  const jobRoot = mkRoot("id-marker");
  const lock = putLock(jobRoot, { pid: DEAD_PID, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  const marker = lock + ".break";
  const log = [];
  const c = await withPatchedFs("unlinkSync", (n, [f]) => {
    if (n === 0 && String(f) === lock) { fs.unlinkSync(marker); fs.writeFileSync(marker, otherOwner()); }
  }, () => withStartLock(jobRoot, () => "ran", { staleMs: 1_000, now: () => mtime + 1_000, pidAlive: () => false, log: (l) => log.push(l) }));
  assert.equal(c, "ran");
  assert.equal(lockPid(marker), OTHER_PID, "someone else's marker is not ours to remove");
  assert.ok(log.some((l) => /break marker \.start\.lock\.break is no longer the file we created/.test(l)), log.join("\n"));
});

test("re-check under the marker: a lock replaced by a fresh one WHILE we hold the marker is never unlinked",
  { timeout: 15_000 }, async () => {
  // Models: our first assessment sees a stale lock; we win the marker race; but before our SECOND
  // (under-the-marker) assessment, some other breaker+new-holder pair already ran to completion and
  // left a brand-new, live lock at the same path. Without the re-check, we would unlink that live
  // lock using our stale first snapshot -- exactly the bug this mutation targets. Uses the real clock
  // (small staleMs, a lock backdated just past it) so the "stale now, fresh moments later" transition
  // is genuine rather than mocked.
  const jobRoot = mkRoot("recheck");
  const lock = putLock(jobRoot, { pid: DEAD_PID, ageMs: 200 });
  const log = [];
  const r = await withPatchedFs("writeSync", (n) => {
    if (n === 0) { // the marker's own content write -- right after we won the marker race
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, JSON.stringify({ pid: OTHER_PID, at: new Date().toISOString() }));
    }
  }, () => withStartLock(jobRoot, () => "ran", { staleMs: 100, pidAlive: (pid) => pid === OTHER_PID, log: (l) => log.push(l) }));
  assert.match(r.error, /could not acquire/, "the fresh live lock must block us, not get unlinked");
  assert.equal(lockPid(lock), OTHER_PID, "the other holder's brand-new lock must survive our break attempt");
  assert.ok(!log.some((l) => /BROKE stale start lock/.test(l)), log.join("\n"));
});

test("identity: our own lock and marker are still removed on the normal paths (nothing lingers)", async () => {
  const jobRoot = mkRoot("id-normal");
  const lock = putLock(jobRoot, { pid: DEAD_PID, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  const r = await withStartLock(jobRoot, () => "ran", { staleMs: 1_000, now: () => mtime + 1_000, pidAlive: () => false });
  assert.equal(r, "ran");
  assert.deepEqual(fs.readdirSync(jobRoot).filter((f) => f.startsWith(".start.lock")), []);
});

// ---------------------------------------------------------------------------------------------
// Part 4: file-identity cleanup on write failure -- a write that fails right after an exclusive
// create must not leave an empty file behind just because its content looks unowned.
// ---------------------------------------------------------------------------------------------

test("lock write failure: the empty lock we created is removed, not left as a 30s block", async () => {
  const jobRoot = mkRoot("lock-write-fail");
  const lock = path.join(jobRoot, ".start.lock");
  const log = [];
  const started = Date.now();
  const r = await withPatchedFs("writeSync", (n) => { if (n === 0) return "throw-eio"; },
    () => withStartLock(jobRoot, () => "ran", { log: (l) => log.push(l) }));
  assert.equal(r, "ran", "the retry after the write failure must succeed immediately, not wait out staleMs");
  assert.ok(Date.now() - started < 2_000, "must not have waited toward the 5s acquire timeout");
  assert.ok(!fs.existsSync(lock), "lock released normally after fn ran");
});

test("marker write failure: break still completes, fn runs, and the marker does not remain", async () => {
  const jobRoot = mkRoot("marker-write-fail");
  const lock = putLock(jobRoot, { pid: DEAD_PID, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  const marker = lock + ".break";
  const log = [];
  const r = await withPatchedFs("writeSync", (n) => { if (n === 0) return "throw-eio"; }, // n=0: the marker's own content write
    () => withStartLock(jobRoot, () => "ran", {
      staleMs: 1_000, now: () => mtime + 1_000, pidAlive: () => false, log: (l) => log.push(l),
    }));
  assert.equal(r, "ran");
  assert.ok(!fs.existsSync(lock), "lock released after break+run");
  assert.ok(!fs.existsSync(marker), "an empty (write-failed) marker must not remain after the break completes");
  assert.ok(log.some((l) => /BROKE stale start lock/.test(l)), log.join("\n"));
});

test("file-id guard: a lock replaced by a rival right before our write failure is not removed", async () => {
  const jobRoot = mkRoot("id-write-fail");
  const lock = path.join(jobRoot, ".start.lock");
  const log = [];
  const r = await withPatchedFs("writeSync", (n) => {
    if (n === 0) { replaceLockWithOthers(lock); return "throw-eio"; }
  }, () => withStartLock(jobRoot, () => "ran", { log: (l) => log.push(l), now: () => Date.now() + 6_000 }));
  assert.match(r.error, /could not acquire/);
  assert.equal(lockPid(lock), OTHER_PID, "the rival's replacement lock must survive our write-failure cleanup");
  assert.ok(log.some((l) => /start lock \.start\.lock is no longer the file we created/.test(l)), log.join("\n"));
});

// ---------------------------------------------------------------------------------------------
// Part 5: own-pid stale and the live-owner ceiling
// ---------------------------------------------------------------------------------------------

test("own-pid stale: a lock bearing our OWN pid, aged past staleMs, is broken (never a live self-hold)", async () => {
  const jobRoot = mkRoot("own-pid");
  const lock = putLock(jobRoot, { pid: process.pid, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  const log = [];
  // pidAlive deliberately says "alive" (trivially true for our own pid) to prove the own-pid rule is
  // checked before, and overrides, the live-owner check. Two-phase now(), like the other tests here:
  // if the own-pid rule were ever dropped this must still time out and give up, not spin forever.
  let calls = 0;
  const now = () => (calls++ === 0 ? mtime : mtime + LOCK_TIMEOUT_MS + 500);
  const r = await withStartLock(jobRoot, () => "ran", {
    staleMs: 1_000, now, pidAlive: () => true, log: (l) => log.push(l),
  });
  assert.equal(r, "ran");
  assert.ok(!fs.existsSync(lock));
  assert.ok(log.some((l) => /is this process itself/.test(l)), log.join("\n"));
});

test("ceiling: a live-looking owner past maxHoldMs is broken anyway (pid reuse), logged distinctly", async () => {
  const jobRoot = mkRoot("ceiling-broken");
  const lock = putLock(jobRoot, { pid: OTHER_PID, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  const log = [];
  // Two-phase now(), like the other tests here: if the ceiling were ever dropped this must still
  // time out and give up, not spin forever waiting for a deadline a fixed now() could never reach.
  let calls = 0;
  const now = () => (calls++ === 0 ? mtime + 600 : mtime + 600 + LOCK_TIMEOUT_MS + 500);
  const r = await withStartLock(jobRoot, () => "ran", {
    staleMs: 100, maxHoldMs: 500, now, pidAlive: (pid) => pid === OTHER_PID, log: (l) => log.push(l),
  });
  assert.equal(r, "ran");
  assert.ok(!fs.existsSync(lock));
  assert.ok(log.some((l) => /BROKE start lock past the 500ms ceiling/.test(l) && /pid=4242 looks alive/.test(l)), log.join("\n"));
});

test("ceiling: a live-looking owner between staleMs and maxHoldMs is NEVER broken; caller times out", async () => {
  const jobRoot = mkRoot("ceiling-pending");
  // Real clock, on purpose: a mocked now() that is fixed across the whole poll would never trip the
  // deadline (infinite loop), and one that grows unboundedly would eventually cross maxHoldMs itself.
  // maxHoldMs is set well above the real ~5s LOCK_TIMEOUT_MS wait so age (starting at 200ms and only
  // growing by the real elapsed polling time) can never reach the ceiling before the caller gives up.
  const lock = putLock(jobRoot, { pid: OTHER_PID, ageMs: 200 });
  const log = [];
  const r = await withStartLock(jobRoot, () => "ran", {
    staleMs: 100, maxHoldMs: 10_000, pidAlive: (pid) => pid === OTHER_PID, log: (l) => log.push(l),
  });
  assert.match(r.error, /could not acquire/);
  assert.equal(lockPid(lock), OTHER_PID, "a live owner below the ceiling must never be unlinked");
  assert.ok(log.some((l) => /owner pid=4242 is alive/.test(l)), log.join("\n"));
});
