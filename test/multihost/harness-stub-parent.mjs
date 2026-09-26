// Harmless stand-in for test-parent.mjs in harness-quoting.test.mjs. Same argv contract the
// job-close harness uses: [jobDir, dummyCli, coreModule, markerPath]. Records what it received
// (so the test can check no argument was split at a space), drops the heartbeat file the harness
// waits for, then idles until the harness's job-close kills it.
import fs from "node:fs";
import path from "node:path";

const [, , jobDir, , , markerPath] = process.argv;
fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));
fs.writeFileSync(path.join(jobDir, "hb"), "1");
setInterval(() => {}, 60_000);
