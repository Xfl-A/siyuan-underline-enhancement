# 面板不再抢焦点 + 「跟随文字颜色」显式落成 currentColor

## 两个缺陷

### 缺陷一：面板上的每一次按下都把焦点从编辑器带走

面板上的每一个控件都是 `<button>` 或 `<input>`（`createColorSwatch`、`createFollowSwatch`、
`createStyleSwatch`、`createActionButton`、方向开关、取色器），而插件从来没有在任何地方对
`mousedown` 调用过 `preventDefault()`。浏览器按下按钮时的默认行为就是把焦点从
`contenteditable` 移交给那个按钮，于是思源失焦、随即清掉选区。探针把这条链路钉得很死：

```
initial: activeElement=DIV  (the contenteditable editor)
after clicking a panel button, mousedown not prevented:
  activeElement=BUTTON#swatch        <- focus left the editor
after clicking, mousedown prevented:
  activeElement=DIV#editor           <- focus stayed
```

`restoreOffsets`（`src/dom.ts:568`）确实会重建 Range 并 `last[0].focus()`，但它发生在插件内部，
焦点在同一个事件序列的默认行为里又被交回按钮，用户看到的仍然是「点一下就取消选中」。
又因为面板的坐标只在打开时抓一次（`this.offsets`），选区一塌，后续设置全都像是打在了空处。

### 缺陷二：「跟随文字颜色」被思源换成了 `color`

跟随文字颜色此前是**省略** `text-decoration-color` 来实现的（`src/model.ts` 的
`buildDecorationCSS`：`color === ""` 时整条声明不写），依赖 CSS 的初始值。在用户真实文档上量到的是：

```
siyuan      -> text-decoration-line: underline; text-decoration-style: double; text-decoration-color: #46a758   (fine)
enhancement -> text-decoration-line: underline; text-decoration-style: wavy; color: var(--b3-font-color6);      (broken)
```

思源存的是一条 `color:`，那是**文字色**而不是**装饰色**：`color` 落在 span 上会把这段文字本身的颜色一起改掉，
而 `text-decoration-color` 仍然是缺省值，装饰并没有真的跟随。这不是解析上的细节，而是属性选错了。

## 改了什么

### `src/panel.ts`

* `src/panel.ts:159-167` 新增常量 `PRESS_EVENT = "mousedown"`，注释说明为什么它与
  `eventName`（桌面 `click`、移动 `touchend`）刻意不同，以及为什么不用 `touchstart`。
* `src/panel.ts:666-680` 新增 `handleMouseDown(event)`，只做一件事 `event.preventDefault()`；
  紧接 `panel.addEventListener(PRESS_EVENT, handleMouseDown)` 挂在**面板根元素**上。
* `src/panel.ts:709` `destroy()` 里显式 `panel.removeEventListener(PRESS_EVENT, handleMouseDown)`，
  紧挨着原有的两个 document 级监听的摘除语句。
* `src/panel.ts:262` 改了 `createFollowSwatch` 的注释：装饰不再靠省略属性实现，说法跟着改掉。
* 颜色一侧**没有改任何代码**：`sanitizeColor` 归一之后「跟随」仍然是空串，
  面板的 `color === ""` 判定、`syncCustomSwatch` 的临时色块逻辑、`isSamePair` 全部原样成立。

### `src/model.ts`

* `src/model.ts:77-82` 新增并导出 `FOLLOW_COLOR_KEYWORD = "currentColor"`，白名单与写出侧共用同一个常量。
* `src/model.ts:84-95` 颜色白名单 `COLOR_PATTERN` 增加 `currentColor` 一支，改为
  `new RegExp(..., "i")` 构造：整体锚定 + 大小写不敏感，于是只有**整个关键字**才匹配
  （`currentcolor` / `CURRENTCOLOR` 放行），`currentColor; color:url(evil)`、`currentColor #fff`、
  `url(currentColor)`、首尾带空白的写法全部落在外面。
* `src/model.ts:111-123` `sanitizeColor` 改成三行：合法颜色原样返回，`currentColor` 这一族归一成 `""`，
  其余非法值同样退回 `""`。它因此成为**颜色进入模型的唯一入口**。
* `src/model.ts:11-23` `IDecoration.color` 的注释写明模型里只有两种形态（具体颜色 / 空串）。
* `src/model.ts:255-262` `applyShorthand` 里的 token 落库改走 `sanitizeColor(token)`，
  简写里写的 `currentColor` 同样归成跟随（`isValidColor` 仍作闸门，非法 token 不会误清颜色）。
* `src/model.ts:344-357` `buildDecorationCSS` 改为始终发出三条声明，跟随态写成
  `text-decoration-color: currentColor`。声明顺序仍是 line → style → color。

### `src/index.ts`

* `src/index.ts:201-209` `applyPair` 的注释：原文说「点击面板控件会让编辑器的选区塌掉」，
  现在面板会拦下按下，注释改成陈述仍然成立的那一半（重裹装饰之后原 Range 失效）。
  没有改任何行为。

`src/persist.ts` 与 `src/index.scss` 未改动。

## 两个决定

### mousedown 守卫挂在面板根上

选**面板根一个监听**，不是逐控件：

1. **覆盖面**：临时色块（`syncCustomSwatch`）是在渲染时才插进面板子树的，
   逐控件绑定就得再补一条「插入后补绑」的路径，而根上一处监听对之后新增的控件自动生效。
2. **可核对**：面板的全部交互都发生在这一棵子树里，一处监听就是一处契约，
   `destroy()` 里也只有一行摘除。逐控件绑定要维护 8 类控件的监听，且与 `addEventListener(eventName, …)`
   的绑定位置分两处。
3. **不影响思源**：面板挂在 `document.body` 上，守卫的范围天然不覆盖浮动工具栏；
   `handleOutsideEvent` 挂在 document 上、监听的是 `eventName`，与 `mousedown` 是两件事。
   打开面板的那一次点击从工具栏按钮冒泡过来时，守卫根本没参与，`contains` 那道闸门照旧生效。

只 `preventDefault()`，**不** `stopPropagation()`：click 依旧冒泡到 document，
「点击面板外关闭」与 Escape 两条出口的判定一个字都不用改；随后的 `click` 也不会被吞掉
（`mousedown` 与 `click` 是两个独立事件），控件照常响应 —— 这一点由测试守住。

### 移动端：不加 touch 处理

移动端只挂 `mousedown` 一道，不碰 `touchstart`：

* `preventDefault()` 掉 `touchstart` 会连带取消浏览器补发的 click 与触摸的默认滚动，
  而面板本身带 `max-height` + `overflow-y: auto`，窗矮时内容要靠滚动到达 —— 拦它等于面板既点不动也滚不动。
* 触摸设备上点按钮本来就不会把焦点抢走（主流移动浏览器不因 tap 聚焦按钮），编辑器因此不失焦。
* 触摸之后浏览器补发的兼容 mouse 事件里本来就含 `mousedown`，那一道守卫在能触发时照样生效；
  即使某个引擎不发，这一道也是无害的。

因此桌面与移动共用同一个 `mousedown` 监听，没有分支。

### 内存表示：选 option (a)，`""` 仍然是「跟随」

`IDecoration.color` 在内存里只有两种形态：**具体颜色原值**，或**空串（跟随）**。
`currentColor` 只出现在写进文档的那一条声明上（`FOLLOW_COLOR_KEYWORD`），
读回时被 `sanitizeColor` 归一成空串。

理由：

1. **`sanitizeColor` 是唯一入口，不变量由构造保证。** 颜色会流经 `sanitizePair`（读 settings.json）、
   `readPairFromStyle`（读文档 CSS）、面板的 `render`（画选中态）三条路径；三条都走同一个函数，
   模型里就不可能出现第三种形态。若让 `currentColor` 自己当表示（option b），
   `clonePair` / `isSamePair` / 面板的 `color === ""` 判定就要各自再认一遍字面量，
   而任何一处漏认都会把 `currentColor` 漏进 settings.json、`data-sue-color` 与
   `syncCustomSwatch`（那会给「跟随」补出一块第 11 块临时色块，整行的「只选中一个」约束就破了）。
2. **`DEFAULT_PAIR` 与落盘配置不用出现第二种 follow 写法。** option (b) 要把
   `DEFAULT_PAIR.underline.color` 一并改成 `"currentColor"`，磁盘上的 settings.json 也会多一种历史格式；
   `sanitizeDecoration` 里「非法颜色退回跟随」这条既有语义也要跟着改口。
3. **`isSamePair` 天然成立**：两个跟随态都是 `""`，相等；跟随与 `#46a758` 不相等。
   顺带地，`""` 与 `"currentColor"`（从外部读进来的写法）在比较时也相等，
   因此读回的声明与面板里的空串不会被误判成一次改动、多一次保存。

代价：`sanitizeColor("currentColor")` 的返回值与「非法值」同为 `""`，光看返回值分不出
「合法但归一」和「非法」。这是有意的取舍，函数注释与类型注释都写明了，
并且「是否合法」由 `isValidColor` 单独回答（测试两侧都断言了）。

`sanitizeComputedColor` 原样保留：它守的是 `A` 字母的计算色，那个值只落在面板自己的 inline style 上，
永远不进文档 HTML，与这条链路无关。

## 覆盖到的测试

### `tests/model.test.mjs`

* `buildDecorationCSS 跟随文字色时显式写出 currentColor` —— 整串 CSS 逐字比对。
* `buildDecorationCSS 具体颜色原样落盘，不被换成 currentColor` —— `#46a758` 原样，且不含 `currentColor`。
* `颜色白名单接受 currentColor 关键字，且只接受它单独出现` —— 放行
  `currentColor` / `currentcolor` / `CURRENTCOLOR`（并断言模型内归一成空串）；
  拒绝 `currentColor; color:url(evil)`、`currentColor #fff`、`currentColor currentColor`、
  首尾空白、`currentColou`、`url(currentColor)`、`var(--currentColor)`、`red`、`var(--x)`、
  `red;position:fixed`、`url(evil)`；`#fff` / `#ffffff` / `#ffffff80` / `var(--b3-font-color8)` 继续放行。
* `round-trip: 跟随文字颜色写出再读回来仍是跟随` —— `readPairFromStyle(buildDecorationCSS(follow,"underline"), null)`
  得到的 `underline` 既不是某个默认颜色，也不是 `enabled: false`。
* `round-trip: 具体颜色写出再读回来不变` —— `#46a758` 一侧原样。
* `parseDecorationStyle 把 currentColor 读成跟随文字色` —— 长属性写法与
  `text-decoration: underline wavy currentcolor` 简写写法都归成跟随。
* `sanitizePair 把 currentColor 归一成模型里的跟随文字色`。
* `isSamePair 把跟随文字色当成一种颜色状态` —— 两个跟随态相等、`currentColor` 写法与空串相等、
  跟随与 `#46a758` 不相等。

> 两条既有断言随契约改动更新，不是被削弱：
> `sanitizeColor rejects the literal currentColor keyword` 原本断言 `isValidColor("currentColor") === false`，
> 它与本次要求的「白名单接受 currentColor」直接冲突，换成了上面那条更严的白名单用例；
> `buildDecorationCSS drops a color that fails the whitelist` 原本断言整串等于两条声明，
> 现在多了显式的 `text-decoration-color: currentColor`，同时补上了「注入的第二条声明不得出现」这一条。

### `tests/panel.test.mjs`

* `面板根与每一类控件上的 mousedown 都被拦下，焦点因此留在编辑器` —— 面板根、面板内非控件、
  线型色块、颜色色块、跟随色块、方向开关、取色器、清除装饰、撤销，九个目标逐一断言
  `defaultPrevented === true`。
* `拦下 mousedown 之后，各类控件仍然响应` —— `mousedown` + 真实 `MouseEvent` click 的完整序列下，
  线型/颜色/跟随/开关/清除/撤销六类控件各自生效。
* `移动端同样只拦 mousedown，不碰 touchstart` —— `mousedown` 被拦、`touchstart` 不被拦、
  `touchend` 仍然触发改动。
* `拦下面板内的 mousedown 之后，面板内外的点击行为都不变` —— 面板内按下被拦且不关闭；
  面板与锚点之外的元素按下不被拦、不关闭，点击才关闭。
* `destroy 之后不再拦 mousedown` —— 销毁前夹具前提成立；销毁后在**脱管**的色块上派发
  `mousedown`，既不抛错也不被拦，且不再有任何关闭回调。
* `颜色是跟随文字色时跟随色块读作选中，挑了具体颜色就不再是` —— 空串时 `aria-pressed="true"`；
  用 `readPairFromStyle` 读回带 `text-decoration-color: currentColor` 的声明后同样为 `true`；
  `#46a758` 时为 `false`；点具体色块、再点跟随，状态来回跟着走。

### `tests/index.test.mjs`

* `面板拦 mousedown 的范围只有面板自己：工具栏按钮的按下不受影响，面板也不被关掉` ——
  工具栏按钮的 `mousedown.defaultPrevented === false`，面板在完整的按下-抬起-点击之后仍然留着。
* `面板控件上的 mousedown 被拦下，控件依然把改动落到文档上` —— 面板根与六类控件逐一断言
  `defaultPrevented === true`，随后 `press()` 仍然把波浪线下划线落到块上。
* `面板外的按下与点击仍然关闭面板` —— 面板外的按下不被拦也不关闭，点击才关闭。
* `通过面板选择「跟随文字颜色」，落盘的块 HTML 带 text-decoration-color: currentColor` ——
  走真实的「面板点击 → index → 防抖保存」链路，断言 `posts[last].data.data` 含
  `text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentColor`，
  且不含 `#46a758`、不含 `color: #46a758`。
* 夹具的 `clickToolbarButton` 改成派发完整的 `mousedown → mouseup → click` 序列并返回三个事件对象，
  以便逐个断言 `defaultPrevented`。

## 命令与结果

```
npm run lint                    exit 0
npm test                        221 pass / 0 fail   （改动前 205 pass）
node node_modules/typescript/bin/tsc --noEmit   exit 0
npm run format:check            exit 0
npm run build                   exit 0（webpack compiled successfully）
```

## RED 证据

只回退三个源文件（`git stash push -- src/index.ts src/model.ts src/panel.ts`），测试文件保持最终状态：

```
# tests 221
# pass 211
# fail 10

not ok - 面板控件上的 mousedown 被拦下，控件依然把改动落到文档上
        error: 面板…上的 mousedown 必须被拦下        false !== true
not ok - 通过面板选择「跟随文字颜色」，落盘的块 HTML 带 text-decoration-color: currentColor
        error: '跟随文字色必须显式落成 currentColor<p data-type="text" data-node-id="20261003220000-a1">
                <span style="text-decoration-line: underline; text-decoration-style: solid">hello</span></p>'
not ok - buildDecorationCSS 跟随文字色时显式写出 currentColor
        error: '跟随文字色必须显式写出 currentColor：text-decoration-line: underline; text-decoration-style: wavy'
not ok - buildDecorationCSS drops a color that fails the whitelist
        error: Expected values to be strictly equal (整串 CSS 少一条声明)
not ok - 颜色白名单接受 currentColor 关键字，且只接受它单独出现
        error: 跟随文字色是合法颜色值：currentColor
not ok - round-trip: 跟随文字颜色写出再读回来仍是跟随
        error: '写出侧要显式声明：text-decoration-line: underline; text-decoration-style: wavy'
not ok - 面板根与每一类控件上的 mousedown 都被拦下，焦点因此留在编辑器
        error: 面板…上的 mousedown 必须被拦下        false !== true
not ok - 移动端同样只拦 mousedown，不碰 touchstart
        error: 移动端也要拦住会把焦点带走的按下      false !== true
not ok - 拦下面板内的 mousedown 之后，面板内外的点击行为都不变
        error: Expected values to be strictly equal
not ok - destroy 之后不再拦 mousedown
        error: 夹具前提：销毁前监听是活的            false !== true
```

10 条里 5 条挂在 `mousedown` 契约上（缺陷一：面板 4 条 + index 1 条），
5 条挂在 `currentColor` 上（缺陷二：model 4 条 + index 1 条），与两个根因一一对应。
`git stash pop` 之后全套 221 条重新转绿。
另有 9 条新用例在旧代码上就通过（面板：控件仍响应、跟随色块选中态；index：守卫范围、
面板外点击；model：具体颜色落盘与往返、解析 currentColor、`sanitizePair` 归一、`isSamePair` 跟随态），
它们是防回归的护栏，本来就该在两侧都通过。

## jsdom 验不了的部分，需要真实思源里过一遍

* **焦点是否真的留在编辑器**。jsdom 根本不做焦点转移：`dispatchEvent(mousedown)` 不会移动
  `activeElement`，点击按钮也不会。测试因此断言的是**契约**（`defaultPrevented === true`）
  与**控件仍然可用**（按下之后改动照样落到块上）。index 里的 `activeElement` 断言只能证明
  插件自己没把焦点带走，证明不了浏览器不会。「点一下色块、选区还在、还能接着改」必须在真机上看。
* **思源是否真的不再清选区**。宿主行为，jsdom 里没有思源。
* **颜色那条链路的最终形态**。「显式写 currentColor ⇒ 思源存成 `text-decoration-color` 而不是 `color`」
  是在用户真实文档上量到的，jsdom 只验到「我们发出去的 HTML 是对的」。
* **面板根是滚动容器**（`max-height` + `overflow-y: auto`）。守卫挂在根上，因此落在滚动条上的按下
  也会被 `preventDefault` 拦一下；主流浏览器里滚动条的拖动由 UA 自己处理，但「窗口很矮时
  拖滚动条还能不能滚面板」这一条应当在真机上看一眼。
* **原生取色器对话框**（`input[type=color]`）。`click` 仍会派发、激活行为仍在，但系统取色器弹窗
  本身是否会让编辑器失焦，只能在真机上看。
