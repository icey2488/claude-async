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
 * OFF BY DEFAULT. A job runs in a container only when claude_start passes sandbox:"container", or
 * CLAUDE_ASYNC_JOB_SANDBOX is exactly "container" and the call does not pass sandbox:"host".
 * Host jobs (Windows-admin work: scheduled tasks, services, firewall checks) keep today's argv,
 * env and spec byte-for-byte.
 *
 * This module only builds and validates: argv, mounts, config. It never runs `docker run` itself
 * (job-runner.mjs does) and never reads secret VALUES -- the env file is passed to docker by path
 * (--env-file), and checkEnvFile() below reads it only to verify key names and format, returning
 * names, never values.
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside, parseAllowedRoots, findUnsafeConfig } from "./scripts/publish-branch.mjs";

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));

export const SANDBOX_MODES = Object.freeze(["host", "container"]);
export const CONTAINER_NAME_PREFIX = "claude-async-";
// Fixed paths INSIDE the image (container/Dockerfile creates the user and directories).
export const CONTAINER_USER = "1000:1000";                       // the image's non-root "agent" user
export const CONTAINER_HOME = "/home/agent";
export const CONTAINER_WORKDIR = "/workspace";
export const CONTAINER_CLAUDE_MD = `${CONTAINER_HOME}/.claude/CLAUDE.md`; // user-level memory file
export const CONTAINER_HOOKS_DIR = "/opt/claude-async/hooks";
// Inline MCP config: the host's empty-mcp.json path does not exist inside the container, and the
// CLI's --mcp-config accepts a JSON string as well as a file path.
export const EMPTY_MCP_INLINE = JSON.stringify({ mcpServers: {} });

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

const DEFAULTS = Object.freeze({
  dockerBin: "docker",
  image: "claude-async-job:local",
  cpus: "4",
  memory: "8g",
  pidsLimit: "1024",
  network: "bridge",
  ollamaUrl: "http://host.docker.internal:11434",
  autocrlf: "true",
});

const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const CPUS_RE = /^(?:\d{1,3})(?:\.\d{1,2})?$/;
const MEMORY_RE = /^\d{1,6}[kmg]?$/i;
const PIDS_RE = /^\d{2,6}$/;
const EMAIL_RE = /^[^\s<>@"]+@[^\s<>@"]+$/;
const HTTP_URL_RE = /^http:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// ------------------------------------------------------------------------------ selection ---

// Which sandbox a job gets. `requested` is claude_start's optional `sandbox` param; `envDefault`
// is CLAUDE_ASYNC_JOB_SANDBOX. Only the exact string "container" turns the env default on (the
// same "exact value or it's off" convention as CLAUDE_ASYNC_JOB_TOOL_GATE / _SAFE_PERMISSIONS);
// an explicit request always wins, in either direction. Returns { mode } or { error }.
export function resolveSandbox(requested, envDefault = process.env.CLAUDE_ASYNC_JOB_SANDBOX) {
  if (requested === undefined || requested === null || requested === "") {
    return { mode: envDefault === "container" ? "container" : "host" };
  }
  if (!SANDBOX_MODES.includes(requested)) {
    return { error: `invalid sandbox ${JSON.stringify(requested)} (expected one of: ${SANDBOX_MODES.join(", ")})` };
  }
  return { mode: requested };
}

export function containerName(jobId) {
  return `${CONTAINER_NAME_PREFIX}${jobId}`;
}

// ------------------------------------------------------------------------------- config ---

// parseAllowedRoots() falls back to D:\code on win32 when its input is empty; here an unset or
// empty value means "no roots", never a default.
function rootList(value, platform) {
  return value && String(value).trim() ? parseAllowedRoots(value, platform) : [];
}

// Read once per startJob() from the bridge's env. Nothing here is a secret: envFile is a PATH.
export function loadContainerConfig(env = process.env, platform = process.platform) {
  return {
    dockerBin: env.CLAUDE_ASYNC_DOCKER_BIN || DEFAULTS.dockerBin,
    image: env.CLAUDE_ASYNC_CONTAINER_IMAGE || DEFAULTS.image,
    envFile: env.CLAUDE_ASYNC_CONTAINER_ENV_FILE || null,
    claudeMd: env.CLAUDE_ASYNC_CONTAINER_CLAUDE_MD || path.join(REPO_DIR, "container", "CLAUDE.md"),
    hooksDir: path.join(REPO_DIR, "hooks"),
    // REQUIRED, no default (unlike publish-branch.mjs's D:\code): the roots a container job's repo
    // may live under. Recommended: a folder of dedicated job clones, not Erick's own working copies.
    allowedRoots: rootList(env.CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS, platform),
    // The claude-async checkout itself is never mountable: a job that could edit it would be editing
    // the code the bridge and runner execute ON THE HOST, unreviewed. Extra denied roots (e.g. the
    // live chassis) use the same separator as the allowed roots.
    deniedRoots: [REPO_DIR, ...rootList(env.CLAUDE_ASYNC_CONTAINER_DENIED_ROOTS, platform)],
    cpus: env.CLAUDE_ASYNC_CONTAINER_CPUS || DEFAULTS.cpus,
    memory: env.CLAUDE_ASYNC_CONTAINER_MEMORY || DEFAULTS.memory,
    pidsLimit: env.CLAUDE_ASYNC_CONTAINER_PIDS_LIMIT || DEFAULTS.pidsLimit,
    network: env.CLAUDE_ASYNC_CONTAINER_NETWORK || DEFAULTS.network,
    gitName: env.CLAUDE_ASYNC_CONTAINER_GIT_NAME || null,
    gitEmail: env.CLAUDE_ASYNC_CONTAINER_GIT_EMAIL || null,
    ollamaUrl: env.CLAUDE_ASYNC_CONTAINER_OLLAMA_URL || DEFAULTS.ollamaUrl,
    autocrlf: env.CLAUDE_ASYNC_CONTAINER_GIT_AUTOCRLF || DEFAULTS.autocrlf,
    // Phase 2 egress allowlist (docs/container-jobs.md): an HTTP proxy reachable on the job network.
    egressProxy: env.CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY || null,
  };
}

// Returns a list of problems (empty = fine) with the non-path settings.
export function validateContainerConfig(cfg) {
  const errs = [];
  if (!IMAGE_RE.test(cfg.image || "")) errs.push(`CLAUDE_ASYNC_CONTAINER_IMAGE ${JSON.stringify(cfg.image)} is not a valid image reference`);
  if (!NETWORK_RE.test(cfg.network || "")) errs.push(`CLAUDE_ASYNC_CONTAINER_NETWORK ${JSON.stringify(cfg.network)} is not a valid network name`);
  else if (["host", "none"].includes(cfg.network.toLowerCase())) {
    // host: the container would share the host's network namespace (every loopback service, incl.
    // this bridge's own unauthenticated 127.0.0.1 HTTP MCP endpoint). none: no route to Anthropic.
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
  if (!["true", "false", "input"].includes(cfg.autocrlf)) errs.push("CLAUDE_ASYNC_CONTAINER_GIT_AUTOCRLF must be true, false or input");
  if (cfg.egressProxy !== null && cfg.egressProxy !== undefined && !HTTP_URL_RE.test(cfg.egressProxy)) {
    errs.push(`CLAUDE_ASYNC_CONTAINER_EGRESS_PROXY ${JSON.stringify(cfg.egressProxy)} must be a plain http://host:port URL`);
  }
  return errs;
}

// ---------------------------------------------------------------------------- host paths ---

// realpath that also resolves Windows junctions (fs.realpathSync.native does; the JS fallback
// does not) and strips a \\?\ long-path prefix so path.win32 math and Docker both see a plain
// drive path.
export function stripLongPathPrefix(r) {
  return typeof r === "string" && r.startsWith("\\\\?\\") && !r.startsWith("\\\\?\\UNC\\") ? r.slice(4) : r;
}
function defaultRealpath(p) {
  return stripLongPathPrefix(fs.realpathSync.native(p));
}

// Host path -> the `source=` value of a --mount flag. Docker Desktop accepts D:/code/x for a
// Windows drive path; forward slashes avoid every backslash-escaping question. --mount is a CSV
// field list, so a comma or quote in a path would split or quote it: such paths are refused rather
// than escaped. UNC/network paths are refused (Docker Desktop file sharing covers local drives).
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

// Validates the job's workFolder for mounting. It must resolve (realpath, so a symlink or junction
// that points elsewhere is judged by its TARGET) strictly inside one allowed root -- not equal to the
// root, which would mount every repo under it -- must not overlap a denied root in either direction,
// and must be a git top-level with a real .git DIRECTORY: a linked worktree's .git file points at a
// git dir outside the mount, so git inside the container would not work. Returns { real } or { error }.
// realpath / fsImpl are test seams (fsImpl: statSync + lstatSync), so the win32 path logic can be
// exercised on any OS.
export function validateWorkFolder(workFolder, { allowedRoots, deniedRoots = [], platform = process.platform,
                                                 realpath = defaultRealpath, fsImpl = fs } = {}) {
  const pm = platform === "win32" ? path.win32 : path.posix;
  if (typeof workFolder !== "string" || !workFolder) return { error: "workFolder is required for a container job" };
  if (!pm.isAbsolute(workFolder)) return { error: `workFolder ${JSON.stringify(workFolder)} must be an absolute path for a container job` };
  const rp = (p) => { try { return realpath(p); } catch { return null; } };
  const roots = (allowedRoots || []).map(rp).filter(Boolean);
  if (roots.length === 0) return { error: "no container allowed roots exist (set CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS); refusing to mount anything" };
  const real = rp(workFolder);
  if (!real) return { error: `workFolder ${JSON.stringify(workFolder)} does not exist` };
  let isDir = false;
  try { isDir = fsImpl.statSync(real).isDirectory(); } catch {}
  if (!isDir) return { error: `workFolder ${JSON.stringify(workFolder)} is not a directory` };
  const inside = roots.find((r) => isInside(r, real, platform));
  if (!inside) return { error: `workFolder ${real} (realpath of ${workFolder}) is outside the container allowed roots (${roots.join(", ")})` };
  const same = (a, b) => (platform === "win32" ? pm.resolve(a).toLowerCase() === pm.resolve(b).toLowerCase() : pm.resolve(a) === pm.resolve(b));
  if (same(inside, real)) return { error: `workFolder ${real} is an allowed root itself; mount a single repo under it, not the whole root` };
  for (const d of (deniedRoots || []).map(rp).filter(Boolean)) {
    if (isInside(d, real, platform) || isInside(real, d, platform)) {
      return { error: `workFolder ${real} overlaps the denied path ${d} (the claude-async checkout, or CLAUDE_ASYNC_CONTAINER_DENIED_ROOTS); use a separate clone` };
    }
  }
  let gitStat = null;
  try { gitStat = fsImpl.lstatSync(pm.join(real, ".git")); } catch {}
  if (!gitStat) return { error: `workFolder ${real} is not a git repository top-level (no .git); container jobs mount exactly one repo` };
  if (!gitStat.isDirectory()) return { error: `workFolder ${real} has a .git FILE (a linked worktree or submodule) whose git dir is outside the mount; use a full clone` };
  return { real };
}

// Reads the secrets env file ONLY to check its shape. Returns { keys } (names only) or { error }.
// Never returns, logs or throws a value. Docker parses the file itself at `docker run` time.
export function checkEnvFile(envFile, { forbidInside = [], platform = process.platform, realpath = defaultRealpath } = {}) {
  if (!envFile) return { error: "CLAUDE_ASYNC_CONTAINER_ENV_FILE is not set (the host secrets file holding GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN)" };
  let real;
  try { real = realpath(envFile); } catch { return { error: `container env file ${envFile} does not exist` }; }
  for (const root of forbidInside) {
    let r; try { r = realpath(root); } catch { continue; }
    if (isInside(r, real, platform)) return { error: `container env file ${real} is inside ${r}; keep secrets outside every repo and allowed root` };
  }
  let buf;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: `container env file ${real} is not a regular file` };
    if (st.size > ENV_FILE_MAX_BYTES) return { error: `container env file ${real} is larger than ${ENV_FILE_MAX_BYTES} bytes` };
    buf = fs.readFileSync(real);
  } catch (e) { return { error: `container env file ${real} is not readable (${e.code || "error"})` }; }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { error: `container env file ${real} starts with a UTF-8 BOM, which docker would make part of the first key name; rewrite it without a BOM` };
  }
  const text = buf.toString("utf8");
  if (text.includes("\r")) return { error: `container env file ${real} has CR characters (CRLF line endings); docker would keep them in the values. Rewrite it with LF endings` };
  const keys = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `container env file ${real} line ${i + 1} is not KEY=value (a bare KEY would copy the host's own value of that variable into the container)` };
    const key = line.slice(0, eq);
    if (!ENV_FILE_ALLOWED_KEYS.includes(key)) return { error: `container env file ${real} line ${i + 1}: key ${JSON.stringify(key)} is not allowed (allowed: ${ENV_FILE_ALLOWED_KEYS.join(", ")})` };
    if (keys.includes(key)) return { error: `container env file ${real}: key ${key} appears twice` };
    if (line.slice(eq + 1).trim() === "") return { error: `container env file ${real}: ${key} is empty` };
    keys.push(key);
  }
  const missing = ENV_FILE_REQUIRED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length) return { error: `container env file ${real} is missing ${missing.join(", ")}` };
  return { keys, real };
}

// Validates everything a container job needs on the host, before the job dir exists. Returns
// { plan } with the resolved paths, or { error }. resolveBin is job-core's resolveBinary().
export function planContainerJob({ jobId, workFolder, cfg, platform = process.platform, resolveBin,
                                   realpath = defaultRealpath }) {
  const cfgErrs = validateContainerConfig(cfg);
  if (cfgErrs.length) return { error: `container mode misconfigured: ${cfgErrs.join("; ")}` };
  const dockerBin = resolveBin ? resolveBin(cfg.dockerBin) : cfg.dockerBin;
  if (!dockerBin) return { error: `docker binary ${JSON.stringify(cfg.dockerBin)} not found (set CLAUDE_ASYNC_DOCKER_BIN to docker.exe's full path)` };
  const wf = validateWorkFolder(workFolder, { allowedRoots: cfg.allowedRoots, deniedRoots: cfg.deniedRoots, platform, realpath });
  if (wf.error) return { error: wf.error };
  const ef = checkEnvFile(cfg.envFile, { forbidInside: [wf.real, ...cfg.allowedRoots], platform, realpath });
  if (ef.error) return { error: ef.error };
  const mdReal = (() => { try { return realpath(cfg.claudeMd); } catch { return null; } })();
  if (!mdReal || !fs.statSync(mdReal).isFile()) return { error: `container CLAUDE.md ${cfg.claudeMd} does not exist` };
  if (isInside(wf.real, mdReal, platform)) return { error: `container CLAUDE.md ${mdReal} is inside the mounted repo, where the job could rewrite its own rules` };
  const hooksReal = (() => { try { return realpath(cfg.hooksDir); } catch { return null; } })();
  if (!hooksReal) return { error: `hooks dir ${cfg.hooksDir} does not exist` };
  const mounts = {};
  for (const [k, p] of [["workFolder", wf.real], ["claudeMd", mdReal], ["hooks", hooksReal]]) {
    const m = toDockerMountSource(p, platform);
    if (m.error) return { error: `cannot mount ${k}: ${m.error}` };
    mounts[k] = m.source;
  }
  return { plan: { jobId, name: containerName(jobId), dockerBin, image: cfg.image, envFile: ef.real,
                   envFileKeys: ef.keys, workFolderReal: wf.real, mounts, cfg } };
}

// ------------------------------------------------------------------------------- argv ---

// The --settings object for the CLI INSIDE the container: the same catch-all no-background hook
// job-core.mjs wires for host jobs (buildNoBackgroundHookSettings), but pointing at the image's
// node and the read-only hooks mount. The job-tool-gate and Ollama-guard hooks are host-only (the
// gate needs the host's claunker-hermes checkout; the Ollama guard exists for dontAsk mode, which
// container jobs don't use).
export function buildContainerSettings({ ultracode = false } = {}) {
  const s = {
    hooks: {
      PreToolUse: [{
        matcher: "*",
        hooks: [{ type: "command", command: `node ${CONTAINER_HOOKS_DIR}/no-background-hook.mjs`, timeout: 5 }],
      }],
    },
  };
  if (ultracode) s.ultracode = true;
  return s;
}

// The CLI argv inside the container. --dangerously-skip-permissions is deliberate here: the
// container is the permission boundary (docs/container-jobs.md, "Why skip-permissions inside").
// The prompt goes last, after "--", and the model is bound with "=", so neither can ever be parsed
// as a CLI option no matter what the caller sent.
export function buildContainerCliArgv({ prompt, model, effortArgv = [], settings }) {
  return ["-p", "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", EMPTY_MCP_INLINE,
          `--model=${model}`, ...effortArgv, "--settings", JSON.stringify(settings), "--", prompt];
}

// -e NAME=value pairs for the container: the allowlisted job env, git identity, Ollama, and (phase
// 2) the egress proxy. Never secrets (those come from --env-file), never a bare -e NAME (which
// would copy the docker CLI process's own host value in).
export function buildContainerEnv({ extraEnv = {}, cfg, jobId }) {
  const env = [];
  const add = (k, v) => {
    if (SECRET_NAME_RE.test(k)) throw new Error(`refusing to pass ${k} on the docker command line; secrets go through --env-file`);
    if (v === undefined || v === null) return;
    env.push([k, String(v)]);
  };
  add("CLAUDE_ASYNC_JOB_ID", jobId);
  add("CLAUDE_ASYNC_SANDBOX", "container");
  for (const k of FORWARDED_ENV_KEYS) if (extraEnv[k] !== undefined) add(k, extraEnv[k]);
  // Commits are the bot's, even if the repo's local config names someone else.
  add("GIT_AUTHOR_NAME", cfg.gitName); add("GIT_COMMITTER_NAME", cfg.gitName);
  add("GIT_AUTHOR_EMAIL", cfg.gitEmail); add("GIT_COMMITTER_EMAIL", cfg.gitEmail);
  // A Windows checkout made with core.autocrlf=true (Git for Windows' default, set in the HOST's
  // global config, which the container doesn't see) has CRLF in the working tree; without the same
  // setting inside, Linux git reports every text file as modified.
  add("GIT_CONFIG_COUNT", "1"); add("GIT_CONFIG_KEY_0", "core.autocrlf"); add("GIT_CONFIG_VALUE_0", cfg.autocrlf);
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
  const argv = [
    "run", "--rm", "--name", name, "--label", `claude-async.job=${jobId}`,
    "--init",                                   // PID 1 reaps the CLI's children and forwards signals
    "--user", CONTAINER_USER,
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--cpus", cfg.cpus, "--memory", cfg.memory, "--memory-swap", cfg.memory, "--pids-limit", cfg.pidsLimit,
    "--network", cfg.network,
    "--add-host", "host.docker.internal:host-gateway",
    "--env-file", plan.envFile,
  ];
  for (const [k, v] of buildContainerEnv({ extraEnv, cfg, jobId })) argv.push("-e", `${k}=${v}`);
  argv.push(
    "--mount", `type=bind,source=${mounts.workFolder},target=${CONTAINER_WORKDIR}`,
    "--mount", `type=bind,source=${mounts.claudeMd},target=${CONTAINER_CLAUDE_MD},readonly`,
    "--mount", `type=bind,source=${mounts.hooks},target=${CONTAINER_HOOKS_DIR},readonly`,
    "--workdir", CONTAINER_WORKDIR,
    plan.image,
    "claude", ...cliArgv,
  );
  return argv;
}

// Preflight: is the daemon up and the image present locally? A job never pulls (no `--pull`): the
// image is built on claunker from container/Dockerfile, and pulling a same-named image from a
// registry would run someone else's code with the job's secrets.
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
  return { ok: true, imageId: String(r.stdout || "").trim() };
}

// ------------------------------------------------------------------------- kill / audit ---

export function buildKillArgv(name) {
  if (typeof name !== "string" || !name.startsWith(CONTAINER_NAME_PREFIX)) throw new Error(`not a claude-async container name: ${name}`);
  return ["kill", name];
}

// Best-effort `docker kill <name>`. Stopping the docker CLI client alone does NOT stop the container
// (on Windows a TerminateProcess'd client sends nothing to the daemon), so every cancel/cleanup path
// kills by name. "No such container" (already exited and --rm'd) counts as success.
export function killContainer({ dockerBin, name, spawnSync = nodeSpawnSync, timeoutMs = 15_000 }) {
  let r;
  try { r = spawnSync(dockerBin, buildKillArgv(name), { encoding: "utf8", timeout: timeoutMs, windowsHide: true }); }
  catch (e) { return { ok: false, error: e.message }; }
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status === 0) return { ok: true, killed: true };
  const err = String(r.stderr || "").trim();
  if (/no such container|is not running/i.test(err)) return { ok: true, killed: false };
  return { ok: false, error: err.slice(0, 300) || `docker kill exited ${r.status}` };
}

// The repo's .git is mounted read-write, and the host later runs git in that same repo (the card
// hook's `git rev-parse HEAD`, and Erick himself). A job could plant config that executes on the
// HOST (core.fsmonitor, core.hooksPath, filter drivers, include.path...) or a hook script. This
// lists what is there now (publish-branch.mjs's allowlist decides what is "unsafe"); the runner
// compares it with the same list taken before the job started and reports anything new.
export function auditRepoGitState(repo, { gitBin = "git", spawnSync = nodeSpawnSync } = {}) {
  const findings = [];
  const gitDir = path.join(repo, ".git");
  for (const file of ["config", "config.worktree"]) {
    const f = path.join(gitDir, file);
    if (!fs.existsSync(f)) continue;
    // --file reads that one file and nothing else: no repo discovery, no fsmonitor, no hooks.
    // cwd outside the repo, so git never discovers (and reads the config of) the repo under audit.
    const r = spawnSync(gitBin, ["config", "--file", f, "--list", "--name-only"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true, cwd: os.tmpdir(), env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.error || r.status !== 0) { findings.push(`unreadable:.git/${file}`); continue; }
    const scoped = String(r.stdout).split(/\r?\n/).filter(Boolean).map((k) => `local\t${k}`).join("\n");
    for (const bad of findUnsafeConfig(scoped)) findings.push(`config:.git/${file}:${bad.replace(/^local:/, "")}`);
  }
  let hooks = [];
  try { hooks = fs.readdirSync(path.join(gitDir, "hooks")); } catch {}
  for (const h of hooks) if (!h.endsWith(".sample")) findings.push(`hook:.git/hooks/${h}`);
  return findings.sort();
}
