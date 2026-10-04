# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-03

First release.

### Added

* **Underline Enhancement** button in the Protyle editor's floating toolbar — a letter U above a wavy line, so
  it is distinguishable from SiYuan's own straight underline. Clicking it opens a panel with a switch, the
  line style and the color.
* Five line styles (`solid`, `dashed`, `dotted`, `double`, `wavy`), previewed with real CSS
  `text-decoration-style` instead of icon characters. The style in use is drawn darker than the others.
* Color choice: follow the text color, 11 preset colors including black, and a custom color input. A custom
  value gets its own swatch so the color in use stays visible. Choosing 「follow the text color」 writes
  `text-decoration-color: currentColor`, which is what omitting the declaration means in CSS.
* **Clear decoration** to remove the underline from the selection, and **Undo** to step back one change —
  all blocks that change touched are reverted by a single press. Undo is disabled when there is nothing to undo.
* Live preview on the selection with a 300 ms debounced save. Opening the panel on text with no underline
  applies the default configuration right away. The default is a solid line in the text color.
* Picking a control applies the change and closes the panel, like SiYuan's own color menu; the selection and
  the floating toolbar stay in place.
* Selection ranges spanning paragraphs, list items and table cells; every affected block is saved on its own.
  A _tight_ list whose item text is a direct child of the `<li>` is the exception: it has no editable region
  of its own, so that text cannot be decorated.
* Every control in the panel is always clickable — there is nothing that has to be enabled first.
* Panel controls deliberately take no keyboard focus, matching how SiYuan's own menus behave. Clicking a
  control therefore leaves the caret and the selection where they were instead of collapsing them.
* When the regions of one selection do not all carry the same decoration, the panel says so before the user
  clicks: one change applies that configuration to the whole selection.
* Decorations are persisted as inline styles through `/api/block/updateBlock` with `dataType: "dom"`, so they
  keep rendering in read-only mode, on published pages and wherever the plugin is not loaded.
* Decorations are recognised by their `text-decoration-line` declaration rather than by a marker attribute,
  because SiYuan drops unknown attributes when it parses a block's HTML into its own AST.
* English and Chinese UI strings (`i18n/en.json`, `i18n/zh-CN.json`).

### Known limitations

* Exporting to Markdown, HTML or PDF collapses the underline to a plain `<u>` and loses the line style
  and color, because SiYuan's Markdown engine (Lute) preserves only `color`, `background-color`, `font-family`
  and `font-size`. This is SiYuan's export-pipeline behaviour, not a defect of this plugin.
* SiYuan's Ctrl+Z undo stack does not cover this plugin's operations. Use the panel's **Undo** button or
  SiYuan's document history.
* Code blocks are not supported, matching SiYuan's own floating toolbar.
* Applying, restyling and **Clear decoration** are scoped to the selected range: decoration elsewhere in the
  same block is preserved, and has to be selected to be changed or cleared.
* Undo covers one recorded change within the current panel session. It is skipped when any of its blocks no
  longer matches what that change left behind (because it has been edited since), and the stack is emptied
  when the document is switched.

[0.1.0]: https://github.com/Xfl-A/siyuan-underline-enhancement/releases/tag/v0.1.0
