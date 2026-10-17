// Pure-function tests for ping-watchdog.mjs, the decision logic behind claude-async-server.mjs's
// ping watchdog. No process/fs/network involved -- these import the module directly rather than
// spawning the real bridge, since ping-watchdog.mjs was split out specifically to be side-effect
// free. See bridge-exit.test.mjs for the spawned, end-to-end exit-path coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldExitOnMiss, isResumeGap, formatExitLine, PING_DEFAULTS } from "../../ping-watchdog.mjs";

test("1-2 misses never exit, regardless of parent liveness", () => {
  for (const parentAlive of [true, false]) {
    assert.equal(shouldExitOnMiss(1, parentAlive, false), false);
    assert.equal(shouldExitOnMiss(2, parentAlive, false), false);
  }
});

test("3 misses (the default maxMisses) with the parent alive: do not exit", () => {
  assert.equal(shouldExitOnMiss(3, true, false), false);
});

test("3 misses with the parent gone: exit", () => {
  assert.equal(shouldExitOnMiss(3, false, false), true);
});

test("misses below maxMisses with the parent gone still do not exit: the count gate is separate from liveness", () => {
  assert.equal(shouldExitOnMiss(2, false, false), false);
});

test("6 misses (the default hardCapMisses) exit unconditionally, even with the parent alive", () => {
  assert.equal(shouldExitOnMiss(6, true, false), true);
  assert.equal(shouldExitOnMiss(6, false, false), true);
});

test("misses between maxMisses and hardCapMisses with the parent alive: still do not exit", () => {
  assert.equal(shouldExitOnMiss(5, true, false), false);
});

test("resumeDetected grants a full grace interval: never exits that tick, even past the hard cap", () => {
  assert.equal(shouldExitOnMiss(3, false, true), false);
  assert.equal(shouldExitOnMiss(6, false, true), false);
  assert.equal(shouldExitOnMiss(99, true, true), false);
});

test("thresholds are overridable", () => {
  assert.equal(shouldExitOnMiss(2, false, false, { maxMisses: 2 }), true);
  assert.equal(shouldExitOnMiss(4, true, false, { hardCapMisses: 4 }), true);
});

test("defaults match the documented env var defaults (3 / 6 / 2x)", () => {
  assert.deepEqual(PING_DEFAULTS, { maxMisses: 3, hardCapMisses: 6, resumeFactor: 2 });
});

test("isResumeGap: a normal tick (interval plus jitter) is not a resume", () => {
  assert.equal(isResumeGap(30_500, 30_000), false);
});

test("isResumeGap: a gap over resumeFactor x the interval is a resume", () => {
  assert.equal(isResumeGap(65_000, 30_000), true);
});

test("isResumeGap: exactly at the factor boundary is not (yet) a resume", () => {
  assert.equal(isResumeGap(60_000, 30_000, 2), false);
  assert.equal(isResumeGap(60_001, 30_000, 2), true);
});

test("isResumeGap: resumeFactor is overridable", () => {
  assert.equal(isResumeGap(40_000, 30_000, 1.2), true);
  assert.equal(isResumeGap(32_000, 30_000, 1.2), false);
});

test("formatExitLine: full shape with a detail string", () => {
  const line = formatExitLine({ code: 0, reason: "ping-timeout", pid: 123, ppid: 456, uptimeS: "12.3", detail: "misses=3 parentAlive=false" });
  assert.equal(line, "exit: code=0 reason=ping-timeout pid=123 ppid=456 uptime=12.3s misses=3 parentAlive=false");
});

test("formatExitLine: empty detail leaves no trailing space", () => {
  const line = formatExitLine({ code: 0, reason: "sigterm", pid: 1, ppid: 2, uptimeS: "0.0", detail: "" });
  assert.equal(line, "exit: code=0 reason=sigterm pid=1 ppid=2 uptime=0.0s");
});
