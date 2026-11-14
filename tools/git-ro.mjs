#!/usr/bin/env node
/**
 * Git inspection for accident protection, NOT a hostile-checkout boundary.
 * Only committed-object comparisons and selected metadata operations are exposed.
 * Git access is not secret-aware: history and objects may contain any repository data.
 * Name/path refusals are courtesy checks only, not confidentiality or physical containment.
 * Local/global Git configuration is still trusted. No claim of hostile-checkout isolation.
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
  diff: { gitArgs: ["diff"], allowedFlags: ["--stat", "--name-only", "--name-status", "-u", "--no-color"], positionals: true, textconv: true },
  log: { gitArgs: ["log"], allowedFlags: ["--oneline", "--stat", "--name-only", "--name-status", "-p", "--graph", "--all", "--no-color", "-1", "-2", "-3", "-5", "-10", "-20", "-50"], positionals: true, textconv: true },
  show: { gitArgs: ["show"], allowedFlags: ["--stat", "--name-only", "--name-status", "--no-color"], positionals: true, textconv: true },
  "rev-parse": { gitArgs: ["rev-parse"], allowedFlags: ["--abbrev-ref", "--short", "--verify", "--is-inside-work-tree", "--show-toplevel"], positionals: true, textconv: false },
  "ls-files": { gitArgs: ["ls-files"], allowedFlags: ["--cached"], positionals: true, textconv: false },
  // branch/remote/worktree: the caller's SECOND token must be exactly this literal word (checked in
  // parseArgs below); no other flags or positionals are admitted for these three at all.
  "branch list": { gitArgs: ["branch", "--list"], allowedFlags: [], positionals: false, textconv: false },
  "remote -v": { gitArgs: ["remote", "-v"], allowedFlags: [], positionals: false, textconv: false },
  "worktree list": { gitArgs: ["worktree", "list"], allowedFlags: [], positionals: false, textconv: false },
};

// Courtesy path-segment checks only. Objects/history are not secret-aware. Checks EVERY segment,
// not just the basename -- a committed directory literally named ".env" containing secret.txt
// (HEAD:.env/secret.txt) must be refused even though "secret.txt" itself looks harmless
// (probe-finding5-dir.mjs, 2026-11-13 PR #6 follow-up review). Each segment has trailing dots and
// spaces stripped before matching: Windows silently strips those from a name when resolving it,
// so ".env." or ".env " on disk can behave as plain ".env".
export function looksSecret(rawPath) {
  const norm = String(rawPath).replace(/\\/g, "/");
  const segments = norm.split("/").filter(Boolean);
  for (const raw of segments) {
    const seg = raw.replace(/[. ]+$/, "");
    if (/^\.env$/i.test(seg)) return true; // .env
    if (/\.env$/i.test(seg)) return true; // *.env (prod.env, etc.)
    if (/^\.env\./i.test(seg)) return true; // .env.*  (.env.local, etc.)
  }
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
  if (looksSecret(pathPart)) return { ok: false, reason: `${JSON.stringify(arg)} matches a courtesy secret-name refusal (Git access is not secret-aware)` };
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
  if (resolved.subcommandKey === "ls-files" && resolved.rest[0] !== "--cached") return { error: "use ls-files --cached" };
  if (resolved.rest.some(t => t.startsWith(":"))) return { error: "index/object shorthand and leading-colon pathspecs are not supported" };
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
  const fixed = ["-c", "core.fsmonitor=false", "--no-pager", "--no-optional-locks"];
  const diffSafety = def.textconv ? ["--no-ext-diff", "--no-textconv"] : [];
  let revisions;
  let revisionArgvIndexes;
  if (resolved.subcommandKey === "diff") {
    const end = extra.indexOf("--");
    const before = end < 0 ? extra : extra.slice(0, end);
    const indexes = before.flatMap((t, i) => t.startsWith("-") ? [] : [i]);
    revisions = indexes.map(i => before[i]);
    revisionArgvIndexes = indexes.map(i => fixed.length + def.gitArgs.length + diffSafety.length + i);
    if (revisions.length !== 2 || revisions.some(t => t.includes(":") || t.includes(".."))) return { error: "diff requires exactly two named commit revisions before optional -- paths" };
  }
  return { argv: [...fixed, ...def.gitArgs, ...diffSafety, ...extra], revisions, revisionArgvIndexes };
}

// Deliberately selected OS/search-path variables only; no inherited GIT_* controls.
// This is not an assertion that arbitrary operator-controlled path values are secret-free.
export function gitEnv(source = process.env) {
  const env = {};
  const keep = new Set(["path", "systemroot", "windir", "temp", "tmp", "home", "userprofile", "appdata", "localappdata", "comspec", "pathext", "systemdrive"]);
  for (const [key, value] of Object.entries(source)) if (keep.has(key.toLowerCase())) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" };
}
function runGit(argv, repoRoot) {
  return new Promise((resolve) => {
    execFile("git", argv, {
      cwd: repoRoot, shell: false, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true, encoding: "utf8",
      env: gitEnv(),
    }, (err, stdout, stderr) => {
      if (err) {
        const truncated = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timeout = err.killed && err.signal;
        resolve({ exitCode: timeout ? EXIT.TIMEOUT : (typeof err.code === "number" && err.code !== 0 ? err.code : EXIT.EXEC_FAILED), stdout: stdout || "",
          stderr: "git-ro.mjs: " + (truncated ? "output truncated" : timeout ? "timed out" : "failed") + ": " + err.message + "\n" + (stderr || "") });
        return;
      }
      resolve({ exitCode: EXIT.OK, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

export async function runCli(argv, repoRoot = process.cwd()) {
  const built = buildGitArgv(argv, repoRoot);
  if (built.error) return { exitCode: EXIT.REFUSED, stdout: "", stderr: `git-ro.mjs: refused: ${built.error}\n` };
  const inside = await runGit(["--no-pager", "rev-parse", "--is-inside-work-tree"], repoRoot);
  if (inside.exitCode !== 0) return inside;
  if (inside.stdout.trim() !== "true") return { exitCode: EXIT.REFUSED, stdout: "", stderr: "git-ro.mjs: refused: cwd must be inside a Git work tree\n" };
  if (built.revisions) {
    // Resolve both operands to commits before diff: a filename can never trigger implicit no-index.
    for (const [index, revision] of built.revisions.entries()) {
      const oid = await runGit(["rev-parse", "--verify", "--end-of-options", revision + "^{commit}"], repoRoot);
      if (oid.exitCode !== 0) return oid;
      built.argv[built.revisionArgvIndexes[index]] = oid.stdout.trim();
    }
  }
  return runGit(built.argv, repoRoot);
}

async function cliMain(argv) {
  if (argv.length === 0) {
    process.stderr.write("usage: git-ro.mjs <diff REV1 REV2|log|show|rev-parse|ls-files --cached|\"branch list\"|\"remote -v\"|\"worktree list\"> [flags/pathspecs...]\n");
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
