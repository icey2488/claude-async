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
  // Inertness (2026-10-21 safe-perms-finish task 4): ollama-guard-hook must stay off too when
  // safePermissions is unset -- only the always-on no-background-hook is wired.
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
  assert.ok(!/ollama-guard-hook\.mjs/.test(settings.hooks.PreToolUse[0].hooks[0].command));
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
  // "git status" (bare command) and "git status *" (with args) are both listed separately
  // (safe-mode-profiles 2026-11-12 word-boundary fix): a single no-space "git status*" prefix is
  // boundary-unsafe (it would also match an unrelated command sharing the same text prefix), but
  // simply adding the space would stop matching the extremely common bare `git status` invocation
  // -- see job-core.mjs's buildSafePermissionsSettings() comment for the full reasoning.
  for (const prefix of ["git status", "git status *", "git add *", "git commit *", "git checkout *",
    "git worktree *", "pytest *", "uv *", "npm *", "node *", "python *", "mkdir *"]) {
    assert.ok(settings.permissions.allow.includes(`PowerShell(${prefix})`),
      `PowerShell(${prefix}) must be allowed to match its Bash equivalent`);
  }
  for (const prefix of ["git push *", "git merge *", "git rebase *", "git reset --hard *", "git clean -f*"]) {
    assert.ok(settings.permissions.deny.includes(`PowerShell(${prefix})`),
      `PowerShell(${prefix}) must be denied to match its Bash equivalent`);
  }
  // Task 3 (2026-10-21 safe-perms-finish): destructive git forms denied even though their
  // non-destructive siblings (`git branch <name>`, `git checkout <branch>`, `git checkout -b`,
  // `git switch <branch>`) are allowed above.
  assert.ok(settings.permissions.allow.includes("Bash(git switch *)"));
  assert.ok(settings.permissions.allow.includes("PowerShell(git switch *)"));
  for (const prefix of ["git branch -D*", "git branch --delete --force*", "git branch --force --delete*",
    "git checkout -- *", "git checkout .*", "git checkout -f*",
    "git switch -f*", "git switch --force*", "git switch --discard-changes*"]) {
    assert.ok(settings.permissions.deny.includes(`Bash(${prefix})`), `Bash(${prefix}) must be denied`);
    assert.ok(settings.permissions.deny.includes(`PowerShell(${prefix})`), `PowerShell(${prefix}) must be denied`);
  }
  assert.ok(!settings.permissions.allow.includes("Bash(git restore *)"),
    "git restore was never allow-listed and must stay that way (no --staged carve-out expressible by prefix matching)");
  // 2026-10-21 safe-permissions rehearsal (D:\code\reviews\safe-permissions-rehearsal-20261021.md),
  // tightened 2026-10-21 safe-perms-finish: the live chassis (D:\claunker\**) must stay out of
  // reach of every file-editing tool this allow list grants. A single Edit(path) deny rule is
  // what claude.exe 2.1.303 actually applies to Edit/Write/MultiEdit/NotebookEdit alike --
  // path-scoped Write(path)/MultiEdit(path)/NotebookEdit(path) rules are silently ignored by the
  // real CLI (confirmed live; see job-core.mjs's comment), so asserting those three NOT be present
  // guards against reintroducing dead-weight rules that look like coverage but aren't.
  assert.ok(settings.permissions.deny.includes("Edit(//**/claunker/**)"),
    "Edit must deny //**/claunker/** (live chassis)");
  for (const tool of ["Write", "MultiEdit", "NotebookEdit"]) {
    assert.ok(!settings.permissions.deny.includes(`${tool}(//**/claunker/**)`),
      `${tool}(//**/claunker/**) is a no-op on real claude.exe and must not be relied on`);
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
  // safePermissions also wires the ollama-guard-hook (see job-core.mjs's OLLAMA_GUARD_HOOK_SCRIPT
  // comment and hooks/ollama-guard-hook.mjs), so the count is 2 here, not 1 -- but the job-tool-
  // gate-hook itself (toolGate: false) must still be absent.
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 2, "ollama-guard-hook on, job-tool-gate-hook stayed off");
  assert.ok(settings.hooks.PreToolUse[0].hooks.every((h) => !/job-tool-gate-hook\.mjs/.test(h.command)),
    "job-tool-gate-hook must not be wired when toolGate is false");
  assert.ok(settings.hooks.PreToolUse[0].hooks.some((h) => /ollama-guard-hook\.mjs/.test(h.command)),
    "ollama-guard-hook must be wired when safePermissions is true");
});

test("safePermissions and toolGate both true: all three hooks wired", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: `perm-and-gate-${crypto.randomBytes(3).toString("hex")}` },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true, toolGate: true, gateRepo: "D:\\fake\\claunker-hermes" },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 3);
  const commands = settings.hooks.PreToolUse[0].hooks.map((h) => h.command);
  assert.ok(commands.some((c) => /no-background-hook\.mjs/.test(c)));
  assert.ok(commands.some((c) => /ollama-guard-hook\.mjs/.test(c)));
  assert.ok(commands.some((c) => /job-tool-gate-hook\.mjs/.test(c)));
});
