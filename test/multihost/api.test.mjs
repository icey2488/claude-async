// host-api.mjs: Tailscale-only bind (injected interface lists; no live Tailscale needed), bearer
// auth (bad/missing token -> 401 AND nothing written), and the start/check/list handlers.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { api, hosts, fakeLaunch, tickets, jobDirs, readTicket, resetState, cfgFor, BIG_CAPS, TOKEN, apiCfgFor,
         listenLoopback, cleanupTmp, TMP } from "./_setup.mjs";

const HOSTNAME = os.hostname();
const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); cleanupTmp(); });
beforeEach(resetState);

const iface = (address, extra = {}) => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", ...extra });
const NON_TAILSCALE = {
  Loopback: [iface("127.0.0.1", { internal: true }), { address: "::1", family: "IPv6", internal: true }],
  Ethernet: [iface("192.168.1.92"), { address: "fe80::1", family: "IPv6", internal: false }],
  Weird: [iface("0.0.0.0"), iface("100.63.255.255"), iface("100.128.0.1"), iface("10.0.0.5")],
};
const WITH_TAILSCALE = { ...NON_TAILSCALE, Tailscale: [iface("100.101.102.103"),
                                                       { address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false }] };

test("isTailscaleIPv4: exactly 100.64.0.0/10", () => {
  for (const a of ["100.64.0.0", "100.64.0.1", "100.101.102.103", "100.127.255.255"]) assert.ok(api.isTailscaleIPv4(a), a);
  for (const a of ["100.63.255.255", "100.128.0.0", "0.0.0.0", "127.0.0.1", "192.168.1.92", "10.0.0.1", "::1",
                   "localhost", "", "100.64.0.256", "100.64.0", "1100.64.0.1", " 100.64.0.1"]) {
    assert.ok(!api.isTailscaleIPv4(a), a);
  }
});

test("selectBindAddress: refuses with no Tailscale address present", () => {
  assert.match(api.selectBindAddress({}, undefined).error, /no Tailscale address \(100\.64\.0\.0\/10\).*refusing to start/);
  assert.match(api.selectBindAddress(NON_TAILSCALE, undefined).error, /no Tailscale address/);
  // a Tailscale-range address on an INTERNAL interface doesn't count
  assert.match(api.selectBindAddress({ x: [iface("100.64.0.9", { internal: true })] }).error, /no Tailscale address/);
  // even an explicit config can't bind when no Tailscale address is up
  assert.match(api.selectBindAddress(NON_TAILSCALE, "100.101.102.103").error, /no Tailscale address/);
});

test("selectBindAddress: refuses non-Tailscale configured addresses, incl. 0.0.0.0 and loopback", () => {
  for (const bad of ["0.0.0.0", "127.0.0.1", "localhost", "::", "192.168.1.92", "100.128.0.1"]) {
    assert.match(api.selectBindAddress(WITH_TAILSCALE, bad).error, /is not a Tailscale address .*refusing to start/, bad);
  }
  assert.match(api.selectBindAddress(WITH_TAILSCALE, "100.64.9.9").error, /not present on any interface/);
});

test("selectBindAddress: picks the single Tailscale address; ambiguity needs explicit config", () => {
  assert.deepEqual(api.selectBindAddress(WITH_TAILSCALE, undefined), { address: "100.101.102.103" });
  assert.deepEqual(api.selectBindAddress(WITH_TAILSCALE, "100.101.102.103"), { address: "100.101.102.103" });
  const two = { ...WITH_TAILSCALE, Other: [iface("100.70.0.1")] };
  assert.match(api.selectBindAddress(two, undefined).error, /multiple Tailscale addresses/);
  assert.deepEqual(api.selectBindAddress(two, "100.70.0.1"), { address: "100.70.0.1" });
});

test("startApi: every refusal happens before any listen; success listens on the Tailscale address only", async () => {
  const calls = [];
  const listen = async (server, port, address) => { calls.push({ port, address }); };
  const good = { cfg: cfgFor("claunker", { receiver: true }), apiCfg: { ...apiCfgFor(), port: 7850 }, listen };
  assert.match((await api.startApi({ ...good, interfaces: NON_TAILSCALE })).error, /no Tailscale address/);
  assert.match((await api.startApi({ ...good, interfaces: WITH_TAILSCALE, apiCfg: { ...good.apiCfg, bindAddress: "0.0.0.0" } })).error,
    /not a Tailscale address/);
  assert.match((await api.startApi({ ...good, interfaces: WITH_TAILSCALE, cfg: cfgFor("laptop") })).error,
    /not a receiver: set "receiver": true in \(test hosts\.json\)/);
  assert.match((await api.startApi({ ...good, interfaces: WITH_TAILSCALE, cfg: { file: "f", error: "local host identity not configured" } })).error,
    /local host identity not configured/);
  assert.match((await api.startApi({ ...good, interfaces: WITH_TAILSCALE, apiCfg: { error: "API config not found" } })).error,
    /API config not found/);
  assert.equal(calls.length, 0, "no refusal path may reach listen()");
  const ok = await api.startApi({ ...good, interfaces: WITH_TAILSCALE });
  assert.ok(!ok.error, ok.error);
  assert.deepEqual(calls, [{ port: 7850, address: "100.101.102.103" }]);
});

test("receiver gate: startApi requires receiver === true, whatever the host is called", async () => {
  const calls = [];
  const listen = async (server, port, address) => { calls.push({ port, address }); };
  const base = { apiCfg: { ...apiCfgFor(), port: 7850 }, listen, interfaces: WITH_TAILSCALE };
  // absent, false, and anything not the boolean true: refused, naming the field, before any listen
  for (const receiver of [undefined, false, null, "true", 1, "yes"]) {
    for (const localHost of ["claunker", "ha", "laptop"]) {
      const r = await api.startApi({ ...base, cfg: cfgFor(localHost, receiver === undefined ? {} : { receiver }) });
      assert.match(r.error, /"receiver": true/, `${localHost} receiver=${String(receiver)}`);
      assert.match(r.error, new RegExp(`localHost=${localHost}`));
      assert.equal(r.server, undefined);
    }
  }
  assert.equal(calls.length, 0, "no refusal path may reach listen()");
  // receiver: true starts, on any valid host name (the gate is the field, not a hard-coded name)
  for (const localHost of ["claunker", "ha"]) {
    const ok = await api.startApi({ ...base, cfg: cfgFor(localHost, { receiver: true }) });
    assert.ok(!ok.error, ok.error);
    assert.equal(ok.address, "100.101.102.103");
  }
  assert.equal(calls.length, 2);
});

test("receiver gate end to end: a real hosts.json without / with receiver: true", async () => {
  const f = path.join(TMP, "receiver-hosts.json");
  const listen = async () => {};
  const start = async (obj) => {
    fs.writeFileSync(f, JSON.stringify(obj));
    return api.startApi({ cfg: hosts.loadHostsConfig(f), apiCfg: { ...apiCfgFor(), port: 7850 }, listen, interfaces: WITH_TAILSCALE });
  };
  assert.match((await start({ localHost: "ha" })).error, /not a receiver: set "receiver": true in .*receiver-hosts\.json/);
  assert.match((await start({ localHost: "ha", receiver: false })).error, /not a receiver/);
  assert.match((await start({ localHost: "ha", receiver: "true" })).error, /"receiver" must be true or false/);
  const ok = await start({ localHost: "ha", receiver: true });
  assert.ok(!ok.error, ok.error);
});

test("api.json holds only a sha256 hash; plaintext/garbage is refused", () => {
  const f = path.join(TMP, "api.json");
  fs.writeFileSync(f, JSON.stringify({ token: TOKEN }));
  assert.match(api.loadApiConfig(f).error, /tokenSha256/);
  fs.writeFileSync(f, JSON.stringify({ tokenSha256: TOKEN }));
  assert.match(api.loadApiConfig(f).error, /tokenSha256/);
  fs.writeFileSync(f, JSON.stringify({ tokenSha256: api.hashToken(TOKEN) }));
  assert.deepEqual(api.loadApiConfig(f), { file: f, port: 7850, tokenSha256: api.hashToken(TOKEN), bindAddress: undefined });
  assert.match(api.loadApiConfig(path.join(TMP, "none.json")).error, /API config not found/);
  assert.equal(api.hashToken(TOKEN).length, 64);
});

test("tokenMatches: exact bearer token only", () => {
  const h = api.hashToken(TOKEN);
  assert.ok(api.tokenMatches(`Bearer ${TOKEN}`, h));
  for (const hdr of [undefined, "", "Bearer", "Bearer ", `bearer ${TOKEN}`, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`,
                     `Bearer ${TOKEN.slice(0, -1)}`, `Bearer  ${TOKEN}`, TOKEN, `Bearer ${h}`]) {
    assert.equal(api.tokenMatches(hdr, h), false, String(hdr));
  }
  assert.equal(api.tokenMatches("Bearer ", api.hashToken("")), false, "empty token never authenticates");
  assert.equal(api.tokenMatches(`Bearer ${TOKEN}`, "abc"), false, "malformed stored hash never authenticates");
});

async function apiServer(cfgExtra = {}) {
  const server = api.createApiServer({ cfg: cfgFor("claunker", { caps: BIG_CAPS, ...cfgExtra }), apiCfg: apiCfgFor(),
                                       startOptions: { launch: fakeLaunch } });
  servers.push(server);
  return listenLoopback(server);
}
const startBody = (extra = {}) => JSON.stringify({ host: "claunker", prompt: "p", ...extra });

test("bad or missing token -> bare 401 AND no ticket, no job dir (every route)", async () => {
  const url = await apiServer();
  const attempts = [
    { path: "/v1/start", method: "POST", headers: {} },
    { path: "/v1/start", method: "POST", headers: { authorization: "Bearer wrong" } },
    { path: "/v1/start", method: "POST", headers: { authorization: `Basic ${TOKEN}` } },
    { path: "/v1/start", method: "POST", headers: { authorization: `Bearer ${api.hashToken(TOKEN)}` } },
    { path: "/v1/jobs", method: "GET", headers: {} },
    { path: "/v1/check?jobId=x", method: "GET", headers: { authorization: "Bearer wrong" } },
    { path: "/nope", method: "GET", headers: {} },
  ];
  for (const a of attempts) {
    const res = await fetch(url + a.path, { method: a.method, headers: { "content-type": "application/json", ...a.headers },
                                            body: a.method === "POST" ? startBody() : undefined });
    assert.equal(res.status, 401, `${a.method} ${a.path}`);
    assert.equal(await res.text(), "", "401 carries no detail");
    assert.equal(res.headers.get("www-authenticate"), null);
  }
  assert.equal(tickets().length, 0, "no ticket may be written without a valid token");
  assert.equal(jobDirs().length, 0, "no job dir may be created without a valid token");
});

test("valid token: start writes exactly one ticket; check + list work; hostname on every response", async () => {
  const url = await apiServer();
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const res = await fetch(url + "/v1/start", { method: "POST", headers: auth, body: startBody({ jobId: "api" }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.jobId, /^claunker\.api-\d{8}-[a-z0-9]{8}$/);
  assert.equal(body.hostname, HOSTNAME);
  assert.equal(body.host, "claunker");
  assert.equal(body.preflight, "preflight passed, execution unverified");
  assert.deepEqual(tickets(), [`${body.jobId}.json`]);
  assert.equal(readTicket(body.jobId).envOverrides.CLAUDE_ASYNC_DEPTH, "1");

  const chk = await (await fetch(`${url}/v1/check?jobId=${encodeURIComponent(body.jobId)}`, { headers: auth })).json();
  assert.equal(chk.status, "running");
  assert.equal(chk.hostname, HOSTNAME);
  const list = await (await fetch(url + "/v1/jobs", { headers: auth })).json();
  assert.equal(list.hostname, HOSTNAME);
  assert.equal(list.count, 1);
  assert.ok(list.jobs.every((r) => r.hostname === HOSTNAME && r.host === "claunker"));

  const unknown = await (await fetch(`${url}/v1/check?jobId=nope`, { headers: auth })).json();
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.hostname, HOSTNAME);
  const trav = await (await fetch(`${url}/v1/check?jobId=${encodeURIComponent("../jobs")}`, { headers: auth })).json();
  assert.equal(trav.error, "invalid jobId");
  const other = await fetch(`${url}/v1/check?jobId=laptop.x-20260925-abcdefgh`, { headers: auth });
  assert.equal(other.status, 404);
  assert.equal((await other.json()).hostname, HOSTNAME);
  const nf = await fetch(url + "/v1/nope", { headers: auth });
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).hostname, HOSTNAME);
});

test("API rejections write nothing: wrong host, bad body, depth, caps (429), preflight (422)", async () => {
  const url = await apiServer({ caps: { maxConcurrent: 1, maxStartsPerMinute: 100 } });
  const post = async (body, headers = {}) => {
    const res = await fetch(url + "/v1/start", { method: "POST", body,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers } });
    return { status: res.status, body: await res.json() };
  };
  const cases = [
    [await post(startBody({ host: "laptop" })), 400, /this API executes on claunker only/],
    [await post(JSON.stringify({ prompt: "p" })), 400, /this API executes on claunker only/],
    [await post("{not json"), 400, /invalid JSON body/],
    [await post(startBody({ prompt: "" })), 400, /prompt is required/],
    [await post(startBody({ effort: "turbo" })), 400, /invalid effort/],
    [await post(startBody({ workFolder: 5 })), 400, /workFolder must be a string/],
    [await post(startBody(), { "x-claude-async-depth": "2" }), 400, /dispatch depth 2 exceeds 1/],
    [await post(startBody({ workFolder: path.join(TMP, "nope") })), 422, /^preflight failed on host claunker/],
  ];
  for (const [r, status, re] of cases) {
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.error, re);
    assert.equal(r.body.hostname, HOSTNAME);
  }
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
  const ok = await post(startBody(), { "x-claude-async-depth": "1" });
  assert.equal(ok.status, 200);
  assert.equal(readTicket(ok.body.jobId).envOverrides.CLAUDE_ASYNC_DEPTH, "2");
  const capped = await post(startBody());
  assert.equal(capped.status, 429);
  assert.match(capped.body.error, /cap exceeded on host claunker/);
  assert.equal(tickets().length, 1);
});

// --new-token must never clobber an api.json it cannot read: rewriting would drop a custom port /
// bindAddress. Only a MISSING file starts fresh.
test("newToken: a missing api.json is created (default port, hash only, token not stored)", () => {
  const f = path.join(TMP, "nt-missing", "api.json");
  const r = api.newToken(f);
  assert.equal(r.error, undefined);
  assert.equal(r.file, f);
  const stored = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(stored, { port: api.DEFAULT_PORT, tokenSha256: api.hashToken(r.token) });
  assert.ok(!fs.readFileSync(f, "utf8").includes(r.token));
});

test("newToken: a valid api.json keeps its custom port and bindAddress and gets a new hash", () => {
  const f = path.join(TMP, "nt-valid.json");
  const old = api.hashToken("old-token");
  fs.writeFileSync(f, JSON.stringify({ port: 9001, bindAddress: "100.101.102.103", tokenSha256: old }));
  const r = api.newToken(f);
  assert.equal(r.error, undefined);
  const stored = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(stored.port, 9001);
  assert.equal(stored.bindAddress, "100.101.102.103");
  assert.equal(stored.tokenSha256, api.hashToken(r.token));
  assert.notEqual(stored.tokenSha256, old);
});

for (const [label, content] of [["garbage", "{{ not json"], ["truncated", '{"port": 9001, "bindAddr'], ["empty", ""],
                                ["JSON null", "null"], ["a JSON array", "[]"], ["a JSON string", '"x"']]) {
  test(`newToken: an existing api.json that is ${label} is refused, named in the error, and left byte-for-byte untouched`, () => {
    const f = path.join(TMP, `nt-corrupt-${label.replace(/\W+/g, "-")}.json`);
    fs.writeFileSync(f, content);
    const r = api.newToken(f);
    assert.equal(r.token, undefined, "no token is minted");
    assert.match(r.error, /^refusing to overwrite /);
    assert.ok(r.error.includes(f), "the error names the file");
    assert.equal(fs.readFileSync(f, "utf8"), content);
    assert.deepEqual(fs.readdirSync(TMP).filter((n) => n.startsWith(path.basename(f)) && n.endsWith(".tmp")), []);
  });
}

test("a receiver named ha: mints ha.* ids, accepts host ha only, and 404s another host's ids on check", async () => {
  const server = api.createApiServer({ cfg: cfgFor("ha", { caps: BIG_CAPS, receiver: true }), apiCfg: apiCfgFor(),
                                       startOptions: { launch: fakeLaunch } });
  servers.push(server);
  const url = await listenLoopback(server);
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = async (body) => {
    const res = await fetch(url + "/v1/start", { method: "POST", headers: auth, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const wrong = await post({ host: "claunker", prompt: "p" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /this API executes on ha only \(got host "claunker"\)/);
  assert.equal(tickets().length, 0);
  const good = await post({ host: "ha", prompt: "p", jobId: "on-ha" });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.match(good.body.jobId, /^ha\.on-ha-\d{8}-[a-z0-9]{8}$/);
  assert.equal(good.body.host, "ha");
  assert.equal(tickets().length, 1);
  const own = await (await fetch(`${url}/v1/check?jobId=${encodeURIComponent(good.body.jobId)}`, { headers: auth })).json();
  assert.equal(own.status, "running");
  assert.equal(own.host, "ha");
  const foreign = await fetch(`${url}/v1/check?jobId=claunker.x-20260926-abcdefgh`, { headers: auth });
  assert.equal(foreign.status, 404);
  assert.match((await foreign.json()).error, /belongs to host claunker, not ha/);
});
