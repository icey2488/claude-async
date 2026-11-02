// Container-job plumbing through dispatch.mjs (claude_start / claude_cancel) and host-api.mjs
// (POST /v1/start, POST /v1/cancel): repo/baseRef are forwarded only when given, so a host-mode
// forwarded body is unchanged; the API validates them; cancel forwards to the owning host.
// Uses the multihost suite's isolation (temp job root, temp queue, fake launch).
// Run: node --test test/container-dispatch.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dispatch, api, fakeLaunch, tickets, jobDirs, resetState, cfgFor, BIG_CAPS, TOKEN, apiCfgFor,
         listenLoopback, cleanupTmp } from "./multihost/_setup.mjs";

const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); cleanupTmp(); });
beforeEach(resetState);

const peer = (seen, body = { jobId: "claunker.j-20261101-abcdefgh", status: "running" }) => async (url, init) => {
  seen.push({ url, init });
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};
const laptopCtx = (fetchImpl) => ({
  cfg: { file: "hosts.json", localHost: "laptop", caps: BIG_CAPS,
         hosts: { claunker: { url: "http://100.100.1.1:7850", token: "tok" } } },
  fetch: fetchImpl, lastSeenFile: "/nonexistent/last-seen.json", startOptions: { launch: fakeLaunch },
});

test("dispatchStart: a host-mode forwarded body has exactly the pre-container keys", async () => {
  const seen = [];
  await dispatch.dispatchStart({ host: "claunker", prompt: "p" }, laptopCtx(peer(seen)));
  // undefined fields drop out of JSON, so the body is exactly what it was before container mode
  assert.deepEqual(JSON.parse(seen[0].init.body), { host: "claunker", prompt: "p" });
});

test("dispatchStart: sandbox, repo and baseRef are forwarded when given", async () => {
  const seen = [];
  await dispatch.dispatchStart({ host: "claunker", prompt: "p", sandbox: "container", repo: "icey2488/scratch",
                                 baseRef: "main" }, laptopCtx(peer(seen)));
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.sandbox, "container");
  assert.equal(body.repo, "icey2488/scratch");
  assert.equal(body.baseRef, "main");
});

async function apiServer() {
  const server = api.createApiServer({ cfg: cfgFor("claunker", { caps: BIG_CAPS }), apiCfg: apiCfgFor(),
                                       startOptions: { launch: fakeLaunch } });
  servers.push(server);
  return listenLoopback(server);
}
const post = async (url, path, body) => {
  const res = await fetch(url + path, { method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
  return { status: res.status, body: await res.json() };
};

test("POST /v1/start: repo/baseRef must be strings; on a host job they are refused; nothing is written", async () => {
  const url = await apiServer();
  const bad = await post(url, "/v1/start", { host: "claunker", prompt: "p", repo: 5 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /repo must be a string/);
  const badRef = await post(url, "/v1/start", { host: "claunker", prompt: "p", baseRef: ["x"] });
  assert.match(badRef.body.error, /baseRef must be a string/);
  const hostRepo = await post(url, "/v1/start", { host: "claunker", prompt: "p", repo: "icey2488/scratch" });
  assert.equal(hostRepo.status, 400);
  assert.match(hostRepo.body.error, /only for container jobs/);
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

test("POST /v1/start: sandbox:\"container\" is refused under the default policy (host only); nothing is written", async () => {
  const url = await apiServer();
  const r = await post(url, "/v1/start", { host: "claunker", prompt: "p", sandbox: "container", repo: "icey2488/scratch" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not allowed on this host \(CLAUDE_ASYNC_ALLOWED_SANDBOXES=host\)/);
  assert.equal(tickets().length, 0);
  assert.equal(jobDirs().length, 0);
});

// Argon #11: a container job started on claunker from another host can be cancelled from there.
test("dispatchCancel: a remote job id is forwarded to its host's POST /v1/cancel; an unknown host is refused", async () => {
  const seen = [];
  const out = await dispatch.dispatchCancel("claunker.j-20261101-abcdefgh",
    laptopCtx(peer(seen, { jobId: "claunker.j-20261101-abcdefgh", ok: true, cancelRequested: true })));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://100.100.1.1:7850/v1/cancel");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(seen[0].init.body), { jobId: "claunker.j-20261101-abcdefgh" });
  assert.equal(out.ok, true);
  assert.equal(out.host, "claunker");
  assert.ok(out.forwardedBy);
  const unknown = await dispatch.dispatchCancel("desktop.j-20261101-abcdefgh", laptopCtx(peer([])));
  assert.match(unknown.error, /not in hosts\.json/);
});

test("POST /v1/cancel: cancels only this host's container jobs; validates the body", async () => {
  const url = await apiServer();
  const other = await post(url, "/v1/cancel", { jobId: "ha.j-20261101-abcdefgh" });
  assert.equal(other.status, 404);
  assert.match(other.body.error, /belongs to host ha/);
  const missing = await post(url, "/v1/cancel", { jobId: "claunker.nope-20261101-abcdefgh" });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no such job/);
  const bad = await post(url, "/v1/cancel", { jobId: 5 });
  assert.equal(bad.status, 400);
  // a host job: refused, nothing written
  const started = await post(url, "/v1/start", { host: "claunker", prompt: "p" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const hostJob = await post(url, "/v1/cancel", { jobId: started.body.jobId });
  assert.equal(hostJob.status, 400);
  assert.match(hostJob.body.error, /only supported for container jobs/);
  const unauth = await fetch(url + "/v1/cancel", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(unauth.status, 401);
});
