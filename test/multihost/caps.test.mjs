// hosts.json "caps" validation: bad shapes fail on load naming the field, and claude_start refuses
// with nothing written. {} and absent both load ("defaults"); valid values pass through unchanged.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hosts, guard, dispatch, fakeLaunch, tickets, jobDirs, resetState, writeHostsJson, cleanupTmp, TMP } from "./_setup.mjs";

after(cleanupTmp);
beforeEach(resetState);

const F = path.join(TMP, "caps-hosts.json");
const load = (obj) => { fs.writeFileSync(F, JSON.stringify(obj)); return hosts.loadHostsConfig(F); };

const BAD = [
  ["string value", { maxConcurrent: "4" }, '"caps.maxConcurrent"'],
  ["zero", { maxConcurrent: 0 }, '"caps.maxConcurrent"'],
  ["negative", { maxConcurrent: -1 }, '"caps.maxConcurrent"'],
  ["float", { maxConcurrent: 2.5 }, '"caps.maxConcurrent"'],
  ["null", { maxStartsPerMinute: null }, '"caps.maxStartsPerMinute"'],
  ["bad rate cap", { maxConcurrent: 2, maxStartsPerMinute: 0 }, '"caps.maxStartsPerMinute"'],
  ["unknown key", { maxConcurent: 4 }, '"caps.maxConcurent"'],
  ["not an object (string)", "4", '"caps"'],
  ["not an object (array)", [], '"caps"'],
  ["not an object (null)", null, '"caps"'],
];

for (const [label, caps, field] of BAD) {
  test(`caps invalid (${label}): error names ${field}; claude_start refuses, nothing written`, async () => {
    const config = { localHost: "claunker", caps };
    const cfg = load(config);
    assert.ok(cfg.error, "must fail validation");
    assert.ok(cfg.error.startsWith(`${F}: ${field} `), cfg.error);
    writeHostsJson(config);
    const ctx = { ...dispatch.defaultCtx(), startOptions: { launch: fakeLaunch } };
    const r = await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, ctx);
    assert.equal(r.error, ctx.cfg.error);
    assert.match(r.error, new RegExp(field));
    assert.equal(tickets().length, 0);
    assert.equal(jobDirs().length, 0);
  });
}

test("caps: {} and absent both load; {} resolves to the guard defaults", () => {
  assert.equal(load({ localHost: "claunker" }).error, undefined);
  assert.equal(load({ localHost: "claunker" }).caps, undefined);
  const empty = load({ localHost: "claunker", caps: {} });
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.caps, {});
  assert.deepEqual(guard.resolveCaps(empty.caps), guard.DEFAULT_CAPS);
});

test("caps: valid values (one or both) pass through unchanged", () => {
  assert.deepEqual(load({ localHost: "claunker", caps: { maxConcurrent: 2, maxStartsPerMinute: 9 } }).caps,
    { maxConcurrent: 2, maxStartsPerMinute: 9 });
  assert.deepEqual(load({ localHost: "claunker", caps: { maxConcurrent: 1 } }).caps, { maxConcurrent: 1 });
});
