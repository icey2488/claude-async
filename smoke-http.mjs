#!/usr/bin/env node
/** smoke-http.mjs — connect over HTTP(S) and assert 3 tools. URL via CLAUDE_ASYNC_SMOKE_URL. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.CLAUDE_ASYNC_HTTP_PORT || 7842);
const url = new URL(process.env.CLAUDE_ASYNC_SMOKE_URL || `http://127.0.0.1:${PORT}/mcp`);
const client = new Client({ name: "smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(url);
let ok = false;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  ok = ["claude_check", "claude_jobs", "claude_start"].every((n) => names.includes(n));
  console.log("tools:", names.join(", "));
  console.log(ok ? "HTTP SMOKE PASS — all 3 tools present over Streamable HTTP"
                 : `HTTP SMOKE FAIL — got [${names.join(", ")}]`);
} catch (e) {
  console.log("HTTP SMOKE FAIL — " + String(e?.message || e));
}
// Exit cleanly: close the transport and let the event loop DRAIN naturally. Do NOT call
// process.exit() during teardown — on Windows that can trip a libuv async double-close
// assertion while undici sockets are still closing. Hard exit only as a last resort.
process.exitCode = ok ? 0 : 1;
try { await client.close(); } catch {}
setTimeout(() => process.exit(process.exitCode), 8000).unref();
