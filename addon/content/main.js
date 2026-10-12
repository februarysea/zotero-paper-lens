/* Zotero owns reading context, UI, and notes. The model backend only sees prepared text. */
var PaperLensMain = (function () {
  "use strict";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const PREF = "extensions.paperlens.";
  const DEFAULT_MODEL = "gpt-6-luna";
  const LEGACY_MODEL = "codex-default";
  const escapeHTML = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
  function paperKey(attachment) { return attachment.libraryID + ":" + attachment.key; }

  function create({ id, version, rootURI, env }) {
    const { Zotero, Services, IOUtils, PathUtils, AbortController } = env;
    const i18n = env.PaperLensI18n.create(Zotero.locale || Services.locale?.appLocaleAsBCP47 || "en-US");
    const t = i18n.t;
    const bindings = new Map();
    const popupBindings = new Map();
    const records = new Map();
    let preferenceObserver = null, tabObserver = null;
    const windows = new Map();
    const textCache = new Map();
    let paneID = null, backend = null, authProvider = null, settingsReader = null, activeRun = null, stopped = false;
    const pref = (key, fallback) => Zotero.Prefs.get(PREF + key, true) || fallback;
    const setPref = (key, value) => Zotero.Prefs.set(PREF + key, value, true);
    const logError = (e) => Zotero.debug("[Paper Lens] "
      + (typeof e?.code === "string" && t("error." + e.code) !== "error." + e.code ? e.code : "Error"));
    const autoTranslator = env.PaperLensSelection.create({
      isEnabled: () => Zotero.Prefs.get(PREF + "autoTranslateSelection", true) === true,
      isCurrent: currentReader,
      isSelecting: (reader) => [reader._internalReader?._primaryView, reader._internalReader?._secondaryView]
        .some((view) => view?.action?.type === "selectText"),
      setTimeout: env.setTimeout, clearTimeout: env.clearTimeout, MutationObserver: env.MutationObserver,
      onSupersede: () => activeRun?.controller.abort(),
      cancelAutomatic: () => { if (activeRun?.automatic) activeRun.controller.abort(); },
      translate: async (job) => {
        if (activeRun) { const previous = activeRun; previous.controller.abort(); await previous.done; }
        if (job.isCurrent()) await openReader(job.reader, "translate", job.selection, true,
          { automatic: true, isCurrent: job.isCurrent });
      },
      onError: (error, reader) => {
        logError(error);
        const binding = [...bindings.values()].find((b) => b.attachment.id === reader.itemID);
        binding?.panel.showError(i18n.error(error, "host.request_failed"));
        const entry = popupBindings.get(reader);
        const record = entry && records.get(entry.key);
        if (record) {
          const display = { selectionKey: entry.selectionKey, text: "", status: "",
            error: i18n.error(error, "host.request_failed"), busy: false, complete: false };
          record.popupState = display; updatePopup(record, display, {});
        }
      },
    });
    function currentReader(reader) {
      const win = reader._window || Zotero.getMainWindow();
      return !!reader.tabID && !win?.closed && win?.Zotero_Tabs?.selectedID === reader.tabID
        && Zotero.Reader.getByTabID(reader.tabID) === reader;
    }
    function getAuthProvider() {
      if (!authProvider) authProvider = env.PaperLensAuth.createAuthProvider({ IOUtils, PathUtils,
        cryptoImpl: env.crypto, fetchImpl: env.fetch, encode: env.btoa, decode: env.atob,
        listen: ({ state }) => env.PaperLensLoopback.createListener({ Cc: env.Cc, Ci: env.Ci,
          ChromeUtils: env.ChromeUtils, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout,
          URLImpl: env.URL, state }),
        openBrowser: (url) => Zotero.launchURL(url),
      });
      return authProvider;
    }
    const selectedModel = () => {
      const model = pref("model", DEFAULT_MODEL);
      return typeof model === "string" && model !== LEGACY_MODEL && /^[A-Za-z0-9._-]{1,128}$/.test(model)
        ? model : DEFAULT_MODEL;
    };
    async function getModelOptions() {
      let state;
      try {
        settingsReader ||= env.PaperLensSettings.createSettingsReader({ authProvider: getAuthProvider(), fetchImpl: env.fetch });
        state = await settingsReader.read();
      }
      catch (e) {
        logError(e);
        state = { models: [{ id: DEFAULT_MODEL, model: DEFAULT_MODEL, displayName: "Luna" }],
          source: "fallback", warnings: ["MODEL_CATALOG_UNAVAILABLE"] };
      }
      const models = [...state.models];
      const current = selectedModel();
      if (!models.some((item) => item.model === current)) {
        models.push({ id: current, model: current, displayName: current });
      }
      return { models, selectedModel: current, warnings: state.warnings, source: state.source,
        selectedAvailable: state.source === "account" ? models.find(x => x.model === current)?.available === true : null };
    }
    function getBackend() {
      if (!backend) {
        backend = new env.PaperLensCodex.CodexBackend({ authProvider: getAuthProvider(), fetchImpl: env.fetch });
      }
      return backend;
    }
    function getAuthState() { return getAuthProvider().getState(); }
    async function signIn(accountID = null) {
      const state = await getAuthProvider().signIn(accountID);
      activeRun?.controller.abort(); await backend?.disconnect?.();
      return state;
    }
    function cancelSignIn() { authProvider?.cancelSignIn(); }
    async function switchAccount(id) {
      activeRun?.controller.abort(); await backend?.disconnect?.();
      return getAuthProvider().switchAccount(id);
    }
    async function signOut() {
      activeRun?.controller.abort(); await backend?.disconnect?.();
      return getAuthProvider().signOut();
    }
    function readerForBody(body) {
      const doc = body.ownerDocument;
      const tabID = body.closest("item-details")?.tabID;
      return tabID ? Zotero.Reader.getByTabID(tabID) : doc.defaultView?.reader;
    }
    function attachmentForBody(body) {
      const reader = readerForBody(body);
      const item = reader && Zotero.Items.get(reader.itemID);
      return item?.isAttachment() && item.attachmentContentType === "application/pdf" ? item : null;
    }
    function getRecord(attachment) {
      const key = paperKey(attachment);
      if (!records.has(key)) {
        records.set(key, { key, selection: { text: "", pageLabel: "" },
          response: "", draft: { action: "translate", question: "" }, lastRequest: null,
          responseIsComplete: false, lastResult: null });
        if (records.size > 20) {
          const oldest = [...records.keys()].find((k) => k !== activeRun?.record?.key && k !== key);
          if (oldest) records.delete(oldest);
        }
      }
      return records.get(key);
    }
    function selectionKey(selection) {
      return JSON.stringify([selection.text || "", selection.pageIndex ?? null, selection.pageLabel || ""]);
    }
    function disposePopup(reader) {
      popupBindings.get(reader)?.popup.dispose(); popupBindings.delete(reader);
    }
    function updatePopup(record, display, changes) {
      if (record.popupState !== display) return;
      Object.assign(display, changes);
      for (const entry of popupBindings.values()) {
        if (entry.key === record.key && entry.selectionKey === display.selectionKey) entry.popup.render(display);
      }
    }
    function titleFor(attachment) {
      const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
      return (parent || attachment).getField("title") || t("host.current_paper");
    }
    async function paperFor(attachment, selection) {
      const key = paperKey(attachment);
      const path = await attachment.getFilePathAsync();
      let stamp = String(attachment.dateModified || "");
      if (path) {
        try { stamp += ":" + (await IOUtils.stat(path)).lastModified; } catch (_) {}
      }
      let cached = textCache.get(key);
      if (!cached || cached.stamp !== stamp) {
        const promise = (async () => {
          let text = "";
          try { text = await attachment.attachmentText || ""; } catch (_) {}
          return text;
        })();
        cached = { stamp, promise };
        textCache.set(key, cached);
        if (textCache.size > 8) textCache.delete(textCache.keys().next().value);
      }
      const text = await cached.promise;
      const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
      const item = parent || attachment;
      return { title: titleFor(attachment), authors: item.getCreators().map((c) =>
        [c.firstName, c.lastName].filter(Boolean).join(" ")).join(", "),
        abstract: parent?.getField("abstractNote") || "", text,
        attachmentKey: attachment.key, pageLabel: selection?.pageLabel || "" };
    }
    function renderBinding(body) {
      const attachment = attachmentForBody(body);
      if (!attachment) return;
      let binding = bindings.get(body);
      if (binding && binding.key !== paperKey(attachment)) {
        if (activeRun?.binding === binding) activeRun.controller.abort();
        binding.record.draft = binding.panel.getDraft();
        binding.panel.dispose(); bindings.delete(body); binding = null;
      }
      if (binding) return;
      const record = getRecord(attachment);
      const callbacks = {
        onSubmit: (request) => submit(binding, request),
        onCancel: () => { autoTranslator.cancelPending(); if (activeRun?.binding === binding) activeRun.controller.abort(); },
        onRetry: () => record.lastRequest && submit(binding, record.lastRequest),
        onCopy: (text) => copy(text),
        onSave: () => save(binding),
        onOpenLink: (url) => Zotero.launchURL(url),
      };
      const panel = env.PaperLensUI.createPanel({ document: body.ownerDocument, container: body,
        callbacks, i18n });
      binding = { body, panel, attachment, key: paperKey(attachment), record };
      bindings.set(body, binding);
      panel.setPaper({ title: titleFor(attachment), attachmentKey: attachment.key });
      panel.setSelection(record.selection); panel.setDraft(record.draft);
      panel.setResponse(record.response);
      panel.setCanSave?.(record.responseIsComplete);
      panel.setStatus(t("host.idle"));
    }
    async function submit(binding, request, { automatic = false, isCurrent = () => true } = {}) {
      if (!binding || stopped || !bindings.has(binding.body)) return;
      if (request.action !== "translate") { binding.panel.showError(t("error.INVALID_ACTION")); return; }
      if (!automatic) autoTranslator.cancelPending();
      if (!isCurrent()) return;
      if (activeRun) { binding.panel.showError(t("host.busy")); return; }
      const record = binding.record;
      const selection = request.selection && typeof request.selection === "object"
        ? { ...record.selection, ...request.selection } : record.selection;
      const model = selectedModel();
      const controller = new AbortController();
      let finishRun;
      const done = new Promise((resolve) => { finishRun = resolve; });
      const display = { selectionKey: selectionKey(selection), text: "", status: t("host.preparing"),
        error: "", busy: true, complete: false };
      record.popupState = display;
      const run = { binding, record, controller, done, automatic, reader: readerForBody(binding.body),
        selectionKey: display.selectionKey };
      activeRun = run;
      record.draft = { action: "translate", question: "" };
      record.lastRequest = { action: "translate", question: "", selection: { ...selection } };
      const priorResponse = record.response;
      const priorComplete = record.responseIsComplete;
      record.responseIsComplete = false;
      let received = "";
      binding.panel.setBusy(true); binding.panel.setResponse("");
      binding.panel.setCanSave?.(false);
      binding.panel.setStatus(t("host.preparing"));
      updatePopup(record, display, {});
      try {
        const paper = await paperFor(binding.attachment, selection);
        if (!isCurrent()) controller.abort();
        if (controller.signal.aborted) throw Object.assign(new Error(t("host.cancelled")), { name: "AbortError" });
        const built = env.PaperLensContext.buildPrompt({ action: "translate",
          selection: selection.text || "", paper, locale: i18n.locale });
        binding.panel.setCoverage(built.coverage.label);
        binding.panel.setStatus(t("host.answering"));
        updatePopup(record, display, { status: t("host.answering") });
        const result = await getBackend().run({ prompt: built.prompt, model, signal: controller.signal,
          onDelta: (delta) => {
            if (activeRun !== run || controller.signal.aborted || bindings.get(binding.body) !== binding) return;
            received += delta; record.response = received;
            updatePopup(record, display, { text: received });
            if (bindings.get(binding.body) === binding) binding.panel.appendResponse(delta);
          } });
        if (controller.signal.aborted || activeRun !== run || bindings.get(binding.body) !== binding) {
          throw Object.assign(new Error(t("host.cancelled")), { name: "AbortError" });
        }
        record.response = result.text;
        record.lastResult = { text: result.text, source: built.source, selection: { ...selection },
          action: "translate", model,
          attachmentID: binding.attachment.id, parentID: binding.attachment.parentID,
          libraryID: binding.attachment.libraryID, coverage: built.coverage.label };
        record.responseIsComplete = true;
        updatePopup(record, display, { text: result.text, status: t("host.complete"), busy: false, complete: true });
        if (bindings.get(binding.body) === binding) {
          binding.panel.setResponse(result.text);
          binding.panel.setStatus(t("host.complete"), "success");
          binding.panel.setCanSave?.(true);
        }
      } catch (e) {
        // Failed/partial responses never replace the last completed note source.
        record.response = received || priorResponse;
        record.responseIsComplete = !received && priorComplete;
        const cancelled = e.name === "AbortError" || controller.signal.aborted;
        updatePopup(record, display, { text: received, busy: false, complete: false,
          status: cancelled ? t("host.cancelled") : "",
          error: cancelled ? "" : i18n.error(e, "host.request_failed") });
        if (bindings.get(binding.body) === binding) {
          binding.panel.setResponse(record.response);
          binding.panel.setCanSave?.(record.responseIsComplete);
          if (e.name === "AbortError" || controller.signal.aborted) binding.panel.setStatus(t("host.cancelled"));
          else { logError(e); binding.panel.showError(i18n.error(e, "host.request_failed")); }
        }
      } finally {
        if (activeRun === run) activeRun = null;
        if (bindings.get(binding.body) === binding) binding.panel.setBusy(false);
        finishRun();
      }
    }
    function copy(text) {
      const helper = env.Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(env.Ci.nsIClipboardHelper);
      helper.copyString(String(text || ""));
    }
    async function save(binding) {
      const result = binding.record.lastResult;
      if (!binding.record.responseIsComplete || !result || result.text !== binding.panel.getResponse()) {
        binding.panel.showError(t("host.save_incomplete")); return;
      }
      try {
        const library = Zotero.Libraries.get(result.libraryID);
        if (!library.editable) throw Object.assign(new Error(t("host.library_read_only")), { code: "LIBRARY_READ_ONLY" });
        const note = new Zotero.Item("note");
        note.libraryID = result.libraryID;
        if (result.parentID) note.parentID = result.parentID;
        const attachment = Zotero.Items.get(result.attachmentID);
        const group = library.libraryType === "group" ? "groups/" + library.groupID : "library";
        const index = result.selection.pageIndex;
        const page = typeof index === "number" && Number.isInteger(index) && index >= 0
          ? "?page=" + (index + 1) : "";
        const link = "zotero://open-pdf/" + group + "/items/" + attachment.key + page;
        const label = t("host.note_translate");
        note.setNote("<h2>" + label + " · " + escapeHTML(result.source.title) + "</h2>"
          + '<p><a href="' + escapeHTML(link) + '">' + escapeHTML(t("host.back_to_source")) + escapeHTML(result.selection.pageLabel ? " · " + t("host.page", { page: result.selection.pageLabel }) : "") + "</a></p>"
          + (result.selection.text ? "<blockquote>" + escapeHTML(result.selection.text).replace(/\n/g, "<br/>") + "</blockquote>" : "")
          + "<p>" + escapeHTML(result.text).replace(/\n/g, "<br/>") + "</p>"
          + "<p><small>Paper Lens · " + escapeHTML(result.model) + " · " + escapeHTML(result.coverage) + "</small></p>");
        await note.saveTx();
        if (!result.parentID) {
          note.addRelatedItem(attachment);
          await note.saveTx();
        }
        binding.panel.setStatus(t(result.parentID ? "host.saved_child" : "host.saved_related"), "success");
      } catch (e) { binding.panel.showError(e.code === "LIBRARY_READ_ONLY" ? t("host.library_read_only") : i18n.error(e, "host.save_failed")); }
    }
    async function openReader(reader, action, selection, autoTranslate = false, options = {}) {
      if (options.isCurrent && !options.isCurrent()) return;
      const win = reader._window || Zotero.getMainWindow();
      attachWindow(win);
      if (reader.tabID) win.Zotero_Tabs.select(reader.tabID);
      const contextPane = win.document.getElementById("zotero-context-pane-inner");
      if (contextPane) { contextPane.collapsed = false; contextPane.mode = "item"; }
      if (win.ZoteroContextPane) win.ZoteroContextPane.collapsed = false;
      await reader.setContextPaneOpen?.(true);
      const details = [...win.document.querySelectorAll("item-details")]
        .find((e) => e.tabID === reader.tabID);
      if (!details) throw new Error(t("host.main_reader_required"));
      await details.render?.();
      await details.scrollToPane(paneID, "instant");
      const section = details.getEnabledPane?.(paneID) || [...details.querySelectorAll("[data-pane]")]
        .find((e) => e.dataset.pane === paneID);
      if (section) { section.open = true; section.querySelector("item-pane-section")?.setAttribute("open", "true"); }
      await section?.render?.(); await section?.asyncRender?.();
      if (options.isCurrent && !options.isCurrent()) return;
      let binding = [...bindings.values()].find((b) => b.attachment.id === reader.itemID && b.body.ownerDocument === win.document);
      if (!binding) throw new Error(t("host.panel_loading"));
      if (selection) { binding.record.selection = { ...selection }; binding.panel.setSelection(selection); }
      binding.panel.setAction("translate");
      if (autoTranslate) {
        await submit(binding, { action: "translate", question: "", selection: binding.record.selection }, options);
      } else binding.panel.focusTranslate();
    }
    function handleSelection({ reader, doc, params, append }) {
      const text = params.annotation?.text || "";
      if (!text.trim()) { autoTranslator.remove(reader); disposePopup(reader); return; }
      const selection = { text, pageLabel: params.annotation?.pageLabel || "",
        pageIndex: params.annotation?.position?.pageIndex };
      const item = Zotero.Items.get(reader.itemID);
      if (!item?.isAttachment() || item.attachmentContentType !== "application/pdf") {
        autoTranslator.remove(reader); disposePopup(reader); return;
      }
      const record = getRecord(item); record.selection = selection;
      for (const b of bindings.values()) if (b.key === record.key) b.panel.setSelection(selection);
      disposePopup(reader);
      const row = doc.createElementNS(XHTML, "div");
      row.className = "paperlens-selection-actions";
      const key = selectionKey(selection);
      const popup = env.PaperLensPopup.create({ document: doc, container: row, i18n,
        setTimeout: env.setTimeout, clearTimeout: env.clearTimeout,
        onTranslate: () => {
          autoTranslator.cancelPending();
          return openReader(reader, "translate", selection, true,
            { isCurrent: () => popupBindings.get(reader)?.popup === popup && currentReader(reader) }).catch((error) => {
            logError(error);
            if (popupBindings.get(reader)?.popup !== popup) return;
            const display = { selectionKey: key, text: "", status: "", error: i18n.error(error, "host.request_failed"),
              busy: false, complete: false };
            record.popupState = display; updatePopup(record, display, {});
          });
        },
        onCopy: copy,
        onCancel: () => {
          autoTranslator.cancelPending();
          if (activeRun?.record === record && activeRun.selectionKey === key) activeRun.controller.abort();
        },
      });
      popupBindings.set(reader, { reader, key: record.key, selectionKey: key, popup });
      append(row);
      popup.render(record.popupState?.selectionKey === key ? record.popupState
        : { text: "", status: t("ui.empty_answer"), error: "", busy: false, complete: false });
      autoTranslator.observe({ reader, selection, sentinel: row });
    }
    function handleToolbar({ reader, doc, append }) {
      const button = doc.createElementNS(XHTML, "button");
      button.className = "paperlens-toolbar-button"; button.type = "button";
      button.textContent = t("host.toolbar"); button.title = t("host.translate_selection");
      button.style.cssText = "font:inherit;padding:3px 8px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;";
      button.addEventListener("click", () => openReader(reader, "translate").catch((e) => Services.prompt.alert(Zotero.getMainWindow(), "Paper Lens", i18n.error(e, "host.request_failed"))));
      append(button);
    }
    function attachWindow(win) {
      if (!win || windows.has(win)) return;
      win.MozXULElement.insertFTLIfNeeded("paper-lens.ftl");
      const style = win.document.createElementNS(XHTML, "link");
      style.rel = "stylesheet"; style.href = rootURI + "content/style.css";
      style.id = "paperlens-stylesheet"; win.document.documentElement.appendChild(style);
      const menu = win.document.createXULElement("menuitem");
      menu.id = "paperlens-open-menu"; menu.setAttribute("label", "Paper Lens");
      menu.setAttribute("data-l10n-id", "paper-lens-open");
      const open = () => {
        const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
        if (!reader) { Services.prompt.alert(win, "Paper Lens", t("host.open_pdf")); return; }
        openReader(reader, "translate").catch((e) => Services.prompt.alert(win, "Paper Lens", i18n.error(e, "host.request_failed")));
      };
      menu.addEventListener("command", open);
      win.document.getElementById("menu_ToolsPopup")?.appendChild(menu);
      windows.set(win, { style, menu });
    }
    function detachWindow(win) {
      const entry = windows.get(win); entry?.style.remove(); entry?.menu.remove(); windows.delete(win);
      for (const reader of [...popupBindings.keys()]) {
        if ((reader._window || Zotero.getMainWindow()) === win) disposePopup(reader);
      }
      for (const [body, binding] of bindings) if (body.ownerDocument.defaultView === win) {
        if (activeRun?.binding === binding) activeRun.controller.abort();
        binding.panel.dispose(); bindings.delete(body);
      }
    }
    async function startup() {
      const oldModel = Zotero.Prefs.get(PREF + "model", true);
      if (oldModel === LEGACY_MODEL || oldModel === "") setPref("model", DEFAULT_MODEL);
      for (const win of Zotero.getMainWindows()) attachWindow(win);
      paneID = Zotero.ItemPaneManager.registerSection({ paneID: "paperlens", pluginID: id,
        header: { l10nID: "paper-lens-pane", icon: rootURI + "content/icon.svg" },
        sidenav: { l10nID: "paper-lens-sidenav", icon: rootURI + "content/icon.svg" },
        onItemChange: ({ body, tabType, setEnabled }) => setEnabled(tabType === "reader" && !!attachmentForBody(body)),
        onRender: ({ body }) => renderBinding(body),
        onDestroy: ({ body }) => {
          const binding = bindings.get(body);
          if (binding) { binding.record.draft = binding.panel.getDraft();
            if (activeRun?.binding === binding) activeRun.controller.abort();
            binding.panel.dispose(); bindings.delete(body); }
        },
      });
      if (!paneID) throw new Error(t("host.register_failed"));
      preferenceObserver = Zotero.Prefs.registerObserver?.(PREF + "autoTranslateSelection", (value) => {
        if (value !== true) autoTranslator.clear();
      }, true);
      tabObserver = Zotero.Notifier?.registerObserver({ notify(event, type, ids) {
        if (type !== "tab") return;
        autoTranslator.tabsChanged(event, ids);
        for (const reader of [...popupBindings.keys()]) {
          if ((event === "close" && ids.includes(reader.tabID)) || (event === "select" && !currentReader(reader))) disposePopup(reader);
        }
        if (activeRun?.automatic && ((event === "close" && ids.includes(activeRun.reader.tabID))
          || !currentReader(activeRun.reader))) activeRun.controller.abort();
      } }, ["tab"], id);
      Zotero.Reader.registerEventListener("renderTextSelectionPopup", handleSelection, id);
      Zotero.Reader.registerEventListener("renderToolbar", handleToolbar, id);
      await Zotero.PreferencePanes.register({ pluginID: id, id: "paperlens-preferences",
        label: "Paper Lens", src: "content/preferences.xhtml", scripts: ["content/preferences.js"],
        image: rootURI + "content/icon.svg" });
    }
    async function shutdown() {
      stopped = true; autoTranslator.dispose(); activeRun?.controller.abort();
      if (preferenceObserver !== null && preferenceObserver !== undefined) Zotero.Prefs.unregisterObserver?.(preferenceObserver);
      if (tabObserver) Zotero.Notifier?.unregisterObserver(tabObserver);
      Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", handleSelection);
      Zotero.Reader.unregisterEventListener("renderToolbar", handleToolbar);
      if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
      Zotero.PreferencePanes.unregister?.("paperlens-preferences");
      for (const win of [...windows.keys()]) detachWindow(win);
      for (const reader of [...popupBindings.keys()]) disposePopup(reader);
      for (const binding of bindings.values()) binding.panel.dispose();
      bindings.clear(); records.clear(); textCache.clear();
      await backend?.disconnect?.(); backend = null;
      await authProvider?.dispose?.(); authProvider = null;
    }
    return { startup, shutdown, attachWindow, detachWindow, openReader,
      get paneID() { return paneID; }, get panelCount() { return bindings.size; },
      // Small integration-test seam: synthetic paper requests can exercise the backend safely.
      getBackend, getModelOptions, getAuthState, signIn, cancelSignIn, switchAccount, signOut,
      openUsage: () => Zotero.launchURL("https://chatgpt.com/settings/usage"),
      localizeError: (error) => i18n.error(error), version };
  }
  return { create, escapeHTML, paperKey };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensMain;
