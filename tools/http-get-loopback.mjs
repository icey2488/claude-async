#!/usr/bin/env node
/** Fixed loopback health GET; no redirects, absolute socket deadline and byte cap.
 * Accident protection only. Responses are not a confidentiality boundary. */
import { boundedRequest } from "./http-bounded.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BODY_MAX_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 0;
const ALLOWED_RESPONSE_HEADERS = ["content-type", "content-length", "location", "date", "server"];

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED: 10, TRANSPORT_FAILED: 20 });

export const ALLOWED_TARGETS = Object.freeze([
  { port: 7842, path: "/healthz" },
]);

// allowedTargets is a seam (tests only) -- production always uses ALLOWED_TARGETS above.
export function validateLoopbackUrl(raw, allowedTargets = ALLOWED_TARGETS) {
  let u;
  try { u = new URL(raw); } catch { return { error: `not a valid URL: ${JSON.stringify(raw)}` }; }
  if (u.protocol !== "http:") return { error: `scheme must be http, got ${u.protocol}` };
  if (u.username || u.password) return { error: "URL must not carry userinfo (user:pass@host)" };
  if (u.hostname !== "127.0.0.1") return { error: `hostname must be exactly 127.0.0.1 (no resolver dependence), got ${JSON.stringify(u.hostname)}` };
  if (u.search || u.hash) return { error: "URL must not carry a query string or fragment" };
  const port = Number(u.port || 80);
  const match = allowedTargets.find((t) => t.port === port && t.path === u.pathname);
  if (!match) {
    return { error: `${u.port || 80}${u.pathname} is not in the allowlist ` +
      `(allowed: ${allowedTargets.map((t) => `${t.port}${t.path}`).join(", ")})` };
  }
  return { url: u, port };
}

export async function getLoopback(rawUrl, { timeoutMs = REQUEST_TIMEOUT_MS, allowedTargets = ALLOWED_TARGETS } = {}) {
  const v = validateLoopbackUrl(rawUrl, allowedTargets);
  if (v.error) return { ok: false, exitCode: EXIT.REFUSED, error: v.error, redirects: [] };
  try {
    const result = await boundedRequest({ host: "127.0.0.1", port: v.port, path: v.url.pathname, deadlineMs: timeoutMs, maxBytes: BODY_MAX_BYTES });
    const headers = {};
    for (const name of ALLOWED_RESPONSE_HEADERS) if (result.headers[name] !== undefined) headers[name] = result.headers[name];
    return { ok: true, exitCode: EXIT.OK, ...result, headers, redirects: [],
      ...(result.status >= 300 && result.status < 400 ? { warning: "redirect not followed" } : {}) };
  } catch (e) { return { ok: false, exitCode: EXIT.TRANSPORT_FAILED, error: e.message, redirects: [] }; }
}

async function cliMain(argv) {
  if (argv.length !== 1) {
    process.stdout.write(JSON.stringify({ ok: false, error: "usage: http-get-loopback.mjs <http://127.0.0.1:<port>/<path>>" }) + "\n");
    process.exitCode = EXIT.USAGE;
    return;
  }
  const out = await getLoopback(argv[0]);
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = out.exitCode;
}

// path.resolve() on both sides (fix 6, 2026-11-13 review round): process.argv[1] can be a relative
// or forward-slash path (job-core.mjs's own allow rule admits both path-separator spellings, and a
// job's shell may invoke this script either way) while fileURLToPath() always returns an absolute,
// backslash-style Windows path -- a bare `===` between them silently fails whenever argv[1] isn't
// already in that exact absolute-backslash form, which made this script exit 0 with NO output
// (cliMain never ran) when invoked with forward slashes.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cliMain(process.argv.slice(2));
}
