#!/usr/bin/env node
/**
 * test-card-hook.mjs — unit + integration tests for the jobcard auto-card hook.
 *
 * Tests (5 required scenarios):
 *   1. card-id recorded on start — mintCard returns a cardId; startJob stores it in meta.json
 *   2. done + artifact on clean exit with HEAD moved
 *   3. no artifact when HEAD unchanged
 *   4. fail on nonzero exit
 *   5. UNCARDED path when jobcard errors — mintCard returns {error, cardId:null}; startJob still dispatches
 *
 * Run: node test-card-hook.mjs   (exit 0 = all pass)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Temp workspace ───────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "test-card-"));
const LOG = path.join(TMP, "invocations.log");
const MOCK_ID = "mock-card-aa000000-0000-0000-0000-000000000001";
const MOCK_SCRIPT = path.join(TMP, "mock-jobcard.mjs");
const ERROR_SCRIPT = path.join(TMP, "error-jobcard.mjs");

// Mock jobcard: logs each subcommand to LOG, prints MOCK_ID on create.
fs.writeFileSync(MOCK_SCRIPT, `
import fs from "node:fs";
const [cmd, ...rest] = process.argv.slice(2);
const LOG = ${JSON.stringify(LOG)};
if (cmd === "create") {
  fs.appendFileSync(LOG, "create\\t" + rest.join("\\t") + "\\n");
  process.stdout.write(${JSON.stringify(MOCK_ID)} + "\\n");
} else if (cmd === "done") {
  fs.appendFileSync(LOG, "done\\t" + rest[0] + "\\n");
} else if (cmd === "fail") {
  fs.appendFileSync(LOG, "fail\\t" + rest[0] + "\\n");
} else if (cmd === "artifact") {
  const kindIdx = rest.indexOf("--kind");
  const refIdx = rest.indexOf("--ref");
  const kind = kindIdx >= 0 ? rest[kindIdx + 1] : "?";
  const ref  = refIdx  >= 0 ? rest[refIdx  + 1] : "?";
  fs.appendFileSync(LOG, "artifact\\t" + rest[0] + "\\t" + kind + "\\t" + ref + "\\n");
  process.stdout.write("mock-artifact-id\\n");
} else { process.exit(1); }
`);

// Error jobcard: always exits non-zero.
fs.writeFileSync(ERROR_SCRIPT, "process.exit(42);\n");

// ─── Env setup (must be before importing modules that read env at load time) ──
// JSON array format avoids whitespace-split breakage on "C:\Program Files\...\node.exe".

const MOCK_CMD  = JSON.stringify([process.execPath, MOCK_SCRIPT]);
const ERROR_CMD = JSON.stringify([process.execPath, ERROR_SCRIPT]);

process.env.CLAUNKER_JOBCARD_CMD = MOCK_CMD;
process.env.CLAUDE_ASYNC_JOB_DIR = path.join(TMP, "jobs");
process.env.CLAUDE_CLI_PATH = process.execPath; // node as "claude" — exits fast with unknown flags

// ─── Imports (dynamic so env vars are set first) ──────────────────────────────

const { mintCard, closeCard, getGitHead, intentSummary, INTENT_SUMMARY_MAX } = await import("./card-hook.mjs");
const { startJob } = await import("./job-core.mjs");

// ─── Git test repo ────────────────────────────────────────────────────────────

const REPO = path.join(TMP, "git-repo");
fs.mkdirSync(REPO, { recursive: true });
spawnSync("git", ["init", "-b", "main"], { cwd: REPO });
spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: REPO });
spawnSync("git", ["config", "user.name", "Test"], { cwd: REPO });
fs.writeFileSync(path.join(REPO, "a.txt"), "hello");
spawnSync("git", ["add", "."], { cwd: REPO });
spawnSync("git", ["commit", "-m", "first"], { cwd: REPO });
const HEAD1 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function clearLog() { try { fs.writeFileSync(LOG, ""); } catch {} }
function readLog()  { try { return fs.readFileSync(LOG, "utf8"); } catch { return ""; } }

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function test(name, fn) {
  clearLog();
  try {
    fn();
    console.log(`PASS — ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL — ${name}: ${e.message}`);
    failed++;
  }
}

// ─── Test 1: card-id recorded on start ───────────────────────────────────────

test("card-id recorded on start (mintCard returns cardId)", () => {
  const { cardId, startHead, error } = mintCard("job-t1", REPO);
  assert(cardId === MOCK_ID, `expected ${MOCK_ID}, got ${JSON.stringify(cardId)}`);
  assert(error === null, `expected no error, got ${JSON.stringify(error)}`);
  assert(startHead === HEAD1, `expected HEAD1 ${HEAD1}, got ${startHead}`);
  const log = readLog();
  assert(log.trim().endsWith("job-t1"), `log should end with title job-t1, got: ${log}`);
});

// ─── Test 1b: mintCard emits resolved model/effort/job-id as provenance flags ─

test("mintCard passes resolved model/effort as --model/--effort, jobId as --job-id", () => {
  mintCard("job-prov1", REPO, "claude-opus-4-8", "high");
  const fields = readLog().trim().split("\t");
  assert(fields[fields.indexOf("--model") + 1] === "claude-opus-4-8",
    `expected --model claude-opus-4-8, got: ${fields.join(" ")}`);
  assert(fields[fields.indexOf("--effort") + 1] === "high",
    `expected --effort high, got: ${fields.join(" ")}`);
  assert(fields[fields.indexOf("--job-id") + 1] === "job-prov1",
    `expected --job-id job-prov1, got: ${fields.join(" ")}`);
});

test("mintCard omits --model/--effort when not provided (absent means absent)", () => {
  mintCard("job-prov2", REPO);
  const log = readLog();
  assert(!log.includes("--model"), `expected no --model flag, got: ${log}`);
  assert(!log.includes("--effort"), `expected no --effort flag, got: ${log}`);
  assert(log.includes("--job-id\tjob-prov2"), `expected --job-id still present, got: ${log}`);
});

// ─── Test 1c: mintCard emits a bounded intent summary as --description ─────────

test("mintCard passes the prompt's intent summary as --description (first sentence)", () => {
  // A realistic dispatch prompt: a >200-char first line (intent sentence + boilerplate),
  // so the rule extracts just the opening sentence rather than keeping the whole line.
  const prompt = "Give the chip a vendor-keyed color. You are on native Windows as Raide. Repo lives on main which auto-deploys, gh.exe authed as icey2488, one-shot git-credential, never store creds, secret-scan every staged diff before committing.";
  mintCard("job-desc1", REPO, null, null, prompt);
  const fields = readLog().trim().split("\t");
  const body = fields[fields.indexOf("--description") + 1];
  assert(body === "Give the chip a vendor-keyed color.", `expected first sentence, got: ${JSON.stringify(body)}`);
});

test("mintCard omits --description when no prompt (absent body, never empty string)", () => {
  mintCard("job-desc2", REPO, null, null);
  const log = readLog();
  assert(!log.includes("--description"), `expected no --description flag, got: ${log}`);
});

// ─── Test 1d: intentSummary extraction rule (unit) ────────────────────────────

test("intentSummary: short first line used whole; long line → first sentence; else ellipsized", () => {
  assert(intentSummary("Do the thing.") === "Do the thing.", "short whole line");
  assert(intentSummary("") === null, "empty → null");
  assert(intentSummary("\n\n  Fix it.  \nmore") === "Fix it.", "first non-empty line, trimmed");
  const longNoSentence = "word ".repeat(60).trim(); // 300 chars, no . ? !
  const s = intentSummary(longNoSentence);
  assert(s.length <= INTENT_SUMMARY_MAX + 1 && s.endsWith("…"), `expected ellipsized ≤cap, got len ${s.length}`);
});

test("startJob threads its resolved model/effort into mintCard's flags", () => {
  startJob({ prompt: "test", workFolder: REPO, jobId: "job-prov3", model: "claude-opus-4-8", effort: "xhigh" });
  const fields = readLog().trim().split("\t");
  assert(fields[fields.indexOf("--model") + 1] === "claude-opus-4-8",
    `expected resolved caller model in flags, got: ${fields.join(" ")}`);
  assert(fields[fields.indexOf("--effort") + 1] === "xhigh",
    `expected resolved caller effort in flags, got: ${fields.join(" ")}`);
  try { fs.rmSync(path.join(process.env.CLAUDE_ASYNC_JOB_DIR, "job-prov3"), { recursive: true, force: true }); } catch {}
});

test("startJob falls back to job-core's own model/effort defaults in mintCard's flags", () => {
  startJob({ prompt: "test", workFolder: REPO, jobId: "job-prov4" });
  const fields = readLog().trim().split("\t");
  assert(fields[fields.indexOf("--model") + 1] === "claude-sonnet-5",
    `expected default model in flags, got: ${fields.join(" ")}`);
  assert(fields[fields.indexOf("--effort") + 1] === "medium",
    `expected default effort in flags, got: ${fields.join(" ")}`);
  try { fs.rmSync(path.join(process.env.CLAUDE_ASYNC_JOB_DIR, "job-prov4"), { recursive: true, force: true }); } catch {}
});

// Also verify startJob stores cardId in meta.json
test("card-id recorded on start (startJob stores cardId in meta.json)", () => {
  const result = startJob({ prompt: "test prompt", workFolder: REPO, jobId: "job-t1b" });
  const metaPath = path.join(process.env.CLAUDE_ASYNC_JOB_DIR, "job-t1b", "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert(meta.cardId === MOCK_ID, `meta.cardId should be ${MOCK_ID}, got ${meta.cardId}`);
  assert(meta.startHead === HEAD1, `meta.startHead should be ${HEAD1}, got ${meta.startHead}`);
  // Cleanup the spawned job dir (the detached runner will fail fast with node args)
  try { fs.rmSync(path.join(process.env.CLAUDE_ASYNC_JOB_DIR, "job-t1b"), { recursive: true, force: true }); } catch {}
});

// ─── Test 2: done + artifact on clean exit with HEAD moved ────────────────────

test("done + artifact on clean exit with HEAD moved", () => {
  // Advance the repo HEAD
  fs.writeFileSync(path.join(REPO, "b.txt"), "world");
  spawnSync("git", ["add", "."], { cwd: REPO });
  spawnSync("git", ["commit", "-m", "second"], { cwd: REPO });
  const HEAD2 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();

  closeCard(MOCK_ID, 0, REPO, HEAD1);
  const log = readLog();
  assert(log.includes(`done\t${MOCK_ID}`),
    `expected done entry in log, got: ${log}`);
  assert(log.includes(`artifact\t${MOCK_ID}\tdelivery\t${HEAD2}`),
    `expected artifact with HEAD2 ${HEAD2} in log, got: ${log}`);
});

// ─── Test 3: no artifact when HEAD unchanged ──────────────────────────────────

test("no artifact when HEAD unchanged", () => {
  const currentHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  closeCard(MOCK_ID, 0, REPO, currentHead);
  const log = readLog();
  assert(log.includes(`done\t${MOCK_ID}`), `expected done in log, got: ${log}`);
  assert(!log.includes("artifact"), `expected no artifact in log, got: ${log}`);
});

// ─── Test 4: fail on nonzero exit ────────────────────────────────────────────

test("fail on nonzero exit", () => {
  closeCard(MOCK_ID, 1, REPO, HEAD1);
  const log = readLog();
  assert(log.includes(`fail\t${MOCK_ID}`), `expected fail in log, got: ${log}`);
  assert(!log.includes("done"),     `unexpected done in log: ${log}`);
  assert(!log.includes("artifact"), `unexpected artifact in log: ${log}`);
});

// ─── Test 5: UNCARDED path — jobcard errors, job still runs ──────────────────

test("UNCARDED: mintCard with bad cmd returns {error, cardId:null} without throwing", () => {
  process.env.CLAUNKER_JOBCARD_CMD = ERROR_CMD;
  try {
    const { cardId, error } = mintCard("job-t5a", REPO);
    assert(cardId === null, `expected null cardId, got ${JSON.stringify(cardId)}`);
    assert(error !== null && error.length > 0, `expected an error string, got ${JSON.stringify(error)}`);
  } finally {
    process.env.CLAUNKER_JOBCARD_CMD = MOCK_CMD;
  }
});

test("UNCARDED: startJob still dispatches when jobcard errors (note prefixed UNCARDED:)", () => {
  process.env.CLAUNKER_JOBCARD_CMD = ERROR_CMD;
  let result;
  try {
    result = startJob({ prompt: "test", workFolder: REPO, jobId: "job-t5b" });
  } finally {
    process.env.CLAUNKER_JOBCARD_CMD = MOCK_CMD;
  }
  assert(result && result.pid, "startJob should return a job record with a pid");
  assert(result.note.startsWith("UNCARDED:"),
    `note should start with UNCARDED:, got: ${result.note}`);
  // Cleanup
  try { fs.rmSync(path.join(process.env.CLAUDE_ASYNC_JOB_DIR, "job-t5b"), { recursive: true, force: true }); } catch {}
});

// ─── Cleanup + summary ────────────────────────────────────────────────────────

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

const total = passed + failed;
console.log(`\n${passed}/${total} CARD-HOOK TESTS PASSED`);
process.exit(failed > 0 ? 1 : 0);
