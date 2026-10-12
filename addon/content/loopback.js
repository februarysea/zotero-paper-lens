/* A temporary native loopback listener for OAuth; it exposes no application API. */
var PaperLensLoopback = (function () {
  "use strict";
  const PATH = "/auth/callback";
  function parseRequest(text, { port, state, URLImpl = URL }) {
    if (text.length > 16384 || /[^\x09\x0A\x0D\x20-\x7E]/.test(text)) return { status: 400 };
    const end = text.indexOf("\r\n\r\n");
    if (end === -1) return null;
    const lines = text.slice(0, end).split("\r\n");
    const first = /^GET (\/[^ ]*) HTTP\/1\.[01]$/.exec(lines.shift());
    if (!first) return { status: 405 };
    const hosts = lines.filter(line => /^host:/i.test(line));
    if (hosts.length !== 1 || hosts[0].slice(5).trim() !== "127.0.0.1:" + port
      || lines.some(line => /^(?:content-length|transfer-encoding|origin):/i.test(line))) return { status: 400 };
    let url;
    try { url = new URLImpl(first[1], "http://127.0.0.1:" + port); } catch (_) { return { status: 400 }; }
    if (url.origin !== "http://127.0.0.1:" + port || url.pathname !== PATH || url.hash) return { status: 404 };
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) return { status: 400 };
    return { status: 200, query: url.searchParams };
  }
  function createListener({ ChromeUtils, setTimeout, clearTimeout, URLImpl = URL,
    state, timeoutMs = 180000, successText = "You can return to Zotero. / 可以返回 Zotero。" }) {
    let server;
    try {
      const { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");
      server = new HttpServer();
      // The bundled server's start() binds loopback only; -1 selects an available port.
      server.start(-1);
      server.identity.setPrimary("http", "127.0.0.1", server.identity.primaryPort);
    } catch (_) { throw Object.assign(new Error("AUTH_CALLBACK_UNAVAILABLE"), { code: "AUTH_CALLBACK_UNAVAILABLE" }); }
    const port = server.identity.primaryPort;
    let settled = false, resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
    function finish(query, code) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // stop() closes the listening socket and lets the native server flush the current response.
      try { Promise.resolve(server.stop()).catch(() => {}); } catch (_) {}
      if (code) reject(Object.assign(new Error(code), { code })); else resolve(query);
    }
    server.registerPrefixHandler("/", (request, response) => {
      let parsed = { status: 400 };
      try {
        if (request.method === "GET" && !settled) {
          const headers = ["Host: " + request.getHeader("Host")];
          for (const name of ["Origin", "Content-Length", "Transfer-Encoding"]) {
            if (request.hasHeader(name)) headers.push(name + ": " + request.getHeader(name));
          }
          parsed = parseRequest("GET " + request.path + (request.queryString ? "?" + request.queryString : "")
            + " HTTP/1.1\r\n" + headers.join("\r\n") + "\r\n\r\n", { port, state, URLImpl }) || parsed;
        }
      } catch (_) {}
      response.setStatusLine(request.httpVersion, parsed.status, parsed.status === 200 ? "OK" : "Bad Request");
      response.setHeader("Content-Type", "text/html; charset=utf-8", false);
      response.setHeader("Cache-Control", "no-store", false);
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'", false);
      response.setHeader("Referrer-Policy", "no-referrer", false);
      response.setHeader("Connection", "close", false);
      const message = parsed.query ? successText : "The authorization callback was not accepted.";
      response.write("<!doctype html><meta charset=utf-8><title>Paper Lens</title><p>"
        + Array.from(message, ch => "&#" + ch.codePointAt(0) + ";").join("") + "</p>");
      if (parsed.query) finish(parsed.query);
    });
    const timer = setTimeout(() => finish(null, "AUTH_TIMEOUT"), timeoutMs);
    return { redirectURI: "http://127.0.0.1:" + port + PATH, result,
      close() { finish(null, "AUTH_CANCELLED"); } };
  }
  return { createListener, parseRequest, PATH };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensLoopback;
