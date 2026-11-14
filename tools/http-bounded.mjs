import http from "node:http";

// One absolute timer owns the socket, not just the caller's promise.
export function boundedRequest({ host, port, path, method = "GET", body, deadlineMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let req, response, done = false, timer;
    const finish = (error, result, abort = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (abort || error) { response?.destroy(); req?.destroy(); }
      if (error) reject(error); else resolve(result);
    };
    timer = setTimeout(() => finish(new Error("absolute deadline exceeded")), deadlineMs);
    try {
      const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
      req = http.request({ host, port, path, method,
        ...(payload ? { headers: { "content-type": "application/json", "content-length": payload.length } } : {}) },
      res => {
        response = res;
        const chunks = [];
        let total = 0;
        const result = truncated => ({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated });
        res.on("data", c => {
          if (done) return;
          const part = c.subarray(0, maxBytes - total);
          chunks.push(part); total += part.length;
          if (total >= maxBytes) finish(null, result(true), true);
        });
        res.on("end", () => finish(null, result(false)));
        res.on("error", e => finish(e));
        res.on("aborted", () => finish(new Error("response aborted")));
      });
      req.on("error", e => finish(e));
      req.end(payload);
    } catch (e) { finish(e); }
  });
}
