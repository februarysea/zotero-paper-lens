const test = require("node:test");
const assert = require("node:assert/strict");
const Main = require("../addon/content/main.js");
const I18n = require("../addon/content/i18n.js");
const Selection = require("../addon/content/selection.js");

function clone(value) { return structuredClone(value); }
function element() {
  return {
    style: {}, children: [], listeners: new Map(), attributes: {}, isConnected: true,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); },
  };
}

class Panel {
  constructor(options) {
    this.callbacks = options.callbacks;
    assert.equal(Object.hasOwn(options, "initialModel"), false, "the reader panel must not receive a model selector");
    this.locale = options.i18n?.locale;
    this.response = "";
    this.errors = [];
    this.statuses = [];
    this.draft = { action: "translate", question: "" };
    this.responseWrites = [];
  }
  setPaper(paper) { this.paper = clone(paper); }
  // The real UI exposes text and displayed page label, not PDF internals.
  setSelection(selection) { this.selection = { text: selection.text, pageLabel: selection.pageLabel }; }
  setDraft(draft) { this.draft = clone(draft); }
  getDraft() { return clone(this.draft); }
  setResponse(text) { this.response = text; this.responseWrites.push(text); }
  appendResponse(delta) { this.setResponse(this.response + delta); }
  getResponse() { return this.response; }
  setBusy(busy) { this.busy = busy; }
  setCanSave(value) { this.canSave = value; }
  setStatus(text, kind) { this.statuses.push({ text, kind }); }
  showError(text) { this.errors.push(text); }
  setCoverage(label) { this.coverage = label; }
  setAction(action) { this.draft.action = action; }
  focusTranslate() { this.focused = true; }
  dispose() { this.disposed = true; }
}

async function harness(t, { automaticShutdown = true, locale = "zh-CN", initialModelPref } = {}) {
  const events = new Map();
  const panels = [];
  const popups = [], copied = [];
  const notes = [];
  const prompts = [];
  const backendCalls = [];
  const behaviors = [];
  const prefs = new Map();
  const timers = new Map(), preferenceObservers = new Map();
  let timerID = 0, tabNotifier = null;
  if (initialModelPref !== undefined) prefs.set("extensions.paperlens.model", initialModelPref);
  const modelSettings = { defaultModel: "gpt-6-luna", models: [
    { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "Luna" },
    { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "Sol" }],
    source: "account", connected: true, warnings: [] };
  let settingsReads = 0, connects = 0, authCreates = 0, backendCreates = 0;
  const hooks = { section: null, registeredPrefs: [], unregisteredSections: [], unregisteredEvents: [], unregisteredPrefs: [] };
  let disconnects = 0;
  function attachment(id, key, parentID) {
    return {
      id, key, libraryID: 1, parentID, dateModified: "synthetic-version-1",
      attachmentContentType: "application/pdf",
      attachmentText: "Synthetic paper body. The temperature determines how concentrated weights become.",
      isAttachment: () => true,
      getField: (field) => field === "title" ? "Synthetic PDF " + key : "",
      getCreators: () => [],
      getFilePathAsync: async () => "/synthetic/" + key + ".pdf",
    };
  }
  const first = attachment(11, "DEMO0001", 101);
  const second = attachment(12, "DEMO0002", 102);
  const standalone = attachment(13, "DEMO0003");
  const items = new Map([[11, first], [12, second], [13, standalone]]);
  for (const [id, title] of [[101, "Synthetic paper A"], [102, "Synthetic paper B"]]) {
    items.set(id, { getField: (field) => field === "title" ? title : field === "abstractNote" ? "A synthetic abstract." : "",
      getCreators: () => [{ firstName: "Demo", lastName: "Author" }] });
  }
  const reader = { itemID: 11, tabID: "synthetic-tab" };
  const document = { defaultView: {}, createElementNS: () => Object.assign(element(), { ownerDocument: document }) };
  const details = { tabID: reader.tabID };
  const body = { ownerDocument: document, closest: (selector) => selector === "item-details" ? details : null };
  class Backend {
    constructor() { backendCreates++; }
    async connect() { connects++; return {}; }
    async disconnect() { disconnects++; }
    async run(options) {
      backendCalls.push(options);
      const behavior = behaviors.shift();
      assert.ok(behavior, "each synthetic request needs a queued backend response");
      return behavior(options);
    }
  }
  class Note {
    constructor(type) { assert.equal(type, "note"); this.related = []; }
    setNote(html) { this.html = html; }
    addRelatedItem(item) { this.related.push(item.id); }
    async saveTx() { if (!notes.includes(this)) notes.push(this); }
  }
  const env = {
    AbortController,
    setTimeout: (callback, delay) => { const id = ++timerID; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    PaperLensSelection: Selection,
    PaperLensPopup: { create: (options) => {
      const popup = { root: options.container, options, state: {}, writes: [], disposed: false,
        render(state) { if (!this.disposed) { Object.assign(this.state, clone(state)); this.writes.push(clone(this.state)); } },
        dispose() { this.disposed = true; },
      };
      const button = element(); button.textContent = options.i18n.t("host.translate");
      button.addEventListener("click", options.onTranslate); options.container.appendChild(button);
      popups.push(popup); return popup;
    } },
    Cc: { "@mozilla.org/widget/clipboardhelper;1": { getService: () => ({ copyString: (text) => copied.push(text) }) } },
    Ci: { nsIClipboardHelper: {} },
    IOUtils: { stat: async () => ({ lastModified: 12345 }) },
    PathUtils: {},
    Services: { prompt: { alert: () => { throw new Error("An unexpected dialog was shown."); } } },
    PaperLensAuth: { createAuthProvider: () => { authCreates++; return {}; } },
    PaperLensI18n: I18n,
    PaperLensSettings: { createSettingsReader: () => ({ read: async () => {
      settingsReads++; return clone(modelSettings);
    } }) },
    PaperLensCodex: { CodexBackend: Backend },
    PaperLensUI: { createPanel: (options) => { const panel = new Panel(options); panels.push(panel); return panel; } },
    PaperLensContext: { buildPrompt: (input) => {
      prompts.push(clone(input));
      return { prompt: "synthetic-prompt", coverage: { label: "Synthetic context only" }, source: { title: input.paper.title } };
    } },
    Zotero: {
      locale,
      getMainWindows: () => [],
      Items: { get: (id) => items.get(id) },
      Item: Note,
      Libraries: { get: () => ({ editable: true, libraryType: "user" }) },
      Prefs: { get: (name) => prefs.get(name), set: (name, value) => {
        prefs.set(name, value);
        for (const observer of preferenceObservers.values()) if (observer.name === name) observer.callback(value);
      }, registerObserver: (name, callback) => {
        const id = Symbol(); preferenceObservers.set(id, { name, callback }); return id;
      }, unregisterObserver: (id) => preferenceObservers.delete(id) },
      Notifier: { registerObserver: (observer) => { tabNotifier = observer; return "synthetic-tabs"; },
        unregisterObserver: () => { tabNotifier = null; } },
      debug: () => {},
      launchURL: () => {},
      Reader: {
        getByTabID: (id) => id === reader.tabID ? reader : null,
        registerEventListener: (name, callback) => events.set(name, callback),
        unregisterEventListener: (name, callback) => {
          assert.equal(events.get(name), callback);
          events.delete(name);
          hooks.unregisteredEvents.push(name);
        },
      },
      ItemPaneManager: {
        registerSection: (section) => { hooks.section = section; return "registered-paperlens"; },
        unregisterSection: (id) => hooks.unregisteredSections.push(id),
      },
      PreferencePanes: { register: async (options) => hooks.registeredPrefs.push(options),
        unregister: (id) => hooks.unregisteredPrefs.push(id) },
    },
  };
  const app = Main.create({ id: "paperlens@test.invalid", version: "test", rootURI: "file:///synthetic/", env });
  await app.startup();
  function render() { hooks.section.onRender({ body }); return panels.at(-1); }
  function select(pageIndex, pageLabel = "5", text = "Synthetic selected source") {
    const appended = [];
    events.get("renderTextSelectionPopup")({ reader, doc: document,
      params: { annotation: { text, pageLabel, position: { pageIndex } } },
      append: (node) => appended.push(node) });
    if (!appended.length) return null;
    const expected = locale.toLowerCase().startsWith("zh") ? ["翻译"] : ["Translate"];
    assert.deepEqual(appended[0].children.map((button) => button.textContent), expected);
    return appended[0];
  }
  function succeed(text) { behaviors.push(({ onDelta }) => { onDelta(text); return { text }; }); }
  function failPartial(text) { behaviors.push(({ onDelta }) => { onDelta(text); throw new Error("Synthetic interruption"); }); }
  function readerWindow() {
    const contextPane = element();
    contextPane.collapsed = true;
    contextPane.mode = "notes";
    const menuPopup = element();
    const scrolled = [];
    const section = {
      open: false, querySelector: () => null,
      render: () => hooks.section.onRender({ body }), asyncRender: async () => {},
    };
    details.render = async () => hooks.section.onRender({ body });
    details.scrollToPane = async (id, behavior) => scrolled.push({ id, behavior });
    details.getEnabledPane = (id) => id === "registered-paperlens" ? section : null;
    document.documentElement = element();
    document.createXULElement = element;
    document.getElementById = (id) => id === "zotero-context-pane-inner" ? contextPane : id === "menu_ToolsPopup" ? menuPopup : null;
    document.querySelectorAll = (selector) => selector === "item-details" ? [details] : [];
    const win = {
      document,
      MozXULElement: { insertFTLIfNeeded: () => {} },
      Zotero_Tabs: { selectedID: reader.tabID, select(id) { this.selectedID = id; } },
      ZoteroContextPane: { collapsed: true },
    };
    document.defaultView = win;
    reader._window = win;
    reader.setContextPaneOpen = async (open) => { reader.contextPaneOpen = open; };
    env.Zotero.getMainWindow = () => win;
    return { win, contextPane, section, scrolled };
  }
  if (automaticShutdown) t.after(() => app.shutdown());
  return { app, hooks, panels, popups, copied, notes, prompts, backendCalls, behaviors, events, reader, body,
    first, second, standalone, render, select, succeed, failPartial, readerWindow, modelSettings, prefs,
    timers, preferenceObservers,
    setAuto: (value) => env.Zotero.Prefs.set("extensions.paperlens.autoTranslateSelection", value),
    fireTimer: () => { const next = timers.entries().next().value; if (!next) return; timers.delete(next[0]); return next[1].callback(); },
    notifyTab: (event, ids) => tabNotifier?.notify(event, "tab", ids),
    get settingsReads() { return settingsReads; }, get connects() { return connects; },
    get authCreates() { return authCreates; }, get backendCreates() { return backendCreates; },
    get disconnects() { return disconnects; } };
}

test("independent translations omit legacy questions and prior conversation from prompts and notes", async (t) => {
  const h = await harness(t);
  const panel = h.render();
  h.succeed("Translation A");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Source A" },
    question: "An obsolete question", history: [{ question: "Old question", answer: "Old answer" }] });
  h.succeed("Translation B");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Source B" },
    question: "Another obsolete question" });
  assert.deepEqual(h.prompts.map((prompt) => prompt.selection), ["Source A", "Source B"]);
  for (const prompt of h.prompts) {
    assert.equal(prompt.action, "translate");
    assert.equal(Object.hasOwn(prompt, "question"), false);
    assert.equal(Object.hasOwn(prompt, "history"), false);
  }
  await panel.callbacks.onSave();
  assert.match(h.notes[0].html, /Source B/);
  assert.match(h.notes[0].html, /Translation B/);
  assert.doesNotMatch(h.notes[0].html, /Source A|Translation A|obsolete question|Old question|Old answer/);
  assert.equal(h.backendCalls.at(-1).model, "gpt-6-luna");
});

test("a failed partial response cannot overwrite a saved complete answer", async (t) => {
  const h = await harness(t);
  const panel = h.render();
  h.succeed("Complete answer");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "First source" } });
  await panel.callbacks.onSave();
  assert.equal(h.notes.length, 1);
  h.failPartial("An unfinished answer");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Follow-up" } });
  assert.equal(panel.response, "An unfinished answer");
  await panel.callbacks.onSave();
  assert.equal(h.notes.length, 1);
  assert.match(panel.errors.at(-1), /未完成/);
  assert.equal(h.notes[0].parentID, 101);
});

test("retry translates the original selection after the reader selection changes", async (t) => {
  const h = await harness(t);
  const panel = h.render();
  h.select(4, "v", "Source to retry");
  h.failPartial("Incomplete translation");
  await panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) });
  assert.match(panel.errors.at(-1), /请求失败/);
  assert.doesNotMatch(panel.errors.at(-1), /Synthetic interruption/);
  h.select(7, "8", "Different source selected later");
  h.succeed("Retried translation");
  await panel.callbacks.onRetry();
  assert.deepEqual(h.prompts.map((prompt) => prompt.selection), ["Source to retry", "Source to retry"]);
  assert.equal(Object.hasOwn(h.prompts[1], "history"), false);
  await panel.callbacks.onSave();
  assert.match(h.notes[0].html, /Source to retry/);
  assert.match(h.notes[0].html, /DEMO0001\?page=5/);
  assert.doesNotMatch(h.notes[0].html, /Different source selected later|Incomplete translation/);
});

test("legacy ask requests are rejected before reading settings or calling the backend", async (t) => {
  const h = await harness(t);
  const panel = h.render();
  const reads = h.settingsReads;
  await panel.callbacks.onSubmit({ action: "ask", question: "A legacy question", selection: { text: "Source" } });
  assert.match(panel.errors.at(-1), /翻译/);
  assert.equal(h.settingsReads, reads);
  assert.equal(h.backendCalls.length, 0);
  assert.equal(h.prompts.length, 0);
  assert.notEqual(panel.busy, true);
});

test("failed or cancelled partial text equal to a previous answer remains unsavable", async (t) => {
  for (const outcome of ["failed", "cancelled"]) {
    await t.test(outcome, async (subtest) => {
      const h = await harness(subtest);
      let panel = h.render();
      const identicalText = "An answer that both requests happen to share";
      h.succeed(identicalText);
      await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Completed source" } });
      assert.equal(panel.canSave, true);
      if (outcome === "failed") {
        h.failPartial(identicalText);
        await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Failed source" } });
      } else {
        let started;
        const whenStarted = new Promise((resolve) => { started = resolve; });
        h.behaviors.push((options) => new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })), { once: true });
          options.onDelta(identicalText);
          started();
        }));
        const request = panel.callbacks.onSubmit({ action: "translate", selection: { text: "Cancelled source" } });
        await whenStarted;
        panel.callbacks.onCancel();
        await request;
      }
      assert.equal(panel.response, identicalText);
      assert.equal(panel.canSave, false);
      await panel.callbacks.onSave();
      assert.equal(h.notes.length, 0);
      assert.match(panel.errors.at(-1), /未完成/);
      // The provenance guard must survive destroying and recreating the pane.
      h.hooks.section.onDestroy({ body: h.body });
      panel = h.render();
      assert.equal(panel.response, identicalText);
      assert.equal(panel.canSave, false);
      await panel.callbacks.onSave();
      assert.equal(h.notes.length, 0);
      h.succeed("A newly completed answer");
      await panel.callbacks.onSubmit({ action: "translate", selection: { text: "New successful source" } });
      assert.equal(panel.canSave, true);
      await panel.callbacks.onSave();
      assert.equal(h.notes.length, 1);
    });
  }
});

test("rebinding the same pane aborts the old paper request and rejects stale streamed output", async (t) => {
  const h = await harness(t);
  const oldPanel = h.render();
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let oldOptions;
  h.behaviors.push((options) => new Promise((resolve, reject) => {
    oldOptions = options;
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })), { once: true });
    options.onDelta("Old paper draft");
    resolveStarted();
  }));
  const request = oldPanel.callbacks.onSubmit({ action: "translate", selection: { text: "Old paper source" } });
  await started;
  h.reader.itemID = h.second.id;
  const newPanel = h.render();
  assert.equal(oldPanel.disposed, true);
  assert.equal(oldOptions.signal.aborted, true);
  assert.equal(newPanel.paper.attachmentKey, h.second.key);
  oldOptions.onDelta(" stale delta");
  assert.equal(newPanel.response, "");
  await request;
  oldOptions.onDelta(" late delta after cancellation");
  assert.equal(newPanel.response, "");
  h.succeed("New paper answer");
  await newPanel.callbacks.onSubmit({ action: "translate", selection: { text: "New paper source" } });
  assert.equal(newPanel.response, "New paper answer");
  assert.equal(h.prompts.at(-1).paper.attachmentKey, h.second.key);
  assert.equal(Object.hasOwn(h.prompts.at(-1), "history"), false);
});

test("note source links retain real PDF indexes but never turn a missing index into page 1", async (t) => {
  const h = await harness(t);
  const panel = h.render();
  h.select(null, "");
  h.succeed("Translation without a known page");
  await panel.callbacks.onSubmit({ action: "translate", question: "", selection: clone(panel.selection) });
  await panel.callbacks.onSave();
  assert.match(h.notes[0].html, /zotero:\/\/open-pdf\/library\/items\/DEMO0001/);
  assert.doesNotMatch(h.notes[0].html, /\?page=/);
  h.select(4, "v");
  h.succeed('Translated <script>source</script> safely');
  await panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) });
  await panel.callbacks.onSave();
  assert.match(h.notes[1].html, /DEMO0001\?page=5/);
  assert.match(h.notes[1].html, /第 v 页/);
  assert.match(h.notes[1].html, /&lt;script&gt;source&lt;\/script&gt;/);
  assert.doesNotMatch(h.notes[1].html, /<script>/);
});

test("standalone PDFs save related notes without assigning an attachment as note parent", async (t) => {
  const h = await harness(t);
  h.reader.itemID = h.standalone.id;
  const panel = h.render();
  h.succeed("Standalone PDF answer");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "The definition appears in the preceding sentence." } });
  await panel.callbacks.onSave();
  assert.equal(h.notes[0].parentID, undefined);
  assert.deepEqual(h.notes[0].related, [h.standalone.id]);
});

test("opening the panel waits, while the single selection button automatically translates", async (t) => {
  const h = await harness(t);
  const { win, contextPane, section, scrolled } = h.readerWindow();
  h.render();
  assert.equal(contextPane.mode, "notes");
  await h.app.openReader(h.reader, "translate", { text: "Existing selection", pageLabel: "4", pageIndex: 3 });
  assert.equal(contextPane.mode, "item");
  assert.equal(contextPane.collapsed, false);
  assert.equal(win.ZoteroContextPane.collapsed, false);
  assert.equal(h.reader.contextPaneOpen, true);
  assert.equal(section.open, true);
  assert.equal(h.panels.at(-1).focused, true);
  assert.equal(h.panels.at(-1).getDraft().action, "translate");
  assert.deepEqual(h.panels.at(-1).selection, { text: "Existing selection", pageLabel: "4" });
  assert.equal(h.backendCalls.length, 0);
  assert.deepEqual(scrolled, [{ id: "registered-paperlens", behavior: "instant" }]);
  const popup = h.select(4, "5");
  h.succeed("Translation from the popup");
  await popup.children[0].listeners.get("click")();
  assert.equal(h.backendCalls.length, 1);
  assert.equal(h.prompts.at(-1).selection, "Synthetic selected source");
  assert.equal(h.prompts.at(-1).action, "translate");
  await h.panels.at(-1).callbacks.onSave();
  assert.match(h.notes[0].html, /DEMO0001\?page=5/);
});

test("English Zotero passes its language to context and localizes notes and login errors", async (t) => {
  const h = await harness(t, { locale: "en-GB" });
  const panel = h.render();
  assert.equal(panel.locale, "en");
  h.select(4, "5");
  h.succeed("An English answer");
  await panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) });
  assert.equal(h.prompts.at(-1).locale, "en");
  await panel.callbacks.onSave();
  assert.match(h.notes[0].html, /Paper Lens/);
  assert.match(h.notes[0].html, /translation/i);
  assert.doesNotMatch(h.notes[0].html, /Question/);
  assert.doesNotMatch(h.notes[0].html, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(panel.statuses.at(-1).text, /[\u4e00-\u9fff]/);
  h.behaviors.push(() => { throw Object.assign(new Error("原始认证错误"), { code: "LOGIN_EXPIRED" }); });
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Another source sentence." } });
  assert.match(panel.errors.at(-1), /login|sign.in/i);
  assert.doesNotMatch(panel.errors.at(-1), /原始认证错误/);
});

test("the reader always defaults to Luna regardless of the Codex default and has no model controls", async (t) => {
  const h = await harness(t);
  const panel = h.render();
  assert.equal(h.settingsReads, 0, "startup and panel rendering must not read Codex settings");
  assert.equal(Object.hasOwn(panel.callbacks, "onModelChange"), false);
  assert.equal(Object.hasOwn(panel.callbacks, "onRefreshModels"), false);
  assert.deepEqual(h.hooks.registeredPrefs[0].scripts, ["content/preferences.js"]);
  h.modelSettings.defaultModel = "gpt-6.1-sol";
  h.modelSettings.models.push({ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Sol 6.1" });
  h.succeed("Answer from Luna");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "First source" } });
  assert.equal(h.backendCalls.at(-1).model, "gpt-6-luna");
  h.modelSettings.defaultModel = "gpt-6-sol";
  h.succeed("Another answer from Luna");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Second source" } });
  assert.equal(h.backendCalls.at(-1).model, "gpt-6-luna");
  assert.equal(h.settingsReads, 0, "translation must use the Zotero preference without refreshing the model list");
});

test("startup migrates empty and legacy follow-Codex choices to Luna", async (t) => {
  for (const initialModelPref of ["", "codex-default"]) {
    await t.test(initialModelPref || "empty preference", async (subtest) => {
      const h = await harness(subtest, { initialModelPref });
      assert.equal(h.prefs.get("extensions.paperlens.model"), "gpt-6-luna");
      assert.equal(h.settingsReads, 0);
      const panel = h.render();
      h.succeed("Luna translation after migration");
      await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Synthetic migration source" } });
      assert.equal(h.backendCalls[0].model, "gpt-6-luna");
    });
  }
});

test("settings refresh keeps the explicit Zotero model even when the account catalog omits it", async (t) => {
  const h = await harness(t, { initialModelPref: "gpt-6-sol" });
  const panel = h.render();
  assert.equal(h.prefs.get("extensions.paperlens.model"), "gpt-6-sol", "startup must preserve explicit choices");
  h.modelSettings.defaultModel = "gpt-6.1-sol";
  h.modelSettings.models = h.modelSettings.models.filter((model) => model.model !== "gpt-6-sol");
  h.modelSettings.warnings = ["synthetic-cache-warning"];
  const options = await h.app.getModelOptions();
  assert.deepEqual(Object.keys(options).sort(), ["models", "selectedAvailable", "selectedModel", "source", "warnings"]);
  assert.equal(options.selectedModel, "gpt-6-sol");
  assert.ok(options.models.some((model) => model.model === "gpt-6-sol"), "a saved choice remains selectable even when missing from the catalog");
  assert.deepEqual(options.warnings, ["synthetic-cache-warning"]);
  assert.equal(options.source, "account");
  assert.equal(h.prefs.get("extensions.paperlens.model"), "gpt-6-sol");
  assert.equal(h.settingsReads, 1);
  h.modelSettings.models.push({ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "Astra" });
  const refreshed = await h.app.getModelOptions();
  assert.equal(h.settingsReads, 2);
  assert.ok(refreshed.models.some((model) => model.model === "gpt-6-astra"));
  assert.equal(refreshed.selectedModel, "gpt-6-sol");
  assert.equal(h.prefs.get("extensions.paperlens.model"), "gpt-6-sol");
  assert.equal(h.authCreates, 1, "the account catalog uses one shared credential provider");
  assert.equal(h.backendCreates, 0, "loading model options must not create a model backend");
  assert.equal(h.connects, 0);
  assert.equal(h.backendCalls.length, 0);
  h.succeed("Translation using the saved setting");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Synthetic saved-setting source" } });
  assert.equal(h.backendCalls[0].model, "gpt-6-sol");
  assert.equal(h.settingsReads, 2);
});

test("a request captures its model before asynchronous context work while the next request uses the changed setting", async (t) => {
  const h = await harness(t, { initialModelPref: "gpt-6-sol" });
  const panel = h.render();
  let contextStarted, finishContext;
  const whenContextStarted = new Promise((resolve) => { contextStarted = resolve; });
  h.first.getFilePathAsync = () => {
    contextStarted();
    return new Promise((resolve) => { finishContext = resolve; });
  };
  h.succeed("Translation using the model selected when the request began");
  const request = panel.callbacks.onSubmit({ action: "translate", selection: { text: "Synthetic in-flight source" } });
  await whenContextStarted;
  h.prefs.set("extensions.paperlens.model", "gpt-6-luna");
  finishContext("/synthetic/DEMO0001.pdf");
  await request;
  assert.equal(h.backendCalls[0].model, "gpt-6-sol");
  await panel.callbacks.onSave();
  assert.match(h.notes[0].html, /gpt-6-sol/);
  h.first.getFilePathAsync = async () => "/synthetic/DEMO0001.pdf";
  h.succeed("Translation using the newly selected model");
  await panel.callbacks.onSubmit({ action: "translate", selection: { text: "Synthetic next source" } });
  assert.equal(h.backendCalls[1].model, "gpt-6-luna");
  assert.equal(h.settingsReads, 0);
});

test("shutdown releases reader hooks, pane registration, panels, preferences, and model backend", async (t) => {
  const h = await harness(t, { automaticShutdown: false });
  const panel = h.render();
  h.app.getBackend();
  assert.equal(h.app.panelCount, 1);
  await h.app.shutdown();
  assert.equal(h.app.panelCount, 0);
  assert.equal(panel.disposed, true);
  assert.deepEqual(h.hooks.unregisteredEvents.sort(), ["renderTextSelectionPopup", "renderToolbar"]);
  assert.deepEqual(h.hooks.unregisteredSections, ["registered-paperlens"]);
  assert.deepEqual(h.hooks.unregisteredPrefs, ["paperlens-preferences"]);
  assert.equal(h.disconnects, 1);
  assert.equal(h.events.size, 0);
  assert.equal(h.preferenceObservers.size, 0);
  assert.equal(h.timers.size, 0);
});

test("selection translation is opt-in, opens the reading pane and uses the saved model", async (t) => {
  const h = await harness(t, { initialModelPref: "gpt-6-sol" });
  const ui = h.readerWindow();
  h.select(2, "3", "Manual-only selection");
  assert.equal(h.timers.size, 0);
  h.setAuto(true);
  assert.equal(h.timers.size, 0, "enabling must wait for a new selection");
  h.select(4, "5", "Automatically selected source");
  assert.equal(h.backendCalls.length, 0);
  assert.equal([...h.timers.values()][0].delay, 350);
  h.succeed("Automatic translation");
  await h.fireTimer();
  assert.equal(h.backendCalls[0].model, "gpt-6-sol");
  assert.equal(h.prompts[0].selection, "Automatically selected source");
  assert.equal(ui.contextPane.collapsed, false);
  assert.equal(h.panels.at(-1).response, "Automatic translation");
});

test("rapid selections and repeated popups translate only the latest source", async (t) => {
  const h = await harness(t); h.readerWindow(); h.setAuto(true);
  const oldRow = h.select(0, "1", "First source");
  h.select(0, "1", "Second source");
  const secondRow = h.select(0, "1", "Second source");
  oldRow.isConnected = false;
  assert.equal(h.timers.size, 1);
  h.succeed("Latest translation"); await h.fireTimer();
  assert.deepEqual(h.prompts.map(x => x.selection), ["Second source"]);
  h.select(0, "1", "Second source");
  assert.equal(h.timers.size, 0, "rerendering after completion must not send again");
  secondRow.isConnected = false;
});

test("closing the switch during asynchronous paper extraction sends no model request", async (t) => {
  const h = await harness(t); h.readerWindow(); h.setAuto(true);
  let started, finish;
  const whenStarted = new Promise(resolve => { started = resolve; });
  h.first.getFilePathAsync = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  h.select(1, "2", "A pending source");
  const task = h.fireTimer(); await whenStarted;
  h.setAuto(false); finish("/synthetic/DEMO0001.pdf"); await task;
  assert.equal(h.backendCalls.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.panels.at(-1).busy, false);
});

test("a newer automatic selection aborts the old request and rejects late deltas and results", async (t) => {
  const h = await harness(t); h.readerWindow(); h.setAuto(true);
  let started, finishOld, oldOptions;
  const whenStarted = new Promise(resolve => { started = resolve; });
  h.behaviors.push(options => new Promise(resolve => {
    oldOptions = options; finishOld = resolve; options.onDelta("Old unfinished translation"); started();
  }));
  h.select(1, "2", "Old source");
  const oldTask = h.fireTimer(); await whenStarted;
  const panel = h.panels.at(-1);
  h.select(2, "3", "New source");
  assert.equal(oldOptions.signal.aborted, true);
  oldOptions.onDelta("Late stale fragment");
  assert.doesNotMatch(panel.response, /Late stale/);
  h.succeed("New completed translation");
  const newTask = h.fireTimer();
  assert.equal(h.backendCalls.length, 1, "the shared backend must wait for cancellation cleanup");
  finishOld({ text: "Stale completed result" });
  await Promise.all([oldTask, newTask]);
  assert.equal(panel.response, "New completed translation");
  assert.equal(panel.errors.length, 0);
  assert.equal(panel.canSave, true);
  await panel.callbacks.onSave();
  assert.match(h.notes[0].html, /New source/);
  assert.doesNotMatch(h.notes[0].html, /Old source|Stale completed/);
});

test("switching tabs or closing a reader cancels pending automatic requests", async (t) => {
  const h = await harness(t); const { win } = h.readerWindow(); h.setAuto(true);
  h.select(0, "1", "Inactive source");
  win.Zotero_Tabs.selectedID = "another-tab";
  h.notifyTab("select", ["another-tab"]);
  assert.equal(h.timers.size, 0);
  win.Zotero_Tabs.selectedID = h.reader.tabID;
  h.select(0, "1", "Closing source");
  h.notifyTab("close", [h.reader.tabID]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.backendCalls.length, 0);
});

test("a manual translation click cancels the pending automatic copy of the same request", async (t) => {
  const h = await harness(t); h.readerWindow(); h.setAuto(true);
  const row = h.select(0, "1", "Manually started source");
  h.succeed("Manual translation");
  await row.children[0].listeners.get("click")();
  assert.equal(h.timers.size, 0);
  assert.equal(h.backendCalls.length, 1);
  assert.equal(h.panels.at(-1).response, "Manual translation");
});

test("automatic selection translation ignores non-PDF readers", async (t) => {
  const h = await harness(t); h.readerWindow(); h.setAuto(true);
  h.first.attachmentContentType = "application/epub+zip";
  h.select(0, "1", "An EPUB passage");
  assert.equal(h.timers.size, 0);
  assert.equal(h.backendCalls.length, 0);
});

test("closing a tab interrupts its active automatic request even before the reader is unregistered", async (t) => {
  const h = await harness(t); h.readerWindow(); h.setAuto(true);
  let started, options;
  const whenStarted = new Promise(resolve => { started = resolve; });
  h.behaviors.push(input => new Promise((resolve, reject) => {
    options = input; started();
    input.signal.addEventListener("abort", () => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })));
  }));
  h.select(0, "1", "An active source");
  const task = h.fireTimer(); await whenStarted;
  h.notifyTab("close", [h.reader.tabID]);
  assert.equal(options.signal.aborted, true); await task;
  assert.equal(h.panels.at(-1).canSave, false);
});

test("one translation streams to both the selection popup and reading pane", async (t) => {
  const h = await harness(t); const panel = h.render();
  h.select(3, "4", "A shared source");
  const popup = h.popups.at(-1);
  let started, finish, requestOptions;
  const whenStarted = new Promise(resolve => { started = resolve; });
  h.behaviors.push(options => new Promise(resolve => {
    requestOptions = options; options.onDelta("First fragment"); started(); finish = resolve;
  }));
  const request = panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) });
  await whenStarted;
  assert.equal(panel.response, "First fragment");
  assert.equal(popup.state.text, "First fragment");
  assert.equal(popup.state.busy, true);
  requestOptions.onDelta(" and second fragment");
  finish({ text: "First fragment and second fragment" }); await request;
  assert.equal(h.backendCalls.length, 1);
  assert.equal(popup.state.text, panel.response);
  assert.equal(popup.state.complete, true);
  assert.equal(popup.state.busy, false);
  popup.options.onCopy(popup.state.text);
  assert.deepEqual(h.copied, ["First fragment and second fragment"]);
});

test("a same-selection popup redraw restores the live translation and releases the old view", async (t) => {
  const h = await harness(t); const panel = h.render(); h.select(0, "1", "Source A");
  const oldPopup = h.popups.at(-1);
  let started, finish, options;
  const whenStarted = new Promise(resolve => { started = resolve; });
  h.behaviors.push(input => new Promise(resolve => { options = input; input.onDelta("Partial A"); started(); finish = resolve; }));
  const request = panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) }); await whenStarted;
  h.select(0, "1", "Source A");
  const newPopup = h.popups.at(-1);
  assert.equal(oldPopup.disposed, true);
  assert.equal(newPopup.state.text, "Partial A");
  assert.equal(newPopup.state.busy, true);
  const oldWrites = oldPopup.writes.length;
  options.onDelta(" continued"); finish({ text: "Partial A continued" }); await request;
  assert.equal(newPopup.state.text, "Partial A continued");
  assert.equal(oldPopup.writes.length, oldWrites);
});

test("a different selection never displays or receives the previous selection's translation", async (t) => {
  const h = await harness(t); const panel = h.render(); h.select(0, "1", "Source A");
  let started, finish;
  const whenStarted = new Promise(resolve => { started = resolve; });
  h.behaviors.push(options => new Promise(resolve => { options.onDelta("Partial A"); started(); finish = resolve; }));
  const request = panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) }); await whenStarted;
  h.select(1, "2", "Source B"); const popupB = h.popups.at(-1);
  assert.equal(popupB.state.text, "");
  finish({ text: "Completed A" }); await request;
  assert.equal(popupB.state.text, "");
  assert.equal(popupB.state.complete, false);
  h.select(0, "1", "Source A"); assert.equal(h.popups.at(-1).state.text, "Completed A");
  h.select(2, "3", "Source A"); assert.equal(h.popups.at(-1).state.text, "", "the same text on another page needs its own source match");
});

test("failed popup requests do not display the previous completed translation restored in the sidebar", async (t) => {
  const h = await harness(t); const panel = h.render(); h.select(0, "1", "Successful source");
  h.succeed("Previous completed translation");
  await panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) });
  h.select(1, "2", "Failing source"); const popup = h.popups.at(-1);
  h.behaviors.push(() => { throw Object.assign(new Error("Sensitive internal detail"), { code: "NETWORK_ERROR" }); });
  await panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) });
  assert.equal(panel.response, "Previous completed translation");
  assert.equal(popup.state.text, "");
  assert.equal(popup.state.complete, false);
  assert.match(popup.state.error, /无法连接/);
  assert.doesNotMatch(popup.state.error, /Sensitive|detail/);
});

test("the popup stop control interrupts the same request shown in the reading pane", async (t) => {
  const h = await harness(t); const panel = h.render(); h.select(0, "1", "Source to stop");
  const popup = h.popups.at(-1);
  let started;
  const whenStarted = new Promise(resolve => { started = resolve; });
  h.behaviors.push(options => new Promise((resolve, reject) => {
    options.onDelta("Incomplete translation"); started();
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })));
  }));
  const request = panel.callbacks.onSubmit({ action: "translate", selection: clone(panel.selection) }); await whenStarted;
  popup.options.onCancel(); await request;
  assert.equal(popup.state.text, "Incomplete translation");
  assert.equal(popup.state.complete, false);
  assert.equal(popup.state.busy, false);
  assert.match(popup.state.status, /取消/);
  assert.equal(panel.canSave, false);
});

test("reader closure and plugin shutdown release selection popup views", async (t) => {
  const h = await harness(t, { automaticShutdown: false }); h.readerWindow();
  h.select(0, "1", "Closing source"); const firstPopup = h.popups.at(-1);
  h.notifyTab("close", [h.reader.tabID]); assert.equal(firstPopup.disposed, true);
  h.select(0, "1", "Another source"); const secondPopup = h.popups.at(-1);
  await h.app.shutdown(); assert.equal(secondPopup.disposed, true);
});

test("a new selection during a manual popup's asynchronous panel opening prevents the old request", async (t) => {
  const h = await harness(t); h.readerWindow();
  let opened, release;
  const whenOpening = new Promise(resolve => { opened = resolve; });
  h.reader.setContextPaneOpen = () => { opened(); return new Promise(resolve => { release = resolve; }); };
  h.select(0, "1", "Old manually requested source");
  const oldPopup = h.popups.at(-1);
  const opening = oldPopup.options.onTranslate(); await whenOpening;
  h.select(1, "2", "New source while opening");
  release(); await opening;
  assert.equal(h.backendCalls.length, 0);
  assert.equal(h.panels.at(-1).selection.text, "New source while opening");
  assert.equal(h.popups.at(-1).state.text, "");
});

test("automatic panel-opening errors are also shown in the selection popup", async (t) => {
  const h = await harness(t); h.readerWindow(); h.setAuto(true);
  h.reader.setContextPaneOpen = async () => { throw new Error("Internal renderer detail"); };
  h.select(0, "1", "Source whose pane fails");
  await h.fireTimer();
  assert.match(h.popups.at(-1).state.error, /请求失败/);
  assert.doesNotMatch(h.popups.at(-1).state.error, /Internal|detail/);
  assert.equal(h.backendCalls.length, 0);
});
