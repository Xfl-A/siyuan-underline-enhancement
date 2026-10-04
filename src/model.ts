/**
 * 装饰样式模型：CSS 装饰声明 ↔ 样式模型的双向转换。
 * 本模块全部为纯函数，不触碰 DOM，也不 import 任何运行时依赖，便于直接单测。
 */

/** 线型；顺序即面板展示顺序 */
export type TLineStyle = "solid" | "dashed" | "dotted" | "double" | "wavy";

/**
 * 一段文字上的装饰：下划线开不开、用哪种线型、什么颜色。
 *
 * 插件只画下划线，因此这里没有方向字段；关掉就是把 enabled 置为 false，此时线型与颜色仍然留着，
 * 打开开关即沿用。
 */
export interface IDecoration {
    /** 下划线是否启用 */
    enabled: boolean;
    /** 线型 */
    style: TLineStyle;
    /**
     * 颜色；空字符串表示跟随文字颜色。
     *
     * 模型里只有这两种形态：具体颜色原值，或空串。currentColor 是「跟随」在 CSS 里的写法，
     * 只出现在写进文档的那条声明上，由 sanitizeColor 归一成空串。
     */
    color: string;
}

/**
 * 线型枚举，顺序即面板展示顺序
 *
 * 冻结：这是全插件共享的常量，一旦某个导入方改到它，面板与 sanitizeDecoration 的回退值会一起被带偏，
 * 而且改动点远在症状之外。freeze 只影响运行时写入，类型仍是 readonly。
 */
export const LINE_STYLES: readonly TLineStyle[] = Object.freeze(
    ["solid", "dashed", "dotted", "double", "wavy"] as TLineStyle[],
);

/**
 * 预设色板；每一项都通过颜色白名单，自定义色由取色器追加（同样冻结，理由见 LINE_STYLES）
 *
 * 前九项是一趟色相遍历，红→橙→琥珀→绿→绿→蓝→紫→粉→黄，挨着的两色因此不会互为深浅版。
 * 末两项刻意留在遍历之外：主题变量是唯一取值随主题变的色，纯黑则不是色相，
 * 它是「跟随文字颜色」那个自适应选项的显式反面。黑色放在色相中段会被读成相邻某色的深浅版，
 * 因此两者一起收在末尾。
 */
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
    "#000000",
]);

/**
 * 默认值：下划线开着、直线、跟随文字颜色
 *
 * 它是 loadData 读不到东西时整个会话的回退底座，连同内部字段一起冻结：
 * 任何按引用拿到它的地方改字段，整条回退链都会被悄悄污染。
 */
export const DEFAULT_DECORATION: IDecoration = Object.freeze({
    enabled: true,
    style: "solid",
    color: "",
}) as IDecoration;

/**
 * 跟随文字颜色在 CSS 里的写法。
 *
 * 白名单与写出侧共用它，两边因此不会各写一份字面量而悄悄走岔。
 */
export const FOLLOW_COLOR_KEYWORD = "currentColor";

/**
 * 颜色白名单：十六进制（含 alpha）、思源主题变量，以及跟随文字颜色的 currentColor。
 *
 * 正则整体锚定、大小写不敏感且不放过任何前后空白 —— 该值会落进持久化的文档 HTML，
 * 多余字符就能拼出第二条声明，因此 currentColor 只以整个关键字的形式匹配，
 * 「currentColor #fff」「currentColor; …」这类复合写法一律落在外面。
 */
const COLOR_PATTERN = new RegExp(
    "^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|var\\(--b3-[A-Za-z0-9_-]+\\)|" +
        `${FOLLOW_COLOR_KEYWORD})$`,
    "i",
);

/** text-decoration-line 的关键字；插件只画下划线，写出与读回都只认这一个 */
const LINE_KEYWORD = "underline";

const DEFAULT_STYLE: TLineStyle = "solid";

const isLineStyle = (token: string): boolean => LINE_STYLES.indexOf(token as TLineStyle) !== -1;

/** 是否为合法的颜色值。currentColor 是合法值：跟随文字颜色就是靠它写进文档的 */
export const isValidColor = (value: unknown): boolean => typeof value === "string" && COLOR_PATTERN.test(value);

/**
 * 颜色进入模型的唯一入口：合法颜色原样返回，其余一律退回空字符串（跟随文字颜色）。
 *
 * currentColor 也归成空串，于是模型里出现的颜色只有两种形态 —— 具体颜色，或跟随。
 * 这条归一同时保证 currentColor 不会以字面量流进插件存储、面板的色块属性与临时色块逻辑。
 */
export const sanitizeColor = (value: unknown): string => {
    const safe = isValidColor(value) ? (value as string) : "";
    return safe.toLowerCase() === FOLLOW_COLOR_KEYWORD.toLowerCase() ? "" : safe;
};

/**
 * 计算色白名单：只收形状完整的 rgb() / rgba()，分量是 0–255 的整数，alpha 是 0–1 的小数且只配 rgba()。
 * getComputedStyle 序列化出来的就是这个形状；关键词、var()、十六进制与带分号的字符串一律落在外面。
 */
const COMPUTED_COLOR_PATTERN = /^(rgba?)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i;

/** 颜色分量的上界：超出它的值不是浏览器算得出来的颜色 */
const CHANNEL_MAX = 255;

/**
 * 返回合法的 rgb() / rgba() 原值，非法值退回空字符串。
 *
 * 与 sanitizeColor 分成两个白名单：这一路的值只落在面板自身的 inline style 上（给「跟随文字色」色块的字母上色），
 * 不进文档 HTML，因此要的是 rgb()/rgba() 而不是十六进制或主题变量。
 * 计算色同样可能是脏字符串，所以它自己也得过一道形状校验，而不是直接写进 style。
 */
export const sanitizeComputedColor = (value: unknown): string => {
    if (typeof value !== "string") {
        return "";
    }
    const matched = COMPUTED_COLOR_PATTERN.exec(value);
    if (matched === null) {
        return "";
    }
    const [, name, red, green, blue, alpha] = matched;
    // alpha 只在 rgba() 里合法：rgb() 带第四个分量、rgba() 缺 alpha 都不是合法写法
    if ((name.toLowerCase() === "rgba") !== (alpha !== undefined)) {
        return "";
    }
    const channels = [red, green, blue].map((channel) => Number(channel));
    if (channels.some((channel) => channel > CHANNEL_MAX)) {
        return "";
    }
    return value;
};

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
    /** 这串声明是否真的声明了下划线 */
    underline: boolean;
    style: TLineStyle;
    color: string;
}

/** 按 CSS token 切分，空格与逗号都算分隔符；声明里出现过下划线即认为画了线 */
const declaresUnderline = (value: string): boolean => {
    for (const token of value.split(/[\s,]+/)) {
        if (token === LINE_KEYWORD) {
            return true;
        }
    }
    return false;
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
            target.underline = false;
        } else if (token === LINE_KEYWORD) {
            target.underline = true;
        } else if (isLineStyle(token)) {
            target.style = token as TLineStyle;
        } else if (isValidColor(token)) {
            // currentColor 归一成空串：简写里写的也是「跟随」，不能留成字面量
            target.color = sanitizeColor(token);
        }
    }
};

/** 解析一整串 style 声明；简写先铺底，长属性后覆盖 */
const parseSpanCSS = (css: string): IParsedDecoration => {
    const parsed: IParsedDecoration = {underline: false, style: DEFAULT_STYLE, color: ""};
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
        parsed.underline = declaresUnderline(line);
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

/**
 * 从一段 span 的 style 声明反解出装饰，用于打开面板时回填。
 *
 * 只有真的声明了下划线的那串声明才让装饰处于启用状态。声明里画的是别的线（或什么都没声明）时
 * 按关闭读，但线型与颜色照读不误：面板把开关关着也照样摆出这份配置，用户打开开关即沿用。
 * 那份声明对应的 span 仍被 dom.ts 认作装饰，因此照样能被剥掉、清掉。
 */
export const readDecorationFromStyle = (css: string | null): IDecoration => {
    const parsed = parseSpanCSS(css ?? "");
    return {enabled: parsed.underline, style: parsed.style, color: parsed.color};
};

/**
 * 生成单个 span 的 style 属性值，声明顺序固定为 line → style → color。
 *
 * 颜色始终显式写出。跟随文字颜色写成 currentColor 而不是省略这条声明：
 * 省掉它时思源会改存一条 color，装饰于是取到的是文字色本身，落盘的属性也就换了个人。
 */
export const buildDecorationCSS = (decoration: IDecoration): string => {
    const style = isLineStyle(decoration?.style) ? decoration.style : DEFAULT_STYLE;
    const color = sanitizeColor(decoration?.color);
    return [
        `text-decoration-line: ${LINE_KEYWORD}`,
        `text-decoration-style: ${style}`,
        `text-decoration-color: ${color === "" ? FOLLOW_COLOR_KEYWORD : color}`,
    ].join("; ");
};

/**
 * 校验外部输入（如 loadData 读回的设置）：非法字段逐个回退默认值。
 * 没有任何字段被原样透传，调用方拿到的配置一定能安全写进 inline style。
 */
export const sanitizeDecoration = (value: unknown): IDecoration => {
    const source = value as Partial<IDecoration>;
    const raw = typeof source === "object" && source !== null ? source : {};
    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_DECORATION.enabled,
        style: isLineStyle(raw.style as string) ? (raw.style as TLineStyle) : DEFAULT_DECORATION.style,
        color: sanitizeColor(raw.color),
    };
};

/**
 * 按配置产出装饰 span 的 style 属性值；未启用时返回 null，调用方只需剥掉已有装饰。
 * 只有一份配置，因此最多产出一个 span，落盘形态是单层包裹，不会出现嵌套。
 */
export const composeDecoration = (decoration: IDecoration): string | null => {
    const safe = sanitizeDecoration(decoration);
    return safe.enabled ? buildDecorationCSS(safe) : null;
};

/** 比较两份配置是否等价；颜色按白名单归一后比较，脏数据不会被误判为差异 */
export const isSameDecoration = (a: IDecoration, b: IDecoration): boolean =>
    Boolean(a?.enabled) === Boolean(b?.enabled) &&
    (a?.style ?? DEFAULT_STYLE) === (b?.style ?? DEFAULT_STYLE) &&
    sanitizeColor(a?.color) === sanitizeColor(b?.color);
