#!/usr/bin/env node
/**
 * test/pathext-integrity.mjs — regression test for sanitizeEnvForWin32(): proves a job launched
 * through the real startJob()/launchWin32()/job-runner.mjs path always reaches the spawned CLI
 * with a usable PATHEXT, even when the bridge process's own environment is missing PATHEXT
 * entirely (Claude Desktop's actual spawn condition -- see job-core.mjs's header comment) or
 * already carries a corrupted '.CPL'-only value (what a prior PowerShell hop produces from an
 * absent PATHEXT).
 *
 * Mechanism: same dummy-env-dumper.exe technique as test/env-integrity.mjs -- CLAUDE_CLI_PATH
 * points at it so it dumps job-runner.mjs's actual spawn environment instead of running claude.
 *
 * Run: node test/pathext-integrity.mjs   (exit 0 = PATHEXT repaired in both scenarios)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);
const DUMPER_EXE = path.join(REPO, "test", "dummy-env-dumper.exe");

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

function lookupCI(envObj, name) {
  const key = Object.keys(envObj).find((k) => k.toLowerCase() === name.toLowerCase());
  return { key: key ?? null, value: key ? envObj[key] : undefined };
}

// Windows env var names are case-insensitive; a stray "PathEXT" duplicate must be removed too,
// not just "PATHEXT" itself, or the scenario setup below wouldn't reproduce the real condition.
function deleteEnvCI(name) {
  for (const k of Object.keys(process.env)) {
    if (k.toLowerCase() === name.toLowerCase()) delete process.env[k];
  }
}

async function runScenario(label, presetPathext) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), `pathext-integrity-${label}-`));
  const dumpFile = path.join(jobDir, "child-env.txt");

  deleteEnvCI("PATHEXT");
  if (presetPathext !== undefined) process.env.PATHEXT = presetPathext;

  // This test proves PATHEXT repair on the win32-breakaway.ps1 powershell.exe hop specifically --
  // the Task Scheduler launch path (default since 2026-09-09) never hops through PowerShell, so
  // force the breakaway path to keep exercising the mechanic this test exists for.
  process.env.CLAUDE_ASYNC_WIN32_LAUNCH_MODE = "breakaway";
  process.env.CLAUDE_ASYNC_JOB_DIR = jobDir;
  process.env.CLAUDE_CLI_PATH = DUMPER_EXE;
  process.env.ENV_DUMP_OUTPUT_PATH = dumpFile;
  process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);

  // Cache-busting query so each scenario gets its own module instance (job-core.mjs reads
  // CLAUDE_CLI_PATH/JOB_ROOT at import time into module-level consts).
  const core = await import(pathToFileURL(path.join(REPO, "job-core.mjs")).href + `?scenario=${label}`);
  const result = await core.startJob({
    prompt: "pathext integrity test", jobId: `pathext-integrity-${label}`, model: "n/a", effort: "low",
  });
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
  const value = childPathext.value || "";
  const ok = value.toUpperCase().includes(".EXE") && value.toUpperCase().includes(".CMD");
  return { label, ok, detail: { presetPathext: presetPathext ?? "(absent)", childPathextKey: childPathext.key, childPathextValue: value } };
}

const build = spawnSync("powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
   "-File", path.join(REPO, "test", "build-dummy-env-dumper.ps1"), "-OutputPath", DUMPER_EXE],
  { encoding: "utf8" });
if (build.status !== 0) {
  console.error("Could not build test/dummy-env-dumper.exe:", build.stdout, build.stderr);
  process.exit(1);
}

const savedEnv = { ...process.env };

try {
  console.log("=== missing (PATHEXT absent from parent -- Claude Desktop's actual condition) ===");
  const missing = await runScenario("missing", undefined);
  console.log(JSON.stringify(missing, null, 2));

  console.log("\n=== cpl-only (parent PATHEXT='.CPL' -- simulating a prior PowerShell hop) ===");
  const cplOnly = await runScenario("cpl", ".CPL");
  console.log(JSON.stringify(cplOnly, null, 2));

  console.log("\n=== SUMMARY ===");
  console.log(`missing:  ${missing.ok ? "PASS" : "FAIL"}` + (missing.reason ? ` -- ${missing.reason}` : ""));
  console.log(`cpl-only: ${cplOnly.ok ? "PASS" : "FAIL"}` + (cplOnly.reason ? ` -- ${cplOnly.reason}` : ""));

  const expected = missing.ok && cplOnly.ok;
  console.log(expected
    ? "\nPASS — PATHEXT reaches the CLI intact in both scenarios"
    : "\nFAIL — PATHEXT was not repaired on at least one path");
  process.exit(expected ? 0 : 1);
} finally {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}
