const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;
const Cache = require('../addon/content/cache.js');
const FILE = '/profile/paper-lens/cache-v1.json';
const key = n => n.toString(16).padStart(64, '0');
const value = n => ({ original: 'Original passage ' + n, text: '完整译文 ' + n });
const input = overrides => ({ paperKey: '1:ATTACHMENT', model: 'gpt-6-luna', language: 'zh-CN', promptVersion: 'translate-v1',
  selection: 'The experiment shows a change.', context: { title: 'Paper title', paragraphs: ['Nearby passage.'] }, ...overrides });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
function fixture({ initial, IO = {}, clock = () => 1791900000000, cryptoImpl = webcrypto } = {}) {
  const files = new Map(initial === undefined ? [] : [[FILE, typeof initial === 'string' ? initial : JSON.stringify(initial) + '\n']]);
  const calls = [], errors = [];
  const IOUtils = {
    async stat(file) { calls.push(['stat', file]); if (!files.has(file)) throw Object.assign(new Error('private path'), { name: 'NotFoundError' });
      return { type: 'regular', size: Buffer.byteLength(files.get(file)) }; },
    async readUTF8(file) { calls.push(['readUTF8', file]); return files.get(file); },
    async makeDirectory(dir, options) { calls.push(['makeDirectory', dir, options]); },
    async setPermissions(file, permissions) { calls.push(['setPermissions', file, permissions]); },
    async writeUTF8(file, text, options) { calls.push(['writeUTF8', file, text, options]); files.set(file, text); },
    ...IO,
  };
  const settings = { IOUtils, PathUtils: { profileDir: '/profile', join: path.join }, cryptoImpl,
    TextEncoderImpl: TextEncoder, now: clock, onError: code => errors.push(code) };
  return { cache: Cache.createCache(settings), files, calls, errors, settings,
    writes: () => calls.filter(call => call[0] === 'writeUTF8'),
    saved: () => JSON.parse(files.get(FILE)) };
}

test('complete translations persist across cache instances with only allowed public record fields', async () => {
  const h = fixture(); const digest = await h.cache.makeKey(input());
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(await h.cache.put(digest, { ...value(1), accessToken: 'secret', context: 'full-paper-secret' }, h.cache.generation), true);
  assert.deepEqual(await h.cache.get(digest), value(1));
  const next = Cache.createCache(h.settings); assert.deepEqual(await next.get(digest), value(1));
  assert.equal(h.saved().version, 1);
  assert.deepEqual(Object.keys(h.saved()).sort(), ['entries', 'version']);
  assert.deepEqual(Object.keys(h.saved().entries[0]).sort(), ['createdAt', 'key', 'lastUsed', 'original', 'text']);
  assert.doesNotMatch(h.files.get(FILE), /secret|gpt-6-luna|Nearby passage|Paper title|ATTACHMENT/);
});

test('cache identity isolates every semantic field, canonicalizes context keys, and preserves array order', async () => {
  const h = fixture(); const original = await h.cache.makeKey(input());
  for (const changed of [{ paperKey: '2:ATTACHMENT' }, { model: 'gpt-6-sol' }, { language: 'en' }, { promptVersion: 'translate-v2' },
    { selection: 'A different experiment.' }, { context: { title: 'Different title', paragraphs: ['Nearby passage.'] } }]) {
    assert.notEqual(await h.cache.makeKey(input(changed)), original);
  }
  assert.equal(await h.cache.makeKey(input({ context: { paragraphs: ['Nearby passage.'], title: 'Paper title' } })), original);
  assert.notEqual(await h.cache.makeKey(input({ context: ['one', 'two'] })), await h.cache.makeKey(input({ context: ['two', 'one'] })));
  assert.equal(h.calls.length, 0, 'making a digest performs no file access');
});

test('actual translation prompts hash both language variants and invalidate when their instructions change', async () => {
  const { buildPrompt } = require('../addon/content/context.js');
  const h = fixture();
  for (const locale of ['zh-CN', 'en-US']) {
    const built = buildPrompt({ action: 'translate', locale, selection: 'A parameter measures the relaxation rate.',
      paper: { title: 'Dynamics', authors: ['A. Reader'], abstract: 'A study of relaxation.',
        text: 'A rate is a reciprocal time.\n\nA parameter measures the relaxation rate.\n\nIts unit is inverse seconds.' } });
    const semantic = { paperKey: '1:ATTACHMENT', model: 'gpt-6-luna', ...built.cacheInput };
    const digest = await h.cache.makeKey(semantic);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.notEqual(await h.cache.makeKey({ ...semantic, promptVersion: semantic.promptVersion + '\nNew translation rule.' }), digest);
  }
  assert.deepEqual(h.errors, []);
});

test('context from another script realm is accepted but instances and unsupported types are rejected', async () => {
  const h = fixture();
  const foreign = vm.runInNewContext('({ title: "Paper title", paragraphs: ["Nearby passage."] })');
  assert.equal(await h.cache.makeKey(input({ context: foreign })), await h.cache.makeKey(input()));
  const scoped = { TextEncoder }; vm.runInNewContext(fs.readFileSync(require.resolve('../addon/content/cache.js'), 'utf8'), scoped);
  const foreignCache = scoped.PaperLensCache.createCache(h.settings);
  assert.equal(await foreignCache.makeKey(input()), await h.cache.makeKey(input()));
  class Custom { constructor() { this.title = 'Paper title'; } }
  assert.equal(await h.cache.makeKey(input({ context: new Custom() })), null);
  assert.equal(await h.cache.makeKey(input({ context: new Date() })), null);
});

test('PDF line wrapping and repeated spaces normalize while word boundaries, case, punctuation and hyphens remain distinct', async () => {
  const h = fixture();
  assert.equal(Cache.normalizeText('  Cafe\u0301\r\n  and\tnew\u00a0results.  '), 'Café and new results.');
  assert.equal(await h.cache.makeKey(input({ selection: 'The experiment\r\n  shows a change.' })), await h.cache.makeKey(input()));
  for (const pair of [['a b', 'ab'], ['Form', 'form'], ['x, y', 'x y'], ['inter-\nnational', 'international'], ['x', 'X'], ['a-b', 'ab']]) {
    assert.notEqual(Cache.normalizeText(pair[0]), Cache.normalizeText(pair[1]));
  }
  assert.equal(Cache.normalizeText('inter-\nnational'), 'inter- national');
});

test('whitespace inside LaTeX expressions, environments and code blocks is retained', () => {
  for (const original of ['$$ x  +\n y $$', '$x  + y$', '\\(x  +\n y\\)', '\\[x  +\n y\\]',
    '\\begin{aligned}x  &= y\\\\\n z &= 2\\end{aligned}', '```python\n  x = 1\n  print(x)\n```',
    '~~~\n  code\n~~~', '`x  + y`', '``x  ` y``']) {
    assert.equal(Cache.normalizeText('  before\n ' + original + '\n after  '), 'before ' + original + ' after');
  }
  assert.notEqual(Cache.normalizeText('$$x  + y$$'), Cache.normalizeText('$$x + y$$'));
  assert.notEqual(Cache.normalizeText('```\n x\n```'), Cache.normalizeText('```\nx\n```'));
  assert.equal(Cache.normalizeText('price \\$2  each'), 'price \\$2 each');
});

test('invalid, circular and excessive key inputs fail softly without leaking data', async () => {
  const h = fixture(); const cycle = {}; cycle.self = cycle;
  const excessive = {}; let next = excessive; for (let i = 0; i < 22; i++) next = next.child = {};
  for (const changed of [{ selection: '' }, { selection: 'x'.repeat(100001) }, { model: null }, { context: cycle }, { context: excessive },
    { context: { invalid: undefined } }, { context: '中'.repeat(400000) }, { promptVersion: 1 }]) {
    assert.equal(await h.cache.makeKey(input(changed)), null);
  }
  const failure = fixture({ cryptoImpl: { subtle: { digest() { throw new Error('token private full text'); } } } });
  assert.equal(await failure.cache.makeKey(input()), null);
  assert.deepEqual([...h.errors, ...failure.errors], Array(9).fill('CACHE_KEY_INVALID'));
  assert.doesNotMatch(JSON.stringify(h.errors) + JSON.stringify(failure.errors), /token|private|full text/);
});

test('reads and writes use the profile-local file with atomic protected writes', async () => {
  const h = fixture(); assert.equal(await h.cache.get(key(1)), null);
  assert.equal(await h.cache.put(key(1), value(1), h.cache.generation), true);
  assert.deepEqual(h.calls.find(call => call[0] === 'makeDirectory'), ['makeDirectory', '/profile/paper-lens', { permissions: 0o700, ignoreExisting: true }]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'setPermissions'), [
    ['setPermissions', '/profile/paper-lens', 0o700], ['setPermissions', FILE, 0o600],
  ]);
  assert.deepEqual(h.writes()[0][3], { tmpPath: FILE + '.tmp', permissions: 0o600 });
  assert.equal(h.writes()[0][1], FILE); assert.equal(h.errors.length, 0);
});

test('hits update LRU in memory and flush only once instead of rewriting the file on each hit', async () => {
  let time = 1; const h = fixture({ clock: () => time++ });
  await h.cache.put(key(1), value(1), 0); const previous = h.saved().entries[0].lastUsed;
  for (let i = 0; i < 20; i++) assert.deepEqual(await h.cache.get(key(1)), value(1));
  assert.equal(h.writes().length, 1); assert.equal(await h.cache.flush(), true);
  assert.equal(h.writes().length, 2); assert.ok(h.saved().entries[0].lastUsed > previous);
  await h.cache.flush(); assert.equal(h.writes().length, 2);
});

test('entry count limit evicts the least recently used record and persists its order across restarts', async () => {
  let time = 1; const h = fixture({ clock: () => time++ });
  const entries = Array.from({ length: Cache.MAX_ENTRIES }, (_, index) => ({ key: key(index + 1), ...value(index + 1), createdAt: index + 1, lastUsed: index + 1 }));
  h.files.set(FILE, JSON.stringify({ version: 1, entries })); time = Cache.MAX_ENTRIES + 1;
  assert.deepEqual(await h.cache.get(key(1)), value(1));
  assert.equal(await h.cache.put(key(Cache.MAX_ENTRIES + 1), value(1001), 0), true);
  assert.equal(h.saved().entries.length, Cache.MAX_ENTRIES);
  const next = Cache.createCache(h.settings);
  assert.equal(await next.get(key(2)), null); assert.deepEqual(await next.get(key(1)), value(1));
  assert.equal(h.saved().entries[0].key, key(3));
});

test('the UTF-8 serialized size limit includes non-ASCII data, JSON escaping and envelope bytes', async () => {
  const h = fixture(); const text = '译'.repeat(1024 * 1024);
  for (let i = 1; i <= 4; i++) assert.equal(await h.cache.put(key(i), { original: 'quote \" and newline\n' + i, text }, 0), true);
  assert.ok(Buffer.byteLength(h.files.get(FILE)) <= Cache.MAX_BYTES);
  assert.equal(h.saved().entries.length, 3); assert.equal(await h.cache.get(key(1)), null);
  assert.equal((await h.cache.get(key(4))).text, text);
});

test('unfinished, empty, oversized and malformed records are not accepted', async () => {
  const h = fixture();
  for (const record of [{ text: '', original: 'passage' }, { text: ' \n', original: 'passage' }, { text: 'answer', original: '' },
    { text: 'x'.repeat(1024 * 1024 + 1), original: 'passage' }, { text: 'answer', original: 'x'.repeat(100001) },
    { text: 123, original: 'passage' }, null]) assert.equal(await h.cache.put(key(1), record, 0), false);
  assert.equal(await h.cache.put('bad', value(1), 0), false);
  assert.equal(await h.cache.put(key(1), value(1)), false);
  assert.equal(await h.cache.get('bad'), null); assert.equal(h.calls.length, 0);
});

test('bad, excessive, duplicate and non-file stores become misses without retaining extra fields', async () => {
  const entry = { key: key(1), ...value(1), createdAt: 1, lastUsed: 1 };
  for (const initial of ['not JSON private text', { version: 2, entries: [] }, { version: 1, entries: null },
    { version: 1, entries: [entry, entry] }, { version: 1, entries: [{ ...entry, key: 'bad' }] },
    { version: 1, entries: [{ ...entry, lastUsed: -1 }] }, { version: 1, entries: Array(Cache.MAX_ENTRIES + 1).fill(entry) }]) {
    const h = fixture({ initial }); assert.equal(await h.cache.get(key(1)), null); assert.deepEqual(h.errors, ['CACHE_INVALID']);
    assert.equal(await h.cache.put(key(2), value(2), 0), true); assert.equal(h.saved().entries.length, 1);
  }
  for (const info of [{ type: 'directory', size: 0 }, { type: 'regular', size: Cache.MAX_BYTES + 1 }, { type: 'regular', size: -1 }]) {
    const h = fixture({ IO: { stat: async () => info, readUTF8: async () => { throw new Error('must not read'); } } });
    assert.equal(await h.cache.get(key(1)), null); assert.deepEqual(h.errors, ['CACHE_INVALID']);
  }
  const h = fixture({ initial: { version: 1, tokens: 'private', entries: [{ ...entry, context: 'private', account: 'private' }] } });
  assert.deepEqual(await h.cache.get(key(1)), value(1)); await h.cache.flush(); assert.doesNotMatch(h.files.get(FILE), /private|tokens|context|account/);
});

test('read and write failures are nonfatal with only safe error codes, and writes can recover', async () => {
  for (const method of ['stat', 'readUTF8']) {
    const h = fixture({ initial: { version: 1, entries: [] }, IO: { [method]: async () => { throw new Error('private-secret'); } } });
    assert.equal(await h.cache.get(key(1)), null); assert.deepEqual(h.errors, ['CACHE_READ_FAILED']);
  }
  let fail = true; const h = fixture({ IO: { writeUTF8: async (file, text) => {
    if (fail) throw new Error('private-secret'); h.files.set(file, text);
  } } });
  assert.equal(await h.cache.put(key(1), value(1), 0), false);
  assert.deepEqual(await h.cache.get(key(1)), value(1)); assert.deepEqual(h.errors, ['CACHE_WRITE_FAILED']);
  fail = false; assert.equal(await h.cache.flush(), true); assert.equal(h.saved().entries[0].key, key(1));
  const brokenCallback = Cache.createCache({ ...h.settings, cryptoImpl: null, onError: () => { throw new Error('callback'); } });
  assert.equal(await brokenCallback.makeKey(input()), null);
});

test('clear increments generation synchronously and ignores a pending load that contains old entries', async () => {
  const read = deferred(); const entry = { key: key(1), ...value(1), createdAt: 1, lastUsed: 1 };
  const h = fixture({ initial: { version: 1, entries: [entry] }, IO: { readUTF8: () => read.promise } });
  const pendingHit = h.cache.get(key(1)); await tick();
  const clearing = h.cache.clear(); assert.equal(h.cache.generation, 1); await clearing;
  read.resolve(JSON.stringify({ version: 1, entries: [entry] }));
  assert.equal(await pendingHit, null); assert.equal(await h.cache.get(key(1)), null);
  assert.deepEqual(h.saved(), { version: 1, entries: [] });
  assert.equal(await h.cache.put(key(1), value(1), 0), false);
});

test('clear during an active atomic write waits for that write then persists the empty cache', async () => {
  const firstWrite = deferred(); let active = 0, peak = 0, count = 0;
  const h = fixture({ IO: { writeUTF8: async (file, text) => {
    active++; peak = Math.max(peak, active); if (++count === 1) await firstWrite.promise;
    h.files.set(file, text); active--;
  } } });
  const put = h.cache.put(key(1), value(1), 0); await tick();
  const clearing = h.cache.clear(); const flush = h.cache.flush();
  assert.equal(h.cache.generation, 1); firstWrite.resolve();
  assert.equal(await put, false); assert.equal(await clearing, true); assert.equal(await flush, true);
  assert.equal(peak, 1); assert.deepEqual(h.saved(), { version: 1, entries: [] });
  assert.equal(await h.cache.get(key(1)), null);
});

test('a put waiting for initial loading cannot resurrect entries after clear', async () => {
  const stat = deferred(); const h = fixture({ IO: { stat: () => stat.promise } });
  const put = h.cache.put(key(1), value(1), 0); await tick();
  await h.cache.clear(); stat.resolve({ type: 'regular', size: 0 });
  assert.equal(await put, false); assert.deepEqual(h.saved().entries, []);
  assert.equal(await h.cache.put(key(2), value(2), 1), true);
  assert.deepEqual(await h.cache.get(key(2)), value(2));
});

test('concurrent puts and flushes serialize writes and all successful completed records survive', async () => {
  let active = 0, peak = 0; const h = fixture({ IO: { writeUTF8: async (file, text) => {
    active++; peak = Math.max(peak, active); await tick(); h.files.set(file, text); active--;
  } } });
  const results = await Promise.all([h.cache.put(key(1), value(1), 0), h.cache.put(key(2), value(2), 0), h.cache.put(key(3), value(3), 0), h.cache.flush()]);
  assert.ok(results.every(Boolean)); assert.equal(peak, 1); assert.equal(h.saved().entries.length, 3);
  const next = Cache.createCache(h.settings); for (let i = 1; i <= 3; i++) assert.deepEqual(await next.get(key(i)), value(i));
});

test('browser global and CommonJS exports share the standalone cache module', () => {
  const scope = { TextEncoder }; vm.runInNewContext(fs.readFileSync(require.resolve('../addon/content/cache.js'), 'utf8'), scope);
  assert.equal(scope.PaperLensCache.MAX_ENTRIES, 1000); assert.equal(scope.PaperLensCache.MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(typeof scope.PaperLensCache.createCache, 'function'); assert.equal(typeof scope.PaperLensCache.normalizeText, 'function');
});
