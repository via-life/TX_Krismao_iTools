import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(repoRoot, "js", "tool3.js"), "utf8");

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
      return "blob:test-image";
    }
    static revokeObjectURL() {}
  },
  Uint8Array,
  atob,
  btoa,
  clearTimeout() {},
  console,
  fetch: async (url) => {
    if (String(url).includes("good_image_123")) {
      return {
        ok: true,
        headers: { get: () => "image/png" },
        blob: async () => new Blob(["png"], { type: "image/png" }),
      };
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
context.addEventListener = () => {};
context.postMessage = () => {};
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

const { imageGallery, prepareCaptureImages, isCurrentImageHelperVersion } =
  context.__tool3Test;
const failedUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=expired_image_123";
const goodUrl =
  "https://hunyuan.tencent.com/api/resource/download?resourceId=good_image_123";

const gallery = imageGallery([failedUrl]);
assert.match(gallery, /🔗/u);
assert.ok(gallery.includes(failedUrl));
assert.equal(isCurrentImageHelperVersion("2.0.1"), false);
assert.equal(isCurrentImageHelperVersion("2.1.0"), true);
assert.equal(isCurrentImageHelperVersion("3.0.0"), true);

function captureImage(url) {
  const link = { hidden: false };
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
    complete: false,
    naturalWidth: 0,
    getAttribute(name) {
      return name === "data-url" ? url : "";
    },
    closest(selector) {
      return selector === ".t3-img-item" ? item : link;
    },
    set src(value) {
      this.currentSrc = value;
      if (value.startsWith("blob:")) {
        this.naturalWidth = 1;
        this.onload();
      }
    },
  };
  return { attributes, fallback, image, link };
}

const good = captureImage(goodUrl);
const failed = captureImage(failedUrl);
const root = {
  querySelectorAll() {
    return [good.image, failed.image];
  },
};

await prepareCaptureImages(root);

assert.equal(good.link.hidden, false);
assert.equal(good.fallback.hidden, true);
assert.equal(failed.link.hidden, true);
assert.equal(failed.fallback.hidden, false);
assert.equal(failed.attributes["data-error-code"], "EXTENSION_MISSING");

console.log("tool3 image fallback tests passed");