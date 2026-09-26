// The launcher's ticket-claim protocol (launcher-claim.mjs). Unit tests first, then the regression
// tests for the Windows double-claim bug: renameSync alone let two launchers BOTH "win" one ticket,
// so a job ran twice and another ticket was never claimed. Everything runs in temp dirs; the real
// launcher variant points a copy of job-launcher.mjs at a temp home (USERPROFILE/HOME, the same
// mechanism _setup.mjs uses) and aborts before spawning anything if that override did not take.
//
// Knobs (all optional):
//   CLAIM_RACE_ROUNDS / CLAIM_RACE_WORKERS / CLAIM_RACE_TICKETS   direct-function race size
//   CLAIM_LAUNCHER_ROUNDS                                        real-launcher rounds
//   CLAIM_RACE_VARIANT=old      run the race harness against the pre-fix rename-only claim and REPORT
//                               the double-claim count instead of asserting zero (proves the harness
//                               catches the bug)
//   CLAIM_TEST_LAUNCHER=<path>  launcher script for the real-launcher variant (default: the repo's
//                               job-launcher.mjs); must sit in the repo dir to resolve its imports
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claimOneTicket, isTicketName, STALE_LOCK_MS } from "../../launcher-claim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ca-claim-"));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const IS_WIN = process.platform === "win32";
const OLD = process.env.CLAIM_RACE_VARIANT === "old";
const nowHr = () => performance.timeOrigin + performance.now();
const DEAD_PID = 2_000_000_000; // above every real pid range: process.kill(pid, 0) -> ESRCH
let dirSeq = 0;

function mkQueue(label) {
  const dir = path.join(ROOT, `${label}-${dirSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const putTicket = (dir, id, body = { jobId: id }) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
function putLock(dir, id, { pid = DEAD_PID, ageMs = 0, raw } = {}) {
  const file = path.join(dir, `${id}.lock`);
  fs.writeFileSync(file, raw !== undefined ? raw : JSON.stringify({ pid, at: new Date().toISOString() }));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}
const listing = (dir) => fs.readdirSync(dir).sort();
const collect = () => { const lines = []; const log = (l) => lines.push(l); return { lines, log }; };
const STALE_AGE = STALE_LOCK_MS + 30_000;

// ---------------------------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------------------------

test("isTicketName: only <jobId>.json is a ticket; claimed files, locks, break markers, logs and temp files are not", () => {
  for (const n of ["a.json", "job-1.json", "x.y.json"]) assert.equal(isTicketName(n), true, n);
  for (const n of ["a.claimed.json", "a.lock", "a.lock.break", "job-launcher.log", "a.json.12.ab.tmp", "a.json.lock"]) {
    assert.equal(isTicketName(n), false, n);
  }
});

test("a pending ticket is claimed, parsed, and leaves no lock or marker behind", () => {
  const q = mkQueue("basic");
  putTicket(q, "j1", { jobId: "j1", specPath: "S" });
  const { lines, log } = collect();
  const c = claimOneTicket({ queueDir: q, log });
  assert.equal(c.claimedPath, path.join(q, "j1.claimed.json"));
  assert.deepEqual(c.ticket, { jobId: "j1", specPath: "S" });
  assert.deepEqual(listing(q), ["j1.claimed.json"]);
  assert.deepEqual(lines, []);
});

test("an empty queue, or one holding only claimed files, locks, markers and logs, yields null and is left untouched", () => {
  const q = mkQueue("nothing");
  for (const f of ["done.claimed.json", "job-launcher.log", "x.lock.break"]) fs.writeFileSync(path.join(q, f), "{}");
  putLock(q, "orphan"); // a lock with no ticket is not a ticket either
  const before = listing(q);
  assert.equal(claimOneTicket({ queueDir: q }), null);
  assert.deepEqual(listing(q), before);
  assert.equal(claimOneTicket({ queueDir: path.join(q, "does-not-exist") }), null);
});

test("each call claims at most one ticket", () => {
  const q = mkQueue("one");
  putTicket(q, "a"); putTicket(q, "b");
  const first = claimOneTicket({ queueDir: q });
  assert.ok(first);
  assert.equal(listing(q).filter(isTicketName).length, 1);
  const second = claimOneTicket({ queueDir: q });
  assert.ok(second);
  assert.notEqual(second.claimedPath, first.claimedPath);
  assert.equal(claimOneTicket({ queueDir: q }), null);
});

test("an unparseable claimed ticket is still claimed (ticket: null) and the lock is released", () => {
  const q = mkQueue("garbage");
  fs.writeFileSync(path.join(q, "bad.json"), "{ not json");
  const c = claimOneTicket({ queueDir: q });
  assert.equal(c.ticket, null);
  assert.deepEqual(listing(q), ["bad.claimed.json"]);
});

test("a ticket whose claimed name is unusable stays pending and its lock is released", () => {
  const q = mkQueue("renamefail");
  putTicket(q, "a");
  fs.mkdirSync(path.join(q, "a.claimed.json")); // renaming a file over a directory fails on every platform
  const { lines, log } = collect();
  assert.equal(claimOneTicket({ queueDir: q, log }), null);
  assert.deepEqual(listing(q), ["a.claimed.json", "a.json"], "no lock left behind, ticket still pending");
  assert.ok(lines.some((l) => /rename under claim lock failed/.test(l)), lines.join("\n"));
});

test("a ticket whose lock is held (fresh) is skipped for the next ticket, and the held lock is left alone", () => {
  const q = mkQueue("held");
  putTicket(q, "a"); putTicket(q, "b");
  const lock = putLock(q, "a", { pid: process.pid, ageMs: 0 });
  const { lines, log } = collect();
  const c = claimOneTicket({ queueDir: q, log });
  assert.equal(path.basename(c.claimedPath), "b.claimed.json");
  assert.deepEqual(listing(q), ["a.json", "a.lock", "b.claimed.json"]);
  assert.ok(fs.existsSync(lock));
  assert.ok(lines.some((l) => /a\.json: claim lock not acquired/.test(l)), lines.join("\n"));
  assert.equal(claimOneTicket({ queueDir: q }), null, "with only the held ticket left there is nothing to claim");
  assert.ok(fs.existsSync(path.join(q, "a.json")));
});

test("stale lock (>= 60s old, owner dead): broken, ticket claimed, break logged, lock and marker gone", () => {
  const q = mkQueue("stale");
  putTicket(q, "a", { jobId: "a" });
  putLock(q, "a", { pid: DEAD_PID, ageMs: STALE_AGE });
  const { lines, log } = collect();
  const c = claimOneTicket({ queueDir: q, log });
  assert.equal(path.basename(c.claimedPath), "a.claimed.json");
  assert.deepEqual(listing(q), ["a.claimed.json"]);
  const broke = lines.filter((l) => /BROKE stale claim lock/.test(l));
  assert.equal(broke.length, 1, lines.join("\n"));
  assert.match(broke[0], new RegExp(`owner pid=${DEAD_PID} dead`));
});

test("stale lock with an unreadable owner (empty or garbled content) is broken", () => {
  for (const raw of ["", "{\"pid\":", "not json", "{\"pid\":\"abc\"}", "{\"pid\":-5}"]) {
    const q = mkQueue("stale-raw");
    putTicket(q, "a");
    putLock(q, "a", { raw, ageMs: STALE_AGE });
    const { lines, log } = collect();
    const c = claimOneTicket({ queueDir: q, log });
    assert.ok(c, `content ${JSON.stringify(raw)} should have been broken: ${lines.join("\n")}`);
    assert.ok(lines.some((l) => /BROKE stale claim lock.*owner pid=unreadable/.test(l)), lines.join("\n"));
  }
});

test("an old lock whose owner is still alive is never broken; the ticket stays pending and the log says why", () => {
  const q = mkQueue("liveowner");
  putTicket(q, "a");
  const lock = putLock(q, "a", { pid: process.pid, ageMs: STALE_AGE });
  const { lines, log } = collect();
  assert.equal(claimOneTicket({ queueDir: q, log }), null);
  assert.deepEqual(listing(q), ["a.json", "a.lock"]);
  assert.ok(fs.existsSync(lock));
  assert.ok(lines.some((l) => /owner pid=\d+ is alive; leaving the ticket pending/.test(l)), lines.join("\n"));
});

test("a lock younger than the threshold is never broken even if its owner is dead", () => {
  const q = mkQueue("fresh");
  putTicket(q, "a");
  putLock(q, "a", { pid: DEAD_PID, ageMs: STALE_LOCK_MS - 20_000 });
  assert.equal(claimOneTicket({ queueDir: q }), null);
  assert.deepEqual(listing(q), ["a.json", "a.lock"]);
});

test("a lock dated in the future (clock stepped back) is never broken", () => {
  const q = mkQueue("future");
  putTicket(q, "a");
  putLock(q, "a", { pid: DEAD_PID, ageMs: -10 * 60_000 });
  assert.equal(claimOneTicket({ queueDir: q }), null);
  assert.deepEqual(listing(q), ["a.json", "a.lock"]);
});

test("the threshold and clock are injectable: a lock is stale once now() - mtime >= staleMs", () => {
  const q = mkQueue("inject");
  putTicket(q, "a");
  const lock = putLock(q, "a", { pid: DEAD_PID, ageMs: 0 });
  const mtime = fs.statSync(lock).mtimeMs;
  assert.equal(claimOneTicket({ queueDir: q, staleMs: 1000, now: () => mtime + 999 }), null);
  assert.ok(claimOneTicket({ queueDir: q, staleMs: 1000, now: () => mtime + 1000 }));
});

test("a stale lock is left alone when another launcher holds the break marker (or its holder died)", () => {
  const q = mkQueue("marker");
  putTicket(q, "a");
  putLock(q, "a", { pid: DEAD_PID, ageMs: STALE_AGE });
  const marker = path.join(q, "a.lock.break");
  fs.writeFileSync(marker, "{}");
  const { lines, log } = collect();
  assert.equal(claimOneTicket({ queueDir: q, log }), null);
  assert.deepEqual(listing(q), ["a.json", "a.lock", "a.lock.break"], "neither the lock nor someone else's marker is touched");
  assert.ok(lines.some((l) => /a\.lock\.break exists .* leaving the ticket pending/.test(l)), lines.join("\n"));
});

test("pidAlive is injectable: a lock owned by a 'live' pid is not broken", () => {
  const q = mkQueue("inject-pid");
  putTicket(q, "a");
  putLock(q, "a", { pid: DEAD_PID, ageMs: STALE_AGE });
  assert.equal(claimOneTicket({ queueDir: q, pidAlive: () => true }), null);
  assert.ok(claimOneTicket({ queueDir: q, pidAlive: () => false }));
});

// ---------------------------------------------------------------------------------------------
// Concurrency: N launcher processes, aligned to a shared instant, draining one queue per round
// ---------------------------------------------------------------------------------------------

const ROUNDS = Number(process.env.CLAIM_RACE_ROUNDS) || (IS_WIN ? 600 : 300);
const WORKERS = Number(process.env.CLAIM_RACE_WORKERS) || 4;
const TICKETS = Number(process.env.CLAIM_RACE_TICKETS) || 3;
const LEAD_MS = 20; // head start between "go" being sent and the instant every worker starts claiming
const WORKER = path.join(HERE, "claim-worker.mjs");

async function startWorkers(n) {
  const ws = Array.from({ length: n }, () => fork(WORKER, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] }));
  await Promise.all(ws.map((w) => new Promise((resolve, reject) => {
    w.once("message", (m) => (m && m.ready ? resolve() : reject(new Error(`unexpected first message ${JSON.stringify(m)}`))));
    w.once("error", reject);
    w.once("exit", (code) => reject(new Error(`worker exited early (${code})`)));
  })));
  return ws;
}
const stopWorkers = (ws) => { for (const w of ws) { try { w.kill(); } catch {} } };

function runRound(workers, round, queueDir) {
  const goAt = nowHr() + LEAD_MS;
  return Promise.all(workers.map((w) => new Promise((resolve, reject) => {
    const onExit = (code) => reject(new Error(`worker ${w.pid} exited (${code}) mid-round ${round}`));
    w.once("exit", onExit);
    w.once("message", (m) => { w.off("exit", onExit); resolve(m); });
    w.send({ round, queueDir, goAt });
  })));
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

test(`claim race: ${WORKERS} aligned launchers x ${ROUNDS} rounds x ${TICKETS} tickets -> no ticket claimed twice, none lost`,
  { timeout: 900_000 }, async (t) => {
    const workers = await startWorkers(WORKERS);
    const doubles = [], lost = [], leftovers = [], spreads = [];
    let late = 0;
    try {
      for (let r = 0; r < ROUNDS; r++) {
        const dir = mkQueue(`race${r}`);
        const ids = Array.from({ length: TICKETS }, (_, i) => `r${r}-t${i}`);
        for (const id of ids) putTicket(dir, id);
        const replies = await runRound(workers, r, dir);

        const counts = new Map();
        for (const rep of replies) for (const c of rep.claimed) counts.set(c, (counts.get(c) || 0) + 1);
        for (const [c, n] of counts) if (n > 1) doubles.push(`round ${r}: ${c} claimed ${n}x`);
        for (const id of ids) if (!counts.has(`${id}.claimed.json`)) lost.push(`round ${r}: ${id} never claimed`);
        const extra = fs.readdirSync(dir).filter((f) => !f.endsWith(".claimed.json"));
        if (extra.length) leftovers.push(`round ${r}: ${extra.join(", ")}`);

        const starts = replies.map((x) => x.startedAt);
        spreads.push(Math.max(...starts) - Math.min(...starts));
        if (replies.some((x) => x.late > 5)) late++;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally { stopWorkers(workers); }

    const summary = `${OLD ? "OLD rename-only claim" : "lock claim"}: ${ROUNDS} rounds, ${WORKERS} workers, ${TICKETS} tickets/round: ` +
      `${doubles.length} double-claimed tickets, ${lost.length} lost, ${leftovers.length} rounds with leftovers; ` +
      `claim start spread median ${median(spreads).toFixed(3)} ms, max ${Math.max(...spreads).toFixed(3)} ms; ${late} rounds with a late worker`;
    t.diagnostic(summary);
    if (OLD) { console.log(summary); return; } // measuring the bug, not asserting
    assert.deepEqual(doubles, [], summary);
    assert.deepEqual(lost, [], summary);
    assert.deepEqual(leftovers, [], `${summary}\nno .lock/.lock.break/.json may remain after a drained queue`);
  });

test(`stale-lock break race: ${WORKERS} aligned launchers find the same stale lock x ${Math.min(ROUNDS, 300)} rounds -> claimed exactly once, broken exactly once`,
  { timeout: 900_000, skip: OLD ? "only meaningful for the lock protocol" : false }, async () => {
    const rounds = Math.min(ROUNDS, 300);
    const workers = await startWorkers(WORKERS);
    const problems = [];
    try {
      for (let r = 0; r < rounds; r++) {
        const dir = mkQueue(`stale${r}`);
        const id = `s${r}`;
        putTicket(dir, id);
        putLock(dir, id, { pid: DEAD_PID, ageMs: STALE_AGE });
        const replies = await runRound(workers, r, dir);
        const claimers = replies.filter((x) => x.claimed.includes(`${id}.claimed.json`)).length;
        const breaks = replies.flatMap((x) => x.logs).filter((l) => /BROKE stale claim lock/.test(l)).length;
        const extra = fs.readdirSync(dir).filter((f) => !f.endsWith(".claimed.json"));
        if (claimers !== 1) problems.push(`round ${r}: ticket claimed by ${claimers} launchers`);
        if (breaks !== 1) problems.push(`round ${r}: lock broken ${breaks} times`);
        if (extra.length) problems.push(`round ${r}: leftovers ${extra.join(", ")}`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally { stopWorkers(workers); }
    assert.deepEqual(problems, []);
  });

// ---------------------------------------------------------------------------------------------
// The real job-launcher.mjs, several copies at once, against a temp queue with a stub runner
// ---------------------------------------------------------------------------------------------

const LAUNCHER = process.env.CLAIM_TEST_LAUNCHER || path.join(REPO, "job-launcher.mjs");
const PRELOAD = pathToFileURL(path.join(HERE, "claim-preload.mjs")).href;
const STUB_RUNNER = path.join(HERE, "claim-stub-runner.mjs");
const LAUNCHER_ROUNDS = Number(process.env.CLAIM_LAUNCHER_ROUNDS) || 120;
const LAUNCHERS = 3;
const BATCH = 4; // rounds run side by side (each in its own home + queue), sharing one go-instant
const realIt = IS_WIN ? test : test.skip; // the launcher is the Windows Task Scheduler entry point

function launcherEnv(home, goAt) {
  return { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_ASYNC_JOB_DIR: path.join(home, "jobs"),
    CLAIM_TEST_REPO: REPO, CLAIM_TEST_GO_AT: String(goAt || 0) };
}

// The launcher derives its queue from os.homedir() alone. If the override did not take, it would be
// scanning (and CLAIMING) the live ~/.claude-async-launcher-queue, so refuse to spawn anything.
function assertLauncherHomeIsTemp(home) {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"],
    { env: launcherEnv(home), encoding: "utf8" });
  assert.equal(path.resolve(r.stdout), path.resolve(home), "USERPROFILE/HOME override did not take; refusing to run a real launcher");
  assert.ok(path.resolve(home).startsWith(path.resolve(ROOT) + path.sep), `${home} is not inside the temp root`);
  assert.notEqual(path.resolve(home, ".claude-async-launcher-queue"), path.resolve(os.homedir(), ".claude-async-launcher-queue"));
}

function makeHome(label, ids) {
  const home = path.join(ROOT, label);
  const queue = path.join(home, ".claude-async-launcher-queue");
  fs.mkdirSync(queue, { recursive: true });
  const jobDirs = [];
  for (const id of ids) {
    const jobDir = path.join(home, "jobs", id);
    fs.mkdirSync(jobDir, { recursive: true });
    const specPath = path.join(jobDir, "spec.json");
    fs.writeFileSync(specPath, JSON.stringify({ command: process.execPath, argv: [], cwd: home,
      out: path.join(jobDir, "out.log"), err: path.join(jobDir, "err.log"), exit: path.join(jobDir, "exit_code") }));
    putTicket(queue, id, { jobId: id, jobDir, specPath, errPath: path.join(jobDir, "err.log"),
      nodeExe: process.execPath, runnerScript: STUB_RUNNER, envOverrides: {}, createdAt: new Date().toISOString() });
    jobDirs.push(jobDir);
  }
  return { home, queue, jobDirs };
}

function runLauncher(home, goAt) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", PRELOAD, LAUNCHER],
      { env: launcherEnv(home, goAt), stdio: "ignore", windowsHide: true });
    c.on("exit", (code) => resolve(code));
    c.on("error", () => resolve(-1));
  });
}

const claimedIds = (queue) => {
  const log = fs.readFileSync(path.join(queue, "job-launcher.log"), "utf8");
  return [...log.matchAll(/\] claimed jobId=(\S+) specPath=/g)].map((m) => m[1]);
};

realIt(`real job-launcher.mjs: ${LAUNCHERS} copies x ${LAUNCHER_ROUNDS} rounds against a temp queue -> each job claimed and started exactly once`,
  { timeout: 900_000 }, async (t) => {
    assertLauncherHomeIsTemp(makeHome("safety", []).home);
    const problems = [];
    const all = []; // { ids, jobDirs } per round, for the after-the-fact runner check
    for (let start = 0; start < LAUNCHER_ROUNDS; start += BATCH) {
      const ks = Array.from({ length: Math.min(BATCH, LAUNCHER_ROUNDS - start) }, (_, i) => start + i);
      const homes = ks.map((k) => makeHome(`lr${k}`, Array.from({ length: LAUNCHERS }, (_, i) => `lr${k}-job${i}`)));
      const goAt = nowHr() + 600; // enough for every process to boot and pre-import before the spin ends
      const exits = await Promise.all(homes.flatMap((h) => Array.from({ length: LAUNCHERS }, () => runLauncher(h.home, goAt))));
      if (exits.some((c) => c !== 0)) problems.push(`batch at round ${start}: launcher exit codes ${JSON.stringify(exits)}`);
      homes.forEach((h, i) => {
        const ids = h.jobDirs.map((d) => path.basename(d));
        const counts = new Map();
        for (const id of claimedIds(h.queue)) counts.set(id, (counts.get(id) || 0) + 1);
        for (const [id, n] of counts) if (n > 1) problems.push(`round ${ks[i]}: ${id} claimed ${n}x`);
        for (const id of ids) if (!counts.has(id)) problems.push(`round ${ks[i]}: ${id} never claimed`);
        const extra = fs.readdirSync(h.queue).filter((f) => !f.endsWith(".claimed.json") && f !== "job-launcher.log");
        if (extra.length) problems.push(`round ${ks[i]}: leftovers ${extra.join(", ")}`);
        all.push({ ids, jobDirs: h.jobDirs });
      });
    }
    const claimDoubles = problems.filter((p) => /claimed \d+x/.test(p)).length;

    // The detached stub runners finish on their own; wait for every job to have started, then a beat
    // longer so a second (double-launched) runner would have shown up too.
    const runFiles = (d) => fs.readdirSync(d).filter((f) => f.startsWith("ran-"));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !all.every((r) => r.jobDirs.every((d) => runFiles(d).length >= 1))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 400));
    let runDoubles = 0;
    for (const r of all) for (const d of r.jobDirs) {
      const n = runFiles(d).length;
      if (n !== 1) { runDoubles++; problems.push(`${path.basename(d)}: runner started ${n}x`); }
    }
    const summary = `${OLD ? "OLD launcher" : "launcher"}: ${LAUNCHER_ROUNDS} rounds x ${LAUNCHERS} copies: ` +
      `${claimDoubles} double-claimed tickets, ${runDoubles} jobs not started exactly once, ${problems.length} problems`;
    t.diagnostic(summary);
    if (OLD) { console.log(summary); console.log(problems.slice(0, 20).join("\n")); return; }
    assert.deepEqual(problems, [], summary);
  });

realIt("real job-launcher.mjs: a stale lock (dead owner) is broken and logged; a fresh lock is left alone", { timeout: 60_000 }, async () => {
  const stale = makeHome("real-stale", ["s1"]);
  assertLauncherHomeIsTemp(stale.home);
  putLock(stale.queue, "s1", { pid: DEAD_PID, ageMs: STALE_AGE });
  assert.equal(await runLauncher(stale.home, 0), 0);
  assert.deepEqual(claimedIds(stale.queue), ["s1"]);
  assert.deepEqual(listing(stale.queue), ["job-launcher.log", "s1.claimed.json"]);
  assert.match(fs.readFileSync(path.join(stale.queue, "job-launcher.log"), "utf8"), /BROKE stale claim lock/);

  const fresh = makeHome("real-fresh", ["f1"]);
  putLock(fresh.queue, "f1", { pid: process.pid, ageMs: 0 });
  assert.equal(await runLauncher(fresh.home, 0), 0);
  assert.deepEqual(claimedIds(fresh.queue), []);
  assert.deepEqual(listing(fresh.queue), ["f1.json", "f1.lock", "job-launcher.log"]);
  assert.match(fs.readFileSync(path.join(fresh.queue, "job-launcher.log"), "utf8"), /no pending ticket found/);
});
