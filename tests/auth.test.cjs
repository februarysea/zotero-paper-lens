const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, generateKeyPairSync, sign } = require('node:crypto');
const { AuthProvider, createFileStore, validateStore } = require('../addon/content/auth.js');
const OAuth = require('../addon/content/oauth.js');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const metadata = { issuer: OAuth.ISSUER, authorization_endpoint: OAuth.AUTHORIZE, token_endpoint: OAuth.TOKEN,
  jwks_uri: OAuth.ISSUER + '/.well-known/jwks.json', revocation_endpoint: OAuth.ISSUER + '/api/accounts/oauth/revoke' };
const NOW = 1791782400000;
const clone = x => structuredClone(x);
function jwt(overrides = {}, header = {}) {
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', kid: jwk.kid, ...header }) + '.' + encode({ iss: OAuth.ISSUER,
    aud: 'oaiapp_test', sub: 'synthetic-subject', email: 'reader@example.invalid', iat: NOW / 1000,
    exp: NOW / 1000 + 3600, nonce: 'test-nonce', ...overrides });
  return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
}
function saved({ expiresAt = NOW + 3600000, scopes = [OAuth.PLAN_SCOPE], refreshToken = 'test-refresh' } = {}) {
  return { version: 1, hostID: 'urn:uuid:00000000-0000-4000-8000-000000000001', activeID: 'account-one', registrations: [{
    id: 'account-one', clientID: 'oaiapp_test', subject: 'synthetic-subject', email: 'reader@example.invalid',
    tokens: { accessToken: 'test-access', refreshToken, idToken: jwt(), expiresAt, scopes }
  }] };
}
function fixture({ data = null, token, launch, discovery = metadata, revokeStatus = 200, wait = false, fetchOverride, setTimer } = {}) {
  let storage = clone(data), authURL, callbackResolve, callbackReject, listenerClosed = false;
  const writes = [], calls = [];
  const provider = new AuthProvider({ cryptoImpl: webcrypto, encode: btoa, decode: atob, now: () => NOW,
    setTimer, store: { read: async () => clone(storage), write: async value => { storage = clone(value); writes.push(clone(value)); } },
    listen: async () => {
      const result = new Promise((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; }); result.catch(() => {});
      return { redirectURI: 'http://127.0.0.1:54321/auth/callback', result,
        close() { listenerClosed = true; callbackReject(Object.assign(new Error('cancelled'), { code: 'AUTH_CANCELLED' })); } };
    },
    openBrowser: async url => {
      authURL = new URL(url);
      if (launch) await launch(authURL, { resolve: callbackResolve, reject: callbackReject, provider });
      else if (!wait) callbackResolve(new URLSearchParams({ state: authURL.searchParams.get('state'), code: 'test-code', client_id: 'oaiapp_test' }));
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (fetchOverride) return fetchOverride(url, init);
      if (url === OAuth.DISCOVERY) return Response.json(discovery);
      if (url === metadata.jwks_uri) return Response.json({ keys: [jwk] });
      if (url === metadata.revocation_endpoint) return new Response('', { status: revokeStatus });
      if (url === OAuth.TOKEN) {
        const form = new URLSearchParams(init.body);
        if (token) return token(form, authURL);
        return Response.json({ access_token: 'new-test-access', refresh_token: 'rotated-test-refresh', token_type: 'Bearer', expires_in: 3600,
          ...(form.get('grant_type') === 'authorization_code' ? { id_token: jwt({ nonce: authURL.searchParams.get('nonce') }) } : {}), scope: OAuth.SCOPES });
      }
      throw new Error('Unexpected URL');
    }
  });
  return { provider, calls, writes, get storage() { return storage; }, get authURL() { return authURL; }, get listenerClosed() { return listenerClosed; } };
}
async function until(fn) {
  for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 1)); }
  throw new Error('Condition was not reached');
}

test('first sign-in performs independent dynamic OAuth, verifies identity, and exposes no credentials in state', async () => {
  const h = fixture(); const state = await h.provider.signIn();
  const q = h.authURL.searchParams;
  assert.equal(h.authURL.origin + h.authURL.pathname, OAuth.AUTHORIZE);
  assert.equal(q.get('client_id'), 'dynamic_agent_client');
  assert.equal(q.get('agent_name_hint'), 'Paper Lens');
  assert.equal(q.get('scope'), OAuth.SCOPES); assert.equal(q.get('resource'), OAuth.RESOURCE);
  assert.equal(q.get('code_challenge_method'), 'S256'); assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.has('id_token_hint'), false); assert.equal(q.has('login_hint'), false);
  assert.equal(state.connected, true); assert.equal(state.planEnabled, true); assert.equal(state.signingIn, false);
  assert.equal(h.storage.registrations[0].clientID, 'oaiapp_test');
  assert.equal(h.storage.registrations[0].subject, 'synthetic-subject'); assert.equal(h.listenerClosed, true);
  assert.doesNotMatch(JSON.stringify(state), /test-access|refresh|id_token|clientID|subject/);
  const request = h.calls.find(x => x.url === OAuth.TOKEN);
  const form = new URLSearchParams(request.init.body);
  assert.equal(form.get('client_id'), 'oaiapp_test'); assert.equal(form.get('redirect_uri'), q.get('redirect_uri'));
  assert.equal(form.has('client_secret'), false); assert.equal(request.init.redirect, 'error');
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')));
  assert.equal(Buffer.from(digest).toString('base64url'), q.get('code_challenge'));
  await h.provider.dispose();
});

test('returning sign-in reuses the issued client and stable host instead of registering again', async () => {
  const h = fixture({ data: saved() }); await h.provider.signIn('account-one');
  assert.equal(h.authURL.searchParams.get('client_id'), 'oaiapp_test');
  assert.equal(h.authURL.searchParams.has('agent_name_hint'), false);
  assert.equal(h.authURL.searchParams.get('ext_agent_host_id'), saved().hostID);
  assert.equal(h.storage.registrations.length, 1);
  assert.equal((await h.provider.getCredentials()).accessToken, 'new-test-access'); await h.provider.dispose();
});

test('valid saved credentials are reused without network or writes', async () => {
  const h = fixture({ data: saved() });
  assert.deepEqual(await h.provider.getCredentials(), { accessToken: 'test-access', accountKey: 'account-one' });
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0); await h.provider.dispose();
});

test('declined authorization preserves the existing account and never exchanges a code', async () => {
  const h = fixture({ data: saved(), launch: (url, cb) => cb.resolve(new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied' })) });
  await assert.rejects(h.provider.signIn(), { code: 'AUTH_DECLINED' });
  assert.deepEqual(h.storage, saved()); assert.equal(h.calls.some(x => x.url === OAuth.TOKEN), false); assert.equal(h.listenerClosed, true);
  await h.provider.dispose();
});

test('invalid state or changed client ID is rejected before token exchange', async () => {
  for (const bad of ['state', 'client']) {
    const h = fixture({ data: saved(), launch: (url, cb) => cb.resolve(new URLSearchParams({
      state: bad === 'state' ? 'wrong' : url.searchParams.get('state'), code: 'test-code', client_id: bad === 'client' ? 'oaiapp_other' : 'oaiapp_test' })) });
    await assert.rejects(h.provider.signIn('account-one'), { code: 'AUTH_CALLBACK_INVALID' });
    assert.deepEqual(h.storage, saved()); assert.equal(h.calls.some(x => x.url === OAuth.TOKEN), false); await h.provider.dispose();
  }
});

test('a cancelled sign-in closes the listener and cannot replace the active account', async () => {
  const h = fixture({ data: saved(), wait: true }); const pending = h.provider.signIn();
  await until(() => h.authURL); await assert.rejects(h.provider.signIn(), { code: 'AUTH_BUSY' });
  h.provider.cancelSignIn(); await assert.rejects(pending, { code: 'AUTH_CANCELLED' });
  assert.deepEqual(h.storage, saved()); assert.equal(h.listenerClosed, true); await h.provider.dispose();
});

test('OIDC rejects a changed account, incorrect nonce, bad signature, expiry, issuer, audience and unsigned token', async () => {
  const cases = [{ sub: 'other-subject' }, { nonce: 'wrong' }, { exp: NOW / 1000 - 300 }, { iss: 'https://evil.invalid' },
    { aud: 'oaiapp_other' }, { aud: ['oaiapp_test', 'other'] }, { iat: NOW / 1000 + 1000 }];
  for (const claims of cases) {
    const h = fixture({ data: saved(), token: (_form, url) => Response.json({ access_token: 'replacement', token_type: 'Bearer', expires_in: 3600,
      scope: OAuth.SCOPES, id_token: jwt({ nonce: url.searchParams.get('nonce'), ...claims }) }) });
    await assert.rejects(h.provider.signIn('account-one'), { code: 'AUTH_IDENTITY_INVALID' });
    assert.deepEqual(h.storage, saved()); await h.provider.dispose();
  }
  const base = { clientID: 'oaiapp_test', nonce: 'test-nonce', metadata, jwks: { keys: [jwk] }, cryptoImpl: webcrypto, decode: atob, now: () => NOW };
  await assert.rejects(OAuth.verifyIDToken(jwt({}, { alg: 'none' }), base), { code: 'AUTH_IDENTITY_INVALID' });
  const signed = jwt(); await assert.rejects(OAuth.verifyIDToken(signed.slice(0, -8) + 'aaaaaaaa', base), { code: 'AUTH_IDENTITY_INVALID' });
  await assert.rejects(OAuth.verifyIDToken(jwt({}, { jku: 'https://evil.invalid/key' }), base), { code: 'AUTH_IDENTITY_INVALID' });
});

test('identity-only sign-in is retained but never enables inference', async () => {
  const h = fixture({ token: (_form, url) => Response.json({ access_token: 'identity-only', token_type: 'Bearer', expires_in: 3600,
    id_token: jwt({ nonce: url.searchParams.get('nonce') }), scope: 'openid profile email' }) });
  const state = await h.provider.signIn(); assert.equal(state.connected, true); assert.equal(state.planEnabled, false);
  await assert.rejects(h.provider.getCredentials(), { code: 'AUTH_PLAN_DISABLED' }); await h.provider.dispose();
});

test('an issued registration survives an expired authorization code, without activating it', async () => {
  const h = fixture({ token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  await assert.rejects(h.provider.signIn(), { code: 'AUTH_TOKEN_FAILED' });
  assert.equal(h.storage.registrations[0].clientID, 'oaiapp_test'); assert.equal(h.storage.activeID, null);
  assert.equal(h.storage.registrations[0].tokens, null); await h.provider.dispose();
});

test('expired credentials refresh once across concurrent calls and replace rotating tokens atomically', async () => {
  const h = fixture({ data: saved({ expiresAt: NOW - 1 }) });
  const credentials = await Promise.all([h.provider.getCredentials(), h.provider.getCredentials()]);
  assert.equal(credentials[0].accessToken, 'new-test-access'); assert.deepEqual(credentials[0], credentials[1]);
  assert.equal(h.calls.filter(x => x.url === OAuth.TOKEN).length, 1); assert.equal(h.writes.length, 1);
  const form = new URLSearchParams(h.calls.find(x => x.url === OAuth.TOKEN).init.body);
  assert.equal(form.get('client_id'), 'oaiapp_test'); assert.equal(form.get('resource'), OAuth.RESOURCE); assert.equal(form.has('scope'), false);
  assert.equal(h.storage.registrations[0].tokens.refreshToken, 'rotated-test-refresh'); await h.provider.dispose();
});

test('terminal refresh failures clear only credentials, while temporary failures preserve them', async () => {
  for (const terminal of [true, false]) {
    const original = saved({ expiresAt: NOW - 1 });
    const h = fixture({ data: original, token: () => Response.json({ error: terminal ? 'invalid_grant' : 'temporary_failure', secret: 'never-expose' }, { status: terminal ? 400 : 503 }) });
    await assert.rejects(h.provider.getCredentials(), error => {
      assert.doesNotMatch(JSON.stringify(error) + error.message, /never-expose|test-refresh/);
      return error.code === (terminal ? 'AUTH_EXPIRED' : 'AUTH_TOKEN_FAILED');
    });
    assert.equal(h.storage.registrations[0].clientID, 'oaiapp_test');
    if (terminal) assert.equal(h.storage.registrations[0].tokens, null); else assert.deepEqual(h.storage, original);
    await h.provider.dispose();
  }
});

test('account changes during refresh cannot send one account credentials on another account retry', async () => {
  const data = saved({ expiresAt: NOW - 1 }); data.registrations.push({ ...clone(data.registrations[0]), id: 'account-two', clientID: 'oaiapp_two', subject: 'another-subject' });
  let release; const h = fixture({ data, token: () => new Promise(r => { release = r; }) });
  const pending = h.provider.getCredentials(); await until(() => release);
  await h.provider.switchAccount('account-two'); release(Response.json({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 }));
  await assert.rejects(pending, { code: 'AUTH_ACCOUNT_CHANGED' });
  await assert.rejects(h.provider.getCredentials({ accountKey: 'account-one' }), { code: 'AUTH_ACCOUNT_CHANGED' }); await h.provider.dispose();
});

test('sign-out revokes the renewable session, clears tokens and retains registration and host', async () => {
  const h = fixture({ data: saved() }); assert.deepEqual(await h.provider.signOut(), { remoteRevoked: true });
  const form = new URLSearchParams(h.calls.find(x => x.url === metadata.revocation_endpoint).init.body);
  assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.equal(form.get('client_id'), 'oaiapp_test');
  assert.equal(h.storage.registrations[0].tokens, null); assert.equal(h.storage.hostID, saved().hostID);
  assert.equal((await h.provider.getState()).connected, false); await h.provider.dispose();
});

test('unconfirmed remote revocation is reported while local sign-out still completes', async () => {
  const h = fixture({ data: saved(), revokeStatus: 503 });
  assert.deepEqual(await h.provider.signOut(), { remoteRevoked: false }); assert.equal(h.storage.registrations[0].tokens, null);
  assert.equal(h.calls.filter(x => x.url === metadata.revocation_endpoint).length, 2); await h.provider.dispose();
});

test('discovery cannot redirect credentials to an untrusted token or key origin', async () => {
  for (const field of ['token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
    const h = fixture({ discovery: { ...metadata, [field]: 'https://evil.invalid/secret' } });
    await assert.rejects(h.provider.signIn(), { code: 'AUTH_DISCOVERY_INVALID' });
    assert.equal(h.calls.length, 1); assert.equal(h.storage, null); await h.provider.dispose();
  }
});

test('network timeout remains effective even when fetch ignores AbortSignal and no secrets escape errors', async () => {
  let expired;
  const h = fixture({ data: saved({ expiresAt: NOW - 1 }), setTimer: fn => { expired = fn; return 1; }, fetchOverride: () => new Promise(() => {}) });
  const pending = h.provider.getCredentials(); await until(() => expired); expired();
  await assert.rejects(pending, { code: 'AUTH_NETWORK' }); await h.provider.dispose();
  const bad = fixture({ fetchOverride: () => { throw Object.assign(new Error('secret'), { code: 'access_token_secret' }); } });
  await assert.rejects(bad.provider.signIn(), error => error.code === 'AUTH_NETWORK' && !error.message.includes('secret')); await bad.provider.dispose();
});

test('stored credentials are bounded, allowlisted and isolated from Codex file paths', async () => {
  const calls = [];
  const store = createFileStore({ PathUtils: { profileDir: '/zotero-profile', join: (...x) => x.join('/') },
    IOUtils: { stat: async path => { calls.push(['stat', path]); throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); },
      makeDirectory: async (...x) => calls.push(['mkdir', ...x]), setPermissions: async (...x) => calls.push(['chmod', ...x]),
      writeUTF8: async (...x) => calls.push(['write', ...x]) } });
  assert.equal(await store.read(), null); await store.write(saved());
  assert.equal(calls[0][1], '/zotero-profile/paper-lens/auth.json');
  const write = calls.find(x => x[0] === 'write'); assert.equal(write[3].permissions, 0o600); assert.equal(write[3].tmpPath, write[1] + '.tmp');
  assert.ok(calls.some(x => x[0] === 'chmod' && x[2] === 0o700));
  const extra = saved(); extra.secret = 'discard'; extra.registrations[0].extra = 'discard';
  assert.equal(Object.hasOwn(validateStore(extra), 'secret'), false);
  const invalid = saved(); invalid.registrations.push(clone(invalid.registrations[0])); assert.throws(() => validateStore(invalid), { code: 'AUTH_FILE_INVALID' });
});
