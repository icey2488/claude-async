/**
 * runner-lock.mjs -- runner.lock, the one-runner-per-job-dir lock taken by job-runner.mjs as its
 * first act (host and container jobs alike; review round 3, finding B4).
 *
 * Acquisition publishes the lock FULLY INITIALISED and ATOMICALLY: the content "<pid>\n<nonce>\n" is
 * written to a private temp file first and then hard-linked to runner.lock. link(2) (CreateHardLink
 * on NTFS) fails with EEXIST when the name exists and never exposes a half-written file, so there is
 * no window in which another runner can see an empty lock and mistake it for a stale one (the old
 * O_EXCL create + write had exactly that window).
 *
 * Stale takeover is serialised by a verified rename: a runner that judged the lock stale renames it
 * to a name only it uses (runner.lock.stale-<pid>-<nonce>), re-reads the renamed file and proceeds
 * only if it is byte-for-byte the content it judged stale. If not, another runner had already
 * replaced the stale lock with its own live one between our read and our rename: the renamed file
 * is put back (link, which cannot overwrite) and this runner gives up (exit 3). After a verified
 * rename the runner links its own lock; losing that link race also means giving up. So two runners
 * judging the same stale lock can never both proceed, and an earlier observation can never remove a
 * lock that was taken after it.
 *
 * An empty or unparsable lock is only stale once it is older than LOCK_INIT_GRACE_MS: a lock written
 * by an older runner build (O_EXCL create, then write) is briefly empty while its owner is alive.
 *
 * Residual (documented in docs/container-jobs.md): the put-back after a failed verification needs
 * the name to be free; a third runner that links its own lock in that instant keeps the lock and the
 * displaced owner keeps running too. That needs three runners for one job dir inside a few
 * microseconds AND a stale lock to start from; launches give one runner per job dir.
 *
 * EPERM / EACCES / EBUSY from link, rename or read (Windows, a file another process holds open) mean
 * "someone has it": the result is { acquired: false, reason: "busy" }, never an exception (Argon #4).
 *
 * hooks: test seams called at the interleaving points ({ afterRead, afterRename }), so a test can
 * run a second contender at exactly that point; fsImpl: the fs module (tests inject errors). Production
 * passes neither.
 */
import crypto from "node:crypto";
import fs from "node:fs";

export const LOCK_INIT_GRACE_MS = 5000;

// "<pid>\n<nonce>\n" (this build) or "<pid>" (older builds). Returns { pid, nonce } or null.
export function parseLock(text) {
  if (typeof text !== "string") return null;
  const m = /^(\d{1,10})(?:\r?\n([0-9a-f]{8,64}))?\r?\n?$/.exec(text);
  if (!m) return null;
  const pid = Number(m[1]);
  return pid > 0 ? { pid, nonce: m[2] || null } : null;
}

// Windows: link/rename/unlink against a file another process holds open can fail with these instead
// of EEXIST (Argon #4). They mean "someone has it": treated as held, never thrown.
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
class Busy extends Error {}

// Returns { acquired: true, content } or { acquired: false, holder, reason }. Throws only on an
// unexpected filesystem error (the caller treats that as fatal, as before).
//   isLive(pid): is that pid a live runner (job-core's pidAlive && isOurProcess)
export function acquireRunnerLock(lockPath, { pid = process.pid, isLive, now = Date.now, hooks = {}, nonce = crypto.randomBytes(8).toString("hex"),
                                              fsImpl = fs } = {}) {
  const content = `${pid}\n${nonce}\n`;
  const tmp = `${lockPath}.tmp-${pid}-${nonce}`;
  const busy = (e) => { if (BUSY_CODES.has(e && e.code)) throw new Busy(e.code); throw e; };
  const readOrNull = (p) => { try { return fsImpl.readFileSync(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; return busy(e); } };
  fsImpl.writeFileSync(tmp, content, { flag: "wx", mode: 0o644 });
  const link = () => { try { fsImpl.linkSync(tmp, lockPath); return true; } catch (e) { if (e.code === "EEXIST") return false; return busy(e); } };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (link()) return { acquired: true, content };
      let seen, st;
      try { seen = readOrNull(lockPath); st = seen === null ? null : fsImpl.statSync(lockPath); } catch (e) { if (e instanceof Busy) throw e; seen = null; }
      if (seen === null) continue;                               // vanished between link and read: try again
      const parsed = parseLock(seen);
      if (parsed && parsed.pid === pid && parsed.nonce === nonce) return { acquired: true, content };
      if (parsed) {
        if (parsed.pid !== pid && isLive(parsed.pid)) return { acquired: false, holder: parsed.pid, reason: "held" };
      } else if (!st || now() - st.mtimeMs < LOCK_INIT_GRACE_MS) {
        return { acquired: false, holder: null, reason: "initialising" };   // empty/unparsable and young: someone is writing it
      }
      if (hooks.afterRead) hooks.afterRead();
      // Judged stale: take it out of the way under a name only we use, then verify it is what we judged.
      const aside = `${lockPath}.stale-${pid}-${nonce}`;
      try { fsImpl.renameSync(lockPath, aside); }
      catch (e) { if (e.code === "ENOENT") continue; busy(e); }   // someone else moved it first: look again
      if (hooks.afterRename) hooks.afterRename();
      const moved = readOrNull(aside);
      if (moved !== seen) {
        // Not the lock we judged stale: another runner replaced it in between. Put it back (link cannot
        // overwrite a lock taken meanwhile) and give up.
        try { fsImpl.linkSync(aside, lockPath); } catch {}
        try { fsImpl.unlinkSync(aside); } catch {}
        const p2 = parseLock(moved || "");
        return { acquired: false, holder: p2 ? p2.pid : null, reason: "replaced" };
      }
      try { fsImpl.unlinkSync(aside); } catch {}
      if (link()) return { acquired: true, content, tookOverFrom: parsed ? parsed.pid : null };
      const p3 = parseLock(readOrNull(lockPath) || "");
      return { acquired: false, holder: p3 ? p3.pid : null, reason: "lost-race" };
    }
    return { acquired: false, holder: null, reason: "contended" };
  } catch (e) {
    if (e instanceof Busy) return { acquired: false, holder: null, reason: "busy", code: e.message };
    throw e;
  } finally {
    try { fsImpl.unlinkSync(tmp); } catch {}
  }
}
