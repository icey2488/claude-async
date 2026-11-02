/**
 * github-app.mjs -- the GitHub identity of container jobs (design: docs/container-jobs.md,
 * "Identity: the GitHub App").
 *
 * Container jobs act on GitHub as a GitHub App owned by Erick's own account and installed only on
 * the repos jobs may touch. There is no bot account and no long-lived GitHub token anywhere: the
 * host holds the App's private key (a PEM file, readable only by the owner), builds a short-lived
 * App JWT from it, and mints a one-hour INSTALLATION token scoped to the job's one repo with
 * contents:write, pull_requests:write and metadata:read. The runner writes that token into a
 * per-job file the container reads through a read-only bind mount, and re-mints it while the job
 * runs (job-runner.mjs). The key never enters the container, argv, spec.json, meta.json or a log.
 *
 * Everything here uses Node's built-in crypto and fetch (no dependencies). Every network call is
 * injectable (the `fetch` option) so the tests run against a fake api.github.com.
 *
 * What this module does NOT do: write tokens anywhere (the runner owns the file), cache tokens, or
 * keep the key in memory between mints (it is re-read from the file on every mint, so rotating the
 * file takes effect at the next refresh without restarting anything).
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isInside } from "./scripts/publish-branch.mjs";

export const GITHUB_API_BASE = "https://api.github.com";
export const DEFAULT_REFRESH_MS = 45 * 60 * 1000;          // installation tokens live 60 min
export const MIN_REFRESH_MS = 60 * 1000;
export const MAX_REFRESH_MS = 55 * 60 * 1000;              // must come before the token expires
// The installation token's scope. Nothing else: no issues, no workflows, no administration.
export const INSTALLATION_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write", metadata: "read" });
export const JWT_LIFETIME_S = 9 * 60;                       // GitHub's maximum is 10 min
export const JWT_BACKDATE_S = 60;                           // clock drift allowance GitHub recommends
const KEY_FILE_MAX_BYTES = 16 * 1024;
const USER_AGENT = "claude-async-container-jobs";
const APP_ID_RE = /^\d{1,20}$/;
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const HTTP_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const REPO_FULL_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

// ------------------------------------------------------------------------------- config ---

// CLAUDE_ASYNC_GITHUB_APP_ID: the App's numeric ID (its settings page). CLAUDE_ASYNC_GITHUB_APP_KEY_FILE:
// the .pem GitHub generated for it. CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS: how often the runner re-mints.
// CLAUDE_ASYNC_GITHUB_API_BASE: the API origin; only tests (a loopback fake) or GHES change it.
export function loadGitHubAppConfig(env = process.env) {
  return {
    appId: env.CLAUDE_ASYNC_GITHUB_APP_ID ? String(env.CLAUDE_ASYNC_GITHUB_APP_ID).trim() : null,
    keyFile: env.CLAUDE_ASYNC_GITHUB_APP_KEY_FILE || null,
    refreshMs: env.CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS !== undefined && env.CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS !== ""
      ? Number(env.CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS) : DEFAULT_REFRESH_MS,
    apiBase: (env.CLAUDE_ASYNC_GITHUB_API_BASE || GITHUB_API_BASE).replace(/\/+$/, ""),
  };
}

export const APP_ID_HELP = "the numeric App ID shown at the top of the GitHub App's settings page (Settings, Developer settings, GitHub Apps, <app>)";

export function validateGitHubAppConfig(cfg) {
  const errs = [];
  if (!cfg.appId) errs.push(`CLAUDE_ASYNC_GITHUB_APP_ID is not set (${APP_ID_HELP}); container jobs authenticate to GitHub as that App, so set it together with CLAUDE_ASYNC_GITHUB_APP_KEY_FILE`);
  else if (!APP_ID_RE.test(cfg.appId)) errs.push(`CLAUDE_ASYNC_GITHUB_APP_ID ${JSON.stringify(cfg.appId)} must be the numeric App ID (digits only), not the client ID or the app name`);
  if (!cfg.keyFile) errs.push("CLAUDE_ASYNC_GITHUB_APP_KEY_FILE is not set (the path of the App's private key .pem, generated under the App's settings, \"Private keys\"); keep it outside every repo, readable only by the owner");
  if (!Number.isInteger(cfg.refreshMs) || cfg.refreshMs < MIN_REFRESH_MS || cfg.refreshMs > MAX_REFRESH_MS) {
    errs.push(`CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS ${JSON.stringify(cfg.refreshMs)} must be an integer between ${MIN_REFRESH_MS} and ${MAX_REFRESH_MS} (installation tokens live 60 minutes; default ${DEFAULT_REFRESH_MS})`);
  }
  if (!HTTP_URL_RE.test(cfg.apiBase || "")) errs.push(`CLAUDE_ASYNC_GITHUB_API_BASE ${JSON.stringify(cfg.apiBase)} must be a plain http(s)://host[:port] origin (default ${GITHUB_API_BASE})`);
  return errs;
}

// ------------------------------------------------------------------------------ key file ---

function stripLongPathPrefix(r) {
  return typeof r === "string" && r.startsWith("\\\\?\\") && !r.startsWith("\\\\?\\UNC\\") ? r.slice(4) : r;
}
const defaultRealpath = (p) => stripLongPathPrefix(fs.realpathSync.native(p));

// Windows ACL check of the key file (review round 3). `icacls <file>` prints the path followed by one
// "<principal>:<rights>" entry per line, then a blank line and a summary. Returns [{ principal,
// rights }] or null when the output is not that shape (the caller then refuses: conservative).
const BROAD_PRINCIPALS = new Set(["everyone", "users", "builtin\\users", "authenticated users", "nt authority\\authenticated users",
  "anonymous logon", "nt authority\\anonymous logon", "*s-1-1-0", "*s-1-5-32-545", "*s-1-5-11", "*s-1-5-7"]);
export function parseIcaclsAces(stdout, file) {
  const lines = String(stdout || "").split(/\r?\n/);
  const aces = [];
  let i = 0;
  for (; i < lines.length; i++) {
    let l = lines[i];
    if (!l.trim()) break;
    if (i === 0) {
      const at = l.toLowerCase().indexOf(String(file).toLowerCase());
      if (at !== 0) return null;
      l = l.slice(String(file).length);
    }
    const m = /^\s*(.+?):((?:\([A-Za-z,]+\))+)\s*$/.exec(l);
    if (!m) return null;
    aces.push({ principal: m[1].trim(), rights: m[2] });
  }
  const summary = lines.slice(i).join("\n");
  if (!aces.length || !/Successfully processed 1 files/i.test(summary)) return null;
  return aces;
}
const defaultIcacls = (file) => spawnSync("icacls", [file], { encoding: "utf8", timeout: 15_000, windowsHide: true });
function checkWin32KeyAcl(real, icacls) {
  const fixHint = `run: icacls "${real}" /inheritance:r /grant:r "%USERNAME%:F" "SYSTEM:F" (docs/container-jobs.md rollout step 6)`;
  let r;
  try { r = icacls(real); } catch (e) { r = { error: e }; }
  if (!r || r.error) return `could not check the ACL of the GitHub App key file ${real}: icacls failed to run (${(r && r.error && (r.error.code || r.error.message)) || "no result"}); refusing to use a key whose ACL cannot be checked`;
  if (r.status !== 0) return `could not check the ACL of the GitHub App key file ${real}: icacls exited ${r.status} (${String(r.stderr || r.stdout || "").trim().slice(0, 200)}); refusing to use a key whose ACL cannot be checked`;
  const aces = parseIcaclsAces(r.stdout, real);
  if (!aces) return `the ACL of the GitHub App key file ${real} could not be parsed from icacls output; refusing to use it. Check it by hand and ${fixHint}`;
  const broad = aces.filter((a) => BROAD_PRINCIPALS.has(a.principal.toLowerCase()) && !/\(DENY\)/i.test(a.rights));
  if (broad.length) {
    return `the GitHub App key file ${real} grants ${broad.map((a) => `${a.principal} ${a.rights}`).join(", ")} access (icacls); only your account and SYSTEM may read it. ` +
      `Anything that can read the key can act as the App on every repo it is installed on; ${fixHint}`;
  }
  return null;
}

// Checks the key file's existence, kind, size, shape (a PEM private key) and that only the owner can
// read it: on POSIX mode & 077 == 0; on win32 (review round 3) its ACL through icacls, refusing any
// entry that grants Everyone, Users, Authenticated Users or BUILTIN\Users access, and refusing when
// icacls is missing or its output cannot be parsed. Never returns the key material. forbidInside:
// roots the file must not be in (the checkout, the mount sources). icacls: test seam.
export function checkAppKeyFile(keyFile, { platform = process.platform, forbidInside = [], realpath = defaultRealpath, fsImpl = fs, icacls = defaultIcacls } = {}) {
  if (!keyFile) return { error: "CLAUDE_ASYNC_GITHUB_APP_KEY_FILE is not set (the GitHub App's private key .pem); container jobs cannot authenticate to GitHub without it" };
  let real;
  try { real = realpath(keyFile); } catch { return { error: `GitHub App key file ${keyFile} does not exist (CLAUDE_ASYNC_GITHUB_APP_KEY_FILE); generate a private key under the App's settings and save it there` }; }
  let st;
  try { st = fsImpl.statSync(real); } catch (e) { return { error: `GitHub App key file ${real} is not readable (${e.code || "error"})` }; }
  if (!st.isFile()) return { error: `GitHub App key file ${real} is not a regular file` };
  if (st.size === 0) return { error: `GitHub App key file ${real} is empty` };
  if (st.size > KEY_FILE_MAX_BYTES) return { error: `GitHub App key file ${real} is larger than ${KEY_FILE_MAX_BYTES} bytes; that is not a GitHub App private key` };
  if (platform !== "win32" && (st.mode & 0o077) !== 0) {
    return { error: `GitHub App key file ${real} is readable by group or others (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it. ` +
      "Anything that can read the key can act as the App on every repo it is installed on" };
  }
  for (const root of forbidInside) {
    let r; try { r = realpath(root); } catch { continue; }
    if (r === real) return { error: `GitHub App key file ${real} is the same file as ${r} (a container mount source or the secrets file); keep the key in its own file` };
    if (isInside(r, real, platform)) return { error: `GitHub App key file ${real} is inside ${r}; keep it outside the claude-async checkout and the mount sources` };
  }
  let head;
  try { const fd = fsImpl.openSync(real, "r"); const buf = Buffer.alloc(64); const n = fsImpl.readSync(fd, buf, 0, 64, 0); fsImpl.closeSync(fd); head = buf.toString("utf8", 0, n); }
  catch (e) { return { error: `GitHub App key file ${real} is not readable (${e.code || "error"})` }; }
  if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/.test(head.replace(/^﻿/, ""))) {
    return { error: `GitHub App key file ${real} is not a PEM private key (expected a -----BEGIN RSA PRIVATE KEY----- file as GitHub generates it)` };
  }
  if (platform === "win32") {
    const aclError = checkWin32KeyAcl(real, icacls);
    if (aclError) return { error: aclError };
  }
  return { real, readable: true };
}

function readPrivateKey(keyFile) {
  const chk = checkAppKeyFile(keyFile);
  if (chk.error) throw new Error(chk.error);
  return fs.readFileSync(chk.real, "utf8");
}

// ---------------------------------------------------------------------------------- JWT ---

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// The App JWT GitHub's App endpoints take as a Bearer: RS256 over { iat: now-60, exp: now+540,
// iss: <app id> }. nowSeconds is injectable for tests.
export function buildAppJwt({ appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!appId || !APP_ID_RE.test(String(appId))) throw new Error("buildAppJwt: app id must be the numeric App ID");
  let key;
  try { key = crypto.createPrivateKey({ key: privateKeyPem, format: "pem" }); }
  catch (e) { throw new Error(`GitHub App private key could not be parsed (${e.message}); is CLAUDE_ASYNC_GITHUB_APP_KEY_FILE the .pem GitHub generated?`); }
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - JWT_BACKDATE_S, exp: nowSeconds + JWT_LIFETIME_S, iss: String(appId) }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------- API calls ---

// jwt: the App JWT for the /app endpoints; omitted (no Authorization header at all) for public
// endpoints such as GET /users/<login>, where GitHub does not accept an App JWT (review round 3).
async function call({ method = "GET", url, jwt, body, fetch: f = globalThis.fetch, timeoutMs = 20_000 }) {
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": USER_AGENT };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
                         signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
  } catch (e) {
    throw new Error(`could not reach ${new URL(url).host} (${e && e.cause && e.cause.message ? e.cause.message : (e && e.message) || e})`);
  }
  let text = "";
  try { text = await res.text(); } catch {}
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  const message = json && typeof json === "object" && typeof json.message === "string" ? json.message : "";
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json, message };
}

const mismatch = () => "the JWT was rejected (401): CLAUDE_ASYNC_GITHUB_APP_ID and CLAUDE_ASYNC_GITHUB_APP_KEY_FILE do not match (the private key " +
  "was generated for a different app id, or the key was revoked), or the host clock is off by more than a minute";

// GET /repos/{owner}/{repo}/installation -> { installationId }. 404: the App is not installed
// there (install it on that repo). 401: key/app-id mismatch. Review round 3 (Argon #2): refused at
// preflight, before any job dir exists, when the lookup was answered for ANOTHER account (GitHub
// follows a rename/transfer redirect, so "owner/old-name" can resolve to an installation elsewhere),
// when the installation is suspended, or when it lacks contents:write or pull_requests:write.
export async function findInstallation({ repo, jwt, fetch: f, apiBase = GITHUB_API_BASE }) {
  const r = await call({ url: `${apiBase}/repos/${repo}/installation`, jwt, fetch: f });
  if (r.status === 401) throw new Error(mismatch());
  if (r.status === 404) {
    throw new Error(`the GitHub App is not installed on ${repo} (404 from GET /repos/${repo}/installation). ` +
      `Install the app on that repository: the App's settings page, "Install App", choose "Only select repositories" and add ${repo}. ` +
      "A repo the App is not installed on cannot be a container job's repo");
  }
  if (!r.ok) throw new Error(`GET /repos/${repo}/installation failed with HTTP ${r.status}${r.message ? `: ${r.message}` : ""}`);
  const id = r.json && r.json.id;
  if (!Number.isInteger(id) || id <= 0) throw new Error(`GET /repos/${repo}/installation returned no installation id`);
  const owner = String(repo).split("/")[0];
  const login = r.json.account && typeof r.json.account.login === "string" ? r.json.account.login : "";
  if (!login || login.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`GET /repos/${repo}/installation answered with an installation on the account ${JSON.stringify(login || "(none)")}, not ${owner}: ` +
      "the repository was probably renamed or transferred (GitHub followed a redirect). Use its current owner/name in " +
      "CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS and the job's repo");
  }
  if (r.json.suspended_at) {
    throw new Error(`the GitHub App's installation on ${owner} is suspended (since ${r.json.suspended_at}); unsuspend it on the installation's settings page`);
  }
  const perms = r.json.permissions && typeof r.json.permissions === "object" ? r.json.permissions : {};
  for (const k of ["contents", "pull_requests"]) {
    if (perms[k] !== "write") {
      throw new Error(`the GitHub App's installation on ${owner} does not grant ${k}: write (it has ${JSON.stringify(perms[k] || "none")}). ` +
        "Give the App Contents: read and write and Pull requests: read and write, then accept the new permissions on the installation page");
    }
  }
  return { installationId: id };
}

// POST /app/installations/{id}/access_tokens with the one repo and the three permissions. repo: the
// full owner/repo the token must be for; the response's `repositories` must be exactly that one repo
// (case-insensitive), or the token is refused (review round 3: after a rename/transfer the short name
// could select a different repository in the same installation). A response without `repositories`
// is refused too (fail closed).
export async function mintInstallationToken({ installationId, repoName, repo, jwt, fetch: f, apiBase = GITHUB_API_BASE }) {
  if (!repo || !REPO_FULL_RE.test(String(repo))) throw new Error("mintInstallationToken: repo (owner/repo) is required to check the token's repository");
  const r = await call({ method: "POST", url: `${apiBase}/app/installations/${installationId}/access_tokens`, jwt, fetch: f,
                         body: { repositories: [repoName], permissions: { ...INSTALLATION_PERMISSIONS } } });
  if (r.status === 401) throw new Error(mismatch());
  if (r.status === 422) {
    throw new Error(`minting an installation token failed with HTTP 422${r.message ? `: ${r.message}` : ""}. The App needs the repository ` +
      "permissions Contents: read and write, Pull requests: read and write, Metadata: read-only, and the installation must include " +
      `the repo ${repoName} (re-accept the permissions on the installation page if they were changed after installing)`);
  }
  if (!r.ok) throw new Error(`minting an installation token failed with HTTP ${r.status}${r.message ? `: ${r.message}` : ""}`);
  const token = r.json && typeof r.json.token === "string" ? r.json.token : "";
  if (!token) throw new Error("the access_tokens response carried no token");
  const repos = r.json.repositories;
  if (!Array.isArray(repos)) throw new Error(`the access_tokens response did not list the token's repositories; refusing a token that cannot be shown to be for ${repo} only`);
  if (repos.length !== 1) throw new Error(`the minted token covers ${repos.length} repositories, not exactly one (${repo}); refusing it`);
  const full = repos[0] && typeof repos[0].full_name === "string" ? repos[0].full_name : "";
  if (full.toLowerCase() !== String(repo).toLowerCase()) {
    throw new Error(`the minted token is for ${JSON.stringify(full || "(unnamed)")}, not ${repo} (renamed or transferred repository?); refusing it`);
  }
  const expiresAt = r.json.expires_at ? Date.parse(r.json.expires_at) : NaN;
  return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000 };
}

const identityCache = new Map();
// GET /app -> slug; GET /users/<slug>[bot] -> the bot user's id. Both are what commit authorship
// needs (<slug>[bot] <id+slug[bot]@users.noreply.github.com>), fetched once at preflight.
export async function fetchAppIdentity({ jwt, fetch: f, apiBase = GITHUB_API_BASE }) {
  const a = await call({ url: `${apiBase}/app`, jwt, fetch: f });
  if (a.status === 401) throw new Error(mismatch());
  if (!a.ok) throw new Error(`GET /app failed with HTTP ${a.status}${a.message ? `: ${a.message}` : ""}`);
  const slug = a.json && typeof a.json === "object" ? a.json.slug : null;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new Error("GET /app returned no usable app slug");
  // Public endpoint: no Authorization header (an App JWT is not a credential GitHub accepts here).
  // Cached per API origin and slug for the life of this process: the id never changes, and
  // unauthenticated calls share a 60/hour per-IP limit.
  const key = `${apiBase}|${slug}`;
  if (identityCache.has(key)) return { slug, botUserId: identityCache.get(key) };
  const u = await call({ url: `${apiBase}/users/${encodeURIComponent(`${slug}[bot]`)}`, fetch: f });
  if (!u.ok) throw new Error(`GET /users/${slug}[bot] (unauthenticated) failed with HTTP ${u.status}${u.message ? `: ${u.message}` : ""}`);
  const botUserId = u.json && u.json.id;
  if (!Number.isInteger(botUserId) || botUserId <= 0) throw new Error(`GET /users/${slug}[bot] returned no user id`);
  identityCache.set(key, botUserId);
  return { slug, botUserId };
}

// The commit identity GitHub links to the App's bot user.
export function botGitIdentity({ slug, botUserId }) {
  return { name: `${slug}[bot]`, email: `${botUserId}+${slug}[bot]@users.noreply.github.com` };
}

// ------------------------------------------------------------------------------- preflight ---

// Everything job-core needs to know before a container job starts, in one call: config shape, key
// file (existence, permissions, PEM), a JWT from it (proves the key parses), the installation on
// the job's repo, and the App's identity for commit authorship. Mints nothing. Returns { error }
// (text says exactly what to do) or { installationId, slug, botUserId, keyFile }.
export async function preflightGitHubApp({ appId, keyFile, repo, fetch: f, apiBase = GITHUB_API_BASE, forbidInside = [], platform = process.platform, nowSeconds }) {
  const cfgErrs = validateGitHubAppConfig({ appId, keyFile, refreshMs: DEFAULT_REFRESH_MS, apiBase });
  if (cfgErrs.length) return { error: cfgErrs.join("; ") };
  const kf = checkAppKeyFile(keyFile, { platform, forbidInside });
  if (kf.error) return { error: kf.error };
  let jwt;
  try { jwt = buildAppJwt({ appId, privateKeyPem: fs.readFileSync(kf.real, "utf8"), ...(nowSeconds ? { nowSeconds } : {}) }); }
  catch (e) { return { error: e.message }; }
  try {
    const { installationId } = await findInstallation({ repo, jwt, fetch: f, apiBase });
    const { slug, botUserId } = await fetchAppIdentity({ jwt, fetch: f, apiBase });
    return { installationId, slug, botUserId, keyFile: kf.real };
  } catch (e) {
    const host = (() => { try { return new URL(apiBase).host; } catch { return apiBase; } })();
    return { error: `GitHub App preflight against ${host} failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------------- minter ---

// What the runner holds for the job's lifetime: mint() re-reads the key file, builds a fresh JWT
// and returns a new installation token. Nothing is cached here; the runner owns the token file.
export function createMinter({ appId, keyFile, installationId, repoName, repo, fetch: f = globalThis.fetch, apiBase = GITHUB_API_BASE, nowSeconds }) {
  if (!appId || !keyFile || !installationId || !repoName || !repo) throw new Error("createMinter: appId, keyFile, installationId, repoName and repo are required");
  return {
    async mint() {
      const pem = readPrivateKey(keyFile);
      const jwt = buildAppJwt({ appId, privateKeyPem: pem, ...(nowSeconds ? { nowSeconds: nowSeconds() } : {}) });
      return mintInstallationToken({ installationId, repoName, repo, jwt, fetch: f, apiBase });
    },
  };
}

// owner/repo -> the repo name the access_tokens body wants.
export function repoNameOf(repo) {
  return String(repo).split("/")[1] || "";
}

export const _internal = { call, mismatch, path, clearIdentityCache: () => identityCache.clear() };
