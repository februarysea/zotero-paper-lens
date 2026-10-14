/* Completed translations are cached locally; only a digest identifies their context. */
var PaperLensCache = (function () {
  "use strict";
  const VERSION = 1, MAX_ENTRIES = 1000, MAX_BYTES = 10 * 1024 * 1024;
  const MAX_ORIGINAL_CHARS = 100000, MAX_TEXT_CHARS = 1024 * 1024, MAX_KEY_CHARS = 1024 * 1024;
  const validKey = key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key);
  const missing = error => error && ["NotFoundError", "NS_ERROR_FILE_NOT_FOUND", "ENOENT"].includes(error.name || error.code)
    || error?.code === "ENOENT";
  function invalid() { return Object.assign(new Error("CACHE_KEY_INVALID"), { code: "CACHE_KEY_INVALID" }); }

  // A single space still separates words. Mathematical notation, code, punctuation,
  // case and hyphens remain intact, including whitespace inside marked expressions.
  function normalizeText(value) {
    if (typeof value !== "string" || value.length > MAX_KEY_CHARS) throw invalid();
    const source = value.normalize("NFC").replace(/\r\n?/g, "\n"), pieces = [];
    const marker = /`+|~{3,}|\\\(|\\\[|\\begin\{[A-Za-z0-9_*.-]{1,64}\}|\${1,2}/g;
    let start = 0, match;
    const escaped = index => {
      let count = 0;
      while (index > 0 && source[--index] === "\\") count++;
      return !!(count % 2);
    };
    while ((match = marker.exec(source))) {
      const opening = match[0], index = match.index;
      if (opening[0] === "$" && escaped(index)) continue;
      let closing = opening;
      if (opening === "\\(") closing = "\\)";
      else if (opening === "\\[") closing = "\\]";
      else if (opening.startsWith("\\begin{")) closing = "\\end{" + opening.slice(7);
      let end = source.indexOf(closing, index + opening.length);
      while (end !== -1 && ((opening[0] === "$" && escaped(end))
        || ((opening[0] === "`" || opening[0] === "~")
          && (source[end - 1] === opening[0] || source[end + closing.length] === opening[0])))) {
        end = source.indexOf(closing, end + closing.length);
      }
      if (end === -1 && opening === "`") continue;
      pieces.push({ text: source.slice(start, index).replace(/\s+/gu, " "), protected: false });
      end = end === -1 ? source.length : end + closing.length;
      pieces.push({ text: source.slice(index, end), protected: true });
      start = end; marker.lastIndex = end;
    }
    pieces.push({ text: source.slice(start).replace(/\s+/gu, " "), protected: false });
    pieces[0].text = pieces[0].text.trimStart();
    pieces[pieces.length - 1].text = pieces[pieces.length - 1].text.trimEnd();
    return pieces.map(piece => piece.text).join("");
  }

  function canonicalContext(value) {
    const visited = new Set(); let nodes = 0;
    function visit(item, depth) {
      if (++nodes > 10000 || depth > 20) throw invalid();
      if (item === null || typeof item === "boolean") return item;
      if (typeof item === "string") return normalizeText(item);
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (typeof item !== "object" || visited.has(item)) throw invalid();
      const proto = Object.getPrototypeOf(item);
      // loadSubScript and window sandboxes can supply another realm's plain objects.
      if (!Array.isArray(item) && (Object.prototype.toString.call(item) !== "[object Object]"
        || (proto !== null && Object.getPrototypeOf(proto) !== null))) throw invalid();
      visited.add(item);
      let result;
      if (Array.isArray(item)) result = Array.from(item, child => visit(child, depth + 1));
      else {
        result = Object.create(null);
        for (const key of Object.keys(item).sort()) {
          if (key.length > 128) throw invalid();
          result[key] = visit(item[key], depth + 1);
        }
      }
      visited.delete(item); return result;
    }
    return visit(value === undefined ? null : value, 0);
  }

  function createCache({ IOUtils, PathUtils, cryptoImpl, TextEncoderImpl = TextEncoder, now = Date.now, onError } = {}) {
    const encoder = new TextEncoderImpl();
    const directory = PathUtils.join(PathUtils.profileDir, "paper-lens");
    const path = PathUtils.join(directory, "cache-v1.json");
    const overhead = encoder.encode(JSON.stringify({ version: VERSION, entries: [] }) + "\n").length;
    let entries = new Map(), totalBytes = 0, loaded = false, loading = null;
    let generation = 0, revision = 0, dirty = false, writes = Promise.resolve();
    function report(code) { try { if (typeof onError === "function") onError(code); } catch (_) {} }
    const recordBytes = entry => encoder.encode(JSON.stringify(entry)).length;
    function timestamp() {
      let time;
      try { time = now(); } catch (_) {}
      return Number.isSafeInteger(time) && time >= 0 ? time : Date.now();
    }
    function serializedBytes() { return overhead + totalBytes + Math.max(0, entries.size - 1); }
    function discard(key) {
      const entry = entries.get(key); if (!entry) return;
      totalBytes -= recordBytes(entry); entries.delete(key);
    }
    function retain(entry) {
      discard(entry.key); entries.set(entry.key, entry); totalBytes += recordBytes(entry);
    }
    function trim() {
      while (entries.size > MAX_ENTRIES || serializedBytes() > MAX_BYTES) discard(entries.keys().next().value);
    }
    function validateEntry(entry) {
      if (!entry || !validKey(entry.key) || typeof entry.original !== "string" || !entry.original.trim()
        || entry.original.length > MAX_ORIGINAL_CHARS || typeof entry.text !== "string" || !entry.text.trim()
        || entry.text.length > MAX_TEXT_CHARS || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
        || !Number.isSafeInteger(entry.lastUsed) || entry.lastUsed < 0) throw invalid();
      return { key: entry.key, original: entry.original, text: entry.text, createdAt: entry.createdAt, lastUsed: entry.lastUsed };
    }
    async function load() {
      if (loaded) return;
      if (!loading) {
        const loadGeneration = generation;
        const operation = (async () => {
          let parsed = null;
          try {
            let info;
            try { info = await IOUtils.stat(path); }
            catch (error) { if (!missing(error)) throw error; }
            if (info) {
              if (info.type !== "regular" || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_BYTES) {
                report("CACHE_INVALID"); return;
              }
              const text = await IOUtils.readUTF8(path);
              if (typeof text !== "string" || text.length > MAX_BYTES || encoder.encode(text).length > MAX_BYTES) {
                report("CACHE_INVALID"); return;
              }
              try {
                const store = JSON.parse(text);
                if (!store || store.version !== VERSION || !Array.isArray(store.entries) || store.entries.length > MAX_ENTRIES) throw invalid();
                const keys = new Set();
                parsed = store.entries.map(item => {
                  const entry = validateEntry(item);
                  if (keys.has(entry.key)) throw invalid();
                  keys.add(entry.key); return entry;
                }).sort((a, b) => a.lastUsed - b.lastUsed);
              } catch (_) { parsed = null; report("CACHE_INVALID"); }
            }
          } catch (_) { report("CACHE_READ_FAILED"); }
          finally {
            if (generation === loadGeneration && !loaded) {
              entries = new Map(); totalBytes = 0;
              if (parsed) for (const entry of parsed) retain(entry);
              trim(); loaded = true;
            }
          }
        })();
        loading = operation;
        operation.finally(() => { if (loading === operation) loading = null; });
      }
      await loading;
    }
    function queue(operation) {
      const pending = writes.then(operation);
      writes = pending.catch(() => {}); return pending;
    }
    async function save(saveGeneration) {
      if (generation !== saveGeneration) return false;
      if (!dirty) return true;
      const savedRevision = revision;
      const text = JSON.stringify({ version: VERSION, entries: Array.from(entries.values()) }) + "\n";
      if (encoder.encode(text).length > MAX_BYTES) { report("CACHE_WRITE_FAILED"); return false; }
      try {
        await IOUtils.makeDirectory(directory, { permissions: 0o700, ignoreExisting: true });
        await IOUtils.setPermissions(directory, 0o700);
        await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp", permissions: 0o600 });
        await IOUtils.setPermissions(path, 0o600);
        if (generation !== saveGeneration) return false;
        if (revision === savedRevision) dirty = false;
        return true;
      } catch (_) { report("CACHE_WRITE_FAILED"); return false; }
    }
    return {
      get generation() { return generation; },
      async makeKey(input) {
        try {
          if (!input || typeof input !== "object") throw invalid();
          const limits = { paperKey: 256, model: 128, language: 64, promptVersion: 16384 };
          for (const [field, limit] of Object.entries(limits)) {
            if (typeof input[field] !== "string" || !input[field].trim() || input[field].length > limit) throw invalid();
          }
          if (typeof input.selection !== "string" || !input.selection.trim() || input.selection.length > MAX_ORIGINAL_CHARS) throw invalid();
          const payload = JSON.stringify({ version: VERSION, paperKey: input.paperKey, model: input.model,
            language: input.language, promptVersion: input.promptVersion, selection: normalizeText(input.selection),
            context: canonicalContext(input.context) });
          if (payload.length > MAX_KEY_CHARS) throw invalid();
          const bytes = encoder.encode(payload);
          if (bytes.length > MAX_KEY_CHARS) throw invalid();
          const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", bytes));
          if (digest.length !== 32) throw invalid();
          return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
        } catch (_) { report("CACHE_KEY_INVALID"); return null; }
      },
      async get(key) {
        if (!validKey(key)) return null;
        await load();
        const entry = entries.get(key); if (!entry) return null;
        retain({ ...entry, lastUsed: timestamp() }); revision++; dirty = true;
        return { text: entry.text, original: entry.original };
      },
      async put(key, value, expectedGeneration) {
        if (!validKey(key) || !Number.isSafeInteger(expectedGeneration) || generation !== expectedGeneration) return false;
        let entry;
        try {
          const time = timestamp();
          entry = validateEntry({ key, text: value?.text, original: value?.original, createdAt: time, lastUsed: time });
          if (recordBytes(entry) + overhead > MAX_BYTES) return false;
        } catch (_) { return false; }
        await load();
        if (generation !== expectedGeneration) return false;
        const previous = entries.get(key);
        if (previous) entry.createdAt = previous.createdAt;
        retain(entry); trim(); revision++; dirty = true;
        return queue(() => save(expectedGeneration));
      },
      clear() {
        generation++; entries = new Map(); totalBytes = 0; loaded = true;
        revision++; dirty = true;
        const clearGeneration = generation;
        return queue(() => save(clearGeneration));
      },
      async flush() {
        await load();
        const flushGeneration = generation;
        return queue(() => save(flushGeneration));
      },
    };
  }
  return { createCache, normalizeText, MAX_ENTRIES, MAX_BYTES, VERSION };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PaperLensCache;
