#!/usr/bin/env node
// A fake api.github.com for the GitHub App paths container jobs use (github-app.mjs), run as its
// OWN PROCESS on a loopback port so the runner under test (job-runner.mjs, spawned synchronously
// by some tests) can always reach it:
//   node fake-github-app.mjs <state-dir>
// <state-dir>/public.pem holds the public key every App JWT is verified with (401 otherwise).
// It writes <state-dir>/port when listening, appends one JSON line per request to
// <state-dir>/calls.jsonl, appends every issued token to <state-dir>/tokens, and reads control
// files on every request: <state-dir>/fail-mint (exists -> POST access_tokens answers 500),
// <state-dir>/expires-ms (content -> how far ahead expires_at lies; default an hour),
// <state-dir>/mint-delay-ms (content -> POST access_tokens answers after that many ms),
// <state-dir>/mint-full-name (content -> the token's repositories[0].full_name; default owner/<requested>),
// <state-dir>/install-owner (content -> the installation's account.login; default the repo's owner).
// GET /users/<slug>[bot] is public: it answers 401 to a request carrying ANY Authorization header.
//   GET  /repos/<repo>/installation            -> { id: 777 }
//   GET  /app                                  -> { slug: "claunker-jobs" }
//   GET  /users/claunker-jobs[bot]             -> { id: 98765 }
//   POST /app/installations/777/access_tokens  -> { token: ghs_<n><random>, expires_at }
// startFakeGitHub(dir) (import) spawns it and returns { url, tokens(), calls(), setFailMint(bool),
// setExpiresMs(ms), close() }.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FAKE_REPO = "icey2488/container-job-scratch";
export const FAKE_SLUG = "claunker-jobs";
export const FAKE_BOT_ID = 98765;
export const FAKE_INSTALLATION = 777;

function serve(dir) {
  const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(dir, "public.pem")));
  const verify = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return false;
    const [h, p, s] = m[1].split(".");
    if (!h || !p || !s) return false;
    try {
      const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"));
      const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      const now = Math.floor(Date.now() / 1000);
      return ok && claims.exp > now && claims.iat <= now + 5 && claims.alg === undefined;
    } catch { return false; }
  };
  let issued = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = decodeURIComponent(req.url);
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const jwtOk = verify(req);
      fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ method: req.method, url, body: body ? JSON.parse(body) : undefined, jwtOk, ua: req.headers["user-agent"] }) + "\n");
      const ctl = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8").trim(); } catch { return null; } };
      // A public endpoint, like real GitHub: no credential needed, and an App JWT is NOT accepted there
      // (401), so a caller that sends one fails (review round 3).
      if (req.method === "GET" && url === `/users/${FAKE_SLUG}[bot]`) {
        if (req.headers.authorization) return send(401, { message: "Bad credentials" });
        return send(200, { id: FAKE_BOT_ID, login: `${FAKE_SLUG}[bot]` });
      }
      if (!jwtOk) return send(401, { message: "A JSON web token could not be decoded" });
      if (req.method === "GET" && url === `/repos/${FAKE_REPO}/installation`) {
        return send(200, { id: FAKE_INSTALLATION, account: { login: ctl("install-owner") || FAKE_REPO.split("/")[0] }, suspended_at: null,
                           permissions: { contents: "write", pull_requests: "write", metadata: "read" } });
      }
      if (req.method === "GET" && url === "/app") return send(200, { id: 1, slug: FAKE_SLUG });
      if (req.method === "POST" && url === `/app/installations/${FAKE_INSTALLATION}/access_tokens`) {
        if (fs.existsSync(path.join(dir, "fail-mint"))) return send(500, { message: "fake outage" });
        let delayMs = 0;
        try { delayMs = Number(fs.readFileSync(path.join(dir, "mint-delay-ms"), "utf8")) || 0; } catch {}
        if (delayMs) { setTimeout(() => mintAndSend(), delayMs); return; }
        return mintAndSend();
      }
      send(404, { message: "Not Found" });
      function mintAndSend() {
        const b = JSON.parse(body);
        if (!Array.isArray(b.repositories) || b.repositories.length !== 1 || !b.permissions) return send(422, { message: "bad body" });
        let expiresMs = 60 * 60 * 1000;
        try { expiresMs = Number(fs.readFileSync(path.join(dir, "expires-ms"), "utf8")) || expiresMs; } catch {}
        const token = `ghs_${String(++issued).padStart(4, "0")}${crypto.randomBytes(16).toString("hex")}`;
        fs.appendFileSync(path.join(dir, "tokens"), token + "\n");
        return send(201, { token, expires_at: new Date(Date.now() + expiresMs).toISOString(), permissions: b.permissions,
                           repositories: [{ id: 4711, name: b.repositories[0], full_name: ctl("mint-full-name") || `${FAKE_REPO.split("/")[0]}/${b.repositories[0]}` }] });
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(path.join(dir, "port.tmp"), String(server.address().port));
    fs.renameSync(path.join(dir, "port.tmp"), path.join(dir, "port"));
  });
}

export async function startFakeGitHub(dir, { publicKey }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["port", "calls.jsonl", "tokens", "fail-mint", "expires-ms", "mint-delay-ms", "mint-full-name", "install-owner"]) fs.rmSync(path.join(dir, f), { force: true }); // a stale state dir from an earlier run
  fs.writeFileSync(path.join(dir, "public.pem"), publicKey.export({ type: "spki", format: "pem" }));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir], { stdio: "ignore" });
  const portFile = path.join(dir, "port");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error("fake GitHub did not start");
    await new Promise((r) => setTimeout(r, 25));
  }
  const url = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}`;
  const lines = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return {
    url,
    tokens: () => lines("tokens"),
    calls: () => lines("calls.jsonl").map((l) => JSON.parse(l)),
    setFailMint: (on) => { const f = path.join(dir, "fail-mint"); if (on) fs.writeFileSync(f, ""); else fs.rmSync(f, { force: true }); },
    setControl: (name, value) => { const f = path.join(dir, name); if (value) fs.writeFileSync(f, String(value)); else fs.rmSync(f, { force: true }); },
    setMintDelayMs: (ms) => { const f = path.join(dir, "mint-delay-ms"); if (ms) fs.writeFileSync(f, String(ms)); else fs.rmSync(f, { force: true }); },
    setExpiresMs: (ms) => { const f = path.join(dir, "expires-ms"); if (ms) fs.writeFileSync(f, String(ms)); else fs.rmSync(f, { force: true }); },
    close: () => new Promise((r) => { child.on("exit", () => r()); child.kill("SIGTERM"); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) serve(process.argv[2]);
