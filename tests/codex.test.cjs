const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexBackend, DEFAULT_MODEL, DEFAULT_ENDPOINT, SSEParser } = require('../addon/content/codex.js');

const encoder = new TextEncoder();
const packet = event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
const delta = text => ({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text });
const complete = (text = '答案', model = DEFAULT_MODEL) => ({ type: 'response.completed', response: {
  status: 'completed', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
} });

function response(events, { status = 200, chunkSize = 100000, keepOpen = false, contentType = 'text/event-stream' } = {}) {
  const bytes = encoder.encode(typeof events === 'string' ? events : events.map(packet).join(''));
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      } else if (!keepOpen) controller.close();
    },
    cancel() { cancelled = true; }
  });
  return { ok: status >= 200 && status < 300, status, body,
    headers: new Headers({ 'Content-Type': contentType }),
    get cancelled() { return cancelled; }
  };
}

function fixture(options = {}) {
  const calls = [];
  const authCalls = [];
  const authProvider = { async getCredentials(args) {
    authCalls.push(args);
    if (options.getCredentials) return options.getCredentials(args);
    return { accessToken: args.forceRefresh ? 'refreshed-test-secret' : 'test-secret', accountKey: 'account-test' };
  } };
  const backend = new CodexBackend({ authProvider, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return options.fetchImpl ? options.fetchImpl(url, init, calls.length) : response([delta('答案'), complete()]);
  }, runTimeoutMs: options.runTimeoutMs || 2000 });
  return { backend, calls, authCalls };
}

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('condition did not become true');
}

test('connect reads existing auth and returns no credentials or account identifiers; no network', async () => {
  const { backend, calls, authCalls } = fixture();
  const metadata = await backend.connect();
  assert.deepEqual(metadata.account, { type: 'chatgpt' });
  assert.equal(metadata.settings.model, 'gpt-6-luna');
  assert.ok(!JSON.stringify(metadata).includes('secret'));
  assert.ok(!JSON.stringify(metadata).includes('account-test'));
  assert.equal(calls.length, 0);
  assert.equal(authCalls.length, 1);
  assert.deepEqual((await backend.listModels()).map(x => x.model), ['gpt-6-luna']);
  assert.equal(calls.length, 0);
});

test('request stays native HTTP, disables tools, uses Luna and backend model defaults', async () => {
  const { backend, calls } = fixture();
  const deltas = [];
  assert.deepEqual(await backend.run({ prompt: 'paper text', onDelta: x => deltas.push(x) }), { text: '答案', model: 'gpt-6-luna' });
  assert.equal(deltas.join(''), '答案');
  const { url, init } = calls[0];
  assert.equal(url, DEFAULT_ENDPOINT);
  assert.equal(init.headers.Authorization, 'Bearer test-secret');
  assert.equal(Object.hasOwn(init.headers, 'ChatGPT-Account-ID'), false);
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  const payload = JSON.parse(init.body);
  assert.equal(payload.model, 'gpt-6-luna');
  assert.deepEqual(payload.tools, []);
  assert.equal(payload.tool_choice, 'none');
  assert.equal(payload.store, false);
  assert.equal(payload.stream, true);
  assert.equal(payload.input[0].content[0].text, 'paper text');
  assert.ok(!('reasoning' in payload));
  assert.ok(!('temperature' in payload));
  assert.ok(!('max_output_tokens' in payload));
  assert.ok(!('previous_response_id' in payload));
});

test('SSE survives single-byte UTF-8/network chunks and CRLF', async () => {
  const events = [delta('中文🙂'), { type: 'response.output_text.done', text: '中文🙂' }, complete('中文🙂')];
  const { backend } = fixture({ fetchImpl: () => response(events.map(packet).join('').replace(/\n/g, '\r\n'), { chunkSize: 1 }) });
  const deltas = [];
  assert.equal((await backend.run({ prompt: 'q', onDelta: x => deltas.push(x) })).text, '中文🙂');
  assert.equal(deltas.join(''), '中文🙂');
});

test('SSE supports multiline data and final event without trailing delimiter', () => {
  const results = [];
  const parser = new SSEParser((data, event) => results.push({ data: JSON.parse(data), event }));
  parser.push(': heartbeat\r\nevent: test\r\ndata: {"x":\r');
  parser.push('\ndata: 1}\r\n\r\nevent: last\ndata: {"y":2}', true);
  assert.deepEqual(results, [{ data: { x: 1 }, event: 'test' }, { data: { y: 2 }, event: 'last' }]);
});

test('full text done/completed events and duplicate completion never duplicate output', async () => {
  const r = response([delta('答'), { type: 'response.output_text.done', text: '答案' }, complete(), complete()], { keepOpen: true });
  const { backend } = fixture({ fetchImpl: () => r });
  const deltas = [];
  assert.equal((await backend.run({ prompt: 'q', onDelta: x => deltas.push(x) })).text, '答案');
  assert.equal(deltas.join(''), '答案');
  assert.equal(r.cancelled, true);
});

test('completed event produces answer without any text deltas and closes a lingering stream', async () => {
  const r = response([complete()], { keepOpen: true });
  const { backend } = fixture({ fetchImpl: () => r });
  const deltas = [];
  assert.equal((await backend.run({ prompt: 'q', onDelta: x => deltas.push(x) })).text, '答案');
  assert.equal(deltas.join(''), '答案');
  assert.equal(r.cancelled, true);
});

test('401 forces one refresh and retries once with fresh credentials', async () => {
  const rejected = response('secret error page', { status: 401 });
  const { backend, calls, authCalls } = fixture({ fetchImpl: (_, __, count) => count === 1 ? rejected : response([complete()]) });
  await backend.run({ prompt: 'q' });
  assert.equal(calls.length, 2);
  assert.deepEqual(authCalls, [{ forceRefresh: false }, { forceRefresh: true, accountKey: 'account-test' }]);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer refreshed-test-secret');
  assert.equal(rejected.cancelled, true);
});

test('a second 401 fails with a clean login error without any further retry', async () => {
  const { backend, calls, authCalls } = fixture({ fetchImpl: () => response('echo test-secret', { status: 401 }) });
  await assert.rejects(backend.run({ prompt: 'q' }), error => error.code === 'LOGIN_EXPIRED' && !error.message.includes('secret'));
  assert.equal(calls.length, 2);
  assert.equal(authCalls.length, 2);
});

for (const [status, code] of [[403, 'ACCESS_DENIED'], [404, 'MODEL_UNAVAILABLE'], [429, 'RATE_LIMIT'], [400, 'HTTP_ERROR'], [500, 'HTTP_ERROR']]) {
  test('HTTP ' + status + ' does not expose raw sensitive error data or retry', async () => {
    const { backend, calls } = fixture({ fetchImpl: () => response('echo test-secret', { status }) });
    await assert.rejects(backend.run({ prompt: 'q' }), error => error.code === code && !error.message.includes('secret'));
    assert.equal(calls.length, 1);
  });
}

for (const type of ['function_call', 'web_search_call', 'mcp_call', 'computer_call', 'new_unknown_tool']) {
  test('tool output ' + type + ' is refused and stream cancelled', async () => {
    const r = response([{ type: 'response.output_item.added', item: { type } }, complete()], { keepOpen: true });
    const { backend } = fixture({ fetchImpl: () => r });
    await assert.rejects(backend.run({ prompt: 'q' }), { code: 'TOOLS_BLOCKED' });
    assert.equal(r.cancelled, true);
  });
}

test('tool call in terminal response is refused even if no earlier tool event arrived', async () => {
  const end = complete();
  end.response.output.push({ type: 'function_call', name: 'shell' });
  const { backend } = fixture({ fetchImpl: () => response([end]) });
  await assert.rejects(backend.run({ prompt: 'q' }), { code: 'TOOLS_BLOCKED' });
});

test('tool delta without output item is refused', async () => {
  const { backend } = fixture({ fetchImpl: () => response([{ type: 'response.function_call_arguments.delta', delta: '{}' }]) });
  await assert.rejects(backend.run({ prompt: 'q' }), { code: 'TOOLS_BLOCKED' });
});

test('cancellation before the request reads no auth and sends nothing', async () => {
  const { backend, calls, authCalls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(backend.run({ prompt: 'q', signal: controller.signal }), { name: 'AbortError', code: 'CANCELLED' });
  assert.equal(calls.length, 0);
  assert.equal(authCalls.length, 0);
});

test('cancellation interrupts a waiting stream', async () => {
  const r = response([delta('partial')], { keepOpen: true });
  const { backend } = fixture({ fetchImpl: () => r });
  const controller = new AbortController();
  const deltas = [];
  const result = backend.run({ prompt: 'q', signal: controller.signal, onDelta: x => deltas.push(x) });
  await until(() => deltas.length);
  controller.abort();
  await assert.rejects(result, { code: 'CANCELLED' });
  assert.equal(r.cancelled, true);
});

test('cancellation during auth and HTTP operations rejects promptly even when providers ignore abort', async () => {
  const a = fixture({ getCredentials: () => new Promise(() => {}) });
  const ca = new AbortController();
  const ra = a.backend.run({ prompt: 'q', signal: ca.signal });
  await until(() => a.authCalls.length);
  ca.abort();
  await assert.rejects(ra, { code: 'CANCELLED' });
  const b = fixture({ fetchImpl: () => new Promise(() => {}) });
  const cb = new AbortController();
  const rb = b.backend.run({ prompt: 'q', signal: cb.signal });
  await until(() => b.calls.length);
  cb.abort();
  await assert.rejects(rb, { code: 'CANCELLED' });
});

test('disconnect cancels its active request', async () => {
  const { backend, calls } = fixture({ fetchImpl: () => response([], { keepOpen: true }) });
  const result = backend.run({ prompt: 'q' });
  await until(() => calls.length);
  await backend.disconnect();
  await assert.rejects(result, { code: 'CANCELLED' });
});

test('response timeout, incomplete stream, malformed JSON and service failure are errors', async () => {
  const a = fixture({ runTimeoutMs: 10, fetchImpl: () => response([], { keepOpen: true }) });
  await assert.rejects(a.backend.run({ prompt: 'q' }), { code: 'RUN_TIMEOUT' });
  const b = fixture({ fetchImpl: () => response([delta('partial')]) });
  await assert.rejects(b.backend.run({ prompt: 'q' }), { code: 'INCOMPLETE_RESPONSE' });
  const c = fixture({ fetchImpl: () => response('data: broken\n\n') });
  await assert.rejects(c.backend.run({ prompt: 'q' }), { code: 'PROTOCOL_ERROR' });
  const d = fixture({ fetchImpl: () => response([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'private data' } } }]) });
  await assert.rejects(d.backend.run({ prompt: 'q' }), error => error.code === 'RESPONSE_FAILED' && !error.message.includes('private'));
});

test('model rejection never silently swaps Luna', async () => {
  const { backend, calls } = fixture({ fetchImpl: () => response([{ type: 'error', code: 'model_not_found' }]) });
  await assert.rejects(backend.run({ prompt: 'q' }), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).model, 'gpt-6-luna');
});

test('service reporting a different model is refused', async () => {
  const { backend } = fixture({ fetchImpl: () => response([complete('answer', 'other')]) });
  await assert.rejects(backend.run({ prompt: 'q' }), { code: 'MODEL_CHANGED' });
});

test('untrusted endpoints cannot receive credentials', () => {
  for (const endpoint of ['http://chatgpt.com/backend-api/codex/responses', 'https://evil.test/backend-api/codex/responses',
    'https://chatgpt.com.evil.test/backend-api/codex/responses', 'https://chatgpt.com/backend-api/codex/responses?forward=evil']) {
    assert.throws(() => new CodexBackend({ authProvider: { getCredentials() {} }, fetchImpl() {}, endpoint }), { code: 'UNTRUSTED_ENDPOINT' });
  }
});

test('missing credentials fails before HTTP and simultaneous requests are rejected', async () => {
  const a = fixture({ getCredentials: () => ({}) });
  await assert.rejects(a.backend.run({ prompt: 'q' }), { code: 'LOGIN_REQUIRED' });
  assert.equal(a.calls.length, 0);
  const b = fixture({ fetchImpl: () => response([], { keepOpen: true }) });
  const result = b.backend.run({ prompt: 'q' });
  await assert.rejects(b.backend.run({ prompt: 'q2' }), { code: 'BUSY' });
  await b.backend.disconnect();
  await assert.rejects(result, { code: 'CANCELLED' });
});

for (const [serviceCode, code, status] of [
  ['subscription_sharing_user_not_eligible', 'PLAN_INELIGIBLE', 403],
  ['subscription_sharing_usage_limit_exceeded', 'PLAN_LIMIT', 429],
  ['subscription_sharing_usage_unavailable', 'PLAN_UNAVAILABLE', 503],
  ['subscription_sharing_unsupported_capability', 'PLAN_UNSUPPORTED', 400],
  ['subscription_sharing_route_not_supported', 'PLAN_ROUTE_UNSUPPORTED', 403],
  ['chatpass_v2_scope_not_authorized', 'AUTH_PLAN_DISABLED', 403]
]) {
  test('public Responses error ' + serviceCode + ' maps to a safe actionable error without changing billing', async () => {
    const { backend, calls } = fixture({ fetchImpl: () => Response.json({ error: { code: serviceCode, message: 'echo private token', param: 'private param' } },
      { status, headers: { 'x-request-id': 'req_synthetic' } }) });
    await assert.rejects(backend.run({ prompt: 'Synthetic source' }), error => {
      assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.requestID, 'req_synthetic');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private token|private param/); return true;
    });
    assert.equal(calls.length, 1);
  });
}

test('a plan limit received after streaming is a failure and cannot produce a completed translation', async () => {
  const { backend } = fixture({ fetchImpl: () => response([delta('Partial'), { type: 'response.failed', response: {
    error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private' }
  } }]) });
  const deltas = []; await assert.rejects(backend.run({ prompt: 'Synthetic', onDelta: x => deltas.push(x) }), { code: 'PLAN_LIMIT' });
  assert.deepEqual(deltas, ['Partial']);
});
