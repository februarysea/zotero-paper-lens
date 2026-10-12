"""Build a reproducible XPI and checksum without runtime dependencies."""
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ["bootstrap.js", "prefs.js", "manifest.json", "content/main.js", "content/i18n.js",
            "content/settings.js", "content/auth.js", "content/codex.js", "content/context.js", "content/ui.js",
            "content/popup.js", "content/selection.js", "content/style.css", "content/preferences.js",
            "content/preferences.xhtml", "content/oauth.js", "content/loopback.js"]
ALLOWED_CONTENT = {".js", ".css", ".svg", ".xhtml", ".png", ".jpg", ".webp"}
PRIVATE_NAMES = {"auth.json", "config.toml", "credentials.json", ".env"}


def addon_files(addon):
    files = []
    if addon.is_symlink():
        raise ValueError("Refusing linked addon directory")
    for path in sorted(addon.rglob("*")):
        if path.is_symlink():
            raise ValueError("Refusing linked addon path: " + str(path.relative_to(addon)))
        if not path.is_file():
            continue
        relative = path.relative_to(addon)
        if path.name in PRIVATE_NAMES or path.suffix in {".pem", ".key"}:
            raise ValueError("Refusing private or linked addon file: " + str(relative))
        if path.name == ".DS_Store":
            continue
        if any(part.startswith(".") for part in relative.parts):
            raise ValueError("Unexpected hidden addon file: " + str(relative))
        valid = relative.as_posix() in {"bootstrap.js", "prefs.js", "manifest.json"}
        valid |= relative.parts[0] == "content" and path.suffix in ALLOWED_CONTENT
        valid |= relative.parts[0] == "locale" and path.suffix == ".ftl"
        valid |= relative.parts[0] == "_locales" and path.name == "messages.json"
        if not valid:
            raise ValueError("Unexpected addon file: " + str(relative))
        files.append((relative.as_posix(), path.read_bytes()))
    return files


def build(root=ROOT, out=None):
    root = Path(root)
    addon = root / "addon"
    manifest = json.loads((addon / "manifest.json").read_text(encoding="utf-8"))
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", manifest.get("version", "")):
        raise ValueError("Invalid package version")
    out = Path(out) if out else root / "dist"
    out.mkdir(parents=True, exist_ok=True)
    for relative in REQUIRED:
        if not (addon / relative).is_file():
            raise ValueError("Missing addon file: " + relative)
    files = addon_files(addon)
    license_file = root / "LICENSE"
    if not license_file.is_file() or license_file.is_symlink():
        raise ValueError("Missing LICENSE")
    files.append(("LICENSE", license_file.read_bytes()))
    target = out / ("paper-lens-" + manifest["version"] + ".xpi")
    temporary = target.with_suffix(".xpi.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files):
                info = zipfile.ZipInfo(name, (2026, 10, 12, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o644 << 16
                archive.writestr(info, data)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    checksum = out / (target.name + ".sha256")
    checksum.write_text(digest + "  " + target.name + "\n", encoding="utf-8", newline="\n")
    return target, checksum, digest


if __name__ == "__main__":
    target, _, _ = build()
    print(str(target))
    print(str(target.stat().st_size) + " bytes")
