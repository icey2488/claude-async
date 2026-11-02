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
