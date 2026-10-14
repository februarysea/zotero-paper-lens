/* Native settings own the model preference; credentials remain in the plugin's protected store. */
var PaperLensPreferences = (function () {
  "use strict";
  const XHTML = "http://www.w3.org/1999/xhtml", LUNA = "gpt-6-luna", NEW_ACCOUNT = "__new__";
  const validModel = value => typeof value === "string" && value !== "codex-default" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
  function create({ document, Zotero }) {
    let root, model, refreshButton, modelStatus, account, authStatus, signIn, signOut, cancel, usage, cacheClear, cacheStatus;
    let sequence = 0, authSequence = 0, disposed = false, initialized = false, busy = false, actionKind = null;
    let choosingNew = false;
    let cacheBusy = false;
    let authState = { accounts: [], connected: false, planEnabled: false };
    const listeners = [];
    function listen(target, name, callback) {
      target.addEventListener(name, callback); listeners.push([target, name, callback]);
    }
    function live(expected = sequence) {
      return !disposed && root?.isConnected && expected === sequence && document.getElementById("paperlens-preferences") === root;
    }
    function localize(node, id, args) {
      if (!live()) return;
      if (document.l10n?.setAttributes) document.l10n.setAttributes(node, id, args);
      else node.setAttribute("data-l10n-id", id);
    }
    function safeError(node, error) {
      if (!live()) return;
      node.removeAttribute("data-l10n-id"); node.removeAttribute("data-l10n-args");
      node.textContent = Zotero.PaperLens.localizeError(error);
    }
    function currentModel() {
      let value; try { value = Zotero.Prefs.get("extensions.paperlens.model", true); } catch (_) {}
      return validModel(value) ? value : LUNA;
    }
    function addOption(select, value, label) {
      const option = document.createElementNS(XHTML, "option"); option.value = value; option.textContent = label;
      select.appendChild(option); return option;
    }
    function syncModel() {
      if (!live()) return;
      const selected = currentModel();
      if (!Array.from(model.options).some(x => x.value === selected)) addOption(model, selected, selected);
      model.value = selected;
    }
    function fillModels(items) {
      const values = new Set([LUNA]);
      for (const item of Array.isArray(items) ? items : []) {
        const value = typeof item === "string" ? item : item?.model || item?.id;
        if (validModel(value)) values.add(value);
      }
      while (model.firstChild) model.removeChild(model.firstChild);
      for (const value of values) addOption(model, value, value);
      syncModel();
    }
    function controls() {
      if (!live()) return;
      const signingIn = !!authState.signingIn || (busy && actionKind === "sign-in");
      account.disabled = busy || signingIn; signIn.disabled = busy || signingIn;
      signOut.disabled = busy || signingIn || !authState.connected || account.value === NEW_ACCOUNT;
      cancel.hidden = !signingIn;
      refreshButton.disabled = busy;
    }
    async function readAuth({ preserveNewSelection = false } = {}) {
      const request = ++authSequence;
      let state;
      try { state = await Zotero.PaperLens.getAuthState(); }
      catch (error) {
        if (!live() || request !== authSequence || busy) return false;
        throw error;
      }
      if (!live() || request !== authSequence || busy) return false;
      authState = state;
      if (!preserveNewSelection) choosingNew = false;
      while (account.firstChild) account.removeChild(account.firstChild);
      for (const item of state.accounts) {
        const option = addOption(account, item.id, item.label);
        if (item.id === state.activeID && state.connected) {
          localize(option, "paper-lens-preferences-account-current", { account: item.label });
        }
      }
      addOption(account, NEW_ACCOUNT, "");
      const newOption = account.options[account.options.length - 1];
      localize(newOption, state.accounts.length ? "paper-lens-preferences-account-new" : "paper-lens-preferences-account-connect");
      account.value = preserveNewSelection && choosingNew && state.accounts.length
        ? NEW_ACCOUNT : state.activeID || (state.accounts[0]?.id || NEW_ACCOUNT);
      const active = state.accounts.find(x => x.id === state.activeID);
      localize(authStatus, state.signingIn ? "paper-lens-preferences-auth-connecting"
        : account.value === NEW_ACCOUNT && state.accounts.length ? "paper-lens-preferences-auth-new"
        : state.connected ? (state.planEnabled ? "paper-lens-preferences-auth-connected" : "paper-lens-preferences-auth-plan-disabled")
        : "paper-lens-preferences-auth-disconnected", { account: active?.label || "" });
      controls();
      return true;
    }
    async function syncAuth(withModels = false) {
      if (busy || !live()) return;
      try {
        const updated = await readAuth({ preserveNewSelection: true });
        if (updated && withModels && !busy && live()) await refresh();
      } catch (error) { if (!busy) safeError(authStatus, error); }
    }
    async function refresh() {
      if (!live()) return;
      const request = ++sequence; refreshButton.disabled = true;
      localize(modelStatus, "paper-lens-preferences-model-loading");
      try {
        const result = await Zotero.PaperLens.getModelOptions();
        if (!live(request)) return;
        fillModels(result?.models);
        const missingAuth = result?.warnings?.some(x => ["AUTH_MISSING", "AUTH_PLAN_DISABLED", "AUTH_EXPIRED"].includes(x));
        localize(modelStatus, missingAuth ? "paper-lens-preferences-model-login"
          : result?.warnings?.length ? "paper-lens-preferences-model-fallback"
          : result?.selectedAvailable === false ? "paper-lens-preferences-model-unavailable" : "paper-lens-preferences-model-loaded");
      } catch (_) {
        if (!live(request)) return;
        fillModels([]); localize(modelStatus, "paper-lens-preferences-model-fallback");
      } finally { if (live(request)) refreshButton.disabled = busy; }
    }
    async function action(kind) {
      if (busy || !live()) return;
      busy = true; actionKind = kind; ++sequence; ++authSequence; controls();
      localize(authStatus, kind === "sign-in" ? "paper-lens-preferences-auth-connecting" : "paper-lens-preferences-auth-working");
      let error = null, result;
      try {
        if (kind === "sign-in") result = await Zotero.PaperLens.signIn(account.value === NEW_ACCOUNT ? null : account.value);
        else if (kind === "sign-out") result = await Zotero.PaperLens.signOut();
        else result = await Zotero.PaperLens.switchAccount(account.value);
      } catch (caught) { error = caught; }
      finally {
        busy = false; actionKind = null;
        if (live()) {
          try { await readAuth(); await refresh(); } catch (caught) { error ||= caught; }
          if (error) safeError(authStatus, error);
          else if (kind === "sign-out" && result?.remoteRevoked === false) localize(authStatus, "paper-lens-preferences-auth-revoke-unconfirmed");
          controls();
        }
      }
    }
    async function clearCache() {
      if (cacheBusy || !live()) return;
      cacheBusy = true; cacheClear.disabled = true;
      localize(cacheStatus, "paper-lens-preferences-cache-clearing");
      try {
        await Zotero.PaperLens.clearTranslationCache();
        localize(cacheStatus, "paper-lens-preferences-cache-cleared");
      } catch (_) {
        localize(cacheStatus, "paper-lens-preferences-cache-clear-failed");
      } finally {
        cacheBusy = false;
        if (live()) cacheClear.disabled = false;
      }
    }
    async function init(event) {
      if (initialized || disposed) return;
      root = document.getElementById("paperlens-preferences");
      const find = id => document.getElementById("paperlens-" + id);
      model = find("model"); refreshButton = find("model-refresh"); modelStatus = find("model-status");
      account = find("account"); authStatus = find("auth-status"); signIn = find("sign-in"); signOut = find("sign-out");
      cancel = find("auth-cancel"); usage = find("usage");
      cacheClear = find("cache-clear"); cacheStatus = find("cache-status");
      if (![root, model, refreshButton, modelStatus, account, authStatus, signIn, signOut, cancel, usage, cacheClear, cacheStatus].every(Boolean)) return;
      initialized = true;
      listen(refreshButton, "click", () => syncAuth(true));
      listen(model, "syncfrompreference", syncModel);
      listen(signIn, "click", () => action("sign-in"));
      listen(signOut, "click", () => action("sign-out"));
      listen(cancel, "click", () => {
        Zotero.PaperLens.cancelSignIn();
        if (!busy) return syncAuth();
      });
      listen(usage, "click", () => Zotero.PaperLens.openUsage());
      listen(cacheClear, "click", clearCache);
      listen(account, "change", () => {
        choosingNew = account.value === NEW_ACCOUNT;
        if (choosingNew) { localize(authStatus, "paper-lens-preferences-auth-new"); controls(); return; }
        return action("switch");
      });
      listen(document.defaultView, "focus", () => syncAuth());
      listen(document.defaultView, "unload", dispose);
      syncModel();
      const ready = (async () => { try { await readAuth(); await refresh(); } catch (error) { safeError(authStatus, error); controls(); } })();
      event?.waitUntil?.(ready);
      return ready;
    }
    function dispose() {
      disposed = true; ++sequence; ++authSequence;
      for (const [target, name, callback] of listeners) target.removeEventListener(name, callback);
      listeners.length = 0;
    }
    return { init, refresh, dispose };
  }
  let controller;
  function init(event) { controller ||= create({ document, Zotero }); return controller.init(event); }
  return { create, init };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensPreferences;
