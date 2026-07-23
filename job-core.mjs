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
// Empty MCP config: paired with --strict-mcp-config so detached jobs load ZERO MCP servers,
// preventing a project .mcp.json from recursively respawning claude-async.
const EMPTY_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), "empty-mcp.json");
// Dispatch defaults: fail-SAFE, not fail-EXPENSIVE. An unspecified job used to inherit the
// `claude` CLI's own default model (Fable) at xhigh effort — the priciest configuration
// available — and that combination absorbed 99.6% of dispatch spend on 2026-07-23. Both
// defaults below are overridable per-process; explicit caller-supplied model/effort always win.
const DEFAULT_MODEL = process.env.CLAUDE_ASYNC_DEFAULT_MODEL || "claude-sonnet-4-6";
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

function launch(p, command, argv, cwd) {
  fs.writeFileSync(p.spec, JSON.stringify({ command, argv, cwd, out: p.out, err: p.err, exit: p.exit }));
  const child = spawn(process.execPath, [RUNNER, p.spec],
                      { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return child.pid;
}

export function startJob({ prompt, workFolder, jobId, model, effort }) {
  const id = (jobId || `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`).replace(/[^A-Za-z0-9._-]/g, "_");
  const p = jobPaths(id);
  if (fs.existsSync(p.d)) return { error: `jobId ${id} already exists` };
  fs.mkdirSync(p.d, { recursive: true });

  const cwd = workFolder || DEFAULT_CWD;
  const argv = ["-p", prompt, "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", EMPTY_MCP];
  argv.push("--model", model || DEFAULT_MODEL);
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
  const pid = launch(p, CLAUDE_BIN, argv, cwd);

  const { cardId, startHead, error: cardError } = mintCard(id, cwd);
  const meta = { jobId: id, pid, workFolder: cwd, model: model || DEFAULT_MODEL, effort: eff,
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
      workFolder: z.string().optional().describe("Directory to run in (default: $HOME or CLAUDE_ASYNC_DEFAULT_CWD)."),
      jobId: z.string().optional().describe("Custom job id; otherwise one is generated."),
      model: z.string().optional().describe("--model override, e.g. claude-opus-4-8 / claude-sonnet-4-6. " +
                  "Default claude-sonnet-4-6 (fail-safe; override via CLAUDE_ASYNC_DEFAULT_MODEL)."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultracode"]).optional()
        .describe("Reasoning effort; default medium. \"max\" = highest reasoning; " +
                  "\"ultracode\" = xhigh plus standing dynamic-workflow orchestration (parallel subagents)."),
    },
  }, async (args) => ok(startJob(args)));

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
  const pid = launch(p, process.execPath,
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
