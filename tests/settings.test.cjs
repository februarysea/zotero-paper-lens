const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Settings = require('../addon/content/settings.js');
const OAuth = require('../addon/content/oauth.js');
const model = (slug, visibility = 'list') => ({ slug, visibility, display_name: 'Untrusted display text', priority: 99 });
function fixture({ credentialError, payload, status = 200, fetchImpl, timeoutMs } = {}) {
  let activeID = 'account-one'; const calls = [];
  const auth = { getCredentials: async () => {
    if (credentialError) throw Object.assign(new Error('must-never-expose'), { code: credentialError });
    return { accessToken: 'synthetic-secret', accountKey: activeID };
  }, getState: async () => ({ activeID, planEnabled: true }) };
  const reader = Settings.createSettingsReader({ authProvider: auth, timeoutMs, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return fetchImpl ? fetchImpl(url, init) : Response.json(payload || { models: [model('gpt-6-sol'), model('gpt-6-luna')] }, { status });
  } });
  return { reader, calls, switchAccount: () => { activeID = 'account-two'; } };
}

test('public account catalog retains server ordering and actual identifiers while hiding non-list models', () => {
  const result = Settings.parseModelCatalog({ models: [model('gpt-6-sol'), model('hidden', 'hide'), model('gpt-6-luna'), model('gpt-6-sol'),
    model('bad model'), model('codex-default'), { slug: 'missing-visibility' }] });
  assert.deepEqual(result.map(x => x.model), ['gpt-6-sol', 'gpt-6-luna']);
  assert.ok(result.every(x => x.id === x.model && x.displayName === x.model && x.available === true));
  assert.deepEqual(Object.keys(result[0]).sort(), ['available', 'displayName', 'id', 'model']);
});

test('native model lookup sends credentials only to the fixed public catalog and defaults to Luna', async () => {
  const h = fixture(); const result = await h.reader.read();
  assert.equal(h.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(h.calls[0].init.headers.Authorization, 'Bearer synthetic-secret'); assert.equal(h.calls[0].init.redirect, 'error');
  assert.equal(result.defaultModel, 'gpt-6-luna'); assert.equal(result.models[0].model, 'gpt-6-luna');
  assert.equal(result.source, 'account'); assert.equal(result.accountKey, 'account-one'); assert.equal(result.connected, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|Untrusted/);
});

test('Luna stays selected but is explicitly unavailable when absent from the authorized catalog', async () => {
  const h = fixture({ payload: { models: [model('gpt-6-sol')] } }); const result = await h.reader.read();
  assert.equal(result.models[0].model, 'gpt-6-luna'); assert.equal(result.models[0].available, false);
  assert.equal(result.models[1].available, true);
});

test('no login or plan permission sends no request and preserves only the default model', async () => {
  for (const credentialError of ['AUTH_MISSING', 'AUTH_PLAN_DISABLED', 'AUTH_EXPIRED']) {
    const h = fixture({ credentialError }); const result = await h.reader.read();
    assert.equal(h.calls.length, 0); assert.deepEqual(result.warnings, [credentialError]);
    assert.deepEqual(result.models.map(x => x.model), ['gpt-6-luna']); assert.equal(result.connected, false);
  }
});

test('account changes during catalog loading discard the previous account models', async () => {
  let release; const h = fixture({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.reader.read(); await new Promise(resolve => setImmediate(resolve));
  h.switchAccount(); release(Response.json({ models: [model('old-account-only')] }));
  const result = await pending; assert.deepEqual(result.models.map(x => x.model), ['gpt-6-luna']);
  assert.deepEqual(result.warnings, ['AUTH_ACCOUNT_CHANGED']);
});

test('malformed, hidden-only and excessive catalogs recover without leaking error content', async () => {
  for (const payload of [{ detail: 'private' }, { models: [] }, { models: [model('only-hidden', 'hide')] }, { models: Array(2001).fill(model('model')) }]) {
    const result = await fixture({ payload }).reader.read();
    assert.deepEqual(result.warnings, ['MODEL_CATALOG_UNAVAILABLE']); assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('HTTP and network failures do not expose tokens or service bodies', async () => {
  const http = await fixture({ payload: { error: 'private token' }, status: 403 }).reader.read();
  assert.deepEqual(http.warnings, ['MODEL_CATALOG_UNAVAILABLE']);
  const network = await fixture({ fetchImpl: () => { throw new Error('secret URL'); } }).reader.read();
  assert.doesNotMatch(JSON.stringify(network), /secret|private/);
});

test('catalog timeout terminates even if transport ignores abort', async () => {
  const h = fixture({ fetchImpl: () => new Promise(() => {}), timeoutMs: 5 });
  const result = await h.reader.read(); assert.deepEqual(result.warnings, ['MODEL_CATALOG_UNAVAILABLE']);
});

test('browser global and CommonJS only expose catalog readers, with no Codex file access', () => {
  const source = fs.readFileSync(require.resolve('../addon/content/settings.js'), 'utf8');
  const scope = { PaperLensOAuth: OAuth }; vm.runInNewContext(source, scope);
  assert.equal(scope.PaperLensSettings.ENDPOINT, Settings.ENDPOINT);
  assert.doesNotMatch(source, /readUTF8|models_cache|config\.toml|Services\.env|auth\.json/);
});
