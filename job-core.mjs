#!/usr/bin/env node
/**
 * job-core.mjs — shared logic for claude-async (stdio + http entrypoints).
 * Job state lives entirely on disk under JOB_ROOT, which is why the HTTP server can be
 * stateless. job-runner.mjs (the detached worker) must sit beside this file.
 */
import { z } from "zod";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mintCard, failCard } from "./card-hook.mjs";

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

function pidAlive(pid) {
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
      if (raw) return Number(raw);
    } catch { /* not written yet */ }
    await sleep(RUNNER_PID_POLL_INTERVAL_MS);
  }
  // Timed out -- fall back to the pid we were handed (the wrapper's, on win32), noting the
  // uncertainty so a future reader of meta.json/err.log understands why pid tracking may be off.
  try { fs.appendFileSync(p.err, `\n[job-core] runner.pid did not appear within ${RUNNER_PID_POLL_MS}ms; ` +
    `falling back to launcher pid ${fallbackPid} (may be a shell wrapper, not the runner itself)\n`); } catch {}
  return fallbackPid;
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
// Environment: no `env` option is passed here, so the wrapper inherits this process's
// environment unchanged, and win32-breakaway.ps1's Launch() passes lpEnvironment=IntPtr.Zero so
// job-runner.mjs inherits the wrapper's unchanged too -- see win32-breakaway.ps1's header for why
// that's deliberate and test/env-integrity.mjs for the proof (this path and the pre-5a09feb
// direct-spawn path are environment-identical). A corrupted PATHEXT reaching a job here means the
// corruption was already present in this bridge process's own environment before it ever called
// launch() -- check the bridge process's own env, not this function.
async function launchWin32(p) {
  const child = spawn("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
     "-File", WIN32_BREAKAWAY_SCRIPT, process.execPath, RUNNER, p.spec, p.err],
    { detached: false, stdio: "ignore", windowsHide: true });
  child.on("error", (e) => recordLaunchFailure(p, `failed to spawn win32 breakaway wrapper: ${e.message}`));
  child.unref();
  return readRunnerPid(p, child.pid);
}

function launchPosix(p) {
  const child = spawn(process.execPath, [RUNNER, p.spec], { detached: true, stdio: "ignore" });
  child.on("error", (e) => recordLaunchFailure(p, `failed to spawn job-runner: ${e.message}`));
  child.unref();
  return child.pid;
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
  const pid = await launch(p, CLAUDE_BIN, argv, cwd);

  const { cardId, startHead, error: cardError } = mintCard(id, cwd, resolvedModel, eff, prompt, intent);
  const meta = { jobId: id, pid, workFolder: cwd, model: resolvedModel, effort: eff,
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
      state = pidAlive(meta.pid) ? "running" : "died";
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

  return { ...meta, status: state, exitCode, finishedAt, ...extra,
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
                 "timed_out means no heartbeat for longer than CLAUDE_ASYNC_JOB_TIMEOUT_MS (default 4h).",
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
  const pid = await launch(p, process.execPath,
    ["-e", "setTimeout(() => console.log('SELFTEST_OK'), 300)"], JOB_ROOT);
  fs.writeFileSync(p.meta, JSON.stringify({ jobId: id, pid, startedAt: new Date().toISOString() }));

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
