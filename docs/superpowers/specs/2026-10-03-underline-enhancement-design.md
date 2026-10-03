# 下划线增强（siyuan-underline-enhancement）设计规格

- 日期：2026-10-03
- 状态：已与用户确认设计，待评审
- 包名：`siyuan-underline-enhancement`

## 1. 目标与范围

### 1.1 一句话目标

在思源笔记 Protyle 编辑器中，选中文本后浮动工具栏出现「下划线增强」图标，点击打开浮层面板，可分别设置**下划线**与**上划线**的**线型**和**颜色**（含跟随文字颜色），设置实时预览并即时生效。

### 1.2 支持环境

| 环境 | 支持内容 |
|---|---|
| 桌面端（Windows / macOS / Linux） | 编辑器浮动工具栏图标 + 设置面板 |
| 桌面浏览器版 | 同上 |
| 移动端（Android / iOS / HarmonyOS APP、移动浏览器） | 同上，面板布局针对触控与窄屏适配 |
| 只读模式 | 装饰样式正确渲染（inline style 自包含，无需插件加载） |
| 发布服务 | 同上 |

### 1.3 明确不做

- 不做文档历史 / 版本管理的改动
- 不做与思源原生 `<u>` 的互转或迁移
- 不做下划线的批量查找替换
- 不做导出格式的保真（见第 9 节已知限制）

## 2. 关键技术结论（已核实）

以下结论均通过阅读思源与 Lute 源码核实，是本设计的地基。

### 2.1 浮动工具栏有官方插件 API

`app/src/plugin/index.ts` 的 `Plugin` 类提供：

```ts
addToolbarItem(item: IMenuItem): void
removeToolbarItem(name: string): void
updateProtyleToolbar(toolbar: Array<string | IMenuItem>): Array<string | IMenuItem>
```

`app/src/protyle/toolbar/index.ts` 的 `Toolbar` 构造函数会遍历所有插件调用 `resolvePluginToolbar(plugin, ...)`，把插件注册的项追加进浮动工具栏。`addToolbarItem` 会自动刷新所有已打开编辑器的工具栏，并注册可在「设置 - 快捷键」中自定义的快捷键。

该 API 在 **petal v1.2.7（2026-09-07）** 引入（思源 issue #19083），已声明于 petal 的公开类型 `siyuan.d.ts`。对应思源版本 **3.8.6**，故 `minAppVersion` 定为 `3.8.6`。

`IMenuItem` 的 `click` 回调签名为 `(protyle: IProtyle) => void`。

### 2.2 inline style 在思源内完整保真

思源把块的 `outerHTML` 原样写入 `.sy`（`app/src/protyle/index.ts`），内核 `Transaction.doUpdate` **不调用** `SpinBlockDOM` 做规范化。因此任意 inline style 可持久化。

**思源自身即依赖此机制**：`app/src/protyle/toolbar/Font.ts:610-618` 把 `text-shadow`、`-webkit-text-stroke`、`-webkit-text-fill-color` 直接写在 span 的 style 上；`Font.ts:601` 的 RTL 方向写成 `direction: rtl; unicode-bidi: isolate`。这些属性均不在 Lute 白名单内，却是官方发布的功能。

### 2.3 Markdown / HTML 导出会降级

Lute 的 `parse/html_text_style.go` 中，`HTMLTextStyle` 只保留四个属性 —— `color`、`background-color`、`font-family`、`font-size`。`CSS()` 只输出这四项，其余全部丢弃。思源自身的 `kernel/api/lute_text_style_test.go` 断言了这一行为（3 轮 `SpinBlockDOM` 后仅这四项存活）。

`ApplyHTMLTextSemantics` 另外把 `text-decoration` 重写为原生标记：`underline` → `<u>`，`line-through` → `<s>`。

结论：导出 Markdown / HTML / PDF 时，下划线降级为普通 `<u>`，上划线、线型、颜色丢失。**用户已确认接受此降级。**

### 2.4 保存机制

`/api/block/updateBlock` 支持 `dataType: "dom"`（见 `docs/API.md`），传入块的完整 HTML，服务端原样写入。本插件用它保存装饰。

代价：`updateBlock` 不产生思源事务记录，**思源的 Ctrl+Z 撤销不了这一步**。补偿见第 7 节。

## 3. CSS 方案与嵌套 span

### 3.1 问题

CSS 中 `text-decoration-style` 与 `text-decoration-color` 作用于元素的**所有**装饰线。单个 span 无法让下划线为波浪线而上划线为实线，但用户要求两个方向分开设定。

### 3.2 解法

用**嵌套 span**，外层承载上划线，内层承载下划线，各自带完整的 `text-decoration-*`：

```html
<span style="text-decoration-line:overline; text-decoration-style:solid; text-decoration-color:#e5484d">
  <span style="text-decoration-line:underline; text-decoration-style:wavy; text-decoration-color:#0090ff">文字</span>
</span>
```

CSS 规范中 `text-decoration` 会向后代传播且后代无法关闭继承来的装饰，但后代**自身**的装饰会叠加渲染 —— 因此两层 span 呈现为两条独立可配的线。

合并规则（减少无谓嵌套）：

| 状态 | 输出 |
|---|---|
| 两个方向都关闭 | 移除装饰，不留 span |
| 仅一个方向开启 | 单个 span |
| 两个方向开启，线型与颜色完全相同 | 单个 span，`text-decoration-line: underline overline` |
| 两个方向开启，线型或颜色不同 | 嵌套 span（外层 overline，内层 underline） |

### 3.3 颜色

「跟随文字颜色」= **不输出** `text-decoration-color`，由 CSS 默认值 `currentColor` 生效。

此外是 10 个预设色块 + `<input type="color">` 自定义取色器，自定义色值加入预设。

预设色板需在深浅两种主题下都有足够对比度。彩色项用固定十六进制值；中性色用思源主题变量 —— 思源自身已在 inline style 中持久化 `var(--b3-font-colorN)`（见 `inlineStyle.ts` 的 `INLINE_FONT_COLORS`），故此做法有先例且能正确落盘。

| 色块 | 值 | 说明 |
|---|---|---|
| 1 | `#e5484d` | 红 |
| 2 | `#f76b15` | 橙 |
| 3 | `#ffb224` | 琥珀 |
| 4 | `#46a758` | 绿 |
| 5 | `#30a46c` | 青 |
| 6 | `#0090ff` | 蓝 |
| 7 | `#8e4ec6` | 紫 |
| 8 | `#d6409f` | 粉 |
| 9 | `#f5d90a` | 黄 |
| 10 | `var(--b3-font-color8)` | 中性灰，跟随主题 |

自定义色值必须校验为 `#rgb` / `#rrggbb` / `#rrggbbaa` 或 `var(--b3-...)` 形式，其余一律拒绝并回退到「跟随文字颜色」，防止把任意字符串写进 inline style。

## 4. 数据模型

```ts
export type TLineStyle = "solid" | "dashed" | "dotted" | "double" | "wavy";

export const LINE_STYLES: readonly TLineStyle[] = ["solid", "dashed", "dotted", "double", "wavy"];

export interface IDecoration {
    /** 该方向是否启用 */
    enabled: boolean;
    /** 线型，仅当 enabled 为 true 时有效 */
    style: TLineStyle;
    /** 颜色；空字符串表示跟随文字颜色 */
    color: string;
}

export interface IDecorationPair {
    underline: IDecoration;
    overline: IDecoration;
}
```

默认值：下划线 `{enabled: true, style: "solid", color: ""}`；上划线 `{enabled: false, style: "solid", color: ""}`。

`src/model.ts` 提供纯函数（不触碰 DOM，全部可单测）：

| 函数 | 职责 |
|---|---|
| `buildDecorationCSS(decoration, position)` | 单个方向的 span `style` 字符串 |
| `composePair(pair)` | 按 3.2 合并规则返回 1 或 2 个 span 描述 |
| `parseDecorationStyle(styleText)` | CSS style 串 → `IDecoration` |
| `readPairFromRange(range)` | 从 DOM 选区反解出 `IDecorationPair`，用于打开面板时回填 |
| `sanitizePair(value)` | 校验外部输入（loadData 读取的设置），非法值回退默认 |
| `isSamePair(a, b)` | 比较两组配置是否等价 |

## 5. DOM 应用算法

### 5.1 范围收集

选区可能跨块、跨表格单元格。算法：

1. 取 `range.commonAncestorContainer`，用 `TreeWalker`（`SHOW_TEXT`）遍历出所有与 `range` 相交的文本节点。
2. 跳过位于 `NodeCodeBlock`、数学块、属性视图（`.av`）、`.hljs` 内的文本节点 —— 思源原生浮动工具栏对代码块同样不显示。
3. 对每个文本节点确定其**可编辑区域**，规则依优先级：
   - 位于表格单元格（`TD` / `TH`）内 → 该单元格
   - 位于 callout / tab-item 的标题区（`:scope > .callout-info > .callout-title`）→ 该标题区
   - 否则 → 所属块（`closest('[data-node-id]')`）自身
4. 按可编辑区域分组，同组内保持文档顺序。

分组是必要的：跨段落或跨表格单元格应用时，每个可编辑区域必须独立做 DOM 包裹，包裹一个区域不得影响另一个。

### 5.2 应用

对每个分组：

1. 在文本节点上构造精确覆盖交选区部分的 `Range`。
2. 若该分组已有本插件产生的装饰 span，先**剥离**再重新包裹 —— 这样「改设置」与「首次应用」走同一条代码路径，避免增量更新导致样式残留。
3. 按 `composePair` 的结果包裹 span；若结果为空则只做剥离。
4. 记录包裹前后的块 `outerHTML`，供撤销栈使用。

### 5.3 标记与识别

插件产生的 span 带 `data-sue="u"` / `data-sue="o"` 标记，便于识别与剥离。该属性是**辅助标记**，样式本身完全由 inline style 承载 —— 即使插件未加载，装饰依然正确渲染。

### 5.4 焦点与选区

包裹 DOM 会使原 `Range` 失效。每次应用后，用记录的文本节点偏移重建选区并 `focus()`，保持用户可继续输入。跨多块时聚焦到最后一个分组。

## 6. 面板 UI

### 6.1 结构

锚定在浮动工具栏按钮正下方（复用思源 `subElement` 的定位思路：相对触发按钮水平居中，垂直方向避开选区，边界用视口夹取）。

```
┌─ 下划线增强 ──────────────────────┐
│  下划线  [====]                   │
│    线型  ━━━ ┅┅┅ ⋯⋯ ══ ∿∿∿        │
│    颜色  A ●●●●●●●●●● 🎨         │
│  ──────────────────────────────  │
│  上划线  [====]                   │
│    线型  ∿∿∿ ∿∿∿  ══ ⋯⋯ ┅┅┅        │
│    颜色  A ●●●●●●●●●● 🎨         │
│  ──────────────────────────────  │
│  [ 清除装饰 ]        [ 撤销 ]    │
└──────────────────────────────────┘
```

### 6.2 交互

- **打开**：从当前选区读出已有装饰回填面板；面板外点击或 `Esc` 关闭。
- **实时预览**：悬停或点击线型 / 颜色立即应用到选区，并防抖（300ms）保存。
- **清除装饰**：移除两个方向的全部装饰并保存。
- **关闭**：执行最后一次保存。

### 6.3 视觉细节

- 线型预览用真实 CSS `text-decoration-style` 绘制，不用图标字符。
- 颜色「跟随文字」用字母 `A` 表示，当前色即继承的正文色。
- 复用思源的 `b3-button`、`b3-switch`、`b3-text-field` 等既有组件类，不重造控件外观。
- 尊重主题变量，深浅色主题下均清晰。
- 移动端：触控目标不小于 32px，面板可纵向滚动，避免超出视口。

## 7. 保存与撤销

### 7.1 保存

```ts
fetchSyncPost("/api/block/updateBlock", {
    id: blockId,
    dataType: "dom",
    data: blockElement.outerHTML,
});
```

每个受影响块独立保存一次。保存失败时弹 `showMessage` 提示。

### 7.2 撤销栈

`src/persist.ts` 维护插件自有的撤销栈。每次保存成功压入一条记录：

```ts
interface IUndoEntry {
    blockId: string;
    beforeHTML: string;   // 改动前的块 outerHTML
    afterHTML: string;    // 改动后的块 outerHTML
}
```

「撤销」按钮弹出栈顶并把 `beforeHTML` 写回：先调用 `updateBlock` 持久化，再把块 DOM 替换回去。

**前置校验**：仅当该块当前 DOM 的 `outerHTML` 仍等于记录中的 `afterHTML` 时才允许撤销。若用户在装饰之后又编辑过该块，说明 `afterHTML` 已过期，此时跳过该条记录继续向前查找；栈已全部失效时按钮置灰。不校验直接回滚会覆盖用户的其他编辑。

栈深上限 50 条，面板关闭时清空当前会话的栈。

### 7.3 已知能力缺口

思源的 Ctrl+Z 撤销栈不包含本插件的操作。用户可通过：

1. 面板的「撤销」按钮
2. 思源的文档历史 / 版本历史（仍会捕获 `updateBlock`）

进行恢复。此限制写入 README。

## 8. 模块与文件

从 `siyuan-note/plugin-sample`（v0.5.2）派生，保留其 webpack + esbuild + pnpm 构建配置，删除 sample 特有的 kernel 插件与发布示例代码。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Plugin 类、生命周期、`addToolbarItem` 注册/反注册 |
| `src/model.ts` | 纯逻辑：样式模型 ↔ CSS 双向转换（单测覆盖） |
| `src/apply.ts` | Range 上的装饰包裹 / 剥离 / 选区恢复 |
| `src/persist.ts` | `updateBlock` 保存 + 撤销栈 |
| `src/panel.ts` | 面板构建、定位、交互、实时预览 |
| `src/settings.ts` | `loadData`/`saveData` 记忆上次线型与颜色 |
| `src/icons.ts` | 自定义 SVG 图标 |
| `src/i18n/en.json`、`src/i18n/zh-CN.json` | 文案 |
| `src/index.scss` | 面板样式 |
| `tests/model.test.mjs` | `model.ts` 单测 |

### 8.1 plugin.json 要点

- `name: "siyuan-underline-enhancement"`
- `minAppVersion: "3.8.6"`
- `frontends: ["all"]`、`backends: ["all"]`、`kernels: ["all"]`
- `disabledInPublish: false`（发布模式需保留插件）
- `displayName` / `description` / `readme` 提供 `default`（英文）与 `zh-CN`

### 8.2 生命周期

- `onload()`：注册工具栏项、注入样式
- `onLayoutReady()`：读取设置（`loadData`），失败则用默认值
- `onunload()`：反注册工具栏项、移除样式与面板、清理计时器

卸载逻辑必须幂等 —— 部分初始化状态下也要安全执行。

## 9. 已知限制（写入 README）

1. **导出降级**：导出 Markdown / HTML / PDF 时，下划线降级为普通 `<u>`；上划线、线型、颜色丢失。原因是思源的 Lute 只保留 `color`、`background-color`、`font-family`、`font-size` 四种样式。此为思源导出管线的既定行为，非本插件缺陷。
2. **Ctrl+Z 不覆盖**：见 7.3。
3. **代码块不支持**：与思源原生浮动工具栏一致。

## 10. 测试策略

### 10.1 自动化单测

沿用 plugin-sample 的测试手法：读取 `src/model.ts` 源码，用 `typescript` 的 `ts.transpileModule` 转成 CommonJS，再在 `node:vm` 的 `runInNewContext` 中执行。`model.ts` 是纯逻辑、不触碰 DOM，无需 mock 浏览器环境。

`node --test tests/model.test.mjs`，覆盖 `model.ts`：

- CSS 串 → 样式模型 → CSS 串 往返一致
- 单方向、双方向同配置（合并为单 span）、双方向异配置（嵌套）三种组合
- 颜色为空时不输出 `text-decoration-color`
- 非法线型 / 非法颜色回退默认
- `sanitizePair` 对 `loadData` 脏数据的防御
- 跨 span 边界的样式解析
- 颜色值白名单校验：`#rgb` / `#rrggbb` / `#rrggbbaa` / `var(--b3-...)` 通过，`red;position:fixed` 之类的注入尝试被拒绝

### 10.2 真实实例手工验证清单

在思源 3.8.6 桌面端逐项验证并记录结果：

1. 选中文字 → 浮动工具栏出现图标
2. 应用下划线（上划线）→ 编辑器内正确渲染
3. **查 `.sy` 文件对应块的 JSON，确认 `style` 属性原样落盘**
4. 刷新页面 / 关闭重开文档 → 装饰保持
5. 两个方向同时开启、异配置 → 两条线各自样式正确
6. 跨段落、跨列表项、跨表格单元格应用
7. 文档历史可回滚
8. 同步到另一设备后装饰保持
9. 导出 Markdown → 确认降级行为与 9.1 一致
10. 发布服务页面 → 装饰正确渲染
11. 只读模式 → 装饰正确渲染
12. 移动端面板布局与触控

## 11. 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 持久化方式 | inline style + `updateBlock(dataType:"dom")` | 已核实内核不做规范化；自包含样式使只读/发布零成本兼容 |
| 样式载体 | inline style 而非 class | 插件未加载时（只读/发布/外部阅读）依然生效 |
| 两个方向的实现 | 嵌套 span | CSS 无法对同一元素的两条线分别设 style/color |
| 面板交互 | 实时预览 | 所选 |
| 颜色选项 | 跟随文字 + 10 预设 + 取色器 | 所选 |
| 线型选项 | solid/dashed/dotted/double/wavy | 所选 |
| 支持范围 | 桌面 + 移动 + 只读/发布 | 所选 |
| 导出保真 | 接受降级 | 所选 |