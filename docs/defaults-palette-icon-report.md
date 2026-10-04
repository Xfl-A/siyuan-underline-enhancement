# 默认值、预设色板与工具栏图标：三项改动的核对与实施记录

本文件记录三件独立的事：核对下划线默认值是否真的画得出线、把纯黑加进预设色板、把工具栏图标换成「带波浪下划线的 U」。

* **Item 1（默认值）**：追了一遍从常量到落盘 CSS 的整条链，**没有找到缺陷**，因此没有改任何生产代码，只补了把它钉住的测试。
* **Item 2（纯黑进色板）**：改 `src/model.ts` 的 `PRESET_COLORS`；另外发现色块在深色主题下没有任何自身的边框，补了一圈发丝实线边框。
* **Item 3（波浪图标）**：改 `src/icons.ts` 的 `UNDERLINE_ICON_SVG`，symbol 属性一字未动，只把直线换成四段三次贝塞尔拼成的波浪。

---

## Item 1 — 默认下划线是「跟随文字颜色 + 直线」：核对结论

### 1.1 从 DEFAULT_PAIR 到写出的 CSS

用 `tests/helpers/loadModule.mjs` 把 `src/model.ts` 原样载入，逐条走了一遍。实测输出（默认 pair）：

```
DEFAULT_PAIR          = {"underline":{"enabled":true,"style":"solid","color":""},
                         "overline":{"enabled":false,"style":"solid","color":""}}
buildDecorationCSS    = text-decoration-line: underline; text-decoration-style: solid;
                         text-decoration-color: currentColor
composePair(default)  = [{"position":"underline","css":"text-decoration-line: underline;
                           text-decoration-style: solid; text-decoration-color: currentColor"}]
roundTrip             = DEFAULT_PAIR
no-style-decl read    = {"underline":{"enabled":true,"style":"solid","color":""}, …}
```

`composePair` 默认只产出一个 span（`position: "underline"`），三条声明齐全，`readPairFromStyle` 原样读回。

### 1.2 会不会有某条路径产出空 / 非法 style

所有能写出 `style` 的地方都收敛到同一个常量 `DEFAULT_STYLE = "solid"`（`src/model.ts:101`），逐条验证过：

| 位置                                       | 兜底写法                                                  | 实测                                          |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------- |
| `sanitizeDecoration`（`src/model.ts:389`） | `isLineLineStyle(raw.style) ? raw.style : fallback.style` | 12 个脏值全部落回 `"solid"`                   |
| `buildDecorationCSS`（`src/model.ts:353`） | `isLineStyle(decoration?.style) ? … : DEFAULT_STYLE`      | 写成 `text-decoration-style: solid`           |
| `parseSpanCSS`（`src/model.ts:271`）       | 初始值就是 `DEFAULT_STYLE`                                | 缺声明时读回 `"solid"`                        |
| `toLineStyle`（`src/model.ts:241`）        | 找不到合法 token 就 `return DEFAULT_STYLE`                | `"bogus"` / `"currentColor"` 都读成 `"solid"` |

`sanitizePair` 的 12 个脏值探针（`undefined / null / "" / "  " / "zigzag" / "SOLID" / 0 / 1 / {} / []`）实测**全部**得到 `style: "solid"`，写出的声明都带 `text-decoration-style: solid`。
`parseSpanCSS` 的 10 个残缺声明探针（`""`、缺 style、空 style 值、`text-decoration: underline` 简写、多余的 `text-decoration-color` …）读回的 style 也全是 `"solid"`。

**结论：不存在能产出空 / 非法 style 的路径。** 唯一"意外"是 `isLineStyle` 大小写敏感（`"SOLID"` 不在 `LINE_STYLES` 里），但它回退到的正是 `"solid"`，结果与期望一致，不构成问题。

### 1.3 面板首屏：solid 是不是选中态

`src/panel.ts:559` 的选中态判定是

```ts
markSelected(swatch, swatch.getAttribute(STYLE_ATTRIBUTE) === decoration.style);
```

`STYLE_ATTRIBUTE`（`data-sue-style`）写的是 `LINE_STYLES` 里的原值，`decoration.style` 经 `sanitizePair` 必然也是同一个枚举里的值，两边都是字符串、严格相等，没有大小写或类型的落差。实测首屏：

```
panel underline: toggle=true  pressedStyle=["solid"] disabled=[false,false,false,false,false]
                 follow pressed=true
panel overline:  toggle=false pressedStyle=["solid"] disabled=[true,true,true,true,true]
```

solid 在下划线那行是 `aria-pressed="true"` 且可点；整排只有它一个选中。上划线那行 solid 同样选中但整排禁用（方向关闭），这是既有设计。

### 1.4 关于「下划线开关默认开启，但没有出现下划线」

面板给出的 `initialPair` 只是**待应用的配置**，它本身不往选区里写任何东西 —— 装饰要等用户在面板里点一次（线型 / 颜色 / 开关）才经 `applyPair` → `composePair` → `applySpansIn` 落进文档。因此「开关亮着但文档里还没有线」是这个插件的设计，而不是默认值失效：开关亮着表示"你点任意一个控件就会得到这条线"，不表示"已经加好了"。

另外最近一次提交（`2ef3f85`）把跟随色写成 `text-decoration-color: currentColor` 而不是省略这条声明，正是为了避免思源改存一条 `color` 让装饰与文字色解绑；这一环现在也被往返测试钉住了。

### 1.5 改了什么

**生产代码：零改动。** 只新增测试。

新增（`tests/model.test.mjs`）：

* `DEFAULT_PAIR 的下划线是跟随文字颜色的直线，上划线保持关闭`
* `默认下划线写出的 CSS 同时声明 line、style 与跟随色`
* `默认下划线经 composePair 落到文档上，读回来仍等于默认值`
* `span 上没有 text-decoration-style 声明时，读回来按 solid 认`
* `sanitizePair 无论收到什么，underline.style 都落在五个线型之内且默认仍是 solid`

新增（`tests/panel.test.mjs`）：

* `默认配置打开面板时，下划线的直线色块就是选中态`
* `默认 pair 下点直线色块不产生改动（它已经是当前线型）`

### 1.6 变异验证（确认这些断言不是自证）

把 `src/model.ts` 的 `DEFAULT_PAIR.underline.style` 临时改成 `"wavy"`：

* `tests/model.test.mjs` 7 条失败（含上面 4 条新增的、以及既有的 `共享常量都被冻结`、`sanitizePair returns fresh objects …`）
* 把 `tests/panel.test.mjs` 里的 `DEFAULT_PAIR` 字面量临时改成 `"wavy"`：`默认配置打开面板时，下划线的直线色块就是选中态` 与 `默认 pair 下点直线色块不产生改动（它已经是当前线型）` 两条失败

两处临时改动都已还原。

---

## Item 2 — 预设色板加入 `#000000`

### 2.1 放在哪、为什么

追加到**末位**（`PRESET_COLORS` 的最后一项，紧跟 `var(--b3-font-color8)` 之后）：

```
#e5484d  #f76b15  #ffb224  #46a758  #30a46c  #0090ff  #8e4ec6  #d6409f  #f5d90a
var(--b3-font-color8)
#000000
```

理由：前九项是一趟连续的色相遍历（红 → 橙 → 琥珀 → 绿 → 绿 → 蓝 → 紫 → 粉 → 黄），挨着的两色不会互为深浅版。纯黑不是一个色相，它是「跟随文字颜色」那个自适应选项的**显式反面** —— 面板里已经有一个会跟着主题走的颜色，再给一个恒定不变的黑才是它的确定版本。把它插在色相中段（例如 `#46a758` 与 `#30a46c` 之间）会让它被读成相邻某个绿的深浅版，用户要在心里多做一次"这不是深绿"的判断。放在末尾，色相遍历保持连续，主题变量与纯黑这两个"非色相"入口一起收在尾部。

对既有断言的影响：因为 `#000000` 落在末位，`tests/panel.test.mjs` 里所有按下标取色块的断言（`[0]` 红、`[3]` 绿、`[5]` 蓝、`[9]` 主题变量）**位置全部不变**，无需改动。需要跟着改的只有三处"数量"断言：

* `tests/model.test.mjs:45` — `PRESET_COLORS holds ten colors…` → `eleven`，`length` 10 → 11，并加了"无重复"检查
* `tests/panel.test.mjs:213` — 测试名 `…10 个预设色块…` → `11 个`；`:233` `length` 10 → 11；`:583` `length` 10 → 11
* 注释里的数字：`tests/panel.test.mjs:136`「因此预设恒为 10 块」→ 11 块；`src/panel.ts:395-396`「整行 11 个色块」→「12 个」、「色板始终是 10 个预设」→「11 个预设」

这三处数字是**数量断言**，不是弱化：请求本身就是"加一个颜色"，数量必然 +1。断言的强度（必须恰好等于模型给的数量、必须逐字等于 `PRESET_COLORS`）保持不变。

白名单无需改动：`#000000` 是 6 位十六进制，命中 `COLOR_PATTERN` 的 `#[0-9a-fA-F]{6}` 分支。

### 2.2 深色主题下的可见性：查了什么、结论是什么

面板表面确实不透明 —— `src/index.scss:18` 的
`background-color: var(--b3-menu-background, var(--b3-theme-background, #fff))`，
变量指向 `--b3-theme-background`（daylight `#fff` / midnight `#1e1e1e`）。

`src/index.scss` 里与色块外观有关的规则只有三条：

1. `:67` `[data-sue-panel] .sue-swatch { width: 32px; }` —— 只有宽度
2. `:78` `[data-sue-panel] [data-sue-follow-color] { border: 1px dashed var(--b3-border-color, #e0e0e0); }`
3. `:84` `[data-sue-panel] .sue-swatch--selected { box-shadow: 0 0 0 2px …; }` —— 只在**选中时**给一圈指示色

也就是说**颜色色块自身没有任何边框声明**：文件里的注释说"边框、背景与悬浮态沿用 b3-button"，而 `b3-button` 的边框色在思源里同样取自 `--b3-border-color` 这类中性灰，在 midnight 下是深灰 —— 黑块 + 深灰边落在 `#1e1e1e` 的面板上，三者挤在一起；未选中时（`sue-swatch--selected` 的 `box-shadow` 不生效）那块纯黑与面板底色几乎无法区分，用户既找不着也点不着。

**结论：需要补最小 affordance。**

### 2.3 改了什么

`src/index.scss`，在跟随文字色色块那圈虚线之后新增一条规则：

```scss
[data-sue-panel] [data-sue-color] {
  box-sizing: border-box;
  border: 1px solid var(--b3-border-color, #e0e0e0);
}
```

选择器只落在颜色色块上（预设色块与自定义色的临时色块都带 `data-sue-color`），因此：

* 线型色块（靠元素自身文字画线）不受影响；
* 跟随文字色色块只有 `data-sue-follow-color`、没有 `data-sue-color`，那条虚线原样保留，两者不互相覆盖；
* 取色器、开关、动作按钮一概没碰；
* 没有用 `:has()`。

边框色沿用文件里已有的 `var(--b3-border-color, …)`，与跟随文字色那圈虚线同源，深浅主题各自都有一层能与面板底色区分的轮廓；`box-sizing: border-box` 让这 1px 不把 32px 的色块挤大（同 `data-sue-follow-color` 那条规则的写法）。

### 2.4 测试

* `PRESET_COLORS holds eleven colors and every one of them passes the whitelist` —— 数量 11 + 逐项过白名单 + **无重复**（重复色块点上去毫无区别，用户只会以为面板没响应）
* `PRESET_COLORS 含纯黑，且它排在色相遍历之外` —— 含 `#000000`、位于末位、色相遍历未被它打断
* `每个方向的颜色行都给出纯黑色块` —— 两个方向各有 `[data-sue-color="#000000"]`，属于预设（不是临时色块）、`aria-pressed="false"`、`title` 给出原值、过白名单
* `面板根有不透明表面，且不挂思源未定义的浮层类`（既有测试，已扩展）—— 读 `src/index.scss` 源码，从 `panel.ts` 里正则取出 `COLOR_ATTRIBUTE` 的真实值（`data-sue-color`），要求存在该规则、含 `border: 1px solid var(--b3-border-color…)`、含 `box-sizing: border-box`，并要求规则体里**只有**这两条声明（守住"最小改动"）。jsdom 不加载样式表，所以只能这样钉。

变异验证：临时删掉这条 SCSS 规则 → 该测试失败（已还原）。

---

## Item 3 — 工具栏图标改成「带波浪下划线的 U」

### 3.1 路径数据

**旧**（直线）：

```
<line x1="4" x2="20" y1="20" y2="20"/>
```

**新**（波浪）：

```
<path d="M4 20c1.33 2 2.67 2 4 0c1.33-2 2.67-2 4 0c1.33 2 2.67 2 4 0c1.33-2 2.67-2 4 0"/>
```

波浪节点全部落在 `y=20` 上，横跨 `x=4..20`，走**两个整周期**（四段半周期，每段 4 单位）；控制点相对节点线偏 ±2，因此三次贝塞尔的实际振幅是各 **1.5**（峰值 `y=21.5`、谷值 `y=18.5`，峰峰值 3）。

### 3.2 为什么 16px 下读得清

采样求得的数值（描边宽度 1.5、圆头端点）：

| 项              | viewBox 单位                          | 16px 渲染         |
| --------------- | ------------------------------------- | ----------------- |
| 描边中心包围盒  | x ∈ [4, 20]，y ∈ [18.5, 21.5]         | —                 |
| 含描边与圆头    | x ∈ [3.25, 20.75]，y ∈ [17.75, 22.25] | 全部落在 0..24 内 |
| 峰峰值          | 3.00                                  | **2.00px**        |
| 每周期          | 8.00                                  | **5.33px**        |
| 描边宽度        | 1.50                                  | **1.00px**        |
| 与 U 底部的间距 | 1.75（U 的弧底在 y=16）               | 1.17px            |

2.00px 的峰峰值配 1.00px 的描边，在 16px 下起伏约为线宽的两倍，形状明确可辨；5.33px 一个周期也不会挤成锯齿噪声。周期再少（比如 1 个）就会并成一条带毛边的直线、看着仍像直下划线；周期再多（比如 4 个）在 16px 下每周期只剩 2.7px，起伏并进线宽里、糊成一条实线。2 个周期落在这两者之间。

### 3.3 symbol 属性是否保留

一字未动：

```
<symbol id="iconUnderlineEnhancement" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round">
```

`fill="none"` 与 `stroke-width="1.5"` 仍然写在 `<symbol>` 上。文件顶部的注释里解释过为什么（思源对工具栏 `<svg>` 设了 `fill: currentColor; stroke-width: 0`，那是 svg 元素自身的声明、会继承进 symbol 里的每条路径；而写在 symbol 上的表现属性是元素自己的声明，优先级高于继承值）—— 这段说明现在依然成立，因此保留，只改了它上面两段：把"图形直接取自 Lucide 的 underline，路径数据原样保留"改成"U 的那段路径取自 Lucide 的 underline 并原样保留"，并新增一段说明下面那条线为什么自己画成波浪、周期与振幅取多少。

`stroke="currentColor"` 也保留，深浅主题下都取当前文字色。

### 3.4 测试

`tests/index.test.mjs` 里那条 `图标沿用 Lucide underline 的路径数据，并把描边宽度收到思源工具栏的粗细` 改名为
`图标是带波浪下划线的字母 U，且描边属性仍写在 symbol 上`，断言：

* `viewBox="0 0 24 24"` 与 U 的路径数据 `M6 4v6a6 6 0 0 0 12 0V4` 保持不变（既有的两条断言原样保留）
* **整段字符串不含 `<line`** —— 与思源自带的直下划线按钮区分开
* 恰好两段 `d`，且**至少一段含曲线命令**（`c`/`q`/`C`/`Q`）—— 断言"弯的"这件事本身，不钉死具体数值
* 每段路径的命令字母都在 SVG 命令集内、命令后紧跟数字参数、所有数字有限（少写一个参数浏览器会整条丢弃那段曲线）
* `fill="none"` / `stroke="currentColor"` / `stroke-width="1.5"` 既出现在字符串里，**又出现在 `<symbol …>` 的属性列表内**（后一条是新加的：它必须留在 symbol 上，落到别的元素上就失效）

**唯一被替换掉的既有断言**是 `assert.match(UNDERLINE_ICON_SVG, /<line x1="4" x2="20" y1="20" y2="20"\/>/)` —— 它钉的正是本次要换掉的那个直线元素，不可能与新图标共存；替换它的是更强的一组（"没有 `<line`" + "有曲线命令"）。

变异验证：把波浪临时换回 `<line x1="4" x2="20" y1="20" y2="20"/>` → 该测试失败（已还原）。

---

## 未能完成 / 需要留意

* **没有在真实的思源里跑过**。本仓库没有 SiYuan 的样式表（`node_modules/siyuan` 下不含 css/less/scss），因此 §2.2 里关于 `b3-button` 边框色在 midnight 下"是深灰"的判断是从变量命名与思源主题体系推断的，不是读到的。为了不把这个推断当事实，§2.3 的新边框**自带主题变量兜底**，且不依赖思源那条规则是否存在 —— 无论 `b3-button` 给不给边框，纯黑色块都至少有一层来自本样式表的轮廓。
* Item 1 的"没有缺陷"结论覆盖的是代码路径与首屏渲染。**面板不会自动把默认配置应用到选区**，这是设计如此（见 §1.4）。若用户期望的是"打开面板就自动加上线"，那是一个新需求，不在本次三项之内，也没有替他们猜。
* 未改动 `src/dom.ts`（按要求整层没碰）、`src/persist.ts`、`README*.md`、`CHANGELOG.md`；`docs/` 下只新增了本文件。

---

## 命令与输出

```
$ npm run lint          # 通过，无输出（--fix 未改动任何文件）
$ npm test              # tests 230 / pass 230 / fail 0（原 221，新增 9）
$ node node_modules/typescript/bin/tsc --noEmit   # 通过，无输出
$ npm run format:check  # 通过
$ npm run build         # webpack production 构建成功
```

逐文件条数（改后 / 改前）：`tests/model.test.mjs` 54 / 45、`tests/panel.test.mjs` 50 / 47、`tests/index.test.mjs` 40 / 39；`tests/dom.test.mjs` 56、`tests/persist.test.mjs` 25、`tests/smoke.test.mjs` 5 未动。

净增 9 条：`tests/model.test.mjs` +6（默认值 5 条 + 纯黑位置 1 条），
`tests/panel.test.mjs` +3（纯黑色块、默认 solid 选中、点已选中不改动），
`tests/index.test.mjs` +0（那条图标断言就地改写，不新增文件、不新增条数）。
