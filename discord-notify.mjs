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
 *   { "discord": { "webhookUrl": "https://discord.com/api/webhooks/...", "includeHeadline": true } }
 * A missing file, a missing/blank discord.webhookUrl, or unparseable JSON all mean "feature off":
 * no error, no throw. There is no debug-level logger anywhere in this codebase to log a debug
 * line to, so "off" is a plain, silent no-op. Read at finish time (loadNotifyConfig() is called
 * fresh on every job), never cached at startup, so Erick can add/edit/remove notify.json without
 * restarting anything.
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
const HEADLINE_MAX_CHARS = 200;
const HEAD_BYTES = 8 * 1024;

export function notifyConfigPath() {
  return path.join(configDir(), "notify.json");
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

const LABEL_MAX_CHARS = 80;
// Leading list/number markers: "-", "*", "+", ">", "1.", "1)", repeated ("> - 1.").
const LIST_PREFIX = /^(?:(?:[-*+>]|\d+[.)])(?:\s+|$))+/;
// A line wholly wrapped in one emphasis pair: **x**, __x__, *x*, _x_.
const EMPHASIS_WRAPPED = /^(\*\*|__|\*|_)(.+)\1$/;

// True for a line that is only markdown markers around a short label: "1.", "- **Report**",
// "**Report**", "**1. Git -- `...`**", "**Summary:**", or a rule like "---". A wrapped line that
// reads like content (ends like a sentence, "**All checks passed.**", or carries a value after a
// colon, "**Verdict: PASS**") or runs past LABEL_MAX_CHARS is not a label.
export function isLabelLine(line) {
  if (/^[-*_=~+>\s]+$/.test(line)) return true;
  const rest = line.replace(LIST_PREFIX, "").trim();
  if (!rest) return true;
  const m = rest.match(EMPHASIS_WRAPPED);
  if (!m) return false;
  const inner = m[2].replace(LIST_PREFIX, "").trim();
  return inner.length <= LABEL_MAX_CHARS && !/[.!?]$/.test(inner) && !/:\s+\S/.test(inner);
}

// Windows drive paths (C:\, D:/), UNC (\\server), and absolute POSIX paths (/home/, /c/Users/,
// /usr/...). The drive letter and the POSIX leading slash must not follow a word character, so
// URLs ("https://..."), "and/or", and "1/2" do not count.
const PATH_PATTERNS = [
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
  /(?:^|[^\\\w])\\\\[\w.$-]+/,
  /(?:^|[^\w/.~-])\/[\w.$-]+\//,
];

export function containsPath(line) {
  return PATH_PATTERNS.some((re) => re.test(line));
}

// First non-empty line of `stdoutLines` that isn't a markdown heading ("#..."), a code-fence
// marker ("```..."), a bare markdown label (isLabelLine), or a line containing a filesystem path
// (containsPath). Headings, fences and labels are skipped because they read as noise/broken
// formatting as a one-line phone notification; path lines because a local path says nothing
// about the outcome and should not leave the host. Escaping (escapeDiscordText) handles safety.
export function extractHeadline(stdoutLines) {
  if (!Array.isArray(stdoutLines)) return null;
  for (const raw of stdoutLines) {
    const line = String(raw).trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("```")) continue;
    if (isLabelLine(line)) continue;
    if (containsPath(line)) continue;
    return line;
  }
  return null;
}

// Reads at most the first `maxBytes` of `file` and returns it split into lines. Mirrors job-
// runner.mjs's readTail() bounded-read shape but anchored at the head instead of the tail: job
// reports put their verdict on the FIRST line ("GATE FAILED...", "Everything checks out.", ...),
// not the last, so the headline source needs to be the head of the log, not its tail.
// When the file is bigger than maxBytes, the read window ends mid-line (or mid-character for
// multibyte UTF-8), so the last line of the chunk is dropped -- it is likely partial, same
// reasoning as readTail()'s drop of its FIRST line. Any failure (missing file, read error, decode
// error, ...) yields [] -- this is best-effort diagnostic data; the caller falls back to the
// stdoutTail rule.
export function readHead(file, maxBytes = HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buf, 0, length, 0);
    let text = buf.toString("utf8");
    if (size > length) {
      // Truncated: the last "line" in the chunk is almost certainly partial. Drop it.
      const nl = text.lastIndexOf("\n");
      text = nl === -1 ? "" : text.slice(0, nl);
    }
    if (!text) return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // trailing newline from the file's last write
    return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// Picks which line set boundHeadline() should read from: the head of out.log when it has a
// qualifying line (job reports put their verdict at the top), else the stdoutTail rule this
// module used before -- covers out.log missing/unreadable (readHead yields []) and out.log
// present but with no qualifying line in the first HEAD_BYTES (e.g. a long banner/heading block).
export function chooseHeadlineLines(headLines, tailLines) {
  return extractHeadline(headLines) ? headLines : tailLines;
}

// Neutralizes Discord markdown/mention syntax by backslash-escaping @, `, <, > so job output can
// never render as a live mention, break out into a code span, or form a custom-emoji/link token.
// This is independent of (and in addition to) allowed_mentions:{parse:[]} on the request itself,
// which is what actually stops a ping from firing -- this only stops the FORMATTING.
export function escapeDiscordText(text) {
  return String(text).replace(/[@`<>]/g, (c) => "\\" + c);
}

// Extracted, truncated (to HEADLINE_MAX_CHARS), then escaped -- in that order, so the length cap
// applies to the raw job-output line, not to however many backslashes escaping happens to add.
export function boundHeadline(stdoutLines) {
  const line = extractHeadline(stdoutLines);
  if (!line) return null;
  const truncated = line.length > HEADLINE_MAX_CHARS ? line.slice(0, HEADLINE_MAX_CHARS) : line;
  return escapeDiscordText(truncated);
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
export function markerFor(exitReason, exitCode) {
  if (exitReason === "spawn-error") return "[SPAWN-ERROR]";
  if (exitReason === "signal") return "[SIGNAL]";
  return exitCode === 0 ? "[OK]" : "[FAIL]";
}

// Pure builder (no I/O) so tests can check shape/escaping/truncation without a network call.
// `jobId` here is really "whatever the caller wants shown as the title" -- see notifyJobFinished's
// header for why the caller (not this function) resolves that to meta.intent-or-jobId.
export function buildDiscordContent({ marker, host, jobId, exitCode, durationMs, headline }) {
  const lines = [
    `${marker} host=${host} job=${jobId} exit=${exitCode === null || exitCode === undefined ? "null" : exitCode} ` +
    `duration=${formatDuration(durationMs)}`,
  ];
  if (headline) lines.push(headline);
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
 * headline text is (escapeDiscordText) before being used -- allowed_mentions:{parse:[]} already
 * stops it from ever pinging, but escaping keeps it from breaking message formatting too.
 *
 * headline: sourced from the HEAD of the job's own stdout log (job reports conventionally put
 * their verdict on the FIRST line -- "GATE FAILED...", "Everything checks out.", ...), read
 * bounded via readHead()/outLogPath. Falls back to the stdoutTail rule (the `stdoutLines` param,
 * exit.json's own stdoutTail) when outLogPath is absent/unreadable or has no qualifying line in
 * its head window -- see chooseHeadlineLines().
 */
export async function notifyJobFinished({ jobId, intent, host, exitCode, exitReason, startedAt, endedAt, stdoutLines, outLogPath, includeHeadlineOverride, logLine, fetchImpl = fetch }) {
  let config;
  try { config = loadNotifyConfig(); } catch { return; }
  if (!config) return;

  const marker = markerFor(exitReason, exitCode);
  const includeHeadline = includeHeadlineOverride !== undefined ? includeHeadlineOverride : config.includeHeadline;
  const durationMs = startedAt && endedAt ? (endedAt.getTime() - new Date(startedAt).getTime()) : NaN;
  const headLines = includeHeadline && outLogPath ? readHead(outLogPath) : [];
  const headline = includeHeadline ? boundHeadline(chooseHeadlineLines(headLines, stdoutLines)) : null;
  const title = intent ? escapeDiscordText(intent) : jobId;
  const content = buildDiscordContent({ marker, host, jobId: title, exitCode, durationMs, headline });

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
