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

// M1: guard.mjs's break-marker cleanup trusted dev+ino alone. Linux filesystems reuse a freed inode
// number for the next file created, so a rival's replacement marker can carry the very dev+ino we
// captured. Modeled deterministically by rewriting the marker IN PLACE (guaranteed same inode) with
// another owner's content: it must never be removed by us.
test("M1 guard: a break marker that now names another owner is left alone even with the same dev+ino", async () => {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const os = (await import("node:os")).default;
  const { withStartLock } = await import("../../guard.mjs");
  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ca-m1-"));
  try {
    const lock = path.join(jobRoot, ".start.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, at: new Date().toISOString() }));
    const mtime = fs.statSync(lock).mtimeMs;
    const marker = lock + ".break";
    const log = [];
    const orig = fs.unlinkSync;
    let rewrote = false;
    fs.unlinkSync = function (f, ...rest) {
      if (!rewrote && String(f) === lock) {
        rewrote = true;
        const before = fs.statSync(marker, { bigint: true }).ino;
        fs.writeFileSync(marker, JSON.stringify({ pid: 4242, at: new Date().toISOString() })); // same inode
        assert.equal(fs.statSync(marker, { bigint: true }).ino, before, "precondition: marker kept its inode");
      }
      return orig.call(this, f, ...rest);
    };
    let r;
    try {
      r = await withStartLock(jobRoot, () => "ran", { staleMs: 1_000, now: () => mtime + 1_000, pidAlive: () => false, log: (l) => log.push(l) });
    } finally { fs.unlinkSync = orig; }
    assert.equal(r, "ran");
    assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).pid, 4242, "another owner's marker must survive our cleanup");
    assert.ok(log.some((l) => /same inode reused/.test(l)), log.join("\n"));
  } finally { fs.rmSync(jobRoot, { recursive: true, force: true }); }
});
