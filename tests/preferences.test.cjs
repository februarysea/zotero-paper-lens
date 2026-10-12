const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Preferences = require('../addon/content/preferences.js');
const LUNA = 'gpt-6-luna', MODEL_PREF = 'extensions.paperlens.model';
class Element {
  constructor(tag = 'div') { Object.assign(this, { tagName: tag, children: [], listeners: new Map(), attributes: {}, isConnected: true, disabled: false, hidden: false, textContent: '', _value: '' }); }
  addEventListener(name, callback) { const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(x => x !== callback)); }
  async fire(name) { if (!this.disabled) await Promise.all((this.listeners.get(name) || []).map(fn => fn({ target: this }))); }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  get firstChild() { return this.children[0]; } get options() { return this.children; }
  get value() { return this._value; } set value(x) { this._value = this.tagName === 'select' && !this.children.some(c => c.value === x) ? '' : x; }
  setAttribute(name, value) { this.attributes[name] = value; } removeAttribute(name) { delete this.attributes[name]; }
}
const model = id => ({ id, model: id, displayName: 'Misleading label' });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function connectedAccount(id, label) {
  return { accounts: [{ id, label, connected: true, planEnabled: true }], activeID: id, connected: true, planEnabled: true };
}
function harness({ selected, read, auth, getAuthState, signIn, signOut, switchAccount, cancelSignIn } = {}) {
  const root = new Element(), win = new Element('window');
  const ids = ['model', 'model-refresh', 'model-status', 'account', 'auth-status', 'sign-in', 'sign-out', 'auth-cancel', 'usage'];
  const elements = new Map([['paperlens-preferences', root], ...ids.map(id => ['paperlens-' + id, new Element(['model', 'account'].includes(id) ? 'select' : 'div')])]);
  const nodes = Object.fromEntries(ids.map(id => [id, elements.get('paperlens-' + id)]));
  const prefs = new Map([[MODEL_PREF, selected]]), writes = [], calls = [], reads = [], authReads = [];
  let state = structuredClone(auth || { accounts: [], activeID: null, connected: false, planEnabled: false });
  const document = { defaultView: win, getElementById: id => elements.get(id), createElementNS: (_, tag) => new Element(tag),
    l10n: { setAttributes: (node, id, args) => { node.attributes['data-l10n-id'] = id; node.attributes.args = args; } } };
  const Zotero = { Prefs: { get: key => prefs.get(key), set: (key, value) => { writes.push({ key, value }); prefs.set(key, value); } },
    PaperLens: { getAuthState: async () => { authReads.push(1); const snapshot = structuredClone(state); return getAuthState ? getAuthState(snapshot) : snapshot; }, getModelOptions: () => { reads.push(1); return read ? read() : Promise.resolve({ models: [model(LUNA), model('gpt-6-sol')], warnings: state.connected ? [] : ['AUTH_MISSING'] }); },
      signIn: async id => { calls.push(['signIn', id]); if (signIn) return signIn(id); state = { accounts: [{ id: 'saved', label: 'Synthetic account', connected: true, planEnabled: true }], activeID: 'saved', connected: true, planEnabled: true }; return state; },
      signOut: async () => { calls.push(['signOut']); if (signOut) return signOut(); state.connected = false; state.planEnabled = false; return { remoteRevoked: true }; },
      switchAccount: async id => { calls.push(['switch', id]); if (switchAccount) return switchAccount(id); state.activeID = id; return state; },
      cancelSignIn: () => { calls.push(['cancel']); if (cancelSignIn) return cancelSignIn(); state.signingIn = false; }, openUsage: () => { calls.push(['usage']); },
      localizeError: error => 'Safe ' + (['AUTH_DECLINED', 'AUTH_CANCELLED', 'AUTH_NETWORK'].includes(error.code) ? error.code : 'error') } };
  nodes.model.addEventListener('change', () => Zotero.Prefs.set(MODEL_PREF, nodes.model.value));
  const controller = Preferences.create({ document, Zotero });
  return { root, win, elements, nodes, prefs, writes, reads, authReads, calls, document, Zotero, controller,
    setAuthState: value => { state = structuredClone(value); } };
}

test('native settings contain independent login controls, preserve model binding, and remove Codex auth path', () => {
  const source = fs.readFileSync(require.resolve('../addon/content/preferences.xhtml'), 'utf8');
  assert.match(source, /getScope\('paperlens-preferences'\)\.PaperLensPreferences\.init\(event\)/);
  assert.match(source, /preference="extensions\.paperlens\.model"/);
  assert.match(source, /<html:option value="gpt-6-luna">gpt-6-luna<\/html:option>/);
  for (const id of ['sign-in', 'sign-out', 'auth-cancel', 'account', 'usage']) assert.match(source, new RegExp('id="paperlens-' + id + '"'));
  assert.doesNotMatch(source, /authPath|auth-path|codex-default/);
});

test('automatic selection translation defaults off and uses a localized native preference checkbox', () => {
  const defaults = new Map();
  vm.runInNewContext(fs.readFileSync(require.resolve('../addon/prefs.js'), 'utf8'), { pref: (key, value) => defaults.set(key, value) });
  assert.equal(defaults.get('extensions.paperlens.autoTranslateSelection'), false);
  const source = fs.readFileSync(require.resolve('../addon/content/preferences.xhtml'), 'utf8');
  assert.match(source, /<checkbox id="paperlens-auto-translate-selection" preference="extensions\.paperlens\.autoTranslateSelection" data-l10n-id="paper-lens-preferences-auto-translate"\s*\/>/);
  assert.match(source, /data-l10n-id="paper-lens-preferences-auto-translate-help"/);
  for (const locale of ['en-US', 'zh-CN']) {
    const text = fs.readFileSync('addon/locale/' + locale + '/paper-lens.ftl', 'utf8');
    assert.match(text, /^paper-lens-preferences-auto-translate =\n\s+\.label = \S/m);
    assert.match(text, /^paper-lens-preferences-auto-translate-help = .+ChatGPT.+/m);
  }
});

test('disconnected settings show login instructions, default to actual Luna ID, and write no model preferences', async () => {
  const h = harness(); let waited; const ready = h.controller.init({ waitUntil: promise => { waited = promise; } }); await ready; await waited;
  assert.equal(h.nodes.model.value, LUNA); assert.equal(h.nodes.model.options[0].textContent, LUNA);
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-disconnected');
  assert.equal(h.nodes['model-status'].attributes['data-l10n-id'], 'paper-lens-preferences-model-login');
  assert.equal(h.nodes.account.value, '__new__'); assert.equal(h.nodes.account.options.length, 1);
  assert.equal(h.nodes.account.options[0].attributes['data-l10n-id'], 'paper-lens-preferences-account-connect');
  assert.equal(h.nodes['sign-out'].disabled, true); assert.deepEqual(h.writes, []); h.controller.dispose();
});

test('a connected saved account is the default option and its localized label marks the current account', async () => {
  const h = harness({ auth: connectedAccount('one', 'Synthetic One') }); await h.controller.init();
  assert.equal(h.nodes.account.value, 'one');
  const current = h.nodes.account.options.find(x => x.value === 'one');
  assert.equal(current.attributes['data-l10n-id'], 'paper-lens-preferences-account-current');
  assert.equal(current.attributes.args.account, 'Synthetic One');
  const add = h.nodes.account.options.find(x => x.value === '__new__');
  assert.equal(add.attributes['data-l10n-id'], 'paper-lens-preferences-account-new');
  assert.equal(h.nodes['auth-status'].attributes.args.account, 'Synthetic One');
  assert.equal(h.nodes['sign-out'].disabled, false); assert.deepEqual(h.calls, []); h.controller.dispose();
});

test('returning focus reads an externally completed login and displays its current saved account', async () => {
  const h = harness(); await h.controller.init();
  const modelReads = h.reads.length;
  h.setAuthState(connectedAccount('one', 'Synthetic One')); await h.win.fire('focus');
  assert.equal(h.nodes.account.value, 'one');
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-connected');
  assert.equal(h.nodes['auth-status'].attributes.args.account, 'Synthetic One');
  assert.equal(h.nodes['sign-out'].disabled, false);
  assert.equal(h.authReads.length, 2); assert.equal(h.reads.length, modelReads); assert.deepEqual(h.calls, []);
  h.controller.dispose();
});

test('the model refresh button also synchronizes the current account without switching it', async () => {
  const h = harness({ auth: connectedAccount('one', 'Synthetic One') }); await h.controller.init();
  h.setAuthState(connectedAccount('two', 'Synthetic Two')); await h.nodes['model-refresh'].fire('click');
  assert.equal(h.nodes.account.value, 'two');
  assert.equal(h.nodes['auth-status'].attributes.args.account, 'Synthetic Two');
  assert.equal(h.authReads.length, 2); assert.equal(h.reads.length, 2); assert.deepEqual(h.calls, []);
  h.controller.dispose();
});

test('an explicitly selected new account remains selected through focus and model refresh', async () => {
  const h = harness({ auth: connectedAccount('one', 'Synthetic One') }); await h.controller.init();
  h.nodes.account.value = '__new__'; await h.nodes.account.fire('change');
  for (const refresh of [() => h.win.fire('focus'), () => h.nodes['model-refresh'].fire('click')]) {
    await refresh();
    assert.equal(h.nodes.account.value, '__new__');
    assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-new');
    assert.equal(h.nodes['sign-out'].disabled, true);
  }
  assert.equal(h.authReads.length, 3); assert.deepEqual(h.calls, []); h.controller.dispose();
});

test('focus during a local sign-in does not refresh away the connecting state', async () => {
  const pending = deferred(); const h = harness({ signIn: () => pending.promise }); await h.controller.init();
  const signing = h.nodes['sign-in'].fire('click');
  h.setAuthState(connectedAccount('one', 'Synthetic One')); await h.win.fire('focus');
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-connecting');
  assert.equal(h.nodes['sign-in'].disabled, true); assert.equal(h.nodes['auth-cancel'].hidden, false);
  assert.equal(h.authReads.length, 1);
  pending.resolve({}); await signing;
  assert.equal(h.nodes.account.value, 'one');
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-connected');
  h.controller.dispose();
});

test('an older auth state response cannot overwrite a subsequently started sign-in', async () => {
  const pendingAuth = deferred(), pendingSignIn = deferred(); let authReads = 0;
  const h = harness({ getAuthState: state => ++authReads === 2 ? pendingAuth.promise : state, signIn: () => pendingSignIn.promise });
  await h.controller.init();
  const focusing = h.win.fire('focus'); await new Promise(resolve => setImmediate(resolve));
  const signing = h.nodes['sign-in'].fire('click');
  pendingAuth.resolve(connectedAccount('stale', 'Synthetic Stale')); await focusing;
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-connecting');
  assert.equal(h.nodes.account.value, '__new__');
  assert.equal(h.nodes.account.options.some(x => x.value === 'stale'), false);
  h.setAuthState(connectedAccount('current', 'Synthetic Current')); pendingSignIn.resolve({}); await signing;
  assert.equal(h.nodes.account.value, 'current');
  assert.equal(h.nodes['auth-status'].attributes.args.account, 'Synthetic Current'); h.controller.dispose();
});

test('a late rejected auth read cannot replace a newer account synchronization with an error', async () => {
  const pendingAuth = deferred(); let authReads = 0;
  const h = harness({ getAuthState: state => ++authReads === 2 ? pendingAuth.promise : state }); await h.controller.init();
  const olderFocus = h.win.fire('focus'); await new Promise(resolve => setImmediate(resolve));
  h.setAuthState(connectedAccount('current', 'Synthetic Current')); await h.win.fire('focus');
  pendingAuth.reject(Object.assign(new Error('synthetic secret'), { code: 'AUTH_NETWORK' })); await olderFocus;
  assert.equal(h.nodes.account.value, 'current');
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-connected');
  assert.equal(h.nodes['auth-status'].attributes.args.account, 'Synthetic Current');
  assert.doesNotMatch(h.nodes['auth-status'].textContent, /secret|AUTH_NETWORK/); h.controller.dispose();
});

test('a reopened pane reflects a global pending login and synchronizes its cancellation', async () => {
  const h = harness({ auth: { accounts: [], activeID: null, connected: false, planEnabled: false, signingIn: true } });
  await h.controller.init();
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-connecting');
  assert.equal(h.nodes.account.disabled, true); assert.equal(h.nodes['sign-in'].disabled, true);
  assert.equal(h.nodes['sign-out'].disabled, true); assert.equal(h.nodes['auth-cancel'].hidden, false);
  await h.nodes['sign-in'].fire('click'); assert.deepEqual(h.calls, []);
  await h.nodes['auth-cancel'].fire('click');
  assert.deepEqual(h.calls, [['cancel']]);
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-disconnected');
  assert.equal(h.nodes.account.disabled, false); assert.equal(h.nodes['sign-in'].disabled, false);
  assert.equal(h.nodes['auth-cancel'].hidden, true); assert.equal(h.authReads.length, 2); assert.equal(h.reads.length, 1);
  h.controller.dispose();
});

test('sign-in selects independent dynamic registration for a new account then updates connection and models', async () => {
  const h = harness(); await h.controller.init(); await h.nodes['sign-in'].fire('click');
  assert.deepEqual(h.calls, [['signIn', null]]); assert.equal(h.nodes.account.value, 'saved');
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-connected');
  assert.equal(h.nodes['sign-out'].disabled, false); assert.equal(h.reads.length, 2); h.controller.dispose();
});

test('saved account sign-in and account switching use local registration IDs, without exposing credentials', async () => {
  const auth = { accounts: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }], activeID: 'one', connected: true, planEnabled: true };
  const h = harness({ auth, signIn: async () => ({}) }); await h.controller.init();
  await h.nodes['sign-in'].fire('click'); assert.deepEqual(h.calls[0], ['signIn', 'one']);
  h.nodes.account.value = 'two'; await h.nodes.account.fire('change'); assert.deepEqual(h.calls.at(-1), ['switch', 'two']);
  h.nodes.account.value = '__new__'; await h.nodes.account.fire('change');
  assert.equal(h.nodes['sign-out'].disabled, true); assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-new');
  h.controller.dispose();
});

test('a pending sign-in disables repeat actions and allows cancellation', async () => {
  const pending = deferred(); const h = harness({ signIn: () => pending.promise }); await h.controller.init();
  const signing = h.nodes['sign-in'].fire('click'); assert.equal(h.nodes['sign-in'].disabled, true); assert.equal(h.nodes['auth-cancel'].hidden, false);
  await h.nodes['auth-cancel'].fire('click'); assert.deepEqual(h.calls.at(-1), ['cancel']);
  pending.reject(Object.assign(new Error('secret'), { code: 'AUTH_CANCELLED' })); await signing;
  assert.equal(h.nodes['sign-in'].disabled, false); assert.equal(h.nodes['auth-cancel'].hidden, true);
  assert.equal(h.nodes['auth-status'].textContent, 'Safe AUTH_CANCELLED'); h.controller.dispose();
});

test('a declined or failed authorization preserves existing model and exposes only localized error text', async () => {
  const h = harness({ selected: 'gpt-6-sol', signIn: async () => { throw Object.assign(new Error('credential secret'), { code: 'AUTH_DECLINED' }); } });
  await h.controller.init(); await h.nodes['sign-in'].fire('click');
  assert.equal(h.nodes.model.value, 'gpt-6-sol'); assert.equal(h.nodes['auth-status'].textContent, 'Safe AUTH_DECLINED');
  assert.doesNotMatch(h.nodes['auth-status'].textContent, /credential|secret/); assert.deepEqual(h.writes, []); h.controller.dispose();
});

test('remote revocation failure is visible after local sign-out, and usage opens the dedicated entry', async () => {
  const h = harness({ auth: { accounts: [{ id: 'one', label: 'One' }], activeID: 'one', connected: true, planEnabled: true }, signOut: async () => ({ remoteRevoked: false }) });
  await h.controller.init(); await h.nodes['sign-out'].fire('click');
  assert.equal(h.nodes['auth-status'].attributes['data-l10n-id'], 'paper-lens-preferences-auth-revoke-unconfirmed');
  await h.nodes.usage.fire('click'); assert.deepEqual(h.calls.at(-1), ['usage']); h.controller.dispose();
});

test('catalog refresh preserves a newer model choice and labels every option with its actual ID', async () => {
  const pending = deferred(); const h = harness({ read: () => pending.promise }); const ready = h.controller.init();
  await new Promise(resolve => setImmediate(resolve)); h.prefs.set(MODEL_PREF, 'gpt-6-astra');
  pending.resolve({ models: [model(LUNA), model('gpt-6-sol'), model('bad model'), model('codex-default')], warnings: [] });
  await ready; assert.equal(h.nodes.model.value, 'gpt-6-astra'); assert.ok(h.nodes.model.options.every(x => x.textContent === x.value));
  assert.deepEqual(h.writes, []); h.controller.dispose();
});

test('older catalog responses cannot overwrite the newer catalog or its loading state', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = harness({ read: () => ++count === 1 ? first.promise : second.promise }); const initial = h.controller.init();
  await new Promise(resolve => setImmediate(resolve)); const refresh = h.controller.refresh();
  second.resolve({ models: [model('new-account-model')], warnings: [], selectedAvailable: false }); await refresh;
  first.resolve({ models: [model('old-account-model')], warnings: [] }); await initial;
  assert.equal(h.nodes.model.options.some(x => x.value === 'old-account-model'), false);
  assert.equal(h.nodes['model-status'].attributes['data-l10n-id'], 'paper-lens-preferences-model-unavailable'); h.controller.dispose();
});

test('removed preference panes reject pending DOM updates without cancelling a validated global authorization', async () => {
  const pending = deferred(); const h = harness({ read: () => pending.promise }); const ready = h.controller.init();
  await new Promise(resolve => setImmediate(resolve)); h.controller.dispose();
  pending.resolve({ models: [model('obsolete')], warnings: [] }); await ready;
  assert.equal(h.nodes.model.options.some(x => x.value === 'obsolete'), false); assert.deepEqual(h.calls, []);
});

test('native model sync and persistence remain owned by Zotero, while unload detaches only plugin listeners', async () => {
  const h = harness(); const scope = { document: h.document, Zotero: h.Zotero };
  vm.runInNewContext(fs.readFileSync(require.resolve('../addon/content/preferences.js'), 'utf8'), scope);
  await scope.PaperLensPreferences.init(); await scope.PaperLensPreferences.init(); assert.equal(h.reads.length, 1);
  h.prefs.set(MODEL_PREF, 'manual-model'); await h.nodes.model.fire('syncfrompreference'); assert.equal(h.nodes.model.value, 'manual-model');
  await h.nodes.model.fire('change'); assert.deepEqual(h.writes, [{ key: MODEL_PREF, value: 'manual-model' }]);
  await h.win.fire('unload'); await h.nodes['model-refresh'].fire('click'); assert.equal(h.reads.length, 1);
  assert.equal(h.nodes.model.listeners.get('change').length, 1);
});

test('all dynamic settings messages and account/model aria attributes are localized in both languages', () => {
  const source = fs.readFileSync(require.resolve('../addon/content/preferences.js'), 'utf8');
  const ids = [...new Set([...source.matchAll(/"(paper-lens-preferences-[a-z-]+)"/g)].map(x => x[1]))];
  for (const locale of ['en-US', 'zh-CN']) {
    const text = fs.readFileSync('addon/locale/' + locale + '/paper-lens.ftl', 'utf8');
    for (const id of ids) assert.match(text, new RegExp('^' + id + ' =', 'm'));
    for (const id of ['account-select', 'model-select']) assert.match(text, new RegExp('paper-lens-preferences-' + id + ' =\\n\\s+\\.aria-label'));
  }
});
