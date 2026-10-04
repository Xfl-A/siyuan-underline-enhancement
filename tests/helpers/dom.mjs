// jsdom 夹具：DOM 手术依赖真实的 Range / TreeWalker / normalize 语义，jsdom 才能提供这一套。
// 夹具只负责「摆场景」与「模拟用户选区」；断言逻辑一律留在测试文件里。
import {JSDOM} from "jsdom";
import {loadModule} from "./loadModule.mjs";

/**
 * 建一套独立的 jsdom 环境，并按需载入 src/dom.ts。
 *
 * @param {{frontend?: string}} [options] frontend 决定 getEventName 的返回值
 * @returns {{window: Window, document: Document, module: Record<string, unknown>, mount: (html: string) => () => void,
 *   select: Function, selectWithin: Function, textNodesOf: Function, decorationsIn: Function, declaredLines: Function,
 *   decorationSpans: Function, close: () => void}}
 */
export const createFixture = (options = {}) => {
    const frontend = options.frontend ?? "desktop";
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {pretendToBeVisual: true});
    const {window} = dom;
    const {document} = window;
    // dom.ts 从 "siyuan" 取 getFrontend，同时直接读取 Node / NodeFilter 两个 DOM 全局，三者都要给桩
    const module = loadModule("src/dom.ts", {
        dependencies: {siyuan: {getFrontend: () => frontend}},
        globals: {Node: window.Node, NodeFilter: window.NodeFilter},
    });

    /** 把 HTML 片段塞进 document.body，返回清理函数 */
    const mount = (html) => {
        document.body.innerHTML = html;
        return () => {
            document.body.innerHTML = "";
        };
    };

    /** 元素内的全部文本节点，文档顺序 */
    const textNodesOf = (root) => {
        const nodes = [];
        const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            nodes.push(node);
        }
        return nodes;
    };

    // 偏移换算在测试侧独立写一份：与 src 里的同名逻辑同源会让断言变成自证。
    // 但交界处的比较符必须与 src/dom.ts 的 locate 保持一致（同样归前一个节点的末尾），
    // 否则夹具摆出来的端点和实现理解的端点会悄悄错开。
    const locate = (element, offset) => {
        // 选区端点可以直接落在某个文本节点上，此时不必再往下找
        if (element.nodeType === window.Node.TEXT_NODE) {
            return {node: element, offset};
        }
        let remaining = offset;
        let last = null;
        for (const text of textNodesOf(element)) {
            if (remaining <= text.data.length) {
                return {node: text, offset: remaining};
            }
            remaining -= text.data.length;
            last = text;
        }
        return last === null ? null : {node: last, offset: last.data.length};
    };

    /** 按字符偏移构造选区，元素不同即跨块选区 */
    const select = (anchorElement, anchorOffset, focusElement, focusOffset) => {
        const from = locate(anchorElement, anchorOffset);
        const to = locate(focusElement, focusOffset);
        assertPoint(from);
        assertPoint(to);
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        return range;
    };

    /** 单个元素内部的选区 */
    const selectWithin = (element, start, end) => select(element, start, element, end);

    /**
     * 一个选区端点（节点 + 节点内偏移）相对元素 textContent 的字符偏移。
     * 端点落在元素本身时按子节点序号算，因此元素级与文本节点级的端点都能量。
     */
    const offsetIn = (element, node, offset) => {
        const range = document.createRange();
        range.setStart(element, 0);
        range.setEnd(node, offset);
        return range.toString().length;
    };

    /** 区域内全部装饰 span 的快照：声明的装饰线、样式与被包裹的文本 */
    const decorationsIn = (root) =>
        decorationSpansIn(root).map((span) => ({
            lines: declaredLines(span.getAttribute("style")),
            style: span.getAttribute("style"),
            text: span.textContent,
        }));

    return {
        window,
        document,
        module,
        mount,
        select,
        selectWithin,
        offsetIn,
        textNodesOf,
        decorationsIn,
        decorationSpans: decorationSpansIn,
        declaredLines,
        close: () => window.close(),
    };
};

// 装饰的判定在测试侧独立写一份：照抄 src/dom.ts 的选择器会让断言变成自证。
// 判定只看 inline style 声明的装饰线 —— 思源存盘会丢掉任何标记属性，样式是唯一留下来的身份。
const LINE_KEYWORD = /^(?:underline|overline)$/;

/** 一串 style 声明里声明了哪些装饰线，按出现顺序去重后拼成 "underline overline" 这样的字符串 */
const declaredLines = (style) => {
    const found = [];
    for (const token of (style ?? "").split(/[\s,;:()]+/)) {
        if (LINE_KEYWORD.test(token) && !found.includes(token)) {
            found.push(token);
        }
    }
    return found.join(" ");
};

/** 区域内全部装饰 span，文档顺序 */
const decorationSpansIn = (root) =>
    Array.from(root.querySelectorAll("span[style]"))
        .filter((span) => declaredLines(span.getAttribute("style")) !== "");

const assertPoint = (point) => {
    if (point === null) {
        throw new Error("createFixture: 元素里没有文本节点，无法按偏移构造选区");
    }
};
