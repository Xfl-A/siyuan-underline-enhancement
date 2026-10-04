import assert from "node:assert/strict";
import test from "node:test";
import {
    loadModule,
    toHost,
} from "./helpers/loadModule.mjs";

const model = loadModule("src/model.ts");

// loadModule 在另一个 realm 里执行模块，返回的对象原型与本文件不同，
// assert.deepStrictEqual 会因此直接判不等。返回纯数据的调用统一先过一次 toHost，
// 断言本身保持严格（见 helpers/loadModule.mjs 里 toHost 的说明）。
const wrap = (callback) => (...args) => toHost(callback(...args));

const LINE_STYLES = toHost(model.LINE_STYLES);
const PRESET_COLORS = toHost(model.PRESET_COLORS);
const DEFAULT_DECORATION = toHost(model.DEFAULT_DECORATION);
const {isValidColor, sanitizeColor, sanitizeComputedColor, isSameDecoration} = model;
const sanitizeDecoration = wrap(model.sanitizeDecoration);
const buildDecorationCSS = wrap(model.buildDecorationCSS);
const composeDecoration = wrap(model.composeDecoration);
const readDecorationFromStyle = wrap(model.readDecorationFromStyle);

// 未启用时的配置：线型与颜色都是默认值，不携带任何视觉信息
const OFF = {enabled: false, style: "solid", color: ""};

// composeDecoration 的结果重新解析回配置必须与原值等价：
// 返回 null 表示「选区里没有装饰」，对应的读回结果正是关闭态
const roundTrip = (decoration) => {
    const css = composeDecoration(decoration);
    return readDecorationFromStyle(css);
};

// ---------------------------------------------------------------- 常量

test("LINE_STYLES holds exactly the five supported line styles in panel order", () => {
    assert.deepEqual([...LINE_STYLES], ["solid", "dashed", "dotted", "double", "wavy"]);
});

test("PRESET_COLORS holds eleven colors and every one of them passes the whitelist", () => {
    assert.equal(PRESET_COLORS.length, 11);
    for (const color of PRESET_COLORS) {
        assert.equal(isValidColor(color), true, `预设色必须能通过白名单：${color}`);
    }
    // 两块同色色块点上去毫无区别，用户只会以为面板没响应
    const seen = new Set();
    for (const color of PRESET_COLORS) {
        assert.equal(seen.has(color), false, `预设色不得重复：${color}`);
        seen.add(color);
    }
});

test("PRESET_COLORS 含纯黑，且它排在色相遍历之外", () => {
    // 纯黑是「跟随文字颜色」那个自适应选项的显式反面，因此必须随时可达；
    // 它不是色相，插在色相中间会被读成相邻某色的深浅版，所以排在末位（与主题变量同侧）
    assert.equal(PRESET_COLORS.includes("#000000"), true, "色板必须给出纯黑");
    assert.equal(PRESET_COLORS.at(-1), "#000000", "纯黑排在色相遍历之后");
    // 色相遍历仍是一个连续的色相序列，不能被纯黑打断
    assert.equal(PRESET_COLORS.indexOf("#000000"), PRESET_COLORS.length - 1);
    assert.equal(PRESET_COLORS[PRESET_COLORS.length - 2], "var(--b3-font-color8)");
});

test("共享常量都被冻结，导入方改不到会话的回退底座", () => {
    for (const [name, value] of [["LINE_STYLES", model.LINE_STYLES], ["PRESET_COLORS", model.PRESET_COLORS]]) {
        assert.equal(Object.isFrozen(value), true, `${name} 必须冻结`);
    }
    // 本文件是 ESM（严格模式），往冻结对象上写会抛 TypeError 而不是静默失败；
    // 对象来自另一个 realm，只能按错误名判定，不能按原型
    const throwsTypeError = (write) => {
        assert.throws(write, (error) => error.name === "TypeError");
    };
    throwsTypeError(() => model.PRESET_COLORS.push("#123456"));
    throwsTypeError(() => {
        model.LINE_STYLES[0] = "zigzag";
    });
    // DEFAULT_DECORATION 是整条回退链的底座
    assert.equal(Object.isFrozen(model.DEFAULT_DECORATION), true);
    throwsTypeError(() => {
        model.DEFAULT_DECORATION.style = "wavy";
    });
    assert.deepEqual(toHost(model.DEFAULT_DECORATION), {enabled: true, style: "solid", color: ""});
    assert.deepEqual(toHost(model.sanitizeDecoration(null)), toHost(model.DEFAULT_DECORATION));
});

// ---------------------------------------------------------------- 默认值

// 默认值是下划线开着、跟随文字颜色、直线。
// 用户报过「下划线开关默认开启，但没有出现下划线」，因此这一串从常量到 CSS 到读回都被钉住。
test("DEFAULT_DECORATION 是跟随文字颜色的实线下划线", () => {
    assert.deepEqual(DEFAULT_DECORATION, {enabled: true, style: "solid", color: ""});
    // 「跟随」在模型里的形态是空串：任何一个具体值都意味着不再是跟随
    assert.equal(DEFAULT_DECORATION.color, "");
    // 直线不是「碰巧的默认」，而是线型行里的第一个选项，两处必须一致
    assert.equal(LINE_STYLES[0], "solid", "solid 是面板里的第一种线型");
    assert.equal(DEFAULT_DECORATION.style, LINE_STYLES[0]);
});

test("默认下划线写出的 CSS 同时声明 line、style 与跟随色", () => {
    // 写出侧不声明 line 就画不出线，不声明 style 时浏览器仍按 solid 画（但那是隐式的）：
    // 三条都必须显式写出，落盘的 HTML 才不依赖阅读方的默认行为
    const css = buildDecorationCSS(DEFAULT_DECORATION);
    assert.ok(css.includes("text-decoration-line: underline"), `必须声明要画下划线：${css}`);
    assert.ok(css.includes("text-decoration-style: solid"), `默认线型必须是 solid：${css}`);
    assert.ok(
        css.includes("text-decoration-color: currentColor"),
        `跟随文字颜色必须显式写成 currentColor：${css}`,
    );
    assert.equal(
        css,
        "text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentColor",
    );
    // 白名单与写出侧共用同一个常量，两边不会各写一份字面量而悄悄走岔
    assert.equal(model.FOLLOW_COLOR_KEYWORD, "currentColor");
});

test("默认下划线经 composeDecoration 落到文档上，读回来仍等于默认值", () => {
    const css = composeDecoration(DEFAULT_DECORATION);
    assert.equal(css, buildDecorationCSS(DEFAULT_DECORATION));
    assert.deepEqual(readDecorationFromStyle(css), DEFAULT_DECORATION);
    assert.equal(isSameDecoration(readDecorationFromStyle(css), DEFAULT_DECORATION), true);
});

test("span 上没有 text-decoration-style 声明时，读回来按 solid 认", () => {
    // 思源重渲染出来的 span 可能只剩 line 与 color；线型因此只能取自解析侧的兜底，
    // 兜底若不是 solid，用户保存过的直线就会被读成别的线型，面板再打开时选中态也落在别的色块上
    for (
        const css of [
            "text-decoration-line: underline",
            "text-decoration-line: underline; text-decoration-color: currentColor",
            "text-decoration: underline",
        ]
    ) {
        const read = readDecorationFromStyle(css);
        assert.equal(read.enabled, true, `线型缺失时装饰仍然启用：${css}`);
        assert.equal(read.style, "solid", `线型缺失时按 solid 认：${css}`);
    }
    // 声明了非法线型时同样退回 solid，而不是把脏值带进模型
    assert.equal(
        readDecorationFromStyle("text-decoration-line: underline; text-decoration-style: zigzag").style,
        "solid",
    );
    assert.equal(
        readDecorationFromStyle("text-decoration-line: underline; text-decoration-style: currentColor").style,
        "solid",
    );
});

test("sanitizeDecoration 无论收到什么，style 都落在五个线型之内且默认仍是 solid", () => {
    // loadData 读回的设置、面板回填、插件存储都是外部输入；style 一旦漏成空值，
    // 写进文档的声明就成了 text-decoration-style: 空，浏览器退回 none，线就没了
    for (const style of [undefined, null, "", "  ", "zigzag", "SOLID", 0, 1, {}, []]) {
        const decoration = sanitizeDecoration({enabled: true, style, color: ""});
        assert.equal(
            LINE_STYLES.includes(decoration.style),
            true,
            `非法线型必须回退：${JSON.stringify(style)} → ${JSON.stringify(decoration.style)}`,
        );
        assert.equal(decoration.style, "solid", `回退值必须是 solid：${JSON.stringify(style)}`);
        assert.ok(
            buildDecorationCSS(decoration).includes("text-decoration-style: solid"),
            "回退之后写出的声明必须真的带 solid",
        );
    }
});

// ---------------------------------------------------------------- composeDecoration

test("composeDecoration yields nothing at all when the underline is disabled", () => {
    assert.equal(composeDecoration(OFF), null);
    assert.equal(composeDecoration({enabled: false, style: "wavy", color: "#0090ff"}), null);
});

test("composeDecoration yields exactly one span spec when the underline is on", () => {
    for (
        const decoration of [
            {enabled: true, style: "solid", color: ""},
            {enabled: true, style: "dotted", color: "#0090ff"},
            {enabled: true, style: "wavy", color: "var(--b3-font-color8)"},
        ]
    ) {
        const css = composeDecoration(decoration);
        // 一段文字上只有一个方向的装饰，因此产出是一段 style 声明，不是一个数组，更不会有嵌套
        assert.equal(typeof css, "string", `产出必须是单段声明：${JSON.stringify(decoration)}`);
        assert.ok(css.includes("text-decoration-line: underline"), `必须声明下划线：${css}`);
        assert.ok(!css.includes("overline"), `产出里不得再有上划线：${css}`);
        assert.equal(css, buildDecorationCSS(decoration));
    }
});

test("composeDecoration 写出的 span 永远只有一层，落盘形态里不含嵌套", () => {
    // 上划线方向已经不存在，两个方向设置不同也逼不出嵌套：一段文字上永远只有一个 span
    const css = composeDecoration({enabled: true, style: "wavy", color: "#46a758"});
    assert.equal(css.split(";").length, 3, `一段装饰恰好三条声明：${css}`);
    assert.ok(!css.includes("span"), `产出是一段 style 声明，不含标记：${css}`);
});

test("composeDecoration 先过白名单再产出", () => {
    const css = composeDecoration({enabled: true, style: "zigzag", color: "red;position:fixed"});
    assert.ok(css.includes("text-decoration-style: solid"), `非法线型退回 solid：${css}`);
    assert.ok(!css.includes("position:fixed"), `注入的第二条声明不得出现：${css}`);
    assert.ok(css.includes("text-decoration-color: currentColor"), `脏颜色退回跟随：${css}`);
});

// ---------------------------------------------------------------- buildDecorationCSS

test("buildDecorationCSS 跟随文字色时显式写出 currentColor", () => {
    // 实测：省略这条声明时思源改存一条 color，装饰因此取到的是文字色而不是「跟随」
    const css = buildDecorationCSS({enabled: true, style: "wavy", color: ""});
    assert.ok(
        css.includes("text-decoration-color: currentColor"),
        `跟随文字色必须显式写成 currentColor：${css}`,
    );
    assert.equal(
        css,
        "text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: currentColor",
    );
});

test("buildDecorationCSS writes a whitelisted color verbatim", () => {
    const css = buildDecorationCSS({enabled: true, style: "solid", color: "#e5484d"});
    assert.ok(css.includes("text-decoration-color: #e5484d"));
});

test("buildDecorationCSS 具体颜色原样落盘，不被换成 currentColor", () => {
    const css = buildDecorationCSS({enabled: true, style: "wavy", color: "#46a758"});
    assert.equal(css.includes("text-decoration-color: #46a758"), true, `具体颜色必须原样写出：${css}`);
    assert.equal(css.includes("currentColor"), false, `具体颜色不得被替换成 currentColor：${css}`);
});

test("buildDecorationCSS always writes line before style before color", () => {
    const css = buildDecorationCSS({enabled: true, style: "wavy", color: "#46a758"});
    const line = css.indexOf("text-decoration-line");
    const style = css.indexOf("text-decoration-style");
    const color = css.indexOf("text-decoration-color");
    assert.ok(line !== -1 && style !== -1 && color !== -1, `三条声明都要出现：${css}`);
    assert.ok(line < style && style < color, `声明顺序必须是 line → style → color：${css}`);
});

test("buildDecorationCSS drops a color that fails the whitelist", () => {
    // 颜色会落进持久化的文档 HTML，非法值必须在写入前就被丢掉；丢掉之后这份装饰就是跟随文字色
    const css = buildDecorationCSS({enabled: true, style: "solid", color: "red;position:fixed"});
    assert.equal(css.includes("position:fixed"), false, `注入的第二条声明不得出现：${css}`);
    assert.equal(
        css,
        "text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentColor",
    );
});

test("buildDecorationCSS falls back to solid when the line style is not a known keyword", () => {
    const css = buildDecorationCSS({enabled: true, style: "zigzag", color: ""});
    assert.ok(css.includes("text-decoration-style: solid"));
});

// ---------------------------------------------------------------- sanitizeColor

test("sanitizeColor rejects every CSS injection attempt", () => {
    const attacks = [
        "red;position:fixed",
        "red;}#abc",
        "#abc}#abc{color:red",
        "expression(alert(1))",
        "url(javascript:alert(1))",
        " var(--b3-font-color8)",
        "var(--b3-font-color8);x:1",
        "var(--evil)",
        "#abc\n",
    ];
    for (const attack of attacks) {
        assert.equal(sanitizeColor(attack), "", `必须拒绝：${attack}`);
        assert.equal(isValidColor(attack), false, `必须判定为非法：${attack}`);
    }
});

test("sanitizeColor returns whitelisted colors verbatim", () => {
    for (const value of ["#abc", "#abcd", "#aabbcc", "#aabbccdd", "var(--b3-font-color8)"]) {
        assert.equal(sanitizeColor(value), value);
        assert.equal(isValidColor(value), true);
    }
});

test("颜色白名单接受 currentColor 关键字，且只接受它单独出现", () => {
    // 跟随文字颜色靠 text-decoration-color: currentColor 落在文档里，因此这个关键字本身必须合法
    for (const value of ["currentColor", "currentcolor", "CURRENTCOLOR"]) {
        assert.equal(isValidColor(value), true, `跟随文字色是合法颜色值：${value}`);
        // 模型内只用空串表示跟随，字面量只活在写进文档的那一条声明里
        assert.equal(sanitizeColor(value), "", `模型内的跟随文字色是空串：${value}`);
    }
    // 复合写法一律拒绝：值会落进持久化的文档 HTML，多带一个 token 就能拼出第二条声明
    for (
        const value of [
            "currentColor; color:url(evil)",
            "currentColor #fff",
            "currentColor currentColor",
            " currentColor",
            "currentColor ",
            "currentColou",
            "url(currentColor)",
            "var(--currentColor)",
            "red",
            "var(--x)",
            "red;position:fixed",
            "url(evil)",
        ]
    ) {
        assert.equal(isValidColor(value), false, `必须判定为非法：${value}`);
        assert.equal(sanitizeColor(value), "", `必须退回跟随文字色：${value}`);
    }
    // 十六进制与思源主题变量仍然照旧放行
    for (const value of ["#fff", "#ffffff", "#ffffff80", "var(--b3-font-color8)"]) {
        assert.equal(isValidColor(value), true, `必须继续放行：${value}`);
        assert.equal(sanitizeColor(value), value);
    }
});

test("sanitizeColor rejects values that are not strings", () => {
    for (const value of [42, null, undefined, true, {}, ["#abc"], () => "#abc"]) {
        assert.equal(sanitizeColor(value), "");
        assert.equal(isValidColor(value), false);
    }
});

// ---------------------------------------------------------------- sanitizeComputedColor

test("sanitizeComputedColor 放行 getComputedStyle 序列化出来的 rgb()/rgba()", () => {
    // 白名单要跟浏览器实际的输出一致：算出来的颜色就是这个形状，挡掉它等于把真实颜色全挡掉
    for (const value of ["rgb(255, 0, 0)", "rgba(1, 2, 3, 0.5)", "rgb(0, 0, 0)", "rgba(9, 9, 9, 0)"]) {
        assert.equal(sanitizeComputedColor(value), value, `必须原样放行：${value}`);
    }
    assert.equal(sanitizeComputedColor("rgb(1,2,3)"), "rgb(1,2,3)", "分量之间没有空格也是合法写法");
    assert.equal(sanitizeComputedColor("rgba(1, 2, 3, .5)"), "rgba(1, 2, 3, .5)", "alpha 可以省掉整数部分的 0");
});

test("sanitizeComputedColor 拒绝白名单之外的一切写法", () => {
    // 白名单（十六进制与 var()）只收文档 HTML 里的颜色，计算色不走那条路：这两者必须各自成一道防线
    for (const value of ["", "red", "var(--x)", "#fff", "#aabbcc", "currentColor", "transparent", "canvastext"]) {
        assert.equal(sanitizeComputedColor(value), "", `必须拒绝：${value}`);
    }
    // 形状不完整的 rgb()/rgba()：少分量、带百分号、用空格分隔、带新式斜杠写法，都不是浏览器会输出的形状
    for (
        const value of [
            "rgb(1, 2)",
            "rgb(1, 2, 3, 0.5)",
            "rgba(1, 2, 3)",
            "rgba(1, 2, 3, 50%)",
            "rgb(100%, 0%, 0%)",
            "rgb(1 2 3)",
            "rgba(1 2 3 / 50%)",
            "rgb(256, 0, 0)",
            "rgb(300, 0, 0)",
            "rgb(0, 0, 0",
            "rgb 1, 2, 3)",
        ]
    ) {
        assert.equal(sanitizeComputedColor(value), "", `必须拒绝：${value}`);
    }
});

test("sanitizeComputedColor 拒绝任何夹带第二条声明或外链的字符串", () => {
    // 这个值来自 getComputedStyle，本身不该是脏的；但面板是把它写进 DOM 的第一个地方，防线得落在这里
    const attacks = [
        "rgb(1,2,3); color:url(evil)",
        "rgb(1, 2, 3);position:fixed",
        "rgba(1,2,3,0.5)}#abc{color:red",
        "url(javascript:alert(1))",
        "rgb(1,2,3);background:url(evil)",
        "expression(alert(1))",
        " rgb(1, 2, 3)",
        "rgb(1, 2, 3) ",
        "rgb(1, 2, 3)\n",
    ];
    for (const attack of attacks) {
        assert.equal(sanitizeComputedColor(attack), "", `必须拒绝：${attack}`);
    }
});

test("sanitizeComputedColor 拒绝非字符串输入", () => {
    for (const value of [42, null, undefined, true, {}, ["rgb(1, 2, 3)"], () => "rgb(1, 2, 3)"]) {
        assert.equal(sanitizeComputedColor(value), "");
    }
});

// ---------------------------------------------------------------- sanitizeDecoration

test("sanitizeDecoration falls back to DEFAULT_DECORATION when the input is missing", () => {
    assert.deepEqual(sanitizeDecoration(null), DEFAULT_DECORATION);
    assert.deepEqual(sanitizeDecoration(undefined), DEFAULT_DECORATION);
    assert.deepEqual(sanitizeDecoration({}), DEFAULT_DECORATION);
});

test("sanitizeDecoration rejects every malformed field", () => {
    assert.deepEqual(sanitizeDecoration({enabled: "yes", style: "zigzag", color: 42}), {
        enabled: true,
        style: "solid",
        color: "",
    });
});

test("sanitizeDecoration keeps valid fields and still sanitizes the color", () => {
    assert.deepEqual(sanitizeDecoration({enabled: false, style: "wavy", color: "#abc;evil"}), {
        enabled: false,
        style: "wavy",
        color: "",
    });
    assert.deepEqual(sanitizeDecoration({enabled: true, style: "double", color: "var(--b3-font-color8)"}), {
        enabled: true,
        style: "double",
        color: "var(--b3-font-color8)",
    });
});

test("sanitizeDecoration 把 currentColor 归一成模型里的跟随文字色", () => {
    const decoration = sanitizeDecoration({enabled: true, style: "wavy", color: "currentColor"});
    assert.equal(decoration.color, "", "读回的 currentColor 归一成空串，面板与落盘配置里不再有字面量");
});

test("sanitizeDecoration returns fresh objects so callers cannot corrupt DEFAULT_DECORATION", () => {
    // 这里必须用未经 wrap 的导出：wrap 里的 toHost 会克隆返回值，那样就测不到「按引用返回」了
    const decoration = model.sanitizeDecoration(null);
    decoration.style = "wavy";
    decoration.enabled = false;
    // 必须在改完之后才读，模块导出的 DEFAULT_DECORATION 若被按引用返回，这里就会看到被改脏的值
    assert.deepEqual(toHost(model.DEFAULT_DECORATION), {enabled: true, style: "solid", color: ""});
});

// ---------------------------------------------------------------- readDecorationFromStyle

test("readDecorationFromStyle reads the text-decoration shorthand", () => {
    assert.deepEqual(readDecorationFromStyle("text-decoration: underline wavy red"), {
        enabled: true,
        style: "wavy",
        // red 是具名颜色，不在白名单内，按「跟随文字颜色」处理
        color: "",
    });
});

test("readDecorationFromStyle lets longhand declarations override the shorthand", () => {
    assert.deepEqual(
        readDecorationFromStyle(
            "text-decoration: underline solid; text-decoration-style: wavy; text-decoration-color: #0090ff",
        ),
        {enabled: true, style: "wavy", color: "#0090ff"},
    );
});

test("readDecorationFromStyle ignores the !important flag", () => {
    assert.deepEqual(
        readDecorationFromStyle(
            "text-decoration-line: underline !important; text-decoration-color: #abc !important",
        ),
        {enabled: true, style: "solid", color: "#abc"},
    );
});

test("readDecorationFromStyle reports a blank style text as disabled", () => {
    for (const css of ["", "   ", null, undefined]) {
        assert.deepEqual(readDecorationFromStyle(css), OFF, `空白声明即关闭：${JSON.stringify(css)}`);
    }
});

test("readDecorationFromStyle reports text-decoration none as disabled", () => {
    assert.equal(readDecorationFromStyle("text-decoration: none").enabled, false);
    assert.equal(readDecorationFromStyle("text-decoration-line: none").enabled, false);
});

test("readDecorationFromStyle 只在声明里真有下划线时才启用", () => {
    // 别的装饰线（别的工具加进来的上划线）不等于下划线：面板如实报「关闭」，
    // 而那个 span 仍被 dom.ts 认作装饰，因此照样能被剥掉。
    // 线型与颜色照读不误：开关关着也照样摆出这份配置，用户打开开关即沿用
    assert.deepEqual(readDecorationFromStyle("text-decoration-line: overline"), OFF);
    assert.deepEqual(readDecorationFromStyle("text-decoration: overline double #0090ff"), {
        enabled: false,
        style: "double",
        color: "#0090ff",
    });
    // 一串声明里同时有两条线时，下划线仍然算数
    assert.equal(readDecorationFromStyle("text-decoration-line: underline overline").enabled, true);
    assert.equal(readDecorationFromStyle("text-decoration-line: underline").enabled, true);
});

test("readDecorationFromStyle 把 currentColor 读成跟随文字色", () => {
    // 文档里的 span 可能带着显式的 currentColor：读回来必须是跟随，面板才会选中「跟随文字色」
    const explicit =
        "text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: currentColor";
    assert.deepEqual(readDecorationFromStyle(explicit), {enabled: true, style: "wavy", color: ""});
    // 简写里的大小写写法同样归到跟随
    assert.deepEqual(readDecorationFromStyle("text-decoration: underline wavy currentcolor"), {
        enabled: true,
        style: "wavy",
        color: "",
    });
});

test("readDecorationFromStyle ignores declarations hidden inside quoted or parenthesised values", () => {
    // 直接 split(";") 会把引号与圆括号里的分号当成分隔符，从而让值里伪装的声明混入解析结果。
    assert.deepEqual(
        readDecorationFromStyle(
            'font-family: "x;text-decoration-color: #abc"; text-decoration-line: underline; text-decoration-style: dotted',
        ),
        {enabled: true, style: "dotted", color: ""},
    );
    // 引号里藏一整条完整声明时，只有引号之外的部分才构成声明
    assert.deepEqual(
        readDecorationFromStyle(
            'font-family: "x;text-decoration-line:underline;y"; text-decoration-style: dotted',
        ),
        {enabled: false, style: "dotted", color: ""},
    );
    assert.deepEqual(
        readDecorationFromStyle(
            'background-image: url("a;text-decoration-style: dashed"); text-decoration-line: underline',
        ),
        {enabled: true, style: "solid", color: ""},
    );
    // 圆括号里的分号同样不是分隔符：这里藏起来的 text-decoration-line 不能生效
    assert.deepEqual(
        readDecorationFromStyle(
            "background-image: url(data:image/svg+xml;text-decoration-line:underline;a); text-decoration-style: dotted",
        ),
        {enabled: false, style: "dotted", color: ""},
    );
});

// ---------------------------------------------------------------- 往返

test("round-trip: underline disabled", () => {
    assert.deepEqual(roundTrip(OFF), OFF);
});

test("round-trip: 跟随文字颜色写出再读回来仍是跟随", () => {
    const follow = {enabled: true, style: "wavy", color: ""};
    // 写出侧必须带 currentColor 声明：这是思源不把它换成 color 的唯一办法
    const css = buildDecorationCSS(follow);
    assert.ok(css.includes("text-decoration-color: currentColor"), `写出侧要显式声明：${css}`);
    const read = readDecorationFromStyle(css);
    // 读回来既不能是某个默认颜色，也不能是「未启用」
    assert.deepEqual(read, follow);
    assert.equal(read.color, "", "跟随状态不能退化成某个具体颜色");
    assert.equal(read.enabled, true);
});

test("round-trip: 具体颜色写出再读回来不变", () => {
    const explicit = {enabled: true, style: "wavy", color: "#46a758"};
    const css = buildDecorationCSS(explicit);
    assert.ok(css.includes("text-decoration-color: #46a758"));
    assert.deepEqual(readDecorationFromStyle(css), explicit);
});

test("round-trip: 五个线型逐个过一遍", () => {
    for (const style of LINE_STYLES) {
        const decoration = {enabled: true, style, color: "#0090ff"};
        assert.deepEqual(roundTrip(decoration), decoration, `往返必须无损：${style}`);
    }
});

test("round-trip: 关掉的方向写成 null，读回来仍是关闭态", () => {
    // 清除装饰走的就是这条路：产出 null，读回必须同样报「关闭」，
    // 否则面板清完之后还会以为选区里还有装饰
    const off = {enabled: false, style: "dashed", color: "#0090ff"};
    assert.equal(composeDecoration(off), null);
    assert.deepEqual(roundTrip(off), {enabled: false, style: "solid", color: ""});
});

// ---------------------------------------------------------------- isSameDecoration

test("isSameDecoration 把跟随文字色当成一种颜色状态", () => {
    const follow = {enabled: true, style: "wavy", color: ""};
    assert.equal(isSameDecoration(follow, structuredClone(follow)), true, "两个跟随状态相等");
    // currentColor 与空串说的是同一件事，读回的声明与面板里的空串不该被当成一次改动
    assert.equal(
        isSameDecoration(follow, {...follow, color: "currentColor"}),
        true,
        "currentColor 写法与空串是同一个状态",
    );
    assert.equal(
        isSameDecoration(follow, {...follow, color: "#46a758"}),
        false,
        "跟随与具体颜色不是同一个状态",
    );
});

test("isSameDecoration compares every field", () => {
    const base = {enabled: true, style: "wavy", color: "#0090ff"};
    assert.equal(isSameDecoration(base, structuredClone(base)), true);
    assert.equal(isSameDecoration(base, {...base, color: "#e5484d"}), false);
    assert.equal(isSameDecoration(base, {...base, style: "solid"}), false);
    assert.equal(isSameDecoration(base, {...base, enabled: false}), false);
    // 脏数据不会被误判成差异
    assert.equal(isSameDecoration(base, {...base, color: "red;position:fixed"}), false);
    assert.equal(isSameDecoration({enabled: true}, {enabled: true, style: "solid"}), true);
});
