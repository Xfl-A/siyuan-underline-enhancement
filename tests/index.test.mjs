// 插件接线测试：在 jsdom 里摆一个思源编辑器（浮动工具栏 + 带 data-node-id 的块），
// 用真实的 panel.ts / dom.ts / persist.ts / model.ts 跑完整链路，只有 "siyuan" 模块与 Plugin 基类是桩。
//
// 这样断言的不是「某个函数被调用过」，而是「用户点一下之后文档与面板分别变成什么样」：
// 装饰 span 真的落进了块、保存真的按块发了 updateBlock、面板的选中态真的跟着文档走。
import {JSDOM} from "jsdom";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {
    loadModule,
    toHost,
} from "./helpers/loadModule.mjs";

const i18n = JSON.parse(readFileSync(new URL("../src/i18n/zh-CN.json", import.meta.url), "utf8"));

const BLOCK_A = "20261003220000-a1";
const BLOCK_B = "20261003220000-b2";

const TOOLBAR_ITEM_NAME = "underline-enhancement";
const ICON_ID = "iconUnderlineEnhancement";
const UPDATE_BLOCK_API = "/api/block/updateBlock";
/** 插件私有存储文件名，与 src/index.ts 里的常量一致 */
const SETTINGS_FILE = "settings.json";
/** 防抖保存窗口（ms），与 src/index.ts 的常量一致 */
const SAVE_DEBOUNCE_MS = 300;

/** 装饰 span 的落盘形态：data-sue 标记 + 完整的 inline style */
const DECORATED_UNDERLINE = /<span data-sue="u"[^>]*text-decoration-style: wavy[^>]*>/;

/** 单块选区：一个只有纯文本的段落 */
const SINGLE_BLOCK_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">hello</p>`;
/** 双块选区：两个并列段落，用来验证「每个受影响块独立保存一次」 */
const TWO_BLOCKS_HTML = SINGLE_BLOCK_HTML + `<p data-type="text" data-node-id="${BLOCK_B}">world</p>`;

/** 已装饰的块：外层上划线、内层下划线，正是 composePair 的嵌套输出 */
const NESTED_CSS = {
    overline: "text-decoration-line: overline; text-decoration-style: dotted; text-decoration-color: #0090ff",
    underline: "text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #e5484d",
};
const NESTED_HTML = `<p data-type="text" data-node-id="${BLOCK_A}"><span data-sue="o" style="${NESTED_CSS.overline}">` +
    `<span data-sue="u" style="${NESTED_CSS.underline}">hello</span></span></p>`;

const OK_RESPONSE = {code: 0, msg: "", data: null};
const FAILED_RESPONSE = {code: -1, msg: "kernel busy", data: null};

/** 等防抖窗口过去。用真实计时器而不是假时钟：慢机器上只是多等一会儿，却不会漏掉真实行为 */
const settle = () => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 50));

/** 让已经排队的 Promise 回调跑完（撤销是 async 的） */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 一个用例一套独立的 jsdom、独立的模块实例与独立的思源桩。
 * 撤销栈与「记住的上次配置」都是模块级 / 实例级状态，共享实例会让用例互相依赖。
 */
const createFixture = (options = {}) => {
    const blocks = options.blocks ?? SINGLE_BLOCK_HTML;
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body><div class="fn__toolbar" id="anchor"></div>' +
            '<div class="protyle-wysiwyg" id="editor"></div></body></html>',
        {pretendToBeVisual: true},
    );
    const {window} = dom;
    const {document} = window;
    document.getElementById("editor").innerHTML = blocks;
    // 只读 / 发布是插件在 onload 里读的两个开关，必须在实例化插件之前就位
    window.siyuan = {
        config: {readonly: options.readonly === true},
        isPublish: options.isPublish === true,
    };

    const calls = {icons: [], toolbarItems: [], removedItems: [], loadedFiles: [], savedFiles: [], messages: []};
    const posts = [];
    let responses = [];

    const fetchSyncPost = async (url, data) => {
        posts.push({url, data});
        return responses.length > 0 ? responses.shift() : OK_RESPONSE;
    };

    /** eventBus 桩：只提供 on / off / emit 三件事，够 src/index.ts 挂监听与测试触发用 */
    const listeners = new Map();
    const eventBus = {
        on(type, listener) {
            listeners.set(type, (listeners.get(type) ?? []).concat(listener));
        },
        off(type, listener) {
            listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
        },
        emit(type) {
            for (const listener of [...(listeners.get(type) ?? [])]) {
                listener({detail: undefined});
            }
        },
    };

    /** Plugin 基类桩：只提供 src/index.ts 真正用到的那几个成员 */
    class Plugin {
        constructor() {
            this.name = "siyuan-underline-enhancement";
            this.i18n = i18n;
            this.data = options.data ?? {};
            this.eventBus = eventBus;
        }

        addIcons(svg) {
            calls.icons.push(svg);
        }

        addToolbarItem(item) {
            calls.toolbarItems.push(item);
        }

        removeToolbarItem(name) {
            calls.removedItems.push(name);
        }

        async loadData(name) {
            calls.loadedFiles.push(name);
            if (options.loadFails === true) {
                throw new Error("load data fail");
            }
            return this.data[name];
        }

        async saveData(name, value) {
            calls.savedFiles.push({name, value});
            return OK_RESPONSE;
        }
    }

    const siyuan = {
        Plugin,
        getFrontend: () => "desktop",
        showMessage: (message) => calls.messages.push(message),
        fetchSyncPost,
    };

    // 每个模块一个 realm，globals 里必须补齐它们各自摸到的浏览器全局
    const model = loadModule("src/model.ts");
    const domModule = loadModule("src/dom.ts", {
        dependencies: {siyuan},
        globals: {Node: window.Node, NodeFilter: window.NodeFilter, setTimeout, clearTimeout},
    });
    const persistModule = loadModule("src/persist.ts", {
        dependencies: {siyuan},
        globals: {document, setTimeout, clearTimeout},
    });
    const panelModule = loadModule("src/panel.ts", {
        dependencies: {"./model": model, "./dom": domModule},
        globals: {document, setTimeout, clearTimeout},
    });
    const indexModule = loadModule("src/index.ts", {
        dependencies: {
            siyuan,
            "./model": model,
            "./dom": domModule,
            "./panel": panelModule,
            "./persist": persistModule,
            "./icons": loadModule("src/icons.ts"),
            // index.ts 带一条副作用的样式导入，webpack 交给 sass-loader，测试里只需一个空桩
            "./index.scss": {},
        },
        globals: {window, document, setTimeout, clearTimeout},
    });
    const plugin = new indexModule.default();

    /** 造一个思源形态的 protyle：工具栏项的 click 收到的是 Protyle 类实例，浮动工具栏在它的 .protyle 上 */
    const protyleOf = (range) => {
        const toolbar = {
            element: document.getElementById("anchor"),
            range,
            subElementCloseCB: () => {},
        };
        return {protyle: {element: document.getElementById("editor"), toolbar}, toolbar};
    };

    // 偏移换算在测试侧独立写一遍：复用被测代码的同一份逻辑会让断言变成自证。
    // 交界处的比较符必须与 src/dom.ts 的 locate 一致（都归前一个节点的末尾）。
    const textNodesOf = (element) => {
        const nodes = [];
        const walker = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            nodes.push(node);
        }
        return nodes;
    };

    const locate = (element, offset) => {
        let remaining = offset;
        let last = null;
        for (const text of textNodesOf(element)) {
            if (remaining <= text.data.length) {
                return {node: text, offset: remaining};
            }
            remaining -= text.data.length;
            last = text;
        }
        return last === null ? null : {node: last, offset: last.data.length};
    };

    /** 按字符偏移（相对 element.textContent）造选区；元素不同即跨块选区 */
    const rangeBetween = (fromElement, fromOffset, toElement, toOffset) => {
        const from = locate(fromElement, fromOffset);
        const to = locate(toElement, toOffset);
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        return range;
    };

    const block = (blockId) => document.querySelector(`[data-node-id="${blockId}"]`);
    const blockHTML = (blockId) => block(blockId).outerHTML;
    /** 默认选区：整段选中唯一的那个块 */
    const singleRange = () => {
        const element = block(BLOCK_A);
        return rangeBetween(element, 0, element, element.textContent.length);
    };
    /** 跨块选区：从第一个块开头选到第二个块结尾 */
    const crossRange = () => rangeBetween(block(BLOCK_A), 0, block(BLOCK_B), block(BLOCK_B).textContent.length);

    const clickToolbarItem = (protyle = protyleOf(singleRange())) => {
        const item = calls.toolbarItems[calls.toolbarItems.length - 1];
        assert.ok(item, "工具栏项应当已注册");
        item.click(protyle);
        return protyle;
    };

    const panelElement = () => document.querySelector("[data-sue-panel]");
    const sectionOf = (direction) => panelElement().querySelector(`[data-sue-section="${direction}"]`);
    const switchOf = (direction) => sectionOf(direction).querySelector("[data-sue-switch]");
    const styleSwatchOf = (direction, style) => sectionOf(direction).querySelector(`[data-sue-style="${style}"]`);
    const colorSwatchOf = (direction, color) => sectionOf(direction).querySelector(`[data-sue-color="${color}"]`);
    const followSwatchOf = (direction) => sectionOf(direction).querySelector("[data-sue-follow-color]");
    const actionButton = (action) => panelElement().querySelector(`[data-sue-action="${action}"]`);
    const pressed = (element) => element.getAttribute("aria-pressed") === "true";

    const click = (element) => element.dispatchEvent(new window.MouseEvent("click", {bubbles: true}));
    const toggle = (element, checked) => {
        element.checked = checked;
        element.dispatchEvent(new window.Event("change", {bubbles: true}));
    };

    return {
        document,
        calls,
        posts,
        module: indexModule,
        plugin,
        protyleOf,
        singleRange,
        crossRange,
        block,
        blockHTML,
        clickToolbarItem,
        panelElement,
        sectionOf,
        switchOf,
        styleSwatchOf,
        colorSwatchOf,
        followSwatchOf,
        actionButton,
        pressed,
        click,
        toggle,
        respondWith: (...queued) => {
            responses = responses.concat(queued);
        },
    };
};

test("onload 注入图标并注册带稳定标识的工具栏项", () => {
    const {calls, module, plugin} = createFixture();
    plugin.onload();
    // 标识必须由模块导出：注册与反注册两处引用同一个常量，拼错就反注册不掉
    assert.equal(module.TOOLBAR_ITEM_NAME, TOOLBAR_ITEM_NAME);
    assert.equal(calls.icons.length, 1);
    assert.equal(calls.toolbarItems.length, 1);
    const [item] = calls.toolbarItems;
    assert.equal(item.name, TOOLBAR_ITEM_NAME);
    assert.equal(item.icon, ICON_ID);
    assert.equal(item.tip, i18n.underlineEnhancement);
    assert.equal(item.tipPosition, "n");
    assert.equal(typeof item.click, "function");
});

test("图标沿用 Lucide underline 的路径数据，并把描边宽度收到思源工具栏的粗细", () => {
    const {UNDERLINE_ICON_SVG} = loadModule("src/icons.ts");
    assert.match(UNDERLINE_ICON_SVG, /viewBox="0 0 24 24"/);
    assert.match(UNDERLINE_ICON_SVG, /d="M6 4v6a6 6 0 0 0 12 0V4"/);
    assert.match(UNDERLINE_ICON_SVG, /<line x1="4" x2="20" y1="20" y2="20"\/>/);
    // 思源对工具栏图标统一声明 fill: currentColor; stroke-width: 0，symbol 上必须自己再声明一次
    assert.match(UNDERLINE_ICON_SVG, /fill="none"/);
    assert.match(UNDERLINE_ICON_SVG, /stroke-width="1\.5"/);
});

test("onunload 移除工具栏项", () => {
    const {calls, plugin} = createFixture();
    plugin.onload();
    plugin.onunload();
    assert.deepEqual(calls.removedItems, [TOOLBAR_ITEM_NAME]);
});

test("onload 从未执行过时 onunload 也不抛错，且可重复执行", () => {
    const {calls, plugin} = createFixture();
    assert.doesNotThrow(() => plugin.onunload());
    assert.doesNotThrow(() => plugin.onunload());
    assert.deepEqual(calls.removedItems, [TOOLBAR_ITEM_NAME, TOOLBAR_ITEM_NAME]);
});

test("点击工具栏项创建带 data-sue-panel 的面板，并接管浮动工具栏的关闭回调", () => {
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    const originalCloseCB = protyle.toolbar.subElementCloseCB;
    f.clickToolbarItem(protyle);
    assert.ok(f.panelElement(), "面板应当已挂到 document.body 上");
    assert.equal(typeof protyle.toolbar.subElementCloseCB, "function");
    assert.notEqual(protyle.toolbar.subElementCloseCB, originalCloseCB);
    // 面板挂在 body 上，不跟着浮动工具栏走；思源关闭工具栏时必须由它来收摊
    protyle.toolbar.subElementCloseCB();
    assert.equal(f.panelElement(), null);
    // 收摊之后把思源原来的回调还回去，别把插件的回调留在它的对象上
    assert.equal(protyle.toolbar.subElementCloseCB, originalCloseCB);
});

test("面板里的改动落到选区上，跨块时每个块各发一次 updateBlock", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    // 装饰立刻出现在编辑器里，保存仍在防抖窗口内
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE);
    assert.deepEqual(f.posts, []);
    await settle();
    // 两个块两个 id：传错记账键会被防抖保存器并成一次，只剩最后一个块落盘
    assert.deepEqual(f.posts.map((post) => post.url), [UPDATE_BLOCK_API, UPDATE_BLOCK_API]);
    assert.deepEqual(f.posts.map((post) => post.data.id).sort(), [BLOCK_A, BLOCK_B].sort());
    for (const post of f.posts) {
        assert.equal(post.data.dataType, "dom");
        assert.match(post.data.data, /<span data-sue="u"/);
    }
});

test("保存失败时弹提示", async () => {
    const f = createFixture();
    f.respondWith(FAILED_RESPONSE);
    f.plugin.onload();
    f.clickToolbarItem();
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.deepEqual(f.calls.messages, [i18n.saveFailed]);
});

test("清除装饰去掉两个方向的装饰，并把面板的选中态刷回来", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();
    f.click(f.styleSwatchOf("underline", "wavy"));
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    await settle();
    f.click(f.actionButton("clear"));
    assert.equal(f.blockHTML(BLOCK_A).includes("data-sue"), false);
    // 面板自己看不到文档的变化，setPair 缺失时下面三项都会停在清除前的样子
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), false);
    assert.equal(f.switchOf("underline").checked, false);
    assert.equal(f.switchOf("overline").checked, false);
    await settle();
    // 清除本身也要落盘，否则磁盘上还留着上一版装饰
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_A]);
    assert.equal(f.posts[1].data.data.includes("data-sue"), false);
});

test("关掉再打开某个方向时沿用它上次的线型与颜色", () => {
    const f = createFixture({blocks: NESTED_HTML});
    f.plugin.onload();
    f.clickToolbarItem();
    f.toggle(f.switchOf("underline"), false);
    // 下划线关掉后内层 span 消失，外层上划线原样留着；线型与颜色仍留在面板上
    assert.equal(f.blockHTML(BLOCK_A).includes('data-sue="u"'), false);
    assert.match(f.blockHTML(BLOCK_A), /data-sue="o"/);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    f.toggle(f.switchOf("underline"), true);
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#e5484d")), true);
});

test("撤销把块换回改动前的样子，并按文档里的真实状态刷新面板", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();
    assert.equal(f.actionButton("undo").disabled, true);
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    f.click(f.actionButton("clear"));
    await settle();
    assert.equal(f.blockHTML(BLOCK_A).includes("data-sue"), false);
    assert.equal(f.actionButton("undo").disabled, false);
    f.click(f.actionButton("undo"));
    await tick();
    // 文档回到有装饰的那一版
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    // 撤销后 setPair 缺失时，面板会停在「全部关闭」那一份配置上
    assert.equal(f.switchOf("underline").checked, true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    // 栈里还剩一次改动，撤销按钮应当仍然可用
    assert.equal(f.actionButton("undo").disabled, false);
});

test("打开面板时按选区里已有的 data-sue 装饰回填两个方向", () => {
    const f = createFixture({blocks: NESTED_HTML});
    f.plugin.onload();
    f.clickToolbarItem();
    assert.equal(f.switchOf("underline").checked, true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#e5484d")), true);
    assert.equal(f.switchOf("overline").checked, true);
    assert.equal(f.pressed(f.styleSwatchOf("overline", "dotted")), true);
    assert.equal(f.pressed(f.colorSwatchOf("overline", "#0090ff")), true);
});

test("loadData 读回的配置过白名单后，作为没有装饰的选区的面板初值", async () => {
    const stored = {
        underline: {enabled: true, style: "wavy", color: "#0090ff"},
        // 注入尝试必须被颜色白名单挡掉，退回「跟随文字颜色」
        overline: {enabled: true, style: "dotted", color: "red;position:fixed"},
    };
    const f = createFixture({data: {[SETTINGS_FILE]: stored}});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    assert.deepEqual(f.calls.loadedFiles, [SETTINGS_FILE]);
    f.clickToolbarItem();
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#0090ff")), true);
    assert.equal(f.switchOf("overline").checked, true);
    assert.equal(f.pressed(f.styleSwatchOf("overline", "dotted")), true);
    assert.equal(f.pressed(f.followSwatchOf("overline")), true);
});

test("loadData 抛错时面板退回默认值，其余功能照常", async () => {
    const f = createFixture({loadFails: true});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem();
    assert.equal(f.switchOf("underline").checked, true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);
    assert.equal(f.switchOf("overline").checked, false);
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A]);
});

test("关闭面板时记住上次的配置", async () => {
    const f = createFixture();
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem();
    f.click(f.styleSwatchOf("underline", "wavy"));
    f.click(f.colorSwatchOf("underline", "#e5484d"));
    await settle();
    // 点面板外面即关闭
    f.click(f.document.getElementById("editor"));
    assert.equal(f.panelElement(), null);
    assert.deepEqual(f.calls.savedFiles.map((file) => file.name), [SETTINGS_FILE]);
    assert.deepEqual(toHost(f.calls.savedFiles[0].value), {
        underline: {enabled: true, style: "wavy", color: "#e5484d"},
        overline: {enabled: false, style: "solid", color: ""},
    });
});

test("切换文档时收起面板并清空本会话的撤销栈", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.equal(f.actionButton("undo").disabled, false);
    f.plugin.eventBus.emit("switch-protyle");
    assert.equal(f.panelElement(), null);
    // 上一份文档的撤销记录留着，新面板的撤销按钮会一直可用却按不动
    f.clickToolbarItem();
    assert.equal(f.actionButton("undo").disabled, true);
});

test("卸载时把面板、未到点的保存与浮动工具栏的回调一起收掉", async () => {
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    const originalCloseCB = protyle.toolbar.subElementCloseCB;
    f.clickToolbarItem(protyle);
    f.click(f.styleSwatchOf("underline", "wavy"));
    // 防抖窗口还没到，卸载时必须把这次保存发出去，否则磁盘上停在改动前
    assert.deepEqual(f.posts, []);
    f.plugin.onunload();
    assert.equal(f.panelElement(), null);
    assert.equal(protyle.toolbar.subElementCloseCB, originalCloseCB);
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A]);
    assert.doesNotThrow(() => f.plugin.onunload());
});

test("只读模式与发布服务下不注册工具栏项", () => {
    for (const option of [{readonly: true}, {isPublish: true}]) {
        const f = createFixture(option);
        f.plugin.onload();
        assert.deepEqual(f.calls.toolbarItems, [], "可写的编辑器不存在时不该出现工具栏项");
        // 图标照常注入：装饰由 inline style 承载，不依赖插件是否加载
        assert.equal(f.calls.icons.length, 1);
        assert.doesNotThrow(() => f.plugin.onunload());
    }
});
