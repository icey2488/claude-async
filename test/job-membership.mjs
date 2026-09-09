#!/usr/bin/env node
/**
 * test/job-membership.mjs — unit test for tools/jobMembership.mjs (2026-09-09 runner-termination
 * investigation instrumentation). Does not require any ambient Job Object setup: just proves both
 * access patterns return a well-formed record when queried against the current (this test's own)
 * process.
 *
 * Run: node test/job-membership.mjs   (exit 0 = both shapes well-formed)
 */
import { queryJobMembershipOnce, createSelfMembershipQuerier } from "../tools/jobMembership.mjs";

const REQUIRED_KEYS = ["inJob", "limitFlags", "killOnClose", "silentBreakawayOk", "breakawayOk"];

function isWellFormed(record) {
  if (!record || typeof record !== "object") return "not an object";
  for (const k of REQUIRED_KEYS) {
    if (!(k in record)) return `missing key "${k}"`;
  }
  if (record.inJob !== null && typeof record.inJob !== "boolean") return `inJob has wrong type: ${typeof record.inJob}`;
  if (record.limitFlags !== null && typeof record.limitFlags !== "string") return `limitFlags has wrong type: ${typeof record.limitFlags}`;
  for (const k of ["killOnClose", "silentBreakawayOk", "breakawayOk"]) {
    if (record[k] !== null && typeof record[k] !== "boolean") return `${k} has wrong type: ${typeof record[k]}`;
  }
  // On win32, IsProcessInJob should always be answerable for our own live process -- inJob null
  // (i.e. IsProcessInJob itself failed) would mean something is badly wrong with the query path.
  if (process.platform === "win32" && record.inJob === null) return `inJob is null (error: ${record.error})`;
  return null;
}

let failures = 0;

console.log("=== queryJobMembershipOnce(process.pid) ===");
const once = queryJobMembershipOnce(process.pid);
console.log(JSON.stringify(once, null, 2));
const onceProblem = isWellFormed(once);
if (onceProblem) { console.log(`FAIL — ${onceProblem}`); failures++; }
else console.log("PASS — well-formed");

console.log("\n=== createSelfMembershipQuerier().query(process.pid) ===");
const querier = createSelfMembershipQuerier();
try {
  const viaHelper = await querier.query(process.pid, 10000);
  console.log(JSON.stringify(viaHelper, null, 2));
  const helperProblem = isWellFormed(viaHelper);
  if (helperProblem) { console.log(`FAIL — ${helperProblem}`); failures++; }
  else console.log("PASS — well-formed");

  // A second query on the same live helper proves the persistent stdin/stdout protocol survives
  // more than one round-trip (the whole point of caching the P/Invoke type across calls).
  console.log("\n=== second query on the same helper ===");
  const second = await querier.query(process.pid, 10000);
  console.log(JSON.stringify(second, null, 2));
  const secondProblem = isWellFormed(second);
  if (secondProblem) { console.log(`FAIL — ${secondProblem}`); failures++; }
  else console.log("PASS — well-formed");
} finally {
  querier.close();
}

console.log(failures === 0 ? "\nPASS — queryJobMembership shapes are well-formed" : `\nFAIL — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
