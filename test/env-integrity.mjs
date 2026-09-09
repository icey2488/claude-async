#!/usr/bin/env node
/**
 * test/env-integrity.mjs — proves a job launched through job-core.mjs's real startJob()/launch()
 * carries PATH, PATHEXT, and a sentinel variable through identically from the process that called
 * startJob(), on both the pre-5a09feb direct-spawn path and the current win32-breakaway.ps1 path.
 * This is NOT a full-environment-block comparison (the win32 path hops through powershell.exe,
 * which can inject/alter a few variables of its own before CreateProcessW ever runs -- e.g.
 * PSModulePath, TEMP -- see win32-breakaway.ps1's header); it only asserts the three variables
 * this bridge actually depends on downstream survive intact.
 *
 * Mechanism: CLAUDE_CLI_PATH is pointed at test/dummy-env-dumper.exe (a real .exe is required --
 * see test/build-dummy-claude.ps1's identical note about job-runner.mjs's shell-less spawn), which
 * writes its own environment to ENV_DUMP_OUTPUT_PATH instead of running claude. The test sets
 * CLAUDE_ASYNC_ENV_SENTINEL to a random value in ITS OWN process before calling startJob(), then
 * asserts the dumped child environment has: the same PATHEXT as the parent, the same PATH as the
 * parent, and the sentinel intact.
 *
 * Run: node test/env-integrity.mjs   (exit 0 = both old and new paths preserve env correctly)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseEnvDump(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out = {};
  for (const line of lines) {
    const i = line.indexOf("=");
    if (i === -1) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

// Windows env var names are case-insensitive; a variable can arrive under a different casing
// than the parent used (observed in the wild: the live corrupted variable is literally named
// "PathEXT", not "PATHEXT") and that's still correct propagation, not a bug. Look up
// case-insensitively but report back the actual key name so case changes are still visible.
function lookupCI(envObj, name) {
  const key = Object.keys(envObj).find((k) => k.toLowerCase() === name.toLowerCase());
  return { key: key ?? null, value: key ? envObj[key] : undefined };
}

async function runScenario(label, coreModulePath, dumperExe, sentinel) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), `env-integrity-${label}-`));
  const dumpFile = path.join(jobDir, "child-env.txt");

  process.env.CLAUDE_ASYNC_JOB_DIR = jobDir;
  process.env.CLAUDE_CLI_PATH = dumperExe;
  process.env.ENV_DUMP_OUTPUT_PATH = dumpFile;
  process.env.CLAUDE_ASYNC_ENV_SENTINEL = sentinel;
  process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);

  const parentPathext = process.env.PATHEXT;
  const parentPath = process.env.PATH;

  const core = await import(pathToFileURL(coreModulePath).href + `?scenario=${label}`);
  const result = await core.startJob({ prompt: "env integrity test", jobId: `env-integrity-${label}`, model: "n/a", effort: "low" });
  if (result.error) {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    return { label, ok: false, reason: `startJob() error: ${result.error}` };
  }

  const deadline = Date.now() + 10000;
  let status;
  do {
    await sleep(100);
    status = core.checkJob(result.jobId);
  } while (status.status === "running" && Date.now() < deadline);

  if (status.status !== "completed" || !fs.existsSync(dumpFile)) {
    const reason = status.status !== "completed"
      ? `job did not complete: status=${status.status} exitCode=${status.exitCode} stderr=${JSON.stringify(status.stderr)}`
      : "dummy-env-dumper.exe never wrote its dump file";
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    return { label, ok: false, reason };
  }

  const childEnv = parseEnvDump(dumpFile);
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}

  const childPathext = lookupCI(childEnv, "PATHEXT");
  const childPath = lookupCI(childEnv, "PATH");
  const childSentinel = lookupCI(childEnv, "CLAUDE_ASYNC_ENV_SENTINEL");

  const checks = {
    pathextMatches: childPathext.value === parentPathext,
    pathMatches: childPath.value === parentPath,
    sentinelMatches: childSentinel.value === sentinel,
  };
  const ok = checks.pathextMatches && checks.pathMatches && checks.sentinelMatches;
  return {
    label, ok,
    detail: {
      ...checks, parentPathext, childPathextKey: childPathext.key, childPathextValue: childPathext.value,
      sentinel, childSentinelValue: childSentinel.value,
    },
  };
}

const REAL_CORE = path.join(REPO, "job-core.mjs");
const OLD_CORE_SNAPSHOT = path.join(REPO, ".job-core-before-env-test.mjs");
const DUMPER_EXE = path.join(REPO, "test", "dummy-env-dumper.exe");

// Pinned to 7effb28762c58a43e260aad7e655802a9579b68f (5a09feb^), the last commit before the
// win32 breakaway fix -- same rationale and same commit as test/detach-survival.mjs's
// PRE_FIX_COMMIT. HEAD~1 is NOT safe here: as more commits land on top of the fix, HEAD~1 drifts
// forward and stops pointing at a pre-breakaway job-core.mjs, silently turning this into a
// before-vs-after comparison of two copies of the SAME (post-fix) code -- which is exactly what
// happened once 9c06ff3 and 4b74d0c landed on top of this test's original HEAD~1 reference.
const PRE_FIX_COMMIT = "7effb28762c58a43e260aad7e655802a9579b68f";
const gitShow = spawnSync("git", ["show", `${PRE_FIX_COMMIT}:job-core.mjs`], { cwd: REPO, encoding: "utf8" });
if (gitShow.status !== 0) {
  console.error(`Could not obtain pre-5a09feb job-core.mjs via \`git show ${PRE_FIX_COMMIT}:job-core.mjs\`:`, gitShow.stderr);
  process.exit(1);
}
fs.writeFileSync(OLD_CORE_SNAPSHOT, gitShow.stdout);

const build = spawnSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
   "-File", path.join(REPO, "test", "build-dummy-env-dumper.ps1"), "-OutputPath", DUMPER_EXE],
  { encoding: "utf8" });
if (build.status !== 0) {
  console.error("Could not build test/dummy-env-dumper.exe:", build.stdout, build.stderr);
  process.exit(1);
}

const sentinel = `sentinel-${crypto.randomBytes(4).toString("hex")}`;
console.log(`sentinel = ${sentinel}`);
console.log(`parent PATHEXT = ${process.env.PATHEXT}`);

try {
  console.log("\n=== BEFORE (pre-5a09feb job-core.mjs launch(), direct spawn) ===");
  const before = await runScenario("before", OLD_CORE_SNAPSHOT, DUMPER_EXE, sentinel);
  console.log(JSON.stringify(before, null, 2));

  console.log("\n=== AFTER (current job-core.mjs launch(), win32-breakaway.ps1) ===");
  const after = await runScenario("after", REAL_CORE, DUMPER_EXE, sentinel);
  console.log(JSON.stringify(after, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log(`before: ${before.ok ? "PASS" : "FAIL"}` + (before.reason ? ` -- ${before.reason}` : ""));
  console.log(`after:  ${after.ok ? "PASS" : "FAIL"}` + (after.reason ? ` -- ${after.reason}` : ""));

  const expected = before.ok && after.ok;
  console.log(expected
    ? "\nPASS — both paths preserve PATHEXT/PATH/sentinel intact"
    : "\nFAIL — environment was not preserved on at least one path");
  // process.exit() below terminates immediately without running pending `finally` blocks, so the
  // snapshot cleanup must happen before it, not after (a bare process.exit() in a try body skips
  // any enclosing finally -- discovered by this script leaving .job-core-before-env-test.mjs
  // behind on its first run).
  try { fs.rmSync(OLD_CORE_SNAPSHOT, { force: true }); } catch {}
  process.exit(expected ? 0 : 1);
} catch (e) {
  try { fs.rmSync(OLD_CORE_SNAPSHOT, { force: true }); } catch {}
  throw e;
}
