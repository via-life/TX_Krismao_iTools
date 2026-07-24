import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = {
  window: {},
  URL,
  Blob,
  Uint8Array,
  ArrayBuffer,
};
vm.runInNewContext(
  fs.readFileSync(path.join(repoRoot, "js", "tool3-data.js"), "utf8"),
  context,
);

const parseConversation = context.window.Tool3Data.parseConversation;

const valid = parseConversation(
  '[{"role":"user","content":"问题"},{"role":"assistant","content":"回答"}]',
);
assert.equal(valid.length, 2);
assert.deepEqual(Array.from(valid, (message) => message.role), ["user", "assistant"]);

const rawControlCharacters =
  '[{"role":"user","content":"第一行\n第二行\t缩进"},' +
  '{"role":"assistant","content":"回答"}]';
const repaired = parseConversation(rawControlCharacters);
assert.equal(repaired.length, 2);
assert.equal(repaired[0].text, "第一行\n第二行\t缩进");
assert.equal(repaired[1].text, "回答");

assert.deepEqual(Array.from(parseConversation('[{"role":]')), []);

console.log("tool3-data parser tests passed");
