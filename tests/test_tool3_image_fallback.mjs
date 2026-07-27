import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(repoRoot, "js", "tool3.js"), "utf8");
const validPngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const invalidJsonBytes = new TextEncoder().encode('{"error":"expired"}');
let extensionFetchCallCount = 0;
let fetchCallCount = 0;
let objectUrlSequence = 0;
const windowListeners = new Map();

function imageResponse(mime, bytes) {
  return {
    ok: true,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "content-type") return mime;
        if (key === "content-length") return String(bytes.byteLength);
        return null;
      },
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function elementStub() {
  return {
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    hidden: false,
    style: {},
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  };
}

const elements = new Map();
const context = {
  AbortController,
  Blob,
  Promise,
  URL: class TestURL extends URL {
    static createObjectURL() {
      objectUrlSequence += 1;
      return `blob:test-image-${objectUrlSequence}`;
    }
    static revokeObjectURL() {}
  },
  Uint8Array,
  atob,
  btoa,
  clearTimeout() {},
  console,
  fetch: async (url) => {
    fetchCallCount += 1;
    const value = String(url);
    if (value.includes("preview_image_123")) {
      return imageResponse("image/png", validPngBytes);
    }
    if (value.includes("good_image_123")) {
      return imageResponse("image/png", validPngBytes);
    }
    if (value.includes("octet_image_123")) {
      return imageResponse("application/octet-stream", validPngBytes);
    }
    if (value.includes("bad_octet_123")) {
      return imageResponse("application/octet-stream", invalidJsonBytes);
    }
    throw new TypeError("cross-origin image unavailable");
  },
  requestAnimationFrame(callback) {
    callback();
  },
  setTimeout() {
    return 1;
  },
};

context.window = context;
context.location = {
  origin: "https://via-life.github.io",
};
context.addEventListener = (type, callback) => {
  if (!windowListeners.has(type)) windowListeners.set(type, []);
  windowListeners.get(type).push(callback);
};
function emitExtensionMessage(data) {
  for (const callback of windowListeners.get("message") || []) {
    callback({
      data,
      origin: context.location.origin,
      source: vm.runInNewContext("window", context),
    });
  }
}
context.postMessage = (message) => {
  if (
    message?.source === "itools-tool3-page" &&
    message.type === "FETCH_HUNYUAN_IMAGE"
  ) {
    extensionFetchCallCount += 1;
    queueMicrotask(() => {
      emitExtensionMessage({
        source: "itools-tool3-extension",
        type: "IMAGE_RESULT",
        requestId: message.requestId,
        ok: true,
        mime: "image/png",
        base64: "iVBORw0KGgo=",
      });
    });
  }
};
context.iTools = {
  bindFileInput() {},
  downloadBlob() {},
  escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  },
};
context.Tool3Data = {
  isSafeImageUrl() {
    return true;
  },
};
context.Mapping = {
  open() {},
  run() {},
};
context.document = {
  body: { classList: { add() {}, remove() {} } },
  addEventListener() {},
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, elementStub());
    return elements.get(id);
  },
};
context.navigator = {};

vm.runInNewContext(source, context, { filename: "tool3.js" });

const {
  bindPreviewImages,
  imageGallery,
  prepareCaptureImages,
  isCurrentImageHelperVersion,
} = context.__tool3Test;
const failedUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=expired_image_123";
const previewUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=preview_image_123";
const goodUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=good_image_123";
const octetUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=octet_image_123";
const badOctetUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=bad_octet_123";
const extensionUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=extension_image_123";

const gallery = imageGallery([failedUrl]);
assert.match(gallery, /🔗/u);
assert.ok(gallery.includes(failedUrl));
assert.equal(isCurrentImageHelperVersion("2.0.1"), false);
assert.equal(isCurrentImageHelperVersion("2.1.0"), false);
assert.equal(isCurrentImageHelperVersion("2.1.1"), true);
assert.equal(isCurrentImageHelperVersion("3.0.0"), true);

function captureImage(url) {
  const link = { hidden: false, addEventListener() {} };
  const attributes = {};
  const fallback = {
    hidden: true,
    removeAttribute(name) {
      delete attributes[name];
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
  };
  const item = {
    querySelector(selector) {
      return selector === ".t3-img-item__link" ? link : fallback;
    },
  };
  const image = {
    assignedSources: [],
    complete: false,
    naturalWidth: 0,
    getAttribute(name) {
      return name === "data-url" ? url : "";
    },
    closest(selector) {
      return selector === ".t3-img-item" ? item : link;
    },
    set src(value) {
      this.assignedSources.push(value);
      this.currentSrc = value;
      if (value.startsWith("blob:")) {
        this.naturalWidth = 1;
        this.onload();
      }
    },
  };
  return { attributes, fallback, image, link };
}

const preview = captureImage(previewUrl);
const previewRoot = {
  querySelectorAll() {
    return [preview.image];
  },
};
await bindPreviewImages(previewRoot);
assert.equal(fetchCallCount, 1);
assert.deepEqual(preview.image.assignedSources, ["blob:test-image-1"]);
assert.equal(preview.link.hidden, false);
assert.equal(preview.fallback.hidden, true);
await prepareCaptureImages(previewRoot);
assert.equal(fetchCallCount, 1);
assert.deepEqual(preview.image.assignedSources, ["blob:test-image-1"]);

const good = captureImage(goodUrl);
const octet = captureImage(octetUrl);
const badOctet = captureImage(badOctetUrl);
const failed = captureImage(failedUrl);
const root = {
  querySelectorAll() {
    return [good.image, octet.image, badOctet.image, failed.image];
  },
};

await prepareCaptureImages(root);
assert.equal(fetchCallCount, 5);
await prepareCaptureImages(root);
assert.equal(fetchCallCount, 5);

assert.equal(good.link.hidden, false);
assert.equal(good.fallback.hidden, true);
assert.equal(octet.link.hidden, false);
assert.equal(octet.fallback.hidden, true);
assert.equal(badOctet.link.hidden, true);
assert.equal(badOctet.fallback.hidden, false);
assert.equal(badOctet.attributes["data-error-code"], "EXTENSION_MISSING");
assert.equal(failed.link.hidden, true);
assert.equal(failed.fallback.hidden, false);
assert.equal(failed.attributes["data-error-code"], "EXTENSION_MISSING");

const failedAgain = captureImage(failedUrl);
const failedAgainRoot = {
  querySelectorAll() {
    return [failedAgain.image];
  },
};
await bindPreviewImages(failedAgainRoot);
assert.equal(fetchCallCount, 5);
assert.equal(failedAgain.link.hidden, true);
assert.equal(failedAgain.fallback.hidden, false);
assert.equal(failedAgain.attributes["data-error-code"], "EXTENSION_MISSING");

emitExtensionMessage({
  source: "itools-tool3-extension",
  type: "PONG",
  version: "2.1.1",
});
const extensionPreview = captureImage(extensionUrl);
const extensionRoot = {
  querySelectorAll() {
    return [extensionPreview.image];
  },
};
await bindPreviewImages(extensionRoot);
assert.equal(extensionFetchCallCount, 1);
assert.equal(fetchCallCount, 5);
assert.equal(extensionPreview.image.assignedSources.length, 1);
assert.match(extensionPreview.image.assignedSources[0], /^blob:/u);
assert.equal(extensionPreview.fallback.hidden, true);
await prepareCaptureImages(extensionRoot);
assert.equal(extensionFetchCallCount, 1);
assert.equal(fetchCallCount, 5);

console.log("tool3 image fallback tests passed");
