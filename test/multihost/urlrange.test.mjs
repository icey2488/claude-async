// A registry url must be an IPv4 literal in the Tailscale range 100.64.0.0/10 (the receiver only
// binds a Tailscale address). CLAUDE_ASYNC_ALLOW_ANY_URL=1 is a test/dev override that skips ONLY
// that range check -- never the protocol check. It is not a security control.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hosts, cleanupTmp, TMP } from "./_setup.mjs";

after(cleanupTmp);
const F = path.join(TMP, "url-hosts.json");
const withUrl = (url) => { fs.writeFileSync(F, JSON.stringify({ localHost: "a", hosts: { ha: { url, token: "t" } } })); return hosts.loadHostsConfig(F); };
const savedEnv = process.env.CLAUDE_ASYNC_ALLOW_ANY_URL;
const restore = () => { if (savedEnv === undefined) delete process.env.CLAUDE_ASYNC_ALLOW_ANY_URL; else process.env.CLAUDE_ASYNC_ALLOW_ANY_URL = savedEnv; };
after(restore);

test("isTailscaleIPv4: range edges and non-literals", () => {
  for (const ok of ["100.64.0.0", "100.64.0.1", "100.100.1.1", "100.127.255.255"]) assert.equal(hosts.isTailscaleIPv4(ok), true, ok);
  for (const no of ["100.128.0.1", "100.63.255.255", "127.0.0.1", "192.168.1.10", "10.0.0.1", "101.64.0.1", "100.64.0", "100.64.0.1.2",
                    "100.64.0.256", "100.064.0.1", " 100.64.0.1", "100.64.0.1 ", "ha.example", "localhost", "[fd7a::1]", "fd7a::1", "", undefined]) {
    assert.equal(hosts.isTailscaleIPv4(no), false, String(no));
  }
});

test("registry url in 100.64.0.0/10 accepted", () => {
  delete process.env.CLAUDE_ASYNC_ALLOW_ANY_URL;
  for (const u of ["http://100.64.0.1:7850", "http://100.127.255.254:7850", "https://100.100.1.1:7850/x"]) assert.equal(withUrl(u).error, undefined, u);
});

test("registry url outside the range, or not an IPv4 literal, rejected with the Tailscale reason", () => {
  delete process.env.CLAUDE_ASYNC_ALLOW_ANY_URL;
  for (const u of ["http://100.128.0.1:7850", "http://100.63.255.255:7850", "http://127.0.0.1:7850", "http://192.168.1.10:7850",
                   "http://[fd7a::1]:7850", "http://ha.example:7850", "http://localhost:7850", "http://8.8.8.8:7850"]) {
    const cfg = withUrl(u);
    assert.ok(cfg.error?.startsWith(`${F}: "hosts.ha.url" `), `${u}: ${cfg.error}`);
    assert.match(cfg.error, /only binds a Tailscale address/, u);
  }
});

test("CLAUDE_ASYNC_ALLOW_ANY_URL=1 skips the range check but never the protocol check", () => {
  process.env.CLAUDE_ASYNC_ALLOW_ANY_URL = "1";
  try {
    for (const u of ["http://127.0.0.1:7850", "http://ha.example:7850", "http://[fd7a::1]:7850"]) assert.equal(withUrl(u).error, undefined, u);
    assert.match(withUrl("ftp://100.64.0.1").error, /"hosts\.ha\.url" must be an http or https URL/);
    assert.match(withUrl("ftp://127.0.0.1").error, /"hosts\.ha\.url" must be an http or https URL/);
    process.env.CLAUDE_ASYNC_ALLOW_ANY_URL = "true"; // only the literal "1" counts
    assert.match(withUrl("http://127.0.0.1:7850").error, /Tailscale/);
  } finally { restore(); }
});
