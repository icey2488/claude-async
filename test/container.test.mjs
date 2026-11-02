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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-async-container-test-"));
process.env.CLAUDE_ASYNC_JOB_DIR = path.join(TMP, "jobs");
process.env.CLAUNKER_JOBCARD_CMD = JSON.stringify(["__no_such_jobcard_binary__"]);
for (const k of ["CLAUDE_ASYNC_JOB_SANDBOX", "CLAUDE_ASYNC_JOB_TOOL_GATE", "CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS",
                 "CLAUDE_ASYNC_DEPTH"]) delete process.env[k];
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const c = await import("../container.mjs");
const core = await import("../job-core.mjs");
const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const BOT = { CLAUDE_ASYNC_CONTAINER_GIT_NAME: "claunker-bot",
              CLAUDE_ASYNC_CONTAINER_GIT_EMAIL: "123+claunker-bot@users.noreply.github.com" };
const SECRET_GH = "ghp_TESTSECRETVALUE0000000000000000000000";
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
  fs.writeFileSync(envFile, `GH_TOKEN=${SECRET_GH}\nCLAUDE_CODE_OAUTH_TOKEN=${SECRET_OAUTH}\n`);
  const env = { ...BOT, CLAUDE_ASYNC_CONTAINER_ALLOWED_REPOS: `${REPO}, icey2488/claude-async`, CLAUDE_ASYNC_CONTAINER_ENV_FILE: envFile };
  return { base, hostDir, envFile, env, cfg: c.loadContainerConfig(env) };
}

const realpath = (p) => fs.realpathSync.native(p);

function planFor(fx, overrides = {}, { repo = REPO, baseRef } = {}) {
  const r = c.planContainerJob({ jobId: "claunker.t-20261101-abcd1234", repo, baseRef,
                                 cfg: { ...fx.cfg, ...overrides }, resolveBin: (b) => b });
  assert.ok(!r.error, r.error);
  return { ...r.plan, hostCpus: 16 }; // pin the CPU clamp so argv doesn't depend on the test machine
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

test("resolveSandbox: off by default; only the exact env value \"container\" turns the default on", () => {
  assert.deepEqual(c.resolveSandbox(undefined, undefined), { mode: "host" });
  for (const v of ["", "1", "true", "Container", "CONTAINER", " container", "docker"]) {
    assert.deepEqual(c.resolveSandbox(undefined, v), { mode: "host" }, `env ${JSON.stringify(v)}`);
  }
  assert.deepEqual(c.resolveSandbox(undefined, "container"), { mode: "container" });
});

test("resolveSandbox: an explicit request wins in both directions; anything else is refused", () => {
  assert.deepEqual(c.resolveSandbox("host", "container"), { mode: "host" });
  assert.deepEqual(c.resolveSandbox("container", undefined), { mode: "container" });
  for (const bad of ["docker", "Container", "vm", 1, true]) assert.ok(c.resolveSandbox(bad).error, `refuses ${JSON.stringify(bad)}`);
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
  assert.equal(mounts.length, 2);
  assert.match(mounts[0], /^type=bind,source=.+CLAUDE\.md,target=\/home\/agent\/\.claude\/CLAUDE\.md,readonly$/);
  assert.match(mounts[1], /^type=bind,source=.+hooks,target=\/opt\/claude-async\/hooks,readonly$/);
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
  assert.equal(env.GIT_AUTHOR_NAME, "claunker-bot");
  assert.equal(env.GIT_COMMITTER_EMAIL, "123+claunker-bot@users.noreply.github.com");
  assert.equal(env.OLLAMA_HOST, "http://host.docker.internal:11434");
  assert.equal(env.CLAUDE_ASYNC_JOB_ID, "claunker.t-20261101-abcd1234");
});

test("buildContainerEnv: extraEnv secrets are dropped, and the name guard throws on a secret-like key", () => {
  const cfg = c.loadContainerConfig(BOT);
  const env = c.buildContainerEnv({ cfg, jobId: "j", extraEnv: { GH_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "y" } });
  assert.ok(!env.some(([k]) => k === "GH_TOKEN" || k === "CLAUDE_CODE_OAUTH_TOKEN"));
  // The guard itself: FORWARDED_ENV_KEYS is frozen, so exercise it through a config value whose
  // name it would produce if the allowlist ever grew a secret-like entry.
  assert.ok(c.FORWARDED_ENV_KEYS.every((k) => !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(k)));
  assert.throws(() => Object.defineProperty(c.FORWARDED_ENV_KEYS, 0, { value: "GH_TOKEN" }));
});

test("phase 2 egress proxy: proxy env is added only when configured", () => {
  const fx = fixture();
  const names = (argv) => allValuesAfter(argv, "-e").map((e) => e.split("=")[0]);
  assert.ok(!names(sampleArgv(fx).argv).includes("HTTPS_PROXY"));
  const { argv } = sampleArgv(fx, { cfg: { egressProxy: "http://egress-proxy:3128", network: "claude-jobs" } });
  assert.ok(allValuesAfter(argv, "-e").includes("HTTPS_PROXY=http://egress-proxy:3128"));
  assert.equal(valueAfter(argv, "--network"), "claude-jobs");
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
  for (const bad of ["-main", "--upload-pack=x", "a..b", "HEAD@{1}", "a/", "x.lock", "a//b", "a b", "a;b", "a\nb", "$(x)", 1]) {
    assert.ok(c.validateBaseRef(bad).error, `refuses ${JSON.stringify(bad)}`);
  }
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

test("the removed host-mount machinery is gone (no workFolder validation, no allowed roots, no .git audit)", () => {
  for (const name of ["validateWorkFolder", "auditRepoGitState"]) assert.equal(c[name], undefined, name);
  const cfg = c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS: "D:\\code" });
  assert.equal(cfg.allowedRoots, undefined);
  assert.equal(cfg.deniedRoots, undefined);
});

// -------------------------------------------------------------------------- secrets file ---

test("checkEnvFile: returns key names only, never values", () => {
  const fx = fixture();
  const r = c.checkEnvFile(fx.envFile);
  assert.deepEqual(r.keys, ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.ok(!JSON.stringify(r).includes(SECRET_GH) && !JSON.stringify(r).includes(SECRET_OAUTH));
});

test("checkEnvFile: refuses unknown keys (ANTHROPIC_API_KEY), bare keys, empties, dupes, CRLF, BOM, missing keys", () => {
  const fx = fixture();
  const cases = [
    [`GH_TOKEN=a\nCLAUDE_CODE_OAUTH_TOKEN=b\nANTHROPIC_API_KEY=${SECRET_GH}\n`, /ANTHROPIC_API_KEY.*not allowed/],
    ["GH_TOKEN=a\nCLAUDE_CODE_OAUTH_TOKEN\n", /not KEY=value/],
    ["GH_TOKEN=a\nCLAUDE_CODE_OAUTH_TOKEN=\n", /is empty/],
    ["GH_TOKEN=a\nGH_TOKEN=b\nCLAUDE_CODE_OAUTH_TOKEN=c\n", /appears twice/],
    ["GH_TOKEN=a\r\nCLAUDE_CODE_OAUTH_TOKEN=b\r\n", /CRLF/],
    ["\ufeffGH_TOKEN=a\nCLAUDE_CODE_OAUTH_TOKEN=b\n", /BOM/],
    ["GH_TOKEN=a\n", /missing CLAUDE_CODE_OAUTH_TOKEN/],
  ];
  for (const [body, re] of cases) {
    fs.writeFileSync(fx.envFile, body);
    const r = c.checkEnvFile(fx.envFile);
    assert.match(r.error || "", re, JSON.stringify(body));
    assert.ok(!r.error.includes(SECRET_GH), "error text never carries a value");
  }
  fs.writeFileSync(fx.envFile, "# comment\n\nGH_TOKEN=a\nCLAUDE_CODE_OAUTH_TOKEN=b\n");
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

// -------------------------------------------------------------------------------- config ---

test("validateContainerConfig: refuses host/none networks, bad limits, missing bot identity", () => {
  const ok = c.loadContainerConfig(BOT);
  assert.deepEqual(c.validateContainerConfig(ok), []);
  assert.ok(c.validateContainerConfig({ ...ok, network: "host" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, network: "none" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, cpus: "0" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, cpus: "--privileged" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, memory: "lots" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, pidsLimit: "10" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, image: "--privileged" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, gitName: null }).length);
  assert.ok(c.validateContainerConfig({ ...ok, gitEmail: "not an email" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, ollamaUrl: "http://u:p@evil/" }).length);
  assert.ok(c.validateContainerConfig({ ...ok, egressProxy: "socks5://x" }).length);
});

// ---------------------------------------------------------------------------- kill / audit ---

test("kill targets the container by name, never a pid", () => {
  assert.deepEqual(c.buildKillArgv("claude-async-claunker.x-20261101-abcd1234"), ["kill", "claude-async-claunker.x-20261101-abcd1234"]);
  assert.throws(() => c.buildKillArgv("some-other-container"));
  assert.throws(() => c.buildKillArgv(1234));
  const calls = [];
  const fake = (bin, args) => { calls.push([bin, args]); return { status: 0, stdout: "x", stderr: "" }; };
  assert.deepEqual(c.killContainer({ dockerBin: "docker", name: "claude-async-j", spawnSync: fake }), { ok: true, killed: true });
  assert.deepEqual(calls, [["docker", ["kill", "claude-async-j"]]]);
  const gone = () => ({ status: 1, stdout: "", stderr: "Error response from daemon: No such container: claude-async-j" });
  assert.deepEqual(c.killContainer({ dockerBin: "docker", name: "claude-async-j", spawnSync: gone }), { ok: true, killed: false });
  const down = () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" });
  assert.equal(c.killContainer({ dockerBin: "docker", name: "claude-async-j", spawnSync: down }).ok, false);
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
const ctrOpts = (fx, extra = {}) => ({ caps: CAPS, containerConfig: { ...fx.cfg, dockerBin: process.execPath },
                                       checkImage: () => ({ ok: true, imageId: `sha256:${"ab".repeat(32)}` }), ...extra });

test("startJob: with container mode off (default), argv/command/env are what they were before container mode", async () => {
  const fx = fixture();
  const a = [], b = [];
  const base = { prompt: "hello", workFolder: fx.hostDir };
  const opts = { claudeBin: process.execPath, caps: CAPS, hermesHomeIsolation: false, toolGate: false, safePermissions: false };
  const r1 = await core.startJob({ ...base, jobId: jid("off-a") }, { ...opts, launch: fakeLaunch(a) });
  const r2 = await core.startJob({ ...base, jobId: jid("off-b"), sandbox: "host" },
    { ...opts, launch: fakeLaunch(b), sandboxDefault: "container" });
  for (const r of [r1, r2]) { assert.ok(!r.error, r.error); assert.equal(r.sandbox, undefined); assert.equal(r.container, undefined); }
  assert.deepEqual(a[0].argv, b[0].argv, "sandbox:\"host\" over a container default is identical to the default");
  assert.equal(a[0].command, process.execPath);
  assert.equal(a[0].cwd, fx.hostDir, "host jobs still run in workFolder");
  assert.equal(a[0].argv[0], "-p");
  assert.ok(a[0].argv.includes("--dangerously-skip-permissions"));
  assert.ok(!a[0].argv.includes("run") && !a[0].argv.includes("--rm"));
  assert.deepEqual(a[0].launchExtra, {}, "no container record for host jobs");
  // The literal pre-container argv shape for this input (prompt/model/effort/settings layout).
  const i = a[0].argv.indexOf("--settings");
  assert.deepEqual(a[0].argv.slice(0, i), ["-p", "hello", "--strict-mcp-config", "--mcp-config",
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
  assert.equal(argv.at(-1), "--version do it");
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
  assert.deepEqual(Object.keys(launchExtra.container).sort(), ["dockerBin", "name", "repo"]);
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
    [{}, { cfg: { gitName: null } }, /GIT_NAME/],
    [{}, { image: () => ({ error: "docker image claude-async-job:local is not built on this host" }) }, /not built/],
    [{}, { cfg: { dockerBin: path.join(fx.base, "no-docker.exe") } }, /docker binary/],
  ];
  for (const [args, o, re] of cases) {
    const id = jid("pf");
    const r = await core.startJob({ prompt: "p", jobId: id, sandbox: "container", repo: REPO, ...args },
      ctrOpts(fx, { launch: fakeLaunch([]), containerConfig: { ...fx.cfg, dockerBin: process.execPath, ...(o.cfg || {}) },
                    ...(o.image ? { checkImage: o.image } : {}) }));
    assert.equal(r.errorCode, "preflight", JSON.stringify(r));
    assert.match(r.error, re);
    assert.ok(!fs.existsSync(path.join(core.JOB_ROOT, id)), "no job dir on refusal");
  }
});

test("cancelJob: kills a running container job by name; refuses host jobs; no-op once finished", async () => {
  const fx = fixture();
  const id = jid("cancel");
  const r2 = await core.startJob({ prompt: "p", jobId: id, sandbox: "container", repo: REPO }, ctrOpts(fx, { launch: fakeLaunch([]) }));
  assert.ok(!r2.error, r2.error);
  const kills = [];
  const out = core.cancelJob(id, { killContainer: (a) => { kills.push(a); return { ok: true, killed: true }; } });
  assert.deepEqual(out.ok, true);
  assert.deepEqual(kills, [{ dockerBin: process.execPath, name: `claude-async-${id}` }]);
  fs.writeFileSync(path.join(core.JOB_ROOT, id, "exit_code"), "137");
  assert.equal(core.cancelJob(id, { killContainer: () => { throw new Error("must not kill"); } }).alreadyFinished, true);

  const hostId = jid("hostjob");
  await core.startJob({ prompt: "p", workFolder: fx.hostDir, jobId: hostId },
    { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]), hermesHomeIsolation: false });
  assert.match(core.cancelJob(hostId, { killContainer: () => { throw new Error("must not kill"); } }).error, /only supported for container jobs/);
  assert.match(core.cancelJob("../x").error, /invalid jobId/);
});

test("checkJob: a died container job gets its container killed once (reap)", async () => {
  const fx = fixture();
  const id = jid("reap");
  const r = await core.startJob({ prompt: "p", jobId: id, sandbox: "container", repo: REPO },
    ctrOpts(fx, { launch: async () => ({ pid: 999999, pidSource: "test", launchPath: "test" }) }));
  assert.ok(!r.error, r.error);
  const kills = [];
  const killContainer = (a) => { kills.push(a.name); return { ok: true, killed: true }; };
  // No heartbeat file and a dead pid: classified "died".
  const s = core.checkJob(id, 0, { killContainer });
  assert.equal(s.status, "died");
  assert.deepEqual(kills, [`claude-async-${id}`]);
  core.checkJob(id, 0, { killContainer });
  assert.equal(kills.length, 1, "reaped only once");
});
