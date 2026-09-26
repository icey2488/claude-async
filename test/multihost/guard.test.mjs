// The single guard: caps (5th concurrent / 7th-in-a-minute rejected), duplicate ids, preflight,
// depth. Every rejection asserts the temp queue dir (no ticket) and the job root (no job dir).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { core, dispatch, guard, fakeLaunch, tickets, jobDirs, readTicket, resetState, completeAll, cfgFor,
         cleanupTmp, TMP, JOBS } from "./_setup.mjs";

after(cleanupTmp);
beforeEach(resetState);

const cfg = cfgFor("claunker"); // default caps (4 concurrent, 6/minute)
const T0 = new Date(2026, 8, 25, 12, 0, 0);
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const start = (now, extra = {}) =>
  dispatch.startLocal({ prompt: "p", jobId: "cap" }, cfg, { launch: fakeLaunch, now, ...extra });

test("defaults are 4 concurrent / 6 per minute", () => {
  assert.deepEqual(guard.resolveCaps(undefined), { maxConcurrent: 4, maxStartsPerMinute: 6 });
  assert.deepEqual(guard.resolveCaps({ maxConcurrent: 2, maxStartsPerMinute: 3 }), { maxConcurrent: 2, maxStartsPerMinute: 3 });
  assert.deepEqual(guard.resolveCaps({ maxConcurrent: -1, maxStartsPerMinute: "x" }), { maxConcurrent: 4, maxStartsPerMinute: 6 });
});

test("caps: 5th concurrent start rejected, no ticket, no job dir", async () => {
  for (let i = 0; i < 4; i++) {
    const r = await start(at(i));
    assert.ok(!r.error, `start ${i + 1}: ${r.error}`);
  }
  assert.equal(tickets().length, 4);
  const r5 = await start(at(4));
  assert.equal(r5.errorCode, "cap_concurrent");
  assert.match(r5.error, /cap exceeded on host claunker \(.+\): 4 jobs already running \(max 4 concurrent\); no job started/);
  assert.equal(r5.hostname, os.hostname());
  assert.equal(tickets().length, 4, "5th start must not write a ticket");
  assert.equal(jobDirs().length, 4, "5th start must not create a job dir");
  // once one finishes, a slot frees up
  fs.writeFileSync(path.join(JOBS, jobDirs()[0], "exit_code"), "0");
  const r6 = await start(at(5));
  assert.ok(!r6.error, r6.error);
});

test("caps: a reserved-but-not-yet-launched job dir counts as running", async () => {
  for (let i = 0; i < 4; i++) fs.mkdirSync(path.join(JOBS, `inflight-${i}`)); // no meta.json yet
  const r = await start(at(0));
  assert.equal(r.errorCode, "cap_concurrent");
  assert.equal(tickets().length, 0);
});

test("caps: 7th start within a minute rejected, no ticket; window rolls", async () => {
  for (let i = 0; i < 6; i++) {
    const r = await start(at(i * 5));
    assert.ok(!r.error, `start ${i + 1}: ${r.error}`);
    completeAll(); // keep concurrency out of the picture
  }
  assert.equal(tickets().length, 6);
  const r7 = await start(at(30));
  assert.equal(r7.errorCode, "cap_rate");
  assert.match(r7.error, /cap exceeded on host claunker \(.+\): 6 starts in the last 60s \(max 6 per minute\); no job started/);
  assert.equal(tickets().length, 6, "7th start must not write a ticket");
  assert.equal(jobDirs().length, 6);
  // rejected starts don't consume budget; 61s after the first start one slot has rolled off
  const r8 = await start(at(61));
  assert.ok(!r8.error, r8.error);
});

test("caps are configurable via hosts.json caps and env", async () => {
  const tight = cfgFor("claunker", { caps: { maxConcurrent: 1, maxStartsPerMinute: 10 } });
  assert.ok(!(await dispatch.startLocal({ prompt: "p" }, tight, { launch: fakeLaunch })).error);
  const r = await dispatch.startLocal({ prompt: "p" }, tight, { launch: fakeLaunch });
  assert.equal(r.errorCode, "cap_concurrent");
  assert.equal(tickets().length, 1);
  process.env.CLAUDE_ASYNC_MAX_CONCURRENT = "2";
  try {
    assert.ok(!(await core.startJob({ prompt: "p", jobId: "envcap" }, { launch: fakeLaunch })).error);
    assert.equal((await core.startJob({ prompt: "p", jobId: "envcap2" }, { launch: fakeLaunch })).errorCode, "cap_concurrent");
  } finally { delete process.env.CLAUDE_ASYNC_MAX_CONCURRENT; }
});

test("duplicate jobId rejected at create time, no second ticket", async () => {
  const opts = { launch: fakeLaunch, suffix: () => "samesame" };
  const a = await dispatch.startLocal({ prompt: "p", jobId: "dup" }, cfg, opts);
  assert.ok(!a.error, a.error);
  assert.match(a.jobId, /^claunker\.dup-\d{8}-samesame$/);
  const b = await dispatch.startLocal({ prompt: "p", jobId: "dup" }, cfg, opts);
  assert.equal(b.errorCode, "duplicate");
  assert.equal(b.error, `jobId ${a.jobId} already exists`);
  assert.equal(tickets().length, 1);
  assert.equal(jobDirs().length, 1);
  // the low-level exact-id path (legacy callers) rejects too, and ":" is still rewritten
  assert.ok(!(await core.startJob({ prompt: "p", jobId: "legacy:id" }, { launch: fakeLaunch })).error);
  const d = await core.startJob({ prompt: "p", jobId: "legacy_id" }, { launch: fakeLaunch });
  assert.equal(d.errorCode, "duplicate");
  assert.equal(tickets().length, 2);
});

test("unsafe ids are refused before touching disk", async () => {
  for (const id of ["..", ".", ".hidden"]) {
    const r = await core.startJob({ prompt: "p", jobId: id }, { launch: fakeLaunch });
    assert.equal(r.errorCode, "invalid", id);
  }
  assert.equal(core.checkJob("..").error, "invalid jobId");
  assert.equal(core.checkJob("../jobs").error, "invalid jobId");
  assert.equal(tickets().length, 0);
});

test("preflight: missing binary -> error naming the host, nothing written", async () => {
  const r = await dispatch.startLocal({ prompt: "p" }, cfg,
    { launch: fakeLaunch, claudeBin: path.join(TMP, "nope", "claude.exe") });
  assert.equal(r.errorCode, "preflight");
  assert.match(r.error, new RegExp(`^preflight failed on host claunker \\(${os.hostname()}\\): Claude Code binary .* not found$`));
  assert.equal(r.host, "claunker");
  assert.equal(r.hostname, os.hostname());
  const bare = await dispatch.startLocal({ prompt: "p" }, cfg, { launch: fakeLaunch, claudeBin: "__no_such_claude_cli__" });
  assert.equal(bare.errorCode, "preflight");
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("preflight: missing workFolder -> error naming the host, nothing written", async () => {
  const r = await dispatch.startLocal({ prompt: "p", workFolder: path.join(TMP, "no-such-dir") }, cfg, { launch: fakeLaunch });
  assert.equal(r.errorCode, "preflight");
  assert.match(r.error, /^preflight failed on host claunker \(.+\): workFolder ".*no-such-dir" does not exist$/);
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("preflight success wording is exact; binary resolves via PATH too", async () => {
  const r = await dispatch.startLocal({ prompt: "p", workFolder: TMP }, cfg, { launch: fakeLaunch });
  assert.ok(!r.error, r.error);
  assert.equal(r.preflight, "preflight passed, execution unverified");
  assert.equal(core.PREFLIGHT_OK, "preflight passed, execution unverified");
  const dir = path.dirname(process.execPath);
  const bare = path.basename(process.execPath, path.extname(process.execPath)); // "node"
  assert.ok(core.resolveBinary(bare, { PATH: dir }));
  assert.equal(core.resolveBinary("__no_such_claude_cli__", { PATH: dir }), null);
});

test("depth accident guard: depth > 1 rejected, malformed rejected, job gets depth+1", async () => {
  const ok0 = await dispatch.startLocal({ prompt: "p" }, cfg, { launch: fakeLaunch });
  assert.ok(!ok0.error);
  assert.equal(readTicket(ok0.jobId).envOverrides.CLAUDE_ASYNC_DEPTH, "1");
  const ok1 = await dispatch.startLocal({ prompt: "p" }, cfg, { launch: fakeLaunch, depth: "1" });
  assert.ok(!ok1.error);
  assert.equal(readTicket(ok1.jobId).envOverrides.CLAUDE_ASYNC_DEPTH, "2");
  completeAll();
  const before = tickets().length;
  for (const depth of ["2", "7", "abc", "-1", "1.5"]) {
    const r = await dispatch.startLocal({ prompt: "p" }, cfg, { launch: fakeLaunch, depth });
    assert.equal(r.errorCode, "depth", depth);
  }
  process.env.CLAUDE_ASYNC_DEPTH = "2"; // env is the local (MCP) path's source
  try {
    assert.equal((await dispatch.startLocal({ prompt: "p" }, cfg, { launch: fakeLaunch })).errorCode, "depth");
  } finally { delete process.env.CLAUDE_ASYNC_DEPTH; }
  assert.equal(tickets().length, before);
});

test("start lock: a stale lock is broken, a live one serializes concurrent starts", async () => {
  fs.writeFileSync(path.join(JOBS, ".start.lock"), "12345");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(JOBS, ".start.lock"), old, old);
  assert.ok(!(await start(at(0))).error);
  completeAll();
  // 10 concurrent starts against a 4-concurrent cap: exactly 4 win
  const rs = await Promise.all(Array.from({ length: 10 }, () =>
    dispatch.startLocal({ prompt: "p" }, cfgFor("claunker", { caps: { maxConcurrent: 4, maxStartsPerMinute: 100 } }),
                        { launch: fakeLaunch })));
  assert.equal(rs.filter((r) => !r.error).length, 4);
  assert.ok(rs.filter((r) => r.error).every((r) => r.errorCode === "cap_concurrent"));
  assert.equal(tickets().length, 5);
  assert.ok(!fs.existsSync(path.join(JOBS, ".start.lock")));
});
