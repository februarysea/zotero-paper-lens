const test = require("node:test");
const assert = require("node:assert/strict");
const Popup = require("../addon/content/popup.js");
const I18n = require("../addon/content/i18n.js");

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this._text = "";
    this.textWrites = 0;
    this.scrollHeight = this.scrollTop = this.clientHeight = 0;
  }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; }
  get isConnected() { return this.connected === true || !!this.parentNode?.isConnected; }
  set textContent(text) { this._text = text; this.children = []; this.textWrites++; }
  get textContent() { return this._text + this.children.map((node) => node.textContent).join(""); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, value) { this.listeners.set(key, value); }
  removeEventListener(key) { this.listeners.delete(key); }
  fire(key) { if (!this.disabled) this.listeners.get(key)?.(); }
}

function harness(callbacks = {}, locale = "zh-CN") {
  const timers = new Map();
  let timerID = 0;
  const container = new Element("existing-selection-popup");
  container.connected = true;
  const document = { createElementNS: (_, tag) => new Element(tag), defaultView: {} };
  const popup = Popup.create({
    document, container, i18n: I18n.create(locale), ...callbacks,
    setTimeout: (callback, delay) => { const id = timerID++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  function find(className) {
    const visit = (node) => node.className === className ? node : node.children.map(visit).find(Boolean);
    return visit(container);
  }
  function tick() {
    const due = [...timers.values()];
    timers.clear();
    for (const timer of due) timer.callback();
  }
  tick(); // Zotero has attached the custom row by the next task.
  return { popup, container, find, timers, tick };
}

test("embeds a compact localized view in the existing selection popup", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const h = harness({}, locale);
    assert.equal(h.container.children.length, 1);
    assert.equal(h.container.children[0], h.popup.root);
    assert.equal(h.popup.root.attributes.lang, I18n.create(locale).locale);
    assert.match(h.popup.root.attributes.style, /max-width:340px/);
    assert.match(h.find("paper-lens-popup-answer").attributes.style, /max-height:200px;overflow:auto/);
    assert.equal(h.find("paper-lens-popup-translate").textContent, I18n.create(locale).t("host.translate"));
    assert.equal(h.find("paper-lens-popup-answer").attributes["aria-label"], I18n.create(locale).t("ui.answer_aria"));
    assert.equal(h.find("paper-lens-popup-answer").hidden, true);
    assert.equal(h.find("paper-lens-popup-status").hidden, true);
    assert.equal(h.find("paper-lens-popup-stop").hidden, true);
    h.popup.dispose();
  }
});

test("translate, stop and complete-copy callbacks respect their state guards", () => {
  let translated = 0;
  let cancelled = 0;
  const copied = [];
  const h = harness({ onTranslate: () => translated++, onCancel: () => cancelled++, onCopy: (text) => copied.push(text) });
  const translate = h.find("paper-lens-popup-translate");
  const stop = h.find("paper-lens-popup-stop");
  const copy = h.find("paper-lens-popup-copy");
  translate.fire("click");
  assert.equal(translated, 1);
  stop.listeners.get("click")();
  assert.equal(cancelled, 0);
  h.popup.render({ busy: true, text: "Partial" });
  assert.equal(stop.hidden, false);
  assert.equal(translate.disabled, true);
  translate.listeners.get("click")();
  copy.listeners.get("click")();
  assert.equal(translated, 1);
  assert.deepEqual(copied, []);
  stop.fire("click");
  assert.equal(cancelled, 1);
  h.popup.render({ busy: false, text: "Partial", complete: false });
  copy.listeners.get("click")();
  assert.deepEqual(copied, []);
  const text = "The complete translation\nincluding every paragraph.";
  h.popup.render({ text, busy: false, complete: true });
  assert.equal(copy.disabled, false);
  copy.fire("click");
  assert.deepEqual(copied, [text]);
  assert.equal(h.find("paper-lens-popup-status").textContent, "完成");
  h.popup.dispose();
});

test("complete translations show Retranslate and explicitly bypass the cache; ordinary and partial requests do not", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const requests = [];
    const h = harness({ onTranslate: request => requests.push(request) }, locale);
    const translate = h.find("paper-lens-popup-translate");
    translate.fire("click");
    assert.deepEqual(requests, [{ forceRefresh: false }]);
    h.popup.render({ text: "Complete cached translation", complete: true, status: I18n.create(locale).t("host.cached") });
    assert.equal(translate.textContent, I18n.create(locale).t("ui.retranslate"));
    assert.equal(h.find("paper-lens-popup-status").textContent, I18n.create(locale).t("host.cached"));
    translate.fire("click");
    assert.deepEqual(requests.at(-1), { forceRefresh: true });
    h.popup.render({ busy: true });
    translate.listeners.get("click")();
    assert.equal(requests.length, 2);
    h.popup.render({ text: "Partial translation", busy: false, complete: false });
    assert.equal(translate.textContent, I18n.create(locale).t("host.translate"));
    translate.fire("click");
    assert.deepEqual(requests.at(-1), { forceRefresh: false });
    h.popup.dispose();
  }
});

test("model markup remains literal plain text with no created model elements", () => {
  const h = harness();
  const payload = '<script>alert(1)</script><img src="x" onerror="steal()"> **译文**\n[open](javascript:evil())';
  h.popup.render({ text: payload, complete: true });
  const answer = h.find("paper-lens-popup-answer");
  assert.equal(answer.textContent, payload);
  assert.deepEqual(answer.children, []);
  assert.equal(answer.innerHTML, undefined);
  h.popup.dispose();
});

test("streaming patches share one 60 ms render and preserve the latest full text", () => {
  const h = harness();
  h.popup.render({ busy: true });
  const answer = h.find("paper-lens-popup-answer");
  const before = answer.textWrites;
  for (let count = 1; count <= 30; count++) h.popup.render({ text: "字".repeat(count) });
  assert.equal(h.timers.size, 1, "a timer id of zero also coalesces correctly");
  assert.equal([...h.timers.values()][0].delay, 60);
  assert.equal(answer.textWrites, before);
  h.tick();
  assert.equal(answer.textWrites, before + 1);
  assert.equal(answer.textContent, "字".repeat(30));
  h.popup.render({ text: "Next chunk" });
  assert.equal(h.timers.size, 1);
  h.popup.dispose();
  assert.equal(h.timers.size, 0);
});

test("completion flushes pending text immediately and clears the pending timer", () => {
  const h = harness();
  h.popup.render({ busy: true });
  h.popup.render({ text: "All output" });
  assert.equal(h.find("paper-lens-popup-answer").textContent, "");
  h.popup.render({ busy: false, complete: true });
  assert.equal(h.timers.size, 0);
  assert.equal(h.find("paper-lens-popup-answer").textContent, "All output");
  assert.equal(h.find("paper-lens-popup-answer").attributes["aria-busy"], "false");
  assert.equal(h.find("paper-lens-popup-copy").disabled, false);
  h.popup.dispose();
});

test("errors flush pending output safely and leave incomplete translations uncopyable", () => {
  const h = harness({}, "en-US");
  h.popup.render({ busy: true });
  h.popup.render({ text: "Partial output" });
  h.popup.render({ error: new Error("<script>secret backend details</script>"), busy: false });
  assert.equal(h.timers.size, 0);
  assert.equal(h.find("paper-lens-popup-answer").textContent, "Partial output");
  assert.equal(h.find("paper-lens-popup-status").textContent, I18n.create("en-US").t("host.request_failed"));
  assert.equal(h.find("paper-lens-popup-status").attributes["data-kind"], "error");
  assert.equal(h.find("paper-lens-popup-copy").disabled, true);
  h.popup.dispose();
});

test("disconnected popup nodes cannot receive text writes or invoke callbacks", () => {
  let translated = 0;
  const h = harness({ onTranslate: () => translated++ });
  const answer = h.find("paper-lens-popup-answer");
  const translate = h.find("paper-lens-popup-translate");
  h.popup.render({ busy: true });
  h.popup.render({ text: "Queued output" });
  const before = answer.textWrites;
  h.container.removeChild(h.popup.root);
  h.tick();
  h.popup.render({ text: "Late completion", busy: false, complete: true });
  translate.listeners.get("click")();
  assert.equal(answer.textWrites, before);
  assert.equal(translated, 0);
  h.popup.dispose();
  assert.equal(h.timers.size, 0);
});

test("dispose removes listeners and protects against already queued callbacks", () => {
  const h = harness();
  const translate = h.find("paper-lens-popup-translate");
  const answer = h.find("paper-lens-popup-answer");
  h.popup.render({ busy: true });
  h.popup.render({ text: "Pending" });
  const queued = [...h.timers.values()][0].callback;
  const before = answer.textWrites;
  h.popup.dispose();
  assert.equal(h.container.children.length, 0);
  assert.equal(translate.listeners.size, 0);
  assert.equal(h.timers.size, 0);
  queued();
  h.popup.render({ text: "Late result", busy: false, complete: true });
  assert.equal(answer.textWrites, before);
  h.popup.dispose();
});

test("streaming follows the bottom but preserves a user's scroll position", () => {
  const h = harness();
  const answer = h.find("paper-lens-popup-answer");
  answer.scrollHeight = 500;
  answer.clientHeight = 200;
  answer.scrollTop = 298;
  h.popup.render({ text: "Output" });
  assert.equal(answer.scrollTop, 500);
  answer.scrollTop = 100;
  h.popup.render({ text: "More output" });
  assert.equal(answer.scrollTop, 100);
  h.popup.dispose();
});

test("rejected callback promises render a safe error without an unhandled rejection", async () => {
  const h = harness({ onTranslate: () => Promise.reject(new Error("private details")) });
  h.find("paper-lens-popup-translate").fire("click");
  await Promise.resolve();
  assert.equal(h.find("paper-lens-popup-status").textContent, I18n.create("zh-CN").t("host.request_failed"));
  h.popup.dispose();
});

test("initial detached construction can render synchronously before Zotero attaches it", () => {
  const callbacks = new Map();
  let id = 0;
  const container = new Element("not-attached-yet");
  const popup = Popup.create({
    document: { createElementNS: (_, tag) => new Element(tag), defaultView: {} }, container,
    setTimeout: (callback) => { callbacks.set(id, callback); return id++; },
    clearTimeout: (timer) => callbacks.delete(timer),
  });
  popup.render({ text: "Cached translation", complete: true });
  const answer = popup.root.children.find((node) => node.className === "paper-lens-popup-answer");
  assert.equal(answer.textContent, "Cached translation");
  container.connected = true;
  for (const callback of callbacks.values()) callback();
  const before = answer.textWrites;
  container.connected = false;
  popup.render({ text: "Late update" });
  assert.equal(answer.textWrites, before);
  popup.dispose();
});

function popupHost(width = 700, height = 500) {
  const declarations = new Map([["width", "198px"], ["max-width", "198px"], ["transform", "translate(600px, 450px)"]]);
  const style = {
    getPropertyValue: (key) => declarations.get(key) || "",
    getPropertyPriority: () => "",
    setProperty: (key, value) => declarations.set(key, value),
    removeProperty: (key) => declarations.delete(key),
  };
  const parentRect = { left: 0, top: 0, right: width, bottom: height, width, height };
  const parent = { getBoundingClientRect: () => parentRect };
  const host = {
    style, parentNode: parent,
    getBoundingClientRect() {
      const translation = /^translate\(([\d.-]+)px,\s*([\d.-]+)px\)$/.exec(style.getPropertyValue("transform"));
      const left = Number(translation[1]), top = Number(translation[2]);
      const hostWidth = parseFloat(style.getPropertyValue("width"));
      return { left, top, width: hostWidth, height: 200, right: left + hostWidth, bottom: top + 200 };
    },
  };
  return { host, parent, parentRect };
}

test("scopes width and position correction to the current selection popup and restores it", () => {
  const h = harness();
  const { host } = popupHost();
  h.popup.root.closest = (selector) => { assert.equal(selector, ".selection-popup"); return host; };
  h.popup.render({ text: "Complete translation", complete: true });
  assert.equal(host.style.getPropertyValue("box-sizing"), "border-box");
  assert.equal(host.style.getPropertyValue("width"), "340px");
  assert.equal(host.style.getPropertyValue("max-width"), "340px");
  assert.equal(host.style.getPropertyValue("transform"), "translate(340px, 280px)");
  h.popup.dispose();
  assert.equal(host.style.getPropertyValue("box-sizing"), "");
  assert.equal(host.style.getPropertyValue("width"), "198px");
  assert.equal(host.style.getPropertyValue("max-width"), "198px");
  assert.equal(host.style.getPropertyValue("transform"), "translate(600px, 450px)");
});

test("restoring plugin layout preserves a newer position written by Zotero", () => {
  const h = harness();
  const { host } = popupHost();
  h.popup.root.closest = () => host;
  h.popup.render({ text: "Complete translation", complete: true });
  host.style.setProperty("transform", "translate(25px, 40px)");
  h.popup.dispose();
  assert.equal(host.style.getPropertyValue("transform"), "translate(25px, 40px)");
});

test("resizing the reader view coalesces layout checks and shrinks the popup inside that view", () => {
  const timers = new Map();
  let timerID = 0;
  const container = new Element("existing-selection-popup");
  container.connected = true;
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; this.nodes = []; observer = this; }
    observe(node) { this.nodes.push(node); }
    disconnect() { this.disconnected = true; }
  }
  const document = { createElementNS: (_, tag) => new Element(tag), defaultView: { ResizeObserver: Observer } };
  const popup = Popup.create({ document, container,
    setTimeout: (callback, delay) => { const id = timerID++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  for (const { callback } of timers.values()) callback();
  timers.clear();
  const { host, parent, parentRect } = popupHost();
  popup.root.closest = () => host;
  popup.render({ text: "Translation", complete: true });
  assert.deepEqual(observer.nodes, [host, parent]);
  parentRect.width = parentRect.right = 300;
  observer.callback();
  observer.callback();
  assert.equal(timers.size, 1);
  const queued = [...timers.values()][0].callback;
  timers.clear();
  queued();
  assert.equal(host.style.getPropertyValue("width"), "260px");
  assert.equal(host.style.getPropertyValue("transform"), "translate(20px, 280px)");
  popup.dispose();
  assert.equal(observer.disconnected, true);
  assert.equal(timers.size, 0);
});
