#!/usr/bin/env node
/**
 * host-api.mjs — Claunker's remote dispatch API (design item 1). Runs on claunker ONLY.
 *
 *   POST /v1/start   body { host, prompt, workFolder?, jobId?, model?, effort?, intent? }
 *   GET  /v1/check?jobId=<id>&tailBytes=<n>
 *   GET  /v1/jobs
 *
 * Backed by the EXISTING local path: a start goes through dispatch.mjs's startLocal() ->
 * job-core.mjs's guarded startJob(), which writes the same launch ticket into the same queue dir
 * the MCP bridge uses; job-runner.mjs and job-launcher.mjs are untouched. It never forwards.
 *
 * Network exposure:
 *   - Binds ONLY to a Tailscale IPv4 address (100.64.0.0/10) present on a local interface. No
 *     Tailscale address at startup -> refuses to start. Never 0.0.0.0, never loopback.
 *   - Bearer-token auth on every route (checked before the body is read or anything is touched).
 *     api.json stores only sha256(token); comparison is crypto.timingSafeEqual over the digests.
 *     Failure is a bare 401 with an empty body.
 *   - Plain HTTP: the transport is Tailscale's WireGuard tunnel.
 *
 * Config (user profile, never the repo): ~/.claude-async/api.json
 *   { "port": 7850, "tokenSha256": "<64 hex>", "bindAddress": "100.x.y.z" (optional; required
 *     only if more than one Tailscale address is present) }
 * plus hosts.json's "localHost", which must be "claunker".
 *
 *   node host-api.mjs --new-token   mint a token, store its hash in api.json, print it ONCE
 *   node host-api.mjs               start the API
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkJob, listJobs } from "./job-core.mjs";
import { startLocal } from "./dispatch.mjs";
import { HOSTS, REMOTE_DISPATCH_TARGETS, loadHostsConfig, apiConfigPath, parseHostPrefix } from "./hosts.mjs";
import { DEPTH_HEADER } from "./guard.mjs";

export const DEFAULT_PORT = 7850;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultracode"]);

// 100.64.0.0/10 (RFC 6598 CGNAT space, which Tailscale assigns node addresses from): first octet
// 100, top two bits of the second octet 01 -> second octet 64..127.
export function isTailscaleIPv4(addr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(addr));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  return o[0] === 100 && (o[1] & 0xc0) === 0x40;
}

// interfaces: the shape of os.networkInterfaces() (injected in tests).
export function tailscaleAddresses(interfaces) {
  const out = [];
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      const v4 = a.family === "IPv4" || a.family === 4;
      if (v4 && !a.internal && isTailscaleIPv4(a.address)) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

// Returns { address } or { error }. Only ever yields an address that is BOTH inside 100.64.0.0/10
// AND actually present on an interface right now.
export function selectBindAddress(interfaces, configured) {
  const present = tailscaleAddresses(interfaces);
  if (present.length === 0) {
    return { error: "no Tailscale address (100.64.0.0/10) on any network interface; refusing to start " +
      "(is Tailscale installed and connected?)" };
  }
  if (configured !== undefined && configured !== null && configured !== "") {
    if (!isTailscaleIPv4(configured)) {
      return { error: `bindAddress ${JSON.stringify(configured)} is not a Tailscale address (100.64.0.0/10); refusing to start` };
    }
    if (!present.includes(configured)) {
      return { error: `bindAddress ${configured} is not present on any interface (found: ${present.join(", ")}); refusing to start` };
    }
    return { address: configured };
  }
  if (present.length > 1) {
    return { error: `multiple Tailscale addresses present (${present.join(", ")}); set "bindAddress" in api.json` };
  }
  return { address: present[0] };
}

export const hashToken = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");

// Constant-time over fixed-length sha256 digests, so neither token length nor content leaks
// through timing; a missing/garbled header still pays for one hash + one compare.
export function tokenMatches(authorizationHeader, storedHex) {
  const stored = Buffer.from(String(storedHex || ""), "hex");
  const m = /^Bearer (\S+)$/.exec(String(authorizationHeader || ""));
  const presented = Buffer.from(hashToken(m ? m[1] : ""), "hex");
  if (stored.length !== 32) { crypto.timingSafeEqual(presented, presented); return false; }
  return crypto.timingSafeEqual(presented, stored) && m !== null;
}

export function loadApiConfig(file = apiConfigPath()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    return { file, error: e.code === "ENOENT"
      ? `API config not found at ${file} (run: node host-api.mjs --new-token)` : `could not read ${file}: ${e.message}` };
  }
  if (!/^[0-9a-f]{64}$/i.test(String(raw.tokenSha256 || ""))) {
    return { file, error: `${file}: "tokenSha256" must be a 64-char hex sha256 digest (run: node host-api.mjs --new-token)` };
  }
  const port = raw.port === undefined ? DEFAULT_PORT : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { file, error: `${file}: invalid "port" ${raw.port}` };
  return { file, port, tokenSha256: raw.tokenSha256.toLowerCase(), bindAddress: raw.bindAddress };
}

const STATUS_BY_CODE = { invalid: 400, depth: 400, preflight: 422, duplicate: 409, cap_concurrent: 429,
                         cap_rate: 429, lock: 503 };

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const optStr = (v) => v === undefined || v === null || typeof v === "string";

// cfg: loadHostsConfig() result (localHost must be claunker); apiCfg: loadApiConfig() result.
// startOptions: job-core startJob seams (tests only). Returns an http.Server that is NOT listening.
export function createApiServer({ cfg, apiCfg, startOptions = {} }) {
  const localHost = cfg.localHost;
  return http.createServer(async (req, res) => {
    const hostname = os.hostname();
    if (!tokenMatches(req.headers.authorization, apiCfg.tokenSha256)) {
      res.writeHead(401, { "content-length": 0, connection: "close" });
      res.end();
      return;
    }
    try {
      const url = new URL(req.url, "http://api.invalid");
      if (req.method === "POST" && url.pathname === "/v1/start") {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch (e) { return send(res, e.status || 400, { error: e.status ? e.message : "invalid JSON body", hostname }); }
        if (!body || typeof body !== "object") return send(res, 400, { error: "invalid JSON body", hostname });
        if (body.host !== localHost) {
          return send(res, 400, { error: `this API executes on ${localHost} only (got host ${JSON.stringify(body.host)})`,
                                  host: localHost, hostname });
        }
        if (typeof body.prompt !== "string" || !body.prompt) return send(res, 400, { error: "prompt is required", hostname });
        for (const k of ["workFolder", "jobId", "model", "intent"]) {
          if (!optStr(body[k])) return send(res, 400, { error: `${k} must be a string`, hostname });
        }
        if (body.effort !== undefined && body.effort !== null && !EFFORTS.has(body.effort)) {
          return send(res, 400, { error: `invalid effort ${JSON.stringify(body.effort)}`, hostname });
        }
        const out = await startLocal(
          { prompt: body.prompt, workFolder: body.workFolder || undefined, jobId: body.jobId || undefined,
            model: body.model || undefined, effort: body.effort || undefined, intent: body.intent || undefined },
          cfg, { ...startOptions, depth: req.headers[DEPTH_HEADER] ?? "" });
        return send(res, out.error ? (STATUS_BY_CODE[out.errorCode] || 400) : 200, { ...out, hostname: out.hostname || hostname });
      }
      if (req.method === "GET" && url.pathname === "/v1/check") {
        const jobId = url.searchParams.get("jobId") || "";
        const tailBytes = Math.min(Math.max(Number(url.searchParams.get("tailBytes")) || 8000, 0), 1_000_000);
        const { host } = parseHostPrefix(jobId, HOSTS);
        if (host && host !== localHost) {
          return send(res, 404, { jobId, host, hostname, status: "unknown",
                                  error: `job ${jobId} belongs to host ${host}, not ${localHost}` });
        }
        return send(res, 200, { host: localHost, ...checkJob(jobId, tailBytes) });
      }
      if (req.method === "GET" && url.pathname === "/v1/jobs") {
        const jobs = listJobs().map((r) => ({ ...r, host: localHost, hostname }));
        return send(res, 200, { host: localHost, hostname, count: jobs.length, jobs });
      }
      return send(res, 404, { error: "not found", hostname });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String(e?.message || e), hostname });
    }
  });
}

const defaultListen = (server, port, address) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, address, () => { server.off("error", reject); resolve(); });
});

// Every refusal path returns { error } before a socket is ever opened. `listen` and `interfaces`
// are injectable so the bind logic is testable without a live Tailscale interface.
export async function startApi({ interfaces = os.networkInterfaces(), cfg = loadHostsConfig(), apiCfg = loadApiConfig(),
                                 listen = defaultListen, startOptions } = {}) {
  if (cfg.error) return { error: cfg.error };
  if (!REMOTE_DISPATCH_TARGETS.has(cfg.localHost)) {
    return { error: `the host API runs on a remote dispatch target only (${[...REMOTE_DISPATCH_TARGETS].join(", ")}); ` +
      `${cfg.file} says localHost=${cfg.localHost}` };
  }
  if (apiCfg.error) return { error: apiCfg.error };
  const sel = selectBindAddress(interfaces, apiCfg.bindAddress);
  if (sel.error) return { error: sel.error };
  if (!isTailscaleIPv4(sel.address)) return { error: `internal: refusing non-Tailscale bind ${sel.address}` };
  const server = createApiServer({ cfg, apiCfg, startOptions });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await listen(server, apiCfg.port, sel.address);
  return { server, address: sel.address, port: apiCfg.port };
}

function newToken(file = apiConfigPath()) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const token = crypto.randomBytes(32).toString("base64url");
  const next = { port: DEFAULT_PORT, ...cur, tokenSha256: hashToken(token) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return { token, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--new-token")) {
    const { token, file } = newToken();
    console.log(`Stored sha256 of a new token in ${file} (the token itself is not stored).`);
    console.log(`Token (shown once; put it in the laptop's hosts.json under hosts.claunker.token):\n${token}`);
  } else {
    const r = await startApi();
    if (r.error) { console.error(`claude-async host API: ${r.error}`); process.exit(1); }
    console.log(`claude-async host API listening on http://${r.address}:${r.port} (host ${loadHostsConfig().localHost})`);
  }
}
