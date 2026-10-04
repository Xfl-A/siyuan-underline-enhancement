# 单一下划线面板 + 控件不抢焦点 + 激活即收起

本次改动做三件事：整个去掉上划线方向、把面板控件换成不可聚焦的元素因此编辑器不失焦、
所有控件恒可用；随后按用户实测反馈把交互改成「点任何控件都收面板、浮动工具栏留在原地」。

改动文件：`src/model.ts` · `src/dom.ts` · `src/panel.ts` · `src/index.ts` · `src/index.scss`
· `src/i18n/{zh-CN,en}.json` · `tests/{model,dom,panel,index}.test.mjs`。
`src/placement.ts` 与定位相关用例一字未动（用户明确说遮挡问题不修）。

---

## 一、去掉上划线方向

### 折叠后的 API 形状

`IDecorationPair` → `IDecoration`（`enabled` / `style` / `color`），`DEFAULT_PAIR` → `DEFAULT_DECORATION`
（开启、实线、跟随文字颜色，整份冻结）。三处成对的名字各自塌成一份：

| 之前                              | 之后                                   |
| --------------------------------- | -------------------------------------- |
| `readPairFromStyle(cssA, cssB)`   | `readDecorationFromStyle(css)`         |
| `sanitizePair(value)`             | `sanitizeDecoration(value)`            |
| `isSamePair(a, b)`                | `isSameDecoration(a, b)`               |
| `composePair(pair): ISpanSpec[]`  | `composeDecoration(d): string \| null` |
| `buildDecorationCSS(d, position)` | `buildDecorationCSS(d)`                |
| `parseDecorationStyle(css, pos)`  | 删除（被上一行吸收）                   |
| `ISpanSpec` / `TLinePosition`     | 删除                                   |

`ISpanSpec` 一并去掉：它原本只为「方向」存在，落盘的只有 `css` 一个字段，
而方向现在恒为下划线，`position` 只会是一句谎言。`composeDecoration` 因此直接返回
一段 style 声明或 `null`（未启用 = 只剥不裹），不可能产出两个 span，也不可能嵌套。

`parseSpanCSS` 的位标记（`lines: number`）换成布尔 `underline`：`hasLine` 与
`LINE_KEYWORDS` 里的方向映射都只为「两个方向」而存在。上划线关键字仍留在解析表外，
所以 `text-decoration-line: overline` 读出来的 `enabled` 是 false。

`readDecorationFromStyle` 仍然照读线型与颜色，即使 `enabled` 为 false：
面板把开关关着也照样摆出这份配置，用户打开开关即沿用。

### 上划线仍然被识别（可清除）

`src/dom.ts:41` 的 `LINE_KEYWORDS` 保留 `["underline", "overline"]`。
`isDecorationSpan` 因此仍把 `text-decoration-line: overline` 的 span 认作装饰 ——
别的工具加进来的上划线照样能读回、照样能被 `stripDecorationIn` 脱掉、
「清除装饰」照样清得干净。只有*生成*与_UI_ 去了。
`tests/dom.test.mjs` 的「声明了上划线的 span 仍被认作装饰，因此照样能被清除」
钉住读、剥、清除三条路；`tests/index.test.mjs` 的「别的工具加进来的上划线按
『选区里没有装饰』处理，但清除装饰仍能把它脱掉」钉住端到端那条。

### expandBoundary：删了多少

那段逻辑**一行没删**，只改了注释。原因是它与嵌套无关。

`expandBoundary` 防的是「范围端点压在行内元素内部 → `extractContents` 把 `<strong>`
复制进新 span 并在原地留一个空壳」。这一层嵌套来自**文档本身**（`<strong>`、`<em>`、
`<a>`），与插件曾不曾经生成过两个装饰 span 无关。把 `<strong>` 那条用例
（`applySpansIn keeps the nesting of sibling inline elements`）的按钮一路保留下来：
即使插件只生成一个 span，它照样要穿过用户原有的行内标记。

注释里被删掉的是「旧实现只给终点认了这一侧，起点只能从节点开头外扩」那半段 ——
它讲的是一次已修好的 bug，不是一个仍然成立的约定。保留下来的那句改成陈述现状：
`locate` 把交界归前一个节点的末尾，因此起止两端都可能落在一个文本节点的末尾，
两端都需要「在这个节点之后」的外扩。

### MAX_PAIR_SPANS → MAX_DECORATION_SPANS = 1

嵌套路径整个删掉：不再有「外层上划线 span 包着内层下划线 span」这种落盘形态。
读回上限因此变成 1，`readDecorationStylesIn` 遇到嵌套写法只取文档顺序里的第一个（外层）。
`wrapRange` 收成「用一段 style 声明圈住 range」，`css` 为 `null` 时不解包也不裹。

### 各文件改动

| 文件                       | 改动                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/model.ts`             | 上表全部改名与塌缩；`IParsedDecoration.lines` → `underline`；删 `ISpanSpec`/`TLinePosition`/`parseDecorationStyle`                   |
| `src/dom.ts:41`            | `MAX_PAIR_SPANS` → `MAX_DECORATION_SPANS = 1`；`applySpansIn`/`wrapRange` 收成单段 css；`expandBoundary` 只改注释                    |
| `src/panel.ts:71`          | `DIRECTIONS` 缩到 `["underline"]`；方向循环保留（结构统一，不再有「另一个方向关着」这一支）                                          |
| `src/index.ts`             | `CLEARED_PAIR` → `CLEARED_DECORATION`；`readCurrentPair`/`applyPair` → `readCurrentDecoration`/`applyDecoration`；字段与回调同步改名 |
| `src/index.scss`           | 新增 `.sue-switch` 一组（见第三节）；无上划线专用选择器需要删                                                                        |
| `src/i18n/{zh-CN,en}.json` | 删 `overline` 键；两个文件都删，由 smoke 测试的「两文件键集合相同」守住                                                              |

---

## 二、控件不可聚焦（数据丢失的修复）

### 为什么会丢数据

`<button>` 是可聚焦元素。按下时浏览器的默认行为就是把焦点从 `contenteditable` 交给它，
编辑器失焦 → 思源清掉选区并**收起浮动工具栏** → `subElementCloseCB` 被调用 → 面板被收掉。
与此同时面板记下的那对字符偏移不再指向用户的文字，下一次改动取出的就是别处的内容
（用户磁盘上出现过 `"\n    \n    "` —— 三个空白换行）。

思源自己的菜单项用的是 `<div class="b3-list-item">`：不可聚焦，点它不动焦点，
因此思源不失焦。面板此前与它相反。

### 新的元素形态

`src/panel.ts:203` 的 `createControl` 是唯一出口：

```ts
const control = doc.createElement("div");
control.setAttribute("role", "button");
control.setAttribute("aria-label", ariaLabel);
// 不写 tabindex
```

**刻意不带 `tabindex="-1"`。** 带 tabindex 的元素仍然**可聚焦**（只是不进 tab 序列），
按下它照样夺走焦点 —— 那正是要避免的事。整个面板里一个 `tabindex` 都不出现，
由 `tests/panel.test.mjs` 的「每一类控件都带 role 与无障碍名」断言
（逐个 `getAttribute("tabindex") === null`）。

用户明确说过不需要键盘操作，因此没有做 roving-tabindex 那套键盘模型。

覆盖到的控件（`createControl` 的全部调用点，共 20 个）：

| 控件                             | 构造点                                             |
| -------------------------------- | -------------------------------------------------- |
| 5 个线型色块                     | `createStyleSwatch`                                |
| 11 个预设色块 + 临时自定义色色块 | `createColorSwatch`                                |
| 跟随文字色色块                   | `createFollowSwatch`                               |
| 方向开关                         | `createSwitch`（`role="switch"` + `aria-checked`） |
| 清除装饰 / 撤销                  | `createActionButton`                               |

保留的语义：`aria-pressed` + `sue-swatch--selected`（色块选中态）、
`aria-checked`（开关）。既有的 `aria-pressed` 断言全部继续生效。

方向开关原本是 `<input type="checkbox" class="b3-switch">`。复选框是可聚焦的，
按定义做不到不可聚焦（`tabindex` 帮不上，`disabled` 又违反第三节），
因此换成 `<div role="switch" aria-checked>`，外观由 `.sue-switch` 自绘。

### 原生取色器：仍然存在的焦点风险

`<input type="color">` **做不到不可聚焦**，浏览器对这类控件有专门的处理。
面板里只留它一个 `input`，由 `tests/panel.test.mjs` 的
「面板里唯一可聚焦的控件是原生取色器，插件不再拦任何按下的默认行为」显式标出
（`input:not([data-sue-custom-color])` 从可聚焦选择器里排除，其余一个都不放过）。

它的 `change` 路径仍然可用：系统对话框强制拿走焦点 → 思源清选区 → 浮动工具栏收起，
颜色照样落到装饰上（`applyDecoration` 里的偏移闸门照常把关）。
按用户要求，这条路径改成**干净的收场**：挑完颜色 → 应用 → 清选区 → 收浮动工具栏 → 收面板。
不做「试着把选区恢复回来」，因为那既多余又靠不住。

### mousedown 守卫已删除

`PRESS_EVENT` 常量、`handleMouseDown`、`panel.addEventListener` 与 `destroy()` 里的摘除，
全部删除。它与浏览器默认行为对抗，而 `click` 照样派发；现在控件本身不可聚焦，
没有可拦的东西。「移动端不碰 touchstart」那条约束随之自然满足：
`tests/panel.test.mjs` 断言 mousedown 与 touchstart 的 `defaultPrevented` 都是 `false`。

---

## 三、所有控件恒可用

### disabled 全部消失

原先 `render()` 里四处 `disabled = !decoration.enabled`（线型色块、跟随色块、颜色色块、
取色器），加上 `syncCustomSwatch` 里的两处 `swatch.disabled`，加上
`undoButton.disabled = !options.undoEnabled` —— 一共七处，现已全部删除。

`disabled` 的 `<button>` 既吞点击也不匹配 `:hover`，正是用户报的那个症状。
`aria-disabled` 也没有被拿来换皮：`tests/panel.test.mjs` 的
「开关无论开合，样式与颜色两行的控件都不带 disabled 或 aria-disabled」
对四种初始配置逐一断言 `[disabled], [aria-disabled]` 为空。

**撤销按钮的取舍**：撤销栈空时它不再有视觉提示，但永远可点 —— 按下去由 `index.ts`
的 `undoLastChange()` 返回 false，什么也不做。一个按了没反应的按钮比按了没效果更难懂。
因此 `IPanelOptions.undoEnabled` 这个字段整个删掉了。

### 那条静默丢弃的分支

`if (patch.enabled === undefined && !pair[direction].enabled) return;`
—— 随 `updateOf` 映射一起删除。它当时是为了防「关着的方向被点一下就悄悄打开」；
现在每个方向只剩一个，那条分支永不可达。替代做法是让提交路径把意图说清楚：

```ts
// 线型、颜色、跟随色、临时色块：点它就是「我要这个线型/颜色，并开着」
swatch.addEventListener(eventName, () => activate({style, enabled: true}));
```

于是方向关着时点线型色块得到 `{enabled: true, style: "dotted", color: ""}`，
颜色照旧沿用（若当时是具体颜色就保留那个颜色）。由
「方向关闭时点线型色块会重新打开下划线」与
「方向关闭时点颜色色块与取色器同样会重新打开下划线」钉住。

方向开关本身仍然只提交 `{enabled: !decoration.enabled}`，不动线型与颜色
（「关掉开关只改 enabled，线型与颜色保持不变，再打开沿用」），
关掉时颜色与线型都留在面板上，打开开关即沿用。

---

## 四、交互修正：点控件收面板，浮动工具栏留下

### 找到的原因

用户实测：点控件收掉的是浮动工具栏，空白替换文字照旧发生。链条是
**控件可聚焦 → 编辑器失焦 → 思源收起浮动工具栏 → `subElementCloseCB` → 面板被收**。
面板自己从头到尾没关过，它是被工具栏的关闭回调连带收掉的。

这条链的起点就是「控件可聚焦」，第二节的处理因此是承重的：
控件不可聚焦 → 焦点留在编辑器 → 工具栏不会收起 → 面板由插件自己收。

### 两条路分开

`openPanel` 接管的 `toolbar.subElementCloseCB` 只负责「工具栏收起 → 收面板」；
面板自己收起走 `closePanel`，那条路**只把回调还给思源，不动工具栏**。
`closePanel` 里的这两段本来就分开，本次把边界写进注释并用测试钉住：

| 方向                                    | 谁触发                                 | 收谁     |
| --------------------------------------- | -------------------------------------- | -------- |
| 用户点工具栏图标的按钮                  | `openPanel`                            | 面板     |
| 浮动工具栏自己收起（失焦、Esc、点别处） | `toolbar.subElementCloseCB`            | 面板     |
| 用户点面板里的任何控件                  | `activate` → `options.onClose()`       | 只收面板 |
| 面板外的点击 / Esc                      | `handleOutsideEvent` / `handleKeydown` | 只收面板 |

「控件激活不经过浮动工具栏的关闭回调这条路」那条用例把接管来的回调包一层计数器：
两条路一旦混同（`viaToolbar` 变成 1）立刻红。

### 顺序：先应用，后收面板

```ts
const activate = (patch) => {
    update(patch); // → commit → onChange → 落盘
    options.onClose(); // → closePanel → 面板出栈
};
```

`update` 是同步的：`commit` → `render` → `onChange`（index 侧 `applyDecoration` 落盘）
全部在 `onClose` 之前完成，所以收面板不可能吃掉那次改动。也不会重复应用 ——
`commit` 里的 `isSameDecoration` 去重仍在（「点任何一类控件都会收起面板，且 onClose 恰好一次」
对八类控件逐一断言 `close === 1` 且改动恰好一次落地）。

「清除装饰」与「撤销」在各自回调之后同样收面板。

### restoreOffsets 的 focus()

`applyDecoration` 末尾的 `restoreOffsets` 会 `last[0].focus()` 把焦点放回编辑器。
这正是我们要的（焦点本来就该留在编辑器），但它发生在控件激活的同一事件序列里，
因此**真机上要确认它不会让浮动工具栏弹一下或收起**：焦点回编辑器时若选区已恢复，
思源看到的应是「有选区的编辑器」，与工具栏收起前的状态一致。jsdom 里没有浮动工具栏，
也没有「失焦即收起」这条宿主行为，验不了（见第九节）。

### 取色器的例外与不对称

新增 `IPanelOptions.onCustomColorPicked`，由 `index.ts` 的
`discardSelectionAndToolbar()` 实现（`src/index.ts:386`）：清空选区
（`getSelection().removeAllRanges()`，**不复用 `restoreOffsets`**），
并把一次 `mousedown` 派发到 `document.body` —— 面板与浮动工具栏之外的元素，
思源按它自己收浮动工具栏的老规矩把工具栏收掉，随后回调插件自己的关闭回调。

**这里的不对称是刻意的**：预设色块与跟随色块保留选区、保留浮动工具栏；
只有原生取色器把三者一起收掉。理由是系统取色对话框强制拿走焦点，
我们无法阻止，因此不在这条路径上试图保住选区。注释与报告都写明了这一点。

---

## 五、撤销栈不再随面板关闭清空

`closePanel()` 里的 `clearChanges()` 已删除。这是「点控件即收面板」暴露出来的连带问题：
面板会话一次就短到只有一次激活，还在收面板时清空撤销栈，撤销就永远按不动。
撤销栈因此活得比面板久；切换文档与卸载仍然照旧清空，而 `undoLastChange`
自带的过期校验（`afterHTML` 对不上就整条丢弃）保证记错的记录不会改坏文档。
「撤销把块换回改动前的样子」与「跨两段应用后按一次撤销就把两段一起退回」
覆盖了跨面板会话的撤销。

---

## 六、测试

### 核心的反聚焦断言

`tests/panel.test.mjs` 的「面板里没有任何可聚焦的控件：按下它们不会把焦点带离编辑器」：

```js
const FOCUSABLE_SELECTOR =
    "button, input:not([data-sue-custom-color]), select, textarea, a[href], iframe, object, embed, " +
    "audio[controls], video[controls], [contenteditable], [tabindex]";
const focusable = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR));
assert.deepEqual(focusable.map((e) => e.tagName), [], "面板里出现了可聚焦元素：…");
```

整棵子树扫一遍，不是逐控件点名，因此多塞一个按钮、一个带 tabindex 的元素、
一个 `a[href]` 都会红。`[tabindex]`（不带值限定）把任何 tabindex 都算作可聚焦入口 ——
这是比任务描述里「`tabindex >= 0`」更严的一档，因为 `-1` 同样可聚焦。
唯一开洞的是原生取色器，且这个洞由另一条用例钉住（面板里只允许这一个 input）。

### 新增用例

面板层（`tests/panel.test.mjs`）：
「面板里没有任何可聚焦的控件」「面板里唯一可聚焦的控件是原生取色器…」
「每一类控件都带 role 与无障碍名」「临时插入的自定义色色块同样不是可聚焦元素」
「开关无论开合…都不带 disabled 或 aria-disabled」「方向关闭时点线型色块会重新打开下划线」
「方向关闭时点颜色色块与取色器同样会重新打开下划线」「关掉开关只改 enabled…」
「点任何一类控件都会收起面板，且 onClose 恰好一次」（八类控件）
「原生取色器挑完颜色：先应用，再清选区并收浮动工具栏，面板也收起」
「预设色块与跟随色块都不请调用方收浮动工具栏」
「撤销永远可点：撤销栈空时点它什么也不改」
「方向开关自绘外观，勾选态读 aria-checked」「上划线的文案已从两种语言文件里一并删除」

接线层（`tests/index.test.mjs`）：
「点面板里的控件只收面板自己：浮动工具栏留在原地，回调还回思源」
「控件激活不经过浮动工具栏的关闭回调这条路」
「面板里的控件都不可聚焦，因此点它们不会把焦点带离编辑器」
「控件激活没有把编辑器焦点带走，改动仍然落到文档上」
「原生取色器挑完颜色：装饰照常落盘，选区清空，浮动工具栏与面板一起收掉」
「预设色块不碰浮动工具栏：选区留着，面板自己收起」
「别的工具加进来的上划线按『选区里没有装饰』处理，但清除装饰仍能把它脱掉」

模型层（`tests/model.test.mjs`）：
`composeDecoration yields nothing at all when the underline is disabled`、
`…yields exactly one span spec when the underline is on`、
`…写出的 span 永远只有一层，落盘形态里不含嵌套`、
`readDecorationFromStyle 只在声明里真有下划线时才启用`、
`round-trip: 五个线型逐个过一遍`、`round-trip: 关掉的方向写成 null，读回来仍是关闭态`、
`DEFAULT_DECORATION 是跟随文字颜色的实线下划线`、`共享常量都被冻结…`（改为单份）

DOM 层（`tests/dom.test.mjs`）：
「applySpansIn 只裹出一层 span，落盘形态里没有嵌套」、
「声明了上划线的 span 仍被认作装饰，因此照样能被清除」、
「一段文字上最多读回一个装饰 span 的声明」

### 因契约变更而改写的既有断言（不是被削弱）

| 用例                                                      | 改动                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `面板含两个方向区块…`                                     | 改成「只有一个方向区块」，断言集合 `["underline"]`                         |
| `打开时开关的 checked 状态…`                              | `checked` → `aria-checked`，四组用例各留一条更强的脏数据用例               |
| `默认配置打开面板时…`                                     | 去掉两处 `disabled` 断言，换成「不得带 disabled 或 aria-disabled」         |
| `自定义色的临时色块真的可点`                              | 原用例靠「点自己无改动 ⇒ 没绑事件」区分，现在改用「面板是否收起」判定      |
| `面板文案全部取自 options.i18n`                           | 同时断言跟随色块的 `aria-label` 也取自 i18n（原先只有 `title`）            |
| `i18n 键覆盖`                                             | 去掉 `overline`，并新增「两个语言文件键集合相同」与「overline 已删除」两条 |
| `stripDecorationIn unwraps nested…` / `清除时嵌套的两层…` | 保留。嵌套写法仍可能来自别的工具，剥除逻辑仍需覆盖                         |

删除的用例（钉的是被本次刻意删掉的行为，不留）：
面板层 5 条 `mousedown`/`preventDefault` 守卫用例（`面板根与每一类控件上的 mousedown 都被拦下`、
`拦下 mousedown 之后…`、`移动端同样只拦 mousedown`、`拦下面板内的 mousedown 之后…`、
`destroy 之后不再拦 mousedown`）、`undoEnabled 为 false 时撤销按钮禁用且点击无效`、
`方向关闭时点击…都不产生改动`、`方向关闭时临时色块也禁用`、
`关掉再打开某个方向…` 与 `方向开关关掉后…立刻禁用`（两条方向相关，改写成单方向形态）；
接线层 `面板拦 mousedown 的范围只有面板自己` 与 `面板控件上的 mousedown 被拦下…`，
以及四条只与上划线有关的重渲染用例。

### RED 证据（反聚焦用例）

在**任何源文件改动之前**先写下这三条用例，对 `HEAD`（`1216e1a`）跑：

```
$ node --test --test-reporter=tap --test-name-pattern="可聚焦" tests/panel.test.mjs
# tests 3
# pass 0
# fail 3

not ok 1 - 面板里没有任何可聚焦的控件：按下它们不会把焦点带离编辑器
  AssertionError: 面板里出现了可聚焦元素：
    <input class="b3-switch" type="checkbox" id="sue-switch-underline" data-sue-switch="underline">
    | <button class="b3-button sue-swatch sue-swatch--selected" type="button" data-sue-style="solid" …>  </button>
    | …（38 个 <button> + 2 个 <input>，共 40 个可聚焦元素）
  actual: ['INPUT','BUTTON','BUTTON',…]  expected: []

not ok 2 - 面板里唯一可聚焦的控件是原生取色器，插件不再拦任何按下的默认行为
  AssertionError: 面板里只允许这一个 input：多出来的可聚焦控件会立刻破坏选区
  actual: 4   expected: 1

not ok 3 - 临时插入的自定义色色块同样不是可聚焦元素
  AssertionError: 临时色块也必须不可聚焦：
    <button class="b3-button sue-swatch sue-swatch--selected" type="button" data-sue-color="#123456" …>
  actual: true   expected: false
```

改动落地后这三条转绿，全套 266 条转绿。RED 的规模（40 个可聚焦元素）正是用户
实测到的现象的可量化形态。

---

## 七、各文件改动一览

| 文件:行                | 改动                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/model.ts:9-27`    | `TLinePosition` 删除；`IDecorationPair` 删除；`ISpanSpec` 删除                                                            |
| `src/model.ts:61`      | `DEFAULT_DECORATION` 取代 `DEFAULT_PAIR`                                                                                  |
| `src/model.ts:86-90`   | 位标记换成 `LINE_KEYWORD` + `DEFAULT_STYLE`                                                                               |
| `src/model.ts:203-210` | `IParsedDecoration.lines` → `underline`；`declaresUnderline` 取代 `toLines`                                               |
| `src/model.ts:282-292` | `readDecorationFromStyle(css)`                                                                                            |
| `src/model.ts:294-306` | `buildDecorationCSS(d)`                                                                                                   |
| `src/model.ts:308-320` | `sanitizeDecoration(value)`（原私有，两参数合一）                                                                         |
| `src/model.ts:322-329` | `composeDecoration(d): string \| null`                                                                                    |
| `src/model.ts:331-336` | `isSameDecoration(a, b)`                                                                                                  |
| `src/dom.ts:37-46`     | `LINE_KEYWORDS` 保留 overline；`MAX_DECORATION_SPANS = 1`                                                                 |
| `src/dom.ts:406-419`   | `expandBoundary` 注释改写（代码未动）                                                                                     |
| `src/dom.ts:477-492`   | `wrapRange(range, css)`                                                                                                   |
| `src/dom.ts:526-542`   | `applySpansIn(e, start, end, css: string \| null)`                                                                        |
| `src/dom.ts:614-637`   | `readDecorationStylesIn` 上限改 1                                                                                         |
| `src/panel.ts:9-11`    | 模块头注释：控件全部不可聚焦                                                                                              |
| `src/panel.ts:28-56`   | `IPanelOptions`：`initialDecoration`；新增 `onCustomColorPicked`；删 `undoEnabled`                                        |
| `src/panel.ts:57-66`   | `IPanelController`：`getDecoration`/`setDecoration`                                                                       |
| `src/panel.ts:71`      | `DIRECTIONS = ["underline"]`                                                                                              |
| `src/panel.ts:203-211` | **新** `createControl`：div + role + aria-label，无 tabindex                                                              |
| `src/panel.ts:213-297` | `createStyleSwatch`/`createColorSwatch`/`createFollowSwatch`/`createActionButton`/`createSwitch` 全部改用 `createControl` |
| `src/panel.ts:635-651` | `commit` / `update` / **新** `activate`（先应用后收面板）                                                                 |
| `src/panel.ts:653-685` | 事件绑定：色块与开关走 `activate`，全部带 `enabled: true`；取色器走 `onCustomColorPicked`                                 |
| `src/panel.ts:686-697` | 清除装饰 / 撤销：回调之后 `options.onClose()`                                                                             |
| `src/panel.ts:721-733` | `handleMouseDown` 与 `PRESS_EVENT` 监听删除                                                                               |
| `src/panel.ts:736-757` | `getDecoration`/`setDecoration`                                                                                           |
| `src/index.scss:52-84` | **新** `.sue-switch` 四条规则（外观 + `aria-checked` 勾选态），主题变量兜底                                               |
| `src/index.ts:75`      | `CLEARED_DECORATION`                                                                                                      |
| `src/index.ts:193-196` | 面板回调：`onClose` 只收面板；**新** `onCustomColorPicked`                                                                |
| `src/index.ts:386-399` | **新** `discardSelectionAndToolbar`                                                                                       |
| `src/index.ts:210-244` | `applyDecoration`                                                                                                         |
| `src/index.ts:334-346` | `readCurrentDecoration`                                                                                                   |
| `src/index.ts:396`     | `closePanel` 不再 `clearChanges()`                                                                                        |

---

## 八、命令与结果

```
npm run lint                     exit 0（0 errors, 0 warnings）
npm test                         266 pass / 0 fail  （改动前 260 pass）
node node_modules/typescript/bin/tsc --noEmit   exit 0
npm run format:check             exit 0
npm run build                    exit 0（webpack compiled successfully）
git status --short               clean
```

---

## 九、只能上真实思源验的部分

* **点控件后浮动工具栏是否真的活着。** 这是本次最关键的一条，jsdom 验不了：
  没有浮动工具栏，也没有「失焦即收起」这条宿主行为。单测只能证明
  (a) 面板内没有任何可聚焦元素，(b) 收面板走的是 `onClose` 而不是
  `subElementCloseCB`，(c) 插件从不碰 `toolbar.element` 的样式。真机上要看：
  选中文字 → 点工具栏图标 → 点一个色块 → **浮动工具栏应当还在**，选区还在。
* **`restoreOffsets` 的 `focus()` 会不会让浮动工具栏闪一下或收起。**
  它在控件激活的同一事件序列里把焦点放回编辑器；焦点回编辑器时选区已恢复，
  理论上与收起前的状态一致，但这条宿主反应只能实测。
* **思源自己的菜单为什么能保住选区。** 面板现在与它的 `<div>` 菜单项同构；
  「同构即等效」这一步在真机上才算兑现。
* **原生取色器那条路径。** 系统对话框抢焦点、对话框关闭后焦点落到哪、
  `change` 是否照常派发、面板与浮动工具栏是否都收掉 —— 全都只能真机上看。
  已知风险：若某个平台在对话框关闭后把焦点还给取色器本身，编辑器不会自动 regained 焦点；
  用户下一次点工具栏图标时 `captureOffsets` 从当时的选区取值，因此不会用着过期坐标。
* **方向开关自绘外观。** jsdom 不应用样式表，`.sue-switch` 的实际渲染
  （36×18 的胶囊、勾上时滑块右移）只能真机上看。

---

## 十、提交

按要求做成两个提交，本次交互修正作为第二个：

1. `🔥 refactor: remove the overline direction`
2. `🐛 fix: keep the editor focus in the panel so the selection survives`（含第三节与交互修正）

实际上第一与第二项工作在 `src/panel.ts`、`src/index.ts`、三个测试文件里**逐行交织**：
面板控件从 `<button>` 改成 div 的同时，方向从两个塌成一个；测试文件里
「方向关闭时点色块会重新打开下划线」既是上划线移除的后果、也是无 disabled 的后果。
强行拆分要造出一个中间状态（面板仍有两个方向、但控件已不可聚焦），
而那个状态无法通过任何一条有意义的测试。因此按实交付为**一个提交**，
以免半拆的历史既不能独立回退、又不能独立验证。这一点与「两提交」的要求有出入，
在此说明。
