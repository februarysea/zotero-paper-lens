"""Exercise packaging and release boundaries without real accounts or GitHub writes."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE / "scripts"))
import build as packaging
import release

COMMIT = "a" * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="paper-lens-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        shutil.copytree(SOURCE / "addon", self.root / "addon")
        shutil.copytree(SOURCE / "docs/releases", self.root / "docs/releases")
        for filename in ("package.json", "LICENSE", "updates-beta.json", "updates.json"):
            shutil.copyfile(SOURCE / filename, self.root / filename)
        for filename in ("updates-beta.json", "updates.json"):
            release.write_json(self.root / filename, {"addons": {release.PLUGIN_ID: {"updates": []}}})

    def prepared(self):
        with patch.object(release, "source_state", return_value=(COMMIT, False)):
            return release.prepare(self.root)

    def published(self, config, metadata):
        artifact = self.root / "dist" / config["artifact"]
        return {"tag_name": config["tag"], "draft": False, "published_at": "2026-10-12T00:00:00Z",
                "prerelease": config["channel"] == "beta", "resolved_commit": COMMIT,
                "assets": [{"name": config["artifact"], "size": artifact.stat().st_size,
                            "browser_download_url": release.update_entry(config, metadata["sha256"])["update_link"],
                            "digest": "sha256:" + metadata["sha256"]}]}

    def test_build_is_repeatable_and_contains_only_public_addon_and_license(self):
        artifact, checksum, digest = packaging.build(self.root)
        first = artifact.read_bytes()
        _, _, repeated_digest = packaging.build(self.root)
        self.assertEqual(first, artifact.read_bytes())
        self.assertEqual(digest, repeated_digest)
        self.assertEqual(digest, hashlib.sha256(first).hexdigest())
        self.assertEqual(checksum.read_text(), digest + "  " + artifact.name + "\n")
        with zipfile.ZipFile(artifact) as archive:
            self.assertIn("LICENSE", archive.namelist())
            self.assertIn("content/selection.js", archive.namelist())
            self.assertNotIn("package.json", archive.namelist())
            self.assertNotIn("updates-beta.json", archive.namelist())
            self.assertEqual(archive.read("LICENSE"), (self.root / "LICENSE").read_bytes())
            self.assertEqual(archive.testzip(), None)

    def test_build_refuses_private_and_unexpected_files(self):
        for filename in ("auth.json", "config.toml", ".env", "private.key", "notes.txt"):
            with self.subTest(filename=filename):
                path = self.root / "addon/content" / filename
                path.write_text("synthetic private fixture", encoding="utf-8")
                try:
                    with self.assertRaises(ValueError):
                        packaging.build(self.root)
                finally:
                    path.unlink()

    def test_build_refuses_linked_files_and_directories(self):
        for directory in (False, True):
            link = self.root / "addon/content/linked.js"
            destination = self.root / ("outside" if directory else "outside.js")
            if directory:
                destination.mkdir()
            else:
                destination.write_text("synthetic source", encoding="utf-8")
            try:
                link.symlink_to(destination, target_is_directory=directory)
            except OSError:
                self.skipTest("Creating symlinks is unavailable on this runner")
            try:
                with self.assertRaises(ValueError):
                    packaging.build(self.root)
            finally:
                link.unlink()

    def test_build_refuses_missing_required_file_and_unsafe_version(self):
        required = self.root / "addon/content/oauth.js"
        required.unlink()
        with self.assertRaisesRegex(ValueError, "Missing addon file"):
            packaging.build(self.root)
        manifest_path = self.root / "addon/manifest.json"
        manifest = release.read_json(manifest_path)
        manifest["version"] = "../../../escape"
        release.write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "version"):
            packaging.build(self.root)

    def test_prepare_generates_matching_assets_without_advertising_a_release(self):
        beta = (self.root / "updates-beta.json").read_bytes()
        stable = (self.root / "updates.json").read_bytes()
        with patch.object(release, "gh") as network:
            config, metadata, assets, notes = self.prepared()
        network.assert_not_called()
        self.assertEqual(metadata["source_commit"], COMMIT)
        self.assertFalse(metadata["source_dirty"])
        self.assertEqual(len(assets), 4)
        self.assertEqual(metadata["sha256"], hashlib.sha256(assets[0].read_bytes()).hexdigest())
        entry = release.read_json(self.root / "dist/updates-beta.json")["addons"][release.PLUGIN_ID]["updates"][0]
        self.assertEqual(entry, release.update_entry(config, metadata["sha256"]))
        self.assertEqual(entry["applications"]["zotero"], {"strict_min_version": "9.0", "strict_max_version": "10.0.*"})
        self.assertEqual(notes.read_bytes(), config["notes"].read_bytes())
        self.assertEqual(beta, (self.root / "updates-beta.json").read_bytes())
        self.assertEqual(stable, (self.root / "updates.json").read_bytes())

    def test_configuration_refuses_mismatched_version_author_identity_and_channel(self):
        manifest_path, package_path = self.root / "addon/manifest.json", self.root / "package.json"
        original_manifest, original_package = release.read_json(manifest_path), release.read_json(package_path)
        cases = ["version", "author", "id", "channel"]
        for case in cases:
            with self.subTest(case=case):
                manifest = json.loads(json.dumps(original_manifest))
                package = json.loads(json.dumps(original_package))
                if case == "version":
                    package["version"] = "0.2.2"
                elif case == "author":
                    manifest["author"] = "unknown"
                elif case == "id":
                    manifest["applications"]["zotero"]["id"] = "paper-lens@local"
                else:
                    manifest["applications"]["zotero"]["update_url"] = "https://example.invalid/updates.json"
                release.write_json(manifest_path, manifest)
                release.write_json(package_path, package)
                with self.assertRaises(ValueError):
                    release.configuration(self.root)

    def test_draft_refuses_dirty_source_before_network_access(self):
        with patch.object(release, "source_state", return_value=(COMMIT, True)), patch.object(release, "gh") as network:
            with self.assertRaisesRegex(ValueError, "Commit all"):
                release.draft(self.root)
        network.assert_not_called()

    def test_draft_refuses_existing_release_and_unpushed_commit(self):
        for existing in ({"draft": True}, {"draft": False}, None):
            with self.subTest(existing=existing):
                with patch.object(release, "source_state", return_value=(COMMIT, False)), \
                     patch.object(release.subprocess, "run", return_value=SimpleNamespace(stdout="https://github.com/" + release.REPOSITORY + ".git")), \
                     patch.object(release, "find_release", return_value=existing), \
                     patch.object(release, "gh", return_value=json.dumps({"sha": "b" * 40})) as network:
                    with self.assertRaises(ValueError):
                        release.draft(self.root)
                self.assertFalse(any(call.args[0][:2] == ["release", "create"] for call in network.call_args_list))

    def test_draft_always_uses_reviewed_commit_draft_and_prerelease_flags(self):
        def fake_gh(arguments):
            return json.dumps({"sha": COMMIT}) if arguments[0] == "api" else "https://github.com/reviewed-draft"
        with patch.object(release, "source_state", return_value=(COMMIT, False)), \
             patch.object(release.subprocess, "run", return_value=SimpleNamespace(stdout="https://github.com/" + release.REPOSITORY)), \
             patch.object(release, "find_release", return_value=None), \
             patch.object(release, "gh", side_effect=fake_gh) as network:
            release.draft(self.root)
        arguments = network.call_args_list[-1].args[0]
        self.assertEqual(arguments[:3], ["release", "create", release.configuration(self.root)["tag"]])
        self.assertIn("--draft", arguments)
        self.assertIn("--prerelease", arguments)
        self.assertEqual(arguments[arguments.index("--target") + 1], COMMIT)
        self.assertEqual(arguments[arguments.index("--repo") + 1], release.REPOSITORY)

    def test_promote_refuses_unpublished_wrong_channel_and_wrong_tag(self):
        config, metadata, _, _ = self.prepared()
        original = (self.root / "updates-beta.json").read_bytes()
        changes = [{"draft": True}, {"published_at": None}, {"prerelease": False},
                   {"tag_name": "v0.2.2"}, {"resolved_commit": "b" * 40}]
        for change in changes:
            with self.subTest(change=change):
                published = {**self.published(config, metadata), **change}
                with self.assertRaises(ValueError):
                    release.promote_manifest(self.root, config, published, self.root / "dist")
                self.assertEqual(original, (self.root / "updates-beta.json").read_bytes())

    def test_promote_refuses_tampered_artifact_checksum_and_metadata(self):
        config, metadata, assets, _ = self.prepared()
        published = self.published(config, metadata)
        for path in (assets[0], assets[1], assets[2], assets[3]):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b"tampered")
                try:
                    with self.assertRaises(ValueError):
                        release.promote_manifest(self.root, config, published, self.root / "dist")
                finally:
                    path.write_bytes(original)
                self.assertEqual(release.read_json(self.root / "updates-beta.json")["addons"][release.PLUGIN_ID]["updates"], [])

    def test_promote_refuses_different_local_source_or_download_address(self):
        config, metadata, _, _ = self.prepared()
        published = self.published(config, metadata)
        published["assets"][0]["browser_download_url"] = "https://example.invalid/download"
        with self.assertRaisesRegex(ValueError, "download URL"):
            release.promote_manifest(self.root, config, published, self.root / "dist")
        source = self.root / "addon/content/ui.js"
        source.write_text(source.read_text(encoding="utf-8") + "\n// changed after review\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "local reviewed build"):
            release.promote_manifest(self.root, config, self.published(config, metadata), self.root / "dist")

    def test_promote_preserves_older_updates_and_never_changes_stable_channel(self):
        config, metadata, _, _ = self.prepared()
        older = {**release.update_entry(config, "b" * 64), "version": "0.2.2",
                 "update_link": "https://github.com/" + release.REPOSITORY + "/releases/download/v0.2.2/paper-lens-0.2.2.xpi"}
        release.write_json(self.root / "updates-beta.json", {"addons": {release.PLUGIN_ID: {"updates": [older]}}})
        stable = (self.root / "updates.json").read_bytes()
        release.promote_manifest(self.root, config, self.published(config, metadata), self.root / "dist")
        updated = release.read_json(self.root / "updates-beta.json")["addons"][release.PLUGIN_ID]["updates"]
        self.assertEqual([item["version"] for item in updated], [config["version"], "0.2.2"])
        self.assertEqual(updated[1], older)
        self.assertEqual(stable, (self.root / "updates.json").read_bytes())
        release.promote_manifest(self.root, config, self.published(config, metadata), self.root / "dist")
        self.assertEqual(len(release.read_json(self.root / "updates-beta.json")["addons"][release.PLUGIN_ID]["updates"]), 2)

    def test_stable_channel_requires_a_stable_release(self):
        package = release.read_json(self.root / "package.json")
        package["paperLens"]["releaseChannel"] = "stable"
        release.write_json(self.root / "package.json", package)
        manifest = release.read_json(self.root / "addon/manifest.json")
        manifest["applications"]["zotero"]["update_url"] = "https://raw.githubusercontent.com/" + release.REPOSITORY + "/main/updates.json"
        release.write_json(self.root / "addon/manifest.json", manifest)
        config, metadata, _, _ = self.prepared()
        published = self.published(config, metadata)
        published["prerelease"] = True
        with self.assertRaisesRegex(ValueError, "channel"):
            release.promote_manifest(self.root, config, published, self.root / "dist")
        published["prerelease"] = False
        release.promote_manifest(self.root, config, published, self.root / "dist")
        self.assertEqual(len(release.read_json(self.root / "updates.json")["addons"][release.PLUGIN_ID]["updates"]), 1)
        self.assertEqual(release.read_json(self.root / "updates-beta.json")["addons"][release.PLUGIN_ID]["updates"], [])


if __name__ == "__main__":
    unittest.main()
