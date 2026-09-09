#!/usr/bin/env node
/**
 * test/pathext-dedup.mjs — unit test for reviewer finding #4 (2026-09-09 review of
 * fix/win32-detach): checks sanitizeEnvForWin32(env) never leaves case-variant PATHEXT
 * duplicates (e.g. both "PathEXT" and "PATHEXT") in its returned object, which CreateProcessW
 * would otherwise accept and a child could read either of unpredictably.
 *
 * Signature under test: export function sanitizeEnvForWin32(env: object): object
 * win32-only behavior (see job-core.mjs); on other platforms it's a passthrough copy, so this
 * test skips there.
 *
 * Run: node test/pathext-dedup.mjs   (exit 0 = no duplicate PATHEXT keys in any case)
 */
import { sanitizeEnvForWin32 } from "../job-core.mjs";

if (process.platform !== "win32") {
  console.log("SKIP — sanitizeEnvForWin32 is a passthrough on non-win32 platforms");
  process.exit(0);
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS — ${msg}`); passed++; }
  else { console.error(`  FAIL — ${msg}`); failed++; }
}

function pathextKeys(obj) {
  return Object.keys(obj).filter((k) => /^pathext$/i.test(k));
}

// Case a: exact input/output pair from the review — a single case-variant key.
{
  console.log("Test a: { PathEXT: '.CPL' } -> exactly one canonical PATHEXT key");
  const result = sanitizeEnvForWin32({ PathEXT: ".CPL" });
  const keys = pathextKeys(result);
  assert(keys.length === 1, `exactly one key matches /^pathext$/i, got ${JSON.stringify(keys)}`);
  assert(keys[0] === "PATHEXT", `the surviving key is canonically-cased "PATHEXT", got "${keys[0]}"`);
  assert(typeof result.PATHEXT === "string" && result.PATHEXT.length > 0, "PATHEXT is a non-empty string");
}

// Case b: both a canonical and a case-variant key present simultaneously.
{
  console.log("Test b: { PathEXT: '.CPL', PATHEXT: '.EXE;.CMD' } -> still exactly one key");
  const result = sanitizeEnvForWin32({ PathEXT: ".CPL", PATHEXT: ".EXE;.CMD" });
  const keys = pathextKeys(result);
  assert(keys.length === 1, `exactly one key matches /^pathext$/i, got ${JSON.stringify(keys)}`);
}

// Case c: PATHEXT absent entirely -- still ends with exactly one canonical key.
{
  console.log("Test c: {} (PATHEXT absent) -> exactly one PATHEXT key with a usable value");
  const result = sanitizeEnvForWin32({});
  const keys = pathextKeys(result);
  assert(keys.length === 1, `exactly one key matches /^pathext$/i, got ${JSON.stringify(keys)}`);
  assert(typeof result.PATHEXT === "string" && result.PATHEXT.length > 0, "PATHEXT is a non-empty string");
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
console.log(failed > 0 ? "PATHEXT DEDUP TEST FAILED" : "ALL PATHEXT DEDUP TESTS PASS");
process.exit(failed > 0 ? 1 : 0);
