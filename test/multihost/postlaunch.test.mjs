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
