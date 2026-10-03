/**
 * 插件接线层：注册浮动工具栏项，把面板报上来的配置落到当前选区上，按设计稿保存与撤销，
 * 并在卸载时把挂出去的监听、面板与定时器全部收回。
 *
 * 本文件只做编排：样式怎么算在 model.ts、装饰怎么裹在 dom.ts、面板长什么样在 panel.ts、
 * 落盘与撤销怎么做在 persist.ts，这里不重复其中任何一条规则。
 */
import {
    Plugin,
    showMessage,
} from "siyuan";
import type {
    Protyle,
    Toolbar,
} from "siyuan";
import "./index.scss";
import {
    applySpansIn,
    captureOffsets,
    collectEditableGroups,
    readDecorationStylesIn,
    reclaimEditableElement,
    restoreOffsets,
} from "./dom";
import type {IEditableGroup} from "./dom";
import {UNDERLINE_ICON_SVG} from "./icons";
import {
    DEFAULT_PAIR,
    composePair,
    isSamePair,
    readPairFromStyle,
    sanitizePair,
} from "./model";
import type {IDecorationPair} from "./model";
import {createPanel} from "./panel";
import type {
    IPanelController,
    IPanelOptions,
} from "./panel";
import {
    clearChanges,
    createDebouncedSaver,
    findBlockElement,
    hasUndoableChange,
    recordChange,
    undoLastChange,
} from "./persist";
import type {
    IBlockChange,
    IDebouncedSaver,
} from "./persist";

/** 工具栏项的稳定标识：addToolbarItem 的 name 与 removeToolbarItem 的实参取自同一个常量 */
export const TOOLBAR_ITEM_NAME = "underline-enhancement";

/** 注入图标的 symbol id，与 IMenuItem.icon 一致 */
const ICON_ID = "iconUnderlineEnhancement";

/** 保存防抖窗口（ms）：实时预览会以毫秒级连续触发，落盘合并成一个窗口 */
const SAVE_DEBOUNCE_MS = 300;

/** 记住上次配置的插件私有存储文件名 */
const SETTINGS_FILE = "settings.json";

/** 块 id 的属性名；防抖保存的记账键必须与元素自身的这个值一致 */
const NODE_ID_ATTRIBUTE = "data-node-id";

/**
 * 两个方向都关闭的一组配置。
 * 既是「清除装饰」的入参，也是「选区里没有装饰」的判据：
 * readPairFromStyle 对着没有装饰的区域会给出两个方向都关闭的结果。
 */
const CLEARED_PAIR: IDecorationPair = {
    underline: {...DEFAULT_PAIR.underline, enabled: false},
    overline: {...DEFAULT_PAIR.overline, enabled: false},
};

export default class UnderlineEnhancement extends Plugin {
    /** 当前面板；null 表示没有打开的面板 */
    private panel: IPanelController = null;
    /**
     * 传给面板的实参对象。面板每次重画都重读它上面的 undoEnabled，
     * 因此撤销可用性只能靠就地改这个对象来告诉面板，面板本身并不持有撤销栈。
     */
    private panelOptions: IPanelOptions = null;
    /** 打开面板时的选区分组；面板开着期间的每次改动都落到它上面 */
    private groups: IEditableGroup[] = [];
    /** 打开面板时记下的字符偏移；包裹装饰会让原 Range 失效，只能靠它重建选区 */
    private offsets: Array<[HTMLElement, number, number]> = [];
    /** 刚应用到文档上的那一组配置，关闭面板时据此记住上次的用法 */
    private appliedPair: IDecorationPair = null;
    /** 防抖保存器：所有块共用一个窗口 */
    private saver: IDebouncedSaver = null;
    /** 打开面板时挂着的浮动工具栏，关闭时要把 subElementCloseCB 还回去 */
    private toolbar: Toolbar = null;
    /** 思源原有的关闭回调；插件的回调不能留在思源的对象上 */
    private previousSubElementCloseCB: () => void = null;
    /** 记住的上次配置，选区里没有装饰时作为面板初值 */
    private rememberedPair: IDecorationPair = null;
    /** 撤销进行中；重复触发会与前一次抢同一个栈顶 */
    private undoing = false;

    /** 切换文档或页签：块 id 已不属于当前文档，留着的撤销记录只会让撤销一直卡在过期项上 */
    private readonly handleProtyleSwitch = () => {
        this.closePanel();
        clearChanges();
    };

    onload() {
        this.addIcons(UNDERLINE_ICON_SVG);
        this.saver = createDebouncedSaver(SAVE_DEBOUNCE_MS, {
            onError: () => {
                // 保存失败没有任何其他出口，装饰就只留在屏幕上；设计稿 §7.1 要求提示用户
                showMessage(this.i18n.saveFailed as string);
            },
        });
        // 只读模式与发布服务里装饰照常由 inline style 渲染，但没有可写的编辑器，按钮没有意义
        if (window.siyuan.config.readonly || window.siyuan.isPublish) {
            return;
        }
        this.addToolbarItem({
            name: TOOLBAR_ITEM_NAME,
            icon: ICON_ID,
            tip: this.i18n.underlineEnhancement as string,
            tipPosition: "n",
            click: (protyle: Protyle) => this.openPanel(protyle),
        });
        this.eventBus.on("switch-protyle", this.handleProtyleSwitch);
    }

    async onLayoutReady() {
        try {
            // 读回的是磁盘上的外部数据，必须过白名单才能进面板，也才能再写回文档
            this.rememberedPair = sanitizePair(await this.loadData(SETTINGS_FILE));
        } catch (error) {
            // 读不到只影响「上次用过什么」：初值退回默认值，其余功能不受影响
            console.log(`[${this.name}] load data [${SETTINGS_FILE}] fail: `, error);
        }
    }

    onunload() {
        // 关闭面板会把未到点的保存发出去，因此先收面板，再摘工具栏项
        this.closePanel();
        this.saver?.cancel();
        this.removeToolbarItem(TOOLBAR_ITEM_NAME);
        this.eventBus?.off("switch-protyle", this.handleProtyleSwitch);
        clearChanges();
    }

    /**
     * 在浮动工具栏的按钮被点下时打开面板。
     *
     * IMenuItem.click 收到的是 Protyle 类实例（思源的 ToolbarItem 传的是 protyle.getInstance()），
     * 浮动工具栏挂在它的 .protyle 上；click 也拿不到触发按钮本身，面板因此只拿工具栏容器当定位参照。
     */
    private openPanel(protyle: Protyle): void {
        const toolbar = protyle?.protyle?.toolbar;
        if (this.panel !== null || !toolbar) {
            return;
        }
        const groups = collectEditableGroups(toolbar.range);
        if (groups.length === 0) {
            // 选区落在代码块、公式、属性视图等不可编辑区域里，没有可装饰的目标
            return;
        }
        this.groups = groups;
        this.offsets = captureOffsets(toolbar.range);
        this.appliedPair = null;
        this.undoing = false;
        this.toolbar = toolbar;
        this.previousSubElementCloseCB = toolbar.subElementCloseCB;
        // 面板挂在 body 上，浮动工具栏收起时不会带走它，得由这个回调来收摊
        toolbar.subElementCloseCB = () => {
            this.closePanel();
        };
        const current = this.readCurrentPair();
        this.panelOptions = {
            anchor: toolbar.element,
            initialPair: current.pair,
            i18n: this.i18n as Record<string, string>,
            undoEnabled: hasUndoableChange(),
            // 选区里各区域的装饰不一致：面板要先说明再让用户点，
            // 否则第一下点击就会把没打算动的区域一并改写
            mixed: current.mixed,
            onChange: (pair: IDecorationPair) => this.applyPair(pair),
            // 清除装饰就是提交一组两个方向都关闭的配置
            onClear: () => this.applyPair(CLEARED_PAIR),
            onUndo: () => {
                void this.undoDecoration();
            },
            onClose: () => this.closePanel(),
        };
        this.panel = createPanel(this.panelOptions);
    }

    /**
     * 把一组配置落到选区上：按内存中的分组重裹装饰，改完重建选区，最后按块调度保存。
     *
     * 分组是打开面板时记下的，不会随面板里的点击而变：点击面板控件会让编辑器的选区塌掉，
     * 真正可靠的坐标只有这里记下的字符偏移。
     *
     * 一个分组动到几个块就记几条块记录，但它们合起来只占撤销栈里的一条：用户做的是一次操作，
     * 按一次撤销就该整体退回，而不是只退回最后一个块。
     */
    private applyPair(pair: IDecorationPair): void {
        const specs = composePair(sanitizePair(pair));
        const changed: IBlockChange[] = [];
        for (const group of this.groups) {
            const blockElement = group.blockElement;
            const beforeHTML = blockElement.outerHTML;
            applySpansIn(group.editableElement, group.start, group.end, specs);
            const afterHTML = blockElement.outerHTML;
            const blockId = blockElement.getAttribute(NODE_ID_ATTRIBUTE);
            // 改动前与改后完全相同（选区里本来就没有装饰，或清了个空）时既不记也不发请求；
            // 没有块 id 的区域同样无从保存 —— 记账键只能是块自己的 id，
            // 传个 null 进防抖保存器只会在保存失败时弹一条对不上的提示
            if (blockId === null || beforeHTML === afterHTML) {
                continue;
            }
            changed.push({blockId, beforeHTML, afterHTML});
            // 记账键必须是元素自己的块 id：传错会把多个块并成一次保存，只有最后一个落盘
            this.saver.save(blockId, blockElement);
        }
        // 一次操作只记一条记录：跨块的改动合起来撤一次
        recordChange(changed);
        // 重建选区，用户可以接着输入，面板的下一次改动也还有坐标可用
        restoreOffsets(this.offsets);
        this.appliedPair = sanitizePair(pair);
        this.syncPanel(this.appliedPair);
    }

    /** 撤销：先把改动前的块 HTML 写回文档，再按文档里的真实状态刷新面板 */
    private async undoDecoration(): Promise<void> {
        if (this.undoing) {
            return;
        }
        this.undoing = true;
        try {
            // 栈空或剩余记录全部过期时返回 false：界面与文档都没变，不该重画面板
            if (!await undoLastChange()) {
                return;
            }
            this.claimBlocks();
            const current = this.readCurrentPair();
            this.syncPanel(current.pair, current.mixed);
        } finally {
            this.undoing = false;
        }
    }

    /**
     * 撤销后的重新认领。
     *
     * 撤销是把整块 HTML 换回去，块连同子树一起换掉，之前拿在手里的引用随即脱管；
     * 不重新认领的话，下一次改动会去装饰一个已经不在文档里的节点：屏幕上什么也不出现，
     * 磁盘上多一次内容没变的 updateBlock，面板显示的选区也不存在，下一次撤销还会因
     * afterHTML 校验不过而被静默丢弃。可编辑区域本身是新块里的哪一个，由 dom.ts 按位置判定。
     */
    private claimBlocks(): void {
        for (let i = 0; i < this.groups.length; i++) {
            const group = this.groups[i];
            const blockId = group.blockElement.getAttribute(NODE_ID_ATTRIBUTE);
            const blockElement = blockId === null ? null : findBlockElement(blockId);
            // 块已经不在文档里（被删除，或用户已切走），这一组就此作废
            if (blockElement === null) {
                continue;
            }
            group.editableElement = reclaimEditableElement(group.editableElement, blockElement);
            group.blockElement = blockElement;
            this.offsets[i][0] = group.editableElement;
        }
    }

    /**
     * 打开面板时的初值，以及选区里的装饰是不是一致的。
     *
     * 每个分组各自读一遍选区内的装饰，不能只看第一个：跨块选区里只有第二块被装饰过时，
     * 拿着默认值开场会让用户第一下点击就把第二块的装饰改掉，而且看上去完全正常。
     *
     * 方向不靠 span 的嵌套位置判断，而是交给 readPairFromStyle 从各自的 text-decoration-line 读：
     * 嵌套时外层是上划线、内层是下划线，合并成一个 data-sue="b" 的 span 则同时供给两个方向。
     * 装饰只在选区范围内找：块里落在选区之外的装饰不描述当前这次选择。
     *
     * 各分组一致时就用那一份；不一致时取第一份有装饰的，并如实报出「混合」，
     * 由面板先把这件事说清楚 —— 一次改动会把整个选区统一，用户该在点之前就知道。
     * 全都没有装饰时回到上次用过的配置，没有记录就用默认值。
     */
    private readCurrentPair(): {pair: IDecorationPair; mixed: boolean;} {
        const pairs = this.groups.map((group) => {
            const styles = readDecorationStylesIn(group.editableElement, group.start, group.end);
            return readPairFromStyle(styles[0] ?? null, styles[1] ?? null);
        });
        const decorated = pairs.filter((pair) => pair.underline.enabled || pair.overline.enabled);
        if (decorated.length === 0) {
            return {pair: this.rememberedPair ?? DEFAULT_PAIR, mixed: false};
        }
        const first = decorated[0];
        const mixed = pairs.some((pair) => !isSamePair(pair, first));
        return {pair: first, mixed};
    }

    /**
     * 把文档里的真实状态刷回面板。
     *
     * 清除与撤销都直接改文档，面板自己看不到结果（setPair 也不会触发 onChange，否则会再来一轮改动）。
     * undoEnabled 就地改面板持有的实参对象，面板重画时重读它。
     */
    private syncPanel(pair: IDecorationPair, mixed = false): void {
        if (this.panelOptions === null) {
            return;
        }
        this.panelOptions.undoEnabled = hasUndoableChange();
        this.panel.setPair(pair, mixed);
    }

    /** 关闭面板；可重复调用，也可以发生在面板从未打开过的情况下 */
    private closePanel(): void {
        if (this.panel !== null) {
            // 面板开着就意味着有未到点的保存，离开前必须发出去
            this.saver?.flush();
            if (this.appliedPair !== null) {
                this.savePair(this.appliedPair);
            }
            this.panel.destroy();
            this.panel = null;
            this.panelOptions = null;
            this.groups = [];
            this.offsets = [];
            this.appliedPair = null;
            // 撤销栈只对当前这一次面板会话有意义（设计稿 §7.2）
            clearChanges();
        }
        if (this.toolbar !== null) {
            this.toolbar.subElementCloseCB = this.previousSubElementCloseCB;
            this.toolbar = null;
            this.previousSubElementCloseCB = null;
        }
    }

    /** 记住上次用过的配置；写盘失败只影响下次打开面板的初值，不值得打断用户 */
    private savePair(pair: IDecorationPair): void {
        this.rememberedPair = pair;
        this.saveData(SETTINGS_FILE, pair).catch((error: unknown) => {
            console.log(`[${this.name}] save data [${SETTINGS_FILE}] fail: `, error);
        });
    }
}
