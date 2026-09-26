/**
 * guard.mjs — the single server-side dispatch guard (design item 6), enforced inside startJob()
 * so it covers every path that can write a launch ticket on this host: the local MCP bridge and
 * host-api.mjs alike. (No P2 fork-bomb guard existed to port -- icey2488/claude-async-release
 * does not exist -- so this is written from scratch and is the only one.)
 *
 *   - max concurrent running jobs on this host (default 4)
 *   - max starts per rolling 60s on this host (default 6)
 *   Over either cap: reject with a clear error; no job dir, no ticket.
 *
 * "Per host" = per executing host = per JOB_ROOT: caps are always checked where the job would
 * actually run, never on a forwarder. Configurable via hosts.json "caps" (preferred: one file
 * shared by the bridge and the API on the same host) or CLAUDE_ASYNC_MAX_CONCURRENT /
 * CLAUDE_ASYNC_MAX_STARTS_PER_MINUTE.
 *
 * The count-then-reserve step runs under a cross-process lock file (JOB_ROOT/.start.lock,
 * O_EXCL create) because several processes share one JOB_ROOT on Claunker (Desktop can run more
 * than one bridge, plus the API). The rolling-minute ledger (JOB_ROOT/.start-ledger.json) records
 * accepted starts only. Both are plain files, so listJobs() (directories only) never sees them.
 *
 * Depth (CLAUDE_ASYNC_DEPTH env / X-Claude-Async-Depth header) is an ACCIDENT guard only, NOT a
 * security control: any caller can simply lie about it. Jobs are launched with depth+1; a start
 * presenting depth > 1 is rejected, which stops a runaway job-dispatches-job chain at two levels.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CAPS = Object.freeze({ maxConcurrent: 4, maxStartsPerMinute: 6 });
export const MAX_DEPTH = 1;
export const DEPTH_ENV = "CLAUDE_ASYNC_DEPTH";
export const DEPTH_HEADER = "x-claude-async-depth";
const WINDOW_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Explicit caps (hosts.json) win over env, env over defaults; invalid values fall through.
export function resolveCaps(explicit) {
  return {
    maxConcurrent: positiveInt(explicit?.maxConcurrent) ?? positiveInt(process.env.CLAUDE_ASYNC_MAX_CONCURRENT)
      ?? DEFAULT_CAPS.maxConcurrent,
    maxStartsPerMinute: positiveInt(explicit?.maxStartsPerMinute)
      ?? positiveInt(process.env.CLAUDE_ASYNC_MAX_STARTS_PER_MINUTE) ?? DEFAULT_CAPS.maxStartsPerMinute,
  };
}

// Absent/empty = 0 (a top-level caller). Anything else must be a non-negative integer, else the
// start is refused (fail closed) -- returns { depth } or { error }.
export function parseDepth(value) {
  if (value === undefined || value === null || String(value).trim() === "") return { depth: 0 };
  const s = String(value).trim();
  if (!/^\d{1,3}$/.test(s)) return { error: `malformed dispatch depth ${JSON.stringify(s)}` };
  return { depth: Number(s) };
}

export function checkDepth(depth) {
  return depth > MAX_DEPTH
    ? `dispatch depth ${depth} exceeds ${MAX_DEPTH} (accident guard against job-dispatches-job ` +
      `chains, not a security control); no job started`
    : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn() while holding jobRoot/.start.lock. fn must be synchronous (it only stats/counts and
// creates the job dir). A lock older than LOCK_STALE_MS is presumed abandoned by a crashed holder.
export async function withStartLock(jobRoot, fn) {
  const lock = path.join(jobRoot, ".start.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { /* vanished between checks; retry */ }
      if (Date.now() > deadline) return { error: `could not acquire ${lock} within ${LOCK_TIMEOUT_MS}ms; no job started` };
      await sleep(25);
    }
  }
  try { return fn(); }
  finally { try { fs.unlinkSync(lock); } catch {} }
}

const ledgerPath = (jobRoot) => path.join(jobRoot, ".start-ledger.json");

export function recentStarts(jobRoot, nowMs) {
  try {
    const arr = JSON.parse(fs.readFileSync(ledgerPath(jobRoot), "utf8"));
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "number" && nowMs - t < WINDOW_MS && t <= nowMs) : [];
  } catch { return []; }
}

export function recordStart(jobRoot, nowMs) {
  const kept = [...recentStarts(jobRoot, nowMs), nowMs];
  fs.writeFileSync(ledgerPath(jobRoot), JSON.stringify(kept));
}

// Returns { error, errorCode } if a cap is hit, else null. Caller holds the start lock.
export function checkCaps({ running, startsInWindow, caps, hostLabel }) {
  if (running >= caps.maxConcurrent) {
    return { errorCode: "cap_concurrent", error: `cap exceeded on ${hostLabel}: ${running} jobs already ` +
      `running (max ${caps.maxConcurrent} concurrent); no job started` };
  }
  if (startsInWindow >= caps.maxStartsPerMinute) {
    return { errorCode: "cap_rate", error: `cap exceeded on ${hostLabel}: ${startsInWindow} starts in ` +
      `the last 60s (max ${caps.maxStartsPerMinute} per minute); no job started` };
  }
  return null;
}
