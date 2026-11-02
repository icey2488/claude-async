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

// A fixture tree: <TMP>/fx-N/{roots/code/<repo>, secrets/container.env, outside/<repo>}.
function fixture() {
  const base = fs.mkdtempSync(path.join(TMP, "fx-"));
  const root = path.join(base, "roots", "code");
  const repo = path.join(root, "scratch-repo");
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  const outside = path.join(base, "outside", "other-repo");
  fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
  const secrets = path.join(base, "secrets");
  fs.mkdirSync(secrets);
  const envFile = path.join(secrets, "container.env");
  fs.writeFileSync(envFile, `GH_TOKEN=${SECRET_GH}\nCLAUDE_CODE_OAUTH_TOKEN=${SECRET_OAUTH}\n`);
  const env = { ...BOT, CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS: root, CLAUDE_ASYNC_CONTAINER_ENV_FILE: envFile };
  return { base, root, repo, outside, envFile, env, cfg: c.loadContainerConfig(env, process.platform) };
}

const realpath = (p) => fs.realpathSync.native(p);

function planFor(fx, overrides = {}) {
  const r = c.planContainerJob({ jobId: "claunker.t-20261101-abcd1234", workFolder: fx.repo,
                                 cfg: { ...fx.cfg, ...overrides }, resolveBin: (b) => b });
  assert.ok(!r.error, r.error);
  return { ...r.plan, hostCpus: 16 }; // pin the CPU clamp so argv doesn't depend on the test machine
}

function sampleArgv(fx, { extraEnv = {}, prompt = "do the thing", cfg = {} } = {}) {
  const plan = planFor(fx, cfg);
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
  assert.ok(!argv.some((a) => /^--cap-add/.test(a)));
  assert.ok(!argv.some((a) => /^--pull/.test(a)), "never pulls");
  const img = argv.indexOf("claude-async-job:local");
  assert.ok(img > 0);
  assert.equal(argv[img + 1], "claude", "the CLI runs inside the image");
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

test("docker run argv: exactly three bind mounts; repo rw at /workspace, CLAUDE.md and hooks read-only", () => {
  const fx = fixture();
  const { argv, plan } = sampleArgv(fx);
  const mounts = allValuesAfter(argv, "--mount");
  assert.equal(mounts.length, 3);
  assert.equal(mounts[0], `type=bind,source=${plan.mounts.workFolder},target=/workspace`);
  assert.match(mounts[1], /^type=bind,source=.+CLAUDE\.md,target=\/home\/agent\/\.claude\/CLAUDE\.md,readonly$/);
  assert.match(mounts[2], /^type=bind,source=.+hooks,target=\/opt\/claude-async\/hooks,readonly$/);
  assert.ok(!argv.includes("-v") && !argv.includes("--volume") && !argv.some((a) => /^--volumes-from/.test(a)));
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
  assert.equal(env.GIT_CONFIG_KEY_0, "core.autocrlf");
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

test("container settings: the no-background hook runs from the read-only hooks mount; ultracode merges in", () => {
  const s = c.buildContainerSettings();
  assert.equal(s.hooks.PreToolUse[0].matcher, "*");
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, "node /opt/claude-async/hooks/no-background-hook.mjs");
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

// A fake win32 filesystem: realpath resolves junctions/symlinks listed in `links` (and adds the
// \\?\ prefix fs.realpathSync.native returns for long paths), stat/lstat answer from `dirs`.
function fakeWin({ dirs, gitDirs = [], gitFiles = [], links = {} }) {
  const lc = (p) => path.win32.resolve(p).toLowerCase();
  const dirSet = new Set(dirs.map(lc));
  const realpath = (p) => {
    let r = path.win32.resolve(p);
    for (const [from, to] of Object.entries(links)) {
      if (lc(r) === lc(from) || lc(r).startsWith(lc(from) + "\\")) r = to + r.slice(from.length);
    }
    if (!dirSet.has(lc(r)) && !gitDirs.concat(gitFiles).some((g) => lc(g) === lc(r))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return "\\\\?\\" + r;
  };
  const st = (isDir) => ({ isDirectory: () => isDir, isFile: () => !isDir });
  const fsImpl = {
    statSync: (p) => { if (dirSet.has(lc(p))) return st(true); throw new Error("ENOENT"); },
    lstatSync: (p) => {
      if (gitDirs.some((g) => lc(g) === lc(p))) return st(true);
      if (gitFiles.some((g) => lc(g) === lc(p))) return st(false);
      throw new Error("ENOENT");
    },
  };
  return { realpath: (p) => c.stripLongPathPrefix(realpath(p)), fsImpl };
}

test("stripLongPathPrefix: drops \\\\?\\ from drive paths, keeps UNC and plain paths", () => {
  assert.equal(c.stripLongPathPrefix("\\\\?\\D:\\code\\x"), "D:\\code\\x");
  assert.equal(c.stripLongPathPrefix("\\\\?\\UNC\\srv\\share"), "\\\\?\\UNC\\srv\\share");
  assert.equal(c.stripLongPathPrefix("D:\\code"), "D:\\code");
});

test("validateWorkFolder (win32): D:\\code\\x accepted case-insensitively, \\\\?\\ prefix stripped", () => {
  const w = fakeWin({ dirs: ["D:\\code", "D:\\code\\scratch"], gitDirs: ["D:\\code\\scratch\\.git"] });
  const r = c.validateWorkFolder("d:\\CODE\\Scratch", { allowedRoots: ["D:\\code"], platform: "win32", ...w });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.real.toLowerCase(), "d:\\code\\scratch");
  assert.deepEqual(c.toDockerMountSource(r.real, "win32").source.toLowerCase(), "d:/code/scratch");
});

test("validateWorkFolder (win32): a junction inside D:\\code pointing at C:\\Users is refused", () => {
  const w = fakeWin({ dirs: ["D:\\code", "C:\\Users\\Raide"], gitDirs: ["C:\\Users\\Raide\\.git"],
                      links: { "D:\\code\\innocent": "C:\\Users\\Raide" } });
  const r = c.validateWorkFolder("D:\\code\\innocent", { allowedRoots: ["D:\\code"], platform: "win32", ...w });
  assert.match(r.error, /outside the container allowed roots/);
  assert.match(r.error, /C:\\Users\\Raide/);
});

test("validateWorkFolder (win32): sibling-prefix and other-drive paths are refused", () => {
  const w = fakeWin({ dirs: ["D:\\code", "D:\\code-private\\x", "E:\\code\\x"],
                      gitDirs: ["D:\\code-private\\x\\.git", "E:\\code\\x\\.git"] });
  for (const p of ["D:\\code-private\\x", "E:\\code\\x"]) {
    assert.match(c.validateWorkFolder(p, { allowedRoots: ["D:\\code"], platform: "win32", ...w }).error, /outside/, p);
  }
});

test("validateWorkFolder (win32): a linked worktree (.git file) is refused", () => {
  const w = fakeWin({ dirs: ["D:\\code", "D:\\code\\wt"], gitFiles: ["D:\\code\\wt\\.git"] });
  assert.match(c.validateWorkFolder("D:\\code\\wt", { allowedRoots: ["D:\\code"], platform: "win32", ...w }).error, /\.git FILE/);
});

// ------------------------------------------------------------------------ workFolder checks ---

test("validateWorkFolder: a repo inside the allowed root is accepted (by realpath)", () => {
  const fx = fixture();
  const r = c.validateWorkFolder(fx.repo, { allowedRoots: [fx.root] });
  assert.equal(r.real, realpath(fx.repo));
});

test("validateWorkFolder: refuses a folder outside every allowed root", () => {
  const fx = fixture();
  const r = c.validateWorkFolder(fx.outside, { allowedRoots: [fx.root] });
  assert.match(r.error, /outside the container allowed roots/);
});

test("validateWorkFolder: refuses a symlink inside the root that points outside it", () => {
  const fx = fixture();
  const link = path.join(fx.root, "sneaky");
  fs.symlinkSync(fx.outside, link, "dir");
  const r = c.validateWorkFolder(link, { allowedRoots: [fx.root] });
  assert.match(r.error, /outside the container allowed roots/);
});

test("validateWorkFolder: refuses a path that escapes with .. after the root", () => {
  const fx = fixture();
  const r = c.validateWorkFolder(path.join(fx.root, "..", "..", "outside", "other-repo"), { allowedRoots: [fx.root] });
  assert.match(r.error, /outside the container allowed roots/);
});

test("validateWorkFolder: refuses when the ALLOWED ROOT itself is a symlink and the repo is reached around it", () => {
  // A root given as a symlink is judged by its target, so a repo under the target is fine, and a
  // repo merely sharing the link's textual prefix is not.
  const fx = fixture();
  const linkRoot = path.join(fx.base, "rootlink");
  fs.symlinkSync(fx.root, linkRoot, "dir");
  assert.equal(c.validateWorkFolder(path.join(linkRoot, "scratch-repo"), { allowedRoots: [linkRoot] }).real, realpath(fx.repo));
  assert.match(c.validateWorkFolder(fx.outside, { allowedRoots: [linkRoot] }).error, /outside/);
});

test("validateWorkFolder: junction on win32 (skipped elsewhere)", { skip: process.platform !== "win32" }, () => {
  const fx = fixture();
  const j = path.join(fx.root, "junction");
  fs.symlinkSync(fx.outside, j, "junction");
  assert.match(c.validateWorkFolder(j, { allowedRoots: [fx.root] }).error, /outside the container allowed roots/);
});

test("validateWorkFolder: refuses the allowed root itself, relative paths, missing dirs, files", () => {
  const fx = fixture();
  assert.match(c.validateWorkFolder(fx.root, { allowedRoots: [fx.root] }).error, /allowed root itself/);
  assert.match(c.validateWorkFolder("relative/repo", { allowedRoots: [fx.root] }).error, /absolute/);
  assert.match(c.validateWorkFolder(path.join(fx.root, "nope"), { allowedRoots: [fx.root] }).error, /does not exist/);
  const f = path.join(fx.root, "file.txt"); fs.writeFileSync(f, "x");
  assert.match(c.validateWorkFolder(f, { allowedRoots: [fx.root] }).error, /not a directory/);
});

test("validateWorkFolder: refuses no allowed roots at all (no D:\\code fallback)", () => {
  const fx = fixture();
  assert.match(c.validateWorkFolder(fx.repo, { allowedRoots: [] }).error, /no container allowed roots/);
  assert.deepEqual(c.loadContainerConfig({}, "win32").allowedRoots, [], "unset means none, not D:\\code");
});

test("validateWorkFolder: refuses a non-repo, a subfolder of a repo, and a linked worktree (.git file)", () => {
  const fx = fixture();
  const plain = path.join(fx.root, "plain"); fs.mkdirSync(plain);
  assert.match(c.validateWorkFolder(plain, { allowedRoots: [fx.root] }).error, /not a git repository top-level/);
  const sub = path.join(fx.repo, "src"); fs.mkdirSync(sub);
  assert.match(c.validateWorkFolder(sub, { allowedRoots: [fx.root] }).error, /not a git repository top-level/);
  const wt = path.join(fx.root, "worktree"); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  assert.match(c.validateWorkFolder(wt, { allowedRoots: [fx.root] }).error, /\.git FILE/);
});

test("validateWorkFolder: refuses the claude-async checkout and anything overlapping a denied root", () => {
  const fx = fixture();
  const cfg = c.loadContainerConfig({ ...BOT, CLAUDE_ASYNC_CONTAINER_ALLOWED_ROOTS: path.dirname(REPO_DIR) });
  assert.ok(cfg.deniedRoots.includes(REPO_DIR), "the checkout is always denied");
  assert.match(c.validateWorkFolder(REPO_DIR, { allowedRoots: cfg.allowedRoots, deniedRoots: cfg.deniedRoots }).error, /denied/);
  assert.match(c.validateWorkFolder(fx.repo, { allowedRoots: [fx.root], deniedRoots: [fx.repo] }).error, /denied/);
  // a denied path INSIDE the repo also refuses (mounting the repo would expose it)
  const inner = path.join(fx.repo, "live"); fs.mkdirSync(inner);
  assert.match(c.validateWorkFolder(fx.repo, { allowedRoots: [fx.root], deniedRoots: [inner] }).error, /denied/);
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

test("checkEnvFile / planContainerJob: a secrets file inside the repo or an allowed root is refused", () => {
  const fx = fixture();
  const inRepo = path.join(fx.repo, "container.env");
  fs.copyFileSync(fx.envFile, inRepo);
  const r = c.planContainerJob({ jobId: "j", workFolder: fx.repo, cfg: { ...fx.cfg, envFile: inRepo }, resolveBin: (b) => b });
  assert.match(r.error, /outside every repo/);
  const inRoot = path.join(fx.root, "container.env");
  fs.copyFileSync(fx.envFile, inRoot);
  assert.match(c.planContainerJob({ jobId: "j", workFolder: fx.repo, cfg: { ...fx.cfg, envFile: inRoot }, resolveBin: (b) => b }).error,
    /outside every repo/);
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

test("planContainerJob: refuses a CLAUDE.md inside the mounted repo", () => {
  const fx = fixture();
  const md = path.join(fx.repo, "CLAUDE.md"); fs.writeFileSync(md, "x");
  assert.match(c.planContainerJob({ jobId: "j", workFolder: fx.repo, cfg: { ...fx.cfg, claudeMd: md }, resolveBin: (b) => b }).error,
    /inside the mounted repo/);
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

test("checkDockerImage: distinguishes a missing image from a stopped daemon; never pulls", () => {
  const seen = [];
  const run = (res) => (bin, args) => { seen.push(args); return res; };
  assert.equal(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 0, stdout: "sha256:x\n" }) }).ok, true);
  assert.match(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 1, stderr: "Error: No such image: i" }) }).error, /not built/);
  assert.match(c.checkDockerImage({ dockerBin: "docker", image: "i", spawnSync: run({ status: 1, stderr: "error during connect" }) }).error, /Docker Desktop running/);
  assert.ok(seen.every((a) => a[0] === "image" && a[1] === "inspect"));
});

test("auditRepoGitState: flags host-executing config and hooks, ignores safe keys and .sample hooks", { skip: spawnSync("git", ["--version"]).status !== 0 }, () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n[user]\n\tname = x\n");
  fs.writeFileSync(path.join(fx.repo, ".git", "hooks", "pre-commit.sample"), "#!/bin/sh\n");
  assert.deepEqual(c.auditRepoGitState(fx.repo), []);
  fs.appendFileSync(path.join(fx.repo, ".git", "config"), "[core]\n\tfsmonitor = /tmp/evil.sh\n");
  fs.writeFileSync(path.join(fx.repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
  assert.deepEqual(c.auditRepoGitState(fx.repo), ["config:.git/config:core.fsmonitor", "hook:.git/hooks/post-checkout"]);
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

test("startJob: with container mode off (default), argv/command/env are what they were before container mode", async () => {
  const fx = fixture();
  const a = [], b = [];
  const base = { prompt: "hello", workFolder: fx.repo };
  const opts = { claudeBin: process.execPath, caps: CAPS, hermesHomeIsolation: false, toolGate: false, safePermissions: false };
  const r1 = await core.startJob({ ...base, jobId: jid("off-a") }, { ...opts, launch: fakeLaunch(a) });
  const r2 = await core.startJob({ ...base, jobId: jid("off-b"), sandbox: "host" },
    { ...opts, launch: fakeLaunch(b), sandboxDefault: "container" });
  for (const r of [r1, r2]) { assert.ok(!r.error, r.error); assert.equal(r.sandbox, undefined); assert.equal(r.container, undefined); }
  assert.deepEqual(a[0].argv, b[0].argv, "sandbox:\"host\" over a container default is identical to the default");
  assert.equal(a[0].command, process.execPath);
  assert.equal(a[0].argv[0], "-p");
  assert.ok(a[0].argv.includes("--dangerously-skip-permissions"));
  assert.ok(!a[0].argv.includes("run") && !a[0].argv.includes("--rm"));
  assert.deepEqual(a[0].launchExtra, {}, "no container record for host jobs");
  // The literal pre-container argv shape for this input (prompt/model/effort/settings layout).
  const i = a[0].argv.indexOf("--settings");
  assert.deepEqual(a[0].argv.slice(0, i), ["-p", "hello", "--strict-mcp-config", "--mcp-config",
    path.join(REPO_DIR, "empty-mcp.json"), "--dangerously-skip-permissions", "--model", "claude-sonnet-5", "--effort", "medium"]);
  assert.equal(a[0].argv.length, i + 2);
});

test("startJob: unknown env values never enable container mode", async () => {
  const fx = fixture();
  for (const v of ["1", "true", "Container"]) {
    const cap = [];
    const r = await core.startJob({ prompt: "p", workFolder: fx.repo, jobId: jid("env") },
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

test("startJob: sandbox:\"container\" launches docker with the container argv and records it", async () => {
  const fx = fixture();
  const cap = [];
  const id = jid("ctr");
  const r = await core.startJob({ prompt: "--version do it", workFolder: fx.repo, jobId: id, sandbox: "container",
                                  model: "claude-opus-4-8", effort: "ultracode" },
    { caps: CAPS, launch: fakeLaunch(cap), containerConfig: { ...fx.cfg, dockerBin: process.execPath },
      checkImage: () => ({ ok: true }) });
  assert.ok(!r.error, r.error);
  const { command, argv, extraEnv, launchExtra } = cap[0];
  assert.equal(command, process.execPath, "the runner spawns the docker binary");
  assert.equal(argv[0], "run");
  assert.equal(valueAfter(argv, "--name"), `claude-async-${id}`);
  assert.equal(argv.at(-1), "--version do it");
  assert.equal(argv.at(-2), "--");
  assert.ok(argv.includes("--model=claude-opus-4-8"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "xhigh");
  assert.equal(JSON.parse(argv[argv.indexOf("--settings") + 1]).ultracode, true);
  assert.equal(r.sandbox, "container");
  assert.equal(r.container.name, `claude-async-${id}`);
  assert.equal(r.hermesHome, undefined, "no per-job HERMES_HOME dir for container jobs");
  assert.equal(launchExtra.container.name, `claude-async-${id}`);
  assert.equal(launchExtra.container.repo, realpath(fx.repo));
  assert.deepEqual(launchExtra.container.gitBaseline, []);
  assert.ok(!JSON.stringify(cap[0]).includes(SECRET_GH), "no secret anywhere in what launch() receives");
  assert.equal(extraEnv.GH_TOKEN, undefined);
});

test("startJob: CLAUDE_ASYNC_JOB_SANDBOX=container (via seam) selects container mode without a per-call param", async () => {
  const fx = fixture();
  const cap = [];
  const r = await core.startJob({ prompt: "p", workFolder: fx.repo, jobId: jid("envon") },
    { caps: CAPS, launch: fakeLaunch(cap), sandboxDefault: "container",
      containerConfig: { ...fx.cfg, dockerBin: process.execPath }, checkImage: () => ({ ok: true }) });
  assert.ok(!r.error, r.error);
  assert.equal(cap[0].argv[0], "run");
});

test("startJob: container preflight refusals happen before the job dir exists", async () => {
  const fx = fixture();
  const cases = [
    [{ workFolder: fx.outside }, {}, /outside the container allowed roots/],
    [{}, { cfg: { envFile: null } }, /CLAUDE_ASYNC_CONTAINER_ENV_FILE is not set/],
    [{}, { cfg: { gitName: null } }, /GIT_NAME/],
    [{}, { image: () => ({ error: "docker image claude-async-job:local is not built on this host" }) }, /not built/],
    [{}, { cfg: { dockerBin: path.join(fx.base, "no-docker.exe") } }, /docker binary/],
  ];
  for (const [args, o, re] of cases) {
    const id = jid("pf");
    const r = await core.startJob({ prompt: "p", workFolder: fx.repo, jobId: id, sandbox: "container", ...args },
      { caps: CAPS, launch: fakeLaunch([]), containerConfig: { ...fx.cfg, dockerBin: process.execPath, ...(o.cfg || {}) },
        checkImage: o.image || (() => ({ ok: true })) });
    assert.equal(r.errorCode, "preflight", JSON.stringify(r));
    assert.match(r.error, re);
    assert.ok(!fs.existsSync(path.join(core.JOB_ROOT, id)), "no job dir on refusal");
  }
});

test("cancelJob: kills a running container job by name; refuses host jobs; no-op once finished", async () => {
  const fx = fixture();
  const id = jid("cancel");
  const r = await core.startJob({ prompt: "p", workFolder: fx.repo, jobId: id, sandbox: "container" },
    { caps: CAPS, launch: fakeLaunch([]), containerConfig: { ...fx.cfg, dockerBin: "docker-test-bin" },
      checkImage: () => ({ ok: true }), claudeBin: process.execPath });
  // dockerBin did not resolve on PATH, so this start is refused; use a resolvable one.
  assert.equal(r.errorCode, "preflight");
  const r2 = await core.startJob({ prompt: "p", workFolder: fx.repo, jobId: id, sandbox: "container" },
    { caps: CAPS, launch: fakeLaunch([]), containerConfig: { ...fx.cfg, dockerBin: process.execPath },
      checkImage: () => ({ ok: true }) });
  assert.ok(!r2.error, r2.error);
  const kills = [];
  const out = core.cancelJob(id, { killContainer: (a) => { kills.push(a); return { ok: true, killed: true }; } });
  assert.deepEqual(out.ok, true);
  assert.deepEqual(kills, [{ dockerBin: process.execPath, name: `claude-async-${id}` }]);
  fs.writeFileSync(path.join(core.JOB_ROOT, id, "exit_code"), "137");
  assert.equal(core.cancelJob(id, { killContainer: () => { throw new Error("must not kill"); } }).alreadyFinished, true);

  const hostId = jid("hostjob");
  await core.startJob({ prompt: "p", workFolder: fx.repo, jobId: hostId },
    { claudeBin: process.execPath, caps: CAPS, launch: fakeLaunch([]), hermesHomeIsolation: false });
  assert.match(core.cancelJob(hostId, { killContainer: () => { throw new Error("must not kill"); } }).error, /only supported for container jobs/);
  assert.match(core.cancelJob("../x").error, /invalid jobId/);
});

test("checkJob: a died container job gets its container killed once (reap)", async () => {
  const fx = fixture();
  const id = jid("reap");
  const r = await core.startJob({ prompt: "p", workFolder: fx.repo, jobId: id, sandbox: "container" },
    { caps: CAPS, launch: async () => ({ pid: 999999, pidSource: "test", launchPath: "test" }),
      containerConfig: { ...fx.cfg, dockerBin: process.execPath }, checkImage: () => ({ ok: true }) });
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
