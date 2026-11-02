// container/job-entry.sh (the image's entrypoint) against a LOCAL bare repo: the clone URL
// https://github.com/<owner/repo>.git is rewritten to a file:// path with git's url.insteadOf, so
// no network and no token are involved. Covers baseRef resolution (round 2, N1): a branch, a tag
// and an abbreviated commit SHA resolve locally in the fresh clone; refs/pull/N/head (GitHub's
// fork-network objects, not on any branch of the repo), a full SHA that is not in the clone, and an
// unknown name exit 70; nothing is ever fetched for baseRef. Also the image's two credential
// scripts, run from the checkout: container/git-credential.sh (git's helper for https://github.com,
// reads the installation token file) and container/gh-wrapper.sh (/usr/local/bin/gh in the image:
// exports GH_TOKEN from the file for the exec'd gh only, so the job's environment never carries it).
// Run: node --test test/job-entry.test.mjs   (POSIX only: bash + git)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, "..", "container", "job-entry.sh");
const CRED_HELPER = path.join(here, "..", "container", "git-credential.sh");
const GH_WRAPPER = path.join(here, "..", "container", "gh-wrapper.sh");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-job-entry-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const have = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
const SKIP = process.platform === "win32" ? "bash entrypoint" : (!have("bash") || !have("git")) ? "needs bash and git" : false;
// The token file the host runner would have bind-mounted at /run/claude-async/creds/token.
const TOKEN = "ghs_ENTRYTESTTOKEN0000000000000000000000";
const CREDS = path.join(TMP, "creds", "token");
fs.mkdirSync(path.dirname(CREDS), { recursive: true });
fs.writeFileSync(CREDS, `${TOKEN}\n`);

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
    { encoding: "utf8", env: { ...process.env, GH_TOKEN: undefined, CLAUDE_ASYNC_CREDS_FILE: CREDS, GIT_CONFIG_GLOBAL: gcfg, CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: ws, GIT_TERMINAL_PROMPT: "0" } });
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

test("job-entry: a SHA not in the clone and an unknown name exit 70 (never fetched from the fork network)", { skip: SKIP }, () => {
  const remote = makeRemote();
  for (const ref of [remote.fork, remote.fork.slice(0, 12), "nope"]) {
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

test("job-entry: usage and configuration exits (64 bad names, 78 no token file / non-empty workspace); GH_TOKEN in the env is not what it checks", { skip: SKIP }, () => {
  const remote = makeRemote();
  const env = (extra) => ({ ...process.env, GH_TOKEN: undefined, CLAUDE_ASYNC_CREDS_FILE: CREDS, ...extra });
  const bad = spawnSync("bash", [ENTRY, "owner/repo", "-x", "--", "true"], { encoding: "utf8", env: env({ CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: path.join(TMP, "e1") }) });
  assert.equal(bad.status, 64);
  const ws = path.join(TMP, "e2"); fs.mkdirSync(ws);
  const noTok = spawnSync("bash", [ENTRY, "owner/repo", "", "--", "true"], { encoding: "utf8", env: { ...process.env, GH_TOKEN: "ghp_irrelevant", CLAUDE_ASYNC_CREDS_FILE: path.join(TMP, "nope"), CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: ws } });
  assert.equal(noTok.status, 78, "a GH_TOKEN in the environment does not stand in for the token file");
  assert.match(noTok.stderr, /missing or empty/);
  const emptyTok = path.join(TMP, "empty-token"); fs.writeFileSync(emptyTok, "");
  assert.equal(spawnSync("bash", [ENTRY, "owner/repo", "", "--", "true"], { encoding: "utf8", env: env({ CLAUDE_ASYNC_CREDS_FILE: emptyTok, CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: ws }) }).status, 78);
  fs.writeFileSync(path.join(ws, "junk"), "");
  const full = spawnSync("bash", [ENTRY, "owner/repo", "", "--", "true"], { encoding: "utf8", env: env({ CLAUDE_ASYNC_JOB_ENTRY_WORKSPACE: ws }) });
  assert.equal(full.status, 78);
  assert.ok(remote);
});

// ------------------------------------------------------------ the image's credential scripts ---

const helper = (input, extra = {}) => spawnSync("bash", [CRED_HELPER, "get"], { input, encoding: "utf8", env: { ...process.env, CLAUDE_ASYNC_CREDS_FILE: CREDS, ...extra } });

test("git-credential: answers x-access-token + the file's current token for https github.com only; nothing for other hosts, protocols, verbs or a missing file", { skip: SKIP }, () => {
  const ok = helper("protocol=https\nhost=github.com\npath=icey2488/x.git\n\n");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `username=x-access-token\npassword=${TOKEN}\n`);
  for (const input of ["protocol=https\nhost=gitlab.com\n\n", "protocol=http\nhost=github.com\n\n", "protocol=https\nhost=evil.github.com\n\n", "protocol=https\nhost=github.com.evil\n\n"]) {
    const r = helper(input);
    assert.equal(r.status, 0); assert.equal(r.stdout, "", JSON.stringify(input));
  }
  for (const verb of ["store", "erase"]) {
    const r = spawnSync("bash", [CRED_HELPER, verb], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", env: { ...process.env, CLAUDE_ASYNC_CREDS_FILE: CREDS } });
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
  }
  const missing = helper("protocol=https\nhost=github.com\n\n", { CLAUDE_ASYNC_CREDS_FILE: path.join(TMP, "none") });
  assert.equal(missing.status, 0); assert.equal(missing.stdout, "");
  // the current content, not a cached one: rewrite the file in place, ask again
  const t2 = "ghs_ENTRYTESTTOKEN1111111111111111111111";
  fs.writeFileSync(CREDS, `${t2}\n`);
  try { assert.equal(helper("protocol=https\nhost=github.com\n\n").stdout, `username=x-access-token\npassword=${t2}\n`); }
  finally { fs.writeFileSync(CREDS, `${TOKEN}\n`); }
});

test("git-credential: git itself picks the helper up for https://github.com through the credential protocol (credential fill)", { skip: SKIP }, () => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${CRED_HELPER}`, "credential", "fill"],
    { input: "protocol=https\nhost=github.com\npath=icey2488/x.git\n\n", encoding: "utf8",
      env: { ...process.env, CLAUDE_ASYNC_CREDS_FILE: CREDS, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^username=x-access-token$/m);
  assert.match(r.stdout, new RegExp(`^password=${TOKEN}$`, "m"));
});

test("gh wrapper: the real gh sees GH_TOKEN from the file for its own process only; the job's shell environment has no GH_TOKEN; a caller's GH_TOKEN wins", { skip: SKIP }, () => {
  const fakeGh = path.join(TMP, "fake-gh");
  fs.writeFileSync(fakeGh, "#!/bin/sh\necho \"GH_TOKEN=${GH_TOKEN:-<unset>}\"\necho \"argv=$*\"\n");
  fs.chmodSync(fakeGh, 0o755);
  const env = { ...process.env, GH_TOKEN: undefined, CLAUDE_ASYNC_CREDS_FILE: CREDS, CLAUDE_ASYNC_GH_BIN: fakeGh };
  const r = spawnSync("bash", [GH_WRAPPER, "pr", "create", "--base", "main"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `GH_TOKEN=${TOKEN}\nargv=pr create --base main\n`);
  // what a job shell sees: no GH_TOKEN before or after a gh call (the export is in the wrapper's process)
  const shell = spawnSync("bash", ["-c", `"${GH_WRAPPER}" auth status >/dev/null; env | grep -c '^GH_TOKEN=' || true; printenv GH_TOKEN || echo none`], { encoding: "utf8", env });
  assert.equal(shell.stdout, "0\nnone\n", shell.stdout + shell.stderr);
  // a GH_TOKEN the job set deliberately is respected
  const own = spawnSync("bash", [GH_WRAPPER, "x"], { encoding: "utf8", env: { ...env, GH_TOKEN: "ghp_mine" } });
  assert.equal(own.stdout, "GH_TOKEN=ghp_mine\nargv=x\n");
  // no file: gh runs unauthenticated rather than failing in the wrapper
  const none = spawnSync("bash", [GH_WRAPPER, "y"], { encoding: "utf8", env: { ...env, CLAUDE_ASYNC_CREDS_FILE: path.join(TMP, "none") } });
  assert.equal(none.stdout, "GH_TOKEN=<unset>\nargv=y\n");
  // the token is never on the exec'd command line
  const argvCheck = path.join(TMP, "fake-gh-cmdline");
  fs.writeFileSync(argvCheck, "#!/bin/sh\ntr '\\0' ' ' < /proc/$$/cmdline; echo\n");
  fs.chmodSync(argvCheck, 0o755);
  const cl = spawnSync("bash", [GH_WRAPPER, "z"], { encoding: "utf8", env: { ...env, CLAUDE_ASYNC_GH_BIN: argvCheck } });
  assert.ok(!cl.stdout.includes(TOKEN), cl.stdout);
});

// ------------------------------------------------------------ review round 3: C3 and token readers ---
test("C3: job-entry refuses refs / refs/* (any case) with exit 64 before cloning", { skip: SKIP }, () => {
  const remote = makeRemote();
  for (const ref of ["refs/pull/1/head", "refs/heads/main", "REFS/heads/main", "Refs", "refs"]) {
    const r = runEntry(remote, ref);
    assert.equal(r.status, 64, `${ref}: ${r.err}`);
    assert.match(r.err, /invalid base ref/);
    assert.deepEqual(fs.readdirSync(r.ws), [], `${ref}: nothing was cloned`);
  }
  assert.equal(runEntry(remote, "refsfoo").status, 70, "a name that merely starts with refs is a normal (unknown) name");
});

// The token file is published by rename (one complete file at a time), and the readers still refuse
// anything that is not exactly one line holding an installation token: they retry (100 ms, up to 20
// times) and then give up, rather than hand git or gh a torn or foreign value.
const tokenFile = (content) => { const f = path.join(TMP, `tok-${++n}`); fs.writeFileSync(f, content); return f; };
const T2 = "ghs_READERTEST2222222222222222222222222222";
test("readers: a torn file (old suffix on a second line), a non-token and an empty file are retried and then refused", { skip: SKIP }, () => {
  for (const bad of [`${TOKEN}\n0000\n`, "not-a-token\n", "", `ghs_short\n`, `${TOKEN} trailing\n`]) {
    const f = tokenFile(bad);
    const t0 = Date.now();
    const r = helper("protocol=https\nhost=github.com\n\n", { CLAUDE_ASYNC_CREDS_FILE: f });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", `nothing handed to git for ${JSON.stringify(bad)}`);
    assert.match(r.stderr, /not a single valid installation token/);
    assert.ok(Date.now() - t0 >= 1500, "it retried (20 x 100 ms) before giving up");
  }
  const fakeGh = path.join(TMP, "fake-gh-r3");
  fs.writeFileSync(fakeGh, "#!/bin/sh\necho \"GH_TOKEN=${GH_TOKEN:-<unset>}\"\n"); fs.chmodSync(fakeGh, 0o755);
  const g = spawnSync("bash", [GH_WRAPPER, "x"], { encoding: "utf8", env: { ...process.env, GH_TOKEN: undefined, CLAUDE_ASYNC_CREDS_FILE: tokenFile(`${TOKEN}\nxx\n`), CLAUDE_ASYNC_GH_BIN: fakeGh } });
  assert.equal(g.status, 1, "gh is not run with a torn token");
  assert.equal(g.stdout, "");
  assert.match(g.stderr, /not a single valid installation token/);
});

test("readers: a file that becomes valid during the retries is used (the next generation)", { skip: SKIP }, async () => {
  const f = tokenFile(`${TOKEN}\n0000\n`);
  const child = spawn("bash", [CRED_HELPER, "get"], { env: { ...process.env, CLAUDE_ASYNC_CREDS_FILE: f } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stdin.end("protocol=https\nhost=github.com\n\n");
  setTimeout(() => { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, `${T2}\n`); fs.renameSync(tmp, f); }, 400);
  await new Promise((r) => child.on("exit", r));
  assert.equal(out, `username=x-access-token\npassword=${T2}\n`);
});
