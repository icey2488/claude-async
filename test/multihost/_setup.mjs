/**
 * Shared isolation for the multihost suites. MUST be imported (and awaited) before anything that
 * reads env at module load. Relocates EVERYTHING into a fresh temp dir:
 *   - USERPROFILE/HOME -> so job-core's LAUNCHER_QUEUE_DIR (derived only from os.homedir()) is a
 *     temp queue dir, never the live ~/.claude-async-launcher-queue (asserted below, hard abort);
 *   - CLAUDE_ASYNC_JOB_DIR, CLAUDE_ASYNC_CONFIG_DIR -> temp job root + temp hosts/api config;
 *   - CLAUNKER_JOBCARD_CMD -> a nonexistent binary, so no real dispatch card is ever minted;
 *   - CLAUDE_CLI_PATH -> node itself (exists, so preflight passes when a test wants it to).
 * Tests replace launch() with fakeLaunch, which writes the REAL launch ticket (job-core's own
 * writeLaunchTicket) into the temp queue but never runs schtasks or spawns a runner -- so nothing
 * here can register/trigger the live ClaudeAsyncRunner task, and "no ticket written" assertions
 * look at the same directory a real start would have written to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIVE_QUEUE = path.join(os.homedir(), ".claude-async-launcher-queue");
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ca-multihost-"));
const home = path.join(TMP, "home");
fs.mkdirSync(home, { recursive: true });
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.CLAUDE_ASYNC_JOB_DIR = path.join(TMP, "jobs");
process.env.CLAUDE_ASYNC_CONFIG_DIR = path.join(home, ".claude-async");
process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);
process.env.CLAUDE_CLI_PATH = process.execPath;
process.env.CLAUDE_ASYNC_WIN32_LAUNCH_MODE = "breakaway"; // belt: fakeLaunch never reaches it anyway
for (const k of ["CLAUDE_ASYNC_DEPTH", "CLAUDE_ASYNC_MAX_CONCURRENT", "CLAUDE_ASYNC_MAX_STARTS_PER_MINUTE",
                 "CLAUDE_ASYNC_DEFAULT_CWD"]) delete process.env[k];

export const core = await import("../../job-core.mjs");
export const hosts = await import("../../hosts.mjs");
export const guard = await import("../../guard.mjs");
export const dispatch = await import("../../dispatch.mjs");
export const api = await import("../../host-api.mjs");

export const QUEUE = core.LAUNCHER_QUEUE_DIR;
if (!path.resolve(QUEUE).startsWith(path.resolve(TMP)) || path.resolve(QUEUE) === path.resolve(LIVE_QUEUE)) {
  console.error(`ABORT: launcher queue ${QUEUE} is not inside the temp dir ${TMP}`);
  process.exit(99);
}
fs.mkdirSync(QUEUE, { recursive: true });
export const JOBS = core.JOB_ROOT;

export const launched = [];
export async function fakeLaunch(p, command, argv, cwd, extraEnv) {
  core.writeLaunchTicket(p, extraEnv);
  launched.push({ jobDir: p.d, extraEnv });
  return { pid: process.pid, pidSource: "test", launchPath: "test" };
}

export const tickets = () => fs.readdirSync(QUEUE).filter((f) => f.endsWith(".json") && !f.endsWith(".claimed.json"));
export const jobDirs = () => fs.readdirSync(JOBS).filter((f) => fs.statSync(path.join(JOBS, f)).isDirectory());
export const readTicket = (jobId) => JSON.parse(fs.readFileSync(path.join(QUEUE, `${jobId}.json`), "utf8"));

// Clears job dirs, tickets, and the guard's ledger between tests that need a clean slate.
export function resetState() {
  for (const d of fs.readdirSync(JOBS)) fs.rmSync(path.join(JOBS, d), { recursive: true, force: true });
  for (const f of fs.readdirSync(QUEUE)) fs.rmSync(path.join(QUEUE, f), { force: true });
  launched.length = 0;
}

// Marks every job finished (exit_code 0) so it stops counting against the concurrency cap.
export function completeAll() {
  for (const d of jobDirs()) fs.writeFileSync(path.join(JOBS, d, "exit_code"), "0");
}

export const cfgFor = (localHost, extra = {}) => ({ file: "(test hosts.json)", localHost, hosts: {}, ...extra });
export const BIG_CAPS = { maxConcurrent: 1000, maxStartsPerMinute: 1000 };

export function writeHostsJson(obj) {
  fs.mkdirSync(process.env.CLAUDE_ASYNC_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(hosts.hostsFilePath(), JSON.stringify(obj));
}

export const TOKEN = "test-token-" + "x".repeat(32);
export const apiCfgFor = () => ({ file: "(test api.json)", port: 0, tokenSha256: api.hashToken(TOKEN) });

// Test-only listener on loopback: exercises the request handlers. The production bind path
// (startApi -> selectBindAddress) never yields loopback -- that is tested separately.
export async function listenLoopback(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

export function cleanupTmp() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
