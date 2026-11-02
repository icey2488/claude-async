# claude-async container job rules

This file is mounted read-only at `~/.claude/CLAUDE.md` inside every claude-async container job.
The repo's own `CLAUDE.md` (if it has one) still applies on top of it.

## Where you are

- You are running unattended inside a Docker container on claunker, as the GitHub machine account
  configured for these jobs (the bot), not as Erick. Nobody will answer a question. Finish the
  task or stop and explain why in your final report.
- `/workspace` is a fresh clone of `$CLAUDE_ASYNC_REPO`, made inside this container when the job
  started. It lives only in the container and is deleted when the job ends. Nothing from the host
  is mounted except this file and the hook scripts (both read-only): no host repos, no home
  directory, no SSH keys, no credential stores. Work that is not pushed is lost.
- If `$CLAUDE_ASYNC_BASE_REF` is set, the clone is checked out at that ref (detached). Otherwise
  it is on the repo's default branch.
- You run with `--dangerously-skip-permissions`. The container is the boundary. That does not make
  destructive git operations acceptable (see below).

## Git and GitHub

- Create a new branch named `<type>/<short-slug>` before your first commit (type: fix, feat,
  chore, docs, test, refactor, perf).
- `main` requires a pull request with an approval from the owner. The bot cannot push to `main` or
  merge into it, and must not try. The bot opens PRs; Erick approves and merges them.
- Commits are made as the bot automatically (`GIT_AUTHOR_*`/`GIT_COMMITTER_*` are set). Do not
  change `user.name`/`user.email`.
- `git` and `gh` are already authenticated as the bot: git over https asks `gh`, and `gh` reads
  `GH_TOKEN`. You don't need `gh auth setup-git` or `gh auth login`.
- Publish with `git push -u origin <branch>` and `gh pr create --base <base>`, where `<base>` must
  be a branch: `$CLAUDE_ASYNC_BASE_REF` when that names a branch, else the default branch (a PR
  cannot target a tag or a commit; if the task started from one, say so in the PR body). If
  `origin` is not writable by the bot (someone else's repo), fork it with
  `gh repo fork --remote --remote-name fork`, push the branch to `fork`, and open the PR against
  the upstream repo with `gh pr create --repo <owner>/<repo> --head <bot-login>:<branch>`.
- Print the PR URL on its own line in your final message (`PR: https://github.com/...`). The
  runner records it.
- Never: `git push --force` / `--force-with-lease` / `--mirror` / `--delete`, deleting remote
  branches, rewriting published history, merging or approving PRs, changing repo settings, branch
  protection, rulesets, secrets, webhooks or collaborators, or editing `.github/workflows/` unless
  the task says so.
- Never write tokens into files, remotes, commit messages, PR bodies, or logs. Do not print the
  environment (`env`, `printenv`, `set`) or read `/proc/*/environ`. Your output is logged on the
  host.

## Local model delegation (Ollama)

- The host's Ollama is at `$OLLAMA_HOST` (`http://host.docker.internal:11434`). Delegate eligible
  work to `qwen2.5-coder:7b`, for example:
  `curl -s "$OLLAMA_HOST/api/generate" -d '{"model":"qwen2.5-coder:7b","prompt":"...","stream":false}'`
- Use only `/api/generate`, `/api/chat`, `/api/tags` and `/api/show`. Never pull, create, copy or
  delete models.
- Delegated code must pass typecheck and tests before you accept it. Rejecting bad output takes
  priority over using it.

## Background work

- Never background work: no `run_in_background`, no `&`, no `nohup`, no detached processes. The
  no-background hook denies these calls.

## Final report

- End your final message with the delegation report: every Ollama call with purpose, model and
  outcome (accepted / accepted after edits / rejected and why), the acceptance rate, or an explicit
  "zero calls" statement. Its last line must start with `DELEGATION-METRICS:` (the runner checks
  for it).
- Include the branch, the commits, and the PR URL (or why there is none).
