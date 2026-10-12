/* Selection popups can rerender and disappear without an empty-selection event. */
var PaperLensSelection = (function () {
  "use strict";
  function create({ isEnabled, isCurrent, isSelecting, translate, onSupersede,
    cancelAutomatic, onError, setTimeout, clearTimeout, MutationObserver }) {
    const entries = new Map();
    let pending = null, stopped = false;
    function valid(entry) {
      return !stopped && pending === entry && isEnabled() && isCurrent(entry.reader)
        && entry.reader.itemID === entry.itemID
        && entries.get(entry.reader) === entry && entry.sentinel.isConnected;
    }
    function cancelPending() {
      if (pending?.timer !== null && pending?.timer !== undefined) clearTimeout(pending.timer);
      pending = null;
    }
    function remove(reader) {
      const entry = entries.get(reader);
      if (!entry) return;
      if (pending === entry) cancelPending();
      entry.observer?.disconnect(); entries.delete(reader);
    }
    function clear() {
      cancelPending();
      for (const reader of [...entries.keys()]) remove(reader);
      cancelAutomatic();
    }
    async function dispatch(entry) {
      entry.timer = null;
      if (!valid(entry)) { if (pending === entry) cancelPending(); return; }
      // Zotero 9 can show a double-click selection popup before the drag ends.
      if (isSelecting?.(entry.reader)) {
        entry.timer = setTimeout(() => dispatch(entry), 100); return;
      }
      try {
        await translate({ reader: entry.reader, selection: { ...entry.selection },
          isCurrent: () => valid(entry) });
      } catch (error) {
        if (valid(entry)) onError(error, entry.reader);
      } finally {
        if (pending === entry) pending = null;
      }
    }
    function observe({ reader, selection, sentinel }) {
      if (stopped) return;
      if (!isEnabled()) { clear(); return; }
      if (!selection.text?.trim() || !isCurrent(reader)) { remove(reader); return; }
      const signature = JSON.stringify([reader.itemID, selection.text,
        selection.pageIndex ?? null, selection.pageLabel || ""]);
      const prior = entries.get(reader);
      if (prior?.signature === signature) {
        // React can replace the appended row while keeping the same selection.
        prior.sentinel = sentinel; return;
      }
      remove(reader); cancelPending(); onSupersede();
      const entry = { reader, itemID: reader.itemID, selection: { ...selection }, sentinel, signature,
        timer: null, observer: null };
      entries.set(reader, entry); pending = entry;
      const root = sentinel.ownerDocument?.documentElement;
      if (MutationObserver && root) {
        entry.observer = new MutationObserver(() => {
          if (entries.get(reader) === entry && !entry.sentinel.isConnected) remove(reader);
        });
        entry.observer.observe(root, { childList: true, subtree: true });
      }
      entry.timer = setTimeout(() => dispatch(entry), 350);
    }
    function tabsChanged(event, ids) {
      if (event === "close") {
        for (const reader of [...entries.keys()]) if (ids.includes(reader.tabID)) remove(reader);
      } else if (event === "select") {
        for (const reader of [...entries.keys()]) if (!isCurrent(reader)) remove(reader);
      }
    }
    function dispose() { stopped = true; clear(); }
    return { observe, cancelPending, clear, remove, tabsChanged, dispose };
  }
  return { create };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensSelection;
