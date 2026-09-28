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

// First non-empty line of `stdoutLines` that isn't a markdown heading ("#...") or a code-fence
// marker ("```..."). Those two are skipped because they read as noise/broken formatting as a
// one-line phone notification, not because they're unsafe -- unlike escapeDiscordText(), which
// handles safety.
export function extractHeadline(stdoutLines) {
  if (!Array.isArray(stdoutLines)) return null;
  for (const raw of stdoutLines) {
    const line = String(raw).trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("```")) continue;
    return line;
  }
  return null;
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
// `title` and `jobId` are deliberately the SAME value today -- see the header of notifyJobFinished
// for why (intent is never persisted past card-mint time) -- but are kept as separate call-sites'
// worth of intent so a future title source only needs to change the caller, not this function.
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
 * jobId: meta.json's own jobId field is used as BOTH the "title" and "jobId" fields in the
 * message. This is a deliberate finding, not an oversight: dispatch.mjs/job-core.mjs's `intent`
 * (claude_start's optional one-line summary) is consumed exactly once, at card-mint time
 * (card-hook.mjs's mintCard(), via boundIntent/intentSummary), to build the EXTERNAL jobcard's
 * title/body -- it is never written back into meta.json or any other job-dir file. job-runner.mjs
 * only ever reads meta.json, so by the time a job finishes, the original intent is gone from
 * every file this process can see. jobId is therefore the only stable "title" left.
 */
export async function notifyJobFinished({ jobId, host, exitCode, exitReason, startedAt, endedAt, stdoutLines, includeHeadlineOverride, logLine, fetchImpl = fetch }) {
  let config;
  try { config = loadNotifyConfig(); } catch { return; }
  if (!config) return;

  const marker = markerFor(exitReason, exitCode);
  const includeHeadline = includeHeadlineOverride !== undefined ? includeHeadlineOverride : config.includeHeadline;
  const durationMs = startedAt && endedAt ? (endedAt.getTime() - new Date(startedAt).getTime()) : NaN;
  const headline = includeHeadline ? boundHeadline(stdoutLines) : null;
  const content = buildDiscordContent({ marker, host, jobId, exitCode, durationMs, headline });

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
