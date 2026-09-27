// Forked by startlock.test.mjs. Stands in for one process calling guard.mjs's withStartLock against a
// shared jobRoot. Two roles per round:
//   "holder"  acquires the lock first, immediately backdates its OWN lock's mtime past LOCK_STALE_MS
//             (simulating a real 30s+ stall between acquire and release without actually waiting),
//             appends an "enter" line to the trace file, busy-waits holdMs ms (synchronously, so it
//             stays inside fn() the whole time), appends an "exit" line, then returns.
//   "racer"   waits until goAt (timed to land inside the holder's busy-wait window) and then makes its
//             own withStartLock call, appending its own enter/exit lines.
// The trace file is append-only and shared across both processes; the coordinator reconstructs the
// interleaving from it afterwards. Round rounds are isolated by giving each one a fresh jobRoot dir.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { withStartLock } from "../../guard.mjs";

const nowHr = () => performance.timeOrigin + performance.now();
const busyWaitMs = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };

function trace(tracePath, line) {
  fs.appendFileSync(tracePath, `${line}\n`);
}

process.on("message", async ({ round, jobRoot, tracePath, goAt, role, holdMs }) => {
  while (nowHr() < goAt) { /* spin: aligns this worker's attempt to the shared instant */ }
  const startedAt = nowHr();
  const tag = role === "holder" ? "P1" : "P2";
  const result = await withStartLock(jobRoot, () => {
    if (role === "holder") {
      const lockPath = path.join(jobRoot, ".start.lock");
      const old = new Date(Date.now() - 90_000); // 90s > LOCK_STALE_MS: looks stale to any observer
      try { fs.utimesSync(lockPath, old, old); } catch { /* lock vanished; let the caller see it */ }
    }
    trace(tracePath, `${tag} enter pid=${process.pid} at=${nowHr()}`);
    busyWaitMs(role === "holder" ? holdMs : Math.min(50, holdMs));
    trace(tracePath, `${tag} exit pid=${process.pid} at=${nowHr()}`);
    return tag;
  });
  process.send({ round, role, result, startedAt, late: startedAt - goAt });
});

process.send({ ready: true });
