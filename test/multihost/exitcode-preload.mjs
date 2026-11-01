// `node --import exitcode-preload.mjs job-runner.mjs spec.json`: records every writeFileSync /
// renameSync the runner makes against its job dir's exit_code, so a test can assert exit_code is
// only ever produced by a rename (never truncated-then-written in place). Test-only.
import fs from "node:fs";
const out = process.env.EXITCODE_TRACE;
const watch = (p) => typeof p === "string" && /exit_code/.test(p);
const origWrite = fs.writeFileSync;
const origRename = fs.renameSync;
fs.writeFileSync = function (f, ...rest) {
  if (watch(f)) origWrite.call(fs, out, `${JSON.stringify(["write", f])}\n`, { flag: "a" });
  return origWrite.call(this, f, ...rest);
};
fs.renameSync = function (from, to) {
  if (watch(to)) origWrite.call(fs, out, `${JSON.stringify(["rename", from, to])}\n`, { flag: "a" });
  return origRename.call(this, from, to);
};
