import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backgroundSource = fs.readFileSync(
  path.join(repoRoot, "chrome-extension", "tool3-image-helper", "background.js"),
  "utf8",
);

const privateConfig = {
  test: {
    "x-id": "test-private-id",
    "x-token": "test-private-token",
  },
  prod: {
    "x-id": "prod-private-id",
    "x-token": "prod-private-token",
  },
};

const tool1Sender = {
  id: "extension-id",
  frameId: 0,
  tab: { id: 7 },
  url: "https://via-life.github.io/TX_Krismao_iTools/tool1.html",
};
const tool3Sender = {
  ...tool1Sender,
  url: "https://via-life.github.io/TX_Krismao_iTools/tool3.html",
};

function createRuntime(config = {}) {
  const state = {
    fetchCalls: [],
    fetchImpl: async () => {
      throw new Error("unexpected fetch");
    },
    imports: [],
    signCalls: [],
    signer: () => "q-sign-algorithm=sha1&safe-signature",
  };
  let listener;
  const context = {};
  Object.assign(context, {
    AbortController,
    Blob,
    DOMException,
    Object,
    Set,
    URL,
    Uint8Array,
    atob,
    btoa,
    clearTimeout,
    setTimeout,
    chrome: {
      runtime: {
        id: "extension-id",
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
    },
    importScripts(...filenames) {
      state.imports.push(...filenames);
      for (const filename of filenames) {
        if (filename === "credentials.js") {
          context.ITOOLS_PRIVATE_CONFIG = JSON.parse(JSON.stringify(config));
        } else if (filename === "cos-js-sdk-v5.min.js") {
          context.COS = {
            getAuthorization(options) {
              state.signCalls.push(options);
              return state.signer(options);
            },
          };
        } else {
          throw new Error(`unexpected importScripts file: ${filename}`);
        }
      }
    },
    async fetch(url, options) {
      state.fetchCalls.push({ url, options });
      return state.fetchImpl(url, options);
    },
  });

  vm.runInNewContext(backgroundSource, context, { filename: "background.js" });
  assert.equal(typeof listener, "function");
  assert.deepEqual(state.imports, ["credentials.js", "cos-js-sdk-v5.min.js"]);
  return { context, listener, state };
}

function send(runtime, message, sender) {
  return new Promise((resolve, reject) => {
    let callbackCalled = false;
    let callbackValue;
    let keepChannel;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("extension response timeout"));
    }, 1000);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    try {
      keepChannel = runtime.listener(message, sender, (value) => {
        callbackCalled = true;
        callbackValue = value;
        if (keepChannel !== undefined) {
          finish({ keepChannel, result: callbackValue });
        }
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }

    if (callbackCalled) finish({ keepChannel, result: callbackValue });
    else if (keepChannel !== true) finish({ keepChannel, result: undefined });
  });
}

function imageResponse(overrides = {}) {
  const headers = new Map([
    ["content-type", "image/png"],
    ["content-length", "3"],
  ]);
  return {
    status: 200,
    ok: true,
    url: "https://hunyuan.tencent.com/api/resource/download?resourceId=valid_id_123",
    headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
    arrayBuffer: async () => Uint8Array.from([137, 80, 78]).buffer,
    ...overrides,
  };
}

function textResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

function uploadInfo(overrides = {}) {
  return {
    encryptTmpSecretId: "temporary-secret-id",
    encryptTmpSecretKey: "temporary-secret-key",
    region: "ap-guangzhou",
    encryptToken: "temporary-security-token",
    bucketName: "private-bucket-1250000000",
    location: "images/folder/test image.png",
    resourceUrl: "https://resource.example.invalid/test-image.png",
    ...overrides,
  };
}

function uploadMessage(overrides = {}) {
  return {
    type: "UPLOAD_TOOL1_IMAGE",
    requestId: "request-1",
    env: "test",
    filename: "Sheet1_A1.png",
    mime: "image/png",
    base64: "iVBORw==",
    ...overrides,
  };
}

function installSuccessfulUploadFetch(runtime, info = uploadInfo()) {
  runtime.state.fetchImpl = async (url) => {
    if (url.endsWith("/api/resource/genUploadInfo")) {
      return textResponse(200, JSON.stringify(info));
    }
    if (url.startsWith("https://private-bucket-1250000000.cos-internal.")) {
      return { status: 200, ok: true };
    }
    throw new Error("unexpected URL");
  };
}

// Demand 3 remains isolated to its fixed page, endpoint and current login session.
const tool3Runtime = createRuntime();
const rejectedSender = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  { ...tool3Sender, url: "https://example.invalid/tool3.html" },
);
assert.equal(rejectedSender.keepChannel, false);
assert.equal(tool3Runtime.state.fetchCalls.length, 0);

const invalidId = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "../bad" },
  tool3Sender,
);
assert.equal(invalidId.result.error.code, "INVALID_RESOURCE_ID");
assert.equal(tool3Runtime.state.fetchCalls.length, 0);

tool3Runtime.state.fetchImpl = async () => imageResponse();
const imageSuccess = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  tool3Sender,
);
assert.equal(imageSuccess.result.ok, true);
assert.equal(imageSuccess.result.mime, "image/png");
assert.equal(imageSuccess.result.base64, "iVBO");
assert.equal(
  tool3Runtime.state.fetchCalls[0].url,
  "https://hunyuan.tencent.com/api/resource/download?resourceId=valid_id_123",
);
assert.equal(tool3Runtime.state.fetchCalls[0].options.credentials, "include");
assert.equal(tool3Runtime.state.fetchCalls[0].options.cache, "no-store");
assert.equal(tool3Runtime.state.fetchCalls[0].options.redirect, "follow");

tool3Runtime.state.fetchImpl = async () => imageResponse({ status: 403, ok: false });
const imageUnauthorized = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  tool3Sender,
);
assert.equal(imageUnauthorized.result.error.code, "IMAGE_AUTH_REQUIRED");

tool3Runtime.state.fetchImpl = async () => imageResponse({ status: 404, ok: false });
const imageNotFound = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  tool3Sender,
);
assert.equal(imageNotFound.result.error.code, "IMAGE_NOT_FOUND");

tool3Runtime.state.fetchImpl = async () =>
  imageResponse({ url: "https://example.invalid/image.png" });
const redirectedImage = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  tool3Sender,
);
assert.equal(redirectedImage.result.error.code, "INVALID_IMAGE_RESPONSE");

tool3Runtime.state.fetchImpl = async () =>
  imageResponse({
    headers: {
      get: (name) =>
        String(name).toLowerCase() === "content-type" ? "image/svg+xml" : "20",
    },
  });
const svgImage = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  tool3Sender,
);
assert.equal(svgImage.result.error.code, "INVALID_IMAGE_RESPONSE");

tool3Runtime.state.fetchImpl = async () =>
  imageResponse({
    headers: {
      get: (name) =>
        String(name).toLowerCase() === "content-type"
          ? "image/png"
          : String(31 * 1024 * 1024),
    },
  });
const oversizedImage = await send(
  tool3Runtime,
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  tool3Sender,
);
assert.equal(oversizedImage.result.error.code, "IMAGE_TOO_LARGE");

// The public package exposes no upload readiness.
const publicRuntime = createRuntime();
const publicStatus = await send(
  publicRuntime,
  { type: "GET_TOOL1_STATUS" },
  tool1Sender,
);
assert.equal(publicStatus.keepChannel, false);
assert.equal(publicStatus.result.ok, true);
assert.equal(publicStatus.result.capabilities.tool1UploadReady, false);
assert.equal(publicStatus.result.capabilities.testReady, false);
assert.equal(publicStatus.result.capabilities.prodReady, false);

// Test and production upload requests use only fixed endpoints and fixed headers.
const privateRuntime = createRuntime(privateConfig);
const privateStatus = await send(
  privateRuntime,
  { type: "GET_TOOL1_STATUS" },
  tool1Sender,
);
assert.equal(privateStatus.result.capabilities.tool1UploadReady, true);
assert.equal(privateStatus.result.capabilities.testReady, true);
assert.equal(privateStatus.result.capabilities.prodReady, true);

installSuccessfulUploadFetch(privateRuntime);
const testUpload = await send(
  privateRuntime,
  uploadMessage({ url: "https://attacker.invalid/must-not-be-used" }),
  tool1Sender,
);
assert.equal(testUpload.result.ok, true);
assert.equal(testUpload.result.url, "https://resource.example.invalid/test-image.png");
assert.equal(privateRuntime.state.fetchCalls.length, 2);

const testInfoCall = privateRuntime.state.fetchCalls[0];
assert.equal(
  testInfoCall.url,
  "https://yuanbao.test.hunyuan.woa.com/api/resource/genUploadInfo",
);
assert.equal(testInfoCall.options.method, "POST");
assert.equal(testInfoCall.options.headers["x-id"], "test-private-id");
assert.equal(testInfoCall.options.headers["x-token"], "test-private-token");
assert.equal(testInfoCall.options.headers["x-route-env"], "ci-613");
assert.equal(testInfoCall.options.headers["x-source"], "app");
assert.equal(testInfoCall.options.headers["x-appversion"], "9.9.9");
assert.equal(testInfoCall.options.headers["content-type"], "application/json");
assert.deepEqual(JSON.parse(testInfoCall.options.body), {
  fileName: "Sheet1_A1.png",
  docFrom: "localDoc",
  docOpenId: "",
});
assert.equal(testInfoCall.options.credentials, "omit");
assert.equal(testInfoCall.options.cache, "no-store");
assert.equal(testInfoCall.options.redirect, "error");

assert.equal(privateRuntime.state.signCalls.length, 1);
const signCall = privateRuntime.state.signCalls[0];
assert.equal(signCall.SecretId, "temporary-secret-id");
assert.equal(signCall.SecretKey, "temporary-secret-key");
assert.equal(signCall.Method, "PUT");
assert.equal(signCall.Key, "images/folder/test image.png");
assert.equal(signCall.Expires, 900);
assert.equal(
  signCall.Headers.Host,
  "private-bucket-1250000000.cos-internal.ap-guangzhou.tencentcos.cn",
);
assert.equal(signCall.Headers["Content-Type"], "image/png");

const cosCall = privateRuntime.state.fetchCalls[1];
assert.equal(
  cosCall.url,
  "https://private-bucket-1250000000.cos-internal.ap-guangzhou.tencentcos.cn/" +
    "images/folder/test%20image.png",
);
assert.equal(cosCall.options.method, "PUT");
assert.equal(cosCall.options.headers.authorization, "q-sign-algorithm=sha1&safe-signature");
assert.equal(cosCall.options.headers["x-cos-security-token"], "temporary-security-token");
assert.equal(cosCall.options.headers["content-type"], "image/png");
assert.equal(cosCall.options.body instanceof Blob, true);
assert.equal(cosCall.options.body.size, 4);
assert.equal(cosCall.options.credentials, "omit");
assert.equal(cosCall.options.redirect, "error");
assert.equal(privateRuntime.state.fetchCalls.some((call) => call.url.includes("attacker.invalid")), false);
assert.equal(JSON.stringify(testUpload).includes("private-token"), false);
assert.equal(JSON.stringify(testUpload).includes("temporary-secret"), false);

privateRuntime.state.fetchCalls.length = 0;
privateRuntime.state.signCalls.length = 0;
installSuccessfulUploadFetch(privateRuntime);
const prodUpload = await send(
  privateRuntime,
  uploadMessage({ requestId: "request-prod", env: "prod" }),
  tool1Sender,
);
assert.equal(prodUpload.result.ok, true);
const prodInfoCall = privateRuntime.state.fetchCalls[0];
assert.equal(
  prodInfoCall.url,
  "https://yuanbao.tencent.com/api/resource/genUploadInfo",
);
assert.equal(prodInfoCall.options.headers["x-id"], "prod-private-id");
assert.equal(prodInfoCall.options.headers["x-token"], "prod-private-token");
assert.equal(prodInfoCall.options.headers["x-route-env"], "--");

privateRuntime.state.fetchCalls.length = 0;
const invalidEnvironment = await send(
  privateRuntime,
  uploadMessage({ env: "https://attacker.invalid/upload" }),
  tool1Sender,
);
assert.equal(invalidEnvironment.result.error.code, "INVALID_ENV");
assert.equal(privateRuntime.state.fetchCalls.length, 0);

const wrongPage = await send(
  privateRuntime,
  uploadMessage(),
  tool3Sender,
);
assert.equal(wrongPage.result.error.code, "INVALID_REQUEST");
assert.equal(privateRuntime.state.fetchCalls.length, 0);

// Authentication, malformed upstream data, signer and COS failures stay redacted.
const expiredRuntime = createRuntime(privateConfig);
expiredRuntime.state.fetchImpl = async () =>
  textResponse(403, "expired upstream-secret-response");
const expired = await send(expiredRuntime, uploadMessage(), tool1Sender);
assert.equal(expired.result.error.code, "TOKEN_EXPIRED");

const authRuntime = createRuntime(privateConfig);
authRuntime.state.fetchImpl = async () =>
  textResponse(403, "denied upstream-secret-response");
const authFailed = await send(authRuntime, uploadMessage(), tool1Sender);
assert.equal(authFailed.result.error.code, "AUTH_FAILED");

const malformedRuntime = createRuntime(privateConfig);
malformedRuntime.state.fetchImpl = async () =>
  textResponse(200, JSON.stringify({ secret: "upstream-secret-response" }));
const malformed = await send(malformedRuntime, uploadMessage(), tool1Sender);
assert.equal(malformed.result.error.code, "UPSTREAM_INVALID_RESPONSE");

const networkRuntime = createRuntime(privateConfig);
networkRuntime.state.fetchImpl = async () => {
  throw new Error("upstream-secret-response");
};
const networkFailed = await send(networkRuntime, uploadMessage(), tool1Sender);
assert.equal(networkFailed.result.error.code, "NETWORK_ERROR");

const signRuntime = createRuntime(privateConfig);
installSuccessfulUploadFetch(signRuntime);
signRuntime.state.signer = () => {
  throw new Error("upstream-secret-response");
};
const signFailed = await send(signRuntime, uploadMessage(), tool1Sender);
assert.equal(signFailed.result.error.code, "COS_SIGN_FAILED");
assert.equal(signRuntime.state.fetchCalls.length, 1);

const cosRuntime = createRuntime(privateConfig);
cosRuntime.state.fetchImpl = async (url) => {
  if (url.endsWith("/api/resource/genUploadInfo")) {
    return textResponse(200, JSON.stringify(uploadInfo()));
  }
  return { status: 500, ok: false };
};
const cosFailed = await send(cosRuntime, uploadMessage(), tool1Sender);
assert.equal(cosFailed.result.error.code, "COS_UPLOAD_FAILED");

for (const response of [expired, authFailed, malformed, networkFailed, signFailed, cosFailed]) {
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes("upstream-secret-response"), false);
  assert.equal(serialized.includes("private-token"), false);
  assert.equal(serialized.includes("temporary-secret"), false);
}

console.log("combined tool1/tool3 extension runtime tests passed");
