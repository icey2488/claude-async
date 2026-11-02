// token-refresh.mjs (review round 3, finding B5): the installation token's renewal schedule, driven by
// a FAKE CLOCK at the production intervals (45 min renewal, 60 min token life). A failed renewal must
// be retried with bounded backoff (so a failure at 45 and recovery at 46 renews long before 60), and
// the near-expiry warning has its own timer at expiresAt - 5 min.
// Run: node --test test/token-refresh.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { createTokenRefresher, RETRY_BACKOFF_MS } = await import("../token-refresh.mjs");
const MIN = 60_000;

// A deterministic clock: timers fire in time order as advanceTo() moves "now"; the async work a timer
// starts (the mint promise) is let run between timers.
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async advanceTo(t) {
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at || (x.at === next[1].at && id < next[0]))) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = t;
      await flush();
    },
  };
}

function harness({ failWhile }) {
  const clock = fakeClock();
  const events = [];
  let n = 0;
  const r = createTokenRefresher({
    refreshMs: 45 * MIN, clock,
    mint: async () => {
      const t = clock.now();
      events.push(["mint", t]);
      if (failWhile(t)) throw new Error("ECONNRESET");
      return { token: `ghs_${++n}`, expiresAt: t + 60 * MIN };
    },
    onSuccess: ({ token, expiresAt }) => events.push(["ok", clock.now(), token, expiresAt]),
    onFailure: (e, info) => events.push(["fail", clock.now(), info.retryInMs]),
    onNearExpiry: (info) => events.push(["near-expiry", clock.now(), info.expiresAt]),
  });
  r.start({ expiresAt: 60 * MIN });                          // the initial token, minted at 0 before docker run
  return { clock, events, r };
}

test("B5: success at 0, failure at 45, network back at 46: the token is renewed before 60 (at 46.5), not at 90", async () => {
  const h = harness({ failWhile: (t) => t >= 45 * MIN && t < 46 * MIN });
  await h.clock.advanceTo(59 * MIN);
  const oks = h.events.filter((e) => e[0] === "ok");
  assert.equal(h.events.find((e) => e[0] === "fail")[1], 45 * MIN, "the normal renewal at 45 failed");
  assert.ok(oks.length >= 1, `renewed before the token expired at 60: ${JSON.stringify(h.events)}`);
  assert.ok(oks[0][1] < 60 * MIN && oks[0][1] >= 46 * MIN, `renewed at ${oks[0][1] / MIN} min`);
  assert.equal(oks[0][1], 45 * MIN + RETRY_BACKOFF_MS[0] + RETRY_BACKOFF_MS[1], "retries at 45.5 (still down) and 46.5 (back)");
  assert.equal(h.events.filter((e) => e[0] === "near-expiry").length, 0, "no near-expiry warning: renewed in time");
  // and back on the normal schedule: the next renewal is 45 min after that success
  await h.clock.advanceTo(oks[0][1] + 45 * MIN + 1);
  assert.equal(h.events.filter((e) => e[0] === "ok")[1][1], oks[0][1] + 45 * MIN);
  h.r.stop();
});

test("B5: recovery never comes: the warning is recorded at 55 by its own timer, without needing another failure at that moment; a last retry happens by 58", async () => {
  const h = harness({ failWhile: (t) => t >= 45 * MIN });
  await h.clock.advanceTo(61 * MIN);
  const near = h.events.filter((e) => e[0] === "near-expiry");
  assert.equal(near.length, 1, JSON.stringify(h.events));
  assert.equal(near[0][1], 55 * MIN, "recorded exactly at expiresAt - 5 min");
  assert.ok(!h.events.some((e) => e[0] === "fail" && e[1] === 55 * MIN), "no failure happened at 55: the timer did it");
  const mints = h.events.filter((e) => e[0] === "mint").map((e) => e[1] / MIN);
  assert.ok(mints.includes(58), `an attempt at expiresAt - 2 min: ${mints}`);
  const gaps = mints.slice(1).map((m, i) => m - mints[i]);
  assert.ok(gaps.every((g) => g <= 5), `bounded backoff, never more than 5 min between attempts: ${gaps}`);
  h.r.stop();
});

test("B5: a mint that resolves after stop() writes nothing and warns about nothing (C1a)", async () => {
  const clock = fakeClock();
  let release;
  const events = [];
  const r = createTokenRefresher({ refreshMs: 45 * MIN, clock,
    mint: () => new Promise((res) => { release = res; }),
    onSuccess: () => events.push("ok"), onFailure: () => events.push("fail"), onNearExpiry: () => events.push("near") });
  r.start({ expiresAt: 60 * MIN });
  await clock.advanceTo(45 * MIN);
  assert.ok(release, "the renewal is in flight");
  r.stop();
  release({ token: "ghs_late", expiresAt: 120 * MIN });
  await clock.advanceTo(70 * MIN);
  assert.deepEqual(events, []);
});

test("B5: no warning when the normal renewal succeeds; a short-lived token's warning waits for an actual failure", async () => {
  const h = harness({ failWhile: () => false });
  await h.clock.advanceTo(200 * MIN);
  assert.equal(h.events.filter((e) => e[0] === "near-expiry").length, 0);
  assert.deepEqual(h.events.filter((e) => e[0] === "ok").map((e) => e[1] / MIN), [45, 90, 135, 180]);
  h.r.stop();
});
