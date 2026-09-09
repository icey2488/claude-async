#!/usr/bin/env node
// The "P" process in test/detach-survival.mjs: this is what gets assigned into the throwaway
// Job Object before it calls startJob(), so job-runner.mjs (spawned from here) starts out
// nested in the same job -- exactly mirroring the bridge process in production. Whether the
// runner then stays nested (old code) or escapes (fixed code) is the entire point of the test.
//
// argv: [jobDir, dummyCliPath, coreModulePath, markerPath]
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [, , jobDir, dummyCliPath, coreModulePath, markerPath] = process.argv;

process.env.CLAUDE_ASYNC_JOB_DIR = jobDir;
process.env.CLAUDE_CLI_PATH = dummyCliPath;
// Force mintCard's UNCARDED path (nonexistent command -> ENOENT) so this test never creates a
// real dispatch card.
process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);

const core = await import(pathToFileURL(coreModulePath).href);
const result = await core.startJob({
  prompt: "survival test",
  jobId: "survival-job",
  model: "n/a",
  effort: "low",
});

fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, result }));

// Keep this process (and its event loop) alive so it's still a live member of the job when the
// harness kills the job holder. It never exits on its own; the harness's kill is what ends it.
setInterval(() => {}, 60_000);
