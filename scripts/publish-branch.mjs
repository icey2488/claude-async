#!/usr/bin/env node
/**
 * publish-branch.mjs -- the ONE narrow publish action a safe-mode claude-async job may take.
 *
 * Why this exists: under CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS=1 (job-core.mjs's
 * buildSafePermissionsSettings()), `git push *` is on the deny floor and `gh` matches no allow rule,
 * so a job could do the work but never open a PR. Rather than un-denying raw `git push` (which a
 * prefix rule can't constrain: `git push --force`, `git push --mirror`, `git push evil main`...),
 * this script is a fixed, validated action -- the same pattern as the allow-listed Ollama helper and
 * the "elevated runner v2" idea: a job gets one verb with every argument checked, not a shell.
 *
 * What it does (and nothing else):
 *   1. Validates the repo (realpath inside an allowed root), the current branch (not detached, not the
 *      default branch, not main/master, strict name pattern), a clean tree, and the origin remote
 *      (github.com, owner in the allowed-owner list -- fetch AND every push URL, after git's own
 *      insteadOf/pushInsteadOf expansion, so repo config can't redirect the push).
 *      Repo-local (and worktree) git config must use only allowlisted keys, because local config can
 *      run commands or capture credentials during status/push (credential.helper, core.fsmonitor,
 *      core.sshCommand, filter.*, include.*, http.*...). Every git call also runs with
 *      core.fsmonitor=false and core.hooksPath pointed at a nonexistent random dir, so repo hooks never run.
 *   2. Pushes exactly `HEAD:refs/heads/<branch>` to origin with --set-upstream. Never --force,
 *      --force-with-lease, --mirror, --all, --tags, --delete, or --no-verify (assertSafePushArgv()
 *      re-checks the final argv before it runs).
 *   3. Opens a PR with `gh pr create` (same-repo by default; with --upstream, only into the exact
 *      repo `gh repo view` reports as origin's fork parent). Idempotent: an existing open PR for the
 *      branch is returned instead of a second one. If PR creation fails, the push still counts and the
 *      GitHub compare URL is returned so a human can open the PR in one click.
 *
 * Never invokes a shell: every child process is execFile(bin, [args]) with shell:false, so no
 * argument can be interpreted as a command. Output is ONE JSON object on stdout; the exit code says
 * which class of refusal happened (EXIT below). Every attempt, allowed or refused, appends one JSON
 * line to the audit log. See docs/publishing.md for the allow rules, threat model, and rollout.
 *
 * Usage:
 *   node <abs path>/scripts/publish-branch.mjs --repo <path> [--title <t>] [--body-file <f>]
 *        [--upstream <owner/repo>] [--draft] [--dry-run]
 *
 * Environment:
 *   PUBLISH_ALLOWED_ROOTS   path.delimiter-separated roots a repo must live under
 *                           (default: D:\code on win32; none elsewhere, i.e. refuse everything).
 *   PUBLISH_ALLOWED_OWNERS  comma-separated GitHub owners origin may belong to (default: icey2488).
 *   PUBLISH_AUDIT_LOG       audit JSONL path (default: ~/.claude-async-jobs/publish-audit.jsonl).
 *   PUBLISH_GIT_BIN / PUBLISH_GH_BIN
 *                           TEST-ONLY overrides for the git/gh binaries: a path, or a JSON argv array
 *                           (same convention as CLAUNKER_JOBCARD_CMD) so a test can point at
 *                           ["node", "fake-gh.mjs"]. Do NOT set these in production job environments:
 *                           whatever they name is what runs the push.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Distinct exit code per refusal class, so a job can branch on the result without parsing prose.
export const EXIT = Object.freeze({
  OK: 0,               // pushed; prStatus says created/existing/compare_fallback (or dry run passed)
  USAGE: 2,            // bad/unknown/duplicate arguments
  REPO_REFUSED: 10,    // repo path missing, not a git repo, or outside the allowed roots
  BRANCH_REFUSED: 11,  // detached HEAD, default/main/master branch, or bad branch name
  DIRTY_TREE: 12,      // uncommitted changes or untracked (non-ignored) files
  REMOTE_REFUSED: 13,  // origin missing, not github.com, owner not allowed, or URLs disagree
  UPSTREAM_REFUSED: 14,// --upstream malformed or not origin's fork parent
  INPUT_REFUSED: 15,   // title or body file failed validation
  AUDIT_FAILED: 16,    // audit log not writable -- refuse rather than publish unaudited
  CONFIG_REFUSED: 17,  // repo-local git config has a key outside the safe allowlist
  PUSH_FAILED: 20,     // git push itself failed (auth, non-fast-forward, network)
  TOOL_FAILED: 21,     // a read-only git/gh query needed for validation failed
  INTERNAL: 30,        // unexpected exception
});

export const BRANCH_PATTERN = /^(fix|feat|chore|docs|test|refactor|perf)\/[a-z0-9][a-z0-9._-]{0,80}$/;
export const PROTECTED_BRANCHES = Object.freeze(["main", "master"]);
export const TITLE_MAX = 256;           // GitHub's own PR title limit
export const BODY_MAX_BYTES = 64 * 1024;
const DEFAULT_OWNERS = ["icey2488"];
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;

class Refusal extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

// ---------------------------------------------------------------- pure validation (exported) ---

export function parseArgs(argv) {
  const spec = { "--repo": "value", "--title": "value", "--body-file": "value", "--upstream": "value",
                 "--draft": "flag", "--dry-run": "flag" };
  const out = { draft: false, dryRun: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const kind = spec[name];
    if (!kind) throw new Refusal(EXIT.USAGE, `unknown argument: ${JSON.stringify(a)}`);
    if (seen.has(name)) throw new Refusal(EXIT.USAGE, `duplicate argument: ${name}`);
    seen.add(name);
    if (kind === "flag") {
      if (name !== a) throw new Refusal(EXIT.USAGE, `${name} takes no value`);
      out[name === "--draft" ? "draft" : "dryRun"] = true;
      continue;
    }
    let value;
    if (name !== a) value = a.slice(eq + 1);
    else {
      if (i + 1 >= argv.length) throw new Refusal(EXIT.USAGE, `${name} requires a value`);
      value = argv[++i];
    }
    const key = { "--repo": "repo", "--title": "title", "--body-file": "bodyFile", "--upstream": "upstream" }[name];
    out[key] = value;
  }
  if (!out.repo) throw new Refusal(EXIT.USAGE, "--repo <path> is required");
  return out;
}

// Returns null if the name is acceptable, else a reason string.
export function validateBranchName(name) {
  if (typeof name !== "string" || name.length === 0) return "empty branch name";
  if (PROTECTED_BRANCHES.includes(name.toLowerCase())) return `refusing to publish protected branch "${name}"`;
  if (!BRANCH_PATTERN.test(name)) {
    return `branch "${name}" does not match ${BRANCH_PATTERN} (lowercase <type>/<slug>, type one of fix|feat|chore|docs|test|refactor|perf)`;
  }
  if (name.includes("..")) return `branch "${name}" contains ".."`;
  if (name.endsWith(".lock")) return `branch "${name}" ends with ".lock"`;
  if (name.endsWith(".")) return `branch "${name}" ends with "."`;
  return null;
}

// Parses a github.com remote URL. Accepts only:
//   https://github.com/<owner>/<repo>[.git][/]
//   git@github.com:<owner>/<repo>[.git]
//   ssh://git@github.com[:22]/<owner>/<repo>[.git][/]
// No userinfo on https (a `https://github.com@evil.com/...` or token-in-URL form is refused), no
// other host, no query/fragment. Returns {owner, repo} or null.
export function parseGithubRemote(url) {
  if (typeof url !== "string") return null;
  const u = url.trim();
  let m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u)
       || /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(u)
       || /^ssh:\/\/git@github\.com(?::22)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!GH_OWNER.test(owner) || !GH_REPO.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

export function parseAllowedOwners(envValue) {
  if (envValue === undefined || envValue === null || String(envValue).trim() === "") return [...DEFAULT_OWNERS];
  return String(envValue).split(",").map((s) => s.trim()).filter(Boolean);
}

export function isOwnerAllowed(owner, allowedOwners) {
  return typeof owner === "string" && allowedOwners.some((o) => o.toLowerCase() === owner.toLowerCase());
}

export function parseAllowedRoots(envValue, platform = process.platform) {
  const pm = platform === "win32" ? path.win32 : path.posix;
  if (envValue === undefined || envValue === null || String(envValue).trim() === "") {
    return platform === "win32" ? ["D:\\code"] : [];
  }
  return String(envValue).split(platform === "win32" ? ";" : ":").map((s) => s.trim()).filter((s) => s && pm.isAbsolute(s));
}

// True if `child` is `root` itself or underneath it. Both should already be realpaths.
export function isInside(root, child, platform = process.platform) {
  const pm = platform === "win32" ? path.win32 : path.posix;
  let r = pm.resolve(root), c = pm.resolve(child);
  if (platform === "win32") { r = r.toLowerCase(); c = c.toLowerCase(); }
  const rel = pm.relative(r, c);
  return rel === "" || (!rel.startsWith("..") && !pm.isAbsolute(rel));
}

export function validateUpstream(value) {
  if (typeof value !== "string") return { error: "upstream must be owner/repo" };
  const m = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!m || !GH_OWNER.test(m[1]) || !GH_REPO.test(m[2]) || m[2] === "." || m[2] === "..") {
    return { error: `--upstream "${value}" is not a valid GitHub owner/repo` };
  }
  return { owner: m[1], repo: m[2] };
}

// Returns null if fine, else a reason. Control characters (incl. newlines) are refused outright.
export function validateTitle(title) {
  if (typeof title !== "string" || title.trim() === "") return "title is empty";
  if ([...title].length > TITLE_MAX) return `title longer than ${TITLE_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(title)) return "title contains control characters or newlines";
  return null;
}

// Repo-local / worktree config keys a publish will tolerate (matched case-insensitively against
// `git config --list --name-only --show-scope`). Anything else refuses the publish: local config
// can execute commands or receive credentials during `git status` / `git push` (credential.helper,
// core.fsmonitor, core.hooksPath, core.sshCommand, core.gitProxy, filter.*.clean/smudge,
// include.path/includeIf, http.*.proxy/sslVerify, ...). url.*.insteadOf/pushInsteadOf are allowed
// here only because the expanded-URL check below already pins where they can point.
export const SAFE_LOCAL_CONFIG_KEYS = Object.freeze([
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode|autocrlf|eol|safecrlf|longpaths|checkstat|trustctime)$/i,
  /^remote\..+\.(url|pushurl|fetch|tagopt|prune|gh-resolved)$/i,
  /^branch\..+\.(remote|merge|rebase|pushremote|description|gh-merge-base|vscode-merge-base)$/i,
  /^url\..+\.(insteadof|pushinsteadof)$/i,
  /^user\.(name|email)$/i,
  /^(pull\.rebase|pull\.ff|fetch\.prune|push\.autosetupremote|push\.default|init\.defaultbranch|commit\.gpgsign|gc\.auto)$/i,
  /^extensions\.(worktreeconfig|objectformat|refstorage)$/i,
]);

// Takes `git config --list --name-only --show-scope` output; returns the local/worktree keys that
// are not on the allowlist (empty array = fine). Global/system/command scopes are the user's own.
export function findUnsafeConfig(listOutput) {
  const bad = [];
  for (const raw of String(listOutput).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    const scope = tab > 0 ? line.slice(0, tab) : "";
    const key = tab > 0 ? line.slice(tab + 1) : line;
    if (scope !== "local" && scope !== "worktree") continue;
    if (!SAFE_LOCAL_CONFIG_KEYS.some((re) => re.test(key))) bad.push(`${scope}:${key}`);
  }
  return bad;
}

// Global options prepended to every git call: no fsmonitor command, and hooks resolved from a
// directory that does not exist (random per run), so a planted .git/hooks/pre-push never runs.
export function hardenedGitPrefix(noHooksDir) {
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${noHooksDir}`];
}

const FORBIDDEN_PUSH_FLAGS = ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror",
  "--all", "--branches", "--tags", "--follow-tags", "--delete", "-d", "--prune", "--no-verify", "--receive-pack",
  "--exec", "--repo"];

// Builds the one push argv this script ever runs.
export function buildPushArgv(branch) {
  const argv = ["push", "--set-upstream", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
                "origin", `HEAD:refs/heads/${branch}`];
  assertSafePushArgv(argv, branch);
  return argv;
}

// Defense in depth: re-checks the final argv so a future edit can't quietly add a force flag.
export function assertSafePushArgv(argv, branch) {
  for (const a of argv) {
    const flag = a.split("=")[0];
    if (FORBIDDEN_PUSH_FLAGS.includes(flag) || /^--force/.test(a)) throw new Error(`forbidden push argument: ${a}`);
    if (/^-[^-]/.test(a) && a.length > 2) throw new Error(`combined short flags not allowed in push argv: ${a}`);
    if (a.startsWith("+") || a.startsWith(":")) throw new Error(`forced/deleting refspec not allowed: ${a}`);
  }
  const refspecs = argv.filter((a) => a.includes(":") && !a.startsWith("-"));
  if (refspecs.length !== 1 || refspecs[0] !== `HEAD:refs/heads/${branch}`) {
    throw new Error(`push must carry exactly one refspec HEAD:refs/heads/${branch}`);
  }
  if (argv[0] !== "push" || argv[argv.length - 2] !== "origin") throw new Error("push must target origin");
}

export function buildCompareUrl({ baseOwner, baseRepo, baseBranch, headOwner, branch, crossRepo }) {
  const head = crossRepo ? `${headOwner}:${branch}` : branch;
  const range = baseBranch ? `${baseBranch}...${head}` : head;
  return `https://github.com/${baseOwner}/${baseRepo}/compare/${range}?expand=1`;
}

// Child environment: the job's env minus anything that could redirect git/gh away from what was
// validated (GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* can swap the repo or inject config like insteadOf;
// GH_REPO/GH_HOST can retarget gh). Tokens (GH_TOKEN/GITHUB_TOKEN) pass through untouched for gh's
// auth but are never logged.
export function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const K = k.toUpperCase();
    if (K.startsWith("GIT_")) continue;
    if (["GH_REPO", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_PAGER", "PAGER"].includes(K)) continue;
    out[k] = v;
  }
  out.GIT_TERMINAL_PROMPT = "0";
  out.GH_PROMPT_DISABLED = "1";
  out.GH_NO_UPDATE_NOTIFIER = "1";
  out.GH_PAGER = "";
  return out;
}

export function resolveCmd(envValue, fallback) {
  if (envValue === undefined || envValue === "") return [fallback];
  const v = String(envValue).trim();
  if (v.startsWith("[")) {
    const arr = JSON.parse(v);
    if (!Array.isArray(arr) || arr.length === 0 || !arr.every((s) => typeof s === "string" && s)) {
      throw new Error("binary override must be a non-empty JSON array of strings");
    }
    return arr;
  }
  return [v];
}

// ------------------------------------------------------------------------- process helpers ---

function run(cmd, args, { cwd, env, timeout = 60_000 }) {
  return new Promise((resolve) => {
    execFile(cmd[0], [...cmd.slice(1), ...args], { cwd, env, timeout, shell: false, windowsHide: true,
      maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
                stdout: stdout || "", stderr: stderr || (err && !stdout ? String(err.message) : "") });
    });
  });
}

const firstLine = (s) => String(s).trim().split(/\r?\n/)[0] || "";
const tail = (s, n = 600) => { const t = String(s).trim(); return t.length > n ? `...${t.slice(-n)}` : t; };

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

// ------------------------------------------------------------------------------ main flow ---

// Import-only test seams (the CLI entry point below never sets them):
//   opts.trustExpandedUrl -- the tests point a github.com origin at a local bare repo via insteadOf,
//     which the expanded-URL check would (correctly) refuse. Every other check, including the raw-URL
//     owner check, still runs.
//   opts.tmpDir -- the temp dir a --body-file may live in (default os.tmpdir()); tests pin it to a
//     dedicated folder because their whole fixture tree is itself under os.tmpdir().
export async function publish(argv, { env = process.env, platform = process.platform, ...opts } = {}) {
  const tmpDir = opts.tmpDir || os.tmpdir();
  const startedAt = new Date().toISOString();
  const result = { ok: false, dryRun: false, repo: null, branch: null, commit: null, pushedTo: null,
                   prUrl: null, compareUrl: null, prStatus: null, errors: [], warnings: [] };
  const audit = { action: "publish", upstream: null };
  let exitCode = EXIT.INTERNAL;
  let auditPath = null;

  try {
    let args;
    try { args = parseArgs(argv); } catch (e) { if (e instanceof Refusal) throw e; throw new Refusal(EXIT.USAGE, e.message); }
    result.dryRun = args.dryRun;
    audit.action = args.dryRun ? "dry-run" : "publish";

    // Audit log first: refuse to publish anything we can't record (fail closed).
    auditPath = env.PUBLISH_AUDIT_LOG || path.join(os.homedir(), ".claude-async-jobs", "publish-audit.jsonl");
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.closeSync(fs.openSync(auditPath, "a"));
    } catch (e) {
      const p = auditPath; auditPath = null;
      throw new Refusal(EXIT.AUDIT_FAILED, `audit log ${p} is not writable (${e.code || e.message}); refusing to publish unaudited`);
    }

    let gitCmd, ghCmd;
    try { gitCmd = resolveCmd(env.PUBLISH_GIT_BIN, "git"); ghCmd = resolveCmd(env.PUBLISH_GH_BIN, "gh"); }
    catch (e) { throw new Refusal(EXIT.USAGE, e.message); }
    const cenv = childEnv(env);

    // --- repo path -----------------------------------------------------------------------
    const roots = parseAllowedRoots(env.PUBLISH_ALLOWED_ROOTS, platform).map(realpathOrNull).filter(Boolean);
    if (roots.length === 0) throw new Refusal(EXIT.REPO_REFUSED, "no allowed roots exist (set PUBLISH_ALLOWED_ROOTS); refusing");
    const repoReal = realpathOrNull(path.resolve(args.repo));
    if (!repoReal || !fs.statSync(repoReal).isDirectory()) throw new Refusal(EXIT.REPO_REFUSED, `repo path does not exist or is not a directory: ${args.repo}`);
    if (!roots.some((r) => isInside(r, repoReal, platform))) {
      throw new Refusal(EXIT.REPO_REFUSED, `repo ${repoReal} is outside the allowed roots (${roots.join(", ")})`);
    }
    let top = null;
    const noHooksDir = path.join(tmpDir, `publish-nohooks-${crypto.randomUUID()}`); // never created
    const gitPrefix = hardenedGitPrefix(noHooksDir);
    const git = (a, o = {}) => run(gitCmd, [...gitPrefix, "-C", top || repoReal, ...a], { env: cenv, ...o });
    const tl = await git(["rev-parse", "--show-toplevel"]);
    if (!tl.ok) throw new Refusal(EXIT.REPO_REFUSED, `not a git work tree: ${repoReal}`);
    top = realpathOrNull(firstLine(tl.stdout));
    if (!top || !roots.some((r) => isInside(r, top, platform))) {
      throw new Refusal(EXIT.REPO_REFUSED, `repo top-level ${firstLine(tl.stdout)} is outside the allowed roots`);
    }
    result.repo = top;

    // --- repo-local config (before anything that could run a filter, e.g. git status) --------
    const cfg = await git(["config", "--list", "--name-only", "--show-scope"]);
    if (!cfg.ok) throw new Refusal(EXIT.TOOL_FAILED, `git config --list --show-scope failed (git 2.26+ required): ${tail(cfg.stderr)}`);
    const unsafe = findUnsafeConfig(cfg.stdout);
    if (unsafe.length) {
      throw new Refusal(EXIT.CONFIG_REFUSED, `repo-local git config has keys outside the publish allowlist: ${unsafe.slice(0, 10).join(", ")}; remove them or publish by hand`);
    }

    // --- branch --------------------------------------------------------------------------
    const sym = await git(["symbolic-ref", "--quiet", "HEAD"]);
    if (!sym.ok) throw new Refusal(EXIT.BRANCH_REFUSED, "HEAD is detached; check out a feature branch first");
    const ref = firstLine(sym.stdout);
    if (!ref.startsWith("refs/heads/")) throw new Refusal(EXIT.BRANCH_REFUSED, `HEAD points at ${ref}, not a local branch`);
    const branch = ref.slice("refs/heads/".length);
    result.branch = branch;
    const bad = validateBranchName(branch);
    if (bad) throw new Refusal(EXIT.BRANCH_REFUSED, bad);
    const crf = await git(["check-ref-format", `refs/heads/${branch}`]);
    if (!crf.ok) throw new Refusal(EXIT.BRANCH_REFUSED, `git check-ref-format rejects refs/heads/${branch}`);
    const head = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!head.ok) throw new Refusal(EXIT.BRANCH_REFUSED, "HEAD has no commit");
    result.commit = firstLine(head.stdout);

    let defaultBranch = null;
    const oh = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (oh.ok && firstLine(oh.stdout).startsWith("refs/remotes/origin/")) {
      defaultBranch = firstLine(oh.stdout).slice("refs/remotes/origin/".length);
      if (branch === defaultBranch) throw new Refusal(EXIT.BRANCH_REFUSED, `refusing to publish the default branch "${branch}"`);
    }

    // --- clean tree ----------------------------------------------------------------------
    const st = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!st.ok) throw new Refusal(EXIT.TOOL_FAILED, `git status failed: ${tail(st.stderr)}`);
    if (st.stdout.trim() !== "") {
      const n = st.stdout.trim().split(/\r?\n/).length;
      throw new Refusal(EXIT.DIRTY_TREE, `working tree is not clean (${n} uncommitted or untracked path(s)); commit or ignore them first`);
    }

    // --- origin --------------------------------------------------------------------------
    // Two layers: the RAW configured URLs (remote.origin.url / pushurl) must be github.com and
    // owned by an allowed owner, AND the URLs git will actually use after url.*.insteadOf /
    // pushInsteadOf expansion (`git remote get-url`) must still be that same repo -- otherwise a
    // config rewrite could leave the raw URL looking right while the push goes somewhere else.
    const allowedOwners = parseAllowedOwners(env.PUBLISH_ALLOWED_OWNERS);
    const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const rawFetch = await git(["config", "--get-all", "remote.origin.url"]);
    if (!rawFetch.ok || lines(rawFetch.stdout).length === 0) throw new Refusal(EXIT.REMOTE_REFUSED, "no origin remote");
    if (lines(rawFetch.stdout).length !== 1) throw new Refusal(EXIT.REMOTE_REFUSED, "origin has more than one url configured; refusing");
    const rawPush = await git(["config", "--get-all", "remote.origin.pushurl"]);
    const rawUrls = [...lines(rawFetch.stdout), ...(rawPush.ok ? lines(rawPush.stdout) : [])];
    const sameRepo = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
    let origin = null;
    for (const u of rawUrls) {
      const p = parseGithubRemote(u);
      if (!p) throw new Refusal(EXIT.REMOTE_REFUSED, `origin URL is not a plain github.com HTTPS/SSH URL: ${redactUrl(u)}`);
      if (!isOwnerAllowed(p.owner, allowedOwners)) {
        throw new Refusal(EXIT.REMOTE_REFUSED, `origin owner "${p.owner}" is not in the allowed owners (${allowedOwners.join(", ")})`);
      }
      if (origin && !sameRepo(origin, p)) throw new Refusal(EXIT.REMOTE_REFUSED, "origin url and pushurl point at different repositories");
      origin = origin || p;
    }
    const expFetch = await git(["remote", "get-url", "origin"]);
    const expPush = await git(["remote", "get-url", "--push", "--all", "origin"]);
    if (!expFetch.ok || !expPush.ok) throw new Refusal(EXIT.REMOTE_REFUSED, "could not resolve origin URLs");
    for (const u of [...lines(expFetch.stdout), ...lines(expPush.stdout)]) {
      const p = parseGithubRemote(u);
      if (p && sameRepo(p, origin)) continue;
      if (typeof opts.trustExpandedUrl === "function" && opts.trustExpandedUrl(u, origin) === true) continue;
      throw new Refusal(EXIT.REMOTE_REFUSED, `origin is rewritten (url.*.insteadOf/pushInsteadOf) to ${redactUrl(u)}, which is not ${origin.owner}/${origin.repo} on github.com`);
    }
    for (const key of ["remote.origin.mirror", "remote.origin.receivepack"]) {
      const v = await git(["config", "--get", key]);
      if (v.ok && firstLine(v.stdout) !== "" && !(key.endsWith("mirror") && /^(false|no|off|0)$/i.test(firstLine(v.stdout)))) {
        throw new Refusal(EXIT.REMOTE_REFUSED, `${key} is set; refusing`);
      }
    }
    result.pushedTo = `${origin.owner}/${origin.repo}`;

    // --- upstream ------------------------------------------------------------------------
    let upstream = null;
    if (args.upstream !== undefined) {
      const u = validateUpstream(args.upstream);
      if (u.error) throw new Refusal(EXIT.UPSTREAM_REFUSED, u.error);
      if (u.owner.toLowerCase() === origin.owner.toLowerCase() && u.repo.toLowerCase() === origin.repo.toLowerCase()) {
        throw new Refusal(EXIT.UPSTREAM_REFUSED, "--upstream names origin itself; omit it for a same-repo PR");
      }
      upstream = u;
      audit.upstream = `${u.owner}/${u.repo}`;
    }

    // --- title / body --------------------------------------------------------------------
    let title = args.title;
    if (title === undefined) {
      const subj = await git(["log", "-1", "--format=%s", "HEAD"]);
      title = firstLine(subj.stdout).slice(0, TITLE_MAX);
    }
    const tErr = validateTitle(title);
    if (tErr) throw new Refusal(EXIT.INPUT_REFUSED, tErr);

    let bodyReal = null, bodyBytes = null;
    if (args.bodyFile !== undefined) {
      bodyReal = realpathOrNull(path.resolve(args.bodyFile));
      if (!bodyReal) throw new Refusal(EXIT.INPUT_REFUSED, `body file not found: ${args.bodyFile}`);
      const tmpReal = realpathOrNull(tmpDir);
      const okDirs = [top];
      if (tmpReal && path.parse(tmpReal).root !== tmpReal) okDirs.push(tmpReal); // never a bare drive/fs root
      if (!okDirs.some((d) => isInside(d, bodyReal, platform))) {
        throw new Refusal(EXIT.INPUT_REFUSED, `body file ${bodyReal} must be inside the repo or the OS temp dir`);
      }
      const bst = fs.statSync(bodyReal);
      if (!bst.isFile()) throw new Refusal(EXIT.INPUT_REFUSED, "body file is not a regular file");
      if (bst.size > BODY_MAX_BYTES) throw new Refusal(EXIT.INPUT_REFUSED, `body file is ${bst.size} bytes (max ${BODY_MAX_BYTES})`);
      // Read the validated bytes ONCE, now. gh later reads a private copy of these bytes, so swapping
      // the original for a symlink to a secret after validation can't get that secret published.
      bodyBytes = fs.readFileSync(bodyReal);
      if (bodyBytes.length > BODY_MAX_BYTES) throw new Refusal(EXIT.INPUT_REFUSED, `body file is ${bodyBytes.length} bytes (max ${BODY_MAX_BYTES})`);
    }

    // --- plan ----------------------------------------------------------------------------
    const pushArgv = buildPushArgv(branch);
    const prRepo = upstream ? `${upstream.owner}/${upstream.repo}` : `${origin.owner}/${origin.repo}`;
    const headSpec = upstream ? `${origin.owner}:${branch}` : branch;
    const createArgv = (base, bodyPath) => ["pr", "create", `--repo=${prRepo}`, `--base=${base}`, `--head=${headSpec}`,
      `--title=${title}`, ...(bodyPath ? [`--body-file=${bodyPath}`] : ["--body="]), ...(args.draft ? ["--draft"] : [])];

    if (args.dryRun) {
      const base = upstream ? "<upstream default branch>" : (defaultBranch || "<origin default branch>");
      result.plannedCommands = [
        ...(upstream ? [{ bin: "gh", argv: ["repo", "view", `${origin.owner}/${origin.repo}`, "--json", "parent"] },
                        { bin: "gh", argv: ["repo", "view", prRepo, "--json", "defaultBranchRef"] }] : []),
        ...(!upstream && !defaultBranch ? [{ bin: "gh", argv: ["repo", "view", prRepo, "--json", "defaultBranchRef"] }] : []),
        { bin: "git", argv: [...gitPrefix, "-C", top, ...pushArgv] },
        { bin: "gh", argv: ["pr", "list", `--repo=${prRepo}`, `--head=${branch}`, "--state=open", "--json=url,headRepositoryOwner"] },
        { bin: "gh", argv: createArgv(base, bodyReal ? "<private temp copy of the validated body file>" : null) },
      ];
      if (upstream) result.warnings.push("dry run does not call gh, so the fork-parent check for --upstream was not performed");
      if (!defaultBranch) result.warnings.push("refs/remotes/origin/HEAD is not set; the default branch is only resolved via gh on a real run (main/master are still refused)");
      result.compareUrl = buildCompareUrl({ baseOwner: upstream ? upstream.owner : origin.owner, baseRepo: upstream ? upstream.repo : origin.repo,
        baseBranch: upstream ? null : defaultBranch, headOwner: origin.owner, branch, crossRepo: !!upstream });
      result.ok = true;
      exitCode = EXIT.OK;
      return finish();
    }

    const gh = (a) => run(ghCmd, a, { cwd: top, env: cenv, timeout: 120_000 });
    const ghJson = async (a, what) => {
      const r = await gh(a);
      if (!r.ok) throw new Refusal(EXIT.TOOL_FAILED, `gh ${what} failed: ${tail(r.stderr)}`);
      try { return JSON.parse(r.stdout); } catch { throw new Refusal(EXIT.TOOL_FAILED, `gh ${what} returned non-JSON output`); }
    };

    let baseBranch;
    if (upstream) {
      const v = await ghJson(["repo", "view", `${origin.owner}/${origin.repo}`, "--json", "parent"], "repo view (fork parent)");
      const par = v && v.parent;
      const pOwner = par && (par.owner && par.owner.login);
      const pName = par && par.name;
      if (!pOwner || !pName || pOwner.toLowerCase() !== upstream.owner.toLowerCase() || pName.toLowerCase() !== upstream.repo.toLowerCase()) {
        throw new Refusal(EXIT.UPSTREAM_REFUSED, `origin ${origin.owner}/${origin.repo} is not a fork of ${upstream.owner}/${upstream.repo}` +
          (pOwner && pName ? ` (its parent is ${pOwner}/${pName})` : " (it has no fork parent)"));
      }
      const d = await ghJson(["repo", "view", prRepo, "--json", "defaultBranchRef"], "repo view (upstream default branch)");
      baseBranch = d && d.defaultBranchRef && d.defaultBranchRef.name;
      if (!baseBranch) throw new Refusal(EXIT.TOOL_FAILED, "could not resolve upstream default branch");
    } else {
      if (!defaultBranch) {
        const d = await ghJson(["repo", "view", prRepo, "--json", "defaultBranchRef"], "repo view (default branch)");
        defaultBranch = d && d.defaultBranchRef && d.defaultBranchRef.name;
        if (!defaultBranch) throw new Refusal(EXIT.TOOL_FAILED, "could not resolve the default branch");
        if (branch === defaultBranch) throw new Refusal(EXIT.BRANCH_REFUSED, `refusing to publish the default branch "${branch}"`);
      }
      baseBranch = defaultBranch;
    }
    result.compareUrl = buildCompareUrl({ baseOwner: upstream ? upstream.owner : origin.owner, baseRepo: upstream ? upstream.repo : origin.repo,
      baseBranch, headOwner: origin.owner, branch, crossRepo: !!upstream });

    // --- push ----------------------------------------------------------------------------
    const push = await git(pushArgv, { timeout: 300_000 });
    if (!push.ok) {
      throw new Refusal(EXIT.PUSH_FAILED, `git push failed: ${tail(push.stderr || push.stdout)}`);
    }

    // --- PR (idempotent) -----------------------------------------------------------------
    exitCode = EXIT.OK;
    result.ok = true;
    const list = await gh(["pr", "list", `--repo=${prRepo}`, `--head=${branch}`, "--state=open", "--json=url,headRepositoryOwner"]);
    if (list.ok) {
      try {
        const prs = JSON.parse(list.stdout);
        const mine = Array.isArray(prs) && prs.find((p) => p && typeof p.url === "string" &&
          (!p.headRepositoryOwner || !p.headRepositoryOwner.login || p.headRepositoryOwner.login.toLowerCase() === origin.owner.toLowerCase()));
        if (mine) { result.prUrl = mine.url; result.prStatus = "existing"; return finish(); }
      } catch { result.warnings.push("gh pr list returned non-JSON output; attempting create"); }
    } else {
      result.warnings.push(`gh pr list failed (${tail(list.stderr, 200)}); attempting create`);
    }

    let bodyCopyDir = null, bodyCopy = null;
    if (bodyBytes) {
      bodyCopyDir = fs.mkdtempSync(path.join(tmpDir, "publish-body-"));
      bodyCopy = path.join(bodyCopyDir, "body.md");
      fs.writeFileSync(bodyCopy, bodyBytes, { flag: "wx" });
    }
    let create;
    try { create = await gh(createArgv(baseBranch, bodyCopy)); }
    finally { if (bodyCopyDir) fs.rmSync(bodyCopyDir, { recursive: true, force: true }); }
    const prUrlPattern = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;
    const created = create.ok && prUrlPattern.exec(create.stdout);
    if (created) { result.prUrl = created[0]; result.prStatus = "created"; return finish(); }
    const already = !create.ok && /already exists/i.test(create.stderr) && prUrlPattern.exec(create.stderr);
    if (already) { result.prUrl = already[0]; result.prStatus = "existing"; return finish(); }
    result.prStatus = "compare_fallback";
    result.warnings.push(`pushed, but gh pr create failed (${tail(create.stderr || create.stdout, 300)}); open the PR by hand at compareUrl`);
    return finish();
  } catch (e) {
    if (e instanceof Refusal) { exitCode = e.code; result.errors.push(e.message); }
    else { exitCode = EXIT.INTERNAL; result.errors.push(`internal error: ${e && e.stack ? e.stack.split("\n")[0] : e}`); }
    result.ok = false;
    return finish();
  }

  function finish() {
    result.exitCode = exitCode;
    if (auditPath) {
      const line = { ts: new Date().toISOString(), startedAt, jobId: env.CLAUDE_ASYNC_JOB_ID || null, action: audit.action,
        result: result.ok ? "ok" : (exitCode === EXIT.PUSH_FAILED || exitCode >= EXIT.TOOL_FAILED ? "failed" : "refused"),
        exitCode, repo: result.repo || null, branch: result.branch, commit: result.commit, pushedTo: result.ok && !result.dryRun ? result.pushedTo : null,
        upstream: audit.upstream, prStatus: result.prStatus, prUrl: result.prUrl, compareUrl: result.compareUrl, errors: result.errors };
      try { fs.appendFileSync(auditPath, JSON.stringify(line) + "\n"); }
      catch (e) { result.warnings.push(`audit append failed: ${e.code || e.message}`); }
    }
    return { result, exitCode };
  }
}

// Strips any userinfo (e.g. a token embedded as https://x:TOKEN@host/...) before a URL is echoed.
function redactUrl(u) {
  return String(u).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, "$1***@");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { result, exitCode } = await publish(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = exitCode;
}
