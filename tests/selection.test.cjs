const test = require('node:test');
const assert = require('node:assert/strict');
const Selection = require('../addon/content/selection.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function harness({ enabled = false, translate } = {}) {
  const reader = { itemID: 1, tabID: 'paper-1' };
  const root = {};
  const state = { enabled, current: reader, selecting: false };
  const timers = new Map(), observers = [], calls = [], errors = [];
  let now = 0, nextTimer = 0, superseded = 0, cancelled = 0;
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; this.disconnects = 0; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.active = true; }
    disconnect() { this.active = false; this.disconnects++; }
  }
  const controller = Selection.create({
    isEnabled: () => state.enabled,
    isCurrent: candidate => candidate === state.current,
    isSelecting: () => state.selecting,
    translate: job => { calls.push(job); return translate ? translate(job) : Promise.resolve(); },
    onSupersede: () => { superseded++; },
    cancelAutomatic: () => { cancelled++; },
    onError: (error, candidate) => errors.push({ error, reader: candidate }),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    MutationObserver: Observer,
  });
  function sentinel() { return { isConnected: true, ownerDocument: { documentElement: root } }; }
  function select(text, options = {}) {
    const node = options.sentinel || sentinel();
    controller.observe({ reader: options.reader || reader,
      selection: { text, pageIndex: options.pageIndex ?? 0, pageLabel: options.pageLabel || '1' }, sentinel: node });
    return node;
  }
  async function flush() { await Promise.resolve(); await Promise.resolve(); }
  async function tick(delay) {
    const end = now + delay;
    while (true) {
      const task = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!task) break;
      timers.delete(task[0]); now = task[1].at; task[1].callback(); await flush();
    }
    now = end; await flush();
  }
  function mutate() { for (const observer of observers) if (observer.active) observer.callback([]); }
  return { state, reader, root, timers, observers, calls, errors, controller, sentinel, select, tick, mutate, flush,
    get superseded() { return superseded; }, get cancelled() { return cancelled; } };
}

test('disabled by default: observing a selection neither schedules nor sends translation', async () => {
  const h = harness(); h.select('Selected passage'); await h.tick(1000);
  assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.observers.length, 0);
  assert.equal(h.superseded, 0);
});

test('350 ms debounce replaces selection A with B and sends only the final passage', async () => {
  const h = harness({ enabled: true }); h.select('A'); await h.tick(200); h.select('B');
  assert.equal(h.observers[0].active, false); assert.equal(h.timers.size, 1);
  await h.tick(349); assert.equal(h.calls.length, 0);
  await h.tick(1); assert.deepEqual(h.calls.map(job => job.selection.text), ['B']);
  assert.equal(h.superseded, 2);
});

test('same-signature popup redraw updates its sentinel without a second translation', async () => {
  const pending = deferred(); const h = harness({ enabled: true, translate: () => pending.promise });
  const original = h.select('A'); await h.tick(150);
  original.isConnected = false; const replacement = h.select('A'); h.mutate();
  assert.equal(h.observers.length, 1); assert.equal(h.observers[0].active, true);
  assert.deepEqual(h.observers[0].options, { childList: true, subtree: true });
  assert.equal(h.observers[0].target, h.root); assert.equal(h.superseded, 1);
  await h.tick(200); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].isCurrent(), true);
  replacement.isConnected = false; h.select('A'); h.mutate();
  assert.equal(h.calls[0].isCurrent(), true);
  pending.resolve(); await h.flush(); h.select('A'); await h.tick(1000);
  assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});

test('removing the popup cancels dispatch, while selecting the same text again starts a fresh job', async () => {
  const h = harness({ enabled: true }); const node = h.select('Same text');
  await h.tick(200); node.isConnected = false; h.mutate();
  assert.equal(h.observers[0].active, false); assert.equal(h.timers.size, 0);
  await h.tick(1000); assert.equal(h.calls.length, 0);
  h.select('Same text'); await h.tick(350);
  assert.deepEqual(h.calls.map(job => job.selection.text), ['Same text']); assert.equal(h.observers.length, 2);
});

test('a drag still selecting after debounce waits in 100 ms intervals until release', async () => {
  const h = harness({ enabled: true }); h.state.selecting = true; h.select('Dragging');
  await h.tick(350); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 1);
  await h.tick(100); assert.equal(h.calls.length, 0);
  h.state.selecting = false; await h.tick(99); assert.equal(h.calls.length, 0);
  await h.tick(1); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});

test('an in-flight translation guard becomes invalid when disabled or when another tab is selected', async t => {
  for (const reason of ['disabled', 'other tab']) await t.test(reason, async () => {
    const pending = deferred(); const h = harness({ enabled: true, translate: () => pending.promise });
    h.select('In flight'); await h.tick(350); const job = h.calls[0]; assert.equal(job.isCurrent(), true);
    if (reason === 'disabled') h.state.enabled = false;
    else { h.state.current = { itemID: 2, tabID: 'paper-2' }; h.controller.tabsChanged('select', ['paper-2']); }
    assert.equal(job.isCurrent(), false);
    pending.reject(new Error('Outdated failure')); await h.flush(); assert.deepEqual(h.errors, []);
  });
});

test('tab close removes only that tab, and tab selection removes inactive pending entries', async () => {
  const h = harness({ enabled: true }); h.select('A'); await h.tick(350);
  const second = { itemID: 2, tabID: 'paper-2' }; h.state.current = second; h.select('B', { reader: second });
  h.controller.tabsChanged('close', ['paper-1']);
  assert.equal(h.observers[0].active, false); assert.equal(h.observers[1].active, true); assert.equal(h.timers.size, 1);
  h.state.current = h.reader; h.controller.tabsChanged('select', ['paper-1']);
  assert.equal(h.observers[1].active, false); assert.equal(h.timers.size, 0);
  await h.tick(1000); assert.deepEqual(h.calls.map(job => job.selection.text), ['A']);
  h.select('C'); h.controller.tabsChanged('close', ['paper-1']); await h.tick(350);
  assert.equal(h.observers[2].active, false); assert.equal(h.calls.length, 1);
});

test('clear disconnects every observer and timer, and dispose prevents subsequent scheduling', async () => {
  const h = harness({ enabled: true }); h.select('A'); await h.tick(350);
  const second = { itemID: 2, tabID: 'paper-2' }; h.state.current = second; h.select('B', { reader: second });
  h.controller.clear(); assert.equal(h.timers.size, 0); assert.ok(h.observers.every(observer => !observer.active));
  assert.equal(h.cancelled, 1); await h.tick(1000); assert.equal(h.calls.length, 1);
  h.select('C', { reader: second }); h.controller.dispose();
  assert.equal(h.timers.size, 0); assert.ok(h.observers.every(observer => !observer.active)); assert.equal(h.cancelled, 2);
  h.select('D', { reader: second }); await h.tick(1000); assert.equal(h.calls.length, 1);
});

test('a superseded translation finishing cannot clear the newer pending task', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = harness({ enabled: true, translate: () => ++count === 1 ? first.promise : second.promise });
  h.select('A'); await h.tick(350); h.select('B'); assert.equal(h.calls[0].isCurrent(), false);
  first.resolve(); await h.flush(); await h.tick(350);
  assert.deepEqual(h.calls.map(job => job.selection.text), ['A', 'B']); assert.equal(h.calls[1].isCurrent(), true);
  second.resolve(); await h.flush(); assert.equal(h.calls[1].isCurrent(), false);
});

test('only an error from the currently active translation reaches the UI', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = harness({ enabled: true, translate: () => ++count === 1 ? first.promise : second.promise });
  h.select('A'); await h.tick(350); h.select('B');
  first.reject(new Error('Stale error')); await h.flush(); assert.deepEqual(h.errors, []);
  await h.tick(350); const currentError = new Error('Current error'); second.reject(currentError); await h.flush();
  assert.deepEqual(h.errors, [{ error: currentError, reader: h.reader }]);
});

test('clearing selection or observing an inactive reader cancels that reader without dispatch', async () => {
  const h = harness({ enabled: true }); h.select('A'); h.select('   '); await h.tick(350);
  assert.equal(h.calls.length, 0); assert.equal(h.observers[0].active, false);
  h.select('B'); h.state.current = {}; h.select('B'); await h.tick(350);
  assert.equal(h.calls.length, 0); assert.equal(h.observers[1].active, false); assert.equal(h.timers.size, 0);
});
