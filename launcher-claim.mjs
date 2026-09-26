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
 *   2. Write {pid, at} into the lock and close it.
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
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch {}
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
    try { fs.unlinkSync(marker); } catch {}
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
      // We created the file, so it is ours to remove; a half-written lock must not strand the ticket.
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
      ctx.log(`${ctx.name}: could not write claim lock: ${e.code}: ${e.message}`);
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
      // The claim is durable once renameSync returns; the lock has done its job either way.
      try { fs.unlinkSync(lockPath); }
      catch (e) { if (e.code !== "ENOENT") log(`${name}: could not remove claim lock: ${e.code}: ${e.message}`); }
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
