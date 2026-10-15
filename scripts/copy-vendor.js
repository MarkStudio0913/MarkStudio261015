// 将 vditor 的 dist 资源复制到 vendor/，保证应用完全离线可用
// R41：
// 1) 复制后裁剪按需资源包（mathjax/mermaid/graphviz 等约 15MB，应用未启用对应渲染器，
//    用户文档也无此类代码块；保留 lute 核心引擎/icons/i18n/katex/highlight.js）
// 2) 保护 vendor/vditor/dist/index.js 中的 MarkStudio 补丁（R39/R40 vendor 修改）：
//    重新复制会覆盖为官方原版，脚本先备份含补丁的版本、复制后还原
const fs = require('fs');
const path = require('path');

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

const from = path.join(__dirname, '..', 'node_modules', 'vditor', 'dist');
const to = path.join(__dirname, '..', 'vendor', 'vditor', 'dist');

// 裁剪清单：仅保留应用实际加载的资源（lute 引擎、icons、i18n、katex、highlight.js 样式/语言包）
const PRUNE = [
  'js/mathjax', 'js/mermaid', 'js/graphviz', 'js/echarts', 'js/markmap',
  'js/abcjs', 'js/smiles-drawer', 'js/flowchart.js', 'js/wavedrom', 'js/plantuml',
  // index.html 直接加载带补丁的 index.js（单一事实源），官方 min 版不再使用（R39 起）
  'index.min.js',
  // 源码/类型/备用入口，运行时不需要
  'ts', 'types', 'method.js', 'method.min.js', 'method.d.ts', 'index.d.ts',
  // emoji 图片：应用未启用 emoji 功能（工具栏无 emoji、改用彩色图标），且其中含
  // octocat / trollface / doge 等第三方商标与版权图，不再随本项目分发
  'images/emoji'
];

if (fs.existsSync(from)) {
  // 备份含 MarkStudio 补丁的 index.js（存在且含补丁标记时）
  const patchedIndex = path.join(to, 'index.js');
  let patchedContent = null;
  if (fs.existsSync(patchedIndex)) {
    const cur = fs.readFileSync(patchedIndex, 'utf8');
    if (cur.includes('MarkStudio R39')) patchedContent = cur;
  }

  // 保留 MarkStudio 补充的许可证文件（如 vendor/vditor/dist/js/katex/LICENSE，
  // MIT 全文；vendor/vditor/dist/js/lute/LICENSE，MulanPSL-2 全文）——npm 官方包里没有它们，
  // 整体重建 dist 前必须先备份、之后还原
  const licenseBackups = [];
  (function collectLicenses(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collectLicenses(p);
      else if (/^(LICENSE|COPYING|NOTICE)(\..+)?$/i.test(entry.name)) {
        licenseBackups.push({ rel: path.relative(to, p), content: fs.readFileSync(p) });
      }
    }
  })(to);

  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
  copyRecursive(from, to);

  for (const rel of PRUNE) {
    const p = path.join(to, rel);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  for (const b of licenseBackups) {
    const p = path.join(to, b.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, b.content);
  }

  if (patchedContent !== null) {
    fs.writeFileSync(patchedIndex, patchedContent, 'utf8');
    console.log('[copy-vendor] 已还原 MarkStudio 补丁版 index.js');
  } else {
    console.log('[copy-vendor] 警告：vendor index.js 无 MarkStudio 补丁标记（R39/R40 vendor 修复缺失），需重新打补丁');
  }
  console.log('[copy-vendor] vditor dist -> vendor/vditor/dist 完成（已裁剪 ' + PRUNE.length + ' 项）');
} else {
  console.log('[copy-vendor] 未找到 vditor dist，跳过');
}
