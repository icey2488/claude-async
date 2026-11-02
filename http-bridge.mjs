/**
 * http-bridge.mjs — the app factory and token minting behind claude-async-http.mjs (the loopback,
 * stateless Streamable HTTP MCP bridge on 127.0.0.1:7842). Kept separate so tests can build the app
 * without the entrypoint's listen() side effect; claude-async-http.mjs stays a plain script (pm2
 * and Task Scheduler run it as-is).
 *
 * Bearer-token auth: when ~/.claude-async/http.json (CLAUDE_ASYNC_CONFIG_DIR-aware) holds
 * a "tokenSha256", every /mcp request must carry `Authorization: Bearer <token>`; anything else
 * gets a bare 401. Same scheme as host-api.mjs: only the sha256 is stored, compared in constant
 * time. Loopback alone is not a boundary on a host that runs container jobs: Docker Desktop
 * forwards host.docker.internal to the Windows host's 127.0.0.1, so a container could reach this
 * port and call claude_start with sandbox:"host". Container mode therefore refuses to start unless
 * this file exists and the running bridge answers an unauthenticated request with 401
 * (container.mjs checkHttpBridgeLocked; docs/container-jobs.md "Host loopback services").
 * Authentication is a STARTUP REQUIREMENT by default (review round 3, B1): with no valid token hash
 * the bridge refuses to start (resolveHttpBridgeAuth, exit 78). The decision used to depend on this
 * process's own CLAUDE_ASYNC_ALLOWED_SANDBOXES / CLAUDE_ASYNC_JOB_SANDBOX, so a bridge launched
 * with another config dir or without those variables while another process ran containers started
 * unauthenticated. CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1 is the explicit, loudly logged opt-out,
 * and it is refused when this process allows container mode OR the machine-wide container-mode
 * marker (container.mjs containerModeMarkerPath(), a fixed path under the user's home that container
 * preflight writes and never removes) exists.
 */
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./dispatch.mjs";
import { hashToken, tokenMatches } from "./host-api.mjs";
import { httpBridgeConfigPath, parseAllowedSandboxes, containerModeMarkerPath, containerModeMarkerPresent } from "./container.mjs";
import { writeJsonAtomic } from "./atomic.mjs";

const HOST = "127.0.0.1";

// tokenSha256: null/undefined = no auth (pre-existing behavior); otherwise every /mcp request needs
// the matching bearer token. Returns the express app (not listening).
export function createHttpApp({ port, tokenSha256 = null }) {
  const app = express();
  if (tokenSha256) {
    // Before the body parser, so an unauthenticated request is refused without reading its body.
    app.use("/mcp", (req, res, next) => {
      if (tokenMatches(req.headers.authorization, tokenSha256)) return next();
      res.writeHead(401, { "content-length": 0, connection: "close" });
      res.end();
    });
  }
  app.use(express.json({ limit: "8mb" }));

  app.post("/mcp", async (req, res) => {
    const server = new McpServer({ name: "claude-async", version: "1.0.0" });
    registerTools(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,            // stateless
      enableJsonResponse: true,                 // plain JSON responses (no SSE needed locally)
      enableDnsRebindingProtection: true,       // defense-in-depth on top of loopback bind
      allowedHosts: [`${HOST}:${port}`, `localhost:${port}`],
    });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", id: null,
          error: { code: -32603, message: String(e?.message || e) } });
      }
    }
  });

  const noSession = (_req, res) => res.status(405).json({ jsonrpc: "2.0", id: null,
    error: { code: -32000, message: "Method not allowed (stateless server)" } });
  app.get("/mcp", noSession);
  app.delete("/mcp", noSession);

  app.get("/healthz", (_req, res) => res.json({ ok: true, name: "claude-async-http", port, auth: Boolean(tokenSha256) }));
  return app;
}

// Mints a token and stores only its sha256 in http.json (mode 0600). Refuses to overwrite a file it
// cannot read as a JSON object. Returns { token, file } or { file, error }.
export function newHttpToken(file = httpBridgeConfigPath()) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) throw new Error("not a JSON object");
  } catch (e) {
    if (e.code !== "ENOENT") return { file, error: `refusing to overwrite ${file}: it exists but could not be read as a JSON object (${e.message})` };
    cur = {};
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { ...cur, tokenSha256: hashToken(token) }, { mode: 0o600 });
  return { token, file };
}

// Startup policy (see the header). Returns { tokenSha256 } (auth on), { tokenSha256: null, warning }
// (unauthenticated: only by explicit opt-out on a machine that has never run container jobs), or
// { error } (refuse to start). Review round 3 (B1): the decision must not rest on THIS process's
// environment alone, so a token is required by default, and the opt-out is refused while the
// machine-wide container-mode marker exists (containerModeMarkerPath(): a fixed path under the
// user's home, written by container preflight, independent of CLAUDE_ASYNC_CONFIG_DIR). The
// env-based refusal (this process itself allows container mode) stays as well.
export function resolveHttpBridgeAuth({ tokenSha256 = null, allowedSandboxes = process.env.CLAUDE_ASYNC_ALLOWED_SANDBOXES,
                                        sandboxDefault = process.env.CLAUDE_ASYNC_JOB_SANDBOX,
                                        allowUnauthenticated = process.env.CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED,
                                        configFile = httpBridgeConfigPath(), markerFile = containerModeMarkerPath() } = {}) {
  if (tokenSha256) return { tokenSha256 };
  const fix = `Run \`node claude-async-http.mjs --new-token\` (it writes the hash to ${configFile}; this process reads that same path, ` +
              "so CLAUDE_ASYNC_CONFIG_DIR must match the one the token was minted under), give the token to the bridge's clients " +
              "(Authorization: Bearer <token>), then restart.";
  const pol = parseAllowedSandboxes(allowedSandboxes);
  if (pol.error) return { error: `${pol.error}; refusing to start the HTTP bridge unauthenticated under an invalid sandbox policy. ${fix}` };
  const containerAllowed = pol.allowed.includes("container") || sandboxDefault === "container";
  const optedOut = allowUnauthenticated === "1";
  if (containerAllowed) {
    const optOut = optedOut ? " CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1 is set but is not honoured while container mode is allowed." : "";
    return { error: `this host allows container jobs (CLAUDE_ASYNC_ALLOWED_SANDBOXES=${JSON.stringify(allowedSandboxes ?? "")}` +
      `${sandboxDefault === "container" ? ", CLAUDE_ASYNC_JOB_SANDBOX=container" : ""}) but ${configFile} holds no valid tokenSha256, so the ` +
      "loopback HTTP MCP bridge would start UNAUTHENTICATED and a container could start host jobs through it. Refusing to start." + optOut + " " + fix };
  }
  if (containerModeMarkerPresent(markerFile)) {
    return { error: `this machine has run container jobs (the container-mode marker ${markerFile} exists), and ${configFile} holds no valid ` +
      "tokenSha256. A container can reach this loopback port through host.docker.internal and start host jobs, so the bridge never " +
      "starts unauthenticated on this machine, whatever this process's own CLAUDE_ASYNC_* environment says" +
      (optedOut ? " (CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1 is refused while the marker exists)" : "") + ". Refusing to start. " + fix +
      " The marker is removed only by hand, after container mode is turned off (docs/container-jobs.md, Rollback)." };
  }
  if (!optedOut) {
    return { error: `a bearer token is required: ${configFile} holds no valid tokenSha256. Since review round 3 the bridge no longer ` +
      "starts unauthenticated by default (a container on this machine could otherwise start host jobs through it). Refusing to start. " + fix +
      ` To run unauthenticated on a machine that has never run container jobs, set CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1 (refused once ${markerFile} exists).` };
  }
  return { tokenSha256: null, warning: `CLAUDE_ASYNC_HTTP_ALLOW_UNAUTHENTICATED=1: starting UNAUTHENTICATED by explicit opt-out. Anything that can ` +
    `reach 127.0.0.1 on this port can start host jobs. ${configFile} holds no token hash; no container-mode marker at ${markerFile}. ${fix}` };
}
