// Stub for job-runner.mjs in claim.test.mjs's real-launcher variant: the launcher spawns
// `node <this> <spec.json>`; we just leave one ran-<pid> file in the job dir, so a job that was
// launched twice shows up as two files.
import fs from "node:fs";
import path from "node:path";

fs.writeFileSync(path.join(path.dirname(process.argv[2]), `ran-${process.pid}`), "");
