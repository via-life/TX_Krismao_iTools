"use strict";

const PAGE_SOURCE = "itools-tool3-page";
const EXTENSION_SOURCE = "itools-tool3-extension";
const PAGE_ORIGIN = "https://via-life.github.io";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;

function postToPage(message) {
  window.postMessage(
    {
      source: EXTENSION_SOURCE,
      ...message,
    },
    PAGE_ORIGIN,
  );
}

function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isValidResourceId(value) {
  return (
    typeof value === "string" &&
    RESOURCE_ID_PATTERN.test(value)
  );
}

function safeError(value) {
  if (
    value &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  ) {
    return {
      code: value.code,
      message: value.message,
    };
  }
  return {
    code: "EXTENSION_ERROR",
    message: "扩展处理图片时发生错误，请重试。",
  };
}

function postImageError(requestId, code, message) {
  postToPage({
    type: "IMAGE_RESULT",
    requestId,
    ok: false,
    error: { code, message },
  });
}

window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== PAGE_ORIGIN ||
    !event.data ||
    event.data.source !== PAGE_SOURCE
  ) {
    return;
  }

  if (event.data.type === "PING") {
    postToPage({
      type: "PONG",
      version: chrome.runtime.getManifest().version,
    });
    return;
  }

  if (event.data.type !== "FETCH_HUNYUAN_IMAGE") {
    return;
  }

  const { requestId, resourceId } = event.data;
  if (!isValidRequestId(requestId)) {
    return;
  }
  if (!isValidResourceId(resourceId)) {
    postImageError(
      requestId,
      "INVALID_RESOURCE_ID",
      "图片资源标识无效，请重新选择 Excel。",
    );
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "FETCH_HUNYUAN_IMAGE",
      resourceId,
    },
    (result) => {
      if (chrome.runtime.lastError) {
        postImageError(
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
        postToPage({
          type: "IMAGE_RESULT",
          requestId,
          ok: true,
          mime: result.mime,
          base64: result.base64,
        });
        return;
      }

      postToPage({
        type: "IMAGE_RESULT",
        requestId,
        ok: false,
        error: safeError(result && result.error),
      });
    },
  );
});
