// discord-notify.mjs: best-effort Discord webhook ping fired from job-runner.mjs's finish(),
// strictly AFTER exit.json and exit_code are written. Two layers of coverage:
//   - unit tests directly against discord-notify.mjs's pure helpers (headline rule, truncation,
//     escaping, content shape) -- no process spawn, no network;
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
  NOTIFY_TIMEOUT_MS, loadNotifyConfig, extractHeadline, escapeDiscordText, boundHeadline,
  formatDuration, markerFor, buildDiscordContent, readHead, chooseHeadlineLines,
  isLabelLine, containsPath, truncateHeadline, closeMarkdownSpans, HEADLINE_MAX_CHARS,
  loadCompletenessConfig, hasCompletenessMarker, DEFAULT_COMPLETENESS_MARKER_SOURCE,
  INCOMPLETE_REASON, notifyJobFinished, isTestMode, getRealSendBlockedCount,
} from "../../discord-notify.mjs";

after(cleanupTmp);

// ---------------------------------------------------------------------------
// Unit tests: pure helpers, no I/O.
// ---------------------------------------------------------------------------

test("extractHeadline: skips markdown headings, code fences, and blank lines", () => {
  assert.equal(extractHeadline(["# heading", "```", "", "  ", "real headline", "next line"]), "real headline");
  assert.equal(extractHeadline([]), null);
  assert.equal(extractHeadline(["# only a heading", "```js"]), null);
  assert.equal(extractHeadline(undefined), null);
});

test("escapeDiscordText: backslash-escapes @, `, <, > and nothing else", () => {
  assert.equal(escapeDiscordText("hi @everyone `code` <tag> plain"), "hi \\@everyone \\`code\\` \\<tag\\> plain");
  assert.equal(escapeDiscordText("no special chars here"), "no special chars here");
});

test("boundHeadline: truncates to HEADLINE_MAX_CHARS BEFORE escaping, then escapes", () => {
  const long = "@".repeat(HEADLINE_MAX_CHARS + 50); // an escape-heavy line with no word/sentence boundary at all
  const result = boundHeadline([long]);
  // no whitespace anywhere -> truncateHeadline falls back to the raw slice, THEN escape doubles it, plus the ellipsis
  assert.equal(result, "\\@".repeat(HEADLINE_MAX_CHARS) + "…");
  assert.equal(result.length, HEADLINE_MAX_CHARS * 2 + 1);
});

test("boundHeadline: returns null when no usable line exists", () => {
  assert.equal(boundHeadline(["# heading only"]), null);
});

test("boundHeadline: empty stdout yields no headline", () => {
  assert.equal(boundHeadline([]), null);
  assert.equal(boundHeadline([""]), null);
});

test("boundHeadline: a short headline needing no truncation passes through unchanged (plus escaping)", () => {
  assert.equal(boundHeadline(["Everything checks out."]), "Everything checks out.");
});

test("extractHeadline: a Verdict line wins over an earlier qualifying preamble line", () => {
  const stdout = "A quick note before the result.\n**Verdict: PASS, all clear.**\nmore detail".split("\n");
  assert.equal(extractHeadline(stdout), "**Verdict: PASS, all clear.**");
});

test("truncateHeadline: cuts at the last sentence boundary within budget, never mid-word", () => {
  const line = "First sentence here. Second sentence that runs long enough to push the whole thing well past the limit we are testing against today for sure. " + "padding ".repeat(40);
  const result = truncateHeadline(line, 150);
  assert.ok(result.endsWith("…"));
  assert.equal(result, "First sentence here. Second sentence that runs long enough to push the whole thing well past the limit we are testing against today for sure.…");
});

test("truncateHeadline: a long single sentence with no period falls back to the last word boundary", () => {
  const line = "this is one long sentence with absolutely no period anywhere in it at all " + "word ".repeat(40);
  const result = truncateHeadline(line, 80);
  assert.ok(result.endsWith("…"));
  const withoutEllipsis = result.slice(0, -1);
  assert.ok(line.startsWith(withoutEllipsis));
  assert.ok(!withoutEllipsis.endsWith(" "), "trailing whitespace before the ellipsis is trimmed");
  assert.equal(line[withoutEllipsis.length], " ", "the cut must land exactly on a word boundary, not mid-word");
});

test("truncateHeadline: a line already within budget is returned unchanged", () => {
  assert.equal(truncateHeadline("short line", 80), "short line");
});

test("closeMarkdownSpans: strips a dangling unmatched **, *, _, and ` left open by truncation", () => {
  assert.equal(closeMarkdownSpans("**bold never closed"), "bold never closed");
  assert.equal(closeMarkdownSpans("plain **closed** and fine"), "plain **closed** and fine");
  assert.equal(closeMarkdownSpans("some *italic never closed"), "some italic never closed");
  assert.equal(closeMarkdownSpans("some _italic never closed"), "some italic never closed");
  assert.equal(closeMarkdownSpans("a (`drift-check`, then an unclosed `span"), "a (`drift-check`, then an unclosed span");
});

test("closeMarkdownSpans: strips an unterminated code fence's lone marker instead of letting it swallow the rest", () => {
  assert.equal(closeMarkdownSpans("before ```js console.log(1)"), "before js console.log(1)");
  assert.equal(closeMarkdownSpans("before ```js\ncode\n``` after, fine"), "before ```js\ncode\n``` after, fine");
});

test("closeMarkdownSpans: strips a dangling [link]( with no closing paren, and a bare unmatched [", () => {
  assert.equal(closeMarkdownSpans("see [the report](https://example.com/very/long/pa"), "see ");
  assert.equal(closeMarkdownSpans("see [the report for more"), "see ");
  assert.equal(closeMarkdownSpans("see [closed](https://example.com) fine"), "see [closed](https://example.com) fine");
});

test("boundHeadline: real example 1 (Verdict cut mid-word, unclosed **) is now sentence-bounded and markdown-safe", () => {
  const ex1 = "**Verdict: Cause class A/B hybrid — host-api was not running (no process, port free) because its logon-triggered start lost a boot-ordering race against Tailscale. Tailscale is up and the IP is unchanged, so the fix belongs in host-api's own startup ordering, not networking, and no further investigation of the network path is warranted at this time, pending a follow-up ticket for a startup dependency check.**";
  const result = boundHeadline([ex1]);
  assert.ok(result.length <= HEADLINE_MAX_CHARS + 1, "ellipsis adds at most one char over budget");
  assert.equal((result.match(/\*\*/g) || []).length % 2, 0, "** markers must balance");
  assert.ok(!result.includes("\\*"), "escaping never touches *, so any stray * would mean unbalanced markup");
});

test("boundHeadline: real example 2 (cut inside an inline-code span) is now sentence-bounded with backticks balanced", () => {
  const ex2 = "Push is blocked — not by anything in my change, but by a repo-wide pre-push liveness gate (`drift-check`, wired via `core.hooksPath=githooks`). It fails closed if any of three sibling repos (`claunker-ops`, `claunker-web`, `claunker-infra`) look unreachable, even though none of them are touched by this branch at all, which needs fixing upstream before anyone can land anything here again without bypassing the gate every time.";
  const result = boundHeadline([ex2]);
  assert.ok(result.length <= HEADLINE_MAX_CHARS + 1, "ellipsis adds at most one char over budget");
  const rawBackticks = (result.match(/\\`/g) || []).length; // escaping turns every surviving ` into \`
  assert.equal(rawBackticks % 2, 0, "backtick spans must balance");
});

// Regression: a report opening "## Report" / "**1. Git -- `C:\...`**" used to put the bold,
// path-bearing section label on the phone as the headline.
test("extractHeadline: skips a bold numbered section label carrying a Windows path (real regression)", () => {
  const stdout = "## Report\n\n**1. Git — `C:\\Users\\Raide\\OneDrive\\Desktop\\CC bridge\\claude-async`**\n- Branch: `main`";
  const headline = extractHeadline(stdout.split("\n"));
  assert.equal(headline, "- Branch: `main`");
  assert.ok(!containsPath(headline), "headline must not carry a path");
  assert.equal(boundHeadline(stdout.split("\n")), "- Branch: \\`main\\`");
});

test("extractHeadline: a plain verdict line before a heading wins", () => {
  assert.equal(extractHeadline("Verdict: all good.\n## Details".split("\n")), "Verdict: all good.");
});

test("extractHeadline: skips marker-only and short emphasis-label lines", () => {
  for (const label of ["1.", "- **Report**", "**Report**", "**Summary:**", "1. **Findings**", "---", "* * *"]) {
    assert.equal(extractHeadline([label, "real headline"]), "real headline", `should skip ${JSON.stringify(label)}`);
    assert.ok(isLabelLine(label), `isLabelLine(${JSON.stringify(label)})`);
  }
});

test("extractHeadline: emphasis around content (sentence or key: value) is still a headline", () => {
  assert.equal(extractHeadline(["**All checks passed.**", "x"]), "**All checks passed.**");
  assert.equal(extractHeadline(["**Verdict: PASS**", "x"]), "**Verdict: PASS**");
  assert.equal(extractHeadline(["- Branch pushed to origin", "x"]), "- Branch pushed to origin");
});

test("containsPath: Windows drive, UNC, and absolute POSIX paths; not URLs or ordinary slashes", () => {
  for (const p of ["see C:\\Users\\x", "wrote D:/code/repo", "at \\\\server\\share", "cwd /home/raide/x",
                   "in `/c/Users/Raide`", "bin /usr/local/bin", "(/tmp/job/out.log)"]) {
    assert.ok(containsPath(p), `should detect a path in ${JSON.stringify(p)}`);
  }
  for (const s of ["https://example.com/a/b", "and/or", "3/4 tests passed", "ratio 1:2", "Verdict: all good.",
                   "~ is home", "http://x/y/z"]) {
    assert.ok(!containsPath(s), `should not flag ${JSON.stringify(s)}`);
  }
});

test("extractHeadline: path-bearing lines are skipped in the tail too; none qualifying means no headline", () => {
  const tail = ["Wrote C:\\Users\\Raide\\out.txt", "done in /home/raide/work/", "**Report**"];
  assert.equal(extractHeadline(tail), null);
  assert.equal(boundHeadline(chooseHeadlineLines(["## Report"], tail)), null);
  assert.equal(boundHeadline(chooseHeadlineLines(["## Report"], [...tail, "Tail verdict ok"])), "Tail verdict ok");
});

test("formatDuration: seconds, minutes, hours, and the unknown fallback", () => {
  assert.equal(formatDuration(4_500), "5s");
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(3_661_000), "1h01m01s");
  assert.equal(formatDuration(NaN), "unknown");
  assert.equal(formatDuration(-1), "unknown");
});

test("markerFor: emoji-free status markers", () => {
  assert.equal(markerFor("exit", 0), "[OK]");
  assert.equal(markerFor("exit", 1), "[FAIL]");
  assert.equal(markerFor("signal", null), "[SIGNAL]");
  assert.equal(markerFor("spawn-error", null), "[SPAWN-ERROR]");
});

// claunker.gemini-mcp-v2-20261018-pfvzx44f: an exit-0 run killed by the CLI's own background-task
// wait ceiling must never ping [OK] -- regardless of exitCode or reportComplete, it always gets
// its own marker so the ping unambiguously says the run failed.
test("markerFor: bg_tasks_terminated always reads as failed, exitCode 0 and reportComplete notwithstanding", () => {
  assert.equal(markerFor("bg_tasks_terminated", 0), "[BG-TASKS-TERMINATED]");
  assert.equal(markerFor("bg_tasks_terminated", 0, { reportComplete: true }), "[BG-TASKS-TERMINATED]");
  assert.equal(markerFor("bg_tasks_terminated", 1), "[BG-TASKS-TERMINATED]");
});

test("buildDiscordContent: shape, and a 1800-char hard cap", () => {
  const content = buildDiscordContent({
    marker: "[OK]", host: "claunker", jobId: "job-1", exitCode: 0, durationMs: 5000, headline: "did the thing",
  });
  assert.match(content, /^\[OK\] host=claunker job=job-1 exit=0 duration=5s\ndid the thing$/);

  const huge = buildDiscordContent({
    marker: "[OK]", host: "h", jobId: "j", exitCode: 0, durationMs: 0, headline: "x".repeat(5000),
  });
  assert.equal(huge.length, 1800);
});

test("readHead: file at or under maxBytes is read whole, no line dropped", () => {
  const p = path.join(TMP, `readhead-small-${Date.now()}.txt`);
  fs.writeFileSync(p, "line one\nline two\nline three\n");
  assert.deepEqual(readHead(p, 8192), ["line one", "line two", "line three"]);
});

test("readHead: a file bigger than maxBytes drops the last (likely partial) line of the read window", () => {
  const p = path.join(TMP, `readhead-big-${Date.now()}.txt`);
  // Each line is exactly 10 bytes ("0123456789\n" is 11) so a maxBytes of 55 lands mid-line-6.
  const lines = Array.from({ length: 10 }, (_, i) => String(i).repeat(9));
  fs.writeFileSync(p, lines.join("\n") + "\n");
  const head = readHead(p, 55); // covers lines 0-4 whole plus a partial line 5
  assert.deepEqual(head, lines.slice(0, 5), "the partial 6th line must be dropped, not truncated");
});

test("readHead: missing file yields []", () => {
  assert.deepEqual(readHead(path.join(TMP, "does-not-exist-at-all.txt")), []);
});

test("chooseHeadlineLines: head wins when it has a qualifying line; tail is the fallback otherwise", () => {
  const tail = ["tail line"];
  assert.deepEqual(chooseHeadlineLines(["head line"], tail), ["head line"]);
  assert.deepEqual(chooseHeadlineLines(["# only a heading"], tail), tail, "no qualifying line in head -> fallback");
  assert.deepEqual(chooseHeadlineLines([], tail), tail, "empty head (missing/unreadable out.log) -> fallback");
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

// ---------------------------------------------------------------------------
// Completeness rule: hasCompletenessMarker, loadCompletenessConfig, markerFor's new
// reportComplete/enforce behavior, buildDiscordContent's incompleteReason line.
// ---------------------------------------------------------------------------

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

test("markerFor: exit-0 completeness gating -- [INCOMPLETE] only when enforced and reportComplete is false", () => {
  assert.equal(markerFor("exit", 0), "[OK]", "no 3rd arg at all preserves old behavior");
  assert.equal(markerFor("exit", 0, { reportComplete: true }), "[OK]");
  assert.equal(markerFor("exit", 0, { reportComplete: false }), "[INCOMPLETE]");
  assert.equal(markerFor("exit", 0, { reportComplete: false, enforce: false }), "[OK]", "enforcement off always OK on exit 0");
});

test("markerFor: a non-zero exit, signal, or spawn-error is never relabeled by reportComplete/enforce", () => {
  assert.equal(markerFor("exit", 1, { reportComplete: false }), "[FAIL]");
  assert.equal(markerFor("exit", 1, { reportComplete: true, enforce: false }), "[FAIL]");
  assert.equal(markerFor("signal", null, { reportComplete: false }), "[SIGNAL]");
  assert.equal(markerFor("spawn-error", null, { reportComplete: false }), "[SPAWN-ERROR]");
});

test("buildDiscordContent: incompleteReason is appended as its own line after the headline", () => {
  const content = buildDiscordContent({
    marker: "[INCOMPLETE]", host: "claunker", jobId: "job-1", exitCode: 0, durationMs: 1000,
    headline: "did the thing", incompleteReason: INCOMPLETE_REASON,
  });
  const lines = content.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "did the thing");
  assert.equal(lines[2], INCOMPLETE_REASON);
});

test("buildDiscordContent: an absent/falsy incompleteReason adds no extra line", () => {
  const withHeadline = buildDiscordContent({
    marker: "[OK]", host: "h", jobId: "j", exitCode: 0, durationMs: 0, headline: "hi", incompleteReason: undefined,
  });
  assert.equal(withHeadline.split("\n").length, 2);
  const noHeadline = buildDiscordContent({
    marker: "[OK]", host: "h", jobId: "j", exitCode: 0, durationMs: 0, headline: null, incompleteReason: "",
  });
  assert.equal(noHeadline.split("\n").length, 1);
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
// still reads as "complete" ([OK], no trailing reason line) under the new default enforcement --
// see the dedicated "[INCOMPLETE]" tests further down for the marker-missing path itself.
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

test("success: correct payload shape, allowed_mentions parse [], JSON content-type", async () => {
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
  assert.match(body.content, /^\[OK\] host=\S+ job=notify-job-\d+ exit=0 duration=\d/);
});

test("headline rule: first non-heading/non-fence line, truncated to HEADLINE_MAX_CHARS on a word boundary, then escaped", async () => {
  const longLine = "Result ready @everyone check the output file now, no further action needed " + "x ".repeat(250);
  const stdoutText = ["# a heading, skipped", "```", "", longLine, "trailing line, never reached", METRICS_LINE].join("\n");
  const dir = prepareJob({ exitCode: 0, stdoutText });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests.length, 1);
  const lines = requests[0].body.content.split("\n");
  assert.equal(lines.length, 2, "status line + one headline line");
  const headline = lines[1];
  const expectedTruncated = truncateHeadline(longLine);
  assert.equal(headline, escapeDiscordText(expectedTruncated));
  assert.ok(!/(?<!\\)@everyone/.test(headline), "@everyone must never appear un-escaped");
  assert.ok(headline.includes("\\@everyone"), "escaped form must be present");
  assert.ok(headline.endsWith("…"), "a truncated headline ends with an ellipsis");
});

test("includeHeadline=false: headline line is omitted even when stdout has one", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `a perfectly good headline line\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.content.split("\n").length, 1);
});

// Fix: the headline used to come from stdoutTail (the LAST 20 lines of stdout), which for a long
// job report lands mid-report -- job reports put their verdict on the FIRST line instead ("GATE
// FAILED...", "Everything checks out.", "Branch pushed..."). These tests exercise the new
// HEAD-of-out.log source and its fallback to the old tail rule.
test("headline source: the verdict on the FIRST line wins even though the last 20 lines are pure boilerplate", async () => {
  const verdict = "GATE FAILED — stopping immediately";
  const boilerplate = Array.from({ length: 25 }, (_, i) => `delegation report line ${i}`);
  const stdoutText = [verdict, ...boilerplate].join("\n") + "\n";
  const dir = prepareJob({ exitCode: 1, stdoutText });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests.length, 1);
  const lines = requests[0].body.content.split("\n");
  assert.equal(lines[1], verdict, "headline must be the first line, not something from the last-20-lines tail");
});

test("headline source: a markdown heading as the first line of out.log is skipped to the next qualifying line", async () => {
  const stdoutText = ["# Job Report", "Everything checks out.", "trailing detail, never the headline"].join("\n") + "\n";
  const dir = prepareJob({ exitCode: 0, stdoutText });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests[0].body.content.split("\n")[1], "Everything checks out.");
});

test("headline source: a report opening with a bold path-bearing section label never puts the path on the ping", async () => {
  const stdoutText = "## Report\n\n**1. Git — `C:\\Users\\Raide\\OneDrive\\Desktop\\CC bridge\\claude-async`**\n- Branch: `main`\n";
  const dir = prepareJob({ exitCode: 0, stdoutText });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  const content = requests[0].body.content;
  assert.ok(!content.includes("Users"), `no path may reach the ping, got: ${content}`);
  assert.equal(content.split("\n")[1], "- Branch: \\`main\\`");
});

test("headline source: out.log over 8 KiB whose only qualifying line is past the 8 KiB mark falls back to the stdoutTail rule", async () => {
  // ~600 heading lines comfortably exceeds the 8 KiB head-read bound; every one of them is skipped
  // by extractHeadline() (both in the head window and in the tail fallback), so the real line at
  // the very end is the only line either rule could possibly surface.
  const padding = Array.from({ length: 600 }, (_, i) => `# padding heading line ${i}`);
  const stdoutText = [...padding, "Verdict from the tail"].join("\n") + "\n";
  assert.ok(Buffer.byteLength(padding.join("\n"), "utf8") > 8192, "test setup: padding must exceed the 8 KiB head bound");
  const dir = prepareJob({ exitCode: 0, stdoutText });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: true } });
  await spawnRunner(dir);
  server.close();
  assert.equal(requests[0].body.content.split("\n")[1], "Verdict from the tail");
});

// Fix: `intent` (claude_start's optional one-line summary) is now persisted to meta.json by
// job-core.mjs's startJob() (see postlaunch.test.mjs), so job-runner.mjs's finish() -- which only
// ever reads meta.json -- can pass it through as the notification's title.
test("title: meta.json's intent is used as the title, escaped the same way headline text is", async () => {
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
// [INCOMPLETE] end-to-end: the real job-runner.mjs writing exit.json's reportComplete field and
// (when a webhook is configured) labeling the ping, via the real completeness config read from
// notify.json's "completeness" key.
// ---------------------------------------------------------------------------

function readExitJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8"));
}

test("exit 0 with the DELEGATION-METRICS marker: reportComplete=true in exit.json, ping stays [OK]", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: `Everything checks out.\n${METRICS_LINE}\n` });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(readExitJson(dir).reportComplete, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.content, /^\[OK\] /);
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
  assert.equal(lines[1], "Everything checks out, allegedly.", "headline is kept");
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

test("completeness.enforce=false in notify.json: exit 0 without the marker still pings [OK]; reportComplete is still recorded false", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: "No metrics line here.\n" });
  const { server, requests } = startServer(dir);
  const url = await listen(server);
  writeNotify({ discord: { webhookUrl: url, includeHeadline: false }, completeness: { enforce: false } });
  await spawnRunner(dir);
  server.close();
  assert.equal(readExitJson(dir).reportComplete, false, "the field reports the objective fact regardless of enforcement");
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.content, /^\[OK\] /);
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
      startedAt: new Date(Date.now() - 1000), endedAt: new Date(), stdoutLines: [], outLogPath: null,
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
    startedAt: new Date(Date.now() - 1000), endedAt: new Date(), stdoutLines: ["Everything checks out."], outLogPath: null,
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
