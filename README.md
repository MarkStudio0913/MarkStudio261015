# MarkStudio

一款**所见即所得（WYSIWYG）** 的 Markdown 桌面编辑器：输入即时渲染，专注内容本身，无需在源码与预览之间来回切换。

基于 **Electron + Vditor（IR 模式）** 构建，核心渲染引擎（Lute）与公式（KaTeX）、代码高亮（highlight.js）均已**内置离线**，无需联网即可完整使用。

---

## 功能特性

- **所见即所得**：沉浸式编辑，标题、列表、引用、表格、任务清单输入即时排版。
- **代码块**：内置 **197 种语言** 语法高亮；支持为代码块选择语言、显示 / 隐藏行号；行内代码与代码块自动区分。
- **表格**：可视化插入，支持**拖拽拉伸行高 / 列宽**，右键 / 悬浮工具条做行列操作。
- **数学公式**：KaTeX 渲染行内与块级公式。
- **多格式导出**：
  - **Word（.docx）**：原生 OOXML，公式为可编辑对象，表格 / 超链接 / 列表 / 任务清单保真；
  - **PDF**：自动注入大纲 / 书签；
  - **HTML**、**图片**（长文自动分片、可选分辨率 / DPI）。
- **双语界面**：简体中文 / English，可在设置中切换（保存后生效）。
- **个性化**：主题、正文字体 / 字号、行高、正文宽度 / 对齐、自动换行等；支持**打字机模式**与**专注模式**。
- **大文件快速阅读模式**：超大文档分段虚拟渲染，打开与滚动不卡顿。
- **快捷键自定义**：内置快捷键可重新绑定，冲突自动提示。
- **本地打开**：支持拖拽 `.md` 文件到窗口打开，自动记录最近文件 / 文件夹。

---

## 环境要求

- **Node.js** 18+ 与 **npm**（推荐 Node 20+）。
- 支持 **Windows** 与 **Linux** 两大平台。
- 打包需在对应平台执行：Windows 包在 **Windows** 上构建（electron-builder / NSIS）；Linux 包（AppImage / deb / rpm）在 **Linux** 上构建。
- Linux 运行/打包建议具备 `fontconfig`（`fc-list`，用于设置里的系统字体列表；主流发行版默认已装）。

> 仓库根目录自带 `.npmrc`，将 npm / Electron 镜像指向国内源（npmmirror），可显著加速安装；如你在海外或已有镜像配置，可忽略或删除该文件。

## 安装与运行

```bash
# 安装依赖（安装完成后会自动把内置的 Vditor 引擎准备到 vendor/，保证离线可用）
npm install

# 以开发模式启动
npm start
```

## 打包发行版

```bash
# 在当前平台构建（Windows 上出 Windows 包，Linux 上出 Linux 包）
npm run dist

# 或显式指定平台
npm run dist:win      # Windows：NSIS 安装版 + 便携版
npm run dist:linux    # Linux：AppImage + deb + rpm
```

产物（在 `dist/` 下）：

- **Windows**：`MarkStudio-Setup-<version>.exe`（NSIS 安装版）、`MarkStudio-Portable-<version>.exe`（绿色便携版）
- **Linux**：`MarkStudio-<version>-x64.AppImage`、`MarkStudio-<version>-x64.deb`、`MarkStudio-<version>-x64.rpm`

## 项目结构

```
markstudio-oss/
├─ src/
│  ├─ main/            # Electron 主进程（窗口、IPC、导出、托盘等）
│  │  ├─ main.js
│  │  └─ preload.js    # contextBridge 白名单
│  └─ renderer/        # 渲染层（编辑器、表格、i18n、Word 导出等）
│     ├─ renderer.js
│     ├─ i18n.js       # 中 / 英双语文案
│     ├─ docx-gen.js   # Word（OOXML）导出
│     ├─ index.html
│     ├─ style.css
│     └─ stats-worker.js
├─ vendor/vditor/dist  # 内置离线渲染引擎（Vditor + Lute + KaTeX + highlight.js）
├─ resources/          # 应用图标
├─ build/              # 安装包自定义脚本与背景
├─ scripts/            # 构建辅助（准备 vendor、冒烟测试等）
├─ test-assets/        # 测试用 Markdown 样本
├─ package.json
├─ LICENSE
└─ README.md
```

## 技术栈

- **Electron** 31 —— 桌面壳
- **Vditor**（IR 模式）—— 所见即所得编辑器
- **Lute**（by 88250）—— Markdown 解析引擎（WASM，离线）
- **KaTeX** —— 数学公式
- **highlight.js** —— 代码高亮
- **electron-builder** —— 打包（Windows：NSIS / 便携版；Linux：AppImage / deb / rpm）

## 第三方组件与许可

本项目内置并依赖以下开源组件，各自的许可证随组件一并提供（见 `vendor/vditor/dist` 内的 `LICENSE`）：

| 组件 | 许可证 |
| --- | --- |
| Vditor（B3log） | MIT |
| Lute | MulanPSL-2 |
| KaTeX | MIT |
| highlight.js | BSD-3-Clause |
| iconv-lite | MIT |

> 说明：`vendor/vditor/dist/index.js` 为 **Vditor v3.11.3 的修改版**（性能优化：整篇 Markdown 转换推迟到输入停顿后执行，修改处均以 `MarkStudio` 注释标记），依 MIT 许可证修改并再分发，修改说明与许可证全文见 `vendor/vditor/dist/LICENSE`。

## 许可

本项目采用 [MIT 许可证](./LICENSE) 开源。
