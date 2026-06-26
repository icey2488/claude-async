#!/usr/bin/env node
/**
 * job-core.mjs — shared logic for claude-async (stdio + http entrypoints).
 * Job state lives entirely on disk under JOB_ROOT, which is why the HTTP server can be
 * stateless. job-runner.mjs (the detached worker) must sit beside this file.
 */
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || "claude";
export const JOB_ROOT = process.env.CLAUDE_ASYNC_JOB_DIR || path.join(os.homedir(), ".claude-async-jobs");
const DEFAULT_CWD = process.env.CLAUDE_ASYNC_DEFAULT_CWD || os.homedir();
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "job-runner.mjs");
// Reasoning effort: default xhigh, overridable per-process. FLAG_EFFORT are the levels that
// map straight to `--effort`; "ultracode" is a composite handled separately (see startJob).
const DEFAULT_EFFORT = process.env.CLAUDE_ASYNC_DEFAULT_EFFORT || "xhigh";
const FLAG_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
fs.mkdirSync(JOB_ROOT, { recursive: true });

const jobDir = (id) => path.join(JOB_ROOT, id);
const jobPaths = (id) => {
  const d = jobDir(id);
  return { d, out: path.join(d, "out.log"), err: path.join(d, "err.log"),
           exit: path.join(d, "exit_code"), meta: path.join(d, "meta.json"),
           spec: path.join(d, "spec.json") };
};

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
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
  const argv = ["-p", prompt, "--dangerously-skip-permissions"];
  if (model) argv.push("--model", model);
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

  const meta = { jobId: id, pid, workFolder: cwd, model: model || null, effort: eff,
                 prompt: prompt.length > 500 ? prompt.slice(0, 500) + "…" : prompt,
                 startedAt: new Date().toISOString() };
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));
  return { ...meta, status: "running",
           note: "Job detached. Poll with claude_check(jobId). Safe across bridge restarts." };
}

export function checkJob(id, tailBytes = 8000) {
  const p = jobPaths(id);
  if (!fs.existsSync(p.meta)) return { jobId: id, status: "unknown", error: "no such job" };
  const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  let state, exitCode = null, finishedAt = null;
  if (fs.existsSync(p.exit)) {
    exitCode = parseInt(fs.readFileSync(p.exit, "utf8").trim(), 10);
    state = exitCode === 0 ? "completed" : "failed";
    finishedAt = fs.statSync(p.exit).mtime.toISOString();
  } else if (pidAlive(meta.pid)) {
    state = "running";
  } else {
    state = "orphaned";
  }
  return { ...meta, status: state, exitCode, finishedAt,
           stdout: readTail(p.out, tailBytes), stderr: readTail(p.err, tailBytes) };
}

export function listJobs() {
  const ids = fs.existsSync(JOB_ROOT)
    ? fs.readdirSync(JOB_ROOT).filter((f) => fs.statSync(path.join(JOB_ROOT, f)).isDirectory())
    : [];
  return ids.map((id) => {
    const s = checkJob(id, 0);
    return { jobId: id, status: s.status, exitCode: s.exitCode ?? null, startedAt: s.startedAt ?? null };
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
      model: z.string().optional().describe("Optional --model override, e.g. claude-opus-4-8 / claude-sonnet-4-6."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultracode"]).optional()
        .describe("Reasoning effort; default xhigh. \"max\" = highest reasoning; " +
                  "\"ultracode\" = xhigh plus standing dynamic-workflow orchestration (parallel subagents)."),
    },
  }, async (args) => ok(startJob(args)));

  server.registerTool("claude_check", {
    description: "Check a background job's status and recent output. Returns status " +
                 "(running | completed | failed | orphaned), exit code, and a tail of stdout/stderr.",
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
