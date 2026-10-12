# Paper Lens

Read papers with Codex models. · [中文](README.md)

A small Zotero PDF selection translator by [februarysea](https://github.com/februarysea). Select a passage, view its translation, then copy or save it as a paper note. The default model is `gpt-6-luna`. Paper Lens runs independently inside Zotero and uses its own ChatGPT OAuth authorization for eligible plan usage. Codex does not need to be running.

The first public version is **0.2.3 Beta**, currently being prepared. Packages will be available in [GitHub Releases](https://github.com/februarysea/zotero-paper-lens/releases). The manifest supports **Zotero 9**. The maintainer has verified authorization, real translation and continued use after restarting Zotero in a local 0.2.3 build on macOS. Windows, Linux and Zotero 10 have not been tested in actual use. See the [release notes](docs/releases/v0.2.3.md) for the validation scope.

## Installation and use

1. Download `paper-lens-0.2.3.xpi` from Releases. Disable or uninstall a development copy with ID `paper-lens@local` first to avoid running two copies. In Zotero, open **Tools → Plugins**, choose **Install Plugin From File**, and select the downloaded XPI.
2. Open **Zotero Settings → Paper Lens** and click **Continue with ChatGPT**. Complete sign-in and authorize Paper Lens to use your ChatGPT plan in your system browser, then return to Zotero.
3. Settings show the connection and query the account's model list. The default is `gpt-6-luna`; if it is not listed, choose another model explicitly.
4. Open a PDF, select text, and click **Translate** in the selection popup. Alternatively, open **Tools → Paper Lens** and click **Translate selection**.
5. Translations stream into both the selection popup and the right reading pane from the same model request. Long popup translations scroll, with controls to copy completed text or stop generation. The reading pane also offers retry and saving as a paper's child note. Notes for standalone PDFs use Related links.

Enable **Translate automatically when text is selected** in **Zotero Settings → Paper Lens** to translate without clicking. It is off by default. After a selection stays stable for about 350 ms and the mouse is released, Paper Lens opens the reading pane and translates it. Rapid selections use only the latest passage, and repeated popup renders do not send duplicates. Turning the option off or switching tabs cancels pending translations; a new selection cancels the previous request. While enabled, selected passages are sent automatically to the model service.

The name remains Paper Lens in both languages. Chinese Zotero locales use Chinese UI; other locales fall back to English. The translation target follows the interface language. Model settings belong to Paper Lens only, and each option shows the actual model ID. Codex and a separate background service do not need to be running. This version only translates selections.

## Authorization, usage and credentials

Paper Lens uses OpenAI's OAuth flow for open-source local apps. Initial dynamic registration issues its own client ID; later sign-ins reuse the account registration and stable host identifier. Authorization uses PKCE, a random-port loopback callback, state/nonce validation, and ID-token signature, issuer and audience verification through OpenAI's JWKS.

Identity sign-in and ChatGPT plan usage are separate permissions. Identity-only sign-in remains saved, but translation is disabled until plan usage is authorized. Account eligibility, workspace policy, model availability and usage limits are determined by OpenAI. Translation counts toward shared account usage; **Manage usage** opens ChatGPT settings.

Credentials are stored only in `paper-lens/auth.json` under the current Zotero profile, separately from the library and sync storage. Writes are atomic, with Unix directory permissions `0700` and file permissions `0600`. Registrations stay separate even for accounts sharing an email address. Credentials are never included in source, logs, notes or diagnostics.

Tokens refresh automatically. Confirmed terminal refresh failures clear unusable tokens; temporary network or service failures preserve them. Sign-out attempts remote session revocation and clears local tokens. Unconfirmed revocation is reported, with instructions to disconnect the app in ChatGPT settings. Sign out before uninstalling; uninstalling alone does not delete saved registration records or revoke remote authorization.

Upgrading from 0.1.5 requires one separate Paper Lens authorization. Codex's auth file, configuration and model cache are no longer read or changed. The old advanced auth-path preference is unused.

## Network and context

Models are queried through `GET https://api.openai.com/v1/models`. Translation uses `POST https://api.openai.com/v1/responses` with `store: false`, `stream: true`, and text-only generation without tools. Credentials are sent only to fixed OpenAI endpoints; redirects are refused.

The selected passage, limited neighboring text, available abstract and basic source metadata are sent to OpenAI. Each translation is independent, without prior translations, PDF uploads or whole-library access. ChatGPT authorization follows the corresponding account/workspace data policies; `store: false` is not a zero-retention guarantee.

The maintainer operates no relay, telemetry or analytics service. Saved notes enter the Zotero library and follow your sync settings. See [Privacy](PRIVACY.md). Paper Lens is an independent project without official Zotero or OpenAI affiliation.

The complete selection is preserved. Neighboring text is limited to approximately 1,200 characters; the complete prompt budget defaults to 24,000 characters. Oversized selections produce an explicit error rather than silent truncation. Selection and recent translations are per-PDF session state; saved notes persist and include the passage, translation, model and source link.

Scanned PDFs need selectable text; OCR is not included. Missing extracted body text does not prevent translating an existing selection, and context coverage is shown. Basic Markdown is supported, LaTeX remains literal, and page numbers are added only when a real PDF page index exists.

## Development and distribution

The runtime uses native Zotero capabilities without npm runtime dependencies. Development requires Python 3.10+ and Node.js 18+; `npm install` is unnecessary. GitHub Actions use Node.js 24 and Python 3.13.

```sh
npm run check
npm test
npm run test:release
npm run release:prepare
```

`release:prepare` generates the XPI, SHA-256 file, candidate update manifest, build metadata and review materials in `dist/`, without uploading anything. `npm run build` builds only the package. `scripts/preview.html` uses the actual reader UI with simulated translations.

`oauth.js`, `loopback.js` and `auth.js` handle authorization and credentials; `settings.js` queries account models; `codex.js` implements the public Responses API; `context.js` and `ui.js` handle paper context and presentation; `preferences.js` manages native settings.

Beta and stable builds share the permanent addon ID `paper-lens@februarysea.github.io`, with separate `updates-beta.json` and `updates.json` channels. Stable packages do not automatically receive Betas. Channels are updated only after matching Releases are published and downloaded assets are verified. Development copies have a different ID/update address, so initial migration requires manual installation. Existing `extensions.paperlens.*` preferences and Paper Lens profile registrations remain available.

CI checks and builds the project. The manual Beta workflow only creates a GitHub Release draft. Publication requires maintainer confirmation, followed by download verification and channel promotion. See [Releasing](docs/RELEASING.md) and [Contributing](CONTRIBUTING.md).

References: [OpenAI open-source app authorization](https://developers.openai.com/siwc/token-sharing-open-source), [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Zotero plugins](https://www.zotero.org/support/plugins).

MIT License · Copyright © 2026 februarysea
