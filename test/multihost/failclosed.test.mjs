// The guard must fail CLOSED on corrupt state: a garbage meta.json still counts toward the
// concurrency cap while its dir is fresh, and a garbage/missing ledger is rebuilt from the job dirs
// instead of wiping the rate-limit history. Every mtime is set explicitly relative to the frozen
// clock; the rate tests anchor the frozen clock to real "now" because they read dir BIRTHtimes,
// which no API can set (the assertions only ever look at offsets from that anchor, so they do not
// depend on the time of day).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { core, dispatch, guard, fakeLaunch, tickets, jobDirs, resetState, completeAll, cfgFor, cleanupTmp, JOBS } from "./_setup.mjs";

after(cleanupTmp);
beforeEach(resetState);

const cfg = cfgFor("claunker"); // default caps: 4 concurrent, 6/minute
const start = (now, extra = {}) =>
  dispatch.startLocal({ prompt: "p", jobId: "fc" }, cfg, { launch: fakeLaunch, now, ...extra });
const ledger = () => path.join(JOBS, ".start-ledger.json");

const GARBAGE_METAS = [
  ['truncated mid-object', '{"jobId":"x","pid":12'],
  ["empty file", ""],
  ["JSON null", "null"],
  ["binary junk", "\u0000\u0000� not json {{"],
];
function garbageDir(name, content, mtimeMs) {
  const dir = path.join(JOBS, name);
  fs.mkdirSync(dir);
  const meta = path.join(dir, "meta.json");
  fs.writeFileSync(meta, content);
  const t = new Date(mtimeMs);
  fs.utimesSync(meta, t, t);
  fs.utimesSync(dir, t, t); // last: writing the file bumped the dir's mtime
}

test("garbage meta.json in fresh dirs still counts toward the cap: 5th start rejected, no ticket", async () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  GARBAGE_METAS.forEach(([label, content], i) => garbageDir(`garbled-${i}`, content, now.getTime() - 20_000));
  const r = await start(now);
  assert.equal(r.errorCode, "cap_concurrent");
  assert.match(r.error, /: 4 jobs already running [(]max 4 concurrent[)]; no job started/);
  assert.equal(tickets().length, 0, "no ticket written");
  assert.equal(jobDirs().length, 4, "no job dir created");
  assert.equal(r.warnings, undefined, "fresh dirs are counted, not warned about");
});

test("the same garbage in dirs older than 2 min is not counted, and the start response names each dir", async () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  GARBAGE_METAS.forEach(([label, content], i) => garbageDir(`old-garbled-${i}`, content, now.getTime() - 5 * 60_000));
  const r = await start(now);
  assert.ok(!r.error, r.error);
  assert.equal(tickets().length, 1);
  assert.equal(r.warnings.length, 4);
  GARBAGE_METAS.forEach((_, i) => {
    const w = r.warnings.find((x) => x.includes(`old-garbled-${i}`));
    assert.ok(w, `warning for old-garbled-${i}`);
    assert.match(w, /unreadable meta[.]json/);
    assert.match(w, /NOT counted/);
  });
});

test("3 fresh + 1 old garbage dirs: only the fresh ones count, so a start still fits", async () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  for (let i = 0; i < 3; i++) garbageDir(`fresh-${i}`, "{", now.getTime() - 10_000);
  garbageDir("old-one", "{", now.getTime() - 10 * 60_000);
  const r = await start(now);
  assert.ok(!r.error, r.error);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /old-one/);
});

test("a recently rewritten meta.json keeps a dir counted even when the dir mtime itself is old", async () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  const caps = { maxConcurrent: 1, maxStartsPerMinute: 100 };
  garbageDir("meta-fresh", "{", now.getTime() - 10_000);
  fs.utimesSync(path.join(JOBS, "meta-fresh"), new Date(now.getTime() - 10 * 60_000), new Date(now.getTime() - 10 * 60_000));
  assert.equal((await start(now, { caps })).errorCode, "cap_concurrent");
  // control: with the meta.json old as well, the same dir no longer counts
  const old = new Date(now.getTime() - 10 * 60_000);
  fs.utimesSync(path.join(JOBS, "meta-fresh", "meta.json"), old, old);
  const r = await start(now, { caps });
  assert.ok(!r.error, r.error);
  assert.match(r.warnings[0], /meta-fresh/);
});

// countActiveJobs separates "meta.json is bad" from "meta.json is fine but the status check threw",
// and both follow the same freshness rule (a throw is never silently skipped: that would fail open).
const throwingCheck = () => { throw Object.assign(new Error("EACCES: permission denied, open exit_code"), { code: "EACCES" }); };

test("a checkJob throw on a readable meta.json in a fresh dir is counted, with no warning", () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  garbageDir("chk-fresh", JSON.stringify({ jobId: "chk-fresh", pid: 1 }), now.getTime() - 20_000);
  const r = core.countActiveJobs(now.getTime(), { check: throwingCheck });
  assert.deepEqual(r, { count: 1, warnings: [] });
});

test("a checkJob throw in a stale dir is not counted, and the warning says status check failed (not unreadable meta.json)", () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  garbageDir("chk-stale", JSON.stringify({ jobId: "chk-stale", pid: 1 }), now.getTime() - 10 * 60_000);
  const r = core.countActiveJobs(now.getTime(), { check: throwingCheck });
  assert.equal(r.count, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /chk-stale/);
  assert.match(r.warnings[0], /readable meta[.]json but its status check failed [(]EACCES: permission denied/);
  assert.match(r.warnings[0], /NOT counted/);
  assert.ok(!/unreadable meta[.]json/.test(r.warnings[0]), "must not blame a meta.json that parsed fine");
});

for (const [label, content] of [["JSON null", "null"], ["a JSON array", "[]"], ["a JSON string", "\"x\""], ["a JSON number", "7"]]) {
  test(`meta.json that is ${label} is "unreadable meta.json (not a JSON object)", fresh -> counted, stale -> warned`, () => {
    const now = new Date(2026, 8, 25, 12, 0, 0);
    garbageDir("shape-fresh", content, now.getTime() - 10_000);
    assert.deepEqual(core.countActiveJobs(now.getTime()), { count: 1, warnings: [] });
    garbageDir("shape-stale", content, now.getTime() - 10 * 60_000);
    const r = core.countActiveJobs(now.getTime());
    assert.equal(r.count, 1, "only the fresh one");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /shape-stale has an unreadable meta[.]json [(]not a JSON object[)]/);
    assert.ok(!/status check failed/.test(r.warnings[0]));
  });
}

test("isPlainObject: objects only", () => {
  assert.equal(core.isPlainObject({ a: 1 }), true);
  assert.equal(core.isPlainObject({}), true);
  for (const x of [null, undefined, [], [1], "s", 7, true, () => 1]) assert.equal(core.isPlainObject(x), false, String(x));
});

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

async function sixStartsThenCorrupt(anchor, corrupt) {
  for (let i = 0; i < 6; i++) {
    const r = await start(new Date(anchor.getTime() + i * 5000), { caps: { maxConcurrent: 100, maxStartsPerMinute: 6 } });
    assert.ok(!r.error, `start ${i + 1}: ${r.error}`);
    completeAll(); // keep concurrency out of the picture
  }
  assert.equal(JSON.parse(fs.readFileSync(ledger(), "utf8")).length, 6);
  corrupt();
}

for (const [label, corrupt] of [
  ["garbage text", () => fs.writeFileSync(ledger(), "{{ not json")],
  ["truncated array", () => fs.writeFileSync(ledger(), "[1727300000000,17273")],
  ["empty file", () => fs.writeFileSync(ledger(), "")],
  ["valid JSON, wrong shape", () => fs.writeFileSync(ledger(), '{"starts": 6}')],
  ["missing", () => fs.rmSync(ledger())],
]) {
  test(`ledger ${label}: starts are rebuilt from recent job dirs, so the 7th start within 60s is still rejected`, async () => {
    const anchor = new Date();
    await sixStartsThenCorrupt(anchor, corrupt);
    const r7 = await start(new Date(anchor.getTime() + 30_000), { caps: { maxConcurrent: 100, maxStartsPerMinute: 6 } });
    assert.equal(r7.errorCode, "cap_rate");
    assert.match(r7.error, /6 starts in the last 60s [(]max 6 per minute[)]; no job started/);
    assert.equal(tickets().length, 6, "7th start must not write a ticket");
    assert.equal(jobDirs().length, 6);
    const rewritten = JSON.parse(fs.readFileSync(ledger(), "utf8")); // valid again, atomically rewritten
    assert.ok(Array.isArray(rewritten) && rewritten.length === 6 && rewritten.every((t) => typeof t === "number"));
  });
}

test("a corrupt ledger does not lock out all starts: with no recent dirs, the rebuild is empty and starts proceed", async () => {
  const anchor = new Date();
  await sixStartsThenCorrupt(anchor, () => fs.writeFileSync(ledger(), "garbage"));
  // 90s later every dir is outside the 60s window, so the rebuilt history is empty
  const r = await start(new Date(anchor.getTime() + 90_000), { caps: { maxConcurrent: 100, maxStartsPerMinute: 6 } });
  assert.ok(!r.error, r.error);
  assert.equal(JSON.parse(fs.readFileSync(ledger(), "utf8")).length, 1);
});

// A backward clock step leaves ledger entries in the future. They must still count (clamped to now),
// exactly like rebuildStarts treats future dir times, or the rate cap silently opens.
const CAPS6 = { maxConcurrent: 100, maxStartsPerMinute: 6 };

test("a valid ledger with 6 entries 30s in the future (clock stepped back) still blocks the 7th start", async () => {
  const now = new Date(2026, 8, 25, 12, 0, 0);
  fs.writeFileSync(ledger(), JSON.stringify(Array.from({ length: 6 }, (_, i) => now.getTime() + 30_000 + i)));
  const r = await start(now, { caps: CAPS6 });
  assert.equal(r.errorCode, "cap_rate");
  assert.match(r.error, /6 starts in the last 60s [(]max 6 per minute[)]; no job started/);
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("future ledger entries are clamped to now when read, and recordStart persists them clamped so they age out 60s after now", () => {
  const now = new Date(2026, 8, 25, 12, 0, 0).getTime();
  fs.writeFileSync(ledger(), JSON.stringify([now + 30_000, now + 10_000, now - 5_000]));
  assert.deepEqual(guard.recentStarts(JOBS, now), [now, now, now - 5_000]);
  guard.recordStart(JOBS, now);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledger(), "utf8")), [now, now, now - 5_000, now]);
  assert.equal(guard.recentStarts(JOBS, now + 59_000).length, 3, "the clamped entries are still inside the window");
  assert.equal(guard.recentStarts(JOBS, now + 61_000).length, 0, "and gone 60s after now, not 60s after their raw future time");
});

test("ledger entries a full window or more in the future, and non-numbers, are discarded (same bound as rebuildStarts)", () => {
  const now = new Date(2026, 8, 25, 12, 0, 0).getTime();
  fs.writeFileSync(ledger(), JSON.stringify([now + 60_000, now + 3_600_000, "x", null, now - 61_000, now + 59_000]));
  assert.deepEqual(guard.recentStarts(JOBS, now), [now]);
});

test("dirCreatedMs is the earlier of birthtime and mtime (a heartbeat-touched dir does not look new)", () => {
  const dir = path.join(JOBS, "born");
  fs.mkdirSync(dir);
  const born = guard.dirCreatedMs(dir);
  assert.ok(Math.abs(born - Date.now()) < 5000, "fresh dir: about now");
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(dir, old, old);
  assert.ok(Math.abs(guard.dirCreatedMs(dir) - old.getTime()) < 2000, "old mtime wins when earlier than birthtime");
  const future = new Date(Date.now() + 3_600_000);
  fs.utimesSync(dir, future, future); // a later mtime (heartbeat rename) never moves the estimate forward
  assert.ok(guard.dirCreatedMs(dir) <= born + 1, "later mtime does not push creation time forward");
});
