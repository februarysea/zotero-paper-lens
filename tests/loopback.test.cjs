const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, createListener } = require('../addon/content/loopback.js');
const request = (path = '/auth/callback?state=expected&code=test', host = '127.0.0.1:54321', extra = '') => 'GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\n' + extra + '\r\n';
const options = { port: 54321, state: 'expected' };

test('callback accepts only its exact loopback host, path and pending state', () => {
  const result = parseRequest(request(), options); assert.equal(result.status, 200); assert.equal(result.query.get('code'), 'test');
  for (const text of [request(undefined, 'evil.invalid'), request(undefined, 'localhost:54321'), request('//evil.invalid/auth/callback?state=expected'),
    request('/other?state=expected'), request('/auth/callback?state=wrong'), request('/auth/callback?state=expected&state=expected'),
    request(undefined, undefined, 'Host: 127.0.0.1:54321\r\n'), request(undefined, undefined, 'Origin: https://evil.invalid\r\n'),
    request(undefined, undefined, 'Content-Length: 1\r\n')]) assert.notEqual(parseRequest(text, options).status, 200);
  assert.equal(parseRequest('GET /auth/callback HTTP/1.1\r\n', options), null);
  assert.equal(parseRequest('a'.repeat(16385), options).status, 400);
});
function native() {
  let handler, closed = false, timeout;
  const calls = [], writes = [], headers = [];
  class HttpServer {
    constructor() { this.identity = { primaryPort: 54321, setPrimary: (...args) => calls.push(['primary', ...args]) }; }
    start(port) { calls.push(['start', port]); }
    stop() { closed = true; return Promise.resolve(); }
    registerPrefixHandler(path, callback) { calls.push(['handler', path]); handler = callback; }
  }
  const listener = createListener({ state: 'expected', ChromeUtils: { importESModule: uri => {
    assert.equal(uri, 'chrome://remote/content/server/httpd.sys.mjs'); return { HttpServer };
  } }, setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {} });
  function receive(query = 'state=expected&code=test', host = '127.0.0.1:54321') {
    let status;
    handler({ method: 'GET', path: '/auth/callback', queryString: query, httpVersion: '1.1', getHeader: () => host, hasHeader: () => false },
      { setStatusLine: (_v, code) => { status = code; }, setHeader: (...args) => headers.push(args), write: value => writes.push(value) });
    return status;
  }
  return { listener, calls, writes, headers, receive, timeout: () => timeout(), get closed() { return closed; } };
}

test('native HTTP listener binds loopback only, flushes a generic response and closes on success', async () => {
  const h = native(); assert.deepEqual(h.calls[0], ['start', -1]); assert.deepEqual(h.calls[1], ['primary', 'http', '127.0.0.1', 54321]);
  assert.equal(h.receive(), 200); const query = await h.listener.result;
  assert.equal(query.get('state'), 'expected'); assert.equal(h.closed, true);
  assert.ok(h.headers.some(x => x[0] === 'Cache-Control' && x[1] === 'no-store'));
  assert.doesNotMatch(h.writes[0], /code=test|state=expected/); h.listener.close();
});

test('invalid callbacks do not consume a pending authorization', async () => {
  const h = native(); assert.equal(h.receive('state=wrong&code=test'), 400); assert.equal(h.closed, false);
  assert.equal(h.receive(), 200); await h.listener.result;
});

test('cancellation and timeout release the loopback socket and reject the pending authorization', async () => {
  for (const cancel of [true, false]) {
    const h = native(); if (cancel) h.listener.close(); else h.timeout();
    await assert.rejects(h.listener.result, { code: cancel ? 'AUTH_CANCELLED' : 'AUTH_TIMEOUT' }); assert.equal(h.closed, true);
  }
});
