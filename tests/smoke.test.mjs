import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const readJSON = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));

const en = readJSON("../src/i18n/en.json");
const zhCN = readJSON("../src/i18n/zh-CN.json");

test("en.json and zh-CN.json expose exactly the same keys", () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort());
    assert.ok(Object.keys(en).length > 0, "i18n key set must not be empty");
});

test("plugin.json and package.json agree on the package name", () => {
    const expected = "siyuan-underline-enhancement";
    assert.equal(readJSON("../plugin.json").name, expected);
    assert.equal(readJSON("../package.json").name, expected);
});
