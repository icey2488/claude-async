/**
 * dispatch.mjs — MCP tool surface + stateless multi-host router for claude-async.
 *
 * claude_start takes a REQUIRED `host`. If it names this machine (hosts.json "localHost") the
 * existing local path runs with no network hop; if it names a hosts.json registry entry the request
 * is forwarded to that host's host-api.mjs; anything else is an error listing the known hosts (see
 * hosts.mjs for the routing rules and registry). The `host` enum the client sees is built from the
 * registry when the bridge starts; routing validates against the live file on every call. The
 * forwarder stores nothing:
 * the job record lives only on the executing host, claude_check routes by the job id's host
 * prefix, and claude_jobs asks every registry host live. The one piece of forwarder-side state is
 * last-seen.json, used only to render an unreachable host's row.
 *
 * Every response carries `hostname` (os.hostname() of the machine that produced it -- the
 * executing host for start/check; forwarded responses also carry `forwardedBy`).
 */
import { z } from "zod";
import os from "node:os";
import { startJob, checkJob, listJobs } from "./job-core.mjs";
import { loadHostsConfig, resolveRoute, parseHostPrefix, mintJobId, knownHosts, readLastSeen, recordLastSeen,
         lastSeenPath } from "./hosts.mjs";
import { DEPTH_ENV, DEPTH_HEADER } from "./guard.mjs";

export const FORWARD_TIMEOUT_MS = 20_000; // start/check: a remote start includes its own launch (task path: up to ~15s)
export const LIST_TIMEOUT_MS = 5_000;

// ctx: { cfg (loadHostsConfig result), fetch, lastSeenFile, startOptions (job-core startJob opts
// seams, tests only) }. Built fresh per tool call so hosts.json edits apply without a restart.
export function defaultCtx() {
  return { cfg: loadHostsConfig(), fetch: globalThis.fetch, lastSeenFile: lastSeenPath(), startOptions: {} };
}

// The executing host's side of a start (used by the local route AND by host-api.mjs): mint the
// <host>.<descriptor>-YYYYMMDD-<suffix> id, then run job-core's guarded startJob.
export function startLocal(args, cfg, startOptions = {}) {
  const jobId = mintJobId({ host: cfg.localHost, descriptor: args.jobId, now: startOptions.now,
                            ...(startOptions.suffix ? { suffix: startOptions.suffix() } : {}) });
  const { prompt, workFolder, model, effort, intent } = args;
  return startJob({ prompt, workFolder, jobId, model, effort, intent },
                  { caps: cfg.caps, ...startOptions, host: cfg.localHost });
}

async function forward(ctx, route, method, pathAndQuery, body, timeoutMs) {
  const url = `${String(route.url).replace(/\/+$/, "")}${pathAndQuery}`;
  let res;
  try {
    res = await ctx.fetch(url, {
      method,
      headers: { authorization: `Bearer ${route.token}`, "content-type": "application/json",
                 [DEPTH_HEADER]: process.env[DEPTH_ENV] || "0" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { unreachable: true, error: `host ${route.host} unreachable at ${route.url}: ${e.cause?.code || e.message}` };
  }
  recordLastSeen(route.host, new Date(), ctx.lastSeenFile);
  let json;
  let parsed = false;
  try { json = await res.json(); parsed = true; } catch {}
  if (res.status === 401) return { error: `host ${route.host} rejected the registry token (HTTP 401)` };
  if (!parsed) return { error: `host ${route.host} returned HTTP ${res.status} with no JSON body` };
  // The peer is only trusted to speak the API's format: every response is a plain JSON object. An
  // array, null, or primitive would be spread into the caller's response as garbage (or as indexed
  // keys), so it is refused here, naming the host.
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    const got = json === null ? "null" : Array.isArray(json) ? "an array" : `a ${typeof json}`;
    return { error: `host ${route.host} returned a malformed response (registry-format error): expected a JSON ` +
                    `object, got ${got} (HTTP ${res.status})` };
  }
  return json;
}

const forwardedBy = (cfg) => ({ host: cfg.localHost, hostname: os.hostname() });

export async function dispatchStart(args, ctx = defaultCtx()) {
  const route = resolveRoute(args.host, ctx.cfg);
  if (route.error) return { error: route.error, host: args.host ?? null, hostname: os.hostname() };
  if (route.kind === "local") return startLocal(args, ctx.cfg, ctx.startOptions);
  const { host, prompt, workFolder, jobId, model, effort, intent } = args;
  const out = await forward(ctx, route, "POST", "/v1/start",
                            { host, prompt, workFolder, jobId, model, effort, intent }, FORWARD_TIMEOUT_MS);
  return { host, ...out, forwardedBy: forwardedBy(ctx.cfg) };
}

export async function dispatchCheck(jobId, tailBytes = 8000, ctx = defaultCtx()) {
  const { host } = parseHostPrefix(jobId);
  // Un-prefixed ids predate multihost and are always local; this path needs no config at all.
  if (!host) return { host: ctx.cfg.localHost ?? null, ...checkJob(jobId, tailBytes) };
  // A prefix that is a valid host name but not in the registry is an error, never a local lookup.
  if (!ctx.cfg.error && !knownHosts(ctx.cfg).includes(host)) {
    return { jobId, host, hostname: os.hostname(), status: "unknown",
             error: `job id ${JSON.stringify(jobId)} has host prefix "${host}", which is not in ${ctx.cfg.file} ` +
                    `(known hosts: ${knownHosts(ctx.cfg).join(", ")})` };
  }
  const route = resolveRoute(host, ctx.cfg);
  if (route.error) return { jobId, host, hostname: os.hostname(), status: "unknown", error: route.error };
  if (route.kind === "local") return { host, ...checkJob(jobId, tailBytes) };
  const out = await forward(ctx, route, "GET",
    `/v1/check?jobId=${encodeURIComponent(jobId)}&tailBytes=${encodeURIComponent(tailBytes)}`, null, FORWARD_TIMEOUT_MS);
  return { jobId, host, ...out, forwardedBy: forwardedBy(ctx.cfg) };
}

export async function dispatchJobs(ctx = defaultCtx()) {
  const hostname = os.hostname();
  const localHost = ctx.cfg.localHost ?? null;
  const jobs = listJobs().map((r) => ({ ...r, host: localHost, hostname }));
  const hosts = [{ host: localHost, hostname, reachable: true, count: jobs.length, local: true }];
  const problemRows = [];

  const remotes = Object.keys(ctx.cfg.hosts || {}).filter((h) => h !== localHost);
  const lastSeen = readLastSeen(ctx.lastSeenFile);
  const results = await Promise.all(remotes.map(async (h) => {
    const route = resolveRoute(h, ctx.cfg);
    if (route.error) return { h, out: { error: route.error } };
    return { h, out: await forward(ctx, route, "GET", "/v1/jobs", null, LIST_TIMEOUT_MS) };
  }));
  for (const { h, out } of results) {
    if (out.unreachable || out.error || !Array.isArray(out.jobs)) {
      // Never silently omitted: an explicit row, with the last time we actually reached it.
      const seen = lastSeen[h] || "never";
      const note = out.unreachable ? `unreachable (last seen ${seen})`
                                   : `error: ${out.error || "malformed /v1/jobs response"} (last seen ${seen})`;
      problemRows.push({ jobId: null, host: h, hostname: null, status: out.unreachable ? "unreachable" : "error", note });
      hosts.push({ host: h, reachable: false, lastSeen: seen, note });
      continue;
    }
    for (const r of out.jobs) jobs.push({ ...r, host: h, hostname: r.hostname ?? out.hostname ?? null });
    hosts.push({ host: h, hostname: out.hostname ?? null, reachable: true, count: out.jobs.length });
  }
  jobs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const all = [...problemRows, ...jobs];
  return { hostname, localHost, ...(ctx.cfg.error ? { configError: ctx.cfg.error } : {}),
           count: all.length, hosts, jobs: all };
}

// The `host` parameter: a REQUIRED enum of the registry's known hosts, fixed for this bridge's
// lifetime (a tool schema is advertised once). If hosts.json is unusable at startup there is no
// registry to enumerate, so it degrades to a plain string and the per-call routing error (which
// names the file and field) is what the caller sees.
function hostParam(cfg) {
  if (cfg.error) {
    return z.string().describe(`REQUIRED. Executing host. hosts.json is unusable, so every claude_start ` +
                               `will be refused until it is fixed: ${cfg.error}`);
  }
  const names = knownHosts(cfg);
  return z.enum(names).describe(`REQUIRED. Executing host, one of: ${names.join(", ")} (this machine is ` +
    `${cfg.localHost}). No default. To add a host, edit hosts.json and restart the bridge.`);
}

// getCtx: test seam; production builds a fresh ctx (and so re-reads hosts.json) per call. The
// host enum is built once here from the registry as it is at startup; each call still validates
// the requested host against the live file, so a host removed since startup is refused.
export function registerTools(server, { getCtx = defaultCtx } = {}) {
  const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
  const hostSchema = hostParam(getCtx().cfg);

  server.registerTool("claude_start", {
    description: "Start a Claude Code task as a detached background job and return a jobId immediately. " +
                 "Use for any work that might run longer than ~30s. Poll with claude_check. `host` is " +
                 "REQUIRED and names the machine the job executes on: this machine runs it locally, any " +
                 "other host in hosts.json is reached over Tailscale (the `host` parameter lists them). " +
                 "The response includes the executing hostname and, on success, \"preflight passed, " +
                 "execution unverified\" (binary + workFolder exist; the job itself may still fail).",
    inputSchema: {
      host: hostSchema,
      prompt: z.string().describe("The task for Claude Code. Include CWD context if it does file/git work."),
      intent: z.string().optional().describe("Optional one-line intent that becomes the dispatch card's " +
                  "TITLE (the board face most users actually see — the jobId never appears there). " +
                  "When supplied it is used verbatim (bounded); otherwise a heuristic summary of the " +
                  "prompt's opener is used. Prefer supplying this for a clean card face."),
      workFolder: z.string().optional().describe("Directory to run in, on the EXECUTING host " +
                  "(default: that host's $HOME or CLAUDE_ASYNC_DEFAULT_CWD)."),
      jobId: z.string().optional().describe("Optional descriptor. The final id is always " +
                  "<host>.<descriptor>-YYYYMMDD-<8 random chars>."),
      model: z.string().optional().describe("--model override, e.g. claude-opus-4-8 / claude-sonnet-5. " +
                  "Default claude-sonnet-5 (fail-safe; override via CLAUDE_ASYNC_DEFAULT_MODEL)."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultracode"]).optional()
        .describe("Reasoning effort; default medium. \"max\" = highest reasoning; " +
                  "\"ultracode\" = xhigh plus standing dynamic-workflow orchestration (parallel subagents)."),
    },
  }, async (args) => ok(await dispatchStart(args, getCtx())));

  server.registerTool("claude_check", {
    description: "Check a background job's status and recent output. Routed by the jobId's host prefix " +
                 "(<host>.…); un-prefixed (older) ids are local. Returns hostname, status " +
                 "(running | completed | failed | died | timed_out), exit code, and a tail of stdout/stderr. " +
                 "running may include elapsed and lastAlive fields; stalled:true means heartbeat is stale " +
                 "but pid is still alive. died means the process exited without recording a result. " +
                 "timed_out means no heartbeat for longer than CLAUDE_ASYNC_JOB_TIMEOUT_MS (default 4h). " +
                 "On win32, launchPath reports which launch mechanism was used (\"task\": Task Scheduler, " +
                 "the default; \"breakaway-fallback\": win32-breakaway.ps1, used only if the task path " +
                 "failed; \"spawn\": non-win32). jobMembership (recorded at launch) and " +
                 "runnerJobMembership (refreshed every heartbeat by the runner itself) report Windows Job " +
                 "Object membership, but inJob:true alone is NOT proof of an escape failure -- Windows " +
                 "places most console-attached processes into a default per-console job with identical " +
                 "limitFlags (0x3C00) regardless of ancestry, confirmed via RUNBOOK.md's verification. " +
                 "Trust the survival behavior (test/survival.mjs), not this flag, when in doubt.",
    inputSchema: {
      jobId: z.string(),
      tailBytes: z.number().int().positive().optional().describe("Bytes of stdout/stderr to return (default 8000)."),
    },
  }, async ({ jobId, tailBytes }) => ok(await dispatchCheck(jobId, tailBytes || 8000, getCtx())));

  server.registerTool("claude_jobs", {
    description: "List background jobs on this host and every host in hosts.json, each row tagged with " +
                 "host + hostname. An unreachable host appears as an explicit row " +
                 "\"unreachable (last seen <time>)\", never silently omitted.",
    inputSchema: {},
  }, async () => ok(await dispatchJobs(getCtx())));

  return server;
}
