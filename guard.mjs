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
 * accepted starts only; if it is missing or corrupt it is rebuilt from the job dirs (the ground
 * truth), never treated as empty. Both are plain files, so listJobs() (directories only) never sees them.
 *
 * Depth (CLAUDE_ASYNC_DEPTH env / X-Claude-Async-Depth header) is an ACCIDENT guard only, NOT a
 * security control: any caller can simply lie about it. Jobs are launched with depth+1; a start
 * presenting depth > 1 is rejected, which stops a runaway job-dispatches-job chain at two levels.
 */
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.mjs";

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

// When a job dir was created, as best the filesystem can say: the EARLIER of its birthtime (when
// the platform reports one) and its mtime. mtime alone is not enough -- a running job's runner
// renames a heartbeat file inside its dir, which keeps bumping the dir's mtime forever -- while
// birthtime alone is not trustworthy everywhere (0/epoch on some filesystems). Taking the minimum
// means a dir only looks recent if BOTH signals say so, so a long-running job never masquerades as
// a fresh start.
export function dirCreatedMs(dir) {
  const st = fs.statSync(dir);
  return st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
}

// The job dirs are the ground truth for "starts in the last minute": startJob creates one per
// accepted start and nothing else does. Used when the ledger is missing or unreadable. Times a
// little in the future (clock skew) are kept but clamped to now so they age out normally.
function rebuildStarts(jobRoot, nowMs) {
  const starts = [];
  let names = [];
  try { names = fs.readdirSync(jobRoot); } catch { return starts; }
  for (const name of names) {
    try {
      const dir = path.join(jobRoot, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const t = dirCreatedMs(dir);
      if (nowMs - t < WINDOW_MS && t - nowMs < WINDOW_MS) starts.push(Math.min(t, nowMs));
    } catch { /* raced away or unreadable: cannot be evidence of a start */ }
  }
  return starts.sort((x, y) => x - y);
}

// { starts, rebuilt }. A missing, unparseable, or non-array ledger is NOT "no history" (that would
// let a corrupt file wipe the rate limit): starts are rebuilt from the job dirs and the ledger is
// rewritten atomically. Caller holds the start lock. The rewrite is best-effort -- if it fails the
// next call simply rebuilds again, so the cap still holds.
function loadLedger(jobRoot, nowMs) {
  let arr = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(jobRoot), "utf8"));
    if (Array.isArray(parsed)) arr = parsed;
  } catch { /* fall through to rebuild */ }
  // Same clock-skew rule as rebuildStarts: an entry up to WINDOW_MS in the FUTURE (the clock stepped
  // backward since it was recorded) is kept, clamped to now, so it ages out normally. Dropping it
  // would empty the window and fail open; only implausibly distant futures are discarded.
  if (arr) {
    const starts = arr.filter((t) => typeof t === "number" && nowMs - t < WINDOW_MS && t - nowMs < WINDOW_MS)
      .map((t) => Math.min(t, nowMs));
    return { starts, rebuilt: false };
  }
  const starts = rebuildStarts(jobRoot, nowMs);
  try { writeJsonAtomic(ledgerPath(jobRoot), starts, { space: 0 }); } catch {}
  return { starts, rebuilt: true };
}

export function recentStarts(jobRoot, nowMs) {
  return loadLedger(jobRoot, nowMs).starts;
}

// Called after the new job dir exists. If the ledger had to be rebuilt right now (and its rewrite
// failed earlier), the rebuild already counted the dir just created, so don't add it twice.
export function recordStart(jobRoot, nowMs) {
  const { starts, rebuilt } = loadLedger(jobRoot, nowMs);
  writeJsonAtomic(ledgerPath(jobRoot), rebuilt ? starts : [...starts, nowMs], { space: 0 });
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
