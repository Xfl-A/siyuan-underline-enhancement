# 装饰的身份改由 style 承载：不再依赖 `data-sue`

## 缺陷

插件把每一处装饰写成 `<span data-sue="u|o|b" style="text-decoration-line: …; text-decoration-style: …; text-decoration-color: …">`，
而思源保存一个块时走的是「块 HTML → Lute AST → `.sy` 文件」这条链路，自定义属性在这一步不会进入 AST。
拿真实文档量到的 `.sy` 原文就是证据：

```json
{
  "Type": "NodeTextMark",
  "Properties": {
    "style": "text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #0090ff"
  },
  "TextMarkType": "text",
  "TextMarkTextContent": "PPPOOO"
}
```

三条 `text-decoration-*` 声明一条不少地留在 `Properties.style` 里，插件的 `data-sue` 却没有留下任何痕迹。
思源据此重新渲染之后，编辑器 DOM 里那块装饰是 `<span data-type="text" style="text-decoration-line: underline; …">`，
**不带 `data-sue`**；而 `src/dom.ts` 只靠 `[data-sue]` 选择器找装饰。于是块一旦存过盘，
插件就再也认不出自己的装饰：面板回填读到空、`readDecorationStylesIn` 返回 `[]`、`stripDecorationIn` 一个 span 都不剥 ——
「清除装饰」和「关掉某个方向」静默失效，那条线永远留在文档里，188 条既有测试一条都没发现，
因为它们全都是在内存里现搭 DOM，从来没有走过思源那层序列化。

## 改了什么

### `src/dom.ts`

* `src/dom.ts:27-37` 删掉 `MARK_ATTRIBUTE`，换成两个常量：`DECORATION_SPAN_SELECTOR = "span[style]"`（候选：带 inline style 的 span）
  与 `LINE_KEYWORDS = new Set(["underline", "overline"])`。
* `src/dom.ts:294-305` 新增 `declaresLine(declarations)`：按 CSS token 切分（分隔符含空格、逗号、分号、冒号与括号），
  只要有一枚 token 恰好等于 `underline` / `overline`（大小写不敏感）就算声明了装饰线。
  按整枚 token 比对而不是 `\b` 匹配，`url(underline.svg)`、`--underline` 这类字样不会误判。
* `src/dom.ts:307-332` 新增 `isDecorationSpan(element)`：先判 `tagName === "SPAN"`，
  再按「CSSOM 长属性 → CSSOM 简写 → style 属性串」三级读值，见下面「选了哪种判定」。
* `src/dom.ts:346-348` `decorationSpansIn` 改为 `querySelectorAll(DECORATION_SPAN_SELECTOR)` 之后 `filter(isDecorationSpan)`。
  `readDecorationStylesIn`（`src/dom.ts:598`）与 `stripDecorationIn`（`src/dom.ts:375`）都走这一个函数，
  面板显示的状态与文档被改动的状态因此不可能分家。
* `src/dom.ts:477-482` `wrapRange` 不再 `setAttribute(MARK_ATTRIBUTE, spec.marker)`，写出的 span 只有 `style` 一个属性。
* 只认 span 是有意的：思源自己的 `<u>`（用户按思源工具栏按钮加的下划线）、以及任何带 style 的非 span 元素都不算装饰。
  装饰的落盘形态只有 span 一种，`<u>` 由思源自己管理，插件不接手。

### `src/model.ts`

* `src/model.ts` 原第 10-11 行的 `TSueMarker` 删除（唯一的写入点就是被删掉的 `spec.marker`，没有任何读取方）。
* `src/model.ts:25-34` `ISpanSpec` 去掉 `marker` 字段，注释改成说明「只有 css 会被写进 DOM，方向另有一处从 css 解析」。
* `src/model.ts:329-352` `composePair` 的四个返回点不再设 `marker`，`position` 保留。
* `src/model.ts:332-334` `composePair` 的文档注释补上一句：每个描述只带一份方向信息，且就写在 css 里。
  写方向的地方从「spec 字段 + CSS 属性」两处收敛成一处。

### 为什么没有给 `dom.ts` 加 `model.ts` 的运行时 import

`isDecorationSpan` 需要的只是「这串 CSS 里有没有装饰线关键字」这一件事。为此 import `model.ts` 会被否掉，两个理由：

1. `tests/dom.test.mjs` 的夹具 `tests/helpers/dom.mjs` 载入 `src/dom.ts` 时只注入 `{siyuan}` 一个桩
   （`tests/helpers/dom.mjs:20-22`），`dom.ts` 加运行时 import 就得同步给各处夹具补 `"./model"` 桩
   （`tests/helpers/dom.mjs`、`tests/index.test.mjs` 以及将来任何新用例）；
2. `model.ts` 里那条解析器（`parseSpanCSS` / `splitDeclarations`）是给「把 style 翻译成面板配置」用的全量解析，
   而这里只需要一个布尔判定；为一个布尔判定拖进一整个解析器 + 跨模块运行时耦合并不划算。

替代方案是 `declaresLine` 这十几行 token 扫描：判定与解析各司其职，`dom.ts` 仍只 `import type {ISpanSpec}`（`src/dom.ts:11`），
测试夹具不必补桩。新测试里需要「style → 面板配置」时，是在**测试侧**自己 `loadModule("src/model.ts")`
（`tests/dom.test.mjs:5,36`）调用 `readPairFromStyle`，src 侧没有多出任何依赖。

## 选了哪种判定，为什么

三级读值，全部以 CSSOM 优先，属性串兜底（`src/dom.ts:317-332`）：

1. `element.style.getPropertyValue("text-decoration-line")` —— 真机上这条会把简写归一化，值直接可用；
2. 取到空串时读 `element.style.getPropertyValue("text-decoration")` —— **jsdom 不做这步归一化**，
   实测 `style="text-decoration: underline"` 的 `textDecorationLine` 是 `""`、而简写原样留在 `text-decoration` 上；
3. 简写也读不到时退回 `element.getAttribute("style")` 自己切 token —— 覆盖 CSSOM 丢值的极端情形。

长属性读到**确定**的值（例如 `none`）就以它为准，不再回头扫属性串：`text-decoration: underline; text-decoration-line: none`
在 CSS 里的结果是没有线，属性串里那个 `underline` 只是被覆盖掉的旧值。`tests/dom.test.mjs` 的简写用例里有一条
`assert.equal(span.style.textDecorationLine, "")` 把「jsdom 不归一」这个事实钉住，
哪天上游改了行为，属性串那条退路就变成死代码，测试会立刻指出来。

## 覆盖到的测试

新增 8 条（`tests/dom.test.mjs`，编号为 `npm test` 的 TAP 序号）：

| 用例                                                                 | 行   | 断言的重点                                                                                          |
| -------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| `思源存盘后重新渲染的装饰没有标记属性，面板照样读得出线型与颜色`     | 1025 | 读回 `{underline: {enabled: true, style: "wavy", color: "#0090ff"}, overline: {enabled: false, …}}` |
| `没有标记属性的装饰能被换成新线型，写回去的 span 上也不冒出标记属性` | 1041 | 换样式作用在原装饰上（不是再包一层），`innerHTML` 逐字节等于 `<span style="…dotted…">PPPOOO</span>` |
| `没有标记属性的装饰能被清除，剥完只剩裸文本`                         | 1061 | `applySpansIn(…, [])` 之后 `innerHTML === "PPPOOO"`                                                 |
| `简写形态 text-decoration: underline 也算装饰，能读回也能剥掉`       | 1072 | 简写读得出方向，也能剥掉                                                                            |
| `嵌套的一对装饰都没有标记属性时，两个方向都要读得回来`               | 1096 | 外层上划线 + 内层下划线 → 两个方向都恢复                                                            |
| `清除时嵌套的两层装饰都被脱掉`                                       | 1115 | `innerHTML === "abcd"`                                                                              |
| `没声明装饰线的 span 不是装饰：读不出来，剥的时候也不动它`           | 1129 | `color`/`font-weight`/无 style/`text-decoration: none` 四种都不算装饰                               |
| `思源自己的 <u> 不算插件装饰：面板读不到，清除也不会碰它`            | 1147 | `<u>` 与带装饰线 style 的 `<u>` 都不动                                                              |

### 无 `data-sue` 夹具怎么搭的

夹具不是手写的字面量，而是从那份 `.sy` AST 推出来的（`tests/dom.test.mjs:1004-1023`）：
`SAVED_UNDERLINE_MARK` 照抄真实文档里的 `NodeTextMark` 节点，
`SAVED_MARK_HTML` 由 `TextMarkType` / `Properties.style` / `TextMarkTextContent` 拼出

```html
<span data-type="text" style="text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #0090ff">PPPOOO</span>
```

于是 AST 与夹具不可能各自漂移；每条用例另外先断言 `paragraph.innerHTML.includes("data-sue") === false`
（`tests/dom.test.mjs:1028`），把「夹具里确实没有标记属性」钉在断言里。

### 既有断言的改动（没有一条被删掉或放宽）

* `tests/helpers/dom.mjs:89-130` 夹具的 `decorationsIn` 快照从 `{marker, style, text}` 改成 `{lines, style, text}`：
  `marker: "u"` 变成 `lines: "underline"`，即**从 style 里解出来的方向**，比原来那枚字面标记更强；
  判定（`declaredLines` + `span[style]`）在测试侧独立写一份，不复用 `src/dom.ts` 的代码。
  同时新增两个出口：`decorationSpans`（只要 span）与 `declaredLines`（只看一串声明）。
* `tests/dom.test.mjs` 里所有装饰夹具从 `<span data-sue="u" style="…">` 换成 `savedSpan`（思源形态）
  与 `wrappedSpan`（插件写出的形态，`<span style="…">`），逐字节比对的用例按「这一段是旧的还是新写的」分别取用。
* `tests/dom.test.mjs:566-582` 追加一条 `innerHTML` 逐字节断言：插件写出的 span 只有 style 一个属性。
* `tests/dom.test.mjs:587-604` 嵌套用例不再用 `[data-sue="o"|"u"]` 取元素，改用 `decorationSpans()` +
  `declaredLines()` 断言外层 `overline`、内层 `underline`。
* `tests/dom.test.mjs:495` 用例名 `…carry no data-sue marker` 改为 `…whose style declares no decoration line`。
* `tests/model.test.mjs:85-90` 新增 `noMarkerField(spec)`，把 5 处 `specs[n].marker === "u|o|b"` 换成
  「spec 上不得再有 marker 字段」+ 方向仍由 `position` 与 css 断言；
  `tests/model.test.mjs:36-37` 的 `readLinesFromCSS` 让「外层在上划线」这条顺序断言直接读 css。
* `tests/index.test.mjs:29-33` `DECORATED_UNDERLINE` / `DECORATED_UNDERLINE_DOTTED` 改成匹配
  `<span style="text-decoration-line: underline; text-decoration-style: wavy|dotted…">`；
  新增 `HAS_DECORATION_SPAN`，把 7 处「块里已经没有装饰」的 `includes("data-sue") === false`
  换成「块里再没有 `text-decoration-line` 声明的 span」——这是新行为下真正该断言的东西。
  `tests/index.test.mjs:546-551` 关掉一个方向后断言 `text-decoration-line: underline` 消失、`overline` 仍在。
  夹具 `NESTED_HTML` 与另外三处输入夹具改成 `savedDecoration`（无标记属性的思源形态），
  `打开面板时按选区里已有装饰的 text-decoration 声明回填两个方向` 这条用例因此端到端地跑在真实落盘形态上。
* `tests/persist.test.mjs:25-31` `decoratedHTML` 夹具与注释改成落盘真实形态（`data-type="text"` + style），
  两处 `block.innerHTML = …` 同步改成 `<span style="…">`（那是插件写出的形态）。

## 命令与结果

全部在 `D:\Coding\siyuan-underline-enhancement`（`main`，普通检出）执行。

| 命令                                            | 退出码 | 结果                                                                      |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `npm run lint`                                  | 0      | 无输出（`eslint . --fix --cache`）                                        |
| `npm test`                                      | 0      | `# tests 196 / # pass 196 / # fail 0`（改动前 188）                       |
| `node node_modules/typescript/bin/tsc --noEmit` | 0      | 无输出                                                                    |
| `npm run format:check`                          | 0      | 无输出（`dprint check`；中途 `npm run format` 修过 4 个测试文件与本报告） |
| `npm run build`                                 | 0      | `webpack 5.111.1 compiled successfully`                                   |

产物抽查（`dist/index.js`，已被 `.gitignore` 忽略，不进提交）：

```
Ye="span[style]",ze=new Set(["underline","overline"])
```

## RED 证据

只回退自己的源码改动（`src/dom.ts src/model.ts`），测试改动留在工作区：

```
git checkout -- src/dom.ts src/model.ts
node --test --test-reporter=tap tests/*.test.mjs
```

```
# tests 196
# pass 164
# fail 32
```

按文件分布：`tests/dom.test.mjs` 17 条、`tests/index.test.mjs` 11 条、`tests/model.test.mjs` 4 条。

新加的 8 条里有 6 条失败（另外 2 条是「不该被当成装饰」的负向用例，老实现本来就什么都认不出，恒真）：

```
not ok 42 - 思源存盘后重新渲染的装饰没有标记属性，面板照样读得出线型与颜色
not ok 43 - 没有标记属性的装饰能被换成新线型，写回去的 span 上也不冒出标记属性
not ok 44 - 没有标记属性的装饰能被清除，剥完只剩裸文本
not ok 45 - 简写形态 text-decoration: underline 也算装饰，能读回也能剥掉
not ok 46 - 嵌套的一对装饰都没有标记属性时，两个方向都要读得回来
not ok 47 - 清除时嵌套的两层装饰都被脱掉
```

另外 11 条**既有**用例也一起红了（它们的夹具已换成思源形态，老的 `[data-sue]` 判定压根认不出）：

```
not ok 17 - stripDecorationIn unwraps nested decoration spans without changing one character of text
not ok 18 - stripDecorationIn leaves strong and a elements whose style declares no decoration line
not ok 19 - stripDecorationIn without a range clears the whole region, which is the explicit region-wide mode
not ok 22 - applySpansIn wraps the selected text in one span and leaves the adjacent text out of it
not ok 31 - applySpansIn restyles the selected range and keeps decoration elsewhere in the block byte-identical
not ok 32 - applySpansIn keeps a decoration byte-identical when the range starts exactly where it ends
not ok 33 - applySpansIn still restyles a decoration that the range only partly overlaps
not ok 34 - applySpansIn keeps every untouched decoration in a table cell that holds two decorated words
not ok 35 - applySpansIn with empty specs clears the selected range and leaves decoration outside it
not ok 36 - applySpansIn strips an outer span that only partly overlaps while its inner span keeps its own decoration
not ok 41 - readDecorationStylesIn reads what the selection really covers, at both boundaries
```

典型失败信息（老实现下测试侧看到的真实 DOM）：

```
# 42 读不到落盘后的装饰
  + []
  - [
  -   'text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #0090ff'
  - ]

# 46 嵌套的两层一个都读不到（老的判定只认标记属性）
  + []
  - [
  -   'text-decoration-line: overline; text-decoration-style: double',
  -   'text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: #0090ff'
  - ]

# 22 插件写出的 span 上仍带着标记（spec.marker 已经不在，老代码写出的是字面量 "undefined"）
actual: 'a<span data-sue="undefined" style="text-decoration-line: underline; text-decoration-style: solid">bcd</span>e'
expected: 'a<span style="text-decoration-line: underline; text-decoration-style: solid">bcd</span>e'

# 36 只剥掉了新写的那层，落盘形态的旧装饰原封不动 —— 这正是线上「清除装饰没反应」的样子
  [
    { lines: 'underline', style: '…wavy', text: 'ab' },
+   { lines: 'overline', style: 'text-decoration-line: overline; text-decoration-style: double', text: 'ab' },
+   { lines: 'overline', style: 'text-decoration-line: overline; text-decoration-style: double', text: 'cd' },
    { lines: 'underline', style: '…dotted', text: 'cd' }
  ]
```

回退只用了 `git checkout -- src/dom.ts src/model.ts`（新版本先备份到临时目录），跑完立刻原样恢复，
随后 `npm test` 回到 196/196。

## 做不到 / 已知遗留

* **文档里仍写着 `data-sue`。** `docs/manual-verification.md:74-83,124` 的手工核对清单、
  `docs/superpowers/specs/…-design.md:182`、`docs/superpowers/plans/…-underline-enhancement.md:20,183,217-220,309-312,329`
  以及 `README*` / `CHANGELOG.md` 都按约束未作改动，其中手工清单第 2 项现在应当改成核对
  `<span style="text-decoration-line: …">`。**建议下一步单独提一次文档修订。**
* **`src/index.ts:286` 的注释还提到「合并成一个 `data-sue="b"` 的 span」**，已过时。
  该文件在本次改动范围之外，未改。
* **`ISpanSpec.position` 同样没有读取方**（`wrapRange` 只用 `spec.css`）。它与 css 指向同一个方向，
  属于「写了两份」的第二种形态；但本次任务只要求移除 `marker`，删掉 `position` 会连带删掉既有断言，
  因此保留并在注释里写明方向以 css 为准。若要继续收敛，建议下一步单独处理。
* **残留的认领风险**：判定依据是「span 声明了 `text-decoration-line`」，因此若思源把**自己**的下划线
  也渲染成 `<span style="text-decoration-line: underline">`（而不是 `<u>`），插件会把它当成自己的装饰接管。
  任务给定的前提是思源原生下划线为 `<u>`，`tests/dom.test.mjs:1147` 把这条钉住；真机上若发现不是 `<u>`，
  判定需要再收一道（例如要求同时存在 `text-decoration-style`）。
* 真机端到端（存盘 → 关闭文档 → 重新打开）没有跑：环境里没有思源实例。
  测试覆盖的是同一份 AST JSON 推出的落盘形态，属等价但非实测。
