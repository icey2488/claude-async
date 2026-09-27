// Forward vs local routing over a registry-driven host list, unknown hosts (which list the known
// ones), the one-way topology as config (a host in nobody's registry is unknown), claude_check by
// prefix (old ids still local), claude_jobs' explicit unreachable row, and hostname on every response.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hosts, dispatch, api, fakeLaunch, tickets, jobDirs, resetState, cfgFor, BIG_CAPS, TOKEN, apiCfgFor,
         listenLoopback, cleanupTmp, TMP, JOBS } from "./_setup.mjs";

const HOSTNAME = os.hostname();
const lastSeenFile = path.join(TMP, "last-seen.json");
const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); cleanupTmp(); });
beforeEach(() => { resetState(); try { fs.rmSync(lastSeenFile); } catch {} });

// "Claunker" side: the real API handlers over the (shared, temp) job root.
async function claunkerApi() {
  let hits = 0;
  const server = api.createApiServer({ cfg: cfgFor("claunker", { caps: BIG_CAPS }), apiCfg: apiCfgFor(),
                                       startOptions: { launch: fakeLaunch } });
  server.on("request", () => { hits++; });
  servers.push(server);
  const url = await listenLoopback(server);
  return { server, url, hits: () => hits };
}

const ctxFor = (cfg, extra = {}) => ({ cfg: { caps: BIG_CAPS, ...cfg }, fetch: globalThis.fetch, lastSeenFile,
                                        startOptions: { launch: fakeLaunch }, ...extra });
const noFetch = () => { throw new Error("network must not be touched for a local route"); };

test("resolveRoute: the routing table", () => {
  const onLaptop = { file: "f", localHost: "laptop", hosts: { claunker: { url: "http://100.100.1.1:7850", token: "t" } } };
  const onClaunker = { file: "f", localHost: "claunker", hosts: {} };
  assert.deepEqual(hosts.resolveRoute("laptop", onLaptop), { kind: "local" });
  assert.deepEqual(hosts.resolveRoute("claunker", onLaptop),
    { kind: "forward", host: "claunker", url: "http://100.100.1.1:7850", token: "t" });
  assert.deepEqual(hosts.resolveRoute("claunker", onClaunker), { kind: "local" });
  // the one-way topology is config: the laptop is in nobody's registry, so it is simply unknown
  assert.equal(hosts.resolveRoute("laptop", onClaunker).error,
    'host "laptop" is not in f (known hosts: claunker)');
  assert.equal(hosts.resolveRoute("claunker", { file: "f", localHost: "laptop", hosts: {} }).error,
    'host "claunker" is not in f (known hosts: laptop)');
  assert.equal(hosts.resolveRoute("desktop", onLaptop).error, 'host "desktop" is not in f (known hosts: laptop, claunker)');
  assert.match(hosts.resolveRoute(undefined, onLaptop).error, /^host "undefined" is not in f \(known hosts: laptop, claunker\)$/);
  assert.match(hosts.resolveRoute("__proto__", onLaptop).error, /^host "__proto__" is not in f/);
  assert.match(hosts.resolveRoute("toString", onLaptop).error, /^host "toString" is not in f/, "inherited keys are not hosts");
  // an entry without url or token is not a dispatch target (validated configs never contain one)
  assert.match(hosts.resolveRoute("ha", { file: "f", localHost: "a", hosts: { ha: { url: "http://x" } } }).error, /is not in f/);
  assert.match(hosts.resolveRoute("claunker", { file: "f", error: "local host identity not configured: x" }).error,
    /local host identity not configured/);
});

test("three-host registry (claunker local, ha remote, laptop absent): ha forwards, laptop is unknown", async () => {
  const cfg = { file: "hosts.json", localHost: "claunker",
                hosts: { ha: { url: "http://100.100.2.2:7850", token: "tok-ha" } } };
  assert.deepEqual(hosts.resolveRoute("claunker", cfg), { kind: "local" });
  assert.deepEqual(hosts.resolveRoute("ha", cfg), { kind: "forward", host: "ha", url: "http://100.100.2.2:7850", token: "tok-ha" });
  assert.equal(hosts.resolveRoute("laptop", cfg).error, 'host "laptop" is not in hosts.json (known hosts: claunker, ha)');

  const seen = [];
  const peer = fakePeer({ jobId: "ha.j-20260926-abcdefgh", status: "running" }, { seen });
  const ctx = ctxFor(cfg, { fetch: peer });
  const r = await dispatch.dispatchStart({ host: "ha", prompt: "p" }, ctx);
  assert.equal(r.jobId, "ha.j-20260926-abcdefgh");
  assert.equal(r.host, "ha");
  assert.deepEqual(r.forwardedBy, { host: "claunker", hostname: HOSTNAME });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://100.100.2.2:7850/v1/start");
  assert.equal(seen[0].init.headers.authorization, "Bearer tok-ha");
  assert.equal(JSON.parse(seen[0].init.body).host, "ha");
  // claude_check routes an ha.* id to ha
  const chk = await dispatch.dispatchCheck("ha.j-20260926-abcdefgh", 100, ctx);
  assert.equal(chk.host, "ha");
  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /^http:\/\/100\.100\.2\.2:7850\/v1\/check\?jobId=ha\.j-20260926-abcdefgh/);

  const lap = await dispatch.dispatchStart({ host: "laptop", prompt: "p" }, ctx);
  assert.equal(lap.error, 'host "laptop" is not in hosts.json (known hosts: claunker, ha)');
  assert.equal(seen.length, 2, "an unknown host never touches the network");
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("local host = laptop, host: laptop -> runs locally, no network hop", async () => {
  const r = await dispatch.dispatchStart({ host: "laptop", prompt: "p", jobId: "fallback" },
                                         ctxFor({ file: "f", localHost: "laptop", hosts: {} }, { fetch: noFetch }));
  assert.ok(!r.error, r.error);
  assert.match(r.jobId, /^laptop\.fallback-\d{8}-[a-z0-9]{8}$/);
  assert.equal(r.hostname, HOSTNAME);
  assert.equal(r.forwardedBy, undefined);
  assert.equal(tickets().length, 1);
});

test("local host = claunker, host: claunker -> runs locally, no network hop", async () => {
  const r = await dispatch.dispatchStart({ host: "claunker", prompt: "p" },
                                         ctxFor({ file: "f", localHost: "claunker", hosts: {} }, { fetch: noFetch }));
  assert.ok(!r.error, r.error);
  assert.match(r.jobId, /^claunker\.job-\d{8}-[a-z0-9]{8}$/);
  assert.equal(r.hostname, HOSTNAME);
  assert.equal(tickets().length, 1);
});

test("local host = claunker, host: laptop -> error listing the known hosts, nothing written", async () => {
  const r = await dispatch.dispatchStart({ host: "laptop", prompt: "p" },
                                         ctxFor({ file: "f", localHost: "claunker", hosts: {} }, { fetch: noFetch }));
  assert.equal(r.error, 'host "laptop" is not in f (known hosts: claunker)');
  assert.equal(r.hostname, HOSTNAME);
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("unknown host / host absent from the registry / unconfigured local host -> errors naming the host, nothing written", async () => {
  const onLaptop = ctxFor({ file: "hosts.json", localHost: "laptop", hosts: {} }, { fetch: noFetch });
  const a = await dispatch.dispatchStart({ host: "desktop", prompt: "p" }, onLaptop);
  assert.equal(a.error, 'host "desktop" is not in hosts.json (known hosts: laptop)');
  const b = await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, onLaptop);
  assert.equal(b.error, 'host "claunker" is not in hosts.json (known hosts: laptop)');
  const c = await dispatch.dispatchStart({ host: "claunker", prompt: "p" },
                                         ctxFor(hosts.loadHostsConfig(path.join(TMP, "absent.json")), { fetch: noFetch }));
  assert.match(c.error, /local host identity not configured/);
  for (const r of [a, b, c]) assert.equal(r.hostname, HOSTNAME);
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("local host = laptop, host: claunker -> forwarded; the executing host mints the id", async () => {
  const c = await claunkerApi();
  const onLaptop = ctxFor({ file: "f", localHost: "laptop", hosts: { claunker: { url: c.url + "/", token: TOKEN } } });
  const r = await dispatch.dispatchStart({ host: "claunker", prompt: "p", jobId: "remote" }, onLaptop);
  assert.ok(!r.error, r.error);
  assert.equal(c.hits(), 1);
  assert.match(r.jobId, /^claunker\.remote-\d{8}-[a-z0-9]{8}$/);
  assert.equal(r.host, "claunker");
  assert.equal(r.hostname, HOSTNAME);
  assert.equal(r.preflight, "preflight passed, execution unverified");
  assert.deepEqual(r.forwardedBy, { host: "laptop", hostname: HOSTNAME });
  assert.equal(tickets().length, 1);
  assert.ok(JSON.parse(fs.readFileSync(lastSeenFile, "utf8")).claunker);

  // claude_check routes by prefix -> forwarded
  const chk = await dispatch.dispatchCheck(r.jobId, 100, onLaptop);
  assert.equal(c.hits(), 2);
  assert.equal(chk.status, "running");
  assert.equal(chk.host, "claunker");
  assert.equal(chk.hostname, HOSTNAME);
  assert.ok(chk.forwardedBy);

  // a remote rejection (preflight) is relayed with the executing host named
  const bad = await dispatch.dispatchStart({ host: "claunker", prompt: "p", workFolder: path.join(TMP, "nope") }, onLaptop);
  assert.match(bad.error, /^preflight failed on host claunker \(/);
  assert.equal(bad.hostname, HOSTNAME);
  assert.equal(tickets().length, 1);

  // wrong token in the registry -> clear error, nothing written remotely
  const wrong = ctxFor({ file: "f", localHost: "laptop", hosts: { claunker: { url: c.url, token: "nope" } } });
  const w = await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, wrong);
  assert.match(w.error, /rejected the registry token \(HTTP 401\)/);
  assert.equal(tickets().length, 1);
});

test("claude_check: old un-prefixed ids still checkable locally (even with no hosts.json)", async () => {
  const id = "1727300000000-a1b2c3";
  fs.mkdirSync(path.join(JOBS, id));
  fs.writeFileSync(path.join(JOBS, id, "meta.json"), JSON.stringify({ jobId: id, pid: 99999999, startedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(JOBS, id, "exit_code"), "0");
  fs.writeFileSync(path.join(JOBS, id, "out.log"), "legacy output");
  const unconfigured = ctxFor(hosts.loadHostsConfig(path.join(TMP, "absent.json")), { fetch: noFetch });
  const r = await dispatch.dispatchCheck(id, 100, unconfigured);
  assert.equal(r.status, "completed");
  assert.equal(r.stdout, "legacy output");
  assert.equal(r.hostname, HOSTNAME);
  // a descriptor that merely starts with "claunker" (no dot) is local too, not routed
  const lookalike = "claunkerfoo-20260925-abcdefgh";
  const l = await dispatch.dispatchCheck(lookalike, 100, ctxFor({ file: "f", localHost: "laptop", hosts: {} }, { fetch: noFetch }));
  assert.equal(l.error, "no such job");
  assert.equal(l.hostname, HOSTNAME);
  // a laptop.* id checked on claunker: the laptop is in no registry, so its prefix is not a known host
  const lp = await dispatch.dispatchCheck("laptop.x-20260925-abcdefgh", 100,
                                          ctxFor({ file: "f", localHost: "claunker", hosts: {} }, { fetch: noFetch }));
  assert.equal(lp.error, 'job id "laptop.x-20260925-abcdefgh" has host prefix "laptop", which is not in f (known hosts: claunker)');
  assert.equal(lp.status, "unknown");
  assert.equal(lp.host, "laptop");
  assert.equal(lp.hostname, HOSTNAME);
});

test("claude_check: an id whose prefix is not a known host is a clear error, never a silent local lookup", async () => {
  // a real job dir exists under exactly that id: a "silent local lookup" would find it
  const id = "ha.x-20260926-abcdefgh";
  fs.mkdirSync(path.join(JOBS, id));
  fs.writeFileSync(path.join(JOBS, id, "meta.json"), JSON.stringify({ jobId: id, pid: 99999999, startedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(JOBS, id, "exit_code"), "0");
  const ctx = ctxFor({ file: "hosts.json", localHost: "claunker", hosts: { laptop: { url: "http://100.1.1.1:7850", token: "t" } } },
                     { fetch: noFetch });
  const r = await dispatch.dispatchCheck(id, 100, ctx);
  assert.equal(r.error, `job id "${id}" has host prefix "ha", which is not in hosts.json (known hosts: claunker, laptop)`);
  assert.equal(r.status, "unknown");
  assert.equal(r.stdout, undefined, "the local job dir was not read");
  assert.equal(r.hostname, HOSTNAME);
  // a broken config keeps its own error rather than pretending to list hosts
  const broken = await dispatch.dispatchCheck(id, 100, ctxFor(hosts.loadHostsConfig(path.join(TMP, "absent.json")), { fetch: noFetch }));
  assert.match(broken.error, /local host identity not configured/);
});

test("claude_jobs: unreachable host is an explicit row, with last-seen time once known", async () => {
  // never reached: closed port
  const c = await claunkerApi();
  const deadUrl = c.url.replace(/:\d+$/, ":1");
  const dead = ctxFor({ file: "f", localHost: "laptop", hosts: { claunker: { url: deadUrl, token: TOKEN } } });
  await dispatch.dispatchStart({ host: "laptop", prompt: "p" }, dead);
  const j1 = await dispatch.dispatchJobs(dead);
  assert.equal(j1.hostname, HOSTNAME);
  const row = j1.jobs.find((r) => r.host === "claunker");
  assert.ok(row, "unreachable host must appear as a row");
  assert.equal(row.status, "unreachable");
  assert.equal(row.note, "unreachable (last seen never)");
  assert.equal(j1.jobs.filter((r) => r.host === "laptop").length, 1);
  assert.ok(j1.jobs.filter((r) => r.host === "laptop").every((r) => r.hostname === HOSTNAME));

  // reached once, then gone: the row carries the last-seen time
  const live = ctxFor({ file: "f", localHost: "laptop", hosts: { claunker: { url: c.url, token: TOKEN } } });
  const j2 = await dispatch.dispatchJobs(live);
  assert.ok(j2.hosts.find((h) => h.host === "claunker").reachable);
  const seen = JSON.parse(fs.readFileSync(lastSeenFile, "utf8")).claunker;
  await new Promise((r) => c.server.close(r));
  servers.splice(servers.indexOf(c.server), 1);
  const j3 = await dispatch.dispatchJobs(live);
  const row3 = j3.jobs.find((r) => r.host === "claunker");
  assert.equal(row3.note, `unreachable (last seen ${seen})`);
  assert.equal(j3.hosts.find((h) => h.host === "claunker").reachable, false);
});

test("claude_jobs aggregates remote rows tagged with host + hostname", async () => {
  const c = await claunkerApi();
  const live = ctxFor({ file: "f", localHost: "laptop", hosts: { claunker: { url: c.url, token: TOKEN } } });
  await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, live);
  const j = await dispatch.dispatchJobs(live);
  // shared temp job root in this test: the job shows up via both the local and the remote listing
  assert.ok(j.jobs.some((r) => r.host === "claunker" && r.jobId.startsWith("claunker.") && r.hostname === HOSTNAME));
  assert.ok(j.jobs.every((r) => "hostname" in r && "host" in r));
});

// ---------------------------------------------------------------------------------------------
// forward() trusts a peer only to speak the API's format: a plain JSON object.
// ---------------------------------------------------------------------------------------------

const fakePeer = (body, { status = 200, seen } = {}) => async (url, init) => {
  seen?.push({ url, init });
  return new Response(typeof body === "string" && body.startsWith("RAW:") ? body.slice(4) : JSON.stringify(body), { status });
};
const laptopCtx = (fetch) => ctxFor({ file: "f", localHost: "laptop", hosts: { claunker: { url: "http://100.100.1.1:7850", token: "t" } } }, { fetch });

for (const [label, body, got] of [
  ["an array", [{ jobId: "x" }], "an array"],
  ["null", null, "null"],
  ["a string", "hello", "a string"],
  ["a number", 42, "a number"],
  ["a boolean", true, "a boolean"],
]) {
  test(`forward(): a peer response that is ${label} is rejected as a registry-format error naming the host`, async () => {
    const start = await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, laptopCtx(fakePeer(body)));
    assert.match(start.error, /^host claunker returned a malformed response \(registry-format error\): expected a JSON object, got /);
    assert.ok(start.error.includes(`got ${got} (HTTP 200)`), start.error);
    assert.equal(start.host, "claunker");
    assert.equal(start.jobId, undefined, "nothing from the bad body leaks into the response");
    assert.equal(Object.keys(start).some((k) => /^\d+$/.test(k)), false, "an array body is not spread into indexed keys");
    const chk = await dispatch.dispatchCheck("claunker.x-20260925-abcdefgh", 100, laptopCtx(fakePeer(body)));
    assert.match(chk.error, /malformed response \(registry-format error\)/);
    const jobs = await dispatch.dispatchJobs(laptopCtx(fakePeer(body)));
    const row = jobs.jobs.find((r) => r.host === "claunker");
    assert.equal(row.status, "error");
    assert.match(row.note, /host claunker returned a malformed response \(registry-format error\)/);
    assert.equal(tickets().length, 0);
  });
}

test("forward(): a non-JSON body is still its own error, and a well-formed object still passes through", async () => {
  const notJson = await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, laptopCtx(fakePeer("RAW:<html>", { status: 502 })));
  assert.equal(notJson.error, "host claunker returned HTTP 502 with no JSON body");
  const ok = await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, laptopCtx(fakePeer({ jobId: "claunker.j-20260925-abcdefgh", status: "running" })));
  assert.equal(ok.jobId, "claunker.j-20260925-abcdefgh");
  assert.ok(!ok.error);
});

test("forward(): every forwarded call carries a request timeout (start/check 20s, list 5s)", async () => {
  assert.equal(dispatch.FORWARD_TIMEOUT_MS, 20_000);
  assert.equal(dispatch.LIST_TIMEOUT_MS, 5_000);
  const seen = [];
  const f = fakePeer({ jobs: [], status: "running" }, { seen });
  await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, laptopCtx(f));
  await dispatch.dispatchCheck("claunker.x-20260925-abcdefgh", 100, laptopCtx(f));
  await dispatch.dispatchJobs(laptopCtx(f));
  assert.equal(seen.length, 3);
  for (const { init } of seen) assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted, "an AbortSignal.timeout is attached");
  // a peer that never answers is cut off by the signal and reported as unreachable, not hung
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => realTimeout.call(AbortSignal, Math.min(ms, 50)); // same code path, test-speed clock
  try {
    const r = await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, laptopCtx(hang));
    assert.equal(r.unreachable, true);
    assert.match(r.error, /^host claunker unreachable at http:\/\/100\.100\.1\.1:7850/);
  } finally { AbortSignal.timeout = realTimeout; }
});
