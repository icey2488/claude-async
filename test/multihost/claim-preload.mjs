// `node --import claim-preload.mjs job-launcher.mjs`: lines real launcher processes up so their claims
// collide. Without it each process's startup jitter (several ms) spreads the claims far apart. The
// preload imports the launcher's own dependencies first (so the launcher's imports are cached and
// cost nothing afterwards), then spins until the shared instant CLAIM_TEST_GO_AT (epoch ms).
// It also records when it stopped spinning (go-<pid>.json in the launcher's temp home) so the test can
// assert the launchers really were released together instead of trusting the 600 ms lead.
// Test-only; the launcher itself knows nothing about it.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repo = process.env.CLAIM_TEST_REPO;
for (const mod of ["job-core.mjs", "atomic.mjs", "launcher-claim.mjs"]) {
  await import(pathToFileURL(path.join(repo, mod)).href);
}
const goAt = Number(process.env.CLAIM_TEST_GO_AT);
while (performance.timeOrigin + performance.now() < goAt) { /* spin */ }
const releasedAt = performance.timeOrigin + performance.now();
try { fs.writeFileSync(path.join(process.env.USERPROFILE, `go-${process.pid}.json`), JSON.stringify({ goAt, releasedAt })); } catch {}
