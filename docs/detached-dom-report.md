# 面板开着时思源重渲染了块：改动落到脱管节点上

## 根因

`openPanel` 把选区拆成分组存进 `this.groups`（每组一个 `blockElement` 与 `editableElement`），
把字符偏移存进 `this.offsets` —— 全是活的 DOM 引用。思源在任何时刻都会重渲染块，
一旦重渲染，这些引用就指向**已经从文档里换掉**的节点，而 `applyPair`
（`src/index.ts:210`，面板每一次改动都走它）从头到尾只用这批引用：`applySpansIn` 包裹装饰、
`blockElement.outerHTML` 取前后 HTML、`saver.save` 记账、`restoreOffsets` 重建选区。
于是装饰裹在脱管的那一份上，屏幕上看不到任何变化；`beforeHTML` 与 `afterHTML` 都是那一份的
（改动确实发生了），`updateBlock` 仍会发一次，落盘的内容却不是用户看到的东西；
`restoreOffsets` 把 Range 写进一棵不在页面上的树，选区就此消失。
`src/index.ts` 里早就有对症的补救 —— `claimBlocks()`（`src/index.ts:268`）按 `data-node-id`
重新找到活着的块元素并重指 `group.editableElement` / `group.blockElement` / `this.offsets[i][0]` ——
但它只被 `undoDecoration()` 调用过一次，主路径一次都没调。

复现探针（把重渲染模拟成 `outerHTML` 往返，然后点第二个色块）给出的正是这两条症状：

```
[1 first change] <span style="...wavy">hello</span>       <- lands
[2 after re-render] <span style="...wavy">hello</span>
[3 after 2nd change, live block] <span style="...wavy">hello</span>
    change reached live DOM: NO                            <- symptom
    updateBlock sent: NO
[4 selection] rangeCount=0 selectedText=""                 <- symptom
```

`[3]` 里活着的块还是第一版，`[4]` 里选区整个不见了。真实使用时之所以时好时坏，
是因为**打开面板后的第一下点击**引用的确还连着文档，之后每一次都失败。

## 改了什么

### `src/index.ts`

| 位置                   | 改动                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts:211-213` | `applyPair` 的第一件事：`this.claimBlocks()`。读块 HTML、包裹装饰、重建选区、调度保存因此全部落在文档里那个节点上。                                                                  |
| `src/index.ts:259-267` | `claimBlocks` 的文档注释：首句原本写「撤销后的重新认领」，现在有第二个调用方，改为「块节点被换掉之后的重新认领」，并把触发原因并列成撤销写回与思源重渲染两条。**函数体一个字没动。** |

净改动：生产代码 3 行有效语句（1 行调用 + 2 行注释）。

### `tests/index.test.mjs`

| 位置                           | 改动                                                                                                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/index.test.mjs:32-37`   | 四个新的断言用正则：`DECORATED_OVERLINE`、`DECORATED_OVERLINE_DOTTED`、`DECORATED_UNDERLINE_BLUE`、`DECORATED_OVERLINE_RED`（上划线的两种线型，以及带指定颜色的装饰）。                                                                                          |
| `tests/index.test.mjs:321-337` | 新助手 `rerender(blockId)`：把块节点的 `outerHTML` 取下来再写回去，节点因此被整个换掉。它自己断言「块还在」「`block(BLOCK_A) !== 原引用`」「原引用 `isConnected === false`」，并把脱管的那一个返回出去供断言使用；用例因此不必重复「重渲染确实发生了」这句前提。 |
| `tests/index.test.mjs:641-846` | 九个新用例，全部走真实的 panel → index 链路（`plugin.onload()` + `await plugin.onLayoutReady()` + `clickToolbarItem`），除「重渲染」这一步之外不用任何测试专用旁路。                                                                                             |

**重渲染是怎么模拟的**：`rerender` 里 `const html = element.outerHTML; element.outerHTML = html;`
（等价于 `element.outerHTML = element.outerHTML`，拆成两句是为了绕开 eslint 的 `no-self-assign`）。
jsdom 与浏览器一样按 `outerHTML` setter 的语义把子节点搬进一个新元素、再换掉父节点上的旧节点，
于是块 id 与内容都一模一样、被换掉的却是另一个对象 —— 这正是思源重渲染对插件引用造成的影响。

九个用例（`tests/index.test.mjs` 行号）：

| 行  | 用例                                                                       | 断言的可见结果                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 648 | 重渲染之后下划线的第二次线型改动仍然落到活着的块上，并各发一次 updateBlock | 跨块选区两块都换成 dotted；四个 `updateBlock`，`posts[2].data.data` / `posts[3].data.data` 等于**活着的** `block(BLOCK_A/B).outerHTML`；`dataType === "dom"`                                                                              |
| 672 | 重渲染之后上划线的第二次线型改动仍然落到活着的块上，并各发一次 updateBlock | 上划线 dotted → wavy，两块都换；两个新 post 的 data 等于活着的块 HTML                                                                                                                                                                     |
| 696 | 重渲染之后下划线的第二次颜色改动仍然落到活着的块上，并各发一次 updateBlock | 颜色 `#0090ff` 出现在**活着的**块 HTML 里；两个新 post 的 data 等于活着的块 HTML                                                                                                                                                          |
| 718 | 重渲染之上划线的第二次颜色改动仍然落到活着的块上，并各发一次 updateBlock   | 上划线变成 `#e5484d`，同上                                                                                                                                                                                                                |
| 741 | 重渲染之后重建的选区落在活着的文档上，而不是脱管的那一份里                 | `getSelection().rangeCount > 0`、`toString() === "helloworld"`、`block(BLOCK_A).contains(anchorNode)`、`block(BLOCK_B).contains(focusNode)`                                                                                               |
| 760 | 重渲染之后清除装饰，活着的块上不再有装饰                                   | 两个方向都开 → 重渲染 → 清除：两块活着的 HTML 里都不再有 `text-decoration`，落盘的两条 data 里也都没有                                                                                                                                    |
| 783 | 重渲染之后关掉下划线，活着的块上只留下上划线                               | 下划线消失、上划线 dotted 原样留着（说明这确实是一次重裹而不是整体抹掉）                                                                                                                                                                  |
| 806 | 重渲染之后关上划线，活着的块上只留下下划线                                 | 上划线消失、下划线 wavy 原样留着                                                                                                                                                                                                          |
| 827 | 重渲染之后的改动只写活着的块，脱管的那一份不会被改到                       | **这一条是修复前会失败的那条**：只重渲染 `BLOCK_A`（跨块选区里一组脱管、一组仍连着文档），改颜色后活着的 `BLOCK_A` 里有 `#0090ff`、脱管的旧副本 `innerHTML` 里**没有**，`BLOCK_B` 照旧改得到，`BLOCK_A` 仍然发了一次且内容是活着的块 HTML |

九个用例全部使用跨块选区（`crossRange()`，`BLOCK_A` + `BLOCK_B`），线型与颜色两个方向各有覆盖。

## 三个设计问题的判断

### 一、`claimBlocks()` 应该在整个 `this.groups` 循环之前跑一次，还是每组跑一次？

**跑一次，确认。** `claimBlocks` 自己就是 `for (let i = 0; i < this.groups.length; i++)`（`src/index.ts:269`），
它遍历全部分组并同时修正 `this.offsets[i][0]`。在 `applyPair` 的循环里逐组调用等于把同一批分组
反复走两遍，`findBlockElement` 的次数按分组数平方增长，而 `this.offsets` 的修正又会重复执行；
语义上也说不通 —— 一个分组要落在哪个可编辑区域，本来就是靠「同一轮里和别的分组一起重新认领」
这件事保证的。放在 `applyPair` 的第一行，`composePair` 之前，改动最小且语义最正：
**每一次应用之前先重新认领，之后这个方法内部只读不再解析。**

### 二、`claimBlocks()` 对已消失的块 `continue`、把那一组的旧引用留在原处，可以接受吗？

**可以接受，我没有改。** 三条理由：

1. **它在这个改动之前就已经是这个行为，而且语义明确。** 撤销路径一直这么跑。`continue` 之后
   `applyPair` 会照常在脱管的那一份上包裹装饰、`saver.save` 也会照常发 —— 但那是
   「块被删除 / 用户已切走文档」这种本来就没有正确答案的场景，不是本次要修的场景。
   本次修复把这个窗口从「任何一次重渲染」收窄到「块真的不在文档里了」，是严格变窄，不是新引入的行为。
2. **下游已经明确设计过这个场景。** `persist.ts` 的 `resolveUndoTargets`（`src/persist.ts:137`）
   在 `findBlockElement` 返回 `null` 时整条记录作废，注释写得很直白：「只要有一个块过期或已不在文档里
   （被删除、或用户已切走文档），这条记录就作废；留着过期记录，撤销会一直卡在它上面」。
   「用户已切走文档」这一支另有 `handleProtyleSwitch` → `closePanel()` → `this.groups = []`
   提前收摊，`claimBlocks` 跑在空数组上，什么也不做。真正剩下的只有「面板开着时块被删掉」。
3. **让 `applyPair` 跳过这类分组要另做一整套决定，而且都属于过度设计。** 是把这一组从
   `this.groups` 里剔掉（那 `this.offsets` 就得同步删，两条数组从此可能对不齐）？还是只在本次
   跳过（用户会看到「这一段没反应」，而且没有任何提示）？还是就此关掉面板？每一条都是新的产品决策，
   都改变用户看得见的行为，而且都不是这个 bug 的一部分。真要处理，正确的地方是 `persist.ts`
   加上一次「块已不在文档里就别记账」的判断，那属于另一件事。

所以：`claimBlocks` 一行未动，`applyPair` 也没有引入任何跳过逻辑。

### 三、有没有测试依赖 `applyPair` **不**重新认领？

**没有，而且这一点是被证明过的，不是推断的。** 把 `src/index.ts` 单独还原到 HEAD 跑全套，
196 个既有测试**全部通过**，失败的正好是新增的九个（见下面的 RED 证据）。既有用例里
表格单元格、callout 标题区、「表格单元格里撤销之后再改设置」这几条最可能受影响的路径全部照旧通过，
原因是：没有重渲染时 `editableElement.isConnected === true`，`reclaimEditableElement`
（`src/dom.ts:625`）在第三种情形下原样返回，`findBlockElement` 也只会找回同一个对象 ——
`claimBlocks` 在这些路径上是完全的恒等变换。

## 验证命令与输出

全部在 `D:\Coding\siyuan-underline-enhancement`（分支 `main`）执行，PowerShell on Windows。

```
> npm run lint
> eslint . --fix --cache
LINT_EXIT=0

> node node_modules/typescript/bin/tsc --noEmit
TSC_EXIT=0

> npm run format:check
> dprint check
FMT_EXIT=0

> npm test
# tests 205
# pass 205
# fail 0
# cancelled 0
# skipped 0
# todo 0

> npm run build
webpack 5.111.1 compiled successfully in 632 ms
BUILD_EXIT=0
```

196 → 205：九个新用例，**没有改动、削弱或删除任何一条既有断言**
（`git diff --stat`：`src/index.ts | 14 +--`，`tests/index.test.mjs | 234 +++++++++++`，全部是新增）。

## RED 证据

只把 `src/index.ts` 还原到 HEAD（`git stash push -- src/index.ts`），测试文件保持最终版本：

```
> node --test --test-reporter=tap tests/*.test.mjs
# tests 205
# pass 196
# fail 9
```

失败的是第 75–83 条，正好是九个新增用例（名字全部以「重渲染之后 / 重渲染之上划线 / 重渲染之后的下划线」开头）：

```
not ok 75 - 重渲染之后下划线的第二次线型改动仍然落到活着的块上，并各发一次 updateBlock
not ok 76 - 重渲染之后上划线的第二次线型改动仍然落到活着的块上，并各发一次 updateBlock
not ok 77 - 重渲染之后下划线的第二次颜色改动仍然落到活着的块上，并各发一次 updateBlock
not ok 78 - 重渲染之上划线的第二次颜色改动仍然落到活着的块上，并各发一次 updateBlock
not ok 79 - 重渲染之后重建的选区落在活着的文档上，而不是脱管的那一份里
not ok 80 - 重渲染之后清除装饰，活着的块上不再有装饰
not ok 81 - 重渲染之后关掉下划线，活着的块上只留下上划线
not ok 82 - 重渲染之后关上划线，活着的块上只留下下划线
not ok 83 - 重渲染之后的改动只写活着的块，脱管的那一份不会被改到
```

每一条都失败在**它自己要断言的那一句**上，不是夹具或前置条件：

```
75  AssertionError: 第一段的线型要真的换成 dotted
      actual:   <p data-node-id="20261003220000-a1"><span style="text-decoration-line: underline; text-decoration-style: wavy">hello</span></p>
      expected: /<span style="text-decoration-line: underline; text-decoration-style: dotted(?:;|")/
78  AssertionError: 第一段的上划线要真的变成红色
      actual:   <p data-node-id="20261003220000-a1"><span style="text-decoration-line: overline; text-decoration-style: dotted"><span style="text-decoration-line: underline; text-decoration-style: solid">hello</span></span></p>
      expected: /text-decoration-line: overline; text-decoration-style: dotted; text-decoration-color: #e5484d/
79  AssertionError: 选区必须回到文档上，用户才能接着输入
      actual:   false      expected: true        ← rangeCount === 0，与探针 [4] 一致
80  AssertionError: 第一段的装饰要真的被清掉        actual: true  expected: false
81  AssertionError: 第一段的下划线要去掉            actual: true  expected: false
82  AssertionError: 第一段的上划线要去掉            actual: true  expected: false
83  AssertionError: 改动要落在文档里那个块上
      actual:   <p data-node-id="20261003220000-a1"><span style="text-decoration-line: underline; text-decoration-style: wavy">hello</span></p>
      expected: /text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: #0090ff/
```

还原之后又跑一次 `git stash pop` 把 `src/index.ts` 恢复，重新验证 205/205 通过、
lint / tsc / format:check / build 全 0。

## 做不到 / 需要说明的地方

1. **性能：每次点击都多一遍 `findBlockElement`。** `claimBlocks` 对每个分组做一次
   `document.querySelectorAll("[data-node-id]")` 加逐个属性比对，是 O(文档块数)。
   面板实时预览会以毫秒级连续触发（指针扫过色板），所以大文档里这 noticeable 的开销是新出现的。
   我没有顺手优化（例如先判 `isConnected === true` 再查），因为那属于改 `claimBlocks` 的实现，
   题目明确要求只在它有具体缺陷时才动它，而且优化路径要另配测试才敢上。
   撤销路径本来就有同样的开销，这次只是让它也出现在 apply 路径上。
   如果实测发现大文档卡顿，第一刀应当是 `claimBlocks` 里的 `isConnected` 短路。
2. **`claimBlocks` 对「块已消失」的那一支没有新增覆盖。** 按设计问题二的结论它保持原样，
   因此「面板开着时删掉被选中的块」这个场景仍然没有端到端用例。它不是本次改动的行为变化，
   单独加一条会把「保持原状」固化成规格，需要另开一次决定。
3. **真实思源里的重渲染时机没法在这里验证。** 全部证据来自 jsdom：`outerHTML` 往返确实换掉节点、
   `reclaimEditableElement` 确实按位置找回新块里的同一个可编辑区域、`restoreOffsets` 写进脱管树时
   jsdom 会静默丢弃那条 Range（`rangeCount` 归 0，与探针一致）。
   浏览器与 jsdom 在这一处的行为一致，但「思源具体在什么时机、以什么粒度重渲染」仍然需要
   `docs/manual-verification.md` 那类手动验证补一次 —— 本次没有在真实思源里跑过。
4. **jsdom 会按 DOM 规范把 Range 端点从被删节点上挪到父节点**，因此
   「重渲染之后当前选区的端点已脱管」在 jsdom 里断言不出来（端点会落到 `#editor` 上且仍 `isConnected`）。
   我原本写了这条前置条件，验证发现它在 jsdom 里不可达，已经删掉；
   真正相关的前提 —— 插件手里那批引用脱管 —— 由 `rerender` 助手自己断言。
