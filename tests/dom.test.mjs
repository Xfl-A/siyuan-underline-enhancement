import assert from "node:assert/strict";
import test from "node:test";
import {createFixture} from "./helpers/dom.mjs";
import {toHost} from "./helpers/loadModule.mjs";

const fixture = createFixture();
const {document, window, module, mount, select, selectWithin, textNodesOf, decorationsIn, offsetIn} = fixture;
const {collectEditableGroups, stripDecorationIn, applySpansIn, captureOffsets, restoreOffsets, getEventName} = module;

// 偏移三元组在 vm realm 里造出来，投影成纯数据后搬回宿主 realm 再断言，避免跨 realm 的原型差异
const offsetsOf = (groups) => toHost(groups.map((group) => [group.start, group.end]));

// 思源编辑器里每个块各带 data-node-id，可编辑区域正是以它为界
const editor = (blocks) => `<div class="b3-editor" id="editor" contenteditable="true">${blocks}</div>`;

const UNDERLINE_CSS = "text-decoration-line: underline; text-decoration-style: solid";
const DOTTED_CSS = "text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: #0090ff";
const OVERLINE_CSS = "text-decoration-line: overline; text-decoration-style: double";
const underlineSpec = (css = UNDERLINE_CSS) => ({position: "underline", marker: "u", css});
const overlineSpec = (css = OVERLINE_CSS) => ({position: "overline", marker: "o", css});
const ZWSP = "\u200b";

const emptyTextNodes = (root) => textNodesOf(root).filter((node) => node.data === "");
const placeholderNodes = (root) => textNodesOf(root).filter((node) => node.data === ZWSP);

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

test("collectEditableGroups contributes nothing from a code block inside the selection", () => {
    const cleanup = mount(editor(
        `<p data-type="text" data-node-id="p1">abc</p>
        <div class="fn__code-block" data-type="NodeCodeBlock" data-node-id="code1">
            <pre style="display: none;"><code class="language-js">let x = 1;</code></pre>
            <pre class="hljs" style="display: block;"><code class="language-js hljs"><span class="hljs-keyword">let</span> x = 1;</code></pre>
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
