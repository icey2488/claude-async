#!/usr/bin/env node
/**
 * register-desktop.mjs — safely add the `claude-async` MCP server to the Claude desktop
 * app's config. Idempotent and re-runnable.
 *
 * On this machine the desktop app is the Microsoft Store (MSIX) build, whose %APPDATA%
 * (Roaming) is redirected into a per-package virtual store, so the canonical
 * %APPDATA%\Claude\claude_desktop_config.json is NOT what the app reads. This script
 * discovers the real config (preferring an existing MSIX virtual-store file), backs it up,
 * merges in the claude-async entry WITHOUT touching any other server or preference, and
 * re-parses to confirm the result is valid JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

// MSIX virtual-store config(s) for any installed Claude package, most-specific first,
// with the standard Roaming path as the final fallback.
function msixCandidates() {
  const pkgRoot = path.join(LOCALAPPDATA, "Packages");
  if (!fs.existsSync(pkgRoot)) return [];
  return fs.readdirSync(pkgRoot)
    .filter((d) => d.startsWith("Claude"))
    .map((d) => path.join(pkgRoot, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
}
const candidates = [...msixCandidates(), path.join(APPDATA, "Claude", "claude_desktop_config.json")];
const configPath = candidates.find((c) => fs.existsSync(c)) || candidates[candidates.length - 1];

// Resolve binaries (absolute, so the app's minimal PATH can't matter).
const NODE = process.execPath;
const CLAUDE_EXE = process.env.CLAUDE_CLI_PATH ||
  path.join(APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const SERVER = path.join(PROJECT_DIR, "claude-async-server.mjs");
const JOB_DIR = path.join(HOME, ".claude-async-jobs");

const entry = {
  command: NODE,
  args: [SERVER],
  env: { CLAUDE_CLI_PATH: CLAUDE_EXE, CLAUDE_ASYNC_JOB_DIR: JOB_DIR },
};

const warnings = [];
if (!fs.existsSync(CLAUDE_EXE)) warnings.push(`claude.exe not found at ${CLAUDE_EXE}`);
if (!fs.existsSync(SERVER)) warnings.push(`server not found at ${SERVER}`);

fs.mkdirSync(path.dirname(configPath), { recursive: true });

let cfg = { mcpServers: {} };
const existedBefore = fs.existsSync(configPath);
if (existedBefore) {
  const raw = fs.readFileSync(configPath, "utf8");
  try { cfg = JSON.parse(raw); }
  catch (e) { console.error(`ABORT: existing config is not valid JSON (${e.message}). Nothing changed.`); process.exit(1); }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${configPath}.bak-${ts}`;
  fs.writeFileSync(bak, raw);
  console.log(`Backed up existing config -> ${bak}`);
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};

const before = cfg.mcpServers["claude-async"] ? JSON.stringify(cfg.mcpServers["claude-async"]) : "(absent)";
cfg.mcpServers["claude-async"] = entry;

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
JSON.parse(fs.readFileSync(configPath, "utf8")); // confirm still valid JSON

console.log(`Config file        : ${configPath}`);
console.log(`Existed before     : ${existedBefore}`);
console.log(`Servers now present: ${Object.keys(cfg.mcpServers).join(", ")}`);
console.log(`claude-async before: ${before}`);
console.log(`claude-async after : ${JSON.stringify(entry)}`);
if (warnings.length) console.log("WARNINGS:\n - " + warnings.join("\n - "));
console.log("DONE");
