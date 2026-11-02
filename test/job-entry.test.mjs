// container/job-entry.sh (the image's entrypoint) against a LOCAL bare repo: the clone URL
// https://github.com/<owner/repo>.git is rewritten to a file:// path with git's url.insteadOf, so
// no network and no token are involved. Covers baseRef resolution (round 2, N1): a branch, a tag
// and an abbreviated commit SHA resolve locally in the fresh clone; refs/pull/N/head (GitHub's
// fork-network objects, not on any branch of the repo), a full SHA that is not in the clone, and an
// unknown name exit 70; nothing is ever fetched for baseRef.
// Run: node --test test/job-entry.test.mjs   (POSIX only: bash + git)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "..", "container", "job-entry.sh");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-job-entry-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const have = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
const SKIP = process.platform === "win32" ? "bash entrypoint" : (!have("bash") || !have("git")) ? "needs bash and git" : false;

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// <TMP>/remotes/owner/repo.git: main (2 commits), branch dev, tag v1 (= first commit), and
// refs/pull/1/head pointing at a commit on no branch (what a fork's PR head looks like upstream).
let remoteSeq = 0;
function makeRemote() {
  const base = path.join(TMP, `remote-${++remoteSeq}`);
  const work = path.join(base, "work"); fs.mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "a.txt"), "one\n"); git(work, "add", "."); git(work, "commit", "-q", "-m", "one");
  const first = git(work, "rev-parse", "HEAD");
  git(work, "tag", "v1");
  fs.writeFileSync(path.join(work, "a.txt"), "two\n"); git(work, "commit", "-q", "-am", "two");
  const second = git(work, "rev-parse", "HEAD");
  git(work, "branch", "dev");
  // the "fork" commit: created on a detached head, then only referenced from refs/pull/1/head
  git(work, "checkout", "-q", "--detach", first);
  fs.writeFileSync(path.join(work, "evil.txt"), "from a fork\n"); git(work, "add", "."); git(work, "commit", "-q", "-m", "fork");
  const fork = git(work, "rev-parse", "HEAD");
  git(work, "update-ref", "refs/pull/1/head", fork);
  git(work, "checkout", "-q", "main");
  const remotes = path.join(base, "remotes", "owner"); fs.mkdirSync(remotes, { recursive: true });
  const bare = path.join(remotes, "repo.git");
  git(base, "clone", "-q", "--bare", work, bare);
  git(bare, "update-ref", "refs/pull/1/head", fork); // --bare clone does not carry refs/pull
  return { first, second, fork, remotesRoot: path.join(base, "remotes") };
}

let n = 0;
function runEntry(remote, baseRef) {
  const ws = path.join(TMP, `ws-${++n}`); fs.mkdirSync(ws);
  const gcfg = path.join(TMP, `gitconfig-${n}`);
  fs.writeFileSync(gcfg, `[url "file://${remote.remotesRoot}/"]\n\tinsteadOf = https://github.com/\n`);
  const r = spawnSync("bash", [ENTRY, "owner/repo", baseRef, "--", "sh", "-c", "git rev-parse HEAD; git rev-parse --abbrev-ref HEAD; git remote -v"],
    { encoding: "utf8", env: { ...process.env, GH_TOKEN: "x", GIT_CONFIG_GLOBAL: gcfg, CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: ws, GIT_TERMINAL_PROMPT: "0" } });
  return { status: r.status, out: r.stdout, err: r.stderr, ws };
}

test("job-entry: a branch, a tag and an abbreviated SHA resolve locally in the clone; nothing is fetched", { skip: SKIP }, () => {
  const remote = makeRemote();
  const def = runEntry(remote, "");
  assert.equal(def.status, 0, def.err);
  assert.match(def.out, new RegExp(`^${remote.second}\\nmain\\n`));
  const dev = runEntry(remote, "dev");
  assert.equal(dev.status, 0, dev.err);
  assert.match(dev.out, new RegExp(`^${remote.second}\\nHEAD\\n`), "detached at origin/dev");
  assert.match(dev.err, /at dev \([0-9a-f]{7,}\), detached/);
  const tag = runEntry(remote, "v1");
  assert.equal(tag.status, 0, tag.err);
  assert.match(tag.out, new RegExp(`^${remote.first}\\n`));
  const short = runEntry(remote, remote.first.slice(0, 8));
  assert.equal(short.status, 0, short.err);
  assert.match(short.out, new RegExp(`^${remote.first}\\n`), "an 8-char SHA checks out that commit");
  for (const r of [def, dev, tag, short]) assert.ok(!/fetch/.test(r.err), `no fetch for baseRef: ${r.err}`);
});

test("job-entry: refs/pull/N/head, a SHA not in the clone, and an unknown name exit 70 (never fetched from the fork network)", { skip: SKIP }, () => {
  const remote = makeRemote();
  for (const ref of ["refs/pull/1/head", remote.fork, remote.fork.slice(0, 12), "nope", "refs/heads/main"]) {
    const r = runEntry(remote, ref);
    assert.equal(r.status, 70, `${ref}: ${r.err}`);
    assert.match(r.err, /not found in owner\/repo|checkout of/);
    assert.ok(!fs.existsSync(path.join(r.ws, "evil.txt")), "the fork commit never landed in the workspace");
  }
  // the clone itself never received the fork object
  const ok = runEntry(remote, "main");
  const has = spawnSync("git", ["cat-file", "-e", remote.fork], { cwd: ok.ws });
  assert.notEqual(has.status, 0, "refs/pull objects are not in the clone");
});

test("job-entry: usage and configuration exits are unchanged (64 bad names, 78 no GH_TOKEN / non-empty workspace)", { skip: SKIP }, () => {
  const remote = makeRemote();
  const env = (extra) => ({ ...process.env, GH_TOKEN: "x", ...extra });
  const bad = spawnSync("bash", [ENTRY, "owner/repo", "-x", "--", "true"], { encoding: "utf8", env: env({ CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: path.join(TMP, "e1") }) });
  assert.equal(bad.status, 64);
  const ws = path.join(TMP, "e2"); fs.mkdirSync(ws);
  const noTok = spawnSync("bash", [ENTRY, "owner/repo", "", "--", "true"], { encoding: "utf8", env: { ...process.env, GH_TOKEN: "", CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: ws } });
  assert.equal(noTok.status, 78);
  fs.writeFileSync(path.join(ws, "junk"), "");
  const full = spawnSync("bash", [ENTRY, "owner/repo", "", "--", "true"], { encoding: "utf8", env: env({ CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: ws }) });
  assert.equal(full.status, 78);
  assert.ok(remote);
});
