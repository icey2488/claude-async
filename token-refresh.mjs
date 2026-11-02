/**
 * token-refresh.mjs -- the renewal schedule of a container job's GitHub App installation token
 * (job-runner.mjs; review round 3, finding B5).
 *
 * Installation tokens live 60 minutes. The normal schedule renews every refreshMs (default 45 min)
 * after the last success. Before round 3 a failed renewal simply waited for the next 45-minute tick,
 * so one transient failure at minute 45 left the job without a valid token from minute 60 to 90, and
 * the near-expiry warning was only checked on another failure or at the end. Now:
 *   - a FAILURE switches to retries with bounded backoff (30 s, 1 min, 2 min, 4 min, then every 5 min;
 *     never longer than refreshMs, so the accelerated test intervals scale down), until a success
 *     returns to the normal schedule;
 *   - a retry is always attempted no later than expiresAt - 2 min while that is still ahead, so the
 *     backoff can never skip the last useful moment;
 *   - the near-expiry warning has its own timer at expiresAt - 5 min: if no newer token exists by then
 *     and renewal is failing or overdue, onNearExpiry fires right there, without waiting for another
 *     failure. A failure that happens inside that window fires it too. Once per token generation.
 * Every timer goes through `clock` ({ now, setTimeout, clearTimeout }), so a test drives the real
 * production intervals with a fake clock. stop() cancels everything; a mint that resolves after
 * stop() is ignored (no write, no warning).
 */
export const RETRY_BACKOFF_MS = Object.freeze([30_000, 60_000, 120_000, 240_000]);
export const RETRY_CAP_MS = 5 * 60_000;
export const LAST_ATTEMPT_BEFORE_EXPIRY_MS = 2 * 60_000;
export const NEAR_EXPIRY_WARN_MS = 5 * 60_000;

export const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimeout: (t) => clearTimeout(t),
});

// mint(): Promise<{ token, expiresAt }>. onSuccess({ token, expiresAt, generation }) must persist the
// token (a throw there counts as a failed attempt). onFailure(error, { expiresAt, retryInMs, failures }).
// onNearExpiry({ expiresAt, generation, failures, at }).
export function createTokenRefresher({ mint, onSuccess, onFailure = () => {}, onNearExpiry = () => {}, refreshMs, clock = realClock }) {
  const st = { expiresAt: 0, generation: 0, failures: 0, timer: null, warnTimer: null, inFlight: false, stopped: false,
               nextAt: 0, warnedGeneration: 0 };
  const clear = () => {
    if (st.timer) { clock.clearTimeout(st.timer); st.timer = null; }
    if (st.warnTimer) { clock.clearTimeout(st.warnTimer); st.warnTimer = null; }
  };
  const scheduleAt = (delay) => {
    if (st.timer) clock.clearTimeout(st.timer);
    st.nextAt = clock.now() + delay;
    st.timer = clock.setTimeout(() => { st.timer = null; attempt(); }, Math.max(0, delay));
  };
  const retryDelay = () => {
    const base = Math.min(RETRY_BACKOFF_MS[Math.min(st.failures - 1, RETRY_BACKOFF_MS.length - 1)], RETRY_CAP_MS, refreshMs);
    const now = clock.now();
    const lastChance = st.expiresAt - LAST_ATTEMPT_BEFORE_EXPIRY_MS;
    if (st.expiresAt && now < lastChance && now + base > lastChance) return lastChance - now;
    return base;
  };
  const warn = () => {
    if (st.warnedGeneration === st.generation) return;
    st.warnedGeneration = st.generation;
    try { onNearExpiry({ expiresAt: st.expiresAt, generation: st.generation, failures: st.failures, at: clock.now() }); } catch {}
  };
  const scheduleWarn = () => {
    if (st.warnTimer) clock.clearTimeout(st.warnTimer);
    const gen = st.generation;
    st.warnTimer = clock.setTimeout(() => {
      st.warnTimer = null;
      if (st.stopped || gen !== st.generation) return;          // a newer token exists
      if (st.failures > 0 || st.inFlight || clock.now() >= st.nextAt) warn();
    }, Math.max(0, st.expiresAt - NEAR_EXPIRY_WARN_MS - clock.now()));
  };
  async function attempt() {
    if (st.stopped || st.inFlight) return;
    st.inFlight = true;
    let r;
    try {
      r = await mint();
      if (st.stopped) return;
      await onSuccess({ ...r, generation: st.generation + 1 });
      if (st.stopped) return;
      st.generation++;
      st.expiresAt = r.expiresAt;
      st.failures = 0;
      scheduleAt(refreshMs);
      scheduleWarn();
    } catch (e) {
      if (st.stopped) return;
      st.failures++;
      const retryInMs = retryDelay();
      try { onFailure(e, { expiresAt: st.expiresAt, retryInMs, failures: st.failures }); } catch {}
      if (st.expiresAt && clock.now() >= st.expiresAt - NEAR_EXPIRY_WARN_MS) warn();
      scheduleAt(retryInMs);
    } finally { st.inFlight = false; }
  }
  return {
    // The first token was minted by the caller (before `docker run`); the schedule starts from it.
    start({ expiresAt, generation = 1 }) {
      st.expiresAt = expiresAt; st.generation = generation; st.failures = 0;
      scheduleAt(refreshMs);
      scheduleWarn();
    },
    stop() { st.stopped = true; clear(); },
    state: () => ({ ...st, timer: !!st.timer, warnTimer: !!st.warnTimer }),
    attemptNow: attempt,
  };
}
