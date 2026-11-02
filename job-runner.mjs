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
 *   (3) SIGTERM/SIGINT/SIGBREAK/SIGHUP: remove the containers, then wait for the client; if it never
 *       exits (wedged daemon), kill the client after CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS and record
 *       the cleanup as NOT confirmed.
 *   (4) A wall-clock limit (spec.container.maxRuntimeMs): past it the containers are removed and the
 *       exit is recorded as exitReason "container_max_runtime" (claude_check: timed_out).
 *   (5) finish() kills a still-running client, removes the job's containers and records the result
 *       in exit.json as container.cleanup.confirmed, separately from the CLI's own exit: job-core's
 *       checkJob()/cancelJob() keep retrying an unconfirmed cleanup.
 *   (6) exit.json's container record also carries the repo, the PR URL the job reported on stdout
 *       for that repo (prUrl), and a warning when the entrypoint could not clone it (exit 70).
 *   (7) Redaction: the env file's two values are read into memory once (never written anywhere),
 *       and exit.json's stdout/stderr tails and the Discord ping's headline are redacted with them
 *       plus GitHub/Anthropic token shapes. out.log/err.log on disk stay raw.
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
import { sanitizeEnvForWin32, logIfPathextSanitized, pidAlive } from "./job-core.mjs";
import { createSelfMembershipQuerier } from "./tools/jobMembership.mjs";
import { writeJsonAtomic } from "./atomic.mjs";
import { notifyJobFinished, loadCompletenessConfig, hasCompletenessMarker } from "./discord-notify.mjs";
import { cleanupJobContainers, extractPrUrl, ENTRY_EXIT_CLONE, DEFAULT_MAX_RUNTIME_MS, readEnvFileSecretValues,
         redactSecrets } from "./container.mjs";

const specPath = process.argv[2];
if (!specPath) process.exit(2);

const pidWriteDelayMs = Number(process.env.CLAUDE_ASYNC_TEST_DELAY_PIDFILE_MS) || 0;
if (pidWriteDelayMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pidWriteDelayMs);
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
// Container jobs only (see the header): { name, jobId, dockerBin, repo, maxRuntimeMs }. null for host jobs.
const containerSpec = spec.container && typeof spec.container === "object" ? spec.container : null;

const heartbeatPath = path.join(path.dirname(specPath), "runner_heartbeat");
// Container jobs: cancel intent (written by job-core) and the docker client's pid (written here).
const cancelPath = path.join(path.dirname(specPath), "cancel_requested");
const dockerPidPath = path.join(path.dirname(specPath), "docker_client.pid");
// Container jobs: the launch state job-core reads to decide whether a `docker run` could still
// create a container (see job-core.mjs containerLaunchPending). Written BEFORE the client is
// spawned ("pending"), again once its pid is known ("spawned"), when the client exited on its own
// ("exited": no further creation possible) and when this runner had to kill it ("killed": the
// daemon may still be serving its create request). A runner that dies between any two of these
// leaves the earlier state behind, which job-core treats as "uncertain", never as "done".
const dockerLaunchPath = path.join(path.dirname(specPath), "docker_launch");
const containerState = { cancelled: false, runtimeExceeded: false, fallbackFired: false, lastCleanupError: null };
function writeLaunchState(state, pid = null) {
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
const redactValues = containerSpec ? readEnvFileSecretValues(containerSpec.envFile) : [];
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
// line boundary. Any failure (missing file, read error, decode error, ...) yields [] -- this is
// best-effort diagnostic data, never allowed to break exit recording.
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
  if (containerSpec && containerState.cancelled && (exitReason === "exit" || exitReason === "cancelled")) exitReason = "cancelled";
  else if (containerSpec && containerState.runtimeExceeded && exitReason === "exit") exitReason = "container_max_runtime";
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
        "CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS) and was removed");
    }
    // 125 is docker run's own failure (daemon down, bad flag, image refused), not the CLI's.
    if (exitInfo.exitCode === 125) warnings.push("docker run itself failed (exit 125) before or while starting the container; see stderrTail");
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
    if (child && child.exitCode === null && child.signalCode === null) { containerState.fallbackFired = true; killClient(child); }
    try {
      const r = removeJobContainers("finish");
      const absent = !!(r.ok && r.absent);
      // A client that had to be killed after the stop wait may have had a create request in flight
      // daemon-side, so its cleanup is never confirmed here; checkJob() confirms it later.
      const confirmed = absent && !containerState.fallbackFired;
      cleanupRecord = { confirmed, removed: r.removed || 0,
                        ...(!r.ok ? { error: r.error } : !absent ? { error: "a container is still listed after docker rm -f" } : {}),
                        ...(containerState.fallbackFired ? { clientKilled: true, reason: "the docker client did not exit within the stop wait and was killed" } : {}) };
      if (absent && r.removed > 0 && !containerState.cancelled && !containerState.runtimeExceeded) {
        fs.writeSync(errFd, `\n[job-runner] container ${containerSpec.name} was still present after docker exited; removed it\n`);
      }
      if (!confirmed) {
        fs.writeSync(errFd, `\n[job-runner] WARN: container cleanup for ${containerSpec.name} not confirmed ` +
          `(${cleanupRecord.error || cleanupRecord.reason}); claude_check / claude_cancel retry it\n`);
      }
    } catch {}
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
if (containerSpec && fs.existsSync(cancelPath)) {
  // Cancelled before `docker run`: never start the container at all.
  containerState.cancelled = true;
  try { fs.writeSync(errFd, `\n[job-runner] cancel requested before docker run; not starting container ${containerSpec.name}\n`); } catch {}
  exitInfo = { exitCode: null, exitSignal: null, exitReason: "cancelled" };
  finish(130);
} else {
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
  }
}

// Container jobs: the docker client's pid (job-core's "may a launch still be pending?"), then a poll
// for the cancel intent and the wall-clock limit. Either one removes the job's containers on every
// tick until the client exits, which also catches a container that was still being created when
// the cancel arrived.
if (child && containerSpec) {
  // Test-only knob (test/container-runner.test.mjs, finding A1): die between the spawn and the pid
  // write, the exact window a TerminateProcess can hit. Production never sets this.
  if (process.env.CLAUDE_ASYNC_TEST_DIE_AFTER_SPAWN === "1") process.kill(process.pid, "SIGKILL");
  try { if (child.pid) fs.writeFileSync(dockerPidPath, String(child.pid)); } catch {}
  writeLaunchState("spawned", child.pid || null);
  // A cancel that landed between the pre-spawn check and here is acted on at once, not on the
  // first poll tick.
  if (fs.existsSync(cancelPath)) {
    containerState.cancelled = true;
    try { fs.writeSync(errFd, `\n[job-runner] cancel request seen right after docker run started; removing container ${containerSpec.name}\n`); } catch {}
    removeJobContainers("cancel");
  }
  const startedMs = Date.now();
  const maxRuntimeMs = Number(containerSpec.maxRuntimeMs) > 0 ? Number(containerSpec.maxRuntimeMs) : DEFAULT_MAX_RUNTIME_MS;
  const pollMs = Number(process.env.CLAUDE_ASYNC_CONTAINER_POLL_MS) || 1000;
  containerWatch = setInterval(() => {
    if (done) return;
    if (!containerState.cancelled && fs.existsSync(cancelPath)) {
      containerState.cancelled = true;
      try { fs.writeSync(errFd, `\n[job-runner] cancel request seen; removing container ${containerSpec.name}\n`); } catch {}
    }
    if (!containerState.runtimeExceeded && Date.now() - startedMs > maxRuntimeMs) {
      containerState.runtimeExceeded = true;
      try { fs.writeSync(errFd, `\n[job-runner] wall-clock limit (${maxRuntimeMs} ms) reached; removing container ${containerSpec.name}\n`); } catch {}
    }
    if (containerState.cancelled || containerState.runtimeExceeded) removeJobContainers("cancel/limit");
  }, pollMs);
  containerWatch.unref();
}

// Container jobs: a cancel (or any catchable termination of this runner) removes the job's
// containers; the docker client then exits on its own and the normal exit path records it. If the
// client never exits, the fallback kills it and finishes with the cleanup NOT confirmed. Windows
// TerminateProcess can't be caught at all, which is why job-core's checkJob() also cleans up after
// a runner that died, and cancelJob() removes the containers itself.
if (child && containerSpec) {
  let stopping = false;
  const stopWaitMs = Number(process.env.CLAUDE_ASYNC_CONTAINER_STOP_WAIT_MS) || 30_000;
  const stopContainer = (sig) => {
    if (stopping) return;
    stopping = true;
    try { fs.writeSync(errFd, `\n[job-runner] ${sig} received; removing container ${containerSpec.name}\n`); } catch {}
    removeJobContainers(sig);
    setTimeout(() => {
      if (done) return;
      containerState.fallbackFired = true;
      killClient(child);
      exitInfo = { exitCode: null, exitSignal: sig, exitReason: "signal" };
      finish(1);
    }, stopWaitMs).unref();
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]) {
    process.on(sig, () => stopContainer(sig));
  }
}

if (child) {
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
    // Container jobs: a client that exited on its own can't create anything any more; one this runner
    // killed (fallback) keeps the "killed" state written by killClient().
    if (containerSpec && !containerState.fallbackFired) writeLaunchState("exited", child.pid || null);
    finish(code == null ? (signal ? 1 : 0) : code);
  });
}
