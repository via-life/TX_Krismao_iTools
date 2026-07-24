import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = REPO_ROOT / "chrome-extension" / "tool3-image-helper"
PUBLIC_ZIP_PATH = REPO_ROOT / "downloads" / "itools-tool3-image-helper.zip"
BUILDER_PATH = REPO_ROOT / "scripts" / "build_private_extension.py"
EXPECTED_HOST_PERMISSIONS = {
    "https://hunyuan.tencent.com/*",
    "https://yuanbao.test.hunyuan.woa.com/*",
    "https://yuanbao.tencent.com/*",
    "https://*.cos-internal.ap-guangzhou.tencentcos.cn/*",
}


def load_builder():
    spec = importlib.util.spec_from_file_location(
        "build_private_extension", BUILDER_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load extension builder")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load_builder()


def tracked_paths() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return [
        REPO_ROOT / os.fsdecode(raw_path)
        for raw_path in result.stdout.split(b"\0")
        if raw_path
    ]


def repository_candidate_paths() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return [
        REPO_ROOT / os.fsdecode(raw_path)
        for raw_path in result.stdout.split(b"\0")
        if raw_path
    ]


def local_secret_values() -> list[bytes]:
    config_path = REPO_ROOT / "config.local.json"
    if not config_path.is_file():
        return []
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    values = []
    for environment_name in ("test", "prod"):
        environment = config.get(environment_name, {})
        if not isinstance(environment, dict):
            continue
        for field_name in ("x-id", "x-token"):
            value = environment.get(field_name)
            if isinstance(value, str) and value.strip():
                values.append(value.strip().encode("utf-8"))
    return values


def file_payloads(path: Path):
    data = path.read_bytes()
    yield data
    if path.suffix.lower() != ".zip":
        return
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            if not member.is_dir():
                yield archive.read(member)


class Tool1ExtensionSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(
            (EXTENSION_ROOT / "manifest.json").read_text(encoding="utf-8")
        )
        cls.background = (EXTENSION_ROOT / "background.js").read_text(
            encoding="utf-8"
        )

    def test_manifest_has_only_fixed_required_hosts(self) -> None:
        self.assertEqual(
            set(self.manifest.get("host_permissions", [])),
            EXPECTED_HOST_PERMISSIONS,
        )
        self.assertEqual(
            len(self.manifest.get("host_permissions", [])),
            len(EXPECTED_HOST_PERMISSIONS),
        )
        self.assertNotIn("cookies", self.manifest.get("permissions", []))

    def test_content_scripts_only_match_github_pages_tool1_and_tool3(self) -> None:
        content_scripts = self.manifest.get("content_scripts", [])
        matches = [
            match
            for content_script in content_scripts
            for match in content_script.get("matches", [])
        ]
        self.assertEqual(
            set(matches),
            {
                "https://via-life.github.io/TX_Krismao_iTools/tool1.html*",
                "https://via-life.github.io/TX_Krismao_iTools/tool3.html*",
            },
        )
        self.assertEqual(len(matches), 2)
        for content_script in content_scripts:
            self.assertEqual(content_script.get("js"), ["content.js"])
            self.assertEqual(content_script.get("run_at"), "document_start")
        self.assertFalse(any("localhost" in match for match in matches))
        self.assertFalse(any("127.0.0.1" in match for match in matches))

    def test_upload_endpoints_and_route_headers_are_fixed_in_source(self) -> None:
        for expected_value in (
            "https://yuanbao.test.hunyuan.woa.com/api/resource/genUploadInfo",
            "https://yuanbao.tencent.com/api/resource/genUploadInfo",
            "cos-internal.ap-guangzhou.tencentcos.cn",
            "ci-613",
            '"--"',
            '"app"',
            '"9.9.9"',
        ):
            with self.subTest(expected_value=expected_value):
                self.assertIn(expected_value, self.background)

        self.assertNotIn("message.url", self.background)
        self.assertNotIn("message.endpoint", self.background)
        self.assertNotIn("message.host", self.background)

    def test_tracked_files_do_not_contain_local_credentials(self) -> None:
        secrets = local_secret_values()
        for path in repository_candidate_paths():
            for payload in file_payloads(path):
                if any(secret in payload for secret in secrets):
                    self.fail(
                        f"local credential found in tracked file: "
                        f"{path.relative_to(REPO_ROOT)}"
                    )

    def test_private_config_and_packages_are_not_tracked(self) -> None:
        tracked = {
            path.relative_to(REPO_ROOT).as_posix() for path in tracked_paths()
        }
        self.assertNotIn("config.local.json", tracked)
        self.assertFalse(
            any(path.startswith("downloads/private/") for path in tracked)
        )

        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "downloads/private/example.zip"],
            cwd=REPO_ROOT,
            check=False,
        )
        self.assertEqual(ignored.returncode, 0)

    def test_public_zip_has_empty_credentials_and_no_local_secrets(self) -> None:
        self.assertTrue(PUBLIC_ZIP_PATH.is_file())
        with zipfile.ZipFile(PUBLIC_ZIP_PATH) as archive:
            self.assertEqual(set(archive.namelist()), set(builder.PACKAGE_FILES))
            self.assertTrue(all("/" not in name for name in archive.namelist()))
            credentials = archive.read("credentials.js")
            self.assertTrue(builder._has_empty_credentials_template(credentials))
            payloads = [archive.read(name) for name in archive.namelist()]
            for filename in builder.PACKAGE_FILES:
                self.assertEqual(
                    archive.read(filename),
                    (EXTENSION_ROOT / filename).read_bytes(),
                )

        for payload in payloads:
            if any(secret in payload for secret in local_secret_values()):
                self.fail("local credential found in the public extension ZIP")


class ExtensionPackageBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.temp_root = Path(self.temp_dir.name)
        self.config_path = self.temp_root / "config.local.json"
        self.output_path = self.temp_root / "private.zip"
        self.private_config = {
            "test": {
                "x-id": "test-private-id-12345",
                "x-token": "test-private-token-12345+/=",
                "x-route-env": "must-not-be-packaged",
            },
            "prod": {
                "x-id": "prod-private-id-67890",
                "x-token": "prod-private-token-67890+/=",
                "x-route-env": "must-not-be-packaged",
            },
        }
        self.config_path.write_text(
            json.dumps(self.private_config), encoding="utf-8"
        )

    def test_private_zip_is_flat_and_only_replaces_credentials_template(self) -> None:
        source_credentials = (EXTENSION_ROOT / "credentials.js").read_bytes()
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = builder.build_private_extension(
                self.config_path, self.output_path
            )

        self.assertEqual(result, self.output_path)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(
            (EXTENSION_ROOT / "credentials.js").read_bytes(),
            source_credentials,
        )

        with zipfile.ZipFile(self.output_path) as archive:
            self.assertEqual(set(archive.namelist()), set(builder.PACKAGE_FILES))
            self.assertTrue(all("/" not in name for name in archive.namelist()))
            credentials = archive.read("credentials.js").decode("utf-8")
            for environment in self.private_config.values():
                self.assertIn(environment["x-id"], credentials)
                self.assertIn(environment["x-token"], credentials)
            self.assertNotIn("must-not-be-packaged", credentials)

            for filename in builder.PACKAGE_FILES:
                if filename != "credentials.js":
                    self.assertEqual(
                        archive.read(filename),
                        (EXTENSION_ROOT / filename).read_bytes(),
                    )

    def test_public_builder_preserves_empty_source_credentials(self) -> None:
        public_output = self.temp_root / "public.zip"
        builder.build_public_extension(public_output)
        with zipfile.ZipFile(public_output) as archive:
            self.assertEqual(set(archive.namelist()), set(builder.PACKAGE_FILES))
            for filename in builder.PACKAGE_FILES:
                self.assertEqual(
                    archive.read(filename),
                    (EXTENSION_ROOT / filename).read_bytes(),
                )

    def test_header_newlines_are_rejected_without_echoing_secret(self) -> None:
        injected_value = "do-not-print-this\r\nInjected: true"
        self.private_config["test"]["x-token"] = injected_value
        self.config_path.write_text(
            json.dumps(self.private_config), encoding="utf-8"
        )

        with self.assertRaises(builder.BuildError) as raised:
            builder.load_private_config(self.config_path)
        self.assertNotIn(injected_value, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
