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
const { startJob, buildSafePermissionsSettings, buildDenialGuidanceText, buildReadonlyMemoryAppend,
        READONLY_CLAUDE_MD_MAX_BYTES } = core;
const { PROFILES, DEFAULT_PROFILE, PROFILE_ENV, JOB_ID_ENV, isProfile, checkProfile } = guard;
const { LANTERN_PREAMBLE_LINE, withLanternPreamble } = await import("../lantern-preamble.mjs");

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

test("guard.mjs: PROFILES is exactly readonly/code, DEFAULT_PROFILE is code", () => {
  assert.deepEqual(PROFILES, ["readonly", "code"]);
  assert.equal(DEFAULT_PROFILE, "code");
});

test("guard.mjs: isProfile rejects anything outside PROFILES, including the removed \"ops\"", () => {
  for (const p of PROFILES) assert.ok(isProfile(p));
  assert.ok(!isProfile("ops"));
  assert.ok(!isProfile("bogus"));
  assert.ok(!isProfile(undefined));
  assert.ok(!isProfile(42));
});

test("guard.mjs: checkProfile refuses an invalid profile regardless of depth", () => {
  assert.match(checkProfile(0, "bogus"), /invalid profile/);
  assert.match(checkProfile(0, "ops"), /invalid profile/);
});

test("guard.mjs: checkProfile at depth 0 (top-level caller) allows any valid profile", () => {
  for (const p of PROFILES) assert.equal(checkProfile(0, p), null);
});

test("guard.mjs: checkProfile refuses a nested job requesting a profile broader than its parent's", () => {
  const err = checkProfile(1, "code", { [PROFILE_ENV]: "readonly" });
  assert.match(err, /nested job.*may not request profile "code".*broader.*"readonly"/);
});

test("guard.mjs: checkProfile allows a nested job requesting its parent's own profile or narrower", () => {
  assert.equal(checkProfile(1, "readonly", { [PROFILE_ENV]: "readonly" }), null);
  assert.equal(checkProfile(1, "code", { [PROFILE_ENV]: "code" }), null);
  assert.equal(checkProfile(1, "readonly", { [PROFILE_ENV]: "code" }), null);
});

test("missing or invalid nested parent profile is refused", () => {
  for (const profile of PROFILES) for (const env of [{}, { [PROFILE_ENV]: "bogus" }]) assert.match(checkProfile(1, profile, env), /no known parent/);
});

// ------------------------------------------------------- job-core.mjs: buildSafePermissionsSettings

function allowSet(profile) { return new Set(buildSafePermissionsSettings(profile).permissions.allow); }

test("readonly: no file-editing tools, no interpreters/code-runners, no mkdir", () => {
  const allow = allowSet("readonly");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(!allow.has(tool), `${tool} must be absent from readonly`);
  // A BARE interpreter prefix (e.g. "node *") must be absent -- but the fixed-path wrapper calls
  // (http-get-loopback.mjs, git-ro.mjs, ollama-generate.mjs) are legitimately present in every
  // profile, so this only rejects the bare, unscoped form, not every rule that happens to start
  // with the binary name.
  for (const shell of ["Bash", "PowerShell"]) {
    for (const bin of ["node", "python", "python3", "py", "npm", "npx", "pnpm", "uv", "pytest", "mkdir"]) {
      assert.ok(!allow.has(`${shell}(${bin} *)`) && !allow.has(`${shell}(${bin})`),
        `bare ${shell}(${bin}...) must be absent from readonly`);
    }
  }
});

test("readonly: no raw git allow rule at all -- only the tools/git-ro.mjs wrapper", () => {
  const allow = [...allowSet("readonly")];
  const rawGit = allow.filter((r) => /^(Bash|PowerShell)\(git /.test(r));
  assert.deepEqual(rawGit, [], `readonly must have NO raw git allow rule (even read-only-looking ones): ${JSON.stringify(rawGit)}`);
  const wrapperRules = allow.filter((r) => r.includes("git-ro.mjs"));
  assert.ok(wrapperRules.some((r) => r.startsWith("Bash(")) && wrapperRules.some((r) => r.startsWith("PowerShell(")),
    "readonly must allow the git-ro.mjs wrapper via both shells");
  assert.ok(wrapperRules.some((r) => r.includes("/")) && wrapperRules.some((r) => r.includes("\\")),
    "git-ro.mjs wrapper rule must cover both path-separator spellings");
});

test("readonly: no allow rule admits an in-place mutator (sed -i, tee, curl -o, Out-File, Set-Content)", () => {
  const allow = allowSet("readonly");
  const mutators = [/^Bash\(sed -i/, /^Bash\(tee /, /-o /, /^PowerShell\(Out-File/, /^PowerShell\(Set-Content/];
  for (const rule of allow) for (const re of mutators) assert.ok(!re.test(rule), `${rule} looks like a mutator and must not be in readonly's allow list`);
});

test("git fetch and raw git worktree list are allowed in code only, not readonly (fix 1)", () => {
  const ro = allowSet("readonly");
  assert.ok(!ro.has("Bash(git fetch)") && !ro.has("Bash(git fetch *)"), "raw git fetch must be absent from readonly");
  const code = allowSet("code");
  assert.ok(code.has("Bash(git fetch)") && code.has("Bash(git fetch *)"), "git fetch missing from code");
  assert.ok(code.has("PowerShell(git fetch)") && code.has("PowerShell(git fetch *)"), "git fetch (PowerShell) missing from code");
  assert.ok(code.has("Bash(git worktree list)") || code.has("Bash(git worktree list *)") || code.has("Bash(git worktree *)"),
    "git worktree list missing from code");
});

test("git worktree add/remove are withheld from readonly but present in code", () => {
  assert.ok(!allowSet("readonly").has("Bash(git worktree *)"));
  assert.ok(allowSet("code").has("Bash(git worktree *)"));
});

test("code adds file editing, raw git, and the dev-tool runners on top of readonly's base set", () => {
  const ro = allowSet("readonly");
  const code = allowSet("code");
  for (const rule of ro) assert.ok(code.has(rule), `code profile dropped a readonly rule: ${rule}`);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.ok(code.has(tool));
  assert.ok(code.has("Bash(node *)") && code.has("PowerShell(node *)"));
  assert.ok(code.has("Bash(mkdir *)"));
  assert.ok(code.has("Bash(git commit *)") && code.has("Bash(git checkout *)"));
});

test("ops is rejected by the internal settings builder", () => { assert.throws(() => buildSafePermissionsSettings("ops"), /invalid profile/); });

test("Get-Content, Get-Item, and Get-ChildItem are absent from every profile's allow list (fix 3: env/file-content read hole)", () => {
  for (const profile of PROFILES) {
    const allow = allowSet(profile);
    for (const rule of allow) {
      assert.ok(!rule.includes("Get-Content"), `${rule} in ${profile} still allows Get-Content`);
      assert.ok(!/PowerShell\(Get-Item\b/.test(rule), `${rule} in ${profile} still allows Get-Item (can print env var values via Get-Item Env:NAME)`);
      assert.ok(!/PowerShell\(Get-ChildItem\b/.test(rule), `${rule} in ${profile} still allows Get-ChildItem (can print env var values via Get-ChildItem Env:)`);
    }
  }
});

test("the loopback helper and ollama-generate wrapper are allow-listed in every profile", () => {
  for (const profile of PROFILES) {
    const allow = [...allowSet(profile)];
    assert.ok(allow.some((r) => r.includes("http-get-loopback.mjs")), `loopback helper missing from ${profile}`);
    assert.ok(allow.some((r) => r.includes("ollama-generate.mjs")), `ollama-generate wrapper missing from ${profile}`);
    assert.ok(allow.includes("Bash(ollama list)") && allow.includes("Bash(ollama list *)"), `word-boundary-safe ollama list missing from ${profile}`);
    assert.ok(allow.includes("Bash(ollama ps)") && allow.includes("Bash(ollama ps *)"), `word-boundary-safe ollama ps missing from ${profile}`);
    // The old no-space forms must be gone (fix 2: they were boundary-unsafe).
    assert.ok(!allow.includes("Bash(ollama list*)"), `boundary-unsafe "ollama list*" must be gone from ${profile}`);
    assert.ok(!allow.includes("Bash(ollama ps*)"), `boundary-unsafe "ollama ps*" must be gone from ${profile}`);
  }
});

test("no raw curl/Invoke-RestMethod/Invoke-WebRequest Ollama allow rule remains in any profile (fix 2)", () => {
  for (const profile of PROFILES) {
    const allow = [...allowSet(profile)];
    for (const rule of allow) {
      assert.ok(!/curl http:\/\/(127\.0\.0\.1|localhost):11434/.test(rule), `${rule} in ${profile} is a raw curl Ollama rule`);
      assert.ok(!/Invoke-(RestMethod|WebRequest) http:\/\/(127\.0\.0\.1|localhost):11434/.test(rule), `${rule} in ${profile} is a raw PowerShell Ollama rule`);
    }
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

test("code accident guards (fix 7): .git/** edits and forced worktree-remove/checkout are denied", () => {
  for (const profile of PROFILES) {
    const deny = buildSafePermissionsSettings(profile).permissions.deny;
    assert.ok(deny.includes("Edit(//**/.git/**)"), `.git/** edit deny missing from ${profile}`);
    assert.ok(deny.some((d) => d.includes("git worktree remove --force")), `git worktree remove --force deny missing from ${profile}`);
    assert.ok(deny.some((d) => d.includes("git worktree remove -f")), `git worktree remove -f deny missing from ${profile}`);
    assert.ok(deny.some((d) => d.includes("git checkout --force")), `git checkout --force deny missing from ${profile}`);
  }
});

test("readonly adds write denies to the shared floor", () => {
 const ro = new Set(buildSafePermissionsSettings("readonly").permissions.deny);
 for (const deny of buildSafePermissionsSettings("code").permissions.deny) assert.ok(ro.has(deny));
 for (const tool of ["Write","Edit","MultiEdit","NotebookEdit","ScheduleWakeup"]) assert.ok(ro.has(tool));
});

test("internal profile helpers reject unknown profiles", () => {
 for (const p of ["ops", "bogus", null]) {
  assert.throws(() => buildSafePermissionsSettings(p), /invalid profile/);
  assert.throws(() => buildDenialGuidanceText(p), /invalid profile/);
 }
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
  assert.equal(capture[0].extraEnv[JOB_ID_ENV], res.jobId);
});

test("startJob: an explicit readonly profile with safe permissions on is recorded and set on the launched process's env", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("readonly"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true },
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

test("startJob: requesting the removed \"ops\" profile is refused explicitly, not mapped to anything", async () => {
  const capture = [];
  const id = jid("ops-refused");
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: id, profile: "ops" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.equal(res.errorCode, "profile");
  assert.match(res.error, /invalid profile "ops"/);
  assert.equal(capture.length, 0);
  assert.ok(!fs.existsSync(path.join(tmpJobRoot, id)));
});

test("startJob: a nested job (depth>0) cannot request a profile broader than its own", async () => {
  const capture = [];
  const id = jid("escalate");
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: id, profile: "code" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 },
      depth: "1", profileEnv: { [PROFILE_ENV]: "readonly" } },
  );
  assert.equal(res.errorCode, "profile");
  assert.equal(capture.length, 0);
  assert.ok(!fs.existsSync(path.join(tmpJobRoot, id)));
});

test("startJob: a nested job requesting its own (or a narrower) profile is allowed", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("nested-ok"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, depth: "1",
      safePermissions: true, profileEnv: { [PROFILE_ENV]: "readonly" } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(res.profile, "readonly");
});

test("startJob: \"readonly\" with safe permissions OFF is refused outright, never silently downgraded (fix 4)", async () => {
  const capture = [];
  const id = jid("readonly-no-safeperms");
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: id, profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: false },
  );
  assert.equal(res.errorCode, "profile");
  assert.equal(capture.length, 0, "no job may be launched for a refused readonly request");
  assert.ok(!fs.existsSync(path.join(tmpJobRoot, id)));
});

test("startJob: \"readonly\" with sandbox \"container\" is refused outright (fix 4)", async () => {
  const capture = [];
  const id = jid("readonly-container");
  const res = await startJob(
    { prompt: "hi", sandbox: "container", repo: "icey2488/claude-async", jobId: id, profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true,
      allowedSandboxes: "container" },
  );
  assert.equal(res.errorCode, "profile");
  assert.equal(capture.length, 0);
  assert.ok(!fs.existsSync(path.join(tmpJobRoot, id)));
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
  assert.equal(capture[0].argv[capture[0].argv.indexOf("--setting-sources") + 1], "");
  assert.ok(!settings.permissions.allow.includes("Edit"), "readonly job's settings must not allow Edit");
  assert.ok(!settings.permissions.allow.includes("Bash(git fetch)"), "readonly job's settings must NOT allow raw git fetch");
  assert.ok(settings.permissions.allow.some((r) => r.includes("git-ro.mjs")), "readonly job's settings must allow the git-ro.mjs wrapper");
});

test("readonly isolates settings sources and preserves operator hooks only", () => {
 const p = path.join(tmpJobRoot, "operator-settings.json");
 fs.writeFileSync(p, JSON.stringify({permissions:{allow:["Bash(node *)"]}, hooks:{PreToolUse:[{matcher:"*",hooks:[{type:"command",command:"echo telemetry-canary"}]}]}}));
 const settings = {hooks:{PreToolUse:[{matcher:"*",hooks:[{type:"command",command:"echo job-hook"}]}]}};
 core.preserveUserHooks(settings,p);
 assert.equal(settings.hooks.PreToolUse.length,2);
 assert.equal(settings.permissions,undefined);
});

test("readonly excludes CIM but code retains it", () => {
 assert.ok(!allowSet("readonly").has("PowerShell(Get-CimInstance *)"));
 assert.ok(allowSet("code").has("PowerShell(Get-CimInstance *)"));
});

test("invalid operator hooks fail before reserving a readonly job", async () => {
 const config=path.join(tmpJobRoot,"bad-operator.json"); fs.writeFileSync(config,"{");
 const id=jid("bad-hooks"); const capture=[];
 const r=await startJob({prompt:"canary",workFolder:WORK_FOLDER,jobId:id,profile:"readonly"},{claudeBin:process.execPath,launch:fakeLaunch(capture),safePermissions:true,userSettingsPath:config,caps:{maxStartsPerMinute:1000}});
 assert.equal(r.errorCode,"profile");assert.equal(capture.length,0);assert.ok(!fs.existsSync(path.join(tmpJobRoot,id)));
});

// ----------------------------------------------- buildReadonlyMemoryAppend (PR #6 follow-up: a
// readonly job's --setting-sources "" also skips CLAUDE.md memory entirely -- see job-core.mjs's
// comment above buildReadonlyMemoryAppend for the probe that found this).

test("buildReadonlyMemoryAppend: returns null when neither file exists", () => {
 const missingUser=path.join(tmpJobRoot,"no-such-user-claude.md");
 assert.equal(buildReadonlyMemoryAppend(path.join(tmpJobRoot,"no-such-project-dir"),missingUser),null);
});

test("buildReadonlyMemoryAppend: includes both files under clear, distinct headings", () => {
 const userMd=path.join(tmpJobRoot,"memory-user.md"); fs.writeFileSync(userMd,"USER_CANARY_1\n");
 const projectDir=path.join(tmpJobRoot,"memory-project-dir"); fs.mkdirSync(projectDir,{recursive:true});
 fs.writeFileSync(path.join(projectDir,"CLAUDE.md"),"PROJECT_CANARY_1\n");
 const text=buildReadonlyMemoryAppend(projectDir,userMd);
 assert.match(text,/USER_CANARY_1/); assert.match(text,/PROJECT_CANARY_1/);
 assert.match(text,/User-level CLAUDE\.md/); assert.match(text,/Project CLAUDE\.md.*not more trusted than the rest of the repo/);
 assert.ok(text.indexOf("User-level")<text.indexOf("USER_CANARY_1"),"heading must precede its own file's content");
});

test("buildReadonlyMemoryAppend: missing project file is skipped, user file alone still included", () => {
 const userMd=path.join(tmpJobRoot,"memory-user-only.md"); fs.writeFileSync(userMd,"USER_CANARY_2\n");
 const text=buildReadonlyMemoryAppend(path.join(tmpJobRoot,"no-such-project-dir-2"),userMd);
 assert.match(text,/USER_CANARY_2/); assert.ok(!text.includes("Project CLAUDE.md"));
});

test("buildReadonlyMemoryAppend: null workFolder (container-shaped call) skips project file, not just missing", () => {
 const userMd=path.join(tmpJobRoot,"memory-user-null-wf.md"); fs.writeFileSync(userMd,"USER_CANARY_3\n");
 const text=buildReadonlyMemoryAppend(null,userMd);
 assert.match(text,/USER_CANARY_3/);
});

test("buildReadonlyMemoryAppend: truncates an oversized file at the cap and says so", () => {
 const userMd=path.join(tmpJobRoot,"memory-user-big.md");
 fs.writeFileSync(userMd,"A".repeat(READONLY_CLAUDE_MD_MAX_BYTES+500));
 const text=buildReadonlyMemoryAppend(path.join(tmpJobRoot,"no-such-project-dir-3"),userMd);
 assert.match(text,/truncated at \d+ bytes/);
 assert.ok(text.includes("A".repeat(READONLY_CLAUDE_MD_MAX_BYTES)),"must keep exactly the capped byte count");
 assert.ok(!text.includes("A".repeat(READONLY_CLAUDE_MD_MAX_BYTES+1)),"must not exceed the cap");
});

test("buildReadonlyMemoryAppend: an unreadable (directory-shaped) CLAUDE.md throws instead of silently skipping", () => {
 const userMdAsDir=path.join(tmpJobRoot,"memory-user-is-a-dir.md"); fs.mkdirSync(userMdAsDir,{recursive:true});
 assert.throws(()=>buildReadonlyMemoryAppend(path.join(tmpJobRoot,"no-such-project-dir-4"),userMdAsDir),/Cannot read user-level CLAUDE\.md/);
});

test("startJob: readonly job's argv carries both CLAUDE.md files via --append-system-prompt-file, additive with denial guidance", async () => {
 const userMd=path.join(tmpJobRoot,"wired-user.md"); fs.writeFileSync(userMd,"WIRED_USER_CANARY\n");
 const projectDir=path.join(tmpJobRoot,"wired-project-dir"); fs.mkdirSync(projectDir,{recursive:true});
 fs.writeFileSync(path.join(projectDir,"CLAUDE.md"),"WIRED_PROJECT_CANARY\n");
 const operatorSettings=path.join(tmpJobRoot,"wired-operator-settings.json"); fs.writeFileSync(operatorSettings,"{}");
 const id=jid("memory-wired"); const capture=[];
 const r=await startJob({prompt:"canary",workFolder:projectDir,jobId:id,profile:"readonly"},
   {claudeBin:process.execPath,launch:fakeLaunch(capture),safePermissions:true,userSettingsPath:operatorSettings,
    userClaudeMdPath:userMd,caps:{maxStartsPerMinute:1000,maxConcurrent:1000}});
 assert.ok(!r.error,JSON.stringify(r));
 const argv=capture[0].argv;
 const fileIdx=argv.indexOf("--append-system-prompt-file");
 assert.ok(fileIdx!==-1,"must pass the memory text via --append-system-prompt-file: "+JSON.stringify(argv));
 const memoryFileContent=fs.readFileSync(argv[fileIdx+1],"utf8");
 assert.match(memoryFileContent,/WIRED_USER_CANARY/); assert.match(memoryFileContent,/WIRED_PROJECT_CANARY/);
 // Additive, not a replacement: the separate inline denial-guidance flag must still be present too.
 const inlineIdx=argv.indexOf("--append-system-prompt");
 assert.ok(inlineIdx!==-1); assert.match(argv[inlineIdx+1],/profile: "readonly"/);
 assert.notEqual(inlineIdx,fileIdx);
});

test("startJob: readonly job with no CLAUDE.md files anywhere never pushes --append-system-prompt-file", async () => {
 const emptyWorkFolder=path.join(tmpJobRoot,"memory-wired-empty-dir"); fs.mkdirSync(emptyWorkFolder,{recursive:true});
 const noUserMd=path.join(tmpJobRoot,"no-such-user-claude-2.md");
 const operatorSettings=path.join(tmpJobRoot,"wired-operator-settings-2.json"); fs.writeFileSync(operatorSettings,"{}");
 const id=jid("memory-empty"); const capture=[];
 const r=await startJob({prompt:"canary",workFolder:emptyWorkFolder,jobId:id,profile:"readonly"},
   {claudeBin:process.execPath,launch:fakeLaunch(capture),safePermissions:true,userSettingsPath:operatorSettings,
    userClaudeMdPath:noUserMd,caps:{maxStartsPerMinute:1000,maxConcurrent:1000}});
 assert.ok(!r.error,JSON.stringify(r));
 assert.equal(capture[0].argv.indexOf("--append-system-prompt-file"),-1);
});

test("startJob: code profile never passes --append-system-prompt-file even if CLAUDE.md files exist", async () => {
 const projectDir=path.join(tmpJobRoot,"code-profile-project-dir"); fs.mkdirSync(projectDir,{recursive:true});
 fs.writeFileSync(path.join(projectDir,"CLAUDE.md"),"SHOULD_NOT_BE_READ_SEPARATELY\n");
 const id=jid("code-no-file-flag"); const capture=[];
 const r=await startJob({prompt:"canary",workFolder:projectDir,jobId:id,profile:"code"},
   {claudeBin:process.execPath,launch:fakeLaunch(capture),safePermissions:true,caps:{maxStartsPerMinute:1000,maxConcurrent:1000}});
 assert.ok(!r.error,JSON.stringify(r));
 assert.equal(capture[0].argv.indexOf("--append-system-prompt-file"),-1);
});

test("startJob: an unreadable user CLAUDE.md fails a readonly launch before reserving the job", async () => {
 const userMdAsDir=path.join(tmpJobRoot,"startjob-user-claude-is-dir"); fs.mkdirSync(userMdAsDir,{recursive:true});
 const operatorSettings=path.join(tmpJobRoot,"wired-operator-settings-3.json"); fs.writeFileSync(operatorSettings,"{}");
 const id=jid("unreadable-memory"); const capture=[];
 const r=await startJob({prompt:"canary",workFolder:WORK_FOLDER,jobId:id,profile:"readonly"},
   {claudeBin:process.execPath,launch:fakeLaunch(capture),safePermissions:true,userSettingsPath:operatorSettings,
    userClaudeMdPath:userMdAsDir,caps:{maxStartsPerMinute:1000,maxConcurrent:1000}});
 assert.equal(r.errorCode,"profile"); assert.equal(capture.length,0); assert.ok(!fs.existsSync(path.join(tmpJobRoot,id)));
});

// --------------------------------------------------------- Lantern notice reaches both profiles
// (fix 4, 2026-11-13 PR #7 follow-up): the Lantern preamble lives in the one argv slot (-p) every
// launch builds unconditionally, regardless of profile, BEFORE the readonly-only branch adds its
// own additive --append-system-prompt (denial guidance) and --append-system-prompt-file (CLAUDE.md
// memory) flags -- see lantern-preamble.mjs's header for why that placement survives both.

test("startJob: code profile's -p prompt carries the Lantern preamble (fix 4, code launch path)", async () => {
  const capture = [];
  const prompt = "do the thing";
  const res = await startJob(
    { prompt, workFolder: WORK_FOLDER, jobId: jid("lantern-code") },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000, maxConcurrent: 1000 } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(res.profile, "code");
  const argv = capture[0].argv;
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], withLanternPreamble(prompt));
  assert.match(argv[1], new RegExp(LANTERN_PREAMBLE_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("startJob: readonly profile's -p prompt carries the Lantern preamble too, additive with denial guidance and memory file (fix 4, readonly launch path)", async () => {
  const userMd = path.join(tmpJobRoot, "lantern-readonly-user.md");
  fs.writeFileSync(userMd, "LANTERN_READONLY_MEMORY_CANARY\n");
  const projectDir = path.join(tmpJobRoot, "lantern-readonly-project-dir");
  fs.mkdirSync(projectDir, { recursive: true });
  const operatorSettings = path.join(tmpJobRoot, "lantern-readonly-operator-settings.json");
  fs.writeFileSync(operatorSettings, "{}");
  const capture = [];
  const prompt = "inspect the thing";
  const res = await startJob(
    { prompt, workFolder: projectDir, jobId: jid("lantern-readonly"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000, maxConcurrent: 1000 },
      safePermissions: true, userSettingsPath: operatorSettings, userClaudeMdPath: userMd },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.equal(res.profile, "readonly");
  const argv = capture[0].argv;
  // The -p prompt carries the preamble exactly as for "code" -- unaffected by --setting-sources ""
  // or either of readonly's own additive system-prompt flags below.
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], withLanternPreamble(prompt));
  // Both of readonly's own additive mechanisms are present alongside it, not instead of it.
  assert.ok(argv.includes("--append-system-prompt"), "denial guidance must still be present");
  const fileIdx = argv.indexOf("--append-system-prompt-file");
  assert.ok(fileIdx !== -1, "memory file flag must still be present");
  assert.match(fs.readFileSync(argv[fileIdx + 1], "utf8"), /LANTERN_READONLY_MEMORY_CANARY/);
});

// -------------------------------------------------- Lantern adds no permission rule (fix 5, PR #7)

// Matches only the AgentGlass Lantern endpoint itself (agents/status, its :4000 port), never the
// bare word "lantern" -- this worktree's own directory name is claude-async-lantern, so a rule
// built from a repo path (e.g. the git-ro.mjs wrapper's absolute path) would otherwise false-positive.
const LANTERN_ENDPOINT_RE = /agents\/status|127\.0\.0\.1:4000|localhost:4000/i;

test("Lantern integration adds no permission rule to either profile's generated settings (fix 5)", () => {
  for (const profile of PROFILES) {
    const settings = buildSafePermissionsSettings(profile);
    for (const rule of [...settings.permissions.allow, ...settings.permissions.deny]) {
      assert.ok(!LANTERN_ENDPOINT_RE.test(rule), `profile "${profile}" has a Lantern-related permission rule: ${rule}`);
    }
  }
});

test("startJob: Lantern adds no permission rule to either profile's constructed --settings (fix 5)", async () => {
  for (const profile of ["code", "readonly"]) {
    const capture = [];
    const res = await startJob(
      { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid(`lantern-no-perm-${profile}`), profile },
      { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000, maxConcurrent: 1000 }, safePermissions: true },
    );
    assert.ok(!res.error, JSON.stringify(res));
    const settings = settingsFromArgv(capture[0].argv);
    const rules = [...(settings.permissions?.allow || []), ...(settings.permissions?.deny || [])];
    for (const rule of rules) assert.ok(!LANTERN_ENDPOINT_RE.test(rule), `profile "${profile}" has a Lantern-related permission rule: ${rule}`);
  }
});
