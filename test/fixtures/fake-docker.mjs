#!/usr/bin/env node
// Fake `docker` for test/container-runner.test.mjs. Appends one JSON line per invocation to
// $FAKE_DOCKER_LOG ({ argv }), then:
//   run ...  -> prints "container stdout" / "container stderr", optionally writes the files named in
//               $FAKE_DOCKER_PLANT (JSON {path: content}) to simulate a job planting git config,
//               sleeps $FAKE_DOCKER_RUN_MS (default 0), and exits $FAKE_DOCKER_RUN_EXIT (default 0).
//               While sleeping, a `kill` invocation for the same name (seen via a marker file) makes
//               it exit 137, as the real client does when its container is killed.
//   kill <n> -> writes the kill marker and exits 0, or 1 with "No such container" when
//               $FAKE_DOCKER_KILL_GONE=1.
import fs from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv }) + "\n");
const marker = log ? `${log}.killed` : null;

if (argv[0] === "kill") {
  if (process.env.FAKE_DOCKER_KILL_GONE === "1") {
    process.stderr.write(`Error response from daemon: No such container: ${argv[1]}\n`);
    process.exit(1);
  }
  if (marker) fs.writeFileSync(marker, argv[1]);
  process.exit(0);
}

if (argv[0] === "run") {
  process.stdout.write("container stdout\n");
  if (process.env.FAKE_DOCKER_STDOUT) process.stdout.write(process.env.FAKE_DOCKER_STDOUT + "\n");
  process.stderr.write("container stderr\n");
  if (process.env.FAKE_DOCKER_PLANT) {
    for (const [p, content] of Object.entries(JSON.parse(process.env.FAKE_DOCKER_PLANT))) fs.writeFileSync(p, content);
  }
  const runMs = Number(process.env.FAKE_DOCKER_RUN_MS) || 0;
  const code = Number(process.env.FAKE_DOCKER_RUN_EXIT) || 0;
  const deadline = Date.now() + runMs;
  const tick = () => {
    if (marker && fs.existsSync(marker)) process.exit(137);
    if (Date.now() >= deadline) process.exit(code);
    setTimeout(tick, 25);
  };
  tick();
} else {
  process.exit(0);
}
