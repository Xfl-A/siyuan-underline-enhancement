/**
 * 装饰样式模型：CSS 装饰声明 ↔ 样式模型的双向转换。
 * 本模块全部为纯函数，不触碰 DOM，也不 import 任何运行时依赖，便于直接单测。
 */

/** 线型；顺序即面板展示顺序 */
export type TLineStyle = "solid" | "dashed" | "dotted" | "double" | "wavy";
/** 单个 span 承载的装饰线 */
export type TLinePosition = "underline" | "overline" | "both";
/** data-sue 标记值 */
export type TSueMarker = "u" | "o" | "b";

export interface IDecoration {
    /** 该方向是否启用 */
    enabled: boolean;
    /** 线型 */
    style: TLineStyle;
    /** 颜色；空字符串表示跟随文字颜色 */
    color: string;
}

export interface IDecorationPair {
    underline: IDecoration;
    overline: IDecoration;
}

/** 一个装饰 span 的描述；marker 由调用方写成 data-sue 属性 */
export interface ISpanSpec {
    position: TLinePosition;
    marker: TSueMarker;
    /** span 的 style 属性值 */
    css: string;
}

/**
 * 线型枚举，顺序即面板展示顺序
 *
 * 冻结：这是全插件共享的常量，一旦某个导入方改到它，面板与 sanitizePair 的回退值会一起被带偏，
 * 而且改动点远在症状之外。freeze 只影响运行时写入，类型仍是 readonly。
 */
export const LINE_STYLES: readonly TLineStyle[] = Object.freeze(
    ["solid", "dashed", "dotted", "double", "wavy"] as TLineStyle[],
);

/** 预设色板；每一项都通过颜色白名单，自定义色由取色器追加（同样冻结，理由见 LINE_STYLES） */
export const PRESET_COLORS: readonly string[] = Object.freeze([
    "#e5484d",
    "#f76b15",
    "#ffb224",
    "#46a758",
    "#30a46c",
    "#0090ff",
    "#8e4ec6",
    "#d6409f",
    "#f5d90a",
    "var(--b3-font-color8)",
]);

/**
 * 默认值：下划线开启并跟随文字颜色，上划线关闭
 *
 * 它是 loadData 读不到东西时整个会话的回退底座，连同两个方向对象一起冻结：
 * 任何按引用拿到它的地方改字段，整条回退链都会被悄悄污染。
 */
export const DEFAULT_PAIR: IDecorationPair = Object.freeze({
    underline: Object.freeze({enabled: true, style: "solid", color: ""}) as IDecoration,
    overline: Object.freeze({enabled: false, style: "solid", color: ""}) as IDecoration,
});

/**
 * 颜色白名单：仅接受十六进制（含 alpha）与思源主题变量。
 * 正则整体锚定且不放过任何前后空白 —— 该值会落进持久化的文档 HTML，多余字符就能拼出第二条声明。
 */
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|var\(--b3-[A-Za-z0-9_-]+\))$/;

/** text-decoration-line 的位标记，用一个整数同时表达「下划线」和「上划线」 */
const LINE_UNDERLINE = 1;
const LINE_OVERLINE = 2;

const DEFAULT_STYLE: TLineStyle = "solid";

/** 简写里的 line 关键字；用 Map 而非对象字面量，避免 "toString" 之类的原型键被当成关键字 */
const LINE_KEYWORDS = new Map<string, number>([
    ["underline", LINE_UNDERLINE],
    ["overline", LINE_OVERLINE],
]);

const isLineStyle = (token: string): boolean => LINE_STYLES.indexOf(token as TLineStyle) !== -1;

/** 是否为合法的颜色值。`currentColor` 刻意不在白名单内：跟随文字色要靠省略属性实现 */
export const isValidColor = (value: unknown): boolean => typeof value === "string" && COLOR_PATTERN.test(value);

/** 返回合法颜色原值，非法值一律退回空字符串（即「跟随文字颜色」） */
export const sanitizeColor = (value: unknown): string => (isValidColor(value) ? (value as string) : "");

/**
 * 按分号切分 CSS 声明列表。引号内与圆括号内的分号不是分隔符：
 * 直接 split(";") 会把 url("a;b") 截断，让值里伪装的声明混入解析结果。
 */
const splitDeclarations = (css: string): string[] => {
    const declarations: string[] = [];
    let buffer = "";
    let quote = "";
    let depth = 0;
    for (const char of css) {
        if (quote !== "") {
            buffer += char;
            if (char === quote) {
                quote = "";
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            buffer += char;
            continue;
        }
        if (char === "(") {
            depth++;
        } else if (char === ")") {
            if (depth > 0) {
                depth--;
            }
        } else if (char === ";" && depth === 0) {
            declarations.push(buffer);
            buffer = "";
            continue;
        }
        buffer += char;
    }
    declarations.push(buffer);
    return declarations.map((declaration) => declaration.trim()).filter((declaration) => declaration !== "");
};

const stripImportant = (value: string): string => value.replace(/\s*!\s*important\s*$/i, "").trim();

/** 解析成「属性名 → 值」的表；同名属性后者覆盖前者，与 CSS 层叠顺序一致 */
const parseDeclarations = (css: string): Record<string, string> => {
    const table: Record<string, string> = {};
    for (const declaration of splitDeclarations(css)) {
        const colon = declaration.indexOf(":");
        if (colon <= 0) {
            continue;
        }
        const property = declaration.slice(0, colon).trim().toLowerCase();
        const value = stripImportant(declaration.slice(colon + 1));
        if (property !== "" && value !== "") {
            table[property] = value;
        }
    }
    return table;
};

interface IParsedDecoration {
    /** CSS 实际声明的装饰线位标记，0 表示没有线 */
    lines: number;
    style: TLineStyle;
    color: string;
}

/** 把 token 列表折成位标记；空格与逗号都算分隔符 */
const toLines = (value: string): number => {
    let lines = 0;
    for (const token of value.split(/[\s,]+/)) {
        const bit = LINE_KEYWORDS.get(token);
        if (bit !== undefined) {
            lines |= bit;
        }
    }
    return lines;
};

const toLineStyle = (value: string): TLineStyle => {
    for (const token of value.split(/[\s,]+/)) {
        if (isLineStyle(token)) {
            return token as TLineStyle;
        }
    }
    return DEFAULT_STYLE;
};

/** 解析简写：按关键字表拆出 line 与 style，剩余且通过白名单的 token 作为 color */
const applyShorthand = (target: IParsedDecoration, value: string): void => {
    for (const token of value.split(/[\s,]+/)) {
        if (token === "") {
            continue;
        }
        if (token === "none") {
            target.lines = 0;
        } else if (LINE_KEYWORDS.has(token)) {
            target.lines |= LINE_KEYWORDS.get(token);
        } else if (isLineStyle(token)) {
            target.style = token as TLineStyle;
        } else if (isValidColor(token)) {
            target.color = token;
        }
    }
};

/** 解析一整串 style 声明，不含方向判定；简写先铺底，长属性后覆盖 */
const parseSpanCSS = (css: string): IParsedDecoration => {
    const parsed: IParsedDecoration = {lines: 0, style: DEFAULT_STYLE, color: ""};
    if (typeof css !== "string" || css.trim() === "") {
        return parsed;
    }
    const declarations = parseDeclarations(css);
    const shorthand = declarations["text-decoration"];
    if (shorthand !== undefined) {
        applyShorthand(parsed, shorthand);
    }
    const line = declarations["text-decoration-line"];
    if (line !== undefined) {
        parsed.lines = toLines(line);
    }
    const style = declarations["text-decoration-style"];
    if (style !== undefined) {
        parsed.style = toLineStyle(style);
    }
    const color = declarations["text-decoration-color"];
    if (color !== undefined) {
        parsed.color = sanitizeColor(color);
    }
    return parsed;
};

const hasLine = (lines: number, position: TLinePosition): boolean => {
    if (position === "both") {
        return lines !== 0;
    }
    return (lines & (position === "overline" ? LINE_OVERLINE : LINE_UNDERLINE)) !== 0;
};

/**
 * 把一串 span 的 style 声明反解成某个方向的装饰。
 * `position` 表示这串 CSS 是给哪个方向用的；`enabled` 只在 CSS 真的声明了那条线时才为真。
 */
export const parseDecorationStyle = (css: string, position: TLinePosition): IDecoration => {
    const parsed = parseSpanCSS(css);
    return {enabled: hasLine(parsed.lines, position), style: parsed.style, color: parsed.color};
};

/**
 * 从现有装饰的 style 声明反解出完整配置，用于打开面板时回填。
 *
 * 方向以 CSS 自己声明的 text-decoration-line 为准，而不是以参数位置为准：调用方可能按
 * DOM 嵌套顺序（外层上划线、内层下划线）取值，参数顺序不可靠；一串 CSS 同时声明两条线时
 * （如合并后的 `underline overline`）则同时供给两个方向。
 */
export const readPairFromStyle = (underlineCSS: string | null, overlineCSS: string | null): IDecorationPair => {
    const pair: IDecorationPair = {
        underline: {enabled: false, style: DEFAULT_STYLE, color: ""},
        overline: {enabled: false, style: DEFAULT_STYLE, color: ""},
    };
    for (const css of [underlineCSS, overlineCSS]) {
        const parsed = parseSpanCSS(css ?? "");
        if (parsed.lines === 0) {
            continue;
        }
        const decoration: IDecoration = {enabled: true, style: parsed.style, color: parsed.color};
        if ((parsed.lines & LINE_UNDERLINE) !== 0) {
            pair.underline = {...decoration};
        }
        if ((parsed.lines & LINE_OVERLINE) !== 0) {
            pair.overline = {...decoration};
        }
    }
    return pair;
};

const resolveLine = (position: TLinePosition): string => {
    if (position === "overline") {
        return "overline";
    }
    return position === "both" ? "underline overline" : "underline";
};

/**
 * 生成单个 span 的 style 属性值，声明顺序固定为 line → style → color。
 * 颜色为空或未通过白名单时整条省略，由 CSS 的 currentColor 生效。
 */
export const buildDecorationCSS = (decoration: IDecoration, position: TLinePosition): string => {
    const style = isLineStyle(decoration?.style) ? decoration.style : DEFAULT_STYLE;
    const declarations = [`text-decoration-line: ${resolveLine(position)}`, `text-decoration-style: ${style}`];
    const color = sanitizeColor(decoration?.color);
    if (color !== "") {
        declarations.push(`text-decoration-color: ${color}`);
    }
    return declarations.join("; ");
};

/**
 * 按合并规则产出一到两个 span 描述，返回顺序为**外层在前**（先上划线，后下划线）。
 * 两个方向都关闭时返回空数组，调用方只需剥离已有装饰。
 */
export const composePair = (pair: IDecorationPair): ISpanSpec[] => {
    const {underline, overline} = sanitizePair(pair);
    if (!underline.enabled && !overline.enabled) {
        return [];
    }
    if (underline.enabled && !overline.enabled) {
        return [{position: "underline", marker: "u", css: buildDecorationCSS(underline, "underline")}];
    }
    if (!underline.enabled) {
        return [{position: "overline", marker: "o", css: buildDecorationCSS(overline, "overline")}];
    }
    // style 与 color 都相同就能合成一个 span；enabled 此刻已都为 true
    if (underline.style === overline.style && underline.color === overline.color) {
        return [{position: "both", marker: "b", css: buildDecorationCSS(underline, "both")}];
    }
    return [
        {position: "overline", marker: "o", css: buildDecorationCSS(overline, "overline")},
        {position: "underline", marker: "u", css: buildDecorationCSS(underline, "underline")},
    ];
};

const sanitizeDecoration = (value: unknown, fallback: IDecoration): IDecoration => {
    const source = value as Partial<IDecoration>;
    const raw = typeof source === "object" && source !== null ? source : {};
    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
        style: isLineStyle(raw.style as string) ? (raw.style as TLineStyle) : fallback.style,
        color: sanitizeColor(raw.color),
    };
};

/**
 * 校验外部输入（如 loadData 读回的设置）：非法字段逐个回退默认值。
 * 没有任何字段被原样透传，调用方拿到的 pair 一定能安全写进 inline style。
 */
export const sanitizePair = (value: unknown): IDecorationPair => {
    const source = value as Partial<IDecorationPair>;
    const raw = typeof source === "object" && source !== null ? source : {};
    return {
        underline: sanitizeDecoration(raw.underline, DEFAULT_PAIR.underline),
        overline: sanitizeDecoration(raw.overline, DEFAULT_PAIR.overline),
    };
};

const isSameDecoration = (a: IDecoration, b: IDecoration): boolean =>
    Boolean(a?.enabled) === Boolean(b?.enabled) &&
    (a?.style ?? DEFAULT_STYLE) === (b?.style ?? DEFAULT_STYLE) &&
    sanitizeColor(a?.color) === sanitizeColor(b?.color);

/** 比较两组配置是否等价；颜色按白名单归一后比较，脏数据不会被误判为差异 */
export const isSamePair = (a: IDecorationPair, b: IDecorationPair): boolean =>
    isSameDecoration(a?.underline, b?.underline) && isSameDecoration(a?.overline, b?.overline);
