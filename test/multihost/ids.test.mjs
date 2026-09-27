// Job id format, dot separator, suffix entropy, host-prefix parsing (incl. old un-prefixed ids).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { hosts, cleanupTmp } from "./_setup.mjs";

const { genSuffix, parseHostPrefix, mintJobId, sanitizeDescriptor } = hosts;
after(cleanupTmp);

const ID_RE = /^(claunker|laptop|ha)\.[A-Za-z0-9_-]{1,64}-\d{8}-[a-z0-9]{8}$/;

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
    assert.deepEqual(parseHostPrefix(m).host, "claunker");
  }
  // any valid host name mints (the list is the registry's, not the code's) ...
  const ha = mintJobId({ host: "ha", descriptor: "on-ha", now, suffix: "k3v9x0qa" });
  assert.equal(ha, "ha.on-ha-20260925-k3v9x0qa");
  assert.match(mintJobId({ host: "desktop", now }), /^desktop\.job-20260925-[a-z0-9]{8}$/);
  assert.deepEqual(parseHostPrefix(ha), { host: "ha", rest: "on-ha-20260925-k3v9x0qa" });
  // ... and an invalid one throws, naming the reason (a dot would corrupt the id's separator)
  for (const bad of ["a.b", "Ha", "", " ", "x".repeat(33), undefined, null, "-a"]) {
    assert.throws(() => mintJobId({ host: bad }), /cannot mint a job id for host/, String(bad));
  }
  assert.throws(() => mintJobId({ host: "a.b" }), /must not contain "\."/);
});

test("sanitizeDescriptor: bounded, never empty", () => {
  assert.equal(sanitizeDescriptor(""), "job");
  assert.equal(sanitizeDescriptor(undefined), "job");
  assert.equal(sanitizeDescriptor("a.b:c"), "a_b_c");
  assert.equal(sanitizeDescriptor("x".repeat(100)).length, 64);
});

test("parseHostPrefix: any valid host name before the first dot, and nothing else", () => {
  assert.deepEqual(parseHostPrefix("claunker.fix-bug-20260925-a1b2c3d4"),
    { host: "claunker", rest: "fix-bug-20260925-a1b2c3d4" });
  assert.deepEqual(parseHostPrefix("laptop.x"), { host: "laptop", rest: "x" });
  assert.deepEqual(parseHostPrefix("ha.fix-bug-20260926-a1b2c3d4"), { host: "ha", rest: "fix-bug-20260926-a1b2c3d4" });
  assert.deepEqual(parseHostPrefix("desktop.x"), { host: "desktop", rest: "x" }, "known-ness is the caller's question");
  assert.deepEqual(parseHostPrefix("ha.a.b.c"), { host: "ha", rest: "a.b.c" }, "only the first dot separates");
  // old, un-prefixed ids resolve as un-prefixed (=> local)
  for (const old of ["1727300000000-a1b2c3", "gallagioloot-multi-url-rows-20260925",
                     "claude-async-multihost-20260925-r3", "selftest-123"]) {
    assert.deepEqual(parseHostPrefix(old), { host: null, rest: old });
  }
  // merely STARTS with a host name, no dot directly after it, or a prefix that is not a valid name: not a prefix
  for (const id of ["claunkerfoo-20260925-abcdefgh", "claunker-fix-20260925", "claunker_x.y",
                    "Claunker.x", "CLAUNKER.x", ".claunker", "claunker", "my job.x", "a_b.x", "-a.x",
                    `${"x".repeat(33)}.y`]) {
    assert.equal(parseHostPrefix(id).host, null, id);
    assert.equal(parseHostPrefix(id).rest, id, id);
  }
  assert.deepEqual(parseHostPrefix(undefined), { host: null, rest: undefined });
  assert.deepEqual(parseHostPrefix(42), { host: null, rest: 42 });
});
