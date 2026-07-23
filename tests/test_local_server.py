import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import quote

import local_server


DUMMY_CONFIG = {
    "test": {
        "x-id": "dummy-test-id",
        "x-token": "dummy-test-token",
        "x-route-env": "must-not-be-used",
    },
    "prod": {
        "x-id": "dummy-prod-id",
        "x-token": "dummy-prod-token",
        "x-route-env": "must-not-be-used",
    },
}

DUMMY_UPLOAD_INFO = {
    "encryptTmpSecretId": "temporary-id",
    "encryptTmpSecretKey": "temporary-key",
    "region": "ap-guangzhou",
    "encryptToken": "temporary-token",
    "bucketName": "dummy-bucket",
    "location": "images/dummy.png",
    "resourceUrl": "https://example.invalid/resource/dummy",
}


def successful_response() -> Mock:
    response = Mock()
    response.status_code = 200
    response.json.return_value = dict(DUMMY_UPLOAD_INFO)
    response.text = ""
    return response


class UploadPipelineTests(unittest.TestCase):
    @patch("local_server.CosS3Client")
    @patch("local_server.CosConfig")
    @patch("local_server.requests.post")
    def test_test_upload_uses_fixed_url_headers_payload_and_cos(
        self, post: Mock, cos_config: Mock, cos_client: Mock
    ) -> None:
        post.return_value = successful_response()
        cos_client.return_value.put_object.return_value = {"ETag": '"dummy-etag"'}

        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.local.json"
            config_path.write_text(json.dumps(DUMMY_CONFIG), encoding="utf-8")
            result = local_server.upload_image(
                "test", "截图.png", b"image-bytes", config_path
            )

        self.assertEqual(result, DUMMY_UPLOAD_INFO["resourceUrl"])
        post.assert_called_once_with(
            "https://yuanbao.test.hunyuan.woa.com/api/resource/genUploadInfo",
            headers={
                "x-id": "dummy-test-id",
                "x-token": "dummy-test-token",
                "x-route-env": "ci-613",
                "x-source": "app",
                "x-appversion": "9.9.9",
                "content-type": "application/json",
            },
            json={"fileName": "截图.png", "docFrom": "localDoc", "docOpenId": ""},
            timeout=(5, 30),
            allow_redirects=False,
        )
        cos_config.assert_called_once_with(
            Region="ap-guangzhou",
            SecretId="temporary-id",
            SecretKey="temporary-key",
            Token="temporary-token",
            Endpoint="cos-internal.ap-guangzhou.tencentcos.cn",
        )
        cos_client.return_value.put_object.assert_called_once_with(
            Bucket="dummy-bucket",
            Key="images/dummy.png",
            Body=b"image-bytes",
        )

    @patch("local_server.CosS3Client")
    @patch("local_server.CosConfig")
    @patch("local_server.requests.post")
    def test_prod_upload_uses_prod_url_and_headers(
        self, post: Mock, _cos_config: Mock, cos_client: Mock
    ) -> None:
        post.return_value = successful_response()
        cos_client.return_value.put_object.return_value = {"ETag": '"dummy-etag"'}

        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.local.json"
            config_path.write_text(json.dumps(DUMMY_CONFIG), encoding="utf-8")
            local_server.upload_image("prod", "image.png", b"bytes", config_path)

        request = post.call_args
        self.assertEqual(
            request.args[0],
            "https://yuanbao.tencent.com/api/resource/genUploadInfo",
        )
        self.assertEqual(request.kwargs["headers"]["x-id"], "dummy-prod-id")
        self.assertEqual(request.kwargs["headers"]["x-token"], "dummy-prod-token")
        self.assertEqual(request.kwargs["headers"]["x-route-env"], "--")

    def test_missing_config_is_actionable_and_does_not_disclose_values(self) -> None:
        missing_path = Path(tempfile.gettempdir()) / "definitely-missing-itools.json"
        with self.assertRaises(local_server.ApiError) as caught:
            local_server.upload_image("test", "image.png", b"bytes", missing_path)
        self.assertEqual(caught.exception.code, "CONFIG_MISSING")
        self.assertNotIn("dummy-test-token", caught.exception.message)

    def test_incomplete_config_is_rejected(self) -> None:
        config = {
            "test": {
                "x-id": "dummy-test-id",
                "x-token": "",
            }
        }
        with self.assertRaises(local_server.ApiError) as caught:
            local_server.get_environment_config(config, "test")
        self.assertEqual(caught.exception.code, "CONFIG_INCOMPLETE")

    @patch("local_server.requests.post")
    def test_auth_failure_is_classified_without_returning_response(
        self, post: Mock
    ) -> None:
        post.return_value.status_code = 403
        post.return_value.text = "denied dummy-test-token"

        with self.assertRaises(local_server.ApiError) as caught:
            local_server.request_upload_info(
                "test",
                "image.png",
                local_server.get_environment_config(DUMMY_CONFIG, "test"),
            )

        self.assertEqual(caught.exception.code, "AUTH_FAILED")
        self.assertNotIn("dummy-test-token", caught.exception.message)

    @patch("local_server.requests.post")
    def test_expired_token_is_classified(self, post: Mock) -> None:
        post.return_value.status_code = 401
        post.return_value.text = "token expired"

        with self.assertRaises(local_server.ApiError) as caught:
            local_server.request_upload_info(
                "test",
                "image.png",
                local_server.get_environment_config(DUMMY_CONFIG, "test"),
            )

        self.assertEqual(caught.exception.code, "TOKEN_EXPIRED")

    @patch("local_server.requests.post")
    def test_timeout_is_classified_and_redacted(self, post: Mock) -> None:
        post.side_effect = local_server.requests.Timeout("dummy-test-token")

        with self.assertRaises(local_server.ApiError) as caught:
            local_server.request_upload_info(
                "test",
                "image.png",
                local_server.get_environment_config(DUMMY_CONFIG, "test"),
            )

        self.assertEqual(caught.exception.code, "UPSTREAM_TIMEOUT")
        self.assertNotIn("dummy-test-token", caught.exception.message)

    @patch("local_server.requests.post")
    def test_network_error_is_classified_and_redacted(self, post: Mock) -> None:
        post.side_effect = local_server.requests.RequestException(
            "dummy-test-token"
        )

        with self.assertRaises(local_server.ApiError) as caught:
            local_server.request_upload_info(
                "test",
                "image.png",
                local_server.get_environment_config(DUMMY_CONFIG, "test"),
            )

        self.assertEqual(caught.exception.code, "NETWORK_ERROR")
        self.assertNotIn("dummy-test-token", caught.exception.message)

    @patch("local_server.requests.post")
    def test_malformed_upload_info_is_rejected(self, post: Mock) -> None:
        post.return_value.status_code = 200
        post.return_value.text = ""
        post.return_value.json.return_value = {"resourceUrl": "incomplete"}

        with self.assertRaises(local_server.ApiError) as caught:
            local_server.request_upload_info(
                "test",
                "image.png",
                local_server.get_environment_config(DUMMY_CONFIG, "test"),
            )

        self.assertEqual(caught.exception.code, "UPSTREAM_INVALID_RESPONSE")

    @patch("local_server.CosS3Client")
    @patch("local_server.CosConfig")
    def test_cos_failure_is_redacted(
        self, _cos_config: Mock, cos_client: Mock
    ) -> None:
        cos_client.return_value.put_object.side_effect = RuntimeError(
            "temporary-key dummy-test-token"
        )

        with self.assertRaises(local_server.ApiError) as caught:
            local_server.upload_to_cos(b"bytes", DUMMY_UPLOAD_INFO)

        self.assertEqual(caught.exception.code, "COS_UPLOAD_FAILED")
        self.assertNotIn("temporary-key", caught.exception.message)
        self.assertNotIn("dummy-test-token", caught.exception.message)


class HttpServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_directory.name)
        (self.directory / "index.html").write_text(
            "local static page", encoding="utf-8"
        )
        self.config_path = self.directory / "config.local.json"
        self.config_path.write_text(json.dumps(DUMMY_CONFIG), encoding="utf-8")
        self.server = local_server.create_server(
            port=0,
            directory=self.directory,
            config_path=self.config_path,
        )
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_directory.cleanup()

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            response_body = response.read()
            response_headers = dict(response.getheaders())
            return response.status, response_headers, response_body
        finally:
            connection.close()

    def test_server_binds_only_to_loopback(self) -> None:
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_health_only_reports_readiness(self) -> None:
        status, headers, body = self.request("GET", "/api/tool1/health")

        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(
            payload,
            {
                "ok": True,
                "environments": {
                    "test": {"ready": True},
                    "prod": {"ready": True},
                },
            },
        )
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        serialized = body.decode("utf-8")
        self.assertNotIn("dummy-test-id", serialized)
        self.assertNotIn("dummy-test-token", serialized)

    def test_static_page_is_served_from_same_server(self) -> None:
        status, _, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(body.decode("utf-8"), "local static page")

    def test_local_config_and_path_variants_are_not_served(self) -> None:
        for method, path in (
            ("GET", "/config.local.json"),
            ("HEAD", "/config.local.json"),
            ("GET", "/%63onfig.local.json"),
            ("GET", "/js/%2e%2e/config.local.json"),
        ):
            with self.subTest(method=method, path=path):
                status, _, body = self.request(method, path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"dummy-test-token", body)

    def test_cross_origin_and_preflight_are_rejected_without_cors(self) -> None:
        path = "/api/tool1/upload?env=test&filename=" + quote(
            "image.png", safe=""
        )
        status, headers, body = self.request(
            "POST",
            path,
            body=b"bytes",
            headers={"Origin": "https://example.invalid"},
        )
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(json.loads(body)["error"]["code"], "FORBIDDEN")

        status, headers, _ = self.request(
            "OPTIONS",
            path,
            headers={"Origin": "https://example.invalid"},
        )
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_wrong_host_is_rejected_for_get_and_post(self) -> None:
        wrong_host = f"localhost:{self.port}"
        status, _, body = self.request(
            "GET",
            "/api/tool1/health",
            headers={"Host": wrong_host},
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"]["code"], "FORBIDDEN")

        status, _, body = self.request(
            "POST",
            "/api/tool1/upload?env=test&filename=image.png",
            body=b"bytes",
            headers={
                "Host": wrong_host,
                "Origin": f"http://127.0.0.1:{self.port}",
            },
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"]["code"], "FORBIDDEN")

    def test_post_requires_same_origin(self) -> None:
        path = "/api/tool1/upload?env=test&filename=image.png"
        status, _, body = self.request("POST", path, body=b"bytes")
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"]["code"], "FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
