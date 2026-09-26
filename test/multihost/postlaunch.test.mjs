// Nothing after a successful launch may throw: startJob's meta.json write falls back to a direct
// write, then to a warning in the response (the runner is already up and a card is minted, so a
// throw would orphan a running job). A failed launch-ticket write falls back to the breakaway path.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { core, fakeLaunch, tickets, resetState, BIG_CAPS, cleanupTmp, JOBS } from "./_setup.mjs";

after(cleanupTmp);
beforeEach(resetState);

const eio = (msg) => Object.assign(new Error(msg), { code: "EIO" });
const startWith = (jobId, fsImpl) =>
  core.startJob({ prompt: "p", jobId }, { launch: fakeLaunch, caps: BIG_CAPS, fsImpl });
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("meta.json: both the atomic and the direct write failing does not throw; the response carries the job and a warning", async () => {
  const dead = { ...fs, writeFileSync() { throw Object.assign(new Error("disk on fire"), { code: "ENOSPC" }); } };
  const r = await startWith("nometa", dead);
  assert.equal(r.error, undefined);
  assert.equal(r.jobId, "nometa");
  assert.equal(r.pid, process.pid);
  assert.equal(r.status, "running");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], new RegExp(
    `^meta[.]json could not be written: disk on fire; the job IS running as pid ${process.pid}; claude_check will not find it$`));
  assert.equal(tickets().length, 1, "the job was launched");
  assert.ok(!fs.existsSync(path.join(JOBS, "nometa", "meta.json")));
  const errLog = fs.readFileSync(path.join(JOBS, "nometa", "err.log"), "utf8");
  assert.match(errLog, /meta[.]json could not be written: disk on fire; the job IS running as pid/);
});

test("meta.json: a rename-only failure falls back to a direct write, leaving a readable meta.json and no warning", async () => {
  const noRename = { ...fs, renameSync() { throw eio("rename failed"); } };
  const r = await startWith("renamefail", noRename);
  assert.equal(r.status, "running");
  assert.equal(r.warnings, undefined);
  const dir = path.join(JOBS, "renamefail");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  assert.equal(meta.jobId, "renamefail");
  assert.equal(meta.pid, process.pid);
  assert.deepEqual(leftovers(dir), [], "the failed atomic attempt cleaned up its temp file");
  assert.equal(core.checkJob("renamefail", 0).jobId, "renamefail", "claude_check finds it");
});

test("meta.json: an unwritable err.log on top of both failures still does not throw", async () => {
  const dead = { ...fs,
    writeFileSync() { throw eio("nope"); },
    appendFileSync() { throw eio("no log either"); } };
  const r = await startWith("nolog", dead);
  assert.equal(r.status, "running");
  assert.match(r.warnings[0], /meta[.]json could not be written: nope/);
});

test("meta.json: a healthy write is unchanged (no warnings key, meta matches the response)", async () => {
  const r = await startWith("healthy", undefined);
  assert.equal(r.warnings, undefined);
  const meta = JSON.parse(fs.readFileSync(path.join(JOBS, "healthy", "meta.json"), "utf8"));
  assert.equal(meta.jobId, "healthy");
  assert.equal(meta.launchPath, "test");
});

// ---------------------------------------------------------------------------------------------
// Launch ticket write failure -> breakaway fallback (never schtasks: every task step is stubbed)
// ---------------------------------------------------------------------------------------------

function taskSeams(over = {}) {
  const calls = [];
  return { calls, mode: "auto",
    ensureTask: () => ({ ok: true }),
    writeTicket: () => { calls.push("ticket"); },
    runTask: () => { calls.push("run"); return { status: 0, stdout: "", stderr: "" }; },
    breakaway: async () => { calls.push("breakaway"); return { pid: 4242, pidSource: "runner" }; },
    ...over };
}
const jobP = (id) => { const d = path.join(JOBS, id); fs.mkdirSync(d); return { d, err: path.join(d, "err.log") }; };

test("a throwing launch-ticket write returns null from launchWin32Task, logs the error and never runs the task", async () => {
  const p = jobP("tkt-null");
  const s = taskSeams({ writeTicket: () => { throw eio("ticket disk full"); } });
  assert.equal(await core.launchWin32Task(p, {}, s), null);
  assert.ok(!s.calls.includes("run"), "schtasks /Run is not attempted without a ticket");
  assert.match(fs.readFileSync(p.err, "utf8"), /launch ticket could not be written: ticket disk full/);
});

test("launchWin32 takes the breakaway fallback when the ticket write throws (no exception escapes)", async () => {
  const p = jobP("tkt-fallback");
  const s = taskSeams({ writeTicket: () => { throw eio("ticket disk full"); } });
  const r = await core.launchWin32(p, {}, s);
  assert.deepEqual(s.calls, ["breakaway"]);
  assert.equal(r.pid, 4242);
  assert.equal(r.launchPath, "breakaway-fallback");
  const errLog = fs.readFileSync(p.err, "utf8");
  assert.match(errLog, /launch ticket could not be written: ticket disk full/);
  assert.match(errLog, /falling back to win32-breakaway[.]ps1/);
});

test("control: with a working ticket write the task path proceeds to /Run (ticket first), not to the fallback", async () => {
  const p = jobP("tkt-ok");
  const s = taskSeams({ runTask: () => { s.calls.push("run"); return { status: 1, stdout: "", stderr: "denied" }; } });
  assert.equal(await core.launchWin32Task(p, {}, s), null, "a failed /Run also returns null (existing behavior)");
  assert.deepEqual(s.calls, ["ticket", "run"]);
  assert.match(fs.readFileSync(p.err, "utf8"), /schtasks [/]Run .* failed [(]status=1[)]/);
  assert.ok(!/launch ticket could not be written/.test(fs.readFileSync(p.err, "utf8")));
});

test("startJob end to end: a ticket failure inside the real launchWin32 still yields a running job with meta.json", async () => {
  const s = taskSeams({ writeTicket: () => { throw eio("ticket disk full"); } });
  const r = await core.startJob({ prompt: "p", jobId: "tkt-e2e" },
    { caps: BIG_CAPS, launch: (p, cmd, argv, cwd, extraEnv) => core.launchWin32(p, extraEnv, s) });
  assert.equal(r.error, undefined);
  assert.equal(r.status, "running");
  assert.equal(r.launchPath, "breakaway-fallback");
  assert.equal(r.pid, 4242);
  assert.equal(JSON.parse(fs.readFileSync(path.join(JOBS, "tkt-e2e", "meta.json"), "utf8")).pid, 4242);
});
