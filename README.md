# Paper Lens

[English](README.md) · [简体中文](README.zh-CN.md)

Translate selected PDF text in Zotero with Codex models.

## Features

- Read translations in the selection popup and Zotero's reading pane.
- Copy translations, stop generation, retranslate, or save a translation as a paper note.
- Turn on automatic translation when you want to translate by selecting text.
- Reuse completed translations from a local cache, including after restarting Zotero.
- Use English or Chinese UI that follows your Zotero language.

## Installation

Requires **Zotero 9 or 10**. Currently tested in Zotero on macOS.

Download the latest Beta from the [Releases page](https://github.com/februarysea/zotero-paper-lens/releases).

1. Download the `.xpi` file from Releases.
2. In Zotero, open **Tools → Plugins**, click the gear icon, and choose **Install Plugin From File**.
3. Select the downloaded file, then open **Zotero Settings → Paper Lens**.
4. Click **Continue with ChatGPT**, complete sign-in and authorization in your browser, then return to Zotero.

## Usage

Open a PDF, select a passage, and click **Translate** in the selection popup. The translation appears as it is generated. You can copy it from the popup or use the reading pane to retranslate and save it to a note.

You can also open the pane through **Tools → Paper Lens** and click **Translate selection**.

To translate automatically, enable **Translate automatically when text is selected** in **Zotero Settings → Paper Lens**. This option is off by default. When enabled, selecting text starts a translation automatically.

The translation target follows the interface language: Chinese for a Chinese Zotero interface, English otherwise. PDFs must contain selectable text.

## Translation cache

Completed translations are saved automatically on this device. When you select the same passage in the same paper again, Paper Lens can show the saved translation, marked **Cached**, without using your model allowance again. The cache is available after restarting Zotero and is not synced between devices.

Click **Retranslate** for a fresh translation. Changing the model or translation language also generates a new result. Failed, cancelled and incomplete translations are not saved, and caching does not create Zotero notes.

To remove saved translations, open **Zotero Settings → Paper Lens → Clear translation cache**. Paper Lens keeps up to 1,000 entries and about 10 MB, removing older, less recently used entries as needed.

## ChatGPT account and model

Paper Lens uses your ChatGPT account. When signing in, approve the permission to use your plan for translation. Your sign-in is saved on this device, and Codex does not need to be running.

Translations count toward your ChatGPT plan's shared usage. Available models and limits depend on your account. Click **Manage usage** in Paper Lens settings to view or manage usage in ChatGPT.

The default model is **`gpt-6-luna`**. Change it in **Zotero Settings → Paper Lens** using the model dropdown. If the default is unavailable for your account, select another available model.

You can sign out at any time from the same settings page.

## Support

Report problems or suggestions in [GitHub Issues](https://github.com/februarysea/zotero-paper-lens/issues). For a bug report, include your Zotero version, operating system, and steps to reproduce it.

Implemented by Codex using GPT-6.1 Sol (Ultra), with [@februarysea](https://github.com/februarysea) providing only the ideas.

[Privacy](PRIVACY.md) · [MIT License](LICENSE)
