// Job id format, dot separator, suffix entropy, host-prefix parsing (incl. old un-prefixed ids).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hosts, cleanupTmp } from "./_setup.mjs";

const { genSuffix, parseHostPrefix, mintJobId, sanitizeDescriptor, HOSTS } = hosts;
after(cleanupTmp);

const ID_RE = /^(claunker|laptop)\.[A-Za-z0-9_-]{1,64}-\d{8}-[a-z0-9]{8}$/;

test("genSuffix: 8 chars from [a-z0-9], one randomInt(36) per char (delegated helper example)", () => {
  let i = 0;
  const seq = (n) => { assert.equal(n, 36); return i++; };
  assert.equal(genSuffix(seq), "abcdefgh");
  assert.equal(genSuffix(() => 35), "99999999");
  for (let k = 0; k < 200; k++) assert.match(genSuffix(), /^[a-z0-9]{8}$/);
});

test("genSuffix entropy: 20k draws unique, every symbol used, symbol distribution roughly flat", () => {
  const N = 20000;
  const seen = new Set();
  const counts = new Map();
  for (let k = 0; k < N; k++) {
    const s = genSuffix();
    seen.add(s);
    for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  }
  assert.equal(seen.size, N, "collision in 20k draws of a ~41-bit suffix");
  assert.equal(counts.size, 36, "every one of the 36 symbols should appear");
  const expected = (N * 8) / 36;
  for (const [c, n] of counts) {
    assert.ok(Math.abs(n - expected) < expected * 0.1, `symbol ${c} count ${n} far from uniform ${expected.toFixed(0)}`);
  }
});

test("mintJobId: <host>.<descriptor>-YYYYMMDD-<8>, exactly one dot, suffix always appended", () => {
  const now = new Date(2026, 8, 25, 23, 30); // local time
  const id = mintJobId({ host: "claunker", descriptor: "fix-bug", now, suffix: "k3v9x0qa" });
  assert.equal(id, "claunker.fix-bug-20260925-k3v9x0qa");
  const gen = mintJobId({ host: "laptop", now });
  assert.match(gen, ID_RE);
  assert.ok(gen.startsWith("laptop.job-20260925-"));
  // custom descriptor: suffix still appended
  const custom = mintJobId({ host: "claunker", descriptor: "my-job" });
  assert.match(custom, ID_RE);
  assert.notEqual(custom, mintJobId({ host: "claunker", descriptor: "my-job" }), "two mints of one descriptor must differ");
  // dots / colons / other hosts' prefixes in the descriptor can't create a second separator
  for (const d of ["laptop.evil", "a:b", "../../x", "claunker.claunker.x", "ünï code"]) {
    const m = mintJobId({ host: "claunker", descriptor: d });
    assert.match(m, ID_RE, `descriptor ${d} -> ${m}`);
    assert.equal(m.split(".").length, 2, `exactly one dot in ${m}`);
    assert.deepEqual(parseHostPrefix(m, HOSTS).host, "claunker");
  }
  assert.throws(() => mintJobId({ host: "desktop" }), /unknown host/);
});

test("sanitizeDescriptor: bounded, never empty", () => {
  assert.equal(sanitizeDescriptor(""), "job");
  assert.equal(sanitizeDescriptor(undefined), "job");
  assert.equal(sanitizeDescriptor("a.b:c"), "a_b_c");
  assert.equal(sanitizeDescriptor("x".repeat(100)).length, 64);
});

test("parseHostPrefix: exact enum match only (delegated helper example)", () => {
  assert.deepEqual(parseHostPrefix("claunker.fix-bug-20260925-a1b2c3d4", HOSTS),
    { host: "claunker", rest: "fix-bug-20260925-a1b2c3d4" });
  assert.deepEqual(parseHostPrefix("laptop.x", HOSTS), { host: "laptop", rest: "x" });
  // old, un-prefixed ids resolve as un-prefixed (=> local)
  for (const old of ["1727300000000-a1b2c3", "gallagioloot-multi-url-rows-20260925",
                     "claude-async-multihost-20260925-r3", "selftest-123"]) {
    assert.deepEqual(parseHostPrefix(old, HOSTS), { host: null, rest: old });
  }
  // merely STARTS with a host name, no dot directly after it: not a prefix
  for (const id of ["claunkerfoo-20260925-abcdefgh", "claunker-fix-20260925", "claunker_x.y", "laptops.x",
                    "Claunker.x", "CLAUNKER.x", "desktop.x", ".claunker", "claunker"]) {
    assert.equal(parseHostPrefix(id, HOSTS).host, null, id);
    assert.equal(parseHostPrefix(id, HOSTS).rest, id, id);
  }
  assert.deepEqual(parseHostPrefix(undefined, HOSTS), { host: null, rest: undefined });
});
