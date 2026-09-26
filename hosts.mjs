/**
 * hosts.mjs — multi-host identity, registry, job-id format, and routing for claude-async.
 *
 * Topology is deliberately one-way: `claunker` is the only remote dispatch target (it runs
 * host-api.mjs on its Tailscale address); `laptop` never exposes an API. Every claude_start names
 * its executing host explicitly (no default), and every job id carries that host as a prefix so
 * claude_check can route without any forwarder-side state:
 *
 *   <host>.<descriptor>-YYYYMMDD-<8 random [a-z0-9]>      e.g. claunker.fix-bug-20260925-k3v9x0qa
 *
 * A dot is the separator because ":" is illegal in Windows directory names (and startJob's own
 * sanitizer already rewrites it). A prefix counts as a host ONLY if it exactly matches the host
 * enum, so pre-multihost ids ("1727300000000-a1b2c3", "gallagioloot-foo-20260925") still resolve
 * as local, and a descriptor that merely starts with "claunker" is not mistaken for a prefix.
 *
 * Config lives in the user profile, never in the repo (CLAUDE_ASYNC_CONFIG_DIR overrides the
 * directory, for tests):
 *   ~/.claude-async/hosts.json   { "localHost": "claunker"|"laptop",
 *                                  "hosts": { "claunker": { "url": "http://100.x.y.z:7850", "token": "..." } },
 *                                  "caps": { "maxConcurrent": 4, "maxStartsPerMinute": 6 } }   (caps optional)
 *   ~/.claude-async/api.json     host-api.mjs's own config (Claunker only; token HASH only)
 *   ~/.claude-async/last-seen.json   last successful contact per remote host (claude_jobs'
 *                                    "unreachable (last seen <time>)" row -- the forwarder's only state)
 * Local-host identity is explicit config (hosts.json "localHost"), never guessed from os.hostname().
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomic.mjs";

export const HOSTS = ["claunker", "laptop"];
// Hosts another machine may forward to. The laptop never exposes an API.
export const REMOTE_DISPATCH_TARGETS = new Set(["claunker"]);

export const configDir = () =>
  process.env.CLAUDE_ASYNC_CONFIG_DIR || path.join(os.homedir(), ".claude-async");
export const hostsFilePath = () => path.join(configDir(), "hosts.json");
export const apiConfigPath = () => path.join(configDir(), "api.json");
export const lastSeenPath = () => path.join(configDir(), "last-seen.json");

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

// Delegated to qwen2.5-coder:7b (local ollama) with the exact signature + one example; accepted
// verbatim (markdown fences stripped).
export function parseHostPrefix(jobId, hosts) {
  if (typeof jobId !== 'string') return { host: null, rest: jobId };
  const dotIndex = jobId.indexOf('.');
  if (dotIndex <= 0) return { host: null, rest: jobId };
  const prefix = jobId.substring(0, dotIndex);
  if (hosts.includes(prefix)) return { host: prefix, rest: jobId.substring(dotIndex + 1) };
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
  if (!HOSTS.includes(host)) throw new Error(`cannot mint a job id for unknown host ${JSON.stringify(host)}`);
  return `${host}.${sanitizeDescriptor(descriptor)}-${yyyymmdd(now)}-${suffix}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Returns { localHost, hosts, caps, file } or { error, file }. Never throws. Re-read on every call
// so editing hosts.json never needs a bridge restart.
export function loadHostsConfig(file = hostsFilePath()) {
  let raw;
  try { raw = readJson(file); }
  catch (e) {
    return { file, error: e.code === "ENOENT"
      ? `local host identity not configured: create ${file} with {"localHost": "claunker"|"laptop"}`
      : `could not read ${file}: ${e.message}` };
  }
  if (!HOSTS.includes(raw?.localHost)) {
    return { file, error: `${file}: "localHost" must be one of ${HOSTS.join(", ")} ` +
      `(got ${JSON.stringify(raw?.localHost)})` };
  }
  const hosts = {};
  for (const [name, entry] of Object.entries(raw.hosts || {})) {
    if (!HOSTS.includes(name)) continue; // unknown names are ignored, never routed to
    hosts[name] = { url: entry?.url, token: entry?.token };
  }
  return { file, localHost: raw.localHost, hosts, caps: raw.caps || undefined };
}

// Routing rules (design item 9):
//   local = laptop:   host claunker -> forward over Tailscale; host laptop -> local
//   local = claunker: host claunker -> local;                  host laptop  -> error
// Returns { kind: "local" } | { kind: "forward", host, url, token } | { error }.
export function resolveRoute(host, cfg) {
  if (!HOSTS.includes(host)) return { error: `unknown host ${JSON.stringify(host)} (expected one of ${HOSTS.join(", ")})` };
  if (cfg.error) return { error: cfg.error };
  if (host === cfg.localHost) return { kind: "local" };
  if (!REMOTE_DISPATCH_TARGETS.has(host)) return { error: `${host} is not a remote dispatch target` };
  const entry = cfg.hosts?.[host];
  if (!entry || !entry.url || !entry.token) {
    return { error: `host ${host} has no registry entry (url + token) in ${cfg.file}` };
  }
  return { kind: "forward", host, url: entry.url, token: entry.token };
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
