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
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
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
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, toolGate: true, gateRepo: "D:\\fake\\claunker-hermes" },
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
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, toolGate: true },
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
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, toolGate: false },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
});

// --- Permission-mode flag: independent of toolGate, default off ---

test("safePermissions omitted (default off): keeps --dangerously-skip-permissions, no permissions block", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `perm-off-${crypto.randomBytes(3).toString("hex")}` },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.ok(capture[0].argv.includes("--dangerously-skip-permissions"));
  assert.ok(!capture[0].argv.includes("--permission-mode"));
  const settings = settingsFromArgv(capture[0].argv);
  assert.ok(!("permissions" in settings));
});

test("safePermissions: true switches to --permission-mode dontAsk with an allow/deny list", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `perm-on-${crypto.randomBytes(3).toString("hex")}` },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.ok(!capture[0].argv.includes("--dangerously-skip-permissions"));
  const i = capture[0].argv.indexOf("--permission-mode");
  assert.ok(i !== -1);
  assert.equal(capture[0].argv[i + 1], "dontAsk");
  const settings = settingsFromArgv(capture[0].argv);
  assert.ok(Array.isArray(settings.permissions.allow) && settings.permissions.allow.length > 0);
  assert.ok(settings.permissions.deny.includes("Bash(git push *)"));
  assert.ok(settings.permissions.allow.includes("Bash(mkdir *)"),
    "mkdir must be allowed -- a false-deny found in the rehearsal blocked routine scaffolding");
  // Bash and PowerShell must carry the same dev-tool allow/deny set (rehearsal: PowerShell-only
  // `uv run pytest` was denied while the identical Bash invocation was allowed).
  for (const prefix of ["git status*", "git add *", "git commit *", "git checkout *",
    "git worktree *", "pytest *", "uv *", "npm *", "node *", "python *", "mkdir *"]) {
    assert.ok(settings.permissions.allow.includes(`PowerShell(${prefix})`),
      `PowerShell(${prefix}) must be allowed to match its Bash equivalent`);
  }
  for (const prefix of ["git push *", "git merge *", "git rebase *", "git reset --hard *", "git clean -f*"]) {
    assert.ok(settings.permissions.deny.includes(`PowerShell(${prefix})`),
      `PowerShell(${prefix}) must be denied to match its Bash equivalent`);
  }
  // 2026-10-21 safe-permissions rehearsal (D:\code\reviews\safe-permissions-rehearsal-20261021.md):
  // the live chassis (D:\claunker\**) must stay out of reach of every mutating tool this allow
  // list grants, not just the control-plane files already covered above.
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.ok(settings.permissions.deny.includes(`${tool}(//**/claunker/**)`),
      `${tool} must deny //**/claunker/** (live chassis)`);
  }
});

test("safePermissions and toolGate are independent: either can be on without the other", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `perm-only-${crypto.randomBytes(3).toString("hex")}` },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true, toolGate: false },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.ok("permissions" in settings, "permission-mode change applied");
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1, "gate hook stayed off");
});
