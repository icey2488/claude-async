/**
 * card-hook.mjs — jobcard integration for claude-async.
 * Shared by job-core.mjs (mint on dispatch) and job-runner.mjs (close on finish).
 * Fail-open by design: jobcard errors are returned as { error }, never thrown.
 *
 * Env: CLAUNKER_JOBCARD_CMD — space-split command override; default resolves
 * to the known claunker-hermes venv at ~/code/claunker-hermes.
 *
 * Quiet mode: when CLAUNKER_JOBCARD_CMD is NOT set and the default executable does not
 * exist (spawn ENOENT), this host simply has no card command. Minting is skipped with one
 * debug line on stderr and no error, so the start response carries no UNCARDED note.
 * Every other failure (an explicit CLAUNKER_JOBCARD_CMD that fails, ENOENT included;
 * non-zero exit; timeout) is a real misconfiguration and still surfaces as an error.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Resolved at call time (os.homedir() honours USERPROFILE/HOME) so tests can point it at a
// temp home.
function defaultJobcard() {
  const hermes = path.join(os.homedir(), "code", "claunker-hermes");
  const python = process.platform === "win32"
    ? path.join(hermes, ".venv", "Scripts", "python.exe")
    : path.join(hermes, ".venv", "bin", "python");
  return [python, [path.join(hermes, "jobcard.py")]];
}

// Read at call time so tests can override CLAUNKER_JOBCARD_CMD between calls.
// Accepts two formats:
//   JSON array  — '["C:\\Program Files\\node.exe","script.mjs"]'  (handles spaces in paths)
//   Space-split — 'node script.mjs'  (simple, no spaces in exe path)
// Returns [exe, args, explicit]; explicit is true when CLAUNKER_JOBCARD_CMD supplied the command.
export function resolveJobcard() {
  const raw = process.env.CLAUNKER_JOBCARD_CMD;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return [parsed[0], parsed.slice(1), true];
    } catch {}
    const parts = raw.trim().split(/\s+/);
    return [parts[0], parts.slice(1), true];
  }
  return [...defaultJobcard(), false];
}

// Returns { ok: true, stdout }, { ok: false, error }, or { ok: false, skipped: true } (quiet
// mode, see header). Never throws.
function runJobcard(args) {
  const [exe, baseArgs, explicit] = resolveJobcard();
  let result;
  try {
    result = spawnSync(exe, [...baseArgs, ...args], { encoding: "utf8", timeout: 10_000 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (result.error) {
    if (!explicit && result.error.code === "ENOENT") {
      try { process.stderr.write(`card-hook: default jobcard command not found and CLAUNKER_JOBCARD_CMD unset; skipping card\n`); } catch {}
      return { ok: false, skipped: true };
    }
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const msg = (result.stderr || "").trim() || `exit ${result.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, stdout: (result.stdout || "").trim() };
}

// Upper bound on the extracted card body. A dispatch card wants a GLANCEABLE intent
// snippet, not the whole (often multi-page) prompt — 200 chars is ~2-3 lines on the card
// face, room for a full intent sentence, and far below the spine's 16 KiB description cap.
export const INTENT_SUMMARY_MAX = 200;

/**
 * Extract a bounded, readable INTENT SUMMARY from a dispatch prompt for the card body.
 * Dispatch prompts conventionally OPEN with a one-line statement of intent, so the rule is:
 *   1. take the FIRST non-empty line (the conventional opener);
 *   2. if it fits in INTENT_SUMMARY_MAX chars, use it whole (the common case — a short
 *      imperative opener — is preserved verbatim, no risk of a false-positive cut);
 *   3. otherwise prefer the FIRST sentence boundary (. ? !) within the cap;
 *   4. failing that, cut at the last word boundary and ellipsize.
 * Never dumps the whole prompt onto the card. Returns null for an empty/blank/non-string
 * prompt, so the caller simply omits --description (absent body, never an empty string).
 *
 * This HEURISTIC is a FALLBACK: it is brittle (a prompt that does not open with its intent
 * gets a poor body). The robust path is an EXPLICIT intent supplied by the dispatcher
 * (mintCard's `intent` arg / claude_start's `intent` input) — see `boundIntent`. We do NOT
 * put a model call on the mint path: that would trade a mild failure (a truncated line) for
 * a worse one (mint blocks or fails when the model is unavailable) on a path that today
 * cannot fail. Explicit-when-known, heuristic-when-not.
 */
export function intentSummary(prompt) {
  if (typeof prompt !== "string") return null;
  const line = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  if (line.length <= INTENT_SUMMARY_MAX) return line;
  // Long opener: first sentence ending in . ? ! (≥20 chars in, to skip early abbreviations
  // like "e.g.") within the cap window; the boundary punctuation is kept.
  const sentence = line.slice(0, INTENT_SUMMARY_MAX + 1).match(/^(.{20,}?[.?!])\s/);
  if (sentence) return sentence[1];
  // No sentence boundary in range → last word boundary, ellipsized.
  const clipped = line.slice(0, INTENT_SUMMARY_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd() + "…";
}

/**
 * Bound an EXPLICIT dispatcher-supplied intent for the card body. Unlike `intentSummary`,
 * this does NOT re-extract a first line/sentence — an explicit intent IS already the summary,
 * so mangling it would defeat the point. It only trims and applies the same hard length cap
 * (word-boundary ellipsis) as a storage-abuse safety bound. Returns null for an empty/blank/
 * non-string value, so the caller falls back to the heuristic.
 */
export function boundIntent(intent) {
  if (typeof intent !== "string") return null;
  const s = intent.trim();
  if (!s) return null;
  if (s.length <= INTENT_SUMMARY_MAX) return s;
  const clipped = s.slice(0, INTENT_SUMMARY_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trimEnd() + "…";
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
 * cardId is null and error is set when the jobcard command fails (fail-open). Both are
 * null in quiet mode (CLAUNKER_JOBCARD_CMD unset and the default command absent).
 * startHead is the git HEAD sha at dispatch time (null for non-repos).
 *
 * model/effort/jobId are the job's dispatch provenance (caller-supplied value or
 * job-core's own default — never raw/possibly-absent), recorded inside created_by
 * (spec v0.7.0) via --job-id. Provenance only — jobId never appears on the card face.
 *
 * The card's narrative body (--description, spec v0.8.0) so dispatch cards stop being
 * title-only. TWO SOURCES, explicit-first (the middle path — no model call on the mint path):
 *   1. `intent` — an EXPLICIT intent string supplied by the dispatcher (claude_start's
 *      `intent` input). When present/non-blank it WINS, bounded verbatim by `boundIntent`.
 *   2. else the `prompt`'s bounded first-line/first-sentence heuristic (`intentSummary`) —
 *      unchanged fallback.
 * Both omitted/blank → no --description (absent body, never "").
 *
 * The TITLE (the board face most users actually see) is that same summary — the
 * one-line intent, not the jobId, which stays confined to provenance. If neither
 * source yields a body (no intent, no prompt), jobId is the last-resort title so the
 * positional arg is never sent blank.
 */
export function mintCard(jobId, workFolder, model, effort, prompt, intent) {
  const startHead = getGitHead(workFolder);
  const args = [
    "create", "--state", "dispatched", "--actor", "claude-code",
    "--project", "Dispatch Log",
  ];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  const body = boundIntent(intent) || intentSummary(prompt);  // explicit wins; heuristic fallback
  if (body) args.push("--description", body);
  args.push("--job-id", jobId, body || jobId);
  const r = runJobcard(args);
  if (r.skipped) return { cardId: null, startHead, error: null }; // quiet mode: no card, no note
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
