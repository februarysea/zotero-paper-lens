/* The model picker uses the selected ChatGPT account's public catalog. */
var PaperLensSettings = (function () {
  "use strict";
  const OAuth = typeof PaperLensOAuth !== "undefined" ? PaperLensOAuth : require("./oauth.js");
  const FALLBACK_MODEL = "gpt-6-luna";
  const ENDPOINT = "https://api.openai.com/v1/models";
  const validModel = value => typeof value === "string" && value !== "codex-default" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
  function defaultChoice(available) { return { id: FALLBACK_MODEL, model: FALLBACK_MODEL, displayName: FALLBACK_MODEL, available }; }
  function parseModelCatalog(data) {
    if (!data || !Array.isArray(data.models) || data.models.length > 2000) throw OAuth.authError("MODEL_CATALOG_INVALID");
    const seen = new Set(), models = [];
    for (const item of data.models) {
      if (!item || item.visibility !== "list" || !validModel(item.slug) || seen.has(item.slug)) continue;
      seen.add(item.slug);
      models.push({ id: item.slug, model: item.slug, displayName: item.slug, available: true });
    }
    if (!models.length) throw OAuth.authError("MODEL_CATALOG_INVALID");
    return models;
  }
  function createSettingsReader({ authProvider, fetchImpl, timeoutMs = 20000 }) {
    return { async read() {
      let accountKey, models = [], warnings = [], connected = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const credentials = await OAuth.abortable(authProvider.getCredentials(), controller.signal);
        accountKey = credentials.accountKey; connected = true;
        const response = await OAuth.abortable(fetchImpl(ENDPOINT, { credentials: "omit", redirect: "error",
          headers: { Authorization: "Bearer " + credentials.accessToken, Accept: "application/json" }, signal: controller.signal }), controller.signal);
        if (!response.ok) throw OAuth.authError("MODEL_CATALOG_UNAVAILABLE", response.status);
        models = parseModelCatalog(await OAuth.readJSON(response, { signal: controller.signal }));
        const state = await authProvider.getState();
        if (state.activeID !== accountKey || !state.planEnabled) throw OAuth.authError("AUTH_ACCOUNT_CHANGED");
        const luna = models.find(x => x.model === FALLBACK_MODEL) || defaultChoice(false);
        return { defaultModel: FALLBACK_MODEL, models: [luna, ...models.filter(x => x.model !== FALLBACK_MODEL)],
          source: "account", accountKey, connected, warnings };
      } catch (error) {
        // No stale catalog is kept across account changes and no exception contents leave this module.
        const known = ["AUTH_MISSING", "AUTH_PLAN_DISABLED", "AUTH_EXPIRED", "AUTH_ACCOUNT_CHANGED"];
        warnings = [known.includes(error.code) ? error.code : "MODEL_CATALOG_UNAVAILABLE"];
        return { defaultModel: FALLBACK_MODEL, models: [defaultChoice(undefined)], source: "fallback", connected: false, warnings };
      } finally { clearTimeout(timer); }
    } };
  }
  return { createSettingsReader, parseModelCatalog, FALLBACK_MODEL, ENDPOINT };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensSettings;
