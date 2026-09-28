// Fake CLI for discord-notify tests: writes an arbitrary (base64-encoded, so newlines/@/backticks
// survive argv untouched) blob to stdout, then exits with the given code.
//   node notify-fake-cli.mjs --stdout-b64 <base64> --exit CODE
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const b64 = opt("stdout-b64", "");
const code = Number(opt("exit", 0));
const out = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
process.stdout.write(out, () => process.exit(code));
