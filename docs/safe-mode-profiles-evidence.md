# PR #6 fix evidence — 2026-11-13

Scope: both native-host profiles are accident protection. Neither contains a hostile job or protects secrets. Untrusted work requires a separate execution environment with scoped credentials, mounts and network. No live bridge restart, user settings edit, real-secret probe, or live-service test was performed.

## Fixes 1–8

1. **Settings and hooks.** Readonly launches with `--setting-sources ""`, using explicit generated settings. It denies Write, Edit, MultiEdit, NotebookEdit and the state-writing ScheduleWakeup/ReportFindings tools. Before excluding user settings, the operator hook configuration was inspected: AgentGlass callbacks are in user settings, while no-background and Ollama guards are generated per job. Only user hooks are copied into readonly settings, preserving generated guards; malformed hook settings fail before reservation. User permission/env settings are not imported. Code retains ambient settings behavior and can be widened by project/local approvals. Official CLI/settings docs were checked.
2. **Git.** Reduced to log, show, two named commit revisions for diff, rev-parse, branch list, remote -v, worktree list and ls-files --cached. Metadata operations are the explicit exception to committed-object inspection. Removed status/describe/index and working-tree diffs/other ls-files modes; requires a Git worktree. Child environment is built from an OS-variable allowlist with no inherited GIT_* variables, case-insensitively; disables lazy fetch, prompts and optional locks. Every execution error returns nonzero, including output truncation and spawn failure. Name checks remain courtesy checks only. History/objects can expose any stored data; Git config remains trusted. Final review also found and fixed revision substitution colliding with a branch named diff.
3. **Nested dispatch.** Chose rejection, not downgrade: depth > 0 requires a resolvable recorded parent profile. Missing identity, unknown records and unavailable cross-host records reject consistently. A self-reported profile header does not substitute for the record. Self-reported depth/identity are still not authorization.
4. **HTTP lifecycle.** Both helpers use a shared absolute timer, destroy request/response on deadline, settle once and clear the timer. The GET helper follows no redirects.
5. **Ollama.** Removed /api/tags and /api/ps from the GET helper instead of expanding the hook. Its sole target is bridge /healthz. Generator model names come from tools/local-models.mjs: qwen2.5-coder:7b and qwen3:8b. Other names, including cloud variants, reject. Real CLI exercises the helper permissions and hook together against test transports.
6. **Windows streams.** Literal colon patterns did not block both tested aliases. Conservative Read(//**/.env*) and Read(//**/*.env*) patterns did block direct and unnamed-stream Read/Grep canaries in CLI 2.1.325. Kept the real CLI regression. These patterns overblock names such as .environment and example.envnotes; documented. No claim that every alias is covered.
7. **Remaining rules.** The initial real CLI CIM probe returned nonsecret TEMP environment values. Removed Get-CimInstance from readonly, retained it in code, and reran denial probes. Unknown profiles now throw in both internal settings/guidance builders.
8. **Documentation.** Rewrote RUNBOOK, README and MCP descriptions around accident protection. Explicitly documents WebSearch egress, gh auth status contacting GitHub, Git not being secret-aware, ambient code approvals, and lack of hostile-job/secret protection.

## Evidence: verified through the real CLI

Installed Claude Code 2.1.325; deterministic local mock Messages API; disposable canaries only. Latest scripts/live-check.mjs run: **23/23 passed**.
- Read public file succeeds.
- Hostile ambient approvals cannot enable Write/Edit or node -e in readonly.
- Direct .env Read/Grep and .env::$DATA Read/Grep deny.
- All three helpers execute with the real permission rules and Ollama hook; HTTP traffic is redirected by a test-only preload to ephemeral test servers. No production service is contacted.
- Local allowed model succeeds; cloud model rejects.
- Raw git log/fetch and CIM environment queries deny in readonly.
- Code Edit succeeds; code fetch advances the tracking ref to a predetermined commit from a local bare origin. Readonly fetch leaves it unchanged.
- Marker operator SessionStart hook executes despite excluded user settings; expected helper requests and filesystem effects are asserted.

The earlier narrow stream-pattern failures and initial CIM success remain preserved in scratch evidence; the report does not treat them as final passes.

## Evidence: verified by executed tests

Full suite, clean-env scratch runner: **797 tests, 747 passed, 4 failed, 46 skipped**. The only failures are the four previously identified:
- Two container bind-path assertions expecting Windows backslashes instead of normalized slashes.
- Bridge-auth opt-out marker assertion.
- Branch-name fixture attempting to create feat/a|b on Windows.

Regression coverage includes:
- Every remaining Git operation against clean-filter and post-index-change marker fixtures: no marker programs ran and uncommitted content was absent. Missing promisor blob failed without running fake SSH.
- Mixed-case Git environment exclusion; non-worktree refusal; output-cap and missing-executable failures; branch named diff.
- Trickle-server tests in child processes for both helpers: deadline error, socket closure and child exit without forced termination.
- Redirect refusal, model validation, nested HTTP rejection, hook preservation, early malformed-hook failure, profile validation, and captured readonly setting-source argv.

## Evidence: established from source only

- Real AgentGlass hook declarations were inspected and are preserved by the hook-copy implementation; actual telemetry delivery was not exercised.
- Explicit ScheduleWakeup/ReportFindings/MultiEdit/NotebookEdit denials are present; these tools were not all individually invoked in the real CLI.
- Production code launches retain ambient settings, while the code harness uses isolated settings to avoid real telemetry.
- Documentation statements about permitted WebSearch and gh auth status network access reflect configured grants and their behavior; neither was invoked against a live service.

## Untested and owner flags

No live bridge deployment/restart, real AgentGlass delivery, scheduler/breakaway launch, real Ollama daemon/model configuration, live GitHub authentication call, managed-policy combinations, or exhaustive hostile configuration/alias audit. Model names are an operator-maintained allowlist, not proof of the daemon's backend behavior. The four known suite failures remain. Broad env-prefix patterns may deny innocent names. Nested cross-host jobs without a local parent record now reject intentionally. Git config/executable lookup, history, physical aliases and self-reported nesting identity remain trusted or outside the hostile-job scope.

## Round-2 finding dispositions

| Finding | Disposition under owner scope |
| --- | --- |
| 1 Ambient settings widen readonly | Fixed: sources excluded, explicit editing denies, hooks preserved |
| 2 Git configuration executes programs/writes | Mitigated: operation reduction and marker regressions; arbitrary hostile config accepted and documented |
| 3 NTFS stream aliases | Mitigated: demonstrated Read/Grep alias blocked by conservative patterns; no universal alias claim |
| 4 Lexical containment / implicit no-index | Mitigated: no-index route removed, worktree required, commits resolved; physical containment accepted and documented |
| 5 Secret selection/history | Accepted-and-documented: Git is not secret-aware; courtesy refusals are not protection |
| 6 Unknown nested parent / forged identity | Mitigated: unknown parents reject; forged self-reported identity is outside accident-guard scope |
| 7 Helper deadlines | Fixed: absolute teardown and process/socket tests |
| 8 Output truncation success | Fixed: all execution errors fail nonzero |
| 9 Helper/hook target mismatch | Fixed: removed conflicting targets; composed real CLI check passes |

## Reproduction and retained evidence

Run the committed harness: `node scripts/live-check.mjs <worktree> <results-directory>`.
Direct regression files: test/git-ro-regression.test.mjs, test/helper-deadlines.test.mjs and the existing helper/profile/host-api tests.

Scratch root: D:\code\_scratch\2026-11-12-safe-mode-profiles-v2.
Original review and probes: round2-astra/. Final evidence: live-check-results.json, live-check-final.txt, full-tests-final.txt, readonly.settings.json, code.settings.json and canary transcripts. The scratch live-check.mjs delegates to the committed harness. The clean runner isolates HOME/config/jobcard state.

Official documentation consulted:
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/permissions
