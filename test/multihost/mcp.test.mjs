// The MCP tool surface over a real McpServer (in-memory transport): `host` is REQUIRED by schema,
// and every tool response carries the executing hostname.
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dispatch, fakeLaunch, tickets, jobDirs, resetState, cfgFor, BIG_CAPS, cleanupTmp, TMP, writeHostsJson } from "./_setup.mjs";

const HOSTNAME = os.hostname();
let client;
let ctx = { cfg: cfgFor("claunker", { caps: BIG_CAPS }), fetch: globalThis.fetch, lastSeenFile: `${TMP}/ls.json`,
            startOptions: { launch: fakeLaunch } };

before(async () => {
  const server = new McpServer({ name: "claude-async", version: "test" });
  dispatch.registerTools(server, { getCtx: () => ctx });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "0" });
  await client.connect(b);
});
after(async () => { await client.close(); cleanupTmp(); });
beforeEach(resetState);

const call = (name, args) => client.callTool({ name, arguments: args });
const parse = (r) => JSON.parse(r.content[0].text);

test("claude_start schema: host is a required enum [claunker, laptop], no default", async () => {
  const { tools } = await client.listTools();
  const start = tools.find((t) => t.name === "claude_start");
  assert.ok(start.inputSchema.required.includes("host"));
  assert.deepEqual(start.inputSchema.properties.host.enum, ["claunker", "laptop"]);
  assert.equal(start.inputSchema.properties.host.default, undefined);
});

test("claude_start without host fails schema validation; nothing written", async () => {
  for (const args of [{ prompt: "p" }, { prompt: "p", host: "desktop" }, { prompt: "p", host: "" }, { prompt: "p", host: null }]) {
    let failed = false;
    try {
      const r = await call("claude_start", args);
      failed = r.isError === true && /host/i.test(r.content[0].text);
    } catch (e) {
      failed = /host/i.test(String(e.message));
    }
    assert.ok(failed, `expected validation failure for ${JSON.stringify(args)}`);
  }
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("claude_start / claude_check / claude_jobs all carry the executing hostname", async () => {
  const s = parse(await call("claude_start", { host: "claunker", prompt: "p", jobId: "mcp" }));
  assert.ok(!s.error, s.error);
  assert.equal(s.hostname, HOSTNAME);
  assert.match(s.jobId, /^claunker\.mcp-\d{8}-[a-z0-9]{8}$/);
  assert.equal(tickets().length, 1);
  const c = parse(await call("claude_check", { jobId: s.jobId }));
  assert.equal(c.hostname, HOSTNAME);
  assert.equal(c.host, "claunker");
  const j = parse(await call("claude_jobs", {}));
  assert.equal(j.hostname, HOSTNAME);
  assert.ok(j.jobs.length === 1 && j.jobs[0].hostname === HOSTNAME);
  // error responses too
  const e = parse(await call("claude_start", { host: "laptop", prompt: "p" }));
  assert.equal(e.error, "laptop is not a remote dispatch target");
  assert.equal(e.hostname, HOSTNAME);
  const u = parse(await call("claude_check", { jobId: "nope" }));
  assert.equal(u.hostname, HOSTNAME);
});

test("default ctx reads hosts.json from the (temp) user profile on every call", async () => {
  const saved = ctx;
  try {
    ctx = { ...dispatch.defaultCtx(), startOptions: { launch: fakeLaunch } };
    const missing = parse(await call("claude_start", { host: "claunker", prompt: "p" }));
    assert.match(missing.error, /local host identity not configured/);
    writeHostsJson({ localHost: "laptop", hosts: {} });
    ctx = { ...dispatch.defaultCtx(), startOptions: { launch: fakeLaunch } };
    const ok = parse(await call("claude_start", { host: "laptop", prompt: "p" }));
    assert.match(ok.jobId, /^laptop\./);
    const noEntry = parse(await call("claude_start", { host: "claunker", prompt: "p" }));
    assert.match(noEntry.error, /host claunker has no registry entry/);
    assert.equal(tickets().length, 1);
  } finally { ctx = saved; }
});
