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
const DEFAULT_PAIR = toHost(model.DEFAULT_PAIR);
const {isValidColor, sanitizeColor, isSamePair} = model;
const sanitizePair = wrap(model.sanitizePair);
const buildDecorationCSS = wrap(model.buildDecorationCSS);
const composePair = wrap(model.composePair);
const parseDecorationStyle = wrap(model.parseDecorationStyle);
const readPairFromStyle = wrap(model.readPairFromStyle);

// 关闭状态下的装饰：线型与颜色都用默认值的占位，不携带任何视觉信息
const OFF = {enabled: false, style: "solid", color: ""};
const offPair = () => ({underline: {...OFF}, overline: {...OFF}});

// composePair 的结果重新解析回 pair 必须与原 pair 等价。
// composePair 返回空数组时没有任何 span 可读，按「当前选区没有装饰」传入两个 null。
const roundTrip = (pair) => {
    const specs = composePair(pair);
    return readPairFromStyle(specs[0]?.css ?? null, specs[1]?.css ?? null);
};

// ---------------------------------------------------------------- 常量

test("LINE_STYLES holds exactly the five supported line styles in panel order", () => {
    assert.deepEqual([...LINE_STYLES], ["solid", "dashed", "dotted", "double", "wavy"]);
});

test("PRESET_COLORS holds ten colors and every one of them passes the whitelist", () => {
    assert.equal(PRESET_COLORS.length, 10);
    for (const color of PRESET_COLORS) {
        assert.equal(isValidColor(color), true, `预设色必须能通过白名单：${color}`);
    }
});

// ---------------------------------------------------------------- composePair

test("composePair returns no span at all when both directions are disabled", () => {
    assert.deepEqual(composePair(offPair()), []);
});

test("composePair emits a single underline span when only underline is enabled", () => {
    const specs = composePair({
        underline: {enabled: true, style: "dotted", color: "#0090ff"},
        overline: {...OFF},
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].marker, "u");
    assert.equal(specs[0].position, "underline");
    assert.ok(specs[0].css.includes("text-decoration-line: underline"));
});

test("composePair emits a single overline span when only overline is enabled", () => {
    const specs = composePair({
        underline: {...OFF},
        overline: {enabled: true, style: "wavy", color: ""},
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].marker, "o");
    assert.equal(specs[0].position, "overline");
    assert.ok(specs[0].css.includes("text-decoration-line: overline"));
});

test("composePair merges two identical directions into one span carrying both lines", () => {
    const specs = composePair({
        underline: {enabled: true, style: "dashed", color: "#e5484d"},
        overline: {enabled: true, style: "dashed", color: "#e5484d"},
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].marker, "b");
    assert.equal(specs[0].position, "both");
    assert.ok(specs[0].css.includes("text-decoration-line: underline overline"));
});

test("composePair nests overline outermost when only the colors differ", () => {
    const specs = composePair({
        underline: {enabled: true, style: "solid", color: "#0090ff"},
        overline: {enabled: true, style: "solid", color: "#e5484d"},
    });
    assert.equal(specs.length, 2);
    // CSS 的 text-decoration-* 作用于元素的全部装饰线，两个方向不同就必须靠嵌套 span 分开承载
    assert.equal(specs[0].marker, "o");
    assert.equal(specs[0].position, "overline");
    assert.ok(specs[0].css.includes("text-decoration-line: overline"));
    assert.equal(specs[1].marker, "u");
    assert.equal(specs[1].position, "underline");
    assert.ok(specs[1].css.includes("text-decoration-line: underline"));
});

test("composePair nests overline outermost when only the styles differ", () => {
    const specs = composePair({
        underline: {enabled: true, style: "wavy", color: "#0090ff"},
        overline: {enabled: true, style: "double", color: "#0090ff"},
    });
    assert.equal(specs.length, 2);
    assert.deepEqual(specs.map((spec) => spec.marker), ["o", "u"]);
    assert.ok(specs[0].css.includes("text-decoration-style: double"));
    assert.ok(specs[1].css.includes("text-decoration-style: wavy"));
});

// ---------------------------------------------------------------- buildDecorationCSS

test("buildDecorationCSS omits text-decoration-color entirely when the color is empty", () => {
    const css = buildDecorationCSS({enabled: true, style: "wavy", color: ""}, "underline");
    assert.ok(!css.includes("text-decoration-color"), `跟随文字色必须靠省略实现：${css}`);
    assert.equal(css, "text-decoration-line: underline; text-decoration-style: wavy");
});

test("buildDecorationCSS writes a whitelisted color verbatim", () => {
    const css = buildDecorationCSS({enabled: true, style: "solid", color: "#e5484d"}, "underline");
    assert.ok(css.includes("text-decoration-color: #e5484d"));
});

test("buildDecorationCSS emits both lines when position is both", () => {
    const css = buildDecorationCSS({enabled: true, style: "dotted", color: ""}, "both");
    assert.ok(css.includes("text-decoration-line: underline overline"));
});

test("buildDecorationCSS always writes line before style before color", () => {
    const css = buildDecorationCSS({enabled: true, style: "wavy", color: "#46a758"}, "underline");
    const line = css.indexOf("text-decoration-line");
    const style = css.indexOf("text-decoration-style");
    const color = css.indexOf("text-decoration-color");
    assert.ok(line !== -1 && style !== -1 && color !== -1, `三条声明都要出现：${css}`);
    assert.ok(line < style && style < color, `声明顺序必须是 line → style → color：${css}`);
});

test("buildDecorationCSS drops a color that fails the whitelist", () => {
    // 颜色会落进持久化的文档 HTML，非法值必须在写入前就被丢掉
    const css = buildDecorationCSS({enabled: true, style: "solid", color: "red;position:fixed"}, "underline");
    assert.equal(css, "text-decoration-line: underline; text-decoration-style: solid");
});

test("buildDecorationCSS falls back to solid when the line style is not a known keyword", () => {
    const css = buildDecorationCSS({enabled: true, style: "zigzag", color: ""}, "underline");
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

test("sanitizeColor rejects the literal currentColor keyword", () => {
    // 跟随文字颜色靠省略 text-decoration-color 实现，不能把 currentColor 字面量写进 inline style
    assert.equal(sanitizeColor("currentColor"), "");
    assert.equal(isValidColor("currentColor"), false);
});

test("sanitizeColor rejects values that are not strings", () => {
    for (const value of [42, null, undefined, true, {}, ["#abc"], () => "#abc"]) {
        assert.equal(sanitizeColor(value), "");
        assert.equal(isValidColor(value), false);
    }
});

// ---------------------------------------------------------------- sanitizePair

test("sanitizePair falls back to DEFAULT_PAIR when the input is missing", () => {
    assert.deepEqual(sanitizePair(null), DEFAULT_PAIR);
    assert.deepEqual(sanitizePair(undefined), DEFAULT_PAIR);
    assert.deepEqual(sanitizePair({}), DEFAULT_PAIR);
});

test("sanitizePair rejects every malformed field of one direction", () => {
    const pair = sanitizePair({underline: {enabled: "yes", style: "zigzag", color: 42}});
    assert.deepEqual(pair.underline, {enabled: true, style: "solid", color: ""});
    assert.deepEqual(pair.overline, {enabled: false, style: "solid", color: ""});
});

test("sanitizePair keeps valid fields and still sanitizes the color", () => {
    const pair = sanitizePair({
        underline: {enabled: false, style: "wavy", color: "#abc;evil"},
        overline: {enabled: true, style: "double", color: "var(--b3-font-color8)"},
    });
    assert.deepEqual(pair, {
        underline: {enabled: false, style: "wavy", color: ""},
        overline: {enabled: true, style: "double", color: "var(--b3-font-color8)"},
    });
});

test("sanitizePair returns fresh objects so callers cannot corrupt DEFAULT_PAIR", () => {
    // 这里必须用未经 wrap 的导出：wrap 里的 toHost 会克隆返回值，那样就测不到「按引用返回」了
    const pair = model.sanitizePair(null);
    pair.underline.style = "wavy";
    pair.overline.enabled = true;
    // 必须在改完之后才读，模块导出的 DEFAULT_PAIR 若被按引用返回，这里就会看到被改脏的值
    assert.deepEqual(toHost(model.DEFAULT_PAIR), {
        underline: {enabled: true, style: "solid", color: ""},
        overline: {enabled: false, style: "solid", color: ""},
    });
});

// ---------------------------------------------------------------- parseDecorationStyle

test("parseDecorationStyle reads the text-decoration shorthand", () => {
    const parsed = parseDecorationStyle("text-decoration: underline wavy red", "underline");
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.style, "wavy");
    // red 是具名颜色，不在白名单内，按「跟随文字颜色」处理
    assert.equal(parsed.color, "");
});

test("parseDecorationStyle lets longhand declarations override the shorthand", () => {
    const parsed = parseDecorationStyle(
        "text-decoration: underline solid; text-decoration-style: wavy; text-decoration-color: #0090ff",
        "underline",
    );
    assert.deepEqual(parsed, {enabled: true, style: "wavy", color: "#0090ff"});
});

test("parseDecorationStyle ignores the !important flag", () => {
    const parsed = parseDecorationStyle(
        "text-decoration-line: underline !important; text-decoration-color: #abc !important",
        "underline",
    );
    assert.deepEqual(parsed, {enabled: true, style: "solid", color: "#abc"});
});

test("parseDecorationStyle reports a blank style text as disabled", () => {
    assert.deepEqual(parseDecorationStyle("", "underline"), {enabled: false, style: "solid", color: ""});
    assert.deepEqual(parseDecorationStyle("   ", "underline"), {enabled: false, style: "solid", color: ""});
});

test("parseDecorationStyle reports text-decoration none as disabled", () => {
    assert.equal(parseDecorationStyle("text-decoration: none", "underline").enabled, false);
    assert.equal(parseDecorationStyle("text-decoration: none", "overline").enabled, false);
    assert.equal(parseDecorationStyle("text-decoration: none", "both").enabled, false);
});

test("parseDecorationStyle enables a direction only when the CSS declares that line", () => {
    assert.equal(parseDecorationStyle("text-decoration-line: overline", "underline").enabled, false);
    assert.equal(parseDecorationStyle("text-decoration-line: overline", "overline").enabled, true);
    assert.equal(parseDecorationStyle("text-decoration-line: underline overline", "both").enabled, true);
    assert.equal(parseDecorationStyle("text-decoration-line: underline", "both").enabled, true);
});

test("parseDecorationStyle ignores declarations hidden inside quoted or parenthesised values", () => {
    // 直接 split(";") 会把引号与圆括号里的分号当成分隔符，从而让值里伪装的声明混入解析结果。
    const quotedColor = parseDecorationStyle(
        'font-family: "x;text-decoration-color: #abc"; text-decoration-line: underline; text-decoration-style: dotted',
        "underline",
    );
    assert.deepEqual(quotedColor, {enabled: true, style: "dotted", color: ""});
    // 引号里藏一整条完整声明时，只有引号之外的部分才构成声明
    const quotedLine = parseDecorationStyle(
        'font-family: "x;text-decoration-line:underline;y"; text-decoration-style: dotted',
        "underline",
    );
    assert.deepEqual(quotedLine, {enabled: false, style: "dotted", color: ""});
    const url = parseDecorationStyle(
        'background-image: url("a;text-decoration-style: dashed"); text-decoration-line: underline',
        "underline",
    );
    assert.deepEqual(url, {enabled: true, style: "solid", color: ""});
    // 圆括号里的分号同样不是分隔符：这里藏起来的 text-decoration-line 不能生效
    const dataURI = parseDecorationStyle(
        "background-image: url(data:image/svg+xml;text-decoration-line:underline;a); text-decoration-style: dotted",
        "underline",
    );
    assert.deepEqual(dataURI, {enabled: false, style: "dotted", color: ""});
});

// ---------------------------------------------------------------- 往返

test("round-trip: both directions disabled", () => {
    const pair = offPair();
    assert.deepEqual(roundTrip(pair), pair);
});

test("round-trip: underline only", () => {
    const pair = {
        underline: {enabled: true, style: "dashed", color: "var(--b3-font-color8)"},
        overline: {...OFF},
    };
    assert.deepEqual(roundTrip(pair), pair);
    assert.equal(isSamePair(roundTrip(pair), pair), true);
});

test("round-trip: overline only", () => {
    const pair = {
        underline: {...OFF},
        overline: {enabled: true, style: "wavy", color: "#e5484d"},
    };
    assert.deepEqual(roundTrip(pair), pair);
});

test("round-trip: both directions with identical style and color", () => {
    const pair = {
        underline: {enabled: true, style: "dotted", color: ""},
        overline: {enabled: true, style: "dotted", color: ""},
    };
    assert.deepEqual(roundTrip(pair), pair);
});

test("round-trip: both directions with different style and color", () => {
    const pair = {
        underline: {enabled: true, style: "wavy", color: "#0090ff"},
        overline: {enabled: true, style: "solid", color: "#e5484d"},
    };
    assert.deepEqual(roundTrip(pair), pair);
});

test("readPairFromStyle assigns directions by the CSS itself, not by argument position", () => {
    const pair = {
        underline: {enabled: true, style: "wavy", color: "#0090ff"},
        overline: {enabled: true, style: "solid", color: "#e5484d"},
    };
    const specs = composePair(pair);
    // 参数顺序传反也必须还原出同一个 pair，否则调用方按 DOM 嵌套顺序取值就会回填颠倒
    assert.deepEqual(readPairFromStyle(specs[1].css, specs[0].css), pair);
});

test("readPairFromStyle reports both directions disabled when there is no style at all", () => {
    assert.deepEqual(readPairFromStyle(null, null), offPair());
    assert.deepEqual(readPairFromStyle("", ""), offPair());
});

// ---------------------------------------------------------------- isSamePair

test("isSamePair compares both directions and every field of each", () => {
    const base = {
        underline: {enabled: true, style: "wavy", color: "#0090ff"},
        overline: {enabled: false, style: "solid", color: ""},
    };
    assert.equal(isSamePair(base, structuredClone(base)), true);
    assert.equal(isSamePair(base, {...base, underline: {...base.underline, color: "#e5484d"}}), false);
    assert.equal(isSamePair(base, {...base, underline: {...base.underline, style: "solid"}}), false);
    assert.equal(isSamePair(base, {...base, underline: {...base.underline, enabled: false}}), false);
    assert.equal(isSamePair(base, {...base, overline: {...base.overline, enabled: true}}), false);
    assert.equal(isSamePair(base, {...base, overline: {...base.overline, style: "dashed"}}), false);
});
