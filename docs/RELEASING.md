# Release process

Repository: `februarysea/zotero-paper-lens`. Author: `februarysea`.

Public source uploads and releases require the maintainer's approval. For the first release, prepare the complete local source commit and review assets before asking for that approval. No release command publishes automatically.

## Prepare locally

1. Keep `package.json` and `addon/manifest.json` at the same numeric version. Add `docs/releases/v<version>.md` with actual behavior, migration and validation scope.
2. Keep the permanent ID `paper-lens@februarysea.github.io`. Choose `paperLens.releaseChannel` in `package.json`: `beta` uses `updates-beta.json`, `stable` uses `updates.json`. The manifest's URL must agree.
3. Run `npm run check`, `npm test`, `npm run test:release` and `npm run release:prepare`.
4. Inspect the XPI contents, checksum, notes and `dist/RELEASE_REVIEW.md`. Ensure source contains no credentials or private material. Commit the source, then repeat `release:prepare` to record the reviewed commit with a clean working tree.
5. Obtain approval for the public source upload and the named release. Before installing the first permanent-ID package, disable/uninstall the old `paper-lens@local` copy. Existing profile auth/preferences remain outside the package.

Preparation creates candidate update data in `dist/` only. Root channel manifests remain unchanged and may be empty until the first public release. No unpublished download is advertised to Zotero.

## Upload and create a draft after approval

1. Push the approved commit to `main`, then wait for CI to pass. CI runs on Linux, macOS and Windows; these are code/build checks, not Zotero runtime tests.
2. Run the manual **Beta release draft** workflow for the exact version, or run `npm run release:draft` from a clean checkout with GitHub CLI authorization. The command verifies that the source commit exists in the target repository and refuses an existing release for the version.
3. Inspect the draft's target commit, release notes, `Pre-release` flag, XPI, checksum, metadata and candidate channel manifest. Check the public-ID package's installation/migration. Publish through GitHub's release UI only after approval and review.

The workflow has no tag/push trigger or publication step. `--draft` is always passed. Publication and channel promotion are separate steps. Do not distribute a GitHub draft URL as a public download.

## Enable updates after publication

From the same reviewed source checkout:

```sh
npm run release:promote
```

This downloads the published release assets and verifies the channel, version, source metadata, XPI manifest, byte hash, checksum file, size and canonical download URL. It also compares the published package with the local build. Drafts and mismatches are refused. Only the local root channel manifest is changed; nothing is pushed.

Review that change, commit it and push it after publication is approved. Preserve older entries so compatible updates remain available. Stable and Beta use separate manifests; stable manifests must never contain pre-release entries. Stable users cannot join Beta automatically. A manual channel switch requires installing the intended package/version.

If preparing the next version, increase the version before creating a new draft. Existing release assets are not overwritten by the script. To change a draft, delete/recreate or edit it consciously in GitHub and rerun review. Do not replace already distributed binaries for the same version.

## Maintainer checks

- Record actual Zotero, OS and account-flow validation separately from unit tests.
- Verify authorization, translation, restart, public-ID migration and update installation on supported environments.
- Enable GitHub private vulnerability reporting in repository settings if available.
- After first publication, update the README's preparation status and record the release date in `CHANGELOG.md`.
- Only then announce the download to a small Beta group; broader Zotero Forums/plugin-directory submissions follow feedback.

References: [Zotero manifest and update format](https://www.zotero.org/support/dev/zotero_7_for_developers), [GitHub draft and pre-release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).
