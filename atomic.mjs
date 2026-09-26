/**
 * atomic.mjs — the one way this repo replaces a state file.
 *
 * writeJsonAtomic writes to a unique temp file in the SAME directory (rename is only atomic within
 * a volume), then renames it over the target, so a concurrent reader -- or a crash at any point --
 * sees either the complete old file or the complete new one, never a truncated hybrid. A crash
 * between the write and the rename leaves an orphan `<file>.<pid>.<rand>.tmp` and an untouched target.
 * On Windows a rename onto a file another process has open can fail with EPERM/EBUSY for a moment,
 * so those two codes get a short bounded retry (5 more tries, 20ms * n apart); anything else, or
 * running out of retries, removes the temp file and rethrows. `fsImpl` is a test seam.
 *
 * Delegated to qwen2.5-coder:7b (local ollama) with the exact signature + one example. First draft
 * rejected (no fs import, ignored fsImpl, wrong path join); second draft accepted after ONE edit:
 * its `EPERM || EBUSY && attempt < 5` precedence bug made EPERM retry forever (bounded now, and
 * covered by test/multihost/atomic.test.mjs); its redundant inner unlink was dropped.
 */
import fs from "node:fs";
import crypto from "node:crypto";

export function writeJsonAtomic(file, data, { space = 2, mode, fsImpl = fs } = {}) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const text = JSON.stringify(data, null, space);
  try {
    fsImpl.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    for (let attempt = 0; ; attempt++) {
      try {
        fsImpl.renameSync(tmp, file);
        break;
      } catch (e) {
        if ((e.code === "EPERM" || e.code === "EBUSY") && attempt < 5) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    try { fsImpl.unlinkSync(tmp); } catch {}
    throw e;
  }
}
