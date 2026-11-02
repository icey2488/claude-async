#!/usr/bin/env node
/**
 * claude-async-http.mjs — HTTP/HTTPS entrypoint (Architecture B).
 * Stateless, loopback-only Streamable HTTP MCP server. Serves TLS when CLAUDE_ASYNC_TLS_CERT +
 * CLAUDE_ASYNC_TLS_KEY are set (else plain HTTP for local checks). Same tools/logic as the stdio
 * server. Register in the app's Connectors UI as: http://127.0.0.1:<port>/mcp
 * (this deployment runs plain HTTP — no TLS cert/key are set; see ecosystem.config.cjs)
 * Security: binds to 127.0.0.1 ONLY + DNS-rebinding protection scoped to loopback, plus opt-in
 * bearer-token auth from ~/.claude-async/http.json (see http-bridge.mjs). A host that runs
 * container jobs must turn the token on: container mode refuses to start otherwise.
 * Env: CLAUDE_ASYNC_HTTP_PORT (default 7842), CLAUDE_ASYNC_TLS_CERT, CLAUDE_ASYNC_TLS_KEY.
 *   node claude-async-http.mjs --new-token   mint a token, store its hash in http.json, print it ONCE
 *   node claude-async-http.mjs --selftest
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { runSelfTest } from "./job-core.mjs";
import { createHttpApp, newHttpToken } from "./http-bridge.mjs";
import { httpBridgeConfigPath, readHttpBridgeTokenHash } from "./container.mjs";

if (process.argv.includes("--selftest")) {
  await runSelfTest(); // exits the process
}
if (process.argv.includes("--new-token")) {
  const { token, file, error } = newHttpToken();
  if (error) { console.error(`claude-async-http: ${error}`); process.exit(1); }
  console.log(`Stored sha256 of a new token in ${file} (the token itself is not stored). Restart the bridge.`);
  console.log(`Token (shown once; give it to each client of this bridge as "Authorization: Bearer <token>"):\n${token}`);
  process.exit(0);
}

const HOST = "127.0.0.1";
const PORT = Number(process.env.CLAUDE_ASYNC_HTTP_PORT || 7842);
const tokenSha256 = readHttpBridgeTokenHash(httpBridgeConfigPath());
const app = createHttpApp({ port: PORT, tokenSha256 });

const CERT = process.env.CLAUDE_ASYNC_TLS_CERT;
const KEY = process.env.CLAUDE_ASYNC_TLS_KEY;
const useTls = Boolean(CERT && KEY);
const httpServer = useTls
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, app)
  : http.createServer(app);
const scheme = useTls ? "https" : "http";
httpServer.listen(PORT, HOST, () => {
  console.log(`claude-async-${scheme} listening on ${scheme}://${HOST}:${PORT}/mcp` +
              (tokenSha256 ? " (bearer token required)" : " (no token: unauthenticated loopback)"));
});
