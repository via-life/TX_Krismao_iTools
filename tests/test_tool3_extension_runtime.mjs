import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let listener;
let fetchCalls = [];
let nextResponse;
const context = {
  AbortController,
  DOMException,
  Object,
  Set,
  URL,
  Uint8Array,
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
  async fetch(url, options) {
    fetchCalls.push({ url, options });
    return nextResponse;
  },
};

vm.runInNewContext(
  fs.readFileSync(
    path.join(repoRoot, "chrome-extension", "tool3-image-helper", "background.js"),
    "utf8",
  ),
  context,
);

const validSender = {
  id: "extension-id",
  frameId: 0,
  tab: { id: 7 },
  url: "https://via-life.github.io/TX_Krismao_iTools/tool3.html",
};

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

function send(message, sender = validSender) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("extension response timeout")), 1000);
    const keepChannel = listener(message, sender, (result) => {
      clearTimeout(timer);
      resolve({ keepChannel, result });
    });
    if (!keepChannel) {
      clearTimeout(timer);
      resolve({ keepChannel, result: undefined });
    }
  });
}

fetchCalls = [];
const rejectedSender = await send(
  { type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" },
  { ...validSender, url: "https://example.invalid/tool3.html" },
);
assert.equal(rejectedSender.keepChannel, false);
assert.equal(fetchCalls.length, 0);

const invalidId = await send({ type: "FETCH_HUNYUAN_IMAGE", resourceId: "../bad" });
assert.equal(invalidId.result.error.code, "INVALID_RESOURCE_ID");
assert.equal(fetchCalls.length, 0);

nextResponse = imageResponse();
const success = await send({ type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" });
assert.equal(success.result.ok, true);
assert.equal(success.result.mime, "image/png");
assert.equal(success.result.base64, "iVBO");
assert.equal(fetchCalls.length, 1);
assert.equal(
  fetchCalls[0].url,
  "https://hunyuan.tencent.com/api/resource/download?resourceId=valid_id_123",
);
assert.equal(fetchCalls[0].options.credentials, "include");
assert.equal(fetchCalls[0].options.cache, "no-store");
assert.equal(fetchCalls[0].options.redirect, "follow");

nextResponse = imageResponse({
  url: "https://example.invalid/image.png",
});
const redirected = await send({ type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" });
assert.equal(redirected.result.error.code, "INVALID_IMAGE_RESPONSE");

nextResponse = imageResponse({ status: 403, ok: false });
const unauthorized = await send({ type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" });
assert.equal(unauthorized.result.error.code, "IMAGE_AUTH_REQUIRED");

nextResponse = imageResponse({
  headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "image/svg+xml" : "20" },
});
const svg = await send({ type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" });
assert.equal(svg.result.error.code, "INVALID_IMAGE_RESPONSE");

nextResponse = imageResponse({
  headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "image/png" : String(31 * 1024 * 1024) },
});
const oversized = await send({ type: "FETCH_HUNYUAN_IMAGE", resourceId: "valid_id_123" });
assert.equal(oversized.result.error.code, "IMAGE_TOO_LARGE");

for (const result of [invalidId, redirected, unauthorized, svg, oversized]) {
  assert.equal(JSON.stringify(result).includes("upstream-secret"), false);
}

console.log("tool3 extension runtime tests passed");
