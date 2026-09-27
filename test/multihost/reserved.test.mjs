// Windows reserved device names are not valid host names: a host name becomes a job-id prefix and a
// job directory name on whichever host mints or checks it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hosts, cleanupTmp, TMP } from "./_setup.mjs";

after(cleanupTmp);
const F = path.join(TMP, "reserved-hosts.json");
const load = (obj) => { fs.writeFileSync(F, JSON.stringify(obj)); return hosts.loadHostsConfig(F); };
const ENTRY = { url: "http://100.100.1.1:7850", token: "t" };

test("validateHostName: reserved device names rejected (uppercase forms by the uppercase rule)", () => {
  for (const n of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
    assert.match(hosts.validateHostName(n), /is a reserved device name on Windows/, n);
  }
  assert.match(hosts.validateHostName("CON"), /lowercase/);
  assert.match(hosts.validateHostName("Nul"), /lowercase/);
});

test("validateHostName: near-misses accepted", () => {
  for (const n of ["console", "com10", "lpt0", "com0", "con1", "nul-1", "aux2"]) assert.equal(hosts.validateHostName(n), null, n);
});

test("reserved names rejected as localHost and as a registry key", () => {
  for (const n of ["con", "nul", "com1", "lpt9"]) {
    const a = load({ localHost: n });
    assert.ok(a.error?.startsWith(`${F}: "localHost" `), a.error);
    assert.match(a.error, /reserved device name on Windows/);
    const b = load({ localHost: "ha", hosts: { [n]: ENTRY } });
    assert.ok(b.error?.startsWith(`${F}: "hosts.${n}" `), b.error);
    assert.match(b.error, /reserved device name on Windows/);
  }
  for (const n of ["console", "com10", "lpt0"]) {
    assert.equal(load({ localHost: n }).error, undefined, n);
    assert.equal(load({ localHost: "ha", hosts: { [n]: ENTRY } }).error, undefined, n);
  }
});
