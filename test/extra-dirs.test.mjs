// Tests for extra-dirs.mjs (A2/A3/A4) and job-core.mjs's extraDirs wiring (A1/A5/A7): validation,
// protected-location/live-checkout refusals, the cap, duplicate rejection, container refusal, the
// --add-dir argv, the "code"-only Edit() deny rule, the guidance text, and meta.json recording.
// Run: node --test test/extra-dirs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpJobRoot = path.join(os.tmpdir(), `claude-async-extradirs-test-${crypto.randomBytes(4).toString("hex")}`);
fs.mkdirSync(tmpJobRoot, { recursive: true });
process.env.CLAUDE_ASYNC_JOB_DIR = tmpJobRoot;
delete process.env.CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS;

const extraDirs = await import("../extra-dirs.mjs");
const { validateExtraDir, validateExtraDirs, checkProtected, checkLiveCheckout, protectedPaths,
        EXTRA_DIRS_MAX, LIVE_CHECKOUTS_ROOT } = extraDirs;
const core = await import("../job-core.mjs");
const { startJob, checkJob, buildExtraDirsGuidanceText, buildSafePermissionsSettings } = core;

const jid = (label) => `extradirs-${label}-${crypto.randomBytes(3).toString("hex")}`;

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

// A fresh fake "home" with the credential dirs the real protectedPaths() names, so these tests
// never touch the real ~/.ssh etc. CLAUDE_CONFIG_DIR is left unset for this homedir's own
// protectedPaths() calls (falls back to <homedir>/.claude).
function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-fakehome-"));
  const sshDir = path.join(home, ".ssh"); fs.mkdirSync(sshDir);
  const claudeDir = path.join(home, ".claude"); fs.mkdirSync(claudeDir);
  const jobsDir = path.join(home, ".claude-async-jobs"); fs.mkdirSync(jobsDir); // deliberately NOT protected
  return { home, sshDir, claudeDir, jobsDir };
}

// --------------------------------------------------------------------------- protectedPaths/checkProtected

test("protectedPaths: includes the credential/config dirs and spine-data; excludes .claude-async-jobs", () => {
  const { home } = makeFakeHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const list = protectedPaths(home);
  assert.ok(list.includes(path.join(home, ".ssh")));
  assert.ok(list.includes(path.join(home, ".aws")));
  assert.ok(list.includes(path.join(home, ".azure")));
  assert.ok(list.includes(path.join(home, ".gnupg")));
  assert.ok(list.includes(path.join(home, ".config", "gh")));
  assert.ok(list.includes(path.join(home, ".docker")));
  assert.ok(list.includes(path.join(home, ".claude")));
  assert.ok(list.includes("D:\\claunker\\spine-data"));
  assert.ok(!list.some((p) => p.endsWith(".claude-async-jobs")));
});

test("checkProtected: refuses a path under a protected dir, in any profile, even when the real dir is missing (literal fallback)", () => {
  const { home, sshDir } = makeFakeHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.match(checkProtected(path.join(sshDir, "id_rsa"), { homedir: home }), /protected location/);
  // D:\claunker\spine-data almost certainly doesn't exist on the test machine -- the literal-path
  // fallback must still refuse it (checkProtected never touches the CANDIDATE path on disk).
  assert.match(checkProtected("D:\\claunker\\spine-data\\spine.db", { homedir: home }), /protected location/);
  assert.equal(checkProtected(path.join(home, "somewhere", "else"), { homedir: home }), null);
});

test("checkProtected: a sibling .claude-async-jobs dir is never refused", () => {
  const { home, jobsDir } = makeFakeHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(checkProtected(jobsDir, { homedir: home }), null);
});

// -------------------------------------------------------------------------------- checkLiveCheckout

test("checkLiveCheckout: refuses anything under D:\\claunker\\ for profile \"code\" only", () => {
  assert.match(checkLiveCheckout("D:\\claunker\\spine\\foo", "code"), /live prod checkout/);
  assert.equal(checkLiveCheckout("D:\\claunker\\spine\\foo", "readonly"), null);
  assert.equal(checkLiveCheckout("D:\\code\\claunker-ops", "code"), null, "a repo whose NAME merely contains claunker must not match");
});

// --------------------------------------------------------------------------------- validateExtraDir

test("validateExtraDir: accepts a real, existing directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-ok-"));
  const v = validateExtraDir(dir);
  assert.ok(!v.error, JSON.stringify(v));
  assert.equal(v.resolved, fs.realpathSync(dir));
});

test("validateExtraDir: refuses a relative path", () => {
  assert.match(validateExtraDir("relative/path").error, /absolute path/);
});

test("validateExtraDir: refuses a nonexistent path", () => {
  const dir = path.join(os.tmpdir(), "extradirs-does-not-exist-" + crypto.randomBytes(4).toString("hex"));
  assert.match(validateExtraDir(dir).error, /does not exist/);
});

test("validateExtraDir: refuses a file (not a directory)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-file-"));
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, "x");
  assert.match(validateExtraDir(file).error, /is not a directory/);
});

test("validateExtraDir: resolves a junction/symlink before checking (points at the real target)", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-real-"));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-linkparent-"));
  const link = path.join(linkParent, "junction");
  try { fs.symlinkSync(real, link, "junction"); }
  catch { fs.symlinkSync(real, link, "dir"); } // non-Windows fallback, unlikely on this host
  const v = validateExtraDir(link);
  assert.ok(!v.error, JSON.stringify(v));
  assert.equal(v.resolved, fs.realpathSync(real));
});

test("validateExtraDir: refuses a protected location (shared check, homedir override)", () => {
  const { home, sshDir } = makeFakeHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.match(validateExtraDir(sshDir, { homedir: home }).error, /protected location/);
});

test("validateExtraDir: \"code\" profile's live-checkout check does not reject an ordinary dir outside D:\\claunker\\", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-notclaunker-"));
  assert.ok(!validateExtraDir(dir, { profile: "code" }).error);
});

test("validateExtraDir: refuses a duplicate of the job's own workFolder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-workfolder-"));
  assert.match(validateExtraDir(dir, { workFolder: dir }).error, /duplicates the job's own work folder/);
});

// -------------------------------------------------------------------------------- validateExtraDirs

test("validateExtraDirs: undefined/null/empty all mean \"nothing requested\"", () => {
  assert.deepEqual(validateExtraDirs(undefined), { dirs: [] });
  assert.deepEqual(validateExtraDirs(null), { dirs: [] });
  assert.deepEqual(validateExtraDirs([]), { dirs: [] });
});

test("validateExtraDirs: rejects a non-array", () => {
  assert.match(validateExtraDirs("not-an-array").error, /must be an array/);
});

test(`validateExtraDirs: enforces the cap of ${EXTRA_DIRS_MAX}`, () => {
  const tooMany = Array.from({ length: EXTRA_DIRS_MAX + 1 }, (_, i) => `/fake/${i}`);
  assert.match(validateExtraDirs(tooMany).error, /more than the cap/);
});

test("validateExtraDirs: rejects a duplicate entry within the list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-listdup-"));
  assert.match(validateExtraDirs([dir, dir]).error, /duplicates another entry/);
});

test("validateExtraDirs: resolves every entry and preserves order", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-b-"));
  const v = validateExtraDirs([a, b]);
  assert.deepEqual(v.dirs, [fs.realpathSync(a), fs.realpathSync(b)]);
});

// -------------------------------------------------------------------------------- buildExtraDirsGuidanceText

test("buildExtraDirsGuidanceText: null when nothing was granted", () => {
  assert.equal(buildExtraDirsGuidanceText([]), null);
  assert.equal(buildExtraDirsGuidanceText(undefined), null);
});

test("buildExtraDirsGuidanceText: lists each dir forward-slashed and explains read-only intent", () => {
  const text = buildExtraDirsGuidanceText(["C:\\foo\\bar"]);
  assert.match(text, /C:\/foo\/bar/);
  assert.match(text, /READING ONLY/);
  assert.match(text, /shell command.*can still write/i);
});

// ----------------------------------------------------------------------- startJob() wiring (A1/A5/A7)

const WORK_FOLDER = os.tmpdir();

test("startJob: a host job with a valid extraDirs gets one --add-dir per directory and records extraDirs in the result/meta", async () => {
  const capture = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-wire-"));
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("wire"), extraDirs: [dir] },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const resolved = fs.realpathSync(dir);
  assert.deepEqual(res.extraDirs, [resolved]);
  const addDirIndex = capture[0].argv.indexOf("--add-dir");
  assert.ok(addDirIndex !== -1, JSON.stringify(capture[0].argv));
  assert.equal(capture[0].argv[addDirIndex + 1], resolved);
});

test("startJob: an invalid extraDirs entry refuses the whole launch before anything is written", async () => {
  const capture = [];
  const bogus = path.join(os.tmpdir(), "extradirs-missing-" + crypto.randomBytes(4).toString("hex"));
  const id = jid("invalid");
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: id, extraDirs: [bogus] },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.match(res.error, /does not exist/);
  assert.equal(capture.length, 0, "launch must never be called when extraDirs validation fails");
});

test("startJob: extraDirs is refused outright for a container job (sandbox: \"container\")", async () => {
  const res = await startJob(
    { prompt: "hi", sandbox: "container", repo: "owner/repo", extraDirs: ["C:\\somewhere"], jobId: jid("container") },
    { caps: { maxStartsPerMinute: 1000 }, sandboxDefault: "host", allowedSandboxes: "host,container" },
  );
  assert.match(res.error, /extraDirs is only for host jobs/);
});

test("startJob: no extraDirs means no --add-dir and no extraDirs key in the result", async () => {
  const capture = [];
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("none") },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.ok(!("extraDirs" in res));
  assert.ok(!capture[0].argv.includes("--add-dir"));
});

test("startJob: \"code\" + safe permissions on + extraDirs adds an Edit() deny rule for that dir, and appends extraDirs guidance", async () => {
  const capture = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-deny-"));
  const resolved = fs.realpathSync(dir).replace(/\\/g, "/");
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("codedeny"), profile: "code", extraDirs: [dir] },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.ok(settings.permissions.deny.includes(`Edit(${resolved}/**)`), JSON.stringify(settings.permissions.deny));
  const promptIndex = capture[0].argv.indexOf("--append-system-prompt");
  assert.ok(promptIndex !== -1);
  assert.match(capture[0].argv[promptIndex + 1], /READING ONLY/);
  assert.match(capture[0].argv[promptIndex + 1], new RegExp(resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("startJob: \"readonly\" + extraDirs does NOT add an Edit() deny rule (readonly already denies Edit/Write/NotebookEdit everywhere)", async () => {
  const capture = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-ro-"));
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("rodeny"), profile: "readonly", extraDirs: [dir] },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: true },
  );
  assert.ok(!res.error, JSON.stringify(res));
  const settings = settingsFromArgv(capture[0].argv);
  assert.deepEqual(settings.permissions.deny, buildSafePermissionsSettings("readonly").permissions.deny,
    "readonly's deny list must be unchanged by extraDirs -- it already denies Edit/Write/NotebookEdit everywhere");
});

test("startJob: extraDirs guidance is appended even with safe permissions OFF (--dangerously-skip-permissions)", async () => {
  const capture = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-skip-"));
  const res = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: jid("skipperm"), extraDirs: [dir] },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 }, safePermissions: false },
  );
  assert.ok(!res.error, JSON.stringify(res));
  assert.ok(capture[0].argv.includes("--dangerously-skip-permissions"));
  const promptIndex = capture[0].argv.indexOf("--append-system-prompt");
  assert.ok(promptIndex !== -1);
  assert.match(capture[0].argv[promptIndex + 1], /READING ONLY/);
});

test("claude_check (checkJob) shows extraDirs for a job that was granted them (A7)", async () => {
  const capture = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extradirs-check-"));
  const id = jid("check");
  const started = await startJob(
    { prompt: "hi", workFolder: WORK_FOLDER, jobId: id, extraDirs: [dir] },
    { claudeBin: process.execPath, launch: fakeLaunch(capture), caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!started.error, JSON.stringify(started));
  const checked = checkJob(started.jobId);
  assert.deepEqual(checked.extraDirs, [fs.realpathSync(dir)]);
});
