# 过期字符偏移的写入安全网

## 根因

`openPanel`（`src/index.ts`）只在面板打开的那一刻记下一组字符偏移，此后整个面板生命周期内既不复核也不重算。
思源在编辑器失焦再获焦时会重渲染块，重新渲染出来的装饰 span 会带回缩进空白（磁盘上同一个块的内容从
`"TESTONE"` 变成 `"\n    \n    "`，`Properties` 一并没了），区域内 `textContent` 因此从 7 个字符变成 17 个，
而记下的 `(0, 7)` 早已不再界定用户当时选中的那段文字。`locate`（`src/dom.ts:392`）对越界的端点一律
悄悄夹到最后一个文本节点的末尾（`src/dom.ts:402-403`，注释是「绝不把范围算到区域之外」），
于是 `extractContents()` 取回的是另一段内容 —— 探针里就是把 `TESTTWO` 切成 `\n    TE` + `STTWO\n`，
再跑一次只剩 `"\n    \n    "` —— 而那一段会被原样写进 `updateBlock`。
探针输出与磁盘上那一对 `kg1dlpg` / `rts77ha` 说明的是同一件事：触发点是编辑器的文本选区被取消，
过期偏移只是它的下游症状。

**这份报告只交付那道安全网。** 真正的修复是「不要取消文本选区」，由另一处在做；本改动不声称修掉了用户报的那个问题。
按要求先尝试过的 Layer 1（记住选中文字、按内容重算偏移）已被否决并全部删除。
换句话说：偏移会过期是选区被取消之后才出现的事，本身不是一个独立缺陷。

## Layer 2 的判定与理由

判定落在 `src/dom.ts:569` 的 `offsetsWithinContent(editableElement, offsets)`：

```
start、end 都是整数，且 0 <= start <= end <= editableElement.textContent.length
```

选它的理由有三条。

**只判位置，不判内容。** 判内容就得在打开面板时把选中文字记下来，那正是被否决的那条路。
纯位置判定不需要任何新状态，也不引入任何按内容搜索的逻辑，守卫与被守卫的东西完全解耦：
它只回答「这对数字此刻还落在区域内吗」。

**零宽范围是合法空操作，不能报成错误。** `end === start` 覆盖不到任何字符，因此 `start <= end`
这一支天然放行它，`applySpansIn` 随后什么都不包，`beforeHTML === afterHTML` 于是既不发请求也不记账。
但零宽范围同样要受上界约束：覆盖不到字符不代表可以放在区域之外，所以 `(6, 6)` 打在 5 个字符的区域上仍判否。

**shrink（内容变短但偏移仍在范围内）判不出来，这里明确不假装能判。** 只记住数字就无从区分
「内容变短、位置没变」与「内容变短、位置已经挪到别的字上」。这种情形需要逐字比对选中文字才能识别，
代价正是被否决的那份记忆。这一条留在文档里，是为了让这道闸的覆盖边界不被误读成更强的东西。
换句话说：它拦得住「坐标已经越界」，拦不住「坐标还在范围内但指的是别的字」。

拒绝的收益是明确的：越界坐标被 `locate` 夹住之后取回的是别的内容，那份内容会被写进磁盘。

**整次放弃，不做半套改动。** 一次操作要覆盖全部区域，所以任一组判否就整次放弃：半套改动既不是用户要的，
也会在撤销栈里留下一条 `afterHTML` 对不上的记录。守卫在 `src/index.ts:214` 的
`if (!this.claimBlocks() || !this.offsetsWithinContent())` 一处求值，位于包裹装饰之前，因此文档一个字节都不会动。

## `isConnected` 短路为什么不够

`claimBlocks`（`src/index.ts:280`）原本只按「块还连不连在文档里」决定要不要重新认领，而真正需要的前提是
「这一组还对应文档里的内容」。两者不是一回事：块被删除后旧节点脱管，但脱管节点自身的 `textContent` 还在，
只判连接就会拿着一份已经不存在的副本去改，并且拿它的 `outerHTML` 去 `updateBlock` —— RED 里第三条用例
正是这样把一个已被删除的块连同旧内容一起发了出去。

因此 `claimBlocks` 现在返回 `boolean`，认不回来时返回 `false`（`src/index.ts:287-296`）：
块已被删除、或用户已切走文档，这一组连同整次操作一起作废。
没有 `data-node-id` 的区域仍按原样放行 —— 它无从查找，但只要还连在文档上就仍然可以装饰，只是不落盘。
`isConnected` 本身仍留在原地：面板的实时预览会以毫秒级连续触发，每一次都全文扫 `data-node-id`
在长文档上是白付的代价，这一点没有理由改。

## 改动清单

| 文件                   | 位置             | 改动                                                                         |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `src/dom.ts`           | 569-583          | 新增导出 `offsetsWithinContent(editableElement, offsets)`                    |
| `src/index.ts`         | 21               | 引入 `offsetsWithinContent`                                                  |
| `src/index.ts`         | 214-219          | `applyPair` 开头加守卫：认不回来或偏移越界就提示并整次返回，不改文档、不落盘 |
| `src/index.ts`         | 258              | `undoDecoration` 补一句注释：撤销只回读，认不回来也没有东西要再写一次        |
| `src/index.ts`         | 280-296          | `claimBlocks` 改为返回 `boolean`，认不回来时返回 `false`                     |
| `src/index.ts`         | 315-317          | 新增私有 `offsetsWithinContent()`，逐组求值                                  |
| `src/i18n/zh-CN.json`  | 12               | 新增 `selectionChanged`                                                      |
| `src/i18n/en.json`     | 12               | 新增 `selectionChanged`                                                      |
| `tests/dom.test.mjs`   | 32, 1279-1329    | 引入并直接测 `offsetsWithinContent`                                          |
| `tests/index.test.mjs` | 364-378, 409-410 | 夹具新增 `shrinkBlock` / `removeBlock`                                       |
| `tests/index.test.mjs` | 618-627          | i18n 覆盖用例补一次「坐标对不上」的分支，让新键进入键清单                    |
| `tests/index.test.mjs` | 1023-1118        | 五条端到端用例                                                               |

## 提示走的是哪条路

沿用插件已有的出口：`showMessage(this.i18n.<key>)`，与 `onload` 里给 `createDebouncedSaver` 的
`onError` 用的完全同一条路（`src/index.ts:113-117`）。没有另造第二条通知通道，没有碰 `src/panel.ts`。
新键 `selectionChanged` 已加进 `zh-CN.json` 与 `en.json`；「插件用到的每个 i18n 键在两种语言的真实文件里都存在」
那条用例现在会主动走一遍放弃分支，因此新键也在覆盖范围内。

## 覆盖到的用例

`tests/dom.test.mjs`（直接打 `offsetsWithinContent`）：

* `offsetsWithinContent accepts offsets that still land inside the region`
* `offsetsWithinContent rejects offsets that no longer address the current content` —— 记下的是 `(0, 11)`，
  区域只剩 5 个字符；另含起点越界、终点越界、起点为负、起止颠倒、非整数
* `offsetsWithinContent treats a zero-width range as a no-op instead of a divergence` —— 零宽放行、零宽越界拒绝
* `offsetsWithinContent rejects any offset once the region holds no text at all`

`tests/index.test.mjs`（完整面板→index 链路）：

* `记下的偏移越出内容时整次放弃：文档不动、不落盘，并提示用户` —— **反数据损失的那一条**
* `跨块选区里只有一组越界时整次放弃：另一段也不落盘` —— 整次放弃的原子性
* `块被删除之后记下的坐标整次放弃：不落盘，并提示用户` —— `claimBlocks` 返回 `false` 的那条路
* `记下的偏移仍然对得上时照常改动并落盘` —— 守卫不能把正常功能也拦下来
* `零宽范围是静默的空操作：既不报错也不落盘`
* `插件用到的每个 i18n 键在两种语言的真实文件里都存在`（扩写）

### 越界是怎么造出来的

按要求不依赖缩进空白的重渲染形态：夹具新增的 `shrinkBlock(blockId, text)` 在面板开着期间直接把块的内容
换短（`element.textContent = text`），记下的 `(0, 5)` 因此越出只剩 2 个字符的区域；
`removeBlock(blockId)` 则把块从文档里摘掉。jsdom 不模拟思源的重渲染，也不模拟用户在编辑器里改写，
因此这两条形态由夹具显式摆出 —— 关键只在于「面板记下的那对偏移已经不再对应任何字符」，与被谁触发无关。
零宽那条用例是白盒的：它直接把 `f.plugin.groups[0].end` 设成 `start`，用来钉住「零宽不是错误」这条语义。

## 验证

五条命令全部退出 0：

```
npm run lint                           → 0
npm test                               → 0   （258 tests / 258 pass / 0 fail）
node node_modules/typescript/bin/tsc --noEmit → 0
npm run format:check                   → 0
npm run build                          → 0   （webpack compiled successfully）
```

258 = 原有 230 + 本次新增 9 + 面板定位那一份并行改动新增的 19。
原有的一条断言都没有被删改或放宽；唯一被改动的是 i18n 那条覆盖用例，只做了加法
（多走一遍放弃分支、多一条 `assert.ok`）。

捕获 RED 证据时，`src/placement.ts`（面板定位那一份并行改动）还没写完，
`tests/index.test.mjs` 的夹具因此缺一个 `./placement` 桩，harness 加载不起来。
补上那一行之后数字见下面的 RED 一节；并行改动完成之后上面的五条命令才全部转绿。

## RED 证据

新增的 9 条用例先落地、`src/` 一行未改。先跑一次时 harness 因为缺 `./placement` 桩加载不起来
（`src/placement.ts` 当时还没写完），44 条报同一个
`loadModule: 模块 ./placement 没有桩实现`。把那一行桩补上（纯机械，harness 能不能加载而已）之后重跑：

```
tests 248   pass 235   fail 13
```

13 条失败里 9 条是本次新增的用例，剩下 4 条在 `tests/panel.test.mjs`，
是并行改动尚未收尾所致。关键三条（`src/index.ts` 未改时的实际输出）：

```
test at tests\index.test.mjs:1030:1
✖ 记下的偏移越出内容时整次放弃：文档不动、不落盘，并提示用户
  AssertionError: 越界的坐标一个字节都不许落到文档上  + actual - expected

  + '<p data-type="text" data-node-id="20261003220000-a1"><span style="text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: currentColor">ab</span></p>'
  - '<p data-type="text" data-node-id="20261003220000-a1">ab</p>'
```

即：记下的 `(0, 5)` 打在只剩 `"ab"` 的块上，装饰照样裹上去，文档被改，随后被发成一次 `updateBlock`。

```
test at tests\index.test.mjs:1072:1
✖ 块被删除之后记下的坐标整次放弃：不落盘，并提示用户
  AssertionError: 不得对着已经删掉的块发请求  + actual - expected

  + [
  +   { data: { data: '<p …a1"><span style="text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: currentColor">hello</span></p>',
  +            dataType: 'dom', id: '20261003220000-a1' }, url: '/api/block/updateBlock' },
  +   { data: { data: '<p …b2"><span style="text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: currentColor">world</span></p>',
  +            dataType: 'dom', id: '20261003220000-b2' }, url: '/api/block/updateBlock' }
  + ]
  - []
```

即：块已经被 `remove()` 掉，它的旧副本连同改前内容照样被发回了内核 —— 这与磁盘上那一对
「一块幸存、一块只剩空白」的记录是同一类后果。

四条 dom 用例在旧代码上是 `TypeError: offsetsWithinContent is not a function`，
i18n 那条是 `AssertionError: 坐标对不上的提示应当取自 i18n`（插件根本没去取这个键）。
加上守卫之后 `node --test tests/dom.test.mjs tests/index.test.mjs` → 105 / 105 / 0。

## 没有真实思源就无法验证的部分

* 越界究竟由哪些用户动作触发（失焦重渲染、面板开着时自己敲字、块被脚本或别的插件换掉），
  只能在真机上复现。这里只保证「一旦越界就一个字节都不写」，不负责枚举触发源。
* `showMessage` 的实际呈现（弹出时长、是否与思源自己的提示叠加）没有 jsdom 对应物。
* 这道闸拦得住越界，拦不住范围内的错位（见上文 shrink 一节）；
  那种情形要靠别处的修复（保持选区不被取消）来根治。
* `claimBlocks` 返回 `false` 的分支里，「没有 `data-node-id` 的区域仍连在文档上」这一支只在
  夹具之外成立 —— jsdom 的用例全部带块 id。

## 与并行的面板定位改动的一处交叠

面板定位那一份并行改动（新增 `src/placement.ts`，改 `src/panel.ts` / `tests/panel.test.mjs`）
与本次改动共享 `tests/index.test.mjs` 里的模块依赖表：它需要给 `loadModule("src/panel.ts", …)`
加一行 `"./placement": loadModule("src/placement.ts")`。那一行是 harness 能加载 `panel.ts` 的必要条件，
若双方各写一次内容相同，不会产生实质冲突，但合并时需要留意。
`src/panel.ts` 与 `src/index.scss` 本身未被本次改动触碰。
