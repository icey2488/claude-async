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
import { mintCard, failCard } from "./card-hook.mjs";
import { queryJobMembershipOnce } from "./tools/jobMembership.mjs";
import { resolveCaps, parseDepth, checkDepth, checkCaps, withStartLock, recentStarts, recordStart,
         DEPTH_ENV } from "./guard.mjs";

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
           spec: path.join(d, "spec.json"), heartbeat: path.join(d, "runner_heartbeat") };
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
    try { fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2)); } catch {}
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
  fs.writeFileSync(path.join(LAUNCHER_QUEUE_DIR, `${jobId}.json`), JSON.stringify(ticket, null, 2));
}

// Primary win32 launch path as of the 2026-09-09 Task Scheduler launcher work: gives
// job-runner.mjs an ancestor (svchost's Task Scheduler service, via job-launcher.mjs) that was
// never inside Claude Desktop's Job Object to begin with, rather than asking a runner already
// inside that job to breakaway from it (win32-breakaway.ps1's approach, which still left runners
// self-reporting membership in a job with KILL_ON_JOB_CLOSE set -- see RUNBOOK.md). Returns null
// on any failure of the task path itself (registration, /Run, or the runner never showing up in
// time) so launchWin32() can fall back to win32-breakaway.ps1; never throws.
async function launchWin32Task(p, extraEnv) {
  const reg = ensureLauncherTask();
  if (!reg.ok) {
    try { fs.appendFileSync(p.err, `\n[job-core] ensureLauncherTask() failed: ${reg.error}\n`); } catch {}
    return null;
  }

  // Same defense-in-depth as launchWin32Breakaway(): a stray runner.pid must never survive from
  // a prior occupant of this job dir.
  try { fs.unlinkSync(path.join(p.d, "runner.pid")); } catch {}
  writeLaunchTicket(p, extraEnv);

  const run = spawnSync("schtasks", ["/Run", "/TN", TASK_NAME], { encoding: "utf8" });
  if (run.status !== 0) {
    try { fs.appendFileSync(p.err, `\n[job-core] schtasks /Run /TN ${TASK_NAME} failed (status=${run.status}): ` +
      `${(run.stdout || "").trim()} ${(run.stderr || "").trim()}\n`); } catch {}
    return null;
  }

  const { pid, pidSource } = await readRunnerPid(p, null, TASK_RUNNER_PID_POLL_MS);
  if (!pid) return null; // task-timeout -- caller falls back to breakaway

  // Same job-membership query as the breakaway path, logged for the record -- but NOTE (verified
  // 2026-09-09 while building this): inJob:true with limitFlags 0x3C00 is NOT reliable evidence
  // of nesting inside Desktop's specific job. Windows places essentially any console-attached
  // process into a default per-console job with those exact flags regardless of ancestry
  // (confirmed: a bare `node -e ...` from a plain terminal, zero relation to Desktop, self-reports
  // identically). The actual proof this launch path escapes Desktop's job is behavioral, not this
  // flag -- see test/survival.mjs and RUNBOOK.md. This WARN is diagnostic breadcrumb, not a verdict.
  const jobMembership = queryJobMembershipOnce(pid);
  if (jobMembership.inJob) {
    try { fs.appendFileSync(p.err, `\n[job-core] NOTE: task-launched runner pid=${pid} self-reports job ` +
      `membership at launch time (jobMembership=${JSON.stringify(jobMembership)}) -- see RUNBOOK.md's ` +
      `caveat on why this alone doesn't indicate a problem; test/survival.mjs is the real check\n`); } catch {}
  }
  return { pid, pidSource, jobMembership, launchPath: "task" };
}

async function launchWin32(p, extraEnv) {
  if (WIN32_LAUNCH_MODE !== "breakaway") {
    const viaTask = await launchWin32Task(p, extraEnv);
    if (viaTask) return viaTask;
    try { fs.appendFileSync(p.err,
      "\n[job-core] Task Scheduler launch path unavailable/failed; falling back to win32-breakaway.ps1\n");
    } catch {}
  }
  const viaBreakaway = await launchWin32Breakaway(p, extraEnv);
  return { ...viaBreakaway, launchPath: "breakaway-fallback" };
}

function launchPosix(p, extraEnv = {}) {
  const child = spawn(process.execPath, [RUNNER, p.spec],
    { detached: true, stdio: "ignore", env: { ...process.env, ...extraEnv } });
  child.on("error", (e) => recordLaunchFailure(p, `failed to spawn job-runner: ${e.message}`));
  child.unref();
  return { pid: child.pid, pidSource: "runner", launchPath: "spawn" };
}

async function launch(p, command, argv, cwd, extraEnv = {}) {
  fs.writeFileSync(p.spec, JSON.stringify({ command, argv, cwd, out: p.out, err: p.err, exit: p.exit }));
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
const INFLIGHT_RESERVATION_MS = 2 * 60 * 1000;
function countActiveJobs(nowMs) {
  let n = 0;
  let ids = [];
  try { ids = fs.readdirSync(JOB_ROOT); } catch {}
  for (const id of ids) {
    const p = jobPaths(id);
    try {
      if (!fs.statSync(p.d).isDirectory() || fs.existsSync(p.exit)) continue;
      if (!fs.existsSync(p.meta)) {
        if (nowMs - fs.statSync(p.d).mtimeMs < INFLIGHT_RESERVATION_MS) n++;
        continue;
      }
      if (checkJob(id, 0).status === "running") n++;
    } catch { /* unreadable job dir: not counted */ }
  }
  return n;
}

// opts (all optional): host (executing host name, e.g. "claunker" -- recorded in meta and used in
// error text), caps (see guard.mjs resolveCaps), depth (the CALLER's dispatch depth; default from
// CLAUDE_ASYNC_DEPTH), now (Date, tests), claudeBin + launch (test seams: the preflight binary and
// a replacement for launch() so tests never touch schtasks or spawn a runner).
// Order is deliberate: every rejection happens before the job dir or ticket exists.
export async function startJob({ prompt, workFolder, jobId, model, effort, intent }, opts = {}) {
  const hostname = os.hostname();
  const hostLabel = opts.host ? `host ${opts.host} (${hostname})` : `host ${hostname}`;
  const fail = (errorCode, error) => ({ error, errorCode, ...(opts.host ? { host: opts.host } : {}), hostname });

  const id = (jobId || `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!isSafeJobId(id)) return fail("invalid", `invalid jobId ${JSON.stringify(id)}`);
  const cwd = workFolder || DEFAULT_CWD;

  const pf = preflight({ claudeBin: opts.claudeBin, cwd, hostLabel });
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
    const capError = checkCaps({ running: countActiveJobs(nowMs), startsInWindow: recentStarts(JOB_ROOT, nowMs).length,
                                 caps, hostLabel });
    if (capError) return fail(capError.errorCode, capError.error);
    // Non-recursive mkdir is the atomic duplicate check (EEXIST), even against a racer that
    // bypassed the lock; JOB_ROOT itself is created at module load.
    try { fs.mkdirSync(p.d); }
    catch (e) {
      return e.code === "EEXIST" ? fail("duplicate", `jobId ${id} already exists`)
                                 : fail("invalid", `could not create job dir: ${e.message}`);
    }
    recordStart(JOB_ROOT, nowMs);
    return { ok: true };
  });
  if (reserved.error) return reserved.errorCode ? reserved : fail("lock", reserved.error);

  const argv = ["-p", prompt, "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", EMPTY_MCP];
  const resolvedModel = model || DEFAULT_MODEL;
  argv.push("--model", resolvedModel);
  // Effort routing (argv-only — never mutate process.env; it leaks across detached jobs).
  const eff = (effort || DEFAULT_EFFORT).toLowerCase();
  if (eff === "ultracode") {
    // ultracode = xhigh effort (explicit, not ambient) + standing dynamic-workflow orchestration.
    // xhigh is pushed explicitly so ultracode delivers its defined effort regardless of the
    // ambient effortLevel, rather than inheriting it from settings.json.
    argv.push("--effort", "xhigh");
    // STEP 1 confirmed `--settings '{"ultracode":true}'` surfaces the Workflow tool headlessly,
    // so use the settings mechanism (not the prompt-keyword fallback) to enable the composite.
    argv.push("--settings", JSON.stringify({ ultracode: true }));
  } else if (FLAG_EFFORT.has(eff)) {
    argv.push("--effort", eff);
  } // else: unrecognized → leave unset, inheriting settings.json effortLevel.
  // The new job runs one level deeper than its caller (guard.mjs's depth accident guard).
  const extraEnv = { [DEPTH_ENV]: String(d.depth + 1) };
  const { pid, pidSource, jobMembership, launchPath } =
    await (opts.launch || launch)(p, opts.claudeBin || CLAUDE_BIN, argv, cwd, extraEnv);

  const { cardId, startHead, error: cardError } = mintCard(id, cwd, resolvedModel, eff, prompt, intent);
  const meta = { jobId: id, ...(opts.host ? { host: opts.host } : {}), hostname,
                 pid, pidSource, launchPath, ...(jobMembership ? { jobMembership } : {}),
                 workFolder: cwd, model: resolvedModel, effort: eff, depth: d.depth + 1,
                 prompt: prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt,
                 startedAt: new Date().toISOString(),
                 cardId: cardId || null, startHead: startHead || null };
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));
  const note = cardError
    ? `UNCARDED: ${cardError} — Job detached. Poll with claude_check(jobId). Safe across bridge restarts.`
    : "Job detached. Poll with claude_check(jobId). Safe across bridge restarts.";
  return { ...meta, status: "running", preflight: PREFLIGHT_OK, note };
}

export function checkJob(id, tailBytes = 8000) {
  const hostname = os.hostname();
  if (!isSafeJobId(id)) return { jobId: id, hostname, status: "unknown", error: "invalid jobId" };
  const p = jobPaths(id);
  if (!fs.existsSync(p.meta)) return { jobId: id, hostname, status: "unknown", error: "no such job" };
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  let state, exitCode = null, finishedAt = null;
  const extra = {};

  if (fs.existsSync(p.exit)) {
    exitCode = parseInt(fs.readFileSync(p.exit, "utf8").trim(), 10);
    state = exitCode === 0 ? "completed" : "failed";
    finishedAt = fs.statSync(p.exit).mtime.toISOString();
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
      try { fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2)); } catch {}
    } else {
      extra.reapError = reap.error || "reap failed";
    }
  }

  const runnerJobMembership = readRunnerJobMembership(p);

  return { ...meta, hostname, status: state, exitCode, finishedAt, ...extra,
           ...(runnerJobMembership ? { runnerJobMembership } : {}),
           stdout: readTail(p.out, tailBytes), stderr: readTail(p.err, tailBytes) };
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
    return row;
  }).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function runSelfTest() {
  const id = `selftest-${Date.now()}`;
  const p = jobPaths(id);
  fs.mkdirSync(p.d, { recursive: true });
  const { pid, pidSource } = await launch(p, process.execPath,
    ["-e", "setTimeout(() => console.log('SELFTEST_OK'), 300)"], JOB_ROOT);
  fs.writeFileSync(p.meta, JSON.stringify({ jobId: id, pid, pidSource, startedAt: new Date().toISOString() }));

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
