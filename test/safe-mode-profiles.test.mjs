// Unit tests for safe-mode-profiles (job-core.mjs's buildSafePermissionsSettings(profile) /
// buildDenialGuidanceText(profile), guard.mjs's PROFILES/checkProfile, and startJob()'s profile
// wiring). See RUNBOOK.md's safe-mode-profiles section for the design.
//
// Uses the same opts.launch test seam as test/job-tool-gate-wiring.test.mjs: captures the real
// argv/extraEnv startJob() builds, without ever spawning a real claude process.
// Run: node --test test/safe-mode-profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpJobRoot = path.join(os.tmpdir(), `claude-async-profiles-test-${crypto.randomBytes(4).toString("hex")}`);
fs.mkdirSync(tmpJobRoot, { recursive: true });
process.env.CLAUDE_ASYNC_JOB_DIR = tmpJobRoot;
delete process.env.CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS; // pin the env-var default to off for these tests

const core = await import("../job-core.mjs");
const guard = await import("../guard.mjs");
const { startJob, buildSafePermissionsSettings, buildDenialGuidanceText } = core;
const { PROFILES, DEFAULT_PROFILE, PROFILE_ENV, isProfile, checkProfile } = guard;

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

const jid = (label) => `profiles-${label}-${crypto.randomBytes(3).toString("hex")}`;

// ---------------------------------------------------------------- guard.mjs: PROFILES/checkProfile

test("guard.mjs: PROFILES is exactly readonly/code/ops, DEFAULT_PROFILE is code", () => {
  assert.deepEqual(PROFILES, ["readonly", "code", "ops"]);
  assert.equal(DEFAULT_PROFILE, "code");
});

test("guard.mjs: isProfile rejects anything outside PROFILES", () => {
  for (const p of PROFILES) assert.ok(isProfile(p));
  assert.ok(!isProfile("bogus"));
  assert.ok(!isProfile(undefined));
  assert.ok(!isProfile(42));
});

test("guard.mjs: checkProfile refuses an invalid profile regardless of depth", () => {
  assert.match(checkProfile(0, "bogus"), /invalid profile/);
});

test("guard.mjs: checkProfile at depth 0 (top-level caller) allows any valid profile", () => {
  for (const p of PROFILES) assert.equal(checkProfile(0, p), null);
});

test("guard.mjs: checkProfile refuses a nested job requesting a profile broader than its parent's", () => {
  const err = checkProfile(1, "ops", { [PROFILE_ENV]: "readonly" });
  assert.match(err, /nested job.*may not request profile "ops".*broader.*"readonly"/);
});

test("guard.mjs: checkProfile allows a nested job requesting its parent's own profile or narrower", () => {
  assert.equal(checkProfile(1, "readonly", { [PROFILE_ENV]: "readonly" }), null);
  assert.equal(checkProfile(1, "code", { [PROFILE_ENV]: "ops" }), null);
  assert.equal(checkProfile(1, "ops", { [PROFILE_ENV]: "ops" }), null);
});

test("guard.mjs: checkProfile treats a missing/invalid parent profile as DEFAULT_PROFILE (code)", () => {
  assert.equal(checkProfile(1, "code", {}), null);
  assert.match(checkProfile(1, "ops", {}), /broader than its parent's profile "code"/);
});

// ------------------------------------------------------- job-core.mjs: buildSafePermissionsSettings

function allowSet(profile) { return new Set(buildSafePermissionsSettings(profile).permissions.allow); }

test("readonly: no file-editing tools, no interpreters/code-runners, no mkdir", () => {
  const allow = allowSet("readonly");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(!allow.has(tool), `${tool} must be absent from readonly`);
  // A BARE interpreter prefix (e.g. "node *") must be absent -- but the fixed-path loopback
  // helper call ("node <repo>/tools/http-get-loopback.mjs *") is legitimately present in every
  // profile, so this only rejects the bare, unscoped form, not every rule that happens to start
  // with the binary name.
  for (const shell of ["Bash", "PowerShell"]) {
    for (const bin of ["node", "python", "python3", "py", "npm", "npx", "pnpm", "uv", "pytest", "mkdir"]) {
      assert.ok(!allow.has(`${shell}(${bin} *)`) && !allow.has(`${shell}(${bin})`),
        `bare ${shell}(${bin}...) must be absent from readonly`);
    }
  }
});

test("readonly: git allow rules are read-only subcommands only, no broad git * prefix", () => {
  const allow = [...allowSet("readonly")].filter((r) => r.startsWith("Bash(git ") || r.startsWith("PowerShell(git "));
  const forbidden = /^(Bash|PowerShell)\(git (push|merge|rebase|reset|clean|add |commit |checkout |worktree (add|remove)|switch )/;
  for (const rule of allow) assert.ok(!forbidden.test(rule), `${rule} must not admit a mutating git subcommand in readonly`);
  // No rule is a completely unscoped "git *" that would admit anything.
  for (const rule of allow) assert.ok(rule !== "Bash(git *)" && rule !== "PowerShell(git *)", "no unscoped git * prefix allowed");
});

test("readonly: no allow rule admits an in-place mutator (sed -i, tee, curl -o, Out-File, Set-Content)", () => {
  const allow = allowSet("readonly");
  const mutators = [/^Bash\(sed -i/, /^Bash\(tee /, /-o /, /^PowerShell\(Out-File/, /^PowerShell\(Set-Content/];
  for (const rule of allow) for (const re of mutators) assert.ok(!re.test(rule), `${rule} looks like a mutator and must not be in readonly's allow list`);
});

test("git fetch and git worktree list are allowed in every profile", () => {
  for (const profile of PROFILES) {
    const allow = allowSet(profile);
    assert.ok(allow.has("Bash(git fetch)") && allow.has("Bash(git fetch *)"), `git fetch missing from ${profile}`);
    assert.ok(allow.has("PowerShell(git fetch)") && allow.has("PowerShell(git fetch *)"), `git fetch (PowerShell) missing from ${profile}`);
    assert.ok(allow.has("Bash(git worktree list)") || allow.has("Bash(git worktree list *)") || allow.has("Bash(git worktree *)"),
      `git worktree list missing from ${profile}`);
  }
});

test("git worktree add/remove are withheld from readonly but present in code and ops", () => {
  assert.ok(!allowSet("readonly").has("Bash(git worktree *)"));
  for (const profile of ["code", "ops"]) assert.ok(allowSet(profile).has("Bash(git worktree *)"), `git worktree * missing from ${profile}`);
});

test("code adds file editing, write-capable git, and the dev-tool runners on top of readonly", () => {
  const ro = allowSet("readonly");
  const code = allowSet("code");
  for (const rule of ro) assert.ok(code.has(rule), `code profile dropped a readonly rule: ${rule}`);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(code.has(tool));
  assert.ok(code.has("Bash(node *)") && code.has("PowerShell(node *)"));
  assert.ok(code.has("Bash(mkdir *)"));
  assert.ok(code.has("Bash(git commit *)") && code.has("Bash(git checkout *)"));
});

test("ops profile only: the ops-actions runner is allow-listed, and ONLY there", () => {
  for (const profile of ["readonly", "code"]) {
    const allow = allowSet(profile);
    assert.ok(![...allow].some((r) => r.includes("ops-actions")), `ops runner must be absent from ${profile}`);
  }
  const opsAllow = allowSet("ops");
  assert.ok([...opsAllow].some((r) => r.includes("ops-actions") && r.includes("run.mjs")), "ops runner missing from ops profile");
  // Both Bash and PowerShell, both path-separator spellings.
  const opsRunnerRules = [...opsAllow].filter((r) => r.includes("ops-actions"));
  assert.ok(opsRunnerRules.some((r) => r.startsWith("Bash(")));
  assert.ok(opsRunnerRules.some((r) => r.startsWith("PowerShell(")));
  assert.ok(opsRunnerRules.some((r) => r.includes("/")), "forward-slash spelling missing");
  assert.ok(opsRunnerRules.some((r) => r.includes("\\")), "backslash spelling missing");
});

test("ops profile has everything code has, plus the ops runner", () => {
  const code = allowSet("code");
  const ops = allowSet("ops");
  for (const rule of code) assert.ok(ops.has(rule), `ops profile dropped a code rule: ${rule}`);
});

test("Get-Content is absent from every profile's allow list (shell secret-read hole, ITEM 2)", () => {
  for (const profile of PROFILES) {
    const allow = allowSet(profile);
    for (const rule of allow) assert.ok(!rule.includes("Get-Content"), `${rule} in ${profile} still allows Get-Content`);
  }
});

test("all three env-file deny shapes are present, anchored for nested directories, in every profile", () => {
  for (const profile of PROFILES) {
    const deny = buildSafePermissionsSettings(profile).permissions.deny;
    assert.ok(deny.includes("Read(//**/.env)"), `bare .env deny missing from ${profile}`);
    assert.ok(deny.includes("Read(//**/*.env)"), `*.env deny missing from ${profile}`);
    assert.ok(deny.includes("Read(//**/.env.*)"), `.env.* deny missing from ${profile}`);
  }
});

test("the deny floor is identical across all three profiles (never loosened per profile)", () => {
  const denies = PROFILES.map((p) => JSON.stringify(buildSafePermissionsSettings(p).permissions.deny.slice().sort()));
  assert.equal(denies[0], denies[1]);
  assert.equal(denies[1], denies[2]);
});

test("an unrecognized profile string falls back to DEFAULT_PROFILE (code)'s allow list", () => {
  assert.deepEqual(buildSafePermissionsSettings("not-a-real-profile").permissions.allow, buildSafePermissionsSettings(DEFAULT_PROFILE).permissions.allow);
  assert.deepEqual(buildSafePermissionsSettings(undefined).permissions.allow, buildSafePermissionsSettings(DEFAULT_PROFILE).permissions.allow);
});

// ------------------------------------------------------------------------- buildDenialGuidanceText

test("buildDenialGuidanceText names the resolved profile and tells the job not to work around a denial", () => {
  const text = buildDenialGuidanceText("readonly");
  assert.match(text, /profile: "readonly"/);
  assert.match(text, /do not look for a workaround/i);
  assert.match(text, /stop and say so in your final report/i);
});

// ---------------------------------------------------------------------------- startJob() wiring

test("startJob: profile omitted defaults to DEFAULT_PROFILE (code) and is recorded in the result/meta", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("default") },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(res.profile, DEFAULT_PROFILE);
  assert.equal(capture[0].extraEnv[PROFILE_ENV], DEFAULT_PROFILE);
});

test("startJob: an explicit profile is recorded and set on the launched process's env", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("readonly"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(res.profile, "readonly");
  assert.equal(capture[0].extraEnv[PROFILE_ENV], "readonly");
});

test("startJob: an invalid profile is refused before any job dir is created", async () => {
  const capture = [];
  const id = jid("invalid");
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: id, profile: "sudo" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.equal(res.errorCode, "profile");
  assert.equal(capture.length, 0);
  assert.ok(!fs.existsSync(path.join(tmpJobRoot, id)), "no job dir should have been created");
});

test("startJob: a nested job (depth>0) cannot request a profile broader than its own", async () => {
  const capture = [];
  const id = jid("escalate");
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: id, profile: "ops" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 },
      depth: "1" },
  );
  // process.env has no CLAUDE_ASYNC_JOB_PROFILE set in this test process, so the "parent" reads as
  // DEFAULT_PROFILE (code); requesting "ops" (broader) at depth 1 must be refused.
  assert.equal(res.errorCode, "profile");
  assert.equal(capture.length, 0);
  assert.ok(!fs.existsSync(path.join(tmpJobRoot, id)));
});

test("startJob: a nested job requesting its own (or a narrower) profile is allowed", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("nested-ok"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, depth: "1" },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(res.profile, "readonly");
});

test("startJob: --append-system-prompt denial guidance is added only when safe permissions are on", async () => {
  const captureOff = [];
  const resOff = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("guidance-off") },
    { claudeBin: process.execPath, launch: fakeLaunch(captureOff), caps: { maxStartsPerMinute: 1000 }, safePermissions: false },
  );
  assert.ok(!resOff.error, JSON.stringify(resOff));
  assert.ok(!captureOff[0].argv.includes("--append-system-prompt"), "guidance must not be added when safe permissions are off");

  const captureOn = [];
  const resOn = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("guidance-on"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(captureOn), caps: { maxStartsPerMinute: 1000 }, safePermissions: true },
  );
  assert.ok(!resOn.error, JSON.stringify(resOn));
  const idx = captureOn[0].argv.indexOf("--append-system-prompt");
  assert.ok(idx !== -1, "guidance must be added when safe permissions are on");
  assert.match(captureOn[0].argv[idx + 1], /profile: "readonly"/);
});

test("startJob: safe permissions on builds permission settings matching the resolved profile", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("settings-readonly"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.ok(!settings.permissions.allow.includes("Edit"), "readonly job's settings must not allow Edit");
  assert.ok(settings.permissions.allow.includes("Bash(git fetch)"), "readonly job's settings must allow git fetch");
});
