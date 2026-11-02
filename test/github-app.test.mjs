// Unit tests for github-app.mjs: the host-side GitHub App minting used by container jobs. No
// network: every GitHub call goes through an injected fetch. A throwaway RSA key is generated per
// run; the JWT is verified with crypto.verify against its public half.
// Run: node --test test/github-app.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ga = await import("../github-app.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-github-app-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
let n = 0;
function keyFile(mode = 0o600, body = PEM) {
  const f = path.join(TMP, `app-${++n}.pem`);
  fs.writeFileSync(f, body, { mode });
  fs.chmodSync(f, mode);
  return f;
}
const b64url = (s) => Buffer.from(s).toString("base64url");
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const POSIX = process.platform !== "win32";

// A fake api.github.com. routes: { "GET /app": (req) => [status, body], ... }. Records every request.
function fakeGitHub(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${decodeURIComponent(u.pathname)}`;
    calls.push({ key, url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[key];
    if (!r) return { ok: false, status: 404, text: async () => JSON.stringify({ message: "Not Found" }) };
    const [status, body] = typeof r === "function" ? r(calls.at(-1)) : r;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}
const APP = { appId: "123456", repo: "icey2488/container-job-scratch" };
const happyRoutes = {
  "GET /repos/icey2488/container-job-scratch/installation": [200, { id: 777, account: { login: "icey2488" }, suspended_at: null,
                                                                      permissions: { contents: "write", pull_requests: "write", metadata: "read" } }],
  "GET /app": [200, { id: 123456, slug: "claunker-jobs" }],
  "GET /users/claunker-jobs[bot]": [200, { id: 98765, login: "claunker-jobs[bot]" }],
  "POST /app/installations/777/access_tokens": [201, { token: "ghs_" + "A".repeat(36), expires_at: "2026-11-02T01:00:00Z",
                                                       repositories: [{ id: 1, name: "container-job-scratch", full_name: "icey2488/container-job-scratch" }] }],
};

// ------------------------------------------------------------------------------------ JWT ---

test("buildAppJwt: RS256, iss = app id, iat 60 s in the past, exp 9 min ahead; verifiable with the public key", () => {
  const now = 1_800_000_000;
  const jwt = ga.buildAppJwt({ appId: APP.appId, privateKeyPem: PEM, nowSeconds: now });
  const [h, p, s] = jwt.split(".");
  assert.equal(jwt.split(".").length, 3);
  assert.deepEqual(decode(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decode(p), { iat: now - 60, exp: now + 9 * 60, iss: "123456" });
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")), "signature verifies");
  assert.ok(!jwt.includes("=") && !jwt.includes("+") && !jwt.includes("/"), "base64url, unpadded");
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  assert.ok(!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), other, Buffer.from(s, "base64url")));
  // a PKCS#8 key (the other PEM shape GitHub's converter produces) signs too
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal(ga.buildAppJwt({ appId: "1", privateKeyPem: pkcs8, nowSeconds: now }).split(".")[1],
               ga.buildAppJwt({ appId: "1", privateKeyPem: PEM, nowSeconds: now }).split(".")[1]);
  assert.throws(() => ga.buildAppJwt({ appId: "", privateKeyPem: PEM }), /app id/);
  assert.throws(() => ga.buildAppJwt({ appId: "1", privateKeyPem: "not a key" }), /private key/);
});

// ------------------------------------------------------------------------------- key file ---

test("checkAppKeyFile: exists, regular, PEM private key; refuses group/world-readable on POSIX", () => {
  const ok = ga.checkAppKeyFile(keyFile(0o600));
  assert.ok(!ok.error, ok.error);
  assert.ok(ok.real.endsWith(".pem"));
  assert.ok(ok.readable !== false);
  const r400 = ga.checkAppKeyFile(keyFile(0o400));
  assert.ok(!r400.error, "owner read-only is fine");
  assert.match(ga.checkAppKeyFile(null).error, /CLAUDE_ASYNC_GITHUB_APP_KEY_FILE is not set/);
  assert.match(ga.checkAppKeyFile(path.join(TMP, "missing.pem")).error, /does not exist/);
  assert.match(ga.checkAppKeyFile(TMP).error, /not a regular file/);
  assert.match(ga.checkAppKeyFile(keyFile(0o600, "hello\n")).error, /not a PEM private key/);
  assert.match(ga.checkAppKeyFile(keyFile(0o600, "")).error, /empty/);
  if (POSIX) {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666]) {
      const r = ga.checkAppKeyFile(keyFile(mode));
      assert.match(r.error || "", /readable by group or others.*chmod 600/, `mode ${mode.toString(8)}`);
    }
    // the mode check is skipped on win32 (ACLs; documented), even for a file that is 0644 here
    assert.ok(!ga.checkAppKeyFile(keyFile(0o644), { platform: "win32" }).error);
  }
  // never the key material in the result
  const f = keyFile(0o600);
  assert.ok(!JSON.stringify(ga.checkAppKeyFile(f)).includes("PRIVATE KEY"));
});

test("checkAppKeyFile: refuses a key inside a forbidden root or equal to a mount source", () => {
  const dir = path.join(TMP, "forbidden"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "k.pem"); fs.writeFileSync(f, PEM, { mode: 0o600 }); fs.chmodSync(f, 0o600);
  assert.match(ga.checkAppKeyFile(f, { forbidInside: [dir] }).error, /inside .*forbidden/);
  assert.match(ga.checkAppKeyFile(f, { forbidInside: [f] }).error, /same file as/);
  assert.ok(!ga.checkAppKeyFile(f, { forbidInside: [path.join(TMP, "elsewhere")] }).error);
});

// ---------------------------------------------------------------------------- API calls ---

test("findInstallation: GET /repos/{owner}/{repo}/installation with the JWT; 404 names the repo and says to install", async () => {
  const gh = fakeGitHub(happyRoutes);
  const r = await ga.findInstallation({ repo: APP.repo, jwt: "J.W.T", fetch: gh.fetch });
  assert.deepEqual(r, { installationId: 777 });
  assert.equal(gh.calls[0].key, "GET /repos/icey2488/container-job-scratch/installation");
  assert.equal(gh.calls[0].url, "https://api.github.com/repos/icey2488/container-job-scratch/installation");
  assert.equal(gh.calls[0].headers.authorization, "Bearer J.W.T");
  assert.equal(gh.calls[0].headers.accept, "application/vnd.github+json");
  assert.match(gh.calls[0].headers["user-agent"], /claude-async/);
  const none = fakeGitHub({});
  const e = await ga.findInstallation({ repo: "icey2488/other", jwt: "J", fetch: none.fetch }).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.match(e.message, /icey2488\/other/);
  assert.match(e.message, /not installed on icey2488\/other.*install the app on that repository/i);
});

test("findInstallation / fetchAppIdentity: 401 means the key and the app id do not match", async () => {
  const bad = fakeGitHub({ "GET /repos/icey2488/x/installation": [401, { message: "A JSON web token could not be decoded" }],
                           "GET /app": [401, { message: "Bad credentials" }] });
  const e = await ga.findInstallation({ repo: "icey2488/x", jwt: "J", fetch: bad.fetch }).catch((x) => x);
  assert.match(e.message, /401/);
  assert.match(e.message, /CLAUDE_ASYNC_GITHUB_APP_ID.*CLAUDE_ASYNC_GITHUB_APP_KEY_FILE.*do not match|private key .* app id/i);
  const e2 = await ga.fetchAppIdentity({ jwt: "J", fetch: bad.fetch }).catch((x) => x);
  assert.match(e2.message, /401/);
});

test("mintInstallationToken: POST with the repo name and the three permissions only; returns token + expiry", async () => {
  const gh = fakeGitHub(happyRoutes);
  const r = await ga.mintInstallationToken({ installationId: 777, repoName: "container-job-scratch", repo: APP.repo, jwt: "J", fetch: gh.fetch });
  assert.equal(r.token, "ghs_" + "A".repeat(36));
  assert.equal(r.expiresAt, Date.parse("2026-11-02T01:00:00Z"));
  const call = gh.calls[0];
  assert.equal(call.key, "POST /app/installations/777/access_tokens");
  assert.deepEqual(call.body, { repositories: ["container-job-scratch"],
                                permissions: { contents: "write", pull_requests: "write", metadata: "read" } });
  assert.equal(call.headers.authorization, "Bearer J");
  assert.equal(call.headers["content-type"], "application/json");
  // a 422 (the app lacks a permission, or the repo is not in the installation) is a clear error
  const e = await ga.mintInstallationToken({ installationId: 777, repoName: "x", repo: "icey2488/x", jwt: "J",
    fetch: fakeGitHub({ "POST /app/installations/777/access_tokens": [422, { message: "The permissions requested are not granted to this installation." }] }).fetch }).catch((x) => x);
  assert.match(e.message, /422.*permissions requested are not granted/);
  assert.match(e.message, /Contents.*Pull requests.*Metadata/i, "says which permissions the app needs");
  // a response without a token is an error, not undefined
  const e2 = await ga.mintInstallationToken({ installationId: 777, repoName: "x", repo: "icey2488/x", jwt: "J",
    fetch: fakeGitHub({ "POST /app/installations/777/access_tokens": [201, { nope: 1 }] }).fetch }).catch((x) => x);
  assert.match(e2.message, /no token/);
});

test("fetchAppIdentity: GET /app gives the slug, GET /users/<slug>[bot] gives the bot user id", async () => {
  const gh = fakeGitHub(happyRoutes);
  const r = await ga.fetchAppIdentity({ jwt: "J", fetch: gh.fetch });
  assert.deepEqual(r, { slug: "claunker-jobs", botUserId: 98765 });
  assert.deepEqual(gh.calls.map((c) => c.key), ["GET /app", "GET /users/claunker-jobs[bot]"]);
  assert.equal(gh.calls[1].url, "https://api.github.com/users/claunker-jobs%5Bbot%5D");
  assert.deepEqual(ga.botGitIdentity(r), { name: "claunker-jobs[bot]", email: "98765+claunker-jobs[bot]@users.noreply.github.com" });
  const weird = fakeGitHub({ "GET /app": [200, { slug: "bad slug/x" }] });
  await assert.rejects(ga.fetchAppIdentity({ jwt: "J", fetch: weird.fetch }), /slug/);
});

// ------------------------------------------------------------------------------- preflight ---

test("preflightGitHubApp: config + key + installation + identity in one call; fails closed with exact instructions", async () => {
  const gh = fakeGitHub(happyRoutes);
  const kf = keyFile(0o600);
  const ok = await ga.preflightGitHubApp({ appId: APP.appId, keyFile: kf, repo: APP.repo, fetch: gh.fetch });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.installationId, 777);
  assert.equal(ok.slug, "claunker-jobs");
  assert.equal(ok.botUserId, 98765);
  assert.equal(ok.keyFile, fs.realpathSync.native(kf));
  assert.ok(!JSON.stringify(ok).includes("PRIVATE KEY"));
  assert.ok(gh.calls.every((c) => c.key.startsWith("GET ")), "preflight mints nothing; the runner mints");
  assert.match((await ga.preflightGitHubApp({ appId: "", keyFile: kf, repo: APP.repo, fetch: gh.fetch })).error,
    /CLAUDE_ASYNC_GITHUB_APP_ID is not set.*App ID.*GitHub App's settings page/);
  assert.match((await ga.preflightGitHubApp({ appId: "12ab", keyFile: kf, repo: APP.repo, fetch: gh.fetch })).error, /must be the numeric App ID/);
  assert.match((await ga.preflightGitHubApp({ appId: "1", keyFile: null, repo: APP.repo, fetch: gh.fetch })).error, /KEY_FILE is not set/);
  if (POSIX) assert.match((await ga.preflightGitHubApp({ appId: "1", keyFile: keyFile(0o644), repo: APP.repo, fetch: gh.fetch })).error, /chmod 600/);
  const noInst = await ga.preflightGitHubApp({ appId: "1", keyFile: kf, repo: "icey2488/other", fetch: gh.fetch });
  assert.match(noInst.error, /not installed on icey2488\/other/);
  const down = await ga.preflightGitHubApp({ appId: "1", keyFile: kf, repo: APP.repo, fetch: async () => { throw new Error("ECONNRESET"); } });
  assert.match(down.error, /api\.github\.com.*ECONNRESET/);
});

test("createMinter: reads the key per mint (rotation), builds a fresh JWT, returns token + expiry; never caches the token", async () => {
  const issued = [];
  const gh = fakeGitHub({ ...happyRoutes, "POST /app/installations/777/access_tokens": (call) => {
    issued.push(call.headers.authorization);
    return [201, { token: `ghs_${String(issued.length).padStart(36, "0")}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                   repositories: [{ full_name: APP.repo }] }];
  } });
  const kf = keyFile(0o600);
  const minter = ga.createMinter({ appId: APP.appId, keyFile: kf, installationId: 777, repoName: "container-job-scratch", repo: APP.repo, fetch: gh.fetch });
  const t1 = await minter.mint();
  const t2 = await minter.mint();
  assert.notEqual(t1.token, t2.token);
  assert.ok(t1.expiresAt > Date.now());
  assert.equal(issued.length, 2);
  for (const auth of issued) {
    const [h, p, s] = auth.replace(/^Bearer /, "").split(".");
    assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")), "each mint signs a real JWT with the key file");
    assert.equal(decode(p).iss, "123456");
  }
  // a rotated key file is picked up by the next mint without restarting anything
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(kf, other.privateKey.export({ type: "pkcs1", format: "pem" }));
  await minter.mint();
  const [h, p, s] = issued[2].replace(/^Bearer /, "").split(".");
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), other.publicKey, Buffer.from(s, "base64url")));
  // a key that went missing is a clear error at mint time, not a crash
  fs.rmSync(kf);
  await assert.rejects(minter.mint(), /does not exist/);
});

test("secret hygiene: no function ever puts the key or a token into an error message", async () => {
  const kf = keyFile(0o600);
  const gh = fakeGitHub({ ...happyRoutes, "POST /app/installations/777/access_tokens": [500, { message: "boom" }] });
  const minter = ga.createMinter({ appId: APP.appId, keyFile: kf, installationId: 777, repoName: "r", repo: "icey2488/r", fetch: gh.fetch });
  const e = await minter.mint().catch((x) => x);
  assert.match(e.message, /500/);
  assert.ok(!e.message.includes("PRIVATE") && !/ghs_/.test(e.message) && !e.message.includes("Bearer"));
  const bad = fakeGitHub({ "GET /app": [200, "<html>not json</html>"] });
  const e2 = await ga.fetchAppIdentity({ jwt: "J", fetch: bad.fetch }).catch((x) => x);
  assert.ok(e2 instanceof Error);
});

test("loadGitHubAppConfig: env names, refresh default 45 min, api base default; validation messages", () => {
  const cfg = ga.loadGitHubAppConfig({ CLAUDE_ASYNC_GITHUB_APP_ID: "42", CLAUDE_ASYNC_GITHUB_APP_KEY_FILE: "/k.pem" });
  assert.deepEqual(cfg, { appId: "42", keyFile: "/k.pem", refreshMs: 45 * 60_000, apiBase: "https://api.github.com" });
  assert.deepEqual(ga.validateGitHubAppConfig(cfg), []);
  assert.deepEqual(ga.loadGitHubAppConfig({}), { appId: null, keyFile: null, refreshMs: 45 * 60_000, apiBase: "https://api.github.com" });
  assert.match(ga.validateGitHubAppConfig(ga.loadGitHubAppConfig({})).join(" "), /CLAUDE_ASYNC_GITHUB_APP_ID.*CLAUDE_ASYNC_GITHUB_APP_KEY_FILE/);
  const r = (v) => ga.validateGitHubAppConfig(ga.loadGitHubAppConfig({ CLAUDE_ASYNC_GITHUB_APP_ID: "1", CLAUDE_ASYNC_GITHUB_APP_KEY_FILE: "/k", CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS: v })).join(" ");
  assert.equal(r("600000"), "");
  assert.match(r("1000"), /REFRESH_MS/, "under a minute");
  assert.match(r("3600000"), /REFRESH_MS/, "an hour is the token lifetime; refresh must come before");
  assert.match(r("abc"), /REFRESH_MS/);
  assert.match(ga.validateGitHubAppConfig({ appId: "1", keyFile: "/k", refreshMs: 60_000, apiBase: "ftp://x" }).join(" "), /API_BASE/);
  assert.equal(ga.validateGitHubAppConfig({ appId: "1", keyFile: "/k", refreshMs: 60_000, apiBase: "http://127.0.0.1:8080" }).length, 0, "a loopback http base (tests)");
});

// ------------------------------------------------------------ review round 3 (questions; Argon #2) ---
// GET /users/<slug>[bot] is a public endpoint and real GitHub does not accept an App JWT outside the
// /app endpoints: the lookup goes out WITHOUT an Authorization header and is cached. A repo
// rename/transfer that redirected the installation lookup, a suspended installation, an installation
// lacking the write permissions, and a minted token for any other repo are refused.
const R3_INSTALL = { id: 777, account: { login: "icey2488" }, suspended_at: null,
                     permissions: { contents: "write", pull_requests: "write", metadata: "read" } };
const r3Routes = (over = {}) => ({
  "GET /repos/icey2488/container-job-scratch/installation": [200, R3_INSTALL],
  "GET /app": [200, { id: 123456, slug: "r3-jobs" }],
  // real GitHub: an App JWT here is not a valid credential (modelled as 401); unauthenticated works
  "GET /users/r3-jobs[bot]": (c) => (c.headers.authorization ? [401, { message: "Bad credentials" }] : [200, { id: 4242, login: "r3-jobs[bot]" }]),
  "POST /app/installations/777/access_tokens": [201, { token: "ghs_" + "B".repeat(36), expires_at: "2026-11-02T01:00:00Z",
    repositories: [{ id: 1, name: "container-job-scratch", full_name: "icey2488/container-job-scratch" }] }],
  ...over,
});

test("R3: call() sends no Authorization header without a jwt; the bot-user lookup is unauthenticated and cached", async () => {
  ga._internal.clearIdentityCache();
  const gh = fakeGitHub(r3Routes());
  const r = await ga.fetchAppIdentity({ jwt: "J.W.T", fetch: gh.fetch });
  assert.deepEqual(r, { slug: "r3-jobs", botUserId: 4242 });
  const users = gh.calls.filter((c) => c.key.startsWith("GET /users/"));
  assert.equal(users.length, 1);
  assert.equal("authorization" in users[0].headers, false, "no Authorization header on GET /users/<slug>[bot]");
  assert.equal(gh.calls.find((c) => c.key === "GET /app").headers.authorization, "Bearer J.W.T", "GET /app still uses the JWT");
  // cached: a second preflight does not look the bot user up again
  await ga.fetchAppIdentity({ jwt: "J.W.T", fetch: gh.fetch });
  assert.equal(gh.calls.filter((c) => c.key.startsWith("GET /users/")).length, 1, "the bot user id is cached");
  ga._internal.clearIdentityCache();
});

test("R3: findInstallation refuses a redirected lookup (other account), a suspended installation, and missing write permissions", async () => {
  const ok = await ga.findInstallation({ repo: APP.repo, jwt: "J", fetch: fakeGitHub(r3Routes()).fetch });
  assert.deepEqual(ok, { installationId: 777 });
  const cases = [
    [{ ...R3_INSTALL, account: { login: "someone-else" } }, /someone-else.*renamed or transferred|redirect/i],
    [{ ...R3_INSTALL, suspended_at: "2026-11-01T00:00:00Z" }, /suspended/i],
    [{ ...R3_INSTALL, permissions: { contents: "read", pull_requests: "write", metadata: "read" } }, /contents.*write/i],
    [{ ...R3_INSTALL, permissions: { contents: "write", metadata: "read" } }, /pull_requests.*write/i],
  ];
  for (const [body, re] of cases) {
    const gh = fakeGitHub(r3Routes({ "GET /repos/icey2488/container-job-scratch/installation": [200, body] }));
    await assert.rejects(ga.findInstallation({ repo: APP.repo, jwt: "J", fetch: gh.fetch }), re, JSON.stringify(body));
  }
  // the account login comparison is case-insensitive
  const gh = fakeGitHub(r3Routes({ "GET /repos/icey2488/container-job-scratch/installation": [200, { ...R3_INSTALL, account: { login: "ICEY2488" } }] }));
  assert.deepEqual(await ga.findInstallation({ repo: APP.repo, jwt: "J", fetch: gh.fetch }), { installationId: 777 });
});

test("R3: mintInstallationToken refuses a token whose repositories are not exactly the requested owner/repo", async () => {
  const good = await ga.mintInstallationToken({ installationId: 777, repoName: "container-job-scratch", repo: APP.repo, jwt: "J", fetch: fakeGitHub(r3Routes()).fetch });
  assert.equal(good.token, "ghs_" + "B".repeat(36));
  const mint = (repositories) => ga.mintInstallationToken({ installationId: 777, repoName: "container-job-scratch", repo: APP.repo, jwt: "J",
    fetch: fakeGitHub(r3Routes({ "POST /app/installations/777/access_tokens": [201, { token: "ghs_" + "C".repeat(36), expires_at: "2026-11-02T01:00:00Z",
      ...(repositories === undefined ? {} : { repositories }) }] })).fetch });
  await assert.rejects(mint([{ full_name: "other-owner/container-job-scratch" }]), /other-owner\/container-job-scratch.*not .*icey2488\/container-job-scratch/i);
  await assert.rejects(mint([{ full_name: "icey2488/container-job-scratch" }, { full_name: "icey2488/x" }]), /exactly one/i);
  await assert.rejects(mint(undefined), /repositories/i, "no repositories in the response: refused (fail closed)");
  // case-insensitive match
  assert.ok((await mint([{ full_name: "Icey2488/Container-Job-Scratch" }])).token);
  // the error never carries the token
  const e = await mint([{ full_name: "x/y" }]).catch((x) => x);
  assert.ok(!e.message.includes("CCCC"));
});
