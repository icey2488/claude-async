// Forked by claim.test.mjs (not a test itself: the *.test.mjs glob skips it). One persistent process
// stands in for one job-launcher.mjs instance. Each round the coordinator hands it a queue dir and a
// shared wall-clock instant (goAt); the worker spins until that instant so every worker's first claim
// lands together, then drains the queue with the claim function under test and reports what it took.
//
// CLAIM_RACE_VARIANT=old swaps in the algorithm this repo used before launcher-claim.mjs (a bare
// rename), which exists only so the harness can be shown to catch the double-claim bug.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { claimOneTicket, isTicketName } from "../../launcher-claim.mjs";

const nowHr = () => performance.timeOrigin + performance.now();

function renameOnlyClaimOneTicket({ queueDir }) {
  for (const name of fs.readdirSync(queueDir)) {
    if (!isTicketName(name)) continue;
    const claimedPath = path.join(queueDir, name.replace(/\.json$/, ".claimed.json"));
    try { fs.renameSync(path.join(queueDir, name), claimedPath); }
    catch { continue; }
    return { claimedPath, ticket: null };
  }
  return null;
}

const claim = process.env.CLAIM_RACE_VARIANT === "old" ? renameOnlyClaimOneTicket : claimOneTicket;

process.on("message", ({ round, queueDir, goAt }) => {
  const logs = [];
  const log = (line) => logs.push(line);
  while (nowHr() < goAt) { /* spin: aligns every worker's first claim */ }
  const startedAt = nowHr();
  const claimed = [];
  for (;;) {
    const c = claim({ queueDir, log });
    if (!c) break;
    claimed.push(path.basename(c.claimedPath));
  }
  process.send({ round, pid: process.pid, claimed, logs, startedAt, late: startedAt - goAt });
});

process.send({ ready: true });
