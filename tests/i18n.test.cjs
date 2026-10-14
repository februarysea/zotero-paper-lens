const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const I18n = require("../addon/content/i18n.js");

test("Chinese locale variants select Chinese; all other locales fall back to English", () => {
  for (const locale of ["zh", "zh-CN", "zh-TW", "zh_Hans", "ZH-hk"]) {
    const i18n = I18n.create(locale);
    assert.equal(i18n.locale, "zh-CN");
    assert.equal(i18n.t("ui.translate"), "翻译");
    assert.equal(i18n.t("host.name"), "Paper Lens");
  }
  for (const locale of ["en", "en-GB", "de-DE", "fr", undefined, "zhish"]) {
    const i18n = I18n.create(locale);
    assert.equal(i18n.locale, "en");
    assert.equal(i18n.t("ui.translate"), "Translate");
    assert.equal(i18n.t("host.name"), "Paper Lens");
  }
});

test("native browser globals and CommonJS expose the same locale API", () => {
  const scope = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../addon/content/i18n.js"), "utf8"), scope);
  assert.equal(scope.PaperLensI18n.create("en").t("host.tagline"), "Read papers with Codex models");
  assert.equal(I18n.create("zh").t("host.tagline"), "用 Codex 模型辅助阅读");
});

test("parameterized labels retain Unicode and do not execute or interpret parameter text", () => {
  const en = I18n.create("en");
  assert.equal(en.t("ui.selection_count", { count: 0 }), "0 characters selected");
  assert.equal(en.t("host.page", { page: "iv" }), "Page iv");
  assert.equal(en.t("host.page", { page: "${secret}<script>" }), "Page ${secret}<script>");
  assert.equal(I18n.create("zh-TW").t("ui.page", { page: "附录二" }), "第 附录二 页");
});

test("every visible native backend and context error code has a translation in both languages", () => {
  const sources = ["auth", "oauth", "loopback", "settings", "codex", "context"].map((name) => fs.readFileSync(path.join(__dirname, "../addon/content/" + name + ".js"), "utf8"));
  const codes = new Set(sources.flatMap((source) => Array.from(source.matchAll(/(?:authError|failure|fail)\("([A-Z_]+)"/g), (match) => match[1])));
  // HTTP status and streamed response errors choose their codes dynamically.
  for (const code of ["LOGIN_EXPIRED", "ACCESS_DENIED", "MODEL_UNAVAILABLE", "RATE_LIMIT", "HTTP_ERROR", "RESPONSE_FAILED"]) codes.add(code);
  for (const code of ["AUTH_FILE_INVALID", "LOGIN_EXPIRED", "EMPTY_SELECTION", "UNTRUSTED_ENDPOINT"]) {
    assert.ok(codes.has(code), "source scan missed " + code);
  }
  for (const locale of ["zh-CN", "en"]) {
    const i18n = I18n.create(locale);
    for (const code of codes) {
      const key = "error." + code;
      assert.notEqual(i18n.t(key), key, locale + " lacks " + code);
      assert.equal(i18n.error({ code, message: "untrusted secret" }), i18n.t(key));
    }
  }
});

test("known errors and HTTP status remain useful while unknown exception content stays hidden", () => {
  const en = I18n.create("en");
  assert.equal(en.error({ code: "AUTH_REFRESH_FAILED", message: "刷新登录失败（HTTP 401）。access_token=secret" }),
    "Could not refresh sign-in credentials. Sign in again and retry. (HTTP 401)");
  assert.equal(en.error({ code: "RATE_LIMIT", status: 429, message: "secret" }),
    "Your ChatGPT usage or request limit has been reached. Please retry later. (HTTP 429)");
  const localized = en.error({ code: "HTTP_ERROR", status: 503 });
  assert.equal(en.error(localized), localized, "host and panel can both localize the same safe error without losing its HTTP status");
  assert.equal(en.error({ status: 999, message: "secret" }, "host.save_failed"), "Could not save the note.");
  assert.equal(en.error({ status: "401 secret", message: "secret" }), "Something went wrong. Please retry.");
  assert.equal(en.error(new Error("credential secret /private/path"), "host.request_failed"), "Request failed. Please retry.");
  assert.equal(en.error("当前文库不可编辑。", "host.save_failed"), "This library is read-only.");
  assert.equal(I18n.create("zh").error({ code: "EMPTY_SELECTION" }), "请先在当前 PDF 中选择要翻译的文字。");
});

test("cache and retranslation messages are localized without exposing cache exception content", () => {
  for (const locale of ["zh-CN", "en"]) {
    const i18n = I18n.create(locale);
    for (const key of ["ui.retranslate", "host.cached", "host.cache_save_failed", "error.CACHE_CLEAR_FAILED"]) {
      assert.notEqual(i18n.t(key), key);
    }
    assert.equal(i18n.error({ code: "CACHE_CLEAR_FAILED", message: "private-file/credential-secret" }), i18n.t("error.CACHE_CLEAR_FAILED"));
    assert.doesNotMatch(i18n.error({ code: "CACHE_CLEAR_FAILED", message: "credential-secret" }), /credential-secret/);
  }
});
