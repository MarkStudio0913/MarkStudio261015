; MarkStudio R68：安装界面 iOS 毛玻璃品牌化（Liquid Glass）
; 欢迎/卸载欢迎页背景图走 electron-builder 官方选项（installerSidebar/uninstallerSidebar，
; 以 /D 注入，脚本内不可重定义）；其余 MUI 宏 MUI2 无默认值，可直接定义。
; 本 include 被插入生成脚本头部（页面生成之前），定义对页面生效。
!define MUI_WELCOMEFINISHPAGE_TITLE "Install MarkStudio"
!define MUI_WELCOMEFINISHPAGE_SUBTITLE "Simple and elegant WYSIWYG Markdown editor"
!define MUI_UNWELCOMEPAGE_TITLE "Uninstall MarkStudio"
!define MUI_UNWELCOMEPAGE_SUBTITLE "Removes the program and its shortcuts. Your documents are kept."

; 完成页背景（MUI_FINISHPAGE_BITMAP 无 /D 注入，可脚本内定义）。
; 使用相对路径 build\installer-bg.bmp（以 NSIS 编译工作目录为基准，即项目根目录）；
; 若构建环境工作目录不同导致找不到文件，则跳过该定义，回退默认完成页（不阻断构建）。
!if /FileExists "build\installer-bg.bmp"
  !define MUI_FINISHPAGE_BITMAP "build\installer-bg.bmp"
!endif

; iOS 蓝强调色（页面顶栏 / 按钮）
!define MUI_ACCENT_COLOR ${0x007aff}
