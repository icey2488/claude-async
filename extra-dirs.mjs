/**
 * extra-dirs.mjs — shared validation for a job's extraDirs (claude_start's --add-dir grant,
 * docs/extra-dirs-proposal.md) and tools/git-ro.mjs's --repo <path> option. One constant, one
 * validator, so every call site refuses the same protected locations the same way.
 *
 * Accident protection on native Windows, not a security boundary (Erick's standing decision,
 * see guard.mjs's header and docs/extra-dirs-proposal.md): a "code" job can already run arbitrary
 * node/python and read/write anything that process is capable of. These checks stop a well-meaning
 * job from being GRANTED visibility into a sensitive or live-prod directory by accident; they are
 * not a confinement mechanism against a job that writes its own script to get there anyway.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXTRA_DIRS_MAX = 8;

// Credential/config stores under the user profile, plus the live Spine data directory (token +
// DB) -- always refused, in every profile. One list, easy to extend. ~/.claude-async-jobs (job
// reports; see job-core.mjs's JOB_ROOT) is a DIFFERENT top-level dir from ~/.claude and is
// deliberately NOT here.
export function protectedPaths(homedir = os.homedir()) {
  return [
    path.join(homedir, ".ssh"),
    path.join(homedir, ".aws"),
    path.join(homedir, ".azure"),
    path.join(homedir, ".gnupg"),
    path.join(homedir, ".config", "gh"),
    path.join(homedir, ".docker"),
    process.env.CLAUDE_CONFIG_DIR || path.join(homedir, ".claude"),
    "D:\\claunker\\spine-data",
  ];
}

// "code" profile accident guard (A4): live prod checkouts under D:\claunker\ are refused as an
// extraDir for "code" (which can already edit/run anything it sees); "readonly" may read them
// (protectedPaths() above still applies to both, e.g. spine-data stays refused either way).
export const LIVE_CHECKOUTS_ROOT = "D:\\claunker";

function normalizedForCompare(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

// True if `candidate` (already resolved) is equal to, or nested inside, `base`. Case-insensitive
// (Windows filesystem semantics) with a path-separator boundary, so "D:\claunkerX" is never
// mistaken for being under "D:\claunker".
function isUnderOrEqual(candidate, base) {
  const c = normalizedForCompare(candidate);
  const b = normalizedForCompare(base);
  return c === b || c.startsWith(b + path.sep);
}

// Resolves symlinks/junctions and ".." via realpath (also the existence + directory check: a
// missing path or a file fails here with one clear error). Returns { resolved } or { error }.
function realDir(rawPath, label) {
  if (typeof rawPath !== "string" || !rawPath) return { error: `${label} must be a non-empty string` };
  if (!path.isAbsolute(rawPath)) return { error: `${label} ${JSON.stringify(rawPath)} must be an absolute path` };
  let resolved;
  try { resolved = fs.realpathSync(rawPath); }
  catch (e) { return { error: `${label} ${JSON.stringify(rawPath)} does not exist or could not be resolved: ${e.message}` }; }
  let st;
  try { st = fs.statSync(resolved); }
  catch (e) { return { error: `${label} ${JSON.stringify(rawPath)} could not be inspected: ${e.message}` }; }
  if (!st.isDirectory()) return { error: `${label} ${JSON.stringify(rawPath)} is not a directory` };
  return { resolved };
}

// A protected location, in every profile (A3). Compares against each entry's own realpath when
// it exists (so a protected dir that is itself a symlink is matched correctly); falls back to the
// literal configured path when the protected entry itself does not exist (still refused -- a
// missing credential dir is not "available").
export function checkProtected(resolved, { homedir = os.homedir() } = {}) {
  for (const prot of protectedPaths(homedir)) {
    let protResolved;
    try { protResolved = fs.realpathSync(prot); } catch { protResolved = prot; }
    if (isUnderOrEqual(resolved, protResolved)) {
      return `is inside a protected location (${prot}) -- credential/config stores and the live Spine data dir are always refused, in any profile`;
    }
  }
  return null;
}

// "code" profile only (A4): refuses anything under D:\claunker\ (live prod checkouts).
// "readonly" allows it (protectedPaths() above, e.g. spine-data, still applies to both).
export function checkLiveCheckout(resolved, profile) {
  if (profile !== "code") return null;
  if (isUnderOrEqual(resolved, LIVE_CHECKOUTS_ROOT)) {
    return `is under ${LIVE_CHECKOUTS_ROOT} (a live prod checkout) -- refused for profile "code" as accident protection; "readonly" may read it`;
  }
  return null;
}

// Validates one directory path. opts: profile (checkLiveCheckout, A4 -- omit to skip that check,
// e.g. git-ro.mjs's --repo, which is A2/A3 only), workFolder (reject a duplicate of it, A2),
// homedir (tests only), label (for the error message). Returns { resolved } or { error }.
export function validateExtraDir(rawPath, { profile, workFolder, homedir = os.homedir(), label = "extraDirs entry" } = {}) {
  const r = realDir(rawPath, label);
  if (r.error) return r;
  const protectedError = checkProtected(r.resolved, { homedir });
  if (protectedError) return { error: `${label} ${JSON.stringify(rawPath)} ${protectedError}` };
  const liveError = checkLiveCheckout(r.resolved, profile);
  if (liveError) return { error: `${label} ${JSON.stringify(rawPath)} ${liveError}` };
  if (workFolder) {
    let wf;
    try { wf = fs.realpathSync(workFolder); } catch { wf = path.resolve(workFolder); }
    if (normalizedForCompare(r.resolved) === normalizedForCompare(wf)) {
      return { error: `${label} ${JSON.stringify(rawPath)} duplicates the job's own work folder` };
    }
  }
  return { resolved: r.resolved };
}

// Validates a whole extraDirs list for a job (A1/A2). dirs: array or undefined/null (not
// requested). Returns { dirs: [...resolved] } (dirs: [] when nothing was requested) or { error }.
export function validateExtraDirs(dirs, { profile, workFolder, homedir = os.homedir() } = {}) {
  if (dirs === undefined || dirs === null) return { dirs: [] };
  if (!Array.isArray(dirs)) return { error: "extraDirs must be an array of absolute paths" };
  if (dirs.length === 0) return { dirs: [] };
  if (dirs.length > EXTRA_DIRS_MAX) return { error: `extraDirs has ${dirs.length} entries, more than the cap of ${EXTRA_DIRS_MAX}` };
  const resolved = [];
  const seen = new Set();
  for (const raw of dirs) {
    const v = validateExtraDir(raw, { profile, workFolder, homedir });
    if (v.error) return { error: v.error };
    const key = normalizedForCompare(v.resolved);
    if (seen.has(key)) return { error: `extraDirs entry ${JSON.stringify(raw)} duplicates another entry already in the list` };
    seen.add(key);
    resolved.push(v.resolved);
  }
  return { dirs: resolved };
}
