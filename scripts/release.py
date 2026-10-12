"""Prepare reviewed release assets; create drafts and verify published updates.

No command publishes a release, pushes Git state, or uploads credentials.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

from build import build

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "februarysea/zotero-paper-lens"
PLUGIN_ID = "paper-lens@februarysea.github.io"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def configuration(root=ROOT):
    root = Path(root)
    manifest = read_json(root / "addon/manifest.json")
    package = read_json(root / "package.json")
    version = manifest.get("version", "")
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("Release versions must use three numeric components")
    if package.get("version") != version:
        raise ValueError("Package and addon versions differ")
    channel = package.get("paperLens", {}).get("releaseChannel")
    if channel not in {"beta", "stable"}:
        raise ValueError("Unknown release channel")
    homepage = "https://github.com/" + REPOSITORY
    if package.get("repository", {}).get("url") != "git+" + homepage + ".git":
        raise ValueError("Unexpected repository")
    if manifest.get("homepage_url") != homepage or package.get("homepage") != homepage:
        raise ValueError("Unexpected homepage")
    if manifest.get("author") != "februarysea" or package.get("author") != "februarysea":
        raise ValueError("Unexpected author")
    zotero = manifest["applications"]["zotero"]
    filename = "updates-beta.json" if channel == "beta" else "updates.json"
    update_url = "https://raw.githubusercontent.com/" + REPOSITORY + "/main/" + filename
    if zotero.get("id") != PLUGIN_ID or zotero.get("update_url") != update_url:
        raise ValueError("Unexpected addon identity or update channel")
    compatibility = {key: zotero[key] for key in ("strict_min_version", "strict_max_version")}
    notes = root / "docs/releases" / ("v" + version + ".md")
    if not notes.is_file() or not notes.read_text(encoding="utf-8").strip():
        raise ValueError("Missing release notes")
    return {"version": version, "tag": "v" + version, "channel": channel,
            "update_filename": filename, "compatibility": compatibility,
            "artifact": "paper-lens-" + version + ".xpi", "notes": notes}


def source_state(root):
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root,
                                check=True, capture_output=True, text=True).stdout.strip()
        status = subprocess.run(["git", "status", "--porcelain"], cwd=root,
                                check=True, capture_output=True, text=True).stdout
        return commit, bool(status.strip())
    except (OSError, subprocess.CalledProcessError):
        return None, None


def update_entry(config, digest):
    return {"version": config["version"],
            "update_link": "https://github.com/" + REPOSITORY + "/releases/download/"
                           + config["tag"] + "/" + config["artifact"],
            "update_hash": "sha256:" + digest,
            "applications": {"zotero": config["compatibility"]}}


def prepare(root=ROOT):
    root = Path(root)
    config = configuration(root)
    artifact, checksum, digest = build(root)
    out = artifact.parent
    candidate = out / config["update_filename"]
    write_json(candidate, {"addons": {PLUGIN_ID: {"updates": [update_entry(config, digest)]}}})
    commit, dirty = source_state(root)
    metadata = {"schema": 1, "repository": REPOSITORY, "plugin_id": PLUGIN_ID,
                "version": config["version"], "tag": config["tag"], "channel": config["channel"],
                "artifact": config["artifact"], "sha256": digest,
                "compatibility": config["compatibility"], "source_commit": commit, "source_dirty": dirty}
    metadata_path = out / "release-meta.json"
    write_json(metadata_path, metadata)
    notes = out / "release-notes.md"
    notes.write_bytes(config["notes"].read_bytes())
    review = out / "RELEASE_REVIEW.md"
    review.write_text(
        "# Paper Lens " + config["version"] + " 发布确认\n\n"
        "目标：公开仓库 https://github.com/" + REPOSITORY + "。作者：februarysea。\n\n"
        "本地材料已准备；本命令没有上传源码、创建 GitHub Release 或公开更新清单。\n\n"
        "- 版本：`" + config["tag"] + "`；渠道：`" + config["channel"] + "`。\n"
        "- 固定插件 ID：`" + PLUGIN_ID + "`。\n"
        "- 源码提交：`" + (commit or "尚未提交") + "`；工作区存在未提交文件：`" + str(dirty) + "`。\n"
        "- 安装包：[" + artifact.name + "](" + artifact.name + ")，" + str(artifact.stat().st_size) + " 字节。\n"
        "- SHA-256：`" + digest + "`。\n"
        "- [发布说明](release-notes.md)、[校验文件](" + checksum.name + ")、[构建元数据](release-meta.json)。\n"
        "- [候选更新清单](" + candidate.name + ") 仅供核对；仓库根目录清单在实际发布前不指向此版本。\n\n"
        "功能、验证范围、迁移方法和已知限制以发布说明为准。自动化工作流只创建草稿。\n\n"
        "确认后：推送这份源码 → 运行 CI → 创建并核对 Beta 草稿 → 手动公开发布 "
        "→ 下载验证已发布安装包 → 更新对应渠道清单。稳定版清单不接收 Beta。\n",
        encoding="utf-8", newline="\n")
    return config, metadata, [artifact, checksum, metadata_path, candidate], notes


def gh(arguments):
    result = subprocess.run(["gh", *arguments], capture_output=True, text=True)
    if result.returncode:
        # Do not echo arbitrary remote bodies, headers, or auth-related diagnostics.
        raise ValueError("GitHub operation failed; check authentication, permissions and connectivity")
    return result.stdout


def find_release(tag):
    # Listing includes drafts visible to the authenticated maintainer. Fail closed
    # on network/auth errors instead of treating them as 'release not found'.
    pages = json.loads(gh(["api", "repos/" + REPOSITORY + "/releases", "--paginate", "--slurp"]))
    return next((item for page in pages for item in page if item.get("tag_name") == tag), None)


def draft(root=ROOT):
    root = Path(root)
    config = configuration(root)
    commit, dirty = source_state(root)
    if not commit or dirty is not False:
        raise ValueError("Commit all release source changes before creating a draft")
    origin = subprocess.run(["git", "remote", "get-url", "origin"], cwd=root,
                            check=True, capture_output=True, text=True).stdout.strip()
    if origin not in {"https://github.com/" + REPOSITORY, "https://github.com/" + REPOSITORY + ".git",
                      "git@github.com:" + REPOSITORY, "git@github.com:" + REPOSITORY + ".git"}:
        raise ValueError("Unexpected origin")
    if find_release(config["tag"]):
        raise ValueError("A release already exists for this version; review it manually")
    remote_commit = json.loads(gh(["api", "repos/" + REPOSITORY + "/commits/" + commit]))
    if remote_commit.get("sha") != commit:
        raise ValueError("The reviewed source commit must already be pushed")
    _, metadata, assets, notes = prepare(root)
    if metadata["source_commit"] != commit or metadata["source_dirty"] is not False:
        raise ValueError("Source changed while preparing the release")
    arguments = ["release", "create", config["tag"], "--repo", REPOSITORY, "--draft",
                 "--target", commit, "--title", "Paper Lens " + config["version"]
                 + (" Beta" if config["channel"] == "beta" else ""), "--notes-file", str(notes)]
    if config["channel"] == "beta":
        arguments.append("--prerelease")
    arguments.extend(str(path) for path in assets)
    return gh(arguments).strip()


def promote_manifest(root, config, release, assets_dir):
    """Verify downloaded assets before editing the local, public update file."""
    root, assets_dir = Path(root), Path(assets_dir)
    if release.get("draft") is not False or not release.get("published_at"):
        raise ValueError("Only a published release can enter an update channel")
    if release.get("tag_name") != config["tag"] or release.get("prerelease") is not (config["channel"] == "beta"):
        raise ValueError("Release version or channel differs")
    metadata = read_json(assets_dir / "release-meta.json")
    expected = {"schema": 1, "repository": REPOSITORY, "plugin_id": PLUGIN_ID,
                "version": config["version"], "tag": config["tag"], "channel": config["channel"],
                "artifact": config["artifact"], "compatibility": config["compatibility"], "source_dirty": False}
    if any(metadata.get(key) != value for key, value in expected.items()):
        raise ValueError("Published release metadata differs")
    if not re.fullmatch(r"[a-f0-9]{40}", metadata.get("source_commit") or ""):
        raise ValueError("Missing release source commit")
    if release.get("resolved_commit") != metadata["source_commit"]:
        raise ValueError("Published tag differs from the reviewed source commit")
    artifact = assets_dir / config["artifact"]
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    if metadata.get("sha256") != digest:
        raise ValueError("Published artifact checksum differs")
    checksum = (assets_dir / (config["artifact"] + ".sha256")).read_text(encoding="utf-8")
    if checksum != digest + "  " + config["artifact"] + "\n":
        raise ValueError("Published checksum file differs")
    with zipfile.ZipFile(artifact) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        current = read_json(root / "addon/manifest.json")
        if manifest != current:
            raise ValueError("Published addon manifest differs from reviewed source")
    _, _, local_digest = build(root)
    if local_digest != digest:
        raise ValueError("Published addon differs from the local reviewed build")
    entry = update_entry(config, digest)
    if read_json(assets_dir / config["update_filename"]) != {"addons": {PLUGIN_ID: {"updates": [entry]}}}:
        raise ValueError("Published candidate update manifest differs")
    assets = {asset.get("name"): asset for asset in release.get("assets", [])}
    remote_asset = assets.get(config["artifact"], {})
    if remote_asset.get("browser_download_url") != entry["update_link"]:
        raise ValueError("Published download URL differs")
    if remote_asset.get("size") != artifact.stat().st_size:
        raise ValueError("Published artifact size differs")
    if remote_asset.get("digest") and remote_asset["digest"] != "sha256:" + digest:
        raise ValueError("GitHub artifact digest differs")
    target = root / config["update_filename"]
    live = read_json(target)
    updates = live["addons"][PLUGIN_ID]["updates"]
    old = next((item for item in updates if item.get("version") == config["version"]), None)
    if old and old != entry:
        raise ValueError("A different update already exists for this version")
    if not old:
        updates.append(entry)
        updates.sort(key=lambda item: tuple(map(int, item["version"].split("."))), reverse=True)
        write_json(target, live)
    return target


def promote(root=ROOT):
    root = Path(root)
    config = configuration(root)
    release = find_release(config["tag"])
    if not release:
        raise ValueError("Release not found")
    if release.get("draft") is not False or not release.get("published_at"):
        raise ValueError("Publish the reviewed release before updating its channel")
    commit = json.loads(gh(["api", "repos/" + REPOSITORY + "/commits/" + config["tag"]]))
    release["resolved_commit"] = commit.get("sha")
    with tempfile.TemporaryDirectory(prefix="paper-lens-release-") as directory:
        gh(["release", "download", config["tag"], "--repo", REPOSITORY, "--dir", directory,
            "--pattern", config["artifact"], "--pattern", config["artifact"] + ".sha256",
            "--pattern", "release-meta.json", "--pattern", config["update_filename"]])
        return promote_manifest(root, config, release, directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "draft", "promote"])
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            _, metadata, assets, _ = prepare()
            print("Prepared " + metadata["tag"] + " (" + metadata["channel"] + ")")
            for path in assets:
                print(path)
            print("SHA-256: " + metadata["sha256"])
            print("No source or release has been uploaded.")
        elif args.command == "draft":
            print(draft())
            print("Draft only. Publish manually after approval.")
        else:
            print(promote())
            print("Local update manifest verified and changed; review, commit and push separately.")
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        parser.exit(1, "Release preparation stopped: " + str(error) + "\n")


if __name__ == "__main__":
    main()
