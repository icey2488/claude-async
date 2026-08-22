#!/usr/bin/env node
/**
 * claude-async-http.mjs — HTTP/HTTPS entrypoint (Architecture B).
 * Stateless, loopback-only Streamable HTTP MCP server. Serves TLS when CLAUDE_ASYNC_TLS_CERT +
 * CLAUDE_ASYNC_TLS_KEY are set (else plain HTTP for local checks). Same tools/logic as the stdio
 * server. Register in the app's Connectors UI as: http://127.0.0.1:<port>/mcp
 * (this deployment runs plain HTTP — no TLS cert/key are set; see ecosystem.config.cjs)
 * Security: binds to 127.0.0.1 ONLY + DNS-rebinding protection scoped to loopback.
 * Env: CLAUDE_ASYNC_HTTP_PORT (default 7842), CLAUDE_ASYNC_TLS_CERT, CLAUDE_ASYNC_TLS_KEY.
 * Self-test: node claude-async-http.mjs --selftest
 */
import express from "express";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, runSelfTest } from "./job-core.mjs";

if (process.argv.includes("--selftest")) {
  await runSelfTest(); // exits the process
}

const HOST = "127.0.0.1";
const PORT = Number(process.env.CLAUDE_ASYNC_HTTP_PORT || 7842);

const app = express();
app.use(express.json({ limit: "8mb" }));

app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "claude-async", version: "1.0.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,            // stateless
    enableJsonResponse: true,                 // plain JSON responses (no SSE needed locally)
    enableDnsRebindingProtection: true,       // defense-in-depth on top of loopback bind
    allowedHosts: [`${HOST}:${PORT}`, `localhost:${PORT}`],
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

app.get("/healthz", (_req, res) => res.json({ ok: true, name: "claude-async-http", port: PORT }));

const CERT = process.env.CLAUDE_ASYNC_TLS_CERT;
const KEY = process.env.CLAUDE_ASYNC_TLS_KEY;
const useTls = Boolean(CERT && KEY);
const httpServer = useTls
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, app)
  : http.createServer(app);
const scheme = useTls ? "https" : "http";
httpServer.listen(PORT, HOST, () => {
  console.log(`claude-async-${scheme} listening on ${scheme}://${HOST}:${PORT}/mcp`);
});
