// test/append-system-prompt-file-support.test.mjs -- readonly's startup check (2026-11-14
// safe-mode-gaps follow-up) that the installed Claude Code CLI actually accepts the undocumented
// --append-system-prompt-file flag readonly depends on to ship CLAUDE.md memory (see
// job-core.mjs's checkAppendSystemPromptFileSupport header). Without this, a CLI that silently
// ignores an unrecognized flag would launch a readonly job fine and just drop CLAUDE.md with no
// visible error.
//
// probeAppendSystemPromptFileSupport's exit-code/output logic is exercised directly against
// controlled stand-in .cmd binaries (never the real `claude`, never process.execPath's own
// incidental "bad option" behavior) so the test does not depend on what any particular installed
// CLI happens to do. checkAppendSystemPromptFileSupport/startJob's wiring is exercised through the
// opts.checkAppendSystemPromptFileSupport seam, which bypasses isTestMode()'s own "assume
// supported" shortcut (that shortcut exists so unrelated tests' stand-in claudeBin, e.g.
// process.execPath, never fails a check they are not testing -- see its header).
// Run: node --test test/append-system-prompt-file-support.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpJobRoot = path.join(os.tmpdir(), `claude-async-append-flag-test-${crypto.randomBytes(4).toString("hex")}`);
fs.mkdirSync(tmpJobRoot, { recursive: true });
process.env.CLAUDE_ASYNC_JOB_DIR = tmpJobRoot;

const { startJob, checkAppendSystemPromptFileSupport, probeAppendSystemPromptFileSupport } = await import("../job-core.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "append-flag-stubs-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

function writeStubCmd(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body);
  return p;
}

const SUPPORTED_STUB = writeStubCmd("supported.cmd",
  "@echo off\r\necho Usage: claude [options] [command] [prompt]\r\nexit /b 0\r\n");
const UNSUPPORTED_STUB = writeStubCmd("unsupported.cmd",
  "@echo off\r\necho bad option: --append-system-prompt-file 1>&2\r\nexit /b 9\r\n");

const WORK_FOLDER = os.tmpdir();
function fakeLaunch(capture) {
  return async (_p, _claudeBin, argv, cwd, extraEnv) => {
    capture.push({ argv, cwd, extraEnv });
    return { pid: 1, pidSource: "test", jobMembership: null, launchPath: "test" };
  };
}

// ----------------------------------------------------------- probeAppendSystemPromptFileSupport

test("probeAppendSystemPromptFileSupport: true when the probe exits 0 and prints the help banner", () => {
  assert.equal(probeAppendSystemPromptFileSupport(SUPPORTED_STUB), true);
});

test("probeAppendSystemPromptFileSupport: false on a nonzero exit with no banner (unrecognized flag)", () => {
  assert.equal(probeAppendSystemPromptFileSupport(UNSUPPORTED_STUB), false);
});

test("probeAppendSystemPromptFileSupport: false on a nonexistent binary (spawn ENOENT), never throws", () => {
  assert.equal(probeAppendSystemPromptFileSupport(path.join(TMP, "does-not-exist.exe")), false);
});

// ------------------------------------------------------------ checkAppendSystemPromptFileSupport

test("checkAppendSystemPromptFileSupport: always true under the test runner, regardless of claudeBin", () => {
  assert.equal(checkAppendSystemPromptFileSupport(UNSUPPORTED_STUB), true);
  assert.equal(checkAppendSystemPromptFileSupport("does-not-exist-at-all"), true);
});

// --------------------------------------------------------------------------- startJob() wiring

test("startJob: readonly is refused with a clear error when the opts seam reports the flag unsupported", async () => {
  const capture = [];
  const jobId = `append-flag-blocked-${crypto.randomBytes(3).toString("hex")}`;
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId, profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), safePermissions: true,
      caps: { maxStartsPerMinute: 1000 }, checkAppendSystemPromptFileSupport: () => false },
  );
  assert.ok(res.error, "readonly must be refused, not silently launched");
  assert.match(res.error, /append-system-prompt-file/);
  assert.equal(capture.length, 0, "no launch must have happened");
  assert.ok(!fs.existsSync(path.join(tmpJobRoot, jobId)), "no job directory must have been reserved");
});

test("startJob: readonly proceeds normally when the opts seam reports the flag supported", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `append-flag-ok-${crypto.randomBytes(3).toString("hex")}`, profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), safePermissions: true,
      caps: { maxStartsPerMinute: 1000 }, checkAppendSystemPromptFileSupport: () => true },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(capture.length, 1);
});

test("startJob: readonly proceeds normally with no seam at all (isTestMode() default applies)", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `append-flag-default-${crypto.randomBytes(3).toString("hex")}`, profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), safePermissions: true, caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(capture.length, 1);
});
