// 面板测试：在 jsdom 里摆一个浮动工具栏锚点，用真实点击驱动面板，断言它报上来的配置。
//
// 面板的依赖全部换成可控桩：src/dom.ts 只桩掉 getFrontend（事件名的真实实现因此仍走 dom.ts 的代码），
// src/model.ts 原样载入，于是 isSamePair 与 sanitizeColor 都是被测链路上的真函数。
import {JSDOM} from "jsdom";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {
    loadModule,
    toHost,
} from "./helpers/loadModule.mjs";

// 面板文案应当逐字来自 i18n 文件；直接读真实文件，键名对不上会立刻暴露
const readLocale = (locale) => JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), "utf8"));
const i18n = readLocale("zh-CN");

// 颜色白名单在测试侧独立写一遍：复用被测代码的同一份正则，断言就成了自证。
const WHITELIST = "(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|var\\(--b3-[A-Za-z0-9_-]+\\))";
const COLOR_PATTERN = new RegExp(`^${WHITELIST}$`);
// 写进 background-color 的值还要容下两种写法：跟随文字色的 transparent，
// 以及 jsdom 会把十六进制规范化成的 rgb()
const BACKGROUND_PATTERN = new RegExp(`^(${WHITELIST}|transparent|rgb\\(\\d{1,3}, \\d{1,3}, \\d{1,3}\\))$`);

const SOLID_PAIR = {
    underline: {enabled: true, style: "solid", color: "#e5484d"},
    overline: {enabled: true, style: "wavy", color: ""},
};

/** 默认形态：下划线开着、上划线关着（规格 §4 的默认值） */
const DEFAULT_PAIR = {
    underline: {enabled: true, style: "solid", color: ""},
    overline: {enabled: false, style: "solid", color: ""},
};

/** 合成的 i18n：每个键一个不会与任何真实文案相撞的记号，便于断言「有没有硬编码字面量」 */
const SENTINELS = {
    underlineEnhancement: "⟦title⟧",
    underline: "⟦underline⟧",
    overline: "⟦overline⟧",
    lineStyle: "⟦lineStyle⟧",
    color: "⟦color⟧",
    followTextColor: "⟦follow⟧",
    customColor: "⟦custom⟧",
    clearDecoration: "⟦clear⟧",
    undo: "⟦undo⟧",
    saveFailed: "⟦saveFailed⟧",
    mixedSelection: "⟦mixed⟧",
    styleSolid: "⟦styleSolid⟧",
    styleDashed: "⟦styleDashed⟧",
    styleDotted: "⟦styleDotted⟧",
    styleDouble: "⟦styleDouble⟧",
    styleWavy: "⟦styleWavy⟧",
};

/** 一个可辨认的视口坐标矩形 */
const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
});

/**
 * 两个矩形是否真的压在一起（相交面积大于 0）。
 *
 * 断言用的这份判定独立写在这里，不用被测代码导出的那份：复制一遍实现只会让断言自证。
 * 只是边挨着边不算压到，间距正是靠这一点保证的。
 */
const overlaps = (a, b) =>
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top;

/** jsdom 不做布局，rect 一律是全零；这里按元素身份分别给出尺寸，定位逻辑才有可算的输入 */
const stubRects = (window, initial) => {
    // 桩做成可改的：重摆一次之后要让几何跟着变，才看得出面板是不是重摆过
    const current = {anchor: initial.anchor, panel: initial.panel};
    window.HTMLElement.prototype.getBoundingClientRect = function() {
        return this.hasAttribute("data-sue-panel") ? current.panel : current.anchor;
    };
    return (rects) => Object.assign(current, rects);
};

/** 一组色块里被选中的那些；querySelectorAll 给的是 NodeList，先摊成数组 */
const selectedSwatches = (swatches) =>
    Array.from(swatches).filter((swatch) => swatch.getAttribute("aria-pressed") === "true");

/**
 * 整个色块行里被选中的数量：预设、跟随文字色与临时色块合起来算。
 * 「整行只允许一个选中项」是用户能直接看懂的约束，就拿它当断言。
 */
const selectedCountIn = (section) =>
    selectedSwatches(section.querySelectorAll("[data-sue-color], [data-sue-follow-color]")).length;

/**
 * 摆一个选区：jsdom 里的 getSelection() 恒为空，Range.getBoundingClientRect 也不存在。
 * 这里直接在 window 上装一个可改的 getSelection，矩形由调用方给出，
 * 于是 placePanel 的选区测量这条路在 jsdom 里也走得通（几何仍由被测代码自己算）。
 * 装上之后必须调 remove()，夹具的 close() 已经代为收摊。
 */
const stubSelection = (window, initial) => {
    let box = initial;
    window.getSelection = () => ({
        rangeCount: box === null ? 0 : 1,
        isCollapsed: box === null,
        getRangeAt: () => ({getBoundingClientRect: () => box}),
    });
    return (next) => {
        box = next;
    };
};

const createFixture = (options = {}) => {
    const frontend = options.frontend ?? "desktop";
    const initialPair = options.initialPair ?? SOLID_PAIR;
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body><div class="fn__toolbar" id="anchor"></div></body></html>',
        {pretendToBeVisual: true},
    );
    const {window} = dom;
    const {document} = window;
    const anchor = document.getElementById("anchor");
    // 思源重渲染浮动工具栏后，旧节点会脱离文档；面板必须不再拿它定位
    if (options.detachAnchor === true) {
        anchor.remove();
    }
    let setRects = () => {};
    if (options.rects !== undefined) {
        setRects = stubRects(window, options.rects);
    }
    // 给出选区矩形；null 表示量不到选区（塌成一点或没有 Range）
    let setSelection = () => {};
    if (options.selection !== undefined) {
        setSelection = stubSelection(window, options.selection);
    }

    const model = loadModule("src/model.ts");
    const domModule = loadModule("src/dom.ts", {
        dependencies: {siyuan: {getFrontend: () => frontend}},
        globals: {Node: window.Node, NodeFilter: window.NodeFilter},
    });
    const placementModule = loadModule("src/placement.ts");
    const panelModule = loadModule("src/panel.ts", {
        dependencies: {"./model": model, "./dom": domModule, "./placement": placementModule},
        globals: {document},
    });

    // vm realm 里造出来的 pair 搬回宿主 realm 才能做严格比较
    const calls = [];
    const controller = panelModule.createPanel({
        anchor,
        initialPair,
        i18n: options.i18n ?? i18n,
        undoEnabled: options.undoEnabled ?? false,
        mixed: options.mixed === true,
        // 不给就传 undefined：面板必须自己判断这个值能不能用，而不是当成字符串收下
        followTextColor: options.followTextColor,
        onChange: (pair) => calls.push({type: "change", pair: toHost(pair)}),
        onClear: () => calls.push({type: "clear"}),
        onUndo: () => calls.push({type: "undo"}),
        onClose: () => calls.push({type: "close"}),
    });
    const panel = document.querySelector("[data-sue-panel]");

    const section = (direction) => panel.querySelector(`[data-sue-section="${direction}"]`);
    const switchOf = (direction) => section(direction).querySelector("[data-sue-switch]");
    const styleSwatchesOf = (direction) => Array.from(section(direction).querySelectorAll("[data-sue-style]"));
    const styleSwatchOf = (direction, style) => section(direction).querySelector(`[data-sue-style="${style}"]`);
    // 预设色块：自定义色的临时色块另带标记，不算预设，因此预设恒为 11 块
    const colorSwatchesOf = (direction) =>
        Array.from(section(direction).querySelectorAll("[data-sue-color]:not([data-sue-custom-swatch])"));
    const customSwatchesOf = (direction) => Array.from(section(direction).querySelectorAll("[data-sue-custom-swatch]"));
    const customSwatchOf = (direction) => section(direction).querySelector("[data-sue-custom-swatch]");
    const followSwatchOf = (direction) => section(direction).querySelector("[data-sue-follow-color]");
    const customInputOf = (direction) => section(direction).querySelector("[data-sue-custom-color]");
    const labelOf = (direction, row) => section(direction).querySelector(`[data-sue-row="${row}"] [data-sue-label]`);
    const rowOf = (direction, row) => section(direction).querySelector(`[data-sue-row="${row}"]`);
    const actionButton = (action) => panel.querySelector(`[data-sue-action="${action}"]`);
    const mixedHint = () => panel.querySelector("[data-sue-mixed]");

    const ofType = (type) => calls.filter((call) => call.type === type);
    const changes = () => ofType("change").map((call) => call.pair);
    const lastChange = () => changes()[changes().length - 1];
    const countOf = (type) => ofType(type).length;

    /** 冒泡地派发一个事件；用来模拟移动端的 touchend 与 Esc */
    const fire = (element, type, init = {}) => {
        const event = type === "keydown" ?
            new window.KeyboardEvent(type, {bubbles: true, ...init}) :
            new window.Event(type, {bubbles: true, ...init});
        element.dispatchEvent(event);
        return event;
    };

    /**
     * 完整的指针序列：先按下再点击。
     * mousedown 必须带 cancelable，否则 preventDefault 不会置位 defaultPrevented，断言就成了自证；
     * click 必须是真的 MouseEvent，浏览器才会在它上面跑复选框的激活行为（jsdom 与浏览器同此约定）。
     */
    const press = (element) => {
        const down = fire(element, "mousedown", {cancelable: true});
        const click = new window.MouseEvent("click", {bubbles: true, cancelable: true});
        element.dispatchEvent(click);
        return {down, click};
    };

    return {
        window,
        document,
        anchor,
        panel,
        controller,
        model,
        placement: placementModule,
        calls,
        section,
        switchOf,
        styleSwatchesOf,
        styleSwatchOf,
        colorSwatchesOf,
        customSwatchesOf,
        customSwatchOf,
        followSwatchOf,
        customInputOf,
        labelOf,
        rowOf,
        actionButton,
        mixedHint,
        changes,
        lastChange,
        countOf,
        fire,
        press,
        // 改掉矩形桩 / 选区桩，用来验证面板在视口变化之后真的会重摆
        setRects: (rects) => setRects(rects),
        setSelection: (box) => setSelection(box),
        close: () => window.close(),
    };
};

// ------------------------------------------------------------------ 结构

test("面板挂到 body 上并带 data-sue-panel 标记", () => {
    const {panel, document, close} = createFixture();
    assert.ok(panel, "面板根元素应带 data-sue-panel 标记属性");
    assert.equal(panel.parentElement, document.body, "面板挂在 document.body 上，而不是浮动工具栏内部");
    close();
});

test("面板含两个方向区块，各带开关、5 个线型色块、跟随文字色色块、11 个预设色块与取色器", () => {
    const {panel, model, switchOf, styleSwatchesOf, colorSwatchesOf, followSwatchOf, customInputOf, close} =
        createFixture();
    assert.deepEqual(
        Array.from(panel.querySelectorAll("[data-sue-section]")).map((element) =>
            element.getAttribute("data-sue-section")
        ),
        ["underline", "overline"],
    );
    for (const direction of ["underline", "overline"]) {
        const toggle = switchOf(direction);
        assert.equal(toggle.tagName, "INPUT");
        assert.equal(toggle.type, "checkbox");
        assert.ok(toggle.classList.contains("b3-switch"), "开关复用思源既有的 b3-switch");
        assert.deepEqual(
            styleSwatchesOf(direction).map((swatch) => swatch.getAttribute("data-sue-style")),
            toHost(model.LINE_STYLES),
            "线型色块的展示顺序必须与 LINE_STYLES 一致",
        );
        assert.equal(styleSwatchesOf(direction).length, 5);
        assert.equal(colorSwatchesOf(direction).length, 11);
        assert.deepEqual(
            colorSwatchesOf(direction).map((swatch) => swatch.getAttribute("data-sue-color")),
            toHost(model.PRESET_COLORS),
        );
        const follow = followSwatchOf(direction);
        assert.ok(follow, "每个方向都要有「跟随文字色」色块");
        assert.equal(follow.textContent, "A", "跟随文字色用字母 A 表示");
        assert.equal(follow.style.backgroundColor, "transparent", "跟随文字色色块背景透明");
        assert.equal(follow.style.color, "", "跟随文字色色块的文字色继承面板正文色");
        assert.equal(customInputOf(direction).type, "color", "每个方向都要有自定义取色器");
    }
    close();
});

test("每个方向的颜色行都给出纯黑色块", () => {
    // 纯黑是「跟随文字颜色」的显式反面，也是最常用的一个具体色：没有它就只能拿取色器去凑
    const {section, colorSwatchesOf, close} = createFixture();
    for (const direction of ["underline", "overline"]) {
        const black = section(direction).querySelector('[data-sue-color="#000000"]');
        assert.ok(black, `${direction} 区块缺纯黑色块`);
        assert.ok(
            colorSwatchesOf(direction).includes(black),
            "纯黑必须是预设色块，不能被当成自定义色的临时色块",
        );
        assert.equal(black.getAttribute("aria-pressed"), "false");
        assert.equal(black.title, "#000000", "悬停提示给出颜色原值");
        // 纯黑同样要过白名单：它会跟着装饰进文档 HTML
        assert.match(black.getAttribute("data-sue-color"), COLOR_PATTERN);
    }
    close();
});

test("「跟随文字色」色块用选中文字的计算色给 A 上色", () => {
    // 这个选项的全部意义就是预览装饰将要取到的颜色；A 显不出那个颜色，色块等于没有预览
    const computed = "rgb(18, 52, 86)";
    const {panel, followSwatchOf, close} = createFixture({followTextColor: computed});
    for (const direction of ["underline", "overline"]) {
        const follow = followSwatchOf(direction);
        assert.equal(follow.style.color, computed, `${direction} 区块的字母 A 用了真实文字色`);
        assert.match(follow.getAttribute("style"), /(^|;)\s*color:\s*rgb\(18, 52, 86\);?$/);
    }
    // 这个值只落在色块自己的 color 上：混进 text-decoration 就会跟着装饰一起进文档 HTML，
    // 而白名单只认十六进制与主题变量，保存前会被整条丢掉，界面与落盘结果就此对不上
    assert.ok(!panel.outerHTML.includes(`text-decoration-color: ${computed}`), "计算色不得混进装饰的声明");
    assert.ok(!panel.outerHTML.includes(`data-sue-color="${computed}"`), "计算色不得挂到颜色色块的属性上");
    close();
});

test("没给出文字色或值非法时都不写 color，字母保持继承", () => {
    const {followSwatchOf, close} = createFixture();
    for (const direction of ["underline", "overline"]) {
        assert.equal(followSwatchOf(direction).style.color, "", "没给出文字色时一个属性都不写");
    }
    close();

    // 计算色来自 getComputedStyle，本身不该是脏的；但面板是把它写进 DOM 的第一个地方，脏值必须在这里被挡掉
    for (
        const value of [
            "red",
            "var(--b3-font-color)",
            "#e5484d",
            "rgb(1, 2, 3); color: url(evil)",
            "url(evil)",
            "rgb(1, 2, 3) ; position: fixed",
        ]
    ) {
        const {panel, followSwatchOf: followOf, close: closePanel} = createFixture({followTextColor: value});
        for (const direction of ["underline", "overline"]) {
            assert.equal(followOf(direction).style.color, "", `脏值不得写进 style：${value}`);
        }
        assert.ok(!panel.outerHTML.includes("url("), `脏值不得留在面板标记里：${value}`);
        assert.ok(!panel.outerHTML.includes("position: fixed"), `脏值不得留在面板标记里：${value}`);
        closePanel();
    }
});

test("线型色块靠元素自身的 text-decoration 画出真实的线", () => {
    const {styleSwatchesOf, close} = createFixture();
    // 每个区块画自己的方向：上划线区块画上划线，否则那一行看起来只是上面那行的复制品
    for (const [direction, line] of [["underline", "underline"], ["overline", "overline"]]) {
        for (const swatch of styleSwatchesOf(direction)) {
            assert.equal(swatch.style.textDecorationLine, line, `${direction} 区块的线型色块`);
            assert.equal(swatch.style.textDecorationStyle, swatch.getAttribute("data-sue-style"));
            assert.equal(swatch.style.textDecorationColor, "currentColor");
            assert.notEqual(swatch.textContent, "", "色块里必须有可供装饰线绘制的文本");
            assert.equal(swatch.children.length, 0, "预览不靠子元素画，也不放图标字符");
            assert.equal(swatch.getElementsByTagName("img").length, 0, "预览不用图片");
            assert.equal(swatch.title, "", "CSS 关键词当提示文案在中文界面里读不懂，预览本身就是提示");
        }
    }
    close();
});

test("线型色块禁止空白折叠，预览线才画得满色块", () => {
    const {styleSwatchesOf, close} = createFixture();
    for (const direction of ["underline", "overline"]) {
        for (const swatch of styleSwatchesOf(direction)) {
            // 示例文本用的是 EN SPACE（U+2002，Unicode Zs），属于 CSS 定义的「可折叠空白」；
            // white-space 保持 normal 的话两个会被折成一个 0.5em，线只剩七八个像素宽，
            // dotted 变成一个点、dashed 变成一截，五个线型就分不出来了
            assert.equal(swatch.style.whiteSpace, "pre", `${direction} 区块的线型色块必须禁止折叠`);
            assert.ok(swatch.textContent.length >= 2, "示例文本要够长，线才有可辨认的长度");
        }
    }
    close();
});

// ------------------------------------------------------------------ 回填

test("默认形态下上划线方向关闭，它的线型行与颜色行整体禁用", () => {
    // 默认 pair 就是规格 §4 的那一份：下划线开、上划线关
    const {switchOf, styleSwatchesOf, colorSwatchesOf, followSwatchOf, customInputOf, close} = createFixture({
        initialPair: DEFAULT_PAIR,
    });
    assert.equal(switchOf("underline").checked, true);
    assert.equal(switchOf("overline").checked, false);
    for (
        const swatch of [...styleSwatchesOf("underline"), ...colorSwatchesOf("underline"), followSwatchOf("underline")]
    ) {
        assert.equal(swatch.disabled, false, "开着的方向不该禁用");
    }
    assert.equal(customInputOf("underline").disabled, false);
    for (const swatch of [...styleSwatchesOf("overline"), ...colorSwatchesOf("overline"), followSwatchOf("overline")]) {
        assert.equal(swatch.disabled, true, "关着的方向，线型与颜色两行都必须禁用");
    }
    assert.equal(customInputOf("overline").disabled, true, "取色器同样禁用");
    close();
});

test("方向关闭时点击该方向的色块与取色器都不产生改动", () => {
    // 复现审阅里的误操作：面板默认开着下划线、关着上划线，点上划线那行的蓝色色块
    // 结果给整段文字加上了实线下划线 —— 用户根本没要求过
    const {styleSwatchOf, colorSwatchesOf, customInputOf, followSwatchOf, window, changes, close} = createFixture({
        initialPair: DEFAULT_PAIR,
    });

    styleSwatchOf("overline", "wavy").click();
    colorSwatchesOf("overline")[5].click();
    followSwatchOf("overline").click();
    const input = customInputOf("overline");
    input.value = "#123456";
    input.dispatchEvent(new window.Event("change", {bubbles: true}));

    assert.equal(changes().length, 0, "关着的方向不得因为点色块而改设置");
    close();
});

test("方向开关关掉后该方向两行立刻禁用，再打开又恢复可用", () => {
    const {switchOf, styleSwatchOf, colorSwatchesOf, lastChange, changes, close} = createFixture();
    assert.equal(styleSwatchOf("overline", "wavy").disabled, false);

    switchOf("overline").click();
    assert.equal(styleSwatchOf("overline", "wavy").disabled, true, "关掉之后两行要马上禁用");
    assert.equal(colorSwatchesOf("overline")[0].disabled, true);
    assert.equal(changes().length, 1);

    switchOf("overline").click();
    assert.equal(styleSwatchOf("overline", "wavy").disabled, false, "打开之后要恢复可用");
    assert.equal(colorSwatchesOf("overline")[0].disabled, false);

    styleSwatchOf("overline", "wavy").click();
    assert.equal(lastChange().overline.style, "wavy");
    close();
});

test("线型色块带可读的无障碍名，取色器上的自定义色块同样如此", () => {
    const {styleSwatchOf, close} = createFixture();
    // 按钮的唯一内容是两个 EN SPACE，没有名字就只能靠图标形状辨认
    assert.equal(styleSwatchOf("underline", "solid").getAttribute("aria-label"), "实线 · 下划线");
    assert.equal(styleSwatchOf("underline", "wavy").getAttribute("aria-label"), "波浪线 · 下划线");
    assert.equal(styleSwatchOf("overline", "dotted").getAttribute("aria-label"), "点线 · 上划线");
    // 不能是 CSS 关键词：中文界面里 "wavy" 对用户没有意义
    for (const direction of ["underline", "overline"]) {
        for (const style of ["solid", "dashed", "dotted", "double", "wavy"]) {
            const swatch = styleSwatchOf(direction, style);
            const label = swatch.getAttribute("aria-label");
            assert.equal(label, `${i18n[`style${style[0].toUpperCase()}${style.slice(1)}`]} · ${i18n[direction]}`);
            assert.notEqual(label, style, "无障碍名不能直接用 CSS 关键词");
            assert.equal(swatch.getAttribute("aria-label"), label, "两个方向各有各的线型色块，名字必须带上方向");
        }
    }
    close();
});

test("打开时开关的 checked 状态与 initialPair 一致", () => {
    const cases = [
        {
            name: "默认：仅下划线开启",
            pair: {
                underline: {enabled: true, style: "solid", color: ""},
                overline: {enabled: false, style: "solid", color: ""},
            },
            expected: {underline: true, overline: false},
        },
        {name: "两方向都开", pair: SOLID_PAIR, expected: {underline: true, overline: true}},
        {
            name: "两方向都关",
            pair: {
                underline: {enabled: false, style: "dashed", color: "#0090ff"},
                overline: {enabled: false, style: "dotted", color: "#0090ff"},
            },
            expected: {underline: false, overline: false},
        },
    ];
    for (const item of cases) {
        const {switchOf, controller, close} = createFixture({initialPair: item.pair});
        assert.equal(switchOf("underline").checked, item.expected.underline, `下划线开关：${item.name}`);
        assert.equal(switchOf("overline").checked, item.expected.overline, `上划线开关：${item.name}`);
        assert.deepEqual(toHost(controller.getPair()), item.pair, `面板持有的初始配置：${item.name}`);
        close();
    }
});

test("选中项带 aria-pressed 与自定义 class，未选中项不带", () => {
    const {styleSwatchesOf, colorSwatchesOf, followSwatchOf, close} = createFixture();
    const solid = styleSwatchesOf("underline")[0];
    const dashed = styleSwatchesOf("underline")[1];
    assert.equal(solid.getAttribute("aria-pressed"), "true");
    assert.ok(solid.classList.contains("sue-swatch--selected"));
    assert.equal(dashed.getAttribute("aria-pressed"), "false");
    assert.ok(!dashed.classList.contains("sue-swatch--selected"));
    // 初始 pair 的下划线颜色是 #e5484d，上划线跟随文字色
    assert.ok(colorSwatchesOf("underline")[0].classList.contains("sue-swatch--selected"));
    assert.ok(followSwatchOf("overline").classList.contains("sue-swatch--selected"));
    close();
});

test("默认配置打开面板时，下划线的直线色块就是选中态", () => {
    // 用户报过「下划线开关默认开启，但没有出现下划线」。
    // 面板默认 pair 就是「跟随文字颜色 + 直线」，因此首屏必须把 solid 摆成选中：
    // 开关亮着、线型色块一个都不亮，用户无从判断当前到底是什么线
    const {styleSwatchOf, styleSwatchesOf, switchOf, followSwatchOf, controller, close} = createFixture({
        initialPair: DEFAULT_PAIR,
    });
    assert.deepEqual(toHost(controller.getPair()), DEFAULT_PAIR, "面板不得改动默认配置本身");

    assert.equal(switchOf("underline").checked, true, "下划线开关默认是开的");
    const solid = styleSwatchOf("underline", "solid");
    assert.equal(solid.getAttribute("aria-pressed"), "true", "solid 色块默认必须选中");
    assert.ok(solid.classList.contains("sue-swatch--selected"), "选中态 class 也要给，主题才能读出来");
    assert.equal(solid.disabled, false, "方向开着，线型色块可点");
    // 整排只允许一个选中项：solid 亮着而另一个也亮着，等于没有默认线型
    const pressed = styleSwatchesOf("underline").filter((swatch) => swatch.getAttribute("aria-pressed") === "true");
    assert.deepEqual(
        pressed.map((swatch) => swatch.getAttribute("data-sue-style")),
        ["solid"],
        "默认线型有且只有 solid 一个",
    );
    // 默认色是跟随文字颜色，于是跟随色块也必须是选中态，整行才不会一个都没选中
    assert.equal(followSwatchOf("underline").getAttribute("aria-pressed"), "true");
    // 上划线默认关着：控件禁用但选中态仍按各自的配置画，不因此串到下划线那一行
    assert.equal(switchOf("overline").checked, false);
    assert.equal(styleSwatchOf("overline", "solid").getAttribute("aria-pressed"), "true");
    assert.equal(styleSwatchOf("overline", "solid").disabled, true);
    close();
});

test("默认 pair 下点直线色块不产生改动（它已经是当前线型）", () => {
    // 首屏就选中 solid，点它等于没点意图；面板据此不回调，也不会白白重排一次装饰
    const {styleSwatchOf, changes, close} = createFixture({initialPair: DEFAULT_PAIR});
    styleSwatchOf("underline", "solid").click();
    assert.equal(changes().length, 0, "点已选中的线型色块不应产生改动");
    close();
});

// ------------------------------------------------------------------ 交互

test("点击线型色块后 onChange 收到该方向的新线型，另一个方向不受影响", () => {
    const {styleSwatchesOf, changes, lastChange, controller, close} = createFixture();
    styleSwatchesOf("underline")[2].click();
    assert.equal(changes().length, 1);
    assert.deepEqual(lastChange().underline, {enabled: true, style: "dotted", color: "#e5484d"});
    assert.deepEqual(lastChange().overline, {enabled: true, style: "wavy", color: ""});
    assert.equal(styleSwatchesOf("underline")[2].getAttribute("aria-pressed"), "true", "选中的样式随之迁移");
    assert.equal(styleSwatchesOf("underline")[0].getAttribute("aria-pressed"), "false");
    assert.equal(toHost(controller.getPair()).underline.style, "dotted");
    close();
});

test("点击开关关闭某方向后 onChange 收到 enabled false，再打开则恢复", () => {
    const {switchOf, changes, lastChange, close} = createFixture();
    switchOf("overline").click();
    assert.equal(changes().length, 1);
    assert.equal(lastChange().overline.enabled, false);
    assert.equal(lastChange().underline.enabled, true, "只动被点的那个方向");
    assert.equal(switchOf("overline").checked, false);

    switchOf("overline").click();
    assert.equal(changes().length, 2);
    assert.equal(lastChange().overline.enabled, true);
    close();
});

test("点击预设色块后 onChange 收到白名单内的颜色值", () => {
    const {colorSwatchesOf, model, changes, lastChange, close} = createFixture();
    colorSwatchesOf("underline")[5].click();
    assert.equal(changes().length, 1);
    assert.equal(lastChange().underline.color, "#0090ff");

    const neutral = colorSwatchesOf("underline")[9];
    neutral.click();
    assert.equal(lastChange().underline.color, "var(--b3-font-color8)", "思源主题变量是合法颜色值");
    assert.equal(lastChange().underline.color, model.sanitizeColor(neutral.getAttribute("data-sue-color")));
    close();
});

test("点击跟随文字色色块与自定义取色器都会更新该方向的颜色", () => {
    const {followSwatchOf, customInputOf, lastChange, changes, close} = createFixture();
    followSwatchOf("underline").click();
    assert.equal(lastChange().underline.color, "", "跟随文字色即颜色为空串");

    const input = customInputOf("underline");
    input.value = "#123456";
    input.dispatchEvent(new input.ownerDocument.defaultView.Event("change", {bubbles: true}));
    assert.equal(changes().length, 2);
    assert.equal(lastChange().underline.color, "#123456");
    close();
});

test("颜色是跟随文字色时跟随色块读作选中，挑了具体颜色就不再是", () => {
    const FOLLOW_UNDERLINE = {underline: {enabled: true, style: "solid", color: ""}, overline: DEFAULT_PAIR.overline};
    const follow = createFixture({initialPair: FOLLOW_UNDERLINE});
    assert.equal(
        follow.followSwatchOf("underline").getAttribute("aria-pressed"),
        "true",
        "颜色为空串就是跟随文字色",
    );
    follow.close();

    // 文档里的 span 带着显式的 currentColor：读回来同样要选中跟随色块，而不是落到某个默认色上
    const restored = createFixture({
        initialPair: toHost(
            follow.model.readPairFromStyle(
                "text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentColor",
                null,
            ),
        ),
    });
    assert.equal(
        restored.followSwatchOf("underline").getAttribute("aria-pressed"),
        "true",
        "读回的 currentColor 声明要显示为「跟随文字颜色」",
    );
    restored.close();

    const explicit = createFixture({
        initialPair: {underline: {enabled: true, style: "solid", color: "#46a758"}, overline: DEFAULT_PAIR.overline},
    });
    const followSwatch = explicit.followSwatchOf("underline");
    assert.equal(followSwatch.getAttribute("aria-pressed"), "false", "选了具体颜色就不再是跟随");
    // 挑一个具体颜色，再点回跟随：两个方向的选中态都要跟着走
    followSwatch.click();
    assert.equal(explicit.lastChange().underline.color, "");
    assert.equal(followSwatch.getAttribute("aria-pressed"), "true", "点跟随色块必须能清回跟随");
    explicit.colorSwatchesOf("underline")[3].click();
    assert.equal(explicit.lastChange().underline.color, "#46a758");
    assert.equal(followSwatch.getAttribute("aria-pressed"), "false");
    explicit.close();
});

test("块上已有的自定义色既回填取色器、也补一块临时色块，非 #rrggbb 的不写进取色器", () => {
    const {section, customInputOf, colorSwatchesOf, customSwatchOf, customSwatchesOf, close} = createFixture({
        initialPair: {
            underline: {enabled: true, style: "solid", color: "#123456"},
            overline: {enabled: true, style: "solid", color: "var(--b3-font-color8)"},
        },
    });
    assert.equal(customInputOf("underline").value, "#123456", "自定义色不在预设里，取色器要显示它");
    assert.equal(customInputOf("overline").value, "#000000", "主题变量不是取色器能接受的形状，不写进去");

    const custom = customSwatchOf("underline");
    assert.ok(custom, "自定义色要补一块临时色块，否则整行没有任何选中项");
    assert.equal(custom.getAttribute("data-sue-color"), "#123456");
    assert.equal(customSwatchesOf("underline").length, 1, "临时色块最多一块");
    assert.equal(custom.getAttribute("aria-pressed"), "true", "选中项就是这块临时色块");
    assert.equal(selectedCountIn(section("underline")), 1, "整行只允许一个选中项");
    assert.equal(selectedSwatches(colorSwatchesOf("underline")).length, 0, "不能顺带选中某个预设");
    assert.equal(customSwatchOf("overline"), null, "主题变量正好是预设色，不需要临时色块");
    assert.equal(colorSwatchesOf("overline")[9].getAttribute("aria-pressed"), "true");
    close();
});

test("挑了自定义色之后整行只有一个色块被选中，换回预设色或跟随文字色后临时色块撤掉", () => {
    const {
        section,
        customInputOf,
        followSwatchOf,
        colorSwatchesOf,
        customSwatchOf,
        customSwatchesOf,
        window,
        lastChange,
        close,
    } = createFixture();
    const pick = (value) => {
        const input = customInputOf("underline");
        input.value = value;
        input.dispatchEvent(new window.Event("change", {bubbles: true}));
    };

    pick("#123456");
    assert.equal(lastChange().underline.color, "#123456");
    assert.equal(customSwatchesOf("underline").length, 1, "自定义色补一块临时色块");
    assert.equal(customSwatchOf("underline").getAttribute("aria-pressed"), "true");
    assert.equal(selectedCountIn(section("underline")), 1, "整行只允许一个选中项");
    assert.equal(colorSwatchesOf("underline").length, 11, "预设色板仍是 11 块，临时色块不算预设");

    colorSwatchesOf("underline")[5].click();
    assert.equal(lastChange().underline.color, "#0090ff");
    assert.equal(customSwatchesOf("underline").length, 0, "换回预设色就撤掉临时色块");
    assert.equal(colorSwatchesOf("underline")[5].getAttribute("aria-pressed"), "true");
    assert.equal(selectedCountIn(section("underline")), 1);

    pick("#654321");
    assert.equal(customSwatchesOf("underline").length, 1, "再挑自定义色要重新补上");
    followSwatchOf("underline").click();
    assert.equal(lastChange().underline.color, "");
    assert.equal(customSwatchesOf("underline").length, 0, "跟随文字色也要撤掉临时色块");
    assert.equal(followSwatchOf("underline").getAttribute("aria-pressed"), "true");
    assert.equal(selectedCountIn(section("underline")), 1);
    close();
});

test("自定义色的临时色块真的可点，与预设色块行为一致", () => {
    // 这块色块是渲染时才插进来的：只在构造期给预设色块绑事件的话，它就是个长得像按钮的死元素
    const {customSwatchOf, window, lastChange, changes, close} = createFixture({
        initialPair: {
            underline: {enabled: true, style: "solid", color: "#123456"},
            overline: {enabled: true, style: "solid", color: ""},
        },
    });
    const chip = customSwatchOf("underline");
    assert.ok(chip, "夹具前提：这里应当有一块自定义色色块");
    assert.equal(chip.disabled, false, "它是当前正在用的颜色，必须可点");

    // 挑一个别的自定义色
    const input = chip.ownerDocument.querySelector("[data-sue-custom-color]");
    input.value = "#654321";
    input.dispatchEvent(new window.Event("change", {bubbles: true}));
    assert.equal(lastChange().underline.color, "#654321");

    // 再点回原来的那块：它必须还能接收事件，否则用户只能靠取色器换回同一个颜色
    chip.click();
    assert.equal(changes().length, 2);
    assert.equal(lastChange().underline.color, "#123456");
    close();
});

test("方向关闭时临时色块也禁用，不是一个可点却无效的死元素", () => {
    const {customSwatchOf, changes, close} = createFixture({
        initialPair: {
            underline: {enabled: false, style: "solid", color: "#123456"},
            overline: {enabled: true, style: "solid", color: ""},
        },
    });
    const chip = customSwatchOf("underline");
    assert.ok(chip);
    assert.equal(chip.disabled, true, "方向关闭时它不该还能被点");
    chip.click();
    assert.equal(changes().length, 0);
    close();
});

test("选区内的装饰不一致时面板给出提示，改动一次之后提示消失", () => {
    const {mixedHint, styleSwatchesOf, changes, close} = createFixture({mixed: true});
    const hint = mixedHint();
    assert.ok(hint, "混合选区必须先说清楚再让用户点");
    assert.equal(hint.hidden, false, "混合状态下提示必须可见");
    assert.equal(hint.textContent, i18n.mixedSelection, "提示文案取自 i18n");
    assert.notEqual(hint.textContent.trim(), "");

    styleSwatchesOf("underline")[4].click();
    // 这次改动把整个选区统一了，提示随之消失
    assert.equal(changes().length, 1);
    assert.equal(mixedHint().hidden, true);
    close();
});

test("选区内的装饰一致时不显示混合提示", () => {
    const {mixedHint, close} = createFixture({mixed: false});
    assert.equal(mixedHint().hidden, true);
    close();
});

test("重复点击当前已选中的色块不触发 onChange", () => {
    const {styleSwatchesOf, colorSwatchesOf, followSwatchOf, customInputOf, window, changes, close} = createFixture();
    // 初始 pair 的下划线已经是 solid + #e5484d，上划线已经跟随文字色
    styleSwatchesOf("underline")[0].click();
    colorSwatchesOf("underline")[0].click();
    followSwatchOf("overline").click();
    // 取色器重新挑出同一个颜色同理：四类控件都要挡住「无变化的提交」
    const input = customInputOf("underline");
    input.value = "#e5484d";
    input.dispatchEvent(new window.Event("change", {bubbles: true}));
    assert.equal(changes().length, 0, "点已选中的项没有任何新意图，不该多一次保存");

    styleSwatchesOf("underline")[1].click();
    assert.equal(changes().length, 1);
    styleSwatchesOf("underline")[1].click();
    assert.equal(changes().length, 1, "换过之后再点回来也不重复回调");
    close();
});

test("点击清除装饰与撤销分别调用 onClear 与 onUndo", () => {
    const {actionButton, countOf, close} = createFixture({undoEnabled: true});
    const clear = actionButton("clear");
    const undo = actionButton("undo");
    assert.ok(clear.classList.contains("b3-button"), "动作按钮复用思源既有的 b3-button");
    assert.ok(undo.classList.contains("b3-button"));
    assert.equal(undo.disabled, false);

    clear.click();
    assert.equal(countOf("clear"), 1);
    undo.click();
    assert.equal(countOf("undo"), 1);
    close();
});

test("undoEnabled 为 false 时撤销按钮禁用且点击无效", () => {
    const {actionButton, countOf, close} = createFixture({undoEnabled: false});
    const undo = actionButton("undo");
    assert.equal(undo.disabled, true);
    undo.click();
    assert.equal(countOf("undo"), 0, "禁用按钮不应触发回调");
    close();
});

test("getPair 返回快照，改动它不会污染面板内部状态", () => {
    const {styleSwatchesOf, controller, close} = createFixture();
    styleSwatchesOf("underline")[1].click();
    const snapshot = controller.getPair();
    snapshot.underline.style = "wavy";
    assert.equal(styleSwatchesOf("underline")[1].getAttribute("aria-pressed"), "true", "面板状态没有被外部改掉");
    assert.equal(toHost(controller.getPair()).underline.style, "dashed");
    close();
});

test("setPair 用外部读回的配置刷新控件，且不触发 onChange", () => {
    const {controller, switchOf, styleSwatchesOf, followSwatchOf, colorSwatchesOf, changes, close} = createFixture();
    // 清除装饰 / 撤销之后由调用方把真实状态读回来回填：这不是用户操作，不该回调 onChange
    const cleared = {
        underline: {enabled: false, style: "dashed", color: ""},
        overline: {enabled: false, style: "dotted", color: "var(--b3-font-color8)"},
    };
    controller.setPair(cleared);
    assert.equal(changes().length, 0, "外部回填不是用户意图，不能回调 onChange");
    assert.equal(switchOf("underline").checked, false, "开关要跟着灭掉");
    assert.equal(switchOf("overline").checked, false);
    assert.equal(styleSwatchesOf("underline")[1].getAttribute("aria-pressed"), "true", "线型选中态也要刷新");
    assert.equal(styleSwatchesOf("overline")[2].getAttribute("aria-pressed"), "true");
    assert.ok(followSwatchOf("underline").classList.contains("sue-swatch--selected"));
    assert.equal(colorSwatchesOf("overline")[9].getAttribute("aria-pressed"), "true");
    assert.equal(styleSwatchesOf("underline")[0].getAttribute("aria-pressed"), "false", "旧选中态要清掉");
    assert.deepEqual(toHost(controller.getPair()), cleared);
    close();
});

test("setPair 与构造一样先过白名单", () => {
    const {controller, close} = createFixture();
    controller.setPair({
        underline: {enabled: true, style: "zigzag", color: "red;position:fixed"},
        overline: {enabled: "yes", style: "wavy", color: "#ABC"},
    });
    const pair = toHost(controller.getPair());
    assert.equal(pair.underline.color, "", "脏颜色退回跟随文字色");
    assert.equal(pair.underline.style, "solid", "非法线型退回 solid");
    assert.equal(pair.underline.enabled, true, "布尔以外的 enabled 退回默认值");
    assert.equal(pair.overline.style, "wavy");
    assert.equal(pair.overline.color, "#ABC");
    close();
});

// ------------------------------------------------------------------ 焦点

// 面板上的控件全是 button 与 input：按下时浏览器默认把焦点从 contenteditable 带走，
// 而思源一失焦就清掉选区，面板记下的坐标随即失去意义，用户看到的就是「点一下取消选中」。
// 因此面板必须在自己的范围内吃掉 mousedown 的默认行为。jsdom 不会因为派发事件而移动焦点，
// 这里断言的是契约本身（defaultPrevented）以及控件仍然响应，端到端要留给真实思源验证。

test("面板根与每一类控件上的 mousedown 都被拦下，焦点因此留在编辑器", () => {
    const {panel, switchOf, styleSwatchOf, colorSwatchesOf, followSwatchOf, customInputOf, actionButton, fire, close} =
        createFixture({undoEnabled: true, initialPair: DEFAULT_PAIR});
    const targets = [
        ["面板根", panel],
        ["面板内的非控件", panel.querySelector("[data-sue-title]")],
        ["线型色块", styleSwatchOf("underline", "wavy")],
        ["颜色色块", colorSwatchesOf("underline")[5]],
        ["跟随文字色色块", followSwatchOf("underline")],
        ["方向开关", switchOf("underline")],
        ["取色器", customInputOf("underline")],
        ["清除装饰", actionButton("clear")],
        ["撤销", actionButton("undo")],
    ];
    for (const [name, target] of targets) {
        const event = fire(target, "mousedown", {cancelable: true});
        assert.equal(event.defaultPrevented, true, `${name} 上的 mousedown 必须被拦下`);
    }
    close();
});

test("拦下 mousedown 之后，各类控件仍然响应", () => {
    // preventDefault 只吃掉 mousedown 的默认行为（焦点转移与起拖），click 照常派发
    const {
        switchOf,
        styleSwatchOf,
        colorSwatchesOf,
        followSwatchOf,
        actionButton,
        press,
        changes,
        lastChange,
        countOf,
        close,
    } = createFixture({undoEnabled: true, initialPair: DEFAULT_PAIR});

    press(styleSwatchOf("underline", "wavy"));
    assert.equal(changes().length, 1);
    assert.equal(lastChange().underline.style, "wavy");

    press(colorSwatchesOf("underline")[5]);
    assert.equal(changes().length, 2);
    assert.equal(lastChange().underline.color, "#0090ff");

    press(followSwatchOf("underline"));
    assert.equal(changes().length, 3);
    assert.equal(lastChange().underline.color, "");

    // 开关的勾选由浏览器在 click 的激活行为里翻转，因此照样可用
    press(switchOf("overline"));
    assert.equal(changes().length, 4);
    assert.equal(lastChange().overline.enabled, true);

    press(actionButton("clear"));
    press(actionButton("undo"));
    assert.equal(countOf("clear"), 1);
    assert.equal(countOf("undo"), 1);
    close();
});

test("移动端同样只拦 mousedown，不碰 touchstart", () => {
    // preventDefault 掉 touchstart 会连带取消浏览器补发的 click 与触摸的默认滚动，
    // 面板会既点不动也滚不动；触摸设备上按钮本来也不会抢焦点，mousedown 一道足够
    const {styleSwatchOf, fire, changes, lastChange, close} = createFixture({frontend: "mobile"});
    const mousedown = fire(styleSwatchOf("underline", "wavy"), "mousedown", {cancelable: true});
    assert.equal(mousedown.defaultPrevented, true, "移动端也要拦住会把焦点带走的按下");

    const touchstart = fire(styleSwatchOf("underline", "wavy"), "touchstart", {cancelable: true});
    assert.equal(touchstart.defaultPrevented, false, "touchstart 不能拦：会连点击与滚动一起取消");

    fire(styleSwatchOf("underline", "wavy"), "touchend");
    assert.equal(changes().length, 1);
    assert.equal(lastChange().underline.style, "wavy");
    close();
});

test("拦下面板内的 mousedown 之后，面板内外的点击行为都不变", () => {
    const {panel, document, fire, countOf, close} = createFixture();
    // 面板内：mousedown 被拦下，click 仍冒泡到 document，靠 contains 排除在「面板外」之外
    const inside = fire(panel.querySelector("[data-sue-action='clear']"), "mousedown", {cancelable: true});
    assert.equal(inside.defaultPrevented, true);
    fire(panel.querySelector("[data-sue-action='clear']"), "click");
    assert.equal(countOf("close"), 0, "面板内部的点击不能被当成「面板外」");

    // 面板与锚点之外：面板管不着，按下不拦，click 照样关闭面板
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const outsideDown = fire(outside, "mousedown", {cancelable: true});
    assert.equal(outsideDown.defaultPrevented, false, "面板外的按下不受面板影响");
    assert.equal(countOf("close"), 0, "面板只监听自己的事件名，面板外的 mousedown 不关闭面板");
    fire(outside, "click");
    assert.equal(countOf("close"), 1, "面板外的点击仍然关闭面板");
    close();
});

test("destroy 之后不再拦 mousedown", () => {
    const {document, controller, styleSwatchesOf, fire, countOf, changes, close} = createFixture({undoEnabled: true});
    const before = fire(styleSwatchesOf("underline")[3], "mousedown", {cancelable: true});
    assert.equal(before.defaultPrevented, true, "夹具前提：销毁前监听是活的");

    const detached = styleSwatchesOf("underline")[3];
    controller.destroy();
    // 面板元素已从 DOM 摘掉，但监听若还留在它身上，脱管控件上的按下仍会被拦
    const after = fire(detached, "mousedown", {cancelable: true});
    assert.equal(after.defaultPrevented, false, "destroy 之后不该再有 mousedown 处理");
    fire(document.body, "click");
    assert.equal(countOf("close"), 0, "销毁后面板不该再响应任何关闭入口");
    assert.equal(changes().length, 0);
    close();
});

// ------------------------------------------------------------------ 销毁与定位

test("面板内的点击不关闭，面板外的点击与 Esc 才关闭", () => {
    const {panel, document, fire, countOf, close} = createFixture();
    panel.querySelector("[data-sue-action='clear']").click();
    assert.equal(countOf("close"), 0, "面板内部的点击不能被当成「面板外」");
    document.body.dispatchEvent(new document.defaultView.MouseEvent("click", {bubbles: true}));
    assert.equal(countOf("close"), 1);
    fire(document, "keydown", {key: "Escape"});
    assert.equal(countOf("close"), 2);
    close();
});

test("destroy 移除面板元素、摘掉挂在 document 上的监听并让面板彻底失效", () => {
    const {panel, document, controller, styleSwatchesOf, fire, countOf, changes, close} = createFixture();
    document.body.dispatchEvent(new document.defaultView.MouseEvent("click", {bubbles: true}));
    fire(document, "keydown", {key: "Escape"});
    assert.equal(countOf("close"), 2, "销毁前 document 上的监听是活的");

    const detachedSwatch = styleSwatchesOf("underline")[3];
    controller.destroy();
    assert.equal(document.querySelector("[data-sue-panel]"), null, "面板元素应从 DOM 移除");
    assert.equal(panel.parentElement, null);

    document.body.dispatchEvent(new document.defaultView.MouseEvent("click", {bubbles: true}));
    fire(document, "keydown", {key: "Escape"});
    assert.equal(countOf("close"), 2, "destroy 之后 document 上不应再回调");

    detachedSwatch.click();
    assert.equal(changes().length, 0, "已脱离文档的面板控件也不该再回调");
    controller.destroy();
    controller.destroy();
    close();
});

test("锚点脱离文档时不参与定位，面板退回视口边距", () => {
    // 这里给脱离文档的锚点也桩一个有意义的矩形，是刻意与真实浏览器作对：
    // 真浏览器里脱离文档的元素量到的是全零，会被视口夹取顺手救回边距，看不出走的是哪条路径。
    // 桩上去之后，只有 isConnected 这道闸门能把「拿失效锚点定位」这件事挡下来。
    const {anchor, panel, close} = createFixture({
        rects: {anchor: rect(300, 120, 200, 40), panel: rect(0, 0, 300, 400)},
        detachAnchor: true,
    });
    assert.equal(anchor.isConnected, false);
    assert.equal(panel.style.left, "12px", "失效锚点的坐标不能拿来算居中位置");
    assert.equal(panel.style.top, "12px");
    close();
});

test("面板按锚点水平居中落在下方，并夹取在视口内", () => {
    const {panel, close} = createFixture({
        rects: {anchor: rect(300, 120, 200, 40), panel: rect(0, 0, 300, 400)},
    });
    assert.equal(panel.style.position, "absolute");
    assert.equal(panel.style.left, "250px");
    assert.equal(panel.style.top, "168px");
    close();
});

test("锚点贴近右缘时面板被夹回视口内", () => {
    const {panel, close} = createFixture({
        rects: {anchor: rect(900, 100, 100, 40), panel: rect(0, 0, 300, 400)},
    });
    assert.equal(panel.style.left, "712px");
    close();
});

test("锚点贴近底部时面板翻到锚点上方", () => {
    const {panel, close} = createFixture({
        rects: {anchor: rect(300, 700, 200, 40), panel: rect(0, 0, 300, 400)},
    });
    assert.equal(panel.style.top, "292px");
    close();
});

test("面板比视口还高时纵向坐标退到视口内而不是被推到视口外", () => {
    // 面板高 900px 而视口只有 768px：夹取区间被挤扁，必须退到下界而不是翻到视口另一侧
    const {panel, close} = createFixture({
        rects: {anchor: rect(300, 700, 200, 40), panel: rect(0, 0, 300, 900)},
    });
    assert.equal(panel.style.left, "250px", "横向仍在夹取区间内");
    assert.equal(panel.style.top, "12px");
    close();
});

test("面板给出纵向滚动兜底，窗口太矮时不会被裁掉", () => {
    // 定位只夹两个轴，不改高度：窗口矮过面板时若没有 max-height，底部直接看不见
    const {panel, close} = createFixture({
        rects: {anchor: rect(300, 100, 200, 40), panel: rect(0, 0, 300, 900)},
    });
    assert.match(panel.style.maxHeight, /vh$/, "面板必须限高");
    assert.equal(panel.style.overflowY, "auto", "超出时改为纵向滚动");
    close();
});

// ------------------------------------------------------------------ 选区避让
//
// jsdom 不做布局，getBoundingClientRect() 一律全零，面板真正排出来什么样在这里是看不到的。
// 因此把「往哪一侧摆」做成纯函数 choosePlacement：给它显式的矩形，它只回答这个决定，
// 于是每一种情形都能用合成矩形走一遍，下面几节断言的也正是这个决定与随之写下的坐标。
// 矩形桩由夹具显式给出（面板尺寸、选区、工具栏三样都是），所以坐标断言是这套输入的确定函数，不是空转。

/** 视口（jsdom 默认 1024×768）与面板尺寸：与既有定位用例同一套，便于对照 */
const VIEWPORT = {width: 1024, height: 768};
const PANEL = {width: 300, height: 400};
/** 与 panel.ts 里那两个常量同值 */
const GAP = 8;
const MARGIN = 12;

/** 喂给纯函数的一组输入；参照矩形默认就取选区，与面板在有选区时的做法一致 */
const placementInput = (selection, overrides = {}) => ({
    viewport: overrides.viewport ?? VIEWPORT,
    panel: overrides.panel ?? PANEL,
    reference: overrides.reference ?? selection,
    avoid: overrides.avoid === undefined ? selection : overrides.avoid,
    gap: GAP,
    margin: MARGIN,
});

/** 走一遍纯函数，并按它给的坐标补出面板矩形，用来独立核对有没有压住选区 */
const place = (placement, selection, overrides = {}) => {
    const input = placementInput(selection, overrides);
    const chosen = placement.choosePlacement(input);
    return {chosen, rect: {...input.panel, left: chosen.left, top: chosen.top}};
};

test("四个候选方向的先后就是优先级：下方、上方、右侧、左侧", () => {
    // 候选表本身是契约的一部分：顺序决定了「都避得开时先挑哪一侧」与「同分时保留哪一个」
    const {placement} = createFixture();
    const candidates = placement.candidatesOf(placementInput(rect(300, 300, 200, 20)));
    assert.deepEqual(
        toHost(candidates.map((item) => item.side)),
        ["below", "above", "right", "left"],
    );
});

test("选区在视口顶部时面板落到选区下方，不压住这段文字", () => {
    const {placement} = createFixture();
    const selection = rect(300, 40, 400, 20);
    const {chosen, rect: placed} = place(placement, selection);
    assert.equal(chosen.side, "below");
    assert.equal(overlaps(placed, selection), false, "面板与选区必须没有交集");
    assert.ok(placed.top >= selection.top + selection.height, "面板整体在选区下方");
    assert.equal(chosen.fits, true, "下方放得下");
});

test("选区在视口底部时面板落到选区上方，不压住这段文字", () => {
    const {placement} = createFixture();
    const selection = rect(300, 700, 400, 20);
    const {chosen, rect: placed} = place(placement, selection);
    assert.equal(chosen.side, "above");
    assert.equal(overlaps(placed, selection), false);
    assert.ok(placed.top + placed.height <= selection.top, "面板整体在选区上方");
});

test("高过面板的多行选区挪到右边，左右两侧都放不下时挪到左边", () => {
    // 选区从上到下几乎铺满窗口：上下两侧都容不下 400px 高的面板，只能挪到旁边。
    // 面板 300 宽再加 8 的间距与 12 的边距，右侧要空出 320，左侧要空出 312，因此选区两侧各留够
    const {placement} = createFixture();
    const tall = rect(330, 0, 340, 768);
    const onRight = place(placement, tall);
    assert.equal(onRight.chosen.side, "right", "右边还放得下，先去右边");
    assert.equal(overlaps(onRight.rect, tall), false, "挪到右边也不能压住选区");

    // 选区一路顶到右边缘：右边没有位置了，左边成为唯一不压住文字的落点
    const flushRight = rect(712, 0, 312, 768);
    const onLeft = place(placement, flushRight);
    assert.equal(onLeft.chosen.side, "left", "右边放不下就去左边");
    assert.equal(overlaps(onLeft.rect, flushRight), false);
    assert.ok(onLeft.rect.left + onLeft.rect.width <= flushRight.left, "面板整体在选区左边");
});

test("左右两侧都放得下时优先选右边那一侧", () => {
    const {placement} = createFixture();
    const selection = rect(330, 0, 340, 768);
    const {chosen, rect: placed} = place(placement, selection);
    assert.equal(chosen.side, "right", "右边与左边都能避开时，按候选顺序取右边");
    assert.equal(overlaps(placed, selection), false);
});

test("选区铺满窗口时四侧都压到，取候选顺序里的第一个", () => {
    // 退化情形之一：选区占满整个视口，四个方向的夹取结果压住的面积完全相同
    const {placement} = createFixture();
    const selection = rect(0, 0, 1024, 768);
    const input = placementInput(selection);
    const {chosen, rect: placed} = place(placement, selection);
    const candidates = placement.candidatesOf(input);
    assert.ok(candidates.every((item) => item.overlap === candidates[0].overlap), "四侧压住的面积确实相同");
    assert.deepEqual(toHost(chosen), toHost(candidates[0]), "同分时取候选顺序里的第一个");
    assert.ok(chosen.overlap > 0, "避不开时如实报告压住了，而不是假装避开了");
    assert.ok(overlaps(placed, selection), "退化情形下面板确实压住了选区");
    assert.ok(placed.top >= MARGIN && placed.left >= MARGIN, "坐标仍然被夹在视口内");
});

test("四侧都压到选区时取压住最少的一侧，而不是固定取第一个", () => {
    // 选区顶到左边缘、右侧又差 20px 放不下面板：四侧都压住，但右边只压到一条边
    const {placement} = createFixture();
    const selection = rect(0, 0, 724, 768);
    const input = placementInput(selection);
    const {chosen, rect: placed} = place(placement, selection);
    const candidates = placement.candidatesOf(input);
    assert.ok(candidates.every((item) => item.overlap > 0), "四侧都压住了");
    const least = candidates.reduce((best, item) => (item.overlap < best.overlap ? item : best), candidates[0]);
    assert.equal(chosen.side, "right", "重叠最小的一侧不是候选顺序里的第一个");
    assert.deepEqual(toHost(chosen), toHost(least));
    assert.ok(chosen.overlap < Math.max(...candidates.map((item) => item.overlap)), "确实比最差的一侧压得少");
    // 右边被夹到视口边距上，与选区右缘之间正好剩一条 margin 宽的重叠
    assert.equal(placed.left + placed.width, VIEWPORT.width - MARGIN, "右侧被夹在视口边距上");
    assert.equal(selection.width - placed.left, MARGIN, "压住的正好是一条边距");
});

test("四侧都压到选区时结果是确定的：同一组输入算两次结果相同", () => {
    const {placement} = createFixture();
    const inputs = [
        // 选区铺满窗口
        placementInput(rect(0, 0, 1024, 768)),
        // 选区高过视口
        placementInput(rect(0, 0, 1024, 2000)),
        // 窗口比面板还小
        placementInput(rect(100, 100, 120, 40), {
            viewport: {width: 320, height: 240},
            panel: {width: 300, height: 400},
        }),
    ];
    for (const input of inputs) {
        const first = placement.choosePlacement(input);
        const second = placement.choosePlacement(input);
        assert.deepEqual(toHost(first), toHost(second), `同一组输入的两次结果必须一致：${first.side}`);
    }
});

test("窗口比面板还小：四个方向夹取后落在同一块，按候选顺序取第一个", () => {
    // 退化情形之二：面板比窗口还大，四个方向的夹取区间都被挤扁，落到同一块矩形上。
    // 四者重叠相同，于是同分保留候选顺序里的前一个 —— 结果仍然是确定的
    const {placement} = createFixture();
    const selection = rect(100, 100, 120, 40);
    const input = placementInput(selection, {viewport: {width: 320, height: 240}, panel: {width: 300, height: 400}});
    const chosen = placement.choosePlacement(input);
    const candidates = placement.candidatesOf(input);
    const overlaps = candidates.map((item) => item.overlap);
    assert.deepEqual([...new Set(overlaps)].length, 1, "四个方向压住的面积确实相同");
    assert.equal(chosen.overlap, Math.min(...overlaps), "重叠最小的优先");
    assert.equal(chosen.side, "below", "同分时取候选顺序里的第一个");
    assert.equal(chosen.left, MARGIN);
    assert.equal(chosen.top, MARGIN);
});

test("选区量不到时退回锚点定位：居中落在下方，与有选区时的规则一致", () => {
    // 塌成一点或没有 Range 时量不到选区（宽度或高度为 0），此时没有需要避让的文字
    const {placement} = createFixture();
    const anchor = rect(300, 120, 200, 40);
    const {chosen, rect: placed} = place(placement, anchor, {avoid: null, reference: anchor});
    assert.equal(chosen.side, "below");
    assert.equal(chosen.overlap, 0, "没有让开区时不该报重叠");
    assert.equal(placed.left, 250, "横向仍按参照矩形居中");
    assert.equal(placed.top, 168);
});

test("宽或高为 0 的让开矩形按没有选区处理", () => {
    // 塌成一点的选区量出来宽或高为 0：拿它当让开区只会把面板无谓地推开
    const {placement} = createFixture();
    const caret = rect(400, 300, 0, 18);
    const {chosen} = place(placement, caret);
    assert.equal(chosen.overlap, 0, "零宽的让开区被忽略");
});

test("浮动工具栏压在选区上时，面板仍要让开整段选区而不是只躲开工具栏", () => {
    // 工具栏容器常有一半落在选区里。只看工具栏的框，面板就会停在选区中间
    const {panel, close} = createFixture({
        rects: {anchor: rect(300, 120, 200, 40), panel: rect(0, 0, 300, 400)},
        selection: rect(300, 100, 400, 100),
    });
    assert.equal(panel.style.left, "350px", "横向仍按选区居中");
    assert.equal(panel.style.top, "208px", "下沿落在选区下沿之外，而不是工具栏下沿之外");
    close();
});

test("选区贴着视口底部时面板翻到选区上方", () => {
    const {panel, close} = createFixture({
        rects: {anchor: rect(300, 700, 200, 40), panel: rect(0, 0, 300, 400)},
        selection: rect(300, 690, 400, 60),
    });
    assert.equal(panel.style.top, "282px", "面板整体落在选区上方");
    close();
});

test("选区高过面板时面板挪到选区右侧", () => {
    const {panel, close} = createFixture({
        rects: {anchor: rect(400, 200, 120, 40), panel: rect(0, 0, 300, 400)},
        selection: rect(330, 0, 340, 768),
    });
    assert.equal(panel.style.left, "678px", "面板左沿落在选区右沿之外");
    assert.equal(panel.style.top, "184px", "竖向与选区居中");
    close();
});

// ------------------------------------------------------------------ 视口变化后重摆

test("窗口缩放之后面板重摆一次", () => {
    const {window, panel, setRects, close} = createFixture({
        rects: {anchor: rect(300, 100, 200, 40), panel: rect(0, 0, 300, 400)},
    });
    assert.equal(panel.style.top, "148px", "夹具前提：先按开面板时的几何摆好");

    // 缩放窗口会让选区与工具栏都挪位置，坐标不重算的话面板就留在原地
    setRects({anchor: rect(300, 600, 200, 40), panel: rect(0, 0, 300, 400)});
    window.dispatchEvent(new window.Event("resize"));
    assert.equal(panel.style.top, "192px", "缩放之后按新的几何重摆");
    close();
});

test("正文滚动之后面板重摆一次：滚动容器内部的滚动同样收得到", () => {
    // 思源的每个编辑区各自是滚动容器，scroll 不冒泡，只有捕获阶段的监听才收得到
    const {window, document, anchor, panel, setRects, close} = createFixture({
        rects: {anchor: rect(300, 100, 200, 40), panel: rect(0, 0, 300, 400)},
    });
    assert.equal(panel.style.top, "148px");

    setRects({anchor: rect(300, 500, 200, 40)});
    anchor.dispatchEvent(new window.Event("scroll"));
    assert.equal(panel.style.top, "92px", "编辑区内部滚动也要重摆（下沿放不下，翻到上方）");

    setRects({anchor: rect(300, 200, 200, 40)});
    window.dispatchEvent(new window.Event("scroll"));
    assert.equal(panel.style.top, "248px", "整页滚动同样要重摆");
    assert.ok(document.contains(panel));
    close();
});

test("滚面板自己的内容不重摆：面板是滚动容器，滚它不该把面板挪走", () => {
    const {window, panel, setRects, close} = createFixture({
        rects: {anchor: rect(300, 100, 200, 40), panel: rect(0, 0, 300, 400)},
    });
    setRects({anchor: rect(300, 500, 200, 40)});
    panel.dispatchEvent(new window.Event("scroll"));
    assert.equal(panel.style.top, "148px", "面板内部的滚动不得反过来挪动面板");
    close();
});

test("destroy 之后缩放与滚动都不再带着面板走", () => {
    const {window, document, controller, panel, setRects, close} = createFixture({
        rects: {anchor: rect(300, 100, 200, 40), panel: rect(0, 0, 300, 400)},
    });
    setRects({anchor: rect(300, 600, 200, 40)});
    window.dispatchEvent(new window.Event("resize"));
    assert.equal(panel.style.top, "192px", "夹具前提：销毁前视口监听是活的");

    controller.destroy();
    setRects({anchor: rect(300, 100, 200, 40)});
    window.dispatchEvent(new window.Event("resize"));
    window.dispatchEvent(new window.Event("scroll"));
    document.body.dispatchEvent(new window.Event("scroll"));
    assert.equal(panel.style.top, "192px", "销毁之后坐标不再被视口事件改动");
    close();
});

test("坐标按文档坐标系写出：滚动偏移一并加上", () => {
    // 面板是 body 上的绝对定位元素，left/top 是文档坐标；换算对两条出口同样成立
    const moved = createFixture({
        rects: {anchor: rect(300, 100, 200, 40), panel: rect(0, 0, 300, 400)},
    });
    assert.equal(moved.panel.style.top, "148px", "夹具前提：先按视口坐标摆好");
    Object.defineProperty(moved.window, "scrollY", {value: 500, configurable: true});
    moved.window.dispatchEvent(new moved.window.Event("scroll"));
    assert.equal(moved.panel.style.top, "648px", "视口里位置没变，文档坐标要加上滚动偏移");
    moved.close();

    // 退回视口边距的那条出口也是文档坐标
    const detached = createFixture({
        rects: {anchor: rect(300, 120, 200, 40), panel: rect(0, 0, 300, 400)},
        detachAnchor: true,
    });
    Object.defineProperty(detached.window, "scrollY", {value: 500, configurable: true});
    detached.window.dispatchEvent(new detached.window.Event("scroll"));
    assert.equal(detached.panel.style.top, "512px", "退回边距时同样加上滚动偏移");
    detached.close();
});

test("移动端走同一套定位：面板同样避开整段选区", () => {
    // 移动端与桌面端只有限高不同，定位没有单独的分支，避让规则因此是同一套
    const {panel, close} = createFixture({
        frontend: "mobile",
        rects: {anchor: rect(300, 120, 200, 40), panel: rect(0, 0, 300, 300)},
        selection: rect(300, 100, 400, 100),
    });
    assert.equal(panel.style.top, "208px", "面板下沿落在选区下沿之外");
    close();
});

test("移动端前端改用 touchend 绑定，并给面板加上滚动兜底", () => {
    const {panel, document, styleSwatchesOf, fire, changes, lastChange, countOf, close} = createFixture({
        frontend: "mobile",
    });
    assert.equal(panel.getAttribute("data-sue-mobile"), "true");
    assert.match(panel.style.maxHeight, /vh$/, "移动端要给面板加最大高度");
    assert.equal(panel.style.overflowY, "auto", "超出时改为纵向滚动");

    styleSwatchesOf("underline")[1].click();
    assert.equal(changes().length, 0, "移动端必须绑定 touchend，click 不该生效");
    fire(styleSwatchesOf("underline")[1], "touchend");
    assert.equal(changes().length, 1);
    assert.equal(lastChange().underline.style, "dashed");

    fire(document.body, "touchend");
    assert.equal(countOf("close"), 1, "面板外的 touchend 同样关闭面板");
    close();
});

// ------------------------------------------------------------------ 文案与安全

test("面板文案全部取自 options.i18n，没有硬编码字面量", () => {
    const {panel, section, labelOf, followSwatchOf, customInputOf, actionButton, close} = createFixture({
        i18n: SENTINELS,
    });
    assert.equal(panel.querySelector("[data-sue-title]").textContent, SENTINELS.underlineEnhancement);
    assert.equal(labelOf("underline", "switch").textContent, SENTINELS.underline);
    assert.equal(labelOf("overline", "switch").textContent, SENTINELS.overline);
    assert.equal(labelOf("underline", "style").textContent, SENTINELS.lineStyle);
    assert.equal(labelOf("overline", "color").textContent, SENTINELS.color);
    assert.equal(followSwatchOf("underline").title, SENTINELS.followTextColor);
    assert.equal(customInputOf("underline").getAttribute("aria-label"), SENTINELS.customColor);
    assert.equal(actionButton("clear").textContent, SENTINELS.clearDecoration);
    assert.equal(actionButton("undo").textContent, SENTINELS.undo);

    // 所有叶子节点的可见文本都必须是 i18n 值。「A」是规格钦定的跟随文字色字形，
    // 线型色块里的 EN SPACE 被 trim 掉，正好一并跳过
    const allowed = new Set([...Object.values(SENTINELS), "A"]);
    for (const element of Array.from(panel.querySelectorAll("*"))) {
        if (element.children.length > 0) {
            continue;
        }
        const text = element.textContent.trim();
        if (text === "") {
            continue;
        }
        assert.ok(allowed.has(text), `出现了不在 i18n 里的文案：${JSON.stringify(text)}`);
    }
    assert.ok(
        !panel.outerHTML.includes(SENTINELS.saveFailed),
        "saveFailed 属于 Task 6 的错误路径，面板不该用它",
    );
    assert.equal(section("underline").getAttribute("data-sue-section"), "underline");
    close();
});

test("面板实际用到的每个 i18n 键在两种语言的真实文件里都存在", () => {
    // 键清单从面板自己问出来的：i18n 换成记录用的 Proxy，面板取哪个键就被记下哪个。
    // 这样漏用、多用或写错一个键都会被抓到，而不是只核对一份手抄的清单。
    const requested = [];
    const recording = new Proxy({}, {
        get: (target, key) => {
            requested.push(key);
            return `⟦${String(key)}⟧`;
        },
    });
    const {close} = createFixture({i18n: recording});
    assert.deepEqual(
        [...new Set(requested)].sort(),
        [
            "clearDecoration",
            "color",
            "customColor",
            "followTextColor",
            "lineStyle",
            "mixedSelection",
            "overline",
            "styleDashed",
            "styleDotted",
            "styleDouble",
            "styleSolid",
            "styleWavy",
            "underline",
            "underlineEnhancement",
            "undo",
        ],
        "面板用到的键集合变了：新增或漏用都要同步核对",
    );
    for (const locale of ["zh-CN", "en"]) {
        const table = readLocale(locale);
        for (const key of new Set(requested)) {
            assert.equal(typeof table[key], "string", `${locale}.json 缺少面板用到的键 ${key}`);
            assert.notEqual(table[key].trim(), "", `${locale}.json 的 ${key} 是空串，界面上会显示空白`);
        }
    }
    close();
});

test("写进面板的颜色一律先过白名单，脏值既不进 DOM 也不进 getPair", () => {
    const {panel, controller, colorSwatchesOf, close} = createFixture({
        initialPair: {
            underline: {enabled: true, style: "solid", color: "red;position:fixed;background:url(evil)"},
            overline: {enabled: true, style: "solid", color: "#ABC"},
        },
    });
    const pair = toHost(controller.getPair());
    assert.equal(pair.underline.color, "", "非法颜色退化为跟随文字色");
    assert.equal(pair.overline.color, "#ABC");
    assert.ok(!panel.outerHTML.includes("position:fixed"), "脏值不得拼进面板样式");
    assert.ok(!panel.outerHTML.includes("url("), "脏值不得拼进面板样式");
    assert.ok(!panel.outerHTML.includes("red;"), "脏值不得残留在面板标记里");

    for (const swatch of Array.from(panel.querySelectorAll(".sue-swatch"))) {
        const background = swatch.style.backgroundColor;
        if (background !== "") {
            assert.match(background, BACKGROUND_PATTERN, `色块背景不在白名单内：${background}`);
        }
        const declared = swatch.getAttribute("data-sue-color");
        if (declared !== null) {
            assert.match(declared, COLOR_PATTERN, `色块上记录的颜色不在白名单内：${declared}`);
        }
    }
    assert.equal(
        colorSwatchesOf("underline")[9].style.backgroundColor,
        "var(--b3-font-color8)",
        "var(--b3-...) 在 backgroundColor 上必须原样保留",
    );
    close();
});

// 面板必须有不透明表面。
// 曾给面板根挂过思源的浮层类 b3-popover，但那个类名在思源 3.8.6 的样式表里并不存在
// （真实的浮层表面类是 .b3-menu），于是背景/边框/圆角/阴影全部落空，横向内边距也是 0，
// 底下的正文直接透过面板显示。jsdom 不加载样式表，因此这里核对样式表源码与类名引用。
test("面板根有不透明表面，且不挂思源未定义的浮层类", () => {
    const scss = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    const root = /\[data-sue-panel\]\s*\{([^}]*)\}/.exec(scss);
    assert.ok(root, "index.scss 里必须有 [data-sue-panel] 规则");
    const body = root[1];

    for (const declaration of ["background-color:", "border:", "border-radius:", "box-shadow:", "padding:"]) {
        assert.ok(body.includes(declaration), `[data-sue-panel] 缺少 ${declaration} 声明`);
    }
    // 横向内边距原来为 0，色块贴边；思源的 .b3-menu 只有 8px 0，这里要补成四边
    assert.match(body, /padding:\s*8px\s*;/, "[data-sue-panel] 必须给出四边内边距");

    // 背景兜底链的末端必须是不透明纯色。思源若改名，兜底值要接住，不能退化成透明
    assert.match(
        body,
        /background-color:[^;]*var\(--b3-menu-background[^;]*#fff[^;]*;/,
        "background-color 必须以 --b3-menu-background 起头、以不透明 #fff 兜底",
    );
    assert.ok(
        !/background-color:[^;]*(transparent|rgba\([^)]*0?\.\d+\))/i.test(body),
        "面板背景不得依赖透明或半透明色",
    );
    for (const token of ["var(--b3-theme-surface-lighter", "var(--b3-border-radius-b", "var(--b3-dialog-shadow"]) {
        assert.ok(body.includes(token), `面板表面缺少主题变量 ${token}，深浅主题会不一致`);
    }

    // 类名回归：b3-popover 在思源里不存在，挂上去等于什么都没做。
    // 先剥掉注释再比对——解释这个坑的注释里本来就会提到这个名字
    const panelSource = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
    const code = panelSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert.ok(
        !code.includes("b3-popover"),
        "panel.ts 的代码不得引用思源不存在的 b3-popover：面板会失去背景",
    );

    // 「跟随文字色」色块背景透明，A 用的是选中文字的真实颜色；而选中文字本身就可能是白色，
    // 白 A 画在白面板上照样看不见 —— 它自己那圈虚线是唯一还能看见的东西，不能没有。
    // 属性名以 panel.ts 实际写出的那个为准（不一致就说明选择器已经对不上元素了）
    assert.match(panelSource, /const FOLLOW_ATTRIBUTE = "([^"]+)"/, "panel.ts 里必须有跟随文字色色块的标记常量");
    const followAttribute = /const FOLLOW_ATTRIBUTE = "([^"]+)"/.exec(panelSource)[1];
    const follow = new RegExp(`\\[${followAttribute}\\]\\s*\\{([^}]*)\\}`).exec(scss);
    assert.ok(follow, `index.scss 里必须有 [${followAttribute}] 规则`);
    assert.match(follow[1], /\bborder:\s*[^;]+;/, "跟随文字色色块缺少 border 声明");
    assert.match(
        follow[1],
        /border:\s*1px\s+dashed\s+var\(--b3-/,
        "这圈边框必须带主题变量兜底，且用虚线与实心颜色块区分开",
    );

    // 颜色色块同样需要一圈实线边框：色板里有纯黑，而深色主题的面板本身也偏黑，
    // 没有这圈边框时纯黑那块与面板底色连成一片，用户既找不着它也点不着它。
    // 同样以 panel.ts 实际写出的属性名为准
    assert.match(panelSource, /const COLOR_ATTRIBUTE = "([^"]+)"/, "panel.ts 里必须有颜色色块的标记常量");
    const colorAttribute = /const COLOR_ATTRIBUTE = "([^"]+)"/.exec(panelSource)[1];
    const colorSwatch = new RegExp(`\\[${colorAttribute}\\]\\s*\\{([^}]*)\\}`).exec(scss);
    assert.ok(colorSwatch, `index.scss 里必须有 [${colorAttribute}] 规则`);
    assert.match(
        colorSwatch[1],
        /border:\s*1px\s+solid\s+var\(--b3-border-color[^;]*;/,
        "颜色色块必须有发丝实线边框，且用 --b3-border-color 才能在深浅主题里都看得见",
    );
    // 边框会挤进盒模型，色块宽度必须仍是 32px 那一份
    assert.match(colorSwatch[1], /box-sizing:\s*border-box\s*;/, "颜色色块加了边框，必须同时收住盒模型");
    // 只许改颜色色块自身：规则体里除了收盒模型与那圈边框不得再有别的声明，
    // 顺带改到线型色块、跟随文字色色块或其它控件都不在这次改动的范围内
    const declarations = colorSwatch[1]
        .split(";")
        .map((line) => line.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim())
        .filter((line) => line !== "");
    assert.deepEqual(
        declarations.map((line) => line.split(":")[0].trim()),
        ["box-sizing", "border"],
        `颜色色块规则里只应有盒模型与边框：${declarations.join("; ")}`,
    );
});

// 定位与样式表是一对约定：placePanel 把面板夹进 [margin, 视口宽 - 面板宽 - margin]，
// 而面板自己的最大宽度也只让出左右各一个 margin —— 两边对不上时，夹好的坐标反而把面板推出可视区。
// 高度同理：面板必须只受 max-height 约束（由 panel.ts 按桌面/移动端分别给出），
// 定死 height 的话窗口一矮面板就缩不下去，"避开文字" 只能退到越过视口边缘那一档。
// jsdom 不应用样式表，因此这里核对样式表源码与 panel.ts 里那几个常量。
test("面板根的尺寸约定与定位一致：最大宽度让出视口边距，高度只受 max-height 约束", () => {
    const scss = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    const root = /\[data-sue-panel\]\s*\{([^}]*)\}/.exec(scss);
    assert.ok(root, "index.scss 里必须有 [data-sue-panel] 规则");
    const body = root[1];

    const panelSource = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
    const margin = /const VIEWPORT_MARGIN = (\d+);/.exec(panelSource);
    assert.ok(margin, "panel.ts 里必须能读出视口边距常量");
    const edge = Number(margin[1]);
    assert.match(
        body,
        new RegExp(`max-width:\\s*calc\\(100vw\\s*-\\s*${edge * 2}px\\)`),
        `面板最大宽度必须让出左右各 ${edge}px 的视口边距`,
    );

    // 盒模型收住，量到的宽才是样式表写下的那个数
    assert.match(body, /box-sizing:\s*border-box\s*;/, "[data-sue-panel] 必须收住盒模型");
    // 不得定死高度：面板要能缩到 max-height，窗口矮过内容时才有得可缩
    assert.ok(!/(^|[\s;])height\s*:/.test(body), `面板根不得定死高度：${body.replace(/\/\/.*$/gm, "").trim()}`);
    // 限高与滚动兜底由 panel.ts 的内联样式给出，这里确认它们仍然在
    assert.match(panelSource, /const MAX_HEIGHT = "\d+vh"/, "panel.ts 里必须给出桌面端限高常量");
    assert.match(panelSource, /panel\.style\.maxHeight = mobile \? MOBILE_MAX_HEIGHT : MAX_HEIGHT;/);
    assert.match(panelSource, /panel\.style\.overflowY = "auto"/, "面板仍须是纵向滚动容器");
});
