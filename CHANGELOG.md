# 更新日志

本文件记录 MarkStudio 的各版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [1.0.0] - 2026-10-15

首个开源版本。MarkStudio 是一款基于 **Electron + Vditor（IR 模式）** 的所见即所得 Markdown 桌面编辑器，核心渲染引擎（Lute）、公式（KaTeX）、代码高亮（highlight.js）均内置离线，无需联网即可完整使用。

### 功能

- **所见即所得**：沉浸式编辑，标题、列表、引用、表格、任务清单输入即时排版。
- **代码块**：内置 197 种语言语法高亮；支持选择语言、显示/隐藏行号；行内代码与代码块自动区分。
- **表格**：可视化插入，支持拖拽拉伸行高/列宽，右键/悬浮工具条做行列操作。
- **数学公式**：KaTeX 渲染行内与块级公式。
- **多格式导出**：
  - Word（.docx）：原生 OOXML，公式为可编辑对象，表格/超链接/列表/任务清单保真；
  - PDF：自动注入大纲/书签；
  - HTML、图片（长文自动分片，可选分辨率/DPI）。
- **双语界面**：简体中文 / English，可在设置中切换。
- **个性化**：主题、正文字体/字号、行高、正文宽度/对齐、自动换行；打字机模式与专注模式。
- **大文件快速阅读模式**：超大文档分段虚拟渲染。
- **快捷键自定义**：内置快捷键可重新绑定，冲突自动提示。
- **本地打开**：拖拽 `.md` 文件打开，自动记录最近文件/文件夹；多标签、多窗口。
- **系统托盘**（Windows）。

### 平台

- **Windows**：NSIS 安装版 + 绿色便携版。
- **Linux**：AppImage + deb + rpm（系统字体列表依赖 `fontconfig` 的 `fc-list`）。

### 许可与合规

- 本项目采用 MIT 许可证开源。
- 内置第三方组件许可证随组件一并提供：Vditor（MIT）、Lute（MulanPSL-2）、KaTeX（MIT）、highlight.js（BSD-3-Clause）、iconv-lite（MIT）；`vendor/vditor/dist/index.js` 内联的 google/diff-match-patch 为 Apache-2.0，详见 `vendor/vditor/dist/LICENSE`。
