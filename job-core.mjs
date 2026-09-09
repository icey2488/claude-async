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
import { z } from "zod";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mintCard, failCard } from "./card-hook.mjs";
import { queryJobMembershipOnce } from "./tools/jobMembership.mjs";

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
const DEFAULT_CWD = process.env.CLAUDE_ASYNC_DEFAULT_CWD || os.homedir();
// Heartbeat classification thresholds. HEARTBEAT_FRESH_MS: a lastAlive within this window
// is definitely running. JOB_TIMEOUT_MS: beyond this, the job is timed_out regardless of pid.
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000; // 3 minutes
export const JOB_TIMEOUT_MS = Number(process.env.CLAUDE_ASYNC_JOB_TIMEOUT_MS) || 4 * 60 * 60 * 1000; // 4h
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "job-runner.mjs");
// win32-only: shells out through CreateProcessW(CREATE_BREAKAWAY_FROM_JOB) so job-runner.mjs
// escapes whatever Job Object launch()'s caller is nested in (see launch()'s win32 comment).
const WIN32_BREAKAWAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "win32-breakaway.ps1");
const RUNNER_PID_POLL_MS = 2000;
const RUNNER_PID_POLL_INTERVAL_MS = 50;
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

async function readRunnerPid(p, fallbackPid) {
  const pidPath = path.join(p.d, "runner.pid");
  const deadline = Date.now() + RUNNER_PID_POLL_MS;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(pidPath, "utf8").trim();
      if (raw) return { pid: Number(raw), pidSource: "runner" };
    } catch { /* not written yet */ }
    await sleep(RUNNER_PID_POLL_INTERVAL_MS);
  }
  // Timed out -- fall back to the pid we were handed (the wrapper's, on win32), noting the
  // uncertainty so a future reader of meta.json/err.log understands why pid tracking may be off.
  // pidSource: "wrapper-fallback" flags this in meta.json so checkJob knows this pid may belong
  // to a process (the PowerShell wrapper) that exits within milliseconds of spawning the real
  // runner -- see checkJob's healMetaPid() for how a stale wrapper pid gets healed later.
  try { fs.appendFileSync(p.err, `\n[job-core] runner.pid did not appear within ${RUNNER_PID_POLL_MS}ms; ` +
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
async function launchWin32(p) {
  // A stray runner.pid can only exist here if a prior job dir at this same path was left behind
  // without a clean startJob() (startJob() itself refuses to reuse an existing job dir -- see
  // its fs.existsSync(p.d) guard -- so this is defense in depth, not a path this code expects to
  // hit in practice). Removing it up front guarantees readRunnerPid() below can only observe a
  // runner.pid written by the runner.mjs we are about to spawn, never a leftover from one we didn't.
  try { fs.unlinkSync(path.join(p.d, "runner.pid")); } catch {}
  const env = sanitizeEnvForWin32(process.env);
  logIfPathextSanitized(p.err, process.env, env, "spawning the win32 breakaway wrapper");
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

function launchPosix(p) {
  const child = spawn(process.execPath, [RUNNER, p.spec], { detached: true, stdio: "ignore" });
  child.on("error", (e) => recordLaunchFailure(p, `failed to spawn job-runner: ${e.message}`));
  child.unref();
  return { pid: child.pid, pidSource: "runner" };
}

async function launch(p, command, argv, cwd) {
  fs.writeFileSync(p.spec, JSON.stringify({ command, argv, cwd, out: p.out, err: p.err, exit: p.exit }));
  return process.platform === "win32" ? launchWin32(p) : launchPosix(p);
}

export async function startJob({ prompt, workFolder, jobId, model, effort, intent }) {
  const id = (jobId || `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`).replace(/[^A-Za-z0-9._-]/g, "_");
  const p = jobPaths(id);
  if (fs.existsSync(p.d)) return { error: `jobId ${id} already exists` };
  fs.mkdirSync(p.d, { recursive: true });

  const cwd = workFolder || DEFAULT_CWD;
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
  const { pid, pidSource, jobMembership } = await launch(p, CLAUDE_BIN, argv, cwd);

  const { cardId, startHead, error: cardError } = mintCard(id, cwd, resolvedModel, eff, prompt, intent);
  const meta = { jobId: id, pid, pidSource, ...(jobMembership ? { jobMembership } : {}),
                 workFolder: cwd, model: resolvedModel, effort: eff,
                 prompt: prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt,
                 startedAt: new Date().toISOString(),
                 cardId: cardId || null, startHead: startHead || null };
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));
  const note = cardError
    ? `UNCARDED: ${cardError} — Job detached. Poll with claude_check(jobId). Safe across bridge restarts.`
    : "Job detached. Poll with claude_check(jobId). Safe across bridge restarts.";
  return { ...meta, status: "running", note };
}

export function checkJob(id, tailBytes = 8000) {
  const p = jobPaths(id);
  if (!fs.existsSync(p.meta)) return { jobId: id, status: "unknown", error: "no such job" };
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

  return { ...meta, status: state, exitCode, finishedAt, ...extra,
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

export function registerTools(server) {
  const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

  server.registerTool("claude_start", {
    description: "Start a Claude Code task as a detached background job and return a jobId immediately. " +
                 "Use for any work that might run longer than ~30s. Poll with claude_check.",
    inputSchema: {
      prompt: z.string().describe("The task for Claude Code. Include CWD context if it does file/git work."),
      intent: z.string().optional().describe("Optional one-line intent that becomes the dispatch card's " +
                  "TITLE (the board face most users actually see — the jobId never appears there). " +
                  "When supplied it is used verbatim (bounded); otherwise a heuristic summary of the " +
                  "prompt's opener is used. Prefer supplying this for a clean card face."),
      workFolder: z.string().optional().describe("Directory to run in (default: $HOME or CLAUDE_ASYNC_DEFAULT_CWD)."),
      jobId: z.string().optional().describe("Custom job id; otherwise one is generated."),
      model: z.string().optional().describe("--model override, e.g. claude-opus-4-8 / claude-sonnet-5. " +
                  "Default claude-sonnet-5 (fail-safe; override via CLAUDE_ASYNC_DEFAULT_MODEL)."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultracode"]).optional()
        .describe("Reasoning effort; default medium. \"max\" = highest reasoning; " +
                  "\"ultracode\" = xhigh plus standing dynamic-workflow orchestration (parallel subagents)."),
    },
  }, async (args) => ok(await startJob(args)));

  server.registerTool("claude_check", {
    description: "Check a background job's status and recent output. Returns status " +
                 "(running | completed | failed | died | timed_out), exit code, and a tail of stdout/stderr. " +
                 "running may include elapsed and lastAlive fields; stalled:true means heartbeat is stale " +
                 "but pid is still alive. died means the process exited without recording a result. " +
                 "timed_out means no heartbeat for longer than CLAUDE_ASYNC_JOB_TIMEOUT_MS (default 4h). " +
                 "On win32, jobMembership (recorded at launch) and runnerJobMembership (refreshed every " +
                 "heartbeat by the runner itself) report Windows Job Object membership -- inJob:true on " +
                 "either means the breakaway did not fully take effect.",
    inputSchema: {
      jobId: z.string(),
      tailBytes: z.number().int().positive().optional().describe("Bytes of stdout/stderr to return (default 8000)."),
    },
  }, async ({ jobId, tailBytes }) => ok(checkJob(jobId, tailBytes || 8000)));

  server.registerTool("claude_jobs", {
    description: "List all known background jobs with their current status.",
    inputSchema: {},
  }, async () => ok({ count: listJobs().length, jobs: listJobs() }));

  return server;
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
