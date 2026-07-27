"use strict";

importScripts("credentials.js", "cos-js-sdk-v5.min.js");

const ALLOWED_PAGE_ORIGIN = "https://via-life.github.io";
const TOOL1_PAGE_PATH = "/TX_Krismao_iTools/tool1.html";
const TOOL3_PAGE_PATH = "/TX_Krismao_iTools/tool3.html";
const HUNYUAN_ORIGIN = "https://hunyuan.tencent.com";
const DOWNLOAD_ENDPOINT =
  "https://hunyuan.tencent.com/api/resource/download";
const UPLOAD_ENVIRONMENTS = Object.freeze({
  test: Object.freeze({
    endpoint:
      "https://yuanbao.test.hunyuan.woa.com/api/resource/genUploadInfo",
    route: "ci-613",
  }),
  prod: Object.freeze({
    endpoint: "https://yuanbao.tencent.com/api/resource/genUploadInfo",
    route: "--",
  }),
});
const COS_REGION = "ap-guangzhou";
const COS_HOST_SUFFIX = ".cos-internal.ap-guangzhou.tencentcos.cn";
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
const TOOL3_CORS_RULE_ID_OFFSET = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const COS_TIMEOUT_MS = 60_000;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
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
const REQUIRED_UPLOAD_FIELDS = [
  "encryptTmpSecretId",
  "encryptTmpSecretKey",
  "region",
  "encryptToken",
  "bucketName",
  "location",
  "resourceUrl",
];

class Tool1Error extends Error {
  constructor(code, message) {
    super(code);
    this.code = code;
    this.safeMessage = message;
  }
}

function errorResult(code, message) {
  return {
    ok: false,
    error: { code, message },
  };
}

function getAllowedSenderPath(sender) {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !sender.tab
  ) {
    return "";
  }
  try {
    const url = new URL(sender.url);
    if (url.origin !== ALLOWED_PAGE_ORIGIN) return "";
    if (url.pathname === TOOL1_PAGE_PATH || url.pathname === TOOL3_PAGE_PATH) {
      return url.pathname;
    }
  } catch {
    return "";
  }
  return "";
}

function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isValidResourceId(value) {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
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

function tool3ImageRuleId(tabId) {
  return tabId + TOOL3_CORS_RULE_ID_OFFSET;
}

async function enableTool3ImageRead(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return errorResult("INVALID_REQUEST", "扩展无法识别当前需求三标签页。");
  }
  const ruleId = tool3ImageRuleId(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            {
              header: "Access-Control-Allow-Origin",
              operation: "set",
              value: ALLOWED_PAGE_ORIGIN,
            },
            {
              header: "Access-Control-Allow-Credentials",
              operation: "set",
              value: "true",
            },
          ],
        },
        condition: {
          urlFilter:
            "|https://hunyuan.tencent.com/api/resource/download?resourceId=",
          initiatorDomains: ["via-life.github.io"],
          requestMethods: ["get"],
          resourceTypes: ["xmlhttprequest"],
          tabIds: [tabId],
        },
      },
    ],
  });
  return { ok: true };
}

async function disableTool3ImageRead(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tool3ImageRuleId(tabId)],
  });
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
      "当前 Chrome 登录态无权读取该图片，请打开原链接确认登录或资源权限。",
    );
  }

  if (response.status === 404 || response.status === 410) {
    return errorResult(
      "IMAGE_NOT_FOUND",
      "图片链接可能已失效，请打开原链接确认。",
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
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mime) || mime === "application/octet-stream") {
    return errorResult(
      "INVALID_IMAGE_RESPONSE",
      "图片服务返回了不支持的内容。",
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    return errorResult("IMAGE_TOO_LARGE", "单张图片超过 30 MiB 限制。");
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
  if (!buffer.byteLength) {
    return errorResult(
      "INVALID_IMAGE_RESPONSE",
      "图片内容为空，请稍后重试。",
    );
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return errorResult("IMAGE_TOO_LARGE", "单张图片超过 30 MiB 限制。");
  }

  return {
    ok: true,
    mime,
    base64: arrayBufferToBase64(buffer),
  };
}

function cleanCredential(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    return "";
  }
  return value.trim();
}

function getEnvironmentCredentials(env) {
  const root = globalThis.ITOOLS_PRIVATE_CONFIG;
  const source = root && typeof root === "object" ? root[env] : null;
  if (!source || typeof source !== "object") return null;
  const xId = cleanCredential(source["x-id"]);
  const xToken = cleanCredential(source["x-token"]);
  return xId && xToken ? { "x-id": xId, "x-token": xToken } : null;
}

function getTool1Capabilities() {
  const testReady = Boolean(getEnvironmentCredentials("test"));
  const prodReady = Boolean(getEnvironmentCredentials("prod"));
  return {
    tool1UploadReady: testReady || prodReady,
    testReady,
    prodReady,
  };
}

function validateUploadRequest(message) {
  if (!message || message.type !== "UPLOAD_TOOL1_IMAGE") {
    throw new Tool1Error(
      "INVALID_REQUEST",
      "扩展收到无法识别的上传请求。",
    );
  }
  if (!isValidRequestId(message.requestId)) {
    throw new Tool1Error("INVALID_REQUEST", "上传请求标识无效，请重试。");
  }
  if (!Object.hasOwn(UPLOAD_ENVIRONMENTS, message.env)) {
    throw new Tool1Error("INVALID_ENV", "环境参数无效，只能选择测试或正式环境。");
  }
  if (
    typeof message.filename !== "string" ||
    !FILENAME_PATTERN.test(message.filename)
  ) {
    throw new Tool1Error("INVALID_FILENAME", "文件名无效，请重新选择文件。");
  }
  const mime = normalizeMimeType(message.mime);
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
    throw new Tool1Error("INVALID_IMAGE_TYPE", "图片格式不受支持，请重新选择文件。");
  }
  if (
    typeof message.base64 !== "string" ||
    !message.base64 ||
    message.base64.length > MAX_BASE64_LENGTH ||
    message.base64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(message.base64)
  ) {
    throw new Tool1Error("INVALID_IMAGE", "图片内容无效，请重新选择文件。");
  }
  return { env: message.env, filename: message.filename, mime };
}

function decodeImage(base64) {
  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new Tool1Error("INVALID_IMAGE", "图片内容无效，请重新选择文件。");
  }
  if (!binary.length) {
    throw new Tool1Error("EMPTY_UPLOAD", "图片内容为空，请重新选择文件。");
  }
  if (binary.length > MAX_IMAGE_BYTES) {
    throw new Tool1Error("IMAGE_TOO_LARGE", "单张图片超过 30 MiB 限制。");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isExpiredText(text) {
  const normalized = String(text || "").slice(0, 1000).toLowerCase();
  return (
    normalized.includes("expired") ||
    normalized.includes("expire") ||
    normalized.includes("过期")
  );
}

function validateUploadInfo(value) {
  if (!value || typeof value !== "object") {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回了无法识别的数据，请稍后重试。",
    );
  }
  for (const field of REQUIRED_UPLOAD_FIELDS) {
    const item = value[field];
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.includes("\r") ||
      item.includes("\n")
    ) {
      throw new Tool1Error(
        "UPSTREAM_INVALID_RESPONSE",
        "元宝接口返回的上传信息不完整，请稍后重试。",
      );
    }
  }
  if (value.region.trim() !== COS_REGION) {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回了不受支持的存储地域。",
    );
  }
  if (!BUCKET_PATTERN.test(value.bucketName.trim())) {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回的存储桶信息无效。",
    );
  }
  const key = value.location.trim().replace(/^\/+/, "");
  if (!key || key.length > 1024) {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回的存储路径无效。",
    );
  }
  let resourceUrl;
  try {
    resourceUrl = new URL(value.resourceUrl.trim());
  } catch {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回的资源地址无效。",
    );
  }
  if (resourceUrl.protocol !== "https:" || !resourceUrl.hostname) {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回的资源地址无效。",
    );
  }
  return {
    encryptTmpSecretId: value.encryptTmpSecretId.trim(),
    encryptTmpSecretKey: value.encryptTmpSecretKey.trim(),
    region: value.region.trim(),
    encryptToken: value.encryptToken.trim(),
    bucketName: value.bucketName.trim(),
    location: key,
    resourceUrl: resourceUrl.href,
  };
}

async function requestUploadInfo(env, filename, credentials) {
  const environment = UPLOAD_ENVIRONMENTS[env];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(environment.endpoint, {
      method: "POST",
      headers: {
        "x-id": credentials["x-id"],
        "x-token": credentials["x-token"],
        "x-route-env": environment.route,
        "x-source": "app",
        "x-appversion": "9.9.9",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fileName: filename,
        docFrom: "localDoc",
        docOpenId: "",
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Tool1Error(
        "UPSTREAM_TIMEOUT",
        "元宝接口请求超时，请确认已连接内网后重试。",
      );
    }
    throw new Tool1Error(
      "NETWORK_ERROR",
      "无法连接元宝接口，请确认当前电脑已连接内网后重试。",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let responseText = "";
  try {
    responseText = await response.text();
  } catch {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回了无法识别的数据，请稍后重试。",
    );
  }
  if (response.status === 401 || response.status === 403) {
    if (isExpiredText(responseText)) {
      throw new Tool1Error(
        "TOKEN_EXPIRED",
        "当前环境的 token 已过期，请重新构建本机私有扩展包。",
      );
    }
    throw new Tool1Error(
      "AUTH_FAILED",
      "当前环境鉴权失败，请更新本机配置并重新构建私有扩展包。",
    );
  }
  if (!response.ok) {
    throw new Tool1Error(
      "UPSTREAM_ERROR",
      "元宝接口暂时不可用，请稍后重试。",
    );
  }

  let uploadInfo;
  try {
    uploadInfo = JSON.parse(responseText);
  } catch {
    throw new Tool1Error(
      "UPSTREAM_INVALID_RESPONSE",
      "元宝接口返回了无法识别的数据，请稍后重试。",
    );
  }
  return validateUploadInfo(uploadInfo);
}

function encodeCosKey(key) {
  return key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/gu, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

async function uploadToCos(imageBytes, mime, uploadInfo) {
  const host = `${uploadInfo.bucketName}${COS_HOST_SUFFIX}`;
  let authorization;
  try {
    if (!globalThis.COS || typeof globalThis.COS.getAuthorization !== "function") {
      throw new Error("COS signer unavailable");
    }
    authorization = globalThis.COS.getAuthorization({
      SecretId: uploadInfo.encryptTmpSecretId,
      SecretKey: uploadInfo.encryptTmpSecretKey,
      Method: "PUT",
      Key: uploadInfo.location,
      Expires: 900,
      Headers: { Host: host, "Content-Type": mime },
    });
  } catch {
    throw new Tool1Error(
      "COS_SIGN_FAILED",
      "图片上传签名生成失败，请稍后重试。",
    );
  }
  if (typeof authorization !== "string" || !authorization) {
    throw new Tool1Error(
      "COS_SIGN_FAILED",
      "图片上传签名生成失败，请稍后重试。",
    );
  }

  const url = `https://${host}/${encodeCosKey(uploadInfo.location)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COS_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        authorization,
        "x-cos-security-token": uploadInfo.encryptToken,
        "content-type": mime,
      },
      body: new Blob([imageBytes], { type: mime }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Tool1Error(
        "COS_UPLOAD_TIMEOUT",
        "图片上传超时，请确认内网连接正常后重试。",
      );
    }
    throw new Tool1Error(
      "COS_UPLOAD_FAILED",
      "图片上传失败，请确认内网连接正常后重试。",
    );
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Tool1Error(
      "COS_UPLOAD_FAILED",
      "图片上传未成功，请稍后重试。",
    );
  }
}

async function uploadTool1Image(message) {
  const request = validateUploadRequest(message);
  const credentials = getEnvironmentCredentials(request.env);
  if (!credentials) {
    throw new Tool1Error(
      "CONFIG_INCOMPLETE",
      "当前环境未配置，请安装包含本机配置的私有扩展包。",
    );
  }
  const imageBytes = decodeImage(message.base64);
  const uploadInfo = await requestUploadInfo(
    request.env,
    request.filename,
    credentials,
  );
  await uploadToCos(imageBytes, request.mime, uploadInfo);
  return { ok: true, url: uploadInfo.resourceUrl };
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    disableTool3ImageRead(tabId).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const pagePath = getAllowedSenderPath(sender);
  if (!pagePath) return false;

  if (pagePath === TOOL3_PAGE_PATH) {
    if (message && message.type === "ENABLE_TOOL3_IMAGE_READ") {
      enableTool3ImageRead(sender.tab && sender.tab.id)
        .then(sendResponse)
        .catch(() => {
          sendResponse(
            errorResult("EXTENSION_ERROR", "扩展无法启用当前标签页的图片读取。"),
          );
        });
      return true;
    }
    if (message && message.type === "DISABLE_TOOL3_IMAGE_READ") {
      disableTool3ImageRead(sender.tab && sender.tab.id)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
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
  }

  if (message && message.type === "GET_TOOL1_STATUS") {
    sendResponse({ ok: true, capabilities: getTool1Capabilities() });
    return false;
  }
  if (!message || message.type !== "UPLOAD_TOOL1_IMAGE") {
    sendResponse(
      errorResult("INVALID_REQUEST", "扩展收到无法识别的上传请求。"),
    );
    return false;
  }
  uploadTool1Image(message)
    .then(sendResponse)
    .catch((error) => {
      if (error instanceof Tool1Error) {
        sendResponse(errorResult(error.code, error.safeMessage));
        return;
      }
      sendResponse(
        errorResult("EXTENSION_ERROR", "扩展处理上传时发生错误，请重试。"),
      );
    });
  return true;
});