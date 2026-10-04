/**
 * 装饰设置面板：把一份装饰配置渲染成可点的控件，并把用户的每次改动以 IDecoration 的形式报给调用方。
 *
 * 本模块只做「呈现 + 收集意图」：它不碰文档 DOM、不调内核，也不感知撤销栈的内容。
 * 谁把配置应用到选区、谁来保存与销毁，都由 src/index.ts 通过 IPanelOptions 的回调决定。
 *
 * 面板挂在 document.body 上而不是浮动工具栏内部：IMenuItem.click 只给出 protyle 实例，
 * 拿不到触发按钮元素，而思源内部 subElement 的定位并非公开契约。
 * 因此 options.anchor 只是定位参照之一：面板要避开的是选区，坐标在插入 DOM 后量出来再夹进视口。
 *
 * 面板里的控件全部是不可聚焦的 div：可聚焦的元素会在按下时把焦点从 contenteditable 带走，
 * 思源随之清掉选区，浮动工具栏也跟着收起，面板记下的字符偏移于是不再指向用户的文字。
 *
 * 控件分两类，收不收面板都收：设置类（线型、颜色、跟随文字色、方向开关）选中即提交这一次设置，
 * 与思源自己的颜色菜单一致 —— 做完就收面板，浮动工具栏与文字选中都留着，要接着调就重新点一次工具栏图标；
 * 终止类（清除装饰、撤销、原生取色器）同样收工。差别只在原生取色器：系统对话框会拿走焦点，
 * 那一条路连选区带浮动工具栏一起交出去，其余控件都保留选区与浮动工具栏。
 */
import {getEventName} from "./dom";
import {
    LINE_STYLES,
    PRESET_COLORS,
    isSameDecoration,
    sanitizeColor,
    sanitizeComputedColor,
    sanitizeDecoration,
} from "./model";
import type {
    IDecoration,
    TLineStyle,
} from "./model";
import {choosePlacement} from "./placement";
import type {IRect} from "./placement";

export interface IPanelOptions {
    /** 定位参照：思源浮动工具栏的容器元素 */
    anchor: HTMLElement;
    /** 打开时的配置，由调用方从选区回填 */
    initialDecoration: IDecoration;
    /** 文案表；缺键时退回键名，便于一眼看出漏了哪条翻译 */
    i18n: Record<string, string>;
    /**
     * 选中文字的计算颜色，给「跟随文字色」色块上的字母上色。
     * 由调用方从选区里读一次；空值或非法值一律不上色，字母保持继承面板的正文色。
     */
    followTextColor?: string;
    /**
     * 选区里的各区域装饰并不一致，initialDecoration 只是其中一份。
     * 面板据此先说明再让用户点：一次改动会把整个选区统一成面板当前这一份配置，
     * 不说清楚的话，第一下点击就会静默改写用户没打算动的那些区域。
     */
    mixed?: boolean;
    /**
     * 本次面板会话里还有没有可撤销的改动；调用方据此决定撤销键是否可用。
     *
     * 撤销是面板里唯一一个可以有禁用态的控件：设置类控件每一下都是新意图，
     * 而一个「按了没反应」的撤销键只会让人反复去按它。没给这个值时按「有东西可撤销」处理，
     * 免得面板凭空摆出一个按不动的按钮。
     */
    undoEnabled?: boolean;
    onChange: (decoration: IDecoration) => void;
    onClear: () => void;
    onUndo: () => void;
    /**
     * 收起面板。设置类、清除装饰、撤销、原生取色器以及面板外的点击与 Esc 都会请出它：
     * 任何一次控件激活都只服务于一次设置，做完即收，与思源自己的颜色菜单一致。
     */
    onClose: () => void;
    /**
     * 原生取色器挑完颜色之后调用：清掉选区，并收起思源的浮动工具栏。
     *
     * 系统取色对话框强制拿走焦点，编辑器与浮动工具栏都已随之收摊；这条路径因此不走
     * 「保住选区」那一套，而是干脆把两者一起收干净。面板随后仍会调 onClose 收起自己。
     * 其余控件都不碰这个回调：它们保留选区，也保留浮动工具栏。
     */
    onCustomColorPicked?: () => void;
}

export interface IPanelController {
    /** 当前配置的一份快照；改动返回值不会影响面板自身状态 */
    getDecoration: () => IDecoration;
    /**
     * 用外部读回的配置覆盖面板状态并重画控件。
     *
     * 清除装饰与撤销都由调用方直接改文档，面板自己看不到结果，得靠这里把选中态刷回来；
     * 这不是用户操作，因此不触发 onChange。第二个实参重报选区是否仍不一致（撤销之后要重新判一次）。
     */
    setDecoration: (decoration: IDecoration, mixed?: boolean) => void;
    /**
     * 报一次「还有没有东西可撤销」，面板据此重画撤销键的禁用态。
     * 每次改动与每次撤销之后都要报：栈深只有调用方掌握。
     */
    setUndoEnabled: (enabled: boolean) => void;
    /** 移除面板并摘掉所有监听；可重复调用 */
    destroy: () => void;
}

/** 面板的装饰方向；插件只画下划线这一个方向 */
type TDirection = "underline";

const DIRECTIONS: readonly TDirection[] = ["underline"];

// ---------------------------------------------------------------- 标记属性与类名

/** 面板根标记；CSS 根选择器与外部识别都靠它 */
const PANEL_ATTRIBUTE = "data-sue-panel";
/**
 * 面板根的来源标记；值取自思源自己的常量（toolbar/subElementLifecycle.ts 的
 * SELECTION_TOOLBAR_SUB_ELEMENT_SOURCE）。
 *
 * 思源在 window 的 mousedown 监听里，只要按下的目标不在 .protyle-toolbar 内、也不带这个标记，
 * 就调用 hideAllElements(["toolbar"]) 收起浮动工具栏。面板挂在 body 上，正是那个「不在工具栏内」的目标，
 * 因此必须带上这个标记，思源才把它当成浮动工具栏的一部分而不收起工具栏。
 * 这既是思源自己的颜色菜单（subElement）用的机制，也是 preventDefault 拦不住的一道检查
 * （它是 window 上的自定义监听，preventDefault 只影响浏览器默认行为）。
 */
const SUB_ELEMENT_SOURCE_ATTRIBUTE = "data-sub-element-source";
/** 与思源 SELECTION_TOOLBAR_SUB_ELEMENT_SOURCE 一致的值 */
const SUB_ELEMENT_SOURCE_VALUE = "selection-toolbar";
/** 方向区块标记，值为 underline */
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
/** 开关自绘外观与选中态：思源的 b3-switch 是给 input[type=checkbox] 写的，面板里的开关不是 input */
const SWITCH_CLASS = "sue-switch";
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

/** 线型色块的预览线画在哪一侧；插件只画下划线，因此恒为 underline */
const LINE_KEYWORD = "underline";

/** 一个方向区块里的控件引用 */
interface ISectionWidgets {
    section: HTMLElement;
    toggle: HTMLDivElement;
    styleSwatches: HTMLDivElement[];
    followSwatch: HTMLDivElement;
    colorSwatches: HTMLDivElement[];
    customInput: HTMLInputElement;
    /** 当前自定义色的临时色块；不是预设色，随时可能被撤掉 */
    customSwatch: HTMLDivElement | null;
}

/** 复制一份配置，避免调用方改到面板内部的状态 */
const cloneDecoration = (decoration: IDecoration): IDecoration => ({...decoration});

const createElement = <T extends HTMLElement>(doc: Document, tagName: string, className: string): T => {
    const element = doc.createElement(tagName);
    if (className !== "") {
        element.className = className;
    }
    return element as T;
};

/**
 * 面板上的可点控件：一个不带 tabindex 的 div + role。
 *
 * 可聚焦的元素按下时会把焦点从 contenteditable 交给它，思源随之清掉选区；
 * 于是面板记下的字符偏移不再指向用户的文字，下一次改动取出的会是别处的内容。
 * div 不是可聚焦区域，按下它焦点原地不动，click 照常派发 —— 思源自己的菜单项正是这么做的。
 * 刻意不写 tabindex="-1"：带 tabindex 的元素仍然可聚焦（只是不进 tab 序列），按它照样夺走焦点。
 * role="button" 与 aria-label 一起给，因此读屏软件仍把它当成按钮并读得出名字。
 */
const createControl = (doc: Document, className: string, ariaLabel: string): HTMLDivElement => {
    const control = createElement<HTMLDivElement>(doc, "div", className);
    control.setAttribute("role", "button");
    control.setAttribute("aria-label", ariaLabel);
    return control;
};

/**
 * 线型色块：靠元素自身的 text-decoration 画出真实的线，不画图标字符也不用图片。
 * 三个属性都必须写全：只写 text-decoration-style 时线型仍取自默认的 solid。
 *
 * 控件里唯一的可见内容是示例文本（两个 EN SPACE），对读屏软件来说没有名字，因此
 * aria-label 必须给。刻意不用 CSS 关键词当名字：中文界面里 "wavy" 对用户没有意义，
 * 名字取自 i18n 里的线型名。
 */
const createStyleSwatch = (doc: Document, style: TLineStyle, ariaLabel: string): HTMLDivElement => {
    const swatch = createControl(doc, `${BUTTON_CLASS} ${SWATCH_CLASS}`, ariaLabel);
    swatch.setAttribute(STYLE_ATTRIBUTE, style);
    swatch.setAttribute("aria-pressed", "false");
    swatch.textContent = SAMPLE_TEXT;
    swatch.style.whiteSpace = "pre";
    swatch.style.textDecorationLine = LINE_KEYWORD;
    swatch.style.textDecorationStyle = style;
    swatch.style.textDecorationColor = "currentColor";
    return swatch;
};

/**
 * 颜色色块。颜色先过白名单再落到 DOM 上：这些值最终会进入持久化的文档 HTML，
 * 面板是这条链路上第一个可能拿到脏值的地方，防线必须落在最前面。
 * 色块上没有可见文字，无障碍名因此直接取颜色原值。
 */
const createColorSwatch = (doc: Document, color: string): HTMLDivElement => {
    const safeColor = sanitizeColor(color);
    const swatch = createControl(doc, `${BUTTON_CLASS} ${SWATCH_CLASS}`, safeColor);
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
const createFollowSwatch = (doc: Document, title: string, followTextColor: string): HTMLDivElement => {
    const swatch = createControl(doc, `${BUTTON_CLASS} ${SWATCH_CLASS}`, title);
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

const createActionButton = (doc: Document, action: string, text: string): HTMLDivElement => {
    const button = createControl(doc, BUTTON_CLASS, text);
    button.setAttribute(ACTION_ATTRIBUTE, action);
    button.textContent = text;
    return button;
};

/**
 * 方向开关。它不能是 input[type=checkbox]：复选框是可聚焦的，按下就把焦点带离编辑器。
 * 勾选状态因此记在 aria-checked 上，切换由面板自己完成（与色块同一个不可聚焦的 div）。
 */
const createSwitch = (doc: Document, direction: TDirection, ariaLabel: string): HTMLDivElement => {
    const toggle = createControl(doc, SWITCH_CLASS, ariaLabel);
    toggle.setAttribute("role", "switch");
    toggle.setAttribute(SWITCH_ATTRIBUTE, direction);
    toggle.setAttribute("aria-checked", "false");
    return toggle;
};

/** 一行：左侧标签、右侧控件 */
const createRow = (
    doc: Document,
    row: string,
    labelText: string,
    controlClassName: string,
): {row: HTMLElement; control: HTMLElement;} => {
    const rowElement = createElement(doc, "div", ROW_CLASS);
    rowElement.setAttribute(ROW_ATTRIBUTE, row);
    const label = createElement(doc, "label", LABEL_CLASS);
    label.setAttribute(LABEL_ATTRIBUTE, "");
    label.textContent = labelText;
    const control = createElement(doc, "div", controlClassName);
    rowElement.appendChild(label);
    rowElement.appendChild(control);
    return {row: rowElement, control};
};

/**
 * 线型色块的无障碍名：线型在 i18n 里的名字。
 *
 * 键按 `style` + 首字母大写的线型拼出（styleSolid / styleWavy …），
 * 因此新增线型只要在两个语言文件里各加一条，面板这边不用改。
 */
const lineStyleName = (translate: (key: string) => string, style: TLineStyle): string =>
    translate(`style${style[0].toUpperCase()}${style.slice(1)}`);

const buildSection = (
    doc: Document,
    direction: TDirection,
    translate: (key: string) => string,
    followTextColor: string,
): ISectionWidgets => {
    const section = createElement(doc, "section", SECTION_CLASS);
    section.setAttribute(SECTION_ATTRIBUTE, direction);

    const toggleRow = createRow(doc, "switch", translate(direction), CONTROL_CLASS);
    const toggle = createSwitch(doc, direction, translate(direction));
    toggleRow.control.appendChild(toggle);
    section.appendChild(toggleRow.row);

    const styleRow = createRow(doc, "style", translate("lineStyle"), SWATCHES_CLASS);
    const styleSwatches = LINE_STYLES.map((style) => createStyleSwatch(doc, style, lineStyleName(translate, style)));
    for (const swatch of styleSwatches) {
        styleRow.control.appendChild(swatch);
    }
    section.appendChild(styleRow.row);

    const colorRow = createRow(doc, "color", translate("color"), SWATCHES_CLASS);
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
 * 这块与其它色块长得一模一样，点了却毫无反应。它同样是不可聚焦的 div。
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

/** 标记开关的勾选态：aria-checked 给无障碍，外观由 index.scss 按同一个属性画出 */
const markChecked = (element: HTMLElement, checked: boolean): void => {
    element.setAttribute("aria-checked", checked ? "true" : "false");
};

/**
 * 标记控件的禁用态。
 *
 * 控件是 div，没有 disabled 属性可设，语义与外观因此共用 aria-disabled 这一条：
 * 样式表按同一个属性画出禁用外观，按下时那条监听里还会再问一遍状态，禁用中的一律不回调。
 * 只有撤销键会带上它 —— 设置类控件永远可点。
 */
const markDisabled = (element: HTMLElement, disabled: boolean): void => {
    if (disabled) {
        element.setAttribute("aria-disabled", "true");
    } else {
        element.removeAttribute("aria-disabled");
    }
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
    let decoration = sanitizeDecoration(options.initialDecoration);
    // 选区里的装饰不一致时先挂提示；用户改一次之后整个选区就被统一了，提示随之撤掉
    let mixed = options.mixed === true;
    // 撤销栈只有调用方掌握；没报就按「有东西可撤销」处理，面板不凭空摆出一个按不动的按钮
    let undoEnabled = options.undoEnabled !== false;
    let destroyed = false;

    const panel = createElement<HTMLDivElement>(ownerDocument, "div", "");
    panel.setAttribute(PANEL_ATTRIBUTE, "");
    // 让思源把面板当成浮动工具栏的一部分：否则点击面板会触发思源的全局 mousedown 收起工具栏
    panel.setAttribute(SUB_ELEMENT_SOURCE_ATTRIBUTE, SUB_ELEMENT_SOURCE_VALUE);
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
    };
    for (const direction of DIRECTIONS) {
        panel.appendChild(sections[direction].section);
    }

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
        // 撤销是面板里唯一可能有禁用态的控件：栈空了它就该摆成按不动的样子
        markDisabled(undoButton, !undoEnabled);
        const color = sanitizeColor(decoration.color);
        for (const direction of DIRECTIONS) {
            const widgets = sections[direction];
            markChecked(widgets.toggle, decoration.enabled);
            for (const swatch of widgets.styleSwatches) {
                markSelected(swatch, swatch.getAttribute(STYLE_ATTRIBUTE) === decoration.style);
            }
            markSelected(widgets.followSwatch, color === "");
            for (const swatch of widgets.colorSwatches) {
                markSelected(swatch, swatch.getAttribute(COLOR_ATTRIBUTE) === color);
            }
            syncCustomSwatch(ownerDocument, widgets, color, {
                eventName,
                bind: (value: string) => {
                    update({color: sanitizeColor(value), enabled: true});
                    options.onClose();
                },
            });
            // 块上已有的自定义色既不在预设里、也不跟随文字色，取色器要跟着显示它；
            // 颜色不是 #rrggbb 时不动控件，免得把用户刚挑的颜色抹成黑色
            if (HEX_COLOR_PATTERN.test(color)) {
                widgets.customInput.value = color;
            }
        }
    };

    /**
     * 提交一份新配置。
     *
     * 与当前配置等价时不回调：重复点同一个色块没有任何新意图，
     * 让它走下去只会多一次装饰重排与一次保存，表现为预览抖动。
     */
    const commit = (next: IDecoration): void => {
        if (destroyed || isSameDecoration(next, decoration)) {
            return;
        }
        decoration = next;
        // 这次改动会把整个选区统一成面板这一份配置，混合状态随之结束
        mixed = false;
        render();
        options.onChange(cloneDecoration(decoration));
    };

    /** 提交「只改某个字段」的那条路径；色块、开关与临时色块都走它 */
    const update = (patch: Partial<IDecoration>): void => commit({...decoration, ...patch});

    for (const direction of DIRECTIONS) {
        const widgets = sections[direction];
        // 线型与颜色两行永远可点：方向关着的时候点它们就是把下划线打开并用上这个值，
        // 否则这两行会变成一批点下去毫无反应的控件。
        // 四类设置控件都在提交之后收起面板，与思源自己的颜色菜单一致：选中即完成这一次设置，
        // 面板收起后浮动工具栏与文字选中都留着，用户要接着调就重新点一次工具栏图标
        for (const swatch of widgets.styleSwatches) {
            const style = swatch.getAttribute(STYLE_ATTRIBUTE) as TLineStyle;
            swatch.addEventListener(eventName, () => {
                update({style, enabled: true});
                options.onClose();
            });
        }
        for (const swatch of widgets.colorSwatches) {
            const color = swatch.getAttribute(COLOR_ATTRIBUTE);
            swatch.addEventListener(eventName, () => {
                update({color: sanitizeColor(color), enabled: true});
                options.onClose();
            });
        }
        widgets.followSwatch.addEventListener(eventName, () => {
            update({color: "", enabled: true});
            options.onClose();
        });
        // 开关自己切换勾选状态：它不是 input，取不到原生 checkbox 的激活行为。
        // 从关到开是一次真的改动：提交出去的那份配置会被真的裹到文档上，而不只是翻面板内部的开关
        widgets.toggle.addEventListener(eventName, () => {
            update({enabled: !decoration.enabled});
            options.onClose();
        });
        /**
         * 取色器是面板里唯一必须收场的控件。
         *
         * 系统取色对话框强制拿走焦点，编辑器随之清掉选区、浮动工具栏也跟着收起；
         * 这条路径上再把选区恢复回来既多余又靠不住，因此挑完颜色先让调用方把选区与浮动工具栏
         * 收干净，面板自己也一并收起 —— 与其余控件「保留选区、保留工具栏」的做法正好相反。
         */
        widgets.customInput.addEventListener("change", () => {
            update({color: sanitizeColor(widgets.customInput.value), enabled: true});
            options.onCustomColorPicked();
            options.onClose();
        });
    }
    clearButton.addEventListener(eventName, () => {
        // 清除是终止类操作：做完整段选区就没有装饰了，接着调也没有意义，因此做完收面板
        // 清除同样把整个选区统一了，混合状态到此为止
        if (mixed) {
            mixed = false;
            render();
        }
        options.onClear();
        options.onClose();
    });
    undoButton.addEventListener(eventName, () => {
        // 禁用态是面板里唯一一处真的按了没反应：没有东西可撤销时既不撤销也不收面板，
        // 亮着的按钮会让人以为按过就该有效果
        if (!undoEnabled) {
            return;
        }
        options.onUndo();
        options.onClose();
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

    ownerDocument.addEventListener(eventName, handleOutsideEvent);
    ownerDocument.addEventListener("keydown", handleKeydown);

    render();

    return {
        getDecoration: () => cloneDecoration(decoration),
        setDecoration: (next: IDecoration, nextMixed?: boolean) => {
            if (destroyed) {
                return;
            }
            // 与构造时同一条防线：外部读回的值一律先过白名单，面板内部只持有干净数据
            decoration = sanitizeDecoration(next);
            // 撤销之后各区域的装饰可能又不一样了，调用方重新判一次；没给就沿用当前状态
            if (nextMixed !== undefined) {
                mixed = nextMixed;
            }
            render();
        },
        setUndoEnabled: (enabled: boolean) => {
            if (destroyed || undoEnabled === enabled) {
                return;
            }
            undoEnabled = enabled;
            markDisabled(undoButton, !undoEnabled);
        },
        destroy: () => {
            if (destroyed) {
                return;
            }
            destroyed = true;
            // 挂在 document 上的两个监听必须显式摘掉：它们不在面板子树里，不会随子树一起消失
            ownerDocument.removeEventListener(eventName, handleOutsideEvent);
            ownerDocument.removeEventListener("keydown", handleKeydown);
            // 视口上的两个监听同理：面板销毁之后不该再被滚动与缩放带着走。
            // 摘捕获阶段的滚动监听必须带上同一个 capture 标志，否则摘不掉。
            view?.removeEventListener("resize", reposition);
            view?.removeEventListener("scroll", handleScroll, true);
            panel.remove();
        },
    };
};
