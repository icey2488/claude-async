#!/usr/bin/env node
// Mints one GitHub App installation token for a repo and writes it to a file, the way job-runner.mjs
// does for a container job (docs/container-jobs.md). For container/smoke-test.ps1 and for checking
// the App setup by hand on claunker. Never prints the token.
//
//   CLAUDE_ASYNC_GITHUB_APP_ID=... CLAUDE_ASYNC_GITHUB_APP_KEY_FILE=... node tools/mint-app-token.mjs <owner/repo> <out-file>
//
// Runs the same preflight job-core runs (key file checks, installation lookup, App identity), then
// mints and writes <out-file> (0600; the directory must exist). Prints the slug, bot user id,
// installation id, commit identity and expiry. Exit 1 with the preflight's message on any problem.
import fs from "node:fs";
import path from "node:path";
import { loadGitHubAppConfig, validateGitHubAppConfig, preflightGitHubApp, createMinter, repoNameOf, botGitIdentity } from "../github-app.mjs";

const [repo, outFile] = process.argv.slice(2);
if (!repo || !outFile || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
  console.error("usage: node tools/mint-app-token.mjs <owner/repo> <out-file>");
  process.exit(2);
}
const cfg = loadGitHubAppConfig(process.env);
const errs = validateGitHubAppConfig(cfg);
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
const pf = await preflightGitHubApp({ appId: cfg.appId, keyFile: cfg.keyFile, repo, apiBase: cfg.apiBase });
if (pf.error) { console.error(pf.error); process.exit(1); }
const id = botGitIdentity(pf);
console.log(`app slug: ${pf.slug}  bot user id: ${pf.botUserId}  installation: ${pf.installationId}`);
console.log(`commit identity: ${id.name} <${id.email}>`);
try {
  const minter = createMinter({ appId: cfg.appId, keyFile: pf.keyFile, installationId: pf.installationId, repoName: repoNameOf(repo), repo, apiBase: cfg.apiBase });
  const { token, expiresAt } = await minter.mint();
  const fd = fs.openSync(path.resolve(outFile), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try { fs.writeSync(fd, `${token}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  console.log(`installation token written to ${path.resolve(outFile)} (length ${token.length}, expires ${new Date(expiresAt).toISOString()})`);
} catch (e) { console.error(`mint failed: ${e.message}`); process.exit(1); }
