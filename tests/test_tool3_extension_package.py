import json
import unittest
import zipfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = REPO_ROOT / "chrome-extension" / "tool3-image-helper"
ZIP_PATH = REPO_ROOT / "downloads" / "itools-tool3-image-helper.zip"
PACKAGE_FILES = {
    "manifest.json",
    "background.js",
    "content.js",
    "README.md",
}


class Tool3ExtensionManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(
            (EXTENSION_ROOT / "manifest.json").read_text(encoding="utf-8")
        )

    def test_manifest_uses_mv3_and_only_required_hunyuan_host(self) -> None:
        self.assertEqual(self.manifest["manifest_version"], 3)
        self.assertEqual(
            self.manifest.get("host_permissions"),
            ["https://hunyuan.tencent.com/*"],
        )
        self.assertNotIn("cookies", self.manifest.get("permissions", []))

    def test_content_script_is_limited_to_the_production_tool3_page(self) -> None:
        self.assertEqual(
            self.manifest["content_scripts"],
            [
                {
                    "matches": [
                        "https://via-life.github.io/"
                        "TX_Krismao_iTools/tool3.html*"
                    ],
                    "js": ["content.js"],
                    "run_at": "document_start",
                }
            ],
        )
        self.assertEqual(
            self.manifest["background"],
            {"service_worker": "background.js"},
        )


class Tool3ExtensionSourceSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.background = (EXTENSION_ROOT / "background.js").read_text(
            encoding="utf-8"
        )
        cls.content = (EXTENSION_ROOT / "content.js").read_text(
            encoding="utf-8"
        )

    def test_background_uses_only_fixed_download_endpoint_and_resource_id(self) -> None:
        self.assertIn(
            'const DOWNLOAD_ENDPOINT =\n'
            '  "https://hunyuan.tencent.com/api/resource/download";',
            self.background,
        )
        self.assertIn(
            'url.searchParams.set("resourceId", resourceId);',
            self.background,
        )
        self.assertNotIn("message.url", self.background)
        self.assertNotIn("chrome.cookies", self.background)

    def test_background_requires_login_session_without_exposing_cookies(self) -> None:
        self.assertIn('credentials: "include"', self.background)
        self.assertIn('cache: "no-store"', self.background)
        self.assertIn(
            'const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;',
            self.background,
        )
        self.assertIn(
            'const ALLOWED_PAGE_ORIGIN = "https://via-life.github.io";',
            self.background,
        )
        self.assertIn(
            'const ALLOWED_PAGE_PATH = "/TX_Krismao_iTools/tool3.html";',
            self.background,
        )

    def test_content_bridge_accepts_only_the_expected_page_and_message_shape(
        self,
    ) -> None:
        self.assertIn(
            'const PAGE_ORIGIN = "https://via-life.github.io";',
            self.content,
        )
        self.assertIn("event.source !== window", self.content)
        self.assertIn("event.origin !== PAGE_ORIGIN", self.content)
        self.assertIn("event.data.source !== PAGE_SOURCE", self.content)
        self.assertIn(
            'event.data.type !== "FETCH_HUNYUAN_IMAGE"',
            self.content,
        )
        self.assertNotIn("chrome.cookies", self.content)


class Tool3ExtensionZipTests(unittest.TestCase):
    def test_zip_contains_only_root_level_extension_files(self) -> None:
        self.assertTrue(ZIP_PATH.is_file(), f"missing extension ZIP: {ZIP_PATH}")

        with zipfile.ZipFile(ZIP_PATH) as archive:
            members = {item.filename for item in archive.infolist()}

        self.assertEqual(members, PACKAGE_FILES)
        self.assertTrue(all("/" not in name for name in members))

    def test_zip_files_are_byte_identical_to_extension_sources(self) -> None:
        with zipfile.ZipFile(ZIP_PATH) as archive:
            for name in PACKAGE_FILES:
                with self.subTest(name=name):
                    self.assertEqual(
                        archive.read(name),
                        (EXTENSION_ROOT / name).read_bytes(),
                    )


if __name__ == "__main__":
    unittest.main()
