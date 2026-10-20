// Unit tests for job-core.mjs's job-tool-gate WIRING (not the hook script itself -- see
// test/job-tool-gate-hook.test.mjs for that): proves startJob() only adds the second PreToolUse
// hook command (and only sets the CLAUDE_ASYNC_GATE_* env vars) when the flag is actually on, and
// that a disabled gate leaves the launched argv/env byte-identical to today's behavior. Uses the
// opts.launch test seam (job-core.mjs's own documented seam -- "tests never touch schtasks or
// spawn a runner") to capture the real argv/extraEnv startJob() builds, without ever spawning a
// real claude process.
//
// CLAUDE_ASYNC_JOB_DIR is pointed at a fresh temp dir before importing job-core.mjs, since
// JOB_ROOT is computed once at module load from that env var -- this keeps the test from writing
// into ~/.claude-async-jobs.
// Run: node --test test/job-tool-gate-wiring.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpJobRoot = path.join(os.tmpdir(), `claude-async-jobtoolgate-test-${crypto.randomBytes(4).toString("hex")}`);
fs.mkdirSync(tmpJobRoot, { recursive: true });
process.env.CLAUDE_ASYNC_JOB_DIR = tmpJobRoot;
delete process.env.CLAUDE_ASYNC_JOB_TOOL_GATE; // pin the env-var default to off for these tests

const { startJob } = await import("../job-core.mjs");

const WORK_FOLDER = os.tmpdir();

function fakeLaunch(capture) {
  return async (_p, _claudeBin, argv, cwd, extraEnv) => {
    capture.push({ argv, cwd, extraEnv });
    return { pid: 1, pidSource: "test", jobMembership: null, launchPath: "test" };
  };
}

function settingsFromArgv(argv) {
  const i = argv.indexOf("--settings");
  assert.ok(i !== -1, `--settings not found in argv: ${JSON.stringify(argv)}`);
  return JSON.parse(argv[i + 1]);
}

test("toolGate omitted (default off): no second hook, no gate env vars", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `wiring-off-${crypto.randomBytes(3).toString("hex")}` },
    { claudeBin: process.execPath, launch: fakeLaunch(capture) },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(capture.length, 1);
  const settings = settingsFromArgv(capture[0].argv);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1, "only the no-background-hook should be wired");
  assert.ok(!("CLAUDE_ASYNC_GATE_REPO" in capture[0].extraEnv));
});

test("toolGate: true adds the second hook and forwards CLAUDE_ASYNC_GATE_REPO", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `wiring-on-${crypto.randomBytes(3).toString("hex")}` },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), toolGate: true, gateRepo: "D:\\fake\\claunker-hermes" },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 2, "both hooks should be wired");
  assert.match(settings.hooks.PreToolUse[0].hooks[1].command, /job-tool-gate-hook\.mjs/);
  assert.equal(capture[0].extraEnv.CLAUDE_ASYNC_GATE_REPO, "D:\\fake\\claunker-hermes");
});

test("toolGate: true with no gateRepo available still wires the hook (fail-closed, not silently skipped)", async () => {
  const capture = [];
  const savedEnv = process.env.CLAUDE_ASYNC_GATE_REPO;
  delete process.env.CLAUDE_ASYNC_GATE_REPO;
  try {
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: `wiring-on-norepo-${crypto.randomBytes(3).toString("hex")}` },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), toolGate: true },
    );
    assert.ok(!res.error, JSON.stringify(res));
    const settings = settingsFromArgv(capture[0].argv);
    assert.equal(settings.hooks.PreToolUse[0].hooks.length, 2);
    assert.ok(!("CLAUDE_ASYNC_GATE_REPO" in capture[0].extraEnv));
  } finally {
    if (savedEnv !== undefined) process.env.CLAUDE_ASYNC_GATE_REPO = savedEnv;
  }
});

test("toolGate: false explicitly behaves the same as omitted", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `wiring-false-${crypto.randomBytes(3).toString("hex")}` },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), toolGate: false },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
});
