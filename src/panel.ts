/**
 * 装饰设置面板：把一组装饰配置渲染成可点的控件，并把用户的每次改动以 IDecorationPair 的形式报给调用方。
 *
 * 本模块只做「呈现 + 收集意图」：它不碰文档 DOM、不调内核，也不感知撤销栈的内容。
 * 谁把配置应用到选区、谁来保存与销毁，都由 src/index.ts 通过 IPanelOptions 的回调决定。
 *
 * 面板挂在 document.body 上而不是浮动工具栏内部：IMenuItem.click 只给出 protyle 实例，
 * 拿不到触发按钮元素，而思源内部 subElement 的定位并非公开契约。
 * 因此 options.anchor 只是定位参照之一：面板要避开的是选区，坐标在插入 DOM 后量出来再夹进视口。
 */
import {getEventName} from "./dom";
import {
    LINE_STYLES,
    PRESET_COLORS,
    isSamePair,
    sanitizeColor,
    sanitizeComputedColor,
    sanitizePair,
} from "./model";
import type {
    IDecoration,
    IDecorationPair,
    TLineStyle,
} from "./model";
import {choosePlacement} from "./placement";
import type {IRect} from "./placement";

export interface IPanelOptions {
    /** 定位参照：思源浮动工具栏的容器元素 */
    anchor: HTMLElement;
    /** 打开时的配置，由调用方从选区回填 */
    initialPair: IDecorationPair;
    /** 文案表；缺键时退回键名，便于一眼看出漏了哪条翻译 */
    i18n: Record<string, string>;
    /** 撤销按钮是否可用；撤销栈本身只有 src/index.ts 知道 */
    undoEnabled: boolean;
    /**
     * 选中文字的计算颜色，给「跟随文字色」色块上的字母上色。
     * 由调用方从选区里读一次；空值或非法值一律不上色，字母保持继承面板的正文色。
     */
    followTextColor?: string;
    /**
     * 选区里的各区域装饰并不一致，initialPair 只是其中一份。
     * 面板据此先说明再让用户点：一次改动会把整个选区统一成面板当前这一份配置，
     * 不说清楚的话，第一下点击就会静默改写用户没打算动的那些区域。
     */
    mixed?: boolean;
    onChange: (pair: IDecorationPair) => void;
    onClear: () => void;
    onUndo: () => void;
    onClose: () => void;
}

export interface IPanelController {
    /** 当前配置的一份快照；改动返回值不会影响面板自身状态 */
    getPair: () => IDecorationPair;
    /**
     * 用外部读回的配置覆盖面板状态并重画控件。
     *
     * 清除装饰与撤销都由调用方直接改文档，面板自己看不到结果，得靠这里把选中态刷回来；
     * 这不是用户操作，因此不触发 onChange。第二个实参重报选区是否仍不一致（撤销之后要重新判一次）。
     */
    setPair: (pair: IDecorationPair, mixed?: boolean) => void;
    /** 移除面板并摘掉所有监听；可重复调用 */
    destroy: () => void;
}

/** 面板的两个方向；顺序即面板里的区块顺序 */
type TDirection = "underline" | "overline";

const DIRECTIONS: readonly TDirection[] = ["underline", "overline"];

// ---------------------------------------------------------------- 标记属性与类名

/** 面板根标记；CSS 根选择器与外部识别都靠它 */
const PANEL_ATTRIBUTE = "data-sue-panel";
/** 方向区块标记，值为 underline 或 overline */
const SECTION_ATTRIBUTE = "data-sue-section";
/** 行标记，值为 switch / style / color */
const ROW_ATTRIBUTE = "data-sue-row";
/** 行标签标记 */
const LABEL_ATTRIBUTE = "data-sue-label";
/** 方向开关标记 */
const SWITCH_ATTRIBUTE = "data-sue-switch";
/** 线型色块上记录的线型 */
const STYLE_ATTRIBUTE = "data-sue-style";
/** 颜色色块上记录的颜色值（已过白名单） */
const COLOR_ATTRIBUTE = "data-sue-color";
/** 当前自定义色的临时色块标记；带它的色块不算预设 */
const CUSTOM_SWATCH_ATTRIBUTE = "data-sue-custom-swatch";
/** 跟随文字色色块标记 */
const FOLLOW_ATTRIBUTE = "data-sue-follow-color";
/** 自定义取色器标记 */
const CUSTOM_COLOR_ATTRIBUTE = "data-sue-custom-color";
/** 动作按钮标记，值为 clear 或 undo */
const ACTION_ATTRIBUTE = "data-sue-action";
/** 标题标记 */
const TITLE_ATTRIBUTE = "data-sue-title";
/** 「选区装饰不一致」提示标记 */
const MIXED_ATTRIBUTE = "data-sue-mixed";
/** 动作行标记 */
const ACTIONS_ATTRIBUTE = "data-sue-actions";
/** 移动端标记；面板据此放大触控目标并加滚动兜底 */
const MOBILE_ATTRIBUTE = "data-sue-mobile";

/** 选中态 class，配合 aria-pressed 使用：主题与无障碍都能拿到选中信息 */
const SELECTED_CLASS = "sue-swatch--selected";
/** 色块 class；控件外观仍由思源的 b3-button 提供 */
const SWATCH_CLASS = "sue-swatch";
/**
 * 面板根不挂思源的浮层类。
 *
 * 曾经挂的是 b3-popover，但思源 3.8.6 的样式表里根本没有这个类（真实的浮层表面类是
 * .b3-menu），于是面板拿不到任何背景/边框/圆角/阴影，内边距也是 0，底下的正文直接透出来。
 * .b3-menu 虽能一次拿到整套表面，但思源 JS 里有上千处引用 b3-menu 家族（__item/__items/
 * __separator…），把面板挂进那一族等于依赖大量没读过的规则。
 * 因此表面由 index.scss 用思源的主题变量自行给出，值与 .b3-menu 一致。
 */
/** 行沿用思源的列表行，只额外补一个自己的类控制间距 */
const ROW_CLASS = "b3-list-item sue-row";
/** 标签沿用思源的列表标签 */
const LABEL_CLASS = "b3-list-item-label sue-label";
/** 开关沿用思源既有的 b3-switch */
const SWITCH_CLASS = "b3-switch";
/** 开关 id 前缀，label 的 for 指向它 */
const SWITCH_ID_PREFIX = "sue-switch-";
/** 区块沿用思源的列表 */
const SECTION_CLASS = "b3-list b3-list-bordered sue-section";
/** 控件侧容器 */
const CONTROL_CLASS = "sue-control";
/** 色块排布容器 */
const SWATCHES_CLASS = "sue-swatches";
/** 动作按钮沿用思源既有的 b3-button */
const BUTTON_CLASS = "b3-button";
/** 取色器沿用思源既有的输入框 */
const COLOR_INPUT_CLASS = "b3-text-field sue-color-input";
/** 动作行沿用思源的弹性布局 */
const ACTIONS_CLASS = "fn__flex fn__flex-justify sue-actions";
/** 标题类 */
const TITLE_CLASS = "sue-title";
/** 混合提示类；排版用弱化的一行说明文字，不做成输入框 */
const MIXED_CLASS = "sue-mixed";

// ---------------------------------------------------------------- 定位与常量

/** 面板与参照矩形之间的间距（px）；参照矩形优先是选区，量不到时才是锚点 */
const ANCHOR_GAP = 8;
/** 面板与视口边缘的最小间距（px） */
const VIEWPORT_MARGIN = 12;
/**
 * 面板的最大高度。桌面端也要有：定位只夹两个轴，窗口矮过面板时没有它就直接把底部裁掉，
 * 而裁掉的部分正是「清除装饰 / 撤销」两个动作按钮。给出上限之后改为纵向滚动，哪一端都能到达。
 */
const MAX_HEIGHT = "80vh";
/** 移动端兜底的最大高度：窄屏上内容超出时改为纵向滚动 */
const MOBILE_MAX_HEIGHT = "60vh";
/** 移动端标记的属性值 */
const MOBILE_VALUE = "true";
/** 移动端的事件名；桌面端是 click */
const TOUCH_EVENT = "touchend";
/**
 * 拦下默认行为的事件名。
 *
 * 与事件名（桌面 click、移动 touchend）刻意不同：click 拦了会把控件自己也一起拦掉。
 * 只拦 mousedown：它的默认行为无非是把焦点从 contenteditable 带走、起一次拖、把选区起点落在这里，
 * 随后的 click 照常派发，控件仍然响应。
 * 不用 touchstart：它的默认行为还管着滚动与合成 click，拦掉的话面板既滚不动也点不动。
 */
const PRESS_EVENT = "mousedown";
/** 关闭面板的按键 */
const ESCAPE_KEY = "Escape";
/** 跟随文字色色块上的字母 */
const FOLLOW_TEXT = "A";
/** 跟随文字色色块的背景色；面板常量，不经白名单 */
const TRANSPARENT = "transparent";
/** 取色器的合法初值：空值会让 jsdom 与部分浏览器把控件折叠掉 */
const DEFAULT_COLOR_VALUE = "#000000";
/**
 * 取色器只接受 #rrggbb 这一种写法：短写与带 alpha 的值塞进去会被浏览器判为非法，
 * 控件随即回落到黑色。因此只有这个形状才回写到取色器。
 */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/**
 * 线型色块里的示例文本：两个 EN SPACE（U+2002），合计约 1em。
 *
 * EN SPACE 属于 Unicode Zs，而 CSS Text Level 3 把 Zs/Zl/Zp 的码位定义为「可折叠空白」，
 * 因此色块上必须配 white-space: pre：默认的 normal 会把两个折成一个 0.5em，
 * 画出来的线只剩七八个像素宽，dotted 缩成一个点、dashed 缩成一截，五个线型就分不出来了。
 */
const SAMPLE_TEXT = "\u2002\u2002";

/** 一个方向区块里的控件引用 */
interface ISectionWidgets {
    section: HTMLElement;
    toggle: HTMLInputElement;
    styleSwatches: HTMLButtonElement[];
    followSwatch: HTMLButtonElement;
    colorSwatches: HTMLButtonElement[];
    customInput: HTMLInputElement;
    /** 当前自定义色的临时色块；不是预设色，随时可能被撤掉 */
    customSwatch: HTMLButtonElement | null;
}

/** 复制一组配置，避免调用方改到面板内部的状态 */
const clonePair = (pair: IDecorationPair): IDecorationPair => ({
    underline: {...pair.underline},
    overline: {...pair.overline},
});

const createElement = <T extends HTMLElement>(doc: Document, tagName: string, className: string): T => {
    const element = doc.createElement(tagName);
    if (className !== "") {
        element.className = className;
    }
    return element as T;
};

/**
 * 线型色块：靠元素自身的 text-decoration 画出真实的线，不画图标字符也不用图片。
 *
 * `direction` 决定线画在文字的上方还是下方：上划线区块画上划线，
 * 两个区块的预览才不会长得一模一样，用户也才看得出这一行管的是哪一侧。
 * 三个属性都必须写全：只写 text-decoration-style 时线型仍取自默认的 solid。
 *
 * 按钮里唯一的可见内容是示例文本（两个 EN SPACE），对读屏软件来说没有名字，因此
 * aria-label 必须给。刻意不用 CSS 关键词当名字：中文界面里 "wavy" 对用户没有意义，
 * 名字取自 i18n（线型中文名 + 方向）。
 */
const createStyleSwatch = (
    doc: Document,
    style: TLineStyle,
    direction: TDirection,
    ariaLabel: string,
): HTMLButtonElement => {
    const swatch = createElement<HTMLButtonElement>(doc, "button", `${BUTTON_CLASS} ${SWATCH_CLASS}`);
    swatch.type = "button";
    swatch.setAttribute(STYLE_ATTRIBUTE, style);
    swatch.setAttribute("aria-label", ariaLabel);
    swatch.setAttribute("aria-pressed", "false");
    swatch.textContent = SAMPLE_TEXT;
    swatch.style.whiteSpace = "pre";
    swatch.style.textDecorationLine = direction;
    swatch.style.textDecorationStyle = style;
    swatch.style.textDecorationColor = "currentColor";
    return swatch;
};

/**
 * 颜色色块。颜色先过白名单再落到 DOM 上：这些值最终会进入持久化的文档 HTML，
 * 面板是这条链路上第一个可能拿到脏值的地方，防线必须落在最前面。
 */
const createColorSwatch = (doc: Document, color: string): HTMLButtonElement => {
    const safeColor = sanitizeColor(color);
    const swatch = createElement<HTMLButtonElement>(doc, "button", `${BUTTON_CLASS} ${SWATCH_CLASS}`);
    swatch.type = "button";
    swatch.setAttribute(COLOR_ATTRIBUTE, safeColor);
    swatch.setAttribute("aria-pressed", "false");
    swatch.title = safeColor;
    swatch.style.backgroundColor = safeColor;
    return swatch;
};

/**
 * 「跟随文字色」色块：字母 A 表示装饰跟随文字颜色时真正会取到的那个颜色，背景透明。
 *
 * A 用选中文字的计算色上色——不显出那个颜色，这个色块就等于没有预览，装饰落到文字上的效果也无从预期。
 * 这个值过不了计算色白名单就一个属性都不写：继承来的颜色仍然读得出来，
 * 而把脏值写进 style 只会换来一条谁也没打算声明的规则。
 */
const createFollowSwatch = (doc: Document, title: string, followTextColor: string): HTMLButtonElement => {
    const swatch = createElement<HTMLButtonElement>(doc, "button", `${BUTTON_CLASS} ${SWATCH_CLASS}`);
    swatch.type = "button";
    swatch.setAttribute(FOLLOW_ATTRIBUTE, "");
    swatch.setAttribute("aria-pressed", "false");
    swatch.textContent = FOLLOW_TEXT;
    swatch.title = title;
    // 面板常量而非外部输入，因此不必过白名单（白名单只收十六进制与思源主题变量）
    swatch.style.backgroundColor = TRANSPARENT;
    // 只写过了白名单的值；计算色不进文档 HTML，但仍然要先过 sanitizeComputedColor 才能落到 DOM 上
    const safeColor = sanitizeComputedColor(followTextColor);
    if (safeColor !== "") {
        swatch.style.color = safeColor;
    }
    return swatch;
};

const createActionButton = (doc: Document, action: string, text: string): HTMLButtonElement => {
    const button = createElement<HTMLButtonElement>(doc, "button", BUTTON_CLASS);
    button.type = "button";
    button.setAttribute(ACTION_ATTRIBUTE, action);
    button.textContent = text;
    return button;
};

/** 一行：左侧标签、右侧控件。label 的 for 指向控件，点文字也能操作 */
const createRow = (
    doc: Document,
    row: string,
    labelText: string,
    labelFor: string,
    controlClassName: string,
): {row: HTMLElement; control: HTMLElement;} => {
    const rowElement = createElement(doc, "div", ROW_CLASS);
    rowElement.setAttribute(ROW_ATTRIBUTE, row);
    const label = createElement(doc, "label", LABEL_CLASS);
    label.setAttribute(LABEL_ATTRIBUTE, "");
    label.textContent = labelText;
    if (labelFor !== "") {
        label.setAttribute("for", labelFor);
    }
    const control = createElement(doc, "div", controlClassName);
    rowElement.appendChild(label);
    rowElement.appendChild(control);
    return {row: rowElement, control};
};

/**
 * 线型色块的无障碍名：线型中文名 + 方向。
 *
 * i18n 键按 `style` + 首字母大写的线型拼出（styleSolid / styleWavy …），
 * 因此新增线型只要在两个语言文件里各加一条，面板这边不用改。
 * 带上方向是因为两个区块各有一排长得一模一样的线型色块，只有名字能把它们区分开。
 */
const lineStyleName = (translate: (key: string) => string, style: TLineStyle, direction: TDirection): string => {
    const name = translate(`style${style[0].toUpperCase()}${style.slice(1)}`);
    return `${name} · ${translate(direction)}`;
};

const buildSection = (
    doc: Document,
    direction: TDirection,
    translate: (key: string) => string,
    followTextColor: string,
): ISectionWidgets => {
    const section = createElement(doc, "section", SECTION_CLASS);
    section.setAttribute(SECTION_ATTRIBUTE, direction);

    const toggleId = `${SWITCH_ID_PREFIX}${direction}`;
    const toggleRow = createRow(doc, "switch", translate(direction), toggleId, CONTROL_CLASS);
    const toggle = createElement<HTMLInputElement>(doc, "input", SWITCH_CLASS);
    toggle.type = "checkbox";
    toggle.id = toggleId;
    toggle.setAttribute(SWITCH_ATTRIBUTE, direction);
    toggleRow.control.appendChild(toggle);
    section.appendChild(toggleRow.row);

    const styleRow = createRow(doc, "style", translate("lineStyle"), "", SWATCHES_CLASS);
    const styleSwatches = LINE_STYLES.map((style) =>
        createStyleSwatch(doc, style, direction, lineStyleName(translate, style, direction))
    );
    for (const swatch of styleSwatches) {
        styleRow.control.appendChild(swatch);
    }
    section.appendChild(styleRow.row);

    const colorRow = createRow(doc, "color", translate("color"), "", SWATCHES_CLASS);
    const followSwatch = createFollowSwatch(doc, translate("followTextColor"), followTextColor);
    colorRow.control.appendChild(followSwatch);
    const colorSwatches = PRESET_COLORS.map((color) => createColorSwatch(doc, color));
    for (const swatch of colorSwatches) {
        colorRow.control.appendChild(swatch);
    }
    const customInput = createElement<HTMLInputElement>(doc, "input", COLOR_INPUT_CLASS);
    customInput.type = "color";
    customInput.value = DEFAULT_COLOR_VALUE;
    customInput.setAttribute(CUSTOM_COLOR_ATTRIBUTE, "");
    customInput.setAttribute("aria-label", translate("customColor"));
    customInput.title = translate("customColor");
    colorRow.control.appendChild(customInput);
    section.appendChild(colorRow.row);

    return {
        section,
        toggle,
        styleSwatches,
        followSwatch,
        colorSwatches,
        customInput,
        customSwatch: null,
    };
};

/** syncCustomSwatch 的附加参数 */
interface ICustomSwatchContext {
    /** 当前方向是否启用；关闭时临时色块同样不可点 */
    enabled: boolean;
    /** 与面板其余控件一致的事件名 */
    eventName: string;
    /** 选中该颜色的回调 */
    bind: (color: string) => void;
}

/**
 * 补上或撤掉当前自定义色的临时色块。
 *
 * 规格 §3.3 要求「自定义色值加入预设」。既不在预设里、也不跟随文字色的颜色若没有自己的色块，
 * 整行 12 个色块就一个都没选中，用户看不出当前用的是哪个颜色。
 * 这块色块是临时的：换成预设色或跟随文字色时立刻撤掉，因此色板始终是 11 个预设。
 *
 * 事件在它被造出来的那一刻就绑，而不是只绑构造期的那一批色块：只绑预设色块的话，
 * 这块长得和按钮一模一样、焦点也拿得到，点了却毫无反应。
 * enabled 决定它此刻是否可用，与同行的预设色块保持一致。
 */
const syncCustomSwatch = (
    doc: Document,
    widgets: ISectionWidgets,
    color: string,
    context: ICustomSwatchContext,
): void => {
    const current = widgets.customSwatch;
    // 已经挂着当前这一块就别动：切换开关之类的操作也会走到 render，来回重建只会白白换掉 DOM 节点
    if (current !== null && current.getAttribute(COLOR_ATTRIBUTE) === color) {
        current.disabled = !context.enabled;
        return;
    }
    if (current !== null) {
        current.remove();
        widgets.customSwatch = null;
    }
    if (color === "" || PRESET_COLORS.indexOf(color) !== -1) {
        return;
    }
    const swatch = createColorSwatch(doc, color);
    swatch.setAttribute(CUSTOM_SWATCH_ATTRIBUTE, "");
    swatch.disabled = !context.enabled;
    swatch.addEventListener(context.eventName, () => context.bind(swatch.getAttribute(COLOR_ATTRIBUTE)));
    markSelected(swatch, true);
    widgets.customInput.parentNode.insertBefore(swatch, widgets.customInput);
    widgets.customSwatch = swatch;
};

/** 视口尺寸；documentElement 的 clientWidth 在部分环境为 0，退回 window.innerWidth */
const viewportSize = (doc: Document): {width: number; height: number;} => {
    const view = doc.defaultView;
    const width = doc.documentElement?.clientWidth || view?.innerWidth || 0;
    const height = doc.documentElement?.clientHeight || view?.innerHeight || 0;
    return {width, height};
};

/**
 * 元素的矩形；元素缺失或已脱离文档时返回 null。
 *
 * 浮动工具栏被思源重渲染之后旧节点会脱离文档，而脱离文档的元素照样能量出矩形（全零），
 * 拿它算居中会把面板钉到视口左上角，因此 isConnected 是第一道闸门。
 */
const connectedRectOf = (element: HTMLElement): IRect | null => {
    if (element?.isConnected !== true || typeof element.getBoundingClientRect !== "function") {
        return null;
    }
    const rect = element.getBoundingClientRect();
    return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
};

/**
 * 当前选区在视口坐标系下的外接矩形；量不到就返回 null。
 *
 * 选区才是「不能被压住的文字」：浮动工具栏只挨着它的一端，单看工具栏的框会把其余部分漏掉。
 * Range.getBoundingClientRect 给的是范围内所有行盒的并集，多行、多块的选区因此也合成一个矩形。
 * 每次重新摆放都现量一次：重裹装饰与滚动都会挪动这段文字，记下来的旧矩形随即失效。
 */
const selectionRectOf = (view: Window): IRect | null => {
    const selection = view?.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }
    const range = selection.getRangeAt(0);
    // Range.getBoundingClientRect 并非处处都有（jsdom 就没有），缺它时按量不到选区处理
    if (typeof range?.getBoundingClientRect !== "function") {
        return null;
    }
    const rect = range.getBoundingClientRect();
    // 宽或高为 0 量的是光标而不是文字：交给锚点去定位，面板不必为此挪开
    return rect.width > 0 && rect.height > 0 ?
        {left: rect.left, top: rect.top, width: rect.width, height: rect.height} :
        null;
};

/**
 * 写回面板坐标；值没变就不写。
 *
 * 滚动事件来得比一帧还密，整页滚动时算出来的文档坐标其实一直没变，
 * 而每次写 style 都会让浏览器把布局标记为待更新，下一次读矩形就得重排一次。
 */
const movePanelTo = (panel: HTMLElement, left: number, top: number): void => {
    const x = `${left}px`;
    const y = `${top}px`;
    if (panel.style.left !== x) {
        panel.style.left = x;
    }
    if (panel.style.top !== y) {
        panel.style.top = y;
    }
};

/**
 * 按选区给面板定位置，量不到选区时退回锚点。
 *
 * 基准矩形优先取选区：面板要让开的是那段文字，而浮动工具栏只挨着选区的一端，拿它当基准会漏掉其余部分。
 * 四个方向的取舍全在 choosePlacement 里完成，这里只提供矩形、拿回坐标。
 * 面板挂在 body 上用绝对定位，坐标要在插入 DOM 之后量，末尾再加上滚动偏移换成文档坐标。
 */
const placePanel = (panel: HTMLElement, anchor: HTMLElement): void => {
    const doc = panel.ownerDocument;
    const view = doc.defaultView;
    if (panel.style.position !== "absolute") {
        panel.style.position = "absolute";
    }
    // 绝对定位相对文档坐标系，视口坐标要先加上滚动偏移，两条出口都一样
    const scrollLeft = view?.scrollX ?? 0;
    const scrollTop = view?.scrollY ?? 0;
    const selection = selectionRectOf(view);
    const reference = selection ?? connectedRectOf(anchor);
    if (reference === null) {
        // 选区与锚点都拿不到：停在视口边距上，面板仍然可用
        movePanelTo(panel, VIEWPORT_MARGIN + scrollLeft, VIEWPORT_MARGIN + scrollTop);
        return;
    }
    const panelRect = panel.getBoundingClientRect();
    const placement = choosePlacement({
        viewport: viewportSize(doc),
        panel: {width: panelRect.width, height: panelRect.height},
        reference,
        // 只让开选区：工具栏是界面的一部分，压住它不违背「不遮挡文字」这一条
        avoid: selection,
        gap: ANCHOR_GAP,
        margin: VIEWPORT_MARGIN,
    });
    movePanelTo(panel, placement.left + scrollLeft, placement.top + scrollTop);
};

/** 标记色块的选中态：aria-pressed 给无障碍，class 给主题 */
const markSelected = (element: HTMLElement, selected: boolean): void => {
    element.setAttribute("aria-pressed", selected ? "true" : "false");
    element.classList.toggle(SELECTED_CLASS, selected);
};

export const createPanel = (options: IPanelOptions): IPanelController => {
    // 面板必须与锚点同属一个 document，否则量到的 rect 与写入的坐标不在同一坐标系
    const ownerDocument = options.anchor?.ownerDocument ?? document;
    // 视口事件也挂在这个 window 上：面板的坐标是视口坐标，写进 style 时才换算成文档坐标
    const view = ownerDocument.defaultView;
    // 事件名在建面板时取一次：绑到一半再问，前端判断出岔子会让面板一半控件响应、一半不响应
    const eventName = getEventName();
    const mobile = eventName === TOUCH_EVENT;
    const translate = (key: string): string => options.i18n?.[key] ?? key;

    // 外部传入的配置先过一遍白名单，面板内部只持有干净数据
    let pair = sanitizePair(options.initialPair);
    // 选区里的装饰不一致时先挂提示；用户改一次之后整个选区就被统一了，提示随之撤掉
    let mixed = options.mixed === true;
    let destroyed = false;

    const panel = createElement<HTMLDivElement>(ownerDocument, "div", "");
    panel.setAttribute(PANEL_ATTRIBUTE, "");
    // 两端都要限高：定位只夹坐标轴，窗口比面板还矮时没有这条就把底部（含两个动作按钮）裁掉
    panel.style.maxHeight = mobile ? MOBILE_MAX_HEIGHT : MAX_HEIGHT;
    panel.style.overflowY = "auto";
    if (mobile) {
        panel.setAttribute(MOBILE_ATTRIBUTE, MOBILE_VALUE);
    }

    const title = createElement(ownerDocument, "div", TITLE_CLASS);
    title.setAttribute(TITLE_ATTRIBUTE, "");
    title.textContent = translate("underlineEnhancement");
    panel.appendChild(title);

    const mixedHint = createElement(ownerDocument, "div", MIXED_CLASS);
    mixedHint.setAttribute(MIXED_ATTRIBUTE, "");
    mixedHint.textContent = translate("mixedSelection");
    mixedHint.hidden = true;
    panel.appendChild(mixedHint);

    const sections: Record<TDirection, ISectionWidgets> = {
        underline: buildSection(ownerDocument, "underline", translate, options.followTextColor ?? ""),
        overline: buildSection(ownerDocument, "overline", translate, options.followTextColor ?? ""),
    };
    panel.appendChild(sections.underline.section);
    panel.appendChild(sections.overline.section);

    const actions = createElement(ownerDocument, "div", ACTIONS_CLASS);
    actions.setAttribute(ACTIONS_ATTRIBUTE, "");
    const clearButton = createActionButton(ownerDocument, "clear", translate("clearDecoration"));
    const undoButton = createActionButton(ownerDocument, "undo", translate("undo"));
    actions.appendChild(clearButton);
    actions.appendChild(undoButton);
    panel.appendChild(actions);

    ownerDocument.body.appendChild(panel);
    placePanel(panel, options.anchor);

    /**
     * 视口变了就重摆一次。
     *
     * 坐标是打开那一刻算出来的，缩放窗口或滚动正文之后面板会留在原处，甚至压回正在改的那段文字上。
     * 重摆时重新量活选区，因此重裹装饰挪动了文字也跟着跟上。
     */
    const reposition = (): void => {
        if (!destroyed) {
            placePanel(panel, options.anchor);
        }
    };
    /**
     * 捕获阶段收滚动：思源的每个编辑区各自是滚动容器，冒泡阶段的监听收不到它们内部的滚动。
     * 面板自己也是滚动容器，滚它的内容属于面板内部，不该反过来把面板挪走。
     */
    const handleScroll = (event: Event): void => {
        const target = event.target as Node | null;
        const isNode = typeof (target as Element)?.nodeType === "number";
        if (isNode && (target === panel || panel.contains(target))) {
            return;
        }
        reposition();
    };
    view?.addEventListener("resize", reposition);
    view?.addEventListener("scroll", handleScroll, {capture: true, passive: true});

    /** 把面板内部状态画到控件上 */
    const render = (): void => {
        mixedHint.hidden = !mixed;
        for (const direction of DIRECTIONS) {
            const widgets = sections[direction];
            const decoration = pair[direction];
            const color = sanitizeColor(decoration.color);
            widgets.toggle.checked = decoration.enabled;
            // 方向关闭时它那两行没有意义，控件禁用掉：面板默认关着上划线，
            // 留着可点的色块的话，点第一下就替用户做了「开启这个方向」的决定
            // （关闭态的样式与颜色一改，就等于同时打开了它）。
            // 禁用的视觉交给思源的 b3-* 样式，这里不另造一套。
            for (const swatch of widgets.styleSwatches) {
                markSelected(swatch, swatch.getAttribute(STYLE_ATTRIBUTE) === decoration.style);
                swatch.disabled = !decoration.enabled;
            }
            widgets.followSwatch.disabled = !decoration.enabled;
            markSelected(widgets.followSwatch, color === "");
            for (const swatch of widgets.colorSwatches) {
                markSelected(swatch, swatch.getAttribute(COLOR_ATTRIBUTE) === color);
                swatch.disabled = !decoration.enabled;
            }
            widgets.customInput.disabled = !decoration.enabled;
            syncCustomSwatch(ownerDocument, widgets, color, {
                enabled: decoration.enabled,
                eventName,
                bind: (value: string) => updateOf[direction]({color: sanitizeColor(value)}),
            });
            // 块上已有的自定义色既不在预设里、也不跟随文字色，取色器要跟着显示它；
            // 颜色不是 #rrggbb 时不动控件，免得把用户刚挑的颜色抹成黑色
            if (HEX_COLOR_PATTERN.test(color)) {
                widgets.customInput.value = color;
            }
        }
        // 撤销栈由调用方掌管，这里只反映它给出的可用性
        undoButton.disabled = !options.undoEnabled;
    };

    /**
     * 提交一组新配置。
     *
     * 与当前配置等价时不回调：重复点同一个色块没有任何新意图，
     * 让它走下去只会多一次装饰重排与一次保存，表现为预览抖动。
     */
    const commit = (next: IDecorationPair): void => {
        if (destroyed || isSamePair(next, pair)) {
            return;
        }
        pair = next;
        // 这次改动会把整个选区统一成面板这一份配置，混合状态随之结束
        mixed = false;
        render();
        options.onChange(clonePair(pair));
    };

    /** 每个方向提交「只改一个字段」的那条路径；临时色块也是走它 */
    const updateOf = {} as Record<TDirection, (patch: Partial<IDecoration>) => void>;

    for (const direction of DIRECTIONS) {
        const widgets = sections[direction];
        /** 只改该方向的某个字段，其余字段原样带过 */
        updateOf[direction] = (patch: Partial<IDecoration>): void => {
            // 方向关闭时线型与颜色两行都是禁用的，这里再挡一道：
            // 即便事件被程序化派发出来，也不该凭空产生一次改动。
            // 开关本身要能把它打开，因此只有「没有打开的意图」时才挡。
            if (patch.enabled === undefined && !pair[direction].enabled) {
                return;
            }
            const next = clonePair(pair);
            next[direction] = {...next[direction], ...patch};
            commit(next);
        };
        const update = updateOf[direction];
        for (const swatch of widgets.styleSwatches) {
            const style = swatch.getAttribute(STYLE_ATTRIBUTE) as TLineStyle;
            swatch.addEventListener(eventName, () => update({style}));
        }
        for (const swatch of widgets.colorSwatches) {
            const color = swatch.getAttribute(COLOR_ATTRIBUTE);
            swatch.addEventListener(eventName, () => update({color: sanitizeColor(color)}));
        }
        widgets.followSwatch.addEventListener(eventName, () => update({color: ""}));
        // 开关与取色器用原生 change：移动端 touchend 早于浏览器补发的 click，
        // 在 touchend 里读 checked 读到的还是切换前的值；change 两端一致，点击行为也由浏览器给出
        widgets.toggle.addEventListener("change", () => update({enabled: widgets.toggle.checked}));
        widgets.customInput.addEventListener("change", () => update({color: sanitizeColor(widgets.customInput.value)}));
    }
    clearButton.addEventListener(eventName, () => {
        // 清除同样把整个选区统一了，混合状态到此为止
        if (mixed) {
            mixed = false;
            render();
        }
        options.onClear();
    });
    undoButton.addEventListener(eventName, () => {
        options.onUndo();
    });

    // 面板内的点击会冒泡到 document，靠 contains 把它们排除在「面板外」之外
    const handleOutsideEvent = (event: Event): void => {
        if (destroyed || event.target === null) {
            return;
        }
        const target = event.target as Node;
        // 浮动工具栏同样不算「面板外」：打开面板的那一次点击正是从工具栏按钮上冒泡过来的
        // （思源的 ToolbarItem 只 preventDefault，不 stopPropagation，事件照样走到 document）。
        // 把它当成面板外点击的话，面板会在打开的同一瞬间被自己的点击关掉。
        if (panel.contains(target) || options.anchor?.contains(target) === true) {
            return;
        }
        options.onClose();
    };
    const handleKeydown = (event: KeyboardEvent): void => {
        if (destroyed || event.key !== ESCAPE_KEY) {
            return;
        }
        options.onClose();
    };

    /**
     * 吃掉面板内按下的默认行为，让编辑器的焦点留在原地。
     *
     * 面板上的控件全是 button 与 input，按下时浏览器默认把焦点交给被按的那个元素；
     * 编辑器一失焦思源就清掉选区，面板记下的坐标随即失去意义，用户看到的是「点一下取消选中」。
     *
     * 挂在面板根上而不是逐个控件：色块、开关、取色器、两个动作按钮以及渲染时才插进来的
     * 临时色块都在这棵子树里，一处监听就够，后加的控件也自动被罩住。
     * 只 preventDefault，不 stopPropagation：click 照旧冒泡到 document，
     * 「点击面板外关闭」与 Escape 两条出口的判定都不受影响。
     */
    const handleMouseDown = (event: Event): void => {
        event.preventDefault();
    };
    panel.addEventListener(PRESS_EVENT, handleMouseDown);
    ownerDocument.addEventListener(eventName, handleOutsideEvent);
    ownerDocument.addEventListener("keydown", handleKeydown);

    render();

    return {
        getPair: () => clonePair(pair),
        setPair: (next: IDecorationPair, nextMixed?: boolean) => {
            if (destroyed) {
                return;
            }
            // 与构造时同一条防线：外部读回的值一律先过白名单，面板内部只持有干净数据
            pair = sanitizePair(next);
            // 撤销之后各区域的装饰可能又不一样了，调用方重新判一次；没给就沿用当前状态
            if (nextMixed !== undefined) {
                mixed = nextMixed;
            }
            render();
        },
        destroy: () => {
            if (destroyed) {
                return;
            }
            destroyed = true;
            // 挂在 document 上的两个监听必须显式摘掉：它们不在面板子树里，不会随子树一起消失
            ownerDocument.removeEventListener(eventName, handleOutsideEvent);
            ownerDocument.removeEventListener("keydown", handleKeydown);
            // 这一个同样显式摘掉：面板虽然已经从 DOM 移除，脱管节点上的按下不该再被它拦住
            panel.removeEventListener(PRESS_EVENT, handleMouseDown);
            // 视口上的两个监听同理：面板销毁之后不该再被滚动与缩放带着走。
            // 摘捕获阶段的滚动监听必须带上同一个 capture 标志，否则摘不掉。
            view?.removeEventListener("resize", reposition);
            view?.removeEventListener("scroll", handleScroll, true);
            panel.remove();
        },
    };
};
