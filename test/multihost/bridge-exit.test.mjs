// End-to-end coverage for claude-async-server.mjs's exit-reason logging: spawns the REAL bridge
// against a fake stdio peer (a child_process pipe nothing answers), rather than importing the
// module -- it has top-level side effects (connects a real McpServer over stdio) that would make
// importing it unsafe for a test process. ping-watchdog.test.mjs covers the pure decision logic
// this drives; this file only proves the handlers in claude-async-server.mjs are wired to the
// right tags and that the exit line lands in bridge-crash.log with the spawned pid.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "..", "claude-async-server.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ca-bridge-exit-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

let seq = 0;
// Spawns the real bridge with its job dir redirected into TMP (never the live ~/.claude-async-jobs),
// waits for it to exit (or the given timeoutMs), and returns { code, pid, crashLog }.
function spawnBridge(extraEnv, timeoutMs = 10_000) {
  const jobDir = path.join(TMP, `jobs-${++seq}`);
  const env = { ...process.env, CLAUDE_ASYNC_JOB_DIR: jobDir, CLAUDE_CLI_PATH: process.execPath,
                CLAUDE_ASYNC_WIN32_LAUNCH_MODE: "breakaway", ...extraEnv };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, jobDir, exited, timeoutMs,
           crashLog: () => { try { return fs.readFileSync(path.join(jobDir, "bridge-crash.log"), "utf8"); } catch { return ""; } },
           stderr: () => stderr };
}

async function waitExit(spawned) {
  const code = await Promise.race([
    spawned.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not exit in time")), spawned.timeoutMs)),
  ]);
  return code;
}

test("stdin end: exits 0, tagged reason=stdin-end, with the spawned child's own pid", async () => {
  const b = spawnBridge({});
  const pid = b.child.pid;
  b.child.stdin.end();
  const code = await waitExit(b);
  assert.equal(code, 0);
  const log = b.crashLog();
  assert.match(log, new RegExp(`exit: code=0 reason=stdin-end pid=${pid} ppid=${process.pid}`));
});

test("ping watchdog, hard cap reached on the very first miss (no peer ever answers): exits 0, tagged reason=ping-timeout", async () => {
  const b = spawnBridge({
    CLAUDE_ASYNC_PING_MS: "100", CLAUDE_ASYNC_PING_TIMEOUT_MS: "50",
    CLAUDE_ASYNC_PING_MAX_MISSES: "1", CLAUDE_ASYNC_PING_HARD_CAP_MISSES: "1",
  });
  const pid = b.child.pid;
  const code = await waitExit(b);
  assert.equal(code, 0);
  const log = b.crashLog();
  assert.match(log, /ping-miss: pid=\d+ count=1 parentAlive=true resumeGrace=false/);
  assert.match(log, new RegExp(`exit: code=0 reason=ping-timeout pid=${pid} ppid=${process.pid}.*misses=1 parentAlive=true`));
});

test("ping watchdog, parent alive and misses below the hard cap: the bridge stays up (no exit line)", async () => {
  const b = spawnBridge({
    CLAUDE_ASYNC_PING_MS: "100", CLAUDE_ASYNC_PING_TIMEOUT_MS: "50",
    CLAUDE_ASYNC_PING_MAX_MISSES: "3", CLAUDE_ASYNC_PING_HARD_CAP_MISSES: "6",
  });
  // Poll (rather than a fixed sleep) for the first miss, so this isn't flaky under a loaded
  // machine/full-suite run where ticks land later than pingMs would suggest -- misses only
  // accumulate slower under load, never faster, so there's no risk of overshooting the hard cap
  // of 6 by waiting longer here.
  const deadline = Date.now() + 10_000;
  let log = "";
  while (Date.now() < deadline && !/ping-miss:/.test(log)) {
    await new Promise((r) => setTimeout(r, 50));
    log = b.crashLog();
  }
  assert.match(log, /ping-miss: pid=\d+ count=\d parentAlive=true/, "no ping-miss observed within 10s");
  assert.equal(b.child.exitCode, null, "bridge must not have exited yet");
  assert.doesNotMatch(log, /^exit:/m);
  b.child.kill();
  await waitExit(b);
});
