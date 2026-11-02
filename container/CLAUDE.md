# claude-async container job rules

This file is mounted read-only at `~/.claude/CLAUDE.md` inside every claude-async container job.
The repo's own `CLAUDE.md` (if it has one) still applies on top of it.

## Where you are

- You are running unattended inside a Docker container on claunker, as the GitHub machine account
  configured for these jobs (the bot), not as Erick. Nobody will answer a question. Finish the
  task or stop and explain why in your final report.
- `/workspace` is the ONE repository you were given, mounted read-write from the host. Nothing
  else from the host is visible: no other repos, no home directory, no SSH keys, no credential
  stores. Do not go looking for them.
- You run with `--dangerously-skip-permissions`. The container is the boundary. That does not make
  destructive git operations acceptable (see below).

## Git and GitHub

- Work on a new branch named `<type>/<short-slug>` (type: fix, feat, chore, docs, test, refactor,
  perf). Never commit to, push to, or force-push `main`/`master` or the default branch.
- Commits are made as the bot automatically (`GIT_AUTHOR_*`/`GIT_COMMITTER_*` are set). Do not
  change `user.name`/`user.email`.
- `gh` is authenticated as the bot through `GH_TOKEN`. Run `gh auth setup-git` once before your
  first push so `git push` over https uses the same token.
- Publish with `git push -u origin <branch>` and `gh pr create`. If `origin` is not writable by
  the bot (someone else's repo), fork it with `gh repo fork --remote --remote-name fork`, push the
  branch to `fork`, and open the PR against the upstream repo with
  `gh pr create --repo <owner>/<repo> --head <bot-login>:<branch>`.
- Never: `git push --force` / `--force-with-lease` / `--mirror` / `--delete`, deleting remote
  branches, rewriting published history, merging PRs, changing repo settings, branch protection,
  secrets, webhooks or collaborators, or editing `.github/workflows/` unless the task says so.
- Never write tokens into files, remotes, commit messages, PR bodies, or logs. Do not print the
  environment (`env`, `printenv`, `set`).
- Do not add git hooks or repo-local git config (`core.hooksPath`, `core.fsmonitor`, filters,
  `include.*`, credential helpers). The host runs git in this same repo after you finish, and the
  runner flags anything new you leave in `.git/config` or `.git/hooks`.

## Local model delegation (Ollama)

- The host's Ollama is at `$OLLAMA_HOST` (`http://host.docker.internal:11434`). Delegate eligible
  work to `qwen2.5-coder:7b`, for example:
  `curl -s "$OLLAMA_HOST/api/generate" -d '{"model":"qwen2.5-coder:7b","prompt":"...","stream":false}'`
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
