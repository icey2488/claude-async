# Publishing from safe-mode jobs (`scripts/publish-branch.mjs`)

Under `CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS=1`, jobs run with `--permission-mode dontAsk` and the
allow/deny lists from `buildSafePermissionsSettings()` in `job-core.mjs`. Ordinary code work runs.
Publishing is blocked on purpose: `git push *` is on the deny floor (`SHELL_DENY_PREFIXES`), and
`gh` matches no allow rule. Until now, a job that finished its work could not open a PR. Erick had
to run the commands himself or turn safe mode off.

`scripts/publish-branch.mjs` is a third option. It is one narrow, validated publish action, the same
pattern as the allow-listed Ollama helper and the "elevated runner v2" idea: a job gets one fixed
action with every argument checked, not raw `git push` and `gh`.

## What the script does

```
node D:/code/claude-async/scripts/publish-branch.mjs --repo <path> [--title <t>] [--body-file <f>]
     [--upstream <owner/repo>] [--draft] [--dry-run]
```

It never invokes a shell. Every child process is `execFile(bin, [args])` with `shell: false`, so no
argument can be read as a command. In order, it:

1. **Repo.** Resolves `--repo` with `realpath`, and does the same for git's own `--show-toplevel`.
   Both must be inside an allowed root: `D:\code` on win32 by default, or `PUBLISH_ALLOWED_ROOTS`
   (separated by `;` on Windows, `:` on POSIX). Because the check uses the realpath, a symlink or
   junction inside the root that points outside it is refused. If no root exists, it refuses.
   **Repo-local config.** Before anything that could run a filter (such as `git status`), every key in
   the repo's local and worktree git config (`git config --list --name-only --show-scope`) must be on
   a small allowlist: basic `core.*` settings, `remote.*.url/pushurl/fetch`, `branch.*` tracking,
   `url.*.insteadOf/pushInsteadOf` (pinned by the expanded-URL check below), `user.name/email`, and a
   few harmless toggles. Anything else is refused with exit 17. This matters because local config
   can run commands or receive credentials during status or push: a local `credential.helper` is
   handed your GitHub credential when git stores it after a successful push, and `core.fsmonitor`,
   `core.sshCommand`, `core.gitProxy`, `filter.*`, `include.*` and `http.*` can all execute code or
   redirect traffic. Every git call also runs with `-c core.fsmonitor=false` and `core.hooksPath`
   set to a random nonexistent directory, so a planted `.git/hooks/pre-push` never runs.
2. **Branch.** Refuses a detached HEAD, `main`, `master`, and the default branch from
   `refs/remotes/origin/HEAD`. If that ref is missing, it asks gh for the default branch before
   pushing. The branch name must match
   `^(fix|feat|chore|docs|test|refactor|perf)/[a-z0-9][a-z0-9._-]{0,80}$`, with no `..`, no trailing
   `.lock` or `.`, and must pass `git check-ref-format`.
3. **Clean tree.** `git status --porcelain --untracked-files=all` must be empty. Ignored files are
   allowed. Untracked files that aren't ignored are refused.
4. **Origin.** The raw `remote.origin.url` and every `remote.origin.pushurl` must be plain github.com
   URLs: `https://github.com/o/r[.git]`, `git@github.com:o/r[.git]` or
   `ssh://git@github.com/o/r[.git]`. URLs with userinfo or tokens are refused, as are other hosts,
   `http://`, `file://` and `ext::`. The owner must be in `PUBLISH_ALLOWED_OWNERS` (comma-separated,
   default `icey2488`), and all of these URLs must name the same repo. The script then checks the
   URLs git will actually use, after `url.*.insteadOf` / `pushInsteadOf` expansion
   (`git remote get-url [--push --all]`). Those must still be that repo, so a config rewrite can't
   keep the raw URL looking right while the push goes elsewhere. It also refuses when
   `remote.origin.mirror` or `remote.origin.receivepack` is set.
5. **Inputs.** The title is at most 256 characters with no control characters or newlines. It
   defaults to the HEAD commit subject. `--body-file` must resolve (realpath) inside the repo or the
   OS temp dir, be a regular file, and be at most 64 KB. Its bytes are read once at validation time,
   and gh gets a private temp copy. Swapping the file for a symlink after validation therefore can't
   publish something else.
6. **Upstream (optional).** `--upstream owner/repo` is allowed only when
   `gh repo view <origin> --json parent` reports that origin is a fork of exactly that repo. The PR
   then targets upstream's default branch with `--head <origin-owner>:<branch>`.
7. **Push.** It runs exactly one push:
   `git -c core.fsmonitor=false -c core.hooksPath=<none> -C <repo> push --set-upstream --porcelain --no-follow-tags --recurse-submodules=no origin HEAD:refs/heads/<branch>`.
   `assertSafePushArgv()` re-checks this argv before it runs. Any `--force*`, `-f`, `--mirror`,
   `--all`, `--tags`, `--delete`, `--no-verify`, `+`-refspec, second refspec, or remote other than
   origin throws. The child environment gets `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1`, and
   every `GIT_*` variable plus `GH_REPO`/`GH_HOST` is stripped, so the job can't swap the repo or
   inject config through the environment.
8. **PR.** If an open PR already exists for the branch (`gh pr list --head`), the script returns its
   URL. Otherwise it runs `gh pr create`. If creation fails, for example because the token can't
   create a cross-owner PR, the push still counts: the result is `ok: true` with
   `prStatus: "compare_fallback"` and a `compareUrl` a human can click to open the PR.

`--dry-run` runs every check that doesn't need the network (it never calls gh). It returns
`plannedCommands`, the exact git/gh argv a real run would execute, and pushes nothing. One gap:
with `--upstream`, the fork-parent check needs gh, so a dry run can't prove it, and the result
carries a warning saying so.

### Output and exit codes

Stdout is always exactly one JSON object:

```json
{"ok":true,"dryRun":false,"repo":"D:\\code\\x","branch":"feat/y","commit":"<sha>","pushedTo":"icey2488/x",
 "prUrl":"https://github.com/icey2488/x/pull/12","compareUrl":"https://github.com/icey2488/x/compare/main...feat/y?expand=1",
 "prStatus":"created","errors":[],"warnings":[],"exitCode":0}
```

`prStatus` is `created`, `existing`, `compare_fallback`, or `null` (dry run or refusal).

| exit | meaning |
|---|---|
| 0 | pushed (or the dry run passed); check `prStatus` |
| 2 | usage: unknown, duplicate or valueless argument |
| 10 | repo missing, not a git work tree, or outside the allowed roots |
| 11 | detached HEAD, `main`/`master`/default branch, or bad branch name |
| 12 | dirty tree or untracked (non-ignored) files |
| 13 | origin missing, not github.com, owner not allowed, URLs disagree, insteadOf rewrite, mirror |
| 14 | `--upstream` malformed, equal to origin, or not origin's fork parent |
| 15 | title or body file failed validation |
| 16 | audit log not writable (the script refuses to publish unaudited) |
| 17 | repo-local or worktree git config has a key outside the allowlist |
| 20 | `git push` itself failed (auth, non-fast-forward, network) |
| 21 | a gh query needed for validation failed |
| 30 | internal error |

### Audit log

Every attempt, whether allowed, refused or failed, appends one JSON line to
`~/.claude-async-jobs/publish-audit.jsonl` (override with `PUBLISH_AUDIT_LOG`). Each line has `ts`,
`jobId` (from `CLAUDE_ASYNC_JOB_ID`), `action` (`publish`/`dry-run`), `result`
(`ok`/`refused`/`failed`), `exitCode`, `repo`, `branch`, `commit`, `pushedTo`, `upstream`,
`prStatus`, `prUrl`, `compareUrl` and `errors`. It never records tokens or the environment.

### Environment overrides

| var | default | note |
|---|---|---|
| `PUBLISH_ALLOWED_ROOTS` | `D:\code` (win32), none elsewhere | path-delimiter separated, absolute only |
| `PUBLISH_ALLOWED_OWNERS` | `icey2488` | comma separated |
| `PUBLISH_AUDIT_LOG` | `~/.claude-async-jobs/publish-audit.jsonl` | |
| `PUBLISH_GIT_BIN`, `PUBLISH_GH_BIN` | `git`, `gh` | **Test-only.** A path or a JSON argv array (`["node","fake-gh.mjs"]`), so the test suite can substitute a fake gh and a logging git wrapper. Do not set these in production job environments. Whatever they name is what runs the push. |

## Allow rules to add to `job-core.mjs` (apply locally)

This branch adds new files only and does **not** touch `job-core.mjs`, because Erick's local main
had unpushed commits on it. Apply this by hand as a small local commit. Mirror the existing
`OLLAMA_ALLOW_PREFIXES` pattern inside `buildSafePermissionsSettings()`:

```js
  // Allow-listed publish action (docs/publishing.md): the ONE way a safe-mode job may push and open a
  // PR. Matches only `node <absolute path to the script> ...`; the script validates every argument and
  // never runs a shell. `git push *` stays on SHELL_DENY_PREFIXES -- this does not un-deny raw push.
  // Both path spellings because jobs write either; jobs must not quote the path (no spaces in it), or
  // the prefix won't match.
  const PUBLISH_ALLOW_PREFIXES = [
    "node D:/code/claude-async/scripts/publish-branch.mjs ",
    "node D:\\code\\claude-async\\scripts\\publish-branch.mjs ",
  ];
```

and in the `allow:` array, next to the Ollama line:

```js
        ...forShells(PUBLISH_ALLOW_PREFIXES.map((p) => `${p}*`)),
```

`forShells()` produces these four rule strings. This is what the settings JSON will contain, with
single backslashes:

```
Bash(node D:/code/claude-async/scripts/publish-branch.mjs *)
PowerShell(node D:/code/claude-async/scripts/publish-branch.mjs *)
Bash(node D:\code\claude-async\scripts\publish-branch.mjs *)
PowerShell(node D:\code\claude-async\scripts\publish-branch.mjs *)
```

Notes:

- **`git push *` stays denied.** So do `git merge *`, `git rebase *` and the rest of
  `SHELL_DENY_PREFIXES`. The script runs git through `execFile`, outside Claude Code's permission
  check, so it needs no shell rule for git or gh. Do not add `Bash(gh *)`.
- **These rules are redundant today.** `SHELL_ALLOW_PREFIXES` already contains `node *`, so
  `node D:/code/.../publish-branch.mjs ...` is already allowed. The specific rules are what keep
  publishing working if `node *` is ever narrowed, and they record intent next to the Ollama rules.
  Narrowing `node *` is the change that would make them matter, at the cost of breaking `node`-based
  test runs. That decision is out of scope here.
- **The Bash backslash form is effectively dead.** Git Bash eats unquoted backslashes, so
  `node D:\code\...` in Bash runs `node D:codeclaude-async...` and fails. It is harmless, and it is
  kept only because `forShells()` treats both shells alike. Jobs should use the forward-slash form in
  Bash.
- **Chaining doesn't get around the deny floor.** A `&&`-joined command whose other part is
  `git push` is still denied, because Claude Code checks each subcommand (see the `mkdir` note in
  `buildSafePermissionsSettings()`).
- **Only the plain spelling matches.** `node.exe ...` or a quoted path won't match these rules
  unless you add those spellings too. Keep jobs on the plain form.
- **Alternative to a hard-coded path:** derive it from `REPO_DIR`
  (`path.join(REPO_DIR, "scripts", "publish-branch.mjs")`, plus its `/` form), the way
  `OLLAMA_GUARD_HOOK_SCRIPT` is derived. That's safer if the checkout ever moves. The hard-coded
  form is shown because it is the real path today.

## Threat model

Read this before you count on the script for anything.

- **A job runs as the same Windows user as Erick.** Anything Erick's account can read, a job can
  read: Git Credential Manager entries, gh's stored token, environment variables, SSH keys
  (`Read(//**/.ssh/**)` is denied only for Claude's Read tool, not for processes the job starts).
- **The safe-mode allow list permits `node *`, `python *`, `npm *` and `uv *`.** Each of these runs
  arbitrary code. A determined or confused job can write a three-line script that runs
  `git push --force` through `child_process`, calls the GitHub API with a token it read from the
  credential store, or sets `PUBLISH_ALLOWED_OWNERS`/`PUBLISH_GIT_BIN` before calling this script.
  None of the client-side rules see inside those processes.
- **So the client-side rules are a speed bump.** The deny floor and this script make the easy,
  likely path (a job that wants to publish) safe and audited. They stop accidents and well-meaning
  over-reach, not an adversarial job. **The real limits have to be server-side:** what the
  credential a job holds is allowed to do on GitHub, and what GitHub refuses no matter who asks.

### Backstop A: a fine-grained PAT for jobs

Create a fine-grained personal access token used only by jobs. Under
<https://github.com/settings/personal-access-tokens>, choose **Generate new token**:

- **Resource owner:** `icey2488`
- **Repository access:** *Only select repositories*. Pick the repos jobs actually publish to, not
  "All repositories".
- **Repository permissions:** Contents **Read and write**, Pull requests **Read and write**,
  Metadata **Read-only** (required, added automatically). Everything else stays **No access**. In
  particular, leave Administration, Workflows, Secrets, Actions and Webhooks unset. Without
  Workflows, the token can't push changes to `.github/workflows/`.
- **Account permissions:** none.
- **Expiration:** set one, for example 30–90 days, and put the renewal on a calendar. GitHub
  recommends an expiry, and tokens unused for a year are removed automatically.

**Where it lives, and how it reaches gh and git.** There are two options:

1. **`GH_TOKEN` in the job environment.** The launcher sets it only for job processes, for example
   from a file readable only by the job account. Erick's interactive gh login is untouched. `gh`
   prefers `GH_TOKEN` over its own store, so the PR call uses the narrow token. *Tradeoff:* every
   process in the job can read it (`node -e "console.log(process.env.GH_TOKEN)"`), and it can leak
   into logs if anything dumps the environment. The script never logs it. **`git push` does not use
   `GH_TOKEN` on its own.** Over HTTPS on Windows, git asks Git Credential Manager, which holds
   *Erick's* credential. For the push to use the narrow token, git's credential helper for
   github.com has to be gh (`gh auth setup-git`, which reads `GH_TOKEN` when set), or the job
   account's GCM has to hold only the narrow token.
2. **gh's own auth store** (`gh auth login --with-token`, kept in Windows Credential Manager). This
   is simpler and not in the environment, but it is the *same* store Erick's interactive gh uses.
   If the jobs' token lives there, it *is* Erick's gh login, and his interactive sessions lose their
   broader access.

**The honest conclusion.** While jobs run as Erick's Windows user, his broad credentials (GCM and
gh's store) sit next to the narrow token, and a determined job can use them, whichever option you
pick. The narrow PAT limits what a well-behaved job and this script can do, and it limits the damage
if `GH_TOKEN` leaks. It does not bound a hostile job. The real boundary is **running jobs as a
separate, low-privilege Windows account** whose credential stores hold only the narrow PAT. Treat
that as the follow-up if jobs ever get less trusted inputs. Until then, Backstop B is what holds no
matter which credential is used.

**Can a fine-grained PAT open a PR from Erick's fork into someone else's repo (cross-owner)?**
As far as I could verify: **no, not with a token whose resource owner is `icey2488`.**
GitHub's PAT docs say each fine-grained token "is limited to access resources owned by a single user
or organization". They list, among the "major gaps in fine-grained personal access tokens",
"Using fine-grained personal access token to contribute to public repos where the user is not a
member" and contributing "to repositories where the user is an outside or repository collaborator".
Source: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>.
Opening the PR is an API call on the *upstream* repo (`POST /repos/<upstream>/pulls`), and that is
outside the token's resource owner. Users report exactly this failure, `403 Resource not accessible
by personal access token`, with no official resolution:
<https://github.com/orgs/community/discussions/106661>.
I could not find an official per-endpoint statement that settles it either way, so treat this as
"documented gap, strongly indicated, not verified against GitHub's endpoint docs". **The script's
compare-URL fallback covers this case.** With `--upstream`, the push to the fork succeeds with the
narrow token, `gh pr create` fails, and the result carries `prStatus: "compare_fallback"` and a
`https://github.com/<upstream>/compare/<base>...icey2488:<branch>?expand=1` link for Erick to click.
Do not widen the token, or switch jobs to a classic token, to close this gap.

### Backstop B: branch protection or rulesets on default branches

On each key repo's default branch, add a **ruleset** (Settings → Rules → Rulesets → New branch
ruleset), targeting the default branch, with enforcement *Active*:

- **Restrict deletions**
- **Block force pushes**
- **Require a pull request before merging.** Set required approvals to **0**: on a solo repo, Erick
  can't approve his own PR, and the point is that nothing reaches `main` except through a PR.
- Leave the **bypass list empty**. A personal repo's owner is its admin, and bypass is opt-in for
  rulesets, so an empty list means the rules also bind Erick's own credentials, and with them
  anything a job steals. For classic branch protection, the equivalent setting is "Do not allow
  bypassing the above settings".

These are enforced by GitHub, so they hold for any credential: the narrow PAT, Erick's GCM login,
or a job that read either.

**Availability (free vs paid).** GitHub's docs say "Rulesets are available in public repositories
with GitHub Free and GitHub Free for organizations, and in public and private repositories with
GitHub Pro, GitHub Team, and GitHub Enterprise Cloud". Protected branches have the same split:
"available in public repositories with GitHub Free and GitHub Free for organizations ... also
available in public and private repositories with GitHub Pro, GitHub Team...". Sources:
<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository>
and
<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>.
So on a **personal account on the Free plan, neither rulesets nor branch protection can be set on
private repos**. They need GitHub Pro (the personal paid plan). Public repos such as `claude-async`
get both for free. The docs don't call out personal-account repos separately. The reading above,
Free means public only and Pro adds private, is my interpretation of "GitHub Free" vs "GitHub Pro".
For private repos on Free, the narrow PAT (Backstop A, with selected repositories only) is the only
server-side limit.

## Rollout on claunker (in order)

1. **Pull the branch.** In `D:\code\claude-async`, run
   `git fetch origin feat/publish-script` and merge it into local main (or wait for the PR to
   merge). It only adds `scripts/publish-branch.mjs`, `test/publish-branch.test.mjs` and this doc,
   so it can't conflict with local `job-core.mjs` changes.
2. **Run the new tests on Windows:** `node --test test/publish-branch.test.mjs`. The test suite
   runs on Linux in the cloud sandbox. On Windows, the symlink-escape test uses a directory
   junction, and the body-file symlink check skips itself if creating file symlinks needs Developer
   Mode.
3. **Apply the allow rules** from the section above in `buildSafePermissionsSettings()`, as a small
   local commit on top of local main
   (`feat(safe-permissions): allow-list scripts/publish-branch.mjs`). Leave `git push *` on the deny
   list.
4. **Create the fine-grained PAT** (Backstop A). Decide between the `GH_TOKEN`-in-job-env option and
   gh's store, and how git's push will authenticate. If jobs should push with the narrow token,
   `gh auth setup-git` is the simplest path.
5. **Set rulesets** (Backstop B) on the default branch of `claude-async` and the other key public
   repos. Check which private repos would need GitHub Pro.
6. **Relaunch per RUNBOOK.** Any `job-core.mjs` change needs a bridge restart. Run
   `tools\restart-bridge.ps1 -RequestedBy manual` (run it with `-WhatIf` first), then fire one
   throwaway `claude_jobs` call as a warmup before any `claude_start`.
7. **Verification job.** Start a safe-mode job with `workFolder` set to a scratch repo under
   `D:\code` whose origin is an `icey2488` repo, and with a prompt like: *"Create branch
   `chore/publish-smoke`, commit a one-line change to a scratch file, then run
   `node D:/code/claude-async/scripts/publish-branch.mjs --repo <repo> --dry-run` and report its JSON.
   Then run it without `--dry-run` and report the JSON, including `prUrl` or `compareUrl`. Also try
   `git push` once and report that it was denied."* Expected results: the dry run prints
   `plannedCommands`; the real run prints `prStatus: "created"`; a second real run prints
   `"existing"`; `git push` is denied; `publish-audit.jsonl` has lines for all of them. Close the
   smoke PR and delete the branch afterwards.

## Proposed CLAUDE.md wording for jobs

Erick pastes this himself. Nothing in this branch edits any CLAUDE.md.

```markdown
### Working and publishing in claude-async safe mode

- Start jobs with `workFolder` set to the repo you are working in, so commands run there and you
  never need `cd`.
- A "don't ask mode" / permission denial means **that one command** matched no allow rule (or hit
  a deny rule). It does **not** mean the shell is off. Retry with a simpler, single command: no
  `&&`/`;` chains, no pipes, no `cd` prefix. Do not try to work around a deny rule.
- Never combine `cd` and `git` in one call (`cd X && git ...`). Use `git -C <path> ...`, or rely
  on `workFolder`.
- `git push` and `gh` are denied by design. To publish, commit your work on a
  `feat|fix|chore|docs|test|refactor|perf/<lowercase-slug>` branch with a clean tree, then run
  exactly:
  `node D:/code/claude-async/scripts/publish-branch.mjs --repo <absolute repo path> --title "<title>" [--body-file <file in repo or temp>] [--draft]`
  Run it with `--dry-run` first if unsure. Report the script's JSON result verbatim in your final
  report (`ok`, `branch`, `commit`, `prUrl` or `compareUrl`, `errors`). If `prStatus` is
  `compare_fallback`, say so and give the compare URL. A human will open the PR.
- If the script refuses (non-zero exit), report the `errors` array. Do not retry with a different
  mechanism.
```
