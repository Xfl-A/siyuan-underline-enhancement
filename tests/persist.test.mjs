import {JSDOM} from "jsdom";
import assert from "node:assert/strict";
import test from "node:test";
import {
    loadModule,
    toHost,
} from "./helpers/loadModule.mjs";

const BLOCK_A = "20261003220000-a1";
const BLOCK_B = "20261003220000-b2";
// 带双引号的块 id：拼进属性选择器字面量会直接让选择器失效，验证按 id 现查没有走那条路
const BLOCK_QUOTED = '20261003220000-"q1"';

const UNDERLINE_CSS = "text-decoration-line: underline; text-decoration-style: solid";

const DECORATED_TEXT = "abc";

/** 属性值里的引号必须写成实体，否则这段标记本身就解析不出这个 id */
const escapeAttribute = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** 未装饰的块 HTML；思源每个块都带 data-node-id，模块靠它定位与写回 */
const blockHTML = (blockId, text) => `<p data-type="text" data-node-id="${escapeAttribute(blockId)}">${text}</p>`;

/** 装饰之后的块 HTML：data-sue 标记 + inline style，正是要原样落进 .sy 文件的东西 */
const decoratedHTML = (blockId, text) =>
    `<p data-type="text" data-node-id="${escapeAttribute(blockId)}">` +
    `<span data-sue="u" style="${UNDERLINE_CSS}">${text}</span></p>`;

/**
 * 可控时钟。防抖测试若依赖真实等待，慢机器上会偶发失败；这里让时间只在 advance 时前进。
 * 到期的定时器按注册顺序触发，与浏览器一致。
 */
const createClock = () => {
    let now = 0;
    let sequence = 0;
    const timers = new Map();
    return {
        setTimeout: (callback, delay = 0) => {
            sequence += 1;
            timers.set(sequence, {callback, due: now + delay});
            return sequence;
        },
        clearTimeout: (handle) => {
            timers.delete(handle);
        },
        /** 尚未触发的定时器数量 */
        pending: () => timers.size,
        advance: (ms) => {
            now += ms;
            for (const [handle, timer] of Array.from(timers)) {
                if (timer.due <= now) {
                    timers.delete(handle);
                    timer.callback();
                }
            }
        },
    };
};

/**
 * fetchSyncPost 的桩：记录每次调用的实参，并按队列给出应答。
 * 队列里放 Error 表示模拟网络层失败 —— 真实的 fetchSyncPost 在这种情况下是 reject。
 */
const createServer = () => {
    const calls = [];
    let queued = [];
    return {
        calls,
        respondWith: (...responses) => {
            queued = queued.concat(responses);
        },
        fetchSyncPost: async (url, data) => {
            calls.push({url, data});
            const response = queued.length > 0 ? queued.shift() : {code: 0, msg: "", data: null};
            if (response instanceof Error) {
                throw response;
            }
            return response;
        },
    };
};

/**
 * 每个用例一套独立的 jsdom 与独立的模块实例：撤销栈是模块级状态，共享实例会让用例互相依赖。
 */
const createFixture = () => {
    const dom = new JSDOM(
        '<!DOCTYPE html><html><body><div class="b3-editor" id="editor" contenteditable="true"></div></body></html>',
        {pretendToBeVisual: true},
    );
    const {window} = dom;
    const {document} = window;
    const editor = document.getElementById("editor");
    const server = createServer();
    const clock = createClock();
    // persist.ts 从 "siyuan" 取 fetchSyncPost，并直接读 document 与两个定时器全局，三者都要给桩
    const module = loadModule("src/persist.ts", {
        dependencies: {siyuan: {fetchSyncPost: server.fetchSyncPost}},
        globals: {document, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout},
    });

    /** 摆好编辑器内容，返回全部子元素（刻意不筛 data-node-id，否则「没有块 id」的场景根本摆不出来） */
    const mount = (...blocks) => {
        editor.innerHTML = blocks.join("");
        return Array.from(editor.children);
    };

    /** 按 data-node-id 现查块；与被测模块走同一条路径 */
    const findBlock = (blockId) =>
        Array.from(editor.querySelectorAll("[data-node-id]"))
            .find((element) => element.getAttribute("data-node-id") === blockId) ?? null;

    return {editor, mount, findBlock, server, clock, module, close: () => window.close()};
};

/** vm realm 里造出来的实参要搬回宿主 realm 才能做严格比较 */
const callOf = (call) => toHost({url: call.url, data: call.data});

// ---------------------------------------------------------------- saveBlockDOM

test("saveBlockDOM posts the block outerHTML verbatim with dataType dom", async () => {
    const {module, mount, server, close} = createFixture();
    const [block] = mount(decoratedHTML(BLOCK_A, DECORATED_TEXT));

    const saved = await module.saveBlockDOM(block);

    assert.equal(saved, true);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(callOf(server.calls[0]), {
        url: "/api/block/updateBlock",
        // dataType 必须是 dom：走 Markdown 通道时 Lute 只留 color / background-color /
        // font-family / font-size，text-decoration 会被丢掉，磁盘上的装饰随之消失
        data: {id: BLOCK_A, dataType: "dom", data: block.outerHTML},
    });
    // 断言不是自证：发出去的 data 必须真的带着装饰样式
    assert.ok(callOf(server.calls[0]).data.data.includes("text-decoration-line: underline"));
    close();
});

test("saveBlockDOM reports failure when the kernel answers with a non-zero code", async () => {
    const {module, mount, server, close} = createFixture();
    server.respondWith({code: -1, msg: "read-only", data: null});
    const [block] = mount(blockHTML(BLOCK_A, DECORATED_TEXT));

    assert.equal(await module.saveBlockDOM(block), false);
    // 请求照发，只是结果为失败：调用方只凭返回值决定要不要提示
    assert.equal(server.calls.length, 1);
    assert.equal(callOf(server.calls[0]).url, "/api/block/updateBlock");
    close();
});

test("saveBlockDOM sends nothing at all when the element carries no data-node-id", async () => {
    const {module, mount, server, close} = createFixture();
    // 编辑器容器、思源自己生成的临时节点都没有块 id，也就没有可寻址的目标
    const [block] = mount('<p data-type="text">没有块 id</p>');

    assert.equal(await module.saveBlockDOM(block), false);
    assert.equal(server.calls.length, 0, "缺少块 id 时连请求都不该发");
    close();
});

test("saveBlockDOM reports failure instead of rejecting when the request never reaches the kernel", async () => {
    const {module, mount, server, close} = createFixture();
    server.respondWith(new Error("network down"));
    const [block] = mount(blockHTML(BLOCK_A, DECORATED_TEXT));

    assert.equal(await module.saveBlockDOM(block), false);
    assert.equal(server.calls.length, 1);
    close();
});

// ---------------------------------------------------------------- createDebouncedSaver

test("createDebouncedSaver collapses a burst of previews into one request carrying the newest block", () => {
    const {module, mount, server, clock, close} = createFixture();
    const saver = module.createDebouncedSaver(300);
    // 指针扫过色板时思源可能已重渲染过块，save 拿到的是一个个不同的元素实例
    const [first] = mount(blockHTML(BLOCK_A, "A"));
    const [second] = mount(blockHTML(BLOCK_A, "B"));
    const [third] = mount(blockHTML(BLOCK_A, "C"));

    saver.save(first);
    saver.save(second);
    saver.save(third);
    clock.advance(299);
    assert.equal(server.calls.length, 0, "窗口未到不能发请求");

    clock.advance(1);

    assert.equal(server.calls.length, 1, "一串连击只应合并成一次请求");
    // 防抖若留住首个实参，这里发出去的就是已经过期的 first，界面是 C 而磁盘上还停在 A
    assert.equal(callOf(server.calls[0]).data.data, third.outerHTML, "必须发最后一次调用的实参");
    assert.notEqual(callOf(server.calls[0]).data.data, first.outerHTML);
    assert.deepEqual(callOf(server.calls[0]).data, {id: BLOCK_A, dataType: "dom", data: third.outerHTML});
    close();
});

test("createDebouncedSaver flush sends the newest block at once instead of waiting out the window", () => {
    const {module, mount, server, clock, close} = createFixture();
    const saver = module.createDebouncedSaver(300);
    const [first] = mount(blockHTML(BLOCK_A, "A"));
    const [second] = mount(blockHTML(BLOCK_A, "B"));

    saver.save(first);
    saver.save(second);
    saver.flush();

    assert.equal(server.calls.length, 1, "面板关闭时的最后一次保存不能等窗口");
    assert.equal(callOf(server.calls[0]).data.data, second.outerHTML);
    clock.advance(300);
    assert.equal(server.calls.length, 1, "已经 flush 出去的内容不能再补发一次");
    close();
});

test("createDebouncedSaver flush does nothing when no save is pending", () => {
    const {module, server, clock, close} = createFixture();
    const saver = module.createDebouncedSaver(300);

    saver.flush();

    assert.equal(server.calls.length, 0);
    clock.advance(1000);
    assert.equal(server.calls.length, 0);
    close();
});

test("createDebouncedSaver cancel drops both the pending block and its timer", () => {
    const {module, mount, server, clock, close} = createFixture();
    const saver = module.createDebouncedSaver(300);
    const [block] = mount(blockHTML(BLOCK_A, "A"));

    saver.save(block);
    saver.cancel();
    clock.advance(1000);

    assert.equal(server.calls.length, 0);
    assert.equal(clock.pending(), 0, "取消必须把定时器一并清掉，不能让它空跑到点");
    close();
});

// ---------------------------------------------------------------- 撤销栈

test("recordChange makes the session undoable", () => {
    const {module, mount, close} = createFixture();
    const [block] = mount(blockHTML(BLOCK_A, "a0"));
    assert.equal(module.hasUndoableChange(), false, "没有记录时不能报可撤销");

    module.recordChange(BLOCK_A, block.outerHTML, decoratedHTML(BLOCK_A, "a0"));

    assert.equal(module.hasUndoableChange(), true);
    close();
});

test("clearChanges empties the session undo stack", () => {
    const {module, mount, close} = createFixture();
    const [blockA, blockB] = mount(blockHTML(BLOCK_A, "a0"), blockHTML(BLOCK_B, "b0"));
    module.recordChange(BLOCK_A, blockA.outerHTML, decoratedHTML(BLOCK_A, "a0"));
    module.recordChange(BLOCK_B, blockB.outerHTML, decoratedHTML(BLOCK_B, "b0"));
    assert.equal(module.hasUndoableChange(), true);

    module.clearChanges();

    assert.equal(module.hasUndoableChange(), false, "面板关闭要清掉当前会话的栈");
    close();
});

test("undoLastChange writes beforeHTML back to the kernel and replaces the block DOM", async () => {
    const {module, mount, findBlock, server, close} = createFixture();
    const [block] = mount(blockHTML(BLOCK_A, "a0"));
    const beforeHTML = block.outerHTML;
    // 模拟面板应用装饰：块 DOM 被重排，随后保存到服务端
    block.innerHTML = `<span data-sue="u" style="${UNDERLINE_CSS}">a0</span>`;
    module.recordChange(BLOCK_A, beforeHTML, block.outerHTML);
    assert.equal(await module.saveBlockDOM(block), true);
    server.calls.length = 0;

    const undone = await module.undoLastChange();

    assert.equal(undone, true);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(callOf(server.calls[0]), {
        url: "/api/block/updateBlock",
        data: {id: BLOCK_A, dataType: "dom", data: beforeHTML},
    });
    assert.equal(block.isConnected, false, "块 DOM 必须被整体替换，而不是就地改写");
    assert.equal(findBlock(BLOCK_A).outerHTML, beforeHTML, "界面上的块必须回到装饰之前");
    assert.equal(module.hasUndoableChange(), false);
    close();
});

test("undoLastChange skips a stale entry instead of overwriting edits made after the change", async () => {
    const {module, mount, findBlock, server, close} = createFixture();
    mount(blockHTML(BLOCK_A, "a0"), blockHTML(BLOCK_B, "b0"));
    const a0 = findBlock(BLOCK_A).outerHTML;
    const b0 = findBlock(BLOCK_B).outerHTML;
    module.recordChange(BLOCK_A, a0, decoratedHTML(BLOCK_A, "a0"));
    module.recordChange(BLOCK_B, b0, decoratedHTML(BLOCK_B, "b0"));
    mount(decoratedHTML(BLOCK_A, "a0"), decoratedHTML(BLOCK_B, "b0"));
    // 用户在装饰之后又在 B 块里接着打字：记录里的 afterHTML 已经对不上当前 DOM
    const blockB = findBlock(BLOCK_B);
    blockB.appendChild(blockB.ownerDocument.createTextNode("后来补的字"));
    const bText = blockB.textContent;

    const undone = await module.undoLastChange();

    assert.equal(undone, true, "过期的那条要跳过，继续向前找到仍然可用的一条");
    assert.equal(server.calls.length, 1, "过期的那条不能发出请求");
    assert.deepEqual(callOf(server.calls[0]).data, {id: BLOCK_A, dataType: "dom", data: a0});
    assert.equal(findBlock(BLOCK_A).outerHTML, a0, "向前找到的可用记录必须真的回滚");
    assert.equal(findBlock(BLOCK_B).textContent, bText, "用户的后续编辑不能被覆盖");
    assert.equal(module.hasUndoableChange(), false, "过期记录应被丢弃，否则撤销会一直卡在它上面");
    close();
});

test("undoLastChange drops an entry whose block is no longer in the document", async () => {
    const {module, mount, findBlock, server, close} = createFixture();
    mount(blockHTML(BLOCK_A, "a0"), blockHTML(BLOCK_B, "b0"));
    const a0 = findBlock(BLOCK_A).outerHTML;
    module.recordChange(BLOCK_A, a0, decoratedHTML(BLOCK_A, "a0"));
    module.recordChange(BLOCK_B, blockHTML(BLOCK_B, "b0"), decoratedHTML(BLOCK_B, "b0"));
    // B 块被删除、或用户已切走文档：这条记录再也无从校验与写回
    mount(decoratedHTML(BLOCK_A, "a0"));

    const undone = await module.undoLastChange();

    assert.equal(undone, true);
    assert.equal(server.calls.length, 1);
    assert.equal(callOf(server.calls[0]).data.id, BLOCK_A);
    assert.equal(module.hasUndoableChange(), false);
    close();
});

test("undoLastChange finds a block whose node id would not survive a selector lookup", async () => {
    const {module, editor, mount, findBlock, server, close} = createFixture();
    mount(blockHTML(BLOCK_QUOTED, "q0"));
    const beforeHTML = findBlock(BLOCK_QUOTED).outerHTML;
    module.recordChange(BLOCK_QUOTED, beforeHTML, decoratedHTML(BLOCK_QUOTED, "q0"));
    mount(decoratedHTML(BLOCK_QUOTED, "q0"));
    // 夹具前提：把这个 id 拼进属性选择器字面量会直接抛错，被测实现一旦走那条路，用例就红
    assert.throws(() => editor.querySelector(`[data-node-id="${BLOCK_QUOTED}"]`));

    const undone = await module.undoLastChange();

    assert.equal(undone, true);
    assert.equal(callOf(server.calls[0]).data.data, beforeHTML);
    assert.equal(findBlock(BLOCK_QUOTED).outerHTML, beforeHTML);
    close();
});

test("undoLastChange keeps the record and the DOM untouched when the write-back fails", async () => {
    const {module, mount, findBlock, server, close} = createFixture();
    const [block] = mount(blockHTML(BLOCK_A, "a0"));
    const beforeHTML = block.outerHTML;
    block.innerHTML = `<span data-sue="u" style="${UNDERLINE_CSS}">a0</span>`;
    const afterHTML = block.outerHTML;
    module.recordChange(BLOCK_A, beforeHTML, afterHTML);
    server.respondWith({code: -1, msg: "read-only", data: null});

    assert.equal(await module.undoLastChange(), false);
    assert.equal(module.hasUndoableChange(), true, "写回失败不能把记录丢掉，用户还得有机会重试");
    assert.equal(findBlock(BLOCK_A).outerHTML, afterHTML, "写回失败时不得动界面");
    close();
});

test("undoLastChange returns false on an empty stack without touching the kernel", async () => {
    const {module, server, close} = createFixture();

    assert.equal(await module.undoLastChange(), false);
    assert.equal(server.calls.length, 0);
    close();
});

test("undoLastChange rolls back no further than the oldest entry left once 60 changes were recorded", async () => {
    const {module, editor, findBlock, server, close} = createFixture();
    const stateHTML = (step) => blockHTML(BLOCK_A, `step-${step}`);
    // 每改一次就落一次盘：块 DOM 跟着前进，撤销栈与真实状态同步增长
    for (let step = 1; step <= 60; step++) {
        editor.innerHTML = stateHTML(step - 1);
        module.recordChange(BLOCK_A, stateHTML(step - 1), stateHTML(step));
        editor.innerHTML = stateHTML(step);
    }
    assert.equal(findBlock(BLOCK_A).outerHTML, stateHTML(60));

    let undone = 0;
    while (await module.undoLastChange()) {
        undone++;
        assert.ok(undone <= 50, "栈深上限是 50，不可能撤销出更多次");
    }

    assert.equal(undone, 50, "压入 60 条后只剩最近 50 条可回滚");
    // 第 1..10 条已被挤出，最深只能回到第 11 条记录之前的那个状态
    assert.equal(findBlock(BLOCK_A).outerHTML, stateHTML(10));
    assert.equal(module.hasUndoableChange(), false);
    assert.equal(server.calls.length, 50);
    close();
});
