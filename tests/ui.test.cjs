const test = require("node:test");
const assert = require("node:assert/strict");
const UI = require("../addon/content/ui.js");
const I18n = require("../addon/content/i18n.js");

test("model answers cannot turn unsafe protocols into links", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "chrome://zotero/content", "https://example.com\n/x"]) {
    assert.equal(UI.safeURL(url), null);
  }
  assert.equal(UI.safeURL("https://example.com/article"), "https://example.com/article");
  assert.equal(UI.safeURL("zotero://select/library/items/ABCD1234"), "zotero://select/library/items/ABCD1234");
  const tokens = UI.tokenizeInline("[bad](javascript:evil) [good](https://example.com)");
  assert.equal(tokens.filter((token) => token.type === "link").length, 1);
  assert.equal(tokens.at(-1).href, "https://example.com");
});

test("HTML and LaTex stay literal; Markdown formats use allowlisted tokens", () => {
  const input = '<img src=x onerror="evil()"> **Definition**: `$x_i$` and \\(E=mc^2\\).';
  const tokens = UI.tokenizeInline(input);
  assert.equal(tokens[0].type, "text");
  assert.match(tokens[0].text, /<img/);
  assert.equal(tokens[1].type, "strong");
  assert.equal(tokens[1].children[0].text, "Definition");
  assert.ok(tokens.some((token) => token.type === "code" && token.text === "$x_i$"));
  assert.ok(tokens.some((token) => token.text && token.text.includes("\\(E=mc^2\\)")));
});

test("streaming incomplete fenced code remains a code block", () => {
  assert.deepEqual(UI.parseMarkdown("Before\n\n```python\nx = 1\n"), [
    { type: "paragraph", text: "Before" },
    { type: "code", language: "python", text: "x = 1\n" },
  ]);
});

test("headings, numbered lists, quotes and paragraphs keep their source", () => {
  const blocks = UI.parseMarkdown("## Result\n\n3. first\n4. second\n\n> Original text\n> continued\n\nA formula: $$x = y$$");
  assert.deepEqual(blocks, [
    { type: "heading", level: 2, text: "Result" },
    { type: "list", ordered: true, start: 3, items: ["first", "second"] },
    { type: "quote", text: "Original text\ncontinued" },
    { type: "paragraph", text: "A formula: $$x = y$$" },
  ]);
});

// A small DOM harness checks the panel's interaction contract without a browser.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.value = "";
    this.scrollHeight = this.scrollTop = this.clientHeight = 0;
    this._text = "";
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  get firstChild() { return this.children[0] || null; }
  get options() { return this.children; }
  set textContent(text) { this._text = text; this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  fire(name, event = {}) { if (!this.disabled) this.listeners.get(name)?.(event); }
  focus() { this.focused = true; }
}
function panelHarness(callbacks = {}, options = {}) {
  const document = {
    defaultView: { setTimeout, clearTimeout },
    createElementNS: (_, tag) => new Element(tag),
    createDocumentFragment: () => new Element("fragment"),
    createTextNode: (text) => { const node = new Element("text"); node.textContent = text; return node; },
  };
  const container = new Element("container");
  const panel = UI.createPanel({ document, container, callbacks, ...options });
  function find(className) {
    const visit = (node) => node.className?.split(" ").includes(className) ? node
      : node.children.map(visit).find(Boolean);
    return visit(container);
  }
  return { panel, container, find };
}

test("translation is the only action and its submission contains only the selection", () => {
  const requests = [];
  const { panel, find } = panelHarness({ onSubmit: (payload) => requests.push(payload) });
  assert.equal(find("paper-lens-actions"), undefined);
  assert.equal(find("paper-lens-question"), undefined);
  assert.equal(find("paper-lens-primary").disabled, true);
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  panel.setSelection({ text: "The selected sentence", pageLabel: "4" });
  assert.equal(find("paper-lens-primary").textContent, "翻译选区");
  assert.equal(find("paper-lens-primary").disabled, false);
  panel.setAction("ask");
  assert.equal(panel.getAction(), "translate");
  find("paper-lens-primary").fire("click");
  assert.deepEqual(requests, [{ action: "translate", question: "", selection: { text: "The selected sentence", pageLabel: "4" } }]);
  panel.dispose();
});

test("translation cannot submit without both a paper and a nonempty selection", () => {
  const requests = [];
  const { panel, find } = panelHarness({ onSubmit: (payload) => requests.push(payload) });
  panel.setSelection({ text: "The selected sentence", pageLabel: "4" });
  find("paper-lens-primary").fire("click");
  assert.equal(requests.length, 0);
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  for (const selection of [null, { text: "" }, { text: " \n\t " }]) {
    panel.setSelection(selection);
    assert.equal(find("paper-lens-primary").disabled, true);
    assert.equal(find("paper-lens-hint").textContent, "先在 PDF 中选中文字。");
    find("paper-lens-primary").fire("click");
    assert.equal(requests.length, 0);
  }
  panel.dispose();
});

test("old question and explanation drafts cannot restore question UI or influence translation", () => {
  const requests = [];
  const { panel, find } = panelHarness({ onSubmit: (payload) => requests.push(payload) });
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  panel.setSelection({ text: "The selected sentence", pageLabel: "4" });
  for (const draft of [{ action: "ask", question: "Why is this true?" }, { action: "explain", question: "What does this term mean?" }, "Old question text"]) {
    panel.setDraft(draft);
    assert.deepEqual(panel.getDraft(), { action: "translate", question: "" });
    assert.equal(find("paper-lens-question"), undefined);
    assert.match(find("paper-lens-source").textContent, /The selected sentence/);
    find("paper-lens-primary").fire("click");
  }
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.action === "translate" && request.question === ""));
  panel.dispose();
});

test("translation focus and the compatibility focus method both target the translation button", () => {
  const { panel, find } = panelHarness();
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  panel.setSelection({ text: "The selected sentence", pageLabel: "4" });
  panel.focusTranslate();
  assert.equal(find("paper-lens-primary").focused, true);
  find("paper-lens-primary").focused = false;
  panel.focusQuestion();
  assert.equal(find("paper-lens-primary").focused, true);
  panel.setAction("explain");
  assert.equal(panel.getDraft().action, "translate");
  panel.dispose();
});

test("streaming output cannot be copied or saved until generation finishes", () => {
  const { panel, container, find } = panelHarness();
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  panel.setResponse("First answer");
  assert.equal(find("paper-lens-result-tools").children[1].disabled, false);
  panel.setBusy(true);
  panel.appendResponse(" continuing");
  assert.equal(panel.getResponse(), "First answer continuing");
  assert.equal(find("paper-lens-result-tools").children[1].disabled, true);
  assert.equal(find("paper-lens-result-tools").children[2].disabled, true);
  panel.setBusy(false);
  assert.equal(find("paper-lens-result-tools").children[2].disabled, false);
  panel.dispose();
  assert.equal(container.children.length, 0);
});

test("the host can keep an incomplete answer unsavable after streaming stops", () => {
  const { panel, find } = panelHarness();
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  panel.setResponse("A partial answer");
  panel.setCanSave(false);
  panel.setBusy(false);
  const tools = find("paper-lens-result-tools").children;
  assert.equal(tools[1].disabled, false, "the partial text is still copyable");
  assert.equal(tools[2].disabled, true, "the partial text cannot become a note");
  panel.setResponse("A completed answer");
  panel.setCanSave(true);
  assert.equal(tools[2].disabled, false);
  panel.dispose();
});

test("retry becomes Retranslate for complete and restored translations while incomplete output stays Retry", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    let retried = 0;
    const { panel, find } = panelHarness({ onRetry: () => retried++ }, { locale });
    const retry = find("paper-lens-result-tools").children[0];
    panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
    assert.equal(retry.disabled, true);
    panel.setCanSave(false);
    panel.setBusy(true);
    panel.setResponse("Partial translation");
    assert.equal(retry.disabled, true);
    assert.equal(retry.textContent, I18n.create(locale).t("ui.retry"));
    panel.setBusy(false);
    assert.equal(retry.textContent, I18n.create(locale).t("ui.retry"));
    retry.fire("click"); assert.equal(retried, 1);
    panel.setResponse("Complete translation"); panel.setCanSave(true);
    assert.equal(retry.textContent, I18n.create(locale).t("ui.retranslate"));
    retry.fire("click"); assert.equal(retried, 2);
    panel.dispose();

    const restored = panelHarness({ onRetry: () => retried++ }, { locale });
    restored.panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
    restored.panel.setResponse("Restored complete translation"); restored.panel.setCanSave(true);
    const restoredRetry = restored.find("paper-lens-result-tools").children[0];
    assert.equal(restoredRetry.disabled, false);
    assert.equal(restoredRetry.textContent, I18n.create(locale).t("ui.retranslate"));
    restoredRetry.fire("click"); assert.equal(retried, 3);
    restored.panel.dispose();
  }
});

test("stopping a stream blocks note saves until a complete response is explicitly allowed", () => {
  const saved = [];
  let cancelled = 0;
  const { panel, find } = panelHarness({ onCancel: () => { cancelled++; panel.setBusy(false); }, onSave: (value) => saved.push(value) });
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  panel.setSelection({ text: "Original text" });
  panel.setCanSave(false);
  panel.setBusy(true);
  panel.setResponse("Partial translation");
  const stop = find("paper-lens-submit-row").children[1];
  const save = find("paper-lens-result-tools").children[2];
  assert.equal(stop.hidden, false);
  stop.fire("click");
  assert.equal(cancelled, 1);
  assert.equal(save.disabled, true);
  save.fire("click");
  assert.deepEqual(saved, []);
  // Even a synthetic dispatch to the disabled control must respect the guard.
  save.listeners.get("click")();
  assert.deepEqual(saved, []);
  panel.setResponse("Completed translation");
  panel.setCanSave(true);
  save.fire("click");
  assert.deepEqual(saved, [{ text: "Completed translation" }]);
  panel.dispose();
});

test("English translation panel localizes hints, accessibility labels, Unicode counts and page labels", () => {
  const { panel, find } = panelHarness({}, { locale: "en-US" });
  assert.equal(find("paper-lens").attributes.lang, "en");
  assert.equal(find("paper-lens-actions"), undefined);
  assert.equal(find("paper-lens-question"), undefined);
  assert.equal(find("paper-lens-hint").textContent, "Open a PDF to start reading.");
  assert.equal(find("paper-lens-answer").attributes["aria-label"], I18n.create("en").t("ui.answer_aria"));
  assert.deepEqual(find("paper-lens-result-tools").children.map((node) => node.textContent), ["Retry", "Copy", "Save note"]);
  panel.setPaper({ title: "A paper", attachmentKey: "ABCD1234" });
  panel.setSelection({ text: "A𠮷🙂", pageLabel: "iv" });
  assert.equal(find("paper-lens-selection-chip").textContent, "3 characters selected · Page iv");
  assert.equal(find("paper-lens-source-label").textContent, "Selected text · Page iv");
  assert.equal(find("paper-lens-hint").textContent, I18n.create("en").t("ui.translate_hint"));
  assert.equal(find("paper-lens-primary").textContent, "Translate selection");
  panel.setBusy(true);
  assert.equal(find("paper-lens-primary").textContent, "Translating…");
  assert.equal(find("paper-lens-submit-row").children[1].textContent, "Stop");
  assert.equal(find("paper-lens-empty").textContent, "Reading the context…");
  assert.equal(find("paper-lens-answer").attributes["aria-busy"], "true");
  panel.setBusy(false);
  panel.setSelection(null);
  panel.setCoverage("");
  assert.equal(find("paper-lens-selection-chip").textContent, "No text selected");
  assert.equal(find("paper-lens-source").textContent, "No selection");
  assert.equal(find("paper-lens-coverage").textContent, "Paper context will be prepared when you send a request.");
  assert.equal(find("paper-lens-primary").disabled, true);
  panel.dispose();
});

test("the reading panel leaves model selection to Zotero settings", () => {
  const { panel, find } = panelHarness({}, { locale: "en" });
  assert.equal(find("paper-lens-model-row"), undefined);
  assert.equal(find("paper-lens-model"), undefined);
  assert.equal(find("paper-lens-refresh"), undefined);
  assert.equal(panel.getModel, undefined);
  assert.equal(panel.setModel, undefined);
  assert.equal(panel.setModels, undefined);
  panel.dispose();
});

test("host locale injection wins over fallback locale and errors never expose unknown exceptions", () => {
  const { panel, find } = panelHarness({}, { locale: "zh-CN", i18n: I18n.create("en") });
  assert.equal(find("paper-lens").attributes.lang, "en");
  panel.showError(Object.assign(new Error("token secret HTTP 503"), { code: "HTTP_ERROR" }));
  assert.equal(find("paper-lens-status").textContent, "The OpenAI service rejected this request. Please retry later. (HTTP 503)");
  panel.showError(new Error("https://service/?access_token=secret"));
  assert.equal(find("paper-lens-status").textContent, "Something went wrong. Please retry.");
  panel.showError(I18n.create("en").t("host.busy"));
  assert.equal(find("paper-lens-status").textContent, "A request is already running. Wait for it to finish or cancel it first.");
  panel.dispose();
});
