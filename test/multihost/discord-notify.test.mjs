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
  isLabelLine, containsPath,
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

test("boundHeadline: truncates to 200 chars BEFORE escaping, then escapes", () => {
  const long = "@".repeat(250); // an escape-heavy line, so truncate-then-escape vs escape-then-truncate diverge sharply
  const result = boundHeadline([long]);
  // truncate(250 @'s, 200) -> 200 @'s, THEN escape -> 200 "\@" pairs -> 400 chars
  assert.equal(result, "\\@".repeat(200));
  assert.equal(result.length, 400);
});

test("boundHeadline: returns null when no usable line exists", () => {
  assert.equal(boundHeadline(["# heading only"]), null);
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
// Integration tests: the real job-runner.mjs, a real (loopback) HTTP server, no fakes.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "..", "job-runner.mjs");
const FAKE = path.join(here, "notify-fake-cli.mjs");
let seq = 0;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

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
  const dir = prepareJob({ exitCode: 0, stdoutText: "plain first line\n" });
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

test("headline rule: first non-heading/non-fence line, truncated to 200 chars, then escaped", async () => {
  const longLine = "Result ready @everyone check the `output` file now " + "x".repeat(250);
  const stdoutText = ["# a heading, skipped", "```", "", longLine, "trailing line, never reached"].join("\n");
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
  const expectedTruncated = longLine.slice(0, 200);
  assert.equal(headline, expectedTruncated.replace(/[@`<>]/g, (c) => "\\" + c));
  assert.ok(!/(?<!\\)@everyone/.test(headline), "@everyone must never appear un-escaped");
  assert.ok(headline.includes("\\@everyone"), "escaped form must be present");
  assert.ok(headline.includes("\\`"), "backtick must be escaped");
});

test("includeHeadline=false: headline line is omitted even when stdout has one", async () => {
  const dir = prepareJob({ exitCode: 0, stdoutText: "a perfectly good headline line\n" });
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
