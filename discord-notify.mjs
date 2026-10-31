/**
 * discord-notify.mjs — best-effort Discord webhook ping when a job finishes.
 *
 * Strictly optional, strictly best-effort: reading config, building the payload, and posting to
 * the webhook can never delay, alter, or fail job completion. job-runner.mjs's finish() calls
 * notifyJobFinished() AFTER exit.json and exit_code are both written, wrapped in its own
 * try/catch, and this module bounds the whole network call at NOTIFY_TIMEOUT_MS so a hung or
 * slow webhook can never hold the runner process open beyond that.
 *
 * Config: ~/.claude-async/notify.json (same CLAUDE_ASYNC_CONFIG_DIR-aware directory hosts.mjs
 * uses for hosts.json/api.json — see notifyConfigPath() there):
 *   { "discord": { "webhookUrl": "https://discord.com/api/webhooks/...", "includeHeadline": true },
 *     "completeness": { "enforce": true, "markerRegex": "^DELEGATION-METRICS:" } }
 * A missing file, a missing/blank discord.webhookUrl, or unparseable JSON all mean "feature off":
 * no error, no throw. There is no debug-level logger anywhere in this codebase to log a debug
 * line to, so "off" is a plain, silent no-op. Read at finish time (loadNotifyConfig() is called
 * fresh on every job), never cached at startup, so Erick can add/edit/remove notify.json without
 * restarting anything. `discord.includeHeadline` is the historical key name (predates the switch
 * from a one-line headline to a multi-line excerpt below); it still governs whether the excerpt is
 * included at all, just not its shape.
 *
 * `completeness` (see loadCompletenessConfig()/markerFor()) is independent of `discord`: it
 * governs whether an exit-0 job missing its final DELEGATION-METRICS report line is labeled
 * [INCOMPLETE] instead of a result-based marker, and is read (and the job's reportComplete field
 * computed) by job-runner.mjs regardless of whether a webhook is even configured.
 *
 * The webhook URL is a credential (a Discord webhook URL embeds its own auth token in the path)
 * and is treated like one: it is never written to the runner's log, to exit.json/meta.json, or
 * to any error message this module produces. sanitizeForLog() below is a second, independent
 * belt against a network error message that happens to echo the request URL back.
 */
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./hosts.mjs";

export const NOTIFY_TIMEOUT_MS = 5000;
const MAX_CONTENT_CHARS = 1800;
// The excerpt's hard cap. Applied to BOTH branches of excerptSource() -- the preferred "text after
// the last Summary heading" branch and the "no heading" last-N-chars fallback -- so one rule, not
// two, decides the final length regardless of which branch produced the source text. 1200 (bigger
// than the "~600 chars" a one-line headline needed) because a real final-report Summary section
// commonly runs 800-1000 chars on its own (job claunker.cloud-dispatch-test-20261031-j8or6rg2's
// real Summary section is ~840 chars): a tighter cap would cut the actual blocker detail right
// back out even though it's the exact text this feature exists to surface. Still comfortably
// under the message's own 1800-char hard cap alongside the status line.
export const EXCERPT_MAX_CHARS = 1200;

export function notifyConfigPath() {
  return path.join(configDir(), "notify.json");
}

// See the 2026-10-18 incident comment on notifyJobFinished's real-send guard below for why these
// exist: CLAUDE_ASYNC_TEST=1 is the explicit marker every test entry point sets; NODE_TEST_CONTEXT
// is Node's own test-runner marker, honored as a second, no-setup-required signal.
export function isTestMode() {
  return process.env.CLAUDE_ASYNC_TEST === "1" || process.env.NODE_TEST_CONTEXT !== undefined;
}
let realSendBlockedCount = 0;
export function getRealSendBlockedCount() { return realSendBlockedCount; }
export function resetRealSendBlockedCount() { realSendBlockedCount = 0; }
function isDiscordWebhookHost(url) {
  try { return /(^|\.)discord(app)?\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

// Returns { webhookUrl, includeHeadline } or null ("feature off"). Never throws.
export function loadNotifyConfig() {
  let raw;
  try { raw = fs.readFileSync(notifyConfigPath(), "utf8"); }
  catch { return null; } // file absent (or unreadable) -> off
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return null; } // unparseable -> off
  const webhookUrl = cfg && cfg.discord && typeof cfg.discord.webhookUrl === "string"
    ? cfg.discord.webhookUrl.trim() : "";
  if (!webhookUrl) return null; // missing/blank key -> off
  return { webhookUrl, includeHeadline: cfg.discord.includeHeadline !== false };
}

// The contract line every Claunker job's final report is now required to emit last (see
// CLAUDE.md's delegation policy). Anchored with "^" and tested per-line (never with a global
// flag's stateful lastIndex -- see hasCompletenessMarker), so a marker embedded mid-line (e.g.
// "note: DELEGATION-METRICS: ...") does not count as present.
export const DEFAULT_COMPLETENESS_MARKER_SOURCE = "^DELEGATION-METRICS:";

// Returns { enforce, markerRegex } from notify.json's optional "completeness" key. Never throws.
// Default (no file, no key, or a malformed markerRegex string): enforce=true with the
// DELEGATION-METRICS marker -- a host that does not use the delegation contract can set
// completeness.enforce:false to turn this off entirely.
export function loadCompletenessConfig() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(notifyConfigPath(), "utf8")); } catch { cfg = null; }
  const c = (cfg && cfg.completeness) || {};
  const enforce = c.enforce !== false;
  let markerRegex;
  try { markerRegex = new RegExp(typeof c.markerRegex === "string" ? c.markerRegex : DEFAULT_COMPLETENESS_MARKER_SOURCE); }
  catch { markerRegex = new RegExp(DEFAULT_COMPLETENESS_MARKER_SOURCE); }
  return { enforce, markerRegex };
}

// Strips markdown wrapping a model commonly puts around its own final-report line -- leading
// whitespace/indentation, blockquote/list markers ("> ", "- ", "* "), bold/italic emphasis
// ("**", "__", "*", "_"), and backticks (inline code or a one-line fenced-code wrap) -- from the
// start and end of `line`. Only touches leading/trailing runs of those characters, so the literal
// hyphen inside "DELEGATION-METRICS" is never affected (stripping stops at the first non-wrapper
// character, which is "D"). A fenced block's OWN delimiter lines ("```" alone) are separate lines
// from the marker line itself and need no special handling here -- they just strip to "".
export function stripMarkdownWrapping(line) {
  return String(line).replace(/^[\s`>*_+-]+/, "").replace(/[\s`*_]+$/, "");
}

// True when any line in `lines`, after stripMarkdownWrapping(), matches markerRegex. lastIndex is
// reset before every test so a caller-supplied global-flag regex can never skip a line due to
// leftover state from the previous one. This is the one function every reportComplete computation
// goes through (job-runner.mjs's recordExit()), so a markdown-wrapped marker line (e.g. a model
// wrapping its final report line in backticks) is recognized the same way everywhere.
export function hasCompletenessMarker(lines, markerRegex) {
  if (!Array.isArray(lines)) return false;
  const re = markerRegex || new RegExp(DEFAULT_COMPLETENESS_MARKER_SOURCE);
  return lines.some((l) => { re.lastIndex = 0; return re.test(stripMarkdownWrapping(String(l))); });
}

// Leading list/number markers: "-", "*", "+", ">", "1.", "1)", repeated ("> - 1.").
const LIST_PREFIX = /^(?:(?:[-*+>]|\d+[.)])(?:\s+|$))+/;

// A report line that reads as a "Summary"-style section heading once markdown heading markers
// ("##"), leading list/blockquote markers, and ONE layer of surrounding emphasis are stripped --
// matches "## Summary", "**Summary:**", "- Summary", and the real-world
// "**Summary / blocker:**" (job claunker.cloud-dispatch-test-20261031-j8or6rg2's final report).
const SUMMARY_HEADING_RE = /^summary\b/i;
export function isSummaryHeadingLine(line) {
  let s = String(line).trim();
  s = s.replace(/^#{1,6}\s*/, "").replace(LIST_PREFIX, "");
  s = s.replace(/^(\*\*|__|\*|_)/, "").replace(/(\*\*|__|\*|_)$/, "").trim();
  return SUMMARY_HEADING_RE.test(s);
}

// Index of the LAST line in `lines` that qualifies as a summary heading (isSummaryHeadingLine),
// or -1. The last occurrence wins: a report can have an earlier "## Summary of findings" followed
// later by the real final "## Summary" the excerpt should start from.
function lastSummaryHeadingIndex(lines) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (isSummaryHeadingLine(lines[i])) idx = i;
  return idx;
}

const DELEGATION_CONTRACT_LINE = /^(?:DELEGATION-(?:CALL|METRICS):)/;

// True for a line that IS the delegation contract's DELEGATION-CALL/DELEGATION-METRICS line, even
// when wrapped in markdown (the real-world case: a model wraps its final report line in inline
// backticks). Delegation is still reported in full by the job's own report text; this only keeps
// the terse machine-readable contract line itself out of the human-facing excerpt.
function isDelegationContractLine(line) {
  return DELEGATION_CONTRACT_LINE.test(stripMarkdownWrapping(String(line).trim()));
}

// The optional final-report marker line, "RESULT: pass|partial|blocked|fail" (case-insensitive,
// tolerant of the same markdown wrapping hasCompletenessMarker tolerates, and of a trailing
// period). The LAST occurrence in `lines` wins, same convention as the completeness marker and
// the old Verdict-line rule -- a model that restates its result partway through and again at the
// very end should be read by its final word.
const RESULT_LINE_RE = /^RESULT:\s*(pass|partial|blocked|fail)[.\s]*$/i;
export function parseResultMarker(lines) {
  if (!Array.isArray(lines)) return null;
  let found = null;
  for (const raw of lines) {
    const m = RESULT_LINE_RE.exec(stripMarkdownWrapping(String(raw).trim()));
    if (m) found = m[1].toLowerCase();
  }
  return found;
}

// Removes the FIRST occurrence of `token` from `text` when it appears an odd number of times (one
// unmatched CLOSING marker left dangling by a cut off the FRONT of the text -- its opener was in
// the dropped prefix), leaving any complete, balanced pairs alone.
function stripLeadingUnbalancedToken(text, token) {
  const count = text.split(token).length - 1;
  if (count % 2 === 0) return text;
  const idx = text.indexOf(token);
  return idx === -1 ? text : text.slice(0, idx) + text.slice(idx + token.length);
}

// Neutralizes any markdown span (fenced code, bold, italic, inline code) left open at the START of
// `text` by a cut that dropped everything BEFORE it -- the shape buildExcerpt() produces, since it
// keeps the END of a report and cuts its front. Strips the orphaned marker (its pair was in the
// dropped prefix) rather than inserting a synthetic opener, same rationale as the end-oriented
// stripping below: a fabricated opener right after the cut would read even stranger than plain
// text. Order matters: longer tokens ("```", "**", "__") are stripped before the shorter tokens
// that are their building blocks, so a complete "**" pair is never mistaken for two unmatched "*"
// markers.
export function closeMarkdownSpansAtStart(text) {
  let s = String(text);
  for (const token of ["```", "**", "__", "*", "_", "`"]) {
    s = stripLeadingUnbalancedToken(s, token);
  }
  return s;
}

const BACKTICK_WRAPPED_URL_RE = /`(https?:\/\/[^\s`]+)`/g;

// Removes backticks that wrap a URL exactly ("`https://...`" -> "https://..."), so the URL is not
// left inside an inline-code span. escapeDiscordText() backslash-escapes every backtick
// regardless of pairing, and an escaped backtick sitting immediately against a URL (no
// whitespace) is exactly the shape Discord's own autolinker was observed swallowing into the link
// itself -- job claunker.cloud-dispatch-test-20261031-j8or6rg2's real ping rendered
// "https://github.com/icey2488/gallagioloot.git/%60" (a URL-encoded trailing backtick) because its
// report wrote "`https://github.com/icey2488/gallagioloot.git`,".
export function stripBackticksAroundUrls(text) {
  return String(text).replace(BACKTICK_WRAPPED_URL_RE, "$1");
}

// Defense in depth for any OTHER way a backtick (raw or backslash-escaped) ends up immediately
// after a URL with no separating whitespace -- inserts a space so Discord's autolinker stops at
// the URL's own last character instead of absorbing the trailing backtick too.
export function ensureSpaceAfterUrlBeforeBacktick(text) {
  return String(text).replace(/(https?:\/\/[^\s`\\]+)(\\?`)/g, "$1 $2");
}

// Cuts `text` to at most `max` characters, KEEPING THE END and moving the cut point forward to the
// next line boundary so the kept text never opens mid-line (the dropped prefix's partial line is
// discarded along with the rest of the prefix). Mirrors job-runner.mjs's readTail() dropping a
// partial first line, same reasoning.
function cutToLastChars(text, max) {
  if (text.length <= max) return text;
  let start = text.length - max;
  const nl = text.indexOf("\n", start);
  if (nl !== -1 && nl + 1 < text.length) start = nl + 1;
  return text.slice(start);
}

// Picks the excerpt's source text from `lines` (the job's own stdout tail): everything after the
// LAST "Summary"-style heading if one exists (a report's final conclusion conventionally lives
// there -- see isSummaryHeadingLine), otherwise the whole tail. The delegation contract's own
// DELEGATION-CALL/DELEGATION-METRICS line is always excluded first (requirement: delegation is
// still reported via the contract lines/metrics themselves, just not echoed into this human-facing
// text). Falls back to the unfiltered tail if the chosen slice is empty (e.g. a summary heading
// with nothing meaningful after it, such as right before the final metrics line).
function excerptSource(lines) {
  const filtered = lines.filter((l) => !isDelegationContractLine(l));
  if (filtered.length === 0) return "";
  const idx = lastSummaryHeadingIndex(filtered);
  const picked = idx === -1 ? filtered : filtered.slice(idx + 1);
  const text = picked.join("\n").trim();
  return text || filtered.join("\n").trim();
}

// Builds the Discord excerpt from the END of a job's report (requirement: the ping must surface
// the conclusion/blocker a model writes last, not whatever happens to be first). Source selection
// (excerptSource) prefers the final "## Summary"-style section; absent one, the last
// EXCERPT_MAX_CHARS characters of the tail, cut at a line boundary. Either way, a cut that landed
// mid code-span/fence is closed (not left dangling) and a URL is never left directly adjacent to a
// markdown character, before the text is escaped for Discord. Returns null when there is nothing
// in `stdoutLines` to work with.
export function buildExcerpt(stdoutLines) {
  if (!Array.isArray(stdoutLines) || stdoutLines.length === 0) return null;
  const source = excerptSource(stdoutLines.map((l) => String(l)));
  if (!source) return null;
  let text = cutToLastChars(source, EXCERPT_MAX_CHARS);
  text = closeMarkdownSpansAtStart(text);
  text = stripBackticksAroundUrls(text);
  const escaped = escapeDiscordText(text);
  return ensureSpaceAfterUrlBeforeBacktick(escaped);
}

// Neutralizes Discord markdown/mention syntax by backslash-escaping @, `, <, > so job output can
// never render as a live mention, break out into a code span, or form a custom-emoji/link token.
// This is independent of (and in addition to) allowed_mentions:{parse:[]} on the request itself,
// which is what actually stops a ping from firing -- this only stops the FORMATTING.
export function escapeDiscordText(text) {
  return String(text).replace(/[@`<>]/g, (c) => "\\" + c);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

// Emoji-free status marker; doubles as the message's status word (no separate emoji is used
// anywhere in this module, deliberately, so the message renders identically on any client/font).
// Precedence (highest first):
//   1. Runner-reported failure (spawn-error / signal / bg_tasks_terminated / non-zero exit) --
//      always wins, regardless of any RESULT: marker the model's own text claims. A job that died
//      or exited non-zero does not get to self-report success.
//   2. [INCOMPLETE] -- an exit-0 job whose stdout never carried the DELEGATION-METRICS final-report
//      marker (enforcement on): it exited cleanly but may have stopped early without ever writing
//      its report, so there is nothing to trust a RESULT: line from either.
//   3. The optional RESULT: marker (see parseResultMarker): [OK] for pass, [PARTIAL], [BLOCKED],
//      [FAIL].
//   4. [DONE] -- exit 0, a complete report, but NO RESULT: marker. Deliberately not [OK]: an
//      unverified outcome must never read as confirmed success. (2026-10-31
//      claunker.cloud-dispatch-test-20261031-j8or6rg2: exited 0 after a permission denial blocked
//      it from launching anything -- its own final report said BLOCKED, but the old rule read exit
//      0 + a complete report as [OK].)
export function markerFor(exitReason, exitCode, { reportComplete = true, enforce = true, resultMarker = null } = {}) {
  if (exitReason === "spawn-error") return "[SPAWN-ERROR]";
  if (exitReason === "signal") return "[SIGNAL]";
  // 2026-10-18 claunker.gemini-mcp-v2-20261018-pfvzx44f: the CLI's own background-task wait
  // ceiling killed background work mid-flight but the CLI still exited 0 -- never let that read
  // as success just because exitCode is 0 (see job-runner.mjs's BG_TASKS_TERMINATED_RE).
  if (exitReason === "bg_tasks_terminated") return "[BG-TASKS-TERMINATED]";
  if (exitCode !== 0) return "[FAIL]";
  if (enforce && !reportComplete) return "[INCOMPLETE]";
  if (resultMarker === "pass") return "[OK]";
  if (resultMarker === "partial") return "[PARTIAL]";
  if (resultMarker === "blocked") return "[BLOCKED]";
  if (resultMarker === "fail") return "[FAIL]";
  return "[DONE]";
}

// Shown on the ping when markerFor returns [INCOMPLETE], appended after the excerpt.
export const INCOMPLETE_REASON = "no final report marker (DELEGATION-METRICS) found; job may have stopped early";

// Pure builder (no I/O) so tests can check shape/escaping/truncation without a network call.
// `jobId` here is really "whatever the caller wants shown as the title" -- see notifyJobFinished's
// header for why the caller (not this function) resolves that to meta.intent-or-jobId.
export function buildDiscordContent({ marker, host, jobId, exitCode, durationMs, excerpt, incompleteReason }) {
  const lines = [
    `${marker} host=${host} job=${jobId} exit=${exitCode === null || exitCode === undefined ? "null" : exitCode} ` +
    `duration=${formatDuration(durationMs)}`,
  ];
  if (excerpt) lines.push(excerpt);
  if (incompleteReason) lines.push(incompleteReason);
  const content = lines.join("\n");
  return content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content;
}

const WEBHOOK_LIKE = /https?:\/\/\S*webhooks?\S*/gi;

// Defense-in-depth redaction for any log line this module produces: strips the exact configured
// URL (if known) AND anything that merely looks like a Discord webhook URL, in case a future
// runtime's network error ever echoes the request URL back in its message.
function sanitizeForLog(msg, webhookUrl) {
  let s = String(msg);
  if (webhookUrl) s = s.split(webhookUrl).join("[redacted]");
  return s.replace(WEBHOOK_LIKE, "[redacted]");
}

/**
 * Best-effort job-finish notification. Never throws, never rejects, and never takes longer than
 * NOTIFY_TIMEOUT_MS. On any non-2xx response, network error, or timeout, calls logLine(msg) once
 * with a message that has been passed through sanitizeForLog() -- msg never contains the webhook
 * URL. logLine itself is expected to be best-effort too (job-runner.mjs's own diagnostic writer).
 *
 * title: meta.json's `intent` field (job-core.mjs's startJob() persists the dispatcher-supplied,
 * boundIntent()-bounded intent there, additively, when one was given -- see job-core.mjs) is used
 * as the message's title when present; jobId is the fallback, same as mintCard()'s own card-title
 * rule (`boundIntent(intent) || intentSummary(prompt)`, jobId-equivalent being the card's own
 * last resort). intent is free text from the ORIGINAL dispatcher, so it is escaped the same way
 * excerpt text is (escapeDiscordText) before being used -- allowed_mentions:{parse:[]} already
 * stops it from ever pinging, but escaping keeps it from breaking message formatting too.
 *
 * excerpt: built from the END of `stdoutLines` (job-runner.mjs's own recordExit() stdoutTail --
 * the last ~20 lines/64KB of out.log read straight off disk at exit time), via buildExcerpt(). See
 * buildExcerpt's own header for the summary-section/EXCERPT_MAX_CHARS rule.
 *
 * reportComplete: whether the job's stdout carried the DELEGATION-METRICS final-report marker
 * (job-runner.mjs computes this once, via hasCompletenessMarker(), and both writes it to
 * exit.json and passes it in here, so the completeness check and the field claude_check surfaces
 * always agree). resultMarker is parsed here (parseResultMarker) from the same stdoutLines, so
 * there is exactly one place that decides what a job's own text claims about its outcome.
 */
export async function notifyJobFinished({ jobId, intent, host, exitCode, exitReason, startedAt, endedAt, stdoutLines, includeHeadlineOverride, reportComplete, logLine, fetchImpl = fetch }) {
  let config;
  try { config = loadNotifyConfig(); } catch { return; }
  if (!config) return;

  // 2026-10-18 test-isolation incident: fixture jobs minted by the test suites (j1-j4, job-t1b,
  // job-intent1, ...) posted real pings to Erick's #notifications channel, because job-runner.mjs
  // child processes inherit the bridge's real CLAUDE_ASYNC_CONFIG_DIR/notify.json whenever a test
  // forgets to override it. Config-dir isolation in the test harness is the primary fix; this is
  // the last-line-of-defense belt: in test mode (CLAUDE_ASYNC_TEST=1, or Node's own
  // NODE_TEST_CONTEXT) a request aimed at a genuine discord.com webhook through the DEFAULT
  // network-capable fetch is never sent. A test-injected fetchImpl (a fake sender) or a non-Discord
  // URL (a test's own local HTTP server, as discord-notify.test.mjs's integration tests use) is
  // unaffected -- this only blocks the one shape that would actually leave the machine for real.
  if (isTestMode() && fetchImpl === fetch && isDiscordWebhookHost(config.webhookUrl)) {
    realSendBlockedCount++;
    try { logLine && logLine("discord notify: blocked real Discord send in test mode (CLAUDE_ASYNC_TEST)"); } catch {}
    return;
  }

  let completeness;
  try { completeness = loadCompletenessConfig(); } catch { completeness = { enforce: true }; }
  const lines = Array.isArray(stdoutLines) ? stdoutLines : [];
  const resultMarker = parseResultMarker(lines);
  const marker = markerFor(exitReason, exitCode, { reportComplete, enforce: completeness.enforce, resultMarker });
  const includeExcerpt = includeHeadlineOverride !== undefined ? includeHeadlineOverride : config.includeHeadline;
  const durationMs = startedAt && endedAt ? (endedAt.getTime() - new Date(startedAt).getTime()) : NaN;
  const excerpt = includeExcerpt ? buildExcerpt(lines) : null;
  const title = intent ? escapeDiscordText(intent) : jobId;
  const incompleteReason = marker === "[INCOMPLETE]" ? INCOMPLETE_REASON : null;
  const content = buildDiscordContent({ marker, host, jobId: title, exitCode, durationMs, excerpt, incompleteReason });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      try { logLine && logLine(sanitizeForLog(`discord notify: webhook returned HTTP ${res.status}`, config.webhookUrl)); } catch {}
    }
  } catch (e) {
    const reason = e && e.name === "AbortError" ? "timed out" : (e && e.message) || String(e);
    try { logLine && logLine(sanitizeForLog(`discord notify: request failed (${reason})`, config.webhookUrl)); } catch {}
  } finally {
    clearTimeout(timer);
  }
}
