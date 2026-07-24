"use strict";

const ALLOWED_PAGE_ORIGIN = "https://via-life.github.io";
const ALLOWED_PAGE_PATH = "/TX_Krismao_iTools/tool3.html";
const HUNYUAN_ORIGIN = "https://hunyuan.tencent.com";
const DOWNLOAD_ENDPOINT =
  "https://hunyuan.tencent.com/api/resource/download";
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function errorResult(code, message) {
  return {
    ok: false,
    error: { code, message },
  };
}

function isAllowedPageUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === ALLOWED_PAGE_ORIGIN &&
      url.pathname === ALLOWED_PAGE_PATH
    );
  } catch {
    return false;
  }
}

function isAllowedSender(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.frameId === 0 &&
    Boolean(sender.tab) &&
    isAllowedPageUrl(sender.url)
  );
}

function isValidResourceId(value) {
  return (
    typeof value === "string" &&
    RESOURCE_ID_PATTERN.test(value)
  );
}

function normalizeMimeType(value) {
  return String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(chunks.join(""));
}

async function fetchHunyuanImage(resourceId) {
  if (!isValidResourceId(resourceId)) {
    return errorResult(
      "INVALID_RESOURCE_ID",
      "图片资源标识无效，请重新选择 Excel。",
    );
  }

  const url = new URL(DOWNLOAD_ENDPOINT);
  url.searchParams.set("resourceId", resourceId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url.href, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return errorResult(
        "IMAGE_TIMEOUT",
        "图片读取超时，请检查网络后重试。",
      );
    }
    return errorResult(
      "IMAGE_NETWORK_ERROR",
      "图片读取失败，请检查网络和浏览器登录状态。",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 401 || response.status === 403) {
    return errorResult(
      "IMAGE_AUTH_REQUIRED",
      "图片需要有效的元宝登录状态，请登录后重试。",
    );
  }

  try {
    if (new URL(response.url).origin !== HUNYUAN_ORIGIN) {
      return errorResult(
        "INVALID_IMAGE_RESPONSE",
        "图片服务返回了不受信任的响应。",
      );
    }
  } catch {
    return errorResult(
      "INVALID_IMAGE_RESPONSE",
      "图片服务返回了不受信任的响应。",
    );
  }

  if (!response.ok) {
    return errorResult(
      "IMAGE_UPSTREAM_ERROR",
      "图片服务暂时不可用，请稍后重试。",
    );
  }

  const mime = normalizeMimeType(response.headers.get("content-type"));
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
    return errorResult(
      "INVALID_IMAGE_RESPONSE",
      "图片服务返回了不支持的内容。",
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_IMAGE_BYTES
  ) {
    return errorResult(
      "IMAGE_TOO_LARGE",
      "单张图片超过 30 MiB 限制。",
    );
  }

  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch {
    return errorResult(
      "INVALID_IMAGE_RESPONSE",
      "图片内容读取失败，请稍后重试。",
    );
  }

  if (buffer.byteLength === 0) {
    return errorResult(
      "INVALID_IMAGE_RESPONSE",
      "图片内容为空，请稍后重试。",
    );
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return errorResult(
      "IMAGE_TOO_LARGE",
      "单张图片超过 30 MiB 限制。",
    );
  }

  return {
    ok: true,
    mime,
    base64: arrayBufferToBase64(buffer),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isAllowedSender(sender)) {
    return false;
  }
  if (
    !message ||
    message.type !== "FETCH_HUNYUAN_IMAGE" ||
    !Object.hasOwn(message, "resourceId")
  ) {
    sendResponse(
      errorResult("INVALID_REQUEST", "扩展收到无法识别的请求。"),
    );
    return false;
  }

  fetchHunyuanImage(message.resourceId)
    .then(sendResponse)
    .catch(() => {
      sendResponse(
        errorResult("EXTENSION_ERROR", "扩展处理图片时发生错误，请重试。"),
      );
    });
  return true;
});
