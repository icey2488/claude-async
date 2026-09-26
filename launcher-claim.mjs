/**
 * launcher-claim.mjs — how a job-launcher.mjs instance takes ownership of one queued launch ticket.
 *
 * Why this is not just fs.renameSync(ticket, claimed): on Windows two launchers renaming the SAME
 * ticket at (nearly) the same instant can BOTH succeed -- neither sees ENOENT -- so one job ran
 * twice and another ticket was never claimed (measured: 31-90% double claims when two claims land
 * within ~0.5 ms; real launcher copies double-claimed 6 of 150 rounds). Exclusive create does not
 * have that flaw: fs.openSync(path, "wx") (CREATE_NEW) let exactly one caller through over 3,000
 * tight rounds, every loser got EEXIST. Rename-to-a-unique-name-then-verify still double-claimed
 * 3-5%, so it is not used anywhere here.
 *
 * Claim protocol, per pending ticket <jobId>.json in queueDir:
 *   1. openSync(<jobId>.lock, "wx"). EEXIST (or any other error) => another launcher owns it (or the
 *      lock is unusable right now): skip, try the next ticket.
 *   2. Write {pid, at} into the lock, close it, and READ IT BACK: the lock is ours only if the file
 *      at that path now parses to our pid. See "Identity" below.
 *   3. renameSync(<jobId>.json, <jobId>.claimed.json). Only the lock holder ever renames a ticket,
 *      so renames of one ticket never overlap. ENOENT means a launcher that read the directory
 *      earlier than we did already claimed it and released its lock: skip.
 *   4. Unlink the lock as soon as the rename returns. The lock is NOT kept after the claim: RUNBOOK
 *      documents retrying claude_start with the same jobId, and a leftover lock would block that
 *      retry until it aged out. The lock therefore only exists for the milliseconds a claim takes.
 *
 * Stale locks: a launcher killed between step 1 and step 4 strands its ticket behind the lock. A
 * lock is broken only when BOTH hold: its mtime is at least staleMs old (default 60 s; a healthy
 * claim holds it for milliseconds), and its owner pid is dead -- or unreadable, meaning the owner
 * died between creating and writing the file. A live owner is never broken (a launcher suspended
 * for a minute is still the owner); the ticket is left pending and the reason logged. A reused pid
 * makes a dead owner look alive, which fails safe the same way (RUNBOOK has the manual cleanup).
 * Breaking is itself made race-safe with a second exclusive-create marker, <jobId>.lock.break:
 * only the marker holder unlinks a lock, and it re-runs the staleness check while holding the
 * marker, so a lock that a rival breaker already replaced with a fresh one is never unlinked. Two
 * launchers that both see the same stale lock therefore cannot both get a lock. A marker whose
 * holder crashed is deliberately NOT auto-broken (that would need a marker for the marker); the
 * ticket stays pending, the log says so, and RUNBOOK gives the manual fix.
 *
 * Identity: a lock is only ever unlinked by the process whose pid is inside it. Unlinking by name
 * alone is unsafe because a launcher stalled between openSync and writeSync (VM pause, antivirus
 * scan, a suspended process) for longer than staleMs looks like a dead owner with an unreadable lock:
 * a breaker unlinks it and a second launcher creates and writes its own lock at the same path. When
 * the first launcher wakes, its file descriptor points at the orphaned file, not at what is now at
 * lockPath; a later unlink-by-name would delete the second launcher's live lock and let a third
 * launcher claim the same ticket. So (a) after writing we read lockPath back and require our pid; a
 * mismatch means we lost the lock: nothing is unlinked, renamed or claimed, and we skip the ticket.
 * (b) Every later unlink of the lock (the release after the rename, and the write-failure cleanup)
 * first checks ownsLock(). Once our pid is on disk the lock is fresh (mtime just set) and its owner
 * is live, so no breaker can judge it stale and nobody else replaces it: the read-back is what closes
 * the window, and it also shows we lost a lock whose file was replaced after our create. The one
 * residue is the breaker's own check-then-unlink gap (assess -> unlinkSync, microseconds), which
 * would have to coincide with a 60 s+ stall of the owner ending inside it; plain filesystem calls
 * cannot make that step atomic. (c) The break marker is treated the same way: its holder unlinks it
 * only if its content is our pid. Nobody auto-breaks markers, so the exposure is a hand-deleted
 * marker recreated by another launcher; the pre-write empty window is the same, hence the same rule.
 * The price of the rule: a lock or marker whose content write failed is empty, so it is not ours by
 * content and is left behind (logged). An empty lock is broken by the normal stale path after
 * staleMs; an empty marker needs the manual delete RUNBOOK describes.
 *
 * The bridge is a claimant too: before job-core.mjs starts a job by the breakaway fallback while its
 * ticket is still pending, it calls withdrawTicket(), which takes the same <jobId>.lock and unlinks
 * the ticket (see the function for the four outcomes). A launcher and the bridge therefore cannot both
 * own one ticket, and a fallback-launched job cannot be started a second time by a late launcher.
 *
 * Only *.json files that are not *.claimed.json are tickets (isTicketName); *.lock and *.lock.break
 * are claim bookkeeping and every scan must ignore them.
 *
 * Deliberately imports nothing from job-core.mjs: job-core creates the live queue and job-root
 * directories at import time, and tests import this module directly against a temp queueDir.
 */
import fs from "node:fs";
import path from "node:path";

export const CLAIMED_SUFFIX = ".claimed.json";
export const LOCK_SUFFIX = ".lock";
export const BREAK_SUFFIX = ".lock.break";
export const STALE_LOCK_MS = 60_000;

export function isTicketName(name) {
  return name.endsWith(".json") && !name.endsWith(CLAIMED_SUFFIX);
}

function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Delegated to qwen2.5-coder:7b (local ollama) with this exact signature and one example; accepted
// after two edits (markdown fences stripped, a redundant empty-content check dropped -- JSON.parse
// already throws on it). True only if lockPath parses as JSON whose pid is ours; false on any error.
function ownsLock(lockPath) {
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return typeof data === "object" && data !== null && data.pid === process.pid;
  } catch {
    return false;
  }
}

// Removes lockPath (a lock or a break marker) only if it still carries our pid; otherwise it belongs
// to someone else (or is gone) and must be left exactly as it is.
function releaseIfOwned(lockPath, ctx, what) {
  if (!ownsLock(lockPath)) {
    ctx.log(`${ctx.name}: ${what} ${path.basename(lockPath)} is no longer ours (missing, replaced or unwritten); leaving it alone`);
    return;
  }
  try { fs.unlinkSync(lockPath); }
  catch (e) { if (e.code !== "ENOENT") ctx.log(`${ctx.name}: could not remove ${what} ${path.basename(lockPath)}: ${e.code}: ${e.message}`); }
}

function readLockOwner(lockPath) {
  let raw = null;
  let pid = null;
  try { raw = fs.readFileSync(lockPath, "utf8"); } catch { return { raw, pid }; }
  try {
    const p = JSON.parse(raw).pid;
    if (Number.isInteger(p) && p > 0) pid = p;
  } catch { /* empty or partial: owner died between create and write */ }
  return { raw, pid };
}

// gone | unreadable | fresh | live-owner | stale. An mtime in the future (clock stepped back) makes
// ageMs negative, so it reads as fresh -- never as stale.
function assessLock(lockPath, { staleMs, pidAlive, now }) {
  let st;
  try { st = fs.statSync(lockPath); }
  catch (e) { return { state: e.code === "ENOENT" ? "gone" : "unreadable", error: e }; }
  const ageMs = now() - st.mtimeMs;
  if (!(ageMs >= staleMs)) return { state: "fresh", ageMs };
  const { raw, pid } = readLockOwner(lockPath);
  if (pid !== null && pidAlive(pid)) return { state: "live-owner", ageMs, pid };
  return { state: "stale", ageMs, pid, raw };
}

// Returns "retry" if the lock is gone (broken by us or vanished) so the caller may try to create it
// again, "held" if it must be left alone.
function breakStaleLock(lockPath, ctx) {
  const { name, log } = ctx;
  const first = assessLock(lockPath, ctx);
  if (first.state === "gone") return "retry";
  if (first.state === "live-owner") {
    log(`${name}: claim lock is ${Math.round(first.ageMs / 1000)}s old but its owner pid=${first.pid} is alive; leaving the ticket pending`);
    return "held";
  }
  if (first.state !== "stale") return "held";

  const marker = lockPath + ".break";
  let fd;
  try { fd = fs.openSync(marker, "wx"); }
  catch (e) {
    log(e.code === "EEXIST"
      ? `${name}: stale claim lock, but ${path.basename(marker)} exists (another launcher is breaking it, or its breaker died -- delete the marker by hand if it is old); leaving the ticket pending`
      : `${name}: stale claim lock, could not create ${path.basename(marker)}: ${e.code}: ${e.message}; leaving the ticket pending`);
    return "held";
  }
  try {
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
    catch (e) { log(`${name}: could not write ${path.basename(marker)}: ${e.code}: ${e.message}`); }
    try { fs.closeSync(fd); } catch {}
    // Re-check while holding the marker: a rival breaker may already have replaced the stale lock.
    const second = assessLock(lockPath, ctx);
    if (second.state === "gone") return "retry";
    if (second.state !== "stale") return "held";
    fs.unlinkSync(lockPath);
    log(`${name}: BROKE stale claim lock (age=${Math.round(second.ageMs / 1000)}s, ` +
        `owner pid=${second.pid === null ? "unreadable" : `${second.pid} dead`}, content=${JSON.stringify(second.raw)})`);
    return "retry";
  } catch (e) {
    if (e.code === "ENOENT") return "retry";
    log(`${name}: failed to break stale claim lock: ${e.code}: ${e.message}; leaving the ticket pending`);
    return "held";
  } finally {
    releaseIfOwned(marker, ctx, "break marker");
  }
}

// true = we now hold lockPath exclusively.
function acquireLock(lockPath, ctx) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = fs.openSync(lockPath, "wx"); }
    catch (e) {
      if (e.code !== "EEXIST") {
        ctx.log(`${ctx.name}: could not create claim lock: ${e.code}: ${e.message}`);
        return false;
      }
      if (attempt === 0 && breakStaleLock(lockPath, ctx) === "retry") continue;
      return false;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
    } catch (e) {
      // Only remove what is ours by content: if we stalled and the lock was broken and replaced, the
      // file at lockPath is another launcher's. An unwritten (empty) lock is not ours by content, so
      // it stays and the stale path breaks it after staleMs.
      try { fs.closeSync(fd); } catch {}
      ctx.log(`${ctx.name}: could not write claim lock: ${e.code}: ${e.message}`);
      releaseIfOwned(lockPath, ctx, "claim lock");
      return false;
    }
    if (!ownsLock(lockPath)) {
      // We were suspended between create and write long enough for a breaker to replace the lock.
      ctx.log(`${ctx.name}: lost the claim lock (the file at ${path.basename(lockPath)} is not ours after writing); leaving it and the ticket alone`);
      return false;
    }
    return true;
  }
  return false;
}

// Finds one pending ticket in queueDir and claims it (see the protocol above). Returns
// { claimedPath, ticket } (ticket is null if the claimed file was unparseable) or null if nothing
// was claimable: nothing pending, or every candidate is owned by another launcher.
export function claimOneTicket({ queueDir, log = () => {}, staleMs = STALE_LOCK_MS,
                                 pidAlive = defaultPidAlive, now = Date.now }) {
  let entries;
  try { entries = fs.readdirSync(queueDir); }
  catch (e) { log(`readdir(${queueDir}) failed: ${e.message}`); return null; }

  for (const name of entries) {
    if (!isTicketName(name)) continue;
    const stem = name.slice(0, -".json".length);
    const ticketPath = path.join(queueDir, name);
    const claimedPath = path.join(queueDir, stem + CLAIMED_SUFFIX);
    const lockPath = path.join(queueDir, stem + LOCK_SUFFIX);
    const ctx = { name, log, staleMs, pidAlive, now };

    if (!acquireLock(lockPath, ctx)) {
      log(`${name}: claim lock not acquired (owned by another launcher); trying the next ticket`);
      continue;
    }
    let renamed = false;
    try {
      fs.renameSync(ticketPath, claimedPath);
      renamed = true;
    } catch (e) {
      log(e.code === "ENOENT"
        ? `${name}: already claimed (ticket gone by the time we held the lock); trying the next ticket`
        : `${name}: rename under claim lock failed: ${e.code}: ${e.message}; trying the next ticket`);
    } finally {
      // The claim is durable once renameSync returns; the lock has done its job either way. Only
      // release it if it is still ours (see "Identity" in the header).
      releaseIfOwned(lockPath, ctx, "claim lock");
    }
    if (!renamed) continue;

    let ticket;
    try { ticket = JSON.parse(fs.readFileSync(claimedPath, "utf8")); }
    catch (e) {
      log(`claimed ${name} but it was unparseable: ${e.message}`);
      return { claimedPath, ticket: null };
    }
    return { claimedPath, ticket };
  }
  return null;
}

// The bridge's side of the protocol: before it launches a job itself (the breakaway fallback) it must
// take its own still-pending ticket out of the queue, or a launcher that starts later would run the
// job a second time. It uses the very same lock a launcher does, so it and a launcher can never both
// own the ticket:
//   "removed" -- we held the lock and unlinked <jobId>.json; no launcher can claim it now. Safe to
//                launch the job another way.
//   "claimed" -- the ticket was already gone (a launcher renamed it to <jobId>.claimed.json).
//   "held"    -- a launcher holds <jobId>.lock right now (about to claim, or a stale lock we may not
//                break); the ticket is not ours to remove.
//   "error"   -- the unlink failed for another reason; the ticket may still be pending.
// Anything but "removed" means: do NOT launch the job another way.
export function withdrawTicket({ queueDir, jobId, log = () => {}, staleMs = STALE_LOCK_MS,
                                 pidAlive = defaultPidAlive, now = Date.now }) {
  const ticketPath = path.join(queueDir, jobId + ".json");
  const lockPath = path.join(queueDir, jobId + LOCK_SUFFIX);
  const ctx = { name: jobId + ".json", log, staleMs, pidAlive, now };
  if (!acquireLock(lockPath, ctx)) return "held";
  try {
    fs.unlinkSync(ticketPath);
    return "removed";
  } catch (e) {
    if (e.code === "ENOENT") return "claimed";
    log(`${ctx.name}: could not remove the pending ticket: ${e.code}: ${e.message}`);
    return "error";
  } finally {
    releaseIfOwned(lockPath, ctx, "claim lock");
  }
}
