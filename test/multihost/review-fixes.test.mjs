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

// M2: countActiveJobs() runs under the start lock; it must not spawn the jobcard command to reap a
// died job's card (up to 10s per job, against a 5s lock timeout). checkJob() itself still reaps.
test("M2 caps: counting active jobs never reaps a died job's card; claude_check still does", async () => {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { TMP, JOBS } = await import("./_setup.mjs");
  const calls = path.join(TMP, "m2-jobcard-calls.txt");
  const script = path.join(TMP, "m2-jobcard.mjs");
  fs.writeFileSync(script, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");`);
  const dir = path.join(JOBS, "m2-died");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId: "m2-died", pid: 2_000_000_000, cardId: "card-m2" }));
  const prev = process.env.CLAUNKER_JOBCARD_CMD;
  process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify([process.execPath, script]);
  try {
    const { count } = core.countActiveJobs(Date.now());
    assert.equal(count, 0, "a died job is not active");
    assert.ok(!fs.existsSync(calls), "counting must not run the jobcard command");
    assert.equal(core.checkJob("m2-died").status, "died");
    assert.match(fs.readFileSync(calls, "utf8"), /^fail card-m2$/m, "claude_check still reaps the card");
  } finally { process.env.CLAUNKER_JOBCARD_CMD = prev; }
});

// M3: one corrupt meta.json must not take down the whole job listing (claude_jobs, /v1/jobs).
test("M3 listJobs: a corrupt meta.json yields one 'unknown' row with the error; the other jobs still list", async () => {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { JOBS } = await import("./_setup.mjs");
  const mk = (id, metaText, exitCode) => {
    fs.mkdirSync(path.join(JOBS, id), { recursive: true });
    fs.writeFileSync(path.join(JOBS, id, "meta.json"), metaText);
    if (exitCode !== undefined) fs.writeFileSync(path.join(JOBS, id, "exit_code"), String(exitCode));
  };
  mk("m3-good", JSON.stringify({ jobId: "m3-good", pid: 1, startedAt: new Date().toISOString() }), 0);
  mk("m3-truncated", '{"jobId": "m3-trunc', undefined);
  mk("m3-null", "null", undefined);
  const rows = core.listJobs();
  const by = Object.fromEntries(rows.map((r) => [r.jobId, r]));
  assert.equal(by["m3-good"].status, "completed");
  assert.equal(by["m3-truncated"].status, "unknown");
  assert.match(by["m3-truncated"].error, /unreadable meta\.json/);
  assert.equal(by["m3-null"].status, "unknown");
  assert.match(core.checkJob("m3-truncated").error, /unreadable meta\.json/, "checkJob reports it rather than throwing");
});

// M4: exit_code must appear atomically (temp file + rename), never be truncated-then-written in
// place, or a concurrent checkJob can read it empty and report a transient "failed".
test("M4 runner: exit_code is produced by a rename, never written in place", async () => {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { TMP } = await import("./_setup.mjs");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(TMP, "m4-job");
  fs.mkdirSync(dir, { recursive: true });
  const spec = { command: process.execPath, argv: [path.join(here, "fake-cli.mjs"), "--exit", "3"], cwd: dir,
                 out: path.join(dir, "out.log"), err: path.join(dir, "err.log"), exit: path.join(dir, "exit_code") };
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec));
  const trace = path.join(TMP, "m4-trace.jsonl");
  const res = spawnSync(process.execPath, ["--import", path.join(here, "exitcode-preload.mjs"),
    path.join(here, "..", "..", "job-runner.mjs"), path.join(dir, "spec.json")],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, EXITCODE_TRACE: trace } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(spec.exit, "utf8"), "3");
  const ops = fs.readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!ops.some(([op, f]) => op === "write" && f === spec.exit), `exit_code written in place: ${JSON.stringify(ops)}`);
  assert.ok(ops.some(([op, , to]) => op === "rename" && to === spec.exit), JSON.stringify(ops));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
});
