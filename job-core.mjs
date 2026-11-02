#!/usr/bin/env node
/**
 * job-core.mjs — shared logic for claude-async (stdio + http entrypoints).
 * Job state lives entirely on disk under JOB_ROOT, which is why the HTTP server can be
 * stateless. job-runner.mjs (the detached worker) must sit beside this file.
 *
 * PATHEXT: Claude Desktop spawns this bridge with PATHEXT absent from its environment
 * entirely, which only became a problem once the win32 breakaway path (launchWin32) added a
 * powershell.exe hop -- PowerShell appends ".CPL" to whatever PATHEXT it inherits, and appended
 * to nothing that's a PATHEXT of exactly ".CPL", breaking bare resolution of node/npm/npx/cmd/tsc
 * for every process downstream. sanitizeEnvForWin32() (below) guarantees PATHEXT always contains
 * a usable value before both spawns that matter; see its own header comment for the full story
 * and test/pathext-integrity.mjs for the regression test.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mintCard, failCard, boundIntent } from "./card-hook.mjs";
import { classifyFinalStatus } from "./job-status.mjs";
import { queryJobMembershipOnce } from "./tools/jobMembership.mjs";
import { writeJsonAtomic } from "./atomic.mjs";
import { withdrawTicket } from "./launcher-claim.mjs";
import { resolveCaps, parseDepth, checkDepth, checkCaps, withStartLock, recentStarts, recordStart,
         DEPTH_ENV } from "./guard.mjs";
import { resolveSandbox, loadContainerConfig, planContainerJob, checkDockerImage, buildContainerSettings,
         buildContainerCliArgv, buildDockerRunArgv, cleanupJobContainers } from "./container.mjs";

// Claude Desktop spawns this bridge (the MCP child process) with NO PATHEXT in its environment
// at all. That was harmless before 5a09feb: the old direct node->node spawn path let a bare
// "claude"/"npm"/"tsc" resolve through cmd.exe, which fills in its own sane PATHEXT default when
// the variable is absent. The win32 breakaway path (launchWin32 below) added a powershell.exe hop,
// and PowerShell's own startup APPENDS ".CPL" to whatever PATHEXT it inherited -- appended to an
// absent value that produces a PATHEXT of exactly ".CPL", which then flows down through
// win32-breakaway.ps1 (lpEnvironment=NULL, i.e. verbatim inheritance -- see that script's header)
// into job-runner.mjs and whatever it spawns (the claude CLI, and any shell that CLI's own tools
// invoke), silently breaking bare resolution of node/npm/npx/cmd/tsc ("'tsc' is not recognized").
// sanitizeEnvForWin32() below repairs PATHEXT before both hops that matter (the wrapper spawn here
// and job-runner.mjs's spawn of the CLI); PowerShell still appends ".CPL" after the repair, but
// ".COM;.EXE;...;.MSC;.CPL" resolves everything the original list did, so that's harmless.
// Delegated to qwen2.5-coder:7b (local ollama) per the exact spec above; accepted with only a
// STANDARD-constant hoist for reuse by logIfPathextSanitized() below — logic unchanged.
const STANDARD_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
export function sanitizeEnvForWin32(env) {
  if (process.platform !== "win32") return { ...env };

  const caseInsensitiveKeys = Object.keys(env).filter((key) => key.toLowerCase() === "pathext");
  const effectiveValue = caseInsensitiveKeys.includes("PATHEXT")
    ? env.PATHEXT
    : env[caseInsensitiveKeys[0]];

  const standardizedValue = effectiveValue
    ? (effectiveValue.trim().toLowerCase().includes(".exe") ? effectiveValue : STANDARD_PATHEXT)
    : STANDARD_PATHEXT;

  const result = { ...env };
  caseInsensitiveKeys.forEach((key) => delete result[key]);
  result.PATHEXT = standardizedValue;

  return result;
}

// Appends a diagnostic line to `logPath` iff sanitizeEnvForWin32() had to intervene (i.e. the
// sanitized PATHEXT differs from what was actually present in `originalEnv`), naming the original
// value so a future reader can tell whether it was absent, empty, or corrupted.
export function logIfPathextSanitized(logPath, originalEnv, sanitizedEnv, context) {
  const matches = Object.keys(originalEnv).filter((k) => k.toLowerCase() === "pathext");
  const hadCanonicalOnly = matches.length === 1 && matches[0] === "PATHEXT";
  const originalValue = matches.length ? originalEnv[matches[0]] : undefined;
  if (hadCanonicalOnly && originalValue === sanitizedEnv.PATHEXT) return; // nothing to repair
  const originalDesc = matches.length === 0 ? "(absent)"
    : matches.map((k) => `${k}=${JSON.stringify(originalEnv[k])}`).join(", ");
  try { fs.appendFileSync(logPath,
    `\n[job-core] sanitizeEnvForWin32: repaired PATHEXT before ${context} ` +
    `(was ${originalDesc}) -> ${sanitizedEnv.PATHEXT}\n`); } catch {}
}

export const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || "claude";
export const JOB_ROOT = process.env.CLAUDE_ASYNC_JOB_DIR || path.join(os.homedir(), ".claude-async-jobs");
// win32 Task Scheduler launcher queue: deliberately NOT derived from JOB_ROOT/any env override.
// job-launcher.mjs is started by the Task Scheduler service with its own fresh environment, not
// a copy of the bridge process's -- a CLAUDE_ASYNC_JOB_DIR override set on the bridge would never
// reach it, so it would scan the wrong directory for pending tickets. This path must be
// computable identically by both processes from nothing but os.homedir(), which Task Scheduler's
// per-user logon session always sets consistently. Individual jobs still live under JOB_ROOT
// (wherever that points); each ticket in this queue just carries the absolute paths to them.
export const LAUNCHER_QUEUE_DIR = path.join(os.homedir(), ".claude-async-launcher-queue");
const DEFAULT_CWD = process.env.CLAUDE_ASYNC_DEFAULT_CWD || os.homedir();
// Heartbeat classification thresholds. HEARTBEAT_FRESH_MS: a lastAlive within this window
// is definitely running. JOB_TIMEOUT_MS: beyond this, the job is timed_out regardless of pid.
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000; // 3 minutes
export const JOB_TIMEOUT_MS = Number(process.env.CLAUDE_ASYNC_JOB_TIMEOUT_MS) || 4 * 60 * 60 * 1000; // 4h
// Default for the CLI's own background-task wait ceiling (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
// set below). Finite, not 0: 0 tells the CLI to wait for background work INDEFINITELY, and the
// runner's own heartbeat keeps ticking while the CLI waits, so CLAUDE_ASYNC_JOB_TIMEOUT_MS (above)
// never fires to catch a hung background agent -- nothing in the bridge would stop it. 2h is
// comfortably above the CLI's old 600s default (so legitimate background work still finishes)
// while still well under JOB_TIMEOUT_MS's 4h, leaving headroom for the heartbeat ceiling to act
// as the real outer backstop.
export const BG_WAIT_CEILING_MS = Number(process.env.CLAUDE_ASYNC_BG_WAIT_CEILING_MS) || 2 * 60 * 60 * 1000; // 2h
// 2026-10-19 auto-background gap (claunker.agents-md-seat-isolation-20261019-fbkk7h1a): the
// no-background-hook (hooks/no-background-hook.mjs) only sees tool calls as the model writes
// them -- it cannot stop the CLI's OWN behavior of moving a foreground Bash/PowerShell command
// to the background on its own once that command outruns its timeout. That job's full-filesystem
// `find` did exactly this: ran past its timeout, got auto-backgrounded, kept running unsupervised,
// and was eventually killed "after reaching its background time limit" (confirmed string in
// claude.exe 2.1.303's bundle, keyed "deadline" next to the sibling "memory_pressure" kill reason)
// -- all while the job still exited 0 and read as "completed". CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
// (confirmed present in that same bundle, gating both explicit run_in_background and the
// auto-background timeout clamp via the same internal check) removes the auto-background
// pathway entirely: a command that outruns its timeout is then killed/interrupted directly,
// a visible failure instead of a silent handoff. Set per-job below, NOT here as a default,
// because it cannot be applied to ultracode-effort jobs -- the Workflow tool those jobs use
// always runs via the same background mechanism by design (returns a task id immediately), and
// this flag has no finer-grained "disable Bash auto-background but not Workflow" mode.
// BASH_MAX_TIMEOUT_MS (also confirmed present in that bundle, feeding the Bash tool's own hard
// timeout ceiling): raised here so disabling auto-backgrounding doesn't also mean genuinely slow
// foreground commands get killed at the CLI's un-raised default ceiling. 20 minutes is well
// under both BG_WAIT_CEILING_MS (2h) and JOB_TIMEOUT_MS (4h) above, leaving headroom for
// everything else a job does, while covering most legitimately slow one-off commands (installs,
// large scans) that used to silently auto-background instead of just running longer.
export const JOB_BASH_MAX_TIMEOUT_MS =
  Number(process.env.CLAUDE_ASYNC_BASH_MAX_TIMEOUT_MS) || 20 * 60 * 1000; // 20m
const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(REPO_DIR, "job-runner.mjs");
// win32-only: shells out through CreateProcessW(CREATE_BREAKAWAY_FROM_JOB) so job-runner.mjs
// escapes whatever Job Object launch()'s caller is nested in (see launchWin32Breakaway()'s
// comment). FALLBACK ONLY as of the 2026-09-09 Task Scheduler launcher -- see launchWin32()'s
// comment for why breakaway alone turned out not to be enough.
const WIN32_BREAKAWAY_SCRIPT = path.join(REPO_DIR, "win32-breakaway.ps1");
// win32-only: the Task Scheduler launcher path (primary as of the 2026-09-09 Task Scheduler
// launcher work). See launchWin32Task()/job-launcher.mjs's own header for the full protocol.
const LAUNCHER_SCRIPT = path.join(REPO_DIR, "job-launcher.mjs");
const REGISTER_TASK_SCRIPT = path.join(REPO_DIR, "tools", "register-launcher-task.ps1");
const TASK_NAME = "ClaudeAsyncRunner";
const RUNNER_PID_POLL_MS = 2000;
// The task path has more hops than a direct breakaway spawn (schtasks /Run -> Task Scheduler
// service schedules a new instance -> job-launcher.mjs starts, imports job-core.mjs, scans and
// claims -> spawns job-runner.mjs), so it gets a longer poll window before falling back.
const TASK_RUNNER_PID_POLL_MS = 15000;
// Extra wait when the fallback found its own ticket already taken by a launcher (see launchWin32Task):
// a launcher that has claimed a job is on its way to spawning the runner, so the bridge keeps waiting
// for runner.pid instead of launching the job a second time.
const TASK_CLAIMED_EXTRA_POLL_MS = 15000;
const RUNNER_PID_POLL_INTERVAL_MS = 50;
// CLAUDE_ASYNC_WIN32_LAUNCH_MODE: "auto" (default) tries the Task Scheduler path first and falls
// back to win32-breakaway.ps1 only if task registration or the run trigger itself fails (or the
// runner never shows up within TASK_RUNNER_PID_POLL_MS). "breakaway" skips the task path
// entirely -- used by tests that specifically exercise win32-breakaway.ps1 mechanics (PATHEXT
// repair, the wrapper-fallback pid path) that the Task Scheduler path doesn't go through at all.
const WIN32_LAUNCH_MODE = (process.env.CLAUDE_ASYNC_WIN32_LAUNCH_MODE || "auto").toLowerCase();
// Empty MCP config: paired with --strict-mcp-config so detached jobs load ZERO MCP servers,
// preventing a project .mcp.json from recursively respawning claude-async.
const EMPTY_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "empty-mcp.json");
// 2026-10-19 no-background enforcement: CLAUDE.md's "claude-async jobs never background work"
// rule (added 2026-10-18) was still being ignored at the prompt level (an Agent launched with
// run_in_background, a backgrounded `find` later killed at its time limit) -- this PreToolUse
// hook enforces it mechanically instead. Scoped to claude-async job launches only via the
// per-job --settings object below (buildNoBackgroundHookSettings()); never written to Erick's
// own ~/.claude/settings.json, so interactive sessions are unaffected. See hooks/no-background-
// hook.mjs's own header for the full contract and RUNBOOK.md for rollback.
//
// Matcher is catch-all ("*"), not a hardcoded tool-name list: empirically confirmed on this
// machine's claude.exe 2.1.303 on 2026-10-19 (a wildcard-matched probe hook fired for Read and
// Glob -- tools with no background-capable fields at all) that "*" invokes the hook for every
// tool call. A hardcoded list meant a renamed/new background-capable tool would silently bypass
// the hook entirely (unmatched calls never reach the script); the catch-all moves every
// tool-specific decision into the script itself (see its header) and keeps it fail-closed for
// malformed input while staying cheap for the common case (~31.6ms/call average over 300 direct
// invocations, almost all node startup -- see RUNBOOK.md's benchmark note).
const NO_BACKGROUND_HOOK_SCRIPT = path.join(REPO_DIR, "hooks", "no-background-hook.mjs");
const NO_BACKGROUND_HOOK_MATCHER = "*";

// Ollama delegation guard (design: this job's own follow-up to the 2026-10-21 safe-permissions
// rehearsal -- D:\code\reviews\safe-perms-finish-20261021.md): closes a gap the rehearsal found
// where the local-model-delegation curl call CLAUDE.md requires of every eligible job silently
// stopped working under --permission-mode dontAsk (curl wasn't allow-listed at all). A bare
// permissions.allow prefix rule can't safely express "exactly this one URL and nothing appended"
// (curl accepts a second positional URL in the same call, and a userinfo "@" trick makes a string
// that starts with the allowed host:port actually target a different host) -- see
// hooks/ollama-guard-hook.mjs's own header. Wired in ONLY when safePermissions is enabled
// (ollamaGuard param below), same scope as the new allow rules in buildSafePermissionsSettings():
// today's --dangerously-skip-permissions jobs already run curl/ollama calls successfully with no
// allow rule in play at all (skip-permissions bypasses the permission system), so this hook must
// never fire for them -- it would only add a NEW, stricter shape requirement (explicit "http://"
// scheme, no chaining) that today's jobs were never written against.
const OLLAMA_GUARD_HOOK_SCRIPT = path.join(REPO_DIR, "hooks", "ollama-guard-hook.mjs");

// job-tool-gate (design: D:\code\reviews\job-tool-gate-design-20261020.md): routes a job's
// Claude Code tool calls through claunker-hermes's classifier/dispatcher. DEFAULT OFF --
// CLAUDE_ASYNC_JOB_TOOL_GATE must be exactly "1" (or opts.toolGate passed explicitly, for tests)
// to wire this hook in at all; the no-background-hook above is unaffected either way, since this
// is an ADDITIONAL hook command appended to the SAME catch-all matcher, never a replacement.
// Same matcher ("*") as the no-background-hook for the same reason documented there: a
// hardcoded tool-name list would let a renamed/new tool bypass the hook unnoticed.
const JOB_TOOL_GATE_HOOK_SCRIPT = path.join(REPO_DIR, "hooks", "job-tool-gate-hook.mjs");
const JOB_TOOL_GATE_ENV_DEFAULT = process.env.CLAUDE_ASYNC_JOB_TOOL_GATE === "1";

// Permission-mode change (design: D:\code\reviews\job-tool-gate-design-20261020.md, DO item 2):
// --dangerously-skip-permissions (below) is Erick's own standing rule to never use, but every
// claude-async job has hardcoded it anyway since unattended -p runs have no one to answer a
// permission prompt. "--permission-mode dontAsk" is Claude Code's OWN designed headless mode --
// it auto-denies anything that would otherwise prompt, while still honoring permissions.allow
// matches, read-only Bash, and a PreToolUse hook's "allow" (confirmed against the current
// Claude Code docs, 2026-10-20: https://code.claude.com/docs/en/permission-modes). INDEPENDENT
// flag from JOB_TOOL_GATE_ENV_DEFAULT above -- Erick can flip either one without the other; this
// one defaults OFF (jobs keep --dangerously-skip-permissions) until he decides otherwise.
const SAFE_PERMISSIONS_ENV_DEFAULT = process.env.CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS === "1";

// Per-job HERMES_HOME isolation (D:\code\reviews\ledger-timeout-hermeshome-provlog-20261020.md).
// claunker-hermes's seat_common.provenance.provenance_log_path() resolves its log path off
// HERMES_HOME (falling back to LOCALAPPDATA, then a path next to seat_common/ itself) with no
// override parameter at any of its three call sites. This workstation's bridge process inherits
// HERMES_HOME=D:\claunker\hermes -- the LIVE chassis -- so a job whose prompt imports judge_seat
// or arbiter_seat code outside pytest (pytest has its own fixture-based isolation; a bare script/
// REPL import does not) would inherit that live value and write straight into the live
// judge_provenance.jsonl. Jobs are never allowed to modify the live chassis (CLAUDE.md), so a job
// must not inherit HERMES_HOME at all by default. DEFAULT ON; CLAUDE_ASYNC_JOB_HERMES_HOME_ISOLATION
// must be exactly "0" to opt out (same "0" is literally off, anything else is on" convention
// as the job-tool-gate and no-auto-background flags use elsewhere in this file).
//
// LOCALAPPDATA is deliberately left untouched: provenance_log_path()'s fallback builds
// "<LOCALAPPDATA>\hermes\logs\judge_provenance.jsonl", a path distinct from the live chassis
// (D:\claunker\hermes\logs\judge_provenance.jsonl) on this workstation -- inheriting the real
// LOCALAPPDATA is not itself a live-chassis hazard, only HERMES_HOME pointing there directly is.
const JOB_HERMES_HOME_ISOLATION_ENV_DEFAULT = process.env.CLAUDE_ASYNC_JOB_HERMES_HOME_ISOLATION !== "0";

// Container jobs (design: docs/container-jobs.md; argv building and validation: container.mjs).
// DEFAULT OFF: a job runs in a Docker container only when claude_start passes sandbox:"container",
// or this is exactly "container" and the call doesn't pass sandbox:"host". Windows-admin jobs
// (scheduled tasks, services, firewall) stay on the host. With it off, startJob() builds the same
// argv, env and spec.json as before this mode existed.
const SANDBOX_ENV_DEFAULT = process.env.CLAUDE_ASYNC_JOB_SANDBOX;
// The host's sandbox POLICY (container.mjs parseAllowedSandboxes): which modes it runs at all.
// Default "host" only, so turning on container mode is an explicit operator decision, and a
// container-only host ("container") refuses sandbox:"host" from any caller (MCP or /v1/start).
const ALLOWED_SANDBOXES_ENV = process.env.CLAUDE_ASYNC_ALLOWED_SANDBOXES;

// The hook's "command" field is handed to a shell (cmd.exe under Task Scheduler on win32), so a
// path under "C:\Program Files\nodejs\node.exe" needs quoting for the space. Forward slashes
// avoid backslash/quote-escaping ambiguity across cmd.exe/PowerShell/sh -- Windows node.exe
// accepts forward-slash paths natively, so this never needs real backslashes at all.
function quotedPosixPath(p) {
  return `"${p.replace(/\\/g, "/")}"`;
}

// Job-scoped permissions.allow/deny for --permission-mode dontAsk (SAFE_PERMISSIONS_ENV_DEFAULT
// above). Sized to what tonight's jobs actually did (git, pytest, uv, node, PowerShell reads,
// worktree ops, file edits) per the design doc's DO item 2 -- NOT a substitute for the
// job-tool-gate hook's per-call review; the two are complementary layers (see the design doc's
// rollout section). The deny list is deliberately the belt to the gate hook's suspenders: a
// static deny rule can never be overridden by a PreToolUse hook's "allow" (confirmed against the
// current permissions docs -- "deny rules... evaluated regardless of what a PreToolUse hook
// returns"), so these hold even if the gate hook is disabled, missing, or buggy. `//` anchors at
// the filesystem root so the rule holds regardless of which workFolder/worktree a job runs in.
export function buildSafePermissionsSettings() {
  // Shared between Bash and PowerShell so the two shells can't drift (2026-10-21 rehearsal,
  // D:\code\reviews\safe-permissions-rehearsal-20261021.md: PowerShell originally had only its
  // own read-only allow rules while Bash got the full dev-tool set below, hand-written separately
  // -- so the SAME logical command, e.g. `uv run pytest`, was allowed or denied purely depending
  // on which shell tool Claude Code happened to invoke that turn, which is not something a job's
  // own prompt controls or can predict). Covers git, the dev-tool runners, and mkdir (added in the
  // same rehearsal: a scaffolding job's first compound Bash command, `cd ... && mkdir -p src tests
  // docs && git status`, was denied outright because `mkdir` matched no allow rule at all --
  // Claude Code decomposes a `&&`-joined command into its sub-commands and denies the whole call
  // if ANY one isn't covered, so the allowed `git status` alongside it didn't save the call
  // either. Directory creation is routine scaffolding, not a destructive verb).
  const SHELL_ALLOW_PREFIXES = [
    "git status*", "git diff*", "git log*", "git show*",
    "git branch*", "git rev-parse*", "git remote*", "git describe*",
    "git add *", "git commit *", "git checkout *", "git worktree *",
    // git switch (2026-10-21 safe-perms-finish task 3): the modern equivalent of
    // `git checkout <branch>`/`git checkout -b`, same risk class as the checkout rule already
    // above -- added here rather than left out, since CLAUDE.md names it alongside checkout as a
    // normal branch operation a job should be able to do.
    "git switch *",
    "pytest *", "uv *", "npm *", "node *", "python *", "mkdir *",
  ];
  const SHELL_DENY_PREFIXES = [
    "git push *", "git merge *", "git rebase *", "git reset --hard *", "git clean -f*",
    // 2026-10-21 safe-perms-finish task 3 (known gap named in the rehearsal, D:\code\reviews\
    // safe-permissions-rehearsal-20261021.md §6): the broad "git branch*"/"git checkout *" allow
    // rules above also match their destructive forms -- `git branch -D`/`--delete --force` force-
    // deletes a branch (including unmerged work), and `git checkout -- <path>`/`git checkout .`/
    // `git checkout -f` discard uncommitted working-tree changes. Deny wins over allow (confirmed
    // in the original rehearsal), so these narrower prefixes block only the destructive forms --
    // `git branch <name>` (create), `git checkout <branch>` (switch), and `git checkout -b` (create
    // + switch) all still match ONLY the allow rules above and are unaffected. Flag-order variants
    // this prefix matching can't express (e.g. `git branch -fd`, `--force --delete` reversed) are a
    // known residual gap -- see the job's report. `git restore` is deliberately left off the allow
    // list entirely (it already was, before this change) rather than given a `--staged`-only carve-
    // out: no job has ever needed it, and prefix matching can't express "has --staged" as a
    // positive requirement, only block specific unwanted prefixes.
    "git branch -D*", "git branch --delete --force*", "git branch --force --delete*",
    "git checkout -- *", "git checkout .*", "git checkout -f*",
    "git switch -f*", "git switch --force*", "git switch --discard-changes*",
  ];
  const forShells = (prefixes) => prefixes.flatMap((p) => [`Bash(${p})`, `PowerShell(${p})`]);

  // Local-model delegation (CLAUDE.md's "local model delegation (Ollama)" section): the two exact
  // URLs CLAUDE.md names for the resident qwen2.5-coder:7b model. Deliberately NOT a broad
  // "curl *" or "Invoke-RestMethod *" rule -- see OLLAMA_GUARD_HOOK_SCRIPT's comment above and
  // hooks/ollama-guard-hook.mjs's header for why the trailing wildcard here (needed for -d/-Method/
  // -Body args, which vary every call) is only safe in combination with that hook, which denies
  // any call that smuggles a second URL, a userinfo "@" host trick, a file-writing/upload/config
  // flag, or shell chaining into the same allowed prefix. Invoke-RestMethod/Invoke-WebRequest
  // rules require the URI as the FIRST positional argument (`Invoke-RestMethod http://... -Method
  // Post ...`), not a later `-Uri` flag -- a narrower rule than ollama-guard-hook.mjs alone would
  // require, chosen because allowing the URI in any argument position would mean the static prefix
  // itself could no longer anchor on the fixed host/port, re-opening the same gap. `ollama run`/
  // `generate`/`list`/`ps`/`show` cover the CLI alternative CLAUDE.md also names; that path has no
  // URL of its own for a bypass to hide in.
  const OLLAMA_ALLOW_PREFIXES = [
    "curl http://127.0.0.1:11434/api/generate", "curl http://localhost:11434/api/generate",
    "Invoke-RestMethod http://127.0.0.1:11434/api/generate", "Invoke-RestMethod http://localhost:11434/api/generate",
    "Invoke-WebRequest http://127.0.0.1:11434/api/generate", "Invoke-WebRequest http://localhost:11434/api/generate",
    "ollama run ", "ollama generate ", "ollama list", "ollama ps", "ollama show ",
  ];

  return {
    permissions: {
      allow: [
        "Read", "Glob", "Grep", "WebSearch",
        "Edit", "Write", "MultiEdit", "NotebookEdit",
        ...forShells(SHELL_ALLOW_PREFIXES),
        ...forShells(OLLAMA_ALLOW_PREFIXES.map((p) => `${p}*`)),
        "PowerShell(Get-ChildItem *)", "PowerShell(Get-Content *)", "PowerShell(Get-Item *)",
      ],
      deny: [
        ...forShells(SHELL_DENY_PREFIXES),
        "Edit(//**/CLAUDE.md)", "Edit(//**/hooks/**)", "Edit(//**/.claude/settings*.json)",
        "Edit(//**/config.yaml)", "Edit(//**/scheduled-tasks/**)",
        "Read(//**/.env)", "Read(//**/.ssh/**)",
        // 2026-10-21 safe-permissions rehearsal gap (D:\code\reviews\safe-permissions-rehearsal-
        // 20261021.md): none of the rules above match a path shaped like the live chassis
        // (D:\claunker\**, e.g. D:\claunker\hermes\plugins.py) -- a decoy probe confirmed Edit was
        // ALLOWED there. CLAUDE.md requires jobs never modify the live chassis. "//**/claunker/**"
        // matches a path SEGMENT literally named "claunker" (e.g. D:\claunker\...), not a repo
        // whose name merely contains it (D:\code\claunker-ops, D:\code\claunker-hermes), so
        // legitimate repo work is unaffected.
        //
        // 2026-10-21 safe-perms-finish follow-up: this used to also list
        // Write(//**/claunker/**)/MultiEdit(//**/claunker/**)/NotebookEdit(//**/claunker/**).
        // Live-tested against claude.exe 2.1.303: those three are silently ignored --
        // "Write(...) is not matched by file permission checks -- only Edit(path) rules are...
        // Edit rules cover all file-editing tools" (the CLI's own stderr warning) -- so Write/
        // MultiEdit/NotebookEdit calls to the live chassis were NOT actually denied by them; they
        // were dead weight that looked like coverage. A single Edit(path) deny rule is what
        // claude.exe actually applies to every file-editing tool (Edit, Write, MultiEdit,
        // NotebookEdit alike); confirmed live that a Write to a neutral //**/claunker/** fixture
        // path is denied by this one rule alone.
        "Edit(//**/claunker/**)",
      ],
    },
  };
}

// Builds the --settings object every claude-async job launch gets (merged with any other
// settings a job needs, e.g. ultracode below, into ONE --settings flag -- passing --settings
// twice was observed to let the later flag silently win, which would otherwise drop whichever
// of ultracode/hooks lost that race).
export function buildNoBackgroundHookSettings({ toolGate = JOB_TOOL_GATE_ENV_DEFAULT, liveHermesHome = null, ollamaGuard = false } = {}) {
  const preToolUseHooks = [
    { type: "command", command: `${quotedPosixPath(process.execPath)} ${quotedPosixPath(NO_BACKGROUND_HOOK_SCRIPT)}`, timeout: 5 },
  ];
  if (ollamaGuard) {
    preToolUseHooks.push({ type: "command", command: `${quotedPosixPath(process.execPath)} ${quotedPosixPath(OLLAMA_GUARD_HOOK_SCRIPT)}`, timeout: 5 });
  }
  if (toolGate) {
    // Additive, not a replacement: both hooks run for every PreToolUse call. A gate subprocess
    // timeout (CLAUDE_ASYNC_GATE_TIMEOUT_MS, default 8s in the hook itself) is generous relative
    // to this 10s outer hook timeout, which exists only to stop a truly wedged subprocess from
    // hanging the job forever -- the hook's own timeout is expected to fire first in that case.
    //
    // HERMES_HOME override: job-tool-gate-hook.mjs's own env (and the gate subprocess it spawns,
    // which inherits process.env verbatim -- see that file's runGate()) would otherwise inherit
    // whatever HERMES_HOME the launched job process has, which per JOB_HERMES_HOME_ISOLATION_
    // ENV_DEFAULT above defaults to the job's own tmp dir, NOT the live chassis. This hook is real
    // enforcement (routes tool calls through claunker-hermes's classifier/dispatcher), so its
    // provenance SHOULD land in the live log, same as any other live dispatch decision -- the
    // `set` prefix below forces HERMES_HOME back to the live value for this ONE hook's own
    // subprocess, baked in as a literal value (not a %VAR% expansion) so it is correct even if
    // CLAUNKER_LIVE_HERMES_HOME is unset in a given job's env. A no-op (prefix omitted entirely)
    // when there is no live value to restore.
    const gateCommand = liveHermesHome
      ? `set "HERMES_HOME=${liveHermesHome}" && ${quotedPosixPath(process.execPath)} ${quotedPosixPath(JOB_TOOL_GATE_HOOK_SCRIPT)}`
      : `${quotedPosixPath(process.execPath)} ${quotedPosixPath(JOB_TOOL_GATE_HOOK_SCRIPT)}`;
    preToolUseHooks.push({ type: "command", command: gateCommand, timeout: 10 });
  }
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: NO_BACKGROUND_HOOK_MATCHER,
          hooks: preToolUseHooks,
        },
      ],
    },
  };
}

// Dispatch defaults: fail-SAFE, not fail-EXPENSIVE. An unspecified job used to inherit the
// `claude` CLI's own default model (Fable) at xhigh effort — the priciest configuration
// available — and that combination absorbed 99.6% of dispatch spend on 2026-07-23. Both
// defaults below are overridable per-process; explicit caller-supplied model/effort always win.
const DEFAULT_MODEL = process.env.CLAUDE_ASYNC_DEFAULT_MODEL || "claude-sonnet-5";
const DEFAULT_EFFORT = process.env.CLAUDE_ASYNC_DEFAULT_EFFORT || "medium";
const FLAG_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
fs.mkdirSync(JOB_ROOT, { recursive: true });
if (process.platform === "win32") fs.mkdirSync(LAUNCHER_QUEUE_DIR, { recursive: true });

const jobDir = (id) => path.join(JOB_ROOT, id);
const jobPaths = (id) => {
  const d = jobDir(id);
  return { d, out: path.join(d, "out.log"), err: path.join(d, "err.log"),
           exit: path.join(d, "exit_code"), meta: path.join(d, "meta.json"),
           spec: path.join(d, "spec.json"), heartbeat: path.join(d, "runner_heartbeat"),
           exitJson: path.join(d, "exit.json"),
           // container jobs only: the persisted cancel intent (job-core writes, the runner reads) and
           // the docker client's pid (the runner writes, job-core reads; see containerLaunchPending)
           cancel: path.join(d, "cancel_requested"), dockerPid: path.join(d, "docker_client.pid") };
};

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Returns the lowercased executable/image name for a running pid, or null if unknown/gone.
function getProcessImageName(pid) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
                          { encoding: "utf8", timeout: 5000 });
      if (r.error || r.status !== 0) return null;
      const line = (r.stdout || "").trim().split(/\r?\n/)[0];
      // "INFO: No tasks are running which match..." means the PID is gone
      if (!line || line.startsWith("INFO:")) return null;
      const first = line.split(",")[0];
      return first ? first.replace(/"/g, "").toLowerCase() : null;
    } else {
      return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase();
    }
  } catch { return null; }
}

// True when the process is ours (node runner or claude CLI). If the image name can't be
// determined (permissions, OS quirk) we give benefit of the doubt — conservative/safe.
function isOurProcess(pid) {
  const name = getProcessImageName(pid);
  if (!name) return true;
  return name.includes("node") || name.includes("claude");
}

// launchWin32's pid-poll window (RUNNER_PID_POLL_MS) can expire before job-runner.mjs writes
// runner.pid, in which case meta.pid is the PowerShell wrapper's pid (pidSource:
// "wrapper-fallback") -- and the wrapper exits within milliseconds of spawning the real runner,
// so pidAlive(meta.pid) goes false almost immediately even though the runner itself is healthy.
// Before checkJob trusts a pidAlive()===false result enough to declare a job died, it calls this
// to see whether runner.pid has since appeared (job-runner.mjs writes it as its first action) and
// points to a live, ours-looking process; if so it heals meta.json in place and the caller treats
// the job as running. Returns true iff healed.
function healMetaPid(p, meta) {
  try {
    const raw = fs.readFileSync(path.join(p.d, "runner.pid"), "utf8").trim();
    if (!raw) return false;
    const runnerPid = Number(raw);
    if (!runnerPid || runnerPid === meta.pid) return false;
    if (!pidAlive(runnerPid) || !isOurProcess(runnerPid)) return false;
    meta.pid = runnerPid;
    meta.pidSource = "runner-healed";
    try { writeJsonAtomic(p.meta, meta); } catch {}
    return true;
  } catch { return false; }
}

// Reads the runner-side job-membership record job-runner.mjs refreshes on every heartbeat
// (2026-09-09 runner-termination investigation). Returns null if absent/unparseable — legacy
// jobs and non-win32 jobs never have this file.
function readRunnerJobMembership(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p.d, "runner_job.json"), "utf8")); }
  catch { return null; }
}

// Reads the runner_heartbeat file; returns a Date or null on any failure.
function readLastAlive(hbPath) {
  try {
    const raw = fs.readFileSync(hbPath, "utf8").trim();
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// exit.json (written by job-runner.mjs, next to meta.json) is reporting-only here: it never
// influences the running/completed/failed/died/timed_out classification above, only adds detail
// to it. Absent (jobs predating the file) means no `exit` key at all, not null -- callers can use
// `"exit" in result` to tell "no record" from "record says nothing". A partial, unparseable, or
// oversized file degrades to a fixed error shape rather than throwing: a bad exit.json must never
// take down claude_check for a job that is otherwise fine.
const EXIT_JSON_MAX_BYTES = 256 * 1024; // exit.json is a handful of short fields; this is generous headroom
const UNPARSEABLE_EXIT = { error: "unparseable exit.json" };

function readExitJson(p) {
  if (!fs.existsSync(p.exitJson)) return undefined;
  try {
    if (fs.statSync(p.exitJson).size > EXIT_JSON_MAX_BYTES) return UNPARSEABLE_EXIT;
    return JSON.parse(fs.readFileSync(p.exitJson, "utf8"));
  } catch {
    return UNPARSEABLE_EXIT;
  }
}

// `died` lumps together every "process exited without recording a result" case. diedCause narrows
// it using the runner's exit.json (when available) without changing the died classification
// itself: spawn-error/signal/exit mirror exit.json's own exitReason; "unknown" covers both a
// missing record (pre-exit.json job, or the runner died before writing one) and an unparseable one
// -- in both cases exit.json has nothing usable to attribute the death to.
function classifyDiedCause(exitRecord) {
  if (!exitRecord || exitRecord.error) return "unknown";
  if (exitRecord.exitReason === "spawn-error") return "spawn-error";
  if (exitRecord.exitReason === "signal") return "signal";
  if (exitRecord.exitReason === "exit") return "exit";
  return "unknown";
}

function readTail(file, maxBytes) {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    return start > 0 ? `…(${start} earlier bytes omitted)\n${text}` : text;
  } catch { return ""; }
}

// Records a launch()-time spawn failure (the shell/wrapper itself never started) the same way
// job-runner.mjs records a run-time failure: an err.log line plus an exit_code file, so checkJob
// reports "failed" with the reason in the stderr tail instead of an unhandled 'error' event
// reaching the bridge process (which, with zero listeners, would crash it -- see the
// uncaughtException/unhandledRejection handlers in claude-async-server.mjs for the last-resort
// backstop if this ever gets bypassed).
function recordLaunchFailure(p, message) {
  try { fs.appendFileSync(p.err, `\n[job-core] launch failed: ${message}\n`); } catch {}
  try { if (!fs.existsSync(p.exit)) fs.writeFileSync(p.exit, "126"); } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// fallbackPid: what to report if runner.pid never shows up in time. On the breakaway path this
// is the PowerShell wrapper's pid (a real, if short-lived, process -- pidSource
// "wrapper-fallback"). On the Task Scheduler path there is no wrapper process job-core.mjs
// controls -- schtasks /Run hands back nothing usable -- so callers pass null, and a timeout
// here is treated as an outright failure of that launch path (pidSource "task-timeout", pid
// null), signaling launchWin32Task() to fall back to win32-breakaway.ps1 instead.
async function readRunnerPid(p, fallbackPid, pollMs = RUNNER_PID_POLL_MS) {
  const pidPath = path.join(p.d, "runner.pid");
  const deadline = Date.now() + pollMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(pidPath, "utf8").trim();
      if (raw) return { pid: Number(raw), pidSource: "runner" };
    } catch { /* not written yet */ }
    await sleep(RUNNER_PID_POLL_INTERVAL_MS);
  }
  if (fallbackPid == null) {
    try { fs.appendFileSync(p.err, `\n[job-core] runner.pid did not appear within ${pollMs}ms via the ` +
      `Task Scheduler path; treating as a failed launch attempt\n`); } catch {}
    return { pid: null, pidSource: "task-timeout" };
  }
  // Timed out -- fall back to the pid we were handed (the wrapper's, on win32), noting the
  // uncertainty so a future reader of meta.json/err.log understands why pid tracking may be off.
  // pidSource: "wrapper-fallback" flags this in meta.json so checkJob knows this pid may belong
  // to a process (the PowerShell wrapper) that exits within milliseconds of spawning the real
  // runner -- see checkJob's healMetaPid() for how a stale wrapper pid gets healed later.
  try { fs.appendFileSync(p.err, `\n[job-core] runner.pid did not appear within ${pollMs}ms; ` +
    `falling back to launcher pid ${fallbackPid} (may be a shell wrapper, not the runner itself)\n`); } catch {}
  return { pid: fallbackPid, pidSource: "wrapper-fallback" };
}

// win32: node's child_process has no option to request CREATE_BREAKAWAY_FROM_JOB, and a plain
// spawn({detached:true}) only creates a new process group -- the child still inherits whatever
// Job Object the caller is nested in. Claude Desktop (Electron) runs this bridge inside a Job
// Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set (confirmed via IsProcessInJob +
// QueryInformationJobObject during the 2026-09-09 investigation), so a naively-detached
// runner can still die when the bridge does. This shells out to win32-breakaway.ps1, which calls
// CreateProcessW itself with CREATE_BREAKAWAY_FROM_JOB (falling back to a plain CreateProcessW if
// the job's flags forbid breakaway -- no worse than the old behavior). The pid spawn() returns
// here is the PowerShell wrapper's, not job-runner.mjs's, so readRunnerPid() polls the job dir
// for the runner.pid file job-runner.mjs writes as its first action.
//
// The wrapper itself is spawned WITHOUT detached:true. On Windows, node's detached:true maps to
// the DETACHED_PROCESS creation flag (no console at all, not merely hidden), and PowerShell's
// console host silently no-ops -- exits 0 without running the -File script -- when it can't
// attach to a console (verified empirically: identical spawn args with detached:true produced no
// output). windowsHide:true (STARTF_USESHOWWINDOW/SW_HIDE) still keeps the window invisible; the
// wrapper's own job/console membership doesn't matter since it just calls CreateProcessW and
// exits within milliseconds, and job-runner.mjs (the actual long-lived target) gets its own
// CREATE_NEW_PROCESS_GROUP + CREATE_NO_WINDOW from win32-breakaway.ps1 regardless.
//
// Environment: the wrapper otherwise inherits this process's environment unchanged, and
// win32-breakaway.ps1's Launch() passes lpEnvironment=IntPtr.Zero so job-runner.mjs inherits the
// wrapper's unchanged too -- see win32-breakaway.ps1's header for why that's deliberate and
// test/env-integrity.mjs for the proof (this path and the pre-5a09feb direct-spawn path are
// environment-identical otherwise). The one deliberate exception is PATHEXT: sanitizeEnvForWin32()
// repairs it before this spawn (see that function's header comment above for why it's needed --
// this is the first of the two hops it patches; job-runner.mjs's own spawn of the CLI is the
// second, belt-and-suspenders in case a future launch path bypasses this one).
async function launchWin32Breakaway(p, extraEnv = {}) {
  // A stray runner.pid can only exist here if a prior job dir at this same path was left behind
  // without a clean startJob() (startJob() itself refuses to reuse an existing job dir -- see
  // its fs.existsSync(p.d) guard -- so this is defense in depth, not a path this code expects to
  // hit in practice). Removing it up front guarantees readRunnerPid() below can only observe a
  // runner.pid written by the runner.mjs we are about to spawn, never a leftover from one we didn't.
  try { fs.unlinkSync(path.join(p.d, "runner.pid")); } catch {}
  const baseEnv = { ...process.env, ...extraEnv };
  const env = sanitizeEnvForWin32(baseEnv);
  logIfPathextSanitized(p.err, baseEnv, env, "spawning the win32 breakaway wrapper");
  const child = spawn("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
     "-File", WIN32_BREAKAWAY_SCRIPT, process.execPath, RUNNER, p.spec, p.err],
    { detached: false, stdio: "ignore", windowsHide: true, env });
  child.on("error", (e) => recordLaunchFailure(p, `failed to spawn win32 breakaway wrapper: ${e.message}`));
  child.unref();
  const { pid, pidSource } = await readRunnerPid(p, child.pid);

  // 2026-09-09 runner-termination investigation: hard evidence of job membership, not just an
  // inference from the breakaway exit path. Foreign-pid query (this bridge process, not the
  // runner, is asking) -- see tools/query-job-membership.ps1's header for why only `inJob` is
  // populated here (limitFlags etc. require a self-query, which job-runner.mjs does on its own
  // behalf via runner_job.json).
  const jobMembership = queryJobMembershipOnce(pid);
  if (jobMembership.inJob) {
    try { fs.appendFileSync(p.err, `\n[job-core] WARN: runner pid=${pid} is still a member of a ` +
      `Job Object at launch time -- breakaway may not have taken effect (jobMembership=` +
      `${JSON.stringify(jobMembership)})\n`); } catch {}
  }
  return { pid, pidSource, jobMembership };
}

// Curated env vars threaded through to job-launcher.mjs via launch.json (see writeLaunchTicket())
// so a task-launched runner still sees whatever CLAUDE_*/ANTHROPIC_* overrides were set directly
// on the bridge process, without snapshotting the bridge's entire environment (PATH/PATHEXT/etc.
// must come from job-launcher.mjs's own Task-Scheduler-provided environment, not a stale copy of
// the bridge's -- see job-launcher.mjs's buildRunnerEnv()).
function collectEnvOverrides() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE_|ANTHROPIC_)/.test(k)) out[k] = v;
  }
  return out;
}

// Idempotently ensures the `ClaudeAsyncRunner` scheduled task exists and points at the current
// node.exe + job-launcher.mjs. Cheap in the steady state: a `schtasks /Query` is a fast, local
// call to the Task Scheduler service (no COM object churn), so this runs on every win32 launch;
// the slow path (tools/register-launcher-task.ps1's Register-ScheduledTask) only runs when the
// task is missing or its action has drifted (e.g. node.exe was reinstalled at a new path, or this
// repo was moved).
function ensureLauncherTask() {
  const expectedAction = `${process.execPath} "${LAUNCHER_SCRIPT}"`;
  const query = spawnSync("schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"], { encoding: "utf8" });
  if (query.status === 0) {
    const line = (query.stdout || "").split(/\r?\n/).find((l) => l.startsWith("Task To Run:"));
    const actual = line ? line.slice("Task To Run:".length).trim() : null;
    if (actual === expectedAction) return { ok: true };
  }
  const register = spawnSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", REGISTER_TASK_SCRIPT,
     "-NodeExe", process.execPath, "-LauncherScript", LAUNCHER_SCRIPT],
    { encoding: "utf8" });
  if (register.status === 0 && /^REGISTERED\b/m.test(register.stdout || "")) return { ok: true };
  return { ok: false, error: `register-launcher-task.ps1 exited ${register.status}: ` +
    `${(register.stdout || "").trim()} ${(register.stderr || "").trim()}`.trim() };
}

// Writes the work ticket job-launcher.mjs claims (see that file's header for the full protocol).
// Written to <jobId>.json in LAUNCHER_QUEUE_DIR (a fixed location -- see that const's comment for
// why it's not simply p.d); job-launcher.mjs renames it to <jobId>.claimed.json in the same
// directory as its atomic claim mechanism. jobDir is carried inside the ticket so job-launcher.mjs
// can find/write the job's own artifacts (launched.marker) without needing to know JOB_ROOT.
// extraEnv (e.g. CLAUDE_ASYNC_DEPTH for the new job) rides in the existing envOverrides field, so
// job-launcher.mjs needs no change to honor it.
export function writeLaunchTicket(p, extraEnv = {}) {
  const jobId = path.basename(p.d);
  const ticket = {
    jobId,
    jobDir: p.d,
    specPath: p.spec,
    errPath: p.err,
    nodeExe: process.execPath,
    runnerScript: RUNNER,
    envOverrides: { ...collectEnvOverrides(), ...extraEnv },
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(LAUNCHER_QUEUE_DIR, `${jobId}.json`), ticket);
}

// Primary win32 launch path as of the 2026-09-09 Task Scheduler launcher work: gives
// job-runner.mjs an ancestor (svchost's Task Scheduler service, via job-launcher.mjs) that was
// never inside Claude Desktop's Job Object to begin with, rather than asking a runner already
// inside that job to breakaway from it (win32-breakaway.ps1's approach, which still left runners
// self-reporting membership in a job with KILL_ON_JOB_CLOSE set -- see RUNBOOK.md). Returns null
// when the task path failed AND its ticket is provably out of the queue, so launchWin32() can fall
// back to win32-breakaway.ps1 without the job ever running twice; never throws. A failed ticket
// write is logged to err.log and treated like a failed /Run, so the breakaway fallback still
// launches the job instead of startJob throwing with a reserved dir and no runner.
//
// The ticket is the hazard: any launcher instance claims any pending ticket, so a ticket left in the
// queue while the fallback starts the job would run the job a second time whenever a launcher next
// ran (this job's late-starting instance, or one triggered by another claude_start). So before
// returning null with a ticket written (a failed /Run, or no runner.pid within TASK_RUNNER_PID_POLL_MS)
// the ticket is removed under the launchers' own claim lock (withdrawTicket). If a launcher got there
// first (the ticket is gone or its lock is held) the launcher owns the job: no fallback. The bridge
// keeps polling runner.pid for TASK_CLAIMED_EXTRA_POLL_MS more and reports launchPath "task" if the
// runner shows up; if it never does the result carries pid null / pidSource "task-claimed-no-runner"
// and an err.log line (checkJob heals a late runner's pid from runner.pid, or reports it died).
// seams (tests only): ensureTask, writeTicket, runTask replace the schtasks-touching steps; pollMs
// and extraPollMs shorten the two runner.pid waits.
export async function launchWin32Task(p, extraEnv, seams = {}) {
  const { ensureTask = ensureLauncherTask, writeTicket = writeLaunchTicket,
          runTask = () => spawnSync("schtasks", ["/Run", "/TN", TASK_NAME], { encoding: "utf8" }),
          pollMs = TASK_RUNNER_PID_POLL_MS, extraPollMs = TASK_CLAIMED_EXTRA_POLL_MS } = seams;
  const reg = ensureTask();
  if (!reg.ok) {
    try { fs.appendFileSync(p.err, `\n[job-core] ensureLauncherTask() failed: ${reg.error}\n`); } catch {}
    return null;
  }

  // Same defense-in-depth as launchWin32Breakaway(): a stray runner.pid must never survive from
  // a prior occupant of this job dir.
  try { fs.unlinkSync(path.join(p.d, "runner.pid")); } catch {}
  try { writeTicket(p, extraEnv); }
  catch (e) {
    try { fs.appendFileSync(p.err, `\n[job-core] launch ticket could not be written: ${e.message}\n`); } catch {}
    return null;
  }

  // Same job-membership query as the breakaway path, logged for the record -- but NOTE (verified
  // 2026-09-09 while building this): inJob:true with limitFlags 0x3C00 is NOT reliable evidence
  // of nesting inside Desktop's specific job. Windows places essentially any console-attached
  // process into a default per-console job with those exact flags regardless of ancestry
  // (confirmed: a bare `node -e ...` from a plain terminal, zero relation to Desktop, self-reports
  // identically). The actual proof this launch path escapes Desktop's job is behavioral, not this
  // flag -- see test/survival.mjs and RUNBOOK.md. This WARN is diagnostic breadcrumb, not a verdict.
  const viaTask = (pid, pidSource) => {
    const jobMembership = queryJobMembershipOnce(pid);
    if (jobMembership.inJob) {
      try { fs.appendFileSync(p.err, `\n[job-core] NOTE: task-launched runner pid=${pid} self-reports job ` +
        `membership at launch time (jobMembership=${JSON.stringify(jobMembership)}) -- see RUNBOOK.md's ` +
        `caveat on why this alone doesn't indicate a problem; test/survival.mjs is the real check\n`); } catch {}
    }
    return { pid, pidSource, jobMembership, launchPath: "task" };
  };

  const run = runTask();
  if (run.status === 0) {
    const { pid, pidSource } = await readRunnerPid(p, null, pollMs);
    if (pid) return viaTask(pid, pidSource);
  } else {
    try { fs.appendFileSync(p.err, `\n[job-core] schtasks /Run /TN ${TASK_NAME} failed (status=${run.status}): ` +
      `${(run.stdout || "").trim()} ${(run.stderr || "").trim()}\n`); } catch {}
  }

  // The task path did not produce a runner. Before anyone else launches this job, take the ticket back.
  const outcome = withdrawTicket({ queueDir: LAUNCHER_QUEUE_DIR, jobId: path.basename(p.d),
    log: (l) => { try { fs.appendFileSync(p.err, `\n[job-core] ${l}\n`); } catch {} } });
  if (outcome === "removed") {
    try { fs.appendFileSync(p.err, "\n[job-core] removed the still-pending launch ticket before falling back\n"); } catch {}
    return null; // caller falls back to breakaway
  }
  try { fs.appendFileSync(p.err, `\n[job-core] launch ticket not withdrawn (${outcome}): a launcher owns this job, so it is NOT ` +
    `launched a second way; waiting up to ${extraPollMs}ms more for runner.pid\n`); } catch {}
  const late = await readRunnerPid(p, null, extraPollMs);
  if (late.pid) return viaTask(late.pid, late.pidSource);
  try { fs.appendFileSync(p.err, "\n[job-core] no runner.pid after the extra wait; the launcher that claimed this job never started " +
    "it (see job-launcher.log in the launcher queue dir). Not launching it a second way; retry claude_start with the same jobId\n"); } catch {}
  return { pid: null, pidSource: "task-claimed-no-runner", launchPath: "task" };
}

// seams (tests only): mode overrides WIN32_LAUNCH_MODE, breakaway replaces launchWin32Breakaway, and
// the rest are passed through to launchWin32Task.
export async function launchWin32(p, extraEnv, seams = {}) {
  const { mode = WIN32_LAUNCH_MODE, breakaway = launchWin32Breakaway } = seams;
  if (mode !== "breakaway") {
    const viaTask = await launchWin32Task(p, extraEnv, seams);
    if (viaTask) return viaTask;
    try { fs.appendFileSync(p.err,
      "\n[job-core] Task Scheduler launch path unavailable/failed; falling back to win32-breakaway.ps1\n");
    } catch {}
  }
  const viaBreakaway = await breakaway(p, extraEnv);
  return { ...viaBreakaway, launchPath: "breakaway-fallback" };
}

function launchPosix(p, extraEnv = {}) {
  const child = spawn(process.execPath, [RUNNER, p.spec],
    { detached: true, stdio: "ignore", env: { ...process.env, ...extraEnv } });
  child.on("error", (e) => recordLaunchFailure(p, `failed to spawn job-runner: ${e.message}`));
  child.unref();
  return { pid: child.pid, pidSource: "runner", launchPath: "spawn" };
}

// launchExtra.container (container jobs only): the runner's container record (name, docker binary,
// repo path, git-state baseline), written into spec.json. Host jobs pass nothing, so their
// spec.json is unchanged.
async function launch(p, command, argv, cwd, extraEnv = {}, launchExtra = {}) {
  writeJsonAtomic(p.spec, { command, argv, cwd, out: p.out, err: p.err, exit: p.exit,
                            ...(launchExtra.container ? { container: launchExtra.container } : {}) }, { space: 0 });
  return process.platform === "win32" ? launchWin32(p, extraEnv) : launchPosix(p, extraEnv);
}

// Job ids reach the filesystem as a directory name under JOB_ROOT (and, via host-api.mjs, arrive
// from the network), so anything that could escape JOB_ROOT ("..", separators) is refused outright.
export function isSafeJobId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id);
}

// Resolves the Claude Code binary the way the launch path will actually find it, or null. A path
// must be an existing file. A bare name is searched on PATH as libuv's spawn() would (as-is if it
// already has an extension, else .com/.exe on win32), then job-launcher.mjs's resolveCommand()
// fallback (~/.local/bin/<name>.exe), so preflight agrees with what the launcher can run.
export function resolveBinary(bin, env = process.env) {
  if (!bin) return null;
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  if (/[\\/]/.test(bin)) return isFile(bin) ? bin : null;
  const win = process.platform === "win32";
  const exts = win && !path.extname(bin) ? [".com", ".exe"] : [""];
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  for (const dir of String(pathKey ? env[pathKey] : "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  if (win) {
    const fallback = path.join(os.homedir(), ".local", "bin", `${bin}.exe`);
    if (isFile(fallback)) return fallback;
  }
  return null;
}

export const PREFLIGHT_OK = "preflight passed, execution unverified";

// Design item 7: checked on the EXECUTING host before anything is written or detached. Success
// only means the binary and workFolder exist -- the runner still records any startup failure in
// the job record, which is why the success wording says "execution unverified".
export function preflight({ claudeBin = CLAUDE_BIN, cwd, hostLabel }) {
  if (!resolveBinary(claudeBin)) {
    return { error: `preflight failed on ${hostLabel}: Claude Code binary ${JSON.stringify(claudeBin)} not found` };
  }
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
  if (!isDir) return { error: `preflight failed on ${hostLabel}: workFolder ${JSON.stringify(cwd)} does not exist` };
  return { ok: PREFLIGHT_OK };
}

// A job counts against the concurrency cap if it has no exit_code and either checkJob() calls it
// running, or it has no meta.json yet (its dir was reserved by a start whose launch is still in
// flight -- the task path can take up to TASK_RUNNER_PID_POLL_MS before meta.json lands).
//
// Fail closed: a dir whose meta.json is missing or unreadable (half-written, corrupt) must not
// silently drop out of the count, or a running job could escape the cap. It counts as running if
// the dir or its meta.json was modified within INFLIGHT_RESERVATION_MS (a running job's heartbeat
// keeps touching its dir). An older one is not counted -- one corrupt dir can never permanently eat
// a slot -- but is returned in `warnings` so the start response names it.
//
// Three distinct problems, all on the same freshness rule (never skipped, which would fail open):
// no meta.json; a meta.json that does not parse to a JSON object (truncated, or e.g. `null`); and a
// readable meta.json whose checkJob() status check throws (an unreadable exit_code, say). The last
// is labeled as its own thing so the warning does not blame a meta.json that is fine.
// `check` is a test seam for checkJob. Returns { count, warnings }.
export const INFLIGHT_RESERVATION_MS = 2 * 60 * 1000;
export function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
export function countActiveJobs(nowMs, { check = checkJob } = {}) {
  let count = 0;
  const warnings = [];
  let ids = [];
  try { ids = fs.readdirSync(JOB_ROOT); } catch {}
  for (const id of ids) {
    const p = jobPaths(id);
    let dirStat;
    try { dirStat = fs.statSync(p.d); } catch { continue; } // raced away
    if (!dirStat.isDirectory() || fs.existsSync(p.exit)) continue;
    let problem = null;
    let running = false;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(p.meta, "utf8")); }
    catch (e) { problem = e.code === "ENOENT" ? "has no meta.json" : `has an unreadable meta.json (${e.message})`; }
    if (!problem && !isPlainObject(meta)) problem = "has an unreadable meta.json (not a JSON object)";
    if (!problem) {
      // containerCleanup:false: the cap count only needs a status, never docker housekeeping (which
      // could spend docker timeouts inside the start lock when the daemon is down).
      try { running = check(id, 0, { containerCleanup: false }).status === "running"; }
      catch (e) { problem = `has a readable meta.json but its status check failed (${e.message})`; }
    }
    if (!problem) { if (running) count++; continue; }
    let lastModMs = dirStat.mtimeMs;
    try { lastModMs = Math.max(lastModMs, fs.statSync(p.meta).mtimeMs); } catch {}
    const ageMs = nowMs - lastModMs; // negative (clock skew) counts as recent: fail closed
    if (ageMs < INFLIGHT_RESERVATION_MS) count++;
    else warnings.push(`job dir ${id} ${problem} and was last modified ${Math.round(ageMs / 60000)} min ago ` +
      `(outside the ${INFLIGHT_RESERVATION_MS / 60000} min reservation window), so it is NOT counted toward the ` +
      `concurrency cap; repair or remove ${p.d}`);
  }
  return { count, warnings };
}

// Writes the new job's meta.json AFTER the runner is already launched and a card minted, so this
// must never throw: there is no old meta.json for atomicity to protect (the file does not exist
// yet), and a throw would leave a running job with a card and no meta. Atomic write first, then a
// direct write, then -- if both fail -- an err.log line. Returns null on success, else the error
// message of the last failure (the caller turns it into a response warning).
function writeNewMeta(p, meta, fsImpl = fs) {
  try { writeJsonAtomic(p.meta, meta, { fsImpl }); return null; } catch {}
  try { fsImpl.writeFileSync(p.meta, JSON.stringify(meta, null, 2)); return null; }
  catch (e) {
    try { fsImpl.appendFileSync(p.err, `\n[job-core] meta.json could not be written: ${e.message}; ` +
      `the job IS running as pid ${meta.pid}\n`); } catch {}
    return e.message;
  }
}

// opts (all optional): host (executing host name, e.g. "claunker" -- recorded in meta and used in
// error text), caps (see guard.mjs resolveCaps), depth (the CALLER's dispatch depth; default from
// CLAUDE_ASYNC_DEPTH), now (Date, tests), claudeBin + launch (test seams: the preflight binary and
// a replacement for launch() so tests never touch schtasks or spawn a runner), fsImpl (test seam
// for the post-launch meta.json write, see writeNewMeta()). Container-mode seams (tests only):
// sandboxDefault (replaces CLAUDE_ASYNC_JOB_SANDBOX), allowedSandboxes (replaces
// CLAUDE_ASYNC_ALLOWED_SANDBOXES), containerConfig (replaces
// loadContainerConfig()), checkImage (replaces the `docker image inspect` preflight).
// repo / baseRef: container jobs only ("owner/repo" cloned inside the container, and the ref to
// start from); a host job that passes either is refused, so host-mode calls are unaffected.
// Order is deliberate: every rejection happens before the job dir or ticket exists.
export async function startJob({ prompt, workFolder, jobId, model, effort, intent, sandbox, repo, baseRef }, opts = {}) {
  const hostname = os.hostname();
  const hostLabel = opts.host ? `host ${opts.host} (${hostname})` : `host ${hostname}`;
  const fail = (errorCode, error) => ({ error, errorCode, ...(opts.host ? { host: opts.host } : {}), hostname });

  const id = (jobId || `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!isSafeJobId(id)) return fail("invalid", `invalid jobId ${JSON.stringify(id)}`);
  const cwd = workFolder || DEFAULT_CWD;

  const sb = resolveSandbox(sandbox, opts.sandboxDefault !== undefined ? opts.sandboxDefault : SANDBOX_ENV_DEFAULT,
                            "allowedSandboxes" in opts ? opts.allowedSandboxes : ALLOWED_SANDBOXES_ENV);
  if (sb.error) return fail("invalid", sb.error);
  if (sb.mode === "host" && ((repo !== undefined && repo !== null && repo !== "") || (baseRef !== undefined && baseRef !== null && baseRef !== ""))) {
    return fail("invalid", "repo and baseRef are only for container jobs (sandbox: \"container\"); a host job runs in workFolder");
  }
  // Container mode: validate the repo name, secrets file, config, docker binary and image now,
  // before anything is written (see container.mjs's planContainerJob()). No host folder is
  // involved: the job clones `repo` inside the container.
  let containerPlan = null;
  if (sb.mode === "container") {
    const planned = planContainerJob({ jobId: id, repo, baseRef, workFolder, cfg: opts.containerConfig || loadContainerConfig(),
                                       resolveBin: (b) => resolveBinary(b) });
    if (planned.error) return fail("preflight", `preflight failed on ${hostLabel}: ${planned.error}`);
    const img = (opts.checkImage || checkDockerImage)({ dockerBin: planned.plan.dockerBin, image: planned.plan.image });
    if (img.error) return fail("preflight", `preflight failed on ${hostLabel}: ${img.error}`);
    // Run exactly the image just inspected (by ID, with --pull=never), not whatever the tag names later.
    containerPlan = { ...planned.plan, imageId: img.imageId };
  }

  // A container job has no workFolder; preflight only checks the docker binary (JOB_ROOT always exists).
  const pf = preflight({ claudeBin: containerPlan ? containerPlan.dockerBin : opts.claudeBin,
                         cwd: containerPlan ? JOB_ROOT : cwd, hostLabel });
  if (pf.error) return fail("preflight", pf.error);

  const d = opts.depth !== undefined ? parseDepth(opts.depth) : parseDepth(process.env[DEPTH_ENV]);
  if (d.error) return fail("depth", `${d.error}; no job started`);
  const depthError = checkDepth(d.depth);
  if (depthError) return fail("depth", depthError);

  const p = jobPaths(id);
  const nowMs = (opts.now || new Date()).getTime();
  const caps = resolveCaps(opts.caps);
  const reserved = await withStartLock(JOB_ROOT, () => {
    if (fs.existsSync(p.d)) return fail("duplicate", `jobId ${id} already exists`);
    const active = countActiveJobs(nowMs);
    const capError = checkCaps({ running: active.count, startsInWindow: recentStarts(JOB_ROOT, nowMs).length,
                                 caps, hostLabel });
    if (capError) {
      return { ...fail(capError.errorCode, capError.error), ...(active.warnings.length ? { warnings: active.warnings } : {}) };
    }
    // Non-recursive mkdir is the atomic duplicate check (EEXIST), even against a racer that
    // bypassed the lock; JOB_ROOT itself is created at module load.
    try { fs.mkdirSync(p.d); }
    catch (e) {
      return e.code === "EEXIST" ? fail("duplicate", `jobId ${id} already exists`)
                                 : fail("invalid", `could not create job dir: ${e.message}`);
    }
    recordStart(JOB_ROOT, nowMs);
    return { ok: true, warnings: active.warnings };
  });
  if (reserved.error) return reserved.errorCode ? reserved : fail("lock", reserved.error);

  // Per-job HERMES_HOME isolation (see JOB_HERMES_HOME_ISOLATION_ENV_DEFAULT above). Computed
  // here, before --settings is built below, because the job-tool-gate hook's command string
  // needs the LIVE value baked in at build time (see buildNoBackgroundHookSettings).
  const liveHermesHome = process.env.HERMES_HOME || null;
  const hermesHomeIsolationEnabled = opts.hermesHomeIsolation !== undefined
    ? Boolean(opts.hermesHomeIsolation) : JOB_HERMES_HOME_ISOLATION_ENV_DEFAULT;
  // Container jobs never see the host's HERMES_HOME (nothing from the host env reaches the
  // container except container.mjs's allowlist), so there is nothing to isolate for them.
  const jobHermesHome = hermesHomeIsolationEnabled && !containerPlan ? path.join(p.d, "hermes_home") : null;
  if (jobHermesHome) fs.mkdirSync(jobHermesHome, { recursive: true });

  const safePermissionsEnabled = opts.safePermissions !== undefined ? Boolean(opts.safePermissions) : SAFE_PERMISSIONS_ENV_DEFAULT;
  const argv = ["-p", prompt, "--strict-mcp-config", "--mcp-config", EMPTY_MCP];
  argv.push(...(safePermissionsEnabled ? ["--permission-mode", "dontAsk"] : ["--dangerously-skip-permissions"]));
  const resolvedModel = model || DEFAULT_MODEL;
  argv.push("--model", resolvedModel);
  // Effort routing (argv-only — never mutate process.env; it leaks across detached jobs).
  const eff = (effort || DEFAULT_EFFORT).toLowerCase();
  // Every claude-async job gets the no-background-hook settings; ultracode merges its own
  // `ultracode: true` into the SAME object below rather than pushing a second --settings flag
  // (two --settings flags were observed to let the later one win outright, silently dropping
  // whichever of ultracode/hooks lost that race).
  const toolGateEnabled = opts.toolGate !== undefined ? Boolean(opts.toolGate) : JOB_TOOL_GATE_ENV_DEFAULT;
  const settingsObj = buildNoBackgroundHookSettings({ toolGate: toolGateEnabled, liveHermesHome, ollamaGuard: safePermissionsEnabled });
  if (safePermissionsEnabled) Object.assign(settingsObj, buildSafePermissionsSettings());
  if (eff === "ultracode") {
    // ultracode = xhigh effort (explicit, not ambient) + standing dynamic-workflow orchestration.
    // xhigh is pushed explicitly so ultracode delivers its defined effort regardless of the
    // ambient effortLevel, rather than inheriting it from settings.json.
    argv.push("--effort", "xhigh");
    // STEP 1 confirmed `--settings '{"ultracode":true}'` surfaces the Workflow tool headlessly,
    // so use the settings mechanism (not the prompt-keyword fallback) to enable the composite.
    settingsObj.ultracode = true;
  } else if (FLAG_EFFORT.has(eff)) {
    argv.push("--effort", eff);
  } // else: unrecognized → leave unset, inheriting settings.json effortLevel.
  argv.push("--settings", JSON.stringify(settingsObj));
  // The new job runs one level deeper than its caller (guard.mjs's depth accident guard).
  const extraEnv = { [DEPTH_ENV]: String(d.depth + 1) };
  // CLAUDE_ASYNC_JOB_EFFORT: tells hooks/no-background-hook.mjs this job's effort level, so it
  // can gate the Workflow tool to ultracode-effort jobs without guessing (job-core.mjs is the
  // only place that knows `eff` authoritatively). Set on the launched CLI process's own
  // environment, not embedded in the --settings hook command -- empirically confirmed on
  // 2026-10-19 that env vars set here propagate down to the hook subprocess the CLI spawns per
  // tool call (same inheritance chain as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS below).
  extraEnv.CLAUDE_ASYNC_JOB_EFFORT = eff;
  // job-tool-gate env passthrough (only set when the gate is actually wired in above, so a
  // disabled gate leaves the launched process's env byte-identical to today's): the hook
  // (hooks/job-tool-gate-hook.mjs) reads these to find and call the claunker-hermes gate
  // subprocess. CLAUDE_ASYNC_GATE_REPO has no safe default -- there is no claunker-hermes
  // checkout path this repo can assume exists -- so it must come from opts.gateRepo or the
  // env var; an operator enabling CLAUDE_ASYNC_JOB_TOOL_GATE without also setting
  // CLAUDE_ASYNC_GATE_REPO gets a hook that denies every tool call (fail-closed, loudly, not a
  // silent no-op) rather than one that never engages at all.
  if (toolGateEnabled) {
    const gateRepo = opts.gateRepo || process.env.CLAUDE_ASYNC_GATE_REPO;
    if (gateRepo) extraEnv.CLAUDE_ASYNC_GATE_REPO = gateRepo;
    if (process.env.CLAUDE_ASYNC_GATE_PYTHON) extraEnv.CLAUDE_ASYNC_GATE_PYTHON = process.env.CLAUDE_ASYNC_GATE_PYTHON;
    if (process.env.CLAUDE_ASYNC_GATE_TIMEOUT_MS) extraEnv.CLAUDE_ASYNC_GATE_TIMEOUT_MS = process.env.CLAUDE_ASYNC_GATE_TIMEOUT_MS;
  }
  // 2026-10-18 claunker.gemini-mcp-v2-20261018-pfvzx44f: default the CLI's own background-task
  // wait ceiling to a finite BG_WAIT_CEILING_MS (see its definition above for why not 0) so a
  // job's background work (subagents handed off and the turn ended) finishes instead of being
  // killed mid-flight at the CLI's internal 600s default -- which silently looked like success
  // (exit 0, nothing in exitCode/status pointing at a kill).
  // Only set it when the bridge's own ambient env hasn't already: collectEnvOverrides() (below)
  // forwards any CLAUDE_*/ANTHROPIC_* var already in process.env into the launch ticket, and
  // extraEnv here takes precedence over that forwarding, so setting it unconditionally would
  // stomp an operator's deliberate override.
  if (process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS === undefined) {
    extraEnv.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = String(BG_WAIT_CEILING_MS);
  }
  // 2026-10-19 auto-background gap (see JOB_BASH_MAX_TIMEOUT_MS's definition above for the full
  // story and citations). Every non-ultracode job gets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: a
  // foreground Bash/PowerShell command that outruns its timeout is killed/interrupted visibly
  // instead of silently handed to the CLI's own auto-background pathway. Skipped for ultracode
  // because its Workflow tool is always-background by design (same flag would disable that too,
  // and there is no finer-grained switch) -- the PreToolUse hook (hooks/no-background-hook.mjs)
  // remains the only enforcement for ultracode jobs' own tool calls; the CLI-internal
  // auto-background gap for bare shell commands stays open there, as a documented tradeoff.
  // BASH_MAX_TIMEOUT_MS is raised for every job regardless of effort, so removing the
  // auto-background clamp doesn't also mean slow-but-legitimate commands get killed sooner than
  // before. Same ambient-override guard as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS above.
  if (eff !== "ultracode" && process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === undefined) {
    extraEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  }
  // BASH_MAX_TIMEOUT_MS isn't CLAUDE_*/ANTHROPIC_*-prefixed, so collectEnvOverrides() below never
  // forwards an ambient value on its own -- set it explicitly here either way (ambient value wins
  // when present) rather than only skipping like the CLAUDE_CODE_* vars above.
  extraEnv.BASH_MAX_TIMEOUT_MS = process.env.BASH_MAX_TIMEOUT_MS ?? String(JOB_BASH_MAX_TIMEOUT_MS);
  // Per-job HERMES_HOME isolation (see JOB_HERMES_HOME_ISOLATION_ENV_DEFAULT above). The live
  // value is always forwarded (when one exists) as CLAUNKER_LIVE_HERMES_HOME regardless of
  // whether isolation itself is on, so a job can still find the real chassis read-only if its
  // prompt legitimately needs to, and so "opt-out leaves it unchanged" is externally observable.
  // HERMES_HOME itself is only overridden to the job's own tmp dir when isolation is enabled;
  // opting out (CLAUDE_ASYNC_JOB_HERMES_HOME_ISOLATION=0) leaves the launched process's env
  // byte-identical to pre-isolation behavior (inherits the ambient HERMES_HOME via baseEnv's
  // ...process.env spread in launch(), same as every var this function doesn't touch).
  if (liveHermesHome) extraEnv.CLAUNKER_LIVE_HERMES_HOME = liveHermesHome;
  if (jobHermesHome) extraEnv.HERMES_HOME = jobHermesHome;
  // Container mode: the runner spawns `docker run ...` instead of the CLI. The CLI argv inside the
  // container is built by container.mjs (same prompt/model/effort, --dangerously-skip-permissions
  // because the container is the boundary); the host argv built above is not used.
  let launchCommand = opts.claudeBin || CLAUDE_BIN;
  let launchArgv = argv;
  // The docker client runs in the job's own dir: a container job has no host folder at all.
  const launchCwd = containerPlan ? p.d : cwd;
  const launchExtra = {};
  if (containerPlan) {
    const effortArgv = eff === "ultracode" ? ["--effort", "xhigh"] : FLAG_EFFORT.has(eff) ? ["--effort", eff] : [];
    const cliArgv = buildContainerCliArgv({ prompt, model: resolvedModel, effortArgv,
                                            settings: buildContainerSettings({ ultracode: eff === "ultracode" }) });
    launchArgv = buildDockerRunArgv({ plan: containerPlan, cliArgv, extraEnv });
    launchCommand = containerPlan.dockerBin;
    // jobId: the claude-async.job label every cleanup lists by; maxRuntimeMs: the runner's wall-clock limit.
    launchExtra.container = { name: containerPlan.name, jobId: id, dockerBin: containerPlan.dockerBin, repo: containerPlan.repo,
                              maxRuntimeMs: containerPlan.cfg.maxRuntimeMs };
  }
  const { pid, pidSource, jobMembership, launchPath } =
    await (opts.launch || launch)(p, launchCommand, launchArgv, launchCwd, extraEnv, launchExtra);

  // Container jobs: no host git, anywhere (noGit). There is no host clone to look at, and the
  // delivery is the PR the job reports on stdout (job-runner.mjs records it in exit.json).
  const { cardId, startHead, error: cardError } = containerPlan
    ? mintCard(id, launchCwd, resolvedModel, eff, prompt, intent, { noGit: true })
    : mintCard(id, cwd, resolvedModel, eff, prompt, intent);
  // Bounded the same way card-hook.mjs bounds it for the card body (boundIntent), so the Discord
  // ping's title (discord-notify.mjs) can use the same value the dispatch card shows -- omitted
  // entirely (no key) when no intent was given, rather than stored as null/empty.
  const persistedIntent = boundIntent(intent);
  const meta = { jobId: id, ...(opts.host ? { host: opts.host } : {}), hostname,
                 pid, pidSource, launchPath, ...(jobMembership ? { jobMembership } : {}),
                 workFolder: containerPlan ? null : cwd, model: resolvedModel, effort: eff, depth: d.depth + 1,
                 prompt: prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt,
                 startedAt: new Date().toISOString(),
                 cardId: cardId || null, startHead: startHead || null,
                 ...(persistedIntent ? { intent: persistedIntent } : {}),
                 ...(jobHermesHome ? { hermesHome: jobHermesHome } : {}),
                 ...(containerPlan ? { sandbox: "container", container: { name: containerPlan.name,
                       image: containerPlan.image, imageId: containerPlan.imageId, dockerBin: containerPlan.dockerBin,
                       jobId: id, repo: containerPlan.repo, baseRef: containerPlan.baseRef || null } } : {}) };
  const metaError = writeNewMeta(p, meta, opts.fsImpl);
  const warnings = [...(reserved.warnings || []),
    ...(metaError ? [`meta.json could not be written: ${metaError}; the job IS running as pid ${pid}; claude_check will not find it`] : [])];
  const note = cardError
    ? `UNCARDED: ${cardError} — Job detached. Poll with claude_check(jobId). Safe across bridge restarts.`
    : "Job detached. Poll with claude_check(jobId). Safe across bridge restarts.";
  return { ...meta, status: "running", preflight: PREFLIGHT_OK, note,
           ...(warnings.length ? { warnings } : {}) };
}

// opts.containerCleanup === false: skip container housekeeping (countActiveJobs). opts.cleanupContainers:
// test seam replacing container.mjs's cleanupJobContainers.
export function checkJob(id, tailBytes = 8000, opts = {}) {
  const hostname = os.hostname();
  if (!isSafeJobId(id)) return { jobId: id, hostname, status: "unknown", error: "invalid jobId" };
  const p = jobPaths(id);
  if (!fs.existsSync(p.meta)) return { jobId: id, hostname, status: "unknown", error: "no such job" };
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  let state, exitCode = null, finishedAt = null;
  const extra = {};
  // Read once, up front: both the "completed/incomplete vs failed" classification below and
  // diedCause (further down) key off it.
  const exitRecord = readExitJson(p);

  if (fs.existsSync(p.exit)) {
    exitCode = parseInt(fs.readFileSync(p.exit, "utf8").trim(), 10);
    finishedAt = fs.statSync(p.exit).mtime.toISOString();
    // 2026-10-18 claunker.gemini-mcp-v2-20261018-pfvzx44f / claunker.bg-wait-agent-test-20261018-se7vmzea:
    // an exit-0 run must not read as "completed" when the CLI was killed by its own background-task
    // wait ceiling (exitReason "bg_tasks_terminated") or never wrote its final-report marker
    // (reportComplete:false) -- see classifyFinalStatus's own header. card-hook.mjs's closeCard()
    // reuses this exact rule so a card's done/fail disposition never disagrees with this status.
    state = classifyFinalStatus(exitCode, exitRecord);
  } else {
    const lastAlive = readLastAlive(p.heartbeat);
    if (lastAlive === null) {
      // Legacy record: no runner_heartbeat file — classify by pid re-stat alone.
      // (Jobs started before heartbeat was added; never leaves them "running" forever.)
      state = (pidAlive(meta.pid) || healMetaPid(p, meta)) ? "running" : "died";
    } else {
      const ageMs = Date.now() - lastAlive.getTime();
      extra.lastAlive = lastAlive.toISOString();

      if (ageMs < HEARTBEAT_FRESH_MS) {
        // Heartbeat is recent — definitely running.
        state = "running";
        if (meta.startedAt) extra.elapsed = formatElapsed(Date.now() - new Date(meta.startedAt).getTime());
      } else if (ageMs >= JOB_TIMEOUT_MS) {
        // Heartbeat is older than the global ceiling — timed_out regardless of pid.
        state = "timed_out";
      } else {
        // Stale window (3 min – timeout): re-stat the pid for additional signal.
        if (pidAlive(meta.pid)) {
          if (isOurProcess(meta.pid)) {
            // Pid alive and looks like node/claude — heartbeat may have lagged.
            state = "running";
            extra.stalled = true;
            if (meta.startedAt) extra.elapsed = formatElapsed(Date.now() - new Date(meta.startedAt).getTime());
          } else {
            // Pid reused by a foreign process (recycling observed in the field: e.g. Code.exe).
            state = "died";
            extra.pidNote = "pid recycled to foreign process";
          }
        } else if (healMetaPid(p, meta)) {
          // meta.pid was a wrapper-fallback pid that has since exited; runner.pid now points to
          // the real (still alive) runner. Heal and treat as running, same as the lagging-heartbeat
          // case above.
          state = "running";
          extra.stalled = true;
          extra.pidHealed = true;
          if (meta.startedAt) extra.elapsed = formatElapsed(Date.now() - new Date(meta.startedAt).getTime());
        } else {
          // Process gone without writing exit_code — crashed or SIGKILL'd.
          state = "died";
        }
      }
    }
  }

  if ((state === "died" || state === "timed_out") && meta.cardId && !meta.cardReaped) {
    const reap = failCard(meta.cardId);
    if (reap.ok) {
      meta.cardReaped = true;
      try { writeJsonAtomic(p.meta, meta); } catch {}
    } else {
      extra.reapError = reap.error || "reap failed";
    }
  }

  // Container jobs: once the job is terminal (exit_code written, or the runner died/timed out), make
  // sure nothing it owns is still running, and keep retrying on every check until that is
  // CONFIRMED (see reconcileContainerCleanup). A running job is left to its runner.
  if (meta.sandbox === "container" && meta.container && opts.containerCleanup !== false) {
    const terminal = exitCode !== null || state === "died" || state === "timed_out";
    if (terminal) {
      const cl = reconcileContainerCleanup(p, meta, exitRecord, { by: "checkJob", runnerFinished: exitCode !== null,
                                                                   cleanup: opts.cleanupContainers });
      extra.containerCleanup = cl.confirmed ? "confirmed" : "unconfirmed";
      if (!cl.confirmed && cl.reason) extra.containerCleanupError = cl.reason;
    }
  }

  const runnerJobMembership = readRunnerJobMembership(p);

  // reportComplete (exit.json, written by job-runner.mjs's recordExit()) measures only whether
  // stdout ever carried the configured completeness marker (default: a line matching
  // ^DELEGATION-METRICS:, see discord-notify.mjs's loadCompletenessConfig/hasCompletenessMarker)
  // before the process exited -- NOT whether the job "succeeded". false means the run ended
  // (any status, as long as it wasn't already failed -- see the "incomplete" branch above)
  // without ever writing that final-report line, e.g. because it handed off to a background task
  // and ended its turn, asked a question, or was cut off mid-report. Surfaced here as its own
  // top-level field + a human-readable warning (previously only visible nested under
  // `exit.reportComplete`) in addition to (not instead of) downgrading status to "incomplete".
  if (exitRecord && exitRecord.reportComplete === false) {
    extra.reportIncomplete = true;
    extra.warning = "job exited without ever writing a final report (no completeness marker " +
      "found in stdout) -- it may have stopped early, e.g. by handing off to a background task " +
      "and ending its turn";
  }

  // A container job the runner stopped at its wall-clock limit reads as timed_out, like a host job
  // whose heartbeat went stale past JOB_TIMEOUT_MS. Applied after the reaps above: the runner has
  // already closed the card and cleaned up through its normal path.
  if (exitCode !== null && exitRecord && exitRecord.exitReason === "container_max_runtime") state = "timed_out";

  return { ...meta, hostname, status: state, exitCode, finishedAt, ...extra,
           ...(runnerJobMembership ? { runnerJobMembership } : {}),
           ...(exitRecord !== undefined ? { exit: exitRecord } : {}),
           ...(state === "died" ? { diedCause: classifyDiedCause(exitRecord) } : {}),
           stdout: readTail(p.out, tailBytes), stderr: readTail(p.err, tailBytes) };
}

// ------------------------------------------------------------------ container cleanup state ---
//
// A container job's cleanup is tracked separately from the CLI's completion: exit_code says the
// docker client exited, not that nothing the job owns is still running (the client can exit, or be
// killed, while its container keeps going, and the final removal can fail while the daemon is
// unreachable). Cleanup is CONFIRMED only when (a) docker lists no container with the job's
// claude-async.job label after removing what it found, and (b) no launch can still be pending:
// either the runner finished (its finish() kills the client first), or the docker client pid the
// runner recorded is gone. Confirmation is stored once -- by the runner in exit.json
// (container.cleanup.confirmed) or by job-core in meta.json (containerCleanup) -- and every later
// check/cancel retries until then.

export function containerCleanupConfirmed(meta, exitRecord) {
  return !!((exitRecord && exitRecord.container && exitRecord.container.cleanup && exitRecord.container.cleanup.confirmed === true) ||
            (meta && meta.containerCleanup && meta.containerCleanup.confirmed === true));
}

// True while a `docker run` the runner started could still create (or start) a container: the
// runner has not finished and the docker client it recorded is still alive.
function containerLaunchPending(p, runnerFinished) {
  if (runnerFinished) return false;
  let pid = null;
  try { pid = Number(fs.readFileSync(p.dockerPid, "utf8").trim()) || null; } catch {}
  return pid !== null && pidAlive(pid);
}

function writeCancelIntent(p, why) {
  if (fs.existsSync(p.cancel)) return;
  try { fs.writeFileSync(p.cancel, `${new Date().toISOString()} ${why}\n`); } catch {}
}

// Removes whatever the job still owns and confirms if it can. Returns { confirmed, removed, reason }.
function reconcileContainerCleanup(p, meta, exitRecord, { by, runnerFinished, cleanup }) {
  if (containerCleanupConfirmed(meta, exitRecord)) return { confirmed: true, removed: 0 };
  // A runner that died before `docker run` must never start it later.
  if (!runnerFinished) writeCancelIntent(p, `${by}: runner not alive`);
  const jobId = (meta.container && meta.container.jobId) || meta.jobId || path.basename(p.d);
  let r;
  try { r = (cleanup || cleanupJobContainers)({ dockerBin: meta.container.dockerBin, jobId }); }
  catch (e) { r = { ok: false, error: e.message }; }
  if (!r.ok) return { confirmed: false, removed: r.removed || 0, reason: r.error || "docker cleanup failed" };
  if (!r.absent) return { confirmed: false, removed: r.removed, reason: `container(s) still present after docker rm -f: ${(r.remaining || []).map((x) => x.id.slice(0, 12)).join(", ")}` };
  if (containerLaunchPending(p, runnerFinished)) {
    return { confirmed: false, removed: r.removed, reason: "no container found, but the docker client is still alive and may still create one" };
  }
  meta.containerCleanup = { confirmed: true, at: new Date().toISOString(), by };
  try { writeJsonAtomic(p.meta, meta); } catch {}
  return { confirmed: true, removed: r.removed };
}

// Cancels a container job. The cancel intent is persisted FIRST (cancel_requested in the job dir):
// the runner checks it before `docker run` and on every poll while the client runs, so a cancel
// that lands before the container exists still stops it the moment it does. Then every container
// with the job's label is removed (`docker rm -f` by ID: running or still Created). The runner is
// left alone; once the container is gone the docker client exits (137) and the runner records the
// exit, card close and Discord ping through its normal path. For a job whose runner already
// finished, this is the cleanup retry: alreadyFinished is returned only once cleanup is confirmed.
// Host jobs are not cancellable here (unchanged from before container mode).
// opts.cleanupContainers: test seam replacing container.mjs's cleanupJobContainers.
export function cancelJob(id, opts = {}) {
  const hostname = os.hostname();
  if (!isSafeJobId(id)) return { jobId: id, hostname, error: "invalid jobId" };
  const p = jobPaths(id);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(p.meta, "utf8")); } catch { return { jobId: id, hostname, error: "no such job" }; }
  if (meta.sandbox !== "container" || !meta.container) {
    return { jobId: id, hostname, error: "cancel is only supported for container jobs (sandbox: \"container\")" };
  }
  const name = meta.container.name;
  const runnerFinished = fs.existsSync(p.exit);
  if (runnerFinished) {
    const exitRecord = readExitJson(p);
    const cl = reconcileContainerCleanup(p, meta, exitRecord, { by: "cancelJob", runnerFinished: true, cleanup: opts.cleanupContainers });
    if (cl.confirmed) return { jobId: id, hostname, ok: true, alreadyFinished: true, cleanup: "confirmed", container: name, removed: cl.removed };
    return { jobId: id, hostname, ok: false, cleanup: "unconfirmed", container: name,
             error: `the job has finished but its container cleanup is not confirmed: ${cl.reason}` };
  }
  writeCancelIntent(p, "cancelJob");
  try { fs.appendFileSync(p.err, `\n[job-core] cancel requested at ${new Date().toISOString()}; removing container ${name}\n`); } catch {}
  let r;
  try { r = (opts.cleanupContainers || cleanupJobContainers)({ dockerBin: meta.container.dockerBin, jobId: meta.container.jobId || id }); }
  catch (e) { r = { ok: false, error: e.message }; }
  const base = { jobId: id, hostname, ok: true, cancelRequested: true, container: name, cleanup: "pending" };
  if (!r.ok) {
    return { ...base, removed: 0, warning: `docker cleanup failed (${r.error}); the runner will remove the container when it sees the cancel request` };
  }
  return { ...base, removed: r.removed,
           ...(r.removed === 0 ? { note: "no container exists yet; the runner will not start one, or will stop it as soon as it exists" } : {}),
           ...(!r.absent ? { warning: "a container was still listed after docker rm -f; the runner and later checks keep retrying" } : {}) };
}

export function listJobs() {
  const ids = fs.existsSync(JOB_ROOT)
    ? fs.readdirSync(JOB_ROOT).filter((f) => fs.statSync(path.join(JOB_ROOT, f)).isDirectory())
    : [];
  return ids.map((id) => {
    const s = checkJob(id, 0);
    const row = { jobId: id, status: s.status, exitCode: s.exitCode ?? null, startedAt: s.startedAt ?? null };
    if (s.lastAlive) row.lastAlive = s.lastAlive;
    if (s.elapsed) row.elapsed = s.elapsed;
    if (s.stalled) row.stalled = true;
    if (s.pidNote) row.pidNote = s.pidNote;
    if (s.diedCause) row.diedCause = s.diedCause;
    if (s.intent) row.intent = s.intent;
    return row;
  }).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function runSelfTest() {
  const id = `selftest-${Date.now()}`;
  const p = jobPaths(id);
  fs.mkdirSync(p.d, { recursive: true });
  const { pid, pidSource } = await launch(p, process.execPath,
    ["-e", "setTimeout(() => console.log('SELFTEST_OK'), 300)"], JOB_ROOT);
  writeJsonAtomic(p.meta, { jobId: id, pid, pidSource, startedAt: new Date().toISOString() }, { space: 0 });

  const deadline = Date.now() + 5000;
  let s;
  do {
    await new Promise((r) => setTimeout(r, 150));
    s = checkJob(id);
  } while (s.status === "running" && Date.now() < deadline);

  const pass = s.status === "completed" && s.exitCode === 0 && s.stdout.includes("SELFTEST_OK");
  fs.rmSync(p.d, { recursive: true, force: true });
  console.log(pass ? "SELFTEST PASS — detach/poll/exit plumbing works"
                   : `SELFTEST FAIL — status=${s.status} exit=${s.exitCode} stdout=${JSON.stringify(s.stdout)}`);
  process.exit(pass ? 0 : 1);
}
