#!/usr/bin/env node
/**
 * job-runner.mjs — the detached worker behind claude-async.
 *
 * Reads a spec.json ({ command, argv, cwd, out, err, exit }), runs `command` with its
 * stdout/stderr redirected into the job's log files, and writes the process exit code to
 * the exit_code file when it finishes. It runs as its own DETACHED process (spawned with
 * detached + unref by the server), so the job keeps running and still records its exit code
 * even if the MCP server (the bridge) is restarted. No shell is involved — argv is passed
 * straight to the OS, so prompts/paths need no escaping and Windows works the same as POSIX.
 *
 * Discord notification: after exit.json and exit_code are both written in finish(), best-effort
 * pings a Discord webhook (see discord-notify.mjs) if ~/.claude-async/notify.json configures one.
 * Silently does nothing otherwise. Bounded and try/caught so it can never affect exit_code, the
 * runner's own exit code, or write ordering. recordExit() also computes exit.json's
 * reportComplete field (did stdout carry the DELEGATION-METRICS final-report marker?) -- this
 * runs regardless of whether notify.json even configures a webhook, since claude_check surfaces
 * it from exit.json directly, and it is what lets the Discord ping (when configured) label an
 * exit-0 job that stopped early [INCOMPLETE] instead of [OK].
 *
 * Heartbeat: writes runner_heartbeat (ISO timestamp) to the job dir once at spawn, every
 * 60s while the child runs, and once in finish(). checkJob reads this to classify
 * running vs timed_out vs died without relying solely on pid re-stat.
 *
 * runner_job.json: alongside every heartbeat (win32 only), writes this runner's own Job Object
 * membership (queried via tools/jobMembership.mjs), plus its parent pid and whether the parent is
 * still alive. Lets job-core.mjs's checkJob() (and a human reading the job dir after the fact)
 * see whether a runner was ever re-absorbed into a job mid-flight, not just at launch.
 *
 * runner.lock: taken as the very first act (runner-lock.mjs: published complete with link(2), stale
 * takeover by verified rename); a second runner for the same job dir exits 3. One runner per job dir.
 *
 * runner.pid: writes its own process.pid to the job dir before doing anything else. On win32,
 * job-core.mjs's launch() may spawn us indirectly through a PowerShell/CreateProcessW shell-out
 * (to escape the caller's Job Object -- see the win32 note in job-core.mjs), in which case the
 * pid spawn() hands back to job-core is the shell's, not ours; it reads this file instead.
 *
 * Container jobs (spec.container present; see container.mjs and docs/container-jobs.md): `command`
 * is the docker CLI and argv is a `docker run --rm --name claude-async-<jobId> ...` line, so the CLI
 * runs inside the container while this runner keeps owning the child's stdout/stderr, heartbeat,
 * exit.json, card close and Discord ping exactly as for a host job. The container clones its repo
 * itself; no host folder is mounted, so there is no host clone to audit and the card hook never runs
 * host git for a container job. Additions, all inert for host jobs:
 *   (1) Cancel intent: if job-core wrote cancel_requested before this runner got to `docker run`, the
 *       container is never started; while the client runs, the file is polled and the container is
 *       removed the moment it is seen (also right after a container that was still being created
 *       appears). The launch state goes to docker_launch ("pending" BEFORE the spawn, "spawned" with
 *       the client's pid, "exited", or "killed" when a fallback had to kill the client) plus the pid
 *       alone in docker_client.pid, so job-core can tell whether a launch may still be pending even
 *       when this runner died between two of those writes (job-core.mjs containerLaunchPending).
 *   (2) Every stop removes the job's containers BY LABEL (claude-async.job=<jobId>) with
 *       `docker rm -f <id>` (container.mjs cleanupJobContainers), which catches a container in the
 *       Created state too. Stopping the docker client alone leaves the container running.
 *   (3) One bounded stop for cancel, the wall-clock limit (spec.container.maxRuntimeMs) and
 *       SIGTERM/SIGINT/SIGBREAK/SIGHUP: remove the containers (retried at most every
 *       CLAUDE_ASYNC_CONTAINER_RM_RETRY_MS), wait for the client up to
 *       CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS, then kill it and finish with the terminal result
 *       ("cancelled" / "container_max_runtime" (claude_check: timed_out) / "signal") and the cleanup
 *       recorded as NOT confirmed. The runner never reports a container as removed unless the
 *       listing established it.
 *   (5) finish() kills a still-running client, removes the job's containers and records the result
 *       in exit.json as container.cleanup.confirmed, separately from the CLI's own exit: job-core's
 *       checkJob()/cancelJob() keep retrying an unconfirmed cleanup.
 *   (6) exit.json's container record also carries the repo, the PR URL the job reported on stdout
 *       for that repo (prUrl), and a warning when the entrypoint could not clone it (exit 70).
 *   (7) Redaction: the env file's value is read into memory once (never written anywhere), every
 *       installation token this runner mints is added as it is minted, and exit.json's stdout/stderr
 *       tails and the Discord ping's headline are redacted with all of them (plus their base64 forms
 *       and the GitHub/Anthropic token shapes). out.log/err.log on disk stay raw.
 *   (8) GitHub App token delivery (spec.container.githubApp, github-app.mjs): before `docker run` the
 *       runner mints a one-hour installation token scoped to the job's repo and writes it to
 *       <jobdir>/creds/token (dir 0700, file 0600, handed to the container's uid when the runner is
 *       root), which the argv bind-mounts read-only at /run/claude-async/creds for the image's git
 *       credential helper and gh wrapper. Every spec.container.githubApp.refreshMs (default 45 min;
 *       tokens live 60) it re-mints and rewrites the file IN PLACE (write at offset 0, truncate to
 *       the new length, fsync: the same inode the container has, never a rename, so the content
 *       change is what propagates through the bind mount), keeps the old token when a refresh
 *       fails (retrying on the next tick, logging once per distinct error), records a warning in
 *       exit.json when refresh keeps failing within 5 minutes of the token's expiry, and deletes the
 *       file and dir in finish(). A first mint that fails means the container is never started
 *       (exit 78, warning). The App's private key is read from its host path by github-app.mjs on
 *       every mint and is never written, logged or passed anywhere.
 *
 * Atomic write choice: write to runner_heartbeat.tmp then fs.renameSync -> runner_heartbeat.
 * On Windows NTFS, renameSync uses MoveFileExW(MOVEFILE_REPLACE_EXISTING) which is atomic
 * on the same volume. This prevents checkJob from reading a truncated file between the
 * open-for-write and the data flush of a direct overwrite.
 *
 * CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS: test-only knob (see test/pid-heal.mjs) that delays the
 * runner.pid write below by the given number of milliseconds, letting a test force job-core.mjs's
 * launchWin32()/readRunnerPid() poll window to expire so it falls back to the wrapper's pid --
 * exercising checkJob's healMetaPid() path deterministically instead of racing a real timing
 * window. Uses Atomics.wait for a synchronous block since the pid write happens before any async
 * machinery (heartbeat, child spawn) is set up. Production never sets this env var.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeCard } from "./card-hook.mjs";
import { sanitizeEnvForWin32, logIfPathextSanitized, pidAlive, isOurProcess, findDockerClientsForJob } from "./job-core.mjs";
import { createSelfMembershipQuerier } from "./tools/jobMembership.mjs";
import { writeJsonAtomic } from "./atomic.mjs";
import { notifyJobFinished, loadCompletenessConfig, hasCompletenessMarker } from "./discord-notify.mjs";
import { cleanupJobContainers, extractPrUrl, ENTRY_EXIT_CLONE, ENTRY_EXIT_CONFIG, DEFAULT_MAX_RUNTIME_MS, readEnvFileSecretValues,
         redactSecrets, secretEncodings, CREDS_DIR_NAME, CREDS_TOKEN_NAME, CONTAINER_USER, listJobContainers,
         classifyClientExit } from "./container.mjs";
import { createMinter } from "./github-app.mjs";
import { acquireRunnerLock } from "./runner-lock.mjs";

const specPath = process.argv[2];
if (!specPath) process.exit(2);

const pidWriteDelayMs = Number(process.env.CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS) || 0;
if (pidWriteDelayMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pidWriteDelayMs);
}

// Runner exclusivity (review rounds 2 and 3): exactly one runner per job dir. runner.lock holds
// "<pid>\n<nonce>\n" and is published fully initialised in one step (temp file + link, which fails
// with EEXIST when the lock exists); a stale lock (dead pid, or on win32 a pid reused by a non-node
// process, same rule as job-core's isOurProcess; or an empty/unparsable lock older than a few
// seconds) is taken over only through a verified rename, so two runners can never both proceed. A
// second runner for the same spec (a retried launch, a scheduler re-fire, an operator running the
// spec by hand) exits 3 before touching docker, the logs or exit.json. See runner-lock.mjs.
{
  const lockPath = path.join(path.dirname(specPath), "runner.lock");
  const note = (msg) => { try { fs.appendFileSync(path.join(path.dirname(specPath), "err.log"), `\n[job-runner] ${msg}\n`); } catch {} };
  const r = acquireRunnerLock(lockPath, { isLive: (pid) => pidAlive(pid) && isOurProcess(pid) });
  if (!r.acquired) {
    note(r.reason === "held"
      ? `another runner (pid ${r.holder}) owns this job dir (runner.lock); this runner (pid ${process.pid}) exits without starting anything`
      : r.reason === "initialising"
        ? `runner.lock exists but is still being written by another runner; this runner (pid ${process.pid}) exits without starting anything`
        : `lost the race for runner.lock (${r.reason}${r.holder ? `, now held by pid ${r.holder}` : ""}); this runner (pid ${process.pid}) exits`);
    process.exit(3);
  }
  if (r.tookOverFrom !== undefined) note(`stale runner.lock (pid ${r.tookOverFrom === null ? "unreadable" : r.tookOverFrom}, not alive); taken over by pid ${process.pid}`);
}

// Written before anything else that could fail. On win32 the runner may be launched via the
// CREATE_BREAKAWAY_FROM_JOB shell-out (see job-core.mjs launch()), so the pid job-core gets
// back from spawn() is the wrapper's, not ours; it reads this file to learn our real pid.
try {
  const pidPath = path.join(path.dirname(specPath), "runner.pid");
  const tmp = pidPath + ".tmp";
  fs.writeFileSync(tmp, String(process.pid), "utf8");
  fs.renameSync(tmp, pidPath);
} catch { /* best-effort; launch() falls back to the wrapper's pid after a short timeout */ }

let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, "utf8")); }
catch { process.exit(2); }

const { command, argv, cwd, out, err, exit } = spec;
// Container jobs only (see the header): { name, jobId, dockerBin, repo, maxRuntimeMs, envFile, credsDir,
// githubApp: { appId, keyFile, installationId, repoName, refreshMs, apiBase } }. null for host jobs.
const containerSpec = spec.container && typeof spec.container === "object" ? spec.container : null;

const heartbeatPath = path.join(path.dirname(specPath), "runner_heartbeat");
// Container jobs: cancel intent (written by job-core) and the docker client's pid (written here).
const cancelPath = path.join(path.dirname(specPath), "cancel_requested");
const dockerPidPath = path.join(path.dirname(specPath), "docker_client.pid");
// Container jobs: the launch state job-core reads to decide whether a `docker run` could still
// create a container (see job-core.mjs containerLaunchPending). Written BEFORE the client is
// spawned ("pending"), again once its pid is known ("spawned"), when the client exited after its
// launch demonstrably completed ("exited": no further creation possible), when it exited in a way
// that proves nothing ("exited-uncertain": e.g. killed by someone else before this runner saw the
// container; a descendant or the daemon may still create it; container.mjs classifyClientExit) and
// when this runner had to kill it ("killed": the daemon may still be serving its create request). A runner that dies between any two of these
// leaves the earlier state behind, which job-core treats as "uncertain", never as "done".
const dockerLaunchPath = path.join(path.dirname(specPath), "docker_launch");
// observedRunning: this runner saw the job's container listed while the client ran (creation had
// completed); launchState: the last docker_launch state written (review round 3, B2).
const containerState = { cancelled: false, runtimeExceeded: false, fallbackFired: false, lastCleanupError: null,
                         observedRunning: false, launchState: null };
// Container jobs: the GitHub App installation token on disk (see header item 8).
const credsDir = containerSpec ? (containerSpec.credsDir || path.join(path.dirname(specPath), CREDS_DIR_NAME)) : null;
const tokenPath = credsDir ? path.join(credsDir, CREDS_TOKEN_NAME) : null;
const tokenState = { generations: 0, expiresAt: 0, lastError: null, lastLoggedError: null, startFailed: null, inFlight: false };
const TOKEN_EXPIRY_WARN_MS = 5 * 60 * 1000;
let tokenRefresh = null;
function writeLaunchState(state, pid = null) {
  containerState.launchState = state;
  const tmp = dockerLaunchPath + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify({ state, pid, runnerPid: process.pid, at: new Date().toISOString() }), "utf8");
    fs.renameSync(tmp, dockerLaunchPath);
  } catch { try { fs.writeFileSync(dockerLaunchPath, JSON.stringify({ state, pid, runnerPid: process.pid, at: new Date().toISOString() })); } catch {} }
}
// Kills the docker client (fallback paths only) and records that its create request may be in flight.
function killClient(child) {
  if (!child || (child.exitCode !== null || child.signalCode !== null)) return;
  writeLaunchState("killed", child.pid || null);
  try { child.kill("SIGKILL"); } catch {}
}
// Container jobs: the secret values to redact from anything that leaves this runner. In memory only.
// The env file's value(s) now; every installation token generation is appended as it is minted.
const redactValues = containerSpec ? [...readEnvFileSecretValues(containerSpec.envFile)] : [];
const addRedactValue = (v) => { for (const e of secretEncodings([v])) if (!redactValues.includes(e)) redactValues.push(e); };
const redact = (text) => (containerSpec ? redactSecrets(text, redactValues) : text);

// 2026-09-09 runner-termination investigation: self-reported Job Object membership, refreshed on
// every heartbeat, so a job's death can be correlated against "was this runner actually free of
// its ambient job the whole time" instead of trusting the launch-time breakaway result alone. The
// helper process is spawned once (Add-Type JIT cost paid once) and polled cheaply thereafter --
// see tools/jobMembership.mjs and tools/query-job-membership.ps1 for why this only ever reports
// on the runner's OWN job (via Windows' automatic job-nesting of a plain, non-breakaway child).
const jobMembershipPath = path.join(path.dirname(specPath), "runner_job.json");
const membershipQuerier = createSelfMembershipQuerier();
// null = "no prior check yet" -- distinct from false, so the very first check never logs a
// spurious "became a member" transition for a runner that was already in a job from the start.
let lastMembershipInJob = null;

async function writeJobMembership() {
  const membership = await membershipQuerier.query(process.pid);
  const parentAlive = pidAlive(process.ppid);
  const record = { ts: new Date().toISOString(), pid: process.pid,
                    parentPid: process.ppid, parentAlive, ...membership };
  const tmp = jobMembershipPath + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(tmp, jobMembershipPath);
  } catch { /* best-effort, same as writeHeartbeat */ }

  if (membership.inJob && lastMembershipInJob === false) {
    try { fs.writeSync(errFd, `\n[job-runner] WARN: ${record.ts} pid=${process.pid} became a member of a ` +
      `Job Object (was not at the previous check) -- membership=${JSON.stringify(membership)}\n`); } catch {}
  }
  lastMembershipInJob = !!membership.inJob;
}

function writeHeartbeat() {
  const ts = new Date().toISOString();
  const tmp = heartbeatPath + ".tmp";
  try {
    fs.writeFileSync(tmp, ts, "utf8");
    fs.renameSync(tmp, heartbeatPath);
  } catch {
    // If rename fails (e.g., cross-device — shouldn't happen but belt-and-suspenders), fall
    // back to a direct write; a torn read is treated as stale (safe, conservative).
    try { fs.writeFileSync(heartbeatPath, ts, "utf8"); } catch {}
  }
}

// Append mode: each write goes to end-of-file, so the runner's own diagnostics never clobber
// the child's captured output.
const outFd = fs.openSync(out, "a");
const errFd = fs.openSync(err, "a");

// Exit record: written to its OWN file (exit.json, next to meta.json), never merged into
// meta.json. meta.json already has a writer (job-core), and a second, independent
// read-modify-write from this process racing that one would silently drop whichever side lost
// the rename -- one writer per file. Fields: exitCode/exitSignal/exitReason ("exit" | "signal" |
// "spawn-error" (+ spawnError on a spawn failure) | "bg_tasks_terminated", see
// BG_TASKS_TERMINATED_RE above), endedAt, stderrTail/stdoutTail -- the last TAIL_LINES lines read
// straight off out.log/err.log on disk at exit time (not a ring buffer kept in memory), since
// stdout/stderr go to those files' fds directly and the runner never sees the bytes itself -- and
// reportComplete: whether stdoutTail carries the DELEGATION-METRICS final-report marker (see
// discord-notify.mjs's hasCompletenessMarker/loadCompletenessConfig). This is purely additive,
// objective reporting (computed from the configured marker regardless of whether completeness
// enforcement or even Discord notification is turned on) so claude_check's verbatim `exit` field
// surfaces it for free, same as every other exit.json field.
const TAIL_LINES = 20;
// Upper bound on how much of a log file readTail() will read off disk. A job's out.log/err.log
// can grow to many MB; reading the whole file just to keep the last 20 lines would be wasteful
// (and slow) for a long-running or chatty job. 64 KiB is comfortably more than 20 lines of any
// realistic CLI output while staying cheap to read on every exit.
const TAIL_BYTES = 64 * 1024;

// Reads at most the last TAIL_BYTES of `file` and returns its last TAIL_LINES lines. When the
// read window starts after byte 0 (file bigger than TAIL_BYTES), the first line of the read
// chunk is discarded: it is very likely a partial line (and, for multibyte UTF-8 content,
// possibly a partial/split character too), since the cut point lands mid-line rather than on a
// line boundary. For container jobs this is also what keeps redaction sound at the window
// boundary: a token never spans a newline, so a window that starts inside a token drops that
// token's remainder with the partial line, and redact() then only ever sees whole lines (tested in
// test/container-runner.test.mjs, round-2 A3). Any failure (missing file, read error, decode
// error, ...) yields [] -- this is best-effort diagnostic data, never allowed to break exit recording.
// Container jobs: how many lines of stdout extractPrUrl() looks at.
const PR_SCAN_LINES = 400;

function readTail(file, maxLines = TAIL_LINES) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // Started mid-file: drop everything up to and including the first newline in the chunk,
      // since that first "line" is actually the tail end of a line (or character) that began
      // before our read window.
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    if (!text) return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // trailing newline from the last write
    return lines.slice(-maxLines).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

let exitInfo = { exitCode: null, exitSignal: null, exitReason: "exit" };

// 2026-10-18 claunker.gemini-mcp-v2-20261018-pfvzx44f: job claunker.gemini-mcp-v2-20261018-pfvzx44f
// handed work to a background subagent, ended its turn, and the CLI's own "wait for background
// tasks" ceiling (600s default) fired and killed that work half-done -- but the CLI still exited
// 0, so the job silently recorded status "completed". Matched loosely (the second count varies
// by build) and kept in this ONE place: recordExit() below is the only place this regex is
// tested, and job-core.mjs's checkJob()/discord-notify.mjs's markerFor() both key off the
// exitReason value it produces ("bg_tasks_terminated") rather than re-matching the string.
const BG_TASKS_TERMINATED_RE = /Background tasks still running after \d+s; terminating/;

// 2026-10-19 auto-background gap (claunker.agents-md-seat-isolation-20261019-fbkk7h1a, see
// job-core.mjs's JOB_BASH_MAX_TIMEOUT_MS comment for the full story). job-core.mjs now sets
// CLAUDE_CODE_DISABLE_BACKGROUND_TASKS for non-ultracode jobs so this should no longer happen
// going forward, but ultracode jobs are exempted (Workflow needs background) and an operator
// could still override the ambient env back on -- so this stays as a visible trip-wire rather
// than silent. Matches the one CLI-emitted string confirmed in claude.exe 2.1.303's bundle for a
// backgrounded command being killed for running too long: a small "friendly messages" dictionary
// keyed by kill reason, with "deadline" (as opposed to the sibling "memory_pressure" reason)
// mapped to exactly this text. Checked against BOTH tails: this job's argv runs `-p` in plain-text
// mode (no --output-format stream-json), so the only way this string could reach disk at all is
// if the model's own reply quotes/paraphrases a tool result that carried it -- there is no
// guarantee it does, which is why this is a best-effort warning, not a status change.
const BASH_AUTO_BACKGROUND_KILLED_RE = /stopped after reaching its background time limit/;

// Container jobs: remove every container carrying this job's label. Returns cleanupJobContainers()'s
// result; logs a failure once per distinct error so a poll loop doesn't flood err.log.
function removeJobContainers(why) {
  let r;
  try { r = cleanupJobContainers({ dockerBin: containerSpec.dockerBin || command, jobId: containerSpec.jobId || path.basename(path.dirname(specPath)) }); }
  catch (e) { r = { ok: false, error: e.message }; }
  const errText = !r.ok ? r.error : (!r.absent ? "a container is still listed after docker rm -f" : null);
  if (errText && errText !== containerState.lastCleanupError) {
    containerState.lastCleanupError = errText;
    try { fs.writeSync(errFd, `\n[job-runner] WARN: removing container ${containerSpec.name} (${why}) failed: ${errText}\n`); } catch {}
  }
  return r;
}

// ------------------------------------------------------------- GitHub App token file (8) ---

const containerUid = Number(String(CONTAINER_USER).split(":")[0]);
// As root (a Linux host), hand the dir and file to the container's uid: a 0600 file owned by root
// is unreadable to uid 1000 inside. As any other user the runner's own uid stays (it must then be
// the container's uid, or the engine's file sharing must not enforce host modes, as Docker Desktop's
// does not). Best-effort: EPERM is expected when not root.
function chownToContainer(p) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) return;
  try { fs.chownSync(p, containerUid, containerUid); } catch {}
}
function ensureCredsDir() {
  fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(credsDir, 0o700); } catch {}
  chownToContainer(credsDir);
}
// In place, never a rename: the container holds the DIRECTORY as a bind mount, and what must reach
// it is new content in the same file. Write the new token at offset 0, then truncate to its length
// (tokens of one app are the same length, so a reader never sees an empty file), then fsync. A
// rename would also work for a directory mount on Linux, but a bind mount through Docker Desktop's
// file sharing is what claunker runs, and in-place content changes are the propagation the smoke
// test measures; one mechanism, measured, rather than two.
function writeTokenFile(token) {
  const data = `${token}\n`;
  const existed = fs.existsSync(tokenPath);
  const fd = fs.openSync(tokenPath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
  try {
    fs.writeSync(fd, data, 0, "utf8");
    fs.ftruncateSync(fd, Buffer.byteLength(data));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (!existed) { try { fs.chmodSync(tokenPath, 0o600); } catch {} chownToContainer(tokenPath); }
}
function removeCredsDir() {
  if (!credsDir) return;
  try { fs.rmSync(credsDir, { recursive: true, force: true }); } catch (e) {
    try { fs.writeSync(errFd, `\n[job-runner] WARN: could not delete ${credsDir}: ${e.message}\n`); } catch {}
  }
}
let minter = null;
// Mints a fresh installation token and rewrites the file. Returns true on success. On failure the
// previous token stays in place (it is still valid until its expiry) and the next tick retries.
async function refreshToken(why) {
  if (tokenState.inFlight) return false;
  tokenState.inFlight = true;
  try {
    const { token, expiresAt } = await minter.mint();
    addRedactValue(token);
    writeTokenFile(token);
    tokenState.generations++;
    tokenState.expiresAt = expiresAt;
    if (tokenState.lastError) { try { fs.writeSync(errFd, `\n[job-runner] GitHub App installation token refreshed after earlier failures (generation ${tokenState.generations})\n`); } catch {} }
    tokenState.lastError = null; tokenState.lastLoggedError = null;
    return true;
  } catch (e) {
    const msg = redact(String(e && e.message || e));
    tokenState.lastError = msg;
    const leftMs = tokenState.expiresAt ? tokenState.expiresAt - Date.now() : 0;
    if (msg !== tokenState.lastLoggedError) {
      tokenState.lastLoggedError = msg;
      try {
        fs.writeSync(errFd, `\n[job-runner] WARN: GitHub App installation token refresh failed (${why}): ${msg}; ` +
          (tokenState.generations ? `keeping the current token (expires in ${Math.max(0, Math.round(leftMs / 60000))} min), retrying every ${refreshMs()} ms` : "no token yet") + "\n");
      } catch {}
    }
    if (tokenState.generations && leftMs < TOKEN_EXPIRY_WARN_MS && !tokenState.nearExpiryLogged) {
      tokenState.nearExpiryLogged = true;
      try { fs.writeSync(errFd, `\n[job-runner] WARN: the installation token is within ${TOKEN_EXPIRY_WARN_MS / 60000} minutes of expiry (or expired) and refresh keeps failing; git/gh calls in the container will start failing\n`); } catch {}
    }
    return false;
  } finally { tokenState.inFlight = false; }
}
const refreshMs = () => Math.max(50, Number(containerSpec && containerSpec.githubApp && containerSpec.githubApp.refreshMs) || 45 * 60_000);
// Before `docker run`: the creds dir, the minter, the first token, the refresh timer. Returns true
// when the container may start. On failure records the cause for exit.json (startFailed).
async function prepareGitHubToken() {
  const ga = containerSpec.githubApp;
  if (!ga || !ga.appId || !ga.keyFile || !ga.installationId || !ga.repoName) {
    tokenState.startFailed = "spec.container.githubApp is missing or incomplete (appId, keyFile, installationId, repoName); this spec was not written by a job-core that knows the GitHub App";
    return false;
  }
  try {
    ensureCredsDir();
    minter = createMinter({ appId: ga.appId, keyFile: ga.keyFile, installationId: ga.installationId, repoName: ga.repoName, apiBase: ga.apiBase || undefined });
  } catch (e) { tokenState.startFailed = redact(String(e && e.message || e)); return false; }
  if (!(await refreshToken("initial"))) { tokenState.startFailed = tokenState.lastError; return false; }
  tokenRefresh = setInterval(() => { if (!done) refreshToken("periodic").catch(() => {}); }, refreshMs());
  tokenRefresh.unref();
  return true;
}

// Best-effort: a runner that cannot record must still finish normally. cleanup: container jobs'
// cleanup record from finish() ({ confirmed, removed, error? }).
function recordExit(cleanup = null) {
  const exitPath = path.join(path.dirname(specPath), "exit.json");
  const stdoutTail = readTail(out).map(redact);
  const stderrTail = readTail(err).map(redact);
  let completeness;
  try { completeness = loadCompletenessConfig(); } catch { completeness = { markerRegex: undefined }; }
  // Only overrides a plain "exit" (the CLI ran and exited on its own, which is what printing its
  // own ceiling-reached line implies) -- never a signal or spawn-error, which mean something else
  // entirely happened.
  let exitReason = exitInfo.exitReason === "exit" && BG_TASKS_TERMINATED_RE.test(stderrTail.join("\n"))
    ? "bg_tasks_terminated"
    : exitInfo.exitReason;
  // Container jobs: the client exited because WE removed its container (cancel, wall-clock limit).
  // "signal" here is this runner's own fallback kill of the client (the stop wait passed), which
  // is still a cancel or a wall-clock stop, not a failure of its own kind.
  const ownStop = exitReason === "exit" || exitReason === "cancelled" || (exitReason === "signal" && containerState.fallbackFired);
  if (containerSpec && containerState.cancelled && ownStop) exitReason = "cancelled";
  else if (containerSpec && containerState.runtimeExceeded && ownStop) exitReason = "container_max_runtime";
  const combinedTail = `${stdoutTail.join("\n")}\n${stderrTail.join("\n")}`;
  const warnings = [];
  if (BASH_AUTO_BACKGROUND_KILLED_RE.test(combinedTail)) {
    warnings.push("a shell command appears to have been auto-backgrounded by the CLI and then " +
      "killed for exceeding its background time limit; any result it was meant to produce may be " +
      "missing even though the job exited normally");
  }
  let containerRecord;
  if (containerSpec) {
    // The PR the job reported for its own repo (searched over the whole stdout tail window the runner
    // reads, not just the last 20 lines, since the report usually ends with the delegation lines).
    let prUrl = null;
    try { prUrl = extractPrUrl(readTail(out, PR_SCAN_LINES), containerSpec.repo); } catch {}
    containerRecord = { name: containerSpec.name, repo: containerSpec.repo || null, prUrl,
                        cleanup: cleanup || { confirmed: false, error: "not attempted" },
                        cancelled: containerState.cancelled, maxRuntimeExceeded: containerState.runtimeExceeded };
    if (containerState.runtimeExceeded) {
      warnings.push(`the container ran past its wall-clock limit (${containerSpec.maxRuntimeMs} ms, ` +
        "CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS) and was stopped" +
        (cleanup && cleanup.confirmed ? "; its removal is confirmed" : "; its removal is NOT confirmed yet (claude_check retries it)"));
    }
    // 125 is docker run's own failure (daemon down, bad flag, image refused), not the CLI's.
    if (exitInfo.exitCode === 125) warnings.push("docker run itself failed (exit 125) before or while starting the container; see stderrTail");
    if (tokenState.startFailed) {
      warnings.push(`could not mint the GitHub App installation token: ${tokenState.startFailed}; the container was not started ` +
        `(exit ${ENTRY_EXIT_CONFIG}). Check CLAUDE_ASYNC_GITHUB_APP_ID / _KEY_FILE and that the App is installed on ${containerSpec.repo}`);
    } else if (tokenState.lastError && (!tokenState.expiresAt || tokenState.expiresAt - Date.now() < TOKEN_EXPIRY_WARN_MS)) {
      const expired = tokenState.expiresAt && tokenState.expiresAt <= Date.now();
      warnings.push(`the GitHub App installation token could not be refreshed (last error: ${tokenState.lastError}) and ` +
        `${expired ? "had expired" : "was within 5 minutes of its expiry"} when the job ended (generations minted: ${tokenState.generations}); ` +
        "git/gh calls late in the job may have failed with authentication errors");
    }
    if (exitInfo.exitCode === ENTRY_EXIT_CLONE) {
      warnings.push(`the container could not clone ${containerSpec.repo} (exit ${ENTRY_EXIT_CLONE} from the image's entrypoint); ` +
        "check that the bot can read the repo and that baseRef exists; see stderrTail");
    }
  }
  const record = {
    exitCode: exitInfo.exitCode,
    exitSignal: exitInfo.exitSignal,
    exitReason,
    endedAt: new Date().toISOString(),
    stderrTail,
    stdoutTail,
    // No reliable CLI usage-limit message pattern exists in this repo (no fixture or test carries
    // one), so this is deliberately unknown rather than a guessed regex.
    usageLimitSuspected: null,
    reportComplete: hasCompletenessMarker(stdoutTail, completeness.markerRegex),
    ...(warnings.length ? { warnings } : {}),
    ...(containerRecord ? { container: containerRecord } : {}),
  };
  if (exitInfo.spawnError !== undefined) record.spawnError = exitInfo.spawnError;
  try { writeJsonAtomic(exitPath, record); }
  catch (e) { try { fs.writeSync(errFd, `\n[job-runner] could not write exit.json: ${e.message}\n`); } catch {} }
  return record;
}

let done = false;
let hbInterval;

async function finish(code) {
  if (done) return;
  done = true;
  if (hbInterval) clearInterval(hbInterval);
  writeHeartbeat(); // final heartbeat immediately before recording exit code
  // Wrapped so a throw here (e.g. the membership-query child process misbehaving on close)
  // cannot skip the exit_code / exit.json / card-close writes below.
  try { membershipQuerier.close(); } catch {}
  // Container jobs: the client must be gone first (so it can't create or start anything after the
  // cleanup below), then nothing with the job's label may be left. Normally the client has exited
  // and --rm already removed the container, so this lists nothing.
  let cleanupRecord = null;
  if (containerSpec) {
    if (containerWatch) clearInterval(containerWatch);
    if (tokenRefresh) clearInterval(tokenRefresh);
    if (child && child.exitCode === null && child.signalCode === null) { containerState.fallbackFired = true; killClient(child); }
    try {
      // Liveness first, listing second (review round 3, B2), in EVERY launch state: a surviving
      // launch process (Docker Desktop's com.docker.cli.exe after docker.exe was killed, a client
      // this runner's kill has not reaped yet) may still create the container after the listing.
      const jobIdForScan = containerSpec.jobId || path.basename(path.dirname(specPath));
      let survivors;
      try { survivors = findDockerClientsForJob(jobIdForScan); } catch { survivors = null; }
      const r = removeJobContainers("finish");
      const absent = !!(r.ok && r.absent);
      const uncertain = containerState.launchState === "exited-uncertain";
      // A client that had to be killed after the stop wait, or one that ended without this runner
      // seeing its launch complete, may have had a create request in flight daemon-side, so its
      // cleanup is never confirmed here; checkJob() confirms it later (scan, hold, listing).
      const scanClear = Array.isArray(survivors) && survivors.length === 0;
      const confirmed = absent && !containerState.fallbackFired && !uncertain && scanClear;
      cleanupRecord = { confirmed, removed: r.removed || 0,
                        ...(!r.ok ? { error: r.error } : !absent ? { error: "a container is still listed after docker rm -f" } : {}),
                        ...(containerState.fallbackFired ? { clientKilled: true, reason: "the docker client did not exit within the stop wait and was killed" } : {}),
                        ...(uncertain ? { uncertainExit: true, reason: "the docker client exited before this runner saw its container (killed by someone else?); a descendant or the daemon may still create it" } : {}),
                        ...(survivors === null ? { reason: "the process scan for this job's docker client failed" }
                          : survivors.length ? { survivors, reason: `a process carrying this job's label is still alive (pid ${survivors.join(", ")})` } : {}) };
      if (absent && r.removed > 0 && !containerState.cancelled && !containerState.runtimeExceeded) {
        fs.writeSync(errFd, `\n[job-runner] container ${containerSpec.name} was still present after docker exited; removed it\n`);
      }
      if (!confirmed) {
        fs.writeSync(errFd, `\n[job-runner] WARN: container cleanup for ${containerSpec.name} not confirmed ` +
          `(${cleanupRecord.error || cleanupRecord.reason}); claude_check / claude_cancel retry it\n`);
      }
    } catch {}
    // The token file goes with the job, whatever the cleanup result (a container that somehow
    // survived loses its credential rather than keeping one on disk).
    removeCredsDir();
  }
  // Write exit.json BEFORE exit_code (and therefore before closeCard() too): exit_code is the
  // signal most external readers poll for "the job is done", so any reader that observes
  // exit_code must be able to rely on exit.json already existing on disk.
  let exitRecord = null;
  try { exitRecord = recordExit(cleanupRecord); } catch {}
  try { fs.writeFileSync(exit, String(code)); } catch {}
  // Card hook: read meta.json (written by job-core before launching us) for cardId/startHead.
  // Reading here (after child exits) avoids any startup race with job-core's meta write.
  let cardId = null, startHead = null, jobId = null, startedAt = null, intent = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(path.dirname(specPath), "meta.json"), "utf8"));
    cardId = m.cardId || null;
    startHead = m.startHead || null;
    jobId = m.jobId || null;
    startedAt = m.startedAt || null;
    intent = m.intent || null;
  } catch {}
  // Container jobs: never host git. The repo exists only inside the (now gone) container, and the
  // delivery is exit.json's container.prUrl, so the card's HEAD-moved check is skipped entirely.
  try { closeCard(cardId, code, cwd, containerSpec ? null : startHead, exitRecord); } catch {}
  // Discord ping: strictly best-effort and bounded (see discord-notify.mjs). Runs AFTER exit.json
  // and exit_code are both on disk, and is awaited (its own timeout bounds the wait) so the
  // process does not exit mid-request -- but nothing here can change `code` or any file already
  // written above.
  try {
    await notifyJobFinished({
      jobId: jobId || path.basename(path.dirname(specPath)),
      intent,
      host: os.hostname(),
      exitCode: exitInfo.exitCode,
      exitReason: exitRecord ? exitRecord.exitReason : exitInfo.exitReason,
      startedAt,
      endedAt: new Date(exitRecord && exitRecord.endedAt ? exitRecord.endedAt : Date.now()),
      stdoutLines: (exitRecord && exitRecord.stdoutTail) || [],
      outLogPath: out,
      reportComplete: exitRecord ? exitRecord.reportComplete : true,
      ...(containerSpec ? { redact } : {}),
      logLine: (msg) => { try { fs.writeSync(errFd, `\n[job-runner] ${msg}\n`); } catch {} },
    });
  } catch {}
  try { fs.closeSync(outFd); } catch {}
  try { fs.closeSync(errFd); } catch {}
  process.exit(0);
}

// Initial heartbeat at spawn so checkJob sees "alive" even before the first 60s tick.
writeHeartbeat();
writeJobMembership().catch(() => {});

// Periodic heartbeat while the child runs. unref() so the interval doesn't prevent exit if
// the child is already gone (child.on("exit") listener is what keeps the loop alive).
// Override for tests (e.g. test/detach-survival.mjs) that need to observe progression in
// seconds rather than minutes; production always uses the 60s default.
const HEARTBEAT_MS = Number(process.env.CLAUDE_ASYNC_HEARTBEAT_MS) || 60_000;
hbInterval = setInterval(() => {
  writeHeartbeat();
  writeJobMembership().catch(() => {});
}, HEARTBEAT_MS);
hbInterval.unref();

// Belt-and-suspenders: job-core.mjs's launchWin32() already sanitizes PATHEXT before spawning the
// wrapper that eventually leads here, but this repairs it again in case a future launch path ever
// gets us started some other way -- see sanitizeEnvForWin32()'s header comment in job-core.mjs.
const spawnEnv = sanitizeEnvForWin32(process.env);
logIfPathextSanitized(err, process.env, spawnEnv, `spawning ${command}`);

let child;
let containerWatch = null;
// Cancelled before `docker run`: never start the container at all.
function finishCancelledBeforeLaunch() {
  containerState.cancelled = true;
  try { fs.writeSync(errFd, `\n[job-runner] cancel requested before docker run; not starting container ${containerSpec.name}\n`); } catch {}
  exitInfo = { exitCode: null, exitSignal: null, exitReason: "cancelled" };
  finish(130);
}
if (containerSpec && fs.existsSync(cancelPath)) {
  finishCancelledBeforeLaunch();
} else if (containerSpec) {
  // Container jobs: the GitHub App installation token must be on disk (for the creds mount) before
  // the container starts; minting is a network call, so the spawn happens in its continuation. A
  // cancel that lands during the mint is honoured before anything is spawned.
  prepareGitHubToken().then((ready) => {
    if (done) return;
    if (fs.existsSync(cancelPath)) { finishCancelledBeforeLaunch(); return; }
    if (!ready) {
      try { fs.writeSync(errFd, `\n[job-runner] could not mint the GitHub App installation token: ${tokenState.startFailed}; not starting container ${containerSpec.name}\n`); } catch {}
      exitInfo = { exitCode: ENTRY_EXIT_CONFIG, exitSignal: null, exitReason: "exit" };
      finish(ENTRY_EXIT_CONFIG);
      return;
    }
    startChild();
  }).catch((e) => {
    if (done) return;
    tokenState.startFailed = redact(String(e && e.message || e));
    exitInfo = { exitCode: ENTRY_EXIT_CONFIG, exitSignal: null, exitReason: "exit" };
    finish(ENTRY_EXIT_CONFIG);
  });
} else {
  startChild();
}

// Spawns the job's command (the CLI for host jobs, the docker client for container jobs) and wires
// its exit. Host jobs reach here synchronously at module load, exactly as before container mode.
function startChild() {
  // Container jobs: "a launch is pending" is on disk BEFORE the spawn, so a runner that dies in the
  // next few lines can never be mistaken for one that never got this far.
  if (containerSpec) writeLaunchState("pending");
  try {
    child = spawn(command, argv, { cwd, stdio: ["ignore", outFd, errFd], windowsHide: true, env: spawnEnv });
  } catch (e) {
    if (containerSpec) writeLaunchState("exited");
    try { fs.writeSync(errFd, `\n[job-runner] failed to start ${command}: ${e.message}\n`); } catch {}
    exitInfo = { exitCode: null, exitSignal: null, exitReason: "spawn-error", spawnError: e.message };
    finish(127);
    return;
  }
  if (containerSpec) watchContainer();
  wireChildExit();
}

// Container jobs: the docker client's pid (job-core's "may a launch still be pending?"), then a poll
// for the cancel intent and the wall-clock limit. Either one removes the job's containers on every
// tick until the client exits, which also catches a container that was still being created when
// the cancel arrived.
function watchContainer() {
  // Test-only knob (test/container-runner.test.mjs, finding A1): die between the spawn and the pid
  // write, the exact window a TerminateProcess can hit. Production never sets this.
  if (process.env.CLAUDE_ASYNC_TEST_DIE_AFTER_SPAWN === "1") process.kill(process.pid, "SIGKILL");
  try { if (child.pid) fs.writeFileSync(dockerPidPath, String(child.pid)); } catch {}
  writeLaunchState("spawned", child.pid || null);
  // One bounded stop procedure for every way a running container job ends early: a cancel
  // (cancel_requested), the wall-clock limit, and a catchable signal to this runner. It removes the
  // job's containers by label now, retries at most every CLAUDE_ASYNC_CONTAINER_RM_RETRY_MS (the
  // docker calls are synchronous, up to 15 s each, so a retry on every 1 s poll tick would starve
  // the heartbeat), and if the client has not exited after CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS it
  // kills the client and finishes with the terminal result (cancelled / container_max_runtime /
  // signal) and the cleanup recorded as NOT confirmed, so job-core's reconcile keeps retrying.
  // Windows TerminateProcess can't be caught at all, which is why job-core's checkJob() also cleans
  // up after a runner that died, and cancelJob() removes the containers itself.
  const stopWaitMs = Number(process.env.CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS) || 30_000;
  const rmRetryMs = Number(process.env.CLAUDE_ASYNC_CONTAINER_RM_RETRY_MS) || 5_000;
  const stop = { started: false, lastAttemptEnd: 0, sig: null };
  const tryRemove = (why) => {
    if (done) return;
    const r = removeJobContainers(why);
    stop.lastAttemptEnd = Date.now();
    return r;
  };
  const beginStop = (why, { sig = null, exitCode = 137 } = {}) => {
    if (stop.started) return;
    stop.started = true;
    stop.sig = sig;
    try { fs.writeSync(errFd, `\n[job-runner] ${why}; removing container ${containerSpec.name} (stop wait ${stopWaitMs} ms)\n`); } catch {}
    tryRemove(why);
    setTimeout(() => {
      if (done) return;
      containerState.fallbackFired = true;
      try { fs.writeSync(errFd, `\n[job-runner] WARN: the docker client did not exit within ${stopWaitMs} ms after ${why}; killing it. ` +
        "The container may still exist; cleanup is recorded as not confirmed and claude_check / claude_cancel retry it\n"); } catch {}
      killClient(child);
      exitInfo = { exitCode: null, exitSignal: sig || "SIGKILL", exitReason: "signal" };
      finish(sig ? 1 : exitCode);
    }, stopWaitMs).unref();
  };
  // A cancel that landed between the pre-spawn check and here is acted on at once, not on the
  // first poll tick.
  if (fs.existsSync(cancelPath)) {
    containerState.cancelled = true;
    beginStop("cancel request seen right after docker run started");
  }
  const startedMs = Date.now();
  const maxRuntimeMs = Number(containerSpec.maxRuntimeMs) > 0 ? Number(containerSpec.maxRuntimeMs) : DEFAULT_MAX_RUNTIME_MS;
  const pollMs = Number(process.env.CLAUDE_ASYNC_CONTAINER_POLL_MS) || 1000;
  const observeMs = Math.max(pollMs, Number(process.env.CLAUDE_ASYNC_CONTAINER_OBSERVE_MS) || 1000);
  let lastObserve = 0;
  containerWatch = setInterval(() => {
    if (done) return;
    if (!containerState.cancelled && fs.existsSync(cancelPath)) {
      containerState.cancelled = true;
      beginStop("cancel request seen");
    }
    if (!containerState.runtimeExceeded && Date.now() - startedMs > maxRuntimeMs) {
      containerState.runtimeExceeded = true;
      beginStop(`wall-clock limit (${maxRuntimeMs} ms) reached`);
    }
    // Review round 3 (B2): until this runner has seen the job's container listed once, look for it
    // (throttled), so a later client exit can be told apart from a launch that never completed.
    if (!containerState.observedRunning && !stop.started && Date.now() - lastObserve >= observeMs) {
      lastObserve = Date.now();
      try {
        const l = listJobContainers({ dockerBin: containerSpec.dockerBin || command, jobId: containerSpec.jobId || path.basename(path.dirname(specPath)) });
        if (!l.error && l.containers.length) containerState.observedRunning = true;
      } catch {}
    }
    // Still attached after the first attempt (a container still being created, a slow daemon):
    // retry, throttled.
    if (stop.started && Date.now() - stop.lastAttemptEnd >= rmRetryMs) tryRemove("retry");
  }, pollMs);
  containerWatch.unref();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]) {
    process.on(sig, () => beginStop(`${sig} received`, { sig }));
  }
}

function wireChildExit() {
  child.on("error", (e) => {
    try { fs.writeSync(errFd, `\n[job-runner] spawn error for ${command}: ${e.message}\n`); } catch {}
    if (!done) exitInfo = { exitCode: null, exitSignal: null, exitReason: "spawn-error", spawnError: e.message };
    finish(127);
  });
  child.on("exit", (code, signal) => {
    // On Windows, an external kill (taskkill /F, Task Manager -> End Task/TerminateProcess, a
    // job-object teardown, ...) arrives here as signal=null with an exit code -- typically 1,
    // the same code Node reports for a plain unhandled-error exit. That makes an externally
    // killed process indistinguishable from an ordinary nonzero exit on this platform, so it is
    // recorded as exitReason "exit", not "signal". This is DELIBERATE: no heuristic is added to
    // try to detect "was this really a kill" from code 1 alone, because 1 is also the CLI's
    // ordinary error exit code -- any such heuristic would misclassify real CLI failures.
    exitInfo = { exitCode: code, exitSignal: signal, exitReason: signal ? "signal" : "exit" };
    // Container jobs: a client whose launch demonstrably completed can't create anything any more
    // ("exited"); one that ended before this runner saw its container proves nothing
    // ("exited-uncertain", review round 3 B2); one this runner killed (fallback) keeps "killed".
    if (containerSpec && !containerState.fallbackFired) {
      writeLaunchState(classifyClientExit({ observedRunning: containerState.observedRunning, code, signal }), child.pid || null);
    }
    finish(code == null ? (signal ? 1 : 0) : code);
  });
}
