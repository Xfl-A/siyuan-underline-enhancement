/**
 * 面板定位：给定量好的矩形，算出面板左上角的视口坐标。
 *
 * 本模块全部为纯函数，不触碰 DOM，也不 import 任何运行时依赖，便于直接单测。
 * 「往哪一侧摆」由 choosePlacement 单独决定，DOM 那一侧只负责量矩形与写坐标。
 */

/** 面板相对参照矩形的摆放方向；候选表的先后即优先级 */
export type TPlacementSide = "below" | "above" | "right" | "left";

/** 视口坐标系下的矩形；左边与上边加尺寸即可推出右边与下边 */
export interface IRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** 只需要宽高的场合 */
export interface ISize {
    width: number;
    height: number;
}

/** choosePlacement 的输入；矩形全部是视口坐标 */
export interface IPlacementInput {
    /** 视口尺寸 */
    viewport: ISize;
    /** 面板自身的尺寸 */
    panel: ISize;
    /** 摆放的基准矩形：优先取选区，没有可测的选区时退回浮动工具栏 */
    reference: IRect;
    /** 必须让开的矩形，即选区；为 null 表示没有需要避让的文字 */
    avoid: IRect | null;
    /** 面板与基准矩形之间的间距 */
    gap: number;
    /** 面板与视口边缘的最小间距 */
    margin: number;
}

/** choosePlacement 的结果 */
export interface IPlacement {
    /** 选中的那一侧；四侧都压到文字时取重叠最小的，同分按候选顺序 */
    side: TPlacementSide;
    /** 面板左上角的视口坐标，已夹进视口并取整 */
    left: number;
    top: number;
    /** 面板是否完整落在视口内；按这一侧的意图摆放来量，不受夹取影响 */
    fits: boolean;
    /** 面板与让开矩形的重叠面积（px²），0 表示没有压到文字 */
    overlap: number;
}

/**
 * 候选侧，顺序即优先级。
 *
 * 上下排在前面：横向居中压在参照矩形上方或下方，是浮层最常见的落点，
 * 右边与左边留给高选区 —— 选区比面板还高时，上下两侧都放不下，只能挪到旁边。
 */
const SIDES: readonly TPlacementSide[] = ["below", "above", "right", "left"];

const right = (rect: IRect): number => rect.left + rect.width;
const bottom = (rect: IRect): number => rect.top + rect.height;

/** 把值夹进区间；区间本身被挤扁（面板比视口还宽）时退到下界，不会翻到视口另一侧 */
const clampToRange = (value: number, lower: number, upper: number): number => {
    const high = Math.max(lower, upper);
    return Math.min(Math.max(value, lower), high);
};

/** 两个矩形真正压在一起的面积；只是边挨着边、或一个完全在另一个之外，都算 0 */
const overlapArea = (a: IRect, b: IRect): number => {
    const width = Math.min(right(a), right(b)) - Math.max(a.left, b.left);
    const height = Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top);
    return width > 0 && height > 0 ? width * height : 0;
};

/**
 * 某一侧的落点，尚未夹取。
 *
 * 上下两侧横向居中于参照矩形；左右两侧竖向居中于参照矩形，于是单行选区旁边得到的是齐平的那一面，
 * 而高过视口的选区居中值会被随后的夹取拉回视口内。
 */
const offsetOf = (side: TPlacementSide, reference: IRect, panel: ISize, gap: number): {left: number; top: number;} => {
    const centeredLeft = reference.left + reference.width / 2 - panel.width / 2;
    const centeredTop = reference.top + reference.height / 2 - panel.height / 2;
    switch (side) {
        case "above":
            return {left: centeredLeft, top: reference.top - panel.height - gap};
        case "right":
            return {left: right(reference) + gap, top: centeredTop};
        case "left":
            return {left: reference.left - panel.width - gap, top: centeredTop};
        default:
            return {left: centeredLeft, top: bottom(reference) + gap};
    }
};

/** 面板矩形是否完整落在视口内，四边都留出 margin */
const fitsInViewport = (rect: IRect, viewport: ISize, margin: number): boolean =>
    rect.left >= margin &&
    rect.top >= margin &&
    right(rect) <= viewport.width - margin &&
    bottom(rect) <= viewport.height - margin;

/**
 * 算出一个候选，先夹进视口再量重叠。
 *
 * fits 与 overlap 说的不是同一件事，区别是必要的：
 * fits 量的是「这一侧按意图摆放时放不放得下」，用的是夹之前的坐标 ——
 * 夹取能让任何一侧都变得放得下，那它就不再是这一侧的优势了；
 * overlap 量的是「夹之后落到屏幕上那块矩形压住了多少」，用的是夹之后的坐标，即用户真正会看到的遮挡。
 * 取整在这里做，面板写进 style 的就是这几个整数，测试与浏览器量到的是同一组数字。
 */
const candidateOf = (side: TPlacementSide, input: IPlacementInput, avoid: IRect | null): IPlacement => {
    const offset = offsetOf(side, input.reference, input.panel, input.gap);
    const intended = {...offset, width: input.panel.width, height: input.panel.height};
    const placed: IRect = {
        left: Math.round(
            clampToRange(offset.left, input.margin, input.viewport.width - input.panel.width - input.margin),
        ),
        top: Math.round(
            clampToRange(offset.top, input.margin, input.viewport.height - input.panel.height - input.margin),
        ),
        width: input.panel.width,
        height: input.panel.height,
    };
    return {
        side,
        left: placed.left,
        top: placed.top,
        fits: fitsInViewport(intended, input.viewport, input.margin),
        overlap: avoid === null ? 0 : overlapArea(placed, avoid),
    };
};

/**
 * 四个方向的落点各算一遍，按候选顺序给出。
 *
 * 单独导出是因为「挑哪一个」与「各自算成什么样」是两件事：
 * 兜底那一档（重叠最小）说的就是这张表里的某一行，把它暴露出来，判据才不必在调用方再写一遍。
 *
 * 宽或高为 0 的让开矩形按没有选区处理：那量的是光标而不是文字，
 * 拿它当让开区只会把面板无谓地推开。
 */
export const candidatesOf = (input: IPlacementInput): IPlacement[] => {
    const avoid = input.avoid !== null && input.avoid.width > 0 && input.avoid.height > 0 ? input.avoid : null;
    return SIDES.map((side) => candidateOf(side, input, avoid));
};

/**
 * 选出面板的落点。
 *
 * 用户的要求是「窗口不能遮挡文字」，因此让开选区优先于把面板完整摆进视口：
 *
 * 1. 一档：这一侧在视口里放得下、且与选区不相交。按候选顺序取第一个，位置因此是确定的。
 * 2. 二档：与选区不相交，但会越过视口边缘。面板有限高与纵向滚动，越出去的部分仍能滚动到达；
 *    压到文字则不行 —— 那一段正是用户正在改的。
 * 3. 三档：四个方向都压到选区（选区大到铺满窗口，或窗口本身小到放不下面板）时，
 *    取重叠面积最小的一个；同分保留候选顺序里的前一个，同样是确定的。
 *
 * 视口比面板还小的时候夹取区间被挤扁，坐标退到边距上，面板于是有多少露多少而不是整块跑到屏幕外。
 */
export const choosePlacement = (input: IPlacementInput): IPlacement => {
    const candidates = candidatesOf(input);
    const preferred = candidates.find((candidate) => candidate.fits && candidate.overlap === 0);
    if (preferred !== undefined) {
        return preferred;
    }
    const clear = candidates.find((candidate) => candidate.overlap === 0);
    if (clear !== undefined) {
        return clear;
    }
    return candidates.reduce((best, candidate) => (candidate.overlap < best.overlap ? candidate : best), candidates[0]);
};
