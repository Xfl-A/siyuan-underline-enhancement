# AGENTS.md

思源笔记插件 `siyuan-underline-enhancement`（下划线增强）。给后续 agent 的操作说明。

## 命令

```bash
npm test                                    # 全部单测（node:test）
node --test tests/model.test.mjs            # 单个文件
node --test --test-name-pattern="还原" tests/dom.test.mjs   # 按用例名筛
npm run lint                                # ESLint（带 --fix，会改文件）
npm run format                              # dprint 改写
npm run format:check                        # dprint 只检查
npm run build                               # 生产构建
node node_modules/typescript/bin/tsc --noEmit   # 类型检查
```

**`npx` 在本机被 PowerShell 执行策略挡住**，别用。直接 `node node_modules/<pkg>/...`。

宿主是 PowerShell，**没有 bash**。Git 身份仓库级是 `opencode <opencode@local>`，
提交必须显式带身份，否则会以 opencode 署名：

```bash
git -c user.name="Xfl-A" -c user.email="Xfl-A@users.noreply.github.com" commit -m "..."
```

宿主控制台 `OutputEncoding` 是 gb2312，中文在终端输出里是乱码。文件本身是合法 UTF-8，
**不要去"修"**。

## 提交前验证顺序

```bash
npm run lint && npm run format:check && npm test && node node_modules/typescript/bin/tsc --noEmit && npm run build
```

五条都必须 exit 0。注意 `npm run lint` 和 `npm run format` 会**改写文件**，跑完要 `git diff` 看一眼。
仓库干净时 `npm run format` 可能顺手改动别的 agent 正在写的文件 —— 只提交自己动过的文件，
**不要 `git add -A`**。

## 架构

纯逻辑 / DOM 手术 / 持久化 / UI / 接线五层，不许跨层直接依赖：

| 文件               | 职责                               | 关键约束                                                       |
| ------------------ | ---------------------------------- | -------------------------------------------------------------- |
| `src/model.ts`     | 样式模型、CSS ↔ 值转换、颜色白名单 | 纯逻辑，不碰 DOM                                               |
| `src/dom.ts`       | DOM 手术、字符偏移坐标系           | **只从 `siyuan` import `getFrontend`，不 import 任何兄弟模块** |
| `src/persist.ts`   | 保存 + 插件自有撤销栈              |                                                                |
| `src/placement.ts` | 面板几何，**纯函数**               | 不碰 DOM，只算矩形                                             |
| `src/panel.ts`     | 面板 UI                            | 只管呈现，不碰文档                                             |
| `src/index.ts`     | 接线、生命周期                     |                                                                |

`src/dom.ts` 不 import 兄弟模块是刻意的：`tests/index.test.mjs` 装载它时只需要 `{siyuan}` 一个桩。
加一个 import 就得同步改测试的依赖表。

面板控件**全部不可聚焦**（`div` + `role`，无 `button`、无 `tabindex`）。有 `<button>` 会夺走焦点。
注意：**带 `tabindex` 的元素仍然可聚焦**，只是不进 Tab 序列 —— 写 `tabindex="-1"` 解决不了问题。

## 构建产物（易混）

* `npm run dev` → 仓库根目录 `index.js` + `index.css` + `i18n/`（已被 gitignore）
* `npm run build` → `dist/`（可直接加载的插件目录）+ `package.zip`（同内容去掉 `dist/` 前缀）

`package.zip` 是 release 资产，**不入 git**。两者都在 `.gitignore` 里。

## jsdom 的盲区 —— 本仓库最容易翻车的地方

`jsdom` **不实现**下列东西，因此相关缺陷测试原理上看不见。已经有四个 bug 因此漏到真机，
其中「选区丢失」**至今未修**：

* **不触发 `selectionchange`**。思源据此判断选区是否还在（见下），所以"选区被取消"这类 bug 全绿。
* **不应用样式表**。CSS 回归必须**读 `src/index.scss` 源码文本**来断言，`tests/panel.test.mjs` 里有现成写法。
* **没有布局**。`getBoundingClientRect()` 全返回 0。面板定位因此必须是纯函数 + 合成矩形单测。
* **不因焦点转移塌掉选区**。真机会。
* **不会重渲染块**。思源随时重渲染，引用会脱管 —— 必须在夹具里显式模拟（`el.outerHTML = ...`）。

推论：**jsdom 测不了的东西，要钉"契约"而不是"行为"**，并写进 `docs/manual-verification.md`
（真机验收清单，中英双语）。新增无法在 jsdom 覆盖的行为时，同步往那份清单加一条。

**但反过来也要当心**：契约断言绿了 ≠ 真机行为正确。「选区」那条契约就是个教训 ——
它绿着，而真机是坏的。凡是只能靠 jsdom 断言的行为，都要标注"需真机确认"。

## 测试装载器

`tests/helpers/loadModule.mjs` 读 `.ts` 源码 → `ts.transpileModule` → `node:vm` 执行。

* **`src/*.ts` 新增 import 必须在 `tests/index.test.mjs` 的依赖表里注册**，否则抛
  `模块 X 没有桩实现`。这是加新模块时最常忘的一步。
* 跨 realm 返回的对象要用 `toHost()` 包一下，否则 `deepStrictEqual` 因原型不一致判不等。
* `tests/helpers/dom.mjs` 的 `createFixture()` 返回 `selectWithin`（不是 `select`），`block` 需要传块 id。

## 思源持久化契约

保存必须走 `/api/block/updateBlock` + **`dataType: "dom"`**。Lute 的 Markdown 通道只保留
`color`/`background-color`/`font-family`/`font-size` 四种 inline style，`text-decoration` 会被悄悄丢掉。

**思源存盘会丢弃块上的自定义属性。** 实测：装饰落盘成
`NodeTextMark{"Properties":{"style":"text-decoration-line: underline; …"}}`，样式原样保留，
任何自定义标记属性消失。因此装饰**只靠 `text-decoration-line` 识别**，不要引入标记属性。

「跟随文字颜色」写 `text-decoration-color: currentColor`（**不能省略**）—— 省略时思源会补一条
`color:`，那是文字色而非装饰色，装饰颜色就失效了。

## 选区丢失 —— 未解决，且已排除多个假设

**症状**：面板里改线型/颜色/开关后，编辑器选区与浮动工具栏一起消失。

**状态：当前代码（`74106a1`）在真机上仍然复现。** 下面是已确认的事实与**已被证伪**的假设，
不要把后者当根因。

### 已确认的事实

* 思源前端（`resources/stage/build/desktop/main.*.js`，压缩后搜 `selectionchange`）在 `document` 上
  有 11 处监听，其中一处形如 `if (Ct.rangeCount === 0) { 收起全部工具栏; return; }`。
* 思源自己的字体颜色菜单**不调用** `getSelection()` / `addRange()` / `focus()`，它持有活的
  `toolbar.range` 直接改 DOM —— 这是它选区不丢的原因，也是我们要对齐的目标。
* 面板控件已全部换成不可聚焦元素（`div` + `role`），焦点确实不再被面板夺走。**这一条是对的，
  但不足以解决问题。**

### 已被证伪的假设

* ❌「`restoreOffsets` 里的 `focus()` 塌掉选区」→ 去掉后真机仍复现。
* ❌「`removeAllRanges()` 让 `rangeCount` 瞬时归零」→ 改用 `setBaseAndExtent` 后真机仍复现。

`tests/dom.test.mjs` 里那条「重建选区不得调 focus() / 不得清空选区」的断言**目前是绿的，
但它不对应真机可用行为**。它只能防止代码回退，**不能**作为"选区问题已解决"的证据 ——
不要因为它绿就认为这条通了。

### 下一步该往哪查（未验证）

* 在真机上抓一次实际时序：点击后 `document.getSelection().rangeCount`、`document.activeElement`、
  浮动工具栏 DOM 的 class 变化，以及 `selectionchange` 触发次数。**在 jsdom 里做这件事没有意义**
  （不触发该事件）。
* 怀疑方向：`applySpansIn` 用 `extractContents()` + `insertNode()` 重排 DOM 后，活的 Range
  被浏览器调整到新位置，但 `document` 的选区已不再映射到它。思源字体颜色菜单也用同样手法却能保住，
  差异可能在于它**从不重建选区**。值得试的方向是让 DOM 手术不触碰 `document.getSelection()`。
* 症状里「浮动工具栏消失」与「选中消失」是否同一因果，尚不确定：也可能是面板关闭路径
  （`closePanel` → 还原 `subElementCloseCB`）误伤了工具栏。

## 约定

* 注释用中文、≤120 字，描述代码**做什么**；不要引用"旧实现""之前的版本"或 bug 历史。
* CSS 里不用 `:has()`。
* 面板根选择器是 `[data-sue-panel]`（面板挂在 `document.body`，不在编辑器里）。
* 一次性诊断探针写成 `probe-*.mjs`，已被 gitignore，用完删掉。
* 上架前确认 `README*`/`CHANGELOG.md`/`plugin.json`/`package.json` 的描述与实际功能一致
  （删功能时要一起改，这几处曾漏过）。
