# Read access beyond a job's own working folder — proposal (not implemented)

2026-11-14 safe-mode-gaps follow-up, Step 3 (design note only -- no code changes here).

## The two denials

1. `git -C <other folder> ...` is refused for every profile.
2. Any Bash/PowerShell command naming a path outside the job's own `workFolder` is refused, so a
   job cannot read a scratch folder or copy a file from elsewhere even read-only.

## Where each one actually comes from

**1. `git -C` is claude-async's own code, two layers deep.**
- `tools/git-ro.mjs`'s `ALWAYS_DENY_FLAGS` explicitly lists `-C` (alongside `-c`, `--git-dir`,
  `--work-tree`, `--exec-path`) as denied regardless of subcommand -- a deliberate defense-in-depth
  choice (see that file's header) so its own "cwd must be inside a work tree" check can never be
  retargeted at a different directory.
- For "code" profile's raw git (`job-core.mjs`'s `READ_GIT_PREFIXES`/`WRITE_GIT_PREFIXES`),
  permission rules are fixed-string PREFIX matches (`"git status"`, `"git log"`, ...). A command
  that starts `git -C <path> ...` never matches any of them, so it is refused the ordinary way any
  uncovered command is refused under `--permission-mode dontAsk` (no matching allow rule) -- not by
  one explicit targeted deny rule.

Both are our own allowlist design, not a Claude Code limitation.

**2. The general "nothing outside the job's folder" refusal is not implemented anywhere in this
repository.** No hook and no permission rule here inspects Bash/PowerShell argument TEXT for file
paths at all -- every rule in `job-core.mjs` matches on command text, never on path arguments. This
is Claude Code's own built-in working-directory boundary: the CLI restricts filesystem-touching
tool calls (and, empirically, Bash commands that name an outside path) to the directory tree it was
launched in, unless widened by its own `--add-dir <directories...>` flag (confirmed present in the
installed CLI's `--help` output). claude-async never passes `--add-dir` today, for any profile.

## Proposal

Add an optional per-job `extraDirs` parameter (`claude_start` / `POST /v1/start`): a list of
absolute paths, mapped 1:1 onto the CLI's own `--add-dir <dir>` flag at launch time (alongside the
existing `--setting-sources`/`--append-system-prompt` argv construction in `job-core.mjs`). Each
directory becomes visible to the job's tools exactly as its own `workFolder` already is --
additive only, never a replacement for it.

**Read-only where possible, for free, not as new machinery:** `--add-dir` itself is a *visibility*
grant, not a permission level -- it does not distinguish read vs. write. The existing
`permissions.allow`/`deny` lists already decide what each profile may DO inside any directory it
can see (Edit/Write denied for readonly, etc.), so a readonly job granted `extraDirs` automatically
gets read-only reach into those directories with no new mechanism: Claude Code's settings schema
has no second dimension ("read-only *in this specific directory*") to build on. A "code" job
granted `extraDirs` gets the same write reach there it already has inside its own `workFolder` --
there is no cheaper way to express "read-only elsewhere" without the CLI itself supporting it.

**`git -C` gets a narrower, independent fix**, not `--add-dir`-dependent on its own: give
`tools/git-ro.mjs` a `--repo <path>` option (never a bare `-C`, which `ALWAYS_DENY_FLAGS` correctly
keeps off the table) that re-runs the SAME "must be inside a work tree" check against the *named*
directory instead of the process's own cwd. This stays inside the wrapper's existing threat model
(committed-object inspection only, courtesy checks, not a security boundary) and only additionally
needs an `extraDirs` grant if the target repo also happens to be outside the job's own folder.

## Tradeoffs, given Erick's standing decision that host profiles are accident protection, not a security boundary

- `--add-dir` widens blast radius for an ACCIDENT, not against a hostile job: a "code" job already
  has `node *`/`python *` and full read/write inside its own `workFolder`, so it could already
  script its way past a path boundary if it chose to (the same "decision A" reasoning used
  throughout `job-core.mjs`'s existing comments) -- `extraDirs` does not cross a line that was not
  already soft for "code".
- It DOES meaningfully widen "readonly"'s reach: readonly's whole value proposition is "nothing
  outside a couple of CLAUDE.md files and three wrapper scripts is visible at all." `extraDirs` on
  readonly should follow the same refuse-not-downgrade philosophy already used for the "readonly
  requires sandbox host" check -- an explicit, logged, per-job opt-in list, never a wildcard or an
  env-var default.
- Scope per-job only, never a default: same pattern as every other opt-in flag already in this
  file (`toolGate`, `safePermissions`, `hermesHomeIsolation`). Record the resolved list in
  `meta.json` (same transparency precedent as `hermesHome`/`profile`) so a reviewer can see exactly
  which jobs asked for extra reach.
- Worth requiring a short justification string alongside the list (recorded in `meta.json`, not
  enforced) matching the existing `intent` field on dispatch cards -- documentation value, not a
  gate.
- Not evaluated here: whether `--add-dir` has its own undocumented quirks the way
  `--append-system-prompt-file` turned out to (this job's Step 2e finding). Before shipping this,
  repeat the same kind of flag-support probe/regression test added there for `--append-system-
  prompt-file`, against `--add-dir`.

No code was written for this step.
