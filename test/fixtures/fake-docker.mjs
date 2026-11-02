#!/usr/bin/env node
// Fake `docker` for test/container-runner.test.mjs. Appends one JSON line per invocation to
// $FAKE_DOCKER_LOG ({ argv }). Container state lives in "$FAKE_DOCKER_LOG.state.json"
// ({ id, label, state }), so separate invocations (run / ps / rm) see the same "daemon":
//   run ...   -> after $FAKE_DOCKER_CREATE_DELAY_MS (default 0) creates the container (state file,
//                state "running"), prints $FAKE_DOCKER_STDOUT (first), "container stdout" / "container stderr",
//                and, with $FAKE_DOCKER_CAT_FILE set, "CAT:<that file's content>" at start and
//                "CAT_END:<content>" right before exiting (what a container would see of the host's
//                token file through the creds mount; the runner must have written it before `run`),
//                then runs for $FAKE_DOCKER_RUN_MS (default 0) and exits $FAKE_DOCKER_RUN_EXIT
//                (default 0), removing the container (--rm) -- unless $FAKE_DOCKER_LEAVE_RUNNING=1,
//                which models a client that exits while its container keeps running. If the
//                container is removed while it runs (rm -f), the client exits 137, as the real one does.
//                $FAKE_DOCKER_DAEMON_CREATE_DELAY_MS=N decouples creation from the client process, as
//                it is in the real engine: the client hands the create request to a detached "daemon"
//                process which writes the state after N ms whether or not the client is still alive
//                (a killed client's request is still served). The client waits for the state to appear.
//   ps -a ... -> prints "<id>\t<state>\t<label>" for the container, if it exists. Fails like a
//                daemon that is down while $FAKE_DOCKER_DAEMON_DOWN names an existing file.
//   rm -f <id>-> removes the container (exit 0; a missing one is also exit 0, as with docker 29),
//                unless $FAKE_DOCKER_IGNORE_RM=1 (models a wedged daemon: exit 0, container stays).
//                $FAKE_DOCKER_IGNORE_RM may also name a file: rm is ignored only while it exists, so a
//                test can let the daemon "recover" by deleting it.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);

// Internal: the detached daemon-side create (see FAKE_DOCKER_DAEMON_CREATE_DELAY_MS above).
if (argv[0] === "__daemon-create") {
  const [, file, json, delay] = argv;
  setTimeout(() => { try { fs.writeFileSync(file, json); } catch {} }, Number(delay) || 0);
} else {

const log = process.env.FAKE_DOCKER_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv }) + "\n");
const stateFile = log ? `${log}.state.json` : null;
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; } };
const daemonDown = () => process.env.FAKE_DOCKER_DAEMON_DOWN && fs.existsSync(process.env.FAKE_DOCKER_DAEMON_DOWN);
const ignoreRm = () => { const v = process.env.FAKE_DOCKER_IGNORE_RM; return v === "1" || (v && v !== "0" && fs.existsSync(v)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (daemonDown() && argv[0] !== "run") {
  process.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
  process.exit(1);
}

if (argv[0] === "ps") {
  const st = readState();
  if (st) process.stdout.write(`${st.id}\t${st.state}\t${st.label}\n`);
  process.exit(0);
}

if (argv[0] === "rm") {
  if (!ignoreRm()) { try { fs.rmSync(stateFile); } catch {} }
  process.exit(0);
}

if (argv[0] === "run") {
  const label = (argv[argv.indexOf("--label") + 1] || "").replace(/^claude-async\.job=/, "");
  const name = argv[argv.indexOf("--name") + 1] || "x";
  const id = crypto.createHash("sha256").update(name).digest("hex");
  const createDelay = Number(process.env.FAKE_DOCKER_CREATE_DELAY_MS) || 0;
  if (createDelay) await sleep(createDelay);
  const state = JSON.stringify({ id, label, state: "running" });
  const daemonDelay = Number(process.env.FAKE_DOCKER_DAEMON_CREATE_DELAY_MS) || 0;
  if (daemonDelay) {
    const d = spawn(process.execPath, [fileURLToPath(import.meta.url), "__daemon-create", stateFile, state, String(daemonDelay)],
                    { detached: true, stdio: "ignore" });
    d.unref();
    while (!readState()) await sleep(25);
  } else {
    fs.writeFileSync(stateFile, state);
  }
  const cat = (tag) => { if (!process.env.FAKE_DOCKER_CAT_FILE) return;
    let v; try { v = fs.readFileSync(process.env.FAKE_DOCKER_CAT_FILE, "utf8").trim(); } catch (e) { v = `ERR:${e.code}`; }
    process.stdout.write(`${tag}:${v}\n`); };
  if (process.env.FAKE_DOCKER_STDOUT) process.stdout.write(process.env.FAKE_DOCKER_STDOUT + "\n");
  cat("CAT");
  process.stdout.write("container stdout\n");
  process.stderr.write("container stderr\n");
  const runMs = Number(process.env.FAKE_DOCKER_RUN_MS) || 0;
  const code = Number(process.env.FAKE_DOCKER_RUN_EXIT) || 0;
  const deadline = Date.now() + runMs;
  for (;;) {
    if (!readState()) process.exit(137);                    // removed under us (rm -f)
    if (Date.now() >= deadline) {
      cat("CAT_END");
      if (process.env.FAKE_DOCKER_LEAVE_RUNNING !== "1") { try { fs.rmSync(stateFile); } catch {} }
      process.exit(code);
    }
    await sleep(25);
  }
}
process.exit(0);

}
