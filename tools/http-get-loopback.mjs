#!/usr/bin/env node
/**
 * http-get-loopback.mjs -- the one HTTP helper a safe-mode claude-async job may use to poll a local
 * service's health/status. Every profile gets it (job-core.mjs's allow rule).
 *
 * Why an explicit (port, path) ALLOWLIST, not just "loopback" (2026-11-13 review round, fix 6): a
 * bare "GET any loopback URL" rule still lets a job probe whatever happens to be listening on
 * 127.0.0.1 on this machine, which is not a fixed, reviewable surface. This script instead only
 * ever issues a GET to one of ALLOWED_TARGETS below, each pair verified against this repo's own
 * source (or documented where it could not be):
 *   - { port: 7842, path: "/healthz" } -- claude-async-http.mjs's loopback MCP bridge, the real
 *     route registered in http-bridge.mjs's createHttpApp() (`app.get("/healthz", ...)`).
 *   - { port: 11434, path: "/api/tags" } and { port: 11434, path: "/api/ps" } -- Ollama's own
 *     model-list/running-process endpoints (documented Ollama HTTP API; Ollama is an external
 *     service, so this repo's own source has nothing to verify these against beyond the fixed
 *     model-delegation port 11434 everything else in this repo already assumes, e.g.
 *     tools/ollama-generate.mjs).
 *   host-api.mjs (this repo's OTHER local service) was asked for here too, but has no health/status
 *   route of its own at all (only POST/GET routes requiring a bearer token this script deliberately
 *   never sends -- see below) and does not listen on port 4000 by anything in this repo's source
 *   (its port is api.json-configured, default 7850); it is intentionally NOT in ALLOWED_TARGETS.
 *   See the PR/job report for this discrepancy.
 *
 * Other hardening (unchanged from the original design, 2026-11-09 safe-mode-profiles ITEM 1):
 * GET only, no request body, no custom headers (so this can never carry a bearer token for a
 * service that requires one), a bounded response (aborted, not just truncated, once the cap is
 * hit), and at most MAX_REDIRECTS loopback-only hops under ONE absolute deadline (not reset per
 * hop). The actual TCP connection is always made to the LITERAL address 127.0.0.1 -- never a
 * hostname lookup, so there is no resolver (hosts-file, DNS, NetBIOS) to subvert.
 *
 * Usage: node http-get-loopback.mjs <http://127.0.0.1:<port>/<path>>
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BODY_MAX_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 3;
const ALLOWED_RESPONSE_HEADERS = ["content-type", "content-length", "location", "date", "server"];

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED: 10, TRANSPORT_FAILED: 20 });

export const ALLOWED_TARGETS = Object.freeze([
  { port: 7842, path: "/healthz" },
  { port: 11434, path: "/api/tags" },
  { port: 11434, path: "/api/ps" },
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

// Always connects to the LITERAL 127.0.0.1, regardless of what validateLoopbackUrl already
// confirmed the URL's hostname text was -- belt and suspenders against any future change that
// might loosen that check without updating this call site too.
function doRequest(u, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Settle the instant the byte cap is hit, synchronously inside the 'data' handler, then
    // destroy() purely to stop the server sending more -- destroy() with no error argument does
    // not reliably emit 'error' (confirmed empirically: waiting for it just hangs to the deadline
    // instead), and it can also surface an 'error' on `req` itself racing req's own reject() below.
    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };
    const req = http.request({ host: "127.0.0.1", port, path: u.pathname, method: "GET", timeout: timeoutMs }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        if (total >= BODY_MAX_BYTES) return;
        const take = c.subarray(0, BODY_MAX_BYTES - total);
        chunks.push(take);
        total += take.length;
        if (total >= BODY_MAX_BYTES) {
          settle(() => resolve({ res, body: Buffer.concat(chunks).toString("utf8"), truncated: true }));
          res.destroy(); // abort rather than keep draining a response past the cap
        }
      });
      res.on("end", () => settle(() => resolve({ res, body: Buffer.concat(chunks).toString("utf8"), truncated: false })));
      res.on("error", () => { /* only reachable after a deliberate destroy() above; already settled */ });
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", (e) => settle(() => reject(e)));
    req.end();
  });
}

function pickHeaders(headers) {
  const out = {};
  for (const name of ALLOWED_RESPONSE_HEADERS) if (headers[name] !== undefined) out[name] = headers[name];
  return out;
}

// allowedTargets: test seam (a function parameter, never an environment variable a job could set
// itself -- see the test file's own note on why).
export async function getLoopback(rawUrl, { timeoutMs = REQUEST_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, allowedTargets = ALLOWED_TARGETS } = {}) {
  const deadline = Date.now() + timeoutMs; // ONE absolute deadline across every hop, never reset
  const redirects = [];
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const v = validateLoopbackUrl(current, allowedTargets);
    if (v.error) return { ok: false, exitCode: EXIT.REFUSED, error: v.error, redirects };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, exitCode: EXIT.TRANSPORT_FAILED, error: `absolute deadline (${timeoutMs}ms) exceeded before this hop started`, redirects };
    let result;
    try { result = await doRequest(v.url, v.port, remaining); }
    catch (e) { return { ok: false, exitCode: EXIT.TRANSPORT_FAILED, error: e.message, redirects }; }
    const { res, body, truncated } = result;
    const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
    if (isRedirect && hop < maxRedirects) {
      let next;
      try { next = new URL(res.headers.location, v.url).toString(); } catch { next = null; }
      const nv = next ? validateLoopbackUrl(next, allowedTargets) : { error: "redirect Location is not a valid URL" };
      if (nv.error) {
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
