# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-03

First release.

### Added

* **Underline Enhancement** button in the Protyle editor's floating toolbar. Clicking it opens a panel where the
  underline and the overline are configured independently — switch, line style and color per direction.
* Five line styles (`solid`, `dashed`, `dotted`, `double`, `wavy`), previewed with real CSS
  `text-decoration-style` instead of icon characters.
* Color choice per direction: follow the text color, 10 preset colors, and a custom color input. A custom value
  gets its own swatch so the color in use stays visible.
* **Clear decoration** to remove both directions, and **Undo** to step back one change.
* Live preview on the selection with a 300 ms debounced save. The last configuration used is remembered and
  becomes the panel's starting point next time.
* Selection ranges spanning paragraphs, list items and table cells; every affected block is saved on its own.
* Decorations are persisted as inline styles through `/api/block/updateBlock` with `dataType: "dom"`, so they
  keep rendering in read-only mode, on published pages and wherever the plugin is not loaded.
* English and Chinese UI strings (`i18n/en.json`, `i18n/zh-CN.json`).

### Known limitations

* Exporting to Markdown, HTML or PDF collapses the underline to a plain `<u>` and loses the overline, line style
  and color, because SiYuan's Markdown engine (Lute) preserves only `color`, `background-color`, `font-family`
  and `font-size`. This is SiYuan's export-pipeline behaviour, not a defect of this plugin.
* SiYuan's Ctrl+Z undo stack does not cover this plugin's operations. Use the panel's **Undo** button or
  SiYuan's document history.
* Code blocks are not supported, matching SiYuan's own floating toolbar.

[0.1.0]: https://github.com/Xfl-A/siyuan-underline-enhancement/releases/tag/v0.1.0
