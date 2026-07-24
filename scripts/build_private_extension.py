#!/usr/bin/env python3
"""Build the local-only browser helper package without exposing credentials."""

from __future__ import annotations

import io
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO_ROOT / "config.local.json"
EXTENSION_ROOT = REPO_ROOT / "chrome-extension" / "tool3-image-helper"
OUTPUT_PATH = (
    REPO_ROOT
    / "downloads"
    / "private"
    / "itools-browser-helper-private.zip"
)
PUBLIC_OUTPUT_PATH = REPO_ROOT / "downloads" / "itools-tool3-image-helper.zip"
PACKAGE_FILES = (
    "manifest.json",
    "background.js",
    "content.js",
    "credentials.js",
    "cos-js-sdk-v5.min.js",
    "COS-SDK-LICENSE.txt",
    "README.md",
)
ENVIRONMENTS = ("test", "prod")
PRIVATE_FIELDS = ("x-id", "x-token")


class BuildError(Exception):
    """Expected build failure with a credential-safe message."""


def load_private_config(config_path: Path) -> dict[str, dict[str, str]]:
    try:
        raw_config: Any = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BuildError("config.local.json was not found.") from None
    except (OSError, json.JSONDecodeError):
        raise BuildError("config.local.json could not be read.") from None

    if not isinstance(raw_config, dict):
        raise BuildError("config.local.json must contain an object.")

    private_config: dict[str, dict[str, str]] = {}
    for environment_name in ENVIRONMENTS:
        environment = raw_config.get(environment_name)
        if not isinstance(environment, dict):
            raise BuildError(
                f"config.local.json is missing the {environment_name} object."
            )

        private_config[environment_name] = {}
        for field_name in PRIVATE_FIELDS:
            value = environment.get(field_name)
            if (
                not isinstance(value, str)
                or not value.strip()
                or "\r" in value
                or "\n" in value
            ):
                raise BuildError(
                    f"config.local.json is missing {environment_name}.{field_name}."
                )
            private_config[environment_name][field_name] = value.strip()

    return private_config


def render_credentials(private_config: dict[str, dict[str, str]]) -> bytes:
    serialized = json.dumps(
        private_config,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    return (
        '"use strict";\n\n'
        f"globalThis.ITOOLS_PRIVATE_CONFIG = {serialized};\n"
    ).encode("utf-8")


def _zip_info(filename: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    return info


def _build_archive(package_data: dict[str, bytes]) -> bytes:
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, mode="w") as archive:
        for filename in PACKAGE_FILES:
            archive.writestr(_zip_info(filename), package_data[filename])
    return archive_buffer.getvalue()


def _read_extension_sources() -> dict[str, bytes]:
    package_data: dict[str, bytes] = {}
    for filename in PACKAGE_FILES:
        try:
            package_data[filename] = (EXTENSION_ROOT / filename).read_bytes()
        except OSError:
            raise BuildError(
                f"Extension source file is missing: {filename}."
            ) from None
    return package_data


def _has_empty_credentials_template(source_bytes: bytes) -> bool:
    try:
        source = source_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return bool(
        re.fullmatch(
            r'\s*(?:["\']use strict["\'];\s*)?'
            r"globalThis\.ITOOLS_PRIVATE_CONFIG\s*=\s*\{\s*\};\s*",
            source,
        )
    )


def build_public_extension(
    output_path: Path = PUBLIC_OUTPUT_PATH,
) -> Path:
    package_data = _read_extension_sources()
    if not _has_empty_credentials_template(package_data["credentials.js"]):
        raise BuildError(
            "credentials.js must contain only the empty public template."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(_build_archive(package_data))
    return output_path


def build_private_extension(
    config_path: Path = CONFIG_PATH,
    output_path: Path = OUTPUT_PATH,
) -> Path:
    private_config = load_private_config(config_path)
    credential_bytes = render_credentials(private_config)
    secret_values = {
        value.encode("utf-8")
        for environment in private_config.values()
        for value in environment.values()
    }

    package_data = _read_extension_sources()
    for filename, source_bytes in package_data.items():
        if filename == "credentials.js":
            package_data[filename] = credential_bytes
            continue

        if any(secret in source_bytes for secret in secret_values):
            raise BuildError(
                f"Credential data was found in extension source: {filename}."
            )
        package_data[filename] = source_bytes

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(_build_archive(package_data))
    return output_path


def main(argv: list[str] | None = None) -> int:
    public_build = argv == ["--public"]
    if argv not in (None, [], ["--public"]):
        print("Usage: build_private_extension.py [--public]", file=sys.stderr)
        return 2

    try:
        output_path = (
            build_public_extension() if public_build else build_private_extension()
        )
    except BuildError as error:
        print(f"Build failed: {error}", file=sys.stderr)
        return 1
    except OSError:
        print("Build failed: the package could not be written.", file=sys.stderr)
        return 1

    package_kind = "Public" if public_build else "Private"
    print(f"{package_kind} browser helper created at "
          f"{output_path.relative_to(REPO_ROOT)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
