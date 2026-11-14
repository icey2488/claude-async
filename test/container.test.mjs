// Unit tests for container.mjs (the docker argv builder and its validators) and for job-core.mjs's
// opt-in container-mode selection. Nothing here runs docker: argv is captured through startJob()'s
// opts.launch seam, and the docker-touching steps (image check, kill) go through their seams.
//
// CLAUDE_ASYNC_JOB_DIR is pointed at a fresh temp dir before importing job-core.mjs (JOB_ROOT is
// computed at module load). CLAUNKER_JOBCARD_CMD points at a nonexistent binary so no real card is
// minted.
// Run: node --test test/container.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn as spawnAsync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-container-test-"));
process.env.CLAUDE_ASYNC_JOB_DIR = path.join(TMP, "jobs");
process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);
// The machine-wide container-mode marker (review round 3, B1) lives under the user's home; keep this
// test run's marker in its own home instead of the real one.
process.env.HOME = process.env.USERPROFILE = path.join(TMP, "home");
for (const k of ["CLAUDE_ASYNC_JOB_SANDBOX", "CLAUDE_ASYNC_JOB_TOOL_GATE", "CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS",
                 "CLAUDE_ASYNC_DEPTH"]) delete process.env[k];
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const c = await import("../container.mjs");
const core = await import("../job-core.mjs");
const { withLanternPreamble } = await import("../lantern-preamble.mjs");
const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The GitHub App that container jobs act as (github-app.mjs): a throwaway key per test run.
const APP_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const APP_KEY_FILE = path.join(TMP, "app.pem");
fs.writeFileSync(APP_KEY_FILE, APP_KEY, { mode: 0o600 }); fs.chmodSync(APP_KEY_FILE, 0o600);
const BOT = { CLAUDE_ASYNC_GITHUB_APP_ID: "123456", CLAUDE_ASYNC_GITHUB_APP_KEY_FILE: APP_KEY_FILE };
// What preflightGitHubApp() returns for the App (the seam in startJob: opts.checkGitHubApp).
const APP_IDENTITY = { installationId: 777, slug: "claunker-jobs", botUserId: 98765, keyFile: APP_KEY_FILE };
const SECRET_GH = "ghs_TESTSECRETVALUE0000000000000000000000";   // an installation token the runner minted
const SECRET_OAUTH = "sk-ant-oat01-TESTSECRETVALUE";

const REPO = "icey2488/container-job-scratch";

// A fixture tree: <TMP>/fx-N/secrets/container.env, plus a plain host folder (never mounted).
function fixture() {
  const base = fs.mkdtempSync(path.join(TMP, "fx-"));
  const hostDir = path.join(base, "host-folder");
  fs.mkdirSync(path.join(hostDir, ".git"), { recursive: true });
  const secrets = path.join(base, "secrets");
  fs.mkdirSync(secrets);
  const envFile = path.join(secrets, "container.env");
  fs.writeFileSync(envFile, `CLAUDE_CODE_OAUTH_TOKEN=${SECRET_OAUTH}\n`);
  const env = { ...BOT, CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS: `${REPO}, icey2488/claude-async`, CLAUDE_ASYNC_CONTAINER_ENV_FILE: envFile };
  const jobDir = path.join(base, "jobdir");
  return { base, hostDir, envFile, env, jobDir, cfg: c.loadContainerConfig(env) };
}

const realpath = (p) => fs.realpathSync.native(p);

function planFor(fx, overrides = {}, { repo = REPO, baseRef } = {}) {
  const r = c.planContainerJob({ jobId: "claunker.t-20261101-abcd1234", repo, baseRef, jobDir: fx.jobDir,
                                 cfg: { ...fx.cfg, ...overrides }, resolveBin: (b) => b });
  assert.ok(!r.error, r.error);
  // pin the CPU clamp so argv doesn't depend on the test machine; the git identity startJob resolves
  // from the App at preflight (resolveGitIdentity) is applied here the same way
  return { ...r.plan, hostCpus: 16, ...c.resolveGitIdentity({ ...fx.cfg, ...overrides }, APP_IDENTITY) };
}

function sampleArgv(fx, { extraEnv = {}, prompt = "do the thing", cfg = {}, baseRef } = {}) {
  const plan = planFor(fx, cfg, { baseRef });
  const cliArgv = c.buildContainerCliArgv({ prompt, model: "claude-sonnet-5", effortArgv: ["--effort", "medium"],
                                            settings: c.buildContainerSettings() });
  return { plan, argv: c.buildDockerRunArgv({ plan, cliArgv, extraEnv }) };
}

const valueAfter = (argv, flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
const allValuesAfter = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

// ------------------------------------------------------------------------------ selection ---

const BOTH = "host,container";

test("resolveSandbox: off by default; only the exact env value \"container\" turns the default on", () => {
  assert.deepEqual(c.resolveSandbox(undefined, undefined, BOTH), { mode: "host" });
  for (const v of ["", "1", "true", "Container", "CONTAINER", " container", "docker"]) {
    assert.deepEqual(c.resolveSandbox(undefined, v, BOTH), { mode: "host" }, `env ${JSON.stringify(v)}`);
  }
  assert.deepEqual(c.resolveSandbox(undefined, "container", BOTH), { mode: "container" });
});

test("resolveSandbox: an explicit request picks the mode; anything else is refused", () => {
  assert.deepEqual(c.resolveSandbox("host", "container", BOTH), { mode: "host" });
  assert.deepEqual(c.resolveSandbox("container", undefined, BOTH), { mode: "container" });
  for (const bad of ["docker", "Container", "vm", 1, true]) assert.ok(c.resolveSandbox(bad, undefined, BOTH).error, `refuses ${JSON.stringify(bad)}`);
});

test("CLAUDE_ASYNC_ALLOWED_SANDBOXES: default host only; the chosen mode must be allowed in both directions", () => {
  assert.deepEqual(c.parseAllowedSandboxes(undefined), { allowed: ["host"] });
  assert.deepEqual(c.parseAllowedSandboxes(""), { allowed: ["host"] });
  assert.deepEqual(c.parseAllowedSandboxes("container"), { allowed: ["container"] });
  assert.deepEqual(c.parseAllowedSandboxes(" host , container "), { allowed: ["host", "container"] });
  for (const bad of ["docker", "host,docker", "Host", ",", "*"]) assert.ok(c.parseAllowedSandboxes(bad).error, bad);
  // default policy: a caller can't reach skip-permissions + GH_TOKEN with sandbox:"container"
  assert.match(c.resolveSandbox("container", undefined, undefined).error, /not allowed on this host/);
  // container-only host: neither the call nor a missing env default escapes to the bare host
  assert.match(c.resolveSandbox("host", "container", "container").error, /not allowed/);
  assert.match(c.resolveSandbox(undefined, undefined, "container").error, /not allowed/);
  assert.deepEqual(c.resolveSandbox(undefined, "container", "container"), { mode: "container" });
  assert.match(c.resolveSandbox("host", undefined, "bogus").error, /ALLOWED_SANDBOXES .* invalid/, "a bad policy fails closed");
});

// ------------------------------------------------------------------------------- argv ---

test("docker run argv: --cpus is clamped to the host's CPU count", () => {
  const fx = fixture();
  const plan = { ...planFor(fx), hostCpus: 2 };
  const argv = c.buildDockerRunArgv({ plan, cliArgv: ["-p"] });
  assert.equal(valueAfter(argv, "--cpus"), "2");
});

test("docker run argv: exact isolation and lifecycle flags are present", () => {
  const fx = fixture();
  const { argv } = sampleArgv(fx);
  assert.equal(argv[0], "run");
  for (const flag of ["--rm", "--init"]) assert.ok(argv.includes(flag), flag);
  assert.equal(valueAfter(argv, "--name"), "claude-async-claunker.t-20261101-abcd1234");
  assert.equal(valueAfter(argv, "--user"), "1000:1000");
  assert.equal(valueAfter(argv, "--security-opt"), "no-new-privileges");
  assert.equal(valueAfter(argv, "--cap-drop"), "ALL");
  assert.equal(valueAfter(argv, "--cpus"), "4");
  assert.equal(valueAfter(argv, "--memory"), "8g");
  assert.equal(valueAfter(argv, "--memory-swap"), "8g");
  assert.equal(valueAfter(argv, "--pids-limit"), "1024");
  assert.equal(valueAfter(argv, "--network"), "bridge");
  assert.equal(valueAfter(argv, "--add-host"), "host.docker.internal:host-gateway");
  assert.equal(valueAfter(argv, "--workdir"), "/workspace");
  assert.ok(!argv.includes("--privileged"));
  assert.ok(!argv.includes("--volume") && !argv.includes("-v"));
  assert.ok(!argv.some((a) => /^--cap-add/.test(a)));
  assert.equal(argv.filter((a) => /^--pull/.test(a)).length, 1);
  assert.ok(argv.includes("--pull=never"), "never pulls, even if the image is missing at launch");
  const img = argv.indexOf("claude-async-job:local");
  assert.ok(img > 0);
  assert.deepEqual(argv.slice(img + 1, img + 6), ["/usr/local/bin/claude-async-job-entry", REPO, "", "--", "claude"],
    "the image's entrypoint clones the repo, then execs the CLI");
  assert.ok(argv.slice(img).includes("--dangerously-skip-permissions"));
});

test("docker run argv: resource limits and image come from config", () => {
  const fx = fixture();
  const { argv } = sampleArgv(fx, { cfg: { cpus: "2.5", memory: "4096m", pidsLimit: "512", image: "claude-async-job:v2" } });
  assert.equal(valueAfter(argv, "--cpus"), "2.5");
  assert.equal(valueAfter(argv, "--memory"), "4096m");
  assert.equal(valueAfter(argv, "--pids-limit"), "512");
  assert.ok(argv.includes("claude-async-job:v2"));
});

test("docker run argv: NO read-write host mount; only CLAUDE.md and hooks, both read-only", () => {
  const fx = fixture();
  const { argv } = sampleArgv(fx);
  const mounts = allValuesAfter(argv, "--mount");
  assert.equal(mounts.length, 3);
  assert.match(mounts[0], /^type=bind,source=.+CLAUDE\.md,target=\/home\/agent\/\.claude\/CLAUDE\.md,readonly$/);
  assert.match(mounts[1], /^type=bind,source=.+hooks,target=\/opt\/claude-async\/hooks,readonly$/);
  // the per-job credentials dir (the runner writes the installation token there), read-only
  assert.equal(mounts[2], `type=bind,source=${path.join(fx.jobDir, "creds")},target=/run/claude-async/creds,readonly`);
  for (const m of mounts) assert.ok(m.endsWith(",readonly"), m);
  assert.ok(!mounts.some((m) => /target=\/workspace/.test(m)), "the workspace is container-local, never a host folder");
  assert.ok(!argv.includes("-v") && !argv.includes("--volume") && !argv.some((a) => /^--volumes-from|^--tmpfs/.test(a)));
});

test("docker run argv: repo and baseRef reach the entrypoint as argv and the job as env", () => {
  const fx = fixture();
  const { argv } = sampleArgv(fx, { baseRef: "release/1.2" });
  const i = argv.indexOf("/usr/local/bin/claude-async-job-entry");
  assert.deepEqual(argv.slice(i, i + 5), ["/usr/local/bin/claude-async-job-entry", REPO, "release/1.2", "--", "claude"]);
  const env = allValuesAfter(argv, "-e");
  assert.ok(env.includes(`CLAUDE_ASYNC_REPO=${REPO}`));
  assert.ok(env.includes("CLAUDE_ASYNC_BASE_REF=release/1.2"));
  assert.ok(!env.some((e) => e.startsWith("GIT_CONFIG_")), "no host-checkout git config (autocrlf) is needed for a Linux clone");
});

test("docker run argv: no Docker socket or daemon pipe anywhere", () => {
  const fx = fixture();
  const { argv } = sampleArgv(fx);
  const joined = argv.join("\n");
  for (const re of [/docker\.sock/i, /docker_engine/i, /\\\\\.\\pipe/i, /npipe/i, /DOCKER_HOST/]) {
    assert.ok(!re.test(joined), `argv must not mention ${re}`);
  }
});

test("docker run argv: secrets go by --env-file PATH only; no token value or secret-named -e anywhere", () => {
  const fx = fixture();
  const { argv } = sampleArgv(fx, { extraEnv: { CLAUDE_ASYNC_DEPTH: "1", GH_TOKEN: "leak", ANTHROPIC_API_KEY: "leak" } });
  assert.equal(valueAfter(argv, "--env-file"), realpath(fx.envFile));
  const joined = argv.join("\n");
  assert.ok(!joined.includes(SECRET_GH) && !joined.includes(SECRET_OAUTH), "no secret value in argv");
  assert.ok(!joined.includes(APP_KEY_FILE) && !joined.includes("PRIVATE KEY") && !joined.includes("123456"), "the App key (path or material) and app id never reach docker");
  assert.ok(!joined.includes("leak"), "extraEnv secrets are not forwarded");
  for (const e of allValuesAfter(argv, "-e")) {
    assert.match(e, /^[A-Za-z_][A-Za-z0-9_]*=/, `-e ${e} must be NAME=value, never a bare name`);
    assert.ok(!/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(e.split("=")[0]), `secret-like name ${e}`);
  }
});

test("docker run argv: only allowlisted job env is forwarded (HERMES_HOME etc. stay on the host)", () => {
  const fx = fixture();
  const { argv } = sampleArgv(fx, { extraEnv: { CLAUDE_ASYNC_DEPTH: "2", CLAUDE_ASYNC_JOB_EFFORT: "high",
    HERMES_HOME: "D:\\claunker\\hermes", CLAUNKER_LIVE_HERMES_HOME: "D:\\claunker\\hermes", CLAUDE_ASYNC_GATE_REPO: "x",
    BASH_MAX_TIMEOUT_MS: "1200000" } });
  const names = allValuesAfter(argv, "-e").map((e) => e.split("=")[0]);
  assert.ok(names.includes("CLAUDE_ASYNC_DEPTH") && names.includes("CLAUDE_ASYNC_JOB_EFFORT") && names.includes("BASH_MAX_TIMEOUT_MS"));
  for (const n of ["HERMES_HOME", "CLAUNKER_LIVE_HERMES_HOME", "CLAUDE_ASYNC_GATE_REPO"]) assert.ok(!names.includes(n), n);
  const env = Object.fromEntries(allValuesAfter(argv, "-e").map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  assert.equal(env.GIT_AUTHOR_NAME, "claunker-jobs[bot]");
  assert.equal(env.GIT_COMMITTER_EMAIL, "98765+claunker-jobs[bot]@users.noreply.github.com");
  assert.equal(env.OLLAMA_HOST, "http://host.docker.internal:11434");
  assert.equal(env.CLAUDE_ASYNC_JOB_ID, "claunker.t-20261101-abcd1234");
});

test("buildContainerEnv: extraEnv secrets are dropped, and the name guard throws on a secret-like key", () => {
  const cfg = c.loadContainerConfig(BOT);
  const env = c.buildContainerEnv({ cfg, jobId: "j", gitName: "a[bot]", gitEmail: "1+a[bot]@users.noreply.github.com",
                                    extraEnv: { GH_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "y" } });
  assert.ok(!env.some(([k]) => k === "GH_TOKEN" || k === "CLAUDE_CODE_OAUTH_TOKEN"));
  // The guard itself: FORWARDED_ENV_KEYS is frozen, so exercise it through a config value whose
  // name it would produce if the allowlist ever grew a secret-like entry.
  assert.ok(c.FORWARDED_ENV_KEYS.every((k) => !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(k)));
  assert.throws(() => Object.defineProperty(c.FORWARDED_ENV_KEYS, 0, { value: "GH_TOKEN" }));
});

test("phase 2 egress proxy: proxy env is added only when configured, and the host gateway is not", () => {
  const fx = fixture();
  const names = (argv) => allValuesAfter(argv, "-e").map((e) => e.split("=")[0]);
  assert.ok(!names(sampleArgv(fx).argv).includes("HTTPS_PROXY"));
  assert.equal(valueAfter(sampleArgv(fx).argv, "--add-host"), "host.docker.internal:host-gateway", "phase 1 reaches host Ollama");
  const { argv } = sampleArgv(fx, { cfg: { egressProxy: "http://egress-proxy:3128", network: "claude-jobs" } });
  assert.ok(allValuesAfter(argv, "-e").includes("HTTPS_PROXY=http://egress-proxy:3128"));
  assert.equal(valueAfter(argv, "--network"), "claude-jobs");
  assert.ok(!argv.includes("--add-host"), "phase 2: no route to the host except through the proxy");
});

test("CLI argv inside the container: prompt last after \"--\", model bound with \"=\", inline empty MCP", () => {
  for (const prompt of ["- fix the bug", "--version", "--add-dir / x", "plain"]) {
    const a = c.buildContainerCliArgv({ prompt, model: "--evil", effortArgv: [], settings: c.buildContainerSettings() });
    assert.equal(a.at(-1), prompt);
    assert.equal(a.at(-2), "--");
    assert.equal(a.indexOf("--"), a.length - 2);
    assert.ok(a.includes("--model=--evil") && !a.includes("--model"));
    assert.equal(a[a.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.ok(a.includes("--strict-mcp-config") && a.includes("--dangerously-skip-permissions"));
  }
});

test("CLI argv inside the container: only user settings load (--setting-sources user), never the clone's", () => {
  const a = c.buildContainerCliArgv({ prompt: "p", model: "m", effortArgv: [], settings: c.buildContainerSettings() });
  const i = a.indexOf("--setting-sources");
  assert.ok(i > 0 && i < a.indexOf("--"), "before the prompt separator");
  assert.equal(a[i + 1], "user", "project (.claude/settings.json) and local (settings.local.json) are not loaded");
  assert.equal(a.filter((x) => x === "--setting-sources").length, 1);
  assert.ok(a.includes("--strict-mcp-config"), "the clone's .mcp.json is ignored too");
});

test("container settings: the no-background hook runs from the read-only hooks mount; ultracode merges in", () => {
  const s = c.buildContainerSettings();
  assert.equal(s.hooks.PreToolUse[0].matcher, "*");
  // absolute node, NODE_OPTIONS dropped: neither the job's PATH nor a --require/--import it sets
  // can replace or pre-empt the hook
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command,
    "env -u NODE_OPTIONS /usr/local/bin/node /opt/claude-async/hooks/no-background-hook.mjs");
  assert.equal(s.ultracode, undefined);
  assert.equal(c.buildContainerSettings({ ultracode: true }).ultracode, true);
});

// ------------------------------------------------------------------------- Windows paths ---

test("toDockerMountSource: Windows drive paths become forward-slash paths Docker Desktop accepts", () => {
  assert.deepEqual(c.toDockerMountSource("D:\\code\\x", "win32"), { source: "D:/code/x" });
  assert.deepEqual(c.toDockerMountSource("D:\\code\\my repo\\sub", "win32"), { source: "D:/code/my repo/sub" });
  assert.deepEqual(c.toDockerMountSource("C:/Users/Raide/repo", "win32"), { source: "C:/Users/Raide/repo" });
  assert.ok(c.toDockerMountSource("\\\\server\\share\\repo", "win32").error, "UNC refused");
  assert.ok(c.toDockerMountSource("//server/share", "win32").error, "UNC (forward) refused");
  assert.ok(c.toDockerMountSource("code\\x", "win32").error, "relative refused");
  assert.ok(c.toDockerMountSource("D:\\code\\a,b", "win32").error, "comma would split the --mount CSV");
  assert.ok(c.toDockerMountSource("D:\\code\\a\"b", "win32").error, "quote refused");
  assert.deepEqual(c.toDockerMountSource("/srv/code/x", "linux"), { source: "/srv/code/x" });
  assert.ok(c.toDockerMountSource("srv/code", "linux").error);
});

test("stripLongPathPrefix: drops \\\\?\\ from drive paths, keeps UNC and plain paths", () => {
  assert.equal(c.stripLongPathPrefix("\\\\?\\D:\\code\\x"), "D:\\code\\x");
  assert.equal(c.stripLongPathPrefix("\\\\?\\UNC\\srv\\share"), "\\\\?\\UNC\\srv\\share");
  assert.equal(c.stripLongPathPrefix("D:\\code"), "D:\\code");
});

// ------------------------------------------------------------------------- repo + base ref ---

test("validateRepo: owner/repo must be well-formed and in CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS (case-insensitive)", () => {
  const allowed = ["icey2488/container-job-scratch"];
  assert.deepEqual(c.validateRepo("icey2488/container-job-scratch", allowed), { repo: "icey2488/container-job-scratch" });
  assert.deepEqual(c.validateRepo("ICEY2488/Container-Job-Scratch", allowed), { repo: "ICEY2488/Container-Job-Scratch" });
  assert.match(c.validateRepo("icey2488/claude-async", allowed).error, /not in CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS/);
  for (const bad of ["", "icey2488", "icey2488/", "/repo", "-x/repo", "a/b/c", "icey2488/..", "icey2488/.",
                     "icey2488/re po", "https://github.com/icey2488/x", "icey2488/x;rm", "git@github.com:a/b", 7]) {
    assert.ok(c.validateRepo(bad, ["icey2488/x"]).error, `refuses ${JSON.stringify(bad)}`);
  }
  assert.match(c.validateRepo("icey2488/x", []).error, /no container repos are allowed/, "no default allowlist");
});

test("parseAllowedRepos: comma/semicolon/space separated; bad entries are surfaced as a config error", () => {
  assert.deepEqual(c.parseAllowedRepos("a/b, c/d;e/f  g/h").repos, ["a/b", "c/d", "e/f", "g/h"]);
  assert.deepEqual(c.parseAllowedRepos(undefined).repos, []);
  const cfg = c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS: "a/b, not-a-repo, x/*" });
  assert.deepEqual(cfg.allowedRepos, ["a/b"]);
  assert.match(c.validateContainerConfig(cfg).join(" "), /ALLOWED_REPOS has invalid entries.*not-a-repo.*x\/\*/);
});

test("validateBaseRef: plain branch/tag/sha only; never an option, never a range or reflog expression", () => {
  for (const ok of ["main", "release/1.2", "v2.0.1", "feat/x_y", "0123abcd", undefined, null, ""]) {
    assert.ok(!c.validateBaseRef(ok).error, `accepts ${JSON.stringify(ok)}`);
  }
  for (const bad of ["-main", "--upload-pack=x", "a..b", "HEAD@{1}", "a/", "x.lock", "a//b", "a b", "a;b", "a\nb", "$(x)", 1,
                     // round 2, N1: full ref names could name GitHub's fork-network objects (refs/pull/N/head) or
                     // anything else the entrypoint's local resolution does not mean; branch/tag/sha names only
                     "refs/pull/1/head", "refs/heads/main", "refs/tags/v1", "REFS/heads/main", "refs"]) {
    assert.ok(c.validateBaseRef(bad).error, `refuses ${JSON.stringify(bad)}`);
  }
  assert.ok(!c.validateBaseRef("refs-and-more").error, "a branch merely starting with refs- is fine");
});

test("planContainerJob: refuses workFolder outright (container jobs never mount a host folder)", () => {
  const fx = fixture();
  const r = c.planContainerJob({ jobId: "j", repo: REPO, workFolder: fx.hostDir, cfg: fx.cfg, resolveBin: (b) => b });
  assert.match(r.error, /do not take workFolder/);
});

test("planContainerJob: a missing CLAUDE.md or hooks dir is an error, not a throw", () => {
  const fx = fixture();
  const gone = path.join(fx.base, "gone.md");
  assert.match(c.planContainerJob({ jobId: "j", repo: REPO, cfg: { ...fx.cfg, claudeMd: gone }, resolveBin: (b) => b }).error, /CLAUDE\.md/);
  // a realpath seam that "resolves" to a path that does not exist must not make statSync throw
  const r = c.planContainerJob({ jobId: "j", repo: REPO, cfg: fx.cfg, resolveBin: (b) => b,
    realpath: (p) => (p === fx.cfg.claudeMd ? path.join(fx.base, "vanished.md") : fs.realpathSync.native(p)) });
  assert.match(r.error, /CLAUDE\.md/);
  assert.match(c.planContainerJob({ jobId: "j", repo: REPO, cfg: { ...fx.cfg, hooksDir: path.join(fx.base, "nohooks") }, resolveBin: (b) => b }).error, /hooks dir/);
});

test("loadContainerConfig: the HTTP bridge lock check uses CLAUDE_ASYNC_HTTP_PORT and the config dir's http.json", () => {
  const cfg = c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_HTTP_PORT: "7999", CLAUDE_ASYNC_CONFIG_DIR: "/cfgdir" });
  assert.equal(cfg.httpBridgePort, 7999);
  assert.equal(cfg.httpBridgeConfig, path.join("/cfgdir", "http.json"));
  assert.equal(c.loadContainerConfig(BOT).httpBridgePort, 7842);
});

test("the removed host-mount machinery is gone (no workFolder validation, no allowed roots, no .git audit)", () => {
  for (const name of ["validateWorkFolder", "auditRepoGitState"]) assert.equal(c[name], undefined, name);
  const cfg = c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS: "D:\\code" });
  assert.equal(cfg.allowedRoots, undefined);
  assert.equal(cfg.deniedRoots, undefined);
});

// -------------------------------------------------------------------------- secrets file ---

test("checkEnvFile: returns key names only, never values; CLAUDE_CODE_OAUTH_TOKEN is the only key", () => {
  const fx = fixture();
  const r = c.checkEnvFile(fx.envFile);
  assert.deepEqual(r.keys, ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.ok(!JSON.stringify(r).includes(SECRET_OAUTH));
  assert.deepEqual(c.ENV_FILE_ALLOWED_KEYS, ["CLAUDE_CODE_OAUTH_TOKEN"]);
  // GH_TOKEN (the old bot PAT) is refused: GitHub credentials come from the App, per job
  fs.writeFileSync(fx.envFile, `GH_TOKEN=ghp_x\nCLAUDE_CODE_OAUTH_TOKEN=${SECRET_OAUTH}\n`);
  const old = c.checkEnvFile(fx.envFile);
  assert.match(old.error, /GH_TOKEN.*not allowed.*GitHub App/);
  assert.ok(!old.error.includes(SECRET_OAUTH));
});

test("checkEnvFile: refuses unknown keys (ANTHROPIC_API_KEY), bare keys, empties, dupes, CRLF, BOM, missing keys", () => {
  const fx = fixture();
  const K = "CLAUDE_CODE_OAUTH_TOKEN";
  const cases = [
    [`${K}=b\nANTHROPIC_API_KEY=${SECRET_OAUTH}\n`, /ANTHROPIC_API_KEY.*not allowed/],
    [`${K}\n`, /not KEY=value/],
    [`${K}=\n`, /is empty/],
    [`${K}=a\n${K}=b\n`, /appears twice/],
    [`${K}=b\r\n`, /CRLF/],
    [`\ufeff${K}=b\n`, /BOM/],
    ["# nothing\n", /missing CLAUDE_CODE_OAUTH_TOKEN/],
    // docker --env-file keeps these literally, so the token inside the container would be wrong
    [`${K}="sk-ant-a"\n`, /CLAUDE_CODE_OAUTH_TOKEN contains a quote/],
    [`${K}='sk-ant-a'\n`, /CLAUDE_CODE_OAUTH_TOKEN contains a quote/],
    [`${K}=sk-ant-a # me\n`, /CLAUDE_CODE_OAUTH_TOKEN contains whitespace/],
    [`${K}= sk-ant-a\n`, /CLAUDE_CODE_OAUTH_TOKEN has leading or trailing whitespace/],
    [`${K}=sk-ant-a \n`, /CLAUDE_CODE_OAUTH_TOKEN has leading or trailing whitespace/],
    [`${K}=sk\tant\n`, /CLAUDE_CODE_OAUTH_TOKEN contains whitespace/],
    [`${K}=sk\u0007ant\n`, /CLAUDE_CODE_OAUTH_TOKEN contains a control character/],
  ];
  for (const [body, re] of cases) {
    fs.writeFileSync(fx.envFile, body);
    const r = c.checkEnvFile(fx.envFile);
    assert.match(r.error || "", re, JSON.stringify(body));
    assert.ok(!r.error.includes(SECRET_OAUTH), "error text never carries a value");
  }
  fs.writeFileSync(fx.envFile, `# comment\n\n${K}=b\n`);
  assert.ok(!c.checkEnvFile(fx.envFile).error, "comments and blank lines are fine");
  assert.match(c.checkEnvFile(null).error, /not set/);
  assert.match(c.checkEnvFile(path.join(fx.base, "missing.env")).error, /does not exist/);
});

test("checkEnvFile / planContainerJob: a secrets file inside the claude-async checkout is refused", () => {
  const fx = fixture();
  const inCheckout = path.join(REPO_DIR, "hooks", `container-test-${process.pid}.env`);
  fs.copyFileSync(fx.envFile, inCheckout);
  try {
    const r = c.planContainerJob({ jobId: "j", repo: REPO, cfg: { ...fx.cfg, envFile: inCheckout }, resolveBin: (b) => b });
    assert.match(r.error, /outside the claude-async checkout/);
  } finally { fs.rmSync(inCheckout, { force: true }); }
});

test("readEnvFileSecretValues: the values, in memory, for redaction only; [] for a bad or missing file", () => {
  const fx = fixture();
  // the raw value first, then its base64 forms (round 2, A3); 3 entries, none under 8 chars
  const v1 = c.readEnvFileSecretValues(fx.envFile);
  assert.deepEqual(v1.slice(0, 1), [SECRET_OAUTH]);
  assert.equal(v1.length, 3);
  assert.ok(v1.every((v) => typeof v === "string" && v.length >= 8));
  assert.deepEqual(c.readEnvFileSecretValues(null), []);
  assert.deepEqual(c.readEnvFileSecretValues(path.join(fx.base, "missing.env")), []);
  // CRLF/BOM files still yield their values (redaction must not depend on the file being perfect)
  fs.writeFileSync(fx.envFile, `\ufeffCLAUDE_CODE_OAUTH_TOKEN=${SECRET_OAUTH}\r\n`);
  assert.deepEqual(c.readEnvFileSecretValues(fx.envFile), v1);
  // the same encoding helper serves the runner's minted tokens
  assert.deepEqual(c.secretEncodings([SECRET_GH]), [SECRET_GH,
    Buffer.from(`x-access-token:${SECRET_GH}`).toString("base64").replace(/=+$/, ""), Buffer.from(SECRET_GH).toString("base64").replace(/=+$/, "")]);
});

test("readTokenFileSecretValues: the job's current installation token (creds/token) plus its base64 forms; [] when absent", () => {
  const fx = fixture();
  const creds = path.join(fx.jobDir, "creds");
  assert.deepEqual(c.readTokenFileSecretValues(creds), []);
  fs.mkdirSync(creds, { recursive: true });
  fs.writeFileSync(path.join(creds, "token"), `${SECRET_GH}\n`);
  const v = c.readTokenFileSecretValues(creds);
  assert.equal(v[0], SECRET_GH, "trailing newline stripped");
  assert.equal(v.length, 3);
  assert.deepEqual(c.readTokenFileSecretValues(null), []);
});

test("redactSecrets: exact env-file values and GitHub/Anthropic token shapes become [REDACTED]", () => {
  const text = `a ${SECRET_GH} b ${SECRET_OAUTH} c ghp_${"A".repeat(36)} d github_pat_${"1".repeat(30)} ` +
               `e gho_${"b".repeat(36)} f ghs_${"c".repeat(36)} g sk-ant-api03-${"x".repeat(20)} h unrelated-text`;
  const out = c.redactSecrets(text, [SECRET_GH, SECRET_OAUTH]);
  for (const leak of [SECRET_GH, SECRET_OAUTH, "ghp_AAAA", "github_pat_111", "gho_bbb", "ghs_ccc", "sk-ant-api03"]) {
    assert.ok(!out.includes(leak), `${leak} redacted: ${out}`);
  }
  assert.match(out, /h unrelated-text$/);
  assert.equal(c.redactSecrets("custom-secret-value-123 x", ["custom-secret-value-123"]), "[REDACTED] x");
  assert.equal(c.redactSecrets("short", ["ab"]), "short", "values under 8 chars are not used as patterns");
  assert.equal(c.redactSecrets("", ["x"]), "");
});

// -------------------------------------------------------------------------------- config ---

test("validateContainerConfig: refuses host/none networks, bad limits, missing App settings, bad identity overrides", () => {
  const ok = c.loadContainerConfig(BOT);
  assert.deepEqual(c.validateContainerConfig(ok), []);
  assert.match(c.validateContainerConfig(c.loadContainerConfig({})).join(" "), /CLAUDE_ASYNC_GITHUB_APP_ID is not set/);
  assert.match(c.validateContainerConfig(c.loadContainerConfig({ CLAUDE_ASYNC_GITHUB_APP_ID: "1" })).join(" "), /KEY_FILE is not set/);
  assert.match(c.validateContainerConfig(c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_GITHUB_APP_REFRESH_MS: "5" })).join(" "), /REFRESH_MS/);
  // the old required identity settings are now optional overrides, validated only when set
  assert.equal(ok.gitName, null); assert.equal(ok.gitEmail, null);
  assert.deepEqual(c.validateContainerConfig(c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_GIT_NAME: "x", CLAUDE_ASYNC_CONTAINER_GIT_EMAIL: "x@y" })), []);
  assert.match(c.validateContainerConfig(c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_GIT_EMAIL: "not an email" })).join(" "), /GIT_EMAIL/);
  assert.match(c.validateContainerConfig(c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_GIT_NAME: "a\u0007b" })).join(" "), /GIT_NAME/);
  assert.ok(c.validateContainerConfig({ ...ok, network: "host" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, network: "none" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, cpus: "0" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, cpus: "--privileged" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, memory: "lots" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, pidsLimit: "10" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, image: "--privileged" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, ollamaUrl: "http://u:p@evil/" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, egressProxy: "socks5://x" }).length);
});

// ---------------------------------------------------------------------------- kill / audit ---

// A fake spawnSync "daemon" for the label-based cleanup: containers = [{ id, state, label }].
function fakeDaemon(containers, { psFails = false, rmFails = new Set() } = {}) {
  const calls = [];
  const fn = (bin, args) => {
    calls.push(args);
    if (args[0] === "ps") {
      if (psFails) return { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      const label = args[args.indexOf("--filter") + 1].replace(/^label=claude-async\.job=/, "");
      return { status: 0, stderr: "", stdout: containers.filter((x) => x.label === label || x.leak)
        .map((x) => `${x.id}\t${x.state}\t${x.label}\n`).join("") };
    }
    if (args[0] === "rm") {
      if (rmFails.has(args[2])) return { status: 1, stdout: "", stderr: "Error response from daemon: cannot remove" };
      const i = containers.findIndex((x) => x.id === args[2]);
      if (i >= 0) containers.splice(i, 1);
      return { status: 0, stdout: args[2], stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { fn, calls, containers };
}
const CID = (ch) => ch.repeat(64);

test("cleanup lists by the exact job label and removes by immutable ID with rm -f (running AND created)", () => {
  const d = fakeDaemon([{ id: CID("a"), state: "running", label: "j1" }, { id: CID("b"), state: "created", label: "j1" },
                        { id: CID("c"), state: "running", label: "j2" }]);
  assert.deepEqual(c.buildListArgv("j1"), ["ps", "-a", "--no-trunc", "--filter", "label=claude-async.job=j1",
    "--format", '{{.ID}}\t{{.State}}\t{{.Label "claude-async.job"}}']);
  const r = c.cleanupJobContainers({ dockerBin: "docker", jobId: "j1", spawnSync: d.fn });
  assert.deepEqual(r, { ok: true, absent: true, removed: 2, remaining: [] });
  assert.deepEqual(d.calls.filter((a) => a[0] === "rm"), [["rm", "-f", CID("a")], ["rm", "-f", CID("b")]]);
  assert.deepEqual(d.containers.map((x) => x.label), ["j2"], "another job's container is untouched");
  assert.ok(!d.calls.some((a) => a[0] === "kill"), "never docker kill <name>");
});

test("cleanup: a container returned without our label is never removed (name reuse / filter bug belt)", () => {
  const d = fakeDaemon([{ id: CID("d"), state: "running", label: "someone-else", leak: true }]);
  const r = c.cleanupJobContainers({ dockerBin: "docker", jobId: "j1", spawnSync: d.fn });
  assert.equal(r.removed, 0);
  assert.ok(!d.calls.some((a) => a[0] === "rm"));
});

test("cleanup: daemon down is ok:false; a failed rm leaves the container listed (absent:false)", () => {
  assert.match(c.cleanupJobContainers({ dockerBin: "docker", jobId: "j1", spawnSync: fakeDaemon([], { psFails: true }).fn }).error,
    /Cannot connect/);
  const d = fakeDaemon([{ id: CID("e"), state: "running", label: "j1" }], { rmFails: new Set([CID("e")]) });
  const r = c.cleanupJobContainers({ dockerBin: "docker", jobId: "j1", spawnSync: d.fn });
  assert.equal(r.ok, true);
  assert.equal(r.absent, false);
  assert.equal(r.remaining.length, 1);
  assert.equal(c.cleanupJobContainers({ dockerBin: "docker", jobId: "j1", spawnSync: fakeDaemon([]).fn }).absent, true);
  const bad = () => ({ status: 0, stdout: "not-an-id\trunning\tj1\n", stderr: "" });
  assert.match(c.listJobContainers({ dockerBin: "docker", jobId: "j1", spawnSync: bad }).error, /unexpected line/);
  assert.equal(c.killContainer, undefined, "the name-based kill is gone");
});
test("checkDockerImage: returns the immutable image ID; refuses a malformed one", () => {
  const id = `sha256:${"0123456789abcdef".repeat(4)}`;
  const run = (res) => () => res;
  assert.deepEqual(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 0, stdout: `${id}\n` }) }),
    { ok: true, imageId: id });
  for (const out of ["sha256:x", "", "claude-async-job:local", `${id} extra`]) {
    assert.match(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 0, stdout: out }) }).error,
      /unexpected image ID/, JSON.stringify(out));
  }
});

test("docker run argv: runs the inspected image ID, not the tag", () => {
  const fx = fixture();
  const id = `sha256:${"ab".repeat(32)}`;
  const plan = { ...planFor(fx), imageId: id };
  const argv = c.buildDockerRunArgv({ plan, cliArgv: ["-p"] });
  assert.ok(argv.includes(id));
  assert.ok(!argv.includes("claude-async-job:local"), "the tag never reaches docker run");
  assert.equal(argv[argv.indexOf(id) + 1], "/usr/local/bin/claude-async-job-entry");
});

test("checkDockerImage: distinguishes a missing image from a stopped daemon; never pulls", () => {
  const seen = [];
  const run = (res) => (bin, args) => { seen.push(args); return res; };
  assert.equal(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 0, stdout: `sha256:${"a".repeat(64)}\n` }) }).ok, true);
  assert.match(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 1, stderr: "Error: No such image: i" }) }).error, /not built/);
  assert.match(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 1, stderr: "error during connect" }) }).error, /Docker Desktop running/);
  assert.ok(seen.every((a) => a[0] === "image" && a[1] === "inspect"));
});

// ----------------------------------------------------------- job-core: opt-in selection ---

function fakeLaunch(capture) {
  return async (p, command, argv, cwd, extraEnv, launchExtra) => {
    capture.push({ p, command, argv, cwd, extraEnv, launchExtra });
    return { pid: process.pid, pidSource: "test", jobMembership: null, launchPath: "test" };
  };
}
const CAPS = { maxConcurrent: 1000, maxStartsPerMinute: 1000 };
const jid = (s) => `${s}-${crypto.randomBytes(4).toString("hex")}`;
// Container-mode startJob seams shared by the tests below.
const ctrOpts = (fx, extra = {}) => ({ caps: CAPS, allowedSandboxes: BOTH, checkHttpBridge: async () => ({ ok: true }),
                                       checkGitHubApp: async () => ({ ...APP_IDENTITY }),
                                       containerConfig: { ...fx.cfg, dockerBin: process.execPath },
                                       checkImage: () => ({ ok: true, imageId: `sha256:${"ab".repeat(32)}` }), ...extra });

test("startJob: with container mode off (default), argv/command/env are what they were before container mode", async () => {
  const fx = fixture();
  const a = [], b = [];
  const base = { prompt: "hello", workFolder: fx.hostDir };
  const opts = { claudeBin: process.execPath, caps: CAPS, hermesHomeIsolation: false, toolGate: false, safePermissions: false };
  const r1 = await core.startJob({ ...base, jobId: jid("off-a") }, { ...opts, launch: fakeLaunch(a) });
  const r2 = await core.startJob({ ...base, jobId: jid("off-b"), sandbox: "host" },
    { ...opts, launch: fakeLaunch(b), sandboxDefault: "container", allowedSandboxes: BOTH });
  for (const r of [r1, r2]) { assert.ok(!r.error, r.error); assert.equal(r.sandbox, undefined); assert.equal(r.container, undefined); }
  assert.deepEqual(a[0].argv, b[0].argv, "sandbox:\"host\" over a container default is identical to the default");
  assert.equal(a[0].command, process.execPath);
  assert.equal(a[0].cwd, fx.hostDir, "host jobs still run in workFolder");
  assert.equal(a[0].argv[0], "-p");
  assert.ok(a[0].argv.includes("--dangerously-skip-permissions"));
  assert.ok(!a[0].argv.includes("run") && !a[0].argv.includes("--rm"));
  assert.deepEqual(a[0].launchExtra, {}, "no container record for host jobs");
  // The literal pre-container argv shape for this input (prompt/model/effort/settings layout).
  // The prompt itself now carries the Lantern preamble (see lantern-preamble.mjs) -- the CLI's
  // own eyes only, never shown on the card or in meta.json's prompt preview.
  const i = a[0].argv.indexOf("--settings");
  assert.deepEqual(a[0].argv.slice(0, i), ["-p", withLanternPreamble("hello"), "--strict-mcp-config", "--mcp-config",
    path.join(REPO_DIR, "empty-mcp.json"), "--dangerously-skip-permissions", "--model", "claude-sonnet-5", "--effort", "medium"]);
  assert.equal(a[0].argv.length, i + 2);
  const meta = JSON.parse(fs.readFileSync(path.join(a[0].p.d, "meta.json"), "utf8"));
  assert.equal(meta.workFolder, fx.hostDir);
  for (const k of ["sandbox", "container", "repo", "baseRef"]) assert.equal(meta[k], undefined, `host meta has no ${k}`);
});

test("startJob: unknown env values never enable container mode", async () => {
  const fx = fixture();
  for (const v of ["1", "true", "Container"]) {
    const cap = [];
    const r = await core.startJob({ prompt: "p", workFolder: fx.hostDir, jobId: jid("env") },
      { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch(cap), sandboxDefault: v, hermesHomeIsolation: false });
    assert.ok(!r.error, r.error);
    assert.equal(cap[0].command, process.execPath, `env ${v}`);
  }
});

test("startJob: the sandbox policy refuses a disallowed mode before the job dir exists", async () => {
  const fx = fixture();
  const cases = [
    [{ sandbox: "container", repo: REPO }, { allowedSandboxes: undefined }],           // default policy: host only
    [{ sandbox: "host" }, { allowedSandboxes: "container" }],
    [{}, { allowedSandboxes: "container" }],                                            // host by default, not allowed
    [{}, { allowedSandboxes: "nonsense" }],
  ];
  for (const [args, o] of cases) {
    const id = jid("pol");
    const r = await core.startJob({ prompt: "p", jobId: id, ...args },
      { ...ctrOpts(fx, { launch: fakeLaunch([]) }), claudeBin: process.execPath, hermesHomeIsolation: false, ...o });
    assert.equal(r.errorCode, "invalid", JSON.stringify(r));
    assert.match(r.error, /CLAUDE_ASYNC_ALLOWED_SANDBOXES/);
    assert.ok(!fs.existsSync(path.join(core.JOB_ROOT, id)));
  }
});

test("startJob: an invalid sandbox value is refused before anything is written", async () => {
  const id = jid("bad");
  const r = await core.startJob({ prompt: "p", workFolder: os.tmpdir(), jobId: id, sandbox: "docker" },
    { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]) });
  assert.equal(r.errorCode, "invalid");
  assert.ok(!fs.existsSync(path.join(core.JOB_ROOT, id)));
});

test("startJob: repo/baseRef on a host job is refused (they only mean something for a container job)", async () => {
  for (const extra of [{ repo: REPO }, { baseRef: "main" }]) {
    const id = jid("hostrepo");
    const r = await core.startJob({ prompt: "p", jobId: id, ...extra },
      { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]), hermesHomeIsolation: false });
    assert.equal(r.errorCode, "invalid", JSON.stringify(r));
    assert.match(r.error, /only for container jobs/);
    assert.ok(!fs.existsSync(path.join(core.JOB_ROOT, id)));
  }
});

test("startJob: sandbox:\"container\" launches docker with the container argv and records it", async () => {
  const fx = fixture();
  const cap = [];
  const id = jid("ctr");
  const r = await core.startJob({ prompt: "--version do it", jobId: id, sandbox: "container", repo: REPO, baseRef: "main",
                                  model: "claude-opus-4-8", effort: "ultracode" }, ctrOpts(fx, { launch: fakeLaunch(cap) }));
  assert.ok(!r.error, r.error);
  const { p, command, argv, cwd, extraEnv, launchExtra } = cap[0];
  assert.equal(command, process.execPath, "the runner spawns the docker binary");
  assert.equal(cwd, p.d, "the docker client runs in the job dir, never in a repo");
  assert.equal(argv[0], "run");
  assert.equal(valueAfter(argv, "--name"), `claude-async-${id}`);
  assert.equal(argv.at(-1), withLanternPreamble("--version do it"));
  assert.equal(argv.at(-2), "--");
  assert.ok(argv.includes("--model=claude-opus-4-8"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "xhigh");
  assert.equal(JSON.parse(argv[argv.indexOf("--settings") + 1]).ultracode, true);
  assert.ok(argv.includes(REPO) && argv.includes("main"));
  assert.equal(r.sandbox, "container");
  assert.equal(r.container.name, `claude-async-${id}`);
  assert.equal(r.container.repo, REPO);
  assert.equal(r.workFolder, null, "no host folder");
  assert.equal(r.startHead, null, "no host git HEAD for a container job");
  assert.equal(r.hermesHome, undefined, "no per-job HERMES_HOME dir for container jobs");
  assert.deepEqual(Object.keys(launchExtra.container).sort(), ["credsDir", "dockerBin", "envFile", "githubApp", "jobId", "maxRuntimeMs", "name", "repo"]);
  assert.equal(launchExtra.container.envFile, fs.realpathSync.native(fx.envFile), "a path, never a value");
  // the runner mints the installation token itself: it gets the app id, the KEY PATH, the installation, the repo name
  assert.deepEqual(launchExtra.container.githubApp, { appId: "123456", keyFile: fs.realpathSync.native(APP_KEY_FILE), installationId: 777,
    repoName: "container-job-scratch", refreshMs: 45 * 60_000, apiBase: "https://api.github.com" });
  assert.equal(launchExtra.container.credsDir, path.join(p.d, "creds"));
  assert.ok(argv.includes(`type=bind,source=${path.join(p.d, "creds")},target=/run/claude-async/creds,readonly`));
  assert.ok(allValuesAfter(argv, "-e").includes("GIT_AUTHOR_NAME=claunker-jobs[bot]"));
  assert.ok(allValuesAfter(argv, "-e").includes("GIT_COMMITTER_EMAIL=98765+claunker-jobs[bot]@users.noreply.github.com"));
  assert.deepEqual(r.container.githubApp, { appId: "123456", slug: "claunker-jobs", botUserId: 98765, installationId: 777 }, "meta records the App identity, never the key path or a token");
  assert.equal(r.container.credsDir, path.join(p.d, "creds"));
  assert.ok(!JSON.stringify(r).includes("PRIVATE KEY") && !JSON.stringify(r).includes(APP_KEY_FILE));
  // the image runs by the ID preflight inspected (ctrOpts' checkImage), recorded in meta too
  const imageId = `sha256:${"ab".repeat(32)}`;
  assert.ok(argv.includes(imageId) && !argv.includes(fx.cfg.image));
  assert.equal(r.container.imageId, imageId);
  assert.equal(r.container.image, fx.cfg.image);
  assert.equal(launchExtra.container.repo, REPO);
  assert.ok(!JSON.stringify(cap[0]).includes(SECRET_GH), "no secret anywhere in what launch() receives");
  assert.equal(extraEnv.GH_TOKEN, undefined);
});

test("startJob: a container job never runs host git (no card startHead lookup in any folder)", { skip: process.platform === "win32" }, async () => {
  const fx = fixture();
  const bin = path.join(fx.base, "bin");
  fs.mkdirSync(bin);
  const log = path.join(fx.base, "git-calls.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$PWD $*" >> "${log}"\nexit 1\n`);
  fs.chmodSync(path.join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const r = await core.startJob({ prompt: "p", jobId: jid("nogit"), sandbox: "container", repo: REPO }, ctrOpts(fx, { launch: fakeLaunch([]) }));
    assert.ok(!r.error, r.error);
    assert.ok(!fs.existsSync(log), `host git ran: ${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""}`);
    // control: a host job in the same process does look up HEAD through the same shim
    await core.startJob({ prompt: "p", workFolder: fx.hostDir, jobId: jid("hostgit") },
      { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]), hermesHomeIsolation: false });
    assert.ok(fs.existsSync(log), "the shim is on PATH");
  } finally { process.env.PATH = oldPath; }
});

test("startJob: CLAUDE_ASYNC_JOB_SANDBOX=container (via seam) selects container mode without a per-call param", async () => {
  const fx = fixture();
  const cap = [];
  const r = await core.startJob({ prompt: "p", jobId: jid("envon"), repo: REPO },
    ctrOpts(fx, { launch: fakeLaunch(cap), sandboxDefault: "container" }));
  assert.ok(!r.error, r.error);
  assert.equal(cap[0].argv[0], "run");
});

test("startJob: container preflight refusals happen before the job dir exists", async () => {
  const fx = fixture();
  const cases = [
    [{ workFolder: fx.hostDir }, {}, /do not take workFolder/],
    [{ repo: undefined }, {}, /repo .* is required/],
    [{ repo: "icey2488/not-allowed" }, {}, /not in CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS/],
    [{ baseRef: "--upload-pack=x" }, {}, /baseRef/],
    [{}, { cfg: { allowedRepos: [] } }, /no container repos are allowed/],
    [{}, { cfg: { envFile: null } }, /CLAUDE_ASYNC_CONTAINER_ENV_FILE is not set/],
    // the GitHub App: fail closed on every missing piece, with the fix in the message
    [{}, { cfg: { githubApp: { ...fx.cfg.githubApp, appId: null } } }, /CLAUDE_ASYNC_GITHUB_APP_ID is not set.*App ID/],
    [{}, { cfg: { githubApp: { ...fx.cfg.githubApp, keyFile: null } } }, /CLAUDE_ASYNC_GITHUB_APP_KEY_FILE is not set/],
    [{}, { cfg: { githubApp: { ...fx.cfg.githubApp, keyFile: path.join(fx.base, "nokey.pem") } } }, /key file .* does not exist/],
    [{}, { app: async () => ({ error: "GitHub App preflight against api.github.com failed: the GitHub App is not installed on icey2488/container-job-scratch" }) }, /not installed on/],
    [{}, { app: async () => ({ error: "the JWT was rejected (401): CLAUDE_ASYNC_GITHUB_APP_ID and CLAUDE_ASYNC_GITHUB_APP_KEY_FILE do not match" }) }, /do not match/],
    [{}, { image: () => ({ error: "docker image claude-async-job:local is not built on this host" }) }, /not built/],
    [{}, { cfg: { dockerBin: path.join(fx.base, "no-docker.exe") } }, /docker binary/],
    [{}, { bridge: async () => ({ error: "the loopback HTTP MCP bridge is not token-locked" }) }, /not token-locked/],
  ];
  for (const [args, o, re] of cases) {
    const id = jid("pf");
    const r = await core.startJob({ prompt: "p", jobId: id, sandbox: "container", repo: REPO, ...args },
      ctrOpts(fx, { launch: fakeLaunch([]), containerConfig: { ...fx.cfg, dockerBin: process.execPath, ...(o.cfg || {}) },
                    ...(o.image ? { checkImage: o.image } : {}), ...(o.bridge ? { checkHttpBridge: o.bridge } : {}),
                    ...(o.app ? { checkGitHubApp: o.app } : {}) }));
    assert.equal(r.errorCode, "preflight", JSON.stringify(r));
    assert.match(r.error, re);
    assert.ok(!fs.existsSync(path.join(core.JOB_ROOT, id)), "no job dir on refusal");
  }
});


// job-core's container cleanup state. Seams: opts.cleanupContainers replaces cleanupJobContainers.
const cleanupSeam = (results) => {
  const seen = [];
  const fn = (a) => { seen.push(a); return results.length > 1 ? results.shift() : results[0]; };
  return { fn, seen };
};
async function startCtr(fx, launch = fakeLaunch([])) {
  const id = jid("cl");
  const r = await core.startJob({ prompt: "p", jobId: id, sandbox: "container", repo: REPO }, ctrOpts(fx, { launch }));
  assert.ok(!r.error, r.error);
  return { id, d: path.join(core.JOB_ROOT, id) };
}
const deadLaunch = async () => ({ pid: 999999, pidSource: "test", launchPath: "test" });

test("startJob: the runner's container record carries the job id (label) and the wall-clock limit", async () => {
  const fx = fixture();
  const cap = [];
  await startCtr({ ...fx, cfg: { ...fx.cfg, maxRuntimeMs: 3_600_000 } }, fakeLaunch(cap));
  const ct = cap[0].launchExtra.container;
  assert.equal(ct.jobId, path.basename(cap[0].p.d));
  assert.equal(ct.maxRuntimeMs, 3_600_000);
  assert.equal(c.loadContainerConfig(BOT).maxRuntimeMs, 4 * 3600_000, "default 4h");
  assert.ok(c.validateContainerConfig({ ...c.loadContainerConfig(BOT), maxRuntimeMs: 1000 }).length, "too small refused");
  assert.ok(c.validateContainerConfig(c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_MAX_RUNTIME_MS: "abc" })).length);
});

test("cancelJob: persists the intent FIRST, then removes by label; refuses host jobs", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx);
  const order = [];
  const seam = (a) => { order.push(fs.existsSync(path.join(d, "cancel_requested")) ? "intent-on-disk" : "no-intent");
                        assert.equal(a.jobId, id); return { ok: true, absent: true, removed: 1, remaining: [] }; };
  const out = core.cancelJob(id, { cleanupContainers: seam });
  assert.deepEqual(order, ["intent-on-disk"]);
  assert.equal(out.ok, true);
  assert.equal(out.cancelRequested, true);
  assert.equal(out.removed, 1);
  assert.notEqual(out.cleanup, "confirmed", "a running job's runner may still be launching; never confirmed here");
  const hostId = jid("hostjob");
  await core.startJob({ prompt: "p", workFolder: fx.hostDir, jobId: hostId },
    { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]), hermesHomeIsolation: false });
  assert.match(core.cancelJob(hostId, { cleanupContainers: () => { throw new Error("must not run"); } }).error, /only supported for container jobs/);
  assert.ok(!fs.existsSync(path.join(core.JOB_ROOT, hostId, "cancel_requested")));
  assert.match(core.cancelJob("../x").error, /invalid jobId/);
});

test("cancelJob: a cancel that finds no container while the job runs reports a pending launch, not success", async () => {
  const fx = fixture();
  const { id } = await startCtr(fx);
  const out = core.cancelJob(id, { cleanupContainers: () => ({ ok: true, absent: true, removed: 0, remaining: [] }) });
  assert.equal(out.ok, true);
  assert.equal(out.removed, 0);
  assert.equal(out.cleanup, "pending");
  assert.match(out.note, /will not start one|stop it as soon as it exists/);
  const down = core.cancelJob(id, { cleanupContainers: () => ({ ok: false, error: "daemon down" }) });
  assert.equal(down.ok, true, "the intent is on disk; the runner acts on it");
  assert.match(down.warning, /daemon down/);
});

test("cancelJob on a finished job: alreadyFinished only once cleanup is confirmed", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx);
  fs.writeFileSync(path.join(d, "exit.json"), JSON.stringify({ exitCode: 0, container: { cleanup: { confirmed: false, error: "x" } } }));
  fs.writeFileSync(path.join(d, "exit_code"), "0");
  const fail = core.cancelJob(id, { cleanupContainers: () => ({ ok: false, error: "daemon down" }) });
  assert.equal(fail.ok, false);
  assert.equal(fail.alreadyFinished, undefined);
  assert.equal(fail.cleanup, "unconfirmed");
  const still = core.cancelJob(id, { cleanupContainers: () => ({ ok: true, absent: false, removed: 0, remaining: [{ id: CID("f") }] }) });
  assert.equal(still.ok, false);
  const ok = core.cancelJob(id, { cleanupContainers: () => ({ ok: true, absent: true, removed: 1, remaining: [] }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.alreadyFinished, true);
  assert.equal(ok.cleanup, "confirmed");
  assert.equal(core.cancelJob(id, { cleanupContainers: () => { throw new Error("must not run again"); } }).alreadyFinished, true);
});

test("checkJob: a died container job is reaped by label; confirmed only when nothing is left AND no launch is pending", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx, deadLaunch);
  // the docker client the runner started is still alive (pid file names a live process): pending
  fs.writeFileSync(path.join(d, "docker_client.pid"), String(process.pid));
  const s1 = cleanupSeam([{ ok: true, absent: true, removed: 0, remaining: [] }]);
  const r1 = core.checkJob(id, 0, { cleanupContainers: s1.fn });
  assert.equal(r1.status, "died");
  assert.equal(r1.containerCleanup, "unconfirmed", "\"no such container\" while a launch may be pending is not cleanup");
  assert.ok(fs.existsSync(path.join(d, "cancel_requested")), "the reap persists cancel intent for a slow runner");
  // client gone, but the daemon still lists a container that rm could not remove
  fs.writeFileSync(path.join(d, "docker_client.pid"), "999999");
  const r2 = core.checkJob(id, 0, { cleanupContainers: cleanupSeam([{ ok: true, absent: false, removed: 0, remaining: [{ id: CID("g") }] }]).fn });
  assert.equal(r2.containerCleanup, "unconfirmed");
  // client gone, nothing left: confirmed, persisted, and never retried
  const s3 = cleanupSeam([{ ok: true, absent: true, removed: 1, remaining: [] }]);
  assert.equal(core.checkJob(id, 0, { cleanupContainers: s3.fn }).containerCleanup, "confirmed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8")).containerCleanup.confirmed, true);
  assert.equal(core.checkJob(id, 0, { cleanupContainers: () => { throw new Error("must not run"); } }).containerCleanup, "confirmed");
});

test("checkJob: a running container job is never cleaned up, and countActiveJobs never touches docker", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx);
  fs.writeFileSync(path.join(d, "runner_heartbeat"), new Date().toISOString());
  const r = core.checkJob(id, 0, { cleanupContainers: () => { throw new Error("must not run for a running job"); } });
  assert.equal(r.status, "running");
  assert.equal(r.containerCleanup, undefined);
  // a died one: countActiveJobs' status check must not spend docker timeouts on cleanup
  const dead = await startCtr(fx, deadLaunch);
  const opts = [];
  core.countActiveJobs(Date.now(), { check: (jid2, tail, o) => { opts.push(o); return core.checkJob(jid2, tail, o); } });
  assert.ok(opts.length >= 1);
  assert.ok(opts.every((o) => o && o.containerCleanup === false), "the cap count asks for no container cleanup");
  assert.ok(!fs.existsSync(path.join(dead.d, "cancel_requested")), "no reap from the cap count");
});

test("checkJob: a container job's stdout/stderr tails and exit.json tails are redacted (out.log stays raw)", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx);
  const meta = JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8"));
  assert.equal(meta.container.envFile, fs.realpathSync.native(fx.envFile), "the env file PATH is recorded (never a value)");
  // the runner's current token file (a generation checkJob can know about) is redacted by value too
  const CUSTOM = "custom-installation-token-value-0001";
  fs.mkdirSync(path.join(d, "creds")); fs.writeFileSync(path.join(d, "creds", "token"), CUSTOM);
  fs.appendFileSync(path.join(d, "out.log"), `token ${SECRET_GH} and ghp_${"Z".repeat(36)} file ${CUSTOM} b64 ${Buffer.from(CUSTOM).toString("base64")}\n`);
  fs.appendFileSync(path.join(d, "err.log"), `oauth ${SECRET_OAUTH}\n`);
  fs.writeFileSync(path.join(d, "exit.json"), JSON.stringify({ exitCode: 0, stdoutTail: [`x ${SECRET_GH}`], stderrTail: [SECRET_OAUTH],
    container: { cleanup: { confirmed: true } } }));
  fs.writeFileSync(path.join(d, "exit_code"), "0");
  const r = core.checkJob(id, 8000);
  const all = JSON.stringify(r);
  assert.ok(!all.includes(SECRET_GH) && !all.includes(SECRET_OAUTH) && !all.includes("ghp_ZZZ"), all);
  assert.ok(!all.includes(CUSTOM) && !all.includes(Buffer.from(CUSTOM).toString("base64").replace(/=+$/, "")), all);
  assert.match(r.stdout, /token \[REDACTED\]/);
  assert.match(fs.readFileSync(path.join(d, "out.log"), "utf8"), new RegExp(SECRET_GH), "the file on disk is not rewritten");
  // host jobs: tails are returned exactly as before
  const hostId = jid("hostredact");
  await core.startJob({ prompt: "p", workFolder: fx.hostDir, jobId: hostId },
    { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]), hermesHomeIsolation: false });
  fs.appendFileSync(path.join(core.JOB_ROOT, hostId, "out.log"), `ghp_${"Q".repeat(36)}\n`);
  assert.match(core.checkJob(hostId, 8000).stdout, /ghp_QQQ/, "host-mode output is untouched");
});

// ------------------------------------------------------------ review round 2, finding A1 ---

// The liveness check must come BEFORE the authoritative listing: a client that creates its container
// and exits between an (empty) listing and the liveness check used to get the job confirmed with a
// running container. Here the listing seam itself "lets the client exit" (rewrites the pid file to a
// dead pid) after it has returned an empty list.
test("A1: liveness is established before the final listing (client exiting mid-reconcile is not confirmation)", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx, deadLaunch);
  fs.writeFileSync(path.join(d, "docker_launch"), JSON.stringify({ state: "spawned", pid: process.pid, at: new Date().toISOString() }));
  fs.writeFileSync(path.join(d, "docker_client.pid"), String(process.pid));
  const seam = () => { fs.writeFileSync(path.join(d, "docker_client.pid"), "999999");
                       fs.writeFileSync(path.join(d, "docker_launch"), JSON.stringify({ state: "spawned", pid: 999999 }));
                       return { ok: true, absent: true, removed: 0, remaining: [] }; };
  const r = core.checkJob(id, 0, { cleanupContainers: seam });
  assert.equal(r.status, "died");
  assert.equal(r.containerCleanup, "unconfirmed", JSON.stringify(r.containerCleanupError));
});

// Argon #2 (b): a FINISHED job (exit_code present) whose runner recorded cleanup as unconfirmed with
// the docker client still alive (or killed with a create possibly in flight) stays unconfirmed.
test("A1: a finished job's live or just-killed docker client keeps cleanup unconfirmed", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx);
  fs.writeFileSync(path.join(d, "exit.json"), JSON.stringify({ exitCode: null, exitReason: "signal",
    container: { cleanup: { confirmed: false, reason: "the docker client did not exit within the stop wait and was killed" } } }));
  fs.writeFileSync(path.join(d, "exit_code"), "1");
  fs.writeFileSync(path.join(d, "docker_client.pid"), String(process.pid));
  fs.writeFileSync(path.join(d, "docker_launch"), JSON.stringify({ state: "spawned", pid: process.pid, at: new Date().toISOString() }));
  const empty = () => ({ ok: true, absent: true, removed: 0, remaining: [] });
  assert.equal(core.checkJob(id, 0, { cleanupContainers: empty }).containerCleanup, "unconfirmed", "client alive");
  assert.equal(core.cancelJob(id, { cleanupContainers: empty }).alreadyFinished, undefined);
  // the client is gone now, but it was killed moments ago: hold before confirming
  fs.writeFileSync(path.join(d, "docker_launch"), JSON.stringify({ state: "killed", pid: 999999, at: new Date().toISOString() }));
  fs.writeFileSync(path.join(d, "docker_client.pid"), "999999");
  process.env.CLAUDE_ASYNC_CONTAINER_CONFIRM_HOLD_MS = "600000";
  try {
    const held = core.checkJob(id, 0, { cleanupContainers: empty });
    assert.equal(held.containerCleanup, "unconfirmed", "killed client: its create request may still be in flight");
    assert.match(held.containerCleanupError, /killed/);
  } finally { delete process.env.CLAUDE_ASYNC_CONTAINER_CONFIRM_HOLD_MS; }
  // killed long ago: an empty listing confirms
  fs.writeFileSync(path.join(d, "docker_launch"), JSON.stringify({ state: "killed", pid: 999999, at: new Date(Date.now() - 3_600_000).toISOString() }));
  assert.equal(core.checkJob(id, 0, { cleanupContainers: empty }).containerCleanup, "confirmed");
});

// A runner that died before writing any launch state, with no docker client of this job's label
// alive anywhere, is the only "missing state" case that confirms on an empty listing. A live runner
// (even one whose status reads died because its heartbeat lagged) never confirms.
test("A1: missing launch state is uncertain while the runner is alive; confirmed only when nothing of the job's can be found", async () => {
  const fx = fixture();
  const empty = () => ({ ok: true, absent: true, removed: 0, remaining: [] });
  const alive = await startCtr(fx, async () => ({ pid: process.pid, pidSource: "test", launchPath: "test" }));
  fs.writeFileSync(path.join(alive.d, "runner_heartbeat"), new Date(Date.now() - 10 * 60_000).toISOString());
  const r = core.checkJob(alive.id, 0, { cleanupContainers: empty, findDockerClients: () => [] });
  assert.equal(r.status, "running", "stale heartbeat but a live pid reads running (unchanged)");
  const dead = await startCtr(fx, deadLaunch);
  // a docker client process carrying this job's label exists (found by the process scan): pending
  assert.equal(core.checkJob(dead.id, 0, { cleanupContainers: empty, findDockerClients: () => [4242] }).containerCleanup, "unconfirmed");
  assert.equal(core.checkJob(dead.id, 0, { cleanupContainers: empty, findDockerClients: () => [] }).containerCleanup, "confirmed");
});

// Argon #2 (c): a container job whose cleanup is unconfirmed still owns a container's CPU and
// memory, so it counts toward CLAUDE_ASYNC_MAX_CONCURRENT whatever its status says. No docker call
// is made for the count (file reads only).
test("A1: countActiveJobs counts a container job while its cleanup is unconfirmed, confirmed ones not", async () => {
  const fx = fixture();
  const before = core.countActiveJobs(Date.now()).count;
  const unc = await startCtr(fx, deadLaunch);
  fs.writeFileSync(path.join(unc.d, "exit.json"), JSON.stringify({ exitCode: 137, container: { cleanup: { confirmed: false, error: "daemon down" } } }));
  fs.writeFileSync(path.join(unc.d, "exit_code"), "137");
  const conf = await startCtr(fx, deadLaunch);
  fs.writeFileSync(path.join(conf.d, "exit.json"), JSON.stringify({ exitCode: 0, container: { cleanup: { confirmed: true } } }));
  fs.writeFileSync(path.join(conf.d, "exit_code"), "0");
  const deadNoRecord = await startCtr(fx, deadLaunch); // died before docker run; never reconciled yet
  const opts = [];
  const { count } = core.countActiveJobs(Date.now(), { check: (jid2, tail, o) => { opts.push(o); return core.checkJob(jid2, tail, o); } });
  assert.equal(count, before + 2, "the unconfirmed finished job and the unreconciled dead one count; the confirmed one does not");
  assert.ok(opts.every((o) => o && o.containerCleanup === false), "still no docker housekeeping from the cap count");
  assert.ok(!fs.existsSync(path.join(deadNoRecord.d, "cancel_requested")));
  // once a check confirms the dead one, it stops counting
  core.checkJob(deadNoRecord.id, 0, { cleanupContainers: () => ({ ok: true, absent: true, removed: 0, remaining: [] }), findDockerClients: () => [] });
  assert.equal(core.countActiveJobs(Date.now()).count, before + 1);
});

// ------------------------------------------------------------ review round 2, finding A3 ---

const SUBSTRINGS = (secret, n = 8) => { const out = []; for (let i = 0; i + n <= secret.length; i++) out.push(secret.slice(i, i + n)); return out; };
const leaks = (text, secret) => SUBSTRINGS(secret).filter((s) => text.includes(s));

test("A3: redactSecrets has no word-boundary gap (TOKEN_ghp_..., foo_sk-ant-...) and knows the base64 forms git prints", () => {
  const gh = `ghp_${"A".repeat(36)}`;
  assert.equal(c.redactSecrets(`TOKEN_${gh}`, []), "TOKEN_[REDACTED]");
  assert.equal(c.redactSecrets(`x9${gh}`, []), "x9[REDACTED]");
  assert.equal(c.redactSecrets(`foo_sk-ant-oat01-${"B".repeat(20)}`, []), "foo_[REDACTED]");
  assert.equal(c.redactSecrets(`GITHUB_PAT=github_pat_${"C".repeat(30)}`, []), "GITHUB_PAT=[REDACTED]");
  // GIT_TRACE_CURL / GIT_CURL_VERBOSE print "Authorization: Basic base64(x-access-token:<token>)"
  const fx = fixture();
  // the env file's value plus a minted installation token, the way the runner assembles its set
  const values = [...c.readEnvFileSecretValues(fx.envFile), ...c.secretEncodings([SECRET_GH])];
  const basic = Buffer.from(`x-access-token:${SECRET_GH}`).toString("base64");
  const raw64 = Buffer.from(SECRET_GH).toString("base64");
  const oauth64 = Buffer.from(SECRET_OAUTH).toString("base64");
  for (const enc of [basic, raw64, oauth64]) {
    assert.ok(values.includes(enc.replace(/=+$/, "")), `the redaction set includes ${enc.slice(0, 12)}...`);
    const out = c.redactSecrets(`Authorization: Basic ${enc}`, values);
    assert.equal(leaks(out, enc.replace(/=+$/, "")).length, 0, out);
    assert.match(out, /Basic \[REDACTED\]=*$/);
  }
  assert.ok(values.includes(SECRET_GH) && values.includes(SECRET_OAUTH), "the raw values are still first");
});

// tailBytes is caller-controlled (claude_check, GET /v1/check). Whatever window is asked for, no
// reconstructable piece of a secret printed at the end of the log may come back.
test("A3: checkJob redacts before the caller-visible truncation, for every tailBytes offset inside a token", async () => {
  const fx = fixture();
  const { id, d } = await startCtr(fx);
  fs.writeFileSync(path.join(d, "exit.json"), JSON.stringify({ exitCode: 0, container: { cleanup: { confirmed: true } } }));
  fs.writeFileSync(path.join(d, "exit_code"), "0");
  const shape = `ghp_${"Z".repeat(36)}`;
  const secrets = [SECRET_GH, SECRET_OAUTH, shape, `github_pat_${"Y".repeat(40)}`];
  for (const [label, prefix] of [["small file", "first line\n"], ["large file", `${"x".repeat(100_000)}\n`], ["no newline before", "x".repeat(100_000)]]) {
    for (const secret of secrets) {
      fs.writeFileSync(path.join(d, "out.log"), `${prefix}${secret}\n`);
      fs.writeFileSync(path.join(d, "err.log"), `${prefix}${secret}`); // no trailing newline either
      for (let tailBytes = 1; tailBytes <= secret.length + 6; tailBytes++) {
        const r = core.checkJob(id, tailBytes);
        const all = JSON.stringify(r);
        assert.equal(leaks(all, secret).length, 0, `${label}: tailBytes=${tailBytes} leaks ${leaks(all, secret)[0]} of ${secret.slice(0, 6)}... stdout=${JSON.stringify(r.stdout)}`);
      }
    }
  }
  // and a normal, larger window still carries the redacted line and nothing of the secret
  fs.writeFileSync(path.join(d, "out.log"), `hello\ntoken ${SECRET_GH}\n`);
  const r = core.checkJob(id, 8000);
  assert.match(r.stdout, /token \[REDACTED\]/);
  assert.equal(leaks(JSON.stringify(r), SECRET_GH).length, 0);
});

test("A3: host jobs' tails are byte-identical to before (no window change, no redaction)", async () => {
  const fx = fixture();
  const hostId = jid("hosttail");
  await core.startJob({ prompt: "p", workFolder: fx.hostDir, jobId: hostId },
    { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]), hermesHomeIsolation: false });
  const body = `${"a".repeat(50)}\nghp_${"Q".repeat(36)}\n`;
  fs.writeFileSync(path.join(core.JOB_ROOT, hostId, "out.log"), body);
  assert.equal(core.checkJob(hostId, 20).stdout, `…(${body.length - 20} earlier bytes omitted)\n${body.slice(-20)}`);
  assert.equal(core.checkJob(hostId, 8000).stdout, body);
});

// ------------------------------------------------------------ review round 2, finding N2 ---
// Argon #6: the secrets file must never be one of the read-only mount sources, or a misconfigured
// CLAUDE_ASYNC_CONTAINER_CLAUDE_MD would put both raw tokens into the model's instructions.
test("N2: planContainerJob refuses an env file that is the CLAUDE.md mount source or lives in the hooks dir", () => {
  const fx = fixture();
  const asMd = c.planContainerJob({ jobId: "j", repo: REPO, cfg: { ...fx.cfg, claudeMd: fx.envFile }, resolveBin: (b) => b });
  assert.match(asMd.error, /env file .* is the same file as .* \(a container mount source\)/);
  // the env file inside a custom hooks dir
  const hooks = path.join(fx.base, "hooks"); fs.mkdirSync(hooks);
  const envInHooks = path.join(hooks, "container.env"); fs.copyFileSync(fx.envFile, envInHooks);
  const inHooks = c.planContainerJob({ jobId: "j", repo: REPO, cfg: { ...fx.cfg, hooksDir: hooks, envFile: envInHooks }, resolveBin: (b) => b });
  assert.match(inHooks.error, /env file .* is inside/);
  // a sane config still plans
  assert.ok(!c.planContainerJob({ jobId: "j", repo: REPO, jobDir: fx.jobDir, cfg: fx.cfg, resolveBin: (b) => b }).error);
});

// The App's private key: the same placement rules as the secrets file, plus the permission check.
test("planContainerJob: the App key may not be the env file, a mount source, or inside the checkout; permissive modes are refused", { skip: process.platform === "win32" }, () => {
  const fx = fixture();
  const plan = (githubApp) => c.planContainerJob({ jobId: "j", repo: REPO, jobDir: fx.jobDir, cfg: { ...fx.cfg, githubApp: { ...fx.cfg.githubApp, ...githubApp } }, resolveBin: (b) => b });
  fs.chmodSync(fx.envFile, 0o600);
  assert.match(plan({ keyFile: fx.envFile }).error, /key file .* is not a PEM/);
  assert.match(plan({ keyFile: fx.cfg.claudeMd }).error, /key file .* (same file as|is not a PEM|readable by group)/);
  const loose = path.join(fx.base, "loose.pem"); fs.writeFileSync(loose, APP_KEY); fs.chmodSync(loose, 0o644);
  assert.match(plan({ keyFile: loose }).error, /readable by group or others.*chmod 600/);
  const inCheckout = path.join(REPO_DIR, "hooks", `app-test-${process.pid}.pem`);
  fs.writeFileSync(inCheckout, APP_KEY); fs.chmodSync(inCheckout, 0o600);
  try { assert.match(plan({ keyFile: inCheckout }).error, /key file .* is inside/); } finally { fs.rmSync(inCheckout, { force: true }); }
  // and the env file may not be the key file either
  assert.match(c.planContainerJob({ jobId: "j", repo: REPO, jobDir: fx.jobDir, cfg: { ...fx.cfg, envFile: APP_KEY_FILE }, resolveBin: (b) => b }).error, /env file/);
  const ok = plan({});
  assert.ok(!ok.error, ok.error);
  assert.deepEqual(ok.plan.githubApp, { appId: "123456", keyFile: fs.realpathSync.native(APP_KEY_FILE), refreshMs: 45 * 60_000, apiBase: "https://api.github.com" });
  assert.equal(ok.plan.credsDir, path.join(fx.jobDir, "creds"));
  assert.equal(ok.plan.gitName, undefined, "the identity is resolved at preflight from the App, not in the plan");
});

test("resolveGitIdentity: <slug>[bot] and <id>+<slug>[bot]@users.noreply.github.com from the App; CLAUDE_ASYNC_CONTAINER_GIT_NAME/_EMAIL override", () => {
  assert.deepEqual(c.resolveGitIdentity(c.loadContainerConfig(BOT), APP_IDENTITY),
    { gitName: "claunker-jobs[bot]", gitEmail: "98765+claunker-jobs[bot]@users.noreply.github.com" });
  const over = c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_GIT_NAME: "Custom Name", CLAUDE_ASYNC_CONTAINER_GIT_EMAIL: "c@example.com" });
  assert.deepEqual(c.resolveGitIdentity(over, APP_IDENTITY), { gitName: "Custom Name", gitEmail: "c@example.com" });
  // one override alone leaves the other derived
  assert.deepEqual(c.resolveGitIdentity(c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_GIT_NAME: "N" }), APP_IDENTITY),
    { gitName: "N", gitEmail: "98765+claunker-jobs[bot]@users.noreply.github.com" });
  assert.throws(() => c.buildContainerEnv({ cfg: c.loadContainerConfig(BOT), jobId: "j" }), /git identity/);
});

test("startJob: the App preflight receives the plan's app id, key path, repo and API base; its result sets the commit identity", async () => {
  const fx = fixture();
  const seen = [];
  const cap = [];
  const r = await core.startJob({ prompt: "p", jobId: jid("appseam"), sandbox: "container", repo: REPO },
    ctrOpts(fx, { launch: fakeLaunch(cap), checkGitHubApp: async (a) => { seen.push(a); return { installationId: 5, slug: "other-app", botUserId: 7, keyFile: a.keyFile }; } }));
  assert.ok(!r.error, r.error);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].appId, "123456");
  assert.equal(seen[0].keyFile, fs.realpathSync.native(APP_KEY_FILE));
  assert.equal(seen[0].repo, REPO);
  assert.equal(seen[0].apiBase, "https://api.github.com");
  const env = allValuesAfter(cap[0].argv, "-e");
  assert.ok(env.includes("GIT_AUTHOR_NAME=other-app[bot]") && env.includes("GIT_AUTHOR_EMAIL=7+other-app[bot]@users.noreply.github.com"));
  assert.equal(cap[0].launchExtra.container.githubApp.installationId, 5);
});

test("SECRET_PATTERNS: installation tokens (ghs_) and their base64 forms are redacted without a known value", () => {
  const tok = `ghs_${"R".repeat(36)}`;
  const basic = Buffer.from(`x-access-token:${tok}`).toString("base64");
  const raw64 = Buffer.from(tok).toString("base64");
  const out = c.redactSecrets(`a ${tok} b Authorization: Basic ${basic} c ${raw64} d`, []);
  assert.equal(leaks(out, tok).length, 0, out);
  assert.equal(leaks(out, basic).length, 0, out);
  assert.equal(leaks(out, raw64).length, 0, out);
  assert.match(out, /^a \[REDACTED\] b Authorization: Basic \[REDACTED\]=* c \[REDACTED\]=* d$/);
});

// ------------------------------------------------------------ review round 3, finding B1 ---
test("B1: container preflight writes the machine-wide container-mode marker before the launch; host jobs never do", async () => {
  const marker = path.join(os.homedir(), ".claude-async", "container-mode");
  assert.equal(marker, path.join(TMP, "home", ".claude-async", "container-mode"));
  fs.rmSync(marker, { force: true });
  const fx = fixture();
  await core.startJob({ prompt: "p", workFolder: fx.hostDir, jobId: jid("b1host") },
    { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]) });
  assert.ok(!fs.existsSync(marker), "a host job does not mark the machine");
  // a refused container start (preflight error) does not mark it either
  const refused = await core.startJob({ prompt: "p", jobId: jid("b1refused"), sandbox: "container", repo: REPO },
    ctrOpts(fx, { checkGitHubApp: async () => ({ error: "nope" }) }));
  assert.ok(refused.error);
  assert.ok(!fs.existsSync(marker));
  let seenAtLaunch = null;
  const r = await core.startJob({ prompt: "p", jobId: jid("b1ctr"), sandbox: "container", repo: REPO },
    ctrOpts(fx, { launch: async (...a) => { seenAtLaunch = fs.existsSync(marker); return fakeLaunch([])(...a); } }));
  assert.ok(!r.error, r.error);
  assert.equal(seenAtLaunch, true, "the marker exists before the runner (and so any container) is launched");
  const body = fs.readFileSync(marker, "utf8");
  // later container starts keep the original marker
  await core.startJob({ prompt: "p", jobId: jid("b1ctr2"), sandbox: "container", repo: REPO }, ctrOpts(fx, { launch: fakeLaunch([]) }));
  assert.equal(fs.readFileSync(marker, "utf8"), body);
  // a marker that cannot be written refuses the container start (fail closed)
  fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  fs.writeFileSync(path.dirname(marker), "not a dir");
  try {
    const bad = await core.startJob({ prompt: "p", jobId: jid("b1bad"), sandbox: "container", repo: REPO }, ctrOpts(fx, { launch: fakeLaunch([]) }));
    assert.equal(bad.errorCode, "preflight");
    assert.match(bad.error, /container-mode marker/);
  } finally { fs.rmSync(path.dirname(marker), { force: true }); }
});

// ------------------------------------------------------------ review round 3, finding B3 ---
// The process scan for a job's surviving docker client must match the complete label argument, never
// its own scanner (the PowerShell command line contains the needle) and never another job whose id
// merely starts with this one's.
const B3_ID = "claunker.scan-20261102-abcd1234";
test("B3: the label matcher takes only the complete --label argument token", () => {
  const yes = [
    `"C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" run --rm --pull=never --name claude-async-${B3_ID} --label claude-async.job=${B3_ID} --init img`,
    `com.docker.cli.exe run --rm --pull=never --label claude-async.job=${B3_ID}`,
    `docker run --pull=never --label=claude-async.job=${B3_ID} --init`,
    `docker run --pull=never --label "claude-async.job=${B3_ID}" --init`,
  ];
  for (const l of yes) assert.equal(core.processScanMatches(l, B3_ID), true, l);
  const no = [
    // the scanner itself (the old Windows script, and anything quoting the needle)
    `powershell.exe -NoProfile -NonInteractive -Command Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('claude-async.job=${B3_ID}') } | ForEach-Object { $_.ProcessId }`,
    `ps -eo pid=,args= claude-async.job=${B3_ID}`,
    // a longer job id sharing the prefix
    `docker run --rm --label claude-async.job=${B3_ID}0 --init img`,
    `docker run --rm --label claude-async.job=${B3_ID}-retry --init img`,
    `docker run --rm --label claude-async.job=${B3_ID}.2`,
    // a label value that merely contains it
    `docker run --label other=claude-async.job=${B3_ID}`,
    `docker run --label claude-async.jobx=${B3_ID}`,
    // job-core's / the runner's own listing and removal (Argon #1): never a launch
    `docker ps -a --no-trunc --filter label=claude-async.job=${B3_ID} --format {{.ID}}`,
    `docker ps -a --no-trunc --filter label=claude-async.job=${B3_ID} --label claude-async.job=${B3_ID}`,
    `docker rm -f --label claude-async.job=${B3_ID}`,
    `docker inspect --pull=never --label claude-async.job=${B3_ID}`,
    // the label form but not our run (no --pull=never)
    `docker run --rm --label claude-async.job=${B3_ID} img`,
  ];
  for (const l of no) assert.equal(core.processScanMatches(l, B3_ID), false, l);
});

test("B3: the Windows scan script excludes its own $PID and PowerShell processes, and prints pid, name and command line", () => {
  const ps = core.buildWin32ProcessScanScript(B3_ID);
  assert.match(ps, /\$_\.ProcessId -ne \$PID/);
  assert.match(ps, /Contains\('--pull=never'\)/, "Argon #1: only our docker run, never a docker ps --filter label=...");
  assert.match(ps, /powershell/i); assert.match(ps, /pwsh/i);
  assert.ok(ps.includes(`claude-async.job=${B3_ID}`));
  // findDockerClientsForJob on win32 (seamed spawnSync): only the real client survives the JS-side
  // filter too, even if the script's own line (or a pwsh one) came back
  const out = [
    `4242\tpowershell.exe\t${"powershell.exe -NoProfile -Command " + ps}`,
    `4343\tpwsh.exe\tpwsh -c "... --label claude-async.job=${B3_ID} ..."`,
    `5000\tdocker.exe\tdocker.exe run --rm --pull=never --label claude-async.job=${B3_ID} --init img`,
    `5001\tcom.docker.cli.exe\tcom.docker.cli.exe run --rm --pull=never --label claude-async.job=${B3_ID} --init img`,
    `5002\tdocker.exe\tdocker.exe run --rm --label claude-async.job=${B3_ID}9 --init img`,
  ].join("\r\n") + "\r\n";
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: out, pid: 4242 }; };
  assert.deepEqual(core.findDockerClientsForJob(B3_ID, { spawnSync: run, platform: "win32" }), [5000, 5001]);
  assert.equal(calls[0][0], "powershell.exe");
  // nothing matching -> []
  assert.deepEqual(core.findDockerClientsForJob(B3_ID, { spawnSync: () => ({ status: 0, stdout: "", pid: 1 }), platform: "win32" }), []);
  // a failed scan stays uncertain
  assert.equal(core.findDockerClientsForJob(B3_ID, { spawnSync: () => ({ status: 1, stdout: "" }), platform: "win32" }), null);
});

test("B3: the POSIX scan matches the exact token and excludes the ps process itself", () => {
  const out = [
    `  100 ps -eo pid=,args= --label claude-async.job=${B3_ID}`,
    `  200 docker run --rm --pull=never --label claude-async.job=${B3_ID} --init img`,
    `  300 docker run --rm --label claude-async.job=${B3_ID}0 --init img`,
    `  400 node fake-docker.mjs __creator x -- run --rm --pull=never --label claude-async.job=${B3_ID}`,
  ].join("\n");
  assert.deepEqual(core.findDockerClientsForJob(B3_ID, { spawnSync: () => ({ status: 0, stdout: out, pid: 100 }), platform: "linux" }), [200, 400]);
  // the real ps on this machine: no such job -> []
  if (process.platform !== "win32") assert.deepEqual(core.findDockerClientsForJob(`${B3_ID}-nothing-runs-this`), []);
});

// ------------------------------------------------------------ review round 3, finding B2 ---
test("B2: classifyClientExit: only an exit after the container was seen running, or a POSIX exit status of the client's own, is conclusive", () => {
  const k = c.classifyClientExit;
  assert.equal(k({ observedRunning: true, code: null, signal: "SIGKILL", platform: "win32" }), "exited");
  assert.equal(k({ observedRunning: true, code: 1, signal: null, platform: "win32" }), "exited");
  assert.equal(k({ observedRunning: false, code: 0, signal: null, platform: "linux" }), "exited", "POSIX: an exit status is the client's own");
  assert.equal(k({ observedRunning: false, code: null, signal: "SIGKILL", platform: "linux" }), "exited-uncertain", "killed by someone else");
  assert.equal(k({ observedRunning: false, code: null, signal: "SIGTERM", platform: "darwin" }), "exited-uncertain");
  // win32: TerminateProcess shows up as an ordinary exit code, so without the observation nothing is conclusive
  for (const code of [0, 1, 125, 137]) assert.equal(k({ observedRunning: false, code, signal: null, platform: "win32" }), "exited-uncertain", String(code));
});

test("B3 / Argon #1: live processes: a `docker ps --filter label=...` and a `docker rm` are never launch clients; a `run --pull=never --label` one is", { skip: process.platform === "win32" }, async () => {
  const id = `${B3_ID}-live-${crypto.randomBytes(3).toString("hex")}`;
  const keep = "setTimeout(() => {}, 20000)";
  const kids = [
    spawnAsync(process.execPath, ["-e", keep, "--", "docker", "ps", "-a", "--no-trunc", "--filter", `label=claude-async.job=${id}`, "--format", "{{.ID}}"]),
    spawnAsync(process.execPath, ["-e", keep, "--", "docker", "rm", "-f", "--label", `claude-async.job=${id}`]),
    spawnAsync(process.execPath, ["-e", keep, "--", "docker", "run", "--rm", "--pull=never", "--label", `claude-async.job=${id}x`]),
  ];
  const client = spawnAsync(process.execPath, ["-e", keep, "--", "docker", "run", "--rm", "--pull=never", "--name", `claude-async-${id}`, "--label", `claude-async.job=${id}`, "img"]);
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(core.findDockerClientsForJob(id), [client.pid], "only the run client");
  } finally { for (const k of [...kids, client]) k.kill("SIGKILL"); }
});

// ------------------------------------------------------------ review round 3: Windows ACLs ---
test("R3: buildCredsDirIcaclsArgv removes inheritance and grants only the user and SYSTEM (by SID)", () => {
  assert.deepEqual(c.buildCredsDirIcaclsArgv("C:\\Users\\Raide\\.claude-async-jobs\\j1\\creds", { USERNAME: "Raide", USERDOMAIN: "CLAUNKER" }),
    ["C:\\Users\\Raide\\.claude-async-jobs\\j1\\creds", "/inheritance:r", "/grant:r", "CLAUNKER\\Raide:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"]);
  assert.deepEqual(c.buildCredsDirIcaclsArgv("D:\\x", { USERNAME: "Raide" }), ["D:\\x", "/inheritance:r", "/grant:r", "Raide:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"]);
  assert.throws(() => c.buildCredsDirIcaclsArgv("D:\\x", {}), /USERNAME/);
  assert.throws(() => c.buildCredsDirIcaclsArgv("D:\\x", { USERNAME: "a:b" }), /USERNAME/);
});
