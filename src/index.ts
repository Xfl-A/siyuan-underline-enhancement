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
    offsetsWithinContent,
    readDecorationStylesIn,
    readFirstTextColor,
    reclaimEditableElement,
    restoreOffsets,
} from "./dom";
import type {IEditableGroup} from "./dom";
import {UNDERLINE_ICON_SVG} from "./icons";
import {
    DEFAULT_DECORATION,
    composeDecoration,
    isSameDecoration,
    readDecorationFromStyle,
    sanitizeDecoration,
} from "./model";
import type {IDecoration} from "./model";
import {createPanel} from "./panel";
import type {
    IPanelController,
    IPanelOptions,
} from "./panel";
import {
    clearChanges,
    createDebouncedSaver,
    findBlockElement,
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
 * 下划线关闭的一份配置。
 * 既是「清除装饰」的入参，也是「选区里没有装饰」的判据：
 * readDecorationFromStyle 对着没有装饰的区域会给出关闭的结果。
 */
const CLEARED_DECORATION: IDecoration = {...DEFAULT_DECORATION, enabled: false};

export default class UnderlineEnhancement extends Plugin {
    /** 当前面板；null 表示没有打开的面板 */
    private panel: IPanelController = null;
    /** 传给面板的实参对象；撤销栈只有本类掌握，面板不据此禁用撤销 */
    private panelOptions: IPanelOptions = null;
    /** 打开面板时的选区分组；面板开着期间的每次改动都落到它上面 */
    private groups: IEditableGroup[] = [];
    /** 打开面板时记下的字符偏移；包裹装饰会让原 Range 失效，只能靠它重建选区 */
    private offsets: Array<[HTMLElement, number, number]> = [];
    /** 刚应用到文档上的那一份配置，关闭面板时据此记住上次的用法 */
    private appliedDecoration: IDecoration = null;
    /** 防抖保存器：所有块共用一个窗口 */
    private saver: IDebouncedSaver = null;
    /** 打开面板时挂着的浮动工具栏，关闭时要把 subElementCloseCB 还回去 */
    private toolbar: Toolbar = null;
    /** 思源原有的关闭回调；插件的回调不能留在思源的对象上 */
    private previousSubElementCloseCB: () => void = null;
    /** 记住的上次配置，选区里没有装饰时作为面板初值 */
    private rememberedDecoration: IDecoration = null;
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
            this.rememberedDecoration = sanitizeDecoration(await this.loadData(SETTINGS_FILE));
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
     *
     * 面板与浮动工具栏是各自独立的：这里接管的 subElementCloseCB 只负责「工具栏收起 → 收面板」，
     * 面板自己收起时走的是另一条出口（closePanel），那条路只把回调还回去，不动工具栏。
     * 因此点面板里的控件不会把浮动工具栏带走。
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
        this.appliedDecoration = null;
        this.undoing = false;
        this.toolbar = toolbar;
        this.previousSubElementCloseCB = toolbar.subElementCloseCB;
        // 面板挂在 body 上，浮动工具栏收起时不会带走它，得由这个回调来收摊
        toolbar.subElementCloseCB = () => {
            this.closePanel();
        };
        const current = this.readCurrentDecoration();
        // 「跟随文字色」色块上的字母要显出装饰真正会取到的那个颜色，值只能从选中的文字上读；
        // 跨多个区域时取第一组：这一项的效果本来就只能给出一个颜色
        const followTextColor = readFirstTextColor(this.groups[0].editableElement);
        this.panelOptions = {
            anchor: toolbar.element,
            initialDecoration: current.decoration,
            i18n: this.i18n as Record<string, string>,
            followTextColor,
            // 选区里各区域的装饰不一致：面板要先说明再让用户点，
            // 否则第一下点击就会把没打算动的区域一并改写
            mixed: current.mixed,
            onChange: (decoration: IDecoration) => this.applyDecoration(decoration),
            // 清除装饰就是提交一份下划线关闭的配置
            onClear: () => this.applyDecoration(CLEARED_DECORATION),
            onUndo: () => {
                void this.undoDecoration();
            },
            // 面板只收自己：浮动工具栏与选区都留给用户继续用
            onClose: () => this.closePanel(),
            // 原生取色器那条路径反过来：选区与浮动工具栏一起收掉
            onCustomColorPicked: () => this.discardSelectionAndToolbar(),
        };
        this.panel = createPanel(this.panelOptions);
    }

    /**
     * 把一份配置落到选区上：按内存中的分组重裹装饰，改完重建选区，最后按块调度保存。
     *
     * 分组是打开面板时记下的：面板上的控件都不可聚焦，编辑器不失焦，
     * 但重裹装饰之后原 Range 依然失效，可靠的坐标只有这里记下的字符偏移。
     *
     * 一个分组动到几个块就记几条块记录，但它们合起来只占撤销栈里的一条：用户做的是一次操作，
     * 按一次撤销就该整体退回，而不是只退回最后一个块。
     */
    private applyDecoration(decoration: IDecoration): void {
        // 思源随时会重渲染块，面板开着期间记下的引用随时可能脱管：每次应用都先重新认领，
        // 读块 HTML、包裹装饰与重建选区才都落在文档里那个节点上
        if (!this.claimBlocks() || !this.offsetsWithinContent()) {
            // 记下的那对偏移已经不再指向文档里的内容：这一次什么都不做，也不落盘，
            // 宁可请用户重选一次，也不能按着一组过期坐标改他的文档
            showMessage(this.i18n.selectionChanged as string);
            return;
        }
        // 下划线关闭时没有装饰要裹：那个 null 的语义是「只剥掉选区里的旧装饰」
        const css = composeDecoration(sanitizeDecoration(decoration));
        const changed: IBlockChange[] = [];
        for (const group of this.groups) {
            const blockElement = group.blockElement;
            const beforeHTML = blockElement.outerHTML;
            applySpansIn(group.editableElement, group.start, group.end, css);
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
        this.appliedDecoration = sanitizeDecoration(decoration);
        this.syncPanel(this.appliedDecoration);
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
            // 撤销已经把改动写回内核，面板接下来只做回读：认不回来也没有东西要再写一次
            this.claimBlocks();
            const current = this.readCurrentDecoration();
            this.syncPanel(current.decoration, current.mixed);
        } finally {
            this.undoing = false;
        }
    }

    /**
     * 块节点被换掉之后的重新认领。
     *
     * 撤销把整块 HTML 写回去、思源自己重渲染块，两条路都会让块连同子树一起换掉，
     * 之前拿在手里的引用随即脱管；不重新认领的话，下一次改动会去装饰一个已经不在文档里的节点：
     * 屏幕上什么也不出现，磁盘上多一次内容没变的 updateBlock，面板显示的选区也不存在，
     * 下一次撤销还会因 afterHTML 校验不过而被静默丢弃。可编辑区域本身是新块里的哪一个，
     * 由 dom.ts 按位置判定。
     *
     * 提前返回的判据只是「块还连着文档」：面板的实时预览会以毫秒级连续触发，
     * 每一次都全文扫描 data-node-id 在长文档上是白付的代价。坐标是否还对得上由调用方另问一遍。
     *
     * @returns 是否每一组都还认得到活着的块；块已被删除或用户已切走文档时为 false
     */
    private claimBlocks(): boolean {
        for (let i = 0; i < this.groups.length; i++) {
            const group = this.groups[i];
            // 还连在文档里就不用重新找
            if (group.blockElement.isConnected) {
                continue;
            }
            const blockId = group.blockElement.getAttribute(NODE_ID_ATTRIBUTE);
            const blockElement = blockId === null ? null : findBlockElement(blockId);
            if (blockElement === null) {
                // 没有块 id 的区域无从查找，但它仍连在文档上：照旧装饰，只是不落盘
                if (group.blockElement.isConnected) {
                    continue;
                }
                // 块已经不在文档里（被删除，或用户已切走），这一组就此作废：
                // 拿着脱管节点继续改并落盘，就是把一份已经不存在的副本写回内核
                return false;
            }
            group.editableElement = reclaimEditableElement(group.editableElement, blockElement);
            group.blockElement = blockElement;
            this.offsets[i][0] = group.editableElement;
        }
        return true;
    }

    /**
     * 每一组记下的字符偏移是否还落在区域当前的内容之内。
     *
     * 这是包裹装饰之前的最后一道闸，也是记下的坐标对不上时唯一不许继续往下走的那个门。
     * 面板开着期间块可能被重渲染、被改写或被删掉，此时打开时记下的 [start, end) 可能整体越界；
     * locate 对越界的端点一律夹到区域末尾，包裹出来的因此是另一段内容，它会被原样写进磁盘。
     *
     * 一次操作要覆盖全部区域，所以任一组对不上就整次放弃：半套改动既不是用户要的，
     * 也会让撤销栈里留下一条对不上的记录。
     */
    private offsetsWithinContent(): boolean {
        return this.groups.every((group) => offsetsWithinContent(group.editableElement, group));
    }

    /**
     * 打开面板时的初值，以及选区里的装饰是不是一致的。
     *
     * 每个分组各自读一遍选区内的装饰，不能只看第一个：跨块选区里只有第二块被装饰过时，
     * 拿着默认值开场会让用户第一下点击就把第二块的装饰改掉，而且看上去完全正常。
     *
     * 装饰只在选区范围内找：块里落在选区之外的装饰不描述当前这次选择。
     *
     * 各分组一致时就用那一份；不一致时取第一份有装饰的，并如实报出「混合」，
     * 由面板先把这件事说清楚 —— 一次改动会把整个选区统一，用户该在点之前就知道。
     * 全都没有装饰时回到上次用过的配置，没有记录就用默认值。
     */
    private readCurrentDecoration(): {decoration: IDecoration; mixed: boolean;} {
        const decorations = this.groups.map((group) => {
            const styles = readDecorationStylesIn(group.editableElement, group.start, group.end);
            return readDecorationFromStyle(styles[0] ?? null);
        });
        const decorated = decorations.filter((item) => item.enabled);
        if (decorated.length === 0) {
            return {decoration: this.rememberedDecoration ?? DEFAULT_DECORATION, mixed: false};
        }
        const first = decorated[0];
        const mixed = decorations.some((item) => !isSameDecoration(item, first));
        return {decoration: first, mixed};
    }

    /**
     * 把文档里的真实状态刷回面板。
     *
     * 清除与撤销都直接改文档，面板自己看不到结果（setDecoration 也不会触发 onChange，
     * 否则会再来一轮改动）。撤销栈是否存在只由调用方掌握，面板不据此禁用撤销：
     * 一个按了没反应的按钮比按了没效果更难懂，栈空时它仍然什么都不做。
     */
    private syncPanel(decoration: IDecoration, mixed = false): void {
        if (this.panelOptions === null) {
            return;
        }
        this.panel.setDecoration(decoration, mixed);
    }

    /**
     * 原生取色器那条路径：清掉选区，并收起浮动工具栏。
     *
     * 系统取色对话框强制拿走焦点，编辑器失焦后思源已经清掉了选区、浮动工具栏也已经在收起途中，
     * 再把选区恢复回来既多余又靠不住。这里主动做一次干净的收尾：选区清空，
     * 浮动工具栏则按它在思源里的收起方式来触发 —— 把一次按下派发到面板与工具栏之外的元素上，
     * 思源照例收起浮动工具栏，并顺带调用插件自己的关闭回调。
     */
    private discardSelectionAndToolbar(): void {
        const doc = this.groups[0]?.editableElement?.ownerDocument ?? document;
        doc.getSelection?.()?.removeAllRanges();
        const view = doc.defaultView ?? window;
        doc.body?.dispatchEvent(new view.MouseEvent("mousedown", {bubbles: true, cancelable: true}));
    }

    /**
     * 关闭面板；可重复调用，也可以发生在面板从未打开过的情况下。
     *
     * 这条路只收面板自己：浮动工具栏不归它管，把 subElementCloseCB 还回去就收工，
     * 用户可以接着用工具栏改下一次选择。工具栏那边收起时走的是 openPanel 里接管的回调。
     */
    private closePanel(): void {
        if (this.panel !== null) {
            // 面板开着就意味着有未到点的保存，离开前必须发出去
            this.saver?.flush();
            if (this.appliedDecoration !== null) {
                this.saveDecoration(this.appliedDecoration);
            }
            this.panel.destroy();
            this.panel = null;
            this.panelOptions = null;
            this.groups = [];
            this.offsets = [];
            this.appliedDecoration = null;
            // 撤销栈不在这里清：面板收在每一次控件激活之后，一次会话已经短到装不下任何一次改动，
            // 在这里清空等于撤销永远按不动。切换文档与卸载仍然照旧清空（见上），
            // 而撤销前的过期校验会保证记错的记录被丢掉而不是改坏文档。
        }
        if (this.toolbar !== null) {
            this.toolbar.subElementCloseCB = this.previousSubElementCloseCB;
            this.toolbar = null;
            this.previousSubElementCloseCB = null;
        }
    }

    /** 记住上次用过的配置；写盘失败只影响下次打开面板的初值，不值得打断用户 */
    private saveDecoration(decoration: IDecoration): void {
        this.rememberedDecoration = decoration;
        this.saveData(SETTINGS_FILE, decoration).catch((error: unknown) => {
            console.log(`[${this.name}] save data [${SETTINGS_FILE}] fail: `, error);
        });
    }
}
