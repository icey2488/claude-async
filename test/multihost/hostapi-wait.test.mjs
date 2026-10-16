// host-api.mjs: runHostApi()'s startup wait, bind-loss rebind, EADDRINUSE handling, and the
// CLAUDE_ASYNC_HOSTAPI_TAILNET_WAIT_MS timeout path. All of this is exercised with injected
// interfaces/listen/sleep/now/log -- no real Tailscale, no real sockets, and no real waiting:
// `sleep` advances a fake clock and yields via setImmediate (so a tight retry loop can never
// starve the real timers the tests themselves use to flip the fake interfaces mid-run).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api, cfgFor, apiCfgFor } from "./_setup.mjs";

const iface = (address, extra = {}) => ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", ...extra });
const NO_TAILSCALE = { Ethernet: [iface("192.168.1.92"), iface("127.0.0.1", { internal: true })] };
const WITH_TAILSCALE = { Tailscale: [iface("100.101.102.103")], ...NO_TAILSCALE };

const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); });

function fakeClock() {
  let elapsed = 0;
  const sleep = (ms) => { elapsed += ms; return new Promise((r) => setImmediate(r)); };
  const now = () => elapsed;
  return { sleep, now };
}

async function waitUntil(pred, timeoutMs = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const baseOpts = () => ({ cfg: cfgFor("claunker", { receiver: true }), apiCfg: { ...apiCfgFor(), port: 7850 } });

test("runHostApi: no Tailscale address at startup -> waits, logs once, binds once the address appears", async () => {
  let ifaces = NO_TAILSCALE;
  const calls = [];
  const logs = [];
  const { sleep, now } = fakeClock();
  const listen = async (server, port, address) => { calls.push({ port, address }); };
  const resultPromise = api.runHostApi({
    ...baseOpts(), getInterfaces: () => ifaces, listen, sleep, now, log: (l) => logs.push(l), maxWaitMs: 0,
  });

  await waitUntil(() => logs.some((l) => l.includes("waiting for Tailscale address")));
  assert.equal(calls.length, 0, "must not bind before an address is present");
  ifaces = WITH_TAILSCALE;

  const result = await resultPromise;
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.address, "100.101.102.103");
  servers.push(result.server);

  assert.deepEqual(calls, [{ port: 7850, address: "100.101.102.103" }]);
  assert.ok(calls.every((c) => api.isTailscaleIPv4(c.address)), "every listen() call must use a Tailscale address");
  assert.equal(logs.filter((l) => l.includes("waiting for Tailscale address...")).length, 1);
  assert.ok(logs.some((l) => l.includes("is up; bound to 100.101.102.103:7850")));
});

test("runHostApi: bind loss (listener error) closes the server and rebinds once the address returns", async () => {
  let ifaces = WITH_TAILSCALE;
  const calls = [];
  const logs = [];
  const { sleep, now } = fakeClock();
  const listen = async (server, port, address) => { calls.push({ port, address }); };
  const result = await api.runHostApi({
    ...baseOpts(), getInterfaces: () => ifaces, listen, sleep, now, log: (l) => logs.push(l), maxWaitMs: 0,
  });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(calls.length, 1);

  // the Tailscale address goes away, then comes back shortly after (real timer: pure test sync,
  // not part of the fake clock the retry backoff runs on)
  ifaces = NO_TAILSCALE;
  result.server.emit("error", Object.assign(new Error("address no longer available"), { code: "EADDRNOTAVAIL" }));
  setTimeout(() => { ifaces = WITH_TAILSCALE; }, 20);

  await waitUntil(() => calls.length === 2);
  assert.deepEqual(calls[1], { port: 7850, address: "100.101.102.103" });
  assert.ok(calls.every((c) => api.isTailscaleIPv4(c.address)));
  assert.ok(logs.some((l) => l.includes("listener error") && l.includes("EADDRNOTAVAIL")));
  assert.ok(logs.some((l) => l.includes("waiting for Tailscale address...")));
});

test("runHostApi: CLAUDE_ASYNC_HOSTAPI_TAILNET_WAIT_MS bounds the wait -> non-zero-exit error, never a non-Tailscale bind", async () => {
  const calls = [];
  const logs = [];
  const { sleep, now } = fakeClock();
  const listen = async (server, port, address) => { calls.push({ port, address }); };
  const result = await api.runHostApi({
    ...baseOpts(), getInterfaces: () => NO_TAILSCALE, listen, sleep, now, log: (l) => logs.push(l), maxWaitMs: 120_000,
  });
  assert.match(result.error, /gave up waiting for a Tailscale address after 120000ms/);
  assert.equal(result.server, undefined);
  assert.equal(calls.length, 0, "a timed-out wait must never have bound anywhere");
});

test("tailnetWaitMsFromEnv: unset/empty/non-numeric/<=0 all mean wait indefinitely (0); positive values pass through", () => {
  for (const env of [{}, { CLAUDE_ASYNC_HOSTAPI_TAILNET_WAIT_MS: "" }, { CLAUDE_ASYNC_HOSTAPI_TAILNET_WAIT_MS: "nope" },
                     { CLAUDE_ASYNC_HOSTAPI_TAILNET_WAIT_MS: "0" }, { CLAUDE_ASYNC_HOSTAPI_TAILNET_WAIT_MS: "-5" }]) {
    assert.equal(api.tailnetWaitMsFromEnv(env), 0, JSON.stringify(env));
  }
  assert.equal(api.tailnetWaitMsFromEnv({ CLAUDE_ASYNC_HOSTAPI_TAILNET_WAIT_MS: "90000" }), 90_000);
});

test("runHostApi: EADDRINUSE at bind time is retried a bounded number of times, then gives up (no kill, no infinite loop)", async () => {
  const calls = [];
  const { sleep, now } = fakeClock();
  const listen = async () => { calls.push(1); throw Object.assign(new Error("address in use"), { code: "EADDRINUSE" }); };
  const logs = [];
  const result = await api.runHostApi({
    ...baseOpts(), getInterfaces: () => WITH_TAILSCALE, listen, sleep, now, log: (l) => logs.push(l), maxWaitMs: 0,
  });
  assert.match(result.error, /EADDRINUSE/);
  assert.equal(calls.length, 5, "must retry a bounded number of times, not forever");
  assert.ok(logs.some((l) => l.includes("already in use")));
});

test("runHostApi: a permanent misconfiguration (not a Tailscale address) fails fast, never enters the wait loop", async () => {
  const calls = [];
  const { sleep, now } = fakeClock();
  const listen = async (server, port, address) => { calls.push({ port, address }); };
  const logs = [];
  const result = await api.runHostApi({
    ...baseOpts(), apiCfg: { ...apiCfgFor(), port: 7850, bindAddress: "0.0.0.0" },
    getInterfaces: () => WITH_TAILSCALE, listen, sleep, now, log: (l) => logs.push(l), maxWaitMs: 0,
  });
  assert.match(result.error, /is not a Tailscale address/);
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 0, "a permanent misconfiguration must not log a waiting message");
});
