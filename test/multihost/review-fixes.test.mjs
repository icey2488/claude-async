// Regression tests for the 2026-10-31 review-and-fix pass (one block per finding; see the PR's
// findings table for the ids).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { core, resetState, cleanupTmp, BIG_CAPS } from "./_setup.mjs";

after(cleanupTmp);
beforeEach(resetState);

// Captures the argv startJob would hand to the CLI, without launching anything.
async function argvFor(args) {
  let captured;
  const r = await core.startJob({ jobId: `argv-${Math.random().toString(36).slice(2)}`, ...args },
    { caps: BIG_CAPS, launch: async (p, command, argv) => { captured = argv; return { pid: process.pid, pidSource: "test", launchPath: "test" }; } });
  assert.ok(!r.error, r.error);
  return captured;
}

// H1: the prompt is the CLI's positional argument; it must follow "--" so a leading "-" can never
// be parsed as an option, and a caller-supplied model must be bound to --model with "=".
for (const prompt of ["- fix the bug", "--version", "--add-dir / do something", "-p", "plain prompt"]) {
  test(`H1 argv: prompt ${JSON.stringify(prompt)} is passed verbatim after "--", as the very last argument`, async () => {
    const argv = await argvFor({ prompt });
    assert.equal(argv.at(-1), prompt);
    assert.equal(argv.at(-2), "--");
    assert.equal(argv.indexOf("--"), argv.length - 2, "exactly one end-of-options marker, right before the prompt");
    assert.ok(!argv.slice(0, -2).includes(prompt) || prompt === "-p", "the prompt appears nowhere among the options");
  });
}

test("H1 argv: a dash-leading model is bound with --model=<value>, never a separate argument", async () => {
  const argv = await argvFor({ prompt: "p", model: "--dangerously-skip-permissions" });
  assert.ok(argv.includes("--model=--dangerously-skip-permissions"));
  assert.ok(!argv.includes("--model"));
});

test("H1 argv: the default model still reaches the CLI", async () => {
  const argv = await argvFor({ prompt: "p" });
  assert.ok(argv.some((a) => /^--model=.+/.test(a)));
});
