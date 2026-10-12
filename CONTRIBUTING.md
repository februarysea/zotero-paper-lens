# Contributing

Paper Lens focuses on translating selected text inside Zotero. Keep the native UI small and additions within that reading workflow. Discuss features in an issue before expanding the scope.

Use Node.js 18+ and Python 3.10+. There are no npm runtime or development dependencies to install.

```sh
npm run check
npm test
npm run test:release
npm run release:prepare
```

The XPI is built only from allowlisted addon files and the license. Generated assets stay in `dist/`. The release preparation command does not upload anything. See [Releasing](docs/RELEASING.md) before changing release metadata or workflows.

Run checks relevant to your change. Runtime tests use mocks; real OAuth and Zotero compatibility need separate manual verification. CI builds on multiple operating systems do not establish Zotero runtime support on those systems. Never use production credentials in tests.

Do not commit auth files, Codex configuration, tokens, login callback URLs, private PDFs or machine-specific paths. Bug reports should include addon/Zotero/OS versions, reproduction steps and non-sensitive error codes. Use synthetic or publicly available text for reproduction.

The permanent addon ID must stay `paper-lens@februarysea.github.io`. Keep package and manifest versions equal and Chinese/English strings aligned. Contributions are provided under the project's MIT license.
