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

// minAppVersion 低于 3.8.6 会让插件调用当时并不存在的 addToolbarItem，因此钉死该下界。
test("plugin.json pins minAppVersion to 3.8.6", () => {
    assert.equal(readJSON("../plugin.json").minAppVersion, "3.8.6");
});

test("plugin.json runs on every frontend, backend and kernel", () => {
    const manifest = readJSON("../plugin.json");
    assert.deepEqual(manifest.frontends, ["all"]);
    assert.deepEqual(manifest.backends, ["all"]);
    assert.deepEqual(manifest.kernels, ["all"]);
});

test("plugin.json stays enabled in published workspaces", () => {
    assert.equal(readJSON("../plugin.json").disabledInPublish, false);
});
