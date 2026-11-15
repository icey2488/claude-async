// Regression guard (chore/portable-paths, 2026-11-15): no tracked file may contain the current
// OS user's Windows profile path. A real username hardcoded into a path breaks on any other
// machine, and since this repo is public, it also leaks who runs it. The username is read from
// the environment at run time -- this file must never contain it as a literal.
// Run: node --test test/no-username-leak.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const username = os.userInfo().username;

test("no tracked file contains the current user's profile path", (t) => {
  if (!username || username.length < 4) {
    t.skip("username too short/generic to be meaningful");
    return;
  }
  const ls = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (ls.status !== 0) {
    t.skip("not a git checkout (or git unavailable)");
    return;
  }
  const needleBack = `users\\${username}`.toLowerCase();
  const needleFwd = `users/${username}`.toLowerCase();
  const files = ls.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
  const offenders = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(REPO_ROOT, f)); } catch { continue; }
    if (buf.includes(0)) continue; // binary file
    const lower = buf.toString("utf8").toLowerCase();
    if (lower.includes(needleBack) || lower.includes(needleFwd)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `tracked file(s) contain the current user's profile path: ${offenders.join(", ")}`);
});
