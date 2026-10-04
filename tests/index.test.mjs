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

// 直接读真实的语言文件：插件实际用到的每个键都要在这里有非空的文案
const readLocale = (locale) => JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), "utf8"));

const BLOCK_A = "20261003220000-a1";
const BLOCK_B = "20261003220000-b2";

const TOOLBAR_ITEM_NAME = "underline-enhancement";
const ICON_ID = "iconUnderlineEnhancement";
const UPDATE_BLOCK_API = "/api/block/updateBlock";
/** 插件私有存储文件名，与 src/index.ts 里的常量一致 */
const SETTINGS_FILE = "settings.json";
/** 防抖保存窗口（ms），与 src/index.ts 的常量一致 */
const SAVE_DEBOUNCE_MS = 300;

/** 装饰 span 的落盘形态：只剩那几条 text-decoration 声明，插件不写任何标记属性 */
const DECORATED_UNDERLINE = /<span style="text-decoration-line: underline; text-decoration-style: wavy(?:;|")/;
const DECORATED_UNDERLINE_DOTTED = /<span style="text-decoration-line: underline; text-decoration-style: dotted(?:;|")/;
/** 上划线的两种线型；两个方向同时打开时上划线是外层那一圈 */
const DECORATED_OVERLINE = /<span style="text-decoration-line: overline; text-decoration-style: wavy(?:;|")/;
const DECORATED_OVERLINE_DOTTED = /<span style="text-decoration-line: overline; text-decoration-style: dotted(?:;|")/;
/** 指定颜色的装饰；重渲染之后改动有没有落到活着的块上，就看这一条出不出现在块 HTML 里 */
const DECORATED_UNDERLINE_BLUE =
    /text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #0090ff/;
const DECORATED_OVERLINE_RED =
    /text-decoration-line: overline; text-decoration-style: dotted; text-decoration-color: #e5484d/;
/** 块里还有没有装饰 span；清除、撤销之后都该为 false */
const HAS_DECORATION_SPAN = /<span[^>]*style="[^"]*text-decoration-line/;

/** 单块选区：一个只有纯文本的段落 */
const SINGLE_BLOCK_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">hello</p>`;
/** 双块选区：两个并列段落，用来验证「每个受影响块独立保存一次」 */
const TWO_BLOCKS_HTML = SINGLE_BLOCK_HTML + `<p data-type="text" data-node-id="${BLOCK_B}">world</p>`;

/**
 * 表格：可编辑区域是 TD，所属块却是外面那张表。
 * 撤销把块的 outerHTML 整体换掉时，TD 连同它里面的块一起脱管，是最容易拿着旧引用继续改的地方。
 */
const TABLE_ID = "20261003220000-t0";
const TABLE_HTML = `<div data-type="NodeTable" data-node-id="${TABLE_ID}"><table><tbody><tr>` +
    `<td><p data-type="text" data-node-id="${BLOCK_A}">cell one</p></td>` +
    `<td><p data-type="text" data-node-id="${BLOCK_B}">cell two</p></td>` +
    "</tr></tbody></table></div>";

/** callout：标题区是可编辑区域，所属块是那个 callout，标题本身不带 data-node-id */
const CALLOUT_ID = "20261003220000-c0";
const CALLOUT_HTML = `<div data-type="NodeCallout" data-node-id="${CALLOUT_ID}">` +
    '<div class="callout-info"><div class="callout-title">title text</div></div>' +
    `<p data-type="text" data-node-id="${BLOCK_A}">body text</p></div>`;

/**
 * 已装饰的块：外层上划线、内层下划线，正是 composePair 的嵌套输出。
 * 形态照抄思源从 .sy 重新渲染的结果：只有 data-type 与那几条声明，没有任何标记属性。
 */
const NESTED_CSS = {
    overline: "text-decoration-line: overline; text-decoration-style: dotted; text-decoration-color: #0090ff",
    underline: "text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #e5484d",
};
const savedDecoration = (css, text) => `<span data-type="text" style="${css}">${text}</span>`;
const NESTED_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">${
    savedDecoration(NESTED_CSS.overline, savedDecoration(NESTED_CSS.underline, "hello"))
}</p>`;

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

    /**
     * i18n 换成记录用的 Proxy：插件读哪个键就被记下哪个，拿到的是固定记号。
     * 断言因此能对着字面量写，不必从被测代码读的同一份 JSON 里取期望值 ——
     * 那样只要键被改名或删掉，两边一起变成 undefined，断言照样通过。
     */
    const requestedI18NKeys = [];
    const recordingI18n = new Proxy({}, {
        get: (target, key) => {
            requestedI18NKeys.push(String(key));
            return `⟦${String(key)}⟧`;
        },
    });

    /** Plugin 基类桩：只提供 src/index.ts 真正用到的那几个成员 */
    class Plugin {
        constructor() {
            this.name = "siyuan-underline-enhancement";
            this.i18n = recordingI18n;
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

    /** 单个元素内 [start, end) 字符偏移的选区 */
    const offsetRange = (element, start, end) => rangeBetween(element, start, element, end);

    const block = (blockId) => document.querySelector(`[data-node-id="${blockId}"]`);
    const blockHTML = (blockId) => block(blockId).outerHTML;
    /** 默认选区：整段选中唯一的那个块 */
    const singleRange = () => {
        const element = block(BLOCK_A);
        return rangeBetween(element, 0, element, element.textContent.length);
    };
    /** 跨块选区：从第一个块开头选到第二个块结尾 */
    const crossRange = () => rangeBetween(block(BLOCK_A), 0, block(BLOCK_B), block(BLOCK_B).textContent.length);
    /** 表格单元格内的选区；可编辑区域是 TD，落盘的块却是外面那张表 */
    const cellRange = (blockId) => {
        const element = block(blockId);
        return rangeBetween(element, 0, element, element.textContent.length);
    };

    const toolbarItem = () => {
        const item = calls.toolbarItems[calls.toolbarItems.length - 1];
        assert.ok(item, "工具栏项应当已注册");
        return item;
    };

    const clickToolbarItem = (protyle = protyleOf(singleRange())) => {
        toolbarItem().click(protyle);
        return protyle;
    };

    /**
     * 按思源的绑定方式从浮动工具栏的按钮上打开面板。
     *
     * ToolbarItem 只 preventDefault，不 stopPropagation，事件照样冒泡到 document；
     * 面板的「点击面板外关闭」就挂在 document 上，同一次点击不能把刚开的面板关掉。
     * 派发的是完整的按下-抬起-点击序列：真实指针交互就是这样一串事件。
     * 返回三个事件对象，测试要能逐个断言 defaultPrevented。
     */
    const clickToolbarButton = (protyle = protyleOf(singleRange())) => {
        const button = document.createElement("button");
        document.getElementById("anchor").appendChild(button);
        button.addEventListener("click", (event) => {
            event.preventDefault();
            toolbarItem().click(protyle);
        });
        const mousedown = new window.MouseEvent("mousedown", {bubbles: true, cancelable: true});
        button.dispatchEvent(mousedown);
        button.dispatchEvent(new window.MouseEvent("mouseup", {bubbles: true, cancelable: true}));
        const click = new window.MouseEvent("click", {bubbles: true, cancelable: true});
        button.dispatchEvent(click);
        return {button, mousedown, click};
    };

    const panelElement = () => document.querySelector("[data-sue-panel]");
    const sectionOf = (direction) => panelElement().querySelector(`[data-sue-section="${direction}"]`);
    const switchOf = (direction) => sectionOf(direction).querySelector("[data-sue-switch]");
    const styleSwatchOf = (direction, style) => sectionOf(direction).querySelector(`[data-sue-style="${style}"]`);
    const colorSwatchOf = (direction, color) => sectionOf(direction).querySelector(`[data-sue-color="${color}"]`);
    const followSwatchOf = (direction) => sectionOf(direction).querySelector("[data-sue-follow-color]");
    const actionButton = (action) => panelElement().querySelector(`[data-sue-action="${action}"]`);
    const mixedHint = () => panelElement().querySelector("[data-sue-mixed]");
    const pressed = (element) => element.getAttribute("aria-pressed") === "true";

    /** 冒泡地派发一个可取消事件，返回事件对象供断言 defaultPrevented */
    const mouse = (element, type = "mousedown") => {
        const event = new window.MouseEvent(type, {bubbles: true, cancelable: true});
        element.dispatchEvent(event);
        return event;
    };

    /** 完整指针序列：按下再点击 */
    const press = (element) => {
        mouse(element, "mousedown");
        return mouse(element, "click");
    };

    const click = (element) => element.dispatchEvent(new window.MouseEvent("click", {bubbles: true}));
    const toggle = (element, checked) => {
        element.checked = checked;
        element.dispatchEvent(new window.Event("change", {bubbles: true}));
    };

    /**
     * 模拟思源重渲染一个块：outerHTML 往返会把节点本身换掉。
     *
     * 插件在打开面板时把块元素与可编辑区域按引用记进 this.groups / this.offsets，
     * 这一句之后那些引用全部脱管：id 与内容都一样，只是已经不是文档里那个节点了
     * （返回的就是脱管后的那一个，isConnected 为 false）。
     */
    const rerender = (blockId) => {
        const element = block(blockId);
        assert.ok(element, `块 ${blockId} 应当还在文档里`);
        const html = element.outerHTML;
        element.outerHTML = html;
        assert.notEqual(block(blockId), element, "重渲染应当换掉节点本身");
        assert.equal(element.isConnected, false, "旧引用应当已经脱管");
        return element;
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
        cellRange,
        offsetRange,
        block,
        blockHTML,
        toolbarItem,
        clickToolbarItem,
        clickToolbarButton,
        panelElement,
        sectionOf,
        switchOf,
        styleSwatchOf,
        colorSwatchOf,
        followSwatchOf,
        actionButton,
        mixedHint,
        pressed,
        click,
        mouse,
        press,
        toggle,
        rerender,
        requestedI18NKeys: () => [...new Set(requestedI18NKeys)],
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
    assert.equal(item.tip, "⟦underlineEnhancement⟧");
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

test("跨两段应用后按一次撤销就把两段一起退回", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE);

    f.click(f.actionButton("undo"));
    await tick();

    // 用户做的是一次操作，撤销也必须是一次：只退回后一段的话，
    // 面板还显示着「下划线开启 / 波浪线」，实际却有一半选区没有装饰
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false, "第一段也要一起退回");
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_B)), false, "第二段要退回");
    assert.equal(f.blockHTML(BLOCK_A), SINGLE_BLOCK_HTML);
    assert.equal(f.blockHTML(BLOCK_B), `<p data-type="text" data-node-id="${BLOCK_B}">world</p>`);
    // 一次操作只记一条记录，撤完栈就该空了
    assert.equal(f.actionButton("undo").disabled, true, "一次操作不能占多条记录，否则撤一次撤不干净");
    // 文档回到没有任何装饰的状态，面板也随之
    assert.equal(f.switchOf("underline").checked, true, "没有装饰时回填的是默认值");
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);
});

test("选区内的装饰不一致时面板先给出混合提示，点一下才统一", async () => {
    // 只有第二块被装饰过，第一块是干净的：只读第一块的话，
    // 面板会拿默认值开场，用户随手一点就把第二块的装饰改掉了，且事先没有任何提示
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">hello</p>` +
        `<p data-type="text" data-node-id="${BLOCK_B}">${savedDecoration(NESTED_CSS.underline, "world")}</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));

    const hint = f.mixedHint();
    assert.ok(hint, "混合选区必须显式告知用户");
    assert.equal(hint.hidden, false);
    // 面板展示的是第一个有装饰的分组的配置
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.equal(f.colorSwatchOf("underline", "#e5484d") !== null, true);

    f.click(f.styleSwatchOf("underline", "dotted"));
    assert.equal(f.mixedHint().hidden, true, "统一之后提示撤掉");
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED, "第一段按面板当前这份配置铺开");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_DOTTED, "第二段被统一，而不是保持原样");
});

test("选区内的装饰一致时不显示混合提示", () => {
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">${savedDecoration(NESTED_CSS.underline, "hello")}</p>` +
        `<p data-type="text" data-node-id="${BLOCK_B}">${savedDecoration(NESTED_CSS.underline, "world")}</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));

    assert.equal(f.mixedHint().hidden, true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
});

test("选区里没有装饰时按清除装饰不发请求", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();

    f.click(f.actionButton("clear"));
    await settle();

    // 文档本来就没有装饰，这次「清除」什么都没改：发一个逐字节相同的块只是白写一次
    assert.deepEqual(f.posts, [], "没有实际改动时不该有 updateBlock");
    assert.deepEqual(f.calls.messages, []);
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
        assert.match(post.data.data, /<span style="text-decoration-line: underline/);
    }
});

test("保存失败时弹提示", async () => {
    const f = createFixture();
    f.respondWith(FAILED_RESPONSE);
    f.plugin.onload();
    f.clickToolbarItem();
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.deepEqual(f.calls.messages, ["⟦saveFailed⟧"]);
});

// ------------------------------------------------------------------ 文案

test("插件用到的每个 i18n 键在两种语言的真实文件里都存在", async () => {
    // 键清单从插件自己问出来：i18n 换成记录用的 Proxy，插件取哪个键就被记下哪个
    const f = createFixture();
    f.respondWith(FAILED_RESPONSE);
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem();
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    const keys = f.requestedI18NKeys();
    assert.ok(keys.includes("underlineEnhancement"), "工具栏提示应当取自 i18n");
    assert.ok(keys.includes("saveFailed"), "保存失败提示应当取自 i18n");
    for (const locale of ["zh-CN", "en"]) {
        const table = readLocale(locale);
        for (const key of keys) {
            assert.equal(typeof table[key], "string", `${locale}.json 缺少插件用到的键 ${key}`);
            assert.notEqual(table[key].trim(), "", `${locale}.json 的 ${key} 是空串，界面上会显示空白`);
        }
    }
});

test("清除装饰去掉两个方向的装饰，并把面板的选中态刷回来", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();
    f.click(f.styleSwatchOf("underline", "wavy"));
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    await settle();
    f.click(f.actionButton("clear"));
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false);
    // 面板自己看不到文档的变化，setPair 缺失时下面三项都会停在清除前的样子
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), false);
    assert.equal(f.switchOf("underline").checked, false);
    assert.equal(f.switchOf("overline").checked, false);
    await settle();
    // 清除本身也要落盘，否则磁盘上还留着上一版装饰
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_A]);
    assert.equal(HAS_DECORATION_SPAN.test(f.posts[1].data.data), false);
});

test("关掉再打开某个方向时沿用它上次的线型与颜色", () => {
    const f = createFixture({blocks: NESTED_HTML});
    f.plugin.onload();
    f.clickToolbarItem();
    f.toggle(f.switchOf("underline"), false);
    // 下划线关掉后内层 span 消失，外层上划线原样留着；线型与颜色仍留在面板上
    assert.equal(f.blockHTML(BLOCK_A).includes("text-decoration-line: underline"), false);
    assert.match(f.blockHTML(BLOCK_A), /text-decoration-line: overline/);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    f.toggle(f.switchOf("underline"), true);
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#e5484d")), true);
});

test("从浮动工具栏的按钮点击打开面板时，同一次点击冒泡到 document 不能把面板关掉", () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarButton();
    assert.ok(f.panelElement(), "面板应当在这次点击之后仍然留在文档里");
    // 面板确实能用来改设置，不是一个开了就被回收的空壳
    f.click(f.styleSwatchOf("underline", "wavy"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
});

test("面板拦 mousedown 的范围只有面板自己：工具栏按钮的按下不受影响，面板也不被关掉", () => {
    // 面板挂在 body 上并在自身范围内吃 mousedown 的默认行为；浮动工具栏是思源的地盘，不能碰
    const f = createFixture();
    f.plugin.onload();
    const {mousedown, click: openingClick} = f.clickToolbarButton();
    assert.equal(mousedown.defaultPrevented, false, "工具栏按钮上的按下不该被面板拦下");
    assert.equal(openingClick.defaultPrevented, true, "思源 ToolbarItem 自己会 preventDefault");
    assert.ok(f.panelElement(), "面板仍然留着：打开的那一次点击不能把它关掉");

    // 面板开着之后再点同一个工具栏按钮：仍然只由面板自己的子树处理按下
    const again = f.mouse(f.clickToolbarButton().button, "mousedown");
    assert.equal(again.defaultPrevented, false);
    assert.ok(f.panelElement());
});

test("面板控件上的 mousedown 被拦下，控件依然把改动落到文档上", () => {
    // 编辑器一失焦思源就清掉选区，面板记下的坐标随即失去意义，因此按下必须被拦下。
    // jsdom 不会因派发事件移动焦点，端到端的选区存活要在真实思源里验；这里断言契约与控件可用。
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();
    // 思源的可编辑区是一个 contenteditable；jsdom 只把带这个属性的元素当作可聚焦
    const editor = f.document.getElementById("editor");
    editor.setAttribute("contenteditable", "true");
    editor.focus();
    assert.equal(f.document.activeElement, editor, "夹具前提：焦点先落在编辑器上");

    const targets = [
        ["面板根", f.panelElement()],
        ["线型色块", f.styleSwatchOf("underline", "wavy")],
        ["颜色色块", f.colorSwatchOf("underline", "#0090ff")],
        ["跟随文字色色块", f.followSwatchOf("underline")],
        ["方向开关", f.switchOf("underline")],
        ["清除装饰", f.actionButton("clear")],
        ["撤销", f.actionButton("undo")],
    ];
    for (const [name, element] of targets) {
        assert.equal(f.mouse(element).defaultPrevented, true, `${name} 上的 mousedown 必须被拦下`);
    }

    // 拦下按下之后，控件仍然响应：改动照样落到块上
    f.press(f.styleSwatchOf("underline", "wavy"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    // jsdom 不会因为派发事件移动焦点，因此这一条只能证明插件自己没把焦点带走；
    // 「焦点留在编辑器 → 思源不清选区」必须在真实思源里验
    assert.equal(f.document.activeElement, editor, "点面板不应把焦点带离编辑器");
});

test("面板外的按下与点击仍然关闭面板", () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();
    const outside = f.document.getElementById("editor");
    // 面板只在自己的范围内拦按下；面板外的按下不该被拦，也不该关闭面板（它只监听点击）
    assert.equal(f.mouse(outside).defaultPrevented, false);
    assert.ok(f.panelElement(), "面板外的按下不关闭面板");
    f.mouse(outside, "click");
    assert.equal(f.panelElement(), null, "面板外的点击关闭面板");
});

test("通过面板选择「跟随文字颜色」，落盘的块 HTML 带 text-decoration-color: currentColor", async () => {
    // 实测：省略这条声明时思源改存一条 color，装饰取到的就成了文字色本身
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem();
    f.click(f.colorSwatchOf("underline", "#46a758"));
    await settle();
    assert.ok(f.posts[0].data.data.includes("text-decoration-color: #46a758"), "先落一个具体颜色");

    f.click(f.followSwatchOf("underline"));
    await settle();
    const last = f.posts[f.posts.length - 1];
    assert.equal(last.data.id, BLOCK_A);
    assert.equal(last.data.dataType, "dom");
    assert.ok(
        last.data.data.includes(
            "text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentColor",
        ),
        `跟随文字色必须显式落成 currentColor：${last.data.data}`,
    );
    // 上一版颜色不得以任何形式残留：思源存的就是这段 HTML
    assert.equal(last.data.data.includes("#46a758"), false);
    assert.equal(last.data.data.includes("color: #46a758"), false, "装饰色不得落成文字色 color");
});

test("对照组：表格单元格里连续改两次设置，两次都落到文档上", async () => {
    const f = createFixture({blocks: TABLE_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.cellRange(BLOCK_A)));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    f.click(f.styleSwatchOf("underline", "dotted"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED);
});

test("表格单元格里撤销之后再改设置，装饰仍然落在文档上", async () => {
    const f = createFixture({blocks: TABLE_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.cellRange(BLOCK_A)));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false);
    // 撤销换掉的是整张表的 HTML：这一组必须重新认领到文档里的单元格，否则改的是脱管的节点
    f.click(f.styleSwatchOf("underline", "dotted"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED);
    await settle();
    const last = f.posts[f.posts.length - 1];
    assert.equal(last.data.id, TABLE_ID, "单元格的改动按所属块落盘");
    // 落盘的内容必须就是当前文档里的内容：拿着脱管节点发出去的是改动前的旧 HTML
    assert.equal(last.data.data, f.block(TABLE_ID).outerHTML);
});

test("callout 标题区撤销之后再改设置，装饰仍然落在标题上", async () => {
    const f = createFixture({blocks: CALLOUT_HTML});
    const title = () => f.document.querySelector(".callout-title");
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.offsetRange(title(), 0, title().textContent.length)));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.match(title().outerHTML, DECORATED_UNDERLINE);
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(HAS_DECORATION_SPAN.test(title().outerHTML), false);
    // 标题区是新块里的哪一个由 dom.ts 按位置判定：认错了就会去装饰正文段落
    f.click(f.styleSwatchOf("underline", "dotted"));
    assert.match(title().outerHTML, DECORATED_UNDERLINE_DOTTED);
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false);
});

// ------------------------------------------ 面板开着时思源重渲染了块

/**
 * 思源随时会重渲染块，而面板记下的分组与字符偏移都是按引用拿住的。
 * 这些用例用 outerHTML 往返把块节点整个换掉（内容与 id 一模一样，节点本身已是另一个），
 * 逐条对着用户看得见的症状断言。
 */
test("重渲染之后下划线的第二次线型改动仍然落到活着的块上，并各发一次 updateBlock", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_B]);

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.click(f.styleSwatchOf("underline", "dotted"));
    await settle();

    // 装饰必须出现在文档里那个节点上，用户在屏幕上才看得到
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED, "第一段的线型要真的换成 dotted");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_DOTTED, "第二段也要换");
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_B, BLOCK_A, BLOCK_B]);
    // 落盘的内容必须是活着的块现在的 HTML：拿着脱管节点发出去的是改动前的旧 HTML
    assert.equal(f.posts[2].data.data, f.block(BLOCK_A).outerHTML);
    assert.equal(f.posts[3].data.data, f.block(BLOCK_B).outerHTML);
    assert.equal(f.posts[2].data.dataType, "dom");
});

test("重渲染之后上划线的第二次线型改动仍然落到活着的块上，并各发一次 updateBlock", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.toggle(f.switchOf("overline"), true);
    f.click(f.styleSwatchOf("overline", "dotted"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_OVERLINE_DOTTED);
    assert.deepEqual(f.posts.map((post) => post.data.id).sort(), [BLOCK_A, BLOCK_B].sort());

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.click(f.styleSwatchOf("overline", "wavy"));
    await settle();

    assert.match(f.blockHTML(BLOCK_A), DECORATED_OVERLINE, "第一段的上划线要真的换成 wavy");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_OVERLINE, "第二段也要换");
    assert.equal(f.posts.length, 4);
    assert.deepEqual(f.posts.slice(2).map((post) => post.data.id), [BLOCK_A, BLOCK_B]);
    assert.equal(f.posts[2].data.data, f.block(BLOCK_A).outerHTML);
    assert.equal(f.posts[3].data.data, f.block(BLOCK_B).outerHTML);
});

test("重渲染之后下划线的第二次颜色改动仍然落到活着的块上，并各发一次 updateBlock", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.equal(f.posts.length, 2);

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.click(f.colorSwatchOf("underline", "#0090ff"));
    await settle();

    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_BLUE, "第一段的颜色要真的换成蓝色");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_BLUE, "第二段也要换");
    assert.equal(f.posts.length, 4);
    assert.deepEqual(f.posts.slice(2).map((post) => post.data.id), [BLOCK_A, BLOCK_B]);
    assert.equal(f.posts[2].data.data, f.block(BLOCK_A).outerHTML);
    assert.equal(f.posts[3].data.data, f.block(BLOCK_B).outerHTML);
});

test("重渲染之上划线的第二次颜色改动仍然落到活着的块上，并各发一次 updateBlock", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.toggle(f.switchOf("overline"), true);
    f.click(f.styleSwatchOf("overline", "dotted"));
    await settle();
    assert.equal(f.posts.length, 2);

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.click(f.colorSwatchOf("overline", "#e5484d"));
    await settle();

    assert.match(f.blockHTML(BLOCK_A), DECORATED_OVERLINE_RED, "第一段的上划线要真的变成红色");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_OVERLINE_RED, "第二段也要换");
    assert.equal(f.posts.length, 4);
    assert.deepEqual(f.posts.slice(2).map((post) => post.data.id), [BLOCK_A, BLOCK_B]);
    assert.equal(f.posts[2].data.data, f.block(BLOCK_A).outerHTML);
    assert.equal(f.posts[3].data.data, f.block(BLOCK_B).outerHTML);
});

test("重渲染之后重建的选区落在活着的文档上，而不是脱管的那一份里", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    // 换掉的节点把插件记下的块元素、可编辑区域与选区坐标一并带走了
    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);

    f.click(f.styleSwatchOf("underline", "dotted"));

    const selection = f.document.getSelection();
    assert.ok(selection.rangeCount > 0, "选区必须回到文档上，用户才能接着输入");
    assert.equal(selection.toString(), "helloworld", "选中的文字要和打开面板时一致");
    assert.ok(f.block(BLOCK_A).contains(selection.anchorNode), "起点要落在活着的第一段里");
    assert.ok(f.block(BLOCK_B).contains(selection.focusNode), "终点要落在活着的第二段里");
});

test("重渲染之后清除装饰，活着的块上不再有装饰", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    f.toggle(f.switchOf("overline"), true);
    await settle();
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), true, "前置条件：两个方向都装饰上了");

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.click(f.actionButton("clear"));

    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false, "第一段的装饰要真的被清掉");
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_B)), false, "第二段也要被清掉");
    await settle();
    // 清除本身也要落盘，否则磁盘上还留着上一版装饰
    assert.deepEqual(f.posts.slice(2).map((post) => post.data.id), [BLOCK_A, BLOCK_B]);
    assert.equal(HAS_DECORATION_SPAN.test(f.posts[2].data.data), false);
    assert.equal(HAS_DECORATION_SPAN.test(f.posts[3].data.data), false);
});

test("重渲染之后关掉下划线，活着的块上只留下上划线", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    f.toggle(f.switchOf("overline"), true);
    f.click(f.styleSwatchOf("overline", "dotted"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    assert.match(f.blockHTML(BLOCK_A), DECORATED_OVERLINE_DOTTED);

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.toggle(f.switchOf("underline"), false);

    // 只是关掉一个方向：另一个方向原样留着，两块因此都仍然带着装饰
    assert.equal(f.blockHTML(BLOCK_A).includes("text-decoration-line: underline"), false, "第一段的下划线要去掉");
    assert.equal(f.blockHTML(BLOCK_B).includes("text-decoration-line: underline"), false, "第二段的下划线要去掉");
    assert.match(f.blockHTML(BLOCK_A), DECORATED_OVERLINE_DOTTED, "第一段的上划线原样留着");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_OVERLINE_DOTTED, "第二段的上划线原样留着");
});

test("重渲染之后关上划线，活着的块上只留下下划线", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    f.toggle(f.switchOf("overline"), true);
    f.click(f.styleSwatchOf("overline", "dotted"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.toggle(f.switchOf("overline"), false);

    assert.equal(f.blockHTML(BLOCK_A).includes("text-decoration-line: overline"), false, "第一段的上划线要去掉");
    assert.equal(f.blockHTML(BLOCK_B).includes("text-decoration-line: overline"), false, "第二段的上划线要去掉");
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE, "第一段的下划线原样留着");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE, "第二段的下划线原样留着");
});

test("重渲染之后的改动只写活着的块，脱管的那一份不会被改到", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    await f.plugin.onLayoutReady();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();

    // 只重渲染第一段：跨块选区里两组的引用会一个脱管、一个仍然连着文档
    const detached = f.rerender(BLOCK_A);
    f.click(f.colorSwatchOf("underline", "#0090ff"));
    await settle();

    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_BLUE, "改动要落在文档里那个块上");
    assert.equal(detached.innerHTML.includes("#0090ff"), false, "脱管的旧副本不该被改到");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_BLUE, "仍然连着文档的那一段照旧改得到");
    // 脱管的那一份也不会被发出去：第二次改动对第一段仍然是一次正常的落盘
    const firstBlockPosts = f.posts.filter((post) => post.data.id === BLOCK_A);
    assert.equal(firstBlockPosts.length, 2, "重渲染之后的第一段仍然要发请求");
    assert.equal(firstBlockPosts[1].data.data, f.block(BLOCK_A).outerHTML);
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
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false);
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

test("打开面板时按选区里已有装饰的 text-decoration 声明回填两个方向", () => {
    // 夹具是思源存盘后重新渲染出来的形态：span 上只有 data-type 与 style，没有任何标记属性
    const f = createFixture({blocks: NESTED_HTML});
    assert.equal(f.blockHTML(BLOCK_A).includes("data-sue"), false, "夹具里本来就没有任何标记属性");
    f.plugin.onload();
    f.clickToolbarItem();
    assert.equal(f.switchOf("underline").checked, true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#e5484d")), true);
    assert.equal(f.switchOf("overline").checked, true);
    assert.equal(f.pressed(f.styleSwatchOf("overline", "dotted")), true);
    assert.equal(f.pressed(f.colorSwatchOf("overline", "#0090ff")), true);
});

test("落在选区之外的装饰不参与回填", () => {
    // 装饰在「decorated」那一段，选区只覆盖前面的「plain 」
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">plain ` +
        `${savedDecoration(NESTED_CSS.underline, "decorated")} tail</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.offsetRange(f.block(BLOCK_A), 0, 6)));
    // 面板显示的是默认值：选中的这段本来就没有装饰
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), false);
    assert.equal(f.pressed(f.followSwatchOf("underline")), true);
    assert.equal(f.switchOf("overline").checked, false);
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
