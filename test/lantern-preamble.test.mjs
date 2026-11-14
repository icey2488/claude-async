// lantern-preamble.mjs: the one line telling a job's CLI that the runner, not the agent, reports
// Lantern status -- see job-core.mjs's two call sites (host argv, container argv).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANTERN_PREAMBLE_LINE, withLanternPreamble } from "../lantern-preamble.mjs";

test("withLanternPreamble: prepends the line, then a blank line, then the original prompt verbatim", () => {
  const prompt = "Fix the thing in foo.mjs.";
  const result = withLanternPreamble(prompt);
  assert.equal(result, `${LANTERN_PREAMBLE_LINE}\n\n${prompt}`);
  assert.ok(result.endsWith(prompt), "the caller's own prompt is never altered, only prefixed");
});

test("LANTERN_PREAMBLE_LINE: tells the agent not to curl its own status", () => {
  assert.match(LANTERN_PREAMBLE_LINE, /agents\/status/);
  assert.match(LANTERN_PREAMBLE_LINE, /ignore/i);
});
