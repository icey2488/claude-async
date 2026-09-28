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
 * Start lock protocol (same shape as launcher-claim.mjs's claim lock; see that file's header for the
 * full rationale). `.start.lock` holds `{pid, at}`, written after an exclusive create
 * (`openSync(path, "wx")`). A lock is only ever unlinked by the process whose pid is inside it
 * (`ownsLock`): a process suspended between creating and writing its lock for longer than staleMs
 * would otherwise look like a dead owner, get its lock broken and replaced by a second holder, then
 * wake up and unlink-by-name that second holder's live lock -- letting a third holder in while the
 * second is still inside fn(). The read-back after writing closes that window (a mismatch means we
 * lost the lock: nothing is unlinked, and withStartLock reports failure to acquire), and the normal
 * release in `finally` calls `ownsLock` (content) first.
 *
 * A lock is broken when it is at least staleMs old AND (its owner pid is dead or unreadable, OR that
 * pid is our own, OR the lock is at least LOCK_MAX_HOLD_MS old regardless of whether the owner pid
 * looks alive): never merely old with a live, foreign, sub-ceiling owner, which is left pending.
 *   - Own-pid: the lock is held only synchronously inside fn(), so this process can never
 *     legitimately still (or again) hold an old lock bearing its own pid -- it is always an
 *     abandoned leftover, most likely a crashed earlier holder whose pid got reused as ours.
 *   - Ceiling (LOCK_MAX_HOLD_MS, default 5 minutes, opts.maxHoldMs in tests): a real hold lasts
 *     milliseconds, so a lock this old is realistically pid reuse by an unrelated process after the
 *     real holder crashed, not a genuine long hold -- it is broken and logged loudly and distinctly
 *     even though pidAlive(owner) says alive. Between staleMs and the ceiling, a live owner is still
 *     never broken. Consequence: a process genuinely frozen inside the critical section for more
 *     than the ceiling can let one extra concurrent/rate-limited start past the caps.
 * Breaking itself is race-safe via a second exclusive-create marker (`.start.lock.break`): only the
 * marker holder unlinks the stale lock, and it re-checks staleness while holding the marker so a lock
 * a rival breaker already replaced is never unlinked. A marker whose holder crashed is not
 * auto-broken (RUNBOOK has the manual cleanup). A clock stepped backwards reads as fresh, never stale.
 *
 * File-identity cleanup: the lock's write-failure path and the break marker's cleanup (always, not
 * just on write failure) unlink by dev+ino captured via `fstatSync(fd, {bigint:true})` right after
 * the exclusive create, not by content. A write failure leaves the file empty, which the content
 * check (`ownsLock`) reads as unowned and would leave behind forever -- an empty `.start.lock` then
 * blocks every start for staleMs, and an empty `.start.lock.break` permanently disables breaking
 * until a human deletes it. Identity survives an empty file; it correctly still refuses to touch the
 * file if some rival has since unlinked-and-recreated the same path. The normal (successful) release
 * of the lock itself keeps the content check, unchanged.
 *
 * fileId() itself can fail (fstatSync on a just-opened fd throwing EIO/ENOSYS/etc, vanishingly rare
 * but not impossible): the exclusive create already succeeded, so unlike an openSync failure this
 * leaves a real, empty file on disk with no dev+ino in hand to prove it is still ours. Reintroducing
 * an unconditional path-based unlink here would reopen exactly the stall race the dev+ino check exists
 * to close (it could delete a lock or marker some other process has since legitimately created at the
 * same path). Instead: the fd is always closed (never leaked), and the empty file is left exactly
 * where a write failure would leave one -- for the lock, the existing staleMs/dead-owner breaker
 * reclaims it like any other empty, owner-less lock; for the marker, it joins the already-documented
 * "stranded marker" bucket (RUNBOOK "Manual cleanup") the same as one whose holder crashed mid-write.
 * Bounded, never a silent leak; see acquireStartLock and breakStaleStartLock below.
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
export const LOCK_TIMEOUT_MS = 5_000;
export const LOCK_STALE_MS = 30_000;
// A real hold lasts milliseconds (the lock is only ever held synchronously inside fn()). A lock this
// old with an owner pid that still looks alive is realistically pid reuse by an unrelated process
// after the real holder crashed, not a genuine long hold -- so it is broken too. See "Start lock
// protocol" above.
export const LOCK_MAX_HOLD_MS = 5 * 60_000;

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

function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// True only if lockPath parses as JSON whose pid is ours. See "Start lock protocol" above.
function ownsLock(lockPath) {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return typeof data === "object" && data !== null && data.pid === process.pid;
  } catch { return false; }
}

// Removes lockPath (the lock or its break marker) only if it still carries our pid; otherwise it
// belongs to someone else (or is gone) and must be left exactly as it is.
function releaseIfOwned(lockPath, log, what) {
  if (!ownsLock(lockPath)) {
    log(`${what} ${path.basename(lockPath)} is no longer ours (missing, replaced or unwritten); leaving it alone`);
    return;
  }
  try { fs.unlinkSync(lockPath); }
  catch (e) { if (e.code !== "ENOENT") log(`could not remove ${what} ${path.basename(lockPath)}: ${e.code}: ${e.message}`); }
}

// dev+ino of the file behind fd, captured right after an exclusive create. Used to recognize "the
// exact file we just created" even when its content check (ownsLock) cannot: a write failure leaves
// it empty, which ownsLock reads as unowned.
function fileId(fd) {
  const st = fs.fstatSync(fd, { bigint: true });
  return { dev: st.dev, ino: st.ino };
}

function sameFile(filePath, id) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    return st.dev === id.dev && st.ino === id.ino;
  } catch { return false; }
}

// Removes lockPath only if it is still literally the file we created (same dev+ino), regardless of
// its content. For use right after we failed to write to a file we just exclusively created: an
// empty file is not "ours" by content (ownsLock/releaseIfOwned would leave it, permanently blocking
// or disabling the lock/marker), but it is still identifiably ours by identity as long as no one has
// unlinked-and-recreated the path in between.
function releaseIfSameFile(lockPath, id, log, what) {
  if (!sameFile(lockPath, id)) {
    log(`${what} ${path.basename(lockPath)} is no longer the file we created (replaced or gone); leaving it alone`);
    return;
  }
  try { fs.unlinkSync(lockPath); }
  catch (e) { if (e.code !== "ENOENT") log(`could not remove ${what} ${path.basename(lockPath)}: ${e.code}: ${e.message}`); }
}

function readLockOwner(lockPath) {
  let raw = null, pid = null;
  try { raw = fs.readFileSync(lockPath, "utf8"); } catch { return { raw, pid }; }
  try {
    const p = JSON.parse(raw).pid;
    if (Number.isInteger(p) && p > 0) pid = p;
  } catch { /* empty or partial: owner died between create and write */ }
  return { raw, pid };
}

// gone | unreadable | fresh | live-owner | ceiling | stale. An mtime in the future (clock stepped
// back) makes ageMs negative, so it reads as fresh -- never as stale.
function assessLock(lockPath, { staleMs, maxHoldMs, pidAlive, now }) {
  let st;
  try { st = fs.statSync(lockPath); }
  catch (e) { return { state: e.code === "ENOENT" ? "gone" : "unreadable", error: e }; }
  const ageMs = now() - st.mtimeMs;
  if (!(ageMs >= staleMs)) return { state: "fresh", ageMs };
  const { raw, pid } = readLockOwner(lockPath);
  // The lock is held only synchronously inside fn(); this process can never legitimately still hold
  // (or hold again) a lock this old bearing its own pid. It is always an abandoned leftover -- from a
  // crashed earlier holder that happened to get our pid back via reuse, or a bug -- never a live hold.
  if (pid !== null && pid === process.pid) return { state: "stale", ageMs, pid, raw };
  if (pid !== null && pidAlive(pid)) {
    // A live owner is normally left alone indefinitely, but a real hold lasts milliseconds; past
    // maxHoldMs the far more likely explanation is pid reuse by an unrelated process after the real
    // holder crashed, so the ceiling overrides the live-owner check and the lock is still broken.
    if (ageMs >= maxHoldMs) return { state: "ceiling", ageMs, pid, raw };
    return { state: "live-owner", ageMs, pid };
  }
  return { state: "stale", ageMs, pid, raw };
}

// Returns "retry" if the lock is gone (broken by us or vanished) so the caller may try to create it
// again, "held" if it must be left alone.
function breakStaleStartLock(lockPath, ctx) {
  const { log, maxHoldMs } = ctx;
  const first = assessLock(lockPath, ctx);
  if (first.state === "gone") return "retry";
  if (first.state === "live-owner") {
    log(`start lock is ${Math.round(first.ageMs / 1000)}s old but its owner pid=${first.pid} is alive; waiting`);
    return "held";
  }
  if (first.state !== "stale" && first.state !== "ceiling") return "held";

  const marker = lockPath + ".break";
  let fd;
  try { fd = fs.openSync(marker, "wx"); }
  catch (e) {
    log(e.code === "EEXIST"
      ? `stale start lock, but ${path.basename(marker)} exists (another process is breaking it, or its breaker died -- delete the marker by hand if it is old); waiting`
      : `stale start lock, could not create ${path.basename(marker)}: ${e.code}: ${e.message}; waiting`);
    return "held";
  }
  let markerId;
  try { markerId = fileId(fd); }
  catch (e) {
    // The create above already succeeded, so unlike the openSync failure just above this leaves a
    // real (empty) marker on disk with no dev+ino to prove it's ours. Never path-unlink it (that
    // reopens the stall race dev+ino exists to close); close the fd and leave the empty marker for
    // manual cleanup, same bucket as a marker whose holder crashed mid-write (see file header and
    // RUNBOOK "Manual cleanup"). Any later attempt sees it via the ordinary EEXIST branch above.
    try { fs.closeSync(fd); } catch {}
    log(`could not stat ${path.basename(marker)} right after creating it: ${e.code}: ${e.message}; ` +
        `leaving the empty marker for manual cleanup; waiting`);
    return "held";
  }
  try {
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
    catch (e) { log(`could not write ${path.basename(marker)}: ${e.code}: ${e.message}`); }
    try { fs.closeSync(fd); } catch {}
    // Re-check while holding the marker: a rival breaker may already have replaced the stale lock.
    const second = assessLock(lockPath, ctx);
    if (second.state === "gone") return "retry";
    if (second.state !== "stale" && second.state !== "ceiling") return "held";
    fs.unlinkSync(lockPath);
    if (second.state === "ceiling") {
      log(`BROKE start lock past the ${maxHoldMs}ms ceiling although owner pid=${second.pid} looks alive (likely pid reuse)`);
    } else if (second.pid === process.pid) {
      log(`BROKE stale start lock (age=${Math.round(second.ageMs / 1000)}s, owner pid=${second.pid} is this ` +
          `process itself -- abandoned by an earlier lineage, content=${JSON.stringify(second.raw)})`);
    } else {
      log(`BROKE stale start lock (age=${Math.round(second.ageMs / 1000)}s, ` +
          `owner pid=${second.pid === null ? "unreadable" : `${second.pid} dead`}, content=${JSON.stringify(second.raw)})`);
    }
    return "retry";
  } catch (e) {
    if (e.code === "ENOENT") return "retry";
    log(`failed to break stale start lock: ${e.code}: ${e.message}; waiting`);
    return "held";
  } finally {
    // File-id, not content: a write failure above leaves the marker empty, which the content check
    // (ownsLock) would read as unowned and leave behind forever, permanently disabling breaking.
    releaseIfSameFile(marker, markerId, log, "break marker");
  }
}

// true = we now hold lockPath exclusively.
async function acquireStartLock(lockPath, ctx) {
  const { log, now, timeoutMs } = ctx;
  const deadline = now() + timeoutMs;
  for (;;) {
    let fd;
    try { fd = fs.openSync(lockPath, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") { log(`could not create start lock: ${e.code}: ${e.message}`); return false; }
      const outcome = breakStaleStartLock(lockPath, ctx);
      if (outcome === "retry") continue;
      if (now() > deadline) return false;
      await sleep(25);
      continue;
    }
    let id;
    try { id = fileId(fd); }
    catch (e) {
      // Same reasoning as the marker case in breakStaleStartLock: the create already succeeded, so
      // this leaves a real (empty) lock file with no dev+ino to prove it's ours. Close the fd (never
      // leak it) and leave the empty lock exactly where a write failure would leave one, for the
      // ordinary staleMs/dead-owner breaker to reclaim -- never an unconditional path-based unlink.
      try { fs.closeSync(fd); } catch {}
      log(`could not stat start lock right after creating it: ${e.code}: ${e.message}; ` +
          `leaving the empty lock for the stale-lock breaker`);
      if (now() > deadline) return false;
      await sleep(25);
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
    } catch (e) {
      // File-id, not content: the lock we just created is empty after this failure, which the
      // content check (ownsLock/releaseIfOwned) reads as unowned and would leave behind, blocking
      // every start for staleMs. Identity still proves it is the exact file we created (unless a
      // breaker has since unlinked-and-recreated it, in which case it correctly stays untouched).
      try { fs.closeSync(fd); } catch {}
      log(`could not write start lock: ${e.code}: ${e.message}`);
      releaseIfSameFile(lockPath, id, log, "start lock");
      if (now() > deadline) return false;
      await sleep(25);
      continue;
    }
    if (!ownsLock(lockPath)) {
      // We were suspended between create and write long enough for a breaker to replace the lock.
      log(`lost the start lock (the file at ${path.basename(lockPath)} is not ours after writing); retrying`);
      if (now() > deadline) return false;
      await sleep(25);
      continue;
    }
    return true;
  }
}

// Runs fn() while holding jobRoot/.start.lock. fn must be synchronous (it only stats/counts and
// creates the job dir). opts (all optional, tests only): staleMs, maxHoldMs, pidAlive, now, log,
// timeoutMs -- see "Start lock protocol" above and launcher-claim.mjs's claimOneTicket for the same
// knobs. timeoutMs defaults to LOCK_TIMEOUT_MS (5s); production call sites never override it -- it
// exists so tests can shrink the acquire-timeout wait without touching the production default.
export async function withStartLock(jobRoot, fn, opts = {}) {
  const {
    staleMs = LOCK_STALE_MS, maxHoldMs = LOCK_MAX_HOLD_MS, timeoutMs = LOCK_TIMEOUT_MS,
    pidAlive = defaultPidAlive, now = Date.now, log = () => {},
  } = opts;
  const lock = path.join(jobRoot, ".start.lock");
  const ctx = { staleMs, maxHoldMs, timeoutMs, pidAlive, now, log };
  const ok = await acquireStartLock(lock, ctx);
  if (!ok) return { error: `could not acquire ${lock} within ${timeoutMs}ms; no job started` };
  try { return fn(); }
  finally { releaseIfOwned(lock, log, "start lock"); }
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
