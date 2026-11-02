/**
 * container.mjs -- opt-in "container job" mode for claude-async (design: docs/container-jobs.md).
 *
 * A container job runs the Claude Code CLI inside a Docker container instead of on the bare host:
 * job-runner.mjs spawns `docker run ...` (argv array, no shell) where it would otherwise spawn the
 * CLI. Everything else about the job (job dir, spec.json, heartbeat, out.log/err.log capture,
 * exit.json, DELEGATION-METRICS completeness, card hook, Discord ping) is unchanged, because the
 * runner still owns the child process and its stdout/stderr -- the child just happens to be the
 * docker CLI, attached to the container's stdout/stderr.
 *
 * NO HOST FOLDER IS MOUNTED READ-WRITE. A container job names a GitHub repo ("owner/repo", checked
 * against CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS) and an optional base ref. The image's entrypoint
 * (container/job-entry.sh) clones it over https inside the container, with the bot's GH_TOKEN
 * supplied to git by gh's credential helper (the token is never in argv or in a file), and the job
 * works in container-local storage, pushes a branch and opens a PR as the bot. The only host
 * mounts are two READ-ONLY ones: container/CLAUDE.md (the job rules) and this repo's hooks/ (the
 * no-background hook). Nothing the job writes reaches the host disk except the runner's captured
 * stdout/stderr.
 *
 * OFF BY DEFAULT, and gated twice: a job runs in a container only when the call (or
 * CLAUDE_ASYNC_JOB_SANDBOX) asks for it AND CLAUDE_ASYNC_ALLOWED_SANDBOXES permits it (default
 * "host" only). Host jobs (Windows-admin work: scheduled tasks, services, firewall checks) keep
 * today's argv, env and spec byte-for-byte.
 *
 * This module builds and validates argv and config, and runs the small docker housekeeping
 * commands (image inspect, list/remove this job's containers). It never runs `docker run` itself
 * (job-runner.mjs does). Secret VALUES are read in exactly one place, readEnvFileSecretValues(),
 * and only so the runner and checkJob() can redact them from what leaves the host; checkEnvFile()
 * returns key names only. Docker reads the env file itself (--env-file).
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./scripts/publish-branch.mjs";

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));

export const SANDBOX_MODES = Object.freeze(["host", "container"]);
export const CONTAINER_NAME_PREFIX = "claude-async-";
export const CONTAINER_JOB_LABEL = "claude-async.job";
// Fixed paths INSIDE the image (container/Dockerfile creates the user, directories and entrypoint).
export const CONTAINER_USER = "1000:1000";                       // the image's non-root "agent" user
export const CONTAINER_HOME = "/home/agent";
export const CONTAINER_WORKDIR = "/workspace";                   // container-local; the clone lives here
export const CONTAINER_CLAUDE_MD = `${CONTAINER_HOME}/.claude/CLAUDE.md`; // user-level memory file
export const CONTAINER_HOOKS_DIR = "/opt/claude-async/hooks";
export const CONTAINER_ENTRYPOINT = "/usr/local/bin/claude-async-job-entry"; // container/job-entry.sh
// The image's node, by absolute path: the hook command must not depend on the job's PATH.
export const CONTAINER_NODE = "/usr/local/bin/node";
// Inline MCP config: the host's empty-mcp.json path does not exist inside the container, and the
// CLI's --mcp-config accepts a JSON string as well as a file path.
export const EMPTY_MCP_INLINE = JSON.stringify({ mcpServers: {} });
// job-entry.sh's exit codes for its own failures (anything else is the CLI's).
export const ENTRY_EXIT_USAGE = 64;
export const ENTRY_EXIT_CLONE = 70;
export const ENTRY_EXIT_CONFIG = 78;

// The only keys the host secrets env file may hold. Anything else (notably ANTHROPIC_API_KEY,
// which would silently switch the job from Erick's subscription to API billing -- it outranks
// CLAUDE_CODE_OAUTH_TOKEN in Claude Code's auth precedence) is refused before the job starts.
export const ENV_FILE_ALLOWED_KEYS = Object.freeze(["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
export const ENV_FILE_REQUIRED_KEYS = Object.freeze(["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
const ENV_FILE_MAX_BYTES = 64 * 1024;

// Non-secret job env that is forwarded into the container as explicit -e NAME=value pairs. An
// allowlist, not "everything in extraEnv": the docker CLI process itself runs with the host env
// (HERMES_HOME, PATH, ...), and none of that belongs inside the sandbox.
export const FORWARDED_ENV_KEYS = Object.freeze([
  "CLAUDE_ASYNC_DEPTH", "CLAUDE_ASYNC_JOB_EFFORT", "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "BASH_MAX_TIMEOUT_MS",
]);
// Belt to the allowlist above: a forwarded name that looks like a credential is refused even if
// someone adds it to the list by mistake. Secrets travel only through --env-file.
const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE|CREDENTIAL)/i;

export const DEFAULT_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000; // 4h
const DEFAULTS = Object.freeze({
  dockerBin: "docker",
  image: "claude-async-job:local",
  cpus: "4",
  memory: "8g",
  pidsLimit: "1024",
  network: "bridge",
  ollamaUrl: "http://host.docker.internal:11434",
  httpBridgePort: 7842,
});

const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
export const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const CPUS_RE = /^(?:\d{1,3})(?:\.\d{1,2})?$/;
const MEMORY_RE = /^\d{1,6}[kmg]?$/i;
const PIDS_RE = /^\d{2,6}$/;
const EMAIL_RE = /^[^\s<>@"]+@[^\s<>@"]+$/;
const HTTP_URL_RE = /^http:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;
// GitHub: owner 1-39 chars of [A-Za-z0-9-], not starting with "-"; repo name [A-Za-z0-9._-]{1,100}.
// The same pattern is re-checked inside the container by job-entry.sh.
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
// A branch, tag or commit to start from. Conservative: no leading "-" (never an option), no "..",
// no "@{", no trailing "/" or ".lock", only [A-Za-z0-9._/-]. Re-checked by job-entry.sh.
const BASE_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// ------------------------------------------------------------------------------ selection ---

// CLAUDE_ASYNC_ALLOWED_SANDBOXES: which modes this host will run at all. Default "host" (container
// mode must be switched on explicitly); "container" alone disables host jobs; "host,container"
// allows both. Returns { allowed } or { error } (an unknown value fails closed: no mode allowed).
export function parseAllowedSandboxes(value) {
  if (value === undefined || value === null || String(value).trim() === "") return { allowed: ["host"] };
  const parts = String(value).split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !SANDBOX_MODES.includes(p));
  if (bad.length || parts.length === 0) {
    return { error: `CLAUDE_ASYNC_ALLOWED_SANDBOXES ${JSON.stringify(value)} is invalid (use host, container, or host,container)` };
  }
  return { allowed: [...new Set(parts)] };
}

// Which sandbox a job gets. `requested` is claude_start's optional `sandbox` param; `envDefault`
// is CLAUDE_ASYNC_JOB_SANDBOX; `allowedValue` is CLAUDE_ASYNC_ALLOWED_SANDBOXES. Only the exact
// string "container" turns the env default on (the same "exact value or it's off" convention as
// CLAUDE_ASYNC_JOB_TOOL_GATE / _SAFE_PERMISSIONS). The chosen mode -- requested or defaulted -- must
// be in the allowed list, so a caller can neither escape a container-only host with
// sandbox:"host" nor reach skip-permissions on a host-only host with sandbox:"container".
// Returns { mode } or { error }.
export function resolveSandbox(requested, envDefault = process.env.CLAUDE_ASYNC_JOB_SANDBOX,
                               allowedValue = process.env.CLAUDE_ASYNC_ALLOWED_SANDBOXES) {
  let mode;
  if (requested === undefined || requested === null || requested === "") {
    mode = envDefault === "container" ? "container" : "host";
  } else if (!SANDBOX_MODES.includes(requested)) {
    return { error: `invalid sandbox ${JSON.stringify(requested)} (expected one of: ${SANDBOX_MODES.join(", ")})` };
  } else {
    mode = requested;
  }
  const pol = parseAllowedSandboxes(allowedValue);
  if (pol.error) return { error: pol.error };
  if (!pol.allowed.includes(mode)) {
    return { error: `sandbox ${JSON.stringify(mode)} is not allowed on this host (CLAUDE_ASYNC_ALLOWED_SANDBOXES=${pol.allowed.join(",")})` };
  }
  return { mode };
}

export function containerName(jobId) {
  return `${CONTAINER_NAME_PREFIX}${jobId}`;
}

// ------------------------------------------------------------------------------- config ---

// CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS: owner/repo entries separated by commas, semicolons or
// whitespace. Compared case-insensitively (GitHub names are). Unset/empty = no repo allowed.
export function parseAllowedRepos(value) {
  const entries = String(value || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return { repos: entries.filter((e) => REPO_RE.test(e) && !/\/\.{1,2}$/.test(e)),
           invalid: entries.filter((e) => !REPO_RE.test(e) || /\/\.{1,2}$/.test(e)) };
}

// Read once per startJob() from the bridge's env. Nothing here is a secret: envFile is a PATH.
export function loadContainerConfig(env = process.env) {
  const ar = parseAllowedRepos(env.CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS);
  return {
    dockerBin: env.CLAUDE_ASYNC_DOCKER_BIN || DEFAULTS.dockerBin,
    image: env.CLAUDE_ASYNC_CONTAINER_IMAGE || DEFAULTS.image,
    envFile: env.CLAUDE_ASYNC_CONTAINER_ENV_FILE || null,
    claudeMd: env.CLAUDE_ASYNC_CONTAINER_CLAUDE_MD || path.join(REPO_DIR, "container", "CLAUDE.md"),
    hooksDir: path.join(REPO_DIR, "hooks"),
    // REQUIRED, no default: the GitHub repos a container job may clone. Keep it to repos the bot is
    // a collaborator on and that jobs should push to.
    allowedRepos: ar.repos,
    allowedReposInvalid: ar.invalid,
    cpus: env.CLAUDE_ASYNC_CONTAINER_CPUS || DEFAULTS.cpus,
    memory: env.CLAUDE_ASYNC_CONTAINER_MEMORY || DEFAULTS.memory,
    pidsLimit: env.CLAUDE_ASYNC_CONTAINER_PIDS_LIMIT || DEFAULTS.pidsLimit,
    network: env.CLAUDE_ASYNC_CONTAINER_NETWORK || DEFAULTS.network,
    gitName: env.CLAUDE_ASYNC_CONTAINER_GIT_NAME || null,
    gitEmail: env.CLAUDE_ASYNC_CONTAINER_GIT_EMAIL || null,
    ollamaUrl: env.CLAUDE_ASYNC_CONTAINER_OLLAMA_URL || DEFAULTS.ollamaUrl,
    // Wall-clock ceiling the runner enforces (the heartbeat never goes stale while the runner is
    // alive, so CLAUDE_ASYNC_JOB_TIMEOUT_MS alone would never stop a hung container).
    maxRuntimeMs: env.CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS !== undefined && env.CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS !== ""
      ? Number(env.CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS) : DEFAULT_MAX_RUNTIME_MS,
    // Phase 2 egress allowlist (docs/container-jobs.md): an HTTP proxy reachable on the job network.
    egressProxy: env.CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY || null,
    // The loopback HTTP MCP bridge (claude-async-http.mjs). Container mode refuses to start unless
    // it is token-locked; see checkHttpBridgeLocked().
    httpBridgePort: Number(env.CLAUDE_ASYNC_HTTP_PORT || DEFAULTS.httpBridgePort),
    httpBridgeConfig: httpBridgeConfigPath(env),
  };
}

// Returns a list of problems (empty = fine) with the non-path settings.
export function validateContainerConfig(cfg) {
  const errs = [];
  if (!IMAGE_RE.test(cfg.image || "")) errs.push(`CLAUDE_ASYNC_CONTAINER_IMAGE ${JSON.stringify(cfg.image)} is not a valid image reference`);
  if (!NETWORK_RE.test(cfg.network || "")) errs.push(`CLAUDE_ASYNC_CONTAINER_NETWORK ${JSON.stringify(cfg.network)} is not a valid network name`);
  else if (["host", "none"].includes(cfg.network.toLowerCase())) {
    // host: the container would share the host's network namespace (every loopback service).
    // none: no route to GitHub or Anthropic.
    errs.push(`CLAUDE_ASYNC_CONTAINER_NETWORK must not be ${JSON.stringify(cfg.network)}`);
  }
  if (!CPUS_RE.test(cfg.cpus || "") || Number(cfg.cpus) <= 0) errs.push(`CLAUDE_ASYNC_CONTAINER_CPUS ${JSON.stringify(cfg.cpus)} must be a positive number like 4 or 2.5`);
  if (!MEMORY_RE.test(cfg.memory || "")) errs.push(`CLAUDE_ASYNC_CONTAINER_MEMORY ${JSON.stringify(cfg.memory)} must look like 8g / 4096m`);
  if (!PIDS_RE.test(cfg.pidsLimit || "") || Number(cfg.pidsLimit) < 64) errs.push(`CLAUDE_ASYNC_CONTAINER_PIDS_LIMIT ${JSON.stringify(cfg.pidsLimit)} must be an integer >= 64`);
  if (!cfg.gitName || CONTROL_RE.test(cfg.gitName) || cfg.gitName.length > 100) {
    errs.push("CLAUDE_ASYNC_CONTAINER_GIT_NAME (the bot account's commit name) must be set, at most 100 characters, no control characters");
  }
  if (!cfg.gitEmail || !EMAIL_RE.test(cfg.gitEmail) || cfg.gitEmail.length > 200) {
    errs.push("CLAUDE_ASYNC_CONTAINER_GIT_EMAIL (the bot account's commit email, e.g. <id>+<login>@users.noreply.github.com) must be set to a plain address");
  }
  if (!HTTP_URL_RE.test(cfg.ollamaUrl || "")) errs.push(`CLAUDE_ASYNC_CONTAINER_OLLAMA_URL ${JSON.stringify(cfg.ollamaUrl)} must be a plain http://host:port URL`);
  if (cfg.egressProxy !== null && cfg.egressProxy !== undefined && !HTTP_URL_RE.test(cfg.egressProxy)) {
    errs.push(`CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY ${JSON.stringify(cfg.egressProxy)} must be a plain http://host:port URL`);
  }
  if (!Number.isInteger(cfg.maxRuntimeMs) || cfg.maxRuntimeMs < 60_000 || cfg.maxRuntimeMs > 7 * 24 * 3600_000) {
    errs.push(`CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS ${JSON.stringify(cfg.maxRuntimeMs)} must be an integer between 60000 and 604800000`);
  }
  if ((cfg.allowedReposInvalid || []).length) {
    errs.push(`CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS has invalid entries: ${cfg.allowedReposInvalid.map((e) => JSON.stringify(e)).join(", ")} (use owner/repo)`);
  }
  return errs;
}

// ------------------------------------------------------------------------- repo + base ref ---

// Returns { repo } (as the caller spelled it, after the allowlist matched case-insensitively) or
// { error }. There is no default allowlist: unset means every container job is refused.
export function validateRepo(repo, allowedRepos) {
  if (typeof repo !== "string" || repo === "") return { error: "repo (\"owner/repo\") is required for a container job" };
  if (!REPO_RE.test(repo) || /\/\.{1,2}$/.test(repo)) return { error: `repo ${JSON.stringify(repo)} is not a GitHub owner/repo name` };
  if (!allowedRepos || allowedRepos.length === 0) {
    return { error: "no container repos are allowed on this host (set CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS); refusing" };
  }
  if (!allowedRepos.some((a) => a.toLowerCase() === repo.toLowerCase())) {
    return { error: `repo ${repo} is not in CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS` };
  }
  return { repo };
}

export function validateBaseRef(ref) {
  if (ref === undefined || ref === null || ref === "") return { ref: "" };
  if (typeof ref !== "string" || !BASE_REF_RE.test(ref) || ref.includes("..") || ref.includes("@{") ||
      ref.endsWith("/") || ref.endsWith(".lock") || ref.includes("//")) {
    return { error: `baseRef ${JSON.stringify(ref)} is not a plain branch, tag or commit name` };
  }
  return { ref };
}

// --------------------------------------------------------------------------- secrets file ---

export function stripLongPathPrefix(r) {
  return typeof r === "string" && r.startsWith("\\\\?\\") && !r.startsWith("\\\\?\\UNC\\") ? r.slice(4) : r;
}
function defaultRealpath(p) {
  return stripLongPathPrefix(fs.realpathSync.native(p));
}

// Docker's --env-file parser keeps everything after the first "=" literally: quotes, a trailing
// " # comment", surrounding spaces. Neither token ever contains whitespace or quotes, so any of
// those means the file is wrong (the job would fail auth with a confusing error at run time).
function badEnvValue(v) {
  if (v === "") return "is empty";
  if (/^\s|\s$/.test(v)) return "has leading or trailing whitespace";
  if (/["'`]/.test(v)) return "contains a quote character (docker --env-file does not strip quotes)";
  if (/\s/.test(v)) return "contains whitespace (a trailing # comment is not stripped by docker either)";
  if (CONTROL_RE.test(v)) return "contains a control character";
  return null;
}

// Parses the env file's text. Returns { entries: [[key, value]] } or { error } (error text never
// carries a value).
function parseEnvFileText(text, real) {
  if (text.includes("\r")) return { error: `container env file ${real} has CR characters (CRLF line endings); docker would keep them in the values. Rewrite it with LF endings` };
  const entries = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `container env file ${real} line ${i + 1} is not KEY=value (a bare KEY would copy the host's own value of that variable into the container)` };
    const key = line.slice(0, eq);
    if (!ENV_FILE_ALLOWED_KEYS.includes(key)) return { error: `container env file ${real} line ${i + 1}: key ${JSON.stringify(key)} is not allowed (allowed: ${ENV_FILE_ALLOWED_KEYS.join(", ")})` };
    if (entries.some(([k]) => k === key)) return { error: `container env file ${real}: key ${key} appears twice` };
    const bad = badEnvValue(line.slice(eq + 1));
    if (bad) return { error: `container env file ${real}: the value of ${key} ${bad}` };
    entries.push([key, line.slice(eq + 1)]);
  }
  return { entries };
}

function readEnvFileBytes(envFile, realpath) {
  let real;
  try { real = realpath(envFile); } catch { return { error: `container env file ${envFile} does not exist` }; }
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: `container env file ${real} is not a regular file` };
    if (st.size > ENV_FILE_MAX_BYTES) return { error: `container env file ${real} is larger than ${ENV_FILE_MAX_BYTES} bytes` };
    return { real, buf: fs.readFileSync(real) };
  } catch (e) { return { error: `container env file ${real} is not readable (${e.code || "error"})` }; }
}

// Reads the secrets env file ONLY to check its shape. Returns { keys, real } (names only) or
// { error }. Never returns, logs or throws a value. Docker parses the file itself at `docker run`
// time. forbidInside: folders the file must not be in (the claude-async checkout, so it can never
// be committed or reach the read-only hooks mount).
export function checkEnvFile(envFile, { forbidInside = [], platform = process.platform, realpath = defaultRealpath } = {}) {
  if (!envFile) return { error: "CLAUDE_ASYNC_CONTAINER_ENV_FILE is not set (the host secrets file holding GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN)" };
  const rd = readEnvFileBytes(envFile, realpath);
  if (rd.error) return { error: rd.error };
  for (const root of forbidInside) {
    let r; try { r = realpath(root); } catch { continue; }
    if (isInside(r, rd.real, platform) || r === rd.real) return { error: `container env file ${rd.real} is inside ${r}; keep secrets outside the claude-async checkout` };
  }
  const buf = rd.buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { error: `container env file ${rd.real} starts with a UTF-8 BOM, which docker would make part of the first key name; rewrite it without a BOM` };
  }
  const parsed = parseEnvFileText(buf.toString("utf8"), rd.real);
  if (parsed.error) return { error: parsed.error };
  const keys = parsed.entries.map(([k]) => k);
  const missing = ENV_FILE_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length) return { error: `container env file ${rd.real} is missing ${missing.join(", ")}` };
  return { keys, real: rd.real };
}

// The ONE function that returns secret values: the runner and checkJob() use them, in memory only,
// to redact job output before it leaves the host (exit.json tails, the Discord ping, claude_check).
// Returns [] on any problem (redaction then falls back to the token-shape patterns alone).
export function readEnvFileSecretValues(envFile, { realpath = defaultRealpath } = {}) {
  if (!envFile) return [];
  const rd = readEnvFileBytes(envFile, realpath);
  if (rd.error) return [];
  let text = rd.buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const parsed = parseEnvFileText(text.replace(/\r/g, ""), rd.real);
  if (parsed.error) return [];
  const raw = parsed.entries.map(([, v]) => v).filter((v) => v.length >= 8);
  // Plus the encodings git itself prints: GIT_TRACE_CURL / GIT_CURL_VERBOSE log the Basic header the
  // credential helper produces, base64("x-access-token:<GH_TOKEN>"), and a job can base64 a value
  // in one line. Trailing "=" padding is stripped so a prefix match still covers the padded form.
  const b64 = (v) => Buffer.from(v, "utf8").toString("base64").replace(/=+$/, "");
  const encoded = raw.flatMap((v) => [b64(`x-access-token:${v}`), b64(v)]);
  return [...raw, ...encoded.filter((v) => v.length >= 8 && !raw.includes(v))];
}

// --------------------------------------------------------------------------------- redaction ---

// Token shapes redacted even when the env file can't be read: GitHub classic/OAuth/app/user/refresh
// tokens and fine-grained PATs, and Anthropic keys/OAuth tokens (sk-ant-...). No leading \b: in JS
// "_" and alphanumerics are word characters, so \b would skip TOKEN_ghp_... and x9ghp_... entirely.
// A false positive costs a few redacted letters; a false negative costs a credential.
export const SECRET_PATTERNS = Object.freeze([
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
]);
export const REDACTED = "[REDACTED]";

export function redactSecrets(text, values = []) {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  for (const v of values) if (typeof v === "string" && v.length >= 8) out = out.split(v).join(REDACTED);
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

// The tail of a log file for a caller-visible window of `tailBytes`, redacted BEFORE the window is
// cut, so a window that starts in the middle of a token can't return a reconstructable suffix
// (round-2 finding A3). Reads tailBytes plus a margin (at least REDACT_TAIL_MARGIN, and at least
// twice the longest known value), redacts that, drops the possibly partial first line of a window
// that did not start at byte 0 (or, when no newline falls in the margin, the whole margin, which is
// longer than any secret we know), and only then keeps the last tailBytes characters. Host jobs
// never come through here (their tails are unchanged).
export const REDACT_TAIL_MARGIN = 512;
export function readRedactedTail(file, tailBytes, values = []) {
  if (!(tailBytes > 0)) return "";
  let fd;
  try {
    const size = fs.statSync(file).size;
    const longest = values.reduce((m, v) => Math.max(m, typeof v === "string" ? v.length : 0), 0);
    const margin = Math.max(REDACT_TAIL_MARGIN, 2 * longest + 64);
    const start = Math.max(0, size - (tailBytes + margin));
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    let text = redactSecrets(buf.toString("utf8"), values);
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl !== -1 && nl < margin ? text.slice(nl + 1) : text.slice(margin);
    }
    if (text.length > tailBytes) return `…(earlier output omitted)\n${text.slice(-tailBytes)}`;
    return start > 0 ? `…(earlier output omitted)\n${text}` : text;
  } catch { return ""; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

// --------------------------------------------------------------------------- host paths ---

// Host path -> the `source=` value of a --mount flag (only the two read-only mounts use this now).
// Docker Desktop accepts D:/code/x for a Windows drive path; forward slashes avoid every
// backslash-escaping question. --mount is a CSV field list, so a comma or quote in a path would
// split or quote it: such paths are refused rather than escaped. UNC/network paths are refused.
export function toDockerMountSource(p, platform = process.platform) {
  if (typeof p !== "string" || p === "") return { error: "empty path" };
  if (/[,"]/.test(p) || CONTROL_RE.test(p)) return { error: `path ${JSON.stringify(p)} contains a comma, quote or control character, which --mount cannot carry safely` };
  if (platform === "win32") {
    if (/^[\\/]{2}/.test(p)) return { error: `UNC/network path ${JSON.stringify(p)} cannot be bind-mounted; use a local drive path` };
    if (!/^[A-Za-z]:[\\/]/.test(p)) return { error: `path ${JSON.stringify(p)} is not an absolute drive path` };
    return { source: p.replace(/\\/g, "/") };
  }
  if (!path.posix.isAbsolute(p)) return { error: `path ${JSON.stringify(p)} is not absolute` };
  return { source: p };
}

function statKind(p, fsImpl) {
  try { const st = fsImpl.statSync(p); return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"; } catch { return null; }
}

// Validates everything a container job needs on the host, before the job dir exists. Returns
// { plan } or { error }. resolveBin is job-core's resolveBinary(). workFolder must be absent: a
// container job never runs in (or mounts) a host folder.
export function planContainerJob({ jobId, repo, baseRef, workFolder, cfg, platform = process.platform, resolveBin,
                                   realpath = defaultRealpath, fsImpl = fs }) {
  if (workFolder !== undefined && workFolder !== null && workFolder !== "") {
    return { error: "container jobs do not take workFolder (no host folder is mounted); pass repo (\"owner/repo\") and optionally baseRef instead" };
  }
  const cfgErrs = validateContainerConfig(cfg);
  if (cfgErrs.length) return { error: `container mode misconfigured: ${cfgErrs.join("; ")}` };
  const rv = validateRepo(repo, cfg.allowedRepos);
  if (rv.error) return { error: rv.error };
  const bv = validateBaseRef(baseRef);
  if (bv.error) return { error: bv.error };
  const dockerBin = resolveBin ? resolveBin(cfg.dockerBin) : cfg.dockerBin;
  if (!dockerBin) return { error: `docker binary ${JSON.stringify(cfg.dockerBin)} not found (set CLAUDE_ASYNC_DOCKER_BIN to docker.exe's full path)` };
  const ef = checkEnvFile(cfg.envFile, { forbidInside: [REPO_DIR], platform, realpath });
  if (ef.error) return { error: ef.error };
  const rp = (p) => { try { return realpath(p); } catch { return null; } };
  const mdReal = rp(cfg.claudeMd);
  if (!mdReal || statKind(mdReal, fsImpl) !== "file") return { error: `container CLAUDE.md ${cfg.claudeMd} does not exist` };
  const hooksReal = rp(cfg.hooksDir);
  if (!hooksReal || statKind(hooksReal, fsImpl) !== "dir") return { error: `hooks dir ${cfg.hooksDir} does not exist` };
  const mounts = {};
  for (const [k, p] of [["claudeMd", mdReal], ["hooks", hooksReal]]) {
    const m = toDockerMountSource(p, platform);
    if (m.error) return { error: `cannot mount ${k}: ${m.error}` };
    mounts[k] = m.source;
  }
  return { plan: { jobId, name: containerName(jobId), dockerBin, image: cfg.image, imageId: null, envFile: ef.real,
                   envFileKeys: ef.keys, repo: rv.repo, baseRef: bv.ref, mounts, cfg } };
}

// ------------------------------------------------------------------------------- argv ---

// The --settings object for the CLI INSIDE the container: the same catch-all no-background hook
// job-core.mjs wires for host jobs (buildNoBackgroundHookSettings), run by the image's node at an
// absolute path with NODE_OPTIONS removed, so neither a PATH entry nor NODE_OPTIONS (--require /
// --import) the job sets can replace or pre-empt the hook. This is a RELIABILITY guard (it keeps
// jobs from backgrounding work), not a security boundary: the job already runs arbitrary code in
// its own container. The job-tool-gate and Ollama-guard hooks are host-only.
export function buildContainerSettings({ ultracode = false } = {}) {
  const s = {
    hooks: {
      PreToolUse: [{
        matcher: "*",
        hooks: [{ type: "command", command: `env -u NODE_OPTIONS ${CONTAINER_NODE} ${CONTAINER_HOOKS_DIR}/no-background-hook.mjs`, timeout: 5 }],
      }],
    },
  };
  if (ultracode) s.ultracode = true;
  return s;
}

// The CLI argv inside the container. --dangerously-skip-permissions is deliberate: the container is
// the permission boundary (docs/container-jobs.md, "Why skip-permissions inside").
// --setting-sources user: the CLI loads ONLY user settings (~/.claude/settings.json, which the image
// makes unwritable) plus --settings, never the cloned repo's .claude/settings.json or
// settings.local.json, so a hostile repo can't set env (ANTHROPIC_BASE_URL), an apiKeyHelper or
// hooks that run before the model ever sees the prompt. --strict-mcp-config with an empty inline
// config ignores the repo's .mcp.json. The prompt goes last, after "--", and the model is bound
// with "=", so neither can ever be parsed as a CLI option.
export function buildContainerCliArgv({ prompt, model, effortArgv = [], settings }) {
  return ["-p", "--dangerously-skip-permissions", "--setting-sources", "user",
          "--strict-mcp-config", "--mcp-config", EMPTY_MCP_INLINE,
          `--model=${model}`, ...effortArgv, "--settings", JSON.stringify(settings), "--", prompt];
}

// -e NAME=value pairs for the container: the allowlisted job env, git identity, the repo, Ollama,
// and (phase 2) the egress proxy. Never secrets (those come from --env-file), never a bare -e NAME
// (which would copy the docker CLI process's own host value in).
export function buildContainerEnv({ extraEnv = {}, cfg, jobId, repo = null, baseRef = "" }) {
  const env = [];
  const add = (k, v) => {
    if (SECRET_NAME_RE.test(k)) throw new Error(`refusing to pass ${k} on the docker command line; secrets go through --env-file`);
    if (v === undefined || v === null) return;
    env.push([k, String(v)]);
  };
  add("CLAUDE_ASYNC_JOB_ID", jobId);
  add("CLAUDE_ASYNC_SANDBOX", "container");
  if (repo) add("CLAUDE_ASYNC_REPO", repo);
  if (baseRef) add("CLAUDE_ASYNC_BASE_REF", baseRef);
  for (const k of FORWARDED_ENV_KEYS) if (extraEnv[k] !== undefined) add(k, extraEnv[k]);
  // Commits are the bot's.
  add("GIT_AUTHOR_NAME", cfg.gitName); add("GIT_COMMITTER_NAME", cfg.gitName);
  add("GIT_AUTHOR_EMAIL", cfg.gitEmail); add("GIT_COMMITTER_EMAIL", cfg.gitEmail);
  add("OLLAMA_HOST", cfg.ollamaUrl);
  add("CLAUDE_ASYNC_OLLAMA_URL", cfg.ollamaUrl);
  if (cfg.egressProxy) {
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) add(k, cfg.egressProxy);
    add("NO_PROXY", "localhost,127.0.0.1"); add("no_proxy", "localhost,127.0.0.1");
  }
  return env;
}

// The full `docker run` argv (without the docker binary itself). Every value is a separate array
// element; nothing is ever joined into a shell string.
export function buildDockerRunArgv({ plan, cliArgv, extraEnv = {} }) {
  const { cfg, mounts, name, jobId } = plan;
  // docker refuses --cpus above the CPUs the daemon's VM has (Docker Desktop's WSL2 VM may have
  // fewer than the host), so the configured value is a ceiling, clamped to what the host reports.
  const hostCpus = plan.hostCpus || os.availableParallelism?.() || os.cpus().length || 1;
  const cpus = String(Math.min(Number(cfg.cpus), hostCpus));
  // The image runs by the immutable ID the preflight inspected, never by tag, and never pulls: a
  // tag retargeted (or removed) between preflight and launch cannot change what runs, and a missing
  // image fails the run (exit 125) instead of fetching a same-named one from a registry.
  const image = plan.imageId || plan.image;
  const argv = [
    "run", "--rm", "--pull=never", "--name", name, "--label", `${CONTAINER_JOB_LABEL}=${jobId}`,
    "--init",                                   // PID 1 reaps the CLI's children and forwards signals
    "--user", CONTAINER_USER,
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--cpus", cpus, "--memory", cfg.memory, "--memory-swap", cfg.memory, "--pids-limit", cfg.pidsLimit,
    "--network", cfg.network,
  ];
  // Phase 1 reaches host Ollama through the host gateway. Phase 2 (egress proxy on an internal
  // network) has no route to the host except through the proxy, so the gateway name is not added.
  if (!cfg.egressProxy) argv.push("--add-host", "host.docker.internal:host-gateway");
  argv.push("--env-file", plan.envFile);
  for (const [k, v] of buildContainerEnv({ extraEnv, cfg, jobId, repo: plan.repo, baseRef: plan.baseRef })) argv.push("-e", `${k}=${v}`);
  argv.push(
    "--mount", `type=bind,source=${mounts.claudeMd},target=${CONTAINER_CLAUDE_MD},readonly`,
    "--mount", `type=bind,source=${mounts.hooks},target=${CONTAINER_HOOKS_DIR},readonly`,
    "--workdir", CONTAINER_WORKDIR,
    image,
    CONTAINER_ENTRYPOINT, plan.repo, plan.baseRef || "", "--",
    "claude", ...cliArgv,
  );
  return argv;
}

// Preflight: is the daemon up and the image present locally? Returns { imageId } (the immutable
// sha256 ID the job will run) or { error }. A job never pulls: the image is built on claunker from
// container/Dockerfile, and pulling a same-named image would run someone else's code with the job's
// secrets.
export function checkDockerImage({ dockerBin, image, spawnSync = nodeSpawnSync, timeoutMs = 20_000 }) {
  let r;
  try { r = spawnSync(dockerBin, ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }); }
  catch (e) { return { error: `could not run ${dockerBin}: ${e.message}` }; }
  if (r.error) return { error: `could not run ${dockerBin}: ${r.error.message}` };
  if (r.status !== 0) {
    const err = String(r.stderr || "").trim().slice(0, 300);
    if (/no such image|not found/i.test(err)) return { error: `docker image ${image} is not built on this host (see docs/container-jobs.md, "Build the image")` };
    return { error: `docker is not usable (is Docker Desktop running?): ${err || `exit ${r.status}`}` };
  }
  const imageId = String(r.stdout || "").trim();
  if (!IMAGE_ID_RE.test(imageId)) return { error: `docker image inspect returned an unexpected image ID ${JSON.stringify(imageId.slice(0, 80))}` };
  return { ok: true, imageId };
}

// ------------------------------------------------------------- container cleanup (by label) ---

// Every container a job owns carries the label claude-async.job=<jobId> (job ids are unique per
// job dir, so the label is too). Cleanup lists by that exact label and removes by immutable
// container ID with `docker rm -f`, which kills a running container AND removes one still in the
// Created state (a launch that `docker kill` would miss). A container merely NAMED like ours but
// without the label is never touched.
export function buildListArgv(jobId) {
  return ["ps", "-a", "--no-trunc", "--filter", `label=${CONTAINER_JOB_LABEL}=${jobId}`,
          "--format", `{{.ID}}\t{{.State}}\t{{.Label "${CONTAINER_JOB_LABEL}"}}`];
}

export function listJobContainers({ dockerBin, jobId, spawnSync = nodeSpawnSync, timeoutMs = 15_000 }) {
  let r;
  try { r = spawnSync(dockerBin, buildListArgv(jobId), { encoding: "utf8", timeout: timeoutMs, windowsHide: true }); }
  catch (e) { return { error: e.message }; }
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) return { error: String(r.stderr || "").trim().slice(0, 300) || `docker ps exited ${r.status}` };
  const containers = [];
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, state, label] = line.split("\t");
    if (!CONTAINER_ID_RE.test(id || "")) return { error: `docker ps returned an unexpected line ${JSON.stringify(line.slice(0, 120))}` };
    if (label !== jobId) continue; // belt: the filter is exact, but never act on another job's container
    containers.push({ id, state: state || "unknown" });
  }
  return { containers };
}

// Removes every container this job owns, then lists again. Returns
//   { ok: true, absent: true|false, removed, remaining }  -- absent: nothing with our label exists
//   { ok: false, error }                                  -- docker could not be asked
// "absent" alone does not mean cleanup is confirmed: a launch may still be pending (see
// job-core.mjs's container cleanup state).
export function cleanupJobContainers({ dockerBin, jobId, spawnSync = nodeSpawnSync, timeoutMs = 15_000 }) {
  const before = listJobContainers({ dockerBin, jobId, spawnSync, timeoutMs });
  if (before.error) return { ok: false, error: before.error };
  let removed = 0;
  const errors = [];
  for (const c of before.containers) {
    let r;
    try { r = spawnSync(dockerBin, ["rm", "-f", c.id], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }); }
    catch (e) { errors.push(e.message); continue; }
    if (r.error) { errors.push(r.error.message); continue; }
    if (r.status === 0 || /no such container/i.test(String(r.stderr || ""))) removed++;
    else errors.push(String(r.stderr || "").trim().slice(0, 200) || `docker rm exited ${r.status}`);
  }
  const after = before.containers.length ? listJobContainers({ dockerBin, jobId, spawnSync, timeoutMs }) : { containers: [] };
  if (after.error) return { ok: false, error: after.error, removed };
  return { ok: true, absent: after.containers.length === 0, removed, remaining: after.containers,
           ...(errors.length ? { errors } : {}) };
}

// ----------------------------------------------------------------------- stdout: PR URL ---

// The PR URL the job reported, if it names the job's own repo (or a fork's PR against it shows the
// upstream URL, which is the same thing). Read off stdout by the runner; the card hook no longer
// runs host git for container jobs, so this is how claude_check shows what was delivered.
export function extractPrUrl(lines, repo) {
  if (!repo || !Array.isArray(lines)) return null;
  const want = `https://github.com/${repo}/pull/`.toLowerCase();
  let found = null;
  for (const l of lines) {
    for (const m of String(l).matchAll(/https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+/g)) {
      if (m[0].toLowerCase().startsWith(want)) found = m[0];
    }
  }
  return found;
}

// ------------------------------------------------------------------ host loopback bridge ---

// claude-async-http.mjs (the loopback HTTP MCP bridge, 127.0.0.1:7842) can start sandbox:"host"
// jobs, and Docker Desktop forwards host.docker.internal to the Windows host's 127.0.0.1 -- the
// same path that makes host Ollama reachable. So container mode refuses to start unless the bridge
// is token-locked: its config file holds a token hash (the bridge then refuses unauthenticated
// requests, from the next time it starts), AND whatever is listening on the port right now answers
// an unauthenticated MCP request with 401. Fail-closed: no file, a bad file, or any other answer
// refuses.
export function httpBridgeConfigPath(env = process.env) {
  return path.join(env.CLAUDE_ASYNC_CONFIG_DIR || path.join(os.homedir(), ".claude-async"), "http.json");
}

export function readHttpBridgeTokenHash(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const h = j && typeof j === "object" ? String(j.tokenSha256 || "") : "";
    return /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null;
  } catch { return null; }
}

export async function checkHttpBridgeLocked({ port, configFile, host = "127.0.0.1", timeoutMs = 3000,
                                              request = http.request } = {}) {
  if (!readHttpBridgeTokenHash(configFile)) {
    return { error: `the loopback HTTP MCP bridge is not token-locked (${configFile} has no tokenSha256). A container ` +
      `can reach 127.0.0.1:${port} through host.docker.internal and start an unsandboxed host job there. Run ` +
      "`node claude-async-http.mjs --new-token` (and restart the bridge), or see docs/container-jobs.md \"Host loopback services\"" };
  }
  const status = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    let req;
    try {
      req = request({ host, port, method: "POST", path: "/mcp", timeout: timeoutMs,
                      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
                                 "content-length": Buffer.byteLength(body), host: `${host}:${port}` } }, (res) => {
        res.resume();
        done({ status: res.statusCode });
      });
    } catch (e) { done({ error: e.message }); return; }
    req.on("timeout", () => { req.destroy(); done({ error: "timeout" }); });
    req.on("error", (e) => done(e.code === "ECONNREFUSED" ? { refused: true } : { error: e.code || e.message }));
    req.end(body);
  });
  if (status.refused) return { ok: true, listening: false };
  if (status.status === 401) return { ok: true, listening: true };
  return { error: `something on 127.0.0.1:${port} answered an unauthenticated MCP request with ` +
    `${status.status !== undefined ? `HTTP ${status.status}` : status.error}, not 401; restart the HTTP bridge so it ` +
    "enforces its token (or stop it) before running container jobs" };
}
