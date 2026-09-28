// Nothing after a successful launch may throw: startJob's meta.json write falls back to a direct
// write, then to a warning in the response (the runner is already up and a card is minted, so a
// throw would orphan a running job). A failed launch-ticket write falls back to the breakaway path.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { core, fakeLaunch, tickets, resetState, BIG_CAPS, cleanupTmp, JOBS, QUEUE } from "./_setup.mjs";
import { claimOneTicket } from "../../launcher-claim.mjs";
import { boundIntent } from "../../card-hook.mjs";

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

// intent: an additive meta.json field, bounded the same way card-hook.mjs's boundIntent() bounds
// the card body, so discord-notify.mjs (via job-runner.mjs, which only ever reads meta.json) can
// use the same title the dispatch card shows. Omitted entirely (no key) rather than null/empty
// when claude_start was not given one.
test("meta.json: intent is persisted verbatim when supplied", async () => {
  const r = await core.startJob({ prompt: "p", jobId: "with-intent", intent: "Fix the flaky test" },
    { launch: fakeLaunch, caps: BIG_CAPS });
  assert.equal(r.error, undefined);
  const meta = JSON.parse(fs.readFileSync(path.join(JOBS, "with-intent", "meta.json"), "utf8"));
  assert.equal(meta.intent, "Fix the flaky test");
});

test("meta.json: no intent key at all when none was supplied", async () => {
  const r = await startWith("no-intent-meta", undefined);
  assert.equal(r.error, undefined);
  const meta = JSON.parse(fs.readFileSync(path.join(JOBS, "no-intent-meta", "meta.json"), "utf8"));
  assert.equal("intent" in meta, false);
});

test("meta.json: an over-long intent is bounded the same way boundIntent bounds the card body", async () => {
  const long = "word ".repeat(100).trim(); // far past card_hook's INTENT_SUMMARY_MAX (200 chars)
  const r = await core.startJob({ prompt: "p", jobId: "long-intent", intent: long },
    { launch: fakeLaunch, caps: BIG_CAPS });
  assert.equal(r.error, undefined);
  const meta = JSON.parse(fs.readFileSync(path.join(JOBS, "long-intent", "meta.json"), "utf8"));
  assert.equal(meta.intent, boundIntent(long));
  assert.ok(meta.intent.length <= 200, `expected a bounded intent, got ${meta.intent.length} chars`);
});

// ---------------------------------------------------------------------------------------------
// Launch ticket write failure -> breakaway fallback (never schtasks: every task step is stubbed)
// ---------------------------------------------------------------------------------------------

function taskSeams(over = {}) {
  const calls = [];
  return { calls, mode: "auto",
    ensureTask: () => ({ ok: true }),
    writeTicket: () => { calls.push("ticket"); }, // stub: writes nothing; fbSeams() below writes the real ticket
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
  // real ticket: a stub that wrote nothing would look like "a launcher already took it" to the bridge
  const s = fbSeams({ runTask: () => { s.calls.push("run"); return { status: 1, stdout: "", stderr: "denied" }; } });
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

// ---------------------------------------------------------------------------------------------
// The breakaway fallback vs the still-pending ticket: the ticket must leave the queue (under the
// launchers' claim lock) BEFORE the fallback starts the job, or a launcher that runs later starts it
// a second time. If a launcher already owns the ticket, the bridge must not launch a second way.
// ---------------------------------------------------------------------------------------------

// Real ticket into the temp queue (never schtasks); short poll windows so "no runner ever" is quick.
function fbSeams(over = {}) {
  const s = taskSeams({ pollMs: 80, extraPollMs: 80, ...over });
  s.writeTicket = (p, env) => { s.calls.push("ticket"); core.writeLaunchTicket(p, env); };
  return s;
}
const queueFiles = () => fs.readdirSync(QUEUE).sort();
const errLog = (p) => fs.readFileSync(p.err, "utf8");
const writeRunnerPid = (p, pid) => fs.writeFileSync(path.join(p.d, "runner.pid"), String(pid));

test("fallback fires with the ticket still pending: the ticket is removed first, the job is launched exactly once, and no launcher can claim it later", async () => {
  const p = jobP("fb-pending");
  const s = fbSeams({
    runTask: () => { s.calls.push("run"); assert.deepEqual(queueFiles(), ["fb-pending.json"], "the ticket is pending when the task is poked"); return { status: 0, stdout: "", stderr: "" }; },
    breakaway: async () => { s.calls.push("breakaway"); assert.deepEqual(queueFiles(), [], "ticket already gone when the fallback starts the job"); return { pid: 4242, pidSource: "runner" }; },
  });
  const r = await core.launchWin32(p, {}, s);
  assert.deepEqual(s.calls, ["ticket", "run", "breakaway"]);
  assert.equal(s.calls.filter((c) => c === "breakaway").length, 1, "exactly one launch");
  assert.equal(r.launchPath, "breakaway-fallback");
  assert.deepEqual(queueFiles(), [], "no ticket, lock or claimed file left");
  assert.equal(claimOneTicket({ queueDir: QUEUE }), null, "a launcher that starts now finds nothing to run a second time");
  assert.match(errLog(p), /removed the still-pending launch ticket before falling back/);
});

test("fallback after a failed schtasks /Run also removes the ticket first (any later launcher would otherwise run it)", async () => {
  const p = jobP("fb-runfail");
  const s = fbSeams({ runTask: () => { s.calls.push("run"); return { status: 1, stdout: "", stderr: "denied" }; } });
  const r = await core.launchWin32(p, {}, s);
  assert.deepEqual(s.calls, ["ticket", "run", "breakaway"]);
  assert.equal(r.launchPath, "breakaway-fallback");
  assert.deepEqual(queueFiles(), []);
});

test("a launcher claims the ticket first: the fallback does NOT launch; a runner that shows up during the extra wait is reported as launchPath \"task\"", async () => {
  const p = jobP("fb-claimed");
  const s = fbSeams({ pollMs: 60, extraPollMs: 1500,
    runTask: () => { // a launcher claims it right away, then its runner is slow to write runner.pid
      s.calls.push("run");
      assert.equal(path.basename(claimOneTicket({ queueDir: QUEUE }).claimedPath), "fb-claimed.claimed.json");
      setTimeout(() => writeRunnerPid(p, process.pid), 200);
      return { status: 0, stdout: "", stderr: "" };
    } });
  const r = await core.launchWin32(p, {}, s);
  assert.ok(!s.calls.includes("breakaway"), "must not launch a second way");
  assert.equal(r.launchPath, "task");
  assert.equal(r.pid, process.pid);
  assert.deepEqual(queueFiles(), ["fb-claimed.claimed.json"], "the launcher's claimed ticket is untouched");
  assert.match(errLog(p), /launch ticket not withdrawn \(claimed\)/);
});

test("a launcher holds the ticket's lock (mid-claim): the bridge leaves the ticket alone and does not launch a second way", async () => {
  const p = jobP("fb-held");
  const s = fbSeams({ runTask: () => {
    s.calls.push("run");
    fs.writeFileSync(path.join(QUEUE, "fb-held.lock"), JSON.stringify({ pid: 4242, at: new Date().toISOString() }));
    return { status: 0, stdout: "", stderr: "" };
  } });
  const r = await core.launchWin32(p, {}, s);
  assert.ok(!s.calls.includes("breakaway"));
  assert.equal(r.launchPath, "task");
  assert.equal(r.pid, null);
  assert.equal(r.pidSource, "task-claimed-no-runner");
  assert.deepEqual(queueFiles(), ["fb-held.json", "fb-held.lock"], "neither the ticket nor the launcher's lock was touched");
  assert.match(errLog(p), /launch ticket not withdrawn \(held\)/);
});

test("a launcher claimed the ticket but no runner ever appears: no second launch, pid null, and err.log says what to do", async () => {
  const p = jobP("fb-nevermind");
  const s = fbSeams({ runTask: () => { s.calls.push("run"); claimOneTicket({ queueDir: QUEUE }); return { status: 0, stdout: "", stderr: "" }; } });
  const r = await core.launchWin32(p, {}, s);
  assert.deepEqual(s.calls, ["ticket", "run"]);
  assert.equal(r.pid, null);
  assert.equal(r.pidSource, "task-claimed-no-runner");
  assert.match(errLog(p), /never started it .* retry claude_start with the same jobId/);
});

test("control: when the runner appears within the normal wait the ticket is never withdrawn and no fallback runs", async () => {
  const p = jobP("fb-normal");
  const s = fbSeams({ pollMs: 1500, runTask: () => {
    s.calls.push("run");
    claimOneTicket({ queueDir: QUEUE });
    setTimeout(() => writeRunnerPid(p, process.pid), 100);
    return { status: 0, stdout: "", stderr: "" };
  } });
  const r = await core.launchWin32(p, {}, s);
  assert.deepEqual(s.calls, ["ticket", "run"]);
  assert.equal(r.launchPath, "task");
  assert.equal(r.pid, process.pid);
  assert.ok(!/withdrawn|removed the still-pending/.test(errLog(p)));
});
