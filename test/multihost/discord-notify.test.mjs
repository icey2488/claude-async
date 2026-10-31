// discord-notify.mjs: best-effort Discord webhook ping fired from job-runner.mjs's finish(),
// strictly AFTER exit.json and exit_code are written. Two layers of coverage:
//   - unit tests directly against discord-notify.mjs's pure helpers (RESULT marker parsing,
//     marker precedence, excerpt selection/truncation/escaping, content shape) -- no process
//     spawn, no network;
//   - integration tests that run the REAL job-runner.mjs against a local 127.0.0.1 HTTP server,
//     covering config on/off, success, non-2xx, a server that never responds, ordering, and that
//     the webhook URL never leaks into any job-dir file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupTmp, TMP, hosts } from "./_setup.mjs";
import {
  NOTIFY_TIMEOUT_MS, loadNotifyConfig, escapeDiscordText, formatDuration, markerFor,
  buildDiscordContent, loadCompletenessConfig, hasCompletenessMarker,
  DEFAULT_COMPLETENESS_MARKER_SOURCE, INCOMPLETE_REASON, notifyJobFinished, isTestMode,
  getRealSendBlockedCount, stripMarkdownWrapping, parseResultMarker, isSummaryHeadingLine,
  buildExcerpt, EXCERPT_MAX_CHARS, closeMarkdownSpansAtStart, stripBackticksAroundUrls,
  ensureSpaceAfterUrlBeforeBacktick,
} from "../../discord-notify.mjs";

after(cleanupTmp);

// ---------------------------------------------------------------------------
// Unit tests: pure helpers, no I/O.
// ---------------------------------------------------------------------------

test("escapeDiscordText: backslash-escapes @, `, <, > and nothing else", () => {
  assert.equal(escapeDiscordText("hi @everyone `code` <tag> plain"), "hi \\@everyone \\`code\\` \\<tag\\> plain");
  assert.equal(escapeDiscordText("no special chars here"), "no special chars here");
});

test("formatDuration: seconds, minutes, hours, and the unknown fallback", () => {
  assert.equal(formatDuration(4_500), "5s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(3_661_000), "1h01m01s");
  assert.equal(formatDuration(NaN), "unknown");
  assert.equal(formatDuration(-1), "unknown");
});

test("stripMarkdownWrapping: strips wrapper chars without touching the hyphen inside DELEGATION-METRICS", () => {
  assert.equal(stripMarkdownWrapping("`DELEGATION-METRICS: x`"), "DELEGATION-METRICS: x");
  assert.equal(stripMarkdownWrapping("**DELEGATION-METRICS: x**"), "DELEGATION-METRICS: x");
  assert.equal(stripMarkdownWrapping("> DELEGATION-METRICS: x"), "DELEGATION-METRICS: x");
  assert.equal(stripMarkdownWrapping("    DELEGATION-METRICS: x"), "DELEGATION-METRICS: x");
});

// ---------------------------------------------------------------------------
// RESULT: marker parsing (requirement A).
// ---------------------------------------------------------------------------

test("parseResultMarker: each value, case-insensitive, tolerant of markdown wrapping and a trailing period", () => {
  assert.equal(parseResultMarker(["RESULT: pass"]), "pass");
  assert.equal(parseResultMarker(["result: PARTIAL"]), "partial");
  assert.equal(parseResultMarker(["Result: Blocked."]), "blocked");
  assert.equal(parseResultMarker(["RESULT: fail"]), "fail");
  assert.equal(parseResultMarker(["`RESULT: blocked`"]), "blocked");
  assert.equal(parseResultMarker(["**RESULT: partial**"]), "partial");
  assert.equal(parseResultMarker(["> RESULT: pass"]), "pass");
});

test("parseResultMarker: last occurrence wins; missing marker, empty, and non-array input all yield null", () => {
  assert.equal(parseResultMarker(["RESULT: pass", "more text", "RESULT: fail"]), "fail");
  assert.equal(parseResultMarker(["no marker in this report"]), null);
  assert.equal(parseResultMarker([]), null);
  assert.equal(parseResultMarker(undefined), null);
  assert.equal(parseResultMarker(["note: RESULT: pass is mentioned here"]), null, "mid-sentence mention must not count");
});

// ---------------------------------------------------------------------------
// markerFor: full label precedence (requirement A).
// ---------------------------------------------------------------------------

test("markerFor: runner-reported failure always wins over any RESULT marker claiming success", () => {
  assert.equal(markerFor("spawn-error", null, { resultMarker: "pass" }), "[SPAWN-ERROR]");
  assert.equal(markerFor("signal", null, { resultMarker: "pass" }), "[SIGNAL]");
  assert.equal(markerFor("bg_tasks_terminated", 0, { resultMarker: "pass", reportComplete: true }), "[BG-TASKS-TERMINATED]");
  assert.equal(markerFor("exit", 1, { resultMarker: "pass" }), "[FAIL]");
});

test("markerFor: [INCOMPLETE] outranks a RESULT marker -- no report means nothing to trust a marker from", () => {
  assert.equal(markerFor("exit", 0, { reportComplete: false, resultMarker: "pass" }), "[INCOMPLETE]");
  assert.equal(markerFor("exit", 0, { reportComplete: false, resultMarker: "blocked" }), "[INCOMPLETE]");
  assert.equal(markerFor("exit", 0, { reportComplete: false, enforce: false, resultMarker: "pass" }), "[OK]", "enforcement off skips straight to the RESULT marker");
});

test("markerFor: RESULT marker maps to its own label when the run exited 0 with a complete report", () => {
  assert.equal(markerFor("exit", 0, { reportComplete: true, resultMarker: "pass" }), "[OK]");
  assert.equal(markerFor("exit", 0, { reportComplete: true, resultMarker: "partial" }), "[PARTIAL]");
  assert.equal(markerFor("exit", 0, { reportComplete: true, resultMarker: "blocked" }), "[BLOCKED]");
  assert.equal(markerFor("exit", 0, { reportComplete: true, resultMarker: "fail" }), "[FAIL]");
});

// 2026-10-31 claunker.cloud-dispatch-test-20261031-j8or6rg2: exited 0 with a complete
// (DELEGATION-METRICS-carrying) report but NO RESULT: marker -- the job's own report said
// BLOCKED, but the old rule read exit 0 + complete as [OK]. [DONE] (not [OK]) makes an
// unverified outcome visually distinct from a confirmed pass.
test("markerFor: exit 0, complete report, no RESULT marker -> [DONE], never [OK]", () => {
  assert.equal(markerFor("exit", 0), "[DONE]", "no 3rd arg at all");
  assert.equal(markerFor("exit", 0, { reportComplete: true }), "[DONE]");
  assert.equal(markerFor("exit", 0, { reportComplete: true, resultMarker: null }), "[DONE]");
  assert.equal(markerFor("exit", 0, { reportComplete: false, enforce: false, resultMarker: null }), "[DONE]", "enforcement off, exit 0, no marker at all");
});

// ---------------------------------------------------------------------------
// isSummaryHeadingLine / buildExcerpt (requirement B).
// ---------------------------------------------------------------------------

test("isSummaryHeadingLine: markdown heading/emphasis/list variants match; mid-sentence mentions of \"summary\" do not", () => {
  for (const line of ["## Summary", "**Summary:**", "**Summary / blocker:**", "- Summary", "Summary", "### SUMMARY"]) {
    assert.ok(isSummaryHeadingLine(line), `expected a summary heading: ${JSON.stringify(line)}`);
  }
  for (const line of ["In summary, this works.", "The summary report follows.", "no heading here", ""]) {
    assert.ok(!isSummaryHeadingLine(line), `expected NOT a summary heading: ${JSON.stringify(line)}`);
  }
});

test("buildExcerpt: null on empty/missing stdout", () => {
  assert.equal(buildExcerpt([]), null);
  assert.equal(buildExcerpt(undefined), null);
});

test("buildExcerpt: prefers the text after the LAST Summary-style heading", () => {
  const lines = [
    "intro paragraph, not the point of the report",
    "## Summary of findings along the way",
    "an earlier, non-final summary section",
    "## Summary",
    "the real final conclusion",
    "DELEGATION-METRICS: calls=0 accepted=0 accepted_after_edits=0 rejected=0 lines_delegated=0 lines_total=0 model=none",
  ];
  assert.equal(buildExcerpt(lines), "the real final conclusion");
});

test("buildExcerpt: excludes the DELEGATION-METRICS line (plain or markdown-wrapped) but keeps everything else", () => {
  assert.equal(
    buildExcerpt(["## Summary", "All good.", "DELEGATION-METRICS: calls=1 accepted=1 accepted_after_edits=0 rejected=0 lines_delegated=5 lines_total=10 model=x"]),
    "All good.",
  );
  assert.equal(
    buildExcerpt(["## Summary", "All good.", "`DELEGATION-METRICS: calls=0 accepted=0 accepted_after_edits=0 rejected=0 lines_delegated=0 lines_total=0 model=none`"]),
    "All good.",
  );
});

test("buildExcerpt: no Summary heading -> falls back to the last EXCERPT_MAX_CHARS, cut at a line boundary", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `report line ${i} with some padding text to add length`);
  const result = buildExcerpt(lines);
  assert.ok(result.length <= EXCERPT_MAX_CHARS);
  assert.ok(result.endsWith("report line 59 with some padding text to add length"), "the very last line must survive the cut");
  assert.ok(!result.startsWith("report line 0 "), "the cut must have dropped the earliest lines");
  assert.equal(result[0], result.trimStart()[0], "the kept text must start exactly on a line boundary, not mid-line");
});

test("buildExcerpt: a Summary heading with nothing meaningful after it falls back to the whole (filtered) tail", () => {
  const lines = ["the actual content", "## Summary", "DELEGATION-METRICS: calls=0 accepted=0 accepted_after_edits=0 rejected=0 lines_delegated=0 lines_total=0 model=none"];
  assert.equal(buildExcerpt(lines), "the actual content\n## Summary");
});

// ---------------------------------------------------------------------------
// Discord-safety post-processing (requirement C): URLs never left adjacent to a markdown
// character, and a cut never leaves a dangling code span/fence open.
// ---------------------------------------------------------------------------

test("stripBackticksAroundUrls: removes backticks that wrap a URL exactly, leaves everything else alone", () => {
  assert.equal(stripBackticksAroundUrls("see `https://example.com/a`, done"), "see https://example.com/a, done");
  assert.equal(stripBackticksAroundUrls("no backticks https://example.com here"), "no backticks https://example.com here");
  assert.equal(stripBackticksAroundUrls("`git remote -v`"), "`git remote -v`", "a non-URL code span is untouched");
});

test("ensureSpaceAfterUrlBeforeBacktick: inserts a space between a URL and an immediately following (escaped or raw) backtick", () => {
  assert.equal(ensureSpaceAfterUrlBeforeBacktick("see https://example.com`next"), "see https://example.com `next");
  assert.equal(ensureSpaceAfterUrlBeforeBacktick("see https://example.com\\`next"), "see https://example.com \\`next");
  assert.equal(ensureSpaceAfterUrlBeforeBacktick("see https://example.com next"), "see https://example.com next");
});

// Real-world regression: job claunker.cloud-dispatch-test-20261031-j8or6rg2's ping rendered
// "https://github.com/icey2488/gallagioloot.git/%60" -- its report wrapped the URL in a code span
// immediately followed by a comma, and escaping the backticks left a literal backtick glued to
// the URL with no separating whitespace, which Discord's autolinker absorbed into the link.
test("buildExcerpt: a URL immediately followed by a backtick is never left adjacent to it after escaping", () => {
  const lines = ["## Summary", "Clone it from `https://github.com/example/repo.git`, then build."];
  const result = buildExcerpt(lines);
  assert.ok(!/https?:\/\/\S*\\?`/.test(result), `URL must not be glued to a backtick, got: ${result}`);
  assert.ok(result.includes("https://github.com/example/repo.git"), "the URL itself must survive intact");
});

test("closeMarkdownSpansAtStart: strips an orphaned closing marker left at the START of a front-cut excerpt", () => {
  assert.equal(closeMarkdownSpansAtStart("bold never opened**"), "bold never opened");
  assert.equal(closeMarkdownSpansAtStart("plain **closed** and fine"), "plain **closed** and fine");
  assert.equal(closeMarkdownSpansAtStart("italic never opened* continues"), "italic never opened continues");
  assert.equal(closeMarkdownSpansAtStart("italic never opened_ continues"), "italic never opened continues");
  assert.equal(closeMarkdownSpansAtStart("a lone closer` with nothing before it"), "a lone closer with nothing before it");
  assert.equal(closeMarkdownSpansAtStart("orphaned fence content\n``` after, fine"), "orphaned fence content\n after, fine");
});

test("buildExcerpt: a cut landing mid inline-code span closes it instead of leaving an orphaned backtick", () => {
  const prefix = "A".repeat(100);
  const code = "`CODE`"; // opens right after the prefix, closes 5 characters later
  const suffix = "X".repeat(EXCERPT_MAX_CHARS - 1);
  const line = prefix + code + suffix;
  // The cut keeps the last EXCERPT_MAX_CHARS characters; by construction that window starts
  // exactly on the closing backtick, dropping the opening one along with the rest of the prefix.
  const result = buildExcerpt([line]);
  assert.equal(result, "X".repeat(EXCERPT_MAX_CHARS - 1));
  assert.ok(!result.includes("`"), "the orphaned backtick left by the cut must be closed, not left dangling");
});

test("buildExcerpt: a cut landing mid fenced code block never leaves an unbalanced ``` marker", () => {
  const prefix = "A".repeat(EXCERPT_MAX_CHARS + 500);
  const fenceOpen = "```js\n";
  const codeBody = "x".repeat(50) + "\n";
  const fenceClose = "```\n";
  const suffix = "tail text after the fence, long enough to pad this out nicely for the window. ".repeat(5);
  const line = prefix + fenceOpen + codeBody + fenceClose + suffix;
  const result = buildExcerpt([line]);
  const fenceCount = (result.match(/```/g) || []).length;
  assert.equal(fenceCount % 2, 0, `fence markers must balance (0 or a complete pair), never an orphan; got: ${result}`);
});

// ---------------------------------------------------------------------------
// Real job regression (requirement D): the exact stdout of
// claunker.cloud-dispatch-test-20261031-j8or6rg2 (read from
// C:\Users\Raide\.claude-async-jobs\claunker.cloud-dispatch-test-20261031-j8or6rg2\out.log on
// 2026-10-31). Stopped because a permission denial blocked the `claude` CLI from launching
// anything, exited 0 anyway, and ended with a complete DELEGATION-METRICS report but no RESULT:
// line -- exactly the case the old rule misread as [OK].
// ---------------------------------------------------------------------------

const REAL_JOB_STDOUT = [
  "I was able to run `git remote -v` successfully — it confirms `origin` points to `https://github.com/icey2488/gallagioloot.git`, matching icey2488/gallagioloot. Good so far.",
  "",
  "However, every attempt to invoke `claude` itself (via PowerShell or Bash) is being denied by the permission system, specifically because this session is running in \"don't ask\" mode, which blocks it. This isn't a transient error — it's a deliberate permission wall, and the tool's own guidance says not to try to route around a denial in disguised ways (different shell, wrapper script, etc.), since that would defeat the intent of the restriction.",
  "",
  "I'm stopping here rather than trying workarounds, since:",
  "- The task explicitly requires launching another `claude` process (`claude --cloud`), and this environment's permission mode is blocking any invocation of the `claude` binary.",
  "- Attempting to bypass that (e.g., via a wrapper script, `cmd /c`, Python `subprocess`, or editing permission settings) would be circumventing a safety boundary rather than reasonably working within it.",
  "",
  "**Summary / blocker:**",
  "- Git remote check: ✅ pass — `origin` = `https://github.com/icey2488/gallagioloot.git`",
  "- `claude --version`, `claude --help`, `claude --cloud --help`, auth status: ❌ blocked — permission denied in don't-ask mode for any `claude` invocation",
  "- No cloud session was launched. No repo files, branches, or remotes were touched.",
  "- Options for you: either grant explicit permission to run the `claude` CLI command in this session (e.g., approve a one-off Bash/PowerShell permission for `claude ...`), or run the launch step yourself from a terminal where that restriction doesn't apply.",
  "",
  "**Delegation report:** Zero Ollama calls — this launcher job is pure CLI/process orchestration (no formatting, boilerplate, or conversion work eligible for local-model delegation), and it stopped before reaching any work that would have been.",
  "",
  "`DELEGATION-METRICS: calls=0 accepted=0 accepted_after_edits=0 rejected=0 lines_delegated=0 lines_total=0 model=none`",
];

test("regression: claunker.cloud-dispatch-test-20261031-j8or6rg2 never reads as [OK] and its excerpt surfaces the blocker", () => {
  const resultMarker = parseResultMarker(REAL_JOB_STDOUT);
  assert.equal(resultMarker, null, "this job predates the RESULT: convention");
  const reportComplete = hasCompletenessMarker(REAL_JOB_STDOUT);
  assert.equal(reportComplete, true, "the DELEGATION-METRICS line IS present");
  const marker = markerFor("exit", 0, { reportComplete, resultMarker });
  assert.notEqual(marker, "[OK]", "an unverified exit-0 report must never read as confirmed success");
  assert.equal(marker, "[DONE]");

  const excerpt = buildExcerpt(REAL_JOB_STDOUT);
  assert.ok(!excerpt.includes("DELEGATION-METRICS"), "the contract line itself must not appear in the excerpt");
  assert.match(excerpt, /permission denied|blocked|don.t.ask mode/i, "the excerpt must surface the blocker, not the opening paragraph");
  assert.ok(!/https?:\/\/\S*`/.test(excerpt), "the real URL/backtick bug must not reproduce");
});

// ---------------------------------------------------------------------------
// buildDiscordContent / loadNotifyConfig / loadCompletenessConfig.
// ---------------------------------------------------------------------------

test("buildDiscordContent: shape, and a 1800-char hard cap", () => {
  const content = buildDiscordContent({
    marker: "[OK]", host: "claunker", jobId: "job-1", exitCode: 0, durationMs: 5000, excerpt: "did the thing",
  });
  assert.match(content, /^\[OK\] host=claunker job=job-1 exit=0 duration=5s\ndid the thing$/);

  const huge = buildDiscordContent({
    marker: "[OK]", host: "h", jobId: "j", exitCode: 0, durationMs: 0, excerpt: "x".repeat(5000),
  });
  assert.equal(huge.length, 1800);
});

test("buildDiscordContent: incompleteReason is appended as its own line after the excerpt", () => {
  const content = buildDiscordContent({
    marker: "[INCOMPLETE]", host: "claunker", jobId: "job-1", exitCode: 0, durationMs: 1000,
    excerpt: "did the thing", incompleteReason: INCOMPLETE_REASON,
  });
  const lines = content.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "did the thing");
  assert.equal(lines[2], INCOMPLETE_REASON);
});

test("buildDiscordContent: an absent/falsy incompleteReason adds no extra line", () => {
  const withExcerpt = buildDiscordContent({
    marker: "[OK]", host: "h", jobId: "j", exitCode: 0, durationMs: 0, excerpt: "hi", incompleteReason: undefined,
  });
  assert.equal(withExcerpt.split("\n").length, 2);
  const noExcerpt = buildDiscordContent({
    marker: "[OK]", host: "h", jobId: "j", exitCode: 0, durationMs: 0, excerpt: null, incompleteReason: "",
  });
  assert.equal(noExcerpt.split("\n").length, 1);
});

test("loadNotifyConfig: absent file, unparseable JSON, and missing/blank webhookUrl all mean off", () => {
  const p = hosts.notifyConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { fs.unlinkSync(p); } catch {}
  assert.equal(loadNotifyConfig(), null, "absent file");
  fs.writeFileSync(p, "{not json");
  assert.equal(loadNotifyConfig(), null, "unparseable JSON");
  fs.writeFileSync(p, JSON.stringify({ discord: {} }));
  assert.equal(loadNotifyConfig(), null, "missing webhookUrl");
  fs.writeFileSync(p, JSON.stringify({ discord: { webhookUrl: "   " } }));
  assert.equal(loadNotifyConfig(), null, "blank webhookUrl");
  fs.writeFileSync(p, JSON.stringify({ discord: { webhookUrl: "http://x/y" } }));
  assert.deepEqual(loadNotifyConfig(), { webhookUrl: "http://x/y", includeHeadline: true }, "default includeHeadline true");
  fs.writeFileSync(p, JSON.stringify({ discord: { webhookUrl: "http://x/y", includeHeadline: false } }));
  assert.deepEqual(loadNotifyConfig(), { webhookUrl: "http://x/y", includeHeadline: false });
  fs.unlinkSync(p);
});

test("hasCompletenessMarker: a line starting with the marker counts, mid-line does not", () => {
  assert.equal(hasCompletenessMarker(["DELEGATION-METRICS: calls=1 accepted=1"]), true);
  assert.equal(hasCompletenessMarker(["note: DELEGATION-METRICS: calls=1"]), false, "marker not at line start must not count");
  assert.equal(hasCompletenessMarker([]), false);
  assert.equal(hasCompletenessMarker(["some text", "other text"]), false);
  assert.equal(hasCompletenessMarker(undefined), false, "non-array input yields false, never throws");
});

test("hasCompletenessMarker: a custom markerRegex is used instead of the default", () => {
  assert.equal(hasCompletenessMarker(["CUSTOM-MARKER: hi"], /^CUSTOM-MARKER:/), true);
  assert.equal(hasCompletenessMarker(["CUSTOM-MARKER: hi"], /^DELEGATION-METRICS:/), false);
  assert.equal(hasCompletenessMarker(["DELEGATION-METRICS: hi"], /^CUSTOM-MARKER:/), false);
});

test("hasCompletenessMarker: tolerates common markdown wrapping around the marker line", () => {
  assert.equal(hasCompletenessMarker(["`DELEGATION-METRICS: calls=0 accepted=0`"]), true, "inline backtick");
  assert.equal(hasCompletenessMarker(["```", "DELEGATION-METRICS: calls=0 accepted=0", "```"]), true, "fenced block");
  assert.equal(hasCompletenessMarker(["**DELEGATION-METRICS: calls=0 accepted=0**"]), true, "bold");
  assert.equal(hasCompletenessMarker(["> DELEGATION-METRICS: calls=0 accepted=0"]), true, "blockquote");
  assert.equal(hasCompletenessMarker(["    DELEGATION-METRICS: calls=0 accepted=0"]), true, "indented");
  assert.equal(hasCompletenessMarker(["DELEGATION-METRICS: calls=0 accepted=0"]), true, "plain line still works");
  assert.equal(hasCompletenessMarker(["note: DELEGATION-METRICS: calls=1 is mentioned here"]), false, "mid-sentence mention must not match");
});

test("loadCompletenessConfig: absent file, no completeness key, and unparseable JSON all default to enforce=true with the DELEGATION-METRICS marker", () => {
  const p = hosts.notifyConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { fs.unlinkSync(p); } catch {}
  let r = loadCompletenessConfig();
  assert.equal(r.enforce, true);
  assert.equal(r.markerRegex.source, DEFAULT_COMPLETENESS_MARKER_SOURCE);

  fs.writeFileSync(p, JSON.stringify({ discord: { webhookUrl: "http://x" } }));
  r = loadCompletenessConfig();
  assert.equal(r.enforce, true);
  assert.equal(r.markerRegex.source, DEFAULT_COMPLETENESS_MARKER_SOURCE);

  fs.writeFileSync(p, "not valid json");
  r = loadCompletenessConfig();
  assert.equal(r.enforce, true);
  assert.equal(r.markerRegex.source, DEFAULT_COMPLETENESS_MARKER_SOURCE);
  fs.unlinkSync(p);
});

test("loadCompletenessConfig: completeness.enforce false turns enforcement off", () => {
  const p = hosts.notifyConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ completeness: { enforce: false } }));
  assert.equal(loadCompletenessConfig().enforce, false);
  fs.unlinkSync(p);
});

test("loadCompletenessConfig: a custom markerRegex string is compiled and used", () => {
  const p = hosts.notifyConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ completeness: { markerRegex: "^CUSTOM:" } }));
  const r = loadCompletenessConfig();
  assert.equal(r.markerRegex.test("CUSTOM: hi"), true);
  assert.equal(r.markerRegex.test("DELEGATION-METRICS: hi"), false);
  fs.unlinkSync(p);
});

test("loadCompletenessConfig: an invalid markerRegex string falls back to the default, never throws", () => {
  const p = hosts.notifyConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ completeness: { markerRegex: "[unclosed" } }));
  const r = loadCompletenessConfig();
  assert.equal(r.markerRegex.source, DEFAULT_COMPLETENESS_MARKER_SOURCE);
  fs.unlinkSync(p);
});

// ---------------------------------------------------------------------------
// Integration tests: the real job-runner.mjs, a real (loopback) HTTP server, no fakes.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "..", "job-runner.mjs");
const FAKE = path.join(here, "notify-fake-cli.mjs");
let seq = 0;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// A real final report's last line (see CLAUDE.md's delegation contract). Appended to a fixture's
// stdoutText wherever a test's point is unrelated to the completeness rule, so the exit-0 job
// still reads as "complete" under the new default enforcement -- see the dedicated
// "[INCOMPLETE]" tests further down for the marker-missing path itself.
const METRICS_LINE = "DELEGATION-METRICS: calls=0 accepted=0 accepted_after_edits=0 rejected=0 lines_delegated=0 lines_total=0 model=none";

function writeNotify(cfg) {
  const p = hosts.notifyConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
}
function clearNotify() {
  try { fs.unlinkSync(hosts.notifyConfigPath()); } catch {}
}

// Prepares a job dir + spec.json + meta.json (startedAt ~1.2s in the past, so duration is
// non-trivial) WITHOUT running the runner yet, so a test can wire up a server whose handler reads
// this same dir's exit_code/exit.json paths before the runner ever touches them.
function prepareJob({ stdoutText = "", exitCode = 0 } = {}) {
  const dir = path.join(TMP, `notify-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    command: process.execPath, argv: [FAKE, "--stdout-b64", b64(stdoutText), "--exit", String(exitCode)],
    cwd: dir, out: path.join(dir, "out.log"), err: path.join(dir, "err.log"), exit: path.join(dir, "exit_code"),
  };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    jobId: `notify-job-${seq}`, pid: 1, status: "running",
    startedAt: new Date(Date.now() - 1234).toISOString(),
  }));
  return dir;
}

// Runs the real runner as an ASYNC child (never spawnSync): spawnSync blocks this process's own
// event loop for its whole duration, which would starve the in-process loopback HTTP server these
// tests depend on -- the runner's fetch() would connect but the server could never actually
// process the request until spawnSync returned, by which point the runner had already given up.
function spawnRunner(dir, timeoutMs = 20_000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, path.join(dir, "spec.json")], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const killTimer = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      resolve({ res: { status: code, stderr }, elapsedMs: Date.now() - t0 });
    });
  });
}

// requests[] accumulates { body (parsed JSON), headers, existedAtReceipt } for every POST this
// server gets. respond(res) picks the status code/body; default 200 "ok".
function startServer(dir, respond = (res) => { res.writeHead(200); res.end("ok"); }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const existedAtReceipt = dir
        ? fs.existsSync(path.join(dir, "exit_code")) && fs.existsSync(path.join(dir, "exit.json"))
        : null;
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      requests.push({ body, headers: req.headers, existedAtReceipt });
      respond(res);
    });
  });
  return { server, requests };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/webhook`;
}

test("config absent: no request is made, job still completes normally", async () => {
  clearNotify();
  const dir = prepareJob({ exitCode: 0 });
  const { server, requests } = startServer(dir);
  await listen(server); // never referenced by notify.json -- proves absence, not just an unused server
  const { res } = await spawnRunner(dir);
  server.close();
  assert.equal(res.status, 0);
  assert.equal(requests.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), "0");
});

test("unparseable notify.json: no request, no throw, job still completes", async () => {
  const dir = prepareJob({ exitCode: 0 });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify("{ this is not json");
  const { res } = await spawnRunner(dir);
  server.close();
  assert.equal(res.status, 0, `runner must exit 0 even with garbage config; stderr: ${res.stderr}`);
  assert.equal(requests.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), "0");
  void url; // never used by notify.json in this test; kept only to hold the listener open until close()
});

test("success: correct payload shape, allowed_mentions parse [], JSON content-type, [DONE] with no RESULT marker", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `plain first line\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  const { res } = await spawnRunner(dir);
  server.close();
  assert.equal(res.status, 0);
  assert.equal(requests.length, 1);
  const { body, headers } = requests[0];
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.match(body.content, /^\[DONE\] host=\S+ job=notify-job-\d+ exit=0 duration=\d/);
});

test("success: a RESULT: pass marker in the final report pings [OK]", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `## Summary\nEverything checks out.\nRESULT: pass\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  const lines = requests[0].body.content.split("\n");
  assert.match(lines[0], /^\[OK\] /);
  assert.equal(lines[1], "Everything checks out.");
});

test("a RESULT: blocked marker in the final report pings [BLOCKED] with the blocker in the excerpt", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `## Summary\nRan into a wall and stopped.\nRESULT: blocked\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  const lines = requests[0].body.content.split("\n");
  assert.match(lines[0], /^\[BLOCKED\] /);
  assert.equal(lines[1], "Ran into a wall and stopped.");
});

test("excerpt source: the end of the report (final Summary section) wins over a misleading opening paragraph", async () => {
  const stdoutText = [
    "Good so far, everything is on track.",
    "## Summary",
    "Actually it failed at the very last step.",
    METRICS_LINE,
  ].join("\n") + "\n";
  const dir = prepareJob({ exitCode: 0, stdoutText });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  const lines = requests[0].body.content.split("\n");
  assert.equal(lines[1], "Actually it failed at the very last step.");
});

test("includeHeadline=false: excerpt line is omitted even when stdout has a Summary section", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `## Summary\na perfectly good excerpt line\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.content.split("\n").length, 1);
});

// Fix: `intent` (claude_start's optional one-line summary) is now persisted to meta.json by
// job-core.mjs's startJob() (see postlaunch.test.mjs), so job-runner.mjs's finish() -- which only
// ever reads meta.json -- can pass it through as the notification's title.
test("title: meta.json's intent is used as the title, escaped the same way excerpt text is", async () => {
  const dir = prepareJob({ exitCode: 0 });
  const metaPath = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.intent = "Ship it @everyone `now`";
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests.length, 1);
  const statusLine = requests[0].body.content.split("\n")[0];
  assert.match(statusLine, /job=Ship it \\@everyone \\`now\\`/);
  assert.ok(!statusLine.includes(meta.jobId), "the raw jobId must not appear once intent supplies the title");
});

test("title: falls back to jobId when meta.json has no intent", async () => {
  const dir = prepareJob({ exitCode: 0 });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.match(requests[0].body.content, new RegExp(`job=${meta.jobId} `));
});

for (const status of [429, 500]) {
  test(`server returns HTTP ${status}: runner still completes with the correct exit_code/exit.json, one log line, no URL leak`, async () => {
    const exitCode = 3;
    const dir = prepareJob({ exitCode });
    const { server, requests } = startServer(dir, (res) => { res.writeHead(status); res.end("nope"); });
    const url = await listen(server);
    writeNotify({ discord: { webhookUrl: url } });
    const { res } = await spawnRunner(dir);
    server.close();
    assert.equal(res.status, 0);
    assert.equal(requests.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), String(exitCode));
    const exitRecord = JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
    assert.equal(exitRecord.exitCode, exitCode);
    const errLog = fs.readFileSync(path.join(dir, "err.log"), "utf8");
    assert.match(errLog, new RegExp(`discord notify: webhook returned HTTP ${status}`));
    assert.ok(!errLog.includes(url), "webhook URL must never appear in err.log");
    for (const f of fs.readdirSync(dir)) {
      const contents = fs.readFileSync(path.join(dir, f), "utf8");
      assert.ok(!contents.includes(url), `webhook URL must not appear in ${f}`);
    }
  });
}

test("server that never responds: runner still finishes within the 5s bound plus slack", async () => {
  const exitCode = 0;
  const dir = prepareJob({ exitCode });
  const server = http.createServer((req) => {
    req.on("data", () => {}); // drain, but never call res.end() -- the request just hangs
  });
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url } });
  const { res, elapsedMs } = await spawnRunner(dir);
  server.close();
  assert.equal(res.status, 0, `runner must still exit cleanly; stderr: ${res.stderr}`);
  assert.ok(elapsedMs < NOTIFY_TIMEOUT_MS + 3000,
    `expected finish within ${NOTIFY_TIMEOUT_MS}ms + slack, took ${elapsedMs}ms`);
  assert.equal(fs.readFileSync(path.join(dir, "exit_code"), "utf8"), String(exitCode));
  const errLog = fs.readFileSync(path.join(dir, "err.log"), "utf8");
  assert.match(errLog, /discord notify: request failed \(timed out\)/);
});

test("ordering: exit_code and exit.json exist before the server receives the POST", async () => {
  const dir = prepareJob({ exitCode: 0 });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].existedAtReceipt, true);
});

test("webhook URL never appears anywhere in the job dir, including after a network failure", async () => {
  // Nothing is listening on this port -> ECONNREFUSED, exercising the exception (not HTTP-status)
  // branch of the failure path.
  const dead = "http://127.0.0.1:1/webhook-should-never-be-reached";
  const dir = prepareJob({ exitCode: 0 });
  writeNotify({ discord: { webhookUrl: dead } });
  const { res } = await spawnRunner(dir);
  assert.equal(res.status, 0);
  for (const f of fs.readdirSync(dir)) {
    const contents = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!contents.includes(dead), `webhook URL leaked into ${f}`);
    assert.ok(!contents.includes("webhook-should-never-be-reached"), `webhook URL fragment leaked into ${f}`);
  }
});

// ---------------------------------------------------------------------------
// [INCOMPLETE] / [DONE] / [FAIL] end-to-end: the real job-runner.mjs writing exit.json's
// reportComplete field and (when a webhook is configured) labeling the ping, via the real
// completeness config read from notify.json's "completeness" key.
// ---------------------------------------------------------------------------

function readExitJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
}

test("exit 0 with the DELEGATION-METRICS marker but no RESULT marker: reportComplete=true, ping is [DONE]", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `Everything checks out.\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(readExitJson(dir).reportComplete, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.content, /^\[DONE\] /);
});

test("exit 0 without the marker (default config, enforced): reportComplete=false in exit.json, ping is [INCOMPLETE] with a reason line", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: "Everything checks out, allegedly.\n" });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  assert.equal(readExitJson(dir).reportComplete, false);
  assert.equal(requests.length, 1);
  const lines = requests[0].body.content.split("\n");
  assert.match(lines[0], /^\[INCOMPLETE\] /);
  assert.equal(lines[1], "Everything checks out, allegedly.", "excerpt is kept");
  assert.equal(lines[2], INCOMPLETE_REASON);
});

test("non-zero exit without the marker: failure label is unchanged ([FAIL], not [INCOMPLETE]), reportComplete still recorded false", async () => {
  const dir = prepareJob({ exitCode: 1, stdoutText: "GATE FAILED\n" });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(readExitJson(dir).reportComplete, false);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.content, /^\[FAIL\] /);
});

test("completeness.enforce=false in notify.json: exit 0 without the marker pings [DONE] (not [INCOMPLETE]); reportComplete is still recorded false", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: "No metrics line here.\n" });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false }, completeness: { enforce: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(readExitJson(dir).reportComplete, false, "the field reports the objective fact regardless of enforcement");
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.content, /^\[DONE\] /);
});

test("reportComplete is computed and written to exit.json even with no notify.json at all (no webhook configured)", async () => {
  clearNotify();
  const dir = prepareJob({ exitCode: 0, stdoutText: `Everything checks out.\n${METRICS_LINE}\n` });
  const { res } = await spawnRunner(dir);
  assert.equal(res.status, 0);
  assert.equal(readExitJson(dir).reportComplete, true);

  const dir2 = prepareJob({ exitCode: 0, stdoutText: "no marker here\n" });
  await spawnRunner(dir2);
  assert.equal(readExitJson(dir2).reportComplete, false);
});

test("marker present but not at its own line start: does not count as complete", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `note: ${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(readExitJson(dir).reportComplete, false);
  assert.match(requests[0].body.content, /^\[INCOMPLETE\] /);
});

// ---------------------------------------------------------------------------
// 2026-10-18 test-isolation incident regression: fixture jobs minted by the test suites posted
// real pings to Erick's #notifications channel because job-runner.mjs children inherit the
// bridge's real CLAUDE_ASYNC_CONFIG_DIR/notify.json whenever a test forgets to isolate it.
// Config-dir isolation (this suite's _setup.mjs) is the primary fix; these tests prove the
// secondary guard in notifyJobFinished itself -- a real Discord webhook host, reached through the
// DEFAULT network-capable fetch, is never sent while in test mode, by instrumenting the real send
// path directly (monkey-patching globalThis.fetch as a zero-call spy) rather than trusting config
// isolation alone.
// ---------------------------------------------------------------------------

test("real-send guard: a Discord-host webhook never reaches the real fetch in test mode; a fake sender still works", async () => {
  assert.equal(isTestMode(), true, "this suite runs under CLAUDE_ASYNC_TEST=1 (see _setup.mjs)");
  // Simulates exactly the incident shape: a test process that inherited a real-looking webhook
  // (e.g. from the live ~/.claude-async/notify.json) rather than one isolated to a local server.
  writeNotify({ discord: { webhookUrl: "https://discord.com/api/webhooks/123456789/fake-token-should-never-be-posted-to" } });

  let realFetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { realFetchCalls++; return realFetch(...args); };
  const blockedBefore = getRealSendBlockedCount();
  const logLines = [];
  try {
    await notifyJobFinished({
      jobId: "test-mode-job", intent: null, host: "test-host", exitCode: 0, exitReason: "exit",
      startedAt: new Date(Date.now() - 1000), endedAt: new Date(), stdoutLines: [],
      reportComplete: true, logLine: (m) => logLines.push(m),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(realFetchCalls, 0, "the real, network-capable fetch must never be invoked");
  assert.equal(getRealSendBlockedCount(), blockedBefore + 1, "the guard's counter must record exactly one blocked send");
  assert.ok(logLines.some((l) => l.includes("blocked real Discord send")),
    `expected a blocked-send log line, got: ${JSON.stringify(logLines)}`);

  // The SAME real-looking Discord URL, but with an injected fake sender -- exactly what a test
  // asserting notification content does. The guard must not interfere with that instrumentation.
  const fakeSends = [];
  await notifyJobFinished({
    jobId: "test-mode-job-2", intent: null, host: "test-host", exitCode: 0, exitReason: "exit",
    startedAt: new Date(Date.now() - 1000), endedAt: new Date(), stdoutLines: ["## Summary", "Everything checks out.", "RESULT: pass"],
    reportComplete: true, logLine: () => {},
    fetchImpl: async (url, opts) => { fakeSends.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
  });
  assert.equal(fakeSends.length, 1, "the fake sender must still receive the call");
  assert.match(fakeSends[0].body.content, /^\[OK\] /);
  assert.equal(realFetchCalls, 0, "injecting a fake sender must not somehow also trigger a real send");
});

test("real-send guard: a non-Discord host (a test's own local server) is unaffected by test mode", async () => {
  assert.equal(isTestMode(), true);
  const dir = prepareJob({ exitCode: 0, stdoutText: `Everything checks out.\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  const blockedBefore = getRealSendBlockedCount();
  await spawnRunner(dir);
  server.close();
  assert.equal(requests.length, 1, "a local test server must still receive the real-runner's default-fetch POST");
  assert.equal(getRealSendBlockedCount(), blockedBefore, "a non-Discord host must never increment the blocked-send counter");
});
