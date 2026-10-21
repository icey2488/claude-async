// Unit tests for job-core.mjs's per-job HERMES_HOME isolation (design: D:\code\reviews\
// ledger-timeout-hermeshome-provlog-20261020.md). claunker-hermes's seat_common.provenance
// resolves its log path off HERMES_HOME with no override parameter; this workstation's bridge
// process inherits HERMES_HOME pointed at the live chassis, so without this feature a job that
// imports judge_seat/arbiter_seat outside pytest would write straight into the live
// judge_provenance.jsonl. Jobs are never allowed to modify the live chassis.
//
// Same opts.launch test seam as test/job-tool-gate-wiring.test.mjs: captures the real
// argv/extraEnv startJob() builds without ever spawning a real claude process.
//
// Run: node --test test/job-hermes-home-isolation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpJobRoot = path.join(os.tmpdir(), `claude-async-hermeshome-test-${crypto.randomBytes(4).toString("hex")}`);
fs.mkdirSync(tmpJobRoot, { recursive: true });
process.env.CLAUDE_ASYNC_JOB_DIR = tmpJobRoot;
delete process.env.CLAUDE_ASYNC_JOB_HERMES_HOME_ISOLATION; // pin the env-var default to ON for these tests

const { startJob } = await import("../job-core.mjs");

const WORK_FOLDER = os.tmpdir();
const FAKE_LIVE_HERMES_HOME = "D:\\claunker\\hermes-test-fixture";

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

function readMeta(jobId) {
  return JSON.parse(fs.readFileSync(path.join(tmpJobRoot, jobId, "meta.json"), "utf8"));
}

// withAmbientHermesHome runs `fn` with process.env.HERMES_HOME temporarily set (or deleted),
// restoring whatever was there before regardless of outcome -- every test must leave the real
// ambient value (this workstation's live chassis) exactly as it found it.
async function withAmbientHermesHome(value, fn) {
  const saved = process.env.HERMES_HOME;
  if (value === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = saved;
  }
}

test("isolation default ON: HERMES_HOME is redirected to a per-job tmp dir that exists on disk", async () => {
  await withAmbientHermesHome(FAKE_LIVE_HERMES_HOME, async () => {
    const capture = [];
    const jobId = `hermeshome-default-${crypto.randomBytes(3).toString("hex")}`;
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
    );
    assert.ok(!res.error, JSON.stringify(res));
    const jobHermesHome = capture[0].extraEnv.HERMES_HOME;
    assert.ok(jobHermesHome, "HERMES_HOME must be set in the launched job's env");
    assert.notEqual(jobHermesHome, FAKE_LIVE_HERMES_HOME, "must not be the live/ambient value");
    assert.ok(jobHermesHome.startsWith(path.join(tmpJobRoot, jobId)), "must live inside this job's own dir");
    assert.ok(fs.statSync(jobHermesHome).isDirectory(), "the per-job HERMES_HOME dir must actually exist");
  });
});

test("live value is preserved in CLAUNKER_LIVE_HERMES_HOME", async () => {
  await withAmbientHermesHome(FAKE_LIVE_HERMES_HOME, async () => {
    const capture = [];
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: `hermeshome-live-${crypto.randomBytes(3).toString("hex")}` },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
    );
    assert.ok(!res.error, JSON.stringify(res));
    assert.equal(capture[0].extraEnv.CLAUNKER_LIVE_HERMES_HOME, FAKE_LIVE_HERMES_HOME);
  });
});

test("no ambient HERMES_HOME: isolation still redirects HERMES_HOME, but CLAUNKER_LIVE_HERMES_HOME is not set", async () => {
  await withAmbientHermesHome(undefined, async () => {
    const capture = [];
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: `hermeshome-noambient-${crypto.randomBytes(3).toString("hex")}` },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
    );
    assert.ok(!res.error, JSON.stringify(res));
    assert.ok(capture[0].extraEnv.HERMES_HOME, "isolation must still apply even with no live value to preserve");
    assert.ok(!("CLAUNKER_LIVE_HERMES_HOME" in capture[0].extraEnv));
  });
});

test("opt-out via opts.hermesHomeIsolation=false leaves HERMES_HOME untouched", async () => {
  await withAmbientHermesHome(FAKE_LIVE_HERMES_HOME, async () => {
    const capture = [];
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: `hermeshome-optout-opt-${crypto.randomBytes(3).toString("hex")}` },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, hermesHomeIsolation: false },
    );
    assert.ok(!res.error, JSON.stringify(res));
    assert.ok(!("HERMES_HOME" in capture[0].extraEnv), "opt-out must not override HERMES_HOME at all");
    // The live value is still forwarded for consistency, even though it's redundant here.
    assert.equal(capture[0].extraEnv.CLAUNKER_LIVE_HERMES_HOME, FAKE_LIVE_HERMES_HOME);
  });
});

// NOTE: CLAUDE_ASYNC_JOB_HERMES_HOME_ISOLATION's env-var default (like JOB_TOOL_GATE_ENV_DEFAULT
// and SAFE_PERMISSIONS_ENV_DEFAULT before it) is read once at module load, not per-call -- a real
// bridge process sets it once at startup, never mutates it at runtime. Mutating the env var after
// import (as this test file already has) cannot exercise that path in-process; the opts-based
// override above (opts.hermesHomeIsolation) exercises the identical code branch inside startJob(),
// same as job-tool-gate-wiring.test.mjs never attempts to flip JOB_TOOL_GATE_ENV_DEFAULT at
// runtime either.

test("meta.json records the chosen HERMES_HOME path when isolation applied, omits it on opt-out", async () => {
  await withAmbientHermesHome(FAKE_LIVE_HERMES_HOME, async () => {
    const capture1 = [];
    const jobId1 = `hermeshome-meta-on-${crypto.randomBytes(3).toString("hex")}`;
    const res1 = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: jobId1 },
      { claudeBin: process.execPath, launch: fakeLaunch(capture1), caps: { maxStartsPerMinute: 1000 } },
    );
    assert.ok(!res1.error, JSON.stringify(res1));
    const meta1 = readMeta(jobId1);
    assert.equal(meta1.hermesHome, capture1[0].extraEnv.HERMES_HOME);

    const capture2 = [];
    const jobId2 = `hermeshome-meta-off-${crypto.randomBytes(3).toString("hex")}`;
    const res2 = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: jobId2 },
      { claudeBin: process.execPath, launch: fakeLaunch(capture2), caps: { maxStartsPerMinute: 1000 }, hermesHomeIsolation: false },
    );
    assert.ok(!res2.error, JSON.stringify(res2));
    const meta2 = readMeta(jobId2);
    assert.ok(!("hermesHome" in meta2));
  });
});

test("gate hook (toolGate on) gets the live HERMES_HOME value in its own command, not the job's tmp one", async () => {
  await withAmbientHermesHome(FAKE_LIVE_HERMES_HOME, async () => {
    const capture = [];
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: `hermeshome-gate-on-${crypto.randomBytes(3).toString("hex")}` },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, toolGate: true },
    );
    assert.ok(!res.error, JSON.stringify(res));
    const settings = settingsFromArgv(capture[0].argv);
    const gateHookCommand = settings.hooks.PreToolUse[0].hooks[1].command;
    assert.match(gateHookCommand, /job-tool-gate-hook\.mjs/);
    assert.match(gateHookCommand, new RegExp(`set "HERMES_HOME=${FAKE_LIVE_HERMES_HOME.replace(/\\/g, "\\\\")}"`));
    // The job's OWN launched process still gets the isolated tmp value, not the live one.
    assert.notEqual(capture[0].extraEnv.HERMES_HOME, FAKE_LIVE_HERMES_HOME);
  });
});

test("gate hook (toolGate on) with no live value: hook command has no HERMES_HOME override at all", async () => {
  await withAmbientHermesHome(undefined, async () => {
    const capture = [];
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: `hermeshome-gate-noambient-${crypto.randomBytes(3).toString("hex")}` },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, toolGate: true },
    );
    assert.ok(!res.error, JSON.stringify(res));
    const settings = settingsFromArgv(capture[0].argv);
    const gateHookCommand = settings.hooks.PreToolUse[0].hooks[1].command;
    assert.doesNotMatch(gateHookCommand, /HERMES_HOME/);
  });
});
