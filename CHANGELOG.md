# Changelog

## 0.2.5 — 2026-10-14 (Beta)

- Cache completed translations locally and reuse matching passages without another model request.
- Show cached translations in both the selection popup and reading pane.
- Add Retranslate to generate a fresh result and Clear translation cache in Zotero settings.
- Keep up to 1,000 cached translations or about 10 MB, removing the least recently used entries as needed.

See [release notes](docs/releases/v0.2.5.md) for validation scope and limitations.

## 0.2.4 — 2026-10-14 (Beta)

- Fix Paper Lens being disabled after upgrading to Zotero 10 by extending compatibility to Zotero 9 and 10.
- Keep the same addon ID, account authorization, preferences and translation behavior.
- Verify loading and automatic selection translation on macOS / Zotero 10.0.6.

See [release notes](docs/releases/v0.2.4.md) for validation scope and limitations.

## 0.2.3 — 2026-10-12 (Beta)

- Translate selected PDF text with Codex models through independent ChatGPT authorization.
- Stream one translation into both the selection popup and native reading pane; copy, stop, retry or save a paper note.
- Optionally translate after selection, with debounce, duplicate suppression and cancellation when selections change. Disabled by default.
- Choose the account's actual model IDs in Zotero settings; default to `gpt-6-luna`.
- Provide Chinese and English UI in one package, with limited nearby context and visible coverage.
- Use the permanent addon ID, separate Beta/stable update channels, checksummed packages and a manual release draft workflow.

First public Beta. See [release notes](docs/releases/v0.2.3.md) for migration, validation and limitations.
