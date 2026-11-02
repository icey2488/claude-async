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

// Checks the key file's existence, kind, size, shape (a PEM private key) and, on POSIX, that only
// the owner can read it (mode & 077 == 0). On win32 the mode bits carry nothing; the ACL expectation
// (owner + SYSTEM only, set with icacls in the rollout) is documented, not checked. Never returns
// the key material. forbidInside: roots the file must not be in (the checkout, the mount sources).
export function checkAppKeyFile(keyFile, { platform = process.platform, forbidInside = [], realpath = defaultRealpath, fsImpl = fs } = {}) {
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

async function call({ method = "GET", url, jwt, body, fetch: f = globalThis.fetch, timeoutMs = 20_000 }) {
  const headers = { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json",
                    "x-github-api-version": "2022-11-28", "user-agent": USER_AGENT };
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
// there (install it on that repo). 401: key/app-id mismatch.
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
  return { installationId: id };
}

// POST /app/installations/{id}/access_tokens with the one repo and the three permissions.
export async function mintInstallationToken({ installationId, repoName, jwt, fetch: f, apiBase = GITHUB_API_BASE }) {
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
  const expiresAt = r.json.expires_at ? Date.parse(r.json.expires_at) : NaN;
  return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000 };
}

// GET /app -> slug; GET /users/<slug>[bot] -> the bot user's id. Both are what commit authorship
// needs (<slug>[bot] <id+slug[bot]@users.noreply.github.com>), fetched once at preflight.
export async function fetchAppIdentity({ jwt, fetch: f, apiBase = GITHUB_API_BASE }) {
  const a = await call({ url: `${apiBase}/app`, jwt, fetch: f });
  if (a.status === 401) throw new Error(mismatch());
  if (!a.ok) throw new Error(`GET /app failed with HTTP ${a.status}${a.message ? `: ${a.message}` : ""}`);
  const slug = a.json && typeof a.json === "object" ? a.json.slug : null;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new Error("GET /app returned no usable app slug");
  const u = await call({ url: `${apiBase}/users/${encodeURIComponent(`${slug}[bot]`)}`, jwt, fetch: f });
  if (!u.ok) throw new Error(`GET /users/${slug}[bot] failed with HTTP ${u.status}${u.message ? `: ${u.message}` : ""}`);
  const botUserId = u.json && u.json.id;
  if (!Number.isInteger(botUserId) || botUserId <= 0) throw new Error(`GET /users/${slug}[bot] returned no user id`);
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
export function createMinter({ appId, keyFile, installationId, repoName, fetch: f = globalThis.fetch, apiBase = GITHUB_API_BASE, nowSeconds }) {
  if (!appId || !keyFile || !installationId || !repoName) throw new Error("createMinter: appId, keyFile, installationId and repoName are required");
  return {
    async mint() {
      const pem = readPrivateKey(keyFile);
      const jwt = buildAppJwt({ appId, privateKeyPem: pem, ...(nowSeconds ? { nowSeconds: nowSeconds() } : {}) });
      return mintInstallationToken({ installationId, repoName, jwt, fetch: f, apiBase });
    },
  };
}

// owner/repo -> the repo name the access_tokens body wants.
export function repoNameOf(repo) {
  return String(repo).split("/")[1] || "";
}

export const _internal = { call, mismatch, path };
