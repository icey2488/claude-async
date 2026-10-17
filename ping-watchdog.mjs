/**
 * Pure decision logic for claude-async-server.mjs's ping watchdog, split out so tests can import
 * it without pulling in (and thereby starting) the real MCP server. See claude-async-server.mjs
 * for how these are wired into the actual setInterval loop.
 */

export const PING_DEFAULTS = Object.freeze({ maxMisses: 3, hardCapMisses: 6, resumeFactor: 2 });

// Should the watchdog exit after this consecutive-miss count? resumeDetected (this miss followed
// a detected sleep/wake gap) always grants grace -- the peer hasn't had a full interval to answer
// yet. Otherwise: the hard cap exits unconditionally (pid reuse / wedged parent you can't see);
// below it, a miss only counts once the parent process itself looks gone.
export function shouldExitOnMiss(misses, parentAlive, resumeDetected, thresholds = {}) {
  const { maxMisses = PING_DEFAULTS.maxMisses, hardCapMisses = PING_DEFAULTS.hardCapMisses } = thresholds;
  if (resumeDetected) return false;
  if (misses >= hardCapMisses) return true;
  return misses >= maxMisses && !parentAlive;
}

// Did the gap between two ticks of the watchdog's setInterval blow past what a normal timer
// delay + event-loop jitter could produce? That's the signature of the machine having slept
// between ticks, rather than the peer actually having gone missing.
export function isResumeGap(elapsedMs, pingMs, resumeFactor = PING_DEFAULTS.resumeFactor) {
  return elapsedMs > pingMs * resumeFactor;
}

// Pure formatter for the exit-reason log line's body (caller prepends the ISO timestamp and
// trailing newline) so the exact format is unit-testable without touching fs/process.exit.
export function formatExitLine({ code, reason, pid, ppid, uptimeS, detail }) {
  return `exit: code=${code} reason=${reason} pid=${pid} ppid=${ppid} uptime=${uptimeS}s${detail ? " " + detail : ""}`;
}
