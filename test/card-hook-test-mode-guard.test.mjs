// test/card-hook-test-mode-guard.test.mjs — regression test for the 2026-11-13 fixture-card
// incident (three test files called startJob() in-process with no jobcard override at all and
// each filed a real dispatch card on Erick's live Spine board). Proves card-hook.mjs's runJobcard()
// guard (see its header's "Test isolation" note): under the test runner, with no explicit
// CLAUNKER_JOBCARD_CMD, the configured default jobcard command is never actually invoked -- no
// matter what CLAUNKER_HERMES_HOME resolves to.
//
// Rather than asserting on stderr text, this builds a stand-in "default jobcard command" --
// CLAUNKER_HERMES_HOME pointed at a temp dir shaped like card-hook.mjs's defaultJobcard() expects
// (<hermes>/.venv/Scripts/python.exe + <hermes>/jobcard.py) -- that logs every invocation to a
// file. The guard is proven by that log file staying empty; a first test (explicit opt-in) proves
// the stand-in command itself actually works, so an empty log in the guarded test isn't just a
// broken fixture.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "card-hook-test-mode-guard-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const HERMES = path.join(TMP, "hermes");
const VENV_BIN = process.platform === "win32" ? path.join(HERMES, ".venv", "Scripts") : path.join(HERMES, ".venv", "bin");
const STAND_IN_PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const JOBCARD_PY = path.join(HERMES, "jobcard.py");
const LOG = path.join(TMP, "invocations.log");

fs.mkdirSync(VENV_BIN, { recursive: true });
// A real win32 executable (a renamed copy of node.exe itself) so spawnSync can actually launch it --
// this is standing in for the real jobcard.py's python.exe, never the real interpreter.
fs.copyFileSync(process.execPath, STAND_IN_PYTHON);
fs.writeFileSync(JOBCARD_PY, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(LOG)}, "invoked:" + process.argv.slice(2).join(" ") + "\\n");
process.stdout.write("fake-card-id");
`);

process.env.CLAUNKER_HERMES_HOME = HERMES;
delete process.env.CLAUNKER_JOBCARD_CMD;

const { mintCard } = await import("../card-hook.mjs");

function clearLog() { try { fs.writeFileSync(LOG, ""); } catch {} }
function readLog() { try { return fs.readFileSync(LOG, "utf8"); } catch { return ""; } }

test("sanity: the stand-in default jobcard command actually works when explicitly opted in", () => {
  clearLog();
  process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify([STAND_IN_PYTHON, JOBCARD_PY]);
  try {
    const { cardId, error } = mintCard("guard-test-explicit", TMP, null, null, "hi", null);
    assert.equal(error, null);
    assert.equal(cardId, "fake-card-id");
    assert.match(readLog(), /^invoked:/);
  } finally {
    delete process.env.CLAUNKER_JOBCARD_CMD;
  }
});

test("guard: under the test runner, with no explicit CLAUNKER_JOBCARD_CMD, the default jobcard command is never invoked", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT !== undefined, "this test must itself be running under the node test runner");
  assert.equal(process.env.CLAUNKER_JOBCARD_CMD, undefined, "no explicit override must be set for this test");
  clearLog();
  const { cardId, error } = mintCard("guard-test-implicit", TMP, null, null, "hi", null);
  assert.equal(error, null, "skip is not an error");
  assert.equal(cardId, null, "no real card is filed");
  assert.equal(readLog(), "", "the stand-in default jobcard command must never have been spawned");
});
