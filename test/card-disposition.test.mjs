// test/card-disposition.test.mjs — regression tests for card-hook.mjs's closeCard() disposition
// mapping, driven by the SAME classifyFinalStatus() rule (job-status.mjs) job-core.mjs's
// checkJob() uses for claude_check's `status` field. Exercises closeCard() directly against a
// mock jobcard command (as test-card-hook.mjs does) rather than through the real job-runner.mjs
// subprocess: job-runner.mjs's own exit-reason computation (exitReason/reportComplete) is already
// covered end-to-end by test/multihost/exit-reason.test.mjs, so this file only needs to prove
// closeCard's disposition choice for each of the four classifyFinalStatus outcomes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "card-disposition-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const LOG = path.join(TMP, "invocations.log");
const MOCK_SCRIPT = path.join(TMP, "mock-jobcard.mjs");
fs.writeFileSync(MOCK_SCRIPT, `
import fs from "node:fs";
const [cmd, ...rest] = process.argv.slice(2);
const LOG = ${JSON.stringify(LOG)};
if (cmd === "done" || cmd === "fail") {
  fs.appendFileSync(LOG, cmd + "\\t" + rest[0] + "\\n");
} else if (cmd === "artifact") {
  const kindIdx = rest.indexOf("--kind");
  const refIdx = rest.indexOf("--ref");
  fs.appendFileSync(LOG, "artifact\\t" + rest[0] + "\\t" + rest[kindIdx + 1] + "\\t" + rest[refIdx + 1] + "\\n");
  process.stdout.write("mock-artifact-id\\n");
} else { process.exit(1); }
`);

process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify([process.execPath, MOCK_SCRIPT]);
const { closeCard } = await import("../card-hook.mjs");

function clearLog() { try { fs.writeFileSync(LOG, ""); } catch {} }
function readLog() { try { return fs.readFileSync(LOG, "utf8"); } catch { return ""; } }

test("normal completed run (exit 0, no exitRecord / reportComplete true) -> done, no note", () => {
  clearLog();
  closeCard("card-x", 0, TMP, null, { exitReason: "exit", reportComplete: true });
  const log = readLog();
  assert.match(log, /^done\tcard-x\n$/, `expected only a done entry, got: ${log}`);
});

test("exit-0 incomplete run (reportComplete: false) -> fail, plus an incomplete note", () => {
  clearLog();
  closeCard("card-x", 0, TMP, null, { exitReason: "exit", reportComplete: false });
  const log = readLog();
  assert.match(log, /^fail\tcard-x\n/, `expected a fail entry, got: ${log}`);
  assert.match(log, /^artifact\tcard-x\tnote\tincomplete:/m, `expected an incomplete note artifact, got: ${log}`);
  assert.ok(!log.includes("done"), `must not be marked done: ${log}`);
});

test("bg_tasks_terminated (exit 0, CLI's own wait-ceiling line) -> fail, no note (failed takes precedence)", () => {
  clearLog();
  // Even if reportComplete also happens to be false, bg_tasks_terminated must still resolve to
  // "failed" (not "incomplete") per classifyFinalStatus — so no incomplete note is attached.
  closeCard("card-x", 0, TMP, null, { exitReason: "bg_tasks_terminated", reportComplete: false });
  const log = readLog();
  assert.match(log, /^fail\tcard-x\n$/, `expected only a fail entry, got: ${log}`);
});

test("nonzero exit -> fail, unchanged (no note, no exitRecord needed)", () => {
  clearLog();
  closeCard("card-x", 1, TMP, null);
  const log = readLog();
  assert.match(log, /^fail\tcard-x\n$/, `expected only a fail entry, got: ${log}`);
});

test("legacy caller with no exitRecord arg (exit 0) -> completed/done, unchanged from before this fix", () => {
  clearLog();
  closeCard("card-x", 0, TMP, null);
  const log = readLog();
  assert.match(log, /^done\tcard-x\n$/, `expected only a done entry, got: ${log}`);
});
