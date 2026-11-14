// Fake CLI for lantern-runner tests: sleeps for --sleep-ms (default 0) before exiting with
// --exit (default 0), giving a test time to plant a fake session transcript file or meta.json
// mid-run and observe job-runner.mjs react to it before the job finishes.
//   node lantern-fake-cli.mjs --sleep-ms 1200 --exit 0
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const sleepMs = Number(opt("sleep-ms", 0));
const code = Number(opt("exit", 0));
setTimeout(() => process.exit(code), sleepMs);
