"""Copy a licensed @dialt/sdk browser release into the static web client.

Usage:
    uv run scripts/vendor_dialt_sdk.py --npm 0.48.1
    uv run scripts/vendor_dialt_sdk.py --npm 0.48.1 --check
    uv run scripts/vendor_dialt_sdk.py /path/to/sdk/browser --commit <git-sha> [--check]

`--npm` downloads the published package with `npm pack --ignore-scripts` and records its
registry tarball, integrity and source commit. A source directory (the monorepo's
`sdk/browser` or an extracted package) needs `--commit`. Either source must be the
preferred-form SDK tree with its Apache license, NOTICE and third-party license directory.
"""

import argparse
import filecmp
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).parents[1]
DEST = ROOT / "converse_code" / "web" / "vendor" / "dialt"
PACKAGE = "@dialt/sdk"
REPOSITORY = "https://github.com/dialt-ai/dialt"
METADATA = ("LICENSE", "NOTICE", "CHANGELOG.md", "package.json")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("source", type=Path, nargs="?", help="SDK source directory (sdk/browser)")
    parser.add_argument("--npm", metavar="VERSION", help=f"Vendor the published {PACKAGE} version")
    parser.add_argument("--commit", help="Full upstream Git commit SHA for a source directory")
    parser.add_argument("--check", action="store_true", help="Fail if the committed copy differs")
    args = parser.parse_args()
    if (args.source is None) == (args.npm is None):
        parser.error("pass either a source directory or --npm VERSION")
    if args.source is not None and not args.commit:
        parser.error("a source directory needs --commit")
    if args.npm is not None and args.commit:
        parser.error("--npm reads the commit from the registry; omit --commit")
    return args


def npm_json(*args: str):
    result = subprocess.run(["npm", *args, "--json"], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def fetch_npm(version: str, workdir: Path) -> tuple[Path, str, dict]:
    spec = f"{PACKAGE}@{version}"
    info = npm_json("view", spec, "version", "gitHead", "dist")
    if not isinstance(info, dict) or info.get("version") != version:
        raise SystemExit(f"{spec} is not a single published version")
    packed = npm_json("pack", spec, "--ignore-scripts", "--pack-destination", str(workdir))[0]
    if packed["integrity"] != info["dist"]["integrity"]:
        raise SystemExit(f"{spec} tarball integrity does not match the registry")
    with tarfile.open(workdir / packed["filename"]) as archive:
        archive.extractall(workdir, filter="data")
    registry = {"tarball": info["dist"]["tarball"], "integrity": info["dist"]["integrity"]}
    return workdir / "package", info.get("gitHead") or "", registry


def validate_source(source: Path) -> dict:
    missing = [name for name in METADATA if not (source / name).is_file()]
    if missing:
        raise SystemExit(f"SDK source is missing required metadata: {', '.join(missing)}")
    package = json.loads((source / "package.json").read_text())
    if package.get("name") != PACKAGE:
        raise SystemExit(f"Refusing to vendor {package.get('name')!r}; expected {PACKAGE}")
    if package.get("license") != "Apache-2.0":
        raise SystemExit("Refusing to vendor SDK source that is not Apache-2.0")
    if not (source / "THIRD_PARTY_LICENSES").is_dir():
        raise SystemExit("SDK source has no THIRD_PARTY_LICENSES directory")
    if not list((source / "src").glob("*.js")):
        raise SystemExit("SDK source has no preferred-form JavaScript in src/")
    return package


def provenance(package: dict, commit: str, registry: dict | None) -> str:
    data = {
        "package": package["name"],
        "version": package["version"],
        "repository": REPOSITORY,
        "path": "sdk/browser",
        "commit": commit,
    }
    if registry:
        data["npm"] = registry
    return json.dumps(data, indent=2) + "\n"


def wanted_files(source: Path) -> dict[Path, Path]:
    files = {source / name: DEST / name for name in METADATA}
    files.update({path: DEST / path.name for path in sorted((source / "src").glob("*.js"))})
    for path in sorted((source / "THIRD_PARTY_LICENSES").iterdir()):
        if path.is_file():
            files[path] = DEST / "THIRD_PARTY_LICENSES" / path.name
    return files


def check(source: Path, package: dict, record: str) -> None:
    wanted = wanted_files(source)
    drift = [
        str(dest.relative_to(ROOT)) for src, dest in wanted.items()
        if not dest.is_file() or not filecmp.cmp(src, dest, shallow=False)
    ]
    expected = set(wanted.values()) | {DEST / "README.md", DEST / "UPSTREAM.json"}
    drift.extend(
        f"{path.relative_to(ROOT)} (not in the release)" for path in sorted(DEST.rglob("*"))
        if path.is_file() and path not in expected
    )
    upstream_path = DEST / "UPSTREAM.json"
    if not upstream_path.is_file() or upstream_path.read_text() != record:
        drift.append(str(upstream_path.relative_to(ROOT)))
    if drift:
        raise SystemExit("Vendored SDK is stale:\n  " + "\n  ".join(drift))
    print(f"Vendored {PACKAGE} {package['version']} is in sync.")


def vendor(source: Path, package: dict, record: str) -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    third_party = DEST / "THIRD_PARTY_LICENSES"
    if third_party.exists():
        shutil.rmtree(third_party)
    third_party.mkdir()

    wanted = wanted_files(source)
    keep = {dest.name for dest in wanted.values() if dest.parent == DEST}
    keep.update({"README.md", "UPSTREAM.json"})
    for old in DEST.iterdir():
        if old.is_file() and old.name not in keep:
            old.unlink()
    for src, dest in wanted.items():
        shutil.copyfile(src, dest)
    (DEST / "UPSTREAM.json").write_text(record)
    print(f"Vendored {PACKAGE} {package['version']} with notices.")


def main() -> None:
    args = parse_args()
    with tempfile.TemporaryDirectory(prefix="dialt-sdk-") as workdir:
        if args.npm:
            source, commit, registry = fetch_npm(args.npm, Path(workdir))
        else:
            source, commit, registry = args.source.resolve(), args.commit, None
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise SystemExit("the upstream commit must be a full lowercase Git commit SHA")
        package = validate_source(source)
        record = provenance(package, commit, registry)
        if args.check:
            check(source, package, record)
        else:
            vendor(source, package, record)


if __name__ == "__main__":
    main()
