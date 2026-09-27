// Fake Claude CLI for job-runner exit-reason tests.
//   node fake-cli.mjs --stderr-lines N --exit CODE [--signal SIGTERM] [--stdout-lines M]
//   node fake-cli.mjs --stderr-numbered N --exit CODE
//   node fake-cli.mjs --stderr-fixed COUNT WIDTH --exit CODE
// Writes "err line <i>" (i = 1..N) to stderr and "out line <i>" (i = 1..M) to stdout, then either
// exits with CODE or kills itself with --signal. Defaults: N=0, M=0, CODE=0.
//
// --stderr-numbered N writes N FIXED-WIDTH lines "line 000001\n" .. "line NNNNNN\n" (each exactly
// 12 bytes) to stderr instead. Fixed width makes the total byte count exactly predictable, which
// lets a test generate a large log cheaply/deterministically (see the "large stderr" test).
//
// --stderr-fixed COUNT WIDTH writes COUNT lines, each PADDED to exactly WIDTH bytes (content +
// trailing "\n"): "line NNNNNN" followed by "x" padding. Unlike --stderr-numbered (whose lines are
// short relative to the 64 KiB tail window, so a great many real lines always survive past any
// mid-line split -- meaning a corrupted/un-dropped fragment never reaches the last-20-lines slice),
// --stderr-fixed's WIDTH lets a test choose how many real lines are left, after the split point, to
// the end of the file -- few enough (< 20) that a corrupted, un-dropped fragment would actually show
// up among the last 20 elements returned. That is what job-runner.mjs's partial-first-line-drop
// step exists to prevent, and it's the only way to make a "boundary" test actually fail if that
// step is missing or broken.
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const optAt = (name, offset, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1 + offset];
};
const n = Number(opt("stderr-lines", 0));
const m = Number(opt("stdout-lines", 0));
const numbered = Number(opt("stderr-numbered", 0));
const fixedCount = Number(opt("stderr-fixed", 0));
const fixedWidth = Number(optAt("stderr-fixed", 1, 0));
const code = Number(opt("exit", 0));
const signal = opt("signal", null);

let err = "";
for (let i = 1; i <= n; i++) err += `err line ${i}\n`;
for (let i = 1; i <= numbered; i++) err += `line ${String(i).padStart(6, "0")}\n`;
for (let i = 1; i <= fixedCount; i++) {
  const body = `line ${String(i).padStart(6, "0")}`.padEnd(fixedWidth - 1, "x");
  err += `${body}\n`;
}
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
