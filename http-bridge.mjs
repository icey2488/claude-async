/**
 * http-bridge.mjs — the app factory and token minting behind claude-async-http.mjs (the loopback,
 * stateless Streamable HTTP MCP bridge on 127.0.0.1:7842). Kept separate so tests can build the app
 * without the entrypoint's listen() side effect; claude-async-http.mjs stays a plain script (pm2
 * and Task Scheduler run it as-is).
 *
 * Bearer-token auth (opt-in): when ~/.claude-async/http.json (CLAUDE_ASYNC_CONFIG_DIR-aware) holds
 * a "tokenSha256", every /mcp request must carry `Authorization: Bearer <token>`; anything else
 * gets a bare 401. Same scheme as host-api.mjs: only the sha256 is stored, compared in constant
 * time. Loopback alone is not a boundary on a host that runs container jobs: Docker Desktop
 * forwards host.docker.internal to the Windows host's 127.0.0.1, so a container could reach this
 * port and call claude_start with sandbox:"host". Container mode therefore refuses to start unless
 * this file exists and the running bridge answers an unauthenticated request with 401
 * (container.mjs checkHttpBridgeLocked; docs/container-jobs.md "Host loopback services").
 * Without the file the bridge behaves exactly as before, so an existing client that cannot send a
 * header keeps working on hosts that don't run container jobs.
 */
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./dispatch.mjs";
import { hashToken, tokenMatches } from "./host-api.mjs";
import { httpBridgeConfigPath } from "./container.mjs";
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
