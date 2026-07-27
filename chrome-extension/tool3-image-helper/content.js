"use strict";

const PAGE_ORIGIN = "https://via-life.github.io";
const TOOL1_PAGE_PATH = "/TX_Krismao_iTools/tool1.html";
const TOOL3_PAGE_PATH = "/TX_Krismao_iTools/tool3.html";
const TOOL1_PAGE_SOURCE = "itools-tool1-page";
const TOOL1_EXTENSION_SOURCE = "itools-tool1-extension";
const TOOL3_PAGE_SOURCE = "itools-tool3-page";
const TOOL3_EXTENSION_SOURCE = "itools-tool3-extension";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const MAX_BASE64_LENGTH = Math.ceil((30 * 1024 * 1024) / 3) * 4 + 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "application/octet-stream",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

function postToPage(source, message) {
  window.postMessage({ source, ...message }, PAGE_ORIGIN);
}

function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isValidResourceId(value) {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
}

function safeError(value, fallbackMessage) {
  if (
    value &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  ) {
    return { code: value.code, message: value.message };
  }
  return { code: "EXTENSION_ERROR", message: fallbackMessage };
}

function postTool3Error(requestId, code, message) {
  postToPage(TOOL3_EXTENSION_SOURCE, {
    type: "IMAGE_RESULT",
    requestId,
    ok: false,
    error: { code, message },
  });
}

function handleTool3Message(message) {
  if (message.type === "PING") {
    chrome.runtime.sendMessage(
      { type: "ENABLE_TOOL3_IMAGE_READ" },
      () => {
        postToPage(TOOL3_EXTENSION_SOURCE, {
          type: "PONG",
          version: chrome.runtime.getManifest().version,
        });
      },
    );
    return;
  }
  if (message.type !== "FETCH_HUNYUAN_IMAGE") return;

  const { requestId, resourceId } = message;
  if (!isValidRequestId(requestId)) return;
  if (!isValidResourceId(resourceId)) {
    postTool3Error(
      requestId,
      "INVALID_RESOURCE_ID",
      "图片资源标识无效，请重新选择 Excel。",
    );
    return;
  }

  chrome.runtime.sendMessage(
    { type: "FETCH_HUNYUAN_IMAGE", resourceId },
    (result) => {
      if (chrome.runtime.lastError) {
        postTool3Error(
          requestId,
          "EXTENSION_UNAVAILABLE",
          "图片助手暂时不可用，请刷新页面后重试。",
        );
        return;
      }
      if (
        result &&
        result.ok === true &&
        typeof result.mime === "string" &&
        typeof result.base64 === "string"
      ) {
        postToPage(TOOL3_EXTENSION_SOURCE, {
          type: "IMAGE_RESULT",
          requestId,
          ok: true,
          mime: result.mime,
          base64: result.base64,
        });
        return;
      }
      postToPage(TOOL3_EXTENSION_SOURCE, {
        type: "IMAGE_RESULT",
        requestId,
        ok: false,
        error: safeError(
          result && result.error,
          "扩展处理图片时发生错误，请重试。",
        ),
      });
    },
  );
}

function tool1Capabilities(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    tool1UploadReady: source.tool1UploadReady === true,
    testReady: source.testReady === true,
    prodReady: source.prodReady === true,
  };
}

function postTool1Status(capabilities) {
  postToPage(TOOL1_EXTENSION_SOURCE, {
    type: "PONG",
    version: chrome.runtime.getManifest().version,
    capabilities: tool1Capabilities(capabilities),
  });
}

function postTool1Error(requestId, code, message) {
  postToPage(TOOL1_EXTENSION_SOURCE, {
    type: "TOOL1_UPLOAD_RESULT",
    requestId,
    ok: false,
    error: { code, message },
  });
}

function handleTool1Ping() {
  chrome.runtime.sendMessage({ type: "GET_TOOL1_STATUS" }, (result) => {
    if (chrome.runtime.lastError || !result || result.ok !== true) {
      postTool1Status({});
      return;
    }
    postTool1Status(result.capabilities);
  });
}

function isValidTool1Upload(message) {
  const mime = String(message.mime || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return (
    isValidRequestId(message.requestId) &&
    (message.env === "test" || message.env === "prod") &&
    typeof message.filename === "string" &&
    FILENAME_PATTERN.test(message.filename) &&
    ALLOWED_IMAGE_MIME_TYPES.has(mime) &&
    typeof message.base64 === "string" &&
    message.base64.length > 0 &&
    message.base64.length <= MAX_BASE64_LENGTH &&
    message.base64.length % 4 === 0 &&
    BASE64_PATTERN.test(message.base64)
  );
}

function handleTool1Upload(message) {
  if (!isValidRequestId(message.requestId)) return;
  if (!isValidTool1Upload(message)) {
    postTool1Error(
      message.requestId,
      "INVALID_REQUEST",
      "上传请求无效，请重新选择 Excel 后重试。",
    );
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "UPLOAD_TOOL1_IMAGE",
      requestId: message.requestId,
      env: message.env,
      filename: message.filename,
      mime: message.mime,
      base64: message.base64,
    },
    (result) => {
      if (chrome.runtime.lastError) {
        postTool1Error(
          message.requestId,
          "EXTENSION_UNAVAILABLE",
          "上传助手暂时不可用，请刷新页面后重试。",
        );
        return;
      }
      if (result && result.ok === true && typeof result.url === "string") {
        postToPage(TOOL1_EXTENSION_SOURCE, {
          type: "TOOL1_UPLOAD_RESULT",
          requestId: message.requestId,
          ok: true,
          url: result.url,
        });
        return;
      }
      postToPage(TOOL1_EXTENSION_SOURCE, {
        type: "TOOL1_UPLOAD_RESULT",
        requestId: message.requestId,
        ok: false,
        error: safeError(
          result && result.error,
          "扩展处理上传时发生错误，请重试。",
        ),
      });
    },
  );
}

if (
  window.location.origin === PAGE_ORIGIN &&
  (window.location.pathname === TOOL1_PAGE_PATH ||
    window.location.pathname === TOOL3_PAGE_PATH)
) {
  if (window.location.pathname === TOOL3_PAGE_PATH) {
    window.addEventListener("pagehide", () => {
      chrome.runtime.sendMessage({ type: "DISABLE_TOOL3_IMAGE_READ" });
    });
  }
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== PAGE_ORIGIN ||
      !event.data
    ) {
      return;
    }

    if (
      window.location.pathname === TOOL3_PAGE_PATH &&
      event.data.source === TOOL3_PAGE_SOURCE
    ) {
      handleTool3Message(event.data);
      return;
    }
    if (
      window.location.pathname === TOOL1_PAGE_PATH &&
      event.data.source === TOOL1_PAGE_SOURCE
    ) {
      if (event.data.type === "PING") handleTool1Ping();
      else if (event.data.type === "UPLOAD_TOOL1_IMAGE") {
        handleTool1Upload(event.data);
      }
    }
  });
}