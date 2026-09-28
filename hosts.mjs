/**
 * hosts.mjs — multi-host identity, registry, job-id format, and routing for claude-async.
 *
 * The registry (hosts.json) is the source of truth for which hosts exist: the known hosts are
 * `localHost` plus every key of `hosts`, and a remote dispatch target is any registry entry with a
 * url and a token. Topology is one-way by config, not by code: a machine that no registry lists
 * (the laptop) can never be dispatched to. A receiver is a machine that runs host-api.mjs on its
 * Tailscale address and says so with "receiver": true. Every claude_start names its executing host
 * explicitly (no default), and every job id carries that host as a prefix so claude_check can
 * route without any forwarder-side state:
 *
 *   <host>.<descriptor>-YYYYMMDD-<8 random [a-z0-9]>      e.g. claunker.fix-bug-20260925-k3v9x0qa
 *
 * A dot is the separator because ":" is illegal in Windows directory names (and startJob's own
 * sanitizer already rewrites it), so host names may not contain one. A prefix counts as a host
 * when it is a valid host name (HOST_NAME_RE); claude_check then requires it to be a KNOWN host.
 * Pre-multihost ids ("1727300000000-a1b2c3", "gallagioloot-foo-20260925") have no dot and still
 * resolve as local, and a descriptor that merely starts with a host name is not mistaken for a prefix.
 *
 * Config lives in the user profile, never in the repo (CLAUDE_ASYNC_CONFIG_DIR overrides the
 * directory, for tests):
 *   ~/.claude-async/hosts.json   { "localHost": "claunker",
 *                                  "receiver": true,                   (optional; this machine runs host-api.mjs)
 *                                  "hosts": { "ha": { "url": "http://100.x.y.z:7850", "token": "..." } },
 *                                  "caps": { "maxConcurrent": 4, "maxStartsPerMinute": 6 } }   (caps optional)
 *   ~/.claude-async/api.json     host-api.mjs's own config (receivers only; token HASH only)
 *   ~/.claude-async/last-seen.json   last successful contact per remote host (claude_jobs'
 *                                    "unreachable (last seen <time>)" row -- the forwarder's only state)
 *   ~/.claude-async/notify.json   discord-notify.mjs's own config (best-effort job-finish
 *                                 webhook ping; see that file's header). Read at finish time,
 *                                 never at startup, and never created by this codebase.
 * Local-host identity is explicit config (hosts.json "localHost"), never guessed from os.hostname().
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.mjs";

// No dots (the job-id separator), no uppercase (host names become dir names / id prefixes).
export const HOST_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Windows device names: a host name becomes a job-id prefix and a job directory name on whichever
// host mints or checks it, and these cannot be created as files or directories there.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

// Returns null when `name` is a valid host name, else a one-line reason.
export function validateHostName(name) {
  if (typeof name !== "string") return "must be a string";
  if (name === "") return "must not be empty";
  if (name.length > 32) return "must be at most 32 characters";
  if (/[A-Z]/.test(name)) return "must be lowercase (no uppercase letters)";
  if (name.includes(".")) return 'must not contain "." (it separates the host from the rest of a job id)';
  if (!HOST_NAME_RE.test(name)) return "must contain only a-z, 0-9 and \"-\", and start with a letter or digit";
  if (WINDOWS_RESERVED.test(name)) return "is a reserved device name on Windows";
  return null;
}

export const configDir = () =>
  process.env.CLAUDE_ASYNC_CONFIG_DIR || path.join(os.homedir(), ".claude-async");
export const hostsFilePath = () => path.join(configDir(), "hosts.json");
export const apiConfigPath = () => path.join(configDir(), "api.json");
export const lastSeenPath = () => path.join(configDir(), "last-seen.json");
export const notifyConfigPath = () => path.join(configDir(), "notify.json");

// True only for a dotted-quad IPv4 literal (four decimal octets 0-255, no leading zeros) in
// 100.64.0.0/10, the Tailscale CGNAT range. (Delegated to qwen2.5-coder:7b; its output was
// rejected -- it refused any octet starting with "0" and compared concatenated digits -- so this is hand-written.)
export function isTailscaleIPv4(host) {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(String(host));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

// Delegated to qwen2.5-coder:7b (local ollama) with the exact signature + one example; accepted
// verbatim (markdown fences stripped). randomInt(36) per char is unbiased; 36^8 ~ 2^41.
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

export function genSuffix(randomInt = crypto.randomInt) {
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += alphabet[randomInt(36)];
  }
  return suffix;
}

// Originally delegated to qwen2.5-coder:7b (local ollama); reworked by hand when the host list
// became registry-driven. A prefix is any valid host name before the first dot; whether it is a
// KNOWN host is the caller's question (claude_check answers it against the live registry).
export function parseHostPrefix(jobId) {
  if (typeof jobId !== 'string') return { host: null, rest: jobId };
  const dotIndex = jobId.indexOf('.');
  if (dotIndex <= 0) return { host: null, rest: jobId };
  const prefix = jobId.substring(0, dotIndex);
  if (validateHostName(prefix) === null) return { host: prefix, rest: jobId.substring(dotIndex + 1) };
  return { host: null, rest: jobId };
}

// Descriptor = the caller's optional jobId. Dots are rewritten too (not just startJob's usual
// [^A-Za-z0-9._-] set) so a minted id has exactly one dot: the host separator.
export function sanitizeDescriptor(descriptor) {
  const d = String(descriptor ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return d || "job";
}

function yyyymmdd(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

// The EXECUTING host mints the id (it knows its own identity); a forwarder only passes the
// descriptor through. The 8-char suffix is always appended, custom descriptor or not.
export function mintJobId({ host, descriptor, now = new Date(), suffix = genSuffix() }) {
  const bad = validateHostName(host);
  if (bad) throw new Error(`cannot mint a job id for host ${JSON.stringify(host)}: ${bad}`);
  return `${host}.${sanitizeDescriptor(descriptor)}-${yyyymmdd(now)}-${suffix}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Returns { localHost, receiver, hosts, caps, file } or { error, file }. Never throws. Re-read on
// every call so editing hosts.json never needs a bridge restart (only the advertised host enum,
// built once at startup, does). A file that fails validation is an error naming the file and the
// field: nothing is silently ignored, and claude_start refuses until it is fixed.
export function loadHostsConfig(file = hostsFilePath()) {
  let raw;
  try { raw = readJson(file); }
  catch (e) {
    return { file, error: e.code === "ENOENT"
      ? `local host identity not configured: create ${file} with {"localHost": "<this machine's name>"}`
      : `could not read ${file}: ${e.message}` };
  }
  const bad = (field, why) => ({ file, error: `${file}: ${field} ${why}` });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad("the file", "must be a JSON object");
  const localBad = validateHostName(raw.localHost);
  if (localBad) return bad('"localHost"', `${localBad} (got ${JSON.stringify(raw.localHost)})`);
  if (raw.receiver !== undefined && typeof raw.receiver !== "boolean") {
    return bad('"receiver"', `must be true or false (got ${JSON.stringify(raw.receiver)})`);
  }
  const rawHosts = raw.hosts === undefined ? {} : raw.hosts;
  if (rawHosts === null || typeof rawHosts !== "object" || Array.isArray(rawHosts)) {
    return bad('"hosts"', "must be an object mapping host name -> { url, token }");
  }
  const hosts = {};
  for (const [name, entry] of Object.entries(rawHosts)) {
    const field = `"hosts.${name}"`;
    const nameBad = validateHostName(name);
    if (nameBad) return bad(field, `is not a valid host name: ${nameBad}`);
    if (name === raw.localHost) return bad(field, "must not name this machine (it equals \"localHost\")");
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return bad(field, "must be an object { url, token }");
    }
    if (typeof entry.url !== "string" || entry.url === "") return bad(`"hosts.${name}.url"`, "is required (an http or https URL)");
    let u;
    try { u = new URL(entry.url); } catch { u = null; }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) {
      return bad(`"hosts.${name}.url"`, `must be an http or https URL with a host (got ${JSON.stringify(entry.url)})`);
    }
    if (process.env.CLAUDE_ASYNC_ALLOW_ANY_URL !== "1" && !isTailscaleIPv4(u.hostname)) {
      return bad(`"hosts.${name}.url"`, `must have an IPv4 literal host in 100.64.0.0/10 (the receiver only binds a Tailscale address; got ${JSON.stringify(entry.url)})`);
    }
    if (typeof entry.token !== "string" || entry.token === "") return bad(`"hosts.${name}.token"`, "is required (a non-empty string)");
    hosts[name] = { url: entry.url, token: entry.token };
  }
  let caps;
  if (raw.caps !== undefined) {
    if (raw.caps === null || typeof raw.caps !== "object" || Array.isArray(raw.caps)) {
      return bad('"caps"', "must be an object { maxConcurrent, maxStartsPerMinute }");
    }
    for (const [k, v] of Object.entries(raw.caps)) {
      if (k !== "maxConcurrent" && k !== "maxStartsPerMinute") {
        return bad(`"caps.${k}"`, "is not a known cap (known: maxConcurrent, maxStartsPerMinute)");
      }
      if (!Number.isInteger(v) || v < 1) return bad(`"caps.${k}"`, `must be an integer >= 1 (got ${JSON.stringify(v)})`);
    }
    caps = raw.caps;
  }
  return { file, localHost: raw.localHost, receiver: raw.receiver === true, hosts, caps };
}

// Every host this registry knows: this machine, then each remote entry.
export const knownHosts = (cfg) => [cfg.localHost, ...Object.keys(cfg.hosts || {})];

// Routing rules:
//   host === localHost                      -> local (no network hop)
//   registry entry with url + token         -> forward to that host's host-api
//   anything else                           -> error naming the file and the known hosts
// One-way topology is config: a machine no registry lists (the laptop) is simply unknown.
// Returns { kind: "local" } | { kind: "forward", host, url, token } | { error }.
export function resolveRoute(host, cfg) {
  if (cfg.error) return { error: cfg.error };
  if (host === cfg.localHost) return { kind: "local" };
  const entry = typeof host === "string" && Object.hasOwn(cfg.hosts || {}, host) ? cfg.hosts[host] : undefined;
  if (entry && entry.url && entry.token) return { kind: "forward", host, url: entry.url, token: entry.token };
  return { error: `host ${JSON.stringify(String(host))} is not in ${cfg.file} (known hosts: ${knownHosts(cfg).join(", ")})` };
}

export function readLastSeen(file = lastSeenPath()) {
  try { return readJson(file); } catch { return {}; }
}

export function recordLastSeen(host, when = new Date(), file = lastSeenPath()) {
  try {
    const cur = readLastSeen(file);
    cur[host] = when.toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, cur);
  } catch { /* cache only; never fatal */ }
}
