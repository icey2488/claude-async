// Fake Claude CLI for job-runner exit-reason tests.
//   node fake-cli.mjs --stderr-lines N --exit CODE [--signal SIGTERM] [--stdout-lines M]
// Writes "err line <i>" (i = 1..N) to stderr and "out line <i>" (i = 1..M) to stdout, then either
// exits with CODE or kills itself with --signal. Defaults: N=0, M=0, CODE=0.
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const n = Number(opt("stderr-lines", 0));
const m = Number(opt("stdout-lines", 0));
const code = Number(opt("exit", 0));
const signal = opt("signal", null);

let err = "";
for (let i = 1; i <= n; i++) err += `err line ${i}\n`;
let out = "";
for (let i = 1; i <= m; i++) out += `out line ${i}\n`;
process.stdout.write(out, () => process.stderr.write(err, () => {
  if (signal) {
    setInterval(() => {}, 1000); // stay alive until the signal lands
    process.kill(process.pid, signal);
  } else {
    process.exit(code);
  }
}));
