/**
 * card-hook.mjs — jobcard integration for claude-async.
 * Shared by job-core.mjs (mint on dispatch) and job-runner.mjs (close on finish).
 * Fail-open by design: jobcard errors are returned as { error }, never thrown.
 *
 * Env: CLAUNKER_JOBCARD_CMD — space-split command override; default resolves
 * to the known claunker-hermes venv at ~/code/claunker-hermes.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const HERMES = path.join(os.homedir(), "code", "claunker-hermes");
const PYTHON = process.platform === "win32"
  ? path.join(HERMES, ".venv", "Scripts", "python.exe")
  : path.join(HERMES, ".venv", "bin", "python");
const SCRIPT = path.join(HERMES, "jobcard.py");

// Read at call time so tests can override CLAUNKER_JOBCARD_CMD between calls.
// Accepts two formats:
//   JSON array  — '["C:\\Program Files\\node.exe","script.mjs"]'  (handles spaces in paths)
//   Space-split — 'node script.mjs'  (simple, no spaces in exe path)
function resolveJobcard() {
  const raw = process.env.CLAUNKER_JOBCARD_CMD;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return [parsed[0], parsed.slice(1)];
    } catch {}
    const parts = raw.trim().split(/\s+/);
    return [parts[0], parts.slice(1)];
  }
  return [PYTHON, [SCRIPT]];
}

// Returns { ok: true, stdout } or { ok: false, error }. Never throws.
function runJobcard(args) {
  const [exe, baseArgs] = resolveJobcard();
  let result;
  try {
    result = spawnSync(exe, [...baseArgs, ...args], { encoding: "utf8", timeout: 10_000 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const msg = (result.stderr || "").trim() || `exit ${result.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, stdout: (result.stdout || "").trim() };
}

/** Return the current git HEAD sha for dir, or null if not a repo / git unavailable. */
export function getGitHead(dir) {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir, encoding: "utf8", timeout: 5_000,
    });
    if (r.status === 0) return (r.stdout || "").trim() || null;
  } catch {}
  return null;
}

/**
 * Mint a dispatch card for jobId. Returns { cardId, startHead, error }.
 * cardId is null and error is set when the jobcard command fails (fail-open).
 * startHead is the git HEAD sha at dispatch time (null for non-repos).
 */
export function mintCard(jobId, workFolder) {
  const startHead = getGitHead(workFolder);
  const r = runJobcard([
    "create", "--state", "dispatched", "--actor", "claude-code",
    "--project", "Dispatch Log", jobId,
  ]);
  if (!r.ok) return { cardId: null, startHead, error: r.error };
  return { cardId: r.stdout || null, startHead, error: null };
}

/**
 * Fail a card by id. Returns { ok, error } so callers can decide whether the reap
 * succeeded — unlike closeCard, which is fire-and-forget (fail-open, void).
 */
export function failCard(cardId) {
  if (!cardId) return { ok: false, error: "no cardId" };
  return runJobcard(["fail", cardId]);
}

/**
 * Close the card on job finish. Fail-open: all errors are swallowed.
 * On exit 0 with HEAD moved from startHead, attaches a delivery artifact.
 */
export function closeCard(cardId, exitCode, workFolder, startHead) {
  if (!cardId) return;
  const r = runJobcard([exitCode === 0 ? "done" : "fail", cardId]);
  if (!r.ok) return; // fail-open; nothing to do without a successful done/fail
  if (exitCode === 0 && startHead) {
    const head = getGitHead(workFolder);
    if (head && head !== startHead) {
      runJobcard(["artifact", cardId, "--kind", "delivery", "--ref", head]);
    }
  }
}
