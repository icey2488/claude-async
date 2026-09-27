// The MCP tool surface over a real McpServer (in-memory transport): `host` is a REQUIRED enum
// built from the registry at startup, routing re-validates against the live hosts.json on every
// call, and every tool response carries the executing hostname.
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dispatch, hosts, fakeLaunch, tickets, jobDirs, resetState, cfgFor, BIG_CAPS, cleanupTmp, TMP, writeHostsJson } from "./_setup.mjs";

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

// A second bridge over its own in-memory transport (its tool schema is built when it registers).
const extra = [];
async function bridge(getCtx) {
  const server = new McpServer({ name: "claude-async", version: "test" });
  dispatch.registerTools(server, { getCtx });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "t2", version: "0" });
  await c.connect(b);
  extra.push(c);
  return { client: c, call: (name, args) => c.callTool({ name, arguments: args }),
           hostSchema: async () => (await c.listTools()).tools.find((t) => t.name === "claude_start").inputSchema.properties.host };
}
after(async () => { for (const c of extra) await c.close(); });
const noFetch = () => { throw new Error("network must not be touched"); };
const liveCtx = (fetch = noFetch) => ({ ...dispatch.defaultCtx(), fetch, startOptions: { launch: fakeLaunch } });
const ENTRY = (n) => ({ url: `http://100.100.1.${n}:7850`, token: `tok-${n}` });

test("claude_start schema: host is a required enum built from the registry (here: just this machine), no default", async () => {
  const { tools } = await client.listTools();
  const start = tools.find((t) => t.name === "claude_start");
  assert.ok(start.inputSchema.required.includes("host"));
  assert.deepEqual(start.inputSchema.properties.host.enum, ["claunker"]);
  assert.equal(start.inputSchema.properties.host.default, undefined);
});

test("host enum: built from a hosts.json with three names; the description lists them and how to add one", async () => {
  writeHostsJson({ localHost: "claunker", hosts: { ha: ENTRY(2), desk: ENTRY(3) } });
  const b = await bridge(() => liveCtx());
  const host = await b.hostSchema();
  assert.deepEqual(host.enum, ["claunker", "ha", "desk"]);
  for (const name of ["claunker", "ha", "desk"]) assert.ok(host.description.includes(name), `description lists ${name}`);
  assert.match(host.description, /REQUIRED/);
  assert.match(host.description, /this machine is claunker/);
  assert.match(host.description, /edit hosts\.json and restart the bridge/);
  const start = (await b.client.listTools()).tools.find((t) => t.name === "claude_start");
  assert.ok(start.inputSchema.required.includes("host"));
  // the client-side enum rejects a name that is not in the registry, before anything runs
  for (const bad of ["laptop", "HA", "ha.x", ""]) {
    let failed = false;
    try { const r = await b.call("claude_start", { host: bad, prompt: "p" }); failed = r.isError === true && /host/i.test(r.content[0].text); }
    catch (e) { failed = /host/i.test(String(e.message)); }
    assert.ok(failed, `host ${JSON.stringify(bad)} must fail schema validation`);
  }
  assert.equal(tickets().length, 0);
});

test("host enum: an unusable hosts.json at startup degrades to a string; every start then names the file and field", async () => {
  writeHostsJson({ localHost: "Claunker", hosts: {} });
  const b = await bridge(() => liveCtx());
  const host = await b.hostSchema();
  assert.equal(host.type, "string");
  assert.equal(host.enum, undefined);
  assert.match(host.description, /"localHost"/);
  const r = parse(await b.call("claude_start", { host: "claunker", prompt: "p" }));
  assert.match(r.error, /hosts\.json: "localHost" must be lowercase/);
  assert.equal(tickets().length, 0);
  // fixed on disk: routing works again with no restart (the schema stays a string)
  writeHostsJson({ localHost: "claunker" });
  const ok = parse(await b.call("claude_start", { host: "claunker", prompt: "p" }));
  assert.match(ok.jobId, /^claunker\./);
});

test("per-call validation: a host removed from hosts.json after startup is refused clearly, no ticket, no network", async () => {
  writeHostsJson({ localHost: "claunker", hosts: { ha: ENTRY(2), desk: ENTRY(3) } });
  const b = await bridge(() => liveCtx());
  assert.deepEqual((await b.hostSchema()).enum, ["claunker", "ha", "desk"]);
  // registry edited while the bridge runs: ha removed, and a new host added
  writeHostsJson({ localHost: "claunker", hosts: { desk: ENTRY(3), newbox: ENTRY(4) } });
  assert.deepEqual((await b.hostSchema()).enum, ["claunker", "ha", "desk"], "the advertised enum is stale until restart");
  const gone = parse(await b.call("claude_start", { host: "ha", prompt: "p" }));
  assert.match(gone.error, /^host "ha" is not in .*hosts\.json \(known hosts: claunker, desk, newbox\)$/);
  assert.equal(gone.hostname, HOSTNAME);
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
  // claude_check on an id from the removed host is a clear error too
  const chk = parse(await b.call("claude_check", { jobId: "ha.x-20260926-abcdefgh" }));
  assert.match(chk.error, /has host prefix "ha", which is not in .*hosts\.json \(known hosts: claunker, desk, newbox\)/);
  // a host that is still listed still works (local here)
  const still = parse(await b.call("claude_start", { host: "claunker", prompt: "p" }));
  assert.match(still.jobId, /^claunker\./);
  assert.equal(tickets().length, 1);
  // a host added after startup is not in the stale enum: the client-side schema refuses it until restart
  let failed = false;
  try { const r = await b.call("claude_start", { host: "newbox", prompt: "p" }); failed = r.isError === true && /host/i.test(r.content[0].text); }
  catch (e) { failed = /host/i.test(String(e.message)); }
  assert.ok(failed, "newbox needs a bridge restart to appear in the enum");
  assert.equal(tickets().length, 1);
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
  const e = parse(await call("claude_check", { jobId: "laptop.x-20260926-abcdefgh" }));
  assert.match(e.error, /has host prefix "laptop", which is not in .*\(known hosts: claunker\)/);
  assert.equal(e.hostname, HOSTNAME);
  const u = parse(await call("claude_check", { jobId: "nope" }));
  assert.equal(u.hostname, HOSTNAME);
});

test("default ctx reads hosts.json from the (temp) user profile on every call", async () => {
  fs.rmSync(hosts.hostsFilePath(), { force: true });
  const b = await bridge(() => liveCtx()); // registered while hosts.json is missing: host is a plain string
  const missing = parse(await b.call("claude_start", { host: "claunker", prompt: "p" }));
  assert.match(missing.error, /local host identity not configured/);
  writeHostsJson({ localHost: "laptop", hosts: {} });
  const ok = parse(await b.call("claude_start", { host: "laptop", prompt: "p" }));
  assert.match(ok.jobId, /^laptop\./);
  const noEntry = parse(await b.call("claude_start", { host: "claunker", prompt: "p" }));
  assert.match(noEntry.error, /^host "claunker" is not in .*hosts\.json \(known hosts: laptop\)$/);
  assert.equal(tickets().length, 1);
});
