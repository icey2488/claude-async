#!/usr/bin/env node
/**
 * http-get-loopback.mjs -- the one HTTP helper a safe-mode claude-async job may use to poll a
 * local service's health (host-api.mjs on 7850, claunker-hermes's spine_server on 8848, Ollama, ...).
 *
 * Why this exists (safe-mode-profiles, 2026-11-09, ITEM 1): a broad "Invoke-WebRequest" / "curl"
 * allow rule scoped only to "loopback" can't actually express that restriction -- a prefix rule
 * matches on the literal argv text, not on what the URL resolves to, and it has no way to pin the
 * HTTP METHOD at all. `curl http://127.0.0.1:7850/* -X POST -d @payload.json` would match a prefix
 * rule just as happily as a harmless GET, and local services here (host-api.mjs, Spine) accept
 * state-changing requests. So this script is the fixed, validated action instead (same pattern as
 * scripts/publish-branch.mjs and the Ollama allow rules): GET only, loopback only, no request body,
 * no custom headers, a bounded response, and it never invokes a shell.
 *
 * What it does (and nothing else):
 *   1. Parses ONE positional URL argument. Refuses anything whose scheme is not http/https, whose
 *      hostname is not 127.0.0.1 / localhost / ::1, or that carries userinfo, a non-default port
 *      outside 0-65535, or a request body/method of any kind (there is no flag for either).
 *   2. Performs exactly one GET request with a bounded timeout. A 3xx redirect is inspected but
 *      NOT followed automatically unless its Location also resolves to loopback -- that keeps a
 *      compromised local service from using a redirect to make this script fetch (and therefore
 *      leak the response of) an arbitrary external URL on the job's behalf. At most 3 loopback-only
 *      hops.
 *   3. Prints ONE JSON object to stdout: { ok, status, statusText, headers (a fixed small allow-
 *      list of header names), body (truncated to BODY_MAX_BYTES), truncated, redirects }. Exit code
 *      0 for any completed HTTP exchange (status is the caller's own signal), nonzero only for a
 *      usage/validation refusal or a transport-level failure (DNS/connect/timeout).
 *
 * Usage: node http-get-loopback.mjs <http(s)://127.0.0.1|localhost|[::1]:<port>/path>
 */
import http from "node:http";
import https from "node:https";

export const BODY_MAX_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 3;
const ALLOWED_RESPONSE_HEADERS = ["content-type", "content-length", "location", "date", "server"];

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED: 10, TRANSPORT_FAILED: 20 });

function isLoopbackHostname(hostname) {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

// Returns { url } or { error }. Refuses anything that is not a plain loopback http(s) GET target.
export function validateLoopbackUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { error: `not a valid URL: ${JSON.stringify(raw)}` }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: `scheme must be http or https, got ${u.protocol}` };
  if (u.username || u.password) return { error: "URL must not carry userinfo (user:pass@host)" };
  if (!isLoopbackHostname(u.hostname)) return { error: `hostname must be 127.0.0.1, localhost, or ::1, got ${JSON.stringify(u.hostname)}` };
  return { url: u };
}

function doRequest(u, timeoutMs) {
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: "GET", timeout: timeoutMs }, (res) => {
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on("data", (c) => {
        if (total >= BODY_MAX_BYTES) { truncated = true; return; }
        const take = c.subarray(0, BODY_MAX_BYTES - total);
        chunks.push(take);
        total += take.length;
        if (total >= BODY_MAX_BYTES) truncated = true;
      });
      res.on("end", () => resolve({ res, body: Buffer.concat(chunks).toString("utf8"), truncated }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

function pickHeaders(headers) {
  const out = {};
  for (const name of ALLOWED_RESPONSE_HEADERS) if (headers[name] !== undefined) out[name] = headers[name];
  return out;
}

export async function getLoopback(rawUrl, { timeoutMs = REQUEST_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  const redirects = [];
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const v = validateLoopbackUrl(current);
    if (v.error) return { ok: false, exitCode: EXIT.REFUSED, error: v.error, redirects };
    let result;
    try { result = await doRequest(v.url, timeoutMs); }
    catch (e) { return { ok: false, exitCode: EXIT.TRANSPORT_FAILED, error: e.message, redirects }; }
    const { res, body, truncated } = result;
    const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
    if (isRedirect && hop < maxRedirects) {
      let next;
      try { next = new URL(res.headers.location, v.url).toString(); } catch { next = null; }
      const nv = next ? validateLoopbackUrl(next) : { error: "redirect Location is not a valid URL" };
      if (nv.error) {
        // Refuse to follow off-loopback (or malformed) redirects; report the redirect itself instead.
        return { ok: true, exitCode: EXIT.OK, status: res.statusCode, statusText: res.statusMessage,
                 headers: pickHeaders(res.headers), body, truncated, redirects,
                 warning: `redirect to ${JSON.stringify(res.headers.location)} not followed: ${nv.error}` };
      }
      redirects.push(current);
      current = next;
      continue;
    }
    return { ok: true, exitCode: EXIT.OK, status: res.statusCode, statusText: res.statusMessage,
             headers: pickHeaders(res.headers), body, truncated, redirects };
  }
}

async function cliMain(argv) {
  if (argv.length !== 1) {
    process.stdout.write(JSON.stringify({ ok: false, error: "usage: http-get-loopback.mjs <http(s)://127.0.0.1|localhost|[::1]:<port>/path>" }) + "\n");
    process.exitCode = EXIT.USAGE;
    return;
  }
  const out = await getLoopback(argv[0]);
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = out.exitCode;
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await cliMain(process.argv.slice(2));
}
