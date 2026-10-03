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
const i18n = JSON.parse(readFileSync(new URL("../src/i18n/zh-CN.json", import.meta.url), "utf8"));

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

/** jsdom 不做布局，rect 一律是全零；这里按元素身份分别给出尺寸，定位逻辑才有可算的输入 */
const stubRects = (window, anchorRect, panelRect) => {
    window.HTMLElement.prototype.getBoundingClientRect = function() {
        return this.hasAttribute("data-sue-panel") ? panelRect : anchorRect;
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
    if (options.rects !== undefined) {
        stubRects(window, options.rects.anchor, options.rects.panel);
    }

    const model = loadModule("src/model.ts");
    const domModule = loadModule("src/dom.ts", {
        dependencies: {siyuan: {getFrontend: () => frontend}},
        globals: {Node: window.Node, NodeFilter: window.NodeFilter},
    });
    const panelModule = loadModule("src/panel.ts", {
        dependencies: {"./model": model, "./dom": domModule},
        globals: {document},
    });

    // vm realm 里造出来的 pair 搬回宿主 realm 才能做严格比较
    const calls = [];
    const controller = panelModule.createPanel({
        anchor,
        initialPair,
        i18n: options.i18n ?? i18n,
        undoEnabled: options.undoEnabled ?? false,
        onChange: (pair) => calls.push({type: "change", pair: toHost(pair)}),
        onClear: () => calls.push({type: "clear"}),
        onUndo: () => calls.push({type: "undo"}),
        onClose: () => calls.push({type: "close"}),
    });
    const panel = document.querySelector("[data-sue-panel]");

    const section = (direction) => panel.querySelector(`[data-sue-section="${direction}"]`);
    const switchOf = (direction) => section(direction).querySelector("[data-sue-switch]");
    const styleSwatchesOf = (direction) => Array.from(section(direction).querySelectorAll("[data-sue-style]"));
    const colorSwatchesOf = (direction) => Array.from(section(direction).querySelectorAll("[data-sue-color]"));
    const followSwatchOf = (direction) => section(direction).querySelector("[data-sue-follow-color]");
    const customInputOf = (direction) => section(direction).querySelector("[data-sue-custom-color]");
    const labelOf = (direction, row) => section(direction).querySelector(`[data-sue-row="${row}"] [data-sue-label]`);
    const actionButton = (action) => panel.querySelector(`[data-sue-action="${action}"]`);

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

    return {
        window,
        document,
        anchor,
        panel,
        controller,
        model,
        calls,
        section,
        switchOf,
        styleSwatchesOf,
        colorSwatchesOf,
        followSwatchOf,
        customInputOf,
        labelOf,
        actionButton,
        changes,
        lastChange,
        countOf,
        fire,
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

test("面板含两个方向区块，各带开关、5 个线型色块、跟随文字色色块、10 个预设色块与取色器", () => {
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
        assert.equal(colorSwatchesOf(direction).length, 10);
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

test("线型色块靠元素自身的 text-decoration 画出真实的线", () => {
    const {styleSwatchesOf, close} = createFixture();
    for (const swatch of styleSwatchesOf("underline")) {
        assert.equal(swatch.style.textDecorationLine, "underline");
        assert.equal(swatch.style.textDecorationStyle, swatch.getAttribute("data-sue-style"));
        assert.equal(swatch.style.textDecorationColor, "currentColor");
        assert.notEqual(swatch.textContent, "", "色块里必须有可供装饰线绘制的文本");
        assert.equal(swatch.children.length, 0, "预览不靠子元素画，也不放图标字符");
        assert.equal(swatch.getElementsByTagName("img").length, 0, "预览不用图片");
    }
    close();
});

// ------------------------------------------------------------------ 回填

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

test("块上已有的自定义色回填到取色器，非 #rrggbb 的颜色不写进去", () => {
    const {customInputOf, colorSwatchesOf, close} = createFixture({
        initialPair: {
            underline: {enabled: true, style: "solid", color: "#123456"},
            overline: {enabled: true, style: "solid", color: "var(--b3-font-color8)"},
        },
    });
    assert.equal(customInputOf("underline").value, "#123456", "自定义色既不在预设里，只能靠取色器显示");
    assert.equal(customInputOf("overline").value, "#000000", "主题变量不是取色器能接受的形状，不写进去");
    assert.ok(
        !colorSwatchesOf("underline").some((swatch) => swatch.getAttribute("aria-pressed") === "true"),
        "不属于预设的颜色不该被认成某个预设色块",
    );
    close();
});

test("重复点击当前已选中的色块不触发 onChange", () => {
    const {styleSwatchesOf, colorSwatchesOf, followSwatchOf, changes, close} = createFixture();
    // 初始 pair 的下划线已经是 solid + #e5484d，上划线已经跟随文字色
    styleSwatchesOf("underline")[0].click();
    colorSwatchesOf("underline")[0].click();
    followSwatchOf("overline").click();
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
