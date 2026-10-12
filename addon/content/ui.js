/* Paper Lens's reader UI. No network calls or model-specific logic live here. */
var PaperLensUI = (function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";

  function safeURL(value) {
    const url = String(value || "").trim();
    if (/[\u0000-\u0020\u007f]/.test(url)) return null;
    if (!/^(?:https?:\/\/|zotero:\/\/)/i.test(url)) return null;
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname) return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  // Tokens become text nodes and a small allowlist of elements, never HTML.
  function tokenizeInline(value, depth) {
    const input = String(value || "");
    if ((depth || 0) > 3) return [{ type: "text", text: input }];
    const tokens = [];
    const pattern = /`([^`\n]+)`|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(input))) {
      if (match.index > cursor) tokens.push({ type: "text", text: input.slice(cursor, match.index) });
      if (match[1] !== undefined) tokens.push({ type: "code", text: match[1] });
      else if (match[2] !== undefined) {
        tokens.push({ type: "strong", children: tokenizeInline(match[2], (depth || 0) + 1) });
      } else {
        const href = safeURL(match[4]);
        if (href) tokens.push({ type: "link", text: match[3], href });
        else tokens.push({ type: "text", text: match[0] });
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < input.length) tokens.push({ type: "text", text: input.slice(cursor) });
    return tokens;
  }

  function parseMarkdown(value) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    const isBoundary = (line) => !line.trim() || /^\s*```/.test(line) || /^(#{1,6})\s+/.test(line)
      || /^\s*(?:[-+*]\s+|\d+[.)]\s+|>\s?)/.test(line);
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^\s*```([^\s`]*)\s*$/);
      if (fence) {
        const content = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) content.push(lines[i++]);
        if (i < lines.length) i++;
        blocks.push({ type: "code", language: fence[1], text: content.join("\n") });
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
        i++;
        continue;
      }
      const list = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
      if (list) {
        const ordered = /^\d/.test(list[1]);
        const items = [];
        const start = ordered ? parseInt(list[1], 10) : undefined;
        while (i < lines.length) {
          const next = lines[i].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
          if (!next || /^\d/.test(next[1]) !== ordered) break;
          items.push(next[2]);
          i++;
        }
        blocks.push({ type: "list", ordered, start, items });
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const content = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          content.push(lines[i++].replace(/^\s*>\s?/, ""));
        }
        blocks.push({ type: "quote", text: content.join("\n") });
        continue;
      }
      const content = [line];
      i++;
      while (i < lines.length && !isBoundary(lines[i])) content.push(lines[i++]);
      blocks.push({ type: "paragraph", text: content.join("\n") });
    }
    return blocks;
  }

  function renderMarkdown(document, value, openLink) {
    const fragment = document.createDocumentFragment();
    const element = (tag) => document.createElementNS(XHTML, tag);
    function inline(parent, tokens) {
      for (const token of tokens) {
        if (token.type === "text") parent.appendChild(document.createTextNode(token.text));
        else if (token.type === "strong") {
          const node = element("strong");
          inline(node, token.children);
          parent.appendChild(node);
        } else {
          const node = element(token.type === "code" ? "code" : "a");
          node.textContent = token.text;
          if (token.type === "link") {
            node.setAttribute("href", token.href);
            node.setAttribute("rel", "noopener noreferrer");
            node.setAttribute("target", "_blank");
            // The host opens URLs; a response must never navigate the reader pane.
            node.addEventListener("click", function (event) {
              event.preventDefault();
              if (typeof openLink === "function") openLink(token.href);
            });
          }
          parent.appendChild(node);
        }
      }
    }
    for (const block of parseMarkdown(value)) {
      const tag = block.type === "heading" ? "h" + Math.min(block.level + 1, 6)
        : block.type === "code" ? "pre"
        : block.type === "quote" ? "blockquote"
        : block.type === "list" ? (block.ordered ? "ol" : "ul") : "p";
      const node = element(tag);
      if (block.type === "code") {
        const code = element("code");
        code.textContent = block.text;
        node.appendChild(code);
      } else if (block.type === "list") {
        if (block.ordered && block.start !== 1) node.setAttribute("start", String(block.start));
        for (const item of block.items) {
          const li = element("li");
          inline(li, tokenizeInline(item));
          node.appendChild(li);
        }
      } else inline(node, tokenizeInline(block.text));
      fragment.appendChild(node);
    }
    return fragment;
  }

  function createPanel(options) {
    const document = options.document;
    const container = options.container;
    const callbacks = options.callbacks || {};
    const catalog = typeof PaperLensI18n !== "undefined" ? PaperLensI18n
      : typeof module !== "undefined" && module.exports ? require("./i18n.js") : null;
    const i18n = options.i18n || catalog.create(options.locale || "zh-CN");
    const t = i18n.t;
    const window = document.defaultView;
    const state = {
      paper: null,
      selection: { text: "", pageLabel: "" }, response: "", busy: false,
      submitted: false, disposed: false, renderTimer: null, canSave: true,
    };
    const listeners = [];
    const nodes = {};
    function make(tag, className, text) {
      const node = document.createElementNS(XHTML, tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function listen(node, event, listener) {
      node.addEventListener(event, listener);
      listeners.push([node, event, listener]);
    }
    function add(parent, node) { parent.appendChild(node); return node; }
    function button(parent, label, className, handler) {
      const node = add(parent, make("button", className, label));
      node.type = "button";
      if (handler) listen(node, "click", handler);
      return node;
    }
    function invoke(name, payload) {
      if (state.disposed || typeof callbacks[name] !== "function") return;
      try {
        const result = callbacks[name](payload);
        if (result && typeof result.catch === "function") result.catch(showError);
        return result;
      } catch (error) { showError(error); }
    }
    function setStatus(text, kind) {
      if (state.disposed) return;
      nodes.status.textContent = text || "";
      nodes.status.dataset.kind = kind || "info";
    }
    function showError(error) {
      if (state.disposed) return;
      setStatus(i18n.error(error, "ui.operation_failed"), "error");
    }
    function submit() {
      if (state.busy || !canSubmit()) return;
      state.submitted = true;
      updateControls();
      invoke("onSubmit", {
        action: "translate",
        question: "",
        selection: state.selection.text ? { ...state.selection } : undefined,
      });
    }
    function canSubmit() {
      return !!state.paper && !!state.selection.text.trim();
    }
    function updateControls() {
      nodes.submit.textContent = t(state.busy ? "ui.generating" : "ui.translate_submit");
      nodes.submit.disabled = state.busy || !canSubmit();
      nodes.cancel.hidden = !state.busy;
      nodes.cancel.disabled = !state.busy;
      nodes.retry.disabled = state.busy || !state.paper || !state.submitted;
      nodes.copy.disabled = state.busy || !state.response.trim();
      nodes.save.disabled = state.busy || !state.paper || !state.response.trim() || !state.canSave;
      nodes.answer.setAttribute("aria-busy", String(state.busy));
      nodes.hint.textContent = t(!state.paper ? "ui.open_pdf_hint"
        : !state.selection.text.trim() ? "ui.select_hint" : "ui.translate_hint");
    }
    function renderResponse() {
      state.renderTimer = null;
      if (state.disposed) return;
      const wasAtBottom = nodes.answer.scrollHeight - nodes.answer.scrollTop - nodes.answer.clientHeight < 48;
      while (nodes.answer.firstChild) nodes.answer.removeChild(nodes.answer.firstChild);
      if (state.response) {
        nodes.answer.appendChild(renderMarkdown(document, state.response, (url) => invoke("onOpenLink", url)));
      } else {
        add(nodes.answer, make("p", "paper-lens-empty", t(state.busy ? "ui.reading_context" : "ui.empty_answer")));
      }
      if (wasAtBottom) nodes.answer.scrollTop = nodes.answer.scrollHeight;
    }
    function scheduleRender() {
      if (!state.renderTimer) state.renderTimer = window.setTimeout(renderResponse, 60);
    }
    nodes.root = add(container, make("div", "paper-lens"));
    nodes.root.setAttribute("lang", i18n.locale);
    nodes.header = add(nodes.root, make("div", "paper-lens-header"));
    nodes.title = add(nodes.header, make("div", "paper-lens-paper", t("ui.current_paper")));
    nodes.selectionChip = add(nodes.root, make("div", "paper-lens-selection-chip", t("ui.no_selection")));
    const submitRow = add(nodes.root, make("div", "paper-lens-submit-row"));
    nodes.hint = add(submitRow, make("span", "paper-lens-hint"));
    nodes.cancel = button(submitRow, t("ui.stop"), "paper-lens-button", () => { if (state.busy) invoke("onCancel"); });
    nodes.submit = button(submitRow, t("ui.translate_submit"), "paper-lens-button paper-lens-primary", submit);
    nodes.status = add(nodes.root, make("div", "paper-lens-status"));
    nodes.status.setAttribute("role", "status");
    nodes.status.setAttribute("aria-live", "polite");
    nodes.answer = add(nodes.root, make("div", "paper-lens-answer"));
    nodes.answer.tabIndex = 0;
    nodes.answer.setAttribute("aria-label", t("ui.answer_aria"));
    const resultTools = add(nodes.root, make("div", "paper-lens-result-tools"));
    nodes.retry = button(resultTools, t("ui.retry"), "paper-lens-button", () => {
      if (!state.busy && state.paper && state.submitted) invoke("onRetry");
    });
    nodes.copy = button(resultTools, t("ui.copy"), "paper-lens-button", () => {
      if (!state.busy && state.response.trim()) invoke("onCopy", state.response);
    });
    nodes.save = button(resultTools, t("ui.save_note"), "paper-lens-button", () => {
      if (!state.busy && state.paper && state.response.trim() && state.canSave) invoke("onSave", { text: state.response });
    });
    nodes.context = add(nodes.root, make("details", "paper-lens-context"));
    add(nodes.context, make("summary", "", t("ui.context")));
    nodes.coverage = add(nodes.context, make("p", "paper-lens-coverage", t("ui.coverage_pending")));
    nodes.sourceLabel = add(nodes.context, make("div", "paper-lens-source-label", t("ui.source")));
    nodes.source = add(nodes.context, make("blockquote", "paper-lens-source", t("ui.source_empty")));
    renderResponse();
    updateControls();

    return {
      setPaper(paper) {
        if (state.disposed) return;
        state.paper = paper && paper.attachmentKey ? { ...paper } : paper && paper.title ? { ...paper } : null;
        nodes.title.textContent = state.paper && state.paper.title || t("ui.current_paper");
        nodes.title.title = nodes.title.textContent;
        updateControls();
      },
      setSelection(selection) {
        if (state.disposed) return;
        state.selection = { text: String(selection && selection.text || ""), pageLabel: String(selection && selection.pageLabel || "") };
        const count = Array.from(state.selection.text).length;
        const page = state.selection.pageLabel ? " · " + t("ui.page", { page: state.selection.pageLabel }) : "";
        nodes.selectionChip.textContent = count ? t("ui.selection_count", { count }) + page : t("ui.no_selection");
        nodes.selectionChip.dataset.selected = String(!!count);
        nodes.source.textContent = state.selection.text || t("ui.source_empty");
        nodes.sourceLabel.textContent = t("ui.source") + page;
        updateControls();
      },
      setCanSave(value) { state.canSave = !!value; updateControls(); },
      setStatus,
      showError,
      setBusy(busy) {
        if (state.disposed) return;
        state.busy = !!busy;
        if (busy) state.submitted = true;
        updateControls();
        if (!state.response) renderResponse();
      },
      setResponse(text) {
        if (state.disposed) return;
        state.response = String(text || "");
        if (state.renderTimer) { window.clearTimeout(state.renderTimer); state.renderTimer = null; }
        renderResponse();
        updateControls();
      },
      appendResponse(delta) {
        if (state.disposed) return;
        state.response += String(delta || "");
        scheduleRender();
        updateControls();
      },
      setCoverage(label) {
        if (!state.disposed) nodes.coverage.textContent = label || t("ui.coverage_pending");
      },
      setAction() { if (!state.disposed) updateControls(); },
      getAction() { return "translate"; },
      getResponse() { return state.response; },
      getDraft() { return { action: "translate", question: "" }; },
      // Ignore old question/explanation drafts when restoring a reader panel.
      setDraft() { if (!state.disposed) updateControls(); },
      focusTranslate() { if (!state.disposed) nodes.submit.focus(); },
      focusQuestion() { if (!state.disposed) nodes.submit.focus(); },
      dispose() {
        if (state.disposed) return;
        state.disposed = true;
        if (state.renderTimer) window.clearTimeout(state.renderTimer);
        for (const [node, event, listener] of listeners) node.removeEventListener(event, listener);
        if (nodes.root.parentNode) nodes.root.parentNode.removeChild(nodes.root);
      },
    };
  }

  return { createPanel, renderMarkdown, parseMarkdown, tokenizeInline, safeURL };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PaperLensUI;
