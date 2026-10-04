/**
 * 浮动工具栏图标：字母 U 加一条波浪下划线。
 *
 * U 的那段路径取自 Lucide 的 `underline` 并原样保留，只把描边宽度从上游的 2 收到 1.5：
 * 工具栏里图标按 16px 渲染，描边 2 落下来约 1.3px，与思源那套填充式（stroke-width: 0）的图标不协调。
 *
 * U 下面那条线自己画成波浪：思源工具栏里本来就带一个直下划线按钮，
 * 两个图标并排时只有波形能让用户一眼分清哪个是这个插件的。
 * 波浪横跨 x=4..20、走过两个整周期，节点都在 y=20 上、振幅各 1.5（波峰 y=21.5 与 18.5）：
 * 周期再少就并成一条带毛边的直线，再多在 16px 下就糊成实线，两个周期刚好还看得出起伏。
 *
 * fill 与 stroke-width 必须写在 symbol 上，不能只依赖 svg 上的样式：
 * 思源对工具栏图标统一设了 `fill: currentColor; stroke-width: 0`，那是**svg 元素自身**的声明，
 * 会继承给 symbol 里的每条路径；而写在 symbol 上的表现属性是该元素自己的声明，优先级高于继承值。
 * 少了 fill="none"，路径会被填成实心块；少了 stroke-width，描边宽度会变成 0，整个图标看不见。
 */
export const UNDERLINE_ICON_SVG =
    `<symbol id="iconUnderlineEnhancement" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M6 4v6a6 6 0 0 0 12 0V4"/>
<path d="M4 20c1.33 2 2.67 2 4 0c1.33-2 2.67-2 4 0c1.33 2 2.67 2 4 0c1.33-2 2.67-2 4 0"/>
</symbol>`;
