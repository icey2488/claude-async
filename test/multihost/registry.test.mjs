// hosts.json schema: the registry is the source of truth, validated on load. A file that fails
// validation is an error naming the file and the field, and claude_start refuses until it is fixed.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hosts, dispatch, fakeLaunch, tickets, jobDirs, resetState, writeHostsJson, cleanupTmp, TMP } from "./_setup.mjs";

const HOSTNAME = os.hostname();
after(cleanupTmp);
beforeEach(resetState);

const F = path.join(TMP, "registry-hosts.json");
const load = (obj) => { fs.writeFileSync(F, typeof obj === "string" ? obj : JSON.stringify(obj)); return hosts.loadHostsConfig(F); };
const ENTRY = { url: "http://100.100.1.1:7850", token: "tok" };

test("validateHostName: null when valid, a one-line reason otherwise", () => {
  for (const ok of ["ha", "claunker", "laptop", "a", "0", "a-b", "9lives", "ha-2", "x".repeat(32), "a-", "a--b"]) {
    assert.equal(hosts.validateHostName(ok), null, ok);
  }
  const bad = [["", /empty/], ["Ha", /lowercase/], ["HA", /lowercase/], ["a.b", /"\."/], [".ha", /"\."/], ["-a", /start with/],
               ["a b", /only a-z/], ["a_b", /only a-z/], ["ünï", /only a-z/], ["x".repeat(33), /at most 32/],
               [undefined, /string/], [null, /string/], [7, /string/], [{}, /string/]];
  for (const [name, re] of bad) {
    const why = hosts.validateHostName(name);
    assert.equal(typeof why, "string", `${String(name)} must be rejected`);
    assert.match(why, re, String(name));
    assert.ok(!why.includes("\n"), "one line");
  }
});

test("HOST_NAME_RE agrees with validateHostName on a spread of names", () => {
  for (const n of ["ha", "Ha", "a.b", "", "-x", "x-", "a".repeat(32), "a".repeat(33), "a b", "0x", "é"]) {
    assert.equal(hosts.HOST_NAME_RE.test(n), hosts.validateHostName(n) === null, JSON.stringify(n));
  }
});

test("loadHostsConfig: a valid registry loads; receiver defaults to false; caps pass through", () => {
  const cfg = load({ localHost: "laptop", hosts: { claunker: ENTRY, ha: { url: "https://ha.example:7850/x", token: "t2" } },
                     caps: { maxConcurrent: 2 } });
  assert.deepEqual(cfg, { file: F, localHost: "laptop", receiver: false, caps: { maxConcurrent: 2 },
                          hosts: { claunker: ENTRY, ha: { url: "https://ha.example:7850/x", token: "t2" } } });
  assert.deepEqual(load({ localHost: "ha", receiver: true }),
                   { file: F, localHost: "ha", receiver: true, hosts: {}, caps: undefined });
  assert.equal(load({ localHost: "ha", receiver: false }).receiver, false);
  assert.deepEqual(hosts.knownHosts(load({ localHost: "laptop", hosts: { claunker: ENTRY, ha: ENTRY } })),
                   ["laptop", "claunker", "ha"]);
});

test("loadHostsConfig: missing / unreadable / non-object files are errors naming the file", () => {
  const missing = hosts.loadHostsConfig(path.join(TMP, "absent-hosts.json"));
  assert.match(missing.error, /local host identity not configured: create .*absent-hosts\.json/);
  assert.match(load("{not json").error, new RegExp(`could not read ${F.replace(/\\/g, "\\\\")}`));
  for (const body of ["[]", "null", "7", '"x"']) assert.match(load(body).error, /the file must be a JSON object/, body);
});

// [label, config, the field the error must name]
const INVALID = [
  ["localHost missing", {}, '"localHost"'],
  ["localHost empty", { localHost: "" }, '"localHost"'],
  ["localHost with a dot", { localHost: "my.box" }, '"localHost"'],
  ["localHost uppercase", { localHost: "Claunker" }, '"localHost"'],
  ["localHost too long", { localHost: "x".repeat(33) }, '"localHost"'],
  ["localHost not a string", { localHost: 5 }, '"localHost"'],
  ["receiver a string", { localHost: "ha", receiver: "yes" }, '"receiver"'],
  ["receiver a number", { localHost: "ha", receiver: 1 }, '"receiver"'],
  ["receiver null", { localHost: "ha", receiver: null }, '"receiver"'],
  ["hosts an array", { localHost: "a", hosts: [] }, '"hosts"'],
  ["hosts null", { localHost: "a", hosts: null }, '"hosts"'],
  ["hosts a string", { localHost: "a", hosts: "ha" }, '"hosts"'],
  ["host name with a dot", { localHost: "a", hosts: { "h.a": ENTRY } }, '"hosts.h.a"'],
  ["host name uppercase", { localHost: "a", hosts: { HA: ENTRY } }, '"hosts.HA"'],
  ["host name empty", { localHost: "a", hosts: { "": ENTRY } }, '"hosts."'],
  ["host name too long", { localHost: "a", hosts: { ["x".repeat(33)]: ENTRY } }, `"hosts.${"x".repeat(33)}"`],
  ["host name equals localHost", { localHost: "ha", hosts: { ha: ENTRY } }, '"hosts.ha"'],
  ["host entry not an object", { localHost: "a", hosts: { ha: "http://x" } }, '"hosts.ha"'],
  ["host entry null", { localHost: "a", hosts: { ha: null } }, '"hosts.ha"'],
  ["url missing", { localHost: "a", hosts: { ha: { token: "t" } } }, '"hosts.ha.url"'],
  ["url empty", { localHost: "a", hosts: { ha: { url: "", token: "t" } } }, '"hosts.ha.url"'],
  ["url not a URL", { localHost: "a", hosts: { ha: { url: "not a url", token: "t" } } }, '"hosts.ha.url"'],
  ["url wrong scheme", { localHost: "a", hosts: { ha: { url: "ftp://100.1.1.1", token: "t" } } }, '"hosts.ha.url"'],
  ["url no host", { localHost: "a", hosts: { ha: { url: "http://", token: "t" } } }, '"hosts.ha.url"'],
  ["url a bare host:port", { localHost: "a", hosts: { ha: { url: "100.1.1.1:7850", token: "t" } } }, '"hosts.ha.url"'],
  ["token missing", { localHost: "a", hosts: { ha: { url: ENTRY.url } } }, '"hosts.ha.token"'],
  ["token empty", { localHost: "a", hosts: { ha: { url: ENTRY.url, token: "" } } }, '"hosts.ha.token"'],
  ["token not a string", { localHost: "a", hosts: { ha: { url: ENTRY.url, token: 12 } } }, '"hosts.ha.token"'],
  ["one bad entry among good ones", { localHost: "a", hosts: { ok: ENTRY, ha: { url: ENTRY.url } } }, '"hosts.ha.token"'],
];

for (const [label, config, field] of INVALID) {
  test(`invalid hosts.json (${label}): the error names the file and ${field}; claude_start refuses, nothing written`, async () => {
    const cfg = load(config);
    assert.ok(cfg.error, "must fail validation");
    assert.equal(cfg.file, F);
    assert.ok(cfg.error.startsWith(`${F}: ${field} `), cfg.error);
    // the real path: hosts.json in the (temp) config dir, re-read by defaultCtx() on the call
    writeHostsJson(config);
    const ctx = { ...dispatch.defaultCtx(), fetch: () => { throw new Error("no network for a refused start"); },
                  startOptions: { launch: fakeLaunch } };
    assert.match(ctx.cfg.error, new RegExp(`${field.replace(/[.]/g, "\\.")} `));
    for (const host of [config.localHost, "claunker", "ha"]) {
      const r = await dispatch.dispatchStart({ host, prompt: "p" }, ctx);
      assert.equal(r.error, ctx.cfg.error, `host ${JSON.stringify(host)}`);
      assert.equal(r.hostname, HOSTNAME);
    }
    assert.equal(tickets().length, 0);
    assert.equal(jobDirs().length, 0);
  });
}

test("loadHostsConfig: unknown top-level keys are ignored; entries do not alias localHost by case", () => {
  assert.equal(load({ localHost: "ha", note: "x", extra: { a: 1 } }).error, undefined);
  assert.ok(load({ localHost: "ha", hosts: { HA: ENTRY } }).error, "HA is not a valid name, so it can never shadow ha");
});
