/**
 * 持久化与撤销栈：把块的完整 HTML 原样写回思源，并维护插件自有的撤销记录。
 *
 * 保存必须走 `updateBlock` 的 `dataType: "dom"`：Lute 的 Markdown 通道只保留 color /
 * background-color / font-family / font-size 四种 inline style，text-decoration 会被悄悄丢掉，
 * 界面上还看得到装饰，磁盘上的 .sy 文件里却已经没有了。dom 通道把块 HTML 原样写进 .sy。
 *
 * 思源的 Ctrl+Z 撤销栈不覆盖 `updateBlock`（它不产生事务记录），所以本模块自己留一份前后 HTML。
 */
import {fetchSyncPost} from "siyuan";

/** 一条撤销记录：把 beforeHTML 写回去就等于回到这次改动之前 */
export interface IChangeEntry {
    blockId: string;
    beforeHTML: string;
    afterHTML: string;
}

/** 防抖保存器的接口，由 createDebouncedSaver 返回 */
export interface IDebouncedSaver {
    /** 记下这次要保存的块；窗口内的后续调用只推迟发送，不覆盖已记下的块 */
    save: (blockElement: HTMLElement) => void;
    /** 立刻把记下的块发出去（面板关闭时用）；没有待保存内容时什么也不做 */
    flush: () => void;
    /** 丢弃记下的块与定时器 */
    cancel: () => void;
}

/** 保存块的接口 */
const UPDATE_BLOCK_API = "/api/block/updateBlock";

/** 块 id 的属性名；思源的每个块都带它 */
const NODE_ID_ATTRIBUTE = "data-node-id";

/** 撤销栈深上限：超出后挤掉最老的一条，更早的状态已经无从回到 */
const MAX_STACK_DEPTH = 50;

/** 会话内的撤销记录；栈顶是最近一次改动 */
const changeStack: IChangeEntry[] = [];

/**
 * 按块 id 在当前文档里现查块元素。
 *
 * 撤销栈只存 HTML 字符串，不持有 DOM 引用：块随时可能被思源重渲染，攥着旧节点只会拿到已经脱管的对象。
 * 这里逐个比对属性值而不是拼属性选择器：块 id 里一旦出现引号或反斜杠，选择器字面量会直接抛错或查不到。
 */
const findBlockElement = (blockId: string): HTMLElement => {
    const blocks = document.querySelectorAll(`[${NODE_ID_ATTRIBUTE}]`);
    for (let i = 0; i < blocks.length; i++) {
        const element = blocks[i];
        if (element.getAttribute(NODE_ID_ATTRIBUTE) === blockId) {
            return element as HTMLElement;
        }
    }
    return null;
};

/**
 * 把一份块 HTML 发给内核，返回是否保存成功。
 *
 * 网络层失败（内核未就绪、文档已关闭）与 `code !== 0` 同样算失败：调用方只认返回值，
 * 防抖路径更是无人接收 Promise，让它 reject 只会留下一串未处理的 rejection。
 */
const postBlockDOM = async (blockId: string, html: string): Promise<boolean> => {
    try {
        const result = await fetchSyncPost(UPDATE_BLOCK_API, {id: blockId, dataType: "dom", data: html});
        return result?.code === 0;
    } catch (error) {
        return false;
    }
};

/**
 * 把一个块的当前 DOM 存到内核。
 * 取不到 data-node-id 就直接失败且不发请求：那是编辑器容器或思源自己生成的临时节点，没有可寻址的块。
 */
export const saveBlockDOM = async (blockElement: HTMLElement): Promise<boolean> => {
    const blockId = blockElement?.getAttribute(NODE_ID_ATTRIBUTE);
    if (!blockId) {
        return false;
    }
    return postBlockDOM(blockId, blockElement.outerHTML);
};

/** 记下一次改动；超过栈深上限时挤掉最老的一条 */
export const recordChange = (blockId: string, beforeHTML: string, afterHTML: string): void => {
    changeStack.push({blockId, beforeHTML, afterHTML});
    if (changeStack.length > MAX_STACK_DEPTH) {
        changeStack.splice(0, changeStack.length - MAX_STACK_DEPTH);
    }
};

/** 本会话是否还有改动可回滚 */
export const hasUndoableChange = (): boolean => changeStack.length > 0;

/** 清空本会话的撤销栈；栈只对当前这一次面板会话有意义，面板关闭时调用 */
export const clearChanges = (): void => {
    changeStack.length = 0;
};

/**
 * 撤销最近一次仍然有效的改动：把 beforeHTML 写回内核，再把块 DOM 替换回去。
 *
 * 过期校验必须在写回之前完成：用户在装饰之后又编辑过该块时，记录里的 afterHTML 已经对不上当前 DOM，
 * 此时回滚会连同用户的后续编辑一起抹掉，因此丢弃该条并继续向前找。块已不在文档里（被删除、
 * 或用户已切走文档）同样无从校验与写回，一并丢弃。丢弃是必要的：留着过期记录，撤销会一直卡在它上面。
 *
 * 先落盘再改界面：写回失败时文档与界面都保持原样，记录也留着，用户还能重试。
 *
 * @returns 是否真的回滚了一条；栈空或剩余记录全部过期时为 false
 */
export const undoLastChange = async (): Promise<boolean> => {
    while (changeStack.length > 0) {
        const entry = changeStack[changeStack.length - 1];
        const blockElement = findBlockElement(entry.blockId);
        if (blockElement !== null && blockElement.outerHTML === entry.afterHTML) {
            if (!await postBlockDOM(entry.blockId, entry.beforeHTML)) {
                return false;
            }
            changeStack.pop();
            blockElement.outerHTML = entry.beforeHTML;
            return true;
        }
        changeStack.pop();
    }
    return false;
};

/**
 * 造一个防抖保存器：窗口内的连续调用只发最后一次。
 *
 * 面板的实时预览会以毫秒级连续触发（指针扫过色板就是如此），因此记下的必须是**最后一次**调用的块：
 * 留住首个实参的话，最后一次保存就被丢掉，界面上是 B 颜色而磁盘上还停在 A 颜色。
 * 记的是块元素而不是它的 HTML 快照，思源重渲染后旧快照就是过期数据。
 */
export const createDebouncedSaver = (delay: number): IDebouncedSaver => {
    let timer: number = null;
    let pendingBlock: HTMLElement = null;

    const stopTimer = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const send = (): void => {
        stopTimer();
        const blockElement = pendingBlock;
        pendingBlock = null;
        if (blockElement !== null) {
            saveBlockDOM(blockElement);
        }
    };

    return {
        save: (blockElement: HTMLElement): void => {
            pendingBlock = blockElement;
            stopTimer();
            timer = setTimeout(send, delay);
        },
        flush: send,
        cancel: (): void => {
            stopTimer();
            pendingBlock = null;
        },
    };
};
