// HTTP-level test for fix 5 (nested dispatch, 2026-11-13 review round): host-api.mjs's POST
// /v1/start used to resolve the CALLER's profile (for guard.mjs's checkProfile, "may a child
// request a profile this broad") from the host-api.mjs DAEMON's own process.env -- never the real
// caller's -- so a readonly job that self-reported a dispatch depth of 1 to /v1/start could request
// (and get) "code" for a nested job, because the daemon's env has no CLAUDE_ASYNC_JOB_PROFILE set
// and checkProfile silently treated that as the most permissive default. This test starts a REAL
// host-api.mjs HTTP server (createApiServer(), listening on an ephemeral 127.0.0.1 port -- no
// Tailscale involved, startApi()'s bind logic is bypassed entirely) and drives it with real POST
// /v1/start requests, asserting on the HTTP response's errorCode, never on hook/rule text.
// Run: node --test test/host-api-nested-profile.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "host-api-nested-profile-"));
process.env.CLAUDE_ASYNC_JOB_DIR = path.join(TMP, "jobs");
delete process.env.CLAUDE_ASYNC_JOB_SAFE_PERMISSIONS;

const hostApi = await import("../host-api.mjs");
const core = await import("../job-core.mjs");
const guard = await import("../guard.mjs");
const { createApiServer, hashToken } = hostApi;
const { startJob } = core;
const { DEPTH_HEADER, PROFILE_HEADER, JOB_ID_HEADER } = guard;

const LOCAL_HOST = "testhost";
const TOKEN = "host-api-test-token-" + "z".repeat(24);
const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); fs.rmSync(TMP, { recursive: true, force: true }); });

function fakeLaunch() {
  return async (_p, _claudeBin, _argv, _cwd, _extraEnv) => ({ pid: 1, pidSource: "test", jobMembership: null, launchPath: "test" });
}

async function startServer() {
  const cfg = { localHost: LOCAL_HOST, caps: { maxStartsPerMinute: 1000 } };
  const apiCfg = { tokenSha256: hashToken(TOKEN) };
  // startOptions here are job-core startJob() seams, shared by every request this server handles --
  // never a real claude binary, so this never actually spawns anything.
  const startOptions = { claudeBin: process.execPath, launch: fakeLaunch(), safePermissions: true };
  const server = createApiServer({ cfg, apiCfg, startOptions });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, cfg };
}

function post(port, path_, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const jid = (label) => `nested-${label}-${crypto.randomBytes(3).toString("hex")}`;

test("a real readonly parent job's recorded profile (meta.json) is used to refuse a broader child, even with a self-reported header claiming otherwise", async () => {
  const { port, cfg } = await startServer();
  // A genuine, previously-started readonly job -- real meta.json on disk, exactly what
  // host-api.mjs's readJobProfile() will read back.
  const parent = await startJob(
    { prompt: "parent", jobId: jid("parent"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(), safePermissions: true, caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!parent.error, JSON.stringify(parent));

  // The self-reported PROFILE_HEADER lies ("code"), but the AUTHORITATIVE meta.json (found via
  // JOB_ID_HEADER) says "readonly" -- the broader request must still be refused.
  const r = await post(port, "/v1/start",
    { host: LOCAL_HOST, prompt: "child", jobId: jid("child"), profile: "code" },
    { [DEPTH_HEADER]: "1", [PROFILE_HEADER]: "code", [JOB_ID_HEADER]: parent.jobId });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.errorCode, "profile");
  assert.match(r.body.error, /broader than its parent's profile "readonly"/);
});

test("the same real readonly parent allows a child requesting readonly (its own profile)", async () => {
  const { port } = await startServer();
  const parent = await startJob(
    { prompt: "parent", jobId: jid("parent2"), profile: "readonly" },
    { claudeBin: process.execPath, launch: fakeLaunch(), safePermissions: true, caps: { maxStartsPerMinute: 1000 } },
  );
  assert.ok(!parent.error, JSON.stringify(parent));

  const r = await post(port, "/v1/start",
    { host: LOCAL_HOST, prompt: "child", jobId: jid("child2"), profile: "readonly" },
    { [DEPTH_HEADER]: "1", [JOB_ID_HEADER]: parent.jobId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profile, "readonly");
});

test("without a resolvable parent job id, rejects even a readonly header", async () => {
  const { port } = await startServer();
  const r = await post(port, "/v1/start",
    { host: LOCAL_HOST, prompt: "child", jobId: jid("header-only") },
    { [DEPTH_HEADER]: "1", [PROFILE_HEADER]: "readonly" }); // no JOB_ID_HEADER at all
  // Requesting the DEFAULT profile ("code") against a self-reported "readonly" parent must be
  // refused -- code is broader than readonly.
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.errorCode, "profile");
});

test("an unresolvable parent is rejected, including cross-host identity", async () => {
  const { port } = await startServer();
  const r = await post(port, "/v1/start",
    { host: LOCAL_HOST, prompt: "child", jobId: jid("unknown-parent"), profile: "code" },
    { [DEPTH_HEADER]: "1", [PROFILE_HEADER]: "readonly", [JOB_ID_HEADER]: "no-such-job-id" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.errorCode, "profile");
});

test("with no parent headers, depth>0 is rejected", async () => {
  const { port } = await startServer();
  const r = await post(port, "/v1/start",
    { host: LOCAL_HOST, prompt: "child", jobId: jid("no-headers"), profile: "code" },
    { [DEPTH_HEADER]: "1" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.errorCode, "profile");
});

test("depth 0 (a direct top-level caller) may request any profile regardless of headers", async () => {
  const { port } = await startServer();
  const r = await post(port, "/v1/start",
    { host: LOCAL_HOST, prompt: "top-level", jobId: jid("top-level"), profile: "readonly" }, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profile, "readonly");
});
