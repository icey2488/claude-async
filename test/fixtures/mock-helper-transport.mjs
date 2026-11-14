// Test-only Node preload: redirects fixed helper destinations to a canary recorder.
// No production module reads these variables or exposes a destination override.
import http from "node:http";
const original = http.request;
http.request = function(options, ...rest) {
 if (options && typeof options === "object" && options.host === "127.0.0.1" && [7842,11434].includes(Number(options.port))) {
  const port=Number(process.env.SAFE_MODE_TEST_RECORDER_PORT);
  if (!Number.isInteger(port) || port < 1) throw new Error("missing canary recorder port");
  return original.call(this,{...options,port,agent:false},...rest);
 }
 throw new Error("test preload refuses unexpected HTTP destination");
};
