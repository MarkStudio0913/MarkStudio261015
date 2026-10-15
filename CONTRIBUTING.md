# 贡献指南

感谢你对 MarkStudio 的关注！本项目是一款基于 **Electron + Vditor（IR 模式）** 的所见即所得 Markdown 桌面编辑器，支持 **Windows** 与 **Linux**。以下内容帮助你快速上手开发与提交。

## 环境准备

- **Node.js** 18+（推荐 20+）与 **npm**
- 打包 Windows 包需在 Windows 上执行；打包 Linux 包（AppImage / deb / rpm）需在 Linux 上执行
- Linux 下的「系统字体列表」依赖 `fontconfig`（`fc-list`），主流发行版默认已安装

```bash
# 安装依赖；postinstall 会自动运行 scripts/copy-vendor.js
# 将 Vditor 引擎准备到 vendor/，保证完全离线可用
npm install

# 开发模式启动
npm start
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm start` | 以开发模式启动应用 |
| `npm run dist` | 在**当前平台**打包（Windows 出 Windows 包，Linux 出 Linux 包） |
| `npm run dist:win` | 打包 Windows：NSIS 安装版 + 便携版 |
| `npm run dist:linux` | 打包 Linux：AppImage + deb + rpm |
| `npm run smoke` | 冒烟测试：启动→打开→编辑→保存→校验落盘 |

## 项目结构

- `src/main/` —— Electron 主进程：窗口、IPC、导出（PDF/图片/Word 容器）、托盘、系统字体枚举
- `src/main/preload.js` —— `contextBridge` 白名单（`contextIsolation` 开启、`nodeIntegration` 关闭）
- `src/renderer/` —— 渲染层：编辑器、表格、i18n、Word（OOXML）导出、样式
- `vendor/vditor/dist/` —— 内置离线渲染引擎（Vditor + Lute + KaTeX + highlight.js）
- `scripts/` —— 构建辅助（准备 vendor、生成图标、冒烟测试）
- `build/` —— Windows 安装包自定义脚本与背景
- `resources/` —— 应用图标（`gen-icon.js` 生成 `.ico` 与 512×512 `.png`）

## 关于 vendor/ 的重要说明

`vendor/vditor/dist/index.js` 是 **Vditor 的修改版**（性能优化：整篇 Markdown 转换推迟到输入停顿后执行，修改处均以 `MarkStudio` 注释标记）。

- `scripts/copy-vendor.js` 在重新从 `node_modules` 复制 vditor 时，会**自动备份并还原**这份带补丁的 `index.js`，以及 `vendor/` 下的各 `LICENSE` 文件。
- 请**不要删除** `vendor/vditor/dist/` 及其子目录（`js/lute`、`js/katex`、`js/highlight.js`）中的 `LICENSE` 文件——它们是第三方组件的许可证，随再分发一并提供。
- 若你修改了 vendor 补丁，请保留 `MarkStudio` 标记，以便 `copy-vendor.js` 识别。

## 跨平台注意事项

代码需同时兼顾 Windows 与 Linux：

- **文件路径**：Windows 用反斜杠、Linux 用 POSIX 正斜杠。请复用 `renderer.js` 的 `resolveLocalPath` / `diskPathFromUrl` / `fileUrlOf` 与 `docx-gen.js` 的 `resolveDocPath`，不要硬编码路径分隔符。
- **平台专有调用**：涉及 PowerShell / Win32 API（如任务栏 AUMID、System.Drawing 字体枚举）的逻辑，必须用 `process.platform === 'win32'` 守卫，并为 Linux 提供等价实现或优雅降级（如字体走 `fc-list`）。
- **快捷键**：Windows 与 Linux 均以 `Ctrl` 为主修饰键。

## 提交规范（Pull Request）

1. 从最新的 `main` 分支切出你的特性分支。
2. 保持改动聚焦；新增/修改功能请同步更新 `README.md` 与（如涉及版本发布的）`CHANGELOG.md`。
3. 提交前请自检：
   - `node --check` 通过（无语法错误）；
   - 尽量在 Windows 与 Linux 上分别验证受影响的流程（尤其是路径、导出、字体相关改动）。
4. 提交信息建议清晰描述「做了什么、为什么」。
5. 发起 PR 时说明改动动机、影响范围与测试情况。

## 许可

本项目采用 [MIT 许可证](./LICENSE)。你提交的贡献将同样以 MIT 许可证授权。
