/**
 * 装饰 span 的 DOM 应用层：把选区换算成「可编辑区域 + 字符偏移」，负责剥掉旧装饰、按描述包裹新 span、
 * 清理解包残留，并给出面板与编辑器交互要用的事件名。
 *
 * 全程只以 `editableElement.textContent` 的字符偏移为坐标系，不搬运活的 Range：
 * 剥离装饰只改变嵌套关系、不改变 textContent，所以「先算偏移 → 再剥 → 再包」这条顺序下偏移始终有效。
 * 这正是「只选中已有装饰的一部分再换样式」能正确工作的原因：包裹范围按文字位置重算，
 * 既不会把未选中的文字拖进新 span，也不会把已选的尾巴丢掉。
 */
import {getFrontend} from "siyuan";
import type {ISpanSpec} from "./model";

/** 一个可编辑区域内的待包裹区间；start / end 是相对 editableElement.textContent 的字符偏移 */
export interface IEditableGroup {
    editableElement: HTMLElement;
    blockElement: HTMLElement;
    start: number;
    end: number;
}

/** 区域内的一段字符偏移 [start, end)；给出它就表示「只碰这一段」 */
export interface IOffsetRange {
    start: number;
    end: number;
}

/** 装饰 span 的标记属性；值为下划线 u、上划线 o、两者合并 b */
const MARK_ATTRIBUTE = "data-sue";

/** 一组装饰方向最多对应两个 span（外层上划线、内层下划线），读取时按这个上限截断 */
const MAX_PAIR_SPANS = 2;

/** 思源的零宽空格占位符 */
const ZWSP = "\u200b";

/** 块级可编辑区域的判定依据：思源每个块都带 data-node-id */
const BLOCK_SELECTOR = "[data-node-id]";

/** 单元格优先级最高：思源允许直接编辑表格单元格里的内容 */
const CELL_SELECTOR = "td, th";

/**
 * 行内元素白名单：端点外扩只认这些标签。
 *
 * 集合之外的是块级容器。端点爬过块级元素就会让装饰 span 把整段块内容包进去，
 * 而 span 的内容模型只允许行内内容，写进文档 HTML 就是非法标记，重新解析时照样留着。
 * 这里不用 getComputedStyle(display) 判定：默认样式表里的 `display: inline` 是初值而非声明，
 * 读出来是空串，拿它判断会把所有行内元素都当成块级。
 */
const PHRASING_TAGS = new Set((
    "A ABBR B BDI BDO BR CITE CODE DATA DEL DFN EM FONT I IMG INS KBD LABEL MARK Q RP RT RUBY " +
    "S SAMP SMALL SPAN STRONG SUB SUP TIME TT U VAR WBR"
).split(" "));

/**
 * 标题区：callout 与 tab-item 的标题是块的直接子元素，块内容里的同名 class 不参与判定。
 * 标题的可编辑区域与正文不是一处，行高也不同，必须单独包裹才不会撑坏布局。
 */
const TITLE_SELECTOR = ":scope > .callout-info > .callout-title, :scope > .fn__flex-item > .fn__flex-item__label";

/** 块内若还有别的可编辑区域（子块或兄弟标题区），这个块多半只是个容器；容器块另有下文那条收紧规则 */
const NESTED_REGION_SELECTOR = `${BLOCK_SELECTOR}, ${TITLE_SELECTOR}`;

/**
 * 「这一层内部有没有别处可编辑的东西」，不锚在块上。
 *
 * 收紧区域问的是内部有没有嵌套区域，与候选处在块的哪一层无关，因此不能用上面那条锚在块上的
 * TITLE_SELECTOR：从标签页项（.fn__flex-item）内部去看，`:scope > .fn__flex-item > ...` 匹配不上，
 * 于是标签与标签之间的空白会被误判成可包裹的区域，凭空造出一个只含空白的区域。
 * 宁可多拒一点。这里的两个类名必须与 TITLE_SELECTOR 保持一致，改一处要改两处。
 */
const NESTED_REGION_INSIDE_SELECTOR = `${BLOCK_SELECTOR}, .callout-title, .fn__flex-item__label`;

/**
 * 不可编辑区域：这些区域内的文本不参与分组。
 * 思源会重渲染代码高亮与公式，往里插 span 会被下一次渲染抹掉，公式里的 span 还会让公式变形。
 */
const NON_EDITABLE_SELECTOR = [
    '[data-type="NodeCodeBlock"]',
    '[data-type="NodeMathBlock"]',
    '[data-type="NodeInlineMath"]',
    ".math",
    ".katex",
    ".av",
    ".hljs",
].join(", ");

/** 分组收集阶段的中途状态：先记下相交的文本节点，最后再统一换算成区域内的绝对偏移 */
interface IEditableDraft {
    editableElement: HTMLElement;
    blockElement: HTMLElement;
    pieces: Array<{node: Text; from: number; to: number;}>;
}

/** 元素内的全部文本节点，文档顺序 */
const textNodesOf = (element: Element): Text[] => {
    const nodes: Text[] = [];
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        nodes.push(node as Text);
    }
    return nodes;
};

/** 文本节点所在的元素；节点本身就是元素时返回自己 */
const elementOf = (
    node: Node,
): Element => (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);

/** 是否落在代码块、属性视图、公式或代码高亮里 */
const isNonEditable = (node: Node): boolean => {
    const element = elementOf(node);
    return element !== null && element.closest(NON_EDITABLE_SELECTOR) !== null;
};

/**
 * 块内更紧的可编辑区域：从文本所在元素往上、到块为止，第一层「块级且内部没有别的可编辑区域」的祖先。
 *
 * 为什么需要它：容器块的判定只看「块里有没有子块」，而列表项把这两种身份叠在同一个元素上 ——
 * 它自己是一块（文字要能装饰、也要能落盘），又能带子列表。此时整块当区域会把子列表一起圈进来，
 * 整块跳过又会让本项自己的文字静默不生效。真正承载这段文字的那一层（列表项里的段落）才是区域：
 * 它内部没有别的可编辑区域，包裹与剥 span 都碰不到子列表。
 *
 * 行内元素一律跳过：区域边界必须是块级。否则同一段文字会随行内标记被切成几个区域
 * （「纯文字 + <strong> + 纯文字」变成两个区域），偏移与包裹范围也就跟着碎了。
 *
 * 找不到就返回 null：文字是块自己的直接子节点（块间空白、或纯容器块）时，本块之下确实没有区域。
 */
const ownRegionBelow = (element: Element, block: Element): HTMLElement => {
    for (
        let candidate = element;
        candidate !== null && candidate !== block.parentElement;
        candidate = candidate.parentElement
    ) {
        if (PHRASING_TAGS.has(candidate.tagName)) {
            continue;
        }
        if (candidate.querySelector(NESTED_REGION_INSIDE_SELECTOR) === null) {
            return candidate as HTMLElement;
        }
    }
    return null;
};

/**
 * 判定文本节点所属的可编辑区域，优先级：表格单元格 → 标题区 → 所属块 → 块内更紧的一层。
 * 判定不出区域（编辑器容器这类结构节点）时返回 null，该文本不参与装饰。
 */
const resolveEditableElement = (node: Node): HTMLElement => {
    const element = elementOf(node);
    if (element === null) {
        return null;
    }
    const cell = element.closest(CELL_SELECTOR);
    // 单元格内多于一个块时 TD 只是容器，退回按块处理：把整格并成一个区域会让包裹范围跨过块边界，
    // 块因此被复制一份、原处留一个空壳块，data-node-id 撞车后保存重载就出问题
    if (cell !== null && cell.querySelectorAll(BLOCK_SELECTOR).length <= 1) {
        return cell as HTMLElement;
    }
    const block = element.closest(BLOCK_SELECTOR);
    if (block === null) {
        return null;
    }
    // 块里可能有多个标题区（多标签页），要挑真正包住当前文本的那个
    for (const title of Array.from(block.querySelectorAll(TITLE_SELECTOR))) {
        if (title.contains(element)) {
            return title as HTMLElement;
        }
    }
    // 块内还有别的可编辑区域：要么这块是纯容器（它的文字全在子块里，或是子块之间的空白，包住毫无意义），
    // 要么像带子列表的列表项那样自带文字 —— 后者改用块内更紧的那一层，当成纯容器跳过就等于静默漏装饰
    if (block.querySelector(NESTED_REGION_SELECTOR) !== null) {
        return ownRegionBelow(element, block);
    }
    return block as HTMLElement;
};

/** 与选区相交、且可编辑的文本节点及它在选区内的区间；文档顺序 */
const collectPieces = (range: Range): Array<{node: Text; from: number; to: number;}> => {
    const common = range.commonAncestorContainer;
    // 选区塌在单个文本节点里时，遍历起点要退到它的父元素，否则走不到那个节点自身
    const root = common.nodeType === Node.TEXT_NODE ? common.parentNode : common;
    const pieces: Array<{node: Text; from: number; to: number;}> = [];
    if (root === null) {
        return pieces;
    }
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let found = walker.nextNode(); found !== null; found = walker.nextNode()) {
        const node = found as Text;
        if (isNonEditable(node) || !range.intersectsNode(node)) {
            continue;
        }
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.data.length;
        // 与选区只是首尾相接、或自身就是空文本节点的都不算相交内容
        if (to > from) {
            pieces.push({node, from, to});
        }
    }
    return pieces;
};

/** 每个文本节点在区域内 textContent 里的起始偏移 */
const offsetIndexOf = (editableElement: HTMLElement): Map<Node, number> => {
    const index = new Map<Node, number>();
    let cursor = 0;
    for (const text of textNodesOf(editableElement)) {
        index.set(text, cursor);
        cursor += text.data.length;
    }
    return index;
};

/**
 * 收集选区覆盖到的可编辑区域。
 *
 * 分组是必需的：跨段落或跨单元格应用时，每个区域必须独立做 DOM 包裹，包裹一个区域不得影响另一个。
 * 不可编辑区域内的文本不产生分组；分组按首个相交文本节点的出现顺序，也就是文档顺序。
 */
export const collectEditableGroups = (range: Range): IEditableGroup[] => {
    const drafts: IEditableDraft[] = [];
    const seen = new Map<HTMLElement, IEditableDraft>();
    for (const piece of collectPieces(range)) {
        const editableElement = resolveEditableElement(piece.node);
        if (editableElement === null) {
            continue;
        }
        let draft = seen.get(editableElement);
        if (draft === undefined) {
            const block = editableElement.closest(BLOCK_SELECTOR) ?? editableElement;
            draft = {editableElement, blockElement: block as HTMLElement, pieces: []};
            seen.set(editableElement, draft);
            drafts.push(draft);
        }
        draft.pieces.push(piece);
    }
    const groups: IEditableGroup[] = [];
    for (const draft of drafts) {
        const index = offsetIndexOf(draft.editableElement);
        let start = Number.POSITIVE_INFINITY;
        let end = Number.NEGATIVE_INFINITY;
        for (const piece of draft.pieces) {
            const base = index.get(piece.node) ?? 0;
            start = Math.min(start, base + piece.from);
            end = Math.max(end, base + piece.to);
        }
        if (end > start) {
            groups.push({editableElement: draft.editableElement, blockElement: draft.blockElement, start, end});
        }
    }
    return groups;
};

/** 解包元素：把子节点搬到父节点上，再删掉空壳 */
const unwrap = (node: Node): void => {
    const parent = node.parentNode;
    if (parent === null) {
        return;
    }
    while (node.firstChild !== null) {
        parent.insertBefore(node.firstChild, node);
    }
    parent.removeChild(node);
};

/**
 * 区域内某个元素所占的字符区间 [start, end)；元素内没有文本节点时返回 null。
 *
 * 与 offsetIndexOf 出自同一张表，所以这里的偏移和 applySpansIn 用的偏移是同一个坐标系。
 */
const offsetsOfElement = (index: Map<Node, number>, element: Element): IOffsetRange => {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const text of textNodesOf(element)) {
        const base = index.get(text);
        if (base === undefined) {
            continue;
        }
        start = Math.min(start, base);
        end = Math.max(end, base + text.data.length);
    }
    return end > start ? {start, end} : null;
};

/**
 * 区域内的装饰 span，文档顺序。
 *
 * 给出范围时只保留与它真正重叠的那些，判定按字符偏移做：spanStart < end && spanEnd > start。
 * 不用 Range.intersectsNode：那条谓词是不对称的 —— 范围终点与 span 起点相接不算相交（安全），
 * 但范围起点与 span 终点相接**算**相交。于是「从一个装饰词之后开始选中」（点击词尾再 Shift+End，
 * collectEditableGroups 丢掉零宽片段后起点落在后一个文本节点的偏移上）会把那块装饰当成在选区内：
 * stripDecorationIn 把它解包，applySpansIn 不会再包回去，装饰就此从文档里消失并随这次保存落盘。
 *
 * 读样式（readDecorationStylesIn）走同一个判定，两者才能对同一段文字给出同一个答案。
 * range 为 null 表示「整块都算」。
 */
const decorationSpansIn = (editableElement: HTMLElement, range: IOffsetRange | null): HTMLElement[] => {
    const spans = Array.from(editableElement.querySelectorAll(`[${MARK_ATTRIBUTE}]`)) as HTMLElement[];
    if (range === null) {
        return spans;
    }
    const index = offsetIndexOf(editableElement);
    return spans.filter((span) => {
        const offsets = offsetsOfElement(index, span);
        // 一个字符都不占的空壳 span 没有可重叠的区间，剥它只会顺手丢掉解包残留之外的别的东西
        return offsets !== null && offsets.start < range.end && offsets.end > range.start;
    });
};

/**
 * 剥掉区域内的装饰 span，只改嵌套关系，不动一个字。
 *
 * 给出范围时只剥与 [start, end) 真正重叠的 span：同一个块里的装饰可能整块落在选区之外，
 * 那是用户此前已经保存下来的另一处改动，按区域整块剥掉会把它从编辑器里删掉、并随
 * 这次保存一起落盘（审阅里复现的就是「先给一个词加线，再给同段另一个词加线」，
 * 前一次装饰无声消失）。范围用区域内字符偏移表达，与 applySpansIn 同一坐标系。
 *
 * 范围塌成一点或起止颠倒时直接返回：零宽范围不覆盖任何字符，一个装饰都不该动 ——
 * 它与「没给范围」（整块清理）是两回事，混同就会把整块的装饰无声剥掉。
 *
 * 不给范围即整块清理。生产代码里没有任何地方需要它：面板的作用域始终是打开时记下的
 * 那个选区范围，「清除装饰」也是 applySpansIn(specs = [])，因此同样只清选区内的装饰。
 * 保留这个无范围形态是为了让「清掉整个区域」这件事仍然显式可写，而不是被顺手带出来。
 */
export const stripDecorationIn = (editableElement: HTMLElement, offsets?: IOffsetRange): void => {
    // 零宽或颠倒的范围什么都不覆盖，与「没给范围」（整块清理）是两回事，不能混同
    if (offsets !== undefined && offsets.end <= offsets.start) {
        return;
    }
    // 从最内层开始拆：内层搬走的子节点正是外层要接着搬的
    const spans = decorationSpansIn(editableElement, offsets ?? null);
    for (let i = spans.length - 1; i >= 0; i--) {
        unwrap(spans[i]);
    }
};

/**
 * 字符偏移 → 文本节点内的位置。
 * 偏移恰好落在两个文本节点的交界时归前一个节点的末尾：端点因此压在行内元素的起点上，
 * 该行内元素要么整个在范围内、要么整个在范围外，不会被复制成一个空壳留在原地。
 */
const locate = (editableElement: HTMLElement, offset: number): {node: Text; offset: number;} => {
    let remaining = Math.max(0, offset);
    let last: Text = null;
    for (const text of textNodesOf(editableElement)) {
        if (remaining <= text.data.length) {
            return {node: text, offset: remaining};
        }
        remaining -= text.data.length;
        last = text;
    }
    // 偏移越过末尾时兜到最后一个文本节点的末尾，绝不把范围算到区域之外
    return last === null ? null : {node: last, offset: last.data.length};
};

/**
 * 把恰好压在行内元素边界上的范围端点外扩到该元素的边界。
 *
 * 不扩的话，「选中 <strong> 里的文字」这种范围会被判成只部分覆盖 <strong>，
 * 包裹时就会把整个 <strong> 复制进新 span、原地留一个空的 <strong>；外扩后它被整体搬走。
 * 外扩只认行内元素：爬过块级元素会把块内容包进 span，那是 span 放不下的非法标记。
 * 范围不会扩出可编辑区域。
 *
 * 两端认法不同，源头是 locate 的交界规则：偏移落在两个文本节点的交界上时归前一个节点的末尾，
 * 因此端点正好压在交界上时，起止两端都会落在一个文本节点的末尾，都需要「在这个节点之后」的外扩。
 * 旧实现只给终点认了这一侧，起点只能从节点开头外扩（按 locate 的规则那只在偏移为 0 时发生），
 * 于是「从一个装饰词之后开始选中」的起点留在那块装饰最后一个文本节点的内部：
 * extractContents 把它复制成一个空壳 span，并把整块装饰连同新装饰一起吞进去 ——
 * 判相交时按字符偏移判对了，包裹时却又把它算进了范围内。
 */
const expandBoundary = (
    editableElement: HTMLElement,
    node: Node,
    offset: number,
    isEnd: boolean,
): {node: Node; offset: number;} => {
    let current = node;
    let position = offset;
    for (;;) {
        const parent = current.parentNode;
        if (current === editableElement || parent === null || parent.nodeType !== Node.ELEMENT_NODE) {
            break;
        }
        if (parent !== editableElement && !PHRASING_TAGS.has((parent as Element).tagName)) {
            break;
        }
        const isText = current.nodeType === Node.TEXT_NODE;
        const length = isText ? (current as Text).length : current.childNodes.length;
        const before = position === 0;
        // 两端都成立（空节点）时按「在它之前」处理，与既有行为一致
        const after = !before && position === length;
        if (!(isEnd ? after : before || after)) {
            break;
        }
        position = Array.from(parent.childNodes).indexOf(current as ChildNode) + (after ? 1 : 0);
        current = parent;
    }
    return {node: current, offset: position};
};

/** 按字符偏移解析范围的起点；区域内没有文本节点时返回 null */
const resolveStart = (editableElement: HTMLElement, offset: number): {node: Node; offset: number;} => {
    const at = locate(editableElement, offset);
    return at === null ? null : expandBoundary(editableElement, at.node, at.offset, false);
};

/** 按字符偏移解析范围的终点；区域内没有文本节点时返回 null */
const resolveEnd = (editableElement: HTMLElement, offset: number): {node: Node; offset: number;} => {
    const at = locate(editableElement, offset);
    return at === null ? null : expandBoundary(editableElement, at.node, at.offset, true);
};

/** 按字符偏移在区域内造 Range；区域内没有文本节点时返回 null */
const createRangeIn = (editableElement: HTMLElement, start: number, end: number): Range => {
    const from = resolveStart(editableElement, start);
    const to = resolveEnd(editableElement, end);
    if (from === null || to === null) {
        return null;
    }
    const range = editableElement.ownerDocument.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
};

/** 用一个 spec 圈住 range，并把范围收敛到新 span 上，供上一层包裹套住它 */
const wrapRange = (range: Range, spec: ISpanSpec): Range => {
    const span = range.startContainer.ownerDocument.createElement("span");
    span.setAttribute(MARK_ATTRIBUTE, spec.marker);
    span.setAttribute("style", spec.css);
    span.appendChild(range.extractContents());
    range.insertNode(span);
    range.selectNode(span);
    return range;
};

/**
 * 清理解包残留。
 *
 * normalize 合并被拆散的文本节点并删掉空文本节点；空文本节点会让思源按偏移算光标时偏位，
 * 用户在装饰内继续打字就会跳到错误位置。
 */
const cleanupIn = (editableElement: HTMLElement): void => {
    editableElement.normalize();
    const placeholders: Text[] = [];
    let hasVisibleText = false;
    for (const text of textNodesOf(editableElement)) {
        if (text.data === ZWSP) {
            placeholders.push(text);
        } else if (text.data !== "") {
            hasVisibleText = true;
        }
    }
    // 整块只剩占位符时留着它：抹掉之后思源就无法在该块内放置光标
    if (!hasVisibleText) {
        return;
    }
    for (const text of placeholders) {
        const parent = text.parentNode;
        if (parent !== null) {
            parent.removeChild(text);
        }
    }
};

/**
 * 在区域内按字符偏移包裹装饰 span。
 *
 * 顺序是「先剥后包」：剥 span 不改变 textContent，所以此时这些偏移仍指向同一批文字。
 * 只剥与 [start, end) 真正重叠的旧装饰，落在范围之外的保持原样 —— 同一个块里的另一处装饰是用户
 * 此前已经保存好的改动，不该被这次设置顺带抹掉。
 * specs 与 composePair 一致、外层在前，因此从末尾向前包裹，落到 DOM 上的是外层 span 包着内层 span。
 * 空 specs 的语义是清除装饰（同样只清选区内的那部分）；空区间或区域内没有文本节点时什么也不包。
 */
export const applySpansIn = (editableElement: HTMLElement, start: number, end: number, specs: ISpanSpec[]): void => {
    stripDecorationIn(editableElement, {start, end});
    let range = end > start ? createRangeIn(editableElement, start, end) : null;
    if (range !== null) {
        for (let i = specs.length - 1; i >= 0; i--) {
            range = wrapRange(range, specs[i]);
        }
    }
    cleanupIn(editableElement);
};

/**
 * 区域内第一个文本节点所在元素的计算颜色；没有文本节点或读不到计算样式时返回空字符串。
 * getComputedStyle 从元素所在文档的 defaultView 上取：本模块不持有 window 引用，跟着文档走才不会落空。
 */
export const readFirstTextColor = (root: HTMLElement): string => {
    if (!root) {
        return "";
    }
    const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parent = (walker?.nextNode() as Text | null)?.parentElement;
    const view = parent?.ownerDocument?.defaultView;
    if (!parent || !view?.getComputedStyle) {
        return "";
    }
    return view.getComputedStyle(parent).color ?? "";
};

/** 记下选区在各个可编辑区域里的字符偏移；DOM 改动后原 Range 会失效，靠它重建 */
export const captureOffsets = (range: Range): Array<[HTMLElement, number, number]> => {
    return collectEditableGroups(range).map((group) => {
        const captured: [HTMLElement, number, number] = [group.editableElement, group.start, group.end];
        return captured;
    });
};

/**
 * 按记下的偏移重建选区，并聚焦到最后一个可编辑区域，让用户可以接着输入。
 *
 * 偏移按文档顺序使用：第一项当起点、最后一项当终点；先聚焦再设选区，
 * 因为聚焦会把光标放到元素里既有的位置，顺序反了选区就被冲掉。
 */
export const restoreOffsets = (captured: Array<[HTMLElement, number, number]>): void => {
    if (!captured || captured.length === 0) {
        return;
    }
    const first = captured[0];
    const last = captured[captured.length - 1];
    const from = resolveStart(first[0], first[1]);
    const to = resolveEnd(last[0], last[2]);
    const doc = first[0].ownerDocument;
    const selection = doc.defaultView?.getSelection();
    if (from === null || to === null || !selection) {
        return;
    }
    const range = doc.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    last[0].focus();
    selection.removeAllRanges();
    selection.addRange(range);
};

/**
 * 读出与 [start, end) 这段字符真正重叠的装饰 span 的 style，按文档顺序、最多两个。
 *
 * 范围用区域内的字符偏移表达，与 applySpansIn 同一坐标系：只看「区域内有没有装饰」是不够的，
 * 一个块里装饰可能整个落在选区之外，那种情况下打开面板不该把它当成当前选区的样式。
 * 重叠判定与剥（stripDecorationIn）走同一个 decorationSpansIn，两条路径不可能对同一段文字
 * 给出相反的答案。
 * 两个上限对应一对方向（外层上划线、内层下划线，或合并后的单个 span）。
 */
export const readDecorationStylesIn = (
    editableElement: HTMLElement,
    start: number,
    end: number,
): string[] => {
    const range: IOffsetRange = end > start ? {start, end} : null;
    const styles: string[] = [];
    for (const span of decorationSpansIn(editableElement, range)) {
        styles.push(span.getAttribute("style"));
        if (styles.length === MAX_PAIR_SPANS) {
            break;
        }
    }
    return styles;
};

/**
 * 块 HTML 被整体换过之后，在新块里按同样的位置找回可编辑区域。
 *
 * 换掉的只是本插件写下的装饰 span（撤销的前后两版 HTML 就差这些 span），块的结构没有变，
 * 因此「同一个单元格 / 同一个标题区 / 同一个块内层级」都可以按位置精确对上，而不是靠猜或者干脆退回块自身：
 * 退回块自身在表格里是危险的，偏移是相对单元格算的，套到整张表上会裹出一段跨单元格的装饰；
 * 块内还有子列表时同样危险，剥旧装饰会把子列表里的装饰一起剥掉。
 *
 * 区域还连着文档时原样返回；新块里找不到对应位置时也退回块自身，
 * 那意味着区域内没有更细的层级，块自身就是可编辑区域（普通段落即是）。
 */
export const reclaimEditableElement = (editableElement: HTMLElement, blockElement: HTMLElement): HTMLElement => {
    if (editableElement === blockElement) {
        return blockElement;
    }
    if (editableElement?.isConnected === true) {
        return editableElement;
    }
    // 旧区域已经脱管，但它自己还带着旧的祖先链，从那里算出位置即可
    const oldBlock = editableElement.closest(BLOCK_SELECTOR);
    if (oldBlock === null) {
        return blockElement;
    }
    // 单元格：按「第几行第几格」在新块里找回同一个格子
    const cell = editableElement.closest(CELL_SELECTOR);
    if (cell !== null) {
        // TD 的父元素就是 TR；querySelectorAll("tr") 的返回类型更窄，这里补一次断言而不是改判定
        const row = cell.parentElement as HTMLTableRowElement;
        const rowIndex = Array.from(oldBlock.querySelectorAll("tr")).indexOf(row);
        const cellIndex = Array.from(row?.children ?? []).indexOf(cell);
        const rows = Array.from(blockElement.querySelectorAll("tr"));
        const found = rows[rowIndex]?.children[cellIndex] as HTMLElement;
        return found ?? blockElement;
    }
    // 标题区：按出现次序找回同一个标题
    const titleIndex = Array.from(oldBlock.querySelectorAll(TITLE_SELECTOR)).indexOf(editableElement);
    if (titleIndex !== -1) {
        const titles = Array.from(blockElement.querySelectorAll(TITLE_SELECTOR));
        return (titles[titleIndex] as HTMLElement) ?? blockElement;
    }
    // 块内更紧的一层（列表项里承载本项文字的那个段落）：按同一条「元素序号」路径在新块里找回同一层。
    // 不能退回块自身：这种块里还有子列表，拿块当区域的话，下一次改动会在剥旧装饰时把子列表里的装饰一并剥掉。
    if (editableElement !== oldBlock) {
        const path: number[] = [];
        let current: Element = editableElement;
        while (current !== oldBlock) {
            const parent = current.parentElement;
            if (parent === null) {
                return blockElement;
            }
            path.unshift(Array.from(parent.children).indexOf(current));
            current = parent;
        }
        let found: Element | null = blockElement;
        for (const index of path) {
            found = found === null ? null : found.children[index] ?? null;
        }
        // 结构对不上（例如思源期间重排过块）就宁可退回块自身，也不把装饰裹到别处去
        if (found !== null && found !== blockElement && found.querySelector(NESTED_REGION_INSIDE_SELECTOR) === null) {
            return found as HTMLElement;
        }
    }
    return blockElement;
};

/**
 * 返回当前前端应使用的事件名：移动端用 touchend，其余用 click。
 *
 * 思源内部的 getEventName 没有导出到 petal 的公开类型，不能从 "siyuan" 包 import，
 * 只能在这里按 getFrontend() 自己实现；凡是「点一下就响应」的控件绑定都要走这个函数。
 *
 * 例外是表单控件自身的 change / input：它们两端行为一致，而且**不能**改成 touchend ——
 * 移动端承载复选框勾选的是 touchend 之后浏览器补发的那个 click，
 * 在 touchend 里读 input.checked 读到的还是切换前的值；input[type=color] 在移动端更是压根不产生 click。
 */
export const getEventName = (): string => (getFrontend() === "mobile" ? "touchend" : "click");
