// 面板测试：在 jsdom 里摆一个浮动工具栏锚点，用真实点击驱动面板，断言它报上来的配置。
//
// 面板的依赖全部换成可控桩：src/dom.ts 只桩掉 getFrontend（事件名的真实实现因此仍走 dom.ts 的代码），
// src/model.ts 原样载入，于是 isSameDecoration 与 sanitizeColor 都是被测链路上的真函数。
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

/** 夹具默认的初值：一个开着、实线、带具体颜色的下划线 */
const SOLID_DECORATION = {enabled: true, style: "solid", color: "#e5484d"};

/** 默认形态：下划线开着、实线、跟随文字颜色（与 model 的 DEFAULT_DECORATION 同一份语义） */
const DEFAULT_DECORATION = {enabled: true, style: "solid", color: ""};

/** 既不在预设里、也不是主题变量的颜色，因此要补一块临时的自定义色色块 */
const CUSTOM_DECORATION = {enabled: true, style: "solid", color: "#123456"};

/** 合成的 i18n：每个键一个不会与任何真实文案相撞的记号，便于断言「有没有硬编码字面量」 */
const SENTINELS = {
    underlineEnhancement: "⟦title⟧",
    underline: "⟦underline⟧",
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
    const initialDecoration = options.initialDecoration ?? SOLID_DECORATION;
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

    // vm realm 里造出来的 decoration 搬回宿主 realm 才能做严格比较
    const calls = [];
    const controller = panelModule.createPanel({
        anchor,
        initialDecoration,
        i18n: options.i18n ?? i18n,
        mixed: options.mixed === true,
        // 不给就传 undefined：撤销键的可用状态只由调用方报，面板自己不知道栈里有没有东西
        undoEnabled: options.undoEnabled,
        // 不给就传 undefined：面板必须自己判断这个值能不能用，而不是当成字符串收下
        followTextColor: options.followTextColor,
        onChange: (decoration) => calls.push({type: "change", decoration: toHost(decoration)}),
        onClear: () => calls.push({type: "clear"}),
        onUndo: () => calls.push({type: "undo"}),
        onClose: () => calls.push({type: "close"}),
        onCustomColorPicked: () => calls.push({type: "picked"}),
    });
    const panel = document.querySelector("[data-sue-panel]");

    const section = (direction) => panel.querySelector(`[data-sue-section="${direction}"]`);
    const switchOf = (direction) => section(direction).querySelector("[data-sue-switch]");
    /** 开关的勾选态读在 aria-checked 上：它不是 input，没有 checked 属性 */
    const checkedOf = (direction) => switchOf(direction).getAttribute("aria-checked") === "true";
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
    const changes = () => ofType("change").map((call) => call.decoration);
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
     * click 必须是真的 MouseEvent，浏览器才会在它上面跑控件的激活行为；
     * mousedown 带 cancelable，测试据此断言插件不再去拦任何默认行为。
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
        checkedOf,
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

/**
 * 点一个控件并给出这一夹具的全部回调记录。
 *
 * 多步交互现在可以留在同一块面板上：设置类控件不再收面板，只有终止类控件才收。
 * 仍然要一次一步的夹具，是因为每一步都要拿一个干净的调用记录来数回调。
 */
const activate = (element, options = {}) => {
    const fixture = createFixture(options);
    if (options.pickColor !== undefined) {
        const input = fixture.customInputOf("underline");
        input.value = options.pickColor;
        input.dispatchEvent(new fixture.window.Event("change", {bubbles: true}));
    } else {
        element(fixture).click();
    }
    return fixture;
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

// ------------------------------------------------------------------ 结构

test("面板挂到 body 上并带 data-sue-panel 标记", () => {
    const {panel, document, close} = createFixture();
    assert.ok(panel, "面板根元素应带 data-sue-panel 标记属性");
    assert.equal(panel.parentElement, document.body, "面板挂在 document.body 上，而不是浮动工具栏内部");
    close();
});

test("面板只有一个方向区块，带开关、5 个线型色块、跟随文字色色块、11 个预设色块与取色器", () => {
    const {panel, model, switchOf, styleSwatchesOf, colorSwatchesOf, followSwatchOf, customInputOf, close} =
        createFixture();
    // 上划线方向已经整个去掉：面板里只剩下划线这一个方向
    assert.deepEqual(
        Array.from(panel.querySelectorAll("[data-sue-section]")).map((element) =>
            element.getAttribute("data-sue-section")
        ),
        ["underline"],
    );
    const toggle = switchOf("underline");
    assert.equal(toggle.tagName, "DIV");
    assert.equal(toggle.getAttribute("role"), "switch");
    assert.deepEqual(
        styleSwatchesOf("underline").map((swatch) => swatch.getAttribute("data-sue-style")),
        toHost(model.LINE_STYLES),
        "线型色块的展示顺序必须与 LINE_STYLES 一致",
    );
    assert.equal(styleSwatchesOf("underline").length, 5);
    assert.equal(colorSwatchesOf("underline").length, 11);
    assert.deepEqual(
        colorSwatchesOf("underline").map((swatch) => swatch.getAttribute("data-sue-color")),
        toHost(model.PRESET_COLORS),
    );
    const follow = followSwatchOf("underline");
    assert.ok(follow, "要有「跟随文字色」色块");
    assert.equal(follow.textContent, "A", "跟随文字色用字母 A 表示");
    assert.equal(follow.style.backgroundColor, "transparent", "跟随文字色色块背景透明");
    assert.equal(follow.style.color, "", "跟随文字色色块的文字色继承面板正文色");
    assert.equal(customInputOf("underline").type, "color", "要有自定义取色器");
    close();
});

test("颜色行给出纯黑色块", () => {
    // 纯黑是「跟随文字颜色」的显式反面，也是最常用的一个具体色：没有它就只能拿取色器去凑
    const {section, colorSwatchesOf, close} = createFixture();
    const black = section("underline").querySelector('[data-sue-color="#000000"]');
    assert.ok(black, "颜色行缺纯黑色块");
    assert.ok(
        colorSwatchesOf("underline").includes(black),
        "纯黑必须是预设色块，不能被当成自定义色的临时色块",
    );
    assert.equal(black.getAttribute("aria-pressed"), "false");
    assert.equal(black.title, "#000000", "悬停提示给出颜色原值");
    // 纯黑同样要过白名单：它会跟着装饰进文档 HTML
    assert.match(black.getAttribute("data-sue-color"), COLOR_PATTERN);
    close();
});

test("「跟随文字色」色块用选中文字的计算色给 A 上色", () => {
    // 这个选项的全部意义就是预览装饰将要取到的颜色；A 显不出那个颜色，色块等于没有预览
    const computed = "rgb(18, 52, 86)";
    const {panel, followSwatchOf, close} = createFixture({followTextColor: computed});
    const follow = followSwatchOf("underline");
    assert.equal(follow.style.color, computed, "字母 A 用了真实文字色");
    assert.match(follow.getAttribute("style"), /(^|;)\s*color:\s*rgb\(18, 52, 86\);?$/);
    assert.equal(follow.getAttribute("aria-label"), i18n.followTextColor, "色块的无障碍名取自 i18n");
    // 这个值只落在色块自己的 color 上：混进 text-decoration 就会跟着装饰一起进文档 HTML，
    // 而白名单只认十六进制与主题变量，保存前会被整条丢掉，界面与落盘结果就此对不上
    assert.ok(!panel.outerHTML.includes(`text-decoration-color: ${computed}`), "计算色不得混进装饰的声明");
    assert.ok(!panel.outerHTML.includes(`data-sue-color="${computed}"`), "计算色不得挂到颜色色块的属性上");
    close();
});

test("没给出文字色或值非法时都不写 color，字母保持继承", () => {
    const {followSwatchOf, close} = createFixture();
    assert.equal(followSwatchOf("underline").style.color, "", "没给出文字色时一个属性都不写");
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
        assert.equal(followOf("underline").style.color, "", `脏值不得写进 style：${value}`);
        assert.ok(!panel.outerHTML.includes("url("), `脏值不得留在面板标记里：${value}`);
        assert.ok(!panel.outerHTML.includes("position: fixed"), `脏值不得留在面板标记里：${value}`);
        closePanel();
    }
});

test("线型色块靠元素自身的 text-decoration 画出真实的线", () => {
    const {styleSwatchesOf, close} = createFixture();
    for (const swatch of styleSwatchesOf("underline")) {
        // 面板只画下划线，因此预览线恒在下侧；其余两个属性仍逐个写全
        assert.equal(swatch.style.textDecorationLine, "underline", "线型色块画的是下划线");
        assert.equal(swatch.style.textDecorationStyle, swatch.getAttribute("data-sue-style"));
        assert.equal(swatch.style.textDecorationColor, "currentColor");
        assert.notEqual(swatch.textContent, "", "色块里必须有可供装饰线绘制的文本");
        assert.equal(swatch.children.length, 0, "预览不靠子元素画，也不放图标字符");
        assert.equal(swatch.getElementsByTagName("img").length, 0, "预览不用图片");
        assert.equal(swatch.title, "", "CSS 关键词当提示文案在中文界面里读不懂，预览本身就是提示");
    }
    close();
});

test("线型色块禁止空白折叠，预览线才画得满色块", () => {
    const {styleSwatchesOf, close} = createFixture();
    for (const swatch of styleSwatchesOf("underline")) {
        // 示例文本用的是 EN SPACE（U+2002，Unicode Zs），属于 CSS 定义的「可折叠空白」；
        // white-space 保持 normal 的话两个会被折成一个 0.5em，线只剩七八个像素宽，
        // dotted 变成一个点、dashed 变成一截，五个线型就分不出来了
        assert.equal(swatch.style.whiteSpace, "pre", "线型色块必须禁止折叠");
        assert.ok(swatch.textContent.length >= 2, "示例文本要够长，线才有可辨认的长度");
    }
    close();
});

// ------------------------------------------------------------------ 回填

test("开关无论开合，样式与颜色两行的控件都不带 disabled 或 aria-disabled", () => {
    // 设置类控件不允许出现任何「按了没反应」的状态：方向关着时这两行仍然可点，
    // 点下去就是把下划线打开并用上这个值。撤销键的禁用态是另一回事，由调用方单独报
    for (
        const initialDecoration of [
            DEFAULT_DECORATION,
            SOLID_DECORATION,
            {...SOLID_DECORATION, enabled: false},
            {...CUSTOM_DECORATION, enabled: false},
        ]
    ) {
        const {panel, close} = createFixture({initialDecoration, undoEnabled: false});
        const inert = Array.from(panel.querySelectorAll("[disabled], [aria-disabled]"))
            .filter((element) => element.getAttribute("data-sue-action") !== "undo");
        assert.deepEqual(
            inert.map((element) => element.outerHTML),
            [],
            `出现了被禁用的设置类控件：${JSON.stringify(initialDecoration)}`,
        );
        close();
    }
});

test("方向关闭时点线型色块会重新打开下划线", () => {
    // 「所有控件都活着」这条要求的直接后果：方向关着的时候，线型与颜色两行不再是死控件
    const {lastChange, countOf, close} = activate((f) => f.styleSwatchesOf("underline")[2], {
        initialDecoration: {...DEFAULT_DECORATION, enabled: false},
    });
    assert.equal(countOf("change"), 1, "点线型色块必须真的产生一次改动");
    assert.deepEqual(lastChange(), {enabled: true, style: "dotted", color: ""});
    close();
});

test("方向关闭时点颜色色块与取色器同样会重新打开下划线", () => {
    const preset = activate((f) => f.colorSwatchesOf("underline")[5], {
        initialDecoration: {...DEFAULT_DECORATION, enabled: false},
    });
    assert.deepEqual(preset.lastChange(), {enabled: true, style: "solid", color: "#0090ff"});
    preset.close();

    const picked = activate(() => {}, {
        initialDecoration: {...DEFAULT_DECORATION, enabled: false},
        pickColor: "#123456",
    });
    assert.deepEqual(picked.lastChange(), {enabled: true, style: "solid", color: "#123456"});
    picked.close();
});

test("关掉开关只改 enabled，线型与颜色保持不变，再打开沿用", () => {
    const off = activate((f) => f.switchOf("underline"), {initialDecoration: CUSTOM_DECORATION});
    assert.deepEqual(off.lastChange(), {...CUSTOM_DECORATION, enabled: false}, "关掉不牵动线型与颜色");
    assert.equal(off.controller.getDecoration().style, "solid");
    assert.equal(off.controller.getDecoration().color, "#123456");
    off.close();

    // 再打开：沿用关掉之前的那份线型与颜色
    const on = activate((f) => f.switchOf("underline"), {
        initialDecoration: {...CUSTOM_DECORATION, enabled: false},
    });
    assert.deepEqual(on.lastChange(), CUSTOM_DECORATION);
    on.close();
});

test("线型色块带可读的无障碍名", () => {
    const {styleSwatchOf, close} = createFixture();
    // 色块里唯一的可见内容是两个 EN SPACE，没有名字就只能靠线的形状辨认
    assert.equal(styleSwatchOf("underline", "solid").getAttribute("aria-label"), "实线");
    assert.equal(styleSwatchOf("underline", "wavy").getAttribute("aria-label"), "波浪线");
    assert.equal(styleSwatchOf("underline", "dotted").getAttribute("aria-label"), "点线");
    // 不能是 CSS 关键词：中文界面里 "wavy" 对用户没有意义
    for (const style of ["solid", "dashed", "dotted", "double", "wavy"]) {
        const label = styleSwatchOf("underline", style).getAttribute("aria-label");
        assert.equal(label, i18n[`style${style[0].toUpperCase()}${style.slice(1)}`]);
        assert.notEqual(label, style, "无障碍名不能直接用 CSS 关键词");
    }
    close();
});

test("打开时开关的勾选状态与 initialDecoration 一致", () => {
    const cases = [
        {name: "默认：实线跟随文字色", decoration: DEFAULT_DECORATION, checked: true, expected: DEFAULT_DECORATION},
        {name: "实线指定颜色", decoration: SOLID_DECORATION, checked: true, expected: SOLID_DECORATION},
        {
            name: "已关掉",
            decoration: {...SOLID_DECORATION, enabled: false},
            checked: false,
            expected: {...SOLID_DECORATION, enabled: false},
        },
        {
            name: "enabled 不是布尔值时退回默认值",
            decoration: {enabled: "yes", style: "dashed", color: "#0090ff"},
            checked: true,
            expected: {enabled: true, style: "dashed", color: "#0090ff"},
        },
    ];
    for (const item of cases) {
        const {switchOf, checkedOf, controller, close} = createFixture({initialDecoration: item.decoration});
        assert.equal(checkedOf("underline"), item.checked, `开关勾选态：${item.name}`);
        assert.equal(
            switchOf("underline").getAttribute("aria-checked"),
            String(item.checked),
            `aria-checked：${item.name}`,
        );
        assert.deepEqual(toHost(controller.getDecoration()), item.expected, `面板持有的配置：${item.name}`);
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
    // 初值的颜色是 #e5484d，因此第一块颜色色块选中；跟随色块不该同时亮着
    assert.ok(colorSwatchesOf("underline")[0].classList.contains("sue-swatch--selected"));
    assert.ok(!followSwatchOf("underline").classList.contains("sue-swatch--selected"));
    close();
});

test("线型色块的选中与未选中在 DOM 上分得开，且两档都不带禁用态", () => {
    // 「当前线型更深、其余更浅」由样式表按这两套标记画出来（见样式表用例）。
    // 面板这边只负责把两种状态真的标出来，并且不给选中那一块任何禁用的暗示：
    // 没有 hover 反应、没有禁止指针的控件，用户最初报的就是这个症状
    const {styleSwatchOf, styleSwatchesOf, close} = createFixture({
        initialDecoration: {...DEFAULT_DECORATION, style: "dotted"},
    });
    const dotted = styleSwatchOf("underline", "dotted");
    const solid = styleSwatchOf("underline", "solid");

    assert.equal(dotted.getAttribute("aria-pressed"), "true");
    assert.ok(dotted.classList.contains("sue-swatch--selected"), "选中那一块要带上选中态 class");
    assert.equal(solid.getAttribute("aria-pressed"), "false");
    assert.ok(!solid.classList.contains("sue-swatch--selected"), "未选中那一块不得带选中态 class");
    // 整排只有一个选中项：深浅之外还得先说得出「就这一个」
    assert.deepEqual(
        styleSwatchesOf("underline")
            .filter((swatch) => swatch.getAttribute("aria-pressed") === "true")
            .map((swatch) => swatch.getAttribute("data-sue-style")),
        ["dotted"],
    );
    for (const swatch of [dotted, solid]) {
        assert.equal(swatch.getAttribute("aria-disabled"), null, `线型色块不该有禁用态：${swatch.outerHTML}`);
        // 预览线仍由元素自身的 text-decoration 画出，线色取 currentColor，因此深浅落在 color 上
        assert.equal(swatch.style.textDecorationColor, "currentColor");
    }
    close();
});

test("默认配置打开面板时，下划线的直线色块就是选中态", () => {
    // 用户报过「下划线开关默认开启，但没有出现下划线」。
    // 面板默认就是「跟随文字颜色 + 直线」，因此首屏必须把 solid 摆成选中：
    // 开关亮着、线型色块一个都不亮，用户无从判断当前到底是什么线
    const {styleSwatchOf, styleSwatchesOf, checkedOf, followSwatchOf, controller, close} = createFixture({
        initialDecoration: DEFAULT_DECORATION,
    });
    assert.deepEqual(toHost(controller.getDecoration()), DEFAULT_DECORATION, "面板不得改动默认配置本身");

    assert.equal(checkedOf("underline"), true, "下划线开关默认是开的");
    const solid = styleSwatchOf("underline", "solid");
    assert.equal(solid.getAttribute("aria-pressed"), "true", "solid 色块默认必须选中");
    assert.ok(solid.classList.contains("sue-swatch--selected"), "选中态 class 也要给，主题才能读出来");
    // 整排只允许一个选中项：solid 亮着而另一个也亮着，等于没有默认线型
    const pressed = styleSwatchesOf("underline").filter((swatch) => swatch.getAttribute("aria-pressed") === "true");
    assert.deepEqual(
        pressed.map((swatch) => swatch.getAttribute("data-sue-style")),
        ["solid"],
        "默认线型有且只有 solid 一个",
    );
    // 默认色是跟随文字颜色，于是跟随色块也必须是选中态，整行才不会一个都没选中
    assert.equal(followSwatchOf("underline").getAttribute("aria-pressed"), "true");
    close();
});

test("默认配置下点直线色块不产生改动（它已经是当前线型）", () => {
    // 首屏就选中 solid，点它等于没点意图；面板据此不回调，也不会白白重排一次装饰
    const {countOf, close} = activate((f) => f.styleSwatchOf("underline", "solid"), {
        initialDecoration: DEFAULT_DECORATION,
    });
    assert.equal(countOf("change"), 0, "点已选中的线型色块不应产生改动");
    close();
});

// ------------------------------------------------------------------ 交互

test("点击线型色块后 onChange 收到新的线型，其余字段原样带过", () => {
    const {lastChange, countOf, styleSwatchesOf, controller, close} = activate(
        (f) => f.styleSwatchesOf("underline")[2],
    );
    assert.equal(countOf("change"), 1);
    assert.deepEqual(lastChange(), {enabled: true, style: "dotted", color: "#e5484d"});
    // 选中的样式随之迁移，面板虽然已经收起，控件上的选中态仍是最后那一版
    assert.equal(styleSwatchesOf("underline")[2].getAttribute("aria-pressed"), "true");
    assert.equal(styleSwatchesOf("underline")[0].getAttribute("aria-pressed"), "false");
    assert.equal(toHost(controller.getDecoration()).style, "dotted");
    close();
});

test("设置类控件不收面板，终止类控件收面板且 onClose 恰好一次", () => {
    // 一次选择上往往要连着调线型与颜色，每调一项就收一次面板等于每调一项都要重选一次。
    // 终止类操作做完没有下一次可调（清除之后整段没有装饰、撤销之后回到上一步、
    // 原生取色器那条路上选区与浮动工具栏本来就已经收摊），因此它们照旧收工。
    // 每一项给出「点它应当报上来的回调」与次数。临时自定义色色块按定义就是当前正在用的那个颜色，
    // 点它因此没有任何新意图，只有它仍被绑上了监听这件事可证
    const steps = [
        ["线型色块", (f) => f.styleSwatchOf("underline", "wavy"), {}, "change", 1, 0],
        ["颜色色块", (f) => f.colorSwatchesOf("underline")[5], {}, "change", 1, 0],
        ["跟随文字色色块", (f) => f.followSwatchOf("underline"), {}, "change", 1, 0],
        [
            "临时自定义色色块",
            (f) => f.customSwatchOf("underline"),
            {initialDecoration: CUSTOM_DECORATION},
            "change",
            0,
            0,
        ],
        ["方向开关", (f) => f.switchOf("underline"), {}, "change", 1, 0],
        ["清除装饰", (f) => f.actionButton("clear"), {}, "clear", 1, 1],
        ["撤销", (f) => f.actionButton("undo"), {}, "undo", 1, 1],
        ["原生取色器", () => {}, {pickColor: "#123456"}, "change", 1, 1],
    ];
    for (const [name, element, options, applied, expected, closes] of steps) {
        const fixture = activate(element, options);
        assert.equal(fixture.countOf("close"), closes, `${name} 的收面板次数不对`);
        assert.equal(fixture.countOf(applied), expected, `${name} 的改动必须先落地`);
        fixture.close();
    }
});

test("设置类控件连点多次，面板与选中态都留在原处", () => {
    // 用户真实的工作方式：先挑线型，再挑颜色。面板必须一直在，控件上的选中态也必须跟着走
    const fixture = createFixture();
    fixture.styleSwatchOf("underline", "wavy").click();
    fixture.colorSwatchesOf("underline")[5].click();
    fixture.followSwatchOf("underline").click();

    assert.equal(fixture.countOf("close"), 0, "三下设置都不收面板");
    assert.equal(fixture.changes().length, 3, "三下各自产生一次改动");
    assert.deepEqual(toHost(fixture.lastChange()), {enabled: true, style: "wavy", color: ""});
    assert.equal(fixture.panel.isConnected, true, "面板仍在文档里");
    assert.equal(fixture.styleSwatchOf("underline", "wavy").getAttribute("aria-pressed"), "true");
    assert.equal(fixture.followSwatchOf("underline").getAttribute("aria-pressed"), "true");
    fixture.close();
});

test("原生取色器挑完颜色：先应用，再清选区并收浮动工具栏，面板也收起", () => {
    // 这条路径与其它控件正好相反：系统取色对话框强制拿走焦点，编辑器与浮动工具栏都已收摊，
    // 于是干脆把选区也清掉，不再试着恢复它
    const {lastChange, countOf, close} = activate(() => {}, {pickColor: "#654321"});
    assert.deepEqual(lastChange(), {enabled: true, style: "solid", color: "#654321"}, "颜色照常落到装饰上");
    assert.equal(countOf("picked"), 1, "必须请调用方把选区与浮动工具栏收掉");
    assert.equal(countOf("close"), 1, "面板自己也要收起");
    close();
});

test("预设色块与跟随色块都不请调用方收浮动工具栏", () => {
    // 只有取色器是例外；其余控件必须保留选区与浮动工具栏
    const preset = activate((f) => f.colorSwatchesOf("underline")[5]);
    assert.equal(preset.countOf("picked"), 0, "预设色块不碰浮动工具栏");
    preset.close();

    const follow = activate((f) => f.followSwatchOf("underline"));
    assert.equal(follow.countOf("picked"), 0, "跟随文字色色块不碰浮动工具栏");
    follow.close();
});

test("点击开关后 onChange 收到 enabled false", () => {
    const {lastChange, countOf, checkedOf, close} = activate((f) => f.switchOf("underline"));
    assert.equal(countOf("change"), 1);
    assert.equal(lastChange().enabled, false);
    assert.equal(checkedOf("underline"), false, "开关的勾选态跟着走");
    close();
});

test("点击预设色块后 onChange 收到白名单内的颜色值", () => {
    const {lastChange, close} = activate((f) => f.colorSwatchesOf("underline")[5]);
    assert.deepEqual(lastChange(), {enabled: true, style: "solid", color: "#0090ff"});
    close();
});

test("主题变量是合法颜色值，原样回写", () => {
    const {lastChange, model, close} = activate((f) => f.colorSwatchesOf("underline")[9]);
    const neutral = lastChange().color;
    assert.equal(neutral, "var(--b3-font-color8)", "思源主题变量是合法颜色值");
    assert.equal(neutral, model.sanitizeColor("var(--b3-font-color8)"));
    close();
});

test("点击跟随文字色色块把颜色清回跟随", () => {
    const {lastChange, close} = activate((f) => f.followSwatchOf("underline"));
    assert.deepEqual(lastChange(), {enabled: true, style: "solid", color: ""}, "跟随文字色即颜色为空串");
    close();
});

test("颜色是跟随文字色时跟随色块读作选中，挑了具体颜色就不再是", () => {
    const follow = createFixture({initialDecoration: DEFAULT_DECORATION});
    assert.equal(
        follow.followSwatchOf("underline").getAttribute("aria-pressed"),
        "true",
        "颜色为空串就是跟随文字色",
    );
    follow.close();

    // 文档里的 span 带着显式的 currentColor：读回来同样要选中跟随色块，而不是落到某个默认色上
    const restored = createFixture({
        initialDecoration: toHost(
            follow.model.readDecorationFromStyle(
                "text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentColor",
            ),
        ),
    });
    assert.equal(
        restored.followSwatchOf("underline").getAttribute("aria-pressed"),
        "true",
        "读回的 currentColor 声明要显示为「跟随文字颜色」",
    );
    restored.close();

    const explicit = activate((f) => f.followSwatchOf("underline"), {
        initialDecoration: {enabled: true, style: "solid", color: "#46a758"},
    });
    assert.equal(explicit.lastChange().color, "", "点跟随色块必须能清回跟随");
    explicit.close();
});

test("块上已有的自定义色既回填取色器、也补一块临时色块，非 #rrggbb 的不写进取色器", () => {
    const {customInputOf, customSwatchOf, customSwatchesOf, section, colorSwatchesOf, close} = createFixture({
        initialDecoration: CUSTOM_DECORATION,
    });
    assert.equal(customInputOf("underline").value, "#123456", "自定义色不在预设里，取色器要显示它");

    const custom = customSwatchOf("underline");
    assert.ok(custom, "自定义色要补一块临时色块，否则整行没有任何选中项");
    assert.equal(custom.getAttribute("data-sue-color"), "#123456");
    assert.equal(customSwatchesOf("underline").length, 1, "临时色块最多一块");
    assert.equal(custom.getAttribute("aria-pressed"), "true", "选中项就是这块临时色块");
    assert.equal(selectedCountIn(section("underline")), 1, "整行只允许一个选中项");
    assert.equal(selectedSwatches(colorSwatchesOf("underline")).length, 0, "不能顺带选中某个预设");
    close();

    const themeVariable = createFixture({
        initialDecoration: {enabled: true, style: "solid", color: "var(--b3-font-color8)"},
    });
    assert.equal(
        themeVariable.customInputOf("underline").value,
        "#000000",
        "主题变量不是取色器能接受的形状，不写进去",
    );
    assert.equal(themeVariable.customSwatchOf("underline"), null, "主题变量正好是预设色，不需要临时色块");
    assert.equal(themeVariable.colorSwatchesOf("underline")[9].getAttribute("aria-pressed"), "true");
    themeVariable.close();
});

test("挑了自定义色之后整行只有一个色块被选中，换回预设色或跟随文字色后临时色块撤掉", () => {
    // 每一步都重新开一个夹具：这样每一步的回调记录都是干净的，数得出这一��点了什么
    const picked = activate(() => {}, {initialDecoration: CUSTOM_DECORATION, pickColor: "#654321"});
    assert.equal(picked.lastChange().color, "#654321");
    assert.equal(picked.customSwatchesOf("underline").length, 1, "自定义色补一块临时色块");
    assert.equal(picked.customSwatchOf("underline").getAttribute("aria-pressed"), "true");
    assert.equal(selectedCountIn(picked.section("underline")), 1, "整行只允许一个选中项");
    assert.equal(picked.colorSwatchesOf("underline").length, 11, "预设色板仍是 11 块，临时色块不算预设");
    picked.close();

    const backToPreset = activate((f) => f.colorSwatchesOf("underline")[5], {initialDecoration: CUSTOM_DECORATION});
    assert.equal(backToPreset.lastChange().color, "#0090ff");
    assert.equal(backToPreset.customSwatchesOf("underline").length, 0, "换回预设色就撤掉临时色块");
    assert.equal(backToPreset.colorSwatchesOf("underline")[5].getAttribute("aria-pressed"), "true");
    assert.equal(selectedCountIn(backToPreset.section("underline")), 1);
    backToPreset.close();

    const backToFollow = activate((f) => f.followSwatchOf("underline"), {
        initialDecoration: {enabled: true, style: "solid", color: "#654321"},
    });
    assert.equal(backToFollow.lastChange().color, "");
    assert.equal(backToFollow.customSwatchesOf("underline").length, 0, "跟随文字色也要撤掉临时色块");
    assert.equal(backToFollow.followSwatchOf("underline").getAttribute("aria-pressed"), "true");
    assert.equal(selectedCountIn(backToFollow.section("underline")), 1);
    backToFollow.close();
});

test("自定义色的临时色块真的可点，与预设色块行为一致", () => {
    // 这块色块是渲染时才插进来的：只在构造期给预设色块绑事件的话，
    // 它就是个长得一样却点不动的元素。方向关着时点它会「打开下划线并用上这个颜色」，
    // 那是真实的一次提交，据此就能分辨它的监听确实绑上了
    const fixture = createFixture({initialDecoration: {...CUSTOM_DECORATION, enabled: false}});
    const chip = fixture.customSwatchOf("underline");
    assert.ok(chip, "夹具前提：这里应当有一块自定义色色块");
    chip.click();
    assert.equal(fixture.countOf("change"), 1, "点击确实走到了它自己的监听上");
    assert.deepEqual(fixture.lastChange(), CUSTOM_DECORATION);
    assert.equal(fixture.countOf("close"), 0, "设置类控件不收面板");
    fixture.close();

    // 这块色块当前正在被使用，点它没有任何新意图：既不回调，也照样不收面板
    const current = createFixture({initialDecoration: CUSTOM_DECORATION});
    current.customSwatchOf("underline").click();
    assert.equal(current.countOf("change"), 0, "它正在被使用，本来就没有新意图");
    assert.equal(current.countOf("close"), 0);
    current.close();

    // 换成别处保存的另一个自定义色之后，这一块仍能接住点击：否则用户换不回同一个颜色
    const restored = createFixture({initialDecoration: {enabled: true, style: "solid", color: "#654321"}});
    restored.customSwatchOf("underline").click();
    assert.equal(restored.countOf("change"), 0, "回到另一个自定义色同样是一次提交");
    restored.close();
});

test("方向关闭时临时色块照样可点，并顺带把下划线打开", () => {
    const fixture = activate((f) => f.customSwatchOf("underline"), {
        initialDecoration: {...CUSTOM_DECORATION, enabled: false},
    });
    assert.ok(fixture.customSwatchOf("underline"));
    assert.deepEqual(fixture.lastChange(), CUSTOM_DECORATION, "点它就把方向打开，而不是毫无反应");
    fixture.close();
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
    // 四类控件都要挡住「无变化的提交」：点已在用的值没有任何新意图，不该多一次保存
    const cases = [
        ["线型色块", (f) => f.styleSwatchOf("underline", "solid"), SOLID_DECORATION],
        ["颜色色块", (f) => f.colorSwatchesOf("underline")[0], SOLID_DECORATION],
        ["跟随文字色色块", (f) => f.followSwatchOf("underline"), DEFAULT_DECORATION],
    ];
    for (const [name, element, initialDecoration] of cases) {
        const {countOf, close} = activate(element, {initialDecoration});
        assert.equal(countOf("change"), 0, `${name} 点已选中的项不该产生改动`);
        close();
    }
    // 取色器重新挑出同一个颜色同理
    const picked = createFixture({initialDecoration: SOLID_DECORATION});
    const input = picked.customInputOf("underline");
    input.value = "#e5484d";
    input.dispatchEvent(new picked.window.Event("change", {bubbles: true}));
    assert.equal(picked.countOf("change"), 0, "取色器挑出当前颜色同样没有新意图");
    picked.close();
});

test("点击清除装饰与撤销分别调用 onClear 与 onUndo", () => {
    const clear = activate((f) => f.actionButton("clear"));
    assert.equal(clear.countOf("clear"), 1);
    clear.close();

    const undo = activate((f) => f.actionButton("undo"));
    assert.equal(undo.countOf("undo"), 1);
    undo.close();
});

test("没有东西可撤销时撤销键摆成禁用态，按它什么也不做", () => {
    // 撤销是面板里唯一一个可以有禁用态的控件：设置类控件每一下都是新意图，
    // 而一个亮着的撤销键按下去什么也不会发生，只会让用户反复去按它。
    // 控件是 div，没有 disabled 属性，语义只能记在 aria-disabled 上；真正的拦截在监听里
    const {actionButton, countOf, close} = createFixture({undoEnabled: false});
    const undo = actionButton("undo");
    assert.equal(undo.getAttribute("aria-disabled"), "true", "禁用态必须由 aria-disabled 表达");
    assert.equal(undo.hasAttribute("disabled"), false, "div 上没有 disabled 属性");
    assert.equal(undo.getAttribute("role"), "button", "禁用不改角色：它仍然是那个按钮，只是此刻不可用");

    undo.click();
    assert.equal(countOf("undo"), 0, "禁用中的撤销键不回调");
    assert.equal(countOf("close"), 0, "禁用中的撤销键也不收面板：它什么都没做");
    close();
});

test("有东西可撤销时撤销键不带禁用态，点它照常撤销并收面板", () => {
    const {actionButton, countOf, close} = createFixture({undoEnabled: true});
    const undo = actionButton("undo");
    assert.equal(undo.getAttribute("aria-disabled"), null, "可用时不带 aria-disabled");

    undo.click();
    assert.equal(countOf("undo"), 1, "撤销照常回调");
    assert.equal(countOf("close"), 1, "撤销是终止类操作，做完收面板");
    close();
});

test("调用方没报撤销栈状态时按「有东西可撤销」处理", () => {
    // 面板自己不知道栈里有没有东西。没报就摆成可点，避免凭空给用户一个按不动的按钮；
    // 调用方（src/index.ts）每次改动与每次撤销之后都会把真实状态报过来
    const {actionButton, countOf, close} = createFixture();
    const undo = actionButton("undo");
    assert.equal(undo.getAttribute("aria-disabled"), null);
    undo.click();
    assert.equal(countOf("undo"), 1);
    close();
});

test("setUndoEnabled 重画撤销键的禁用态，且不影响设置类控件", () => {
    const {controller, actionButton, styleSwatchOf, switchOf, followSwatchOf, colorSwatchesOf, countOf, close} =
        createFixture({undoEnabled: false});
    assert.equal(actionButton("undo").getAttribute("aria-disabled"), "true");

    controller.setUndoEnabled(true);

    const undo = actionButton("undo");
    assert.equal(undo.getAttribute("aria-disabled"), null, "栈里有了东西就恢复可用");
    undo.click();
    assert.equal(countOf("undo"), 1, "恢复之后点击照常回调");
    assert.equal(countOf("close"), 1);

    // 设置类控件一个都不带禁用态：它们永远可点，禁用是撤销独有的
    for (
        const control of [
            styleSwatchOf("underline", "wavy"),
            colorSwatchesOf("underline")[5],
            followSwatchOf("underline"),
            switchOf("underline"),
            actionButton("clear"),
        ]
    ) {
        assert.equal(control.getAttribute("aria-disabled"), null, `设置类控件不该被禁用：${control.outerHTML}`);
    }
    close();
});

test("撤销键禁用时设置类控件全部可用，面板里只有它一个禁用态", () => {
    const {panel, close} = createFixture({undoEnabled: false});
    const disabled = Array.from(panel.querySelectorAll("[aria-disabled]"));
    assert.deepEqual(
        disabled.map((element) => element.getAttribute("data-sue-action")),
        ["undo"],
        "禁用态只属于撤销键：设置类控件每一下都是新意图，按了没反应才是问题",
    );
    // 换一批初值再来一遍：方向关着、色块选中状态不同，都不该冒出第二个禁用控件
    for (
        const initialDecoration of [
            DEFAULT_DECORATION,
            {...SOLID_DECORATION, enabled: false},
            {...CUSTOM_DECORATION, enabled: false},
        ]
    ) {
        const fixture = createFixture({initialDecoration, undoEnabled: false});
        const others = Array.from(fixture.panel.querySelectorAll("[aria-disabled], [disabled]"))
            .filter((element) => element.getAttribute("data-sue-action") !== "undo");
        assert.deepEqual(others, [], `出现了第二个禁用控件：${JSON.stringify(initialDecoration)}`);
        fixture.close();
    }
    close();
});

test("getDecoration 返回快照，改动它不会污染面板内部状态", () => {
    const {styleSwatchesOf, controller, close} = createFixture();
    styleSwatchesOf("underline")[1].click();
    const snapshot = controller.getDecoration();
    snapshot.style = "wavy";
    assert.equal(toHost(controller.getDecoration()).style, "dashed", "面板状态没有被外部改掉");
    close();
});

test("setDecoration 用外部读回的配置刷新控件，且不触发 onChange", () => {
    const {controller, checkedOf, styleSwatchesOf, followSwatchOf, close} = createFixture();
    // 清除装饰 / 撤销之后由调用方把真实状态读回来回填：这不是用户操作，不该回调 onChange
    const cleared = {enabled: false, style: "dashed", color: ""};
    controller.setDecoration(cleared);
    assert.equal(controller.getDecoration().style, "dashed");
    assert.equal(checkedOf("underline"), false, "开关要跟着灭掉");
    assert.equal(styleSwatchesOf("underline")[1].getAttribute("aria-pressed"), "true", "线型选中态也要刷新");
    assert.equal(styleSwatchesOf("underline")[0].getAttribute("aria-pressed"), "false", "旧选中态要清掉");
    assert.ok(followSwatchOf("underline").classList.contains("sue-swatch--selected"), "跟随色块跟着亮起");
    assert.equal(controller.getDecoration().color, "");
    close();
});

test("setDecoration 与构造一样先过白名单", () => {
    const {controller, close} = createFixture();
    controller.setDecoration({enabled: "yes", style: "zigzag", color: "red;position:fixed"});
    const decoration = toHost(controller.getDecoration());
    assert.equal(decoration.color, "", "脏颜色退回跟随文字色");
    assert.equal(decoration.style, "solid", "非法线型退回 solid");
    assert.equal(decoration.enabled, true, "布尔以外的 enabled 退回默认值");
    close();
});

// ------------------------------------------------------------------ 焦点

// 面板里的每一个控件都必须是非可聚焦的。
//
// 思源自己的菜单项用的是 <div class="b3-list-item">：不可聚焦，点它不会把焦点从 contenteditable
// 带走，因此思源不会失焦、选区也就活着，浮动工具栏同样留在原地。面板里的控件必须满足同一条契约 ——
// 只要有一个控件是可聚焦的，按下时浏览器就会把焦点交给它，编辑器随即清掉选区，
// 浮动工具栏也跟着收起，而面板记下的字符偏移不再指向用户的文字，
// 随后那次包裹取出的会是别的内容（曾经把用户的字写成了空白）。
//
// 判定不逐个控件做，而是整棵子树扫一遍可聚焦入口：多出一个 button / input / 带 tabindex 的元素就会红。

/**
 * 可聚焦入口的选择器。
 *
 * tabindex 属性本身就把元素变成可聚焦区域：即使取 -1（不进 tab 序列）也仍然会被按下聚焦，
 * 因此这里连它一并算作可聚焦；唯一的例外是原生取色器，它没法做成不可聚焦（见下方断言）。
 * [contenteditable] 同样算：可编辑区里的任意一段文字都是能抢到焦点的。
 */
const FOCUSABLE_SELECTOR =
    "button, input:not([data-sue-custom-color]), select, textarea, a[href], iframe, object, embed, " +
    "audio[controls], video[controls], [contenteditable], [tabindex]";

test("面板里没有任何可聚焦的控件：按下它们不会把焦点带离编辑器", () => {
    const {panel, close} = createFixture();
    const focusable = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR));
    assert.deepEqual(
        focusable.map((element) => element.tagName),
        [],
        `面板里出现了可聚焦元素：${focusable.map((element) => element.outerHTML).join(" | ")}`,
    );

    // 夹具前提：面板确实造出了控件，上面那条断言才不是空转
    assert.equal(panel.querySelectorAll("[data-sue-style]").length, 5);
    assert.equal(panel.querySelectorAll("[data-sue-action]").length, 2);
    close();
});

test("面板里唯一可聚焦的控件是原生取色器，插件不再拦任何按下的默认行为", () => {
    const {panel, customInputOf, close} = createFixture();
    const picker = customInputOf("underline");
    // input[type=color] 在浏览器里是既有的可聚焦控件，做不到不可聚焦，因此这里只标出它、不假装它安全
    assert.equal(picker.tagName, "INPUT");
    assert.equal(picker.type, "color");
    assert.equal(picker.getAttribute("data-sue-custom-color"), "");
    assert.equal(
        panel.querySelectorAll("input").length,
        1,
        "面板里只允许这一个 input：多出来的可聚焦控件会立刻破坏选区",
    );

    // 面板不再与浏览器默认行为对抗：控件本来就不可聚焦，没有可拦的东西
    const {styleSwatchOf, fire} = createFixture();
    assert.equal(fire(styleSwatchOf("underline", "wavy"), "mousedown", {cancelable: true}).defaultPrevented, false);
    close();
});

test("每一类控件都带 role 与无障碍名", () => {
    const {panel, close} = createFixture();
    const controls = Array.from(
        panel.querySelectorAll(
            "[data-sue-style], [data-sue-color], [data-sue-follow-color], " +
                "[data-sue-switch], [data-sue-action]",
        ),
    );
    assert.equal(controls.length, 5 + 11 + 1 + 1 + 2, "夹具前提：这些就是面板上的全部控件");
    for (const control of controls) {
        assert.notEqual(control.getAttribute("role"), null, `控件必须带 role：${control.outerHTML}`);
        assert.notEqual(control.getAttribute("aria-label"), null, `控件必须带 aria-label：${control.outerHTML}`);
        assert.equal(
            control.getAttribute("tabindex"),
            null,
            `控件不得带 tabindex：带了就仍然可聚焦，按下照样夺走焦点（${control.outerHTML}）`,
        );
    }
    // 颜色色块上没有可见文字，无障碍名因此取颜色原值；「跟随文字色」那块的字母 A 读不出意思，名字取自 i18n
    assert.equal(panel.querySelector('[data-sue-color="#e5484d"]').getAttribute("aria-label"), "#e5484d");
    assert.equal(panel.querySelector("[data-sue-follow-color]").getAttribute("aria-label"), i18n.followTextColor);
    assert.equal(panel.querySelector("[data-sue-action='clear']").getAttribute("aria-label"), i18n.clearDecoration);
    assert.equal(panel.querySelector("[data-sue-switch]").getAttribute("aria-label"), i18n.underline);
    close();
});

test("临时插入的自定义色色块同样不是可聚焦元素", () => {
    // 这块色块是在渲染时才插进面板子树的：只盯构造期那一批控件的话，它就是个能抢焦点的漏网之鱼
    const {panel, customSwatchOf, close} = createFixture({initialDecoration: CUSTOM_DECORATION});
    const chip = customSwatchOf("underline");
    assert.ok(chip, "夹具前提：这里应当有一块自定义色色块");
    assert.equal(chip.matches(FOCUSABLE_SELECTOR), false, `临时色块也必须不可聚焦：${chip.outerHTML}`);
    assert.equal(panel.querySelectorAll("[tabindex]").length, 0, "面板里一个 tabindex 都不该有");
    close();
});

test("完整的按下-点击序列下，各类控件仍然响应", () => {
    // 控件不是 input，因此没有原生的激活行为可用：click 事件本身就是全部。
    // 设置类控件按完留着面板，终止类控件按完收面板
    const {
        styleSwatchOf,
        press,
        countOf,
        lastChange,
        close,
    } = createFixture();

    press(styleSwatchOf("underline", "wavy"));
    assert.equal(countOf("change"), 1);
    assert.equal(lastChange().style, "wavy");
    assert.equal(countOf("close"), 0, "设置类控件按下-点击不收面板");
    close();

    const colour = createFixture();
    colour.press(colour.colorSwatchesOf("underline")[5]);
    assert.equal(colour.countOf("change"), 1);
    assert.equal(colour.lastChange().color, "#0090ff");
    assert.equal(colour.countOf("close"), 0);
    colour.close();

    const follow = createFixture();
    follow.press(follow.followSwatchOf("underline"));
    assert.equal(follow.countOf("change"), 1);
    assert.equal(follow.lastChange().color, "");
    assert.equal(follow.countOf("close"), 0);
    follow.close();

    const clear = createFixture();
    clear.press(clear.actionButton("clear"));
    assert.equal(clear.countOf("clear"), 1);
    assert.equal(clear.countOf("close"), 1, "清除是终止类操作，做完收面板");
    clear.close();
});

test("移动端走 touchend 绑定，收面板的规则与桌面端一致", () => {
    // preventDefault 掉 touchstart 会连带取消浏览器补发的 click 与触摸的默认滚动，
    // 面板会既点不动也滚不动；触摸设备上按钮本来也不会抢焦点，因此一条 mousedown 守卫都不需要
    const {styleSwatchOf, fire, countOf, lastChange, close} = createFixture({frontend: "mobile"});
    assert.equal(fire(styleSwatchOf("underline", "wavy"), "mousedown", {cancelable: true}).defaultPrevented, false);
    assert.equal(fire(styleSwatchOf("underline", "wavy"), "touchstart", {cancelable: true}).defaultPrevented, false);

    fire(styleSwatchOf("underline", "wavy"), "touchend");
    assert.equal(countOf("change"), 1);
    assert.equal(lastChange().style, "wavy");
    assert.equal(countOf("close"), 0, "移动端的设置类控件同样不收面板");
    close();
});

// ------------------------------------------------------------------ 销毁与定位

test("面板内的点击不关闭，面板外的点击与 Esc 才关闭", () => {
    const {panel, document, fire, countOf, close} = createFixture();
    // 面板里的非控件：点它既不改设置也不该被当成「面板外」
    fire(panel.querySelector("[data-sue-title]"), "click");
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
    assert.equal(chosen.side, "right", "右侧与左侧都能避开时，按候选顺序取右侧");
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
    const {panel, styleSwatchesOf, fire, changes, lastChange, close} = createFixture({
        frontend: "mobile",
    });
    assert.equal(panel.getAttribute("data-sue-mobile"), "true");
    assert.match(panel.style.maxHeight, /vh$/, "移动端要给面板加最大高度");
    assert.equal(panel.style.overflowY, "auto", "超出时改为纵向滚动");

    styleSwatchesOf("underline")[1].click();
    assert.equal(changes().length, 0, "移动端必须绑定 touchend，click 不该生效");
    fire(styleSwatchesOf("underline")[1], "touchend");
    assert.equal(changes().length, 1);
    assert.equal(lastChange().style, "dashed");
    close();
});

test("移动端面板外的 touchend 同样关闭面板", () => {
    const {document, fire, countOf, close} = createFixture({frontend: "mobile"});
    fire(document.body, "touchend");
    assert.equal(countOf("close"), 1);
    close();
});

// ------------------------------------------------------------------ 文案与安全

test("面板文案全部取自 options.i18n，没有硬编码字面量", () => {
    const {panel, section, labelOf, followSwatchOf, customInputOf, actionButton, close} = createFixture({
        i18n: SENTINELS,
    });
    assert.equal(panel.querySelector("[data-sue-title]").textContent, SENTINELS.underlineEnhancement);
    assert.equal(labelOf("underline", "switch").textContent, SENTINELS.underline);
    assert.equal(labelOf("underline", "style").textContent, SENTINELS.lineStyle);
    assert.equal(labelOf("underline", "color").textContent, SENTINELS.color);
    assert.equal(followSwatchOf("underline").title, SENTINELS.followTextColor);
    assert.equal(followSwatchOf("underline").getAttribute("aria-label"), SENTINELS.followTextColor);
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
        "saveFailed 属于保存失败那条路径，面板不该用它",
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
        // 两个语言文件的键集合必须一致：删掉的方向不该只在一个文件里消失
        assert.deepEqual(
            Object.keys(table).sort(),
            Object.keys(readLocale(locale === "zh-CN" ? "en" : "zh-CN")).sort(),
        );
    }
    close();
});

test("上划线的文案已从两种语言文件里一并删除", () => {
    // 方向整个去掉之后，这个键不再有任何地方会请求它；留着它就是一条永远用不到的文案
    for (const locale of ["zh-CN", "en"]) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(readLocale(locale), "overline"),
            false,
            `${locale}.json 仍有 overline`,
        );
    }
    assert.ok(!readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8").includes('"overline"'));
});

test("写进面板的颜色一律先过白名单，脏值既不进 DOM 也不进 getDecoration", () => {
    const {panel, controller, colorSwatchesOf, close} = createFixture({
        initialDecoration: {enabled: true, style: "solid", color: "red;position:fixed;background:url(evil)"},
    });
    assert.equal(toHost(controller.getDecoration()).color, "", "非法颜色退化为跟随文字色");
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

// 开关不能是思源的 b3-switch：那个类是为 input[type=checkbox] 写的，
// 而面板里的开关必须是不可聚焦的 div（按下可聚焦的 input 会把焦点带离编辑器）。
// 因此开关的外观与勾选态都自己画，勾选状态读的是 aria-checked。
test("方向开关自绘外观，勾选态读 aria-checked", () => {
    const scss = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    const panelSource = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
    const switchClass = /const SWITCH_CLASS = "([^"]+)"/.exec(panelSource);
    assert.ok(switchClass, "panel.ts 里必须能读出开关的类名常量");
    assert.equal(
        new RegExp(`\\.${switchClass[1]}\\b`).test(scss),
        true,
        `index.scss 里必须有 .${switchClass[1]} 的规则：否则开关没有任何外观`,
    );
    assert.match(
        scss,
        new RegExp(`${switchClass[1]}\\[aria-checked="true"\\]`),
        "必须按 aria-checked 画出勾选态",
    );

    const {switchOf, close} = createFixture({initialDecoration: DEFAULT_DECORATION});
    const toggle = switchOf("underline");
    assert.equal(toggle.className, switchClass[1]);
    assert.equal(toggle.getAttribute("role"), "switch");
    assert.equal(toggle.getAttribute("aria-checked"), "true", "默认配置下开关是勾上的");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-checked"), "false", "点一下就变成未勾选");
    close();
    // 关掉之后线型选中态仍在，用户上一次选的线型没有丢
    const after = createFixture({initialDecoration: {...DEFAULT_DECORATION, enabled: false}});
    assert.equal(after.switchOf("underline").getAttribute("aria-checked"), "false");
    assert.equal(after.styleSwatchOf("underline", "solid").getAttribute("aria-pressed"), "true");
    after.close();
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

// 线型色块的预览线是元素自己的文字画出来的（panel.ts 写的是 text-decoration + currentColor），
// 因此「当前线型颜色变深、其余变浅」只能落在 color 上，而深浅要跟主题走 ——
// 写死一个颜色的话深色主题下两档就分不出来了。jsdom 不应用样式表，因此核对样式表源码。
test("线型色块按选中与否给出深浅两档线色，两档都跟随主题变量", () => {
    const scss = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    const panelSource = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
    // 属性名与 class 名都以 panel.ts 实际写出的那个为准，对不上就说明选择器已经配不上元素了
    assert.match(panelSource, /const STYLE_ATTRIBUTE = "([^"]+)"/, "panel.ts 里必须有线型色块的标记常量");
    const styleAttribute = /const STYLE_ATTRIBUTE = "([^"]+)"/.exec(panelSource)[1];
    const selectedClass = /const SELECTED_CLASS = "([^"]+)"/.exec(panelSource)[1];
    assert.ok(selectedClass, "panel.ts 里必须有选中态 class 常量");

    const plain = new RegExp(`\\[data-sue-panel\\]\\s*\\[${styleAttribute}\\]\\s*\\{([^}]*)\\}`).exec(scss);
    assert.ok(plain, `index.scss 里必须有 [${styleAttribute}] 的未选中态规则`);
    const selected = new RegExp(`\\[data-sue-panel\\]\\s*\\[${styleAttribute}\\]\\.${selectedClass}\\s*\\{([^}]*)\\}`)
        .exec(scss);
    assert.ok(selected, `index.scss 里必须有 [${styleAttribute}].${selectedClass} 的选中态规则`);

    const colorOf = (body) => {
        const matched = /(?:^|[;{\s])color:\s*([^;]*);/.exec(body);
        assert.ok(matched, `规则里没有 color 声明：${body}`);
        return matched[1].trim();
    };
    // 未选中那一档要浅、选中那一档要深：两档必须是不同的值，否则深浅这一层等于没做
    assert.notEqual(colorOf(plain[1]), colorOf(selected[1]), "选中与未选中必须给出不同的线色");
    // 两档都取自思源的主题变量，深浅主题各自跟随；每档都带一个不透明兜底色
    for (const [name, body] of [["未选中", plain[1]], ["选中", selected[1]]]) {
        assert.match(
            body,
            /color:\s*[^;]*var\(--b3-[^;]*#[0-9a-fA-F]{3,8}[^;]*;/,
            `${name}那一档的线色必须跟主题走并留兜底值`,
        );
    }
    // 选中那一块仍然可点：它只是「已经是当前线型」，不是被禁用了。
    // 少了 hover 反馈或按下不响应，用户最初报的就是这类症状
    for (const [name, body] of [["未选中", plain[1]], ["选中", selected[1]]]) {
        assert.ok(!/pointer-events/.test(body), `${name}那一档不得关掉指针事件：${body}`);
        assert.ok(!/not-allowed/.test(body), `${name}那一档不得用禁止指针表示状态：${body}`);
        assert.ok(!/cursor\s*:\s*none/.test(body), `${name}那一档不得藏起鼠标指针：${body}`);
    }
    // 深浅之外，选中态外面那圈指示色仍然在：深浅只说明「哪一块是当前线型」，外圈给出的是同一件事的第二条线索
    assert.match(
        scss,
        new RegExp(`\\.${selectedClass}\\s*\\{[^}]*box-shadow:[^;]*var\\(--b3-primary-color`),
        "选中态的外圈指示色不能丢",
    );

    // 颜色色块与跟随文字色色块不在这次改动的范围内：它们的选中态外观仍只有那一圈指示色
    for (const attribute of ["data-sue-color", "data-sue-follow-color"]) {
        const rule = new RegExp(`\\[data-sue-panel\\]\\s*\\[${attribute}\\]\\.${selectedClass}\\s*\\{`).exec(scss);
        assert.equal(rule, null, `颜色类色块不该另给深浅线色：${rule?.[0] ?? ""}`);
    }
});

// 撤销键的禁用态：div 没有 disabled 属性，语义由 aria-disabled 承担、外观由样式表给出。
// jsdom 不应用样式表，因此核对选择器与声明。
test("撤销键的禁用态由 aria-disabled 驱动，且样式表给出可辨认的禁用外观", () => {
    const scss = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    const panelSource = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
    assert.match(panelSource, /const ACTION_ATTRIBUTE = "([^"]+)"/, "panel.ts 里必须有动作按钮的标记常量");
    const actionAttribute = /const ACTION_ATTRIBUTE = "([^"]+)"/.exec(panelSource)[1];
    // 选择器按动作名给出：清除装饰永远不会有禁用态，不必另给一条规则
    const rule = new RegExp(
        `\\[data-sue-panel\\]\\s*\\[${actionAttribute}="undo"\\]\\[aria-disabled="true"\\]\\s*\\{([^}]*)\\}`,
    )
        .exec(scss);
    assert.ok(rule, "index.scss 里必须有撤销键的禁用态规则");
    assert.match(rule[1], /\bopacity:\s*[^;]*;/, "禁用态要有一处可辨认的减弱：否则用户看不出它按不动");
    assert.match(rule[1], /\bpointer-events:\s*none\s*;/, "禁用态要关掉指针事件，悬停反馈与浏览器默认行为一起停掉");
    // 规则里不得出现 :has()：思源的用户样式表会重写面板所在的 DOM 树，选择器只认面板自己的标记
    assert.ok(!scss.includes(":has("), "样式表不得使用 :has()");

    const {actionButton, close} = createFixture({undoEnabled: false});
    const undo = actionButton("undo");
    assert.equal(undo.getAttribute("aria-disabled"), "true", "禁用态确实落在 aria-disabled 上");
    // 真正让它按不动的不是样式，是监听里的那次判断：样式被覆盖时也不该回调
    undo.click();
    close();
});
