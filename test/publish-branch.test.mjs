// scripts/publish-branch.mjs: the one allow-listed publish action for safe-mode jobs.
// Pure validators are unit-tested directly; the flow is tested end-to-end against temp git repos
// whose origin is a github.com URL (so the production owner/host checks run for real) redirected to
// a local bare repo with url.<bare>.insteadOf. The expanded-URL check would rightly refuse that
// rewrite, so the in-process tests pass publish()'s import-only trustExpandedUrl seam, scoped to
// exactly that one bare path; the CLI tests at the bottom prove the seam is unreachable from the
// command line (same setup -> REMOTE_REFUSED). gh is a fake node script; git is the real git behind
// a thin logging wrapper so every argv the script runs can be asserted on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pb from "../scripts/publish-branch.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "publish-branch.mjs");
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ca-publish-")));
const ROOT = path.join(TMP, "root");       // the only allowed root
const OUTSIDE = path.join(TMP, "outside"); // never allowed
const HOME = path.join(TMP, "home");
const OSTMP = path.join(TMP, "ostmp");    // stands in for os.tmpdir() via publish()'s tmpDir seam
const BARES = path.join(TMP, "bares");
const AUDIT = path.join(TMP, "audit", "publish-audit.jsonl");
const GH_LOG = path.join(TMP, "gh-argv.jsonl");
const GIT_LOG = path.join(TMP, "git-argv.jsonl");
const FAKE_GH = path.join(TMP, "fake-gh.mjs");
const GIT_WRAP = path.join(TMP, "git-wrap.mjs");
for (const d of [ROOT, OUTSIDE, HOME, BARES, OSTMP]) fs.mkdirSync(d, { recursive: true });

// Fake gh: logs argv, answers the handful of subcommands the script uses, driven by FAKE_GH_* env.
fs.writeFileSync(FAKE_GH, `
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + "\\n");
const e = process.env;
const flag = (n) => { const x = a.find((s) => s.startsWith("--" + n + "=")); return x ? x.slice(n.length + 3) : null; };
if (a[0] === "repo" && a[1] === "view") {
  if (a.includes("parent")) {
    const p = e.FAKE_GH_PARENT || "";
    process.stdout.write(JSON.stringify({ parent: p ? { owner: { login: p.split("/")[0] }, name: p.split("/")[1] } : null }));
  } else process.stdout.write(JSON.stringify({ defaultBranchRef: { name: e.FAKE_GH_DEFAULT || "main" } }));
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "list") {
  if (e.FAKE_GH_LIST_FAIL) { process.stderr.write("list failed"); process.exit(1); }
  const u = e.FAKE_GH_EXISTING_PR;
  process.stdout.write(JSON.stringify(u ? [{ url: u, headRepositoryOwner: { login: e.FAKE_GH_EXISTING_OWNER || "icey2488" } }] : []));
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "create") {
  const bf = flag("body-file");
  if (bf && e.FAKE_GH_BODY_OUT) fs.copyFileSync(bf, e.FAKE_GH_BODY_OUT);
  if (e.FAKE_GH_CREATE === "fail") { process.stderr.write("GraphQL: Resource not accessible by personal access token (createPullRequest)"); process.exit(1); }
  const repo = flag("repo");
  process.stdout.write("https://github.com/" + repo + "/pull/42\\n");
  process.exit(0);
}
process.stderr.write("fake gh: unexpected argv " + JSON.stringify(a)); process.exit(3);
`);
// git wrapper: logs argv then runs the real git with the same argv (no shell).
fs.writeFileSync(GIT_WRAP, `
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(a) + "\\n");
const r = spawnSync(process.env.REAL_GIT || "git", a, { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`);

const REAL_GIT = (() => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" });
  return (r.stdout || "").split(/\r?\n/)[0].trim() || "git";
})();

const baseEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|GH_|GITHUB_|PUBLISH_|FAKE_GH_|CLAUDE_ASYNC_JOB_ID$)/i.test(k)) env[k] = v;
  return { ...env, HOME, USERPROFILE: HOME, PUBLISH_ALLOWED_ROOTS: ROOT, PUBLISH_ALLOWED_OWNERS: "icey2488",
    PUBLISH_AUDIT_LOG: AUDIT, PUBLISH_GH_BIN: JSON.stringify([process.execPath, FAKE_GH]),
    PUBLISH_GIT_BIN: JSON.stringify([process.execPath, GIT_WRAP]), REAL_GIT, FAKE_GH_LOG: GH_LOG, FAKE_GIT_LOG: GIT_LOG };
};
// Test-side git (setup only): isolated HOME so the developer's global config can't leak in.
const tgit = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com",
  "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
  { cwd, encoding: "utf8", env: { ...baseEnv(), GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();

let n = 0;
// Creates <parent>/repoN with one commit on main pushed to a fresh bare repo, origin set to
// https://github.com/<owner>/<name>.git rewritten to the bare via insteadOf, origin/HEAD -> main,
// then checks out `branch` with one more commit.
function makeRepo({ branch = "feat/thing", owner = "icey2488", name = "x", parent = ROOT, originUrl } = {}) {
  n++;
  const bare = path.join(BARES, `b${n}.git`);
  tgit(TMP, "init", "--bare", "-q", bare);
  const dir = path.join(parent, `repo${n}`);
  fs.mkdirSync(dir, { recursive: true });
  tgit(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  tgit(dir, "add", ".");
  tgit(dir, "commit", "-q", "-m", "init");
  const url = originUrl || `https://github.com/${owner}/${name}.git`;
  tgit(dir, "remote", "add", "origin", url);
  tgit(dir, "config", `url.${bare}.insteadOf`, url);
  tgit(dir, "push", "-q", "origin", "main");
  tgit(dir, "fetch", "-q", "origin");
  tgit(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  if (branch) {
    tgit(dir, "checkout", "-q", "-b", branch);
    fs.writeFileSync(path.join(dir, "change.txt"), "change\n");
    tgit(dir, "add", ".");
    tgit(dir, "commit", "-q", "-m", "Add the thing");
  }
  return { dir, bare };
}
const trust = (bare) => (u) => path.resolve(u) === path.resolve(bare);
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearLogs = () => { for (const f of [GH_LOG, GIT_LOG]) fs.rmSync(f, { force: true }); };
const bareHasBranch = (bare, b) => spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${b}`]).status === 0;

async function pub(args, { env = {}, bare } = {}) {
  clearLogs();
  return pb.publish(args, { env: { ...baseEnv(), ...env }, tmpDir: OSTMP, trustExpandedUrl: bare ? trust(bare) : undefined });
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ------------------------------------------------------------------------ pure validators ---

test("validateBranchName: accepts the strict pattern only", () => {
  for (const ok of ["feat/publish-script", "fix/a", "docs/x.y_z-1", "perf/0abc"]) assert.equal(pb.validateBranchName(ok), null, ok);
  for (const bad of ["main", "master", "MAIN", "feat/a..b", "feat/x.lock", "feat/Upper", "Feat/x", "feature/x",
    "feat/", "feat/-x", "feat/.x", "feat/a/b", "feat/a;rm -rf", "feat/$(id)", "feat/`id`", "feat/a&b", "feat/a|b",
    "feat/a b", "feat/a\nb", "feat/x.", "wip", "", "feat/" + "a".repeat(82)]) {
    assert.ok(pb.validateBranchName(bad), `should refuse ${JSON.stringify(bad)}`);
  }
});

test("parseGithubRemote: github.com https/ssh only, no userinfo, no other hosts", () => {
  assert.deepEqual(pb.parseGithubRemote("https://github.com/icey2488/claude-async.git"), { owner: "icey2488", repo: "claude-async" });
  assert.deepEqual(pb.parseGithubRemote("https://github.com/icey2488/claude-async"), { owner: "icey2488", repo: "claude-async" });
  assert.deepEqual(pb.parseGithubRemote("git@github.com:icey2488/x.git"), { owner: "icey2488", repo: "x" });
  assert.deepEqual(pb.parseGithubRemote("ssh://git@github.com/icey2488/x.git"), { owner: "icey2488", repo: "x" });
  for (const bad of ["https://gitlab.com/icey2488/x.git", "https://github.com.evil.com/icey2488/x.git",
    "https://github.com@evil.com/icey2488/x.git", "https://user:tok@github.com/icey2488/x.git", "http://github.com/icey2488/x.git",
    "git@evil.com:icey2488/x.git", "/srv/git/x.git", "file:///srv/x.git", "https://github.com/icey2488/x/extra",
    "https://github.com/icey2488/x.git?a=b", "ext::sh -c id", "https://github.com/-bad/x.git", "https://github.com/icey2488/..", ""]) {
    assert.equal(pb.parseGithubRemote(bad), null, bad);
  }
});

test("owners, roots, upstream, title validators", () => {
  assert.deepEqual(pb.parseAllowedOwners(undefined), ["icey2488"]);
  assert.deepEqual(pb.parseAllowedOwners("a, b"), ["a", "b"]);
  assert.ok(pb.isOwnerAllowed("ICEY2488", ["icey2488"]));
  assert.ok(!pb.isOwnerAllowed("someoneelse", ["icey2488"]));
  assert.deepEqual(pb.parseAllowedRoots(undefined, "win32"), ["D:\\code"]);
  assert.deepEqual(pb.parseAllowedRoots(undefined, "linux"), []);
  assert.deepEqual(pb.parseAllowedRoots("D:\\code;E:\\work;relative", "win32"), ["D:\\code", "E:\\work"]);
  assert.ok(pb.isInside("D:\\code", "d:\\CODE\\claude-async", "win32"));
  assert.ok(!pb.isInside("D:\\code", "D:\\code-evil\\x", "win32"));
  assert.ok(!pb.isInside("D:\\code", "C:\\code\\x", "win32"));
  assert.ok(pb.isInside("/srv/code", "/srv/code/a", "linux"));
  assert.ok(!pb.isInside("/srv/code", "/srv/code/../etc", "linux"));
  assert.deepEqual(pb.validateUpstream("anthropics/claude-code"), { owner: "anthropics", repo: "claude-code" });
  for (const bad of ["x", "a/b/c", "a/..", "-a/b", "a b/c", "a/b;id"]) assert.ok(pb.validateUpstream(bad).error, bad);
  assert.equal(pb.validateTitle("Fix the thing"), null);
  assert.ok(pb.validateTitle(""));
  assert.ok(pb.validateTitle("a\nb"));
  assert.ok(pb.validateTitle("x".repeat(pb.TITLE_MAX + 1)));
});

test("parseArgs: rejects unknown, duplicate, and valueless args", () => {
  assert.deepEqual(pb.parseArgs(["--repo", "r", "--draft", "--title=t"]), { repo: "r", title: "t", draft: true, dryRun: false });
  for (const bad of [[], ["--repo"], ["--repo", "a", "--repo", "b"], ["--repo", "a", "--force"], ["--repo", "a", "--draft=1"], ["--repo", "a", "extra"]]) {
    assert.throws(() => pb.parseArgs(bad), (e) => e.code === pb.EXIT.USAGE, JSON.stringify(bad));
  }
});

test("push argv: exact refspec, and the guard rejects every force/mirror/all/tags/no-verify variant", () => {
  const argv = pb.buildPushArgv("feat/x");
  assert.equal(argv[argv.length - 1], "HEAD:refs/heads/feat/x");
  assert.ok(argv.includes("--set-upstream"));
  for (const a of argv) assert.ok(!/force|mirror|^--all$|^--tags$|no-verify|^\+/.test(a), a);
  const variants = [["--force"], ["-f"], ["--force-with-lease"], ["--force-with-lease=x"], ["--mirror"], ["--all"], ["--tags"],
    ["--no-verify"], ["--delete"], ["-fu"]];
  for (const v of variants) {
    assert.throws(() => pb.assertSafePushArgv(["push", ...v, "origin", "HEAD:refs/heads/feat/x"], "feat/x"), String(v));
  }
  assert.throws(() => pb.assertSafePushArgv(["push", "origin", "+HEAD:refs/heads/feat/x"], "feat/x"));
  assert.throws(() => pb.assertSafePushArgv(["push", "origin", "HEAD:refs/heads/main"], "feat/x"));
  assert.throws(() => pb.assertSafePushArgv(["push", "evil", "HEAD:refs/heads/feat/x"], "feat/x"));
});

test("childEnv strips GIT_*/GH_REPO/GH_HOST, keeps tokens for gh, disables prompts", () => {
  const e = pb.childEnv({ PATH: "p", GIT_DIR: "/x", GIT_CONFIG_COUNT: "1", GH_REPO: "a/b", GH_HOST: "evil", GH_TOKEN: "t" });
  assert.equal(e.GIT_DIR, undefined); assert.equal(e.GIT_CONFIG_COUNT, undefined);
  assert.equal(e.GH_REPO, undefined); assert.equal(e.GH_HOST, undefined);
  assert.equal(e.GH_TOKEN, "t"); assert.equal(e.GIT_TERMINAL_PROMPT, "0"); assert.equal(e.PATH, "p");
});

test("compare URL shapes", () => {
  assert.equal(pb.buildCompareUrl({ baseOwner: "icey2488", baseRepo: "x", baseBranch: "main", headOwner: "icey2488", branch: "feat/a" }),
    "https://github.com/icey2488/x/compare/main...feat/a?expand=1");
  assert.equal(pb.buildCompareUrl({ baseOwner: "up", baseRepo: "y", baseBranch: "dev", headOwner: "icey2488", branch: "fix/b", crossRepo: true }),
    "https://github.com/up/y/compare/dev...icey2488:fix/b?expand=1");
});

// ------------------------------------------------------------------------------- end to end ---

test("success: pushes exactly HEAD:refs/heads/<branch>, creates a PR, audits", async () => {
  const { dir, bare } = makeRepo();
  const head = tgit(dir, "rev-parse", "HEAD");
  const before = readJsonl(AUDIT).length;
  const { result, exitCode } = await pub(["--repo", dir, "--title", "My PR", "--draft"], { bare, env: { CLAUDE_ASYNC_JOB_ID: "job-123" } });
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.branch, "feat/thing");
  assert.equal(result.commit, head);
  assert.equal(result.pushedTo, "icey2488/x");
  assert.equal(result.prUrl, "https://github.com/icey2488/x/pull/42");
  assert.equal(result.prStatus, "created");
  assert.ok(bareHasBranch(bare, "feat/thing"));
  assert.equal(execFileSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/feat/thing"], { encoding: "utf8" }).trim(), head);
  const pushes = readJsonl(GIT_LOG).filter((a) => a.includes("push"));
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].slice(-2), ["origin", "HEAD:refs/heads/feat/thing"]);
  for (const a of [...pushes.flat(), ...readJsonl(GH_LOG).flat()]) {
    assert.ok(!/^(--force|-f$|--force-with-lease|--mirror$|--all$|--tags$|--no-verify$|\+)/.test(a), `forbidden arg ${a}`);
  }
  const create = readJsonl(GH_LOG).find((a) => a[0] === "pr" && a[1] === "create");
  assert.deepEqual(create, ["pr", "create", "--repo=icey2488/x", "--base=main", "--head=feat/thing", "--title=My PR", "--body=", "--draft"]);
  const audit = readJsonl(AUDIT);
  assert.equal(audit.length, before + 1);
  const last = audit[audit.length - 1];
  assert.equal(last.result, "ok"); assert.equal(last.action, "publish"); assert.equal(last.jobId, "job-123");
  assert.equal(last.branch, "feat/thing"); assert.equal(last.commit, head); assert.equal(last.prUrl, result.prUrl);
  assert.ok(!JSON.stringify(last).includes("PATH"), "audit line must not carry the environment");
});

test("title defaults to the HEAD commit subject; body file is passed as a private copy", async () => {
  const { dir, bare } = makeRepo();
  const body = path.join(dir, "pr-body.md");
  fs.writeFileSync(body, "Body text\n");
  fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), "pr-body.md\n");
  const out = path.join(TMP, `body-seen-${n}.md`);
  const { result, exitCode } = await pub(["--repo", dir, "--body-file", body], { bare, env: { FAKE_GH_BODY_OUT: out } });
  assert.equal(exitCode, 0, JSON.stringify(result));
  const create = readJsonl(GH_LOG).find((a) => a[1] === "create");
  assert.ok(create.includes("--title=Add the thing"));
  const bf = create.find((a) => a.startsWith("--body-file=")).slice("--body-file=".length);
  assert.notEqual(path.resolve(bf), path.resolve(body), "gh must read a private copy, not the job-controlled path");
  assert.equal(fs.readFileSync(out, "utf8"), "Body text\n");
  assert.ok(!fs.existsSync(bf), "private copy is cleaned up");
});

test("idempotent: an existing open PR is returned, no second create", async () => {
  const { dir, bare } = makeRepo();
  const url = "https://github.com/icey2488/x/pull/7";
  const { result, exitCode } = await pub(["--repo", dir], { bare, env: { FAKE_GH_EXISTING_PR: url } });
  assert.equal(exitCode, 0);
  assert.equal(result.prUrl, url);
  assert.equal(result.prStatus, "existing");
  assert.ok(!readJsonl(GH_LOG).some((a) => a[1] === "create"));
});

test("PR creation failure still succeeds on the push and returns the compare URL", async () => {
  const { dir, bare } = makeRepo();
  const { result, exitCode } = await pub(["--repo", dir], { bare, env: { FAKE_GH_CREATE: "fail" } });
  assert.equal(exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.prUrl, null);
  assert.equal(result.prStatus, "compare_fallback");
  assert.equal(result.compareUrl, "https://github.com/icey2488/x/compare/main...feat/thing?expand=1");
  assert.ok(result.warnings.some((w) => /gh pr create failed/.test(w)));
  assert.ok(bareHasBranch(bare, "feat/thing"));
  assert.equal(readJsonl(AUDIT).at(-1).prStatus, "compare_fallback");
});

test("upstream: allowed only when gh reports origin is a fork of exactly that repo", async () => {
  const { dir, bare } = makeRepo();
  const ok = await pub(["--repo", dir, "--upstream", "anthropics/claude-code"], { bare, env: { FAKE_GH_PARENT: "anthropics/claude-code", FAKE_GH_DEFAULT: "dev" } });
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.result));
  const create = readJsonl(GH_LOG).find((a) => a[1] === "create");
  assert.ok(create.includes("--repo=anthropics/claude-code"));
  assert.ok(create.includes("--head=icey2488:feat/thing"));
  assert.ok(create.includes("--base=dev"));

  const r2 = makeRepo();
  const bad = await pub(["--repo", r2.dir, "--upstream", "anthropics/other"], { bare: r2.bare, env: { FAKE_GH_PARENT: "anthropics/claude-code" } });
  assert.equal(bad.exitCode, pb.EXIT.UPSTREAM_REFUSED);
  assert.match(bad.result.errors[0], /not a fork of anthropics\/other/);
  assert.ok(!bareHasBranch(r2.bare, "feat/thing"), "refused before pushing");

  const r3 = makeRepo();
  const none = await pub(["--repo", r3.dir, "--upstream", "anthropics/claude-code"], { bare: r3.bare, env: { FAKE_GH_PARENT: "" } });
  assert.equal(none.exitCode, pb.EXIT.UPSTREAM_REFUSED);
  const malformed = await pub(["--repo", r3.dir, "--upstream", "a/b;id"], { bare: r3.bare });
  assert.equal(malformed.exitCode, pb.EXIT.UPSTREAM_REFUSED);
});

test("refuses main, master, and the default branch from origin/HEAD", async () => {
  const m = makeRepo({ branch: null });
  const r1 = await pub(["--repo", m.dir], { bare: m.bare });
  assert.equal(r1.exitCode, pb.EXIT.BRANCH_REFUSED);
  tgit(m.dir, "checkout", "-q", "-b", "master");
  assert.equal((await pub(["--repo", m.dir], { bare: m.bare })).exitCode, pb.EXIT.BRANCH_REFUSED);
  // default branch that is NOT main/master but does match the pattern
  const d = makeRepo({ branch: "chore/trunk" });
  tgit(d.dir, "push", "-q", "origin", "chore/trunk");
  tgit(d.dir, "fetch", "-q", "origin");
  tgit(d.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/chore/trunk");
  const r3 = await pub(["--repo", d.dir], { bare: d.bare });
  assert.equal(r3.exitCode, pb.EXIT.BRANCH_REFUSED);
  assert.match(r3.result.errors[0], /default branch/);
  assert.equal(readJsonl(GH_LOG).length, 0);
});

test("refuses detached HEAD", async () => {
  const { dir, bare } = makeRepo();
  tgit(dir, "checkout", "-q", "--detach");
  const r = await pub(["--repo", dir], { bare });
  assert.equal(r.exitCode, pb.EXIT.BRANCH_REFUSED);
  assert.match(r.result.errors[0], /detached/);
});

// ".." and ".lock" are refused by git itself before a branch can exist (covered by the pure
// validateBranchName test above); these are names git accepts but the script must not.
test("refuses bad branch names (uppercase, shell metacharacters, wrong type)", async () => {
  for (const b of ["feat/Upper", "feat/a$b", "feat/a;b", "feat/a&b", "feat/a`b`", "feat/a|b", "feat/a(b)", "wip/x", "feat/x/y"]) {
    const { dir, bare } = makeRepo({ branch: b });
    const r = await pub(["--repo", dir], { bare });
    assert.equal(r.exitCode, pb.EXIT.BRANCH_REFUSED, b);
    assert.ok(!bareHasBranch(bare, b));
  }
});

test("refuses a dirty tree: modified, staged, or untracked-not-ignored; ignored files are fine", async () => {
  const { dir, bare } = makeRepo();
  fs.writeFileSync(path.join(dir, "ignored.txt"), "x");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "x");
  assert.equal((await pub(["--repo", dir, "--dry-run"], { bare })).exitCode, pb.EXIT.DIRTY_TREE);
  fs.rmSync(path.join(dir, "untracked.txt"));
  fs.appendFileSync(path.join(dir, "README.md"), "more\n");
  assert.equal((await pub(["--repo", dir, "--dry-run"], { bare })).exitCode, pb.EXIT.DIRTY_TREE);
  tgit(dir, "add", "README.md");
  assert.equal((await pub(["--repo", dir, "--dry-run"], { bare })).exitCode, pb.EXIT.DIRTY_TREE);
  tgit(dir, "commit", "-q", "-m", "more");
  assert.equal((await pub(["--repo", dir, "--dry-run"], { bare })).exitCode, 0, "ignored file alone does not block");
});

test("refuses a repo outside the allowed roots, including via a symlink/junction inside a root", async () => {
  const out = makeRepo({ parent: OUTSIDE });
  const r1 = await pub(["--repo", out.dir], { bare: out.bare });
  assert.equal(r1.exitCode, pb.EXIT.REPO_REFUSED);
  const link = path.join(ROOT, `link-${n}`);
  fs.symlinkSync(out.dir, link, process.platform === "win32" ? "junction" : "dir");
  const r2 = await pub(["--repo", link], { bare: out.bare });
  assert.equal(r2.exitCode, pb.EXIT.REPO_REFUSED);
  assert.match(r2.result.errors[0], /outside the allowed roots/);
  const r3 = await pub(["--repo", path.join(ROOT, "nope")]);
  assert.equal(r3.exitCode, pb.EXIT.REPO_REFUSED);
  const r4 = await pub(["--repo", ROOT], { env: { PUBLISH_ALLOWED_ROOTS: path.join(TMP, "missing-root") } });
  assert.equal(r4.exitCode, pb.EXIT.REPO_REFUSED);
  assert.ok(!bareHasBranch(out.bare, "feat/thing"));
});

test("refuses origin owned by someone else, non-GitHub origin, and a mismatched pushurl", async () => {
  const other = makeRepo({ owner: "someoneelse" });
  const r1 = await pub(["--repo", other.dir], { bare: other.bare });
  assert.equal(r1.exitCode, pb.EXIT.REMOTE_REFUSED);
  assert.match(r1.result.errors[0], /owner "someoneelse"/);
  const gl = makeRepo({ originUrl: "https://gitlab.com/icey2488/x.git" });
  assert.equal((await pub(["--repo", gl.dir], { bare: gl.bare })).exitCode, pb.EXIT.REMOTE_REFUSED);
  const pu = makeRepo();
  tgit(pu.dir, "config", "remote.origin.pushurl", "https://github.com/someoneelse/x.git");
  assert.equal((await pub(["--repo", pu.dir], { bare: pu.bare })).exitCode, pb.EXIT.REMOTE_REFUSED);
  for (const r of [other, gl, pu]) assert.ok(!bareHasBranch(r.bare, "feat/thing"));
});

test("refuses an insteadOf rewrite that points a github.com origin somewhere else", async () => {
  const { dir, bare } = makeRepo();
  const r = await pub(["--repo", dir]); // no trust seam: production behavior
  assert.equal(r.exitCode, pb.EXIT.REMOTE_REFUSED);
  assert.match(r.result.errors[0], /rewritten/);
  assert.ok(!bareHasBranch(bare, "feat/thing"));
});

test("body file: must be inside the repo or OS temp dir, regular, under the size cap", async () => {
  const { dir, bare } = makeRepo();
  fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), "*.md\n!README.md\n");
  const outside = path.join(OUTSIDE, `body-${n}.md`);
  fs.writeFileSync(outside, "x");
  assert.equal((await pub(["--repo", dir, "--body-file", outside, "--dry-run"], { bare })).exitCode, pb.EXIT.INPUT_REFUSED);
  const big = path.join(dir, "big.md");
  fs.writeFileSync(big, "x".repeat(pb.BODY_MAX_BYTES + 1));
  assert.equal((await pub(["--repo", dir, "--body-file", big, "--dry-run"], { bare })).exitCode, pb.EXIT.INPUT_REFUSED);
  const sneaky = path.join(dir, "sneaky.md");
  let linked = true;
  try { fs.symlinkSync(outside, sneaky, "file"); } catch { linked = false; } // win32 file symlinks need Developer Mode
  if (linked) assert.equal((await pub(["--repo", dir, "--body-file", sneaky, "--dry-run"], { bare })).exitCode, pb.EXIT.INPUT_REFUSED);
  assert.equal((await pub(["--repo", dir, "--body-file", path.join(dir, ".git"), "--dry-run"], { bare })).exitCode, pb.EXIT.INPUT_REFUSED);
  const tmpBody = path.join(OSTMP, `body-${n}.md`);
  fs.writeFileSync(tmpBody, "ok");
  assert.equal((await pub(["--repo", dir, "--body-file", tmpBody, "--dry-run"], { bare })).exitCode, 0, "temp-dir body allowed");
  const inRepo = path.join(dir, "notes.md");
  fs.writeFileSync(inRepo, "ok");
  assert.equal((await pub(["--repo", dir, "--body-file", inRepo, "--dry-run"], { bare })).exitCode, 0, "in-repo body allowed");
  assert.equal((await pub(["--repo", dir, "--title", "x".repeat(300), "--dry-run"], { bare })).exitCode, pb.EXIT.INPUT_REFUSED);
  assert.equal((await pub(["--repo", dir, "--title", "a\nb", "--dry-run"], { bare })).exitCode, pb.EXIT.INPUT_REFUSED);
});

test("dry run: validates, prints the exact argv, pushes nothing, never calls gh", async () => {
  const { dir, bare } = makeRepo();
  const { result, exitCode } = await pub(["--repo", dir, "--dry-run", "--title", "T"], { bare });
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.dryRun, true);
  assert.equal(readJsonl(GH_LOG).length, 0, "dry run must not invoke gh");
  assert.ok(!readJsonl(GIT_LOG).some((a) => a.includes("push")), "dry run must not invoke git push");
  assert.ok(!bareHasBranch(bare, "feat/thing"));
  const push = result.plannedCommands.find((c) => c.bin === "git");
  assert.deepEqual(push.argv, ["-C", fs.realpathSync.native(dir), ...pb.buildPushArgv("feat/thing")]);
  assert.ok(result.plannedCommands.some((c) => c.bin === "gh" && c.argv[1] === "create"));
  for (const c of result.plannedCommands) for (const a of c.argv) assert.ok(!/^(--force|--mirror$|--all$|--tags$|--no-verify$)/.test(a), a);
  assert.equal(readJsonl(AUDIT).at(-1).action, "dry-run");
});

test("audit log records refused attempts too, and an unwritable audit log refuses to publish", async () => {
  const { dir, bare } = makeRepo({ branch: null });
  const before = readJsonl(AUDIT).length;
  await pub(["--repo", dir], { bare, env: { CLAUDE_ASYNC_JOB_ID: "job-refused" } });
  const audit = readJsonl(AUDIT);
  assert.equal(audit.length, before + 1);
  assert.equal(audit.at(-1).result, "refused");
  assert.equal(audit.at(-1).jobId, "job-refused");
  assert.equal(audit.at(-1).branch, "main");
  assert.ok(audit.at(-1).errors.length > 0);
  const blocker = path.join(TMP, `notadir-${n}`);
  fs.writeFileSync(blocker, "");
  const ok = makeRepo();
  const r = await pub(["--repo", ok.dir], { bare: ok.bare, env: { PUBLISH_AUDIT_LOG: path.join(blocker, "audit.jsonl") } });
  assert.equal(r.exitCode, pb.EXIT.AUDIT_FAILED);
  assert.ok(!bareHasBranch(ok.bare, "feat/thing"));
});

test("audit log never contains tokens", async () => {
  const { dir, bare } = makeRepo();
  await pub(["--repo", dir], { bare, env: { GH_TOKEN: "ghp_SECRETSECRET", GITHUB_TOKEN: "ghs_SECRET2" } });
  assert.ok(!fs.readFileSync(AUDIT, "utf8").includes("SECRET"));
});

// ------------------------------------------------------------------------------------- CLI ---

function cli(args, env = {}) {
  clearLogs();
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...baseEnv(), ...env }, encoding: "utf8" });
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must be exactly one JSON line, got: ${r.stdout}`);
  return { status: r.status, json: JSON.parse(lines[0]) };
}

test("CLI: one JSON object on stdout with a distinct exit code per refusal class", () => {
  const usage = cli(["--nope"]);
  assert.equal(usage.status, pb.EXIT.USAGE);
  assert.equal(usage.json.ok, false);
  const { dir } = makeRepo({ branch: "feat/BAD" });
  const br = cli(["--repo", dir]);
  assert.equal(br.status, pb.EXIT.BRANCH_REFUSED);
  for (const k of ["ok", "branch", "commit", "pushedTo", "prUrl", "compareUrl", "dryRun", "errors"]) assert.ok(k in br.json, k);
  assert.equal(new Set(Object.values(pb.EXIT)).size, Object.keys(pb.EXIT).length, "exit codes are distinct");
});

test("CLI: the trust seam is unreachable, so a locally-rewritten origin is refused", () => {
  const { dir, bare } = makeRepo();
  const r = cli(["--repo", dir]);
  assert.equal(r.status, pb.EXIT.REMOTE_REFUSED);
  assert.ok(!bareHasBranch(bare, "feat/thing"));
  const dry = cli(["--repo", dir, "--dry-run"]);
  assert.equal(dry.status, pb.EXIT.REMOTE_REFUSED);
});
