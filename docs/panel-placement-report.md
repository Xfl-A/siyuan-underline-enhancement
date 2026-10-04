# 面板定位：躲开选区，不再遮挡文字

需求：**无论如何，窗口都不能遮挡文字，要挪到旁边。**

## 现在的定位算法在做什么，以及为什么会压住文字

`placePanel(panel, options.anchor)`（`src/panel.ts`，原 444-486 行）只有三个动作：

1. 量**锚点**（思源浮动工具栏的容器 `toolbar.element`）的矩形 `anchorRect`，
   元素已脱离文档（`isConnected === false`）或量不到时按 `null` 处理。
2. 横向取 `anchorRect` 的中线，纵向取「锚点下沿 + 8」；**只有一个翻转条件**：
   `viewport.height - anchorRect.bottom < panelRect.height + VIEWPORT_MARGIN`
   且 `above > VIEWPORT_MARGIN` 时才翻到锚点上方。
3. 把 `left` / `top` 各夹进 `[margin, viewport - 面板 - margin]`，加滚动偏移写进 `style`。

压住文字的原因有四条，每一条都独立成立：

* **参照的不是选区，是工具栏。** 工具栏容器只挨着选区的一端，它的框远小于选区。
  面板「居中于工具栏、落在工具栏下方」，落点完全由工具栏的位置决定，与那段文字的位置无关。
* **只有一个向下/向上的二元判断。** 高过面板的多行、多块选区，上下都放不下时，
  `fitsBelow` 为假、`above` 也为假（或者为真但仍在选区里），面板就被夹回视口，
  于是正压在选区中段 —— 这正是「挪个偏移」修不掉的形状。
* **夹取会把它拉回视口中央。** 夹取的区间只是「保证面板有一部分可见」，
  从不与选区求交，因此无论落在哪，压没压住文字都照样写进 `style`。
* **选区没有参与任何计算。** 整个函数里没有出现过 `Selection` / `Range`。

另外两件与本次相关的事实：

* `placePanel` **只在打开面板时调用一次**（原 `src/panel.ts:544`），之后再不重算：
  缩放窗口或滚动正文之后，面板留在原地；文字被面板自己的操作重裹装饰挪动了，它也不跟。
* 面板挂在 `document.body` 上用 `position: absolute`，`left`/`top` 是**文档坐标**，
  视口坐标要加 `window.scrollX/scrollY`。

## 新算法

### 候选集合与坐标

四个方向，顺序即优先级：**下方 → 上方 → 右侧 → 左侧**（`src/placement.ts:60`）。
上下排在前面是因为横向居中压在参照矩形上方/下方是浮层最常见的落点；
右、左侧留给高选区 —— 选区比面板还高时上下都放不下，只能挪到旁边。

| 方向    | `left`                        | `top`                         |
| ------- | ----------------------------- | ----------------------------- |
| `below` | 参照矩形横向居中              | 参照矩形下沿 + `gap`          |
| `above` | 参照矩形横向居中              | 参照矩形上沿 − 面板高 − `gap` |
| `right` | 参照矩形右沿 + `gap`          | 参照矩形竖向居中              |
| `left`  | 参照矩形左沿 − 面板宽 − `gap` | 参照矩形竖向居中              |

`gap = ANCHOR_GAP = 8`，`margin = VIEWPORT_MARGIN = 12`，与原先同一对常量。

* **参照矩形**：优先是**选区矩形**，量不到时退回锚点。
* **让开矩形（avoid）**：只有选区。没有可测的选区时是 `null`，此时没有需要避让的文字。
* 宽或高为 0 的让开矩形按「没有选区」处理：那量的是光标，不是文字。

### 选区规则（三档，确定性）

`choosePlacement`（`src/placement.ts:164`）把四个方向各算一遍，按档位取：

1. **一档**：`fits && overlap === 0` —— 这一侧在视口里放得下、且不压住选区。按候选顺序取第一个。
2. **二档**：`overlap === 0` —— 不压住文字，但会越过视口边缘。
   面板有限高（桌面 `80vh`、移动端 `60vh`）与纵向滚动，越出去的部分仍能滚动到达；
   压到文字不行 —— 那一段正是用户正在改的。
3. **三档（兜底）**：四个方向都压到选区时，取**重叠面积最小**的一个；
   同分保留候选顺序里的前一个。

两个量的口径刻意不同，混用会得出错的结论：

* `fits` 用**夹之前**的坐标：它回答「这一侧按意图摆放时放不放得下」。
  夹取能让任何一侧都变得「放得下」，那就抹掉了这一侧的优势。
* `overlap` 用**夹之后**的坐标：它回答「落到屏幕上那块矩形实际压住了多少」。

### 兜底的情形与取舍

几何上真的避不开只有两类：**选区铺满窗口**，或者**窗口比面板还小**（面板自身也被限高）。
此时按重叠面积最小取舍；四侧夹取后落到同一块矩形时（窗口小于面板）四者同分，
按候选顺序取第一个 —— 两种情况都是确定的，`choosePlacement` 是无状态的纯函数，
同一组输入两次调用结果逐字节相同（有用例钉住）。

为什么不静默退回「压在文字上」：用户的要求是无条件的，压住选区就是失败，
必须让「压得最少」成为显式的、有测试兜着的判据，而不是隐含在夹取里的副作用。

### 选区矩形怎么量

`selectionRectOf(view)`（`src/panel.ts:454`）读 `view.getSelection()`：
`rangeCount === 0` 或 `isCollapsed` 返回 `null`；否则取 `getRangeAt(0).getBoundingClientRect()`。
`Range.getBoundingClientRect` 给的是范围内所有行盒的并集，多行、多块选区因此也合成**一个**矩形，
正好是「压到没有」这个判断需要的形状。`typeof … !== "function"` 时按量不到处理
（jsdom 就没有这个方法，缺它时不能抛）。

**每次重摆都现量一次**。这是有意的：`applyPair` 每次改动都会
`applySpansIn` → `restoreOffsets` 重建选区，`undoDecoration` 会把块 HTML 换掉，
两者都会挪动这段文字，记下来的旧矩形随即失效。
把「量选区」留在 `placePanel` 里而不是构造时记一次，重裹装饰与撤销之后的位置变化才跟得上。

`options.anchor` 的脱管兜底沿用原有那道闸门，搬进了 `connectedRectOf`（`src/panel.ts:443`）：
`element?.isConnected !== true` 或量不到 `getBoundingClientRect` 一律按 `null` 处理。
选区与锚点都拿不到时，面板停在 `margin` 上（既有用例钉住 `12px`）。

### 缩放与滚动：现在会重摆

**原来的代码只在打开时算一次**，之后不重算。现在 `createPanel` 额外挂两个视口监听
（`src/panel.ts:590-598`）：

* `resize` → `reposition`
* `scroll` → `handleScroll`，**捕获阶段** + `passive: true`

捕获阶段是必需的：思源的每个编辑区各自是滚动容器，`scroll` 不冒泡，
挂在 `window` 上冒泡阶段收不到它们内部的滚动。挂在 `document` 上也不行（收不到 window 自身的滚动）。

`handleScroll` 里有一条排除：**事件来自面板自身或面板子树时直接返回**。
面板根就是滚动容器（限高 + `overflow-y: auto`），用户滚它的内容时不该反过来把面板挪走。
`destroy()` 里按同一组标志摘掉两个监听（摘捕获阶段的监听必须带 `capture: true`），
`reposition` 本身也再判一次 `destroyed`。

顺带一处性能上的讲究（`movePanelTo`，`src/panel.ts:478`）：**坐标没变就不写 `style`**。
整页滚动时算出来的文档坐标其实一直没变（视口坐标减 `scrollY` 抵消），
而每次写 `style` 都会让浏览器把布局标记为待更新，下一次读矩形就得重排一次。

### 移动端与 RTL

* **移动端没有单独的定位分支**，改之前也没有；两端的差别只在限高
  （`MOBILE_MAX_HEIGHT = 60vh`）与 `getEventName()` 返回 `touchend`。
  限高变小只会让「放得下」更容易成立，避让规则是同一套。补了一条用例钉住这一点。
* **RTL：本仓库没有任何 RTL 处理**（没有 `dir`、没有 `direction`、没有逻辑属性），
  因此不引入。候选里的 `right`/`left` 是**几何**左右，不是逻辑起止：
  RTL 文档下它们仍表示屏幕上的右侧与左侧，行为不变，也不需要额外代码。

## 纯函数为什么单独放一个模块

几何判断做成了 `src/placement.ts` 的纯函数（`choosePlacement` / `candidatesOf`），
理由与 `src/model.ts` 的组织方式一致：那个模块的头注释就写着「本模块全部为纯函数，
不触碰 DOM，也不 import 任何运行时依赖，便于直接单测」，`placement.ts` 沿用同一约定。

* jsdom 没有布局引擎，`getBoundingClientRect()` 恒为全零。几何决策一旦埋在
  `placePanel` 里，就只能靠给每个元素打矩形桩来间接验证，桩和被测代码缠在一起，
  断言既容易空转又容易自证。提成纯函数之后，测试直接给它合成矩形。
* `panel.ts` 的职责仍然是「呈现 + 收集意图」：量矩形、把结果写成坐标。
  `placement.ts` 不 import 任何东西（`panel.ts` 单向依赖它），两边都只有一个理由去改。
* 导出面刻意收窄：只有 `choosePlacement`、`candidatesOf` 与类型。
  `SIDES` / `clampToRange` / `overlapArea` 留在模块内部 ——
  候选顺序通过 `candidatesOf(...).map(c => c.side)` 就能读到（有用例），
  兜底判据直接落在候选表上，不必再导出一个常量。

## 逐文件改动

### `src/placement.ts`（新增，175 行）

* `TPlacementSide` / `IRect` / `ISize` / `IPlacementInput` / `IPlacement`：契约类型。
* `choosePlacement(input)`：三档规则，返回 `{side, left, top, fits, overlap}`。
  `left` / `top` 已夹进视口并**取整** —— 面板写进 `style` 的就是这几个整数，
  测试与浏览器量到的是同一组数字。
* `candidatesOf(input)`：四个候选各算一遍，按候选顺序给出。
* 模块私有：`SIDES`、`clampToRange`、`overlapArea`、`offsetOf`、`fitsInViewport`、`candidateOf`。

### `src/panel.ts`

* `:9` 头注释：定位参照从「只有 anchor」改成「anchor 只是参照之一」。
* `:25-26` 新增 `import {choosePlacement}` 与 `import type {IRect}`。
* `:147` `ANCHOR_GAP` 注释：参照矩形优先是选区。
* `:446` `connectedRectOf`：锚点矩形的取值，带 `isConnected` 闸门。
* `:461` `selectionRectOf`：活选区矩形，量不到返回 `null`。
* `:484` `movePanelTo`：坐标没变就不写 `style`。
* `:502` `placePanel`：改写为「量选区 → 交给 `choosePlacement` → 加滚动偏移写坐标」。
  滚动偏移现在两条出口都加（原先只有正常那条加），面板是 body 上的绝对定位元素，
  `left`/`top` 是文档坐标；锚点量不到且没有选区时退回视口边距。
* `:541` `const view = ownerDocument.defaultView`：视口监听要挂在面板自己那个 window 上。
* `:597-615` `reposition` / `handleScroll` 与两个 `addEventListener`。
* `:783-784` `destroy()`：摘掉 `resize` 与捕获阶段的 `scroll`。

### `src/index.scss`

**没有改动。** 定位是 JS 里算的坐标，CSS 那边不存在能否决它的开关；
面板的自适应宽度（`width: 300px` + `max-width: calc(100vw - 24px)`）、
限高与滚动兜底（限高/滚动在 `src/panel.ts` 的内联样式上，不在样式表里）都已经够用，
没有 `:has()`、没有新属性要加。

代价是「定位与样式表是一对约定」这件事没有变化，但也没有变坏：
`VIEWPORT_MARGIN` 与 `max-width` 的 `24px` 必须继续对得上，
面板根也不能定死 `height`（否则窗口一矮面板缩不下去，「避开文字」只能退到二档）。
这两条由样式表源码用例钉住（见下）。

## 测试

全部加在 `tests/panel.test.mjs`（未新建测试文件），面板套件从 50 条到 71 条，全绿。

**夹具的三处变化**（原有断言一条没动）：

* `stubRects` 的返回值改成一个 setter，便于在重摆前后改几何。
* 新增 `stubSelection`：jsdom 的 `getSelection()` 恒为空、`Range.getBoundingClientRect` 不存在，
  于是直接在 `window` 上装一个可改的 `getSelection`，让 `selectionRectOf` 那条路在 jsdom 里也走得通
  （几何仍由被测代码自己算，桩只提供输入）。
* `loadModule("src/placement.ts")` 注入给 `src/panel.ts`；
  夹具多返回 `placement` / `setRects` / `setSelection`。

### 纯函数（`choosePlacement` / `candidatesOf`）

| 用例                                                   | 断言的事                                               |
| ------------------------------------------------------ | ------------------------------------------------------ |
| 四个候选方向的先后就是优先级                           | `candidatesOf(...).map(side)` = below/above/right/left |
| 选区在视口顶部时面板落到选区下方                       | side = below，`overlaps()` 独立判定不相交              |
| 选区在视口底部时面板落到选区上方                       | side = above，面板整体在选区上方                       |
| 高过面板的多行选区挪到右边，左右两侧都放不下时挪到左边 | side = right → left，两次都不相交                      |
| 左右两侧都放得下时优先选右边那一侧                     | side = right（按候选顺序）                             |
| 选区铺满窗口时四侧都压到，取候选顺序里的第一个         | 四侧 `overlap` 相等，`chosen` = `candidates[0]`        |
| 四侧都压到选区时取压住最少的一侧，而不是固定取第一个   | side = right，且 `overlap` 等于四侧最小值              |
| 窗口比面板还小：四个方向夹取后落在同一块               | 四者同分 → side = below，坐标退到 margin               |
| 四侧都压到选区时结果是确定的                           | 三组退化输入各算两次，`deepEqual`                      |
| 选区量不到时退回锚点定位                               | avoid = null 时无重叠、仍居中落在下方                  |
| 宽或高为 0 的让开矩形按没有选区处理                    | `overlap === 0`                                        |

### 面板这一侧（DOM 接线）

| 用例                                         | 断言的事                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| 浮动工具栏压在选区上时，面板仍要让开整段选区 | 下沿落在**选区**下沿 + 8，而不是工具栏下沿 + 8                            |
| 选区贴着视口底部时面板翻到选区上方           | `top = 282px`（选区上沿 − 面板高 − 8）                                    |
| 选区高过面板时面板挪到选区右侧               | `left = 678px`（选区右沿 + 8），竖向居中                                  |
| 窗口缩放之后面板重摆一次                     | 改几何 → `resize` → 坐标跟着变                                            |
| 正文滚动之后面板重摆一次                     | 滚动容器内部的 `scroll`（捕获阶段）与 window 上的 `scroll` 都收得到       |
| 滚面板自己的内容不重摆                       | 面板上的 `scroll` 不改坐标                                                |
| destroy 之后缩放与滚动都不再带着面板走       | 销毁前是活的（前提断言），销毁后坐标不再变                                |
| 坐标按文档坐标系写出：滚动偏移一并加上       | 视口里位置不变、`scrollY = 500` 时文档坐标 +500；退回边距那条出口同样成立 |
| 移动端走同一套定位                           | mobile 前端下同样避开整段选区                                             |

### 样式表源码（按既有模式，读 `src/index.scss` 原文）

`面板根的尺寸约定与定位一致：最大宽度让出视口边距，高度只受 max-height 约束`：
从 `src/panel.ts` 源码里读出 `VIEWPORT_MARGIN` 的值，再去 `index.scss` 里核对
`max-width: calc(100vw - 24px)`；另核对 `box-sizing: border-box`、
`[data-sue-panel]` 规则体里不得出现 `height:`，以及限高与 `overflow-y: auto` 仍在 `panel.ts` 的内联样式上。
这与既有的 `面板根有不透明表面…` 同一种做法：jsdom 不应用样式表，只能核对源码。

### 既有契约仍然成立（未改、未削弱）

`面板挂到 body 上并带 data-sue-panel 标记`、`destroy 移除面板元素、摘掉挂在 document 上的监听并让面板彻底失效`、
`面板根与每一类控件上的 mousedown 都被拦下…`、`destroy 之后不再拦 mousedown`、
`锚点脱离文档时不参与定位，面板退回视口边距`、`面板按锚点水平居中落在下方，并夹取在视口内`、
`锚点贴近右缘时面板被夹回视口内`、`锚点贴近底部时面板翻到锚点上方`、
`面板比视口还高时纵向坐标退到视口内而不是被推到视口外` —— 全部原样通过。
后四条断言的是「量不到选区时」的那条路径，与新算法给出的落点一致。

## jsdom 验不了的部分（必须说清楚）

**jsdom 不能验证任何视觉摆放。** 它没有布局引擎，`getBoundingClientRect()` 恒为全零，
`Range.getBoundingClientRect` 根本不存在，样式表也不生效。
因此上面所有断言验的是三件事：

1. **纯函数在给定矩形下的决策**（往哪一侧、重叠多少）—— 这是真断言，用合成矩形走完整条规则；
2. **DOM 接线**（量的是选区不是锚点、viewport 坐标换算成文档坐标、视口事件会触发重摆、
   `destroy` 之后不触发）—— 矩形全部由夹具显式给出；
3. **样式表源码的字面内容** —— 按既有模式读文本。

验不了的：「面板在真机上真的没有压到那段文字」。这一条只能在真实思源里看。

## 需要真机确认的清单

* **思源点开工具栏按钮时，活选区还在不在。** 面板只拿得到 `options.anchor`
  （`IMenuItem.click` 只给 protyle 实例），因此 `selectionRectOf` 读的是
  `window.getSelection()`，而不是思源内部 `toolbar.range`。
  两者在正常路径下是同一个 Range（面板与工具栏都吃了 `mousedown` 的 `preventDefault`，编辑器不失焦），
  但 jsdom 里造不出这个前提。**如果真机上量不到选区，面板会退回锚点定位**，
  表现与本次改动前一致 —— 即「工具栏下方居中」，不会报错，也不会遮住更多文字。
  用户看到的就是「窗口还是压在字上」这一条需求没达成。**这是本次改动最需要真机确认的一点。**
* **高选区时挪到右侧/左侧的手感。** 面板 300px 宽，选区两侧要各空出 320px / 312px 才挪得开；
  正文占满窗口宽度时，四面都放不下，会落到三档兜底（压得最少的一侧）。
* **滚动时面板会不会抖。** 思源的编辑区滚动 + 面板重摆是每帧一次几何测量；
  坐标没变时已经跳过写 `style`，但真机上是否还有可见抖动要看一眼。
* **面板自身滚动条能不能拖。** 面板根既是表面又是滚动容器（限高 + `overflow-y: auto`，
  两者都在 `src/panel.ts` 的内联样式上，不在 `src/index.scss` 里），
  而面板根上有一个 `mousedown` → `preventDefault()` 的守卫（为了保住编辑器焦点与选区），
  落在滚动条上的按下也会被它拦一下 —— **这一条本次没有改动，也没有被这次改动变坏**：
  新加的 `scroll` 监听对来自面板的滚动直接返回，不会因为面板内部的滚动反过来挪动面板。
  主流浏览器里滚动条的拖动由 UA 自己处理，但「窗口很矮时拖滚动条还能不能滚面板」
  建议在真机上看一眼（先前那份报告也记了同一条）。
* **移动端窄屏。** 360px 宽的手机上 `max-width` 会把面板压到 336px，左右两侧基本无处可去；
  移动端限高 60vh，上下两侧更容易成立，因此多半落在上下。
* **RTL 文档。** 本次不引入 RTL 处理（仓库里本来也没有），候选里的左右是几何左右，行为与 LTR 相同。
  如果日后要按书写方向决定优先侧，那是另一件事。

## 命令与结果

```
npm run lint                              exit 0
npm test                                  260 pass / 0 fail   （本套件 71 pass，改动前 50）
node node_modules/typescript/bin/tsc --noEmit   exit 0
npm run format:check                      exit 0
npm run build                             exit 0（webpack compiled successfully）
```

格式只对自己动的三个文件跑过 `dprint fmt src/placement.ts src/panel.ts tests/panel.test.mjs`，
避免与同仓库另一处并行改动互相覆盖；`dprint check` / `eslint .` 是全仓库跑的，两者都通过。
