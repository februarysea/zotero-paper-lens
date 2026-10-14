var paperLensScope;
var paperLensChrome;

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const win = Zotero.getMainWindow();
  const cu = win.ChromeUtils;
  const services = win.Services;
  paperLensChrome = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup)
    .registerChrome(services.io.newURI(rootURI + "manifest.json"), [
      ["content", "paper-lens", "content/"],
    ]);
  paperLensScope = {
    Zotero, Services: services, ChromeUtils: cu, Cc, Ci, Components,
    IOUtils: win.IOUtils, PathUtils: win.PathUtils,
    MutationObserver: win.MutationObserver, AbortController: win.AbortController, URL: win.URL,
    fetch: win.fetch.bind(win), atob: win.atob.bind(win), btoa: win.btoa.bind(win),
    crypto: win.crypto, URLSearchParams: win.URLSearchParams,
    TextDecoder: win.TextDecoder, TextEncoder: win.TextEncoder,
    setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win),
  };
  for (const file of ["i18n.js", "oauth.js", "loopback.js", "auth.js", "settings.js", "context.js", "cache.js", "codex.js", "ui.js", "popup.js", "selection.js", "main.js"]) {
    services.scriptloader.loadSubScript(rootURI + "content/" + file, paperLensScope, "UTF-8");
  }
  Zotero.PaperLens = paperLensScope.PaperLensMain.create({ id, version, rootURI, env: paperLensScope });
  await Zotero.PaperLens.startup();
}

function onMainWindowLoad({ window }) { Zotero.PaperLens?.attachWindow(window); }
function onMainWindowUnload({ window }) { Zotero.PaperLens?.detachWindow(window); }

async function shutdown() {
  await Zotero.PaperLens?.shutdown();
  delete Zotero.PaperLens;
  paperLensScope = null;
  paperLensChrome?.destruct();
  paperLensChrome = null;
}

function install() {}
function uninstall() {}
