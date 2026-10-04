// 插件接线测试：在 jsdom 里摆一个思源编辑器（浮动工具栏 + 带 data-node-id 的块），
// 用真实的 panel.ts / dom.ts / persist.ts / model.ts 跑完整链路，只有 "siyuan" 模块与 Plugin 基类是桩。
//
// 这样断言的不是「某个函数被调用过」，而是「用户点一下之后文档与面板分别变成什么样」：
// 装饰 span 真的落进了块、保存真的按块发了 updateBlock、面板真的自己收了起来而浮动工具栏留在原地。
import {JSDOM} from "jsdom";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {loadModule} from "./helpers/loadModule.mjs";

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
const DECORATED_UNDERLINE_DASHED = /<span style="text-decoration-line: underline; text-decoration-style: dashed(?:;|")/;
/** 默认那份装饰：实线跟随文字颜色，color 落成 currentColor */
const DECORATED_UNDERLINE_DEFAULT =
    /<span style="text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentColor"/;
/** 指定颜色的装饰；重渲染之后改动有没有落到活着的块上，就看这一条出不出现在块 HTML 里 */
const DECORATED_UNDERLINE_BLUE =
    /text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #0090ff/;
/** 取色器挑出来的自定义色落盘形态：线型沿用面板当时那一份 */
const DECORATED_UNDERLINE_CUSTOM =
    /text-decoration-line: underline; text-decoration-style: \w+; text-decoration-color: #123456/;
/** 块里还有没有装饰 span；清除、撤销之后都该为 false */
const HAS_DECORATION_SPAN = /<span[^>]*style="[^"]*text-decoration-line/;

/** 单块选区：一个只有纯文本的段落 */
const SINGLE_BLOCK_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">hello</p>`;
/** 双块选区：两个并列段落，用来验证「每个受影响块独立保存一次」 */
const TWO_BLOCKS_HTML = SINGLE_BLOCK_HTML + `<p data-type="text" data-node-id="${BLOCK_B}">world</p>`;

/**
 * 已装饰的块：形态照抄思源从 .sy 重新渲染的结果，只有 data-type 与那几条声明，没有任何标记属性。
 */
const SAVED_WAVY_RED = "text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #e5484d";
/** 与 SAVED_WAVY_RED 同形、线型不同：用于让「点另一个线型」一定产生一次真实提交 */
const SAVED_DOTTED_RED =
    "text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: #e5484d";
const savedDecoration = (css, text) => `<span data-type="text" style="${css}">${text}</span>`;

/**
 * 表格：可编辑区域是 TD，所属块却是外面那张表。
 * 撤销把块的 outerHTML 整体换掉时，TD 连同它里面的块一起脱管，是最容易拿着旧引用继续改的地方。
 */
const TABLE_ID = "20261003220000-t0";
const tableHTML = (firstCell) =>
    `<div data-type="NodeTable" data-node-id="${TABLE_ID}"><table><tbody><tr>` +
    `<td><p data-type="text" data-node-id="${BLOCK_A}">${firstCell}</p></td>` +
    `<td><p data-type="text" data-node-id="${BLOCK_B}">cell two</p></td>` +
    "</tr></tbody></table></div>";
const TABLE_HTML = tableHTML("cell one");
/** 单元格里的文字已经装饰好：打开面板因此不落笔，撤销栈里只有用户自己那一次改动 */
const DECORATED_TABLE_HTML = tableHTML(savedDecoration(SAVED_DOTTED_RED, "cell one"));

/** callout：标题区是可编辑区域，所属块是那个 callout，标题本身不带 data-node-id */
const CALLOUT_ID = "20261003220000-c0";
const calloutHTML = (title) =>
    `<div data-type="NodeCallout" data-node-id="${CALLOUT_ID}">` +
    `<div class="callout-info"><div class="callout-title">${title}</div></div>` +
    `<p data-type="text" data-node-id="${BLOCK_A}">body text</p></div>`;
/** 标题已经装饰好：打开面板因此不落笔，撤销栈里只有用户自己那一次改动 */
const DECORATED_CALLOUT_HTML = calloutHTML(savedDecoration(SAVED_DOTTED_RED, "title text"));

const DECORATED_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">${savedDecoration(SAVED_WAVY_RED, "hello")}</p>`;
const DECORATED_DOTTED_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">${
    savedDecoration(SAVED_DOTTED_RED, "hello")
}</p>`;
/**
 * 打开面板落不落笔取决于选区里有没有下划线，因此凡是要把一次改动单独算成用户那一次的用例，
 * 都从「已经装饰好」的块出发：这样打开面板不动文档，撤销栈里就只有用户自己点出来的那一条。
 */
const DECORATED_BLOCK_A_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">${
    savedDecoration(SAVED_WAVY_RED, "hello")
}</p>`;
const DECORATED_BLOCK_B_HTML = `<p data-type="text" data-node-id="${BLOCK_B}">${
    savedDecoration(SAVED_WAVY_RED, "world")
}</p>`;
const DECORATED_TWO_BLOCKS_HTML = DECORATED_BLOCK_A_HTML + DECORATED_BLOCK_B_HTML;
const DOTTED_BLOCK_A_HTML = `<p data-type="text" data-node-id="${BLOCK_A}">${
    savedDecoration(SAVED_DOTTED_RED, "hello")
}</p>`;
const DOTTED_BLOCK_B_HTML = `<p data-type="text" data-node-id="${BLOCK_B}">${
    savedDecoration(SAVED_DOTTED_RED, "world")
}</p>`;
const DECORATED_DOTTED_TWO_BLOCKS_HTML = DOTTED_BLOCK_A_HTML + DOTTED_BLOCK_B_HTML;
/** 思源自己的下划线：它的工具栏按钮与 Markdown 语法落成的都是 <u> */
const nativeUnderline = (text) => `<u>${text}</u>`;

const OK_RESPONSE = {code: 0, msg: "", data: null};
const FAILED_RESPONSE = {code: -1, msg: "kernel busy", data: null};

/** 等防抖窗口过去。用真实计时器而不是假时钟：慢机器上只是多等一会儿，却不会漏掉真实行为 */
const settle = () => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 50));

/** 让已经排队的 Promise 回调跑完（撤销是 async 的） */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 一个用例一套独立的 jsdom、独立的模块实例与独立的思源桩。
 * 撤销栈是模块级、面板状态是实例级的，共享实例会让用例互相依赖。
 */
const createFixture = (options = {}) => {
    const blocks = options.blocks ?? SINGLE_BLOCK_HTML;
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body><div class="fn__toolbar" id="anchor"></div>' +
            // 面包屑也带 data-node-id，且与块 id 相同：真实思源里它排在编辑区之前，用来钉住「别认错节点」
            '<div class="protyle-breadcrumb">' +
            `<span class="protyle-breadcrumb__item" data-node-id="${BLOCK_A}"></span>` +
            `<span class="protyle-breadcrumb__item" data-node-id="${BLOCK_B}"></span></div>` +
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
        dependencies: {"./model": model, "./dom": domModule, "./placement": loadModule("src/placement.ts")},
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
    const protyleOf = (range, options = {}) => {
        const toolbar = {
            element: document.getElementById("anchor"),
            range,
            subElementCloseCB: () => {},
        };
        const protyle = {element: document.getElementById("editor"), toolbar};
        // 真机上前端连着内核 WebSocket 才会收到块事务回放；用例按需打开，以覆盖回放后重落选区那条路
        if (options.ws === true) {
            protyle.ws = {};
        }
        return {protyle, toolbar};
    };

    // 偏移换算在测试侧独立写一遍：复用被测代码的同一段逻辑会让断言变成自证。
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

    const block = (blockId) => document.getElementById("editor").querySelector(`[data-node-id="${blockId}"]`);
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
    const titleRange = () => {
        const title = document.querySelector(".callout-title");
        return offsetRange(title, 0, title.textContent.length);
    };

    const toolbarItem = () => {
        const item = calls.toolbarItems[calls.toolbarItems.length - 1];
        assert.ok(item, "工具栏项应当已注册");
        return item;
    };

    const clickToolbarItem = (protyle) => {
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
    const clickToolbarButton = (protyle) => {
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
    /** 开关的勾选态读在 aria-checked 上：面板里的开关不是 input */
    const checkedOf = (direction) => switchOf(direction).getAttribute("aria-checked") === "true";
    const styleSwatchOf = (direction, style) => sectionOf(direction).querySelector(`[data-sue-style="${style}"]`);
    const colorSwatchOf = (direction, color) => sectionOf(direction).querySelector(`[data-sue-color="${color}"]`);
    const followSwatchOf = (direction) => sectionOf(direction).querySelector("[data-sue-follow-color]");
    const customInputOf = (direction) => sectionOf(direction).querySelector("[data-sue-custom-color]");
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
    /** 原生取色器：设值再派发 change */
    const pickColor = (input, value) => {
        input.value = value;
        input.dispatchEvent(new window.Event("change", {bubbles: true}));
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

    /**
     * 面板开着期间块的内容被换短：打开面板时记下的字符偏移因此越出了区域当前的内容。
     *
     * jsdom 不会模拟思源的重渲染，也不会模拟用户在编辑器里改写，因此这一形态由夹具显式摆出。
     * 触发它的可以是思源，也可以是用户自己 —— 这里只关心一个事实：
     * 面板记下的那对偏移已经不再对应任何字符。
     */
    const shrinkBlock = (blockId, text) => {
        const element = block(blockId);
        assert.ok(element, `块 ${blockId} 应当还在文档里`);
        element.textContent = text;
        return element;
    };

    /** 块被删除：面板记下的那对偏移已经不对应文档里的任何东西 */
    const removeBlock = (blockId) => {
        const element = block(blockId);
        assert.ok(element, `块 ${blockId} 应当还在文档里`);
        element.remove();
        return element;
    };

    /**
     * 再点一次工具栏图标把面板重新打开。
     *
     * 设置类控件点了就收面板，因此一次会话里往往要来回重开。选区要重新造：
     * 文档已经被改过，上一次的 Range 早已失效。
     */
    const reopen = (rangeFactory = singleRange) => clickToolbarItem(protyleOf(rangeFactory()));

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
        titleRange,
        offsetRange,
        block,
        blockHTML,
        toolbarItem,
        clickToolbarItem,
        clickToolbarButton,
        reopen,
        panelElement,
        sectionOf,
        switchOf,
        checkedOf,
        styleSwatchOf,
        colorSwatchOf,
        followSwatchOf,
        customInputOf,
        actionButton,
        mixedHint,
        pressed,
        click,
        mouse,
        press,
        pickColor,
        rerender,
        shrinkBlock,
        removeBlock,
        // 白盒地收面板：多步交互之间要换一次面板时用它
        closePanel: () => plugin.closePanel(),
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

test("图标是带波浪下划线的字母 U，且描边属性仍写在 symbol 上", () => {
    const {UNDERLINE_ICON_SVG} = loadModule("src/icons.ts");
    assert.match(UNDERLINE_ICON_SVG, /viewBox="0 0 24 24"/);
    // U 的那段路径取自 Lucide 的 underline，原样保留
    assert.match(UNDERLINE_ICON_SVG, /d="M6 4v6a6 6 0 0 0 12 0V4"/);
    // 思源工具栏里本来就有一个直下划线按钮，两者必须靠波形区分开
    assert.equal(
        /<line[\s>]/.test(UNDERLINE_ICON_SVG),
        false,
        "波浪下划线不能用直线元素画，否则与思源自带的直下划线按钮长得一样",
    );
    const pathData = Array.from(UNDERLINE_ICON_SVG.matchAll(/\sd="([^"]+)"/g), (matched) => matched[1]);
    assert.equal(pathData.length, 2, "图标由 U 与波浪两段路径组成");
    // 波浪必须真的弯：至少一段路径带曲线命令
    assert.ok(
        pathData.some((data) => /[cqCQ]/.test(data)),
        `下划线那段必须是曲线：${pathData.join(" | ")}`,
    );
    // 路径数据里不能有野数字：命令字母都得在 SVG 的命令集内，每个数字都得跟在某个命令后面，
    // 且全部是有限数字。少写一个参数或写错一个字母，浏览器会把整段曲线整条丢弃
    for (const data of pathData) {
        let seenCommand = false;
        for (const token of data.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []) {
            if (/^[a-zA-Z]$/.test(token)) {
                assert.match(token, /^[MmLlHhVvCcSsQqTtAaZz]$/, `未知的路径命令 ${token}：${data}`);
                seenCommand = true;
                continue;
            }
            assert.equal(seenCommand, true, `这个数字不属于任何命令：${token} 出现在 ${data}`);
            assert.ok(Number.isFinite(Number(token)), `路径里不能出现非有限数字：${token} 出现在 ${data}`);
        }
    }
    // 思源对工具栏图标统一声明 fill: currentColor; stroke-width: 0，symbol 上必须自己再声明一次
    assert.match(UNDERLINE_ICON_SVG, /fill="none"/);
    assert.match(UNDERLINE_ICON_SVG, /stroke-width="1.5"/);
    assert.match(UNDERLINE_ICON_SVG, /stroke="currentColor"/, "描边跟随文字色，深浅主题才都对");
    // 这三件事必须留在 <symbol> 上（继承自 svg 的声明优先级更低），落到别的元素上就失效了
    const symbol = /<symbol\b([^>]*)>/.exec(UNDERLINE_ICON_SVG);
    assert.ok(symbol, "图标必须是一个 symbol");
    for (const attribute of ['fill="none"', 'stroke="currentColor"', 'stroke-width="1.5"']) {
        assert.ok(
            symbol[1].includes(attribute),
            `${attribute} 必须留在 <symbol> 上：思源对 svg 的声明会继承进路径，优先级低于元素自身的表现属性`,
        );
    }
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

// ------------------------------------------------------------------ 面板与浮动工具栏各收各的

test("点面板里的控件收面板，但不动浮动工具栏，收摊时把回调还回思源", () => {
    // 设置类控件点一下就完成一次设置，面板随之收起，与思源自己的颜色菜单一致；
    // 浮动工具栏与选区留给用户，下一次要改重新点工具栏图标即可。工具栏任何情况下都不由面板收
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    const originalCloseCB = protyle.toolbar.subElementCloseCB;
    f.clickToolbarItem(protyle);

    f.click(f.styleSwatchOf("underline", "wavy"));

    assert.equal(f.panelElement(), null, "设置类控件点一下就收面板");
    assert.ok(protyle.toolbar.element.isConnected, "浮动工具栏仍然挂在文档里，没有被收走");
    assert.equal(protyle.toolbar.subElementCloseCB, originalCloseCB, "收面板时把回调还给了思源");
});

test("收面板不经过浮动工具栏的关闭回调这条路", () => {
    // 工具栏收起时思源会调 subElementCloseCB；面板收起是另一条出口。
    // 把接管来的回调包一层计数器，两条路一旦混同就会立刻暴露
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    const originalCloseCB = protyle.toolbar.subElementCloseCB;
    f.clickToolbarItem(protyle);

    const installed = protyle.toolbar.subElementCloseCB;
    let viaToolbar = 0;
    protyle.toolbar.subElementCloseCB = () => {
        viaToolbar++;
        installed();
    };

    f.click(f.styleSwatchOf("underline", "wavy"));

    assert.equal(viaToolbar, 0, "收面板走的是面板自己的出口，不是工具栏的关闭回调");
    assert.equal(f.panelElement(), null, "面板确实收掉了");
    assert.equal(protyle.toolbar.subElementCloseCB, originalCloseCB);
});

test("面板里的控件都不可聚焦，因此点它们不会把焦点带离编辑器", () => {
    // 可聚焦的元素按下时会把焦点交给它，编辑器失焦、思源清掉选区，浮动工具栏跟着收起，
    // 面板记下的字符偏移也不再指向用户的文字。可聚焦入口一个都不许有
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    const panel = f.panelElement();
    const focusable = panel.querySelectorAll(
        "button, input:not([data-sue-custom-color]), select, textarea, a[href], [contenteditable], [tabindex]",
    );
    assert.deepEqual(
        Array.from(focusable).map((element) => element.tagName),
        [],
        "面板里出现了可聚焦元素",
    );
});

test("控件激活没有把编辑器焦点带走，改动仍然落到文档上", () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    // 思源的可编辑区是一个 contenteditable；jsdom 只把带这个属性的元素当作可聚焦
    const editor = f.document.getElementById("editor");
    editor.setAttribute("contenteditable", "true");
    editor.focus();
    assert.equal(f.document.activeElement, editor, "夹具前提：焦点先落在编辑器上");

    const swatch = f.styleSwatchOf("underline", "wavy");
    const down = f.press(swatch);
    assert.equal(down.defaultPrevented, false, "插件不再与浏览器默认行为对抗");
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    // jsdom 不会因为派发事件移动焦点，因此这一条只证明插件自己没把焦点带走；
    // 浏览器究竟会不会移走焦点，必须在真实思源里看一眼
    assert.equal(f.document.activeElement, editor);
});

test("原生取色器挑完颜色：装饰照常落盘，选区清空，浮动工具栏与面板一起收掉", () => {
    // 这条路径与其它控件正好相反：系统取色对话框强制拿走焦点，编辑器与工具栏都已收摊，
    // 与其把选区恢复回来，不如干脆把选区也清掉
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    f.clickToolbarItem(protyle);
    const outsidePresses = [];
    f.document.addEventListener("mousedown", (event) => outsidePresses.push(event.target));

    f.click(f.styleSwatchOf("underline", "wavy"));
    f.reopen();
    assert.ok(f.document.getSelection().rangeCount > 0, "前置条件：选区是活的");

    const picker = f.customInputOf("underline");
    f.pickColor(picker, "#123456");

    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_CUSTOM, "颜色照常落到装饰上");
    assert.equal(f.document.getSelection().rangeCount, 0, "选区被清空了");
    assert.equal(f.panelElement(), null, "面板收起");
    // 浮动工具栏是按思源自己的收起方式触发的：面板与工具栏之外的一次按下
    assert.ok(outsidePresses.length >= 1, "确实在工具栏之外派发了一次按下");
    assert.equal(outsidePresses[0], f.document.body);
    assert.equal(protyle.toolbar.element.contains(outsidePresses[0]), false, "那次按下不在工具栏里");
});

test("预设色块不碰浮动工具栏：选区留着，工具栏留着，面板收起", () => {
    // 只有取色器那一条路会连选区带浮动工具栏一起收；其余控件必须把这两样都留给用户，
    // 只收起自己的面板
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    f.clickToolbarItem(protyle);
    f.click(f.styleSwatchOf("underline", "wavy"));

    assert.equal(f.panelElement(), null, "设置类控件点一下就收面板");
    assert.ok(f.document.getSelection().rangeCount > 0, "选区必须留着");
    assert.ok(protyle.toolbar.element.isConnected);
});

test("从浮动工具栏的按钮点击打开面板时，同一次点击冒泡到 document 不能把面板关掉", () => {
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    f.clickToolbarButton(protyle);
    assert.ok(f.panelElement(), "面板应当在这次点击之后仍然留在文档里");
    // 面板确实能用来改设置，不是一个开了就被回收的空壳
    f.click(f.styleSwatchOf("underline", "wavy"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
});

test("面板外的点击仍然关闭面板", () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    const outside = f.document.getElementById("editor");
    assert.ok(f.panelElement(), "面板外的按下不关闭面板");
    f.mouse(outside, "click");
    assert.equal(f.panelElement(), null, "面板外的点击关闭面板");
});

// ------------------------------------------------------- 打开面板时对文档做的改动
//
// 用户报过的症状：「选中一段没有下划线的文字，打开面板，开关是开的、实线也是选中的，
// 文档里却什么也没出现。」于是打开面板本身就要真的落笔；已经装饰好的选区则一个字都不动。

test("打开面板时选区里没有下划线：默认装饰真的落到文档上，并恰好发一次 updateBlock", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));

    // 面板摆出来的那一份，就是刚被应用的那一份：默认实线 + 跟随文字颜色
    assert.equal(f.checkedOf("underline"), true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);
    assert.equal(f.pressed(f.followSwatchOf("underline")), true);
    // 装饰立刻出现在编辑器里，不必等落盘
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DEFAULT, "实线 + 跟随文字色必须真的画出来");
    assert.equal(f.block(BLOCK_A).textContent, "hello", "一个字都不许少");

    await settle();
    // 用户这一次动作只产生一次落盘：一个块一条 updateBlock
    assert.deepEqual(f.posts.map((post) => post.url), [UPDATE_BLOCK_API]);
    assert.equal(f.posts[0].data.id, BLOCK_A);
    assert.equal(f.posts[0].data.dataType, "dom");
    assert.equal(f.posts[0].data.data, f.blockHTML(BLOCK_A));

    // 这一步同样可撤销：按一次撤销整段退回打开面板之前的样子（撤销自己那一次写回不算在内）
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(f.blockHTML(BLOCK_A), SINGLE_BLOCK_HTML, "撤销把打开面板时的那一次改动整体退回");
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_A]);
});

test("打开面板时选区里已经有下划线：只显示设置，文档一个字节都不动", async () => {
    const f = createFixture({blocks: DECORATED_HTML});
    f.plugin.onload();
    const before = f.blockHTML(BLOCK_A);
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    await settle();

    // 已经有装饰时只是显示设置：不重裹一遍（那只会多一次落盘），也不碰思源自己的标记
    assert.equal(f.blockHTML(BLOCK_A), before, "已有装饰的选区，块 HTML 必须逐字节不变");
    assert.deepEqual(f.posts, [], "不得发出任何 updateBlock");
    assert.deepEqual(f.calls.messages, []);
    assert.equal(f.checkedOf("underline"), true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#e5484d")), true);
    // 也没有别的改动可撤：撤销键因此摆成禁用
    assert.equal(f.actionButton("undo").getAttribute("aria-disabled"), "true", "打开面板不算一次可撤销的改动");
});

test("选区里的装饰不一致时，打开面板同样一个字节都不动", async () => {
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">hello</p>` +
        `<p data-type="text" data-node-id="${BLOCK_B}">${savedDecoration(SAVED_WAVY_RED, "world")}</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    await settle();

    // 选区里已经有下划线（只有第二段有），因此这属于「已经打开」那一档：先说清楚，不替他统一
    assert.equal(f.mixedHint().hidden, false, "混合状态要先告诉用户");
    assert.deepEqual(f.posts, [], "不得趁打开面板把没打算动的那一段一起改掉");
    assert.equal(f.blockHTML(BLOCK_A), SINGLE_BLOCK_HTML);
    assert.ok(f.blockHTML(BLOCK_B).includes(SAVED_WAVY_RED));
});

test("思源自己的 <u> 在打开面板时被脱掉，换成插件自己的下划线", async () => {
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">plain ${nativeUnderline("under")} tail</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));

    // <u> 让位：同一段文字上只能有一条下划线，而插件的这条是面板能调的
    assert.equal(f.block(BLOCK_A).querySelectorAll("u").length, 0, "思源自己的 <u> 必须被脱掉");
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DEFAULT, "取而代之的是插件自己的装饰");
    assert.equal(f.block(BLOCK_A).textContent, "plain under tail", "脱掉 <u> 必须一个字都不改");
    assert.equal(f.checkedOf("underline"), true, "面板显示的是刚刚真的应用的那一份");

    await settle();
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A], "脱 <u> 与应用装饰合起来只落一次盘");

    // 两者是同一次改动：按一次撤销，<u> 回到原样，插件的装饰一起消失
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(f.blockHTML(BLOCK_A), html, "撤销把 <u> 与插件装饰一起退回");
});

test("只有落在选区里的 <u> 被脱掉，同一块里其余位置的 <u> 逐字节不变", async () => {
    const marked = `<p data-type="text" data-node-id="${BLOCK_A}">one ${nativeUnderline("two")} three ${
        nativeUnderline("four")
    }</p>`;
    // "one " 覆盖 [0, 4)：两个 <u> 都在它之外
    const outside = createFixture({blocks: marked});
    outside.plugin.onload();
    outside.clickToolbarItem(outside.protyleOf(outside.offsetRange(outside.block(BLOCK_A), 0, 4)));

    assert.equal(outside.block(BLOCK_A).querySelectorAll("u").length, 2, "选区之外的 <u> 一个都不许动");
    assert.equal(
        outside.blockHTML(BLOCK_A),
        `<p data-type="text" data-node-id="${BLOCK_A}"><span style="text-decoration-line: underline; ` +
            'text-decoration-style: solid; text-decoration-color: currentColor">one </span>' +
            `${nativeUnderline("two")} three ${nativeUnderline("four")}</p>`,
        "只有选区那一段被铺上下划线，两个 <u> 原样留着",
    );
    assert.equal(outside.block(BLOCK_A).textContent, "one two three four");
    outside.closePanel();

    // 选区落在 "three " 上（[8, 14)），同样一个 <u> 都碰不到
    const middle = createFixture({blocks: marked});
    middle.plugin.onload();
    middle.clickToolbarItem(middle.protyleOf(middle.offsetRange(middle.block(BLOCK_A), 8, 14)));
    const survivors = Array.from(middle.block(BLOCK_A).querySelectorAll("u")).map((element) => element.textContent);
    assert.deepEqual(survivors, ["two", "four"], "两个 <u> 都原样留着，一个字都没动");
    assert.equal(middle.block(BLOCK_A).textContent, "one two three four");
    middle.closePanel();
});

test("另一个块里的 <u> 完全不在作用域内", async () => {
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">plain ${nativeUnderline("under")} tail</p>` +
        `<p data-type="text" data-node-id="${BLOCK_B}">other ${nativeUnderline("mark")}</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    await settle();

    assert.equal(f.block(BLOCK_A).querySelectorAll("u").length, 0, "选区所在的那一段：脱掉");
    assert.equal(f.block(BLOCK_B).querySelectorAll("u").length, 1, "另一个块的 <u> 一个都不许碰");
    assert.ok(f.blockHTML(BLOCK_B).includes(nativeUnderline("mark")), "另一个块逐字节不变");
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A], "只为改过的块落盘");
});

test("<u> 只覆盖选区的一部分时整条脱掉，缺掉的那半截由插件的装饰接管", async () => {
    // "ab " 是 [0, 3)，"cdef" 是 [3, 7)，" gh" 从 [7) 起。选区 [0, 5) 与 <u> 相交但没盖住它：
    // 行内元素无法按字符偏移切成两半，留半截又会让选区里那部分叠成两条线，因此整条脱掉。
    // 解包只改嵌套关系，字符偏移因此仍然指着同一批文字，装饰照样铺满 [0, 5)
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">ab ${nativeUnderline("cdef")} gh</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.offsetRange(f.block(BLOCK_A), 0, 5)));

    assert.equal(f.block(BLOCK_A).querySelectorAll("u").length, 0, "与选区相交的 <u> 整条脱掉");
    assert.equal(f.block(BLOCK_A).textContent, "ab cdef gh", "文字一个字都不许少");
    const decoration = f.block(BLOCK_A).querySelector("span[style]");
    assert.ok(decoration, "选区里仍然有插件自己的装饰");
    assert.equal(decoration.textContent, "ab cd", "装饰正好铺满选区");
});

test("思源的 <u> 与插件装饰同时存在：<u> 让位，插件那份装饰保持同一份配置", async () => {
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">plain ${nativeUnderline("native")} ` +
        `${savedDecoration(SAVED_WAVY_RED, "plugin")} tail</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    await settle();

    assert.equal(f.block(BLOCK_A).querySelectorAll("u").length, 0, "思源那条让位");
    assert.ok(f.blockHTML(BLOCK_A).includes(SAVED_WAVY_RED), "插件那份装饰的线型与颜色不变");
    assert.equal(f.block(BLOCK_A).querySelectorAll("span[style]").length, 1, "仍然只有一条下划线");
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#e5484d")), true);
    assert.equal(f.mixedHint().hidden, true, "整段都是同一份装饰，不该报混合");
    assert.equal(f.block(BLOCK_A).textContent, "plain native plugin tail");
    // 脱 <u> 与这次装饰改动合成一条：按一次撤销，<u> 与装饰一起退回打开面板之前的样子
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(f.blockHTML(BLOCK_A), html);
});

test("选区里没有下划线时一律用默认配置，不再沿用上次的设置", async () => {
    // Bug 1：初次点开增强下划线，应该把下划线改成「实线 + 跟随文字色」并应用，
    // 而不是沿用上一次用过的（这里是关掉 + wavy）。思源那一条 <u> 仍然让位。
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">plain ${nativeUnderline("under")} tail</p>`;
    const f = createFixture({blocks: html, data: {[SETTINGS_FILE]: {enabled: false, style: "wavy", color: ""}}});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));

    assert.equal(f.block(BLOCK_A).querySelectorAll("u").length, 0, "<u> 仍然脱掉");
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DEFAULT, "落笔的是默认的实线 + 跟随文字色");
    assert.equal(f.checkedOf("underline"), true, "开关显示为开");
    assert.equal(f.pressed(f.followSwatchOf("underline")), true, "颜色显示为跟随文字色");
    assert.equal(f.block(BLOCK_A).textContent, "plain under tail");
    // 存储里的那份 wavy 配置一个字都不该被读出来用上
    assert.equal(f.posts.length, 0, "落笔还在防抖窗口里，此刻没有落盘");
    await settle();
    assert.equal(f.posts.length, 1);
    assert.match(f.posts[0].data.data, DECORATED_UNDERLINE_DEFAULT);
    // 脱 <u> 与落笔合成一条：按一次撤销就把 <u> 放回去
    f.reopen();
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(f.blockHTML(BLOCK_A), html);
});

test("打开面板时记下的偏移已经越界：整次放弃，不落盘并提示用户", async () => {
    // 打开面板这一次的落笔走的是与用户点控件同一条路，因此偏移校验那道闸对它一样生效。
    // 夹具在 applyDecoration 入口处把块换短，模拟思源在记下偏移与应用之间重渲染了块
    const f = createFixture();
    f.plugin.onload();
    const apply = f.plugin.applyDecoration;
    f.plugin.applyDecoration = function(decoration, options) {
        // 面板还没建起来 ⇒ 这一次就是打开面板时的落笔
        if (this.panel === null) {
            f.shrinkBlock(BLOCK_A, "ab");
        }
        return apply.call(this, decoration, options);
    };
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    await settle();

    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false, "越界的坐标不得凭空多出装饰");
    assert.equal(f.block(BLOCK_A).textContent, "ab", "用户的文字原样保留");
    assert.deepEqual(f.posts, [], "越界的坐标不得变成一次落盘");
    assert.deepEqual(f.calls.messages, ["⟦selectionChanged⟧"], "与其它路径同一条提示：选区已变，请重选");
    // 面板照常开起来，用户可以重选之后再试
    assert.ok(f.panelElement());
});

test("把下划线关掉之后重新打开：默认配置真的铺回选区并落盘", async () => {
    // 关掉是一次真实改动：装饰从文档里去掉。之后重新打开面板时选区已无装饰，
    // 因此按 Bug 1 的约定落的是默认配置（实线 + 跟随文字色）
    const f = createFixture({blocks: DECORATED_TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));

    f.click(f.switchOf("underline"));
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false, "关掉之后装饰真的没了");
    // 收面板时会把这次改动立刻发出去，不能一直躺在防抖窗口里
    await settle();
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_B], "关掉一次，各块各发一次");

    f.reopen(f.crossRange);
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DEFAULT, "重新打开时落的是默认配置");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_DEFAULT);
    assert.equal(f.checkedOf("underline"), true);

    await settle();
    assert.deepEqual(
        f.posts.map((post) => post.data.id),
        [BLOCK_A, BLOCK_B, BLOCK_A, BLOCK_B],
        "重新打开一次，各块各发一次",
    );
});

// ------------------------------------------------------------------ 改动落到文档

test("跨两段应用后按一次撤销就把两段一起退回", async () => {
    // 从已装饰的块出发：打开面板因此不落笔，撤销栈里就只有用户点出来的那一次改动
    const f = createFixture({blocks: DECORATED_TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "dotted"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED);
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_DOTTED);
    // 用户这一次操作跨两个块，每个块各发一次
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_B]);

    // 设置类控件点了就收面板；重新打开仍能撤掉刚才那一次改动（撤销栈活得比面板久）
    f.reopen(f.crossRange);
    const undo = f.actionButton("undo");
    assert.equal(undo.getAttribute("aria-disabled"), null, "有东西可撤销时撤销键是可用的");
    f.click(undo);
    await tick();

    // 用户做的是一次操作，撤销也必须是一次：只退回后一段的话，
    // 面板还显示着点下去的那份配置，实际却有一半选区没退回
    assert.equal(f.blockHTML(BLOCK_A), DECORATED_BLOCK_A_HTML, "第一段要一起退回改动前的样子");
    assert.equal(f.blockHTML(BLOCK_B), DECORATED_BLOCK_B_HTML, "第二段也要退回");
    // 撤销同样把面板收起来了
    assert.equal(f.panelElement(), null, "撤销之后面板收起");
    // 重新打开：撤销栈已经空了，撤销键因此摆成禁用，按它什么也不会发生
    f.reopen(f.crossRange);
    const undoAgain = f.actionButton("undo");
    assert.equal(undoAgain.getAttribute("aria-disabled"), "true", "没有东西可撤销时撤销键是禁用的");
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true, "面板显示的是文档里真实的那份配置");
    const beforeUndo = f.blockHTML(BLOCK_A);
    f.click(undoAgain);
    await tick();
    assert.equal(f.blockHTML(BLOCK_A), beforeUndo, "禁用的撤销键连回调都不会发：文档一个字节都不动");
    assert.deepEqual(
        f.posts.map((post) => post.data.id),
        [BLOCK_A, BLOCK_B, BLOCK_A, BLOCK_B],
        "禁用的撤销键不产生任何新落盘",
    );
});

test("选区内的装饰不一致时面板先给出混合提示，点一下才统一", async () => {
    // 只有第二块被装饰过，第一块是干净的：只读第一块的话，
    // 面板会拿默认值开场，用户随手一点就把第二块的装饰改掉了，且事先没有任何提示
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">hello</p>` +
        `<p data-type="text" data-node-id="${BLOCK_B}">${savedDecoration(SAVED_WAVY_RED, "world")}</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));

    const hint = f.mixedHint();
    assert.ok(hint, "混合选区必须显式告知用户");
    assert.equal(hint.hidden, false);
    // 面板展示的是第一个有装饰的分组的配置
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.ok(f.colorSwatchOf("underline", "#e5484d") !== null);

    const dotted = f.styleSwatchOf("underline", "dotted");
    f.click(dotted);
    assert.equal(hint.hidden, true, "统一之后提示撤掉");
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED, "第一段按面板当前这份配置铺开");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_DOTTED, "第二段被统一，而不是保持原样");
});

test("选区内的装饰一致时不显示混合提示", () => {
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">${savedDecoration(SAVED_WAVY_RED, "hello")}</p>` +
        `<p data-type="text" data-node-id="${BLOCK_B}">${savedDecoration(SAVED_WAVY_RED, "world")}</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));

    assert.equal(f.mixedHint().hidden, true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
});

test("面板里的改动落到选区上，跨块时每个块各发一次 updateBlock", async () => {
    const f = createFixture({blocks: DECORATED_TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "dotted"));
    // 装饰立刻出现在编辑器里，不必等落盘
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED);
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_DOTTED);
    await settle();
    // 两个块两个 id：传错记账键会被防抖保存器并成一次，只剩最后一个块落盘
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
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
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
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    // 再走一次「记下的坐标对不上」的分支：那条提示也是插件会取的键，同样要过这道检查。
    // 面板开着期间块被换短，因此记下的那对偏移不再对应任何字符
    f.reopen();
    f.shrinkBlock(BLOCK_A, "ab");
    f.click(f.styleSwatchOf("underline", "dotted"));
    const keys = f.requestedI18NKeys();
    assert.ok(keys.includes("underlineEnhancement"), "工具栏提示应当取自 i18n");
    assert.ok(keys.includes("saveFailed"), "保存失败提示应当取自 i18n");
    assert.ok(keys.includes("selectionChanged"), "坐标对不上的提示应当取自 i18n");
    for (const locale of ["zh-CN", "en"]) {
        const table = readLocale(locale);
        for (const key of keys) {
            assert.equal(typeof table[key], "string", `${locale}.json 缺少插件用到的键 ${key}`);
            assert.notEqual(table[key].trim(), "", `${locale}.json 的 ${key} 是空串，界面上会显示空白`);
        }
    }
    assert.ok(!keys.includes("overline"), "上划线方向已删除，不该再有这个键");
});

test("清除装饰去掉下划线", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);

    f.reopen();
    f.click(f.actionButton("clear"));

    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false);
    await settle();
    // 清除本身也要落盘，否则磁盘上还留着上一版装饰
    assert.equal(HAS_DECORATION_SPAN.test(f.posts[f.posts.length - 1].data.data), false);
});

test("关掉下划线之后重新打开：选区已无装饰，面板回到默认配置", () => {
    const f = createFixture({blocks: DECORATED_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    f.click(f.switchOf("underline"));
    // 装饰整个去掉，面板随之收起
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false);
    assert.equal(f.panelElement(), null);

    // 文档里已经没有装饰，重新打开时按约定落回默认配置
    f.reopen();
    assert.equal(f.checkedOf("underline"), true, "默认就是开着");
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);
    assert.equal(f.pressed(f.followSwatchOf("underline")), true);
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DEFAULT);
});

test("通过面板选择「跟随文字颜色」，落盘的块 HTML 带 text-decoration-color: currentColor", async () => {
    // 实测：省略这条声明时思源改存一条 color，装饰取到的就成了文字色本身
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    f.click(f.colorSwatchOf("underline", "#46a758"));
    await settle();
    const coloured = f.posts[f.posts.length - 1].data.data;
    assert.ok(coloured.includes("text-decoration-color: #46a758"), "先落一个具体颜色");

    f.reopen();
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
    f.reopen(() => f.cellRange(BLOCK_A));
    f.click(f.styleSwatchOf("underline", "dotted"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DOTTED);
});

test("表格单元格里撤销之后再改设置，装饰仍然落在文档上", async () => {
    const f = createFixture({blocks: DECORATED_TABLE_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.cellRange(BLOCK_A)));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);

    f.reopen(() => f.cellRange(BLOCK_A));
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(f.block(TABLE_ID).outerHTML, DECORATED_TABLE_HTML, "撤销把整张表退回打开面板之前的样子");
    assert.ok(f.blockHTML(BLOCK_A).includes(SAVED_DOTTED_RED), "单元格里退回的是打开之前那份装饰");

    // 撤销换掉的是整张表的 HTML：这一组必须重新认领到文档里的单元格，否则改的是脱管的节点
    f.reopen(() => f.cellRange(BLOCK_A));
    f.click(f.styleSwatchOf("underline", "dashed"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DASHED);
    await settle();
    const last = f.posts[f.posts.length - 1];
    assert.equal(last.data.id, TABLE_ID, "单元格的改动按所属块落盘");
    // 落盘的内容必须就是当前文档里的内容：拿着脱管节点发出去的是改动前的旧 HTML
    assert.equal(last.data.data, f.block(TABLE_ID).outerHTML);
});

test("callout 标题区撤销之后再改设置，装饰仍然落在标题上", async () => {
    const f = createFixture({blocks: DECORATED_CALLOUT_HTML});
    const title = () => f.document.querySelector(".callout-title");
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.titleRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.match(title().outerHTML, DECORATED_UNDERLINE);

    f.reopen(f.titleRange);
    f.click(f.actionButton("undo"));
    await tick();
    assert.equal(f.block(CALLOUT_ID).outerHTML, DECORATED_CALLOUT_HTML, "整个 callout 退回打开面板之前的样子");
    assert.ok(title().outerHTML.includes(SAVED_DOTTED_RED), "标题里退回的是打开之前那份装饰");

    // 标题区是新块里的哪一个由 dom.ts 按位置判定：认错了就会去装饰正文段落
    f.reopen(f.titleRange);
    f.click(f.styleSwatchOf("underline", "dashed"));
    assert.match(title().outerHTML, DECORATED_UNDERLINE_DASHED);
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
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A, BLOCK_B]);

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.reopen(f.crossRange);
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

test("重渲染之后下划线的第二次颜色改动仍然落到活着的块上，并各发一次 updateBlock", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.equal(f.posts.length, 2);

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.reopen(f.crossRange);
    f.click(f.colorSwatchOf("underline", "#0090ff"));
    await settle();

    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_BLUE, "第一段的颜色要真的换成蓝色");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_BLUE, "第二段也要换");
    assert.equal(f.posts.length, 4);
    assert.deepEqual(f.posts.slice(2).map((post) => post.data.id), [BLOCK_A, BLOCK_B]);
    assert.equal(f.posts[2].data.data, f.block(BLOCK_A).outerHTML);
    assert.equal(f.posts[3].data.data, f.block(BLOCK_B).outerHTML);
});

test("重渲染之后清除装饰，活着的块上不再有装饰", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), true, "前置条件：已经装饰上了");

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.reopen(f.crossRange);
    f.click(f.actionButton("clear"));

    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false, "第一段的装饰要真的被清掉");
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_B)), false, "第二段也要被清掉");
    await settle();
    // 清除本身也要落盘，否则磁盘上还留着上一版装饰
    assert.deepEqual(f.posts.slice(2).map((post) => post.data.id), [BLOCK_A, BLOCK_B]);
    assert.equal(HAS_DECORATION_SPAN.test(f.posts[2].data.data), false);
    assert.equal(HAS_DECORATION_SPAN.test(f.posts[3].data.data), false);
});

test("重渲染之后关掉再重新打开，默认配置仍然落到活着的块上", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();

    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);
    f.reopen(f.crossRange);
    f.click(f.switchOf("underline"));
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false, "关掉之后装饰真的没了");

    f.reopen(f.crossRange);
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE_DEFAULT, "重新打开时落的是默认配置");
    assert.match(f.blockHTML(BLOCK_B), DECORATED_UNDERLINE_DEFAULT);
});

test("重渲染之后重建的选区落在活着的文档上，而不是脱管的那一份里", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    // 换掉的节点把插件记下的块元素、可编辑区域与选区坐标一并带走了
    f.rerender(BLOCK_A);
    f.rerender(BLOCK_B);

    f.reopen(f.crossRange);
    f.click(f.styleSwatchOf("underline", "dotted"));

    const selection = f.document.getSelection();
    assert.ok(selection.rangeCount > 0, "选区必须回到文档上，用户才能接着输入");
    assert.equal(selection.toString(), "helloworld", "选中的文字要和打开面板时一致");
    assert.ok(f.block(BLOCK_A).contains(selection.anchorNode), "起点要落在活着的第一段里");
    assert.ok(f.block(BLOCK_B).contains(selection.focusNode), "终点要落在活着的第二段里");
});

test("内核回放替换掉块节点之后，选区自动落回同一段文字", async () => {
    // 真机上落盘会让内核把更新事务回放回前端，回放时整块节点被换掉、选区随之丢失。
    // 夹具用 ws 标记出「连了内核」，再用 rerender 模拟这次替换
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange(), {ws: true}));
    f.click(f.styleSwatchOf("underline", "wavy"));
    // 面板收起后选区还在
    assert.equal(f.document.getSelection().toString(), "hello");

    // 内核回放：整块被一份新的替换掉，选区此前已丢失
    f.rerender(BLOCK_A);
    f.document.getSelection()?.removeAllRanges();
    await tick();

    const selection = f.document.getSelection();
    assert.ok(selection.rangeCount > 0, "回放换块之后选区必须自动落回来");
    assert.equal(selection.toString(), "hello", "落回的是同一段文字");
    assert.ok(f.block(BLOCK_A).contains(selection.anchorNode), "落点在新块里");
});

test("回放重落不抢用户的新选择：块被换掉但用户已经选了别处", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange(), {ws: true}));
    f.click(f.styleSwatchOf("underline", "wavy"));

    // 用户改选了第二段，随后内核才回放第一段的替换
    f.document.getSelection().removeAllRanges();
    f.document.getSelection().addRange(f.offsetRange(f.block(BLOCK_B), 0, 5));
    f.rerender(BLOCK_A);
    await tick();

    assert.equal(f.document.getSelection().toString(), "world", "用户自己的新选择必须留着");
});

test("重渲染之后的改动只写活着的块，脱管的那一份不会被改到", async () => {
    const f = createFixture({blocks: TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();

    // 只重渲染第一段：跨块选区里两组的引用会一个脱管、一个仍然连着文档
    const detached = f.rerender(BLOCK_A);
    f.reopen(f.crossRange);
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

// -------------------------- 面板开着期间，记下的字符偏移不再对应区域当前的内容

/**
 * 包裹装饰之前必须先确认记下的偏移还落在区域当前的内容之内。
 *
 * 这些用例直接把块的内容在面板开着期间换短或删掉：记下的 [start, end) 因此越界，
 * 而 locate 会把越界的端点悄悄夹到区域末尾，extractContents 于是取出另一段内容，
 * 那一段会被原样写进磁盘。它们钉的是「宁可什么都不做，也不改用户的文档」。
 * jsdom 不会模拟思源的重渲染或用户的改写，这一形态由 shrinkBlock / removeBlock 显式摆出。
 */
test("记下的偏移越出内容时整次放弃：文档不动、不落盘，并提示用户", async () => {
    // 这是本次改动里最重要的一条：它钉住的是「用户的文字绝不会被截断后写进磁盘」。
    // 从已装饰的块出发：打开面板因此不落笔，这次越界的改动是会话里唯一的一次
    const f = createFixture({blocks: DECORATED_DOTTED_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    assert.equal(f.plugin.groups[0].end, 5, "前置条件：面板记下的偏移是 (0, 5)");
    assert.deepEqual(f.posts, [], "前置条件：打开面板本身没有写文档");

    // 内容被换短到只剩 2 个字符，记下的 (0, 5) 越界
    f.shrinkBlock(BLOCK_A, "ab");
    const beforeClick = f.blockHTML(BLOCK_A);
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();

    assert.equal(f.blockHTML(BLOCK_A), beforeClick, "越界的坐标一个字节都不许落到文档上");
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), false, "不该凭空多出装饰");
    assert.equal(f.block(BLOCK_A).textContent, "ab", "块里的文字必须原样保留");
    assert.deepEqual(f.posts, [], "越界的坐标不得变成一次落盘");
    assert.deepEqual(f.calls.messages, ["⟦selectionChanged⟧"], "必须明确告诉用户这次没有改动");
});

test("跨块选区里只有一组越界时整次放弃：另一段也不落盘", async () => {
    const f = createFixture({blocks: DECORATED_DOTTED_TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));

    // 只有第二段变短：一次操作要覆盖全部区域，因此不能只改掉仍然对得上的那一段
    f.shrinkBlock(BLOCK_B, "wo");
    const untouchedHTML = f.blockHTML(BLOCK_A);
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();

    assert.deepEqual(f.posts, [], "半途而废的改动一个块都不许落盘");
    assert.equal(f.blockHTML(BLOCK_A), untouchedHTML, "仍然对得上的一段也原样不动");
    assert.equal(HAS_DECORATION_SPAN.test(f.blockHTML(BLOCK_A)), true, "已有装饰保持原样");
    assert.equal(f.blockHTML(BLOCK_B), `<p data-type="text" data-node-id="${BLOCK_B}">wo</p>`);
    assert.deepEqual(f.calls.messages, ["⟦selectionChanged⟧"]);
});

test("块被删除之后记下的坐标整次放弃：不落盘，并提示用户", async () => {
    const f = createFixture({blocks: DECORATED_DOTTED_TWO_BLOCKS_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.crossRange()));
    const survivingHTML = f.blockHTML(BLOCK_A);

    f.removeBlock(BLOCK_B);
    const editorHTML = f.document.getElementById("editor").innerHTML;
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();

    // 块没了不是理由：拿脱管节点去改再发出去，改的是一份已经不存在的副本
    assert.deepEqual(f.posts, [], "不得对着已经删掉的块发请求");
    assert.equal(f.blockHTML(BLOCK_A), survivingHTML, "还在的块同样不动");
    assert.equal(f.document.getElementById("editor").innerHTML, editorHTML, "编辑器里一个字节都不许变");
    assert.deepEqual(f.calls.messages, ["⟦selectionChanged⟧"]);
});

test("记下的偏移仍然对得上时照常改动并落盘", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));

    f.click(f.styleSwatchOf("underline", "wavy"));
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);
    await settle();
    // 对得上的坐标照旧一路走到 updateBlock：这道闸不能把正常功能也拦下来。
    // 打开面板时的应用与这一下改动在同一个防抖窗口里，因此一个块只发一次，内容取最后一次
    assert.deepEqual(f.posts.map((post) => post.url), [UPDATE_BLOCK_API]);
    assert.equal(f.posts[0].data.id, BLOCK_A);
    assert.equal(f.posts[0].data.dataType, "dom");
    assert.equal(f.posts[0].data.data, f.blockHTML(BLOCK_A));
    assert.deepEqual(f.calls.messages, [], "正常路径不该弹任何提示");
});

test("零宽范围是静默的空操作：既不报错也不落盘", async () => {
    const f = createFixture({blocks: DECORATED_DOTTED_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    // 白盒地把这一组的范围退化成零宽：覆盖不到任何字符的选区是一次合法的空操作，
    // 不是「记下的坐标对不上」，因此不该打断用户，也不该产生任何改动
    const [group] = f.plugin.groups;
    group.end = group.start;
    const beforeClick = f.blockHTML(BLOCK_A);

    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();

    assert.deepEqual(f.calls.messages, [], "零宽范围不是错误");
    assert.deepEqual(f.posts, [], "零宽范围不产生改动，也就没有落盘");
    assert.equal(f.blockHTML(BLOCK_A), beforeClick);
});

test("撤销把块换回改动前的样子", async () => {
    const f = createFixture({blocks: DECORATED_DOTTED_HTML});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.match(f.blockHTML(BLOCK_A), DECORATED_UNDERLINE);

    // 设置类控件点了就收面板；重新打开仍能撤销，栈不随面板清空
    f.reopen();
    f.click(f.actionButton("undo"));
    await tick();
    assert.ok(f.blockHTML(BLOCK_A).includes(SAVED_DOTTED_RED), "文档退回改动前的样子");
    assert.equal(f.blockHTML(BLOCK_A), DECORATED_DOTTED_HTML);
});

// ------------------------------------------------------------------ 回填与记忆

test("打开面板时按选区里已有装饰的 text-decoration 声明回填", () => {
    // 夹具是思源存盘后重新渲染出来的形态：span 上只有 data-type 与 style，没有任何标记属性
    const f = createFixture({blocks: DECORATED_HTML});
    assert.equal(f.blockHTML(BLOCK_A).includes("data-sue"), false, "夹具里本来就没有任何标记属性");
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    assert.equal(f.checkedOf("underline"), true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), true);
    assert.equal(f.pressed(f.colorSwatchOf("underline", "#e5484d")), true);
});

test("落在选区之外的装饰不参与回填", () => {
    // 装饰在「decorated」那一段，选区只覆盖前面的「plain 」
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">plain ` +
        `${savedDecoration(SAVED_WAVY_RED, "decorated")} tail</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.offsetRange(f.block(BLOCK_A), 0, 6)));
    // 面板显示的是默认值：选中的这段本来就没有装饰
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "wavy")), false);
    assert.equal(f.pressed(f.followSwatchOf("underline")), true);
    assert.equal(f.checkedOf("underline"), true);
});

test("别的工具加进来的上划线按「选区里没有装饰」处理，但清除装饰仍能把它脱掉", () => {
    // 插件不再画上划线，可别的工具加进来的上划线仍然是一段装饰声明，因此仍被认作装饰。
    // 面板这一侧只管下划线，读不到下划线就回到默认配置；
    // 剥的那一侧照旧认它，所以清除装饰照样能把这条上划线整个脱掉
    const overline = "text-decoration-line: overline; text-decoration-style: double; text-decoration-color: #0090ff";
    const html = `<p data-type="text" data-node-id="${BLOCK_A}">${savedDecoration(overline, "hi")}</p>`;
    const f = createFixture({blocks: html});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    assert.equal(f.checkedOf("underline"), true, "这一段里并没有下划线，面板给的是默认配置");
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);

    f.click(f.actionButton("clear"));
    assert.equal(f.blockHTML(BLOCK_A), `<p data-type="text" data-node-id="${BLOCK_A}">hi</p>`);
});

test("面板的初值与 loadData 无关：没装饰就是默认配置", async () => {
    const f = createFixture({loadFails: true});
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    assert.equal(f.checkedOf("underline"), true);
    assert.equal(f.pressed(f.styleSwatchOf("underline", "solid")), true);
    assert.equal(f.pressed(f.followSwatchOf("underline")), true);
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A]);
});

test("切换文档时收起面板并清空本会话的撤销栈", async () => {
    const f = createFixture();
    f.plugin.onload();
    f.clickToolbarItem(f.protyleOf(f.singleRange()));
    f.click(f.styleSwatchOf("underline", "wavy"));
    await settle();
    // 上一份文档的撤销记录留着，新面板的撤销按钮会一直可用却按不动
    f.plugin.eventBus.emit("switch-protyle");
    assert.equal(f.panelElement(), null);

    // 新面板里撤销仍然可点（面板不再有禁用态），栈空时按它什么也不改
    f.reopen();
    const undo = f.actionButton("undo");
    const before = f.blockHTML(BLOCK_A);
    f.click(undo);
    await tick();
    assert.equal(f.blockHTML(BLOCK_A), before, "切文档之后撤销栈已清空，再按撤销什么也不改");
});

test("卸载时把面板与浮动工具栏的回调一起收掉，且不丢已落盘的改动", async () => {
    const f = createFixture();
    f.plugin.onload();
    const protyle = f.protyleOf(f.singleRange());
    const originalCloseCB = protyle.toolbar.subElementCloseCB;
    f.clickToolbarItem(protyle);
    f.click(f.styleSwatchOf("underline", "wavy"));
    // 设置类控件点一下就收面板，收面板时那次保存已经发出去
    assert.deepEqual(f.posts.map((post) => post.data.id), [BLOCK_A]);
    f.plugin.onunload();
    assert.equal(f.panelElement(), null);
    assert.equal(protyle.toolbar.subElementCloseCB, originalCloseCB);
    assert.doesNotThrow(() => f.plugin.onunload());
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
