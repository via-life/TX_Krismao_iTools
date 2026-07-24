"""Local-only static server and media helpers for iTools."""

from __future__ import annotations

import argparse
import json
import posixpath
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, unquote, urlsplit

import requests
from qcloud_cos import CosConfig, CosS3Client


HOST = "127.0.0.1"
DEFAULT_PORT = 8080
APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "config.local.json"
UPLOAD_INFO_PATH = "/api/resource/genUploadInfo"
BASE_URLS = {
    "test": "https://yuanbao.test.hunyuan.woa.com",
    "prod": "https://yuanbao.tencent.com",
}
ROUTE_ENVS = {
    "test": "ci-613",
    "prod": "--",
}
COS_ENDPOINT = "cos-internal.ap-guangzhou.tencentcos.cn"
REQUEST_TIMEOUT = (5, 30)
REQUIRED_CONFIG_FIELDS = ("x-id", "x-token")
REQUIRED_UPLOAD_FIELDS = (
    "encryptTmpSecretId",
    "encryptTmpSecretKey",
    "region",
    "encryptToken",
    "bucketName",
    "location",
    "resourceUrl",
)


class ApiError(Exception):
    """An error that is safe to return to the browser."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.status = status


def load_config(
    config_path: Path = CONFIG_PATH, *, required: bool = True
) -> Mapping[str, Any]:
    """Load local credentials without including their values in errors."""

    try:
        raw_config = config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        if not required:
            return {}
        raise ApiError(
            "CONFIG_MISSING",
            "未找到本地配置，请复制 config.example.json 为 config.local.json 并填写凭据。",
            HTTPStatus.SERVICE_UNAVAILABLE,
        ) from None
    except OSError:
        if not required:
            return {}
        raise ApiError(
            "CONFIG_INVALID",
            "无法读取本地配置，请检查 config.local.json。",
            HTTPStatus.SERVICE_UNAVAILABLE,
        ) from None

    try:
        config = json.loads(raw_config)
    except (TypeError, json.JSONDecodeError):
        if not required:
            return {}
        raise ApiError(
            "CONFIG_INVALID",
            "本地配置格式无效，请检查 config.local.json。",
            HTTPStatus.SERVICE_UNAVAILABLE,
        ) from None

    if not isinstance(config, dict):
        if not required:
            return {}
        raise ApiError(
            "CONFIG_INVALID",
            "本地配置格式无效，请检查 config.local.json。",
            HTTPStatus.SERVICE_UNAVAILABLE,
        )
    return config


def get_environment_config(
    config: Mapping[str, Any], env: str
) -> dict[str, str]:
    if env not in BASE_URLS:
        raise ApiError(
            "INVALID_ENV",
            "环境参数无效，只能选择测试或正式环境。",
            HTTPStatus.BAD_REQUEST,
        )

    environment = config.get(env)
    if not isinstance(environment, Mapping):
        raise ApiError(
            "CONFIG_INCOMPLETE",
            f"{'测试' if env == 'test' else '正式'}环境尚未配置。",
            HTTPStatus.SERVICE_UNAVAILABLE,
        )

    values: dict[str, str] = {}
    for field in REQUIRED_CONFIG_FIELDS:
        value = environment.get(field)
        if (
            not isinstance(value, str)
            or not value.strip()
            or "\r" in value
            or "\n" in value
        ):
            raise ApiError(
                "CONFIG_INCOMPLETE",
                f"{'测试' if env == 'test' else '正式'}环境尚未配置。",
                HTTPStatus.SERVICE_UNAVAILABLE,
            )
        values[field] = value.strip()
    return values


def get_environment_readiness(config_path: Path = CONFIG_PATH) -> dict[str, bool]:
    config = load_config(config_path, required=False)
    readiness: dict[str, bool] = {}
    for env in BASE_URLS:
        try:
            get_environment_config(config, env)
        except ApiError:
            readiness[env] = False
        else:
            readiness[env] = True
    return readiness


def build_headers(env: str, environment: Mapping[str, str]) -> dict[str, str]:
    return {
        "x-id": environment["x-id"],
        "x-token": environment["x-token"],
        "x-route-env": ROUTE_ENVS[env],
        "x-source": "app",
        "x-appversion": "9.9.9",
        "content-type": "application/json",
    }


def _is_expired_response(response: requests.Response) -> bool:
    try:
        response_text = response.text[:1000].lower()
    except Exception:
        return False
    return (
        "expired" in response_text
        or "expire" in response_text
        or "过期" in response_text
    )


def request_upload_info(
    env: str, filename: str, environment: Mapping[str, str]
) -> Mapping[str, Any]:
    url = BASE_URLS[env] + UPLOAD_INFO_PATH
    payload = {"fileName": filename, "docFrom": "localDoc", "docOpenId": ""}

    try:
        response = requests.post(
            url,
            headers=build_headers(env, environment),
            json=payload,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.Timeout:
        raise ApiError(
            "UPSTREAM_TIMEOUT",
            "元宝接口请求超时，请确认已连接内网后重试。",
            HTTPStatus.GATEWAY_TIMEOUT,
        ) from None
    except requests.RequestException:
        raise ApiError(
            "NETWORK_ERROR",
            "无法连接元宝接口，请确认当前电脑已连接内网后重试。",
            HTTPStatus.BAD_GATEWAY,
        ) from None

    if response.status_code in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
        if _is_expired_response(response):
            raise ApiError(
                "TOKEN_EXPIRED",
                "当前环境的 token 已过期，请更新 config.local.json 后重试。",
                HTTPStatus.UNAUTHORIZED,
            )
        raise ApiError(
            "AUTH_FAILED",
            "当前环境鉴权失败，请检查 config.local.json 中的凭据。",
            HTTPStatus.UNAUTHORIZED,
        )

    if response.status_code != HTTPStatus.OK:
        raise ApiError(
            "UPSTREAM_ERROR",
            "元宝接口暂时不可用，请稍后重试。",
            HTTPStatus.BAD_GATEWAY,
        )

    try:
        upload_info = response.json()
    except (TypeError, ValueError):
        raise ApiError(
            "UPSTREAM_INVALID_RESPONSE",
            "元宝接口返回了无法识别的数据，请稍后重试。",
            HTTPStatus.BAD_GATEWAY,
        ) from None

    if not isinstance(upload_info, Mapping) or any(
        not isinstance(upload_info.get(field), str)
        or not upload_info.get(field, "").strip()
        for field in REQUIRED_UPLOAD_FIELDS
    ):
        raise ApiError(
            "UPSTREAM_INVALID_RESPONSE",
            "元宝接口返回的上传信息不完整，请稍后重试。",
            HTTPStatus.BAD_GATEWAY,
        )
    return upload_info


def upload_to_cos(image_data: bytes, upload_info: Mapping[str, Any]) -> None:
    try:
        cos_config = CosConfig(
            Region=upload_info["region"],
            SecretId=upload_info["encryptTmpSecretId"],
            SecretKey=upload_info["encryptTmpSecretKey"],
            Token=upload_info["encryptToken"],
            Endpoint=COS_ENDPOINT,
        )
        cos_client = CosS3Client(cos_config)
        result = cos_client.put_object(
            Bucket=upload_info["bucketName"],
            Key=upload_info["location"],
            Body=image_data,
        )
    except Exception:
        raise ApiError(
            "COS_UPLOAD_FAILED",
            "图片上传失败，请确认内网连接正常后重试。",
            HTTPStatus.BAD_GATEWAY,
        ) from None

    if not isinstance(result, Mapping) or not result.get("ETag"):
        raise ApiError(
            "COS_UPLOAD_FAILED",
            "图片上传未成功，请稍后重试。",
            HTTPStatus.BAD_GATEWAY,
        )


def upload_image(
    env: str,
    filename: str,
    image_data: bytes,
    config_path: Path = CONFIG_PATH,
) -> str:
    if env not in BASE_URLS:
        raise ApiError(
            "INVALID_ENV",
            "环境参数无效，只能选择测试或正式环境。",
            HTTPStatus.BAD_REQUEST,
        )
    filename = filename.strip()
    if not filename or "\r" in filename or "\n" in filename:
        raise ApiError(
            "INVALID_FILENAME",
            "文件名无效，请重新选择文件。",
            HTTPStatus.BAD_REQUEST,
        )
    if not image_data:
        raise ApiError(
            "EMPTY_UPLOAD",
            "图片内容为空，请重新选择文件。",
            HTTPStatus.BAD_REQUEST,
        )

    config = load_config(config_path)
    environment = get_environment_config(config, env)
    upload_info = request_upload_info(env, filename, environment)
    upload_to_cos(image_data, upload_info)
    return str(upload_info["resourceUrl"])


class LocalRequestHandler(SimpleHTTPRequestHandler):
    """Serve static files and expose loopback-only iTools APIs."""

    server_version = "iToolsLocal/1.0"

    def __init__(
        self,
        *args: Any,
        directory: str,
        config_path: Path,
        **kwargs: Any,
    ) -> None:
        self.config_path = config_path
        super().__init__(*args, directory=directory, **kwargs)

    def version_string(self) -> str:
        return self.server_version

    def _expected_host(self) -> str:
        return f"{HOST}:{self.server.server_port}"

    def _expected_origin(self) -> str:
        return f"http://{self._expected_host()}"

    def _is_local_request(self, *, require_origin: bool) -> bool:
        if self.headers.get("Host", "").strip().lower() != self._expected_host():
            return False
        origin = self.headers.get("Origin")
        if require_origin and origin is None:
            return False
        if origin is not None and origin.strip().lower() != self._expected_origin():
            return False
        return True

    def _send_json(self, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_api_error(self, error: ApiError) -> None:
        self._send_json(
            error.status,
            {
                "ok": False,
                "error": {"code": error.code, "message": error.message},
            },
        )

    def _reject_non_local_request(self) -> None:
        self._send_api_error(
            ApiError(
                "FORBIDDEN",
                "该接口仅允许从本机 iTools 页面访问。",
                HTTPStatus.FORBIDDEN,
            )
        )

    def _is_allowed_static_path(self) -> bool:
        try:
            decoded_path = unquote(urlsplit(self.path).path, errors="strict")
        except UnicodeError:
            return False
        if "\\" in decoded_path:
            return False
        normalized_path = posixpath.normpath("/" + decoded_path.lstrip("/"))
        if decoded_path.endswith("/") and normalized_path != "/":
            return False
        if normalized_path in {
            "/",
            "/index.html",
            "/tool1.html",
            "/tool2.html",
            "/tool3.html",
            "/tool4.html",
        }:
            return True
        return (
            normalized_path.startswith("/css/")
            and normalized_path.endswith(".css")
        ) or (
            normalized_path.startswith("/js/")
            and normalized_path.endswith(".js")
        )

    def send_head(self) -> Any:
        if not self._is_allowed_static_path():
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def do_GET(self) -> None:
        if not self._is_local_request(require_origin=False):
            self._reject_non_local_request()
            return

        parsed_path = urlsplit(self.path)
        if parsed_path.path == "/api/tool1/health":
            readiness = get_environment_readiness(self.config_path)
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "environments": {
                        "test": {"ready": readiness["test"]},
                        "prod": {"ready": readiness["prod"]},
                    },
                },
            )
            return
        if parsed_path.path.startswith("/api/"):
            self._send_api_error(
                ApiError("NOT_FOUND", "接口不存在。", HTTPStatus.NOT_FOUND)
            )
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        if not self._is_local_request(require_origin=False):
            self._reject_non_local_request()
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        if not self._is_local_request(require_origin=True):
            self._reject_non_local_request()
            return

        parsed_path = urlsplit(self.path)
        if parsed_path.path != "/api/tool1/upload":
            self._send_api_error(
                ApiError("NOT_FOUND", "接口不存在。", HTTPStatus.NOT_FOUND)
            )
            return

        try:
            query = parse_qs(parsed_path.query, keep_blank_values=True)
            if len(query.get("env", [])) != 1 or len(query.get("filename", [])) != 1:
                raise ApiError(
                    "INVALID_REQUEST",
                    "上传请求缺少环境或文件名。",
                    HTTPStatus.BAD_REQUEST,
                )

            content_length = self.headers.get("Content-Length")
            if content_length is None:
                raise ApiError(
                    "LENGTH_REQUIRED",
                    "上传请求缺少内容长度。",
                    HTTPStatus.LENGTH_REQUIRED,
                )
            try:
                length = int(content_length)
            except ValueError:
                raise ApiError(
                    "INVALID_REQUEST",
                    "上传请求的内容长度无效。",
                    HTTPStatus.BAD_REQUEST,
                ) from None
            if length <= 0:
                raise ApiError(
                    "EMPTY_UPLOAD",
                    "图片内容为空，请重新选择文件。",
                    HTTPStatus.BAD_REQUEST,
                )

            image_data = self.rfile.read(length)
            if len(image_data) != length:
                raise ApiError(
                    "INCOMPLETE_UPLOAD",
                    "图片内容接收不完整，请重试。",
                    HTTPStatus.BAD_REQUEST,
                )

            resource_url = upload_image(
                query["env"][0],
                query["filename"][0],
                image_data,
                self.config_path,
            )
        except ApiError as error:
            self._send_api_error(error)
            return
        except Exception:
            self._send_api_error(
                ApiError(
                    "INTERNAL_ERROR",
                    "本地服务处理失败，请重启服务后重试。",
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            )
            return

        self._send_json(HTTPStatus.OK, {"ok": True, "url": resource_url})

    def do_OPTIONS(self) -> None:
        self._reject_non_local_request()


def create_server(
    *,
    port: int = DEFAULT_PORT,
    directory: Path = APP_DIR,
    config_path: Path = CONFIG_PATH,
) -> ThreadingHTTPServer:
    handler = partial(
        LocalRequestHandler,
        directory=str(directory),
        config_path=config_path,
    )
    return ThreadingHTTPServer((HOST, port), handler)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Start the local iTools server.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")

    try:
        server = create_server(port=args.port)
    except OSError:
        print(f"[ERROR] Unable to bind http://{HOST}:{args.port}. Is the port in use?")
        return 1

    url = f"http://{HOST}:{server.server_port}/"
    print(f"iTools local server: {url}")
    print("Keep this window open while using requirement 1 or 3 local features.")
    if args.open_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
