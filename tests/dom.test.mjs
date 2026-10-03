import assert from "node:assert/strict";
import test from "node:test";
import {createFixture} from "./helpers/dom.mjs";
import {toHost} from "./helpers/loadModule.mjs";

const fixture = createFixture();
const {document, window, module, mount, select, selectWithin, textNodesOf, decorationsIn, offsetIn} = fixture;
const {
    collectEditableGroups,
    stripDecorationIn,
    applySpansIn,
    captureOffsets,
    restoreOffsets,
    reclaimEditableElement,
    readDecorationStylesIn,
    getEventName,
} = module;

// 偏移三元组在 vm realm 里造出来，投影成纯数据后搬回宿主 realm 再断言，避免跨 realm 的原型差异
const offsetsOf = (groups) => toHost(groups.map((group) => [group.start, group.end]));

// 思源编辑器里每个块各带 data-node-id，可编辑区域正是以它为界
const editor = (blocks) => `<div class="b3-editor" id="editor" contenteditable="true">${blocks}</div>`;

const UNDERLINE_CSS = "text-decoration-line: underline; text-decoration-style: solid";
const DOTTED_CSS = "text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: #0090ff";
const OVERLINE_CSS = "text-decoration-line: overline; text-decoration-style: double";
const WAVY_CSS = "text-decoration-line: underline; text-decoration-style: wavy";
const underlineSpec = (css = UNDERLINE_CSS) => ({position: "underline", marker: "u", css});
const overlineSpec = (css = OVERLINE_CSS) => ({position: "overline", marker: "o", css});
/** 夹具里的一块装饰 span，属性顺序与插件写出的形态一致，便于逐字节比对 */
const markedSpan = (css, text) => `<span data-sue="u" style="${css}">${text}</span>`;
const ZWSP = "\u200b";

const emptyTextNodes = (root) => textNodesOf(root).filter((node) => node.data === "");
const placeholderNodes = (root) => textNodesOf(root).filter((node) => node.data === ZWSP);

// 装饰 span 内出现块级元素就是非法标记：span 的内容模型只允许行内内容
const BLOCK_TAGS = [
    "BLOCKQUOTE",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "LI",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TD",
    "TH",
    "UL",
];

/** 装饰 span 内部出现的块级标签名；为空才说明没把块搬进 span */
const blockTagsInDecorations = (root) => {
    const tags = new Set();
    for (const span of Array.from(root.querySelectorAll("[data-sue]"))) {
        for (const element of Array.from(span.querySelectorAll("*"))) {
            if (BLOCK_TAGS.includes(element.tagName)) {
                tags.add(element.tagName);
            }
        }
    }
    return Array.from(tags).sort();
};

/** 区域内全部块的 data-node-id；思源按 node-id 建文档树，重号会在保存重载时撞车 */
const blockIDsIn = (root) =>
    Array.from(root.querySelectorAll("[data-node-id]")).map((element) => element.getAttribute("data-node-id"));

/** 被搬进装饰 span 的块的 data-node-id；块被复制过就会在这里出现重号 */
const blockIDsInDecorations = (root) =>
    Array.from(root.querySelectorAll("[data-sue] [data-node-id]")).map((element) =>
        element.getAttribute("data-node-id")
    );

// ---------------------------------------------------------------- collectEditableGroups

test("collectEditableGroups returns one group whose offsets cover exactly the selected text", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">abcde</p>'));
    const paragraph = document.querySelector("p");
    const range = selectWithin(paragraph, 1, 4);

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].editableElement, paragraph);
    assert.equal(groups[0].blockElement, paragraph);
    assert.deepEqual(offsetsOf(groups), [[1, 4]]);
    // 偏移切出来的文本必须与用户实际选中的文本一致，而不是碰巧对上数字
    assert.equal(range.toString(), "bcd");
    assert.equal(paragraph.textContent.slice(groups[0].start, groups[0].end), "bcd");
    cleanup();
});

test("collectEditableGroups returns one group per paragraph for a selection across two paragraphs", () => {
    const cleanup = mount(editor(
        `<div data-type="blocks" data-node-id="list1">
            <p data-type="text" data-node-id="p1">abc</p>
            <p data-type="text" data-node-id="p2">defghi</p>
        </div>`,
    ));
    const [first, second] = document.querySelectorAll("p");
    const range = select(first, 1, second, 2);

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 2, "跨段落必须按块分组，包裹一个块不得影响另一个");
    assert.deepEqual(offsetsOf(groups), [[1, 3], [0, 2]]);
    assert.deepEqual(
        toHost(groups.map((group) => group.editableElement.getAttribute("data-node-id"))),
        ["p1", "p2"],
    );
    // 两段的偏移各自相对本段，两个片段拼起来正好是被选中的文字
    const selected = groups.map((group) => group.editableElement.textContent.slice(group.start, group.end)).join("");
    assert.equal(selected, "bcde");
    // 原始选区还会跨过两段之间的空白，偏移只覆盖真正落在块里的那些字
    assert.ok(range.toString().startsWith("bc"), `选区开头应当是前一段选中的部分：${range.toString()}`);
    assert.ok(range.toString().endsWith("de"), `选区结尾应当是后一段选中的部分：${range.toString()}`);
    cleanup();
});

test("collectEditableGroups resolves two table cells to their own TD elements", () => {
    const cleanup = mount(editor(
        `<table class="b3-table" data-type="blockTable" data-node-id="table1"><tbody><tr>
            <td data-type="blockTableCell"><p data-type="text" data-node-id="c1">abc</p></td>
            <td data-type="blockTableCell"><p data-type="text" data-node-id="c2">def</p></td>
        </tr></tbody></table>`,
    ));
    const [left, right] = document.querySelectorAll("td");
    const range = select(left, 1, right, 2);

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 2);
    // 单元格优先级高于块：可编辑区域是 TD 本身，偏移也相对 TD 的 textContent
    assert.deepEqual(toHost(groups.map((group) => group.editableElement === left)), [true, false]);
    assert.deepEqual(toHost(groups.map((group) => group.editableElement === right)), [false, true]);
    assert.deepEqual(offsetsOf(groups), [[1, 3], [0, 2]]);
    // 块元素仍是最近的 data-node-id 容器，保存时按它取 DOM
    assert.deepEqual(toHost(groups.map((group) => group.blockElement.getAttribute("data-node-id"))), [
        "table1",
        "table1",
    ]);
    assert.equal(left.textContent.slice(groups[0].start, groups[0].end), "bc");
    assert.equal(right.textContent.slice(groups[1].start, groups[1].end), "de");
    cleanup();
});

test("collectEditableGroups splits a multi-block table cell into one group per block", () => {
    const cleanup = mount(editor(
        `<table class="b3-table" data-type="blockTable" data-node-id="table1"><tbody><tr>
            <td data-type="blockTableCell">
                <p data-type="text" data-node-id="c1">第一段</p>
                <p data-type="text" data-node-id="c2">第二段</p>
            </td>
        </tr></tbody></table>`,
    ));
    const cell = document.querySelector("td");
    const first = cell.querySelector('[data-node-id="c1"]');
    const second = cell.querySelector('[data-node-id="c2"]');

    const groups = collectEditableGroups(select(first, 0, second, 1));

    // 单元格里有多于一个块时 TD 只是容器：按 TD 分组会把两个块并进一次包裹，
    // 而跨块的端点会逼出「块被复制一份」的残骸，撞上重号的 data-node-id
    assert.equal(groups.length, 2, "多块单元格必须退回按块分组");
    assert.deepEqual(offsetsOf(groups), [[0, 3], [0, 1]]);
    assert.deepEqual(
        toHost(groups.map((group) => group.editableElement.getAttribute("data-node-id"))),
        ["c1", "c2"],
    );
    cleanup();
});

test("collectEditableGroups contributes nothing from a code block inside the selection", () => {
    // 思源渲染代码块时同时保留一份原始源码与一份高亮副本，两份都不可编辑
    const plainCode = '<pre style="display: none;"><code class="language-js">let x = 1;</code></pre>';
    const highlighted =
        '<pre class="hljs"><code class="hljs"><span class="hljs-keyword">let</span> x = 1;</code></pre>';
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">abc</p>
        <div class="fn__code-block" data-type="NodeCodeBlock" data-node-id="code1">
            ${plainCode}
            ${highlighted}
        </div>`,
    ));
    const paragraph = document.querySelector("p");
    // 选区一直伸进高亮代码的内部，代码文字本身也必须被跳过
    const code = document.querySelector("pre.hljs code");
    const range = select(paragraph, 0, code.lastChild, 3);
    assert.ok(range.toString().startsWith("abc"), "夹具选区确实跨出了段落");
    assert.ok(range.toString().includes("let"), "夹具选区确实伸进了代码块");

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 1, "代码块内的文本不能产生任何分组");
    assert.equal(groups[0].editableElement, paragraph);
    assert.deepEqual(offsetsOf(groups), [[0, 3]]);
    assert.ok(!groups.some((group) => group.editableElement.textContent.includes("let")));
    cleanup();
});

test("collectEditableGroups contributes nothing from an attribute view inside the selection", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">abc</p>
        <div class="av" data-type="NodeAttributeView" data-node-id="av1">
            <table class="b3-table"><tbody><tr><td><div data-node-id="cell1">attr-text</div></td></tr></tbody></table>
        </div>`,
    ));
    const paragraph = document.querySelector("p");
    const cellText = document.querySelector(".av td div").firstChild;
    const range = select(paragraph, 1, cellText, 9);
    assert.ok(range.toString().includes("attr-text"), "夹具选区确实穿过了属性视图");

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 1, "属性视图内的文本不能产生任何分组");
    assert.equal(groups[0].editableElement, paragraph);
    assert.deepEqual(offsetsOf(groups), [[1, 3]]);
    cleanup();
});

test("collectEditableGroups contributes nothing from a math block inside the selection", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">abc</p>
        <div class="fn__math-block" data-type="NodeMathBlock" data-node-id="math1">
            <div class="katex"><span class="katex-mathml">x+y</span></div>
        </div>`,
    ));
    const paragraph = document.querySelector("p");
    const mathText = document.querySelector(".katex-mathml").firstChild;
    const range = select(paragraph, 0, mathText, 3);

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].editableElement, paragraph);
    assert.deepEqual(offsetsOf(groups), [[0, 3]]);
    cleanup();
});

test("collectEditableGroups treats a callout title as its own editable area", () => {
    const cleanup = mount(editor(
        `<div class="callout" data-type="NodeBlockQuote" data-node-id="callout1">
            <div class="callout-info"><div class="callout-title">Title</div></div>
            <div class="callout-content"><p data-type="text" data-node-id="body1">Body</p></div>
        </div>`,
    ));
    const title = document.querySelector(".callout-title");
    const body = document.querySelector("p");
    const range = select(title, 1, body, 2);

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 2, "标题与正文是两个可编辑区域");
    assert.deepEqual(toHost(groups.map((group) => group.editableElement === title)), [true, false]);
    assert.deepEqual(offsetsOf(groups), [[1, 5], [0, 2]]);
    assert.equal(title.textContent.slice(groups[0].start, groups[0].end), "itle");
    cleanup();
});

test("collectEditableGroups treats a tab item label as its own editable area", () => {
    const cleanup = mount(editor(
        `<div class="fn__flex" data-type="Tabs" data-node-id="tabs1">
            <div class="fn__flex-item" data-type="TabsItem">
                <div class="fn__flex-item__label" contenteditable="true">Label</div>
            </div>
            <div class="fn__flex-item" data-type="TabsItem">
                <div class="fn__flex-item__label" contenteditable="true">Body</div>
            </div>
        </div>`,
    ));
    const [label, body] = document.querySelectorAll(".fn__flex-item__label");
    const range = select(label, 1, body, 2);

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 2, "两个标签各自是一个可编辑区域");
    assert.deepEqual(toHost(groups.map((group) => group.editableElement === label)), [true, false]);
    assert.deepEqual(offsetsOf(groups), [[1, 5], [0, 2]]);
    assert.equal(label.textContent.slice(groups[0].start, groups[0].end), "abel");
    cleanup();
});

test("collectEditableGroups ignores a selection collapsed to a caret", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">abc</p>'));
    const paragraph = document.querySelector("p");
    assert.deepEqual(offsetsOf(collectEditableGroups(selectWithin(paragraph, 1, 1))), []);
    cleanup();
});

// ---------------------------------------------------------------- 带子列表的列表项

// 思源的列表项同时是自己的一块、又能带子列表，两种身份叠在同一个 <li> 上。
// 这个夹具是「本项文字包在 <p> 里」的写法：文字因此落在比列表项更内层、且不含子列表的那一层上。
// 另一种写法（本项文字直接作为 <li> 的子节点）之下没有更内层的区域，仍按纯容器跳过；
// 真实思源用哪种写法只能上实例看，见 docs/manual-verification.md 第 6 项。
const nestedListWithOwnParagraph = editor(
    `<ul class="b3-list">
        <li data-type="listItem" class="b3-list-item" data-node-id="A">
            <p data-type="text" class="b3-list-item__text">own text</p><ul class="b3-list"><li data-type="listItem" class="b3-list-item" data-node-id="B">child text</li></ul>
        </li>
    </ul>`,
);

test("collectEditableGroups keeps a list item's own text editable when it holds a nested sub-list", () => {
    const cleanup = mount(nestedListWithOwnParagraph);
    const item = document.querySelector('[data-node-id="A"]');
    const own = item.querySelector("p");
    const range = selectWithin(own, 4, 8);
    assert.equal(range.toString(), "text");

    const groups = collectEditableGroups(range);

    assert.equal(groups.length, 1, "带子列表的列表项，它自己的文字不能因为块内还有子块就被整块跳过");
    assert.equal(groups[0].editableElement, own, "可编辑区域是承载本项文字的那一层，不是整个列表项");
    // 块仍是这个列表项本身：落盘按块元素取 HTML 与块 id
    assert.equal(groups[0].blockElement, item);
    assert.deepEqual(offsetsOf(groups), [[4, 8]]);
    assert.equal(own.textContent.slice(groups[0].start, groups[0].end), "text");
    cleanup();
});

test("collectEditableGroups does not split a list item's own text along its inline elements", () => {
    const cleanup = mount(editor(
        '<ul class="b3-list"><li data-type="listItem" data-node-id="A"><p>own <strong>bold</strong> tail</p><ul class="b3-list"><li data-type="listItem" data-node-id="B">child</li></ul></li></ul>',
    ));
    const own = document.querySelector('[data-node-id="A"] > p');

    const groups = collectEditableGroups(selectWithin(own, 0, 13));

    // 区域边界必须落在块级上：按行内标记切区域的话，同一段文字会变成两个区域，偏移各按各的算
    assert.equal(groups.length, 1, "行内元素不构成区域边界");
    assert.equal(groups[0].editableElement, own);
    assert.deepEqual(offsetsOf(groups), [[0, 13]]);
    assert.equal(own.textContent.slice(groups[0].start, groups[0].end), "own bold tail");
    cleanup();
});

test("collectEditableGroups splits a selection across a parent list item and its child item into two groups", () => {
    const cleanup = mount(nestedListWithOwnParagraph);
    const item = document.querySelector('[data-node-id="A"]');
    const own = item.querySelector("p");
    const child = document.querySelector('[data-node-id="B"]');

    const groups = collectEditableGroups(select(own, 4, child, 5));

    // 静默只应用一半是最难察觉的失败形态：父项与子项必须各自成为一个区域
    assert.equal(groups.length, 2, "跨父项与子项的选区必须分成两组，不能静默跳过其中一边");
    assert.deepEqual(toHost(groups.map((group) => group.editableElement.tagName)), ["P", "LI"]);
    assert.deepEqual(offsetsOf(groups), [[4, 8], [0, 5]]);
    assert.deepEqual(
        toHost(groups.map((group) => group.blockElement.getAttribute("data-node-id"))),
        ["A", "B"],
        "两个区域各自记自己的块，保存时才不会把两个块并成一次",
    );

    for (const group of groups) {
        applySpansIn(group.editableElement, group.start, group.end, [underlineSpec()]);
    }

    assert.deepEqual(
        decorationsIn(document.body),
        [
            {marker: "u", style: UNDERLINE_CSS, text: "text"},
            {marker: "u", style: UNDERLINE_CSS, text: "child"},
        ],
        "父项自己的文字与子项的文字都要被装饰",
    );
    assert.deepEqual(decorationsIn(own), [{marker: "u", style: UNDERLINE_CSS, text: "text"}]);
    assert.deepEqual(decorationsIn(child), [{marker: "u", style: UNDERLINE_CSS, text: "child"}]);
    cleanup();
});

test("applySpansIn decorates a list item's own text and leaves the nested sub-list alone", () => {
    const cleanup = mount(nestedListWithOwnParagraph);
    const item = document.querySelector('[data-node-id="A"]');
    const own = item.querySelector("p");
    const child = document.querySelector('[data-node-id="B"]');
    const before = item.textContent;

    for (const group of collectEditableGroups(selectWithin(own, 0, 8))) {
        applySpansIn(group.editableElement, group.start, group.end, [underlineSpec()]);
    }

    // data-sue 必须落在这个列表项之内、承载本项文字的那一层里
    assert.deepEqual(decorationsIn(own), [{marker: "u", style: UNDERLINE_CSS, text: "own text"}]);
    assert.ok(item.contains(own.querySelector("[data-sue]")), "装饰要写在文档里的这个列表项内部");
    // 子列表不在选区里：既不能被包裹，也不能被剥掉既有装饰
    assert.deepEqual(decorationsIn(child), [], "子列表里的内容不属于本次选区");
    assert.deepEqual(blockTagsInDecorations(item), [], "span 里不能出现块级元素");
    assert.deepEqual(blockIDsInDecorations(item), [], "块被搬进 span 会复制出重号的 data-node-id");
    assert.deepEqual(blockIDsIn(document.body), ["A", "B"], "块 id 必须仍然唯一");
    assert.equal(item.textContent, before, "一个字符都不能动");
    cleanup();
});

test("collectEditableGroups still contributes nothing from a block that only wraps other blocks", () => {
    // 纯容器块：它的直接文本只有子块之间的空白，包住毫无意义
    const cleanup = mount(editor(
        `<div data-type="NodeBlockQuote" data-node-id="A">
            <div data-type="blocks" data-node-id="B"><p data-type="text" data-node-id="C">first</p></div>
            <div data-type="blocks" data-node-id="D"><p data-type="text" data-node-id="E">second</p></div>
        </div>`,
    ));
    const wrapper = document.querySelector('[data-node-id="A"]');
    // 两个子块之间那段空白文本节点
    const between = wrapper.childNodes[2];
    assert.equal(between.nodeType, 3, "夹具必须真的在两个子块之间留了空白文本节点");
    assert.ok(between.data.trim() === "", `夹具里的空白文本节点不应含可见文字：${between.data}`);

    assert.deepEqual(
        offsetsOf(collectEditableGroups(select(between, 0, between, between.data.length))),
        [],
        "纯容器块自身不产生任何分组",
    );

    // 同一块里落在子块上的文字照旧按子块分组：容器块被跳过不等于整块的内容不可编辑
    const first = document.querySelector('[data-node-id="C"]');
    const second = document.querySelector('[data-node-id="E"]');
    const groups = collectEditableGroups(select(first, 0, second, 6));
    assert.equal(groups.length, 2);
    assert.deepEqual(
        toHost(groups.map((group) => group.editableElement.getAttribute("data-node-id"))),
        ["C", "E"],
    );
    cleanup();
});

test("collectEditableGroups resolves a single nested block to that block instead of the wrapper", () => {
    const cleanup = mount(
        editor('<div data-type="blocks" data-node-id="A"><div data-type="text" data-node-id="B">text</div></div>'),
    );
    const inner = document.querySelector('[data-node-id="B"]');

    const groups = collectEditableGroups(selectWithin(inner, 0, 4));

    assert.equal(groups.length, 1);
    assert.equal(groups[0].editableElement, inner, "文字全在子块里时，区域就是那个子块");
    assert.equal(groups[0].blockElement, inner);
    cleanup();
});

// ---------------------------------------------------------------- stripDecorationIn

test("stripDecorationIn unwraps nested decoration spans without changing one character of text", () => {
    // 装饰 span 是套在一起的：外层上划线、内层下划线
    const inner = `<span data-sue="u" style="${UNDERLINE_CSS}">abc</span>`;
    const nested = `<span data-sue="o" style="${OVERLINE_CSS}">${inner}</span>`;
    const cleanup = mount(editor(`<p data-type="text" data-node-id="p1">pre${nested}post</p>`));
    const paragraph = document.querySelector("p");
    const before = paragraph.textContent;
    assert.equal(before, "preabcpost");

    stripDecorationIn(paragraph);

    assert.equal(paragraph.textContent, before, "剥 span 只能改嵌套关系，textContent 必须逐字不变");
    assert.equal(paragraph.querySelectorAll("[data-sue]").length, 0);
    // 只剩文本节点：说明是解包而不是删内容
    assert.deepEqual(toHost(textNodesOf(paragraph).map((node) => node.data)), ["pre", "abc", "post"]);
    cleanup();
});

test("stripDecorationIn leaves strong and a elements that carry no data-sue marker", () => {
    const marked = `<span data-sue="u" style="${UNDERLINE_CSS}">x</span>`;
    const linkURL = "https://example.com/doc";
    const inline = `<strong>bold</strong><a href="${linkURL}">link</a>`;
    const cleanup = mount(editor(`<p data-type="text" data-node-id="p1">${marked}${inline}</p>`));
    const paragraph = document.querySelector("p");
    const before = paragraph.textContent;

    stripDecorationIn(paragraph);

    const strong = paragraph.querySelector("strong");
    const link = paragraph.querySelector("a");
    assert.ok(strong !== null && link !== null, "没有 data-sue 的行内元素必须原样保留");
    assert.equal(strong.parentElement, paragraph);
    assert.equal(link.parentElement, paragraph);
    assert.equal(link.getAttribute("href"), linkURL);
    assert.equal(paragraph.textContent, before);
    assert.deepEqual(decorationsIn(paragraph), []);
    cleanup();
});

test("stripDecorationIn without a range clears the whole region, which is the explicit region-wide mode", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">${markedSpan(UNDERLINE_CSS, "abc")} tail</p>`,
    ));
    const paragraph = document.querySelector("p");

    stripDecorationIn(paragraph);

    assert.deepEqual(decorationsIn(paragraph), [], "不给范围即整块清理，这是唯一走到区域级清理的入口");
    assert.equal(paragraph.innerHTML, "abc tail", "解包后只剩裸文本");
    cleanup();
});

test("stripDecorationIn with a range leaves decoration outside that range untouched", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>`,
    ));
    const paragraph = document.querySelector("p");

    // 只覆盖前 6 个字符（"plain "），落在范围之外的那块装饰必须原样留下
    stripDecorationIn(paragraph, {start: 0, end: 6});

    assert.deepEqual(decorationsIn(paragraph), [{marker: "u", style: DOTTED_CSS, text: "decorated"}]);
    assert.equal(paragraph.innerHTML, `plain ${markedSpan(DOTTED_CSS, "decorated")} tail`);
    cleanup();
});

test("stripDecorationIn treats a collapsed or inverted range as no range at all", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>`,
    ));
    const paragraph = document.querySelector("p");
    const before = paragraph.innerHTML;

    // 零宽的字符范围在 DOM 上仍是一条真实 range：起点落在 "decorated" 末尾，
    // 终点经端点外扩升到 <p> 里那个 span 之后的位置。Range.intersectsNode 判它相交，
    // 于是这块装饰被无声剥掉。零宽范围不覆盖任何字符，一个装饰都不该动。
    stripDecorationIn(paragraph, {start: 15, end: 15});

    assert.equal(paragraph.innerHTML, before, "塌成一点的范围不该剥掉任何装饰");

    stripDecorationIn(paragraph, {start: 8, end: 3});

    assert.equal(paragraph.innerHTML, before, "起止颠倒的范围同样按「没有范围」处理");
    assert.deepEqual(decorationsIn(paragraph), [{marker: "u", style: DOTTED_CSS, text: "decorated"}]);
    cleanup();
});

// ---------------------------------------------------------------- applySpansIn

test("applySpansIn wraps the selected text in one span and leaves the adjacent text out of it", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">abcde</p>'));
    const paragraph = document.querySelector("p");

    applySpansIn(paragraph, 1, 4, [underlineSpec()]);

    const decorations = decorationsIn(paragraph);
    assert.deepEqual(decorations, [{marker: "u", style: UNDERLINE_CSS, text: "bcd"}]);
    assert.equal(paragraph.textContent, "abcde");
    // 未选中的前后文字必须仍是段落自己的直接子节点，没有被顺手包进去
    assert.equal(paragraph.firstChild.nodeType, 3);
    assert.equal(paragraph.firstChild.data, "a");
    assert.equal(paragraph.lastChild.nodeType, 3);
    assert.equal(paragraph.lastChild.data, "e");
    assert.equal(decorations[0].text.startsWith("a"), false);
    assert.equal(decorations[0].text.endsWith("e"), false);
    cleanup();
});

test("applySpansIn nests the specs outermost-first so the overline span wraps the underline span", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">abc</p>'));
    const paragraph = document.querySelector("p");

    // specs 与 composePair 一致，外层在前；从末尾向前包裹才能得到下层在内、上层在外的嵌套
    applySpansIn(paragraph, 0, 3, [overlineSpec(), underlineSpec(DOTTED_CSS)]);

    const outer = paragraph.querySelector('[data-sue="o"]');
    const inner = paragraph.querySelector('[data-sue="u"]');
    assert.equal(paragraph.querySelectorAll("[data-sue]").length, 2);
    assert.ok(outer !== null && inner !== null);
    assert.equal(outer.parentElement, paragraph, "上划线 span 必须在最外层");
    assert.equal(inner.parentElement, outer, "下划线 span 必须在最内层");
    assert.equal(outer.getAttribute("style"), OVERLINE_CSS);
    assert.equal(inner.getAttribute("style"), DOTTED_CSS);
    assert.equal(outer.textContent, "abc");
    assert.equal(paragraph.textContent, "abc");
    cleanup();
});

test("applySpansIn removes the existing decoration when specs is empty", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">abc</p>'));
    const paragraph = document.querySelector("p");
    applySpansIn(paragraph, 0, 3, [underlineSpec()]);
    assert.equal(decorationsIn(paragraph).length, 1);

    applySpansIn(paragraph, 0, 3, []);

    assert.deepEqual(decorationsIn(paragraph), [], "空 specs 的语义是清除装饰");
    assert.equal(paragraph.textContent, "abc");
    assert.equal(paragraph.childNodes.length, 1, "解包后应由 normalize 合并成单个文本节点");
    cleanup();
});

test("applySpansIn restyles only the selected tail when it partially overlaps an existing decoration", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">abc</p>'));
    const paragraph = document.querySelector("p");
    // 先给 abc 整体加实线下划线
    applySpansIn(paragraph, 0, 3, [underlineSpec(UNDERLINE_CSS)]);

    // 用户随后只选中 bc 并换成点线蓝色
    applySpansIn(paragraph, 1, 3, [underlineSpec(DOTTED_CSS)]);

    assert.equal(paragraph.textContent, "abc", "换样式不能动一个字");
    assert.deepEqual(
        decorationsIn(paragraph),
        [{marker: "u", style: DOTTED_CSS, text: "bc"}],
        "只应剩一个新样式的 span：既不能双层包裹，也不能把未选中的 a 拖进来",
    );
    // 未选中的 a 必须是裸的段落直接子文本，不在任何装饰 span 内
    const first = paragraph.firstChild;
    assert.equal(first.nodeType, 3);
    assert.equal(first.data, "a");
    assert.equal(first.parentElement, paragraph);
    assert.ok(first.parentElement.closest("[data-sue]") === null, "a 不得落在装饰 span 内");
    assert.equal(paragraph.querySelectorAll("[data-sue]").length, 1);
    cleanup();
});

test("applySpansIn leaves no empty text node behind when the range cuts across an inline element", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">ab<em>c</em>de</p>'));
    const paragraph = document.querySelector("p");

    // 1..4 横跨纯文本与 <em>：<em> 整体被搬进 span，两侧的文字一字不动
    applySpansIn(paragraph, 1, 4, [underlineSpec()]);

    assert.equal(paragraph.textContent, "abcde");
    assert.deepEqual(emptyTextNodes(paragraph).length, 0, "残留空文本节点会让思源算错光标位置");
    const decorated = paragraph.querySelector("[data-sue]");
    assert.ok(decorated !== null);
    assert.equal(decorated.textContent, "bcd");
    assert.ok(decorated.querySelector("em") !== null, "被选中的 <em> 内容要跟着进 span");
    cleanup();
});

test("applySpansIn leaves no empty text node behind when the whole block is selected", () => {
    const cleanup = mount(editor('<p data-type="text" data-node-id="p1">abc</p>'));
    const paragraph = document.querySelector("p");

    // 整段选中是最常见的用法：端点外扩到段落边界后，范围搬运会在段落里留下两个空文本节点
    applySpansIn(paragraph, 0, 3, [underlineSpec()]);

    assert.equal(paragraph.textContent, "abc");
    assert.deepEqual(emptyTextNodes(paragraph).length, 0);
    assert.deepEqual(decorationsIn(paragraph), [{marker: "u", style: UNDERLINE_CSS, text: "abc"}]);
    cleanup();
});

test("applySpansIn keeps the nesting of sibling inline elements", () => {
    const cleanup = mount(
        editor('<p data-type="text" data-node-id="p1">pre<strong>bold</strong>mid<em>emph</em>post</p>'),
    );
    const paragraph = document.querySelector("p");

    // 3..7 正好落在 <strong> 内部
    applySpansIn(paragraph, 3, 7, [underlineSpec()]);

    assert.equal(paragraph.textContent, "preboldmidemphpost");
    // <strong> 整体搬进 span：段里只剩一个 strong，说明没有留下被复制后空掉的残壳
    const strong = paragraph.querySelector("strong");
    const decorated = paragraph.querySelector("[data-sue]");
    assert.ok(strong !== null && decorated !== null);
    assert.equal(paragraph.querySelectorAll("strong").length, 1, "不能把行内元素复制一份、原处留个空壳");
    assert.equal(strong.textContent, "bold");
    assert.equal(strong.parentElement, decorated);
    assert.equal(decorated.parentElement, paragraph);
    // 选区外的 <em> 仍是段落的直接子元素，没被顺手挪动
    const em = paragraph.querySelector("em");
    assert.equal(em.parentElement, paragraph);
    assert.equal(em.textContent, "emph");
    assert.deepEqual(emptyTextNodes(paragraph).length, 0);
    cleanup();
});

test("applySpansIn wraps a single-block table cell without pulling the block into the span", () => {
    const cleanup = mount(editor(
        `<table class="b3-table" data-type="blockTable" data-node-id="table1"><tbody><tr>
            <td data-type="blockTableCell"><p data-type="text" data-node-id="c1">abc</p></td>
        </tr></tbody></table>`,
    ));
    const cell = document.querySelector("td");
    // 单块单元格仍按计划判定为 TD 本身
    const groups = collectEditableGroups(selectWithin(cell, 0, 3));
    assert.equal(groups[0].editableElement, cell);
    for (const group of groups) {
        applySpansIn(group.editableElement, group.start, group.end, [underlineSpec()]);
    }

    assert.deepEqual(
        blockTagsInDecorations(cell),
        [],
        "span 只放得下行内内容；块级元素被端点外扩拉进 span 就是非法标记，重新解析时照样留在文档里",
    );
    assert.deepEqual(blockIDsIn(cell), ["c1"]);
    assert.equal(cell.textContent, "abc");
    cleanup();
});

test("applySpansIn does not duplicate a block id when it wraps one paragraph of a multi-block cell", () => {
    const cleanup = mount(editor(
        `<table class="b3-table" data-type="blockTable" data-node-id="table1"><tbody><tr>
            <td data-type="blockTableCell">
                <p data-type="text" data-node-id="c1">第一段</p>
                <p data-type="text" data-node-id="c2">第二段</p>
            </td>
        </tr></tbody></table>`,
    ));
    const cell = document.querySelector("td");
    const first = cell.querySelector('[data-node-id="c1"]');
    const before = cell.textContent;

    // 只选第一段；思源按块应用行内标记，单元格此时只是容器
    const groups = collectEditableGroups(selectWithin(first, 0, 3));
    for (const group of groups) {
        applySpansIn(group.editableElement, group.start, group.end, [underlineSpec()]);
    }

    // 单元格内的块 id 重号会让保存重载时撞车，空壳块则是块被复制后剩下的残骸
    assert.deepEqual(blockIDsInDecorations(cell), [], "没有任何块被搬进装饰 span");
    assert.deepEqual(blockIDsIn(cell), ["c1", "c2"], "块 id 必须唯一，且没有多出来的空壳块");
    assert.deepEqual(decorationsIn(cell), [{marker: "u", style: UNDERLINE_CSS, text: "第一段"}]);
    assert.equal(cell.textContent, before);
    cleanup();
});

test("applySpansIn restyles the selected range and keeps decoration elsewhere in the block byte-identical", () => {
    // 先装饰 "decorated"，再只选中它前面的 "plain " 换成波浪线
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>`,
    ));
    const paragraph = document.querySelector("p");
    const kept = markedSpan(DOTTED_CSS, "decorated");

    applySpansIn(paragraph, 0, 6, [underlineSpec(WAVY_CSS)]);

    // 「给第一个词加下划线，再给同段第二个词加下划线」是最普通的用法；
    // 按区域整块剥的话，第一次加的装饰会连同它已落盘的 HTML 一起消失
    assert.equal(
        paragraph.innerHTML,
        `${markedSpan(WAVY_CSS, "plain ")}${kept} tail`,
        "选区之外的装饰必须逐字节保留，不能只换个位置就算数",
    );
    assert.deepEqual(
        decorationsIn(paragraph),
        [
            {marker: "u", style: WAVY_CSS, text: "plain "},
            {marker: "u", style: DOTTED_CSS, text: "decorated"},
        ],
    );
    assert.equal(paragraph.textContent, "plain decorated tail");
    cleanup();
});

test("applySpansIn keeps a decoration byte-identical when the range starts exactly where it ends", () => {
    // 装饰 "decorated" 落在偏移 6..15：选区起点压在它末尾时，一个字都不该属于选区
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>
        <p data-type="text" data-node-id="p2">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>`,
    ));
    const [afterSpan, beforeSpan] = document.querySelectorAll("p");
    const kept = markedSpan(DOTTED_CSS, "decorated");

    applySpansIn(afterSpan, 15, 20, [underlineSpec(WAVY_CSS)]);

    // 选区起点与装饰末尾相接：那块装饰是用户此前保存过的另一处改动，
    // 剥掉它等于把它从文档里删掉，并随这次保存一起落盘（生产可达：装饰后紧跟的文字起选中）
    assert.equal(
        afterSpan.innerHTML,
        `plain ${kept}${markedSpan(WAVY_CSS, " tail")}`,
        "选区起点与装饰末尾相接时，那块装饰必须逐字节保留",
    );
    assert.deepEqual(decorationsIn(afterSpan), [
        {marker: "u", style: DOTTED_CSS, text: "decorated"},
        {marker: "u", style: WAVY_CSS, text: " tail"},
    ]);

    // 同一个边界从另一侧看：选区终点与装饰起点相接时，那块装饰落在范围之外，
    // 既不被剥掉也不被新样式盖住。（上面那条 applySpansIn 用例覆盖了这一侧，这里作对称对照）
    applySpansIn(beforeSpan, 0, 6, [underlineSpec(WAVY_CSS)]);

    assert.equal(
        beforeSpan.innerHTML,
        `${markedSpan(WAVY_CSS, "plain ")}${kept} tail`,
        "选区终点与装饰起点相接时，只改写选区本身",
    );
    assert.deepEqual(decorationsIn(beforeSpan), [
        {marker: "u", style: WAVY_CSS, text: "plain "},
        {marker: "u", style: DOTTED_CSS, text: "decorated"},
    ]);
    assert.equal(afterSpan.textContent, "plain decorated tail");
    assert.equal(beforeSpan.textContent, "plain decorated tail");
    cleanup();
});

test("applySpansIn still restyles a decoration that the range only partly overlaps", () => {
    // 装饰落在偏移 6..15；两段选区各压住它的一半，都算与范围相交
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>
        <p data-type="text" data-node-id="p2">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>`,
    ));
    const [tailCut, headCut] = document.querySelectorAll("p");

    applySpansIn(tailCut, 9, 20, [underlineSpec(WAVY_CSS)]);
    applySpansIn(headCut, 0, 9, [underlineSpec(WAVY_CSS)]);

    // 只擦掉相接处那一侧：装饰被新样式盖住，范围外的文字既不被拖进新 span、也不会被剥成裸文本
    assert.deepEqual(decorationsIn(tailCut), [{marker: "u", style: WAVY_CSS, text: "orated tail"}]);
    assert.deepEqual(decorationsIn(headCut), [{marker: "u", style: WAVY_CSS, text: "plain dec"}]);
    assert.equal(tailCut.textContent, "plain decorated tail");
    assert.equal(headCut.textContent, "plain decorated tail");
    cleanup();
});

test("applySpansIn keeps every untouched decoration in a table cell that holds two decorated words", () => {
    const cleanup = mount(editor(
        `<table class="b3-table" data-type="blockTable" data-node-id="table1"><tbody><tr>
            <td data-type="blockTableCell"><p data-type="text" data-node-id="c1">alpha ${
            markedSpan(DOTTED_CSS, "beta")
        } gamma ${markedSpan(DOTTED_CSS, "delta")}</p></td>
        </tr></tbody></table>`,
    ));
    const cell = document.querySelector("td");
    assert.equal(cell.textContent, "alpha beta gamma delta");
    const keptBeta = markedSpan(DOTTED_CSS, "beta");
    const keptDelta = markedSpan(DOTTED_CSS, "delta");

    // 可编辑区域是 TD 本身，偏移相对 TD 的 textContent：gamma 落在 11..16
    applySpansIn(cell, 11, 16, [underlineSpec(WAVY_CSS)]);

    assert.equal(
        cell.querySelector("p").innerHTML,
        `alpha ${keptBeta} ${markedSpan(WAVY_CSS, "gamma")} ${keptDelta}`,
        "单元格里另外两块装饰都不能被顺手剥掉",
    );
    assert.deepEqual(
        decorationsIn(cell),
        [
            {marker: "u", style: DOTTED_CSS, text: "beta"},
            {marker: "u", style: WAVY_CSS, text: "gamma"},
            {marker: "u", style: DOTTED_CSS, text: "delta"},
        ],
    );
    assert.equal(cell.textContent, "alpha beta gamma delta");
    cleanup();
});

test("applySpansIn with empty specs clears the selected range and leaves decoration outside it", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">${markedSpan(DOTTED_CSS, "alpha")} tail ${
            markedSpan(DOTTED_CSS, "gamma")
        }</p>`,
    ));
    const paragraph = document.querySelector("p");

    // 「清除装饰」走的是同一条路径，因此它的作用域同样是选区而不是整块
    applySpansIn(paragraph, 0, 5, []);

    assert.equal(paragraph.innerHTML, `alpha tail ${markedSpan(DOTTED_CSS, "gamma")}`);
    assert.equal(paragraph.textContent, "alpha tail gamma");
    cleanup();
});

test("applySpansIn strips an outer span that only partly overlaps while its inner span keeps its own decoration", () => {
    // 外层上划线罩着整段，内层下划线只罩着后半段；选区只覆盖前半段
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1"><span data-sue="o" style="${OVERLINE_CSS}">ab` +
            `<span data-sue="u" style="${DOTTED_CSS}">cd</span></span></p>`,
    ));
    const paragraph = document.querySelector("p");

    applySpansIn(paragraph, 0, 2, [underlineSpec(WAVY_CSS)]);

    // 前半段换成新的下划线，后半段自己的装饰既不能丢也不能被新样式盖住
    assert.deepEqual(
        decorationsIn(paragraph),
        [
            {marker: "u", style: WAVY_CSS, text: "ab"},
            {marker: "u", style: DOTTED_CSS, text: "cd"},
        ],
    );
    assert.equal(paragraph.textContent, "abcd");
    cleanup();
});

test("applySpansIn leaves no empty inline clone when the range ends where an inline element starts", () => {
    const linkURL = "https://example.com/doc";
    const cleanup = mount(
        editor(`<p data-type="text" data-node-id="p1">abc<em>de</em></p>
        <p data-type="text" data-node-id="p2">abc<a href="${linkURL}">de</a></p>`),
    );
    const [emphasized, linked] = document.querySelectorAll("p");

    // 0..3 正好停在行内元素的起点：端点若算到行内元素内部，元素会被复制成空壳留在原地
    applySpansIn(emphasized, 0, 3, [underlineSpec()]);
    applySpansIn(linked, 0, 3, [underlineSpec()]);

    assert.equal(emphasized.querySelectorAll("em").length, 1, "不能多出一个空的 <em> 副本");
    assert.equal(linked.querySelectorAll("a").length, 1, "不能多出一个空的 <a> 副本");
    assert.equal(linked.querySelector("a").getAttribute("href"), linkURL);
    assert.deepEqual(decorationsIn(emphasized), [{marker: "u", style: UNDERLINE_CSS, text: "abc"}]);
    assert.deepEqual(decorationsIn(linked), [{marker: "u", style: UNDERLINE_CSS, text: "abc"}]);
    assert.equal(emphasized.parentElement.querySelector("p").textContent, "abcde");
    assert.deepEqual(emptyTextNodes(emphasized).length, 0);
    assert.deepEqual(emptyTextNodes(linked).length, 0);
    cleanup();
});

test("applySpansIn drops a zero-width-space placeholder left over next to real text", () => {
    const cleanup = mount(editor(`<p data-type="text" data-node-id="p1"><em>a</em>${ZWSP}<em>b</em></p>`));
    const paragraph = document.querySelector("p");
    assert.equal(placeholderNodes(paragraph).length, 1, "夹具必须真的放进了一个只含 ZWSP 的文本节点");

    // 偏移 2..3 只覆盖第二个 <em> 里的 b，落在选区之外的占位符必须被清掉
    applySpansIn(paragraph, 2, 3, [underlineSpec()]);

    assert.deepEqual(decorationsIn(paragraph), [{marker: "u", style: UNDERLINE_CSS, text: "b"}]);
    assert.deepEqual(
        placeholderNodes(paragraph).length,
        0,
        "只剩零宽空格的残留文本节点必须清掉，否则思源按偏移算光标会偏位",
    );
    assert.equal(paragraph.textContent, "ab");
    cleanup();
});

test("applySpansIn keeps a zero-width-space placeholder when the whole block holds nothing else", () => {
    const cleanup = mount(editor(`<p data-type="text" data-node-id="p1">${ZWSP}</p>`));
    const paragraph = document.querySelector("p");

    applySpansIn(paragraph, 0, 1, [underlineSpec()]);

    // 空块唯一的占位符被抹掉之后，思源就无法在该块内放置光标
    assert.equal(paragraph.textContent, ZWSP);
    assert.equal(placeholderNodes(paragraph).length, 1);
    cleanup();
});

test("applySpansIn does nothing for an empty or inverted offset range", () => {
    const cleanup = mount(
        editor('<p data-type="text" data-node-id="p1">abc</p><p data-type="text" data-node-id="p2"></p>'),
    );
    const [text, blank] = document.querySelectorAll("p");

    applySpansIn(text, 2, 2, [underlineSpec()]);
    assert.deepEqual(decorationsIn(text), [], "空范围不该留下空 span");

    applySpansIn(text, 3, 1, [underlineSpec()]);
    assert.deepEqual(decorationsIn(text), [], "起止颠倒时不该包裹出负范围");

    applySpansIn(blank, 0, 5, [underlineSpec()]);
    assert.deepEqual(decorationsIn(blank), [], "块里没有文本节点时不该凭空造出 span");
    assert.equal(text.textContent, "abc");
    cleanup();
});

// ---------------------------------------------------------------- readDecorationStylesIn

test("readDecorationStylesIn reads what the selection really covers, at both boundaries", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">plain ${markedSpan(DOTTED_CSS, "decorated")} tail</p>`,
    ));
    const paragraph = document.querySelector("p");

    // 面板读到的是「选区内的装饰」：范围落在装饰之后就读不到它，而不是把整块里的装饰都算进来
    assert.deepEqual(toHost(readDecorationStylesIn(paragraph, 15, 20)), [], "起点压在装饰末尾即不相交");
    assert.deepEqual(toHost(readDecorationStylesIn(paragraph, 0, 6)), [], "终点压在装饰起点即不相交");
    // 一侧重叠仍算相交；读与剥走的是同一条判定，两者不可能对同一段文字给出相反的答案
    assert.deepEqual(toHost(readDecorationStylesIn(paragraph, 9, 15)), [DOTTED_CSS], "压住后半截算相交");
    assert.deepEqual(toHost(readDecorationStylesIn(paragraph, 6, 12)), [DOTTED_CSS], "压住前半截算相交");
    assert.deepEqual(toHost(readDecorationStylesIn(paragraph, 6, 15)), [DOTTED_CSS], "整段压在装饰上算相交");
    cleanup();
});

// ---------------------------------------------------------------- reclaimEditableElement

test("reclaimEditableElement finds the same inner area again after the block HTML was swapped", () => {
    const cleanup = mount(nestedListWithOwnParagraph);
    const item = document.querySelector('[data-node-id="A"]');
    const own = item.querySelector("p");
    const before = item.outerHTML;
    const groups = collectEditableGroups(selectWithin(own, 0, 8));
    applySpansIn(groups[0].editableElement, groups[0].start, groups[0].end, [underlineSpec()]);

    // 模拟 persist.undoLastChange：整块 HTML 换回去，块连同子树一起被换掉
    item.outerHTML = before;
    const reclaimed = reclaimEditableElement(groups[0].editableElement, document.querySelector('[data-node-id="A"]'));

    assert.equal(reclaimed.tagName, "P", "认领到的仍是承载本项文字的那一层，而不是整个列表项");
    assert.ok(reclaimed.isConnected);
    assert.ok(
        !reclaimed.contains(document.querySelector('[data-node-id="B"]')),
        "认领到的区域不能把子列表圈进来",
    );

    // 认领之后再改一次设置：装饰照旧落在本项文字上，子列表里的装饰也不该被顺手剥掉
    const child = document.querySelector('[data-node-id="B"]');
    applySpansIn(child, 0, 10, [underlineSpec(DOTTED_CSS)]);
    applySpansIn(reclaimed, 0, 8, [underlineSpec(DOTTED_CSS)]);

    assert.deepEqual(decorationsIn(reclaimed), [{marker: "u", style: DOTTED_CSS, text: "own text"}]);
    assert.deepEqual(
        decorationsIn(child),
        [{marker: "u", style: DOTTED_CSS, text: "child text"}],
        "拿整个列表项当区域的话，剥旧装饰会把子列表里的装饰一起剥掉",
    );
    cleanup();
});

// ---------------------------------------------------------------- captureOffsets / restoreOffsets

test("captureOffsets and restoreOffsets return the selection to the same text after the DOM changed", () => {
    const cleanup = mount(editor(
        `<div data-type="blocks" data-node-id="list1">
            <p data-type="text" data-node-id="p1">hello</p>
            <p data-type="text" data-node-id="p2">world</p>
        </div>`,
    ));
    const [first, second] = document.querySelectorAll("p");
    const range = select(first, 1, second, 3);
    const selected = range.toString();
    assert.ok(selected.startsWith("ello"), `夹具选区应当从前一段的中段开始：${selected}`);
    assert.ok(selected.includes("wor"), `夹具选区应当伸进后一段：${selected}`);

    const captured = captureOffsets(range);
    assert.equal(captured.length, 2);
    assert.equal(captured[0][0], first);
    assert.equal(captured[1][0], second);
    assert.deepEqual(toHost(captured.map(([, start, end]) => [start, end])), [[1, 5], [0, 3]]);

    // 模拟面板应用：块 DOM 已被装饰 span 重排，原来的 Range 早已失效
    applySpansIn(first, 1, 5, [underlineSpec()]);
    applySpansIn(second, 0, 3, [overlineSpec()]);

    restoreOffsets(captured);

    const selection = window.getSelection();
    assert.equal(selection.rangeCount, 1);
    assert.equal(selection.toString(), selected, "包裹之后选区必须还落在同一段文字上");
    // 端点相对各段的字符偏移也要回到原处，说明重建选区用的就是记下的偏移
    assert.equal(offsetIn(first, selection.anchorNode, selection.anchorOffset), 1);
    assert.equal(offsetIn(second, selection.focusNode, selection.focusOffset), 3);
    assert.ok(first.contains(selection.anchorNode), "起点必须落在第一段里");
    assert.ok(second.contains(selection.focusNode), "终点必须落在第二段里");
    cleanup();
});

test("restoreOffsets ignores an empty capture instead of throwing", () => {
    // 单独一套 jsdom：共享环境里残留的选区会让断言依赖测试执行顺序
    const fresh = createFixture();
    fresh.module.restoreOffsets([]);
    fresh.module.restoreOffsets(null);
    assert.equal(fresh.window.getSelection().rangeCount, 0);
    fresh.close();
});

// ---------------------------------------------------------------- getEventName

test("getEventName answers click on the desktop frontend", () => {
    assert.equal(getEventName(), "click");
});

test("getEventName answers touchend on the mobile frontend", () => {
    // 单独一套 jsdom：getEventName 读的是模块内的 getFrontend，与第一套互不干扰
    const mobile = createFixture({frontend: "mobile"});
    assert.equal(mobile.module.getEventName(), "touchend");
    mobile.close();
});
