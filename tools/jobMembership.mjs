// tools/jobMembership.mjs — Node-side wrappers around query-job-membership.ps1, built for the
// 2026-09-09 runner-termination investigation (see win32-breakaway.ps1 and job-core.mjs for the
// rest of that instrumentation).
//
// Two access patterns, matching the two things callers need:
//   - queryJobMembershipOnce(pid): a single foreign-pid check (job-core.mjs, right after a win32
//     launch, checking the freshly-spawned runner's pid). Spawns a fresh powershell.exe and pays
//     its Add-Type JIT cost once; fine for an infrequent one-off call, not for polling.
//   - createSelfMembershipQuerier(): a long-lived helper for a process that wants to check its OWN
//     membership repeatedly and cheaply (job-runner.mjs, once per heartbeat). Spawns ONE
//     powershell.exe -Server helper that compiles its P/Invoke type once and then answers over
//     stdin/stdout for as long as the caller keeps it open -- see query-job-membership.ps1's
//     header for why a -Server response is always a self-query of the helper's own job, never the
//     arbitrary pid it was asked about.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "query-job-membership.ps1");
const UNKNOWN = { inJob: null, limitFlags: null, killOnClose: null, silentBreakawayOk: null, breakawayOk: null };

function parseLine(line) {
  return JSON.parse(line.trim().split(/\r?\n/).pop());
}

export function queryJobMembershipOnce(pid, timeoutMs = 5000) {
  if (process.platform !== "win32") return { ...UNKNOWN, error: "not win32" };
  try {
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-TargetPid", String(pid)],
      { encoding: "utf8", timeout: timeoutMs });
    if (r.error) return { ...UNKNOWN, error: r.error.message };
    if (r.status !== 0 || !r.stdout || !r.stdout.trim()) {
      return { ...UNKNOWN, error: `query-job-membership.ps1 exited ${r.status}: ${(r.stderr || "").trim()}` };
    }
    return parseLine(r.stdout);
  } catch (e) {
    return { ...UNKNOWN, error: e.message };
  }
}

// Returns { query(pid, timeoutMs?) => Promise<record>, close() }. `pid` is accepted for call-site
// clarity but the underlying helper always answers about itself -- see module header.
export function createSelfMembershipQuerier() {
  if (process.platform !== "win32") {
    return { query: async () => ({ ...UNKNOWN, error: "not win32" }), close() {} };
  }

  const child = spawn("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Server"],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });

  let buf = "";
  let pending = [];
  let dead = false;

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const resolve = pending.shift();
      if (!resolve) continue;
      try { resolve(parseLine(line)); }
      catch (e) { resolve({ ...UNKNOWN, error: `bad response from helper: ${e.message}` }); }
    }
  });
  const killPending = (reason) => {
    dead = true;
    const waiting = pending;
    pending = [];
    waiting.forEach((resolve) => resolve({ ...UNKNOWN, error: reason }));
  };
  child.on("exit", () => killPending("membership helper exited"));
  child.on("error", () => killPending("membership helper failed to spawn"));

  return {
    query(pid, timeoutMs = 3000) {
      if (dead) return Promise.resolve({ ...UNKNOWN, error: "membership helper exited" });
      return new Promise((resolve) => {
        const wrapped = (v) => { clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => {
          pending = pending.filter((r) => r !== wrapped);
          resolve({ ...UNKNOWN, error: "membership helper query timed out" });
        }, timeoutMs);
        pending.push(wrapped);
        try { child.stdin.write(`${pid}\n`); }
        catch (e) { pending = pending.filter((r) => r !== wrapped); clearTimeout(timer); resolve({ ...UNKNOWN, error: e.message }); }
      });
    },
    close() {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    },
  };
}
