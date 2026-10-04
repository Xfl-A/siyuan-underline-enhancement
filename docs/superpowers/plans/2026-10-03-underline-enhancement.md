# 下划线增强（siyuan-underline-enhancement）实施计划

> **本文档是 2026-10-03 的执行记录，其中两项已在发布前作废，照着做会走错：**
>
> 1. **上划线方向**（2026-10-04，用户删除）。只保留下划线，`IDecorationPair` 塌成单个 `IDecoration`，
>    嵌套 span 路径移除。凡提到「两个方向」「上划线」的任务与断言都已不适用。
> 2. **`data-sue` 标记属性**（2026-10-04）。思源存盘会丢弃自定义属性，改为按 `text-decoration-line` 识别。
>
> 模块划分（`model.ts` / `dom.ts` / `persist.ts` / `panel.ts` / `index.ts`）与保存通道仍与实现一致。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为思源笔记构建一个编辑器插件，在 Protyle 浮动工具栏加入「下划线增强」按钮，用 CSS `text-decoration` 为选中文本分别设置下划线与上划线的线型和颜色，设置实时预览。

**Architecture:** 纯逻辑（样式模型 ↔ CSS 转换）放在 `model.ts`，DOM 手术放在 `dom.ts`，持久化与撤销放在 `persist.ts`，面板 UI 放在 `panel.ts`，`index.ts` 只做生命周期与接线。装饰以 **inline style** 写在 span 上（不用 class），因此插件未加载时（只读模式、发布服务）依然正确渲染。保存走 `/api/block/updateBlock` + `dataType: "dom"`，原样写入 `.sy`。

**Tech Stack:** TypeScript、webpack 5 + esbuild-loader、Node 内置 `node:test`、`jsdom`（仅测试用）、pnpm/npm。

**Spec:** `docs/superpowers/specs/2026-10-03-underline-enhancement-design.md`

## Global Constraints

- 包名固定为 `siyuan-underline-enhancement`，`plugin.json` 的 `name`、仓库名、`package.json` 的 `name` 三处必须一致。
- `minAppVersion` 固定为 `"3.8.6"` —— 唯一功能所依赖的 `addToolbarItem` API 在 petal v1.2.7（思源 3.8.6）才引入，版本号不得下调。
- 线型枚举固定为 `solid` / `dashed` / `dotted` / `double` / `wavy`，顺序即面板展示顺序，不得增删。
- 「跟随文字颜色」的实现是**不输出** `text-decoration-color`，依赖 CSS `currentColor`。不得用 `currentColor` 字面量代替省略。
- 颜色白名单：仅接受 `#rgb`、`#rgba`、`#rrggbb`、`#rrggbbaa`、`var(--b3-...)`。其余一律视为非法并回退为空字符串（跟随文字色）。这条是防 CSS 注入，不可放宽。
- 装饰 span 必须带 `data-sue="u"`（下划线）或 `data-sue="o"`（上划线）标记属性；带 `data-sue="b"`（合并）表示同时承载两个方向。
  **（已于 2026-10-04 作废）** 思源解析块 HTML 存 `.sy` 时会丢弃自定义属性，只把 `text-decoration-*` 原样存进 `NodeTextMark` 的 `Properties.style`。靠标记识别会让插件在块存过一次之后彻底认不出自己的装饰。改为按 `text-decoration-line` 识别，且不写标记。
- 所有写入 inline style 的值必须先过 `sanitizeColor`，包括从 `loadData` 读回的设置。
- 面板与编辑器交互的事件名必须经**本地** `getEventName()` 辅助函数取得（`src/dom.ts` 导出）：`getFrontend() === "mobile"` 返回 `"touchend"`，否则返回 `"click"`。
  **注意**：思源内部的 `getEventName`（`app/src/protyle/util/compatibility.ts`）并**未**导出到 petal 公开类型，不可从 `siyuan` 包 import；必须自己用 `getFrontend()` 实现。这是本计划唯一允许的移动端事件名来源。
- 面板内禁止使用 `:has()` 选择器（思源工程约定）。
- 面板控件外观必须复用思源既有类（`b3-button`、`b3-switch`、`b3-text-field` 等），feature 样式只描述布局，不重造控件外观。
- 代码注释用中文，不引用「旧实现」，单行不超过 120 字符。
- 每个任务结束必须提交，提交信息用 gitmoji 前缀 + 英文主题。

## Review Focus

以下五类是规格隐含、但没有任何任务的测试覆盖、最可能咬到真实用户的输入或状态。每个都已在对应任务里补上测试。

1. **选区只部分覆盖已有装饰 span** —— 例如从某个已加下划线的词的中间拖到该词之外再拖回来。偏移换算若不精确，会重复包裹尾段或吃掉尾段。→ 归 Task 3。
2. **装饰 span 内立即继续输入文字** —— 应用后光标停在 span 内，用户接着打字。可测的根因是包裹遗留的空文本节点 / ZWSP 与 `normalize()` 处理不当：它会让思源按偏移算光标时偏位。可测表面为「应用后无可编辑区域内不含空文本节点，且选区往返一致」，已列入 Task 3 Step 2 的后两条用例。→ 归 Task 3。
3. **选区包含代码块 / 数学块 / 数据库（`.av`）** —— 代码高亮会重绘并抹掉自定义 span，若不跳过就会污染代码或让高亮失效。→ 归 Task 3。
4. **快速连续预览（指针扫过色板）** —— 悬停预览会以毫秒级连续触发，防抖若只保留最后一次的样式却丢掉最后一次的保存，会出现「界面是 B 颜色、磁盘上还是 A 颜色」。→ 归 Task 4。
5. **用户在装饰之后又编辑了该块，然后按撤销** —— 撤销记录里的 `afterHTML` 已过期，直接回滚会覆盖用户的后续编辑。→ 归 Task 4。

---

### Task 1: 从模板搭建插件骨架并让构建通过

**Files:**
- Create: `package.json`、`tsconfig.json`、`.gitignore`、`.dprint.json`、`eslint.config.mjs`、`webpack.config.js`
- Create: `plugin.json`
- Create: `src/index.ts`（占位，后续任务替换）
- Create: `src/index.scss`（占位）
- Create: `src/i18n/en.json`、`src/i18n/zh-CN.json`
- Create: `tests/smoke.test.mjs`
- Delete: 从模板继承的多余文件（`src/kernel.ts`、`webpack.kernel.config.js`、`src/siyuan-publish.d.ts`、`tests/publish.test.mjs`、`src/declarations.d.ts`）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 可运行的构建产物 `index.js` / `index.css`；`src/index.ts` 导出一个 `export default class extends Plugin`，供后续任务填充。`npm run build` 与 `npm test` 两个命令存在且可通过。

- [ ] **Step 1: 从模板拷贝骨架文件**

```bash
git clone --depth 1 https://github.com/siyuan-note/plugin-sample.git _template
```

保留 `_template/package.json`、`tsconfig.json`、`.gitignore`、`.dprint.json`、`eslint.config.mjs`、`webpack.config.js`、`src/declarations.d.ts`；删除 `_template/src/kernel.ts`、`_template/webpack.kernel.config.js`、`_template/src/siyuan-publish.d.ts`、`_template/tests/`。拷贝 `icon.png` 与 `preview.png` 作为占位图。

不要保留 `_template` 目录本身进版本库（已在 `.gitignore`）。

- [ ] **Step 2: 写 `package.json`**

基于模板改动三处：
- `name` 改为 `siyuan-underline-enhancement`
- 删除 `packageManager` 字段（改用 npm，见下方说明），`scripts` 只保留下面四项
- `devDependencies` 在模板基础上**新增 `"jsdom": "^26.0.0"`**（Task 3 起需要）

```json
"scripts": {
    "format": "dprint fmt",
    "format:check": "dprint check",
    "lint": "eslint . --fix --cache",
    "test": "node --test tests/*.test.mjs",
    "dev": "webpack --config webpack.config.js --mode development",
    "build": "webpack --config webpack.config.js --mode production"
}
```

> **为何用 npm 而非模板的 pnpm**：模板声明 `packageManager: pnpm@11.4.0`，但本机 `pnpm` 未安装、需经 corepack 引导，多一层失败点。本项目无特殊 pnpm 依赖，npm 完全够用。若用户环境已有 pnpm，把 `packageManager` 字段加回即可，脚本无需改动。

`devDependencies` 保留模板全部条目（`typescript`、`webpack`、`esbuild-loader`、`sass`、`mini-css-extract-plugin`、`copy-webpack-plugin`、`zip-webpack-plugin`、`eslint`、`dprint`、`@eslint/js`、`typescript-eslint` 等），仅把 `siyuan` 依赖保持在 `^1.2.8`。

- [ ] **Step 3: 写 `plugin.json`**

```json
{
  "name": "siyuan-underline-enhancement",
  "author": "your-name",
  "url": "https://github.com/your-name/siyuan-underline-enhancement",
  "version": "0.1.0",
  "minAppVersion": "3.8.6",
  "kernels": ["all"],
  "backends": ["all"],
  "frontends": ["all"],
  "disabledInPublish": false,
  "publish": {"resources": [], "data": []},
  "displayName": {"default": "Underline Enhancement", "zh-CN": "下划线增强"},
  "description": {
    "default": "Configure underline and overline line styles and colors from the editor floating toolbar.",
    "zh-CN": "在编辑器浮动工具栏中分别设置下划线与上划线的线型和颜色。"
  },
  "readme": {"default": "README.md", "zh-CN": "README.zh-CN.md"},
  "icon": "icon.png",
  "preview": "preview.png",
  "keywords": ["下划线", "上划线", "线型", "编辑器", "underline", "overline", "decoration", "editor"]
}
```

`disabledInPublish` 必须为 `false`；`publish.data` 为空数组（不声明任何私有字段给发布端）。

- [ ] **Step 4: 写 i18n 文件**

`src/i18n/en.json` 与 `src/i18n/zh-CN.json` 写入**完整**文案集合（键必须两种语言完全一致，缺一即构建后显示原始键名）：

| 键 | en | zh-CN |
|---|---|---|
| `underlineEnhancement` | Underline Enhancement | 下划线增强 |
| `underline` | Underline | 下划线 |
| `overline` | Overline | 上划线 |
| `lineStyle` | Line style | 线型 |
| `color` | Color | 颜色 |
| `followTextColor` | Follow text color | 跟随文字颜色 |
| `customColor` | Custom color | 自定义颜色 |
| `clearDecoration` | Clear decoration | 清除装饰 |
| `undo` | Undo | 撤销 |
| `saveFailed` | Unable to save the decoration | 装饰保存失败 |

- [ ] **Step 5: 写占位 `src/index.ts` 与 `src/index.scss`**

`src/index.ts` 导出一个空的 Plugin 子类，生命周期方法全部留空并带中文注释说明由后续任务实现。`src/index.scss` 暂时只有一个注释块。

- [ ] **Step 6: 写 `tests/smoke.test.mjs`**

断言两件事：i18n 两个文件的键集合完全相同；`plugin.json` 的 `name` 与 `package.json` 的 `name` 相等且为 `siyuan-underline-enhancement`。

- [ ] **Step 7: 安装依赖**

```bash
npm install
```

Expected: 安装完成，无 `ERESOLVE` 错误。

- [ ] **Step 8: 运行测试**

Run: `npm test`
Expected: PASS，smoke 测试通过。

- [ ] **Step 9: 运行构建**

Run: `npm run build`
Expected: 生成 `index.js`、`index.css`、`dist/`、`package.zip`，webpack 无 error。若 `zip-webpack-plugin` 报缺 `LICENSE` 文件，从模板 `LICENSE` 拷贝一份到仓库根。

- [ ] **Step 10: 提交**

```bash
git add -A && git commit -m "feat: scaffold plugin from template"
```

---

### Task 2: 装饰样式模型（纯逻辑）

本任务只写不碰 DOM 的纯函数，是整个插件里唯一有真正算法复杂度的部分。

**Files:**
- Create: `src/model.ts`
- Create: `tests/model.test.mjs`
- Create: `tests/helpers/loadModule.mjs`

**Interfaces:**
- Consumes: 无
- Produces: 供 Task 3/4/5/6 使用的类型与函数（签名见下）

```ts
export type TLineStyle = "solid" | "dashed" | "dotted" | "double" | "wavy";
export type TLinePosition = "underline" | "overline" | "both";
export type TSueMarker = "u" | "o" | "b";

export interface IDecoration { enabled: boolean; style: TLineStyle; color: string; }
export interface IDecorationPair { underline: IDecoration; overline: IDecoration; }
export interface ISpanSpec { position: TLinePosition; marker: TSueMarker; css: string; }

export const LINE_STYLES: readonly TLineStyle[];
export const PRESET_COLORS: readonly string[];
export const DEFAULT_PAIR: IDecorationPair;

export const isValidColor(value: unknown): boolean;
export const sanitizeColor(value: unknown): string;
export const sanitizePair(value: unknown): IDecorationPair;

export const buildDecorationCSS(decoration: IDecoration, position: TLinePosition): string;
export const composePair(pair: IDecorationPair): ISpanSpec[];
export const parseDecorationStyle(css: string, position: TLinePosition): IDecoration;
export const readPairFromStyle(underlineCSS: string | null, overlineCSS: string | null): IDecorationPair;
export const isSamePair(a: IDecorationPair, b: IDecorationPair): boolean;
```

- [ ] **Step 1: 写测试加载器 `tests/helpers/loadModule.mjs`**

沿用 plugin-sample 的手法：读 `.ts` 源码 → `ts.transpileModule` 转 CommonJS → `node:vm` 的 `runInNewContext` 执行 → 返回其 `exports`。签名：

```js
export const loadModule = (relativePath) => { ... }   // 相对于仓库根，返回 transpiled 模块的 exports
```

- [ ] **Step 2: 写失败的测试 `tests/model.test.mjs`**

必须包含以下用例（名称即断言意图）：

- `composePair` 两方向均 disabled → 返回 `[]`
- `composePair` 仅下划线启用 → 长度 1，`marker === "u"`，`position === "underline"`
- `composePair` 仅上划线启用 → 长度 1，`marker === "o"`
- `composePair` 两方向 style 与 color 完全相同 → 长度 1，`marker === "b"`，`position === "both"`，css 含 `text-decoration-line: underline overline`
- `composePair` 两方向仅 color 不同 → 长度 2，`[0].marker === "o"`、`[1].marker === "u"`（**外层是上划线**）
- `composePair` 两方向仅 style 不同 → 长度 2，顺序同上
- `buildDecorationCSS` color 为空串 → 输出**不含** `text-decoration-color`
- `buildDecorationCSS` color 为 `#e5484d` → 含 `text-decoration-color: #e5484d`
- `buildDecorationCSS` position 为 `"both"` → 含 `text-decoration-line: underline overline`
- 属性输出顺序固定为 line → style → color
- `sanitizeColor("red;position:fixed")` → `""`（CSS 注入防线，**最高优先级用例**）
- `sanitizeColor("#abc")` / `"#aabbcc"` / `"#aabbccdd"` / `"var(--b3-font-color8)"` → 原样返回
- `sanitizeColor("currentColor")` → `""`（跟随文字色必须靠省略实现，不写字面量）
- `sanitizePair(null)`、��� `sanitizePair({})` → 等于 `DEFAULT_PAIR`
- `sanitizePair({underline: {enabled: "yes", style: "zigzag", color: 42}})` → 三项全部回退到默认
- `parseDecorationStyle("text-decoration: underline wavy red", "underline")` → `{enabled: true, style: "wavy", color: "red 或经 sanitize 后的值}`
- `parseDecorationStyle` 显式长属性覆盖简写
- `parseDecorationStyle("", "underline")` → `enabled: false`
- **往返测试**：`readPairFromStyle(composePair(p)[0].css, composePair(p)[1]?.css ?? null)` 得到的 pair 与 `p` 等价（对 4 种组合各测一次）
- `isSamePair` 在 color 不同时返回 false

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL，报 `src/model.ts` 不存在或导出缺失。

- [ ] **Step 4: 实现 `src/model.ts`**

实现要点（签名已定，正文由实现者决定）：

- `sanitizeColor` 用一条正则 `^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|var\(--b3-[A-Za-z0-9_-]+\))$` 判定，必须整体锚定。
- CSS 声明解析需处理引号与括号内的分号（参考 Lute `HTMLStyleDeclarations` 的思路），不能直接 `split(";")`。
- `buildDecorationCSS` 的 color 取自 `sanitizeColor(decoration.color)`，非法值自然退化为「省略」。
- `composePair` 判「两方向相同」时比较 `style` 与 `color` 两个字段（`enabled` 此刻已都为 true）。
- `parseDecorationStyle` 需同时支持简写 `text-decoration` 与长属性 `text-decoration-line/-style/-color`，长属性优先。简写里按关键字表拆出 line / style，剩余合法颜色 token 作为 color。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/model.ts tests/ && git commit -m "feat: add decoration style model"
```

---

### Task 3: DOM 包裹与选区处理

**Files:**
- Create: `src/dom.ts`
- Create: `tests/dom.test.mjs`
- Create: `tests/helpers/dom.mjs`

**Interfaces:**
- Consumes: Task 2 的 `ISpanSpec`、`TLinePosition`、`IDecorationPair`
- Produces:

```ts
export interface IEditableGroup { editableElement: HTMLElement; blockElement: HTMLElement; start: number; end: number; }

export const collectEditableGroups = (range: Range): IEditableGroup[];
export const stripDecorationIn = (editableElement: HTMLElement): void;
export const applySpansIn = (editableElement: HTMLElement, start: number, end: number, specs: ISpanSpec[]): void;
export const captureOffsets = (range: Range): Array<[HTMLElement, number, number]>;
export const restoreOffsets = (captured: Array<[HTMLElement, number, number]>): void;

/** 返回当前前端应使用的事件名：移动端 "touchend"，其余 "click"。 */
export const getEventName = (): string;
```

`start` / `end` 是相对 `editableElement.textContent` 的字符偏移。`applySpansIn` 的 `specs` 按**外层在前**排列（与 `composePair` 一致），实现须从末尾向前包裹。

- [ ] **Step 1: 写 jsdom 夹具 `tests/helpers/dom.mjs`**

导出一个函数把 HTML 片段塞进 jsdom 的 `document.body`，返回清理函数。夹具需能构造：普通段落、含 `<strong>` 的段落、表格 `<table><tr><td>`、代码块（`data-type="NodeCodeBlock"`）、`.av` 容器、含 `data-sue` 装饰 span 的段落。

- [ ] **Step 2: 写失败的测试 `tests/dom.test.mjs`**

必须包含：

- `collectEditableGroups` 单段落选区 → 返回 1 组，`start`/`end` 覆盖选中文字
- `collectEditableGroups` 跨两个段落 → 返回 2 组
- `collectEditableGroups` 跨两个表格单元格 → 返回 2 组，各自 `editableElement` 为对应 `TD`
- `collectEditableGroups` 选区含代码块 → 代码块内文本不出现在任何组里
- `collectEditableGroups` 选区含 `.av` → 同上被跳过
- `stripDecorationIn` 拆掉 `data-sue` span 后 `editableElement.textContent` **完全不变**（Review Focus 1、2）
- `stripDecorationIn` 不动没有 `data-sue` 的 `<strong>` / `<a>`
- `applySpansIn` 单 spec → 选中文本被包一层 span，未选中的相邻文字未被包
- `applySpansIn` 双 spec（`o` 在前 `u` 在后）→ 产出嵌套结构，外层 `text-decoration-line: overline`、内层 `underline`（原写作 `data-sue` 标记，该机制已于 2026-10-04 作废，见上文）
- `applySpansIn` 空 specs → 移除已有装饰
- **`applySpansIn` 部分重叠**：先把 `abc` 整体加下划线，再对 `bc` 加新样式 → 结果 `a` 无装饰、`bc` 为新样式、文本内容不变（Review Focus 1）
- `applySpansIn` 不产生空文本节点，且 `<strong>` 兄弟元素保持原有嵌套
- `captureOffsets` / `restoreOffsets` 往返后选区文本一致（Review Focus 2）

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 4: 实现 `src/dom.ts`**

实现要点：

- **偏移法而非 Range 搬运**：因为 `stripDecorationIn` 拆 span 不改变 `textContent`，所以先剥后包时偏移始终有效。`collectEditableGroups` 计算偏移；`applySpansIn` 内部自行遍历文本节点把偏移还原成 `Range`。
- `collectEditableGroups` 的可编辑区域判定按优先级：表格 `TD`/`TH` → callout / tab-item 的 `:scope > .callout-info > .callout-title` → `closest("[data-node-id]")` 自身。跳过 `NodeCodeBlock`、`.av`、`.hljs`、数学块内的文本。
- `applySpansIn` 包裹写法：对每个 spec（从末尾向前）建 `span`，写 `data-sue` 与 `style`，`appendChild(range.extractContents())` 后 `range.insertNode(span)`，再 `range.selectNode(span)` 供下一层包裹。
- `applySpansIn` 结束前对 `editableElement` 调 `normalize()` 合并多余文本节点，再清掉 `Constants.ZWSP` 造成的空节点（ZWSP 字面量为 `\u200b`）。这一步是 Review Focus 2 的落点：残留空文本节点会让用户在装饰内继续打字时思源的光标计算出错。
- `getEventName()` 用 `import { getFrontend } from "siyuan"` 判断前端类型，**不要**试图从 `siyuan` 包 import 思源内部的 `getEventName`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/dom.ts tests/ && git commit -m "feat: add decoration DOM application"
```

---

### Task 4: 持久化与撤销栈

**Files:**
- Create: `src/persist.ts`
- Create: `tests/persist.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `IDecorationPair`（不直接需要，实际只存取 HTML 字符串）
- Produces:

```ts
export interface IChangeEntry { blockId: string; beforeHTML: string; afterHTML: string; }

export const recordChange = (blockId: string, beforeHTML: string, afterHTML: string): void;
export const undoLastChange = (): Promise<boolean>;
export const hasUndoableChange = (): boolean;
export const clearChanges = (): void;

export const saveBlockDOM = (blockElement: HTMLElement): Promise<boolean>;
export const createDebouncedSaver = (delay: number) => (
    save: (blockElement: HTMLElement) => void, flush: () => void, cancel: () => void);
```

- [ ] **Step 1: 写失败的测试 `tests/persist.test.mjs`**

用 mock 替换全局 `fetchSyncPost`，断言其被调用时参数为 `{ id, dataType: "dom", data }` 且 `data` 等于 `blockElement.outerHTML`。必须包含：

- `saveBlockDOM` 调用 `fetchSyncPost` 且 `dataType === "dom"`
- `saveBlockDOM` 在 `code !== 0` 时返回 `false`
- **debounce 合并**：300ms 内连调三次 `save`，只发一次请求；`flush()` 后立即发出最新一次的值（Review Focus 4）
- `recordChange` 后 `hasUndoableChange()` 为 true
- `undoLastChange` 把 `beforeHTML` 写回服务端并替换 DOM
- **`undoLastChange` 跳过过期记录**：块当前 `outerHTML` 不等于 `afterHTML` 时不写回，继续向前找（Review Focus 5）
- 栈空时 `undoLastChange` 返回 `false`
- `clearChanges` 清空栈
- 栈深上限 50：压入 60 条后 `undoLastChange` 只回滚到第 11 条对应的状态

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/persist.ts`**

要点：

- `saveBlockDOM` 用 `fetchSyncPost("/api/block/updateBlock", { id, dataType: "dom", data })`；`id` 取 `blockElement.getAttribute("data-node-id")`，缺失则直接返回 `false` 不发请求。
- 撤销栈存块 `blockElement` 的**弱引用**或每次现查 DOM（`document.querySelector` + `CSS.escape`），不要长期持有 DOM 引用。
- `undoLastChange` 的过期校验必须在写回**之前**完成。
- debounce 实现要保证「最后一次调用的实参」被保留（用闭包存最新 `blockElement`，而不是存首个定时器的实参）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/persist.ts tests/ && git commit -m "feat: add persistence and undo stack"
```

---

### Task 5: 浮动面板

**Files:**
- Create: `src/panel.ts`
- Modify: `src/index.scss`
- Create: `tests/panel.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `IDecorationPair`、`LINE_STYLES`、`PRESET_COLORS`、`sanitizeColor`、`isSamePair`；Task 3 的 `getEventName`
- Produces:

```ts
export interface IPanelOptions {
    anchor: HTMLElement;
    initialPair: IDecorationPair;
    i18n: Record<string, string>;
    undoEnabled: boolean;
    onChange: (pair: IDecorationPair) => void;
    onClear: () => void;
    onUndo: () => void;
    onClose: () => void;
}
export interface IPanelController {
    getPair: () => IDecorationPair;
    destroy: () => void;
}
export const createPanel = (options: IPanelOptions): IPanelController;
```

- [ ] **Step 1: 写失败的测试 `tests/panel.test.mjs`**

用 jsdom 构造，模拟点击。必须包含：

- 面板 DOM 含两个方向区块，各自有一个开关、5 个线型色块、1 个「跟随文字色」色块、10 个预设色块、1 个 `<input type="color">`
- 打开时开关的 checked 状态与 `initialPair` 一致
- 点击线型色块 → `onChange` 收到的 pair 该方向 `style` 已更新
- 点击开关关闭某方向 → `onChange` 收到该方向 `enabled: false`
- 点击预设色块 → `onChange` 收到 `sanitizeColor` 之后的颜色值
- 重复点击当前已选中的色块 → 不触发 `onChange`（避免抖动与多余保存）
- 点击「清除装饰」→ 调用 `onClear`
- 点击「撤销」→ 调用 `onUndo`；`undoEnabled` 为 false 时该按钮 `disabled`
- `destroy()` 后面板元素从 DOM 移除
- 面板根元素带 `data-sue-panel` 标记属性

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 3: 实现 `src/panel.ts`**

要点：

- 所有事件绑定用 Task 3 导出的本地 `getEventName()` 取事件名，保证移动端可用。
- `IPanelOptions.undoEnabled: boolean` —— 由 `index.ts` 传入 `hasUndoableChange()` 的结果，面板本身不感知撤销栈。
- 线型预览色块用真实 CSS 绘制：元素自身设 `text-decoration-line: underline; text-decoration-style: <所选线型>; text-decoration-color: currentColor`，而不是画图标字符或用图片。
- 颜色色块的背景色走 `sanitizeColor`，`var(--b3-...)` 值在 `style.backgroundColor` 上是合法的。
- 「跟随文字色」色块显示字母 `A`，其背景为 `transparent`、文字色继承面板。
- 当前选中项加一个 `aria-pressed="true"` 与自定义 class，便于主题与无障碍。
- 面板初始位置锚定 `options.anchor`；`position: absolute`，坐标在插入 DOM 后用 `getBoundingClientRect()` 测量再夹取到视口内，移动端下再兜底加 `max-height` + `overflow-y: auto`。

- [ ] **Step 4: 写 `src/index.scss`**

只描述布局与预览线条，不覆盖 `b3-button` / `b3-switch` 的控件外观。禁止 `:has()`。根选择器用 `[data-sue-panel]`。移动端断点（或 `isMobile()` 加的 class）下加大触控目标与滚动。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6: 类型检查并构建**

Run: `npx tsc --noEmit` 然后 `npm run build`
Expected: 均无错误，`index.css` 中含 `[data-sue-panel]` 规则。

- [ ] **Step 7: 提交**

```bash
git add src/panel.ts src/index.scss tests/ && git commit -m "feat: add decoration settings panel"
```

---

### Task 6: 插件接线与生命周期

**Files:**
- Modify: `src/index.ts`
- Create: `src/icons.ts`
- Create: `tests/index.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `composePair`、`readPairFromStyle`、`sanitizePair`、`isSamePair`；Task 3 的 `collectEditableGroups`、`stripDecorationIn`、`applySpansIn`、`captureOffsets`、`restoreOffsets`、`getEventName`；Task 4 的 `saveBlockDOM`、`recordChange`、`undoLastChange`、`hasUndoableChange`、`clearChanges`、`createDebouncedSaver`；Task 5 的 `createPanel`
- Produces: 插件包本身（`src/index.ts` 默认导出）

- [ ] **Step 1: 写图标 `src/icons.ts`**

导出一个 SVG 字符串常量，内容为一条下划线 + 一条上划线的图形（`viewBox="0 0 24 24"`，`stroke-width` 与思源现有图标风格一致）。不得手写复杂路径，优先参考 Lucide 的 `underline` 图标并改造。

- [ ] **Step 2: 写失败的测试 `tests/index.test.mjs`**

沿用 plugin-sample 的 vm 手法：transpile `src/index.ts`，在 `runInNewContext` 里注入 mock 的 `Plugin` 基类、`siyuan` 模块、`window.siyuan`。必须包含：

- `onload` 调用了 `addIcons` 与 `addToolbarItem`
- 注册的 `IMenuItem` 的 `name` 为 `"underline-enhancement"`，`icon` 非空，`click` 是函数
- `onunload` 调用了 `removeToolbarItem("underline-enhancement")`
- **`onunload` 在 `onload` 从未执行过时也不抛错**（幂等卸载）
- 触发 `click(protyle)` 会创建带 `data-sue-panel` 的面板元素
- 面板 `onChange` 触发后，`updateBlock` 被调用且 `dataType === "dom"`
- 只读模式（`window.siyuan.config.readonly === true`）下 `onload` 不注册工具栏项
- 发布模式（`window.siyuan.isPublish === true`）下不注册工具栏项
- `onLayoutReady` 的 `loadData` 抛错时仍能用默认值正常工作

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL。

- [ ] **Step 4: 实现 `src/index.ts`**

要点：

- 常量 `const TOOLBAR_ITEM_NAME = "underline-enhancement";`
- `onload()`：`addIcons(svg)`；`addToolbarItem({ name: TOOLBAR_ITEM_NAME, icon: "iconUnderlineEnhancement", tip: this.i18n.underlineEnhancement, tipPosition: "n", click: (protyle) => this.openPanel(protyle) })`。只读 / 发布模式下跳过注册。
- `openPanel(protyle)`：`collectEditableGroups` 取当前选区 → 用 `readPairFromStyle` 从首个组的现有 `data-sue` span 回填初始 pair → `createPanel(...)`，接上 `onChange` / `onClear` / `onUndo` / `onClose`。
- `onChange(pair)` 的应用流程：先 `captureOffsets` 备份选区 → 对每个组 `stripDecorationIn` 后 `applySpansIn(..., composePair(pair))` → `restoreOffsets` → 用 `createDebouncedSaver(300)` 调度 `saveBlockDOM`，并在 `recordChange` 里记下 before/after HTML。
- `onClear()`：等价于 `onChange` 一个两方向全 disabled 的 pair。
- `onUndo()`：`await undoLastChange()` 后同步刷新面板上的开关状态。
- `onunload()`：无条件移除工具栏项、销毁面板、清 timer、清撤销栈。所有清理都写成可重复执行。
- 所有 `this.loadData` / `this.saveData` 调用都要有失败兜底，且 `loadData` 读回的值必须过 `sanitizePair`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS，全部 4 个测试文件通过。

- [ ] **Step 6: 类型检查并构建**

Run: `npx tsc --noEmit` 然后 `npm run build`
Expected: 均无错误。

- [ ] **Step 7: 提交**

```bash
git add src/ tests/ && git commit -m "feat: wire plugin lifecycle and toolbar item"
```

---

### Task 7: 文档、构建产物与真实实例验收

**Files:**
- Create: `README.md`、`README.zh-CN.md`
- Create: `docs/manual-verification.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1–6 的全部产出
- Produces: 可发布的插件包 `package.zip`

- [ ] **Step 1: 写 `README.md`（英文）与 `README.zh-CN.md`（中文）**

两者结构一致，各含：

1. 功能说明与截图占位
2. 安装：把 `dist/` 或 `package.zip` 放进 `{工作空间}/data/plugins/siyuan-underline-enhancement/`，或从集市安装
3. 用法：选中文字 → 浮动工具栏点击图标 → 分别设置下划线 / 上划线
4. **已知限制**（照抄规格第 9 节，不要软化措辞）：
   - 导出 Markdown / HTML / PDF 时下划线降级为普通 `<u>`，上划线、线型、颜色丢失。原因是思源 Lute 只保留 `color`、`background-color`、`font-family`、`font-size` 四种样式，属思源导出管线的既定行为。
   - 思源的 Ctrl+Z 撤销栈不包含本插件的操作，请用面板的「撤销」按钮，或思源的文档历史。
   - 代码块不支持，与思源原生浮动工具栏一致。
5. 开发：`npm install`、`npm run dev`、`npm test`、`npm run build`

- [ ] **Step 2: 写 `docs/manual-verification.md`**

把规格第 10.2 节的 12 项手工验证清单落成可勾选的清单，每项写明**预期结果**与**实际结果**两栏，供填写。第 3 项（检查 `.sy` 文件里对应块的 JSON 是否原样含 `style` 属性）是保真性的关键证据，必须单独标出查看方法（`.sy` 中块内容的 `content` 字段）。

- [ ] **Step 3: 写 `CHANGELOG.md`**

首条记录 0.1.0 的功能点。

- [ ] **Step 4: 全量验证**

```bash
npm run lint
npm test
npx tsc --noEmit
npm run build
```

Expected: 四条全部通过，`package.zip` 生成。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "docs: add readme, manual verification checklist"
```

- [ ] **Step 6: 交付后清理**

删除仅为开发期参考拉取的上游仓库目录：`_siyuan/`、`_template/`。确认 `git status` 干净，`git ls-files` 中不含任何上游文件。