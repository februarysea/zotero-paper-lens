/* A translation view embedded in Zotero's existing selection popup. */
var PaperLensPopup = (function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const FRAME_MS = 60;

  function create(options) {
    const document = options.document;
    const container = options.container;
    const catalog = typeof PaperLensI18n !== "undefined" ? PaperLensI18n
      : typeof module !== "undefined" && module.exports ? require("./i18n.js") : null;
    const i18n = options.i18n || catalog.create(options.locale || "zh-CN");
    const t = i18n.t;
    const window = document.defaultView;
    const schedule = options.setTimeout || ((callback, delay) => window.setTimeout(callback, delay));
    const unschedule = options.clearTimeout || ((timer) => window.clearTimeout(timer));
    const state = { text: "", status: "", error: null, busy: false, complete: false };
    const listeners = [];
    let disposed = false;
    let timer = null;
    let initialTimer = null;
    let layoutTimer = null;
    let initializing = true;
    let mounted = false;
    let host = null;
    let hostParent = null;
    let resizeObserver = null;
    const ownStyles = new Map();

    function make(tag, className, css, text) {
      const node = document.createElementNS(XHTML, tag);
      node.className = className;
      if (css) node.setAttribute("style", css);
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function add(parent, node) { parent.appendChild(node); return node; }
    const root = add(container, make("div", "paper-lens-selection-translation",
      "box-sizing:border-box;width:100%;max-width:340px;min-width:0;padding:8px;margin-top:4px;"
      + "font:inherit;color:inherit;background:transparent;text-align:start;"));
    root.setAttribute("lang", i18n.locale);
    const toolbar = add(root, make("div", "paper-lens-popup-toolbar",
      "display:flex;align-items:center;gap:6px;flex-wrap:wrap;"));

    function live() {
      if (disposed) return false;
      if (root.isConnected !== false) { mounted = true; return true; }
      // Zotero appends custom nodes after the synchronous render callback ends.
      return initializing && !mounted;
    }
    function clearTimer() {
      if (timer !== null) unschedule(timer);
      timer = null;
    }
    function invoke(name, payload) {
      if (!live() || typeof options[name] !== "function") return;
      try {
        const result = options[name](payload);
        if (result && typeof result.catch === "function") result.catch((error) => render({ error, busy: false, complete: false }));
      } catch (error) { render({ error, busy: false, complete: false }); }
    }
    function button(className, label, handler) {
      const node = add(toolbar, make("button", className,
        "font:inherit;color:inherit;background:transparent;border:1px solid #8886;"
        + "border-radius:4px;padding:3px 7px;cursor:pointer;", label));
      node.type = "button";
      node.addEventListener("click", handler);
      listeners.push([node, "click", handler]);
      return node;
    }
    const translate = button("paper-lens-popup-translate", t("host.translate"), () => {
      if (!state.busy) invoke("onTranslate");
    });
    const stop = button("paper-lens-popup-stop", t("ui.stop"), () => {
      if (state.busy) invoke("onCancel");
    });
    const copy = button("paper-lens-popup-copy", t("ui.copy"), () => {
      if (!state.busy && state.complete && state.text.trim()) invoke("onCopy", state.text);
    });
    const status = add(root, make("div", "paper-lens-popup-status",
      "font-size:0.9em;line-height:1.4;margin-top:5px;overflow-wrap:anywhere;"));
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const answer = add(root, make("div", "paper-lens-popup-answer",
      "box-sizing:border-box;max-height:200px;overflow:auto;white-space:pre-wrap;"
      + "overflow-wrap:anywhere;line-height:1.5;margin-top:6px;user-select:text;"));
    answer.tabIndex = 0;
    answer.setAttribute("aria-label", t("ui.answer_aria"));

    function setHostStyle(property, value) {
      if (!host?.style || host.style.getPropertyValue(property) === value) return;
      if (!ownStyles.has(property)) ownStyles.set(property, {
        original: host.style.getPropertyValue(property), priority: host.style.getPropertyPriority(property), applied: "",
      });
      else if (host.style.getPropertyValue(property) !== ownStyles.get(property).applied) {
        ownStyles.get(property).original = host.style.getPropertyValue(property);
        ownStyles.get(property).priority = host.style.getPropertyPriority(property);
      }
      host.style.setProperty(property, value);
      ownStyles.get(property).applied = host.style.getPropertyValue(property);
    }
    function restoreHost() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      for (const [property, saved] of ownStyles) {
        // React owns this element: retain any newer positioning it supplied.
        if (host?.style?.getPropertyValue(property) !== saved.applied) continue;
        if (saved.original) host.style.setProperty(property, saved.original, saved.priority);
        else host.style.removeProperty(property);
      }
      ownStyles.clear();
      host = hostParent = null;
    }
    function scheduleLayout() {
      if (!live() || layoutTimer !== null) return;
      layoutTimer = schedule(() => { layoutTimer = null; fitPopup(); }, 0);
    }
    function fitPopup() {
      if (!live() || root.isConnected === false || typeof root.closest !== "function") return;
      const nextHost = root.closest(".selection-popup");
      if (!nextHost?.parentNode?.getBoundingClientRect || !nextHost.getBoundingClientRect) return;
      if (host !== nextHost || hostParent !== nextHost.parentNode) {
        restoreHost();
        host = nextHost;
        hostParent = host.parentNode;
        if (typeof window?.ResizeObserver === "function") {
          resizeObserver = new window.ResizeObserver(scheduleLayout);
          resizeObserver.observe(host);
          resizeObserver.observe(hostParent);
        }
      }
      const parentRect = hostParent.getBoundingClientRect();
      if (!Number.isFinite(parentRect.width) || parentRect.width <= 0) return;
      const width = Math.max(40, Math.min(340, parentRect.width - 40));
      setHostStyle("box-sizing", "border-box");
      setHostStyle("width", width + "px");
      setHostStyle("max-width", width + "px");
      if (answer.style && Number.isFinite(parentRect.height)) {
        const height = Math.max(60, Math.min(200, parentRect.height * 0.35));
        if (answer.style.maxHeight !== height + "px") answer.style.maxHeight = height + "px";
      }
      const rect = host.getBoundingClientRect();
      const right = parentRect.right ?? parentRect.left + parentRect.width;
      const bottom = parentRect.bottom ?? parentRect.top + parentRect.height;
      const leftEdge = Math.max(parentRect.left + 20, 0);
      const topEdge = Math.max(parentRect.top + 20, 0);
      const rightEdge = Math.min(right - 20, Number.isFinite(window?.innerWidth) ? window.innerWidth - 20 : right - 20);
      const bottomEdge = Math.min(bottom - 20, Number.isFinite(window?.innerHeight) ? window.innerHeight - 20 : bottom - 20);
      const dx = Math.max(leftEdge, Math.min(rect.left, rightEdge - rect.width)) - rect.left;
      const dy = Math.max(topEdge, Math.min(rect.top, bottomEdge - rect.height)) - rect.top;
      if (!dx && !dy) return;
      let x = null, y = null;
      const transform = window?.getComputedStyle?.(host)?.transform || host.style?.getPropertyValue("transform") || "none";
      try {
        if (typeof window?.DOMMatrix === "function") {
          const matrix = new window.DOMMatrix(transform === "none" ? undefined : transform);
          x = matrix.m41; y = matrix.m42;
        }
      } catch (_) { /* Use the host's ordinary translate syntax below. */ }
      if (x === null || y === null) {
        const translate = /^translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)$/.exec(transform);
        const matrix = /^matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*(-?[\d.]+),\s*(-?[\d.]+)\)$/.exec(transform);
        const pair = translate || matrix;
        if (pair) { x = Number(pair[1]); y = Number(pair[2]); }
        else if (transform === "none") { x = 0; y = 0; }
      }
      if (Number.isFinite(x) && Number.isFinite(y)) setHostStyle("transform", "translate(" + (x + dx) + "px, " + (y + dy) + "px)");
    }

    function flush() {
      timer = null;
      if (!live()) return;
      const atBottom = answer.scrollHeight - answer.scrollTop - answer.clientHeight < 32;
      // Model output is always plain text, never markup or executable content.
      answer.textContent = state.text;
      answer.hidden = !state.text;
      answer.setAttribute("aria-busy", String(state.busy));
      if (atBottom) answer.scrollTop = answer.scrollHeight;
      const message = state.error ? i18n.error(state.error, "host.request_failed")
        : state.status || (state.busy ? t("host.answering") : state.complete ? t("host.complete") : "");
      status.textContent = message;
      status.hidden = !message;
      status.setAttribute("data-kind", state.error ? "error" : state.complete ? "success" : "info");
      translate.disabled = state.busy;
      stop.hidden = !state.busy;
      stop.disabled = !state.busy;
      copy.hidden = !state.text;
      copy.disabled = state.busy || !state.complete || !state.text.trim();
      fitPopup();
    }

    function render(patch = {}) {
      if (!live()) return;
      const wasBusy = state.busy;
      for (const key of ["text", "status"]) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) state[key] = String(patch[key] || "");
      }
      for (const key of ["busy", "complete"]) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) state[key] = !!patch[key];
      }
      if (Object.prototype.hasOwnProperty.call(patch, "error")) state.error = patch.error || null;
      if (state.busy) state.complete = false;
      if (!state.busy || state.busy !== wasBusy || state.complete || state.error) {
        clearTimer();
        flush();
      } else if (timer === null) timer = schedule(flush, FRAME_MS);
    }

    flush();
    initialTimer = schedule(() => {
      initialTimer = null;
      initializing = false;
      if (live()) flush();
    }, 0);
    return {
      root,
      render,
      dispose() {
        if (disposed) return;
        disposed = true;
        clearTimer();
        if (initialTimer !== null) unschedule(initialTimer);
        if (layoutTimer !== null) unschedule(layoutTimer);
        initialTimer = layoutTimer = null;
        restoreHost();
        for (const [node, event, listener] of listeners) node.removeEventListener(event, listener);
        listeners.length = 0;
        if (root.parentNode) root.parentNode.removeChild(root);
      },
    };
  }

  return { create };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PaperLensPopup;
