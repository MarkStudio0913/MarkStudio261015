/* MarkStudio 渲染层主逻辑 */
'use strict';

const el = (s) => document.querySelector(s);
const els = (s) => Array.from(document.querySelectorAll(s));

const state = {
  vditor: null,
  editorReady: false,
  docPath: null,
  dirty: false,
  eol: '\n',
  hadBom: false,
  encoding: 'UTF-8',
  folder: null,
  sourceMode: false,
  settings: null,
  cdnUrl: '',
  treeOpen: new Set(),
  outlineClosed: new Set(),
  outline: [],
  outlineActiveIdx: -1, // R78-2：当前高亮的大纲章节索引（-1=无），随正文选中/光标联动
  showLines: true,
  findState: { idx: -1, total: 0, matches: [] },
  lastLink: null,
  smokeDone: false,
  // R57：编辑器 DOM 是否有「尚未同步进 tab.content 的用户编辑」。
  // 原生 input 事件置脏；Vditor 的 input 回调（停顿 800ms 后的整篇 md 同步）置净。
  // 表格结构操作用它选择快速路径（tab.content 字符串手术，免整篇 WASM 转换 ~0.9s）
  editorDomDirty: false,
  // 多标签：每个标签保存内容快照与视图位置，切换时整体换入/换出
  tabs: [],
  activeTab: null,
  recent: [],
  // R75-4b：全屏状态（视图菜单据此在「全屏」/「退出全屏」之间切换，同一时间只出现一个）
  isFullScreen: false,
  // R75-9：专注模式是否已应用到 DOM（CSS 淡化非当前块，免重建编辑器）
  focusApplied: false,
  // R75-2：最近打开的文件夹（文件→最近文件夹 子菜单用）
  recentFolders: []
};
let tabSeq = 0;

// ---------------------------------------------------------------- 工具
function dirOf(p) { return p ? p.replace(/[/\\][^/\\]*$/, '') : null; }
function baseName(p) { return p ? p.replace(/^.*[/\\]/, '') : t('name.untitled'); }
// 保存对话框默认文件名：先剥掉已有的 md/markdown/txt 扩展名再补 .md，
// 保证标签名无论是否已带扩展名，对话框里都恰好是一个 .md（不会出现 x.md.md）
function mdSuggestName(n) {
  const base = String(n || t('name.untitled')).replace(/\.(md|markdown|txt)$/i, '');
  return (base || t('name.untitled')) + '.md';
}

// 平台判定（preload 暴露 ms.platform）：Windows 用反斜杠磁盘路径，Linux 等 POSIX 系统用正斜杠
const IS_WIN = (typeof ms !== 'undefined' && ms.platform === 'win32');
const PATH_SEP = IS_WIN ? '\\' : '/';

// 磁盘绝对路径 → file:// URL（跨平台：Windows 补前导斜杠成 file:///C:/…，POSIX 为 file:///home/…）
function fileUrlOf(absPath) {
  const norm = String(absPath).replace(/\\/g, '/');
  const lead = norm.startsWith('/') ? norm : '/' + norm;
  return 'file://' + encodeURI(lead).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

// file:// URL → 磁盘绝对路径（跨平台）：Windows 还原盘符+反斜杠；POSIX 保留前导斜杠+正斜杠
function diskPathFromUrl(url) {
  let p = String(url).replace(/^file:\/\/\/?/i, '');
  try { p = decodeURIComponent(p); } catch (e) { }
  if (IS_WIN) return p.replace(/^\/(?=[A-Za-z]:)/, '').replace(/\//g, '\\');
  return p.startsWith('/') ? p : '/' + p;
}

// 把 markdown 里的相对/绝对图片路径解析为本地绝对路径（跨平台）
function resolveLocalPath(src) {
  if (!src) return null;
  let s = src;
  if (/^(https?|data|blob):/i.test(s)) return null;
  if (/^file:\/\//i.test(s)) return diskPathFromUrl(s);
  try { s = decodeURIComponent(s); } catch (e) { }
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/[\\/]/g, PATH_SEP); // Windows 绝对路径
  if (s.startsWith('/')) return IS_WIN ? s.replace(/\//g, '\\') : s;    // POSIX 绝对路径
  const dir = dirOf(state.docPath);
  if (!dir) return null;
  const joined = dir.replace(/\\/g, '/') + '/' + s.replace(/^\.\//, '');
  return IS_WIN ? joined.replace(/\//g, '\\') : joined;
}

function toast(msg, ms = 2200) {
  const t = el('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function countStats(text) {
  const cjk = (text.match(/[\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const latin = (text.replace(/[\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ').match(/[A-Za-z0-9_']+/g) || []).length;
  return { words: cjk + latin, chars: text.length };
}

function resolveContentTheme() {
  const s = state.settings;
  const valid = ['light', 'dark', 'ant-design', 'wechat'];
  const ct = s && s.contentTheme;
  if (ct && valid.indexOf(ct) !== -1) return ct;
  // auto 或非法/旧值 → 跟随界面主题
  return (s && s.theme === 'dark') ? 'dark' : 'light';
}
function resolveHlStyle() {
  return state.settings && state.settings.theme === 'dark' ? 'github-dark' : 'github';
}

// ---------------------------------------------------------------- 编辑器
function ensureEditor() {
  if (state.vditor) return Promise.resolve();
  return new Promise((resolve) => {
    const s = state.settings;
    state.vditor = new Vditor('editor', {
      cdn: state.cdnUrl,
      mode: 'ir',
      theme: s.theme === 'dark' ? 'dark' : 'light',
      lang: (window.i18nLang() === 'en-US') ? 'en_US' : 'zh_CN',
      value: '',
      height: '100%',
      placeholder: t('vditor.placeholder'),
      toolbar: ['headings', 'bold', 'italic', 'strike', 'list', 'ordered-list', 'check', 'quote', 'line', 'code', 'inline-code', 'link', 'table', 'undo', 'redo'],
      typewriterMode: !!s.typewriter,
      focusMode: !!s.focusMode,
      counter: { enable: false },
      cache: { enable: false },
      // 接管 IR 链接点击：不设此项时 Vditor 默认 window.open(链接)，会弹出新窗口
      link: { click: onVditorLinkClick },
      undoDelay: 300,
      // R39：整篇 md 转换（Lute WASM，大文档约 0.5s）推迟到停顿 800ms 后执行，
      // 击键本身不再触发整篇解析；undo 栈仍按 undoDelay 短延迟更新（见 vendor 补丁）
      mdSyncDelay: 800,
      preview: {
        maxWidth: 860,
        theme: { current: resolveContentTheme() },
        hljs: { enable: true, style: resolveHlStyle(), lineNumber: s.codeLineNumbers !== false },
        math: { inlineDigit: true }
      },
      after: () => {
        state.editorReady = true;
        bindEditorEvents();
        // R75-9：重建后按当前设置恢复专注模式的高亮类
        applyFocusMode();
        // 等 Vditor 完成首次布局后再定位行号栏（此时 #editor 宽度已定）
        setTimeout(() => { applyWrap(); layoutLineGutter(); }, 60);
        resolve();
      },
      input: (value) => {
        // Vditor 仅在用户实际编辑时触发本回调（setValue 等程序化改动带 enableInput:false 守卫），
        // 因此这里必须标记未保存。回调自带最新内容，直接透传，避免再整篇 getValue 解析（大文件性能）
        state.editorDomDirty = false; // R57：整篇 md 已同步回 tab.content，DOM 基线恢复干净
        const t = activeTab();
        if (t) {
          t.content = value;
          // R40：本回调被推迟到停顿 800ms 后（整篇 md 转换耗时）。若内容与最近一次保存
          // 完全一致（打字后 800ms 内已保存，或撤销回保存状态），视为干净，
          // 避免「刚保存完又亮起未保存点」的假象
          if (value.replace(/\r\n/g, '\n') === (t.savedContent || '').replace(/\r\n/g, '\n')) {
            setDirty(false);
          } else {
            onDocChanged(true, value);
          }
        } else {
          onDocChanged(true, value);
        }
        scheduleOutline(value);
        refreshLinesSoon();
        fixImagesSoon();
        refreshToolbarState();
      }
    });
  });
}

// IR 模式下链接不是 <a>，而是 span[data-type="a"]，href 以标记文本形式存在（[文字](href)）
function parseIrLinkHref(span) {
  const t = span.textContent || '';
  const m = /\]\(([^)]*)\)\s*$/.exec(t);
  return m ? m[1].trim() : '';
}

// 链接统一处理（DOM 点击 与 Vditor link.click 回调 共用，150ms 内相同链接只处理一次）
let lastLinkAt = 0, lastLinkRaw = '';
function handleLinkHref(raw) {
  const now = Date.now();
  if (raw === lastLinkRaw && now - lastLinkAt < 150) return;
  lastLinkAt = now; lastLinkRaw = raw;
  state.lastLink = raw;
  // 页内锚点（目录/文内跳转）：立即跳到本文档对应标题，不打开新窗口/新标签
  if (raw.startsWith('#')) {
    scrollToHeadingInDoc(raw.slice(1));
    return;
  }
  if (/^https?:\/\//i.test(raw)) { try { ms.invoke('shell:open-external', { url: raw }); } catch (e) { } return; }
  if (/\.md$|\.markdown$/i.test(raw.split('#')[0])) {
    const abs = resolveLocalPath(raw.split('#')[0]);
    if (abs) openPath(abs);
  }
}
// Vditor options.link.click 回调：IR 模式传入 .vditor-ir__marker--link 标记 span，SWM 传入 <a>
function onVditorLinkClick(target) {
  if (!target || !target.closest) return;
  const a = target.closest('a');
  const ir = a ? null : target.closest('span[data-type="a"]');
  const raw = a ? (a.getAttribute('href') || '') : (ir ? parseIrLinkHref(ir) : '');
  if (raw) handleLinkHref(raw);
}

let editorRootBound = false;
// #editor 元素在 recreateEditor 中持久存在（Vditor 只重建其内部节点，元素本身不换）→
// 「挂在 #editor 上」的监听与整棵子树的 MutationObserver 只能绑定一次：否则每次主题/语言/
// 打字机/代码块行号切换触发重建都会再挂一遍，监听与观察器逐次叠加并持续泄漏内存。
function bindEditorEvents() {
  const root = el('#editor');
  if (!editorRootBound) {
    editorRootBound = true;
    // 链接点击：接管默认跳转（兼容 <a> 与 IR 标记链接）。
    // 注意：Vditor 自身的 IR 链接处理器也会调用 options.link.click 回调，
    // 二者会先后触发，handleLinkHref 内置 150ms 去重防止重复打开。
    root.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      const irLink = !a && e.target.closest ? e.target.closest('span[data-type="a"]') : null;
      if (!a && !irLink) return;
      const raw = a ? (a.getAttribute('href') || '') : parseIrLinkHref(irLink);
      if (!raw) return;
      e.preventDefault();
      handleLinkHref(raw);
    });
    // 图片地址修正观察器
    const mo = new MutationObserver(() => { fixImageSrcNow(); fixImagesSoon(); }); // R82-3：同步修正图片 src，消除可见破图闪烁
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    // R57：用户键入/删除/IME 的原生 input 事件 = DOM 领先于 tab.content（Vditor 的
    // md 同步回调要等停顿 800ms 才到）→ 置脏，表格结构操作据此走「整篇 getValue」慢路径
    root.addEventListener('input', () => { state.editorDomDirty = true; });
  }
  // R59：undo/redo 直接整篇替换 DOM（无原生 input 事件），而 Vditor 的 md 同步回调
  // 要等 800ms 停顿才落回 tab.content——这段时间 tab.content 还是撤销/重做前的文本。
  // 若不置脏，紧接着的表格结构操作会用陈旧基线（editorMdBaseline 的快速路径），
  // 把刚撤销的改动悄悄恢复回去。所有 undo/redo 都必经这两个方法（工具条按钮点击、
  // 快捷键最终都是点工具条按钮）→ 包一层即可全捕获
  try {
    const u = state.vditor.vditor && state.vditor.vditor.undo;
    if (u && !u.__msUndoDirtyMarked) {
      const _undo = u.undo.bind(u);
      const _redo = u.redo.bind(u);
      // R60：undo/redo 的 renderDiff 同步整篇替换 DOM 后，表格是全新节点（内联列宽丢失）
      // 且无原生 input 事件 → 立即重放布局+主动钉列（内部顺带清扫孤儿覆盖层）
      u.undo = (vv) => { const r = _undo(vv); state.editorDomDirty = true; try { if (!state.sourceMode) reapplyTableLayout(true); } catch (e) { } return r; };
      u.redo = (vv) => { const r = _redo(vv); state.editorDomDirty = true; try { if (!state.sourceMode) reapplyTableLayout(true); } catch (e) { } return r; };
      u.__msUndoDirtyMarked = true;
    }
  } catch (e) { }
}

// 标题文本归一化：去掉 markdown 锚点/标题标记里常见的标点/空白，便于宽松匹配
function normHeadingKey(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[#\s\-—_·•.。:：,，!！?？()（）\[\]【】"'`~|\\/]/g, '');
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 页内锚点跳转：在正文渲染区内定位标题并平滑滚动（目录链接、文内 [x](#y) 引用）
function scrollToHeadingInDoc(anchor) {
  // 真正的滚动容器是 .vditor-ir .vditor-reset（与行号栏同步逻辑一致），不是 .vditor-ir
  const cont = getScrollContainer();
  if (!cont) return;
  const root = el('#editor');
  let dec = anchor;
  try { dec = decodeURIComponent(anchor); } catch (e) { }
  const heads = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  let target = null;
  // 1) 精确 id（含 Vditor 的 vditorAnchor- 前缀方案）
  for (const id of [anchor, dec, 'vditorAnchor-' + anchor, 'vditorAnchor-' + dec]) {
    if (!id) continue;
    target = document.getElementById(id) || root.querySelector('#' + CSS.escape(id));
    if (target) break;
  }
  // 2) Vditor IR 标题 id 方案：ir-<slug>_<n>（前缀匹配，兼容编码差异）
  if (!target) {
    for (const cand of [anchor, dec]) {
      if (!cand) continue;
      const re = new RegExp('^ir-' + escapeRegExp(cand) + '(_\\d+)?$');
      const hit = heads.find((h) => re.test(h.id || ''));
      if (hit) { target = hit; break; }
    }
  }
  // 3) 标题文本宽松匹配（id 规则与锚点不一致时兜底）
  if (!target) {
    const key = normHeadingKey(dec);
    if (key) target = heads.find((h) => normHeadingKey(h.textContent) === key) || null;
  }
  if (!target) { toast(t('toast.headingNotFound', { dec })); return; }
  const top = target.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop - 12;
  // 立即跳转（不平滑滚动）
  cont.scrollTop = Math.max(0, top);
  syncLineGutter();
}

// R82-3：图片 src「本地相对路径 → 绝对 file://」的同步修正。VDitor 渲染时先把 <img src> 设为相对路径，浏览器会
// 相对页面 base（app.asar 内 index.html）去加载（该路径不存在）；旧逻辑靠 60ms 防抖的 fixImagesSoon 才改对、期间
// 图片一闪而破图。现改为在 MutationObserver 里同步（微任务、先于首帧绘制）改对 src，消除可见破图闪烁。注：初始
// 坏 src 的加载已被浏览器触发，控制台仍会记一条瞬时 ERR_FILE_NOT_FOUND（图片随后正常显示）；要彻底消除需在渲染
// 前改写 markdown 图片路径（会污染 getValue / 落盘相对路径），权衡后不采用。
let _fixImgReenter = false;
function fixImageSrcNow() {
  if (_fixImgReenter) return;
  _fixImgReenter = true;
  try {
    els('.vditor-ir .vditor-reset img').forEach((img) => {
      if (img.dataset.fixed === '1') return;
      const src = img.getAttribute('src') || '';
      if (!src || /^(https?|data|blob):/i.test(src)) { img.dataset.fixed = '1'; return; }
      const abs = resolveLocalPath(src);
      if (abs) { img.src = fileUrlOf(abs); img.dataset.mssrc = src; } // R75-4a：记住 markdown 原路径，供缩放/裁剪回写
      img.dataset.fixed = '1';
    });
  } finally { _fixImgReenter = false; }
}
function fixImagesSoon() {
  clearTimeout(fixImagesSoon._t);
  fixImagesSoon._t = setTimeout(() => {
    fixImageSrcNow();
    resyncImageSizes(); // R75-4a：把 markdown 里的 {=WxH} 尺寸标注同步到 <img> 实际显示尺寸
  }, 60);
}

// R75-4a：本 Vditor 版本不渲染 in-paren 的 =WxH 尺寸（会退化成纯文本），改用花括号
// 语法 ![alt](src){=WxH}——VDitor 能正常渲染图片且 getValue 原样回读，作为可持久化的
// 尺寸标注载体；真正的显示尺寸由这里用 style 落到 <img> 上（每次渲染后重放）。
function resyncImageSizes() {
  if (!el('.vditor-ir .vditor-reset')) return;
  const md = state.vditor ? state.vditor.getValue() : '';
  const ann = {}; // src -> [{w,h}]（按 md 出现顺序）
  const re = /!\[[^\]]*\]\(([^)]*)\)\s*\{\s*=\s*(\d+)x(\d+)\s*\}/g;
  let m;
  while ((m = re.exec(md))) {
    const src = m[1].trim().split(/\s+/)[0];
    (ann[src] = ann[src] || []).push({ w: +m[2], h: +m[3] });
  }
  const seen = {};
  els('.vditor-ir .vditor-reset img').forEach((img) => {
    const src = img.dataset.mssrc;
    let a = null;
    if (src && ann[src]) { const i = seen[src] || 0; seen[src] = i + 1; a = ann[src][i] || null; }
    if (a && a.w > 0) { img.style.width = a.w + 'px'; img.style.height = a.h + 'px'; img.dataset.mssz = a.w + 'x' + a.h; }
    else { img.style.width = ''; img.style.height = ''; img.dataset.mssz = ''; }
  });
}

function getCurrentContent() {
  // R90：阅读模式标签不可编辑，内容恒为载入时的全文（也避免 getValue 触发整篇同步）
  if (isReader()) { const t = activeTab(); return t ? (t.content || '') : ''; }
  return state.sourceMode ? el('#source').value : (state.vditor ? state.vditor.getValue() : '');
}

function setContent(content) {
  if (state.sourceMode) {
    el('#source').value = content;
  } else if (state.vditor) {
    state.vditor.setValue(content);
    applyCvl(content ? content.length : 0);
    fixImagesSoon();
  }
}

// 超大文件：给滚动容器加 .cvl，屏外块跳过布局/绘制（content-visibility），
// 显著降低打开与上下滚动的开销（CSS 见 style.css 中 .vditor-reset.cvl 规则）
const CVL_THRESHOLD = 400000;
function applyCvl(len) {
  const resetEl = el('.vditor-ir .vditor-reset');
  if (resetEl) resetEl.classList.toggle('cvl', (len || 0) >= CVL_THRESHOLD);
}

// ---------------------------------------------------------------- R90 超大文件快速阅读模式
// 文件超过 READER_THRESHOLD 时不再整篇进 Vditor IR（实测 13MB/22 万行/800 万字符文档会把
// 主线程卡死 5 分钟以上仍无响应），改用只读「分块虚拟渲染」：md 按安全边界切成小块，
// 视口附近的块即时 Lute.Md2HTML + KaTeX 渲染，远离视口的块卸载回收，DOM 里只留定高占位盒。

const READER_THRESHOLD = 1000000;   // chars（JS length）；超过 → 快速阅读模式
const READER_CHUNK_TARGET = 16000;  // 分块目标大小（chars）
const READER_CHUNK_MAX = 131072;    // 单块硬上限（找不到安全边界时强切）
const READER_KEEP_RANGE = 6;        // 视口外保留已渲染块的数目（超出卸载）
const READER_OUTLINE_CAP = 4000;    // 大纲行数上限（1.6 万标题的文档全渲染侧栏会卡）
const EDITOR_ESCAPE_MAX = 3000000;  // R92：整篇进 IR 的体量上限——再大会耗尽内存致渲染进程崩溃（窗口全白=顶栏"消失"）

function isReader() { const t = activeTab(); return !!(t && t.reader); }

// 按行扫描切分：绝不在围栏代码块 / $$ 块级公式 / 表格行中间切；
// 优先在「下一行是空行 / 标题 / 分割线」或当前行是空行的块边界切，找不到才强切
function splitReaderChunks(text) {
  const lines = text.split('\n');
  const chunks = [];
  let inFence = false, fenceCh = '', inMath = false, prevTable = false;
  let fenceStart = -1, mathStart = -1;
  let start = 0, off = 0, size = 0, ln = 0;
  const push = (end) => {
    chunks.push({ s: start, e: end, h: 0, est: Math.min(120000, Math.max(120, ln * 28 + 40)), done: false, el: null });
    start = end; size = 0; ln = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!inFence) { inFence = true; fenceCh = f[1][0]; fenceStart = i; } else if (f[1][0] === fenceCh) { inFence = false; fenceStart = -1; } }
    else if (!inFence) {
      const dd = (l.match(/\$\$/g) || []).length;
      if (dd % 2 === 1) { inMath = !inMath; mathStart = inMath ? i : -1; } // 奇数个 $$ → 进入/离开块级公式（$$x$$ 单行形式成对不自切换）
    }
    // R90.1：失衡保护——真实代码块/公式不会连绵数百行，围栏/公式超长未闭合说明源文档
    // 围栏标记失衡（实测超长真实文档存在未闭合围栏，会把后续 20 万行全当成"块内"，
    // 分块只剩 128KB 硬切、大纲解析也全部失灵），到阈值即视为闭合恢复普通分块
    if (inFence && fenceStart >= 0 && i - fenceStart > 300) { inFence = false; fenceStart = -1; }
    if (inMath && mathStart >= 0 && i - mathStart > 200) { inMath = false; mathStart = -1; }
    const tl = !inFence && !inMath && /^\s*\|/.test(l);
    const nx = i + 1 < lines.length ? lines[i + 1] : '';
    const boundarySafe = !inFence && !inMath && !tl &&
      (nx.trim() === '' || /^\s*(#{1,6}\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(nx) || l.trim() === '');
    size += l.length + 1;
    ln++;
    if ((size >= READER_CHUNK_TARGET && boundarySafe) || size >= READER_CHUNK_MAX) push(off + l.length + 1);
    off += l.length + 1;
    prevTable = tl;
  }
  if (start < text.length) push(text.length);
  return chunks;
}

// 数学公式占位：Lute 默认渲染器不认公式（$$/$ 输出乱码），先把块级 $$…$$ 与行内 $…$
// 替换为纯文本 token，Md2HTML 出 HTML 后再换回 KaTeX 渲染结果。围栏代码块内不动。
function readerMaskMath(src) {
  const toks = {}; let seq = 0;
  const lines = src.split('\n');
  const out = [];
  let inFence = false, fenceCh = '';
  const mk = (tex, display) => { const id = 'zz' + (display ? 'd' : 'i') + 'mth' + (seq++) + 'zz'; toks[id] = { tex, display }; return id; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!inFence) { inFence = true; fenceCh = f[1][0]; } else if (f[1][0] === fenceCh) inFence = false; out.push(l); continue; }
    if (inFence) { out.push(l); continue; }
    // 块级公式：$$ 独占一行开 / 闭
    if (/^\s*\$\$\s*$/.test(l)) {
      let j = i + 1; const buf = [];
      while (j < lines.length && !/^\s*\$\$\s*$/.test(lines[j])) { buf.push(lines[j]); j++; }
      if (j < lines.length) { out.push(mk(buf.join('\n'), true)); i = j; continue; }
    }
    // 单行 $$...$$
    const one = l.match(/^\s*\$\$(.+)\$\$\s*$/);
    if (one && one[1].indexOf('$$') === -1) { out.push(mk(one[1].trim(), true)); continue; }
    // 行内 $...$：先屏蔽行内代码 span（其中的 $ 不当公式），提取后再还原
    const codes = [];
    let s = l.replace(/`[^`]*`/g, (m) => { codes.push(m); return 'zzcd' + (codes.length - 1) + 'zz'; });
    s = s.replace(/\$(?!\s)((?:\\.|[^$\n])+?)\$(?![\d$])/g, (m, tex) => {
      if (!tex || /^\s|\s$/.test(tex)) return m;
      return ' ' + mk(tex, false) + ' ';
    });
    // R94：单个 ~ 转义为 \~——中文技术文档里 0~7 / 31~81 是数值范围，而 GFM 会把同段
    // 两个单 ~ 配对成删除线（用户实测截图）。~~对~~ 原样保留（真删除线仍可用）；lute 对
    // \~ 渲染为字面 ~（实测通过）。此时代码 span 与公式均已屏蔽为 token、围栏内容在
    // 上方 inFence 分支原样输出，均不受影响
    s = s.replace(/~+/g, (m) => m.length === 2 ? m : m.replace(/~/g, '\\~'));
    s = s.replace(/zzcd(\d+)zz/g, (m, k) => codes[+k] !== undefined ? codes[+k] : m);
    out.push(s);
  }
  return { text: out.join('\n'), toks };
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readerKatex(tex, display) {
  try {
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
  } catch (e) {
    return '<code class="ms-math-err">' + escHtml(tex) + '</code>';
  }
}

function readerLute() { return readerLute._i || (readerLute._i = Lute.New()); }

// R93：把块顶对齐到滚动容器顶——纯内层滚动器数学，**禁止 scrollIntoView**
//（scrollIntoView 会沿祖先链一路对齐，连 overflow:hidden 的 body 也被程序化滚动：
//  阅读内容让 body.scrollHeight 变成几十万 px，body 被滚 ~116px 后自绘顶栏整体
//  被顶出窗口 = 用户看到的「菜单栏/标题栏/任务栏消失」；点靠前章节 body 复位=「恢复」）
function readerScrollChunkIntoView(ck) {
  const sc = el('#reader-scroll'); if (!sc || !ck || !ck.el) return;
  const top = ck.el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTop = Math.max(0, top);
}

// R93：兜底复位页面级滚动（任何残留都立即归零，顶栏永不移位）
function readerPinPageScroll() {
  if (document.body.scrollTop) document.body.scrollTop = 0;
  if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
}

// R91：跳转前预渲染目标块前后各 2 块——否则最终定位滚动触发的渲染会把上方占位块
// 变成真实高度（估算偏高时收缩 ~70px），标题刚对准就又被推离视口
function readerRenderAround(ci) {
  const tab = activeTab(); if (!tab || !tab.readerChunks) return;
  const C = tab.readerChunks;
  for (let j = ci - 2; j <= ci + 2; j++) {
    if (C[j]) readerRenderChunk(j);
  }
}

function readerMeasure(i) {
  const tab = activeTab(); const C = tab && tab.readerChunks; const ck = C && C[i];
  if (!ck || !ck.el) return;
  const h = ck.el.getBoundingClientRect().height;
  if (h > 0 && Math.abs(h - ck.h) > 0.5) { ck.h = h; C._sumsDirty = true; }
}

function readerRenderChunk(i) {
  const tab = activeTab(); if (!tab || !tab.readerChunks) return;
  const C = tab.readerChunks, ck = C[i];
  if (!ck || ck.done) return;
  const raw = tab.content.slice(ck.s, ck.e);
  let html;
  try {
    const { text: masked, toks } = readerMaskMath(raw);
    html = readerLute().Md2HTML(masked);
    for (const id in toks) {
      const rendered = readerKatex(toks[id].tex, toks[id].display);
      html = html.split('<p>' + id + '</p>').join(rendered); // 块级公式独立成段 → 整段替换
      html = html.split(id).join(rendered);
    }
  } catch (e) {
    html = '<pre>' + escHtml(raw) + '</pre>';
  }
  ck.el.style.height = ''; // 渲染后高度自适应，实测值记入 ck.h 供前缀和/卸载占位用
  ck.el.innerHTML = html;
  ck.done = true;
  // 相对路径图片 → 绝对 file://（复用全局解析逻辑）；加载完成会改变块高，重测一次
  const imgs = ck.el.querySelectorAll('img');
  for (let k = 0; k < imgs.length; k++) {
    const img = imgs[k];
    const src = img.getAttribute('src') || '';
    if (src && !/^(https?|data|blob):/i.test(src)) {
      const abs = resolveLocalPath(src);
      if (abs) img.src = fileUrlOf(abs);
    }
    if (k < 64) img.addEventListener('load', () => readerMeasure(i), { once: true });
  }
  readerMeasure(i);
}

function readerUnrenderChunk(i) {
  const tab = activeTab(); if (!tab || !tab.readerChunks) return;
  const C = tab.readerChunks, ck = C[i];
  if (!ck || !ck.done) return;
  const h = ck.el.getBoundingClientRect().height;
  if (h > 0) ck.h = h;
  ck.el.innerHTML = '';
  ck.el.style.height = (ck.h || ck.est || 800) + 'px';
  ck.done = false;
  C._sumsDirty = true;
}

function readerSums(C) {
  if (!C._sums || C._sumsDirty) {
    const s = new Array(C.length); let acc = 0;
    for (let i = 0; i < C.length; i++) { acc += (C[i].h || C[i].est || 800); s[i] = acc; }
    C._sums = s; C._total = acc; C._sumsDirty = false;
  }
  return C._sums;
}

function readerBuildDom(tab) {
  const body = el('#reader-body');
  if (!body) return;
  body.innerHTML = '';
  const C = tab.readerChunks;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < C.length; i++) {
    const d = document.createElement('div');
    d.className = 'rchunk';
    d.dataset.i = i;
    d.style.height = (C[i].h || C[i].est || 800) + 'px';
    C[i].el = d;
    frag.appendChild(d);
  }
  body.appendChild(frag);
  C._sumsDirty = true;
}

// 视口内外的块渲染 / 回收：±2 块预渲染，视口外 READER_KEEP_RANGE 块之外卸载
function readerRenderVisible() {
  const tab = activeTab(); if (!tab || !tab.reader || !tab.readerChunks) return;
  const C = tab.readerChunks;
  const sc = el('#reader-scroll'); if (!sc) return;
  const sums = readerSums(C);
  if (!sums.length) return;
  const st = sc.scrollTop, vh = Math.max(200, sc.clientHeight);
  let lo = 0, hi = sums.length - 1, a = sums.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sums[m] > st) { a = m; hi = m - 1; } else lo = m + 1; }
  let b = a + 1;
  while (b < sums.length && sums[b - 1] < st + vh) b++;
  for (let i = Math.max(0, a - 2); i < Math.min(C.length, b + 2); i++) readerRenderChunk(i);
  for (let i = 0; i < C.length; i++) {
    if (!C[i].done) continue;
    if (i < a - READER_KEEP_RANGE || i >= b + READER_KEEP_RANGE) readerUnrenderChunk(i);
  }
}

function readerScheduleRender() {
  if (readerScheduleRender._raf) return;
  readerScheduleRender._raf = requestAnimationFrame(() => { readerScheduleRender._raf = 0; readerRenderVisible(); });
}

let readerTabId = null;

function enterReaderMode(tab) {
  if (!tab.readerChunks || tab.readerChunksSrcLen !== tab.content.length) {
    tab.readerChunks = splitReaderChunks(tab.content);
    tab.readerChunksSrcLen = tab.content.length;
  }
  readerTabId = tab.id;
  readerBuildDom(tab);
  const ed = el('#editor'); if (ed) ed.classList.add('hidden');
  const ta = el('#source'); if (ta) ta.classList.add('hidden');
  const rd = el('#reader'); if (rd) rd.classList.remove('hidden');
  const g = el('#line-gutter'); if (g) g.classList.add('hidden');
  const fbar = el('#fbar'); if (fbar) fbar.classList.add('reader-mode');
  document.body.classList.add('ms-reader');
  const mb = tab.content.length / 1048576;
  const sz = el('#reader-size');
  if (sz) sz.textContent = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(tab.content.length / 1024) + ' KB';
  requestAnimationFrame(() => {
    const sc = el('#reader-scroll');
    if (sc) sc.scrollTop = tab.readerScrollTop || 0;
    readerRenderVisible();
  });
}

// 离开阅读模式（切到其他标签 / 该标签转编辑模式）：清 DOM 释放内存，重置块渲染状态
function readerTeardown(tab) {
  readerTabId = null;
  const body = el('#reader-body'); if (body) body.innerHTML = '';
  const rd = el('#reader'); if (rd) rd.classList.add('hidden');
  const g = el('#line-gutter'); if (g) g.classList.remove('hidden');
  const fbar = el('#fbar'); if (fbar) fbar.classList.remove('reader-mode');
  document.body.classList.remove('ms-reader');
  if (!tab || !tab.readerChunks) return;
  const C = tab.readerChunks;
  for (let i = 0; i < C.length; i++) { C[i].done = false; C[i].el = null; }
  C._sums = null; C._sumsDirty = true;
}

// 滚动到指定字符偏移（查找命中用）：二分定位块 → 按元素真实布局位置滚动 → 高亮
// R91：占位块高度是估算值，前缀和会有累积误差——滚动基准必须是 chunk 元素的真实布局位置
//（scrollIntoView 与估算无关、天然精确），再在块内按文本精确定位命中处居中
function readerRevealMatch(off, len) {
  const tab = activeTab(); if (!tab || !tab.readerChunks) return;
  const C = tab.readerChunks;
  let lo = 0, hi = C.length - 1, ci = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (C[m].s <= off) { ci = m; lo = m + 1; } else hi = m - 1; }
  const ck = C[ci];
  const sc = el('#reader-scroll'); if (!sc || !ck.el) return;
  readerScrollChunkIntoView(ck);
  readerRenderAround(ci);
  requestAnimationFrame(() => {
    const hit = readerHighlightIn(ck, off - ck.s, len, tab);
    if (hit) {
      // R93：命中处垂直居中——内层滚动器数学（不用 scrollIntoView，防祖先链滚动）
      const r = hit.getBoundingClientRect();
      sc.scrollTop += (r.top + r.height / 2) - (sc.getBoundingClientRect().top + sc.clientHeight / 2);
    } else {
      // 兜底：块内按字符比例推进（用实测块高，不再用估算）
      const frac = (off - ck.s) / Math.max(1, ck.e - ck.s);
      sc.scrollTop += frac * (ck.el.getBoundingClientRect().height || 0);
    }
    readerPinPageScroll();
    readerScheduleRender();
  });
}

// 大纲跳转（R91 重做）：定位到块 → 元素精确滚动 → 在块内找到标题元素精确到顶 + 高亮闪烁
function readerJumpToHeading(idx) {
  const tab = activeTab(); if (!tab || !tab.readerChunks) return;
  const off = (state.readerOutlineOff || [])[idx];
  if (off == null) return;
  const C = tab.readerChunks;
  let lo = 0, hi = C.length - 1, ci = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (C[m].s <= off) { ci = m; lo = m + 1; } else hi = m - 1; }
  const ck = C[ci];
  const sc = el('#reader-scroll'); if (!sc || !ck.el) return;
  readerScrollChunkIntoView(ck);
  readerRenderAround(ci);
  // R91.1：自校正——scrollIntoView 会把标题的 margin 顶到容器顶之外（标题被裁切）。
  // 两段式：rAF 内先对齐一次，150ms 后复核一次（渲染窗口稳定过程中会有几十 px 的滞后收缩）
  const alignHeading = () => {
    const item = state.outline[idx];
    let target = null;
    if (item && item.text) {
      const want = String(item.text);
      const hs = ck.el.querySelectorAll('h1,h2,h3,h4,h5,h6');
      // 精确匹配优先；空文本标题元素（lute 会输出）必须跳过——'' 对 indexOf 恒命中会错选
      for (let i = 0; i < hs.length; i++) {
        const t = (hs[i].textContent || '').trim();
        if (t && t === want) { target = hs[i]; break; }
      }
      if (!target) {
        for (let i = 0; i < hs.length; i++) {
          const t = (hs[i].textContent || '').trim();
          if (t && t.length > want.length && t.indexOf(want) !== -1) { target = hs[i]; break; }
        }
      }
    }
    if (!target) return null;
    const gap = target.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    if (Math.abs(gap - 8) > 2) sc.scrollTop += gap - 8;
    return target;
  };
  requestAnimationFrame(() => {
    const target = alignHeading();
    if (target) {
      target.classList.add('ms-rjump');
      setTimeout(() => target.classList.remove('ms-rjump'), 1800);
      setTimeout(() => { const t2 = alignHeading(); if (t2 && t2 !== target) { t2.classList.add('ms-rjump'); setTimeout(() => t2.classList.remove('ms-rjump'), 1800); } }, 150);
    } else {
      const frac = (off - ck.s) / Math.max(1, ck.e - ck.s);
      sc.scrollTop += frac * (ck.el.getBoundingClientRect().height || 0);
    }
    readerPinPageScroll();
    readerScheduleRender();
  });
}

// 在已渲染块内定位并高亮（R91 重做）：原始 md 文本带 #/*/` 等标记而 DOM 没有，且命中可能
// 跨内联元素拆出的多个文本节点——改为在「块内全部文本节点拼接串」里找；先试原文，
// 再试剥掉首尾 md 标记的版本；单节点命中包持久 <mark>，跨节点命中用选区(::selection)高亮
function readerHighlightIn(ck, localOff, len, tab) {
  document.querySelectorAll('#reader-body mark.ms-rfind').forEach(m => {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    m.remove();
  });
  try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (e) { }
  const raw = tab.content.substr(ck.s + localOff, len);
  if (!raw) return null;
  const cands = [raw];
  const stripped = raw.replace(/^[\s#>*_~`\-—·•]+/, '').replace(/[\s*_~`]+$/, '');
  if (stripped && stripped !== raw && stripped.length >= 4) cands.push(stripped);
  const walker = document.createTreeWalker(ck.el, NodeFilter.SHOW_TEXT, null);
  const nodes = []; let n;
  while ((n = walker.nextNode())) nodes.push(n);
  if (!nodes.length) return null;
  let full = '';
  const starts = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) { starts[i] = full.length; full += nodes[i].nodeValue; }
  for (let c2 = 0; c2 < cands.length; c2++) {
    const needle = cands[c2];
    if (needle.indexOf('\n') !== -1) continue;
    const at = full.indexOf(needle);
    if (at < 0) continue;
    let si = 0, ei = nodes.length - 1;
    for (let i = 0; i < nodes.length; i++) { if (starts[i] <= at) si = i; else break; }
    for (let i = si; i < nodes.length; i++) { if (starts[i] <= at + needle.length) ei = i; else break; }
    const so = at - starts[si];
    const eo = Math.min(at + needle.length - starts[ei], nodes[ei].nodeValue.length);
    const r = document.createRange();
    try {
      r.setStart(nodes[si], so);
      r.setEnd(nodes[ei], eo);
    } catch (e) { continue; }
    if (si === ei) {
      try {
        const mark = document.createElement('mark');
        mark.className = 'ms-rfind';
        r.surroundContents(mark);
        return mark;
      } catch (e) { /* 跨元素边界 → 走选区高亮 */ }
    }
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return nodes[si].parentElement || nodes[si];
    } catch (e) { return null; }
  }
  return null;
}

// 阅读模式大纲：带字符偏移的标题解析（jumpToHeading 按偏移跳块），复用 parseOutline 的过滤规则
function readerOutlineWithOffsets(md) {
  const items = [], offs = [];
  let inFence = false, fenceCh = '', fenceStart = -1, off = 0;
  const lines = (md || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!inFence) { inFence = true; fenceCh = f[1][0]; fenceStart = i; } else if (f[1][0] === fenceCh) { inFence = false; fenceStart = -1; } off += line.length + 1; continue; }
    // R90.1：围栏失衡保护（同 splitReaderChunks——源文档围栏未闭合时标题会全部失灵）
    if (inFence && fenceStart >= 0 && i - fenceStart > 300) { inFence = false; fenceStart = -1; }
    if (!inFence) {
      const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) { items.push({ level: h[1].length, text: h[2].replace(/<[^>]+>/g, '').trim() || h[2] }); offs.push(off); }
    }
    off += line.length + 1;
  }
  return { items, offs };
}

window.addEventListener('resize', () => {
  if (!isReader()) return;
  const tab = activeTab(); const C = tab && tab.readerChunks;
  if (C) C._sumsDirty = true;
  readerScheduleRender();
});

// R90：横幅「仍用编辑模式打开」——4 秒内连点两次确认，避免误触把超大文档整篇灌进 IR
(function bindReaderEdit() {
  const btn = document.getElementById('reader-edit');
  if (!btn || btn._r90) return;
  btn._r90 = true;
  let last = 0;
  btn.addEventListener('click', () => {
    if (Date.now() - last > 4000) {
      last = Date.now();
      btn.textContent = t('reader.confirmAgain');
      setTimeout(() => { btn.textContent = t('reader.keepEdit'); }, 4000);
      return;
    }
    const tab = activeTab();
    if (!tab || !tab.reader) return;
    // R92：超大文件禁止整篇进 IR——内存耗尽会崩掉渲染进程，窗口全白（菜单栏/标题栏/标签栏
    // 全是 DOM，随进程一起"消失"），用户只能强退。保持阅读模式并给出明确指引
    if (tab.content.length > EDITOR_ESCAPE_MAX) {
      toast(t('toast.fileTooBigReader', { size: (tab.content.length / 1048576).toFixed(1) }), 6000);
      btn.textContent = t('reader.keepEdit');
      return;
    }
    tab.reader = false;
    tab.sourceMode = false;
    readerTeardown(tab);
    toast(t('toast.openInEditor'), 30000);
    setTimeout(() => loadTabIntoEditor(tab), 60);
  });
})();

function recreateEditor(content) {
  if (!state.vditor) { ensureEditor().then(() => setContent(content)); return; }
  try { state.vditor.destroy(); } catch (e) { }
  state.vditor = null;
  state.editorReady = false;
  el('#editor').innerHTML = '';
  ensureEditor().then(() => {
    setContent(content || '');
    // 重建后 pre.vditor-reset 是新元素：换行类（ms-no-wrap）会丢，按当前设置重打
    applyWrap();
    onDocChanged(false);
    scheduleOutline();
    refreshLinesSoon();
    bindTableInteractions(); // R80-1：新 reset 重绑表格交互，否则行列选择槽/悬浮工具条随重建失效
    hideParaBar(); // R80-3：旧 reset 已销毁，收起可能仍锚定旧块的段落悬浮栏
  });
}

// ---------------------------------------------------------------- 多标签
function activeTab() {
  return state.tabs.find(t => t.id === state.activeTab) || null;
}

function untitledName() {
  const n = state.tabs.filter(t => !t.path).length;
  let name = n === 0 ? t('name.untitled') : t('name.untitled') + ' ' + (n + 1);
  let k = 2;
  while (state.tabs.some(t => t.name === name)) {
    name = t('name.untitled') + ' ' + (n + k);
    k++;
  }
  return name;
}

function newTabRecord() {
  return {
    id: 't' + (++tabSeq),
    path: null,
    name: untitledName(),
    content: '',
    eol: '\n',
    hadBom: false,
    encoding: 'UTF-8',
    dirty: false,
    scrollTop: 0,
    scrollLeft: 0,
    sourceMode: false,
    sourceEdited: false,
    diskStale: false,
    savedContent: ''
  };
}

// R60: 序列化编辑器根 innerHTML 时剥离应用覆盖层（与 vendor addCaret 同规则）。
// undo 快照/IR 缓存若烘焙进覆盖层，恢复时整篇重解析会复活僵尸工具条、扶正选框
//（见 sweepTableOrphans 注释）
function cleanIrHtml(pre) {
  const clone = pre.cloneNode(true);
  clone.querySelectorAll('.ms-ttools,.ms-tsel,.ms-cre,.ms-rre,.ms-grow,.ms-gcol').forEach((x) => x.remove());
  return clone.innerHTML;
}

// 把当前编辑器里的内容/视图状态收进指定标签（切换/新建前调用）
function snapshotTab(tab) {
  if (!tab) return;
  tab.content = getCurrentContent();
  const sc = getScrollContainer();
  if (sc) { tab.scrollTop = sc.scrollTop; tab.scrollLeft = sc.scrollLeft; }
  tab.sourceMode = state.sourceMode;
  tab.sourceEdited = sourceEdited;
  // R40：缓存 IR innerHTML 供切回时快路径恢复（免整篇 md 重解析，
  // 且保留 md 文本无法表达的空白段落）；源码模式下 IR DOM 已陈旧，不缓存
  tab.irHTML = (!state.sourceMode && state.vditor) ? cleanIrHtml(state.vditor.vditor.ir.element) : null;
}

let dragTabId = null;

// 标签栏拖动重排：dragover 时按指针位于目标标签左/右半区显示插入指示线，drop 时重排
function initTabDrag() {
  const wrap = el('#tabbar-wrap') || el('#tabbar');
  const bar = el('#tabbar');
  if (!wrap || !bar) return;
  const addBtn = el('#tab-add');
  if (addBtn) {
    addBtn.addEventListener('mousedown', (e) => e.preventDefault());
    addBtn.addEventListener('click', () => newFile());
  }
  const clearMarks = () => wrap.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  wrap.addEventListener('dragover', (e) => {
    if (!dragTabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearMarks();
    const tabEl = e.target.closest && e.target.closest('.tab');
    if (tabEl && tabEl.dataset.id !== dragTabId) {
      const r = tabEl.getBoundingClientRect();
      tabEl.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
    } else if (!tabEl && addBtn) {
      addBtn.classList.add('drop-after');
    }
  });
  wrap.addEventListener('drop', (e) => {
    if (!dragTabId) return;
    e.preventDefault();
    const tabEl = e.target.closest && e.target.closest('.tab');
    let targetId = null, after = false;
    if (tabEl && tabEl.dataset.id !== dragTabId) {
      targetId = tabEl.dataset.id;
      const r = tabEl.getBoundingClientRect();
      after = e.clientX > r.left + r.width / 2;
    }
    const id = dragTabId;
    dragTabId = null;
    clearMarks();
    finishOutDrag(); // R74：松手落在本窗口标签栏 = 重排，不开新窗口（消费本次拖拽）
    reorderTab(id, targetId, after);
  });
}

function reorderTab(dragId, targetId, after) {
  const tabs = state.tabs || [];
  const from = tabs.findIndex(t => t.id === dragId);
  if (from < 0) return;
  let toOriginal;
  if (!targetId) toOriginal = tabs.length; // 放在末尾（落到空白区或 + 号上）
  else {
    const ti = tabs.findIndex(t => t.id === targetId);
    if (ti < 0 || ti === from) return;
    toOriginal = after ? ti + 1 : ti;
  }
  const insertAt = from < toOriginal ? toOriginal - 1 : toOriginal;
  if (insertAt === from) return;
  const t = tabs.splice(from, 1)[0];
  tabs.splice(insertAt, 0, t);
  renderTabBar();
}

// ---------------------------------------------------------------- 标签拖出 / 跨窗口（R73-2 → R74-4 时序调整）
// 交互（参考 WPS 多文档窗口，R74 按用户口径修正新窗口时机）：
//   ① 按住已保存的标签拖到另一个 MarkStudio 窗口上松手 → 该窗口以标签打开文件，
//      本窗口移除该标签（脏标签不移除，防丢数据）；全程不新建窗口。
//   ② 松手时不在任何 MarkStudio 窗口上（桌面/其他程序）→ 此时才在松手点附近
//      开新窗口显示该文件（目录=文件所在目录，任务栏图标 +1），本窗口移除该标签。
//   ③ 松手落回本窗口：标签栏 = 按落点重排；文档区 = 取消（标签原地不动）。
// 未保存的标签（无路径）不能移动；有未保存改动的标签也不移动（toast 提示）。
let outDrag = null;
let outDragPreviewWin = 0; // dragend 新开窗口产生的 id——跨窗 drop 的 IPC 迟到时用它关掉冗余窗口
function finishOutDrag() {
  if (outDrag && outDrag.timer) { clearTimeout(outDrag.timer); outDrag.timer = 0; }
  outDrag = null;
}
// R75-5/6：从本窗口移除某标签（跨窗/拖出新窗口共用）。不弹未保存确认——
// 内容已随拖拽转移到目标窗口，这里只做「移走」；唯一标签移走则回到欢迎页
function removeTabById(id) {
  const i = state.tabs.findIndex(t => t.id === id);
  if (i === -1) return;
  state.tabs.splice(i, 1);
  if (state.tabs.length === 0) {
    state.activeTab = null;
    state.docPath = null;
    setDirty(false);
    // R83-P4：标签被拖到其它窗口/拖出新窗口后本窗口已无标签 → 直接关闭本窗口。
    // 内容已转移到目标窗口，空壳窗口不必保留、也不回欢迎页（win:close-by-id 强制销毁，
    // 绕过「关闭动作=最小化到托盘」；__dirty 此时必为 false，安全）。
    if (state.winId) { ms.invoke('win:close-by-id', { id: state.winId }).catch(() => { }); }
    else { window.close(); }
  } else if (state.activeTab === id) {
    activateTab(state.tabs[Math.max(0, i - 1)].id);
  }
  renderTabBar();
  syncTabWatchers();
}
// dragend（鼠标松开）时调用。落点在本窗口（标签栏/文档区）时对应 drop 分支已消费
// outDrag，这里直接返回；落点在另一个 MarkStudio 窗口时目标窗口异步发
// win:remote-tab-moved 把 consumed 置真；只有两种都不满足（松手在任意 MarkStudio
// 窗口之外）才开新窗口——延迟 400ms 等 IPC，防竞态下重复开窗
function scheduleOutDragNewWin(e) {
  if (!outDrag || (!outDrag.path && outDrag.content == null)) { finishOutDrag(); return; }
  const od = outDrag;
  if (od.dropped || od.consumed) { finishOutDrag(); return; }
  od.x = (e && Number.isFinite(e.screenX)) ? e.screenX : window.screenX;
  od.y = (e && Number.isFinite(e.screenY)) ? e.screenY : window.screenY;
  od.timer = setTimeout(() => { od.timer = 0; fireOutDragNewWin(od); }, 400);
}
function fireOutDragNewWin(od) {
  if (od.dropped || od.consumed || outDrag !== od) { if (outDrag === od) finishOutDrag(); return; }
  const tab = state.tabs.find(t => t.id === od.id);
  if (!tab) { finishOutDrag(); return; }
  (async () => {
    let r = null;
    const nx = od.x + 48, ny = od.y + 48;
    if (od.content != null) {
      // R75-5/6：未保存标签——新窗口以「内容」打开（保留未存改动）
      try { r = await ms.invoke('win:open-unsaved', { name: od.name, content: od.content, x: nx, y: ny }); } catch (err) { }
    } else if (tab.dirty) {
      // 已保存但有未存改动的标签：不移动，防丢数据（R74 行为）
      toast(t('toast.dragUnsaved'));
      finishOutDrag();
      return;
    } else {
      // 已保存且干净：新窗口按路径打开
      try { r = await ms.invoke('window:new', { path: od.path, folder: dirOf(od.path) || undefined, x: nx, y: ny }); } catch (err) { }
    }
    if (r && r.id) {
      // 竞态兜底：若其实是跨窗 drop（目标窗口加载慢、IPC 晚于 400ms），
      // 目标的 consumed IPC 会用这个 id 关掉本冗余窗口；3s 宽限后视为用户正式窗口
      outDragPreviewWin = r.id;
      setTimeout(() => { if (outDragPreviewWin === r.id) outDragPreviewWin = 0; }, 3000);
      removeTabById(od.id);
    } else {
      toast(t('toast.newWinFailed'));
    }
    finishOutDrag();
  })().catch(() => { finishOutDrag(); });
}

function renderTabBar() {
  const bar = el('#tabbar');
  if (!bar) return;
  bar.classList.toggle('hidden', state.tabs.length === 0);
  syncMenuBarVis();
  bar.innerHTML = '';
  // dist54 修复：循环参数改名 tb——原参数名 t 遮蔽了 i18n 的 t()，
  // 导致 t('tab.closeTitle') 把标签对象当函数调用，renderTabBar 每次必抛
  // TypeError，标签栏渲染中断（标签不显示、后续同步代码被跳过）
  state.tabs.forEach(tb => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (tb.id === state.activeTab ? ' active' : '');
    tab.dataset.id = tb.id;
    tab.title = tb.path || tb.name;
    const ico = document.createElement('span');
    ico.className = 'tico';
    ico.innerHTML = tb.path ? fileIconSVG('md')
      : '<svg viewBox="0 0 20 20" fill="none"><path d="M5 2.5h6.5L15.5 6.5v11c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5v-13c0-.8.7-1.5 1.5-1.5z" fill="#9aa0a6"/><path d="M11.5 2.5l4 4h-3c-.6 0-1-.4-1-1v-3z" fill="#7d8288"/><path d="M6.8 10.5h6.4M6.8 13h4.2" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>';
    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = tb.name;
    tab.appendChild(ico);
    tab.appendChild(name);
    if (tb.dirty) {
      const dot = document.createElement('span');
      dot.className = 'tdirty';
      dot.textContent = '●';
      dot.title = t('common.notSaved');
      tab.appendChild(dot);
    }
    const close = document.createElement('button');
    close.className = 'tclose';
    close.title = t('tab.closeTitle');
    close.textContent = '✕';
    close.addEventListener('mousedown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tb.id); });
    // R46：悬浮「✕」→ 弹出文件名（可重命名）+ 完整路径卡片
    close.addEventListener('mouseenter', () => showTabCard(tb, close));
    close.addEventListener('mouseleave', hideTabCardSoon);
    tab.appendChild(close);
    tab.addEventListener('click', () => activateTab(tb.id));
    // 拖动标签可在多个标签间左右调整位置
    // R73：已保存到磁盘的标签额外携带自定义类型数据（文件绝对路径 + 源窗口 id）——
    // 拖出窗口边界 → 新窗口显示（任务栏图标 +1）；拖到另一个 MarkStudio 窗口 →
    // 该窗口以标签打开，本窗口移除（均参考 WPS 的多文档窗口操作）
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      dragTabId = tb.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tb.id); } catch (err) { }
      if (tb.path) {
        // 已保存：按路径移动（R73/R74 行为）
        try {
          e.dataTransfer.setData('application/x-markstudio-tab', JSON.stringify({ id: tb.id, path: tb.path, win: state.winId || null }));
          outDrag = { id: tb.id, path: tb.path, content: null, name: tb.name, dropped: false, consumed: false, timer: 0, x: 0, y: 0 };
        } catch (err) { }
      } else {
        // R75-5/6：未保存标签——携带内容，可拖到其它窗口 / 拖出开新窗口（保留未存改动）
        const content = (tb.id === state.activeTab) ? getCurrentContent() : (tb.content || '');
        try {
          e.dataTransfer.setData('application/x-markstudio-tab', JSON.stringify({ id: tb.id, name: tb.name, content, win: state.winId || null }));
          outDrag = { id: tb.id, path: null, content, name: tb.name, dropped: false, consumed: false, timer: 0, x: 0, y: 0 };
        } catch (err) { }
      }
      setTimeout(() => tab.classList.add('dragging'), 0);
    });
    tab.addEventListener('dragend', (e) => {
      dragTabId = null;
      tab.classList.remove('dragging');
      els('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
      scheduleOutDragNewWin(e); // R74：鼠标松开才决定是否开新窗口（松手不在任何 MarkStudio 窗口上时）
    });
    bar.appendChild(tab);
  });
  // 新建标签页按钮：固定在标题栏标签行右端（不在滚动区内），无标签时随标签栏隐藏
  const add = el('#tab-add');
  if (add) add.classList.toggle('hidden', state.tabs.length === 0);
  const act = bar.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------------------------------------------------------- 文件标签悬浮卡片（R46）
// 悬浮文件标签的「✕」时弹出卡片（参考主流办公套件的标题栏交互）：
// 第一行=文件名（可编辑，回车/失焦即重命名），第二行=文件完整路径，第三行=保存状态。
// 已保存到磁盘的文件重命名走主进程 fs:rename（同目录）；未保存的文件只改待保存名。
let tabCardTimer = 0;
function showTabCard(tab, anchorEl) {
  clearTimeout(tabCardTimer);
  const c = el('#tab-card');
  if (!c || !tab) return;
  c.dataset.tabId = tab.id;
  el('#tab-card-name').value = tab.name;
  el('#tab-card-path').textContent = tab.path || t('tab.cardPath');
  const d = el('#tab-card-dirty');
  if (d) { d.classList.toggle('hidden', !tab.dirty); d.textContent = tab.dirty ? t('tab.dirty') : t('common.saved'); }
  c.classList.remove('hidden');
  const r = anchorEl.getBoundingClientRect();
  const cw = c.offsetWidth, ch = c.offsetHeight;
  let x = r.left + r.width / 2 - cw / 2;
  x = Math.max(6, Math.min(x, window.innerWidth - cw - 6));
  let y = r.bottom + 6;
  if (y + ch > window.innerHeight - 6) y = Math.max(6, r.top - ch - 6);
  c.style.left = x + 'px';
  c.style.top = y + 'px';
  const inp = el('#tab-card-name');
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) { } }, 30);
}
function hideTabCardSoon() {
  clearTimeout(tabCardTimer);
  tabCardTimer = setTimeout(() => { const c = el('#tab-card'); if (c) c.classList.add('hidden'); }, 320);
}
function hideTabCardNow() {
  clearTimeout(tabCardTimer);
  const c = el('#tab-card');
  if (c) c.classList.add('hidden');
}
function commitTabCardRename() {
  const c = el('#tab-card');
  if (!c) return;
  const tab = state.tabs.find(t => t.id === c.dataset.tabId);
  if (!tab) return;
  const inp = el('#tab-card-name');
  hideTabCardNow();
  let name = (inp.value || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
  if (!name) { toast(t('toast.nameEmpty')); return; }
  // 值与原名完全一致（典型场景：只是悬停看了一眼名字、并未编辑，随后失焦）
  // → 不做任何事。否则下面「无扩展名补 .md」会把 未命名 静默改成 未命名.md，
  // 之后保存对话框再拼一次扩展名就成了 未命名.md.md
  if (name === tab.name) return;
  // 未带扩展名 → 沿用原扩展名（默认 .md）
  const oldExt = tab.name.includes('.') ? tab.name.slice(tab.name.lastIndexOf('.')) : '.md';
  if (!name.includes('.')) name += oldExt;
  if (name === tab.name) return;
  tab.name = name;
  (async () => {
    if (tab.path) {
      const from = tab.path;
      const dir = dirOf(from);
      const to = dir ? dir + '\\' + name : name;
      if (to === from) { renderTabBar(); return; }
      const r = await ms.invoke('fs:rename', { from, to });
      if (r && r.error) { toast(t('toast.renameFailed', { e: r.error })); renderTabBar(); return; }
      tab.path = to;
      if (state.docPath === from) state.docPath = to;
      state.recent = await ms.invoke('app:recent-replace', { from, to });
      const parent = dirOf(to);
      if (parent) {
        if (parent !== state.folder) state.folder = parent;
        refreshTree();
      }
      syncTabWatchers();
      if (state.docPath === to) syncDocState();
      renderTabBar();
      toast(t('toast.renamed', { name }));
    } else {
      // 尚未保存：只改待保存名（下次保存时生效）
      if (state.activeTab === tab.id) syncDocState();
      renderTabBar();
    }
  })();
}
function initTabCard() {
  const c = el('#tab-card');
  if (!c) return;
  c.addEventListener('mouseenter', () => clearTimeout(tabCardTimer));
  c.addEventListener('mouseleave', hideTabCardSoon);
  const inp = el('#tab-card-name');
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTabCardRename(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      const tab = state.tabs.find(t => t.id === c.dataset.tabId);
      if (tab) inp.value = tab.name; // 撤销编辑，避免失焦提交把改动应用掉
      hideTabCardNow();
    }
  });
  inp.addEventListener('blur', () => { setTimeout(commitTabCardRename, 80); });
  document.addEventListener('mousedown', (e) => {
    if (!c.classList.contains('hidden') && !c.contains(e.target)) hideTabCardNow();
  });
  window.addEventListener('blur', hideTabCardNow);
}

// 把标签内容载入编辑器（openPath / activateTab / newFile 共用）
function loadTabIntoEditor(tab) {
  state.docPath = tab.path;
  state.eol = tab.eol;
  state.hadBom = tab.hadBom;
  state.encoding = tab.encoding || 'UTF-8';
  state.sourceMode = !!tab.sourceMode;
  sourceEdited = !!tab.sourceEdited;
  // R90：上一个标签若在阅读模式，先拆掉阅读 DOM（释放内存、恢复行号栏/悬浮栏）
  if (readerTabId) {
    const pt = state.tabs.find(t => t.id === readerTabId);
    readerTeardown(pt);
  }
  // R90：超大文件（tab.reader）走只读快速阅读模式，不进 Vditor IR
  if (tab.reader) {
    enterReaderMode(tab);
    setDirty(!!tab.dirty);
    syncDocState();
    el('#st-enc').textContent = state.encoding;
    clearTableSelection();
    removeGutters();
    scheduleOutline(tab.content);
    setTimeout(() => updateStats(tab.content), 0);
    setTimeout(updateCursorPos, 0);
    setTimeout(updateFbarTextStyle, 0);
    // R92：文件列表跟随所在目录（此前阅读分支提前 return 跳过了这段——
    // 直接打开/最近列表打开大文件时 state.folder 不设置，侧栏「文件」面板为空）
    const parentR = dirOf(tab.path);
    if (parentR && parentR !== state.folder) { state.folder = parentR; refreshTree(); }
    else highlightTreeFile(tab.path);
    return;
  }
  // 大文件关闭代码高亮（打开大文件卡顿的主因）
  const vopt = (state.vditor.vditor || {}).options;
  if (vopt && vopt.preview && vopt.preview.hljs) vopt.preview.hljs.enable = (tab.content || '').length < LARGE_FILE_THRESHOLD;
  // R40：切回标签优先用缓存的 IR DOM 快路径恢复（免整篇 md 重解析，大文档约 1s 降到
  // 几十毫秒，且保留 md 文本无法表达的空白段落）；无缓存时整篇 md 重渲染
  if (tab.irHTML && !state.sourceMode && state.vditor) {
    state.vditor.restoreIR(tab.irHTML);
    tab.irHTML = null;
  } else {
    setContent(tab.content || '');
  }
  // R40：undo 栈是编辑器级共享的，载入新文档后必须重置，否则 Ctrl+Z 会把
  // 当前文档回退成上一个文档的内容（跨标签污染）
  try { if (state.vditor) state.vditor.clearStack(); } catch (e) { }
  // R57：换文档后 DOM 与 tab.content 必然同步（且旧的待同步 mdSync 已被 restoreIR/setContent 作废）
  state.editorDomDirty = false;
  // R40：源码模式标签载入时，IR DOM 仍是上一个标签的文档，二者必然不同步，
  // 标记 sourceEdited 使「退出源码」时强制从源码重建 IR DOM，避免显示/保存串文档
  if (state.sourceMode) sourceEdited = true;
  applyCvl((tab.content || '').length);
  setDirty(!!tab.dirty);
  // setDirty 在脏状态未变化时会提前 return（不刷新状态栏），而切标签 docPath 必然变化；
  // 显式再同步一次，保证状态栏「文件路径/保存态/编码」始终跟随当前标签
  syncDocState();
  el('#st-enc').textContent = state.encoding;
  applySourceMode(state.sourceMode);
  // 文件列表跟随当前文件所在目录
  const parent = dirOf(tab.path);
  if (parent && parent !== state.folder) {
    state.folder = parent;
    refreshTree();
  } else {
    highlightTreeFile(tab.path);
  }
  scheduleOutline(tab.content);
  refreshLinesSoon();
  fixImagesSoon();
  setTimeout(() => updateStats(tab.content), 0);
  setTimeout(updateCursorPos, 0);
  setTimeout(updateFbarTextStyle, 0);
  // 表格交互（R45）：切标签后旧选区失效；重放本标签保存的列宽/行高
  clearTableSelection();
  removeGutters(); // 行/列选择槽引用的是旧文档表格，必须整体移除
  // R60：文档加载后主动钉死所有表格列宽（「天生已钉」，见 reapplyTableLayout(pinNew)）——
  // 首次钉列的重排是「点选单元格时表格跳动」的主因。restoreIR 近乎同步，setContent
  // 的整篇 md 重渲染是异步（WASM 解析），大文档 150ms 时表格可能尚未进 DOM → 重试数次
  [150, 400, 1000, 2500].forEach((d) => {
    setTimeout(() => { if (state.docPath === tab.path && !state.sourceMode) reapplyTableLayout(true); }, d);
  });
}

function activateTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || id === state.activeTab) return;
  if (!state.vditor) { ensureEditor().then(() => { snapshotTab(activeTab()); state.activeTab = id; loadTabIntoEditor(tab); renderTabBar(); syncTabWatchers(); }); return; }
  snapshotTab(activeTab());
  state.activeTab = id;
  loadTabIntoEditor(tab);
  // 切换文档后重置与单文档相关的 UI 状态
  state.findState = { idx: -1, total: 0, matches: [] };
  toggleFind(false);
  closeTablePicker();
  // 恢复滚动位置（Vditor 渲染是异步的，双次保险）
  const st = tab.scrollTop || 0, sl = tab.scrollLeft || 0;
  const applyScroll = () => {
    const sc = getScrollContainer();
    if (sc) { sc.scrollTop = st; sc.scrollLeft = sl; }
  };
  setTimeout(applyScroll, 120);
  setTimeout(applyScroll, 350);
  renderTabBar();
  syncTabWatchers();
}

// 未保存改动确认（R50）：应用内 iOS 风格毛玻璃弹窗，替代系统原生对话框。
// 返回 'save' / 'discard' / 'cancel'；suffix 可替换结尾句（标签页关闭 vs 窗口关闭）
function confirmUnsaved(name, suffix) {
  const msg = t('unsaved.msg', { name }) + (suffix || t('unsaved.askTab'));
  return new Promise((resolve) => {
    const mask = el('#unsaved-modal');
    if (!mask) {
      ms.invoke('msg:confirm', {
        message: t('unsaved.msg', { name }),
        detail: suffix || t('unsaved.askTab'),
        buttons: [t('common.save'), t('common.dontSave'), t('common.cancel')]
      }).then((a) => resolve(a === 0 ? 'save' : (a === 1 ? 'discard' : 'cancel')));
      return;
    }
    el('#unsaved-msg').textContent = msg;
    mask.classList.remove('hidden');
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      mask.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      resolve(r);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish('save'); }
    };
    document.addEventListener('keydown', onKey, true);
    el('#unsaved-save').onclick = () => finish('save');
    el('#unsaved-discard').onclick = () => finish('discard');
    el('#unsaved-cancel').onclick = () => finish('cancel');
    el('#unsaved-x').onclick = () => finish('cancel');
    setTimeout(() => { try { el('#unsaved-save').focus(); } catch (err) { } }, 30);
  });
}

// 关闭确认（R62/R64）：应用内 iOS 毛玻璃弹窗，替代系统原生「要关闭 MarkStudio 吗？」。
// 主进程在 closeAction=ask 时发 app:close-ask，用户选择后回 app:close-ask-done。
// 返回 'minimize' / 'quit' / 'cancel'（Enter 默认 = 最小化）。
// R64：勾选「记住我的选择」且选最小化/退出 → 写 closeAction，后续点 × 直接执行不再弹窗。
let closeAskFinish = null; // R63：待决 finish 的引用——主进程兜底超时时同步收起弹窗
function confirmClose() {
  return new Promise((resolve) => {
    const mask = el('#close-modal');
    if (!mask) {
      // 兜底：DOM 异常时退回原生弹框（顺序与旧版一致：最小化/退出/取消）
      ms.invoke('msg:confirm', {
        message: t('close.title'),
        detail: t('close.detail'),
        buttons: [t('common.minimize'), t('common.quit'), t('common.cancel')]
      }).then((a) => resolve(a === 0 ? 'minimize' : (a === 1 ? 'quit' : 'cancel')));
      return;
    }
    try { const cb0 = el('#close-remember'); if (cb0) cb0.checked = false; } catch (err) { }
    mask.classList.remove('hidden');
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      closeAskFinish = null;
      mask.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      // R64：记住本次选择（取消不算选择，不持久化）
      if (r === 'minimize' || r === 'quit') {
        const cb = el('#close-remember');
        if (cb && cb.checked) {
          ms.invoke('app:set-settings', { partial: { closeAction: r } }).catch(() => { });
        }
      }
      resolve(r);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish('minimize'); }
    };
    document.addEventListener('keydown', onKey, true);
    el('#close-min').onclick = () => finish('minimize');
    el('#close-quit').onclick = () => finish('quit');
    el('#close-cancel').onclick = () => finish('cancel');
    el('#close-x').onclick = () => finish('cancel');
    setTimeout(() => { try { el('#close-min').focus(); } catch (err) { } }, 30);
    closeAskFinish = finish;
  });
}
// R63：主进程 30 秒兜底已按「取消」处理（渲染层卡死/崩溃）——若弹窗仍开着就同步收起，
// 避免用户去点一个「已失效但仍可点」的弹窗而得不到任何响应
ms.on('app:close-ask-timeout', () => {
  if (typeof closeAskFinish === 'function') closeAskFinish('cancel');
});

// 关于 MarkStudio（R62）：应用内毛玻璃卡片，替代系统原生对话框
let aboutOpen = false;
function hideAbout() {
  aboutOpen = false;
  const m = el('#about-modal');
  if (m) m.classList.add('hidden');
}
function showAbout() {
  const m = el('#about-modal');
  if (!m) {
    ms.invoke('msg:confirm', {
      message: 'MarkStudio 1.0.0',
      detail: t('about.detail'),
      buttons: [t('common.ok')]
    });
    return;
  }
  ms.invoke('app:info').then((i) => {
    const v = el('#about-ver');
    if (v && i) v.textContent = t('about.version') + ' ' + i.version;
  }).catch(() => { });
  m.classList.remove('hidden');
  aboutOpen = true;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && aboutOpen) { e.preventDefault(); hideAbout(); }
}, true);
el('#about-x').onclick = hideAbout;
el('#about-ok').onclick = hideAbout;

// dist58：导出图片弹窗——分辨率(1×~4×) + 格式(PNG/JPEG/WebP) + 保存位置，一次选好直接导出
// （不再另弹系统保存框；默认保存到当前文档所在目录）。Promise 化：resolve({scale,format,path}) 继续 / null 取消。
let imgresResolve = null;
let imgresState = { dir: '', base: '', dpi: 300, baseW: 0, baseH: 0, html: '' };
// dist59：格式不再单设——由保存路径扩展名决定（.jpg/.jpeg→JPEG，其余→PNG）
function imgresExtFromPath(p) { const e = ((p || '').match(/\.([a-z0-9]+)$/i) || [])[1] || ''; return (e === 'jpg' || e === 'jpeg') ? 'jpg' : 'png'; }
function imgresJoinPath(dir, name, ext) {
  const d = dir || ''; if (!d) return '';
  const sep = (d[d.length - 1] === '\\' || d[d.length - 1] === '/') ? '' : '\\';
  return d + sep + name + '.' + ext;
}
// dist59：预计张数——与主进程 export:image 完全同式（倍率仅按宽度约束，高度分片），保证预览=实际
function imgresTileCount(scale, baseH, baseW) {
  const CAP = 16000, MAX_SCALE = 4;
  const s = (typeof scale === 'number' && isFinite(scale)) ? Math.min(MAX_SCALE, Math.max(1, scale)) : 2;
  const eff = Math.min(s, CAP / (baseW || 800));
  const sliceBaseH = Math.max(1, Math.floor(CAP / eff));
  return Math.max(1, Math.ceil((baseH || 0) / sliceBaseH));
}
function imgresUpdateTiles() {
  const info = el('#imgres-tileinfo'); if (!info) return;
  const m = el('#modal-image-res'); if (!m) return;
  const rScale = m.querySelector('input[name="imgres"]:checked');
  const scale = rScale ? parseInt(rScale.value, 10) : 2;
  if (!imgresState.baseH) { info.textContent = t('imgres.tilesMeasuring'); info.classList.add('dim'); return; }
  const n = imgresTileCount(scale, imgresState.baseH, imgresState.baseW);
  if (n > 1) { info.textContent = t('imgres.tilesMany', { n: n }); info.classList.remove('dim'); }
  else { info.textContent = t('imgres.tilesOne'); info.classList.add('dim'); }
}
function hideImageRes() {
  const m = el('#modal-image-res');
  if (m) m.classList.add('hidden');
  if (imgresResolve) { const r = imgresResolve; imgresResolve = null; r(null); }
}
function showImageRes() {
  return new Promise(async (resolve) => {
    const m = el('#modal-image-res');
    if (!m) { resolve(null); return; } // 极端无 DOM → 取消
    const s = state.settings || {};
    const scale = Math.max(1, Math.min(4, parseInt(s.imageScale, 10) || 2));
    const dpi = [96, 150, 300, 600].indexOf(s.imageDpi) !== -1 ? s.imageDpi : 300;
    const base = baseName(state.docPath).replace(/\.(md|markdown|txt)$/i, '') || 'export';
    let dir = s.imageSaveDir || '';
    if (!dir && state.docPath) dir = state.docPath.replace(/[/\\][^/\\]*$/, '');
    imgresState = { dir: dir, base: base, dpi: dpi, baseW: 0, baseH: 0, html: '' };
    const rScale = m.querySelector('input[name="imgres"][value="' + scale + '"]'); if (rScale) rScale.checked = true;
    const dpiSel = el('#imgres-dpi'); if (dpiSel) dpiSel.value = String(dpi);
    const pathIn = el('#imgres-path'); // dist59：可编辑/直接粘贴，默认 目录+文件名+.png
    if (pathIn) pathIn.value = dir ? imgresJoinPath(dir, base, 'png') : '';
    imgresUpdateTiles();
    imgresResolve = (v) => { resolve(v); };
    m.classList.remove('hidden');
    // dist59：异步测量正文尺寸 → 本地算出预计张数（不阻塞弹窗显示）
    try {
      imgresState.html = await buildExportHtml();
      const mr = await ms.invoke('export:measure-image', { html: imgresState.html });
      if (mr && mr.ok && !el('#modal-image-res').classList.contains('hidden')) {
        imgresState.baseW = mr.baseW; imgresState.baseH = mr.baseH; imgresUpdateTiles();
      }
    } catch (e) { /* 测量失败 → 保持"计算中"，不影响导出 */ }
  });
}
el('#imgres-x').onclick = hideImageRes;
el('#imgres-cancel').onclick = hideImageRes;
document.addEventListener('change', (e) => { if (e.target && e.target.name === 'imgres') imgresUpdateTiles(); }, true);
el('#imgres-browse').onclick = async () => {
  const m = el('#modal-image-res'); if (!m) return;
  const pathIn = el('#imgres-path');
  const r = await ms.invoke('dialog:pick-image-path', { defaultPath: (pathIn && pathIn.value) || undefined });
  if (!r || r.canceled || !r.filePath) return;
  const p = r.filePath;
  imgresState.dir = p.replace(/[/\\][^/\\]*$/, '');
  imgresState.base = baseName(p).replace(/\.[a-z0-9]+$/i, '') || imgresState.base;
  if (pathIn) pathIn.value = p; // dist59：格式由扩展名决定，不再切换单选
};
el('#imgres-ok').onclick = () => {
  const m = el('#modal-image-res'); if (!m) return;
  const rScale = m.querySelector('input[name="imgres"]:checked');
  const scale = rScale ? parseInt(rScale.value, 10) : 2;
  const dpiSel = el('#imgres-dpi');
  const dpi = dpiSel ? parseInt(dpiSel.value, 10) : 300;
  const pathIn = el('#imgres-path');
  let path = pathIn ? pathIn.value.trim() : '';
  if (!path && imgresState.dir) path = imgresJoinPath(imgresState.dir, imgresState.base, 'png');
  if (path && !/\.([a-z0-9]+)$/i.test(path)) path += '.png'; // 无扩展名 → 补 .png（→PNG）
  const saveDir = path ? path.replace(/[/\\][^/\\]*$/, '') : '';
  ms.invoke('app:set-settings', { partial: { imageScale: scale, imageDpi: dpi, imageSaveDir: saveDir } }).then(s2 => { if (s2) state.settings = s2; }).catch(() => { });
  m.classList.add('hidden');
  if (imgresResolve) { const r = imgresResolve; imgresResolve = null; r({ scale: scale, dpi: dpi, path: path }); }
};
document.addEventListener('keydown', (e) => {
  const m = el('#modal-image-res');
  if (e.key === 'Escape' && m && !m.classList.contains('hidden')) { e.preventDefault(); hideImageRes(); }
}, true);

function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  const proceed = async (r) => {
    if (tab.dirty) {
      const ans = await confirmUnsaved(tab.name);
      if (ans === 'cancel') return;
      if (ans === 'save') {
        if (tab.id === state.activeTab) {
          if (!await save(true)) return;
        } else {
          if (!tab.path) {
            const p = await ms.invoke('dialog:save-file', { defaultPath: mdSuggestName(tab.name) });
            if (!p) return;
            tab.path = p;
            tab.name = baseName(p);
          }
          const w = await ms.invoke('fs:write-file', { path: tab.path, content: tab.content, eol: tab.eol, hadBom: tab.hadBom });
          if (w.error) { toast(t('toast.saveFailed', { e: w.error })); return; }
          state.recent = await ms.invoke('app:recent');
        }
        tab.dirty = false;
      }
    }
    state.tabs.splice(idx, 1);
    if (state.activeTab === id) {
      const next = state.tabs[idx] || state.tabs[idx - 1] || null;
      if (next) activateTab(next.id);
      else {
        state.activeTab = null;
        state.docPath = null;
        setDirty(false);
        showWelcome();
      }
    }
    renderTabBar();
    syncTabWatchers();
  };
  proceed();
}

// 上报全部已打开标签的文件路径，主进程据此维护外部修改监听
function syncTabWatchers() {
  ms.invoke('fs:watch-tabs', { paths: state.tabs.filter(t => t.path).map(t => t.path) });
}

// ---------------------------------------------------------------- 文档状态
function setDirty(v) {
  const tab = activeTab();
  if (tab) tab.dirty = v;
  if (state.dirty === v) return;
  state.dirty = v;
  syncDocState();
  renderTabBar();
}

function syncDocState() {
  const anyDirty = state.tabs.some(t => t.dirty);
  ms.invoke('doc:state', { path: state.docPath, dirty: state.dirty, anyDirty });
  // R46：状态栏左下角不再显示文件路径（用户反馈冗余，路径已在标签/右键卡片可见）
  // R52：保存态必须与文件标签悬浮卡一致——从未保存到磁盘的文件（新建未落盘，无 path）
  // 一律显示「未保存」；新建文件 dirty=false，曾误显示「已保存」造成两处状态矛盾
  const tab = activeTab();
  const unsaved = tab ? (!tab.path || state.dirty) : false;
  el('#st-save').textContent = tab ? (unsaved ? t('common.notSaved') : t('common.saved')) : '—';
  el('#st-save').classList.toggle('dirty', unsaved);
}

function onDocChanged(markDirty = true, value) {
  if (markDirty) setDirty(true);
  scheduleStats(value);
}

// 字数统计防抖：整篇统计对大文档是百毫秒级开销，放在防抖里避免每次击键都卡
let statsTimer = null;
function scheduleStats(value) {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => updateStats(value != null ? value : getCurrentContent()), 250);
}

// 上报 UI 状态给主进程，驱动菜单项动态标签（隐藏/打开侧边栏 等）
function sendMenuState() {
  try {
    ms.invoke('app:menu-state', {
      sidebarVisible: !el('#sidebar').classList.contains('hidden'),
      sourceMode: !!state.sourceMode,
      showLines: !!state.showLines
    });
  } catch (e) { }
}

// ---------------------------------------------------------------- 字数统计
// R53-9：整篇正则统计放到 Web Worker（独立线程）执行，大文档击键时主线程零阻塞。
// Worker 创建/发送失败（如 CSP 或打包异常）时回退主线程 countStats，功能不受影响
let statsWorker = null;
let statsSeq = 0;
function getStatsWorker() {
  if (statsWorker) return statsWorker;
  try {
    statsWorker = new Worker('stats-worker.js');
    statsWorker.onmessage = (e) => {
      const d = e.data || {};
      if (d.id !== statsSeq) return; // 过期结果丢弃（大文档统计期间可能又输入了）
      el('#st-words').textContent = t('status.words', { n: d.words });
      el('#st-chars').textContent = t('status.chars', { n: d.chars });
    };
    statsWorker.onerror = () => { statsWorker = null; }; // 之后自动走主线程兜底
  } catch (err) { statsWorker = null; }
  return statsWorker;
}

function updateStats(value) {
  const text = value != null ? value : getCurrentContent();
  const w = getStatsWorker();
  if (w) {
    statsSeq++;
    try { w.postMessage({ id: statsSeq, text }); return; }
    catch (err) { try { w.terminate(); } catch (e2) { } statsWorker = null; }
  }
  const { words, chars } = countStats(text);
  el('#st-words').textContent = t('status.words', { n: words });
  el('#st-chars').textContent = t('status.chars', { n: chars });
}

// ---------------------------------------------------------------- 光标位置（状态栏 行:列）
// 渲染模式：行 = 光标所在顶层块序号（与行号栏编号一致），列 = 块内到光标的字符数
// 悬浮栏字体/字号框：选中文本时显示该文本实际使用的字体
// （默认字体栈→本机实际渲染的字体名，如微软雅黑；显式设置过字体→该字体）
const GENERIC_FONTS_RE = /^(system-ui|-apple-system|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace|segoe ui|segoe ui variable|cascadia[ -]?[a-z]*|harmonyos? ?sans|pingfang sc|hiragino sans|tahoma|verdana|arial|helvetica|geneva|noto sans cjk sc)$/i;
// 在选区内找第一个「显式设置过字体」的文字（内联 style font-family，即 .ms-styled 包装）
function fontInSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
  let frag = null;
  try { frag = sel.getRangeAt(0).cloneContents(); } catch (e) { return ''; }
  if (!frag) return '';
  const tw = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = tw.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    let p = n.parentElement;
    while (p && p !== frag) {
      if (p.style && p.style.fontFamily) return String(p.style.fontFamily).split(',')[0].replace(/["']/g, '').trim();
      p = p.parentElement;
    }
  }
  return '';
}
// 从 style 串里取某个属性的值（font-family / font-size / color）
function spanStyleProp(styleStr, prop) {
  const m = new RegExp(prop + '\\s*:\\s*([^;"\']+)', 'i').exec(String(styleStr || ''));
  return m ? m[1].replace(/["']/g, '').trim() : '';
}
// 折叠光标下「光标所指字符」的样式载体元素：
// offset>0 取当前文本节点（光标前一个字符）；offset==0 回退到块内上一个非空、非 marker 的文本节点。
// 通用编辑交互惯例：光标停在某字体文字上（未拖动选择）时，字体框也应显示该字体。
function caretStyleNode() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const an = sel.anchorNode;
  if (an.nodeType !== 3) return an;
  const block = an.parentElement;
  if (!block) return null;
  let target = an;
  if (sel.anchorOffset === 0) {
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    w.currentNode = an;
    let n = w.previousNode();
    while (n) {
      const inMarker = n.parentElement && n.parentElement.closest ? n.parentElement.closest('code.vditor-ir__marker') : null;
      if (!inMarker && n.nodeValue.trim()) { target = n; break; }
      n = w.previousNode();
    }
  }
  return target.parentElement;
}
// 默认字体栈在本机「实际参与渲染」的字体名。
// 默认栈（见 style.css #editor .vditor-reset）：-apple-system, "SF Pro Text", "Segoe UI",
// "PingFang SC", "Microsoft YaHei", "Microsoft YaHei UI", sans-serif。浏览器按序取第一个
// 能渲染该字符的字体：中文取 CJK 字体（中文系统上 family 即「微软雅黑」），纯拉丁取 Segoe UI 等。
// 依据启动时预取的已装字体列表（sysFontsCache）做本机检测；列表未就绪时按平台兜底。
// 注意：中文系统上主进程枚举到的 family 本身就是中文名（如「微软雅黑」），
// 英文系统上才是英文 family 名 → 匹配必须同时按 family 和 local 两个字段。
// 英文名 ↔ 本地化名 互为别名（跨系统兼容：CSS/设置里存的是英文 family，
// 中文系统上枚举出来的 family 却是中文名）
const FONT_ALIAS = {
  'microsoft yahei': ['微软雅黑', 'yahei'],
  'yahei': ['微软雅黑', 'microsoft yahei'],
  'microsoft yahei ui': ['微软雅黑 ui'],
  'pingfang sc': ['苹方-简', '苹方'],
  '苹方': ['苹方-简', 'pingfang sc']
};
function fontEntryMatch(name) {
  const list = (typeof sysFontsCache !== 'undefined' && sysFontsCache) ? sysFontsCache : [];
  const key = String(name || '').toLowerCase();
  if (!key) return null;
  const tryOne = (k) => {
    for (const f of list) {
      if (typeof f === 'string') { if (f.toLowerCase() === k) return { family: f, local: f }; continue; }
      if (!f) continue;
      if (String(f.family || '').toLowerCase() === k || String(f.local || '').toLowerCase() === k) return f;
    }
    return null;
  };
  const hit = tryOne(key);
  if (hit) return hit;
  const aliases = FONT_ALIAS[key] || [];
  for (const a of aliases) { const h = tryOne(a.toLowerCase()); if (h) return h; }
  return null;
}
function defaultRenderFont(sample) {
  // 无选区/无样本文字时按系统语言推定主体文字类型（中文系统正文以中文为主）
  let s = sample || '';
  if (!s) s = /zh/i.test(navigator.language || '') ? '中' : 'a';
  const hasCJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(s);
  const pref = hasCJK
    ? ['Microsoft YaHei', '微软雅黑', 'Microsoft YaHei UI', 'PingFang SC', '苹方-简', 'Noto Sans CJK SC', 'SimHei', '宋体']
    : ['Segoe UI', 'SF Pro Text', 'Helvetica Neue', 'Arial'];
  if (pref.some(f => fontEntryMatch(f))) {
    for (const f of pref) { const hit = fontEntryMatch(f); if (hit) return hit.family; }
  }
  // 字体列表尚未就绪：按平台给出最可能的实际字体
  if (/Windows/i.test(navigator.userAgent)) return hasCJK ? 'Microsoft YaHei' : 'Segoe UI';
  if (/Mac/i.test(navigator.userAgent)) return hasCJK ? 'PingFang SC' : 'SF Pro Text';
  return t('font.default');
}
// family 名（或本地化名）→ 本地化显示名。中文界面下字体列表/悬浮栏应显示中文名称
// （如「微软雅黑」而不是 Microsoft YaHei）；英文字体保持英文名。无映射返回 ''。
function fontLocalName(family) {
  const hit = fontEntryMatch(family);
  if (!hit) return '';
  return (typeof hit === 'string' ? hit : (hit.local || hit.family)) || family;
}
function updateFbarTextStyle() {
  const fEl = el('#fbar-font-val');
  const sEl = el('#fbar-size-val');
  if (!fEl && !sEl) return;
  const sel = window.getSelection();
  let node = null;
  let srcFam = '', srcPx = 0;
  if (state.sourceMode) {
    // 源码模式：窗口选区在 textarea 里，改从 markdown 的样式 span 读光标/选区处的字体字号
    const ta = el('#source');
    if (ta) {
      const a = Math.min(ta.selectionStart, ta.selectionEnd);
      const b = Math.max(ta.selectionStart, ta.selectionEnd);
      const cover = findSpanCovering(ta.value, a, b);
      if (cover) {
        srcFam = spanStyleProp(cover.style, 'font-family');
        srcPx = parseFloat(spanStyleProp(cover.style, 'font-size')) || 0;
      }
    }
  } else {
    const reset = el('.vditor-ir .vditor-reset');
    if (sel && sel.rangeCount && sel.anchorNode && reset && reset.contains(sel.anchorNode)) {
      node = (!sel.isCollapsed && sel.toString())
        ? (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode)
        : caretStyleNode();
      // 锚点落在 html-inline span 的隐藏 marker 文字（<span ...> 字面量，等宽字体）上会污染显示
      if (node && node.nodeType === 1 && node.closest && node.closest('code.vditor-ir__marker')) node = null;
    }
  }
  const cs = node ? getComputedStyle(node) : null;
  // 显式内联字体（.ms-styled 包装）优先于 computed：代码块/行内代码的等宽字体是编辑器默认，不算「显式字体」
  let explicitFF = '';
  if (node && node.nodeType === 1) {
    const reset = el('.vditor-ir .vditor-reset');
    let p = node;
    while (p && p !== reset && p.nodeType === 1) {
      if (p.style && p.style.fontFamily) { explicitFF = p.style.fontFamily; break; }
      p = p.parentElement;
    }
  }
  if (fEl) {
    let fam = explicitFF
      ? explicitFF.split(',')[0].replace(/["']/g, '').trim()
      : (cs ? (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim() : srcFam);
    if (!explicitFF && node && node.closest && node.closest('pre, code')) fam = ''; // 代码块默认等宽 → 按默认字体显示
    if (!fam || GENERIC_FONTS_RE.test(fam)) {
      const inSel = fontInSelection();
      if (inSel && !GENERIC_FONTS_RE.test(inSel)) fam = inSel;
    }
    if (!fam || GENERIC_FONTS_RE.test(fam)) {
      // 默认字体栈：显示本机实际参与渲染的字体（Windows 上即微软雅黑系），
      // 而不是含糊的「默认」——用户选中正文时期望看到文本的真实字体（R43 用户反馈）
      const sample = (node && node.textContent) ? node.textContent : (sel && sel.toString ? sel.toString() : '');
      fam = defaultRenderFont(sample);
    }
    // R47：正文字体栈以拉丁字体开头（如 Segoe UI），中文字形实际由 CJK 字体回退渲染。
    // 若样本文字含中文且栈首字体不支持中文 → 显示真正参与渲染的 CJK 字体（本地化名），
    // 避免中文段落却显示一排拉丁字体名
    if (fam && !GENERIC_FONTS_RE.test(fam) && typeof document !== 'undefined' && document.fonts && document.fonts.check) {
      const sampleCjk = (node && node.textContent) ? node.textContent : (sel && sel.toString ? sel.toString() : '');
      if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(sampleCjk) &&
          !document.fonts.check('16px "' + String(fam).replace(/"/g, '') + '"', '国')) {
        fam = defaultRenderFont(sampleCjk);
      }
    }
    fEl.textContent = fontLocalName(fam) || fam;
  }
  if (sEl) {
    const px = cs ? parseFloat(cs.fontSize) : srcPx;
    sEl.textContent = Number.isFinite(px) && px > 0 ? String(Math.round(px)) : '16';
  }
}

function updateCursorPos() {
  const posEl = el('#st-pos');
  if (!posEl) return;
  // R52：未打开任何文档（如欢迎页只打开了文件夹）时不显示占位的「行1：列1」
  if (!activeTab()) { posEl.textContent = t('status.lineCol'); highlightGutterLine(null); return; }
  // R90：阅读模式无光标概念
  if (isReader()) { posEl.textContent = t('status.readMode'); highlightGutterLine(null); return; }
  let line = 1, col = 1;
  if (state.sourceMode) {
    const ta = el('#source');
    if (ta) {
      const p = ta.selectionStart || 0;
      const before = ta.value.slice(0, p);
      const nl = before.lastIndexOf('\n');
      line = (before.match(/\n/g) || []).length + 1;
      col = p - nl;
    }
  } else {
    const reset = el('.vditor-ir .vditor-reset');
    const sel = window.getSelection();
    if (sel && sel.anchorNode && reset && reset.contains(sel.anchorNode)) {
      let n = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      let block = null;
      while (n && n !== reset) {
        if (n.parentElement === reset) { block = n; break; }
        n = n.parentElement;
      }
      if (block) {
        line = Array.prototype.indexOf.call(reset.children, block) + 1;
        const anchor = sel.anchorNode;
        const aoff = sel.anchorOffset || 0;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
        let total = 0, w;
        while ((w = walker.nextNode())) {
          if (w === anchor) { total += aoff; break; }
          total += w.nodeValue.length;
        }
        col = total + 1;
      }
    }
  }
  posEl.textContent = t('status.lineColN', { l: line, c: col });
  highlightGutterLine(line);
}

// 行号栏当前行高亮：只增删 .cur 类，不重建整列
let gutterCurLn = null;
function highlightGutterLine(n) {
  const inner = el('#line-gutter-inner');
  if (!inner) return;
  if (gutterCurLn) gutterCurLn.classList.remove('cur');
  gutterCurLn = null;
  if (!n) return;
  const d = inner.querySelector('.ln[data-n="' + n + '"]');
  if (d) { d.classList.add('cur'); gutterCurLn = d; }
}

// ---------------------------------------------------------------- 文件操作
// 大文件阈值：超过后关闭代码高亮（hljs 逐块渲染是打开大文件卡顿的主因）
const LARGE_FILE_THRESHOLD = 150000;

async function openPath(p) {
  // 多标签：同一文件已在标签中打开 → 直接激活，不重复读盘
  const norm = p.replace(/\\/g, '/');
  const ex = state.tabs.find(t => t.path && t.path.replace(/\\/g, '/') === norm);
  if (ex) { activateTab(ex.id); return; }
  const r = await ms.invoke('fs:read-file', { path: p });
  if (r.error) { toast(t('toast.openFailed', { e: r.error })); return; }
  const content = r.content || '';
  await ensureEditor();
  // 性能：大文件关闭代码高亮，避免逐块 highlight 造成的明显卡顿
  const isLarge = content.length >= LARGE_FILE_THRESHOLD;
  // R90：超大文件默认走只读快速阅读模式（整篇 IR 渲染会卡死主线程数分钟）
  const isReaderFile = content.length >= READER_THRESHOLD;
  if (isLarge) {
    // 先让 toast 画出来再执行整篇阻塞渲染，避免界面看起来"冻住"
    toast(t('toast.loadingBig'), 30000);
    await new Promise(res => setTimeout(res, 30));
  }
  const tab = {
    id: 't' + (++tabSeq),
    path: p,
    name: baseName(p),
    content,
    eol: r.eol || '\n',
    hadBom: !!r.hadBom,
    encoding: (r.encoding || 'utf-8').toUpperCase(),
    dirty: false,
    scrollTop: 0,
    scrollLeft: 0,
    sourceMode: false,
    sourceEdited: false,
    diskStale: false,
    reader: isReaderFile,
    // 与磁盘一致的内容基线（归一化换行）：延迟 input 回调据此判断是否真有新改动
    savedContent: content.replace(/\r\n/g, '\n')
  };
  snapshotTab(activeTab());
  state.tabs.push(tab);
  state.activeTab = tab.id;
  // 大文件的高亮开关在 loadTabIntoEditor 内按内容长度处理
  loadTabIntoEditor(tab);
  showWorkspace();
  highlightTreeFile(p);
  renderTabBar();
  syncTabWatchers();
  // 最近文件（主进程已在读盘成功路径 pushRecent，这里刷新菜单用列表）
  state.recent = await ms.invoke('app:recent');
  if (isReaderFile) toast(t('toast.readerOpened'), 5000);
  else if (isLarge) toast(t('toast.bigOpened'));
}

// R75-5/6：以「内容」开一个标签（跨窗拖入未保存标签 / 新窗口打开未保存内容）
async function openContentTab(up) {
  const content = (up && up.content != null) ? up.content : '';
  await ensureEditor();
  const tab = {
    id: 't' + (++tabSeq),
    path: (up && up.path) || null,
    name: (up && up.name) || ((up && up.path) ? baseName(up.path) : t('name.untitled')),
    content,
    eol: '\n',
    hadBom: false,
    encoding: 'UTF-8',
    dirty: content.length > 0,
    scrollTop: 0,
    scrollLeft: 0,
    sourceMode: false,
    sourceEdited: false,
    diskStale: false,
    reader: content.length >= READER_THRESHOLD,
    savedContent: content.replace(/\r\n/g, '\n')
  };
  snapshotTab(activeTab());
  state.tabs.push(tab);
  state.activeTab = tab.id;
  state.docPath = tab.path;
  state.eol = '\n';
  state.hadBom = false;
  loadTabIntoEditor(tab);
  showWorkspace();
  renderTabBar();
  syncTabWatchers();
  syncDocState();
}

async function save(silent) {
  const tab = activeTab();
  const content = getCurrentContent();
  if (tab) tab.content = content;
  if (!state.docPath) return saveAs(silent);
  const r = await ms.invoke('fs:write-file', { path: state.docPath, content, eol: state.eol, hadBom: state.hadBom });
  if (r.error) { toast(t('toast.saveFailed', { e: r.error })); return false; }
  if (tab) { tab.diskStale = false; tab.dirty = false; tab.savedContent = content.replace(/\r\n/g, '\n'); }
  setDirty(false);
  state.recent = await ms.invoke('app:recent');
  if (!silent) toast(t('toast.saved'));
  return true;
}

async function saveAs(silent) {
  const tab = activeTab();
  const p = await ms.invoke('dialog:save-file', { defaultPath: state.docPath || mdSuggestName(tab ? tab.name : t('name.untitled')) });
  if (!p) return false;
  if (tab) { tab.path = p; tab.name = baseName(p); tab.eol = '\n'; tab.hadBom = false; }
  state.docPath = p;
  state.eol = '\n';
  state.hadBom = false;
  syncDocState();
  const ok = await save(silent);
  if (ok) {
    renderTabBar(); syncTabWatchers();
    // R46a：首次保存（新建文件落地）后，侧边栏「文件」面板要能立刻看到这个文件——
    // 目录与当前不同则切换目录刷新，相同则原地刷新并高亮
    const parent = dirOf(p);
    if (parent) {
      if (parent !== state.folder) state.folder = parent;
      refreshTree();
    }
  }
  return ok;
}

async function newFile() {
  await ensureEditor();
  const tab = newTabRecord();
  snapshotTab(activeTab());
  state.tabs.push(tab);
  state.activeTab = tab.id;
  loadTabIntoEditor(tab);
  showWorkspace();
  renderTabBar();
  syncTabWatchers();
  try { state.vditor.focus(); } catch (e) { }
  setTimeout(updateCursorPos, 0);
}

async function reloadCurrent() {
  const tab = activeTab();
  if (!tab || !tab.path) return;
  const r = await ms.invoke('fs:read-file', { path: tab.path });
  if (r.error) return;
  tab.content = r.content || '';
  tab.eol = r.eol || '\n';
  tab.hadBom = !!r.hadBom;
  tab.savedContent = (r.content || '').replace(/\r\n/g, '\n');
  // R90：阅读模式标签重载 → 重建分块并重渲染（不进 setContent/Vditor）
  if (tab.reader) {
    tab.readerChunks = splitReaderChunks(tab.content);
    tab.readerChunksSrcLen = tab.content.length;
    tab.readerScrollTop = 0;
    enterReaderMode(tab);
    setDirty(false);
    updateStats();
    scheduleOutline(tab.content);
    return;
  }
  setContent(tab.content);
  setDirty(false);
  updateStats();
  scheduleOutline();
  refreshLinesSoon();
  fixImagesSoon();
}

// ---------------------------------------------------------------- 欢迎页
// 品牌标签/菜单栏显隐：以「欢迎页是否可见」为准，而非「是否有文档标签」——
// R44：启动界面（欢迎页）不需要左上角标识；
// R52：从欢迎页打开文件夹后虽未打开文件，但已进入工作区，
// 此时品牌标签与菜单栏都应显示（用户反馈缺失）
function isWelcomeVisible() {
  const w = el('#welcome');
  return !!(w && !w.classList.contains('hidden'));
}
function syncBrandTab() {
  const b = el('#brand-tab');
  if (b) b.classList.toggle('hidden', isWelcomeVisible());
}

async function showWelcome() {
  // R75：查找/替换栏挂在 <body>（#workspace 之外），回到欢迎页/关闭最后一个文件时必须收起，
  // 否则它会一直浮在欢迎页右上角（8d 修复）
  toggleFind(false);
  state.findState = { idx: -1, total: 0, matches: [] };
  el('#welcome').classList.remove('hidden');
  el('#workspace').classList.add('hidden');
  syncBrandTab();
  syncMenuBarVis();
  const recent = await ms.invoke('app:recent');
  state.recent = recent;
  const ul = el('#recent-list');
  ul.innerHTML = '';
  if (!recent.length) {
    ul.innerHTML = '<li style="cursor:default;color:var(--text-dim)">' + t('welcome.noRecent') + '</li>';
    return;
  }
  recent.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rname">${baseName(p)}</span><span class="rdir">${p}</span>`;
    li.title = p;
    li.onclick = () => openPath(p);
    ul.appendChild(li);
  });
}

async function showWorkspace() {
  el('#welcome').classList.add('hidden');
  el('#workspace').classList.remove('hidden');
  syncBrandTab();
  syncMenuBarVis();
  syncDocState();
}

// ---------------------------------------------------------------- 大纲
function scheduleOutline(value) {
  clearTimeout(scheduleOutline._t);
  scheduleOutline._t = setTimeout(() => refreshOutline(value), 250);
}

function parseOutline(md) {
  const lines = (md || '').split('\n');
  const items = [];
  let inFence = false, fence = '', fenceStart = -1;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!inFence) { inFence = true; fence = f[1][0]; fenceStart = li; }
      else if (f[1][0] === fence) { inFence = false; fenceStart = -1; }
      continue;
    }
    // R90.1：围栏失衡保护——源文档围栏 300 行未闭合按失衡处理（真实代码块不会这么长），
    // 否则未闭合围栏之后的所有标题都会被当成"块内"跳过，大纲只剩开头的几条
    if (inFence && fenceStart >= 0 && li - fenceStart > 300) inFence = false;
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    // 标题可能被文字样式包成 `<span style="...">标题</span>`，大纲只取纯文本
    if (h) items.push({ level: h[1].length, text: h[2].replace(/<[^>]+>/g, '').trim() || h[2] });
  }
  return items;
}

// 把扁平标题列表按层级组织成树：每个节点的 children 是「紧跟其后、级别更深」的标题，
// 遇到同级或更高级别标题即结束（标准 Markdown 大纲嵌套规则）
function buildOutlineTree(items) {
  const root = { level: 0, children: [] };
  const stack = [root];
  items.forEach((it, i) => {
    const node = { idx: i, level: it.level, text: it.text, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= it.level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  return root.children;
}

// 递归渲染大纲行：箭头=折叠/展开，文字=点击跳转。折叠状态按「级别|文本」记忆，
// 编辑标题时未变动的节点保持原折叠状态（默认全部展开）
function renderOutlineNodes(nodes, depth) {
  const frag = document.createDocumentFragment();
  nodes.forEach((node) => {
    const key = node.level + '|' + node.text;
    const open = !state.outlineClosed.has(key);
    const hasKids = node.children.length > 0;

    const row = document.createElement('div');
    row.className = 'ol-row';
    row.style.setProperty('--indent', (depth * 14) + 'px');
    row.dataset.oi = String(node.idx); // R78-2：按大纲索引定位行（选中正文时高亮对应章节）

    const caret = document.createElement('span');
    caret.className = 'ol-caret' + (hasKids ? '' : ' leaf');
    caret.textContent = hasKids ? (open ? '▾' : '▸') : '▾';
    caret.title = hasKids ? (open ? t('outline.fold') : t('outline.expand')) : '';
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasKids) return;
      const nowOpen = state.outlineClosed.has(key); // 当前是折叠态 → 点开
      if (nowOpen) state.outlineClosed.delete(key); else state.outlineClosed.add(key);
      caret.textContent = nowOpen ? '▾' : '▸';
      caret.title = nowOpen ? t('outline.fold') : t('outline.expand');
      if (node._kids) node._kids.classList.toggle('hidden', !nowOpen);
    });

    // 标签图标：按标题级别着色，区分层级更直观
    const tag = document.createElement('span');
    tag.className = 'ol-tag lv' + node.level;
    tag.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';

    const label = document.createElement('span');
    label.className = 'ol-text';
    label.textContent = node.text;
    label.title = node.text;
    label.addEventListener('click', () => jumpToHeading(node.idx));

    row.appendChild(caret);
    row.appendChild(tag);
    row.appendChild(label);
    frag.appendChild(row);

    if (hasKids) {
      const kids = document.createElement('div');
      kids.className = 'ol-kids' + (open ? '' : ' hidden');
      kids.appendChild(renderOutlineNodes(node.children, depth + 1));
      node._kids = kids;
      frag.appendChild(kids);
    }
  });
  return frag;
}

function refreshOutline(value) {
  state.readerOutlineOff = null;
  if (isReader()) {
    // R90：阅读模式用带偏移的大纲解析（跳转按字符偏移定位分块）
    const t = activeTab();
    const r = readerOutlineWithOffsets(t ? t.content : '');
    state.outline = r.items;
    state.readerOutlineOff = r.offs;
  } else {
    state.outline = parseOutline(value != null ? value : getCurrentContent());
  }
  // R90：超大文档大纲行数封顶（上万条全渲染侧栏会卡），超出部分折叠为提示
  if (state.outline.length > READER_OUTLINE_CAP) {
    state.outline = state.outline.slice(0, READER_OUTLINE_CAP);
    if (state.readerOutlineOff) state.readerOutlineOff = state.readerOutlineOff.slice(0, READER_OUTLINE_CAP);
    state.outlineCapped = true;
  } else {
    state.outlineCapped = false;
  }
  const box = el('#outline-list');
  box.innerHTML = '';
  if (!state.outline.length) {
    box.innerHTML = '<div class="empty">' + t('outline.empty') + '</div>';
    state.outlineActiveIdx = -1;
    return;
  }
  box.appendChild(renderOutlineNodes(buildOutlineTree(state.outline), 0));
  if (state.outlineCapped) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = t('outline.cap', { n: READER_OUTLINE_CAP });
    box.appendChild(note);
  }
  applyOutlineHighlight(); // R78-2：大纲重建后恢复当前章节高亮
}

// R78-2：根据正文当前的选中/光标位置，算出它落在哪个标题章节（返回大纲索引，-1=无）
function outlineIndexForSelection() {
  if (state.sourceMode) return -1;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return -1;
  const n = sel.anchorNode;
  const nodeEl = n.nodeType === Node.TEXT_NODE ? n.parentElement : n;
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset || !nodeEl || !reset.contains(nodeEl)) return -1;
  const heads = Array.from(reset.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  // R79：选区若落在某个标题内部（含「选中该标题文字本身」）→ 该标题即当前章节，直接取其索引。
  // 否则 compareDocumentPosition 对「节点自身」返回 0（三个关系位都不置位），会漏掉该标题、
  // 回落到它前面的章节（如选中 B 标题却高亮到上一个 A）。沿父链向上找最近的标题祖先或自身。
  let node = nodeEl;
  while (node && node !== reset) {
    const k = heads.indexOf(node);
    if (k >= 0) return k;
    node = node.parentElement;
  }
  let sectionIdx = -1;
  for (let i = 0; i < heads.length; i++) {
    const pos = heads[i].compareDocumentPosition(nodeEl);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      sectionIdx = i; // 该标题在选区之前 → 选区位于它（或更近标题）的章节内
    } else if (pos & Node.DOCUMENT_POSITION_CONTAINS) {
      sectionIdx = i; break; // 选区就在这个标题内
    } else if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
      break; // 该标题在选区之后 → 更后面的标题更不可能，停
    }
  }
  return sectionIdx;
}

// R78-2：把 .ol-row.active 高亮到 state.outlineActiveIdx 对应行（无则清除全部高亮）
function applyOutlineHighlight() {
  const box = el('#outline-list');
  if (!box) return;
  box.querySelectorAll('.ol-row.active').forEach(r => r.classList.remove('active'));
  const idx = state.outlineActiveIdx;
  if (idx == null || idx < 0) return;
  const row = box.querySelector('.ol-row[data-oi="' + idx + '"]');
  if (row) row.classList.add('active');
}

// R78-2：正文选中/光标移动 → 大纲对应章节高亮联动
function initOutlineSelectionSync() {
  let last = -2;
  document.addEventListener('selectionchange', () => {
    const idx = outlineIndexForSelection();
    if (idx === last) return;
    last = idx;
    if (idx !== state.outlineActiveIdx) {
      state.outlineActiveIdx = idx;
      applyOutlineHighlight();
    }
  });
}

function jumpToHeading(idx) {
  const item = state.outline[idx];
  if (!item) return;
  // R90/R91：阅读模式按大纲偏移定位，块内再按标题元素精确到顶
  if (isReader()) {
    readerJumpToHeading(idx);
    return;
  }
  if (state.sourceMode) {
    // 源代码模式：按行号跳转
    const ta = el('#source');
    const lines = ta.value.split('\n');
    let count = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m && m[1].length === item.level && m[2].trim() === item.text) {
        count = i; break;
      }
    }
    if (count >= 0) {
      const pos = lines.slice(0, count).join('\n').length + (count ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      ta.scrollTop = Math.max(0, count * 24 - 96);
    }
    return;
  }
  // 注意：DOM 中存在多个 .vditor-reset（Vditor 预览容器也带此类名），
  // 必须锁定 IR 编辑器真正的内容容器，否则取到的是空容器
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  // 大纲按源码顺序生成，与 DOM 中标题的出现顺序一一对应：直接取第 idx 个标题
  const heads = Array.from(reset.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  let target = heads[idx];
  if (!target) {
    // 兜底：大纲可能滞后于编辑内容，按文本匹配
    target = Array.from(reset.querySelectorAll('h' + item.level))
      .find(h => h.textContent.trim() === item.text) || null;
  }
  if (!target) return;
  // 找到真正的滚动容器（Vditor 的 .vditor-ir）并平滑滚动到标题
  let sc = target.parentElement;
  while (sc && sc !== document.body) {
    const oy = getComputedStyle(sc).overflowY;
    if (oy === 'auto' || oy === 'scroll') break;
    sc = sc.parentElement;
  }
  if (sc) {
    // 直接跳转，无过渡动画；大文件 content-visibility 下屏外块尺寸是估算值，
    // 首跳后再精算一次（requestAnimationFrame 内完成，视觉上仍是瞬时）
    const jump = () => {
      const delta = target.getBoundingClientRect().top - sc.getBoundingClientRect().top - 18;
      sc.scrollTop = Math.max(0, sc.scrollTop + delta);
    };
    jump();
    requestAnimationFrame(jump);
  } else {
    target.scrollIntoView({ behavior: 'auto', block: 'start' });
  }
}

// ---------------------------------------------------------------- 文件树
async function openFolder(p) {
  if (!p) return;
  state.folder = p;
  // R75-2：打开文件夹后刷新「最近文件夹」列表（主进程已记录）
  try { state.recentFolders = await ms.invoke('app:recent-folders') || []; } catch (e) { /* ignore */ }
  await showWorkspace();
  showSidebar('files');
  await refreshTree();
  // R52：只打开文件夹、尚未打开任何文档时，状态栏位置复位为「行：列」（不带占位数字）
  updateCursorPos();
  toast(t('toast.openedFolder', { name: baseName(p) }));
}

async function openFolderDialog() {
  const p = await ms.invoke('dialog:open-folder');
  if (!p) return;
  await openFolder(p);
}

// 刷新竞态保护：快速切换文件/文件夹时，丢弃过期（非最新）的目录读取结果，避免显示错文件夹
let treeSeq = 0;
async function refreshTree() {
  if (!state.folder) return;
  const seq = ++treeSeq;
  const root = state.folder;
  const tree = await ms.invoke('fs:read-dir', { path: root });
  if (seq !== treeSeq) return;
  el('#files-root-name').textContent = baseName(root);
  const box = el('#file-tree');
  box.innerHTML = '';
  box.appendChild(buildTreeDom(tree));
  highlightTreeFile(state.docPath);
}

// 文件类型 → 图标配色（取代旧 emoji，观感更统一）
function fileKind(name) {
  const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'img';
  return 'other';
}
const FILE_ICONS = {
  folder: '<svg viewBox="0 0 20 20" fill="none"><path d="M2.5 5.5c0-1 .8-1.8 1.8-1.8h3.6c.5 0 .9.2 1.2.5l1 1h7.6c1 0 1.8.8 1.8 1.8v8.5c0 1-.8 1.8-1.8 1.8H4.3c-1 0-1.8-.8-1.8-1.8V5.5z" fill="#f2b32c"/></svg>',
  folderOpen: '<svg viewBox="0 0 20 20" fill="none"><path d="M2.5 5.5c0-1 .8-1.8 1.8-1.8h3.6c.5 0 .9.2 1.2.5l1 1h6.4c.6 0 1.1.4 1.3 1l.7 2H6.2c-1 0-1.8.6-2 1.6l-1.7 6H2.5V5.5z" fill="#f2b32c"/><path d="M4.9 9.5h12.9c.9 0 1.5.9 1.2 1.7l-1.6 4.4c-.2.5-.7.9-1.2.9H3.4c-.9 0-1.6-.9-1.3-1.7l1.6-4.4c.2-.5.7-.9 1.2-.9z" fill="#f7c75b"/></svg>',
  md: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 2.5h6.5L15.5 6.5v11c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5v-13c0-.8.7-1.5 1.5-1.5z" fill="#2f6fd0"/><path d="M11.5 2.5l4 4h-3c-.6 0-1-.4-1-1v-3z" fill="#1f4f9e"/><text x="9.7" y="14.3" font-family="Arial, sans-serif" font-size="6.6" font-weight="700" fill="#fff" text-anchor="middle">M\u2193</text></svg>',
  pdf: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 2.5h6.5L15.5 6.5v11c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5v-13c0-.8.7-1.5 1.5-1.5z" fill="#d64541"/><path d="M11.5 2.5l4 4h-3c-.6 0-1-.4-1-1v-3z" fill="#a8322e"/><text x="9.7" y="14" font-family="Arial, sans-serif" font-size="5.2" font-weight="700" fill="#fff" text-anchor="middle">PDF</text></svg>',
  img: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 2.5h6.5L15.5 6.5v11c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5v-13c0-.8.7-1.5 1.5-1.5z" fill="#3a9e5b"/><path d="M11.5 2.5l4 4h-3c-.6 0-1-.4-1-1v-3z" fill="#2b7a44"/><rect x="4.8" y="9" width="10.4" height="6.6" rx="1" fill="#fff" opacity=".92"/><circle cx="7.4" cy="11.4" r="1" fill="#3a9e5b"/><path d="M5.4 14.8l2.8-2.6 1.9 1.8 2.4-2.4 2.1 2.2" stroke="#3a9e5b" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  other: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 2.5h6.5L15.5 6.5v11c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5v-13c0-.8.7-1.5 1.5-1.5z" fill="#9aa0a6"/><path d="M11.5 2.5l4 4h-3c-.6 0-1-.4-1-1v-3z" fill="#7d8288"/><path d="M6.2 10h7.6M6.2 12.6h7.6M6.2 15.2h4.6" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>'
};
function fileIconSVG(kind, open) {
  if (kind === 'folder') return open ? FILE_ICONS.folderOpen : FILE_ICONS.folder;
  return FILE_ICONS[kind] || FILE_ICONS.other;
}

function buildTreeDom(node, depth) {
  depth = depth || 0;
  const indent = (depth * 14) + 'px';
  const frag = document.createDocumentFragment();
  (node.children || []).forEach((child) => {
    if (child.isDir) {
      const details = document.createElement('details');
      details.open = state.treeOpen.has(child.path);
      const summary = document.createElement('summary');
      summary.style.setProperty('--indent', indent);
      const ico = document.createElement('span');
      ico.className = 'ti';
      ico.innerHTML = fileIconSVG('folder', details.open);
      summary.appendChild(ico);
      summary.appendChild(document.createTextNode(' ' + child.name));
      summary.title = child.path;
      details.ontoggle = () => {
        ico.innerHTML = fileIconSVG('folder', details.open);
        if (details.open) state.treeOpen.add(child.path);
        else state.treeOpen.delete(child.path);
      };
      details.appendChild(summary);
      if (child.children && child.children.length) details.appendChild(buildTreeDom(child, depth + 1));
      else {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.style.setProperty('--indent', indent);
        empty.textContent = t('files.empty');
        details.appendChild(empty);
      }
      frag.appendChild(details);
    } else {
      const f = document.createElement('button');
      f.type = 'button';
      f.className = 'file' + (child.openable ? '' : ' dim');
      f.dataset.path = child.path;
      f.style.setProperty('--indent', indent);
      const ico = document.createElement('span');
      ico.className = 'ti';
      ico.innerHTML = fileIconSVG(fileKind(child.name));
      f.appendChild(ico);
      f.appendChild(document.createTextNode(' ' + child.name));
      f.title = child.path;
      f.onclick = () => {
        if (child.openable) openPath(child.path);
        else ms.invoke('shell:open-path', { path: child.path });
      };
      frag.appendChild(f);
    }
  });
  return frag;
}

function highlightTreeFile(p) {
  els('#file-tree .file').forEach(n => n.classList.toggle('active', n.dataset.path && p && n.dataset.path.toLowerCase() === p.toLowerCase()));
}

function showSidebar(tab) {
  el('#sidebar').classList.remove('hidden');
  syncSidebarResizer();
  if (tab) {
    els('#sidebar-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    el('#panel-files').classList.toggle('hidden', tab !== 'files');
    el('#panel-outline').classList.toggle('hidden', tab !== 'outline');
  }
}

function syncSidebarResizer() {
  const sb = el('#sidebar');
  const rz = el('#sidebar-resizer');
  if (rz && sb) rz.classList.toggle('hidden', sb.classList.contains('hidden'));
}

function toggleSidebar() {
  const sb = el('#sidebar');
  if (sb.classList.contains('hidden')) {
    sb.classList.remove('hidden');
    if (!state.folder) refreshOutline();
    if (state.folder && el('#file-tree').children.length === 0) refreshTree();
  } else {
    sb.classList.add('hidden');
  }
  syncSidebarResizer();
  layoutLineGutter();
  sendMenuState();
}

// 侧边栏宽度：应用持久化宽度 + 拖拽调宽
function applySidebarWidth() {
  const sb = el('#sidebar');
  if (!sb) return;
  const w = Math.min(480, Math.max(180, parseInt(state.settings && state.settings.sidebarWidth, 10) || 260));
  sb.style.width = w + 'px';
}

function initSidebarResizer() {
  const rz = el('#sidebar-resizer');
  const sb = el('#sidebar');
  if (!rz || !sb) return;
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sb.offsetWidth;
    rz.classList.add('dragging');
    let raf = 0;
    const onMove = (ev) => {
      const w = Math.min(480, Math.max(180, startW + (ev.clientX - startX)));
      sb.style.width = w + 'px';
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; layoutLineGutter(); });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      rz.classList.remove('dragging');
      const w = Math.round(sb.offsetWidth);
      state.settings.sidebarWidth = w;
      ms.invoke('app:set-settings', { partial: { sidebarWidth: w } });
      layoutLineGutter();
      // 拖拽结束后的 click 会误触发编辑器行为，吞掉一次
      const swallow = (ev2) => { ev2.stopPropagation(); ev2.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// 行号开关（视图菜单）
function toggleLines() {
  state.showLines = !state.showLines;
  const g = el('#line-gutter');
  if (g) g.classList.toggle('hidden', !state.showLines);
  if (state.showLines) {
    // 重新显示时强制重建（隐藏期间内容可能已变化，跳过缓存会显示过期行号）
    refreshLines._irSig = null;
    refreshLines._srcN = -1;
    refreshLines();
    layoutLineGutter();
  }
  sendMenuState();
}

// ---------------------------------------------------------------- 行号栏：右键=隐藏行号；左键点行号=选中该行内容
// ---------------------------------------------------------------- 代码块语言选择
// 代码块聚焦（Vditor 给节点加 .vditor-ir__node--expand）时，在其右上角浮现语言下拉；
// 选择后按「值回环」改写该代码块围栏的语言标记并 setValue 重建，即时切换高亮。
// 语言列表取全局 hljs（Vditor 自带，约 197 种），另加「纯文本」。
// 注意（同 R82）：取 md 用实时 getValue()；按文档顺序的 ``` 围栏与 DOM 代码块一一对应
// （第 n 个 data-type=code-block ↔ 第 n 个围栏），避免过期 tab.content 造成索引错位。
let codeLangNode = null;
function codeLangOptions() {
  let langs = [];
  try { if (window.hljs && window.hljs.listLanguages) langs = window.hljs.listLanguages(); } catch (e) { }
  const common = ['javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'c++', 'csharp', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'sql', 'bash', 'shell', 'json', 'yaml', 'xml', 'html', 'css', 'markdown', 'plaintext'];
  const head = common.filter((l) => langs.indexOf(l) >= 0);
  const rest = langs.filter((l) => head.indexOf(l) < 0);
  return head.concat(rest);
}
function fenceLangOf(node) {
  const info = node.querySelector('.vditor-ir__marker--info');
  return info ? (info.textContent || '').replace(/\u200b/g, '').trim() : '';
}
function replaceNthFenceLang(md, n, lang) {
  const lines = md.split('\n');
  let count = -1, inFence = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)(`{3,})(.*)$/.exec(line);
    if (!inFence) {
      if (m) { count++; inFence = true; out.push(count === n ? (m[1] + m[2] + (lang || '')) : line); }
      else out.push(line);
    } else {
      if (m && m[3].trim() === '') inFence = false;
      out.push(line);
    }
  }
  return out.join('\n');
}
function setCodeBlockLang(node, lang) {
  if (!state.vditor) return;
  const blocks = els('#editor .vditor-ir [data-type="code-block"]');
  const idx = blocks.indexOf(node);
  if (idx < 0) return;
  const md = state.vditor.getValue();
  const newMd = replaceNthFenceLang(md, idx, lang || '');
  if (newMd !== md) state.vditor.setValue(newMd);
  hideCodeLangPicker();
}
function showCodeLangPicker(node) {
  codeLangNode = node;
  const wrap = el('#code-lang-picker');
  const sel = el('#code-lang-select');
  if (!wrap || !sel) return;
  const cur = fenceLangOf(node);
  const langs = codeLangOptions();
  let html = '<option value="">' + t('codeLang.plain') + '</option>';
  if (cur && langs.indexOf(cur) < 0) html += '<option value="' + cur.replace(/"/g, '&quot;') + '" selected>' + cur + '</option>';
  for (let i = 0; i < langs.length; i++) html += '<option value="' + langs[i] + '"' + (langs[i] === cur ? ' selected' : '') + '>' + langs[i] + '</option>';
  sel.innerHTML = html;
  const r = node.getBoundingClientRect();
  wrap.style.left = Math.max(8, r.right - 140) + 'px';
  wrap.style.top = Math.max(8, r.top + 2) + 'px';
  wrap.classList.remove('hidden');
}
function hideCodeLangPicker() {
  const w = el('#code-lang-picker');
  if (w) w.classList.add('hidden');
  codeLangNode = null;
}
function initCodeLangPicker() {
  const sel = el('#code-lang-select');
  if (!sel) return;
  sel.addEventListener('change', () => { if (codeLangNode) setCodeBlockLang(codeLangNode, sel.value); });
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.closest && e.target.closest('#code-lang-picker')) return;
    if (state.sourceMode) { hideCodeLangPicker(); return; }
    const node = (e.target && e.target.closest) ? e.target.closest('[data-type="code-block"]') : null;
    if (node) showCodeLangPicker(node);
    else if (codeLangNode && !(codeLangNode.contains && codeLangNode.contains(e.target))) hideCodeLangPicker();
  });
  // 悬停即可唤出语言选择器（提升可发现性：不必点进代码块就能看到/切换语言）。
  // mouseover 只在换到「另一个」代码块时才重建下拉（codeLangNode !== node），避免在同一块内
  // 鼠标移动反复重建 innerHTML 造成闪烁/丢焦点；mouseout 移出「代码块+选择器」且未在编辑时才收起。
  document.addEventListener('mouseover', (e) => {
    if (state.sourceMode) return;
    if (e.target && e.target.closest && e.target.closest('#code-lang-picker')) return;
    const node = (e.target && e.target.closest) ? e.target.closest('[data-type="code-block"]') : null;
    if (node && codeLangNode !== node) showCodeLangPicker(node);
  });
  document.addEventListener('mouseout', (e) => {
    const from = (e.target && e.target.closest) ? e.target.closest('[data-type="code-block"], #code-lang-picker') : null;
    if (!from) return;
    const to = (e.relatedTarget && e.relatedTarget.closest) ? e.relatedTarget.closest('[data-type="code-block"], #code-lang-picker') : null;
    if (to) return; // 仍在代码块或下拉选择器内
    const focused = (document.activeElement && document.activeElement.closest) ? document.activeElement.closest('[data-type="code-block"]') : null;
    if (focused) return; // 正在编辑该代码块，保留选择器
    hideCodeLangPicker();
  });
  document.addEventListener('mousedown', (e) => {
    const w = el('#code-lang-picker');
    if (w && !w.classList.contains('hidden') && !(e.target.closest && e.target.closest('#code-lang-picker'))) {
      const inBlock = e.target.closest && e.target.closest('[data-type="code-block"]');
      if (!inBlock) hideCodeLangPicker();
    }
  });
  document.addEventListener('scroll', hideCodeLangPicker, true);
  window.addEventListener('blur', hideCodeLangPicker);
}


function closeGutterMenu() {
  const m = el('#gutter-menu');
  if (m) m.classList.add('hidden');
}

function initGutterMenu() {
  const g = el('#line-gutter');
  const menu = el('#gutter-menu');
  if (!g || !menu) return;
  // 右键行号栏：专用小菜单「隐藏行号」（不弹正文右键菜单）
  g.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - mw - 4));
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - mh - 4));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  });
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢焦点
  el('#gm-hide').addEventListener('click', () => {
    closeGutterMenu();
    if (state.showLines) toggleLines();
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) closeGutterMenu();
  });
  window.addEventListener('blur', closeGutterMenu);
  window.addEventListener('resize', closeGutterMenu);
  // 左键点某行号：选中该行对应内容（渲染模式行号=块序号，源码模式=源码行号）
  g.addEventListener('click', (e) => {
    const ln = e.target.closest && e.target.closest('.ln');
    if (ln) selectLineAtGutter(+ln.dataset.n);
  });
}

function selectLineAtGutter(n) {
  if (state.sourceMode) {
    const ta = el('#source');
    if (!ta) return;
    const lines = ta.value.split('\n');
    const i = Math.min(Math.max(1, n), lines.length) - 1;
    let start = 0;
    for (let k = 0; k < i; k++) start += lines[k].length + 1;
    ta.focus();
    ta.setSelectionRange(start, start + lines[i].length);
    return;
  }
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  const kids = Array.from(reset.children).filter(k => k.nodeType === 1);
  const block = kids[n - 1];
  if (!block) return;
  reset.focus();
  const range = document.createRange();
  range.selectNodeContents(block);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  block.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- 标题栏（无框窗口）
const WIN_MAX_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" shape-rendering="geometricPrecision"><rect x="1.1" y="1.1" width="9.8" height="9.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const WIN_RESTORE_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" shape-rendering="geometricPrecision"><path d="M4.2 1.9h5.9v5.9" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="1.9" y="4.2" width="5.9" height="5.9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

function setMaxState(max) {
  const b = el('#win-max');
  if (b) { b.title = max ? t('common.restore') : t('common.maximize'); b.innerHTML = max ? WIN_RESTORE_SVG : WIN_MAX_SVG; }
  const bm = el('#bm-max');
  if (bm) bm.textContent = max ? t('common.restore') : t('common.maximize');
}

// R75-4b：全屏状态记录（视图菜单项的文案在每次打开菜单时按此实时取，无需重建）
function setFullState(full) {
  state.isFullScreen = !!full;
}

function initTitlebar() {
  const bar = el('#titlebar');
  const brand = el('#brand-tab');
  const menu = el('#brand-menu');
  if (!bar || !brand || !menu) return;
  const closeMenu = () => { menu.classList.add('hidden'); brand.classList.remove('open'); };
  brand.addEventListener('mousedown', (e) => e.preventDefault());
  brand.addEventListener('click', () => {
    if (!menu.classList.contains('hidden')) { closeMenu(); return; }
    const r = brand.getBoundingClientRect();
    menu.style.left = Math.max(4, r.left) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.classList.remove('hidden');
    brand.classList.add('open');
  });
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  els('#brand-menu [data-bm]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.bm;
    closeMenu();
    if (a === 'min') ms.invoke('window:minimize', {});
    else if (a === 'max') ms.invoke('window:maximize', {});
    else if (a === 'close') window.close();
    else if (a === 'move') toast(t('toast.moved'));
  }));
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !brand.contains(e.target)) closeMenu();
  });
  window.addEventListener('blur', closeMenu);
  // 窗口控制按钮
  el('#win-min').addEventListener('click', () => ms.invoke('window:minimize', {}));
  el('#win-max').addEventListener('click', () => ms.invoke('window:maximize', {}));
  el('#win-close').addEventListener('click', () => window.close());
  // 最大化/还原状态同步（拖顶边、双击等外部操作也能更新图标）
  ms.on('window:max-state', (max) => setMaxState(!!max));
  setMaxState(false);
  // R75-4b：全屏状态同步（视图菜单「全屏」/「退出全屏」切换）
  ms.on('window:full-state', (full) => setFullState(!!full));
  // 双击标题栏空白处切换最大化/还原
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || (e.target.closest && e.target.closest('.tab'))) return;
    ms.invoke('window:maximize', {});
  });
}

// ---------------------------------------------------------------- 右键菜单
function doPaste() {
  return ms.invoke('clipboard:read').then((text) => {
    if (text) {
      ensureEditorFocus();
      document.execCommand('insertText', false, text);
    }
  }).catch(() => {
    ensureEditorFocus();
    document.execCommand('paste');
  });
}

function initContextMenu() {
  const menu = el('#ctxmenu');
  const main = el('#main-col');
  if (!menu || !main) return;

  // R61：右键落在表格单元格内 → 显示「左/中/右对齐 + 清空选中单元格」。
  // 当前无单元格选区、或选区属于另一张表时，先把右键所在格设为单格选中；
  // 已有同表选区（含拖拽路径多选的零散集合）则沿用，实现「对选中的这些单元格
  // 单独设置对齐」
  function updateTableItems(target) {
    const cell = target.closest && !state.sourceMode ? target.closest('td,th') : null;
    const items = ['align-left', 'align-center', 'align-right', 'clear-cells']
      .map(id => menu.querySelector('[data-ctx="' + id + '"]'));
    const sep = el('#ctx-table-sep');
    const all = [sep].concat(items.filter(Boolean));
    if (!cell) { all.forEach(b => b.classList.add('hidden')); return; }
    const table = cell.closest('table');
    const idx = getIrTables().indexOf(table);
    const pos = cellPos(table, cell);
    if (idx < 0 || !pos) { all.forEach(b => b.classList.add('hidden')); return; }
    if (!TBL.sel || TBL.sel.table !== idx) {
      TBL.selAnchor = { table: idx, r: pos.r, c: pos.c };
      TBL.sel = { table: idx, r1: pos.r, c1: pos.c, r2: pos.r, c2: pos.c };
      renderTableSelection();
    }
    all.forEach(b => b.classList.remove('hidden'));
  }
  // R85-P2：右键落在「普通段落/标题」内 → 显示「在上方/下方插入段落」（从悬浮栏迁入右键菜单）。
  // 记录命中的顶层块 ctxParaBlock 供点击时传给 insertParagraph；表格/代码块/引用/列表/分隔线不显示。
  let ctxParaBlock = null;
  function updateParaItems(target) {
    const items = ['insert-para-above', 'insert-para-below']
      .map(id => menu.querySelector('[data-ctx="' + id + '"]'));
    const sep = el('#ctx-para-sep');
    const all = [sep].concat(items.filter(Boolean));
    const block = (!state.sourceMode) ? topLevelBlockOf(target) : null;
    if (!block || !domBlockEligible(block)) { all.forEach(b => b.classList.add('hidden')); ctxParaBlock = null; return; }
    ctxParaBlock = block;
    all.forEach(b => b.classList.remove('hidden'));
  }
  function close() { menu.classList.add('hidden'); }

  main.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('#fbar')) return; // 悬浮工具栏保留系统菜单
    e.preventDefault();
    updateTableItems(e.target);
    updateParaItems(e.target);
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth - 4) x = Math.max(4, window.innerWidth - mw - 4);
    if (y + mh > window.innerHeight - 4) y = Math.max(4, window.innerHeight - mh - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  });

  // 点菜单按钮时不抢焦点，避免正文选区被清空
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) close();
  });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);

  els('#ctxmenu [data-ctx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.ctx;
      close();
      if (act === 'cut') { ensureEditorFocus(); document.execCommand('cut'); }
      else if (act === 'copy') { document.execCommand('copy'); }
      else if (act === 'paste') { doPaste(); }
      else if (act === 'select-all') { ensureEditorFocus(); document.execCommand('selectAll'); }
      else if (act === 'align-left' || act === 'align-center' || act === 'align-right') {
        // R61：对选中单元格单独设置对齐。路径多选传精确集合（只改选中的格），
        // 矩形选区走 R47 原语义（表头整列写属性 → 持久化到 md 对齐标记）
        const s = TBL.sel;
        if (!s) { toast(t('toast.selCellFirst')); return; }
        applyCellAlign(act.slice(6), null, (s.cells && s.cells.length) ? s.cells : null);
      }
      else if (act === 'clear-cells') {
        if (TBL.sel) clearSelectedCells();
        else toast(t('toast.selCellFirst'));
      }
      else if (act === 'insert-para-above' || act === 'insert-para-below') {
        // R85-P2：右键菜单「在上方/下方插入段落」（从悬浮栏迁入）；ctxParaBlock 为右键命中的合格块
        insertParagraph(act === 'insert-para-above' ? 'above' : 'below', ctxParaBlock);
      }
      // R50：表格结构操作已从右键菜单移除，全部收进单击表格弹出的工具条（对齐/清空除外）
    });
  });
}

// ---------------------------------------------------------------- 查找/替换
function buildTextIndex(rootEl) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.length) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const nodes = [], starts = [];
  let total = 0;
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
    starts.push(total);
    total += walker.currentNode.nodeValue.length;
  }
  return { nodes, starts, text: nodes.map(n => n.nodeValue).join('') };
}

function locateOffset(idx, index) {
  let lo = 0, hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return { node: index.nodes[lo], offset: idx - index.starts[lo] };
}

// R75-8c：全字匹配——匹配项前后紧邻的字符都不是「词字符」（字母/数字/下标/中日韩汉字），
// 即该词不是更长词的一部分（对应 Word 的「全字匹配」）。对中文按「不被更长连续汉字包含」判定。
const WORD_CHAR_RE = /[A-Za-z0-9_\u4e00-\u9fff\u3400-\u4dbf]/;
function isWholeWord(hay, at, len) {
  const b = at > 0 ? hay[at - 1] : '';
  const a = at + len < hay.length ? hay[at + len] : '';
  return !(b && WORD_CHAR_RE.test(b)) && !(a && WORD_CHAR_RE.test(a));
}
// 在（可能已小写的）hay 中收集 nd 的全部匹配偏移；wholeWord 时只保留整词匹配
function collectMatches(hay, nd, wholeWord) {
  const list = [];
  if (!nd.length) return list;
  let i = hay.indexOf(nd);
  while (i !== -1) {
    if (!wholeWord || isWholeWord(hay, i, nd.length)) list.push(i);
    i = hay.indexOf(nd, i + nd.length);
  }
  return list;
}

function computeDomMatches(needle, caseSensitive, wholeWord) {
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset || !needle) return { list: [], index: null };
  const index = buildTextIndex(reset);
  const hay = caseSensitive ? index.text : index.text.toLowerCase();
  const nd = caseSensitive ? needle : needle.toLowerCase();
  const list = collectMatches(hay, nd, wholeWord);
  return { list, index };
}

function selectDomMatch(m, index) {
  const a = locateOffset(m, index);
  const b = locateOffset(m + el('#find-input').value.length, index);
  const sel = window.getSelection();
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, Math.min(b.offset, b.node.nodeValue.length));
    sel.removeAllRanges();
    sel.addRange(range);
    const focusEl = a.node.parentElement;
    if (focusEl) focusEl.scrollIntoView({ block: 'center' });
  } catch (e) { }
}

function updateFindCount() {
  const { total } = state.findState;
  el('#find-count').textContent = total ? `${state.findState.idx + 1}/${total}` : (el('#find-input').value ? '0/0' : '');
}

function findNext(backward) {
  const needle = el('#find-input').value;
  if (!needle) return;
  const cs = el('#find-case').checked;
  const ww = el('#find-word').checked;
  // R90：阅读模式查找 = 原文偏移定位到分块 + 块内高亮
  if (isReader()) {
    const tab = activeTab();
    const nd = cs ? needle : needle.toLowerCase();
    const hay = cs ? tab.content : tab.content.toLowerCase();
    const key = nd + '|' + ww;
    if (!state.findState || state.findState.rkey !== key) {
      const M = collectMatches(hay, nd, ww).slice(0, 9999);
      state.findState = { rkey: key, matches: M, idx: -1, total: M.length };
    }
    const M = state.findState.matches;
    if (!M.length) { state.findState.idx = -1; updateFindCount(); toast(t('toast.notFound', { q: needle })); return; }
    state.findState.idx = backward
      ? (state.findState.idx <= 0 ? M.length - 1 : state.findState.idx - 1)
      : (state.findState.idx + 1) % M.length;
    readerRevealMatch(M[state.findState.idx], needle.length);
    updateFindCount();
    return;
  }
  if (state.sourceMode) {
    const ta = el('#source');
    let hay = ta.value, nd = needle;
    if (!cs) { hay = hay.toLowerCase(); nd = nd.toLowerCase(); }
    const matches = collectMatches(hay, nd, ww);
    if (!matches.length) { toast(t('toast.notFound', { q: needle })); return; }
    const pos = backward ? ta.selectionStart : ta.selectionEnd;
    let idx;
    if (backward) {
      const before = matches.filter(m => m < pos);
      idx = before.length ? before[before.length - 1] : matches[matches.length - 1];
    } else {
      const after = matches.find(m => m >= pos);
      idx = (after === undefined) ? matches[0] : after;
    }
    ta.focus();
    ta.setSelectionRange(idx, idx + needle.length);
    const linesBefore = hay.slice(0, idx).split('\n').length;
    ta.scrollTop = (linesBefore - 4) * 24;
    return;
  }
  const { list, index } = computeDomMatches(needle, cs, ww);
  state.findState.total = list.length;
  if (!list.length) {
    state.findState.idx = -1;
    updateFindCount();
    toast(t('toast.notFound', { q: needle }));
    return;
  }
  if (backward) state.findState.idx = state.findState.idx <= 0 ? list.length - 1 : state.findState.idx - 1;
  else state.findState.idx = (state.findState.idx + 1) % list.length;
  selectDomMatch(list[state.findState.idx], index);
  updateFindCount();
}

async function replaceOne() {
  const needle = el('#find-input').value;
  const rep = el('#replace-input').value;
  if (isReader()) { toast(t('toast.readerNoReplace')); return; }
  if (!needle) return;
  const cs = el('#find-case').checked;
  const ww = el('#find-word').checked;
  if (state.sourceMode) {
    const ta = el('#source');
    if (ta.selectionEnd > ta.selectionStart && ta.value.slice(ta.selectionStart, ta.selectionEnd).toLowerCase() === needle.toLowerCase()) {
      ta.setRangeText(rep, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
      return;
    }
    findNext(false);
    return;
  }
  const { list } = computeDomMatches(needle, cs, ww);
  if (!list.length) return;
  const cur = state.findState.idx < 0 ? 0 : Math.min(state.findState.idx, list.length - 1);
  const src = state.vditor.getValue();
  // 在源码中定位第 cur 处（整词）匹配并替换
  let hay = cs ? src : src.toLowerCase();
  let nd = cs ? needle : needle.toLowerCase();
  const matches = collectMatches(hay, nd, ww);
  const at = cur < matches.length ? matches[cur] : -1;
  if (at < 0) return;
  const newText = src.slice(0, at) + rep + src.slice(at + nd.length);
  state.vditor.setValue(newText);
  setDirty(true);
  refreshLinesSoon();
  fixImagesSoon();
  state.findState.idx = cur - 1;
  setTimeout(() => findNext(false), 80);
}

// R75-8c：在字符串中替换全部（可选整词）匹配，从后往前替换避免偏移失效
function replaceMatchesIn(src, needle, rep, cs, ww) {
  let hay = cs ? src : src.toLowerCase();
  let nd = cs ? needle : needle.toLowerCase();
  const matches = collectMatches(hay, nd, ww);
  let out = src;
  for (let i = matches.length - 1; i >= 0; i--) {
    const at = matches[i];
    out = out.slice(0, at) + rep + out.slice(at + nd.length);
  }
  return { out, count: matches.length };
}

async function replaceAll() {
  const needle = el('#find-input').value;
  const rep = el('#replace-input').value;
  if (isReader()) { toast(t('toast.readerNoReplace')); return; }
  if (!needle) return;
  const cs = el('#find-case').checked;
  const ww = el('#find-word').checked;
  let count = 0;
  if (state.sourceMode) {
    const ta = el('#source');
    const r = replaceMatchesIn(ta.value, needle, rep, cs, ww);
    count = r.count;
    ta.value = r.out;
    ta.dispatchEvent(new Event('input'));
  } else {
    const src = state.vditor.getValue();
    const r = replaceMatchesIn(src, needle, rep, cs, ww);
    count = r.count;
    if (!count) { toast(t('toast.notFound', { q: needle })); return; }
    state.vditor.setValue(r.out);
    setDirty(true);
    refreshLinesSoon();
    fixImagesSoon();
  }
  toast(t('toast.replaced', { n: count }));
  updateFindCount();
}

function toggleFind(show) {
  const fb = el('#findbar');
  const showNow = show === undefined ? fb.classList.contains('hidden') : show;
  fb.classList.toggle('hidden', !showNow);
  if (showNow) {
    const sel = window.getSelection().toString();
    if (sel && sel.length < 80) el('#find-input').value = sel;
    el('#find-input').focus();
    el('#find-input').select();
    state.findState = { idx: -1, total: 0 };
    updateFindCount();
  }
}

// R75-8b：查找面板可拖动——用 left/top 精确定位（去掉初始的居中 transform），位置记忆于 localStorage
function applyFindbarPos(x, y) {
  const fb = el('#findbar');
  if (!fb) return;
  fb.style.transform = 'none';
  fb.style.left = Math.round(x) + 'px';
  fb.style.top = Math.round(y) + 'px';
}

// ---------------------------------------------------------------- 主题/视图
function applyThemeDom(theme) {
  document.body.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function applyFontSize() {
  document.documentElement.style.setProperty('--fs', (state.settings.fontSize || 16) + 'px');
}

// 字号持久化防抖：连续缩放（Ctrl+滚轮）时不每级都写盘
let fontSizePersistTimer = null;
function persistFontSizeSoon() {
  clearTimeout(fontSizePersistTimer);
  fontSizePersistTimer = setTimeout(() => {
    ms.invoke('app:set-settings', { partial: { fontSize: state.settings.fontSize || 16 } });
  }, 300);
}

// 运行时换肤：Vditor 公开 setTheme 只切换 vditor--dark 类与两个 CSS <link>（内容主题 + hljs 代码主题），
// 不销毁/重建编辑器、不重新解析文档 —— 大文档切换主题秒切、不丢光标、无整页白闪。
// contentTheme/codeTheme 参数不变时 Vditor 内部判定 href 相同即为 no-op，重复调用安全。
function applyEditorTheme() {
  if (!state.vditor || typeof state.vditor.setTheme !== 'function') return false;
  try {
    state.vditor.setTheme(
      state.settings.theme === 'dark' ? 'dark' : 'light',
      resolveContentTheme(),
      resolveHlStyle()
    );
    return true;
  } catch (e) {
    return false;
  }
}

function setTheme(theme) {
  state.settings.theme = theme;
  applyThemeDom(theme);
  applyFontSize();
  // 优先运行时换肤；仅当编辑器尚未就绪或运行时 API 不可用时才整体重建
  if (!applyEditorTheme()) recreateEditor(getCurrentContent());
  ms.invoke('app:native-theme', { theme });
}

// ---------------------------------------------------------------- 源代码模式
// 源码模式下用户是否编辑过：退出源码模式时仅在有编辑的情况下才用 textarea
// 内容回灌 IR 编辑器（否则会用 textarea 里的旧内容覆盖刚打开的新文档）
let sourceEdited = false;

function applySourceMode(keepSourceValue = false) {
  const editorEl = el('#editor');
  const ta = el('#source');
  const fbar = el('#fbar');
  // 关键：源码模式下不再整条隐藏悬浮栏（那样「源码」按钮自身也消失，无法退出）。
  // 改为加 source-mode 类：CSS 收起其余按钮，只保留「退出源码」按钮，随时可点回。
  if (fbar) {
    fbar.classList.toggle('source-mode', state.sourceMode);
    const srcBtn = fbar.querySelector('.fbar-src');
    if (srcBtn) {
      const label = srcBtn.querySelector('.fbar-src-label');
      if (label) label.textContent = state.sourceMode ? t('src.exitLabel') : t('src.label');
      srcBtn.title = state.sourceMode ? t('fbar.srcExit') : t('fbar.src');
    }
  }
  if (state.sourceMode) {
    // keepSourceValue（loadTabIntoEditor 载入源码模式标签）：ta.value 已由 setContent 装入
    // 该标签内容，而 IR DOM 还是上一个标签的文档——不能从 IR DOM 读回（会串文档）
    if (!keepSourceValue) {
      ta.value = state.vditor ? state.vditor.getValue() : '';
      sourceEdited = false;
    }
    editorEl.classList.add('hidden');
    ta.classList.remove('hidden');
  } else {
    const v = ta.value;
    ta.classList.add('hidden');
    editorEl.classList.remove('hidden');
    if (v && sourceEdited && state.vditor) {
      state.vditor.setValue(v);
      // R40：整篇重渲染后重置 undo 基线，避免跨状态污染
      try { state.vditor.clearStack(); } catch (e) { }
    }
    sourceEdited = false;
  }
  // 行号栏样式跟随源码/渲染模式（源码模式行高不同）
  const g = el('#line-gutter');
  if (g) g.classList.toggle('src', state.sourceMode);
  // 源码模式行号栏必须留在流内（贴 #source 左缘）；居中类的即时切换避免 40ms 内行号浮在中间
  const row = el('#editor-row');
  if (row) row.classList.toggle('centered', !state.sourceMode && isCenteredContent());
}

function toggleSource() {
  state.sourceMode = !state.sourceMode;
  // 表格交互（R45）：源码模式下无 IR 表格 → 清除选区/工具条；返回 IR 后重放列宽行高
  if (state.sourceMode) clearTableSelection();
  else setTimeout(reapplyTableLayout, 150);
  applySourceMode();
  if (!state.sourceMode) {
    setDirty(true);
    fixImagesSoon();
    scheduleOutline();
  }
  refreshLinesSoon();
  refreshToolbarState();
  sendMenuState();
  setTimeout(() => { layoutLineGutter(); updateCursorPos(); }, 40);
  toast(state.sourceMode ? t('toast.sourceSwitched') : t('toast.wysiwygSwitched'));
}

// ---------------------------------------------------------------- 工具栏动作
// 工具栏点击前确保编辑器持有焦点：焦点飘走时（如刚点过顶部工具栏按钮），
// 格式化命令会作用到空选区上，表现为“点了没反应”
function ensureEditorFocus() {
  if (state.sourceMode || !state.vditor) return;
  const ae = document.activeElement;
  const box = el('#editor');
  const inside = ae && box && box.contains(ae);
  if (!inside) {
    try { state.vditor.focus(); } catch (e) { }
  }
}

// 正文 ↔ 悬浮栏联动：根据光标当前所处格式高亮对应工具按钮
function refreshToolbarState() {
  const bar = el('#fbar');
  if (!bar) return;
  const setOn = (sel, on) => bar.querySelectorAll(sel).forEach(b => b.classList.toggle('on', !!on));
  // 先全部清除
  setOn('[data-fact="bold"],[data-fact="italic"],[data-fact="inline-code"],[data-fact="link"],[data-fact="quote"]', false);
  setOn('[data-menu="list"],[data-menu="head"]', false);
  setOn('#fbar-menu-head [data-fact^="h"]', false);
  if (state.sourceMode || !state.vditor) return;
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.anchorNode) return;
  let start = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
  if (!start || start.nodeType !== 1 || !reset.contains(start)) return;

  // 向上遍历祖先：行内格式（加粗/斜体/行内代码/链接）
  let n = start, inPre = false;
  while (n && n !== reset) {
    const tag = n.tagName;
    if (tag === 'PRE') { inPre = true; break; }
    if (tag === 'CODE' && !inPre) setOn('[data-fact="inline-code"]', true);
    // IR 模式下链接不生成 <a>，而是 span[data-type="a"] / span.vditor-ir__link
    if (tag === 'A' || (n.dataset && n.dataset.type === 'a') || (n.classList && n.classList.contains('vditor-ir__link'))) setOn('[data-fact="link"]', true);
    if (tag === 'STRONG' || (n.dataset && n.dataset.type === 'strong')) setOn('[data-fact="bold"]', true);
    if (tag === 'EM' || (n.dataset && n.dataset.type === 'em')) setOn('[data-fact="italic"]', true);
    n = n.parentElement;
  }
  if (inPre) return; // 代码块内部不再联动其它状态

  // 块级状态：标题 / 引用 / 列表（取光标所在块的直接父级判断）
  let cur = start, block = null, li = null, d = 0;
  while (cur && cur !== reset && d < 60) {
    if (cur.parentElement === reset) { block = cur; break; }
    if (cur.tagName === 'LI') li = cur;
    cur = cur.parentElement; d++;
  }
  if (block) {
    const tag = block.tagName;
    if (/^H[1-6]$/.test(tag)) {
      setOn('[data-menu="head"]', true);
      setOn('#fbar-menu-head [data-fact="h' + tag[1] + '"]', true);
      return;
    }
    if (tag === 'BLOCKQUOTE') setOn('[data-fact="quote"]', true);
    if (tag === 'UL' || tag === 'OL') setOn('[data-menu="list"]', true);
  } else if (li) {
    // 光标在列表项深层结构里（block 未直接命中 reset 子级时兜底）
    setOn('[data-menu="list"]', true);
  }
}

// 光标位于未闭合的行内格式（加粗/斜体等）内部时，先把它移到格式之外。
// Vditor IR 用 marker span（vditor-ir__marker）承载行内格式，若在格式内部直接插入
// 表格/代码块等块级内容，会破坏行内结构（** 被拆成单独一行、文本并入表格单元格等）。
function guardCaretForBlockInsert() {
  if (state.sourceMode || !state.vditor) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const caretNode = range.startContainer;
  // 向上找“行内格式容器”：直接子元素中含 vditor-ir__marker 的元素
  let n = caretNode.nodeType === 3 ? caretNode.parentElement : caretNode;
  let container = null;
  for (let d = 0; n && n !== document.body && d < 8; d++) {
    if (n.nodeType === 1) {
      if (n.classList && n.classList.contains('vditor-ir__marker')) {
        // 光标正好停在 marker 符号上（**）：移到整个格式 run 的末尾 marker 之后
        let w = n.parentElement;
        let wm = w && Array.from(w.children).filter(c => c.classList && c.classList.contains('vditor-ir__marker'));
        const target = (wm && wm.length >= 2) ? wm[wm.length - 1] : n;
        const r = document.createRange();
        r.setStartAfter(target); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
      if (Array.from(n.children).some(c => c.classList && c.classList.contains('vditor-ir__marker'))) {
        container = n;
        break;
      }
    }
    n = n.parentElement;
  }
  if (!container) return;
  const markers = Array.from(container.children).filter(c => c.classList && c.classList.contains('vditor-ir__marker'));
  if (!markers.length) return;
  const first = markers[0], last = markers[markers.length - 1];
  const cR = document.createRange();
  try { cR.setStart(caretNode, range.startOffset); cR.collapse(true); } catch (e) { return; }
  const fR = document.createRange(); fR.selectNodeContents(first); fR.collapse(false); // 起始 marker 之后
  const lR = document.createRange(); lR.selectNodeContents(last); lR.collapse(true);   // 结束 marker 之前
  const afterOpen = cR.compareBoundaryPoints(Range.END_TO_START, fR) > 0;
  const beforeClose = cR.compareBoundaryPoints(Range.END_TO_START, lR) < 0;
  if (afterOpen && beforeClose) {
    const r = document.createRange();
    r.setStartAfter(last); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  }
}

const BLOCK_TOOL_TYPES = { 'code': 1, 'line': 1 };

function clickToolbar(type) {
  if (!state.sourceMode) {
    ensureEditorFocus();
    // R81-2：光标在表格单元格内时，块级插入（列表/引用/代码块/分隔线）不能就地生效
    // （会把整表拍扁）→ 改插到整张表格之后，表格原样保留
    if (CELL_BLOCK_TYPES[type] && caretInCell()) { insertBlockAfterTable(type); return; }
    if (BLOCK_TOOL_TYPES[type]) guardCaretForBlockInsert();
  }
  const btn = el(`#editor .vditor-toolbar [data-type="${type}"]`);
  if (btn) btn.click();
  else toast(t('toast.opUnavailable'));
}

function setHeading(level) {
  if (state.sourceMode) return;
  ensureEditorFocus();
  const btn = el('#editor .vditor-toolbar [data-type="headings"]');
  if (!btn) return;
  // R40：Vditor 标题面板是 headings 工具项下的 .vditor-panel--arrow（不是 .vditor-panel），
  // 面板按钮标记为 data-tag="h1".."h6"（不是 data-type）。面板 DOM 常驻（仅 display 切换），
  // 可直接程序化点击；不再依赖旧选择器（永远落空导致标题操作静默失效）
  const item = btn.closest('.vditor-toolbar__item') || btn.parentElement;
  const panelBtn = item && item.querySelector('.vditor-panel--arrow button[data-tag="h' + level + '"]');
  if (!panelBtn) return;
  btn.click(); // 同步 Vditor 自身状态（打开/收起面板）
  setTimeout(() => {
    if (item.contains(panelBtn)) {
      panelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } else {
      // 兜底：Vditor 原生标题热键（Windows 为 Alt+Ctrl+数字，见 vendor matchHotKey）
      const target = el('#editor .vditor-ir .vditor-ir__node, #editor [contenteditable]');
      if (target) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: String(level), code: 'Digit' + level, ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      }
    }
    // 关闭下拉面板
    setTimeout(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, 60);
  }, 60);
}

// R75-7：取光标/选区所在正文块当前的标题级别（0=段落/非标题，1..6）。
// 选区跨多个块时取首个块的级别；正文块是 .vditor-reset 的直接子元素 h1..h6。
function caretHeadingLevel() {
  if (state.sourceMode) return 0;
  const sel = window.getSelection();
  let node = null;
  if (sel && sel.rangeCount) {
    node = sel.anchorNode;
  } else if (state.vditor) {
    // 无选区时退回 Vditor 内部记录的光标位置
    try {
      const pos = state.vditor.getCursorIndex && state.vditor.getCursorIndex();
      node = pos;
    } catch (e) { /* ignore */ }
  }
  if (!node) return 0;
  if (node.nodeType === 3) node = node.parentElement;
  if (!node) return 0;
  let p = node;
  while (p && p !== document.body) {
    if (p.parentNode && p.parentNode.classList && p.parentNode.classList.contains('vditor-reset')) {
      const m = /^H([1-6])$/.exec(p.tagName || '');
      return m ? parseInt(m[1], 10) : 0;
    }
    p = p.parentNode;
  }
  return 0;
}

// R75-7：提升/降低标题级别。段落(0)提升→H1；H1 不能再提升；H6 不能再降低。
function changeHeadingLevel(delta) {
  if (state.sourceMode) return;
  const cur = caretHeadingLevel();
  let target;
  if (cur === 0) {
    if (delta < 0) return; // 段落不能「降低」
    target = 1; // 段落「提升」→ H1
  } else {
    target = cur - delta; // delta<0 提升（级别变小），delta>0 降低（级别变大）
  }
  if (target < 1 || target > 6 || target === cur) return;
  setHeading(target);
}

// ---------------------------------------------------------------- R80-3：在上方/下方插入段落 + 悬浮栏
// 核心：把光标/鼠标所在「顶层块」映射到 markdown 的行区间，在其上/下方 splice 一行 `&nbsp;`
// （markdown 里空行只是分隔符、不构成段落，必须用 `&nbsp;` 才能生成一个真实可点击、可输入的空段落），
// 然后按既有套路 setValue 整篇回写。空段落随后由用户点进去输入。
let paraBarShown = false;   // 悬浮栏当前是否可见
let paraBarBlock = null;    // 悬浮栏锚定的顶层块
let paraBarHideTimer = null;// 延迟隐藏定时器（离开合格块后短暂划过相邻块不闪）
let paraBarBound = false;   // 悬浮栏监听只绑一次

// 解析 md 的顶层块序列（与 .vditor-reset 直接子元素同序、同数），返回 [{start,end,kind}]（行号，含端点）。
// 解析时按块类型归类，用于与 DOM 块类型做逐位比对，防止索引错位导致插错位置。
function mdTopLevelBlocks(md) {
  const lines = (md || '').split('\n');
  const out = [];
  const fenceRe = /^ {0,3}(`{3,}|~{3,})/;
  const isBlank = (l) => /^\s*$/.test(l);
  const isHeading = (l) => /^ {0,3}#{1,6}(\s|$)/.test(l);
  const isHr = (l) => /^ {0,3}((-[ \t]?){3,}|(\*[ \t]?){3,}|(_[ \t]?){3,})$/.test(l);
  const isQuote = (l) => /^ {0,3}>\s?/.test(l);
  const isListItem = (l) => /^ {0,3}([-*+]|\d{1,9}[.)])\s+/.test(l);
  const isTableRow = (l) => l.indexOf('|') !== -1;
  const fenceCh = (l) => { const m = l.match(fenceRe); return m ? m[1][0] : null; };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const start = i;
    const fc = fenceCh(line);
    if (fc) {
      i++;
      while (i < lines.length) {
        const c2 = fenceCh(lines[i]);
        if (c2 === fc && /^\s*(`{3,}|~{3,})\s*$/.test(lines[i])) break; // 闭合围栏
        i++;
      }
      if (i < lines.length) i++; // 吃掉闭合围栏行
      out.push({ start, end: Math.min(i - 1, lines.length - 1), kind: 'code' });
      continue;
    }
    if (isHeading(line)) { out.push({ start, end: start, kind: 'h' }); i++; continue; }
    if (isHr(line)) { out.push({ start, end: start, kind: 'hr' }); i++; continue; }
    if (isQuote(line)) { while (i < lines.length && isQuote(lines[i])) i++; out.push({ start, end: i - 1, kind: 'quote' }); continue; }
    if (isTableRow(line) && i + 1 < lines.length && isTableRow(lines[i + 1])) {
      while (i < lines.length && !isBlank(lines[i]) && isTableRow(lines[i])) i++;
      out.push({ start, end: i - 1, kind: 'table' }); continue;
    }
    if (isListItem(line)) {
      while (i < lines.length && !isBlank(lines[i]) && (isListItem(lines[i]) || /^ {2,}\S/.test(lines[i]) || isTableRow(lines[i]))) i++;
      out.push({ start, end: i - 1, kind: 'list' }); continue;
    }
    while (i < lines.length && !isBlank(lines[i]) && !isHeading(lines[i]) && !isQuote(lines[i]) && !isHr(lines[i]) && !fenceCh(lines[i])) i++;
    out.push({ start, end: i - 1, kind: 'p' });
  }
  return out;
}

// DOM 顶层块 → 与 mdTopLevelBlocks 同口径的类型
function domBlockKind(el) {
  const t = el && el.tagName;
  if (t === 'P') return 'p';
  if (t && /^H[1-6]$/.test(t)) return 'h';
  if (t === 'UL' || t === 'OL') return 'list';
  if (t === 'BLOCKQUOTE') return 'quote';
  if (t === 'TABLE') return 'table';
  if (t === 'HR') return 'hr';
  return 'code'; // DIV（围栏代码块容器）及其它容器
}

// 是否「可插入段落」的块：仅普通段落与标题。表格/代码块/引用/列表/分隔线均不适用。
function domBlockEligible(el) {
  if (!el || !el.tagName) return false;
  return el.tagName === 'P' || /^H[1-6]$/.test(el.tagName);
}

// 从节点向上找它所属的顶层块（.vditor-reset 的直接子元素）
function topLevelBlockOf(node) {
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return null;
  let b = (node && node.nodeType === 3) ? node.parentElement : node;
  if (!b || b === document.body) return null;
  while (b && b.parentElement && b.parentElement !== reset) b = b.parentElement;
  return (b && b.parentElement === reset) ? b : null;
}

// 光标/选区所在的顶层块（菜单项用）
function currentTopLevelBlock() {
  let node = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount) node = sel.anchorNode;
  return topLevelBlockOf(node);
}

// R82：setValue 会异步重渲染（原块节点被替换）。轮询定位到「新插入的空段落」（html-entity &nbsp; 块），
// 把光标移入其预览节点——用户可立即输入，且连续「插入段落」不再因光标掉到文档根而报「当前块不支持插入」。
// origIdx=原块 DOM 索引；above→新块落在 origIdx（原块后移一位），below→新块落在 origIdx+1。
function placeCaretInNewPara(origIdx, dir) {
  if (state.sourceMode || origIdx == null) return;
  let tries = 25;
  const attempt = () => {
    if (state.sourceMode) return;
    const reset = el('.vditor-ir .vditor-reset');
    if (!reset) { if (--tries > 0) setTimeout(attempt, 60); return; }
    const ni = dir === 'above' ? origIdx : origIdx + 1;
    const nb = reset.children[ni];
    const isNew = nb && nb.tagName === 'P' && nb.textContent.indexOf('\u00a0') !== -1;
    if (!isNew) { if (--tries > 0) setTimeout(attempt, 60); return; }
    try {
      const pv = nb.querySelector('.vditor-ir__preview') || nb;
      const node = (pv.firstChild && pv.firstChild.nodeType === 3) ? pv.firstChild : pv;
      const range = document.createRange();
      range.setStart(node, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ed = el('.vditor-ir');
      if (ed) ed.focus();
      nb.scrollIntoView({ block: 'nearest' });
    } catch (e) {}
  };
  attempt();
}
// 在当前顶层块之上/之下插入一个空段落。dir: 'above' | 'below'；blockEl 缺省时取光标所在块。
function insertParagraph(dir, blockEl) {
  if (state.sourceMode) { toast(t('toast.wysiwygParaFirst')); return; }
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) { toast(t('toast.editorNotReady')); return; }
  blockEl = blockEl || currentTopLevelBlock();
  if (!blockEl || !domBlockEligible(blockEl)) { toast(t('toast.blockNoPara')); return; }
  const md = state.vditor.getValue().replace(/\r\n/g, '\n'); // R82：用实时 getValue()（editorMdBaseline 可能返回过期 tab.content，致 md 与 DOM 顶层块索引错位）
  const ranges = mdTopLevelBlocks(md);
  const idx = Array.prototype.indexOf.call(reset.children, blockEl);
  const r = idx >= 0 ? ranges[idx] : null;
  if (!r || r.kind !== domBlockKind(blockEl)) { toast(t('toast.caretLost')); return; }
  const lines = md.split('\n');
  let newLines;
  if (dir === 'above') newLines = lines.slice(0, r.start).concat(['&nbsp;', '']).concat(lines.slice(r.start));
  else newLines = lines.slice(0, r.end + 1).concat(['', '&nbsp;']).concat(lines.slice(r.end + 1));
  state.vditor.setValue(newLines.join('\n'));
  setDirty(true);
  refreshLinesSoon();
  fixImagesSoon();
  hideParaBar(); // 结构已变，悬浮栏需按新结构重算
  placeCaretInNewPara(idx, dir); // R82：光标移入新插入的空段落（可立即输入，连续插入不再失败）
}

// ---------------- R80-3 悬浮栏 ----------------
function positionParaBar(blockEl) {
  const bar = el('#para-bar');
  if (!bar || !blockEl || !blockEl.isConnected) return;
  const r = blockEl.getBoundingClientRect();
  const bw = bar.offsetWidth || 160, bh = bar.offsetHeight || 30;
  let x = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left));
  let y = r.top - bh - 8; // 默认在块上方；顶部空间不足则移到块下方
  if (y < 54) y = Math.min(window.innerHeight - bh - 8, r.bottom + 8);
  bar.style.left = Math.round(x) + 'px';
  bar.style.top = Math.round(y) + 'px';
}

function showParaBar(blockEl) {
  const bar = el('#para-bar');
  if (!bar || !blockEl || !blockEl.isConnected) return;
  bar.classList.remove('hidden');
  paraBarShown = true;
  paraBarBlock = blockEl;
  positionParaBar(blockEl);
}

function hideParaBar() {
  const bar = el('#para-bar');
  if (bar) bar.classList.add('hidden');
  paraBarShown = false;
  paraBarBlock = null;
  if (paraBarHideTimer) { clearTimeout(paraBarHideTimer); paraBarHideTimer = null; }
}

// 命中合格块立即显示（「鼠标在此即弹出」），离开到非合格区则延迟 150ms 收起（短暂划过相邻块不闪）
function onParaBarHover(e) {
  if (state.sourceMode) { if (paraBarShown) hideParaBar(); return; }
  if (paraBarShown && paraBarBlock && !paraBarBlock.isConnected) { paraBarShown = false; paraBarBlock = null; } // 结构已重建
  const t = e.target;
  if (t && t.closest && t.closest('#para-bar')) { if (paraBarHideTimer) { clearTimeout(paraBarHideTimer); paraBarHideTimer = null; } return; } // 悬停在悬浮栏自身：保持可见并取消待隐藏
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) { if (paraBarShown) hideParaBar(); return; }
  const block = topLevelBlockOf(t);
  if (block && domBlockEligible(block)) {
    if (paraBarHideTimer) { clearTimeout(paraBarHideTimer); paraBarHideTimer = null; }
    if (paraBarShown && paraBarBlock === block) return; // 已在正确位置
    showParaBar(block);
  } else {
    if (!paraBarShown) return;
    if (paraBarHideTimer) clearTimeout(paraBarHideTimer);
    paraBarHideTimer = setTimeout(() => { paraBarHideTimer = null; hideParaBar(); }, 500); // R83-P3：放宽到 500ms，悬停可从容移到栏上点击
  }
}

function bindParaBar() {
  // R85-P2：段落悬浮栏（鼠标上下移动自动弹出「在上方/下方插入段落」）已整体停用——该两项
  // 改放到正文右键菜单（见 initContextMenu 的 insert-para-above / insert-para-below）。
  // 保留本函数空实现仅为兼容既有调用；不再绑定 mousemove，#para-bar 恒保持 hidden。
}

// ---------------------------------------------------------------- 表格：行列选择 + 行/列操作
const TP_ROWS = 8, TP_COLS = 8;

// ---------------- R81-2 表格单元格内插入 ----------------
// 表格单元格是 markdown 的「单行内联」内容：可容纳 图片 / 链接 / 行内公式 等内联元素；
// 但装不下 列表 / 引用 / 代码块 / 分隔线 等「块级」元素——直接用 Vditor 的块级工具按钮
// 会把整张表拍扁破坏（实测：单元格内点「无序列表」→ 全表变成 `* A1B1C1...`）。
// 故光标在单元格内时：内联类就地插入（Vditor insertValue 对纯内联 md 不破坏表格）；
// 块级类改插到「整张表格之后」（前后补空行），表格原样保留。
const CELL_BLOCK_TYPES = { 'list': 1, 'ordered-list': 1, 'check': 1, 'quote': 1, 'code': 1, 'line': 1 };
// 光标/选区所在单元格 → {table, cell, r, c, tableIndex} 或 null
function caretInCell() {
  if (state.sourceMode) return null;
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let n = sel.anchorNode;
  if (!n) return null;
  let cell = (n.nodeType === 3) ? n.parentElement : n;
  while (cell && cell !== reset) {
    if (cell.tagName === 'TD' || cell.tagName === 'TH') break;
    cell = cell.parentElement;
  }
  if (!cell || (cell.tagName !== 'TD' && cell.tagName !== 'TH')) return null;
  const table = cell.closest('table');
  if (!table) return null;
  const tableIndex = getIrTables().indexOf(table);
  if (tableIndex < 0) return null;
  const rows = Array.from(table.querySelectorAll('tr'));
  const tr = cell.parentElement;
  return { table, cell, r: rows.indexOf(tr), c: Array.from(tr.children).indexOf(cell), tableIndex };
}
// 按保存坐标把光标移回单元格（对话框/异步期间 DOM 可能已重渲染，按 tableIndex+r+c 重定位）
function relocateCell(ctx) {
  if (!ctx) return null;
  const t = getIrTables()[ctx.tableIndex];
  if (!t) return null;
  const rows = Array.from(t.querySelectorAll('tr'));
  const tr = rows[ctx.r];
  const cell = tr ? tr.children[ctx.c] : null;
  if (!cell || !document.contains(cell)) return null;
  const range = document.createRange();
  range.selectNodeContents(cell); range.collapse(false);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  const ed = el('.vditor-ir [contenteditable], .vditor-ir .vditor-ir__node');
  if (ed) ed.focus();
  return cell;
}
// 块级元素插到整张表格之后（前后补空行，满足块级分隔要求），返回是否成功
function insertBlockAfterTable(kind) {
  const cellInfo = caretInCell();
  if (!cellInfo) return false;
  const md = state.vditor.getValue().replace(/\r\n/g, '\n'); // R82：用实时 getValue()（editorMdBaseline 可能返回过期 tab.content，致 md 与 DOM 顶层块索引错位）
  const range = findTableBlockRange(md, cellInfo.tableIndex);
  if (!range) { toast(t('toast.tableNotFound')); return false; }
  const startLine = md.slice(0, range.startOffset).split('\n').length - 1;
  const endLine = startLine + range.lines.length - 1;
  const lines = md.split('\n');
  // 空的 列表/有序/引用/任务项 在 Vditor IR 重新解析后会被丢弃（表格之后只保留「有内容」的块，
  // 实测空 `- `、`1. `、`> ` 均丢失）；用不可见空格 NBSP 占位让空项得以渲染成正确的块，
  // 插入后把光标移入该项，用户直接键入即可（实测 NBSP 项渲染为 UL/LI、OL/LI、BLOCKQUOTE/P）
  let ins;
  if (kind === 'line') ins = ['', '---', ''];
  else if (kind === 'code') ins = ['', '```', '```', ''];
  else if (kind === 'quote') ins = ['', '> \u00a0', ''];
  else if (kind === 'ordered-list') ins = ['', '1. \u00a0', ''];
  else if (kind === 'check') ins = ['', '- [ ] ', '']; // 任务项：NBSP 会触发 lute 解析器空指针崩溃，故不带（复选框本身即内容，空项可保留）
  else ins = ['', '- \u00a0', '']; // list（无序列表）
  const newLines = lines.slice(0, endLine + 1).concat(ins, lines.slice(endLine + 1));
  try {
    state.vditor.setValue(newLines.join('\n'));
  } catch (e) {
    // lute(WASM) 对个别 markdown 结构会 panic（其内部 recover 后抛 JS 异常、实例仍可继续使用，
    // 崩溃发生在生成 DOM 阶段、未落回 reset，故表格等原文不受损）。兜底捕获，避免异常冒泡弄挂编辑器
    toast(t('toast.insertFailed'));
    return false;
  }
  setDirty(true);
  refreshLinesSoon();
  fixImagesSoon();
  placeCaretAfterTableBlock(cellInfo.tableIndex, kind);
  return true;
}
// 块级插入后：把光标移入「表格紧随其后的新建块」，让用户的键入直接落入该项。
// 用 table 的 nextElementSibling 定位新块（表格在文档中部也能正确定位，不依赖它是最后一个块；
// setValue 重渲染后 getIrTables() 返回的是新表格节点，其索引不变——插入的是列表等非表格块）。
// Vditor 重渲染是异步的（此 VDI 上可能 >120ms），需轮询直到新块已按预期类型渲染再放置光标；
// 若窗口内始终未就绪则放弃（用户可手点），绝不落到错误节点（如残留的空 P）导致键入错位
function placeCaretAfterTableBlock(tableIndex, kind) {
  if (kind === 'line') return; // 分隔线无内容可键入
  const wantTag = { quote: 'BLOCKQUOTE', 'ordered-list': 'OL', list: 'UL', check: 'UL' }[kind];
  if (!wantTag && kind !== 'code') return;
  let tries = 10;
  const attempt = () => {
    if (state.sourceMode) return;
    const tableEl = getIrTables()[tableIndex];
    const nb = tableEl && tableEl.nextElementSibling;
    // 代码块渲染为 DIV 容器（内含「源码 PRE」.vditor-ir__marker--pre 与「预览 PRE」），
    // 其 nextElementSibling 是 DIV 而非 PRE，故按容器内的 marker-pre 判定就绪；其余块直接按标签匹配
    const ready = kind === 'code'
      ? !!(nb && nb.querySelector && nb.querySelector('.vditor-ir__marker--pre'))
      : !!(nb && nb.tagName === wantTag);
    if (!ready) {
      if (--tries > 0) setTimeout(attempt, 60);
      return;
    }
    let target = kind === 'code' ? (nb.querySelector('.vditor-ir__marker--pre code') || nb.querySelector('pre') || nb)
      : kind === 'quote' ? (nb.querySelector('p') || nb)
      : (nb.querySelector('li') || nb);
    if (!target || !document.contains(target)) {
      if (--tries > 0) setTimeout(attempt, 60);
      return;
    }
    const tn = target.lastChild;
    const range = document.createRange();
    if (tn && tn.nodeType === 3) range.setStart(tn, tn.length);
    else range.selectNodeContents(target);
    range.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(range);
    const ed = el('.vditor-ir [contenteditable], .vditor-ir .vditor-ir__node');
    if (ed && ed !== document.activeElement) { try { ed.focus(); } catch (e) { } }
  };
  setTimeout(attempt, 30);
}
// 插入行内公式（$...$）。单元格内外均可：insertValue 对行内 md 会就地插入、不破坏表格。
function insertFormula() {
  if (state.sourceMode) { toast(t('toast.wysiwygFormulaFirst')); return; }
  ensureEditorFocus();
  state.vditor.insertValue('$E=mc^2$');
  setDirty(true);
  refreshLinesSoon();
}

function buildTablePickerGrid() {
  const grid = el('#tp-grid');
  if (!grid || grid.childElementCount) return;
  for (let r = 1; r <= TP_ROWS; r++) {
    for (let c = 1; c <= TP_COLS; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'tp-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.title = t('tp.cell', { r, c });
      cell.addEventListener('mouseenter', () => highlightTpCells(r, c));
      cell.addEventListener('click', () => insertTableAt(r, c));
      grid.appendChild(cell);
    }
  }
  highlightTpCells(1, 1);
}

function highlightTpCells(r, c) {
  els('#tp-grid .tp-cell').forEach(x => {
    x.classList.toggle('on', +x.dataset.r <= r && +x.dataset.c <= c);
  });
  el('#tp-label').textContent = t('tp.cell', { r, c });
}

function buildTableMd(rows, cols) {
  const row = (cells) => '| ' + cells.join(' | ') + ' |';
  const out = [
    row(Array.from({ length: cols }, (_, i) => 'col' + (i + 1))),
    row(Array.from({ length: cols }, () => '---'))
  ];
  for (let r = 1; r < rows; r++) out.push(row(Array.from({ length: cols }, () => '')));
  return out.join('\n');
}

function insertTableAt(rows, cols) {
  closeTablePicker();
  const md = buildTableMd(rows, cols);
  if (state.sourceMode) {
    const ta = el('#source');
    ta.setRangeText('\n\n' + md + '\n\n', ta.selectionStart, ta.selectionEnd, 'end');
    ta.focus();
    setDirty(true);
    updateStats(ta.value);
    scheduleOutline(ta.value);
    refreshLinesSoon();
    return;
  }
  guardCaretForBlockInsert();
  const before = state.vditor.getValue();
  state.vditor.insertValue('\n\n' + md + '\n\n', true);
  if (state.vditor.getValue() === before) {
    // 光标停在无效位置（如代码围栏标记上）时 insertValue 会被忽略 →
    // 自动移到最后一个真实正文文本节点末尾重试，保证表格一定能插进去
    const reset = el('.vditor-ir .vditor-reset');
    let node = null;
    if (reset) {
      const walker = document.createTreeWalker(reset, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        let p = n.parentElement, bad = false;
        for (let d = 0; p && p !== reset; d++) {
          if (p.tagName === 'CODE' || p.tagName === 'PRE') { bad = true; break; }
          if (p.classList && (p.classList.contains('vditor-ir__marker') || p.classList.contains('vditor-ir__preview'))) { bad = true; break; }
          p = p.parentElement;
        }
        const v = (n.nodeValue || '').replace(/\u200b/g, '').trim();
        if (bad || !v || /^(`{3,}|~{3,})$/.test(v)) continue;
        node = n;
      }
    }
    if (node) {
      const range = document.createRange();
      range.setStart(node, node.nodeValue.length); range.collapse(true);
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(range);
      state.vditor.insertValue('\n\n' + md + '\n\n', true);
    } else {
      toast(t('toast.tableCaretFirst'));
    }
  }
}

function openTablePicker(anchorEl) {
  if (state.sourceMode) {
    const ta = el('#source');
    if (ta) ta.focus();
  } else {
    ensureEditorFocus();
  }
  buildTablePickerGrid();
  bindTablePickerCustom();
  const info = getTableInfoAtCaret();
  el('#tp-ops').classList.toggle('hidden', !info);
  el('#tp-ops-title').textContent = info ? t('tp.opsIn') : t('tp.opsNeed');
  const pk = el('#table-picker');
  pk.classList.remove('hidden');
  const mc = el('#main-col');
  const mcRect = mc.getBoundingClientRect();
  let left = 16;
  if (anchorEl) left = anchorEl.getBoundingClientRect().left - mcRect.left;
  pk.style.left = Math.max(8, Math.min(left, mcRect.width - 320)) + 'px';
  // 悬浮栏现在浮在窗口底部，选择器从栏上方弹出，避免遮挡栏本身
  const barRect = el('#fbar').getBoundingClientRect();
  pk.style.top = Math.max(8, barRect.top - mcRect.top - pk.offsetHeight - 8) + 'px';
}

// 自定义 行数 × 列数 插入：聚焦输入框会抢走正文选区，先存光标、插入前恢复
let tpSavedRange = null;
function tpSaveRange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const reset = el('.vditor-ir .vditor-reset');
  if (reset && reset.contains(r.commonAncestorContainer)) tpSavedRange = r.cloneRange();
}
function bindTablePickerCustom() {
  const okBtn = el('#tp-custom-ok');
  const inR = el('#tp-rows');
  const inC = el('#tp-cols');
  if (!okBtn || !inR || !inC || okBtn.dataset.bound) return;
  okBtn.dataset.bound = '1';
  [inR, inC].forEach((inp) => {
    inp.addEventListener('focus', tpSaveRange);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 不触发全局快捷键
      if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
    });
  });
  okBtn.addEventListener('mousedown', (e) => e.preventDefault());
  okBtn.addEventListener('click', () => {
    let r = parseInt(inR.value, 10);
    let c = parseInt(inC.value, 10);
    if (!isFinite(r) || r < 1) r = 1; if (r > 30) r = 30;
    if (!isFinite(c) || c < 1) c = 1; if (c > 20) c = 20;
    inR.value = r; inC.value = c;
    // 恢复正文光标，保证表格插入到原位置
    if (!state.sourceMode && tpSavedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(tpSavedRange);
    }
    insertTableAt(r, c);
    tpSavedRange = null;
  });
}

function closeTablePicker() {
  const pk = el('#table-picker');
  if (pk) pk.classList.add('hidden');
}

// 光标所在表格的信息：第几个表格（0 起，按 DOM 顺序）+ 光标所在行/列
function getTableInfoAtCaret() {
  if (state.sourceMode || !state.vditor) return null;
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let caret = sel.getRangeAt(0).startContainer;
  if (caret.nodeType === 3) caret = caret.parentElement;
  let n = caret, table = null;
  while (n && n.id !== 'editor') {
    if (n.nodeType === 1 && n.tagName === 'TABLE') { table = n; break; }
    n = n.parentElement;
  }
  if (!table) return null;
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return null;
  let index = 0;
  for (const t of reset.querySelectorAll('table')) { if (t === table) break; index++; }
  const tr = caret && caret.closest ? caret.closest('tr') : null;
  const td = caret && caret.closest ? caret.closest('td,th') : null;
  let row = tr && table.rows ? Array.prototype.indexOf.call(table.rows, tr) : -1;
  let col = td && tr ? Array.prototype.indexOf.call(tr.cells, td) : -1;
  return { index, row: Math.max(0, row), col: Math.max(0, col) };
}

function isTableSep(line) {
  const s = (line || '').trim();
  if (!s || s.indexOf('-') === -1) return false;
  return /^[|:\-\s]+$/.test(s);
}

// 在 markdown 源码中定位第 tableIndex 个表格块（跳过代码围栏），返回字符偏移与行列表
function findTableBlockRange(md, tableIndex) {
  const lines = (md || '').split('\n');
  let inFence = false, fenceCh = '', found = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!inFence) { inFence = true; fenceCh = f[1][0]; }
      else if (f[1][0] === fenceCh) inFence = false;
      continue;
    }
    if (inFence) continue;
    if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      found++;
      if (found === tableIndex) {
        let end = i;
        while (end + 1 < lines.length && lines[end + 1].indexOf('|') !== -1) end++;
        let offset = 0;
        for (let k = 0; k < i; k++) offset += lines[k].length + 1;
        const blockLines = lines.slice(i, end + 1);
        return { startOffset: offset, length: blockLines.join('\n').length, lines: blockLines };
      }
    }
  }
  return null;
}

function splitRow(line) {
  let s = (line || '').trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  // 按未转义的 | 拆分（单元格内 \| 不作为分隔符）
  const cells = [];
  let cur = '', esc = false;
  for (const ch of s) {
    if (esc) { cur += '\\' + ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
function joinRow(cells) {
  return '| ' + cells.map(c => c === '' ? ' ' : c).join(' | ') + ' |';
}

// 行/列 增删与移动：直接转换 markdown 表格块后整篇回写
function opTable(op) {
  const info = getTableInfoAtCaret();
  if (!info) { toast(t('toast.caretInTableFirst')); closeTablePicker(); return; }
  const value = editorMdBaseline();
  const range = findTableBlockRange(value, info.index);
  if (!range) { toast(t('toast.tableNotInSrc')); closeTablePicker(); return; }
  const L = range.lines;
  const cols = splitRow(L[0]).length;
  const emptyRow = () => joinRow(Array.from({ length: cols }, () => ''));
  let newLines = L.slice();
  let fail = '';
  // info.row 是 DOM 行号（0=表头，无分隔行）；markdown 行号 = DOM 行号 + 1（分隔行占一行）
  const mrow = info.row === 0 ? 0 : info.row + 1;

  switch (op) {
    case 'row-above':
      if (mrow <= 1) fail = t('tbl.noRowAboveHeader');
      else newLines.splice(mrow, 0, emptyRow());
      break;
    case 'row-below':
      // 表头行(mrow=0)时新行须插在分隔行之后(md 行 2)，否则落在分隔行上方会把整表拍扁成纯文本
      newLines.splice(mrow === 0 ? 2 : mrow + 1, 0, emptyRow());
      break;
    case 'row-del':
      if (mrow <= 1) fail = t('tbl.headerNoDel');
      else newLines.splice(mrow, 1);
      break;
    case 'row-up':
      if (mrow <= 2) fail = t('tbl.firstDataRow');
      else { const t = newLines[mrow]; newLines[mrow] = newLines[mrow - 1]; newLines[mrow - 1] = t; }
      break;
    case 'row-down':
      if (mrow >= newLines.length - 1) fail = t('tbl.lastRow');
      else { const t = newLines[mrow]; newLines[mrow] = newLines[mrow + 1]; newLines[mrow + 1] = t; }
      break;
    case 'col-left':
      for (let i = 0; i < newLines.length; i++) {
        const cells = splitRow(newLines[i]);
        cells.splice(Math.min(info.col, cells.length), 0, i === 1 ? '---' : '');
        newLines[i] = joinRow(cells);
      }
      break;
    case 'col-right':
      for (let i = 0; i < newLines.length; i++) {
        const cells = splitRow(newLines[i]);
        cells.splice(Math.min(info.col + 1, cells.length), 0, i === 1 ? '---' : '');
        newLines[i] = joinRow(cells);
      }
      break;
    case 'col-del':
      if (cols <= 1) fail = t('tbl.lastColLeft');
      else for (let i = 0; i < newLines.length; i++) {
        const cells = splitRow(newLines[i]);
        cells.splice(Math.min(info.col, cells.length - 1), 1);
        newLines[i] = joinRow(cells);
      }
      break;
    case 'col-move-left':
      if (info.col <= 0) fail = t('tbl.firstCol');
      else for (let i = 0; i < newLines.length; i++) {
        const cells = splitRow(newLines[i]);
        const t = cells[info.col]; cells[info.col] = cells[info.col - 1]; cells[info.col - 1] = t;
        newLines[i] = joinRow(cells);
      }
      break;
    case 'col-move-right':
      if (info.col >= cols - 1) fail = t('tbl.lastCol');
      else for (let i = 0; i < newLines.length; i++) {
        const cells = splitRow(newLines[i]);
        const t = cells[info.col]; cells[info.col] = cells[info.col + 1]; cells[info.col + 1] = t;
        newLines[i] = joinRow(cells);
      }
      break;
    case 'table-del':
      newLines = [];
      break;
  }
  if (fail) { toast(fail); return; }
  const newMd = value.slice(0, range.startOffset) + newLines.join('\n') + value.slice(range.startOffset + range.length);
  {
    // 列结构变化：必须在整篇回写之前改写列宽记录（同 tableOp 的原因）
    const tab = activeTab();
    const L = tab && tab.tableLayout && tab.tableLayout[info.index];
    if (L && L.cols && L.cols.length) {
      if (op === 'col-left') L.cols = retabCols(L.cols, 'insert', info.col);
      else if (op === 'col-right') L.cols = retabCols(L.cols, 'insert', info.col + 1);
      else if (op === 'col-del') L.cols = retabCols(L.cols, 'delete', null, [Math.min(info.col, cols - 1)]);
      else if (op === 'col-move-left') L.cols = retabCols(L.cols, 'move', null, null, info.col, 1, info.col - 1);
      else if (op === 'col-move-right') L.cols = retabCols(L.cols, 'move', null, null, info.col, 1, info.col + 1);
    }
  }
  const surgical = applyTableOpDom({ table: info.index }, op === 'table-del' ? null : newLines, op === 'table-del');
  if (!surgical) state.vditor.setValue(newMd);
  // R60：手术替换的表格是新节点（内联列宽/行高丢失）：手术路径立即重放并钉列；
  // setValue 整篇回写路径重渲染是异步的，由下方 tryRestore 表格落位后重放
  if (surgical) reapplyTableLayout(true);
  setDirty(true);
  updateStats(newMd);
  scheduleOutline(newMd);
  refreshLinesSoon();
  toast(t('toast.tableUpdated'));
  closeTablePicker();
  // 整篇回写会丢光标 → 恢复到原行列单元格（钳制在界内），
  // 这样连续执行「插入行→插入列→删除行」等菜单操作时表格仍能被识别
  if (op !== 'table-del') {
    const tIndex = info.index, wantRow = info.row, wantCol = info.col;
    let tries = 0, attachedOnce = false, stableUntil = 0;
    const tryRestore = () => {
      const t2 = getIrTables()[tIndex];
      if (!t2 || !t2.rows || !t2.rows.length) {
        if (++tries < 60) { setTimeout(tryRestore, 40); return; }
        return;
      }
      const ri = Math.max(1, Math.min(wantRow, t2.rows.length - 1));
      const cells = t2.rows[ri].cells;
      const ci = Math.max(0, Math.min(wantCol, cells.length - 1));
      // 整篇回写既丢光标也丢悬浮工具条（setValue 重建 DOM 会清掉挂在 reset 下的工具条节点）。
      // 用选中态重建「单元格选中 + 工具条 + 手柄」（程序化 addRange 的光标会被 Vditor 重置，不可靠）
      TBL.selAnchor = { table: tIndex, r: ri, c: ci };
      TBL.sel = { table: tIndex, r1: ri, c1: ci, r2: ri, c2: ci };
      renderTableSelection();
      // R60：整篇回写重渲染后表格是新节点：重放布局+钉列宽（观察期内 Vditor 可能
      // 再异步重渲染一次，重复重放保证最后一帧也已钉死）
      reapplyTableLayout(true);
      // Vditor 除同步重渲染外还有一次异步重渲染（rAF 调度，遮挡窗口下延迟可达百毫秒级），
      // 会把刚挂回的工具条/选中高亮再清一次 → 首次挂回后持续观察 700ms，被清就立即重挂
      const alive = !!(ttEl && document.contains(ttEl) && ttEl.classList.contains('show'));
      if (alive && !attachedOnce) { attachedOnce = true; stableUntil = Date.now() + 700; }
      const done = attachedOnce && alive && Date.now() >= stableUntil;
      if (!done && tries++ < 80) setTimeout(tryRestore, 50);
    };
    setTimeout(tryRestore, 60);
  }
}

// ---------------------------------------------------------------- 行号栏
// IR 模式下按顶层块编号（标题/段落/表格/代码块等各占一行号），
// 源代码模式下按真实行号显示；滚动时与内容同步
function getScrollContainer() {
  if (state.sourceMode) return el('#source');
  return el('.vditor-ir .vditor-reset');
}

function syncLineGutter() {
  const inner = el('#line-gutter-inner');
  const sc = getScrollContainer();
  if (!inner || !sc) return;
  // R51：top 偏移替代 translateY——transform 使行号子树常驻合成层，
  // 软件渲染下行号文字被光栅化发糊；top 只重定位单个绝对盒，成本相当
  inner.style.top = (-sc.scrollTop) + 'px';
}

// 行号栏水平定位：
// - 左对齐/全宽（默认）：正文紧贴编辑器左缘，行号栏留在流内、margin-left=0 即在正文正左侧；
// - 居中限宽：行号栏移出文档流（#editor-row.centered，见 style.css），编辑器占满整行，
//   applyContentLayout 写的 calc((100% - W)/2) padding 让正文真正在窗口居中；
//   此处读实际 padding-left，把行号栏绝对定位贴到正文左缘（留 10px 间距）。
//   注意：行号栏若留在流内占位，编辑器被挤窄，「居中」正文会整体右移、永远无法真正居中。
function layoutLineGutter() {
  const g = el('#line-gutter');
  const row = el('#editor-row');
  if (!g) return;
  const centered = !state.sourceMode && !g.classList.contains('hidden') && isCenteredContent();
  if (row) row.classList.toggle('centered', centered);
  if (!centered) { g.style.marginLeft = '0px'; g.style.left = ''; return; }
  const reset = el('.vditor-ir .vditor-reset');
  if (!row || !reset) { g.style.left = ''; return; }
  void g.offsetWidth; // 强制 reflow，确保 class 切换后 padding 已按新编辑器宽度解析
  const padL = parseFloat(getComputedStyle(reset).paddingLeft) || 0;
  const G = g.offsetWidth;
  const gap = 10;
  g.style.marginLeft = '0px';
  g.style.left = Math.max(0, padL - G - gap) + 'px';
}

function refreshLines() {
  const inner = el('#line-gutter-inner');
  if (!inner) return;
  if (isReader()) return; // R90：阅读模式无行号栏
  if (state.sourceMode) {
    const ta = el('#source');
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
    const n = ta.value.split('\n').length;
    // R90：行数过多不再逐行建 DOM（几十万个 .ln 会卡死主线程），直接隐藏行号栏
    const gEl0 = el('#line-gutter');
    if (n > 25000) {
      inner.innerHTML = '';
      if (gEl0) gEl0.classList.add('nolines');
      refreshLines._srcN = n;
      refreshLines._srcLen = ta.value.length;
      return;
    }
    if (gEl0) gEl0.classList.remove('nolines');
    // 行数与高度都没变则跳过重建（大文档每次击键都是几十毫秒级开销）
    if (n === refreshLines._srcN && ta.value.length === refreshLines._srcLen) return;
    refreshLines._srcN = n;
    refreshLines._srcLen = ta.value.length;
    inner.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= n; i++) {
      const d = document.createElement('div');
      d.className = 'ln';
      d.dataset.n = i;
      d.style.top = ((i - 1) * lh) + 'px';
      d.textContent = i;
      frag.appendChild(d);
    }
    inner.style.height = (n * lh + 60) + 'px';
    inner.appendChild(frag);
    gutterCurLn = null;
    syncLineGutter();
    return;
  }
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  if (tableDragging) return; // 拖拽中跳过（onUp 会强制重建）
  // 只数正文块：表格悬浮工具条/行列选择槽等覆盖层也挂在 reset 下，必须排除，
  // 否则它们会被当成「块」参与编号与定位，导致行号错乱
  const isOverlay = (k) => k.classList && (k.classList.contains('ms-ttools') || k.classList.contains('ms-grow') || k.classList.contains('ms-gcol') || k.classList.contains('ms-tsel'));
  const kids = Array.from(reset.children).filter(k => k.nodeType === 1 && !isOverlay(k));
  // R90：块数过多同样隐藏行号栏（超大文件被强制用编辑模式打开时的保护）
  if (kids.length > 25000) {
    inner.innerHTML = '';
    const gEl1 = el('#line-gutter');
    if (gEl1) gEl1.classList.add('nolines');
    refreshLines._irSig = null;
    return;
  }
  const gEl2 = el('#line-gutter');
  if (gEl2) gEl2.classList.remove('nolines');
  // 块数 + 总高度都没变 → 布局未变化，跳过整列重建
  const sig = kids.length + ':' + reset.scrollHeight;
  if (sig === refreshLines._irSig && inner.children.length === kids.length) return;
  refreshLines._irSig = sig;
  inner.innerHTML = '';
  // 行号数字与「该块首行文字」垂直中线对齐（跳过 Vditor 标题的隐藏 # 标记 span）。
  // 关键：.ln 的 top 相对 #line-gutter（与正文同顶边的独立列），不是相对滚动容器 reset，
  // 故参照系要用 gutter 的视口顶边 gTop，而非 reset 的视口顶边（二者相差 vditor 内联 padding）。
  const lnLh = (state.settings.fontSize || 16) * (currentLineHeight());
  const gEl = el('#line-gutter');
  // R75-1：大文件性能——先把所有「读」做完（含一次强制 reflow），再做所有「写」。
  // 读 gTop/scrollTop 会触发一次完整 reflow；之后逐块取首行坐标时布局已稳定，
  // 全部是缓存命中，避免「读-写交替」把整篇重排打断成多轮，显著降低卡顿。
  void reset.offsetHeight;
  const gTop = gEl ? gEl.getBoundingClientRect().top : 0;
  const stTop = reset.scrollTop;
  const centers = new Array(kids.length);
  for (let i = 0; i < kids.length; i++) centers[i] = firstLineCenter(kids[i], reset);
  // 写阶段：纯 DOM 构建（挂到未入文档的 fragment，不触发 reflow），最后一次性入文档
  const frag = document.createDocumentFragment();
  for (let i = 0; i < kids.length; i++) {
    const top = centers[i] - lnLh / 2 - gTop + stTop;
    const d = document.createElement('div');
    d.className = 'ln';
    d.dataset.n = i + 1;
    d.style.top = top + 'px';
    d.textContent = i + 1;
    frag.appendChild(d);
  }
  inner.style.height = (reset.scrollHeight + 40) + 'px';
  inner.appendChild(frag);
  gutterCurLn = null;
  syncLineGutter();
}

// 取块内首行文字的中线 y 坐标：遍历首个非空文本节点，跳过位于零面积（隐藏）元素内的
// 文本（如 Vditor 标题里隐藏显示的 # 标记），避免拿到幻影坐标
function firstLineCenter(k, reset) {
  const walker = document.createTreeWalker(k, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    let p = n.parentElement, hidden = false;
    while (p && p !== k && p !== reset) {
      const pr = p.getBoundingClientRect();
      if (pr.width === 0 || pr.height === 0) { hidden = true; break; }
      p = p.parentElement;
    }
    if (hidden) continue;
    const r = document.createRange();
    try {
      r.setStart(n, 0); r.setEnd(n, 0);
      const rect = r.getBoundingClientRect();
      if (rect.height) return rect.top + rect.height / 2;
    } catch (e) { /* 继续找下一个文本节点 */ }
  }
  const br = k.getBoundingClientRect();
  return br.top + br.height / 2;
}

function refreshLinesSoon() {
  clearTimeout(refreshLinesSoon._t);
  refreshLinesSoon._t = setTimeout(refreshLines, 80);
}
// 行号栏即时刷新：rAF 合并，DOM 变化后同帧重建一次。
// WYSIWYG 下回车/删除的 DOM 拆分几百毫秒内就完成，但 Vditor 的 input 回调要等它
// 内部把整篇 markdown 重新同步完（大文档要 1~3 秒）才触发，若行号只等 input 回调，
// 编号修正会明显晚于正文变化（用户看到的"行号慢几秒"）。行号只依赖 DOM 几何，
// 因此 DOM 一变就刷新；refreshLines 内部按（块数+总高）签名去重，无变化时是空操作。
let gutterRafId = 0;
function scheduleGutterRefresh() {
  if (gutterRafId) return;
  gutterRafId = requestAnimationFrame(() => {
    gutterRafId = 0;
    refreshLines();
  });
}

// ---------------------------------------------------------------- 正文字体
function applyFont() {
  const f = ((state.settings && state.settings.contentFont) || '').trim();
  let styleEl = document.getElementById('ms-font-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'ms-font-style';
    document.head.appendChild(styleEl);
  }
  if (f) {
    const fam = f.replace(/"/g, '\\"');
    styleEl.textContent = '#editor .vditor-reset, #editor .vditor-ir { font-family: "' + fam + '", "Microsoft YaHei", sans-serif; }';
  } else {
    styleEl.textContent = '';
  }
}

// ---------------------------------------------------------------- 段落行距
// 行距统一走 CSS 变量 --lh（渲染视图块级元素 + 源码 textarea + 行号栏全部跟随），
// 修改后重排行号（块高变化）并重新定位行号栏
const LINE_HEIGHTS = [
  { v: 1.4, k: 'lh.14', name: '1.4 紧凑' },
  { v: 1.6, k: 'lh.16', name: '1.6 稍紧凑' },
  { v: 1.75, k: 'lh.175', name: '1.75 默认' },
  { v: 1.9, k: 'lh.19', name: '1.9 适中' },
  { v: 2.1, k: 'lh.21', name: '2.1 宽松' },
  { v: 2.4, k: 'lh.24', name: '2.4 很宽松' }
];
function currentLineHeight() {
  const v = parseFloat(state.settings && state.settings.lineHeight);
  return (Number.isFinite(v) && v >= 1 && v <= 3) ? v : 1.75;
}
function applyLineHeight() {
  document.documentElement.style.setProperty('--lh', String(currentLineHeight()));
  refreshLinesSoon();
  layoutLineGutter();
}

// ---------------------------------------------------------------- 正文宽度 / 对齐 / 换行
// Vditor 在 IR 模式通过「内联 padding」把正文按 preview.maxWidth 居中（窗口越宽两侧留白越大）。
// 这里用一个 !important 的 <style> 覆盖该内联 padding：
//   - 全宽(full)：左右各 28px，文本撑满编辑器（左对齐）
//   - 固定宽度 W：左对齐=左 28px；居中=两侧等分
// CSS 的 !important 恒大于 Vditor 的内联样式，窗口缩放时 Vditor 重写内联 padding 也不受影响。
const CONTENT_PAD = 28;
function isCenteredContent() {
  const s = state.settings || {};
  const w = (s.contentWidth === undefined || s.contentWidth === null) ? 'full' : s.contentWidth;
  return String(w) !== 'full' && !!s.contentCenter;
}
function contentWidthPx() {
  const w = (state.settings && state.settings.contentWidth);
  const n = parseInt(w, 10);
  return (w === undefined || w === null || w === 'full' || !n) ? 0 : Math.max(560, Math.min(2400, n));
}
function applyContentLayout() {
  let styleEl = document.getElementById('ms-layout-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'ms-layout-style';
    document.head.appendChild(styleEl);
  }
  const sel = '#editor .vditor-ir .vditor-reset';
  const W = contentWidthPx();
  if (!W) {
    // 全宽（默认）：左对齐撑满
    styleEl.textContent = sel + ' { padding-left: ' + CONTENT_PAD + 'px !important; padding-right: ' + CONTENT_PAD + 'px !important; }';
  } else if (isCenteredContent()) {
    // 行号栏已移出流内（见 layoutLineGutter），编辑器占满整行，此处 padding 即真正窗口居中；
    // 10px 下限仅防极窄窗口（(100% - W)/2 < 10）时 padding 为负
    styleEl.textContent = sel +
      ' { padding-left: max(10px, calc((100% - ' + W + 'px) / 2)) !important;' +
      ' padding-right: max(10px, calc((100% - ' + W + 'px) / 2)) !important; }';
  } else {
    // 固定宽度 + 左对齐
    styleEl.textContent = sel +
      ' { padding-left: ' + CONTENT_PAD + 'px !important;' +
      ' padding-right: max(0px, calc(100% - ' + (W + CONTENT_PAD) + 'px)) !important; }';
  }
  // 宽度变化会改变换行与块高，重排行号并重新定位行号栏
  refreshLinesSoon();
  layoutLineGutter();
}
function applyWrap() {
  const on = !(state.settings && state.settings.wrap === false);
  const ta = el('#source');
  if (ta) {
    ta.classList.toggle('nowrap', !on);
    // wrap 内容属性是规范保证的软换行开关（仅靠 CSS white-space 对 textarea 不一定生效）
    ta.setAttribute('wrap', on ? 'soft' : 'off');
  }
  // 渲染视图：关闭自动换行时正文同样不折行，滚动容器（pre）底部出现横向滚动条
  const reset = el('.vditor-ir .vditor-reset');
  if (reset) reset.classList.toggle('ms-no-wrap', !on);
  // 换行开/关会改变块高与行号对齐，重排行号
  refreshLinesSoon();
}

// R75-9：专注模式——淡化光标所在正文块之外的所有内容，只聚焦当前段落。
// vendor Vditor 3.11.3 的 focusMode 选项实际是空操作（vendor 源码无对应实现），
// 这里改用 CSS 类在应用层实现：切换专注模式只增删一个 class，无需重建编辑器。
function updateFocusHighlight() {
  const ir = el('.vditor-ir');
  if (!ir || !ir.classList.contains('ms-focus')) return;
  const reset = ir.querySelector('.vditor-reset');
  if (!reset) return;
  const sel = window.getSelection();
  let cur = null;
  if (sel && sel.rangeCount) {
    let n = sel.anchorNode;
    if (n && n.nodeType === 3) n = n.parentElement;
    while (n && n !== reset) {
      if (n.parentNode === reset) { cur = n; break; }
      n = n.parentNode;
    }
  }
  for (const b of Array.from(reset.children)) {
    if (b.nodeType !== 1) continue;
    b.classList.toggle('ms-focus-hl', b === cur);
  }
}

function applyFocusMode() {
  const ir = el('.vditor-ir');
  if (!ir) return;
  const on = !!(state.settings && state.settings.focusMode);
  ir.classList.toggle('ms-focus', on);
  state.focusApplied = on;
  const reset = ir.querySelector('.vditor-reset');
  if (!on) {
    if (reset) for (const b of Array.from(reset.children)) if (b.nodeType === 1) b.classList.remove('ms-focus-hl');
    return;
  }
  updateFocusHighlight();
}

// ---------------------------------------------------------------- 文字样式（选区字体 / 字号 / 颜色）
// 存储：markdown 源码里的原始 HTML `<span style="...">文字</span>`（Vditor 按 html-inline
// 原样往返，保存/重开不丢失）。显示：Vditor IR 会把原始 HTML 渲染成隐藏的 marker 节点、
// 文字本身不带样式，这里在每次渲染后用 MutationObserver 把成对 marker 之间的内容包成
// 真实 <span class="ms-styled">，视觉即所见即所得；用户继续输入时 marker 保留，样式范围
// 自然延伸（与常见办公软件行为一致）。
let spanFixTimer = null;
function applyStyledSpans() {
  if (state.sourceMode) return;
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  const OPEN_RE = /^<span style="([^"]*)">$/;
  const mt = (h) => { const c = h.querySelector('code.vditor-ir__marker'); return c ? c.textContent : ''; };
  const nodes = Array.from(reset.querySelectorAll('span[data-type="html-inline"]'));
  for (let i = 0; i < nodes.length; i++) {
    const m = mt(nodes[i]).match(OPEN_RE);
    if (!m) continue;
    // 配对（支持嵌套）：从第 i 个开始找 depth 归零的 </span>
    let depth = 1, j = i + 1;
    for (; j < nodes.length && depth > 0; j++) {
      const t = mt(nodes[j]);
      if (t.match(OPEN_RE)) depth++;
      else if (t.trim() === '</span>') depth--;
      if (depth === 0) break;
    }
    if (depth !== 0) continue;
    const open = nodes[i], close = nodes[j];
    const mid = open.nextSibling;
    // 幂等：中间已是包装 span 则跳过
    if (mid && mid.nodeType === 1 && mid.classList.contains('ms-styled') && mid === close.previousSibling) continue;
    const span = document.createElement('span');
    span.className = 'ms-styled';
    span.setAttribute('style', m[1]);
    if (mid && mid.nodeType === 3 && mid === close.previousSibling) {
      // 单一文本节点：直接替换（避免 Range 边界落在父元素上）
      mid.parentNode.replaceChild(span, mid);
      span.appendChild(mid);
    } else {
      // 混合内容（含加粗/链接等行内元素）：Range 抽取后包裹
      const range = document.createRange();
      range.setStartAfter(open);
      range.setEndBefore(close);
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
  }
}
function installSpanObserver() {
  const host = el('#editor');
  if (!host) return;
  new MutationObserver(() => {
    if (spanFixTimer) return;
    spanFixTimer = setTimeout(() => {
      spanFixTimer = null;
      applyStyledSpans();
      // 行号跟随 DOM 即时刷新（不等 Vditor 的 input 回调，大文档下它延迟可达数秒）
      if (!state.sourceMode) scheduleGutterRefresh();
    }, 30);
  }).observe(host, { childList: true, subtree: true });
}

function spanStyleParts(props) {
  const parts = [];
  if (props.fontFamily) {
    // 含空格/特殊字符的字体名需要 CSS 引号；用单引号，避免破坏外层 style="..." 属性
    const fam = String(props.fontFamily).replace(/["']/g, '');
    parts.push('font-family:' + (/^[A-Za-z0-9\u4e00-\u9fff._-]+$/.test(fam) ? fam : "'" + fam + "'"));
  }
  if (props.fontSize) parts.push('font-size:' + props.fontSize);
  if (props.color) parts.push('color:' + props.color);
  return parts.join(';');
}

// 找「内容区恰好以 [a,b) 开始或包含 [a,b)」的最近 <span style="..."> 开标签
function findSpanCovering(md, a, b) {
  for (let i = a - 1; i >= Math.max(0, a - 500); i--) {
    if (md.slice(i, i + 13) === '<span style="') {
      const qEnd = md.indexOf('"', i + 13);
      if (qEnd === -1) return null;
      const tagEnd = md.indexOf('>', qEnd);
      if (tagEnd === -1 || tagEnd + 1 > a) return null;
      const style = md.slice(i + 13, qEnd);
      const closeIdx = md.indexOf('</span>', b);
      if (closeIdx === -1 || closeIdx < b) return null;
      return { openStart: i, openEnd: tagEnd + 1, style, closeStart: closeIdx, closeEnd: closeIdx + 7 };
    }
  }
  return null;
}

// 按 props 合并/删除一个 style 串里的 font-family / font-size / color（null=删除该属性）
function setSpanStyleProps(styleStr, props) {
  const parts = String(styleStr || '').split(';').map(s => s.trim()).filter(Boolean);
  const KEYS = { fontFamily: 'font-family', fontSize: 'font-size', color: 'color' };
  for (const [prop, css] of Object.entries(KEYS)) {
    if (props[prop] === undefined) continue;
    const idx = parts.findIndex(p => p.startsWith(css + ':'));
    const val = props[prop];
    if (val === null || val === '') {
      if (idx !== -1) parts.splice(idx, 1);
    } else {
      if (idx !== -1) parts[idx] = css + ':' + val;
      else parts.push(css + ':' + val);
    }
  }
  return parts.join(';');
}

// markdown → 顶层块（带字符偏移），与 Vditor 的块划分基本一致（围栏/标题/表格/普通段）
function splitMdBlocks(md) {
  const lines = md.split('\n');
  const blocks = [];
  const offOf = (i) => {
    let o = 0;
    for (let k = 0; k < i; k++) o += lines[k].length + 1;
    return o;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const closeRe = f[1][0] === '`' ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
      let end = i;
      while (end + 1 < lines.length && !closeRe.test(lines[end + 1])) end++;
      const start = offOf(i);
      blocks.push({ start, end: offOf(end) + lines[end].length, type: 'fence' });
      i = end + 1;
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      const start = offOf(i);
      blocks.push({ start, end: start + line.length, type: 'head' });
      i++;
      continue;
    }
    if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].indexOf('|') !== -1) end++;
      const start = offOf(i);
      blocks.push({ start, end: offOf(end) + lines[end].length, type: 'table' });
      i = end + 1;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trim() !== '' && !/^\s{0,3}#{1,6}\s/.test(lines[end + 1])) end++;
    const start = offOf(i);
    blocks.push({ start, end: offOf(end) + lines[end].length, type: 'para' });
    i = end + 1;
  }
  return blocks;
}

function blockText(k) {
  let s = '';
  const w = document.createTreeWalker(k, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = w.nextNode())) s += n.nodeValue;
  return s;
}

// 把选区按顶层块切成片段（含 Vditor 隐藏的 marker 字符，与 markdown 源码字符一致）
// 注意 compareBoundaryPoints 实测语义（Chromium）：how 的第一个关键字取「参数 range」的边界、
// 第二个关键字取「this range」的边界，符号 = pos(this边界) - pos(参数边界)。
// 例：sel.cmp(END_TO_START, blk) > 0 ⟺ sel 起点在 blk 终点之后（整块在选区之前）
function extractFragments(range, reset) {
  const kids = Array.from(reset.children).filter(k => k.nodeType === 1);
  const out = [];
  kids.forEach((k, bi) => {
    const b = document.createRange();
    b.selectNodeContents(k);
    if (range.compareBoundaryPoints(Range.END_TO_START, b) > 0) return;   // 整块在选区之前
    if (range.compareBoundaryPoints(Range.START_TO_END, b) <= 0) return;  // 整块在选区之后
    const full = blockText(k);
    if (!full) return;
    let frag = '', startOff = -1;
    const walker = document.createTreeWalker(k, NodeFilter.SHOW_TEXT, null);
    let off = 0, w;
    while ((w = walker.nextNode())) {
      const len = w.nodeValue.length;
      const nodeStart = off;
      off += len;
      const rs = document.createRange(); rs.selectNode(w); rs.collapse(true);
      const re = document.createRange(); re.selectNode(w); re.collapse(false);
      // 该文本节点与选区的交集（文本坐标）
      let lo = 0, hi = len;
      if (range.startContainer === w) lo = range.startOffset;
      else if (range.compareBoundaryPoints(Range.END_TO_START, re) > 0) continue; // 选区起点在本节点之后
      if (range.endContainer === w) hi = range.endOffset;
      else if (rs.compareBoundaryPoints(Range.END_TO_START, range) > 0) break;    // 选区终点在本节点之前
      if (hi > lo) {
        if (startOff === -1) startOff = nodeStart + lo;
        frag += w.nodeValue.slice(lo, hi);
      }
    }
    if (frag) out.push({ text: frag, blockIdx: bi, startRatio: startOff / full.length });
  });
  return out;
}

// 在 markdown 中为各片段文本定位（块 ±3 容忍解析偏差，再退化为全文；
// 取最接近「选区起点在块内比例」的候选，降低重复文本选错位置的概率）。
// 返回按片段顺序的 [{a, b}]；任一失败返回 null
function locateFragmentsInMd(md0, fragments) {
  const blocks = splitMdBlocks(md0);
  const out = [];
  for (const frag of fragments) {
    const F = frag.text;
    let cands = [];
    const tryRegion = (idx) => {
      if (idx < 0 || idx >= blocks.length) return;
      const rg = blocks[idx];
      let pos = md0.indexOf(F, rg.start);
      while (pos !== -1 && pos < rg.end) { cands.push(pos); pos = md0.indexOf(F, pos + 1); }
    };
    for (let d = 0; d <= 3 && !cands.length; d++) {
      tryRegion(frag.blockIdx + d);
      tryRegion(frag.blockIdx - d);
    }
    if (!cands.length) {
      let pos = md0.indexOf(F);
      while (pos !== -1) { cands.push(pos); pos = md0.indexOf(F, pos + 1); }
    }
    if (!cands.length) return null;
    const rb = blocks[frag.blockIdx] || { start: 0, end: md0.length };
    const expected = rb.start + (rb.end - rb.start) * frag.startRatio;
    let a = cands[0], best = Infinity;
    for (const c of cands) {
      const d = Math.abs(c - expected);
      if (d < best) { best = d; a = c; }
    }
    out.push({ a, b: a + F.length });
  }
  return out;
}

// 在 markdown 中把各片段包上/合并/清除 span 样式；任一片段定位失败返回 null
function wrapSelectionInMd(md0, fragments, props) {
  if (!fragments.length) return null;
  const ranges = locateFragmentsInMd(md0, fragments);
  if (!ranges) return null;
  const styleStr = spanStyleParts(props);
  const allClear = !props.fontFamily && !props.fontSize && !props.color;
  const edits = ranges.slice().sort((x, y) => y.a - x.a); // 从后往前应用，偏移不互相影响
  let md2 = md0;
  for (const ed of edits) {
    const cover = findSpanCovering(md2, ed.a, ed.b);
    const exact = cover && cover.openEnd === ed.a && cover.closeStart === ed.b;
    if (allClear) {
      if (!exact) return null; // 清除要求选区与样式范围完全一致，避免误删其它文字的样式
      // 只删两侧标签，保留标签内的文字
      md2 = md2.slice(0, cover.openStart) + md2.slice(cover.openEnd, cover.closeStart) + md2.slice(cover.closeEnd);
    } else if (exact) {
      const newStyle = setSpanStyleProps(cover.style, props);
      const sStart = cover.openStart + 13;
      md2 = md2.slice(0, sStart) + newStyle + md2.slice(sStart + cover.style.length);
    } else {
      md2 = md2.slice(0, ed.a) + '<span style="' + styleStr + '">' + md2.slice(ed.a, ed.b) + '</span>' + md2.slice(ed.b);
    }
  }
  // 返回 md2：=== md0 表示定位成功但样式无变化；null 才是定位失败（由调用方区分提示）
  return md2;
}

// IR（渲染）模式：在 markdown 层应用样式，再整体回写；显示层包装由 observer 自动完成
function applyInlineStyleIR(props) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString()) return toast(t('toast.selStyleFirst'));
  const range = sel.getRangeAt(0);
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset || !reset.contains(range.commonAncestorContainer)) return toast(t('toast.selStyleInBody'));
  const fragments = extractFragments(range, reset);
  if (!fragments.length) return toast(t('toast.selStyleFirst'));
  const md0 = state.vditor.getValue();
  const md1 = wrapSelectionInMd(md0, fragments, props);
  if (md1 === null) { toast(t('toast.styleApplyFailed')); return; }
  if (md1 === md0) return; // 定位成功但样式无变化（本就是该样式），不回写、不标脏
  state.vditor.setValue(md1);
  const tab = activeTab();
  if (tab) tab.content = md1;
  setDirty(true);
  scheduleOutline(md1);
  refreshLinesSoon();
  fixImagesSoon();
  updateStats(md1);
  refreshToolbarState();
  // setValue 整体重渲染会把选区重置为折叠光标，悬浮栏字体/字号框随之退回默认值；
  // 等样式包装 span 生成后把选区恢复到刚设置样式的文字上（可继续连选改字号/颜色）
  setTimeout(() => restoreStylingSelection(fragments), 80);
}

// 重渲染后按「块索引 + 块内文本比例」在 DOM 里重新定位已应用样式的文字，恢复选区。
// 依据：md 只新增了 span 标签、正文文本未变，重渲染后各块文本（含隐藏 marker 字符）
// 与之前逐字一致，fragment 文本在块串中的位置不变。
function restoreStylingSelection(fragments) {
  if (!fragments || !fragments.length) return;
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  const kids = Array.from(reset.children).filter(k => k.nodeType === 1);
  const blockInfo = (bi) => {
    const k = kids[bi];
    if (!k) return null;
    const nodes = [];
    const w = document.createTreeWalker(k, NodeFilter.SHOW_TEXT, null);
    let str = '', n;
    while ((n = w.nextNode())) { nodes.push({ n, start: str.length }); str += n.nodeValue; }
    return { str, nodes };
  };
  const mapPos = (info, abs) => {
    for (let i = info.nodes.length - 1; i >= 0; i--) {
      if (abs >= info.nodes[i].start) return { node: info.nodes[i].n, off: abs - info.nodes[i].start };
    }
    return info.nodes.length ? { node: info.nodes[0].n, off: 0 } : null;
  };
  const locate = (frag) => {
    const info = blockInfo(frag.blockIdx);
    if (!info || !info.str.length) return null;
    const expected = Math.round(info.str.length * frag.startRatio);
    let idx = info.str.indexOf(frag.text, Math.max(0, expected - 80));
    if (idx === -1) idx = info.str.indexOf(frag.text);
    if (idx === -1) return null;
    const s = mapPos(info, idx);
    const e = mapPos(info, idx + frag.text.length);
    return (s && e) ? { s, e } : null;
  };
  const first = locate(fragments[0]);
  const last = locate(fragments[fragments.length - 1]);
  if (!first || !last) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(first.s.node, first.s.off);
  range.setEnd(last.e.node, last.e.off);
  sel.removeAllRanges();
  sel.addRange(range);
}

// 源码模式：直接对 textarea 的 markdown 文本做同样的 span 包装
function applyInlineStyleSource(props) {
  const ta = el('#source');
  const a = ta.selectionStart, b = ta.selectionEnd;
  const F = ta.value.slice(a, b);
  if (!F) return toast(t('toast.selStyleSrcFirst'));
  const styleStr = spanStyleParts(props);
  const allClear = !props.fontFamily && !props.fontSize && !props.color;
  const cover = findSpanCovering(ta.value, a, b);
  const exact = cover && cover.openEnd === a && cover.closeStart === b;
  if (exact) {
    const newStyle = setSpanStyleProps(cover.style, props);
    let inner;
    if (newStyle === '') inner = F; // 属性全清 → 解包
    else inner = '<span style="' + newStyle + '">' + F + '</span>';
    const cur = ta.value.slice(cover.openStart, cover.closeEnd);
    if (inner === cur) return; // 无变化，不回写、不标脏
    ta.setRangeText(inner, cover.openStart, cover.closeEnd, 'end');
  } else if (allClear) {
    return toast(t('toast.styleClearIncomplete'));
  } else {
    ta.setRangeText('<span style="' + styleStr + '">' + F + '</span>', a, b, 'end');
  }
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function applyTextStyle(props) {
  if (state.sourceMode) applyInlineStyleSource(props);
  else applyInlineStyleIR(props);
}

// ---------------------------------------------------------------- 加粗 / 斜体 / 删除线（markdown 层）
// 不走 Vditor 原生 toolbar 按钮：该 IR 版本下程序化点击 bold 会在选区两边插入「裸 **」
// 文本节点（不经过输入解析器），界面显示字面 ** 且不渲染加粗（R43 用户反馈）。
// 与字体/字号/颜色同一套机制：在 markdown 源上做标记包合，setValue 整体重渲染，
// Vditor 解析器保证 IR DOM 结构（隐藏 marker span + <strong>）与存盘 md 正确。
const EM_MARKERS = { strong: '**', em: '*', s: '~~' };
const EM_NAMES = { strong: '加粗', em: '斜体', s: '删除线' };

// 在 markdown 字符串上对 ranges（同坐标 [{a,b}]）应用或取消强调：
// ① 选区含完整标记（**x**，IR 选区可能带隐藏 marker 文本）→ 去标记；
// ② 选区是纯文本且两侧恰好是同类标记 → 去两侧标记（选中整段加粗文字再点 B = 取消）；
// ③ 选区内/一侧已带同类标记 → 拒绝（避免产生交错嵌套的坏 markdown）；
// ④ 其余 → 加标记。返回 { md } 或 { err: 'mixed' | 'partial' }
function emphasisEditMd(md, ranges, tag) {
  const m = EM_MARKERS[tag];
  const ml = m.length;
  const isMarkerAt = (pos) => {
    if (pos < 0 || pos + ml > md.length) return false;
    if (md.slice(pos, pos + ml) !== m) return false;
    // 斜体的 * 不能是 ** 的一部分
    if (tag === 'em' && ((pos - 1 >= 0 && md[pos - 1] === '*') || (pos + ml < md.length && md[pos + ml] === '*'))) return false;
    return true;
  };
  const edits = [];
  for (const r of ranges) {
    const inner = md.slice(r.a, r.b);
    if (inner.length >= 2 * ml && inner.indexOf(m) !== -1) {
      const core = inner.slice(ml, inner.length - ml);
      if (inner.startsWith(m) && inner.endsWith(m) && core.indexOf(m) === -1) {
        edits.push({ a: r.a, b: r.b, text: core }); // ① 整段含标记 → 换回纯文本
      } else {
        return { err: 'mixed' };                    // ③ 内含标记但非完整强调
      }
    } else if (isMarkerAt(r.a - ml) && isMarkerAt(r.b)) {
      edits.push({ a: r.a - ml, b: r.b + ml, text: inner }); // ② 精确包住 → 去标记
    } else if (isMarkerAt(r.a - ml) || isMarkerAt(r.b)) {
      return { err: 'partial' };                    // ③ 选区跨入已有强调的一部分
    } else {
      edits.push({ a: r.a, b: r.b, text: m + inner + m }); // ④ 加标记
    }
  }
  let md2 = md;
  const texts = edits.map((e) => e.text); // 与入参 ranges 同序，供源码模式取单段替换文本
  for (const ed of edits.slice().sort((x, y) => y.a - x.a)) { // 从后往前替换
    md2 = md2.slice(0, ed.a) + ed.text + md2.slice(ed.b);
  }
  return { md: md2, texts };
}

// IR 模式：选区 → markdown 片段 → 标记包合 → 整体回写
function applyEmphasisIR(tag) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString()) return toast(t('toast.selEm', { em: EM_NAMES[tag] }));
  const range = sel.getRangeAt(0);
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset || !reset.contains(range.commonAncestorContainer)) return toast(t('toast.selEmInBody', { em: EM_NAMES[tag] }));
  const fragments = extractFragments(range, reset);
  if (!fragments.length) return toast(t('toast.selEm', { em: EM_NAMES[tag] }));
  const md0 = state.vditor.getValue();
  const ranges = locateFragmentsInMd(md0, fragments);
  if (!ranges) return toast(t('toast.emApplyFailed', { em: EM_NAMES[tag] }));
  const res = emphasisEditMd(md0, ranges, tag);
  if (res.err) {
    return toast(res.err === 'mixed'
      ? t('toast.emHasMark', { em: EM_NAMES[tag] })
      : t('toast.emOverlap', { em: EM_NAMES[tag] }));
  }
  if (res.md === md0) return; // 无变化，不回写不标脏
  state.vditor.setValue(res.md);
  const tab = activeTab();
  if (tab) tab.content = res.md;
  setDirty(true);
  scheduleOutline(res.md);
  refreshLinesSoon();
  fixImagesSoon();
  updateStats(res.md);
  refreshToolbarState();
  setTimeout(() => restoreStylingSelection(fragments), 80);
}

// 源码模式：直接对 textarea 选区做同样的标记包合
function applyEmphasisSource(tag) {
  const ta = el('#source');
  const a = ta.selectionStart, b = ta.selectionEnd;
  if (a === b) return toast(t('toast.selEmSrc', { em: EM_NAMES[tag] }));
  const res = emphasisEditMd(ta.value, [{ a, b }], tag);
  if (res.err) {
    return toast(res.err === 'mixed'
      ? t('toast.emHasMark', { em: EM_NAMES[tag] })
      : t('toast.emOverlap', { em: EM_NAMES[tag] }));
  }
  ta.setRangeText(res.texts[0], a, b, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function applyEmphasis(tag) {
  if (state.sourceMode) applyEmphasisSource(tag);
  else applyEmphasisIR(tag);
}

// ---------------------------------------------------------------- 表格交互（R45）
// ① 列宽/行高拖拽（列/行边界 8px 命中区，hover 显示高亮线）
// ② 单击选中单元格，拖动/Shift+点 扩展为矩形选区
// ③ hover 表格时左上角出现「全选」控件 + 行列操作工具条
// ④ 结构操作走 MD 层（复用 findTableBlockRange/splitRow/joinRow，与 opTable 同一管线，
//    区别：本处按「选区」定位行列，opTable 按光标定位）
const TBL = { sel: null, selAnchor: null, caret: null, dragging: null };
let ttEl = null; // 表格工具条（单例，挂到当前表格下）

function getIrTables() {
  const reset = el('.vditor-ir .vditor-reset');
  return reset ? Array.from(reset.querySelectorAll('table')) : [];
}

// 元素所在单元格 → {r, c}（表头行 r=0）
function cellPos(table, node) {
  let n = node;
  while (n && n !== table && n.tagName !== 'TD' && n.tagName !== 'TH') n = n.parentElement;
  if (!n || n === table) return null;
  const rows = Array.from(table.querySelectorAll('tr'));
  const r = rows.indexOf(n.parentElement);
  if (r < 0) return null;
  return { r, c: n.cellIndex };
}

// 光标进入表格时把当前列宽钉死：切 fixed 布局 + 各列 % 写入表头行内联 + 存进
// tab.tableLayout。否则 Vditor IR 每次击键都会重建表格 DOM（自然 auto 布局），
// 输入的文字改变列宽分配，导致"在一个单元格里打字、其他单元格宽度跟着变"。
// 已 fixed 的表不重复钉（避免覆盖刚拖拽出的列宽）。
function pinTableCols(table, idx) {
  if (state.sourceMode) return;
  const tab = activeTab();
  const saved = tab && tab.tableLayout && tab.tableLayout[idx];
  const head = table.querySelector('tr');
  const n = head ? head.children.length : 0;
  // R50：Vditor 每次击键都会重建表格 DOM。重建后光标落入新单元格会再次触发
  // selectionchange → 若此时重新钉死，Vditor 按内容算出的列宽会覆盖用户钉死/
  // 拖拽过的列宽（实测记录从 33/33/33 被污染成 19/62/19，钉列宽功能完全失效）。
  // 所以只要该表已有列宽记录且列数未变（列数变了才重新钉，防止删表后同位置的
  // 新表吃到旧记录），一律不重钉；重建后的列宽恢复交给 80ms 防抖的
  // reapplyTableLayout（input 事件防抖晚于 Vditor 重建，时序可靠）
  if (saved && saved.cols && n && saved.cols.length === n) return;
  if (table.style.tableLayout === 'fixed') return;
  const pcts = currentColPcts(table);
  if (!pcts.length) return;
  const fr = table.querySelector('tr');
  if (!fr) return;
  pcts.forEach((p, k) => { if (fr.children[k]) fr.children[k].style.width = p + '%'; });
  table.style.tableLayout = 'fixed';
  if (tab) {
    tab.tableLayout = tab.tableLayout || {};
    tab.tableLayout[idx] = tab.tableLayout[idx] || {};
    tab.tableLayout[idx].cols = pcts;
  }
}
// 列操作（插入/删除/移动列）会改变表格结构，但保存的「列宽记录」还是旧结构的 ——
// 不同步改写，reapplyTableLayout 重放时旧宽度按 100% 铺满前 N 列，新列被挤成 0 宽
// （t143 回归：插入列后第 4 列 0.09%）。
// 插入：新列以相邻列宽度为基准（Word 式），整体归一化到 100；
// 删除：存活列按比例放大补满；移动：宽度随列一起换位置
function retabCols(cols, kind, at, drop, from, len, to) {
  if (!cols || !cols.length) return cols;
  const norm = (a) => { const s = a.reduce((x, y) => x + y, 0); return a.map((v) => (s > 0 ? (v / s) * 100 : 100 / a.length)); };
  if (kind === 'insert') {
    const a = cols.slice();
    const i = Math.max(0, Math.min(at, a.length));
    a.splice(i, 0, i < a.length ? a[i] : a[a.length - 1]);
    return norm(a);
  }
  if (kind === 'delete') {
    const dropSet = new Set(drop);
    return norm(cols.filter((_, c) => !dropSet.has(c)));
  }
  if (kind === 'move') {
    const a = cols.slice();
    const seg = a.splice(from, len);
    a.splice(to, 0, ...seg);
    return a;
  }
  return cols;
}
// R60：清扫孤儿覆盖层。修复前的旧快照（undo 栈/irHTML 缓存）若烘焙了覆盖层 HTML，
// 整篇 innerHTML 重解析（Ctrl+Z/setValue/切标签恢复）会复活两类残留：
// ① 工具条「僵尸」——节点原样复原但事件监听器丢失（用户看到两份悬浮工具条，
//    点僵尸那份无反应）；② 选框/手柄被 HTML 解析器从 <table> 内「扶正」到编辑器根
//    （div 在 table 内是非法节点）——选框坐标由相对表格变相对整块内容，表现为
//    内容左上角一块巨大蓝色矩形。合法覆盖层的归属：工具条=活的 ttEl 单例（挂编辑器
//    根）；选框/手柄=表格内部节点；行列槽=活的 gutRow/gutCol 单例。因此编辑器根上
//    的 .ms-tsel/.ms-cre/.ms-rre 必为孤儿；.ms-ttools 只保留活的 ttEl
function sweepTableOrphans() {
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  reset.querySelectorAll(':scope > .ms-ttools').forEach((x) => { if (x !== ttEl) x.remove(); });
  reset.querySelectorAll(':scope > .ms-tsel, :scope > .ms-cre, :scope > .ms-rre').forEach((x) => x.remove());
}

// 把当前标签保存的列宽/行高重放到所有表格（切回标签 / 重渲染后）。
// R60：pinNew=true 时对还没有列宽记录的表立即钉死当前自然宽度（「天生已钉」）——
// 首次钉列（auto→fixed 布局切换 + 写 % 宽）有一帧重排，是「点选单元格时表格跳动」
// 的主因；加载/撤销/结构操作后主动钉，之后 mousedown/拖动零几何变化
function reapplyTableLayout(pinNew) {
  if (state.sourceMode) return;
  sweepTableOrphans();
  const tables = getIrTables();
  const tab = activeTab();
  const lay = (tab && tab.tableLayout) || {};
  tables.forEach((t, i) => {
    t.querySelectorAll('.ms-cre,.ms-rre').forEach(x => x.remove());
    const L = lay[i];
    // R60：先在「重放」之前钉新表。若放在末尾，无列宽记录的新表（刚加载的文档）
    // 会先被 if (!L) return 挡掉，永远钉不上（E1「天生已钉」失败的根因）。
    // 已 fixed / 已有匹配列宽记录的表在 pinTableCols 内部提前返回（零开销）
    if (pinNew) pinTableCols(t, i);
    if (!L) return;
    if (L.cols && L.cols.length) {
      // 列数对不上（记录是旧结构的，op 未改写成功或结构被外部改动）：
      // 旧记录无法映射到新列——宁可丢弃恢复自然布局，不能把新列挤成 0 宽。
      // 丢弃后光标再进表格会由 pinTableCols 重新钉死当前自然宽度（自愈）
      const head0 = t.querySelector('tr');
      const n0 = head0 ? head0.children.length : 0;
      if (n0 && L.cols.length !== n0) { delete L.cols; }
      else if (head0) {
        // colgroup 会让 Vditor 的 DOM→MD 转换丢表，列宽只写表头行 th 内联 width
        t.style.tableLayout = 'fixed';
        const cg = t.querySelector('colgroup');
        if (cg) cg.remove(); // 清理旧版本可能残留的 colgroup
        L.cols.forEach((p, k) => { if (head0.children[k]) head0.children[k].style.width = p + '%'; });
      }
    }
    if (L.tbl && L.tbl.w) {
      // 最左/最右边框拖拽记忆的整表宽度与左边距
      t.style.width = L.tbl.w + '%';
      t.style.marginLeft = (L.tbl.ml || 0) + '%';
    } else if (!L.nowrap) {
      t.style.width = '';
      t.style.marginLeft = '';
    }
    if (L.rows) {
      Array.from(t.querySelectorAll('tr')).forEach((tr, r) => { tr.style.height = L.rows[r] ? L.rows[r] + 'px' : ''; });
    }
    if (L.nowrap) applyTableWrap(t, false); // 重渲染后恢复「关闭自动换行」状态（对齐由 md 标记重建，无需处理）
  });
  if (TBL.sel) renderTableSelection();
  else if (ttEl && ttEl.classList.contains('show')) positionTableTools();
  positionGutters(); // 顺带校正行/列选择槽位置（表格可能已被删除/结构变化）
  // 重放改变了列宽/表宽：现存手柄（工具条未显示时不重建）重新对齐实际边框
  tables.forEach(t => { if (t && t.querySelector('.ms-cre')) syncHandlePositions(t); });
  // 重放会清掉旧手柄；若此刻工具条正显示（鼠标悬停/选区激活），立即重建，
  // 否则鼠标停在表格内不动时（不再触发 mouseover）手柄就丢了
  if (ttEl && ttEl.classList.contains('show') && document.contains(ttEl)) {
    const hi = TBL.sel ? TBL.sel.table : (TBL.caret ? TBL.caret.table : -1);
    if (hi >= 0 && tables[hi] && document.contains(tables[hi])) buildResizeHandles(tables[hi], hi);
  }
}

// ---------------- 单元格选中 ----------------
// R61：拖拽路径多选 —— TBL.sel.cells = 选中单元格的精确集合 [{r,c},...]（沿拖拽
// 路径累积、只加不减，因此可能是非矩形的）；cells 缺省即为矩形选区
function selIsFullRect(s) {
  if (!s || !s.cells) return true;
  return s.cells.length === (s.r2 - s.r1 + 1) * (s.c2 - s.c1 + 1);
}
function selCellOn(s, r, c) {
  if (!s) return false;
  if (s.cells) { for (let i = 0; i < s.cells.length; i++) if (s.cells[i].r === r && s.cells[i].c === c) return true; return false; }
  return r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
}
function selBBox(cells) {
  let r1 = cells[0].r, c1 = cells[0].c, r2 = cells[0].r, c2 = cells[0].c;
  for (let i = 1; i < cells.length; i++) {
    r1 = Math.min(r1, cells[i].r); c1 = Math.min(c1, cells[i].c);
    r2 = Math.max(r2, cells[i].r); c2 = Math.max(c2, cells[i].c);
  }
  return { r1, c1, r2, c2 };
}
// R66b：Ctrl+左键点选 = 在现有选区上「加/减」目标格（toggle，Excel 语义）：
// 目标格已全部在选区中 → 整体移除；否则整体加入（并集）。结果为空 → 清空选区。
// 无现有选区或选区属于另一张表 → 直接以目标格建立新选区。
// 现有选区是矩形（行/列槽点选产生、无 cells 集合）时先物化成精确集合再运算
function toggleTableSelCells(idx, newCells) {
  const tables = getIrTables();
  const t = tables[idx];
  if (!t || !newCells.length) return;
  const s = TBL.sel;
  if (!s || s.table !== idx) {
    TBL.selAnchor = { table: idx, r: newCells[0].r, c: newCells[0].c };
    const bb0 = selBBox(newCells);
    TBL.sel = { table: idx, r1: bb0.r1, c1: bb0.c1, r2: bb0.r2, c2: bb0.c2, cells: newCells.slice() };
    renderTableSelection();
    return;
  }
  const cur = new Set();
  if (s.cells && s.cells.length) {
    s.cells.forEach(p => cur.add(p.r * 100 + p.c));
  } else {
    for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) cur.add(r * 100 + c);
  }
  const target = newCells.map(p => p.r * 100 + p.c);
  const allIn = target.every(k => cur.has(k)); // 已全选 → 移除；否则 → 加入
  target.forEach(k => { if (allIn) cur.delete(k); else cur.add(k); });
  if (!cur.size) { clearTableSelection(); return; }
  const cells = Array.from(cur).map(k => ({ r: Math.floor(k / 100), c: k % 100 }));
  const bb = selBBox(cells);
  TBL.sel = { table: idx, r1: bb.r1, c1: bb.c1, r2: bb.r2, c2: bb.c2, cells };
  renderTableSelection();
}
function setTableSelection(idx, pos) {
  const a = TBL.selAnchor && TBL.selAnchor.table === idx ? TBL.selAnchor : { table: idx, r: pos.r, c: pos.c };
  TBL.sel = {
    table: idx,
    r1: Math.min(a.r, pos.r), c1: Math.min(a.c, pos.c),
    r2: Math.max(a.r, pos.r), c2: Math.max(a.c, pos.c)
  };
  renderTableSelection();
}
function renderTableSelection() {
  sweepTableOrphans(); // R60：重画前先清扫孤儿（选框/僵尸工具条）
  if (!TBL.sel) return;
  const tables = getIrTables();
  const t = tables[TBL.sel.table];
  if (!t) { clearTableSelection(); return; }
  const s = TBL.sel;
  const rows = Array.from(t.querySelectorAll('tr'));
  rows.forEach((tr, r) => {
    Array.from(tr.children).forEach((cell, c) => {
      // R61：路径多选按精确集合高亮（非矩形），矩形选区退化为原 r/c 范围判断
      cell.classList.toggle('ms-cell-sel', selCellOn(s, r, c));
    });
  });
  t.querySelectorAll('.ms-tsel').forEach(x => x.remove());
  // R61：外框只在选区为完整矩形时绘制（拖拽路径选中的零散单元格只高亮、不画框）
  if (selIsFullRect(s)) {
    const tr = t.getBoundingClientRect();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) {
        const cell = rows[r] && rows[r].children[c];
        if (!cell) continue;
        const rc = cell.getBoundingClientRect();
        x1 = Math.min(x1, rc.left - tr.left); y1 = Math.min(y1, rc.top - tr.top);
        x2 = Math.max(x2, rc.right - tr.left); y2 = Math.max(y2, rc.bottom - tr.top);
      }
    }
    if (Number.isFinite(x1)) {
      const box = document.createElement('div');
      box.className = 'ms-tsel';
      box.style.left = x1 + 'px'; box.style.top = y1 + 'px';
      box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
      t.insertBefore(box, t.firstChild); // 前导节点，保证 table.lastElementChild 仍是最后一行
    }
  }
  const tt = getTableTools();
  const rs = el('.vditor-ir .vditor-reset');
  if (rs && tt.parentElement !== rs) rs.appendChild(tt);
  refreshToolsState();
  tt.classList.add('show');
  positionTableTools();
}
// R63：选区描边轻量重定位——拖边框（行高/列宽/整表边缘）改变表格几何后，
// .ms-tsel 仍停在旧坐标（用户报障：选中格后拉伸边框，蓝框不跟随）。
// 按实时几何重算（只改 style，不重建高亮类；单元格蓝底 .ms-cell-sel
// 挂在格子上自动跟随，无需处理）
function updateSelBox(table) {
  if (!TBL.sel || !table || !table.isConnected) return;
  if (TBL.sel.table !== getIrTables().indexOf(table)) return;
  const s = TBL.sel;
  if (!selIsFullRect(s)) return; // 非矩形选区没有外框，只有随格高亮
  const tr = table.getBoundingClientRect();
  const rows = Array.from(table.querySelectorAll('tr'));
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let r = s.r1; r <= s.r2; r++) {
    for (let c = s.c1; c <= s.c2; c++) {
      const cell = rows[r] && rows[r].children[c];
      if (!cell) continue;
      const rc = cell.getBoundingClientRect();
      x1 = Math.min(x1, rc.left - tr.left); y1 = Math.min(y1, rc.top - tr.top);
      x2 = Math.max(x2, rc.right - tr.left); y2 = Math.max(y2, rc.bottom - tr.top);
    }
  }
  if (!Number.isFinite(x1)) return;
  let box = table.querySelector(':scope > .ms-tsel');
  if (!box) {
    box = document.createElement('div');
    box.className = 'ms-tsel';
    table.insertBefore(box, table.firstChild);
  }
  box.style.left = x1 + 'px'; box.style.top = y1 + 'px';
  box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
}
function clearTableSelection() {
  sweepTableOrphans(); // R60：清选区时顺带清孤儿覆盖层
  if (!TBL.sel) { if (ttEl) ttEl.classList.remove('show'); return; }
  TBL.sel = null;
  TBL.selAnchor = null;
  TBL.dragging = null; // R61：拖拽路径选中进行中被打断（点外部/Esc/输入）→ 终止
  getIrTables().forEach(t => {
    t.classList.remove('ms-drag-sel'); // R61：兜底清理拖拽期的禁选类
    t.classList.remove('ms-celdrag'); // R65b：兜底清理拖拽期的手柄禁反应类
    t.querySelectorAll('.ms-cell-sel').forEach(c => c.classList.remove('ms-cell-sel'));
    t.querySelectorAll('.ms-tsel').forEach(x => x.remove());
  });
  if (ttEl) ttEl.classList.remove('show');
  // R66：清选区不再隐藏行/列槽——槽是纯 hover 指示器（鼠标离开表格时由
  // hideTableToolsIfNoSel 隐藏）。旧代码在这里也摘 .show：Esc 清选区 /
  // Ctrl+点选到空 时鼠标仍在表格上，槽变 opacity:0 + pointer-events:none，
  // 且 hover 分支不会重建它 → 槽彻底失联，用户再点行槽/列槽毫无反应
}

// ---------------- 左上角悬浮工具条 ----------------
function getTableTools() {
  if (ttEl && document.contains(ttEl)) return ttEl;
  sweepTableOrphans(); // R60：重建前先清掉重解析复活的僵尸工具条
  ttEl = document.createElement('div');
  ttEl.className = 'ms-ttools';
  ttEl.innerHTML =
    '<button class="ms-tt-selall" data-tt="selall" title="' + t('tt.selAll') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/><rect x="5.6" y="5.6" width="4.8" height="4.8" fill="currentColor" stroke="none"/></svg>' +
    '</button><span class="ms-tt-sep"></span>' +
    '<button data-tt="align-left" title="' + t('tt.alignLeft') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3.5h11M2.5 8h7M2.5 12.5h11"/></svg>' +
    '</button>' +
    '<button data-tt="align-center" title="' + t('tt.alignCenter') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3.5h11M4.5 8h7M2.5 12.5h11"/></svg>' +
    '</button>' +
    '<button data-tt="align-right" title="' + t('tt.alignRight') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3.5h11M6.5 8h7M2.5 12.5h11"/></svg>' +
    '</button><span class="ms-tt-sep"></span>' +
    '<button data-tt="row-above" title="' + t('tt.rowAbove') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3h11v10h-11zM2.5 8h11M8 4.1v2.8M6.6 5.5h2.8"/></svg>' +
    '</button>' +
    '<button data-tt="row-below" title="' + t('tt.rowBelow') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3h11v10h-11zM2.5 8h11M8 9.1v2.8M6.6 10.5h2.8"/></svg>' +
    '</button>' +
    '<button data-tt="row-up" title="' + t('tt.rowUp') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 9.5h7M2.5 13.5h7M12 4.5v9M9.5 7 12 4.5 14.5 7"/></svg>' +
    '</button>' +
    '<button data-tt="row-down" title="' + t('tt.rowDown') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 2.5h7M2.5 6.5h7M12 11.5v-9M9.5 9 12 11.5 14.5 9"/></svg>' +
    '</button>' +
    '<button data-tt="del-row" title="' + t('tt.delRow') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 9.5h7M2.5 13.5h7M11.8 4.3l3.4 3.4M15.2 4.3l-3.4 3.4"/></svg>' +
    '</button><span class="ms-tt-sep"></span>' +
    '<button data-tt="col-left" title="' + t('tt.colLeft') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3h11v10h-11zM8 3v10M3.9 8h2.6M5.2 6.7v2.6"/></svg>' +
    '</button>' +
    '<button data-tt="col-right" title="' + t('tt.colRight') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3h11v10h-11zM8 3v10M9.5 8h2.6M10.8 6.7v2.6"/></svg>' +
    '</button>' +
    '<button data-tt="col-move-left" title="' + t('tt.colMoveLeft') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M13.5 2.5v11M11 8H3M5.5 5.5 3 8l2.5 2.5"/></svg>' +
    '</button>' +
    '<button data-tt="col-move-right" title="' + t('tt.colMoveRight') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 2.5v11M5 8h8M9.5 5.5 12 8l-2.5 2.5"/></svg>' +
    '</button>' +
    '<button data-tt="del-col" title="' + t('tt.delCol') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M9.5 2.5v7M13.5 2.5v7M4.3 11.8l3.4 3.4M7.7 11.8l-3.4 3.4"/></svg>' +
    '</button><span class="ms-tt-sep"></span>' +
    '<button data-tt="del-table" title="' + t('tt.delTable') + '">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 3.5h11v9h-11zM2.5 8h11M6.7 5.2l2.6 2.6M9.3 5.2L6.7 7.8"/></svg>' +
    '</button>';
  ttEl.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  ttEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tt]');
    if (b && !b.disabled) handleTableTool(b.dataset.tt);
  });
  return ttEl;
}
function refreshToolsState() {
  if (!ttEl) return;
  const hasSel = !!TBL.sel;
  const dr = ttEl.querySelector('[data-tt="del-row"]');
  const dc = ttEl.querySelector('[data-tt="del-col"]');
  if (dr) dr.disabled = !hasSel;
  if (dc) dc.disabled = !hasSel;
}
function hideTableToolsIfNoSel() {
  // dist67：行/列拖拽进行中保持行槽/工具条可见——拖拽中鼠标一旦离开手柄触发本函数，
  // 会摘掉最左行槽(.ms-grow)的 .show，而行拖拽 onMove 只重定位不恢复 .show → 蓝条「消失」(用户报障)
  if (tableDragging > 0) return;
  if (!TBL.sel) {
    if (ttEl) ttEl.classList.remove('show');
    if (gutRow) gutRow.classList.remove('show');
    if (gutCol) gutCol.classList.remove('show');
  }
}
// 定位工具条：贴紧表格上方（2px 间距）；上方空间不足时顶到内容顶端。
// 工具条是 .vditor-reset（滚动容器，position:relative）的绝对定位子元素，随内容一起滚动，
// top/left 相对「滚动内容」坐标 → 用「表格视口位置 + scrollTop/scrollLeft」换算（见函数内）。
function positionTableTools() {
  if (!ttEl || !ttEl.classList.contains('show')) return;
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  // setValue 的异步重渲染 / Vditor 后台 IR 重同步会清掉 reset 的子节点（含工具条）→ 重新挂回
  if (!document.contains(ttEl)) reset.appendChild(ttEl);
  const idx = TBL.sel ? TBL.sel.table : (TBL.caret ? TBL.caret.table : -1);
  const t = idx >= 0 ? getIrTables()[idx] : null;
  if (!t) { ttEl.classList.remove('show'); return; }
  const rr = reset.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  const ttH = ttEl.offsetHeight || 30;
  // R83-P1：工具条「紧贴表格正上方」（底边距表顶 2px，几乎贴着）——选列槽移到工具条之上
  //（见 positionGutters），不再与工具条抢表格正上方那 8px；修用户「工具条离表格还是太远」。
  // 表格太靠文档顶、上方放不下时回落到表格下方 6px（下方无结构遮挡，安全）。
  // R85-P1：工具条 top/left 相对「滚动内容」坐标——.vditor-reset 是可滚动容器(position:relative)，
  // 绝对定位子元素随内容一起滚动，故必须用「表格视口位置 + scrollTop/scrollLeft」换算成内容坐标，
  // 才能贴住表格当前视口位置。旧版漏加 scrollTop：表格越深(文档中部 scrollTop≈700)工具条越往上
  // 漂(漂到视口外 ~740px)，即用户「离表格还是太远」的根因；滚到文档顶的小表 scrollTop≈0 故没暴露。
  const tableTopContent = (tr.top - rr.top) + reset.scrollTop;
  const tableLeftContent = (tr.left - rr.left) + reset.scrollLeft;
  let top = tableTopContent - 2 - ttH;
  if (top < 0) top = 0;
  let left = tableLeftContent - 3;
  if (left < 0) left = 0;
  ttEl.style.top = top + 'px';
  ttEl.style.left = left + 'px';
  positionGutters();
}

// R57 最新全文 md 基线：DOM 干净（无未同步的用户编辑）时直接复用 tab.content
// （零 WASM 开销）；否则整篇 DOM→md 转换（大文档 ~0.9s，但只有这条路径才能保证
// 刚键入、尚未同步的内容不丢）
function editorMdBaseline() {
  const tab = activeTab();
  if (!state.editorDomDirty && tab && typeof tab.content === 'string' && tab.content.length) return tab.content;
  state.editorDomDirty = false;
  return state.vditor.getValue();
}

// ---------------- 结构操作（MD 层，按选区） ----------------
// R57 表格级 DOM 手术：只换掉这一张表格节点，不整篇 setValue。
// 整篇 setValue = Lute WASM 重解析全文（大文档实测 ~1s 主线程冻结）+ 编辑器 innerHTML
// 整体替换重绘——用户报障「行列移动/插入时表格跳动厉害、闪瞎眼」的根因。
// IR 的 DOM 是 Vditor 的唯一事实源（getValue() 随时从 DOM 派生 md），换掉表格节点后
// 文档其余部分零重绘；表格的 md 由调用方按 nextRows 字符串精确算出（与 DOM 一致）。
// 成功返回 true；任何异常返回 false，调用方回退 setValue（功能不变，只是有闪烁）。
function applyTableOpDom(op, nextRows, dropBlock) {
  try {
    const V = state.vditor, v = V && V.vditor;
    const oldTable = getIrTables()[op.table];
    if (!v || !v.lute || !oldTable || !document.contains(oldTable)) return false;
    if (dropBlock) {
      oldTable.remove();
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = v.lute.Md2VditorIRDOM(nextRows.map(joinRow).join('\n'));
      const newTable = tmp.querySelector('table');
      if (!newTable) return false;
      oldTable.replaceWith(newTable);
    }
    // 延迟入 undo 栈（与 setValue 的 processAfterRender 同延迟）：读到的正是手术后的
    // 全文，Ctrl+Z 可整步撤销本次结构操作
    if (v.undo && typeof v.undo.addMsUndo === 'function') {
      const delay = (v.options && v.options.undoDelay) || 300;
      window.setTimeout(() => {
        if (!v.ir || v.ir.composingLock) return;
        try { v.undo.addMsUndo(v); } catch (e) { }
      }, delay);
    }
    return true;
  } catch (e) { return false; }
}
// op: {table, type: insertRow|deleteRow|insertCol|deleteCol|clearCells|deleteTable,
//      row, col, rows, cols, cells, presel}
// 语义与 opTable（光标版）保持一致：表头行上方不可插入、表头行不可删、至少一列
function tableOp(op) {
  // R57 快速路径：DOM 没有未同步的用户编辑时，tab.content 就是最新全文——
  // 直接对它做字符串手术，省掉整篇 DOM→md 的 Lute WASM 转换（大文档 ~0.9s 冻结）。
  // DOM 领先（刚键入未同步）时回退 getValue()，保证不把键入内容丢掉。
  const md0 = editorMdBaseline();
  const range = findTableBlockRange(md0, op.table);
  if (!range) { toast(t('toast.tableNotFound2')); return false; }
  const rows = range.lines.map(splitRow);
  const nCols = rows[0].length;
  // 视觉行(0=表头, 无分隔行) → markdown 行（表头 0，其余 +1 跳过分隔行）
  const mRow = (v) => (v === 0 ? 0 : v + 1);
  let nextRows = null, dropBlock = false, failMsg = '';
  if (op.type === 'insertRow') {
    if (op.row <= 0) failMsg = t('tbl.noRowAboveHeader');
    else {
      const at = Math.max(1, Math.min(op.row, rows.length - 1)); // 视觉行（不含分隔行）
      nextRows = rows.slice();
      nextRows.splice(mRow(at), 0, new Array(nCols).fill(' '));
    }
  } else if (op.type === 'deleteRow') {
    // 选区若含表头：只删数据行；纯表头选区则拒绝
    const dataRows = op.rows.filter(r => r > 0);
    if (!dataRows.length) failMsg = t('tbl.headerNoDel');
    else {
      const drop = new Set(dataRows.map(mRow));
      nextRows = rows.filter((_, i) => !drop.has(i));
      if (nextRows.length < 2) failMsg = t('tbl.keepOneRow');
    }
  } else if (op.type === 'insertCol') {
    const at = Math.max(0, Math.min(op.col, nCols));
    nextRows = rows.map((r, i) => { const a = r.slice(); a.splice(at, 0, i === 1 ? '---' : ' '); return a; });
  } else if (op.type === 'deleteCol') {
    if (nCols <= 1) failMsg = t('tbl.lastColLeft');
    else {
      const drop = new Set(op.cols);
      nextRows = rows.map(r => r.filter((_, c) => !drop.has(c)));
    }
  } else if (op.type === 'moveRow') {
    // 整块数据行上/下移（op.rows = 视觉行号集合，0=表头不参与）
    const band = (op.rows || []).filter(r => r > 0).sort((a, b) => a - b);
    if (!band.length) failMsg = t('tbl.headerNoMove');
    else {
      const from = band[0] + 1, len = band.length, to = from + op.dir; // 视觉行→md 行（跳过分隔行）
      if (op.dir < 0 && from < 3) failMsg = t('tbl.firstDataRow');
      else if (op.dir > 0 && to + len - 1 > rows.length - 1) failMsg = t('tbl.lastRow');
      else { const seg = rows.slice(from, from + len); nextRows = rows.slice(); nextRows.splice(from, len); nextRows.splice(to, 0, ...seg); }
    }
  } else if (op.type === 'moveCol') {
    // 整块列左/右移（op.col=首列, op.cols=块宽）
    const from = op.col, len = op.cols || 1, to = from + op.dir;
    if (op.dir < 0 && from < 1) failMsg = t('tbl.firstCol');
    else if (op.dir > 0 && to + len - 1 > nCols - 1) failMsg = t('tbl.lastCol');
    else nextRows = rows.map(r => { const a = r.slice(); const seg = a.splice(from, len); a.splice(to, 0, ...seg); return a; });
  } else if (op.type === 'clearCells') {
    // R61：op.cells 是视觉行号（0=表头、无分隔行），rows.map 的 i 是 md 行号
    // （1=分隔行）——旧代码直接混用，清数据行 1 实际清掉的是分隔行（t215 实测：
    // 选 (1,0) 清空后 md 变成 |   | -- | -- |，表格差点塌掉）
    const drop = new Set(op.cells.map(p => mRow(p.r) * 100 + p.c));
    nextRows = rows.map((r, i) => r.map((c, k) => (drop.has(i * 100 + k) ? ' ' : c)));
  } else if (op.type === 'deleteTable') {
    dropBlock = true;
  }
  if (failMsg || (!nextRows && !dropBlock)) { if (failMsg) toast(failMsg); return false; }
  const md2 = md0.slice(0, range.startOffset)
    + (dropBlock ? '' : nextRows.map(joinRow).join('\n'))
    + md0.slice(range.startOffset + range.length);
  if (md2 === md0) return false;
  {
    const tab0 = activeTab();
    // 列结构变化（插/删/移列）：必须在整篇回写之前改写列宽记录——setValue 同步重渲染，
    // 渲染后光标落位会触发选区变化；若记录还是旧列数，钉死守卫会误判「新表」而重钉
    const L0 = tab0 && tab0.tableLayout && tab0.tableLayout[op.table];
    if (L0 && L0.cols && L0.cols.length && !dropBlock) {
      if (op.type === 'insertCol') L0.cols = retabCols(L0.cols, 'insert', op.col);
      else if (op.type === 'deleteCol') L0.cols = retabCols(L0.cols, 'delete', null, op.cols);
      else if (op.type === 'moveCol') L0.cols = retabCols(L0.cols, 'move', null, null, op.col, op.cols || 1, op.col + op.dir);
    }
  }
  if (!applyTableOpDom(op, nextRows, dropBlock)) state.vditor.setValue(md2);
  const tab = activeTab();
  if (tab) {
    tab.content = md2;
    if (dropBlock && tab.tableLayout) {
      // 表格数减少：后面的宽度记录前移一位
      const shifted = {};
      Object.keys(tab.tableLayout).forEach(k => { if (+k > op.table) shifted[+k - 1] = tab.tableLayout[+k]; });
      tab.tableLayout = shifted;
    }
  }
  setDirty(true);
  scheduleOutline(md2);
  refreshLinesSoon();
  fixImagesSoon();
  updateStats(md2);
  refreshToolbarState();
  clearTableSelection();
  // 新表格此刻已在 DOM 中（手术替换与 setValue 的 innerHTML 都是同步的）：直接重放
  // 布局与选区。不能等 120ms——等待期间会先渲染一帧「自然列宽/行高」的表格再跳回
  // 保存值，这是跳动感的另一来源。R60：pinNew——手术替换的表格是新节点，确保钉死
  reapplyTableLayout(true);
  if (op.presel && op.type !== 'deleteTable') {
    const t = getIrTables()[op.table];
    if (t) {
      const nr = t.querySelectorAll('tr').length;
      const nc = t.querySelector('tr') ? t.querySelector('tr').children.length : 0;
      if (nr && nc) {
        let cells = null;
        if (op.presel.cells && op.presel.cells.length) {
          // R61：路径多选的精确集合跟随结构变化（删/移行列入口有矩形校验拦截，
          // 集合能活到这里的只有 insertRow / insertCol / clearCells 三种）
          cells = op.presel.cells.slice();
          if (op.type === 'insertRow') cells = cells.map(p => (p.r >= op.row ? { r: p.r + 1, c: p.c } : p));
          else if (op.type === 'insertCol') cells = cells.map(p => (p.c >= op.col ? { r: p.r, c: p.c + 1 } : p));
          cells = cells.filter(p => p.r < nr && p.c < nc);
          if (!cells.length) cells = null;
        }
        if (cells) {
          const bb = selBBox(cells);
          TBL.sel = { table: op.table, r1: bb.r1, c1: bb.c1, r2: bb.r2, c2: bb.c2, cells };
        } else {
          TBL.sel = {
            table: op.table,
            r1: Math.max(0, Math.min(op.presel.r1, nr - 1)),
            c1: Math.max(0, Math.min(op.presel.c1, nc - 1)),
            r2: Math.max(0, Math.min(op.presel.r2, nr - 1)),
            c2: Math.max(0, Math.min(op.presel.c2, nc - 1))
          };
          if (TBL.sel.r1 > TBL.sel.r2) TBL.sel.r1 = TBL.sel.r2;
          if (TBL.sel.c1 > TBL.sel.c2) TBL.sel.c1 = TBL.sel.c2;
        }
        renderTableSelection();
      }
    }
    // 手术路径下槽/工具条未被清（它们是表格兄弟节点）；重建一次保证引用的是新表格
    // （setValue 回退路径则必须重建——整篇回写会清掉 reset 子节点）
    if (TBL.sel) buildGutters(op.table);
  } else if (op.type === 'deleteTable') {
    removeGutters();
  }
  return true;
}

function handleTableTool(op) {
  const tables = getIrTables();
  let idx = TBL.sel ? TBL.sel.table : (TBL.caret ? TBL.caret.table : -1);
  if (idx < 0 || !tables[idx]) { toast(t('toast.hoverTable')); return; }
  if (op === 'selall') {
    const t = tables[idx];
    const nr = t.querySelectorAll('tr').length;
    const nc = t.querySelector('tr') ? t.querySelector('tr').children.length : 0;
    TBL.selAnchor = { table: idx, r: 0, c: 0 };
    TBL.sel = { table: idx, r1: 0, c1: 0, r2: Math.max(0, nr - 1), c2: Math.max(0, nc - 1) };
    renderTableSelection();
    return;
  }
  const s = TBL.sel;
  const caretPos = (TBL.caret && TBL.caret.table === idx) ? TBL.caret : null;
  // R61：删/移行列是按整行整列操作的；路径多选（非矩形）时「选中了哪些行/列」
  // 语义不明确 → 提示改选矩形区域。插入/对齐/清空按集合本身执行，不受限
  const needRect = (msg) => { if (s && !selIsFullRect(s)) { toast(msg); return true; } return false; };
  if (op === 'row-above') tableOp({ table: idx, type: 'insertRow', row: s ? s.r1 : (caretPos ? caretPos.r : 0), presel: s });
  else if (op === 'row-below') tableOp({ table: idx, type: 'insertRow', row: s ? s.r2 + 1 : (caretPos ? caretPos.r + 1 : 1), presel: s });
  else if (op === 'col-left') tableOp({ table: idx, type: 'insertCol', col: s ? s.c1 : (caretPos ? caretPos.c : 0), presel: s });
  else if (op === 'col-right') tableOp({ table: idx, type: 'insertCol', col: s ? s.c2 + 1 : (caretPos ? caretPos.c + 1 : 1), presel: s });
  else if (op === 'del-row') { if (!s) return; if (needRect(t('tbl.rectDelRow'))) return; const rows = []; for (let r = s.r1; r <= s.r2; r++) rows.push(r); tableOp({ table: s.table, type: 'deleteRow', rows, presel: s }); }
  else if (op === 'del-col') { if (!s) return; if (needRect(t('tbl.rectDelCol'))) return; const cols = []; for (let c = s.c1; c <= s.c2; c++) cols.push(c); tableOp({ table: s.table, type: 'deleteCol', cols, presel: s }); }
  else if (op === 'del-table') tableOp({ table: idx, type: 'deleteTable' });
  else if (op === 'row-up' || op === 'row-down') {
    // 整块行上/下移：选区版移选中行带，光标版移光标所在行（表头行 tableOp 内拒绝）
    const dir = op === 'row-up' ? -1 : 1;
    if (!s && !caretPos) return;
    if (needRect(t('tbl.rectMoveRow'))) return;
    const rows = s ? [] : [caretPos.r];
    if (s) { for (let r = s.r1; r <= s.r2; r++) rows.push(r); }
    tableOp({ table: idx, type: 'moveRow', rows, dir, presel: s });
  }
  else if (op === 'col-move-left' || op === 'col-move-right') {
    // 整块列左/右移：选区版移选中列块，光标版移光标所在列
    const dir = op === 'col-move-left' ? -1 : 1;
    if (!s && !caretPos) return;
    if (needRect(t('tbl.rectMoveCol'))) return;
    const c1 = s ? s.c1 : caretPos.c;
    const len = s ? (s.c2 - s.c1 + 1) : 1;
    tableOp({ table: idx, type: 'moveCol', col: c1, cols: len, dir, presel: s });
  }
  else if (op === 'align-left' || op === 'align-center' || op === 'align-right') applyTableAlign(tables[idx], op.slice(6));
}

// 单元格文字对齐（R47）：lute 的 DOM→MD 只从表头行 th 读 align 属性
// 生成 md 的 :---: 对齐标记，td 上的属性只影响视觉（浏览器对表格单元格的 align
// 遗留属性支持 text-align）。因此：选中列的表头 th 写属性（持久化）+ 选中单元格
// 同步写属性（即时视觉）。对齐是列级属性（GFM 表格无单元格级对齐），整列生效。
// R61：第三个参数 cells = 精确单元格集合（拖拽路径多选/右键菜单「单独设置」）——
// 只对集合内的单元格写 align，不再把整列表头都带上（用户要求「选中的这些单元格
// 单独设置」）。集合里的表头格仍会持久化到 md 对齐标记，数据格为视觉态
function applyCellAlign(align, range, cells) {
  const tables = getIrTables();
  let t = null, r1, c1, r2, c2;
  if (range && range.table != null && tables[range.table]) {
    t = tables[range.table];
    r1 = range.r1; c1 = range.c1; r2 = range.r2; c2 = range.c2;
  } else if (TBL.sel && tables[TBL.sel.table]) {
    t = tables[TBL.sel.table];
    r1 = TBL.sel.r1; c1 = TBL.sel.c1; r2 = TBL.sel.r2; c2 = TBL.sel.c2;
  } else {
    const info = getTableInfoAtCaret();
    if (!info || !tables[info.index]) { toast(t('toast.hoverTableIn')); return; }
    t = tables[info.index];
    r1 = r2 = info.row; c1 = c2 = info.col;
  }
  const rows = Array.from(t.querySelectorAll('tr'));
  // 左对齐也必须显式写 align="left"（不能删属性）：表头 th 的 UA 默认是
  // 居中，删属性后没有任何规则可覆盖居中，整表左对齐时首行标题不生效
  // （用户报障②）。lute DOM→MD 会把 align="left" 写成合法标记 :---，往返一致
  const setAttr = (cell) => {
    if (!cell) return;
    cell.setAttribute('align', align);
  };
  if (cells && cells.length) {
    // R61 精确集合：只写选中的单元格（表头格 → 持久化；数据格 → 视觉态）
    cells.forEach(p => setAttr(rows[p.r] && rows[p.r].children[p.c]));
  } else {
    // R66a：表头只在选区真正覆盖第 0 行时才写（行槽整行选中数据行后右键对齐，
    // 标题行不再被顺手改掉——旧代码无条件写 rows[0] 即用户报障）
    if (r1 <= 0) for (let c = c1; c <= c2; c++) setAttr(rows[0] && rows[0].children[c]); // 表头列：持久化到 md
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) setAttr(rows[r] && rows[r].children[c]);
  }
  // 同步内存内容（align 属性已改变 DOM→MD 的结果，不必整篇重渲染）
  const md = state.vditor.getValue();
  const tab = activeTab();
  if (tab) tab.content = md;
  setDirty(true);
  scheduleOutline(md);
  refreshLinesSoon();
  updateStats(md);
}
// 工具条「整表对齐」：作用到该表格全部单元格（表头 th 写属性 → 持久化到 md 对齐标记）
function applyTableAlign(t, align) {
  const tables = getIrTables();
  const idx = tables.indexOf(t);
  if (idx < 0 || !t) return;
  const rows = t.querySelectorAll('tr');
  const first = t.querySelector('tr');
  if (!rows.length || !first) return;
  applyCellAlign(align, { table: idx, r1: 0, c1: 0, r2: rows.length - 1, c2: first.children.length - 1 });
}
// 工具条「表格自动换行」开关（按表格记忆，重渲染后由 reapplyTableLayout 恢复）：
// 关闭后单元格文字不折行，表格宽度改为内容宽（max-content），超出正文时横向滚动
function applyTableWrap(t, on) {
  if (!t) return;
  Array.from(t.querySelectorAll('td,th')).forEach((c) => { c.style.whiteSpace = on ? '' : 'nowrap'; });
  t.style.width = on ? '' : 'max-content';
  t.style.minWidth = on ? '' : '100%';
}
function toggleTableWrap(t) {
  const tables = getIrTables();
  const idx = tables.indexOf(t);
  if (idx < 0) return;
  const tab = activeTab();
  if (!tab) return;
  tab.tableLayout = tab.tableLayout || {};
  tab.tableLayout[idx] = tab.tableLayout[idx] || {};
  tab.tableLayout[idx].nowrap = !tab.tableLayout[idx].nowrap;
  applyTableWrap(t, !tab.tableLayout[idx].nowrap);
  refreshToolsState();
  if (TBL.sel) renderTableSelection(); else positionTableTools();
  refreshLinesSoon();
}

// 选区生效时 Backspace/Delete 清空选中单元格内容（R61：路径多选按精确集合清）
function clearSelectedCells() {
  const s = TBL.sel;
  if (!s) return;
  const cells = (s.cells && s.cells.length) ? s.cells.slice() : [];
  if (!cells.length) for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) cells.push({ r, c });
  tableOp({ table: s.table, type: 'clearCells', cells, presel: s });
}

// ---------------- 列宽 / 行高拖拽 ----------------
// tableDragging：行/列拖拽进行中。此期间 refreshLines 跳过整列重建（Vditor 的输入回调
// 会在停顿 800ms 后异步触发，若落在长拖拽中途，大文档下整列重建 ~70ms 会打断拖拽）；
// 拖拽结束由 onUp 强制重建一次收敛。
let tableDragging = 0;
// 重要：Vditor 的 VditorIRDOM2Md（getValue 每次实时 DOM→MD）遇到 <colgroup> 会把
// 整个表格转丢（实测空 colgroup 也会）。因此列宽一律写表头行 th 的内联 width +
// table-layout:fixed（实测对 md 转换完全无影响），绝不用 colgroup。
function currentColPcts(table) {
  const firstRow = table.querySelector('tr');
  if (!firstRow) return [];
  const cw = table.getBoundingClientRect().width || 1;
  return Array.from(firstRow.children).map((c) => {
    const w = parseFloat(c.style.width);
    if (Number.isFinite(w) && c.style.width.indexOf('%') !== -1) return w;
    return (c.getBoundingClientRect().width / cw) * 100;
  });
}
function setColPct(table, colIdx, pct) {
  const firstRow = table.querySelector('tr');
  const cell = firstRow && firstRow.children[colIdx];
  if (cell) cell.style.width = pct + '%';
  table.style.tableLayout = 'fixed';
}
// 拖拽期间表格高度变化（行高调整、列宽引发文字换行）会把表格下方的块整体下移，
// 行号必须同步。整列重建在大文档（1700+ 块）要 ~70ms/次，不能每帧做——
// 这里只把「位于表格下缘之下」的行号按高度增量平移（纯 style.top 算术，无布局读取），
// 拖拽结束后再强制一次完整重建收敛到精确位置。
function gutterShiftBelowTable(table, lastH) {
  const inner = el('#line-gutter-inner');
  const gEl = el('#line-gutter');
  const reset = el('.vditor-ir .vditor-reset');
  if (!inner || !gEl || !reset || !inner.children.length) return lastH;
  const newH = table.offsetHeight;
  // 首次调用只记录基线（mousedown 时的高度）：lastH 为 null 时返回 newH 而非
  // null——否则增量平移永远是死代码，行号只能等拖拽结束的重建才更新（用户投诉：
  // 拖动过程中行号不动，松手才跳变）
  if (lastH == null) return newH;
  if (newH === lastH) return newH;
  const dH = newH - lastH;
  const gTop = gEl.getBoundingClientRect().top;
  const tblBottom = table.getBoundingClientRect().top - gTop + reset.scrollTop + newH;
  const kids = inner.children;
  // 行号 top 按块序升序 → 二分找第一个位于表格下缘之下的行号
  let lo = 0, hi = kids.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (parseFloat(kids[mid].style.top) < tblBottom) lo = mid + 1; else hi = mid; }
  // 巨量行号（超大文档）时跳过增量平移：每帧写上千个 style 本身就是长任务，
  // 改由拖拽结束时的强制完整重建一次性收敛
  if (kids.length - lo > 400) return newH;
  for (let i = lo; i < kids.length; i++) {
    kids[i].style.top = (parseFloat(kids[i].style.top) + dH) + 'px';
  }
  inner.style.height = (parseFloat(inner.style.height) + dH) + 'px';
  return newH;
}
// 最左/最右边框拖拽 = 只拉伸第一/最后一列（不是整表宽度）：
// 其余各列像素宽保持不变，首/末列吸收表宽的全部变化，总宽恒等于新表宽（100%）。
// 吸收列下限为新表宽的 4%；钳制时剩余宽度按原比例分给其余列。
function applyEdgeColAbsorb(table, pcts0, oldTblW, newTblW, edge) {
  const fr = table.querySelector('tr');
  if (!fr) return;
  const n = fr.children.length;
  if (!n) return;
  const absorbIdx = edge === 'l' ? 0 : n - 1;
  let absorbPx = (pcts0[absorbIdx] / 100) * oldTblW + (newTblW - oldTblW);
  const minPx = 0.04 * newTblW;
  if (absorbPx < minPx) absorbPx = minPx;
  const others = [];
  let othersOrig = 0;
  for (let i = 0; i < n; i++) {
    if (i === absorbIdx) continue;
    const px = (pcts0[i] / 100) * oldTblW;
    others.push({ i, px });
    othersOrig += px;
  }
  const remain = newTblW - absorbPx;
  others.forEach((o) => {
    const target = othersOrig > 0 ? remain * (o.px / othersOrig) : remain / others.length;
    setColPct(table, o.i, (target / newTblW) * 100);
  });
  setColPct(table, absorbIdx, (absorbPx / newTblW) * 100);
}
function startColDrag(e, table, idx, col) {
  e.preventDefault(); e.stopPropagation();
  if (e.button !== 0) return;
  const tab0 = activeTab();
  const saved0 = (tab0 && tab0.tableLayout && tab0.tableLayout[idx]) || {};
  const hadSaved = !!(saved0.cols && saved0.cols.length);
  const firstRow0 = table.querySelector('tr');
  const n = firstRow0 ? firstRow0.children.length : 0;
  if (!n) return;
  // col 语义：0=最左边框（拖→只拉伸第一列，表左缘 1:1 跟手），
  // n=最右边框（拖→只拉伸最后一列，表右缘 1:1 跟手），
  // 1..n-1=内边界（调相邻两列宽）。手柄是表格子元素，边缘手柄随表缘移动，
  // 高亮线恒与实际边框重合。
  const edge = col === 0 ? 'l' : (col === n ? 'r' : null);
  // 先把当前所有列宽写入表头行 th，切到 fixed 布局后其余列不跳动
  const pcts0 = currentColPcts(table);
  table.style.tableLayout = 'fixed';
  const firstRow = table.querySelector('tr');
  if (firstRow) pcts0.forEach((p, k) => { if (firstRow.children[k]) firstRow.children[k].style.width = p + '%'; });
  const startRect = table.getBoundingClientRect();
  const startX = e.clientX;
  const h = e.currentTarget;
  const slRaw = h.style.left || '0';
  // 手柄 left 可能是 %（刚构建）或 px（上次拖拽后残留），统一换算成像素
  const startLeftPx = edge ? 0 : (/%$/.test(slRaw) ? (parseFloat(slRaw) / 100) * startRect.width : (parseFloat(slRaw) || 0));
  const hScale = (startRect.width || 1) / 100; // 1% 列宽对应的像素
  const minTbl = 20; // 整表最小宽度（%），防止拖没
  // 外边框模式：表宽/边距的 % 与鼠标位移都以「包含块」（表格父元素内容盒）为参照
  const cb = table.parentElement;
  const cbPad = cb ? (parseFloat(getComputedStyle(cb).paddingLeft) || 0) + (parseFloat(getComputedStyle(cb).paddingRight) || 0) : 0;
  const contW = cb ? (cb.clientWidth - cbPad) || startRect.width : (startRect.width || 1);
  let w0 = 100, ml0 = 0;
  if (edge && cb) {
    w0 = (parseFloat(getComputedStyle(table).width) / contW) * 100; // 当前表宽（%）
    const csMl = getComputedStyle(table).marginLeft;
    ml0 = csMl === 'auto' ? 0 : (parseFloat(csMl) / contW) * 100;
  }
  h.classList.add('ms-dragging');
  tableDragging++;
  // 拖拽期间把重排/重绘范围锁在表格内（大文档下每帧只重绘表格，不再波及整页）
  table.style.contain = 'layout paint';
  let moved = false, raf = 0, pending = null, lastH = table.offsetHeight;
  const applyAt = (mouseX) => {
    // 内边界：列宽 % 相对表宽；外边框：表宽 % 相对容器宽
    const dx = (mouseX - startX) / (edge ? contW : (startRect.width || 1)) * 100;
    if (edge === 'l') {
      // 表左缘 1:1 跟手（手柄是表格子元素 left:0%，随表格一起移动，高亮恒贴实际边框）；
      // 右缘固定。表宽变化全部由第一列吸收，其余列像素宽不变
      const contLeft = startRect.left - (ml0 / 100) * contW;
      const ml = Math.max(0, Math.min(ml0 + w0 - minTbl, (mouseX - contLeft) / contW * 100));
      table.style.marginLeft = ml + '%';
      const newW = w0 - (ml - ml0);
      table.style.width = newW + '%';
      applyEdgeColAbsorb(table, pcts0, startRect.width, (newW / 100) * contW, 'l');
    } else if (edge === 'r') {
      // 表右缘 1:1 跟手（手柄 calc(100% - 8px) 随表格右缘移动）；左缘固定。
      // 表宽变化全部由最后一列吸收，其余列像素宽不变
      const w = Math.max(minTbl, Math.min(100 - ml0, (mouseX - startRect.left) / contW * 100));
      table.style.width = w + '%';
      applyEdgeColAbsorb(table, pcts0, startRect.width, (w / 100) * contW, 'r');
    } else {
      const leftW = pcts0[col - 1], rightW = pcts0[col], total = leftW + rightW;
      const nw = Math.max(4, Math.min(total - 4, leftW + dx));
      setColPct(table, col - 1, nw);
      setColPct(table, col, total - nw);
      h.style.left = (startLeftPx + (nw - leftW) * hScale) + 'px';
    }
    lastH = gutterShiftBelowTable(table, lastH);
    updateSelBox(table); // R63：列几何每帧变化，选区描边同步跟随
    positionGutters(); // R88-2：边缘拖拽改表宽/左边距，行列选择槽随表格边框实时跟随
  };
  // 每帧最多应用一次、且用「最新」鼠标位置（不用缓动插值）：鼠标事件成批到达
  // （VDI 高延迟）时边界直接跳到最新位置，蓝线始终贴合鼠标，不落后不抖动
  const tick = () => { raf = 0; if (pending !== null) { const m = pending; pending = null; applyAt(m); } };
  const onMove = (ev) => {
    if (Math.abs(ev.clientX - startX) >= 1) moved = true;
    pending = ev.clientX;
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (pending !== null) { applyAt(pending); pending = null; }
    // 拖拽改变了列几何（尤其边缘=首末列吸收，内边界整体平移）：把手柄重新对齐实际边框
    syncHandlePositions(table);
    updateSelBox(table); // R63：收敛到最终几何（无位移的点击路径由 reapply 兜底）
    positionGutters(); // R88-2：收敛到最终几何
    tableDragging--;
    table.style.contain = '';
    h.classList.remove('ms-dragging');
    const tab = activeTab();
    if (!tab) return;
    if (moved) {
      tab.tableLayout = tab.tableLayout || {};
      tab.tableLayout[idx] = tab.tableLayout[idx] || {};
      tab.tableLayout[idx].cols = currentColPcts(table);
      if (edge) {
        const w = (parseFloat(getComputedStyle(table).width) / contW) * 100;
        const csMl = getComputedStyle(table).marginLeft;
        const ml = csMl === 'auto' ? 0 : (parseFloat(csMl) / contW) * 100;
        tab.tableLayout[idx].tbl = (Math.abs(w - 100) < 0.2 && Math.abs(ml) < 0.2) ? null : { w: Math.round(w * 10) / 10, ml: Math.round(ml * 10) / 10 };
      }
    } else if (edge) {
      // 只是点了一下（没拖）：还原表宽与边距
      table.style.width = '';
      table.style.marginLeft = '';
      if (hadSaved) reapplyTableLayout();
      else {
        const fr = table.querySelector('tr');
        if (fr) Array.from(fr.children).forEach((c) => { c.style.width = ''; });
        table.style.tableLayout = '';
      }
    } else if (hadSaved) {
      reapplyTableLayout(); // 只是点了一下（没拖）：恢复已保存的列宽
    } else {
      // 点了一下且从未拖过：还原自然布局，别把表格留在 fixed 状态
      const fr = table.querySelector('tr');
      if (fr) Array.from(fr.children).forEach((c) => { c.style.width = ''; });
      table.style.tableLayout = '';
    }
    // 拖拽结束强制完整重建行号（增量平移是近似值，且列宽变化可能改变块高度）
    refreshLines._irSig = null;
    refreshLinesSoon();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', onUp);
}
function startRowDrag(e, table, idx, row) {
  e.preventDefault(); e.stopPropagation();
  if (e.button !== 0) return;
  const tr = Array.from(table.querySelectorAll('tr'))[row];
  if (!tr) return;
  const startY = e.clientY;
  const startH = tr.getBoundingClientRect().height;
  // 自然高度（内容撑开的最小高度）：临时清除声明高度量一次再还原。
  // 行高钳制到自然高度而不是 24px——24px 小于单元格内容高度时声明值不生效
  // （行按内容渲染），手柄线却跟着声明值走，会与真实边框脱节（用户报障③）
  const prevH = tr.style.height;
  tr.style.height = '';
  const naturalH = Math.ceil(tr.getBoundingClientRect().height);
  tr.style.height = prevH;
  const h = e.currentTarget;
  const startTop = parseFloat(h.style.top) || 0;
  h.classList.add('ms-dragging');
  tableDragging++;
  // 与列拉伸一致：重排/重绘范围锁在表格内
  table.style.contain = 'layout paint';
  let moved = false;
  let lastH = table.offsetHeight;
  let rafId = 0; // dist67：rAF 节流——高刷 mousemove 可能每帧多次，把 3 个强制 reflow 的函数
                 // (gutterShiftBelowTable/updateSelBox/positionGutters) 合并为每帧最多一次，
                 // 消除「每事件多次同步 layout」造成的卡顿；行高/手柄仍每事件实时写(保持跟手)
  const onMove = (ev) => {
    const dy = ev.clientY - startY;
    if (Math.abs(dy) >= 1) moved = true;
    const nh = Math.max(naturalH, startH + dy);
    tr.style.height = nh + 'px';
    // 蓝色手柄线跟随行边界移动（与行实际生效的高度差一致，含最小高度钳制）
    h.style.top = (startTop + (nh - startH)) + 'px';
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        lastH = gutterShiftBelowTable(table, lastH);
        updateSelBox(table); // R63：行高每帧变化，选区描边同步跟随
        positionGutters(); // 行槽随表格高度实时拉伸（列拖拽 applyAt 已有、行拖拽遗漏 → 用户报障：最左蓝条不跟手）
      });
    }
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
    tableDragging--;
    table.style.contain = '';
    h.classList.remove('ms-dragging');
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } // dist67：取消挂起的 rAF
    lastH = gutterShiftBelowTable(table, lastH);            // 补上最后一帧可能未跑的增量平移
    syncHandlePositions(table); // 行高变化后重定位其余手柄
    updateSelBox(table); // R63：收敛到最终行高
    positionGutters(); // 行槽收敛到最终表格高度（同列拖拽 onUp）
    if (!moved) return; // 只是点了一下（没拖）：不改行高、不覆盖已保存的值
    const tab = activeTab();
    if (tab) {
      tab.tableLayout = tab.tableLayout || {};
      tab.tableLayout[idx] = tab.tableLayout[idx] || {};
      tab.tableLayout[idx].rows = tab.tableLayout[idx].rows || {};
      tab.tableLayout[idx].rows[row] = Math.round(tr.getBoundingClientRect().height);
    }
    // 行高变化会移动表格下方的块：强制完整重建行号收敛
    refreshLines._irSig = null;
    refreshLinesSoon();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', onUp);
}
// 在表格上生成列/行边界手柄
// 把已存在的手柄重新对齐到当前实际边框（轻量：只写 style，不重建节点）。
// 任何几何变化后调用（拖拽结束 / 重渲染重放 / 窗口缩放）：
// 边缘拖拽=首末列吸收会让所有内边界整体平移，旧的手柄位置不再贴边框，
// 不重定位就会出现「再次拉伸时高亮线和实际边框错位」
function syncHandlePositions(table) {
  if (!table.querySelector('.ms-cre')) return;
  const rows = Array.from(table.querySelectorAll('tr'));
  const head = rows.length ? Array.from(rows[0].children) : [];
  const n = head.length;
  if (!n) return;
  const cw = table.getBoundingClientRect().width || 1;
  const pctOf = (c) => (c.style.width && c.style.width.indexOf('%') !== -1) ? parseFloat(c.style.width) : (c.getBoundingClientRect().width / cw) * 100;
  const posMap = new Map();
  let acc = 0;
  head.forEach((c, col) => {
    if (col > 0) posMap.set(col, acc);
    acc += pctOf(c);
  });
  table.querySelectorAll('.ms-cre').forEach((h) => {
    const c = parseInt(h.dataset.col, 10);
    if (c === 0) h.style.left = '0%';
    else if (c === n) h.style.left = 'calc(100% - 8px)';
    else if (posMap.has(c)) h.style.left = posMap.get(c) + '%';
  });
  // 行手柄按 data-row（它负责调整的行）定位，不能按 DOM 序：
  // buildResizeHandles 用 insertBefore(firstChild) 建手柄，DOM 序是
  // [末行下缘, r末-1, …, r1]（倒序），按序升序分配 top 会把每个手柄错配到
  // 另一条边界上——而 mouseover 到手柄就会触发本函数，用户刚悬停手柄位置就
  // 被错配，拖「第 N 行边框」实际改的是别的行（用户报障①）
  // R71：贴「实际」边框线定位——vendor 表格 border-collapse: collapse，1px 边框线
  // 画在行盒边界的正中（一半在行盒内、一半在外）；旧代码用 offsetHeight 整数累加
  // 作基准最多漂移 1px，末行手柄还带 y-5 偏移（当年 display:block+overflow:auto
  // 为留在盒内防裁剪），切换 display:table 后已不被裁剪（计算值 overflow=visible），
  // 偏移反而造成「高亮线与实际边框线之间有空隙」（用户报障）。改用小数行 rect：
  // 手柄 top 值 = 线中心（视口坐标）- 首行顶（绝对定位子元素包含块的顶边）
  const rres = table.querySelectorAll('.ms-rre');
  if (rres.length) {
    const base = rows[0].getBoundingClientRect().top;
    const rowTops = rows.map((tr) => tr.getBoundingClientRect().top);
    const lastBottom = rows[rows.length - 1].getBoundingClientRect().bottom;
    rres.forEach((h) => {
      if (h.classList.contains('ms-rre-last')) {
        h.style.top = (lastBottom - base) + 'px'; // 末行手柄贴末行盒底缘（底边框线正中）
      } else {
        const k = parseInt(h.dataset.row, 10);
        if (k >= 0 && rowTops[k + 1] != null) h.style.top = (rowTops[k + 1] - base) + 'px'; // 调 row k 的手柄贴 row k+1 的上边界
      }
    });
  }
}
// 注意：所有覆盖层 div 一律插到 index 0（首行之前）——Vditor 内部用
// table.lastElementChild.lastElementChild.lastElementChild 取「最后一行/最后一格」
// （isLastCell、表后 Backspace 合并），覆盖层必须是前导节点，不能是末尾节点。
// 列手柄位置用 %（相对表格宽）：整表宽度变化（拖最左/最右边框）时内边界手柄自动跟随，
// 无需重算。data-col：0=最左边框（调整表宽/左边距），1..n-1=内边界（调相邻两列），n=最右边框（调整表宽）
function buildResizeHandles(table, idx) {
  table.querySelectorAll('.ms-cre,.ms-rre').forEach(x => x.remove());
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return;
  const head = Array.from(rows[0].children);
  const n = head.length;
  if (n === 0) return;
  // 最左边框：命中区在表格内左侧 8px（表格 overflow 会裁剪盒外子元素），高亮线贴左缘
  {
    const h = document.createElement('div');
    h.className = 'ms-cre ms-cre-edge-l';
    h.style.left = '0%';
    h.dataset.col = '0';
    h.addEventListener('mousedown', (e) => startColDrag(e, table, idx, 0));
    table.insertBefore(h, table.firstChild);
  }
  let accPct = 0;
  const cw = table.getBoundingClientRect().width || 1;
  head.forEach((c, col) => {
    const pct = (parseFloat(c.style.width) && c.style.width.indexOf('%') !== -1) ? parseFloat(c.style.width) : (c.getBoundingClientRect().width / cw) * 100;
    if (col > 0) {
      const h = document.createElement('div');
      h.className = 'ms-cre';
      h.style.left = accPct + '%';
      h.dataset.col = String(col);
      h.addEventListener('mousedown', (e) => startColDrag(e, table, idx, col));
      table.insertBefore(h, table.firstChild);
    }
    accPct += pct;
  });
  // 最右边框：命中区在表格内右侧 8px，高亮线贴右缘
  {
    const h = document.createElement('div');
    h.className = 'ms-cre ms-cre-edge-r';
    h.style.left = 'calc(100% - 8px)';
    h.dataset.col = String(n);
    h.addEventListener('mousedown', (e) => startColDrag(e, table, idx, n));
    table.insertBefore(h, table.firstChild);
  }
  // R71：行手柄贴实际边框线（小数行 rect；原理见 syncHandlePositions 注释）。
  // 末行手柄中心 = 末行盒底缘 = 底边框线正中；8px 命中区下半伸入表格下边距——
  // 当前表格是 display:table（计算值 overflow=visible，不裁剪），旧「y-5 留盒内」
  // 偏移已无必要且正是错位来源
  const base = rows[0].getBoundingClientRect().top;
  const rowTops = rows.map((tr) => tr.getBoundingClientRect().top);
  rows.forEach((tr, r) => {
    if (r > 0) {
      const h = document.createElement('div');
      h.className = 'ms-rre';
      h.style.top = (rowTops[r] - base) + 'px';
      h.dataset.row = String(r - 1); // syncHandlePositions 按此定位（不依赖 DOM 序）
      // 常见办公软件语义：拖「第 r 行的上边框」→ 上一行（r-1）变高，而不是本行
      h.addEventListener('mousedown', (e) => startRowDrag(e, table, idx, r - 1));
      table.insertBefore(h, table.firstChild);
    }
  });
  {
    const h = document.createElement('div');
    h.className = 'ms-rre ms-rre-last';
    h.style.top = (rows[rows.length - 1].getBoundingClientRect().bottom - base) + 'px';
    h.dataset.row = String(rows.length - 1);
    h.addEventListener('mousedown', (e) => startRowDrag(e, table, idx, rows.length - 1));
    table.insertBefore(h, table.firstChild);
  }
}

// ---------------- 行/列选择槽（R47） ----------------
// 鼠标靠近表格左缘 → 行槽（箭头光标）：单击=选中整行，拖拽=选多行；
// 靠近表格上缘 → 列槽：单击=选中整列，拖拽=选多列。
// 槽条与工具条一样挂在 .vditor-reset 下（避免被 table 的 overflow:auto 裁剪）。
let gutRow = null, gutCol = null, gutTable = null;
function removeGutters() {
  if (gutRow) { gutRow.remove(); gutRow = null; }
  if (gutCol) { gutCol.remove(); gutCol = null; }
  gutTable = null;
}
function buildGutters(idx) {
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset) return;
  removeGutters();
  gutTable = idx;
  gutRow = document.createElement('div');
  gutRow.className = 'ms-grow';
  gutCol = document.createElement('div');
  gutCol.className = 'ms-gcol';
  bindGutter(gutRow, true);
  bindGutter(gutCol, false);
  reset.appendChild(gutRow);
  reset.appendChild(gutCol);
  positionGutters();
  if (gutRow) gutRow.classList.add('show');
  if (gutCol) gutCol.classList.add('show');
}
function positionGutters() {
  if (state.sourceMode) { removeGutters(); return; }
  if (gutTable === null || !gutRow || !gutCol) return;
  const reset = el('.vditor-ir .vditor-reset');
  const t = reset ? getIrTables()[gutTable] : null;
  if (!t || !document.contains(t)) { removeGutters(); return; }
  const rr = reset.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  // R85-P1：内容坐标系（同 positionTableTools）——绝对定位槽随内容滚动，需加 scrollTop/scrollLeft
  const tableTopContent = (tr.top - rr.top) + reset.scrollTop;
  const tableLeftContent = (tr.left - rr.left) + reset.scrollLeft;
  // 行槽：表格左侧 8px、纵向跨整表；内容坐标下 min 0 避免负值
  gutRow.style.top = Math.max(0, tableTopContent) + 'px';
  gutRow.style.left = Math.max(0, tableLeftContent - 8) + 'px';
  gutRow.style.height = Math.max(0, tr.height) + 'px';
  // R84-P2：列槽贴表格「上边缘」(横向 8px 高槽)；内容坐标定位，随表格滚动贴住表格顶边
  gutCol.style.top = Math.max(0, tableTopContent) + 'px';
  gutCol.style.left = Math.max(0, tableLeftContent) + 'px';
  gutCol.style.width = Math.max(0, tr.width) + 'px';
}
function gutterRowAt(t, clientY) {
  const rows = Array.from(t.querySelectorAll('tr'));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (clientY >= r.top && clientY < r.bottom) return i;
  }
  const rr = t.getBoundingClientRect();
  return clientY < rr.top ? 0 : rows.length - 1;
}
function gutterColAt(t, clientX) {
  const head = t.querySelector('tr');
  if (!head) return 0;
  const kids = Array.from(head.children);
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    if (clientX >= r.left && clientX < r.right) return i;
  }
  const rr = t.getBoundingClientRect();
  return clientX < rr.left ? 0 : kids.length - 1;
}
function bindGutter(strip, isRow) {
  strip.addEventListener('mouseout', (e) => {
    const rt = e.relatedTarget;
    const inside = rt && rt.closest && (rt.closest('table') || (rt.classList && (rt.classList.contains('ms-grow') || rt.classList.contains('ms-gcol'))));
    if (!inside) hideTableToolsIfNoSel();
  });
  strip.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || gutTable === null) return;
    e.preventDefault(); e.stopPropagation();
    const idx = gutTable;
    const t = getIrTables()[idx];
    if (!t) return;
    const rows = Array.from(t.querySelectorAll('tr'));
    const nr = rows.length;
    const nc = rows[0] ? rows[0].children.length : 0;
    if (!nr || !nc) return;
    const a = isRow ? { r: gutterRowAt(t, e.clientY), c: 0 } : { r: 0, c: gutterColAt(t, e.clientX) };
    // R66b：Ctrl+左键点行槽/列槽 = 整行/整列加入或移出选区（toggle），不进入拖拽扩选
    if (e.ctrlKey) {
      const cells = isRow
        ? Array.from({ length: nc }, (_, c) => ({ r: a.r, c }))
        : Array.from({ length: nr }, (_, r) => ({ r, c: a.c }));
      toggleTableSelCells(idx, cells);
      return;
    }
    TBL.selAnchor = { table: idx, r: a.r, c: a.c };
    setTableSelection(idx, isRow ? { r: a.r, c: nc - 1 } : { r: nr - 1, c: a.c });
    const onMove = (ev) => {
      const p = isRow ? { r: gutterRowAt(t, ev.clientY), c: nc - 1 } : { r: nr - 1, c: gutterColAt(t, ev.clientX) };
      setTableSelection(idx, p);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------------- 事件绑定（委托） ----------------
// recreateEditor 会 destroy 掉 Vditor 并重建 .vditor-reset（旧元素连同其上的监听一起被丢弃）。
// 凡把处理器绑在「那个 reset 实例」上的监听，一旦触发重建（改主题/字体/行高/打字机等走
// applySettings→recreateEditor）就全部失效 → 表格的行/列选择槽、悬浮工具条随之消失（R80-1
// 用户报障「选中一行/一列、悬浮菜单栏都消失不见了」）。故拆成两段：
//   ① bindTableGlobal：绑 document/window（持久元素，重建不受影响），只绑一次；
//   ② bindTableReset：绑当前 .vditor-reset；reset 实例换了就重绑（recreateEditor 收尾重跑）。
let tblGlobalBound = false; // ① 全局监听只绑一次（防 recreate 后重复 addEventListener）
let tblBoundReset = null;   // ② 已绑定的 reset 实例；与当前 reset 不一致则重绑
let lastPinnedTable = null; // pinTableAtCaret 记忆（提升模块级，跨重绑存活；重建后新表格自动重新钉死）

function bindTableGlobal() {
  if (tblGlobalBound) return;
  tblGlobalBound = true;
  // 窗口 resize：表格几何变化 → 重放已保存的列宽/行高（内部会顺带重定位工具条）
  window.addEventListener('resize', () => { reapplyTableLayout(); });
  // 点击表格以外 → 清除选中。#ctxmenu 必须豁免（R63）：本处理器在 capture 阶段，
  // 点右键菜单项的 mousedown 会先于 click 到达——若把菜单当「表格外」清掉选区，
  // 对齐/清空等作用于选区的菜单项 click 时读到的 TBL.sel 必为 null，误报「请先选中单元格」
  document.addEventListener('mousedown', (e) => {
    if (!TBL.sel) return;
    const t = e.target && e.target.closest ? e.target.closest('.vditor-ir table, .ms-ttools, .ms-grow, .ms-gcol, #ctxmenu') : null;
    if (!t) clearTableSelection();
  }, true);
  // 光标进入表格单元格：立即钉死当前列宽，之后击键重建 DOM 也不会重排列宽。
  // 注意：Vditor IR 的编辑器是 contenteditable 的 <pre>，点击单元格时 focusin 的
  // target 恒为 pre 根（且编辑器已聚焦时根本不触发 focusin）——必须用选区变化
  // （selectionchange）判断「光标进入了哪个单元格」（键盘 Tab 进入同样覆盖）
  const pinTableAtCaret = () => {
    if (state.sourceMode) return;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) { lastPinnedTable = null; return; }
    const n = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
    const cell = n && n.closest ? n.closest('td,th') : null;
    if (!cell) { lastPinnedTable = null; return; }
    const t = cell.closest('table');
    if (!t || t === lastPinnedTable) return;
    const idx = getIrTables().indexOf(t);
    if (idx < 0) return;
    lastPinnedTable = t;
    pinTableCols(t, idx);
  };
  document.addEventListener('selectionchange', pinTableAtCaret);
  // R65a：多选单元格拖拽进行中，原生文字选区必须不存在（跨格后由单元格级选区接管）。
  // 部分浏览器的拖动选区会话在 JS 清除后仍会于后续 mousemove 重新扩展原生选区，
  // 蓝色文本带再次出现 = 「文字跳动」的根因之一。此处同步清掉任何非折叠选区；
  // 同格内的合法文字选中发生在 drag.active 之前（尚未跨格），不受影响
  document.addEventListener('selectionchange', () => {
    const drag = TBL.dragging;
    if (!drag || !drag.active) return;
    const s = window.getSelection();
    if (s && s.rangeCount > 0 && !s.getRangeAt(0).collapsed) s.removeAllRanges();
  }, true);
}

// 表格交互（R45）：单元格点选、行列宽拖拽、左上角悬浮工具条（绑当前 reset，重建后重绑）
// R81-1：单元格内按 Enter / 输入导致行高实时变化时，选区描边 .ms-tsel（蓝色矩形框 +
// 淡蓝区域）此前只在「拖边框」后重算，内容增高会停在旧尺寸（实测：单元格 49→113px，
// 蓝框仍 49px）。reset 级 MutationObserver + rAF 合并：选中态下任一子树变化 → 下一帧
// 重打高亮类（节点可能被重渲染）+ 重算 .ms-tsel，实时贴合当前行高/列宽。
let selWatchMo = null, selWatchRaf = null, selWatchTable = null;
function refreshSelectionVisual() {
  if (state.sourceMode || !TBL.sel) return;
  const t = getIrTables()[TBL.sel.table];
  if (!t || !document.contains(t)) return;
  if (t !== selWatchTable) { // 节点已重渲染 → 高亮类可能丢失，重打
    selWatchTable = t;
    const s = TBL.sel;
    Array.from(t.querySelectorAll('tr')).forEach((tr, r) => Array.from(tr.children).forEach((cell, c) => {
      if (cell) cell.classList.toggle('ms-cell-sel', selCellOn(s, r, c));
    }));
  }
  updateSelBox(t);
}
function startSelWatch(reset) {
  stopSelWatch();
  selWatchTable = null;
  if (!reset) return;
  selWatchMo = new MutationObserver(() => {
    if (!TBL.sel) return;
    if (selWatchRaf) return;
    selWatchRaf = requestAnimationFrame(() => { selWatchRaf = null; refreshSelectionVisual(); });
  });
  selWatchMo.observe(reset, { childList: true, subtree: true, characterData: true });
}
function stopSelWatch() {
  if (selWatchMo) { selWatchMo.disconnect(); selWatchMo = null; }
  if (selWatchRaf) { cancelAnimationFrame(selWatchRaf); selWatchRaf = null; }
}

function bindTableReset() {
  const reset = el('.vditor-ir .vditor-reset');
  if (!reset || reset === tblBoundReset) return;
  tblBoundReset = reset;
  let hoverTimer = 0, hoverTable = null;
  const showFor = (t) => {
    sweepTableOrphans(); // R60：悬停建工具前先清孤儿（用户看到的第一个触点）
    const idx = getIrTables().indexOf(t);
    if (idx < 0) return;
    buildResizeHandles(t, idx);
    buildGutters(idx);
    const tt = getTableTools();
    if (tt.parentElement !== reset) reset.appendChild(tt);
    refreshToolsState();
    tt.classList.add('show');
    positionTableTools();
  };
  reset.addEventListener('mouseover', (e) => {
    if (state.sourceMode) return;
    if (TBL.dragging) return; // R65b：单元格拖拽进行中不做悬停处理（手柄已 pointer-events:none，此处兜底省掉重定位）
    const t = e.target.closest && e.target.closest('table');
    if (!t) return;
    const cell = e.target.closest && e.target.closest('td,th');
    if (cell) {
      const pos = cellPos(t, cell);
      if (pos) TBL.caret = { table: getIrTables().indexOf(t), ...pos };
    }
    if (t === hoverTable) {
      // 仍悬停同一张表：手柄被重渲染清掉则补建；否则轻量重定位——
      // 上一次拖拽/缩放后手柄位置可能已不贴实际边框（高亮错位投诉）
      if (!t.querySelector('.ms-cre')) showFor(t);
      else syncHandlePositions(t);
      return;
    }
    hoverTable = t;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (document.contains(t)) showFor(t); }, 120);
  });
  reset.addEventListener('mouseout', (e) => {
    const t = e.target.closest && e.target.closest('table');
    if (!t) return;
    const rt = e.relatedTarget;
    // 移向行/列选择槽或工具条（含其内部按钮）都不算离开表格——它们都在表格盒外，是 hover 区域的一部分。
    // R83-P1：列槽移到工具条之上后，从表格上移到工具条会先经过工具条，必须一并豁免，否则工具条被隐藏
    const toKeep = rt && ((rt.classList && (rt.classList.contains('ms-grow') || rt.classList.contains('ms-gcol') || rt.classList.contains('ms-ttools'))) || (rt.closest && rt.closest('.ms-ttools')));
    if (!(rt && (t.contains(rt) || toKeep))) {
      clearTimeout(hoverTimer);
      hoverTable = null;
      hideTableToolsIfNoSel();
    }
  });
  reset.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); hoverTable = null; hideTableToolsIfNoSel(); });

  // 工具条跟随：锚点在滚动容器视口上，内容滚动后需重算 top/left
  reset.addEventListener('scroll', () => { if (ttEl && ttEl.classList.contains('show')) positionTableTools(); });

  // 单元格点选（R61 路径多选）：单击选中一格；按住左键拖动时，鼠标经过的每个单元格
  // 都加入选区（沿路径累积、只加不减——(1,1)→(1,2)→(2,2) 选中 3 格而非 4 格矩形）。
  // 鼠标停留在同一格内时不做单元格级处理，交给浏览器原生文字选中；一旦跨格立即
  // 取消原生选区并禁选（.ms-drag-sel），改由单元格级选区接管
  reset.addEventListener('mousedown', (e) => {
    if (state.sourceMode || e.button !== 0) return;
    if (e.target.closest && (e.target.closest('.ms-ttools') || e.target.closest('.ms-cre') || e.target.closest('.ms-rre') || e.target.closest('.ms-grow') || e.target.closest('.ms-gcol'))) return;
    const cell = e.target.closest && e.target.closest('td,th');
    if (!cell) { if (TBL.sel) clearTableSelection(); return; }
    const table = cell.closest('table');
    const pos = cellPos(table, cell);
    if (!pos) return;
    const idx = getIrTables().indexOf(table);
    // R66b：Ctrl+左键 = 把光标下单元格加入/移出选区（toggle），不进入拖选逻辑、
    // 不动光标（preventDefault 阻断原生文字选中起点）
    if (e.ctrlKey) {
      e.preventDefault();
      toggleTableSelCells(idx, [pos]);
      return;
    }
    TBL.selAnchor = { table: idx, r: pos.r, c: pos.c };
    setTableSelection(idx, pos);
    const drag = { table: table, active: false, cells: new Map(), lastR: pos.r, lastC: pos.c };
    TBL.dragging = drag;
    // R65b：单元格拖拽期间手柄无反应（pointer-events:none，见 css .ms-celdrag）。
    // 此刻 mousedown 的命中目标必是单元格（手柄目标在上方已 return 走边框拖拽），
    // 不会误伤「落在边框线上拉列宽/行高」的正常操作
    table.classList.add('ms-celdrag');
    const onMove = (ev) => {
      if (!TBL.dragging || TBL.dragging !== drag) return;
      const n = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!n || !n.closest) return;
      const c2 = n.closest('td,th');
      if (!c2 || c2.closest('table') !== table) return;
      const p2 = cellPos(table, c2);
      if (!p2 || (p2.r === drag.lastR && p2.c === drag.lastC)) return; // 同格：原生文字选中
      drag.lastR = p2.r; drag.lastC = p2.c;
      if (!drag.active) {
        drag.active = true;
        window.getSelection().removeAllRanges(); // 取消第一格里刚形成的文字选区
        table.classList.add('ms-drag-sel');
        drag.cells.set(pos.r * 100 + pos.c, { r: pos.r, c: pos.c });
      }
      drag.cells.set(p2.r * 100 + p2.c, { r: p2.r, c: p2.c }); // 累积，不删
      const cells = Array.from(drag.cells.values());
      const bb = selBBox(cells);
      TBL.sel = { table: idx, r1: bb.r1, c1: bb.c1, r2: bb.r2, c2: bb.c2, cells };
      renderTableSelection();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (TBL.dragging === drag) TBL.dragging = null;
      table.classList.remove('ms-celdrag'); // R65b：拖拽结束，手柄恢复响应
      if (drag.active && TBL.sel && TBL.sel.table === idx) {
        table.classList.remove('ms-drag-sel');
        renderTableSelection(); // 松手定稿（onMove 已按精确集合实时渲染）
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 选区激活时：Backspace/Delete 清空选中单元格，Esc 取消
  reset.addEventListener('keydown', (e) => {
    if (!TBL.sel) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearTableSelection(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); clearSelectedCells(); }
  }, true);

  // 编辑/重渲染 → 选区失效清除 + 防抖重放列宽行高。
  // IR 模式每次击键都会重建表格 DOM，重放要紧跟其后（80ms），否则钉死的列宽
  // 会在重建后的自然布局里闪一下
  let layTimer = 0;
  reset.addEventListener('input', () => {
    if (TBL.sel) clearTableSelection();
    clearTimeout(layTimer);
    layTimer = setTimeout(reapplyTableLayout, 80);
  });

  // R81-1：reset 实例换了就重挂选中态跟随观察器（重建/切文件后仍实时贴合）
  startSelWatch(reset);
}

// 兼容原调用：init 时一次绑定（全局 + 当前 reset）；recreateEditor 收尾重跑 → 新 reset 重绑，
// 全局段因 tblGlobalBound 守卫自动跳过（不重复绑 document/window 监听）
function bindTableInteractions() {
  bindTableGlobal();
  bindTableReset();
}

// ---------------------------------------------------------------- 系统字体面板 / 自定义弹窗
let sysFontsCache = null;
// 启动时预取系统字体，供「所有系统字体」子菜单即时使用
function preloadSysFonts() {
  if (sysFontsCache) return;
  try { ms.invoke('app:list-fonts').then((fonts) => { if (fonts && fonts.length) sysFontsCache = fonts; }).catch(() => {}); } catch (e) { }
}
// 「所有系统字体」下一级子菜单项（显示本地化名，应用 family 名）
function sysFontSubItems() {
  const fonts = (sysFontsCache && sysFontsCache.length) ? sysFontsCache
    : ['宋体', '黑体', '楷体', '仿宋', '微软雅黑', '等线', 'Arial', 'Consolas', 'Times New Roman', 'Georgia', 'Cambria', 'Verdana'];
  const famOf = (f) => (typeof f === 'string' ? f : f.family);
  const labOf = (f) => (typeof f === 'string' ? f : (f.local || f.family));
  return fonts.map((f) => ({ label: labOf(f), act: () => applyTextStyle({ fontFamily: famOf(f) }) }));
}
function closeFontPanel() { const p = el('#fontpanel'); if (p) p.classList.add('hidden'); }
async function openFontPanel() {
  const p = el('#fontpanel');
  p.classList.remove('hidden');
  p.style.left = Math.max(8, window.innerWidth - p.offsetWidth - 24) + 'px';
  p.style.top = '62px';
  el('#fp-search').value = '';
  if (!sysFontsCache) {
    el('#fp-list').innerHTML = '<div class="fp-empty">' + t('fp.loading') + '</div>';
    let fonts = [];
    try { fonts = (await ms.invoke('app:list-fonts')) || []; } catch (e) { }
    if (!fonts.length) fonts = ['宋体', '黑体', '楷体', '仿宋', '微软雅黑', '等线', 'Arial', 'Consolas', 'Times New Roman', 'Georgia', 'Cambria', 'Verdana'];
    sysFontsCache = fonts;
  }
  renderFontList('');
  // 注意：不能在这里自动聚焦 #fp-search——聚焦搜索框（可编辑元素）会清掉正文选区，
  // 导致随后点选字体时 applyTextStyle 找不到选区（「请先选中要设置样式的文本」）。
  // 需要筛选时用户可手动点击搜索框。
}
function renderFontList(q) {
  const list = el('#fp-list');
  list.innerHTML = '';
  const famOf = (f) => (typeof f === 'string' ? f : f.family);
  const labOf = (f) => (typeof f === 'string' ? f : (f.local || f.family));
  const ql = (q || '').toLowerCase();
  const fonts = (sysFontsCache || []).filter(f => !ql || labOf(f).toLowerCase().indexOf(ql) !== -1 || famOf(f).toLowerCase().indexOf(ql) !== -1);
  if (!fonts.length) { list.innerHTML = '<div class="fp-empty">' + t('fp.none') + '</div>'; return; }
  const frag = document.createDocumentFragment();
  fonts.forEach(f => {
    const family = famOf(f), label = labOf(f);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'fp-item';
    const sample = document.createElement('span');
    sample.className = 'fp-sample';
    sample.style.fontFamily = '"' + family.replace(/"/g, '') + '", "Microsoft YaHei", sans-serif';
    sample.textContent = 'Aa 甲';
    const name = document.createElement('span');
    name.className = 'fp-name';
    name.textContent = label;
    row.appendChild(sample);
    row.appendChild(name);
    row.addEventListener('mousedown', (e) => e.preventDefault()); // 保留正文选区
    row.addEventListener('click', () => { closeFontPanel(); applyTextStyle({ fontFamily: family }); });
    frag.appendChild(row);
  });
  list.appendChild(frag);
}

function showMiniPop(build) {
  const old = document.getElementById('mini-pop');
  if (old) old.remove();
  const pop = document.createElement('div');
  pop.id = 'mini-pop';
  pop.className = 'mini-pop';
  document.body.appendChild(pop);
  build(pop);
  pop.style.left = Math.max(8, window.innerWidth - pop.offsetWidth - 24) + 'px';
  pop.style.top = '58px';
  return pop;
}
function openCustomSizePop() {
  const pop = showMiniPop((p) => {
    p.innerHTML = '<div class="mp-title">' + t('fp.customSizeTitle') + '</div>' +
      '<div class="mp-row"><input type="number" min="8" max="120" step="1" value="18"> <span class="mp-unit">px</span> ' +
      '<button class="mp-ok primary">' + t('common.apply') + '</button> <button class="mp-cancel">' + t('common.cancel') + '</button></div>';
    const inp = p.querySelector('input');
    const apply = () => {
      const n = parseInt(inp.value, 10);
      if (!n || n < 8 || n > 120) return;
      pop.remove();
      applyTextStyle({ fontSize: n + 'px' });
    };
    p.querySelector('.mp-ok').addEventListener('mousedown', (e) => e.preventDefault());
    p.querySelector('.mp-ok').addEventListener('click', apply);
    p.querySelector('.mp-cancel').addEventListener('click', () => pop.remove());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') pop.remove(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
  });
}
// ---------------- 应用内取色面板（HSL 滑杆 + 十六进制 + 常用色，参考主流软件） ----------------
let cpHsl = { h: 355, s: 75, l: 57 };
let cpSavedRange = null; // 打开面板时的正文选区（面板内交互会丢焦点，应用前需恢复）
function cpRestoreSelection() {
  if (!cpSavedRange) return false;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(cpSavedRange);
    return true;
  } catch (e) { return false; }
}
function cpApplyColor() {
  cpRestoreSelection();
  applyTextStyle({ color: hslToHex(cpHsl.h, cpHsl.s, cpHsl.l) });
  closeCustomColorPop();
  cpSavedRange = null;
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to2 = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return ('#' + to2(f(0)) + to2(f(8)) + to2(f(4))).toUpperCase();
}
function hexToHsl(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}
function cpRender() {
  const { h, s, l } = cpHsl;
  const hex = hslToHex(h, s, l);
  el('#cp-swatch').style.background = hex;
  const hexInp = el('#cp-hex');
  if (document.activeElement !== hexInp) hexInp.value = hex;
  el('#cp-h').value = h; el('#cp-s').value = s; el('#cp-l').value = l;
  el('#cp-hv').textContent = h; el('#cp-sv').textContent = s + '%'; el('#cp-lv').textContent = l + '%';
  el('#cp-h').style.background = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';
  el('#cp-s').style.background = 'linear-gradient(to right, ' + hslToHex(h, 0, l) + ', ' + hslToHex(h, 100, l) + ')';
  el('#cp-l').style.background = 'linear-gradient(to right, #000, ' + hslToHex(h, s, 50) + ', #fff)';
}
function openCustomColorPop() {
  if (!hasTextSelection()) { toast(t('toast.selTextFirst')); return; }
  // 面板内的输入框/滑杆会抢走焦点导致正文选区丢失，先保存选区，应用时恢复
  const sel0 = window.getSelection();
  try { cpSavedRange = sel0.rangeCount ? sel0.getRangeAt(0).cloneRange() : null; } catch (e) { cpSavedRange = null; }
  cpHsl = { h: 355, s: 75, l: 57 };
  cpRender();
  const panel = el('#color-picker');
  panel.classList.add('open');
  // 位置：紧贴「格式」菜单按钮下方；菜单栏隐藏时改用悬浮栏「颜色」按钮为锚点
  const fmtBtn = el('#menubar .mb-item[data-menu="fmt"]');
  const anchor = (fmtBtn && fmtBtn.getBoundingClientRect().width > 0)
    ? fmtBtn
    : (el('#fbar [data-menu="color"]') || fmtBtn);
  if (anchor && anchor.getBoundingClientRect().width > 0) {
    const r = anchor.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = (r.bottom + 6) + 'px';
  } else {
    panel.style.left = Math.max(8, window.innerWidth - panel.offsetWidth - 24) + 'px';
    panel.style.top = '58px';
  }
  setTimeout(() => { const hx = el('#cp-hex'); hx.focus(); hx.select(); }, 20);
}
function closeCustomColorPop() {
  el('#color-picker').classList.remove('open');
  // 取消/关闭时恢复选区，不破坏用户的选中状态
  cpRestoreSelection();
  cpSavedRange = null;
}
function initColorPicker() {
  const panel = el('#color-picker');
  if (!panel || panel.dataset.init) return;
  panel.dataset.init = '1';
  ['h', 's', 'l'].forEach((k) => {
    el('#cp-' + k).addEventListener('input', (e) => { cpHsl[k] = +e.target.value; cpRender(); });
  });
  el('#cp-hex').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    const hsl = hexToHsl(v);
    if (hsl) { cpHsl = hsl; cpRender(); }
  });
  // 常用色板
  const common = el('#cp-common');
  TEXT_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      const hsl = hexToHsl(c);
      if (hsl) { cpHsl = hsl; cpRender(); }
    });
    common.appendChild(b);
  });
  el('#cp-ok').addEventListener('click', cpApplyColor);
  el('#cp-cancel').addEventListener('click', closeCustomColorPop);
  el('#cp-close').addEventListener('click', closeCustomColorPop);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { cpApplyColor(); }
    if (e.key === 'Escape') closeCustomColorPop();
  });
  // 点击面板外关闭
  document.addEventListener('mousedown', (e) => {
    if (panel.classList.contains('open') && !panel.contains(e.target) && !e.target.closest('#menubar .mb-item[data-menu="fmt"]')) {
      closeCustomColorPop();
    }
  }, true);
}

// ---------------------------------------------------------------- 图片
async function saveImageAndInsert(fileOrB64, suggestedName, isB64, cellCtx) {
  let dataB64 = fileOrB64;
  if (!isB64) {
    const buf = new Uint8Array(await fileOrB64.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    dataB64 = btoa(bin);
  }
  const r = await ms.invoke('img:save', { dataB64, baseDir: dirOf(state.docPath), suggestedName });
  if (!r || !r.rel) { toast(t('toast.imgSaveFailed')); return; }
  const mdPath = state.docPath ? r.rel : r.abs.replace(/\\/g, '/');
  const imgMd = `![${suggestedName || 'image'}](${mdPath})`;
  // R81-2：光标在表格单元格内 → 内联插入图片（不带结尾换行，避免退出单元格破坏表格）
  const cc = cellCtx || caretInCell();
  if (state.vditor && !state.sourceMode) {
    if (cc) {
      if (relocateCell(cc)) state.vditor.insertValue(imgMd); // 光标已移回单元格
      else state.vditor.insertValue(imgMd + '\n');            // 单元格已不存在，退回块级
    } else {
      state.vditor.insertValue(imgMd + '\n');
    }
  } else if (state.sourceMode) {
    const ta = el('#source');
    ta.setRangeText(imgMd + '\n', ta.selectionStart, ta.selectionEnd, 'end');
  }
  setDirty(true);
  toast(t('toast.imgSavedAssets'));
}

async function insertImageDialog() {
  const cellCtx = caretInCell(); // R81-2：对话框打开前捕获（文件对话框会抢焦点/丢光标）
  const r = await ms.invoke('dialog:open-file', { image: true });
  if (!r || !r.path) return;
  const b64 = await ms.invoke('fs:read-base64', { path: r.path });
  if (b64.error) { toast(t('toast.imgReadFailed')); return; }
  await saveImageAndInsert(b64.dataB64, baseName(r.path), true, cellCtx);
}

// ================= 图片选择 + 工具条 + 缩放/裁剪（R75-4a，参考 Word 图片操作） =================
let selImage = null;
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 在 md 中定位第 occ 个「URL 部分=mssrc」的图片引用，用 build(整匹配数组) 生成替换串。
// m[1]=`![alt](`，m[2]=`)`；整匹配含可选的 {=WxH} 尺寸标注（R75-4a 用花括号语法）。
function rewriteImageRef(md, mssrc, occ, build) {
  const re = new RegExp('(!\\[[^\\]]*\\]\\()\\s*' + escapeRegExp(mssrc) + '\\s*(\\))(?:\\s*\\{\\s*=\\s*\\d+x\\d+\\s*\\})?', 'g');
  let m, idx = -1;
  while ((m = re.exec(md))) {
    idx++;
    if (idx === occ) return { md: md.slice(0, m.index) + build(m) + md.slice(m.index + m[0].length), ok: true };
  }
  return { md, ok: false };
}

// 当前选中图片的 markdown 路径 + 它是同路径中的第几个（DOM 顺序与 md 顺序一致）
function selectedImageOccurrence() {
  if (!selImage) return { mssrc: null, occ: -1 };
  const mssrc = selImage.dataset.mssrc;
  if (!mssrc) return { mssrc: null, occ: -1 };
  const same = els('.vditor-ir .vditor-reset img').filter(im => im.dataset.mssrc === mssrc);
  return { mssrc, occ: same.indexOf(selImage) };
}

function selectImage(img) {
  if (selImage && selImage !== img) { try { selImage.classList.remove('ms-img-sel'); } catch (e) { } }
  selImage = img || null;
  const bar = el('#imgbar');
  if (img) {
    img.classList.add('ms-img-sel');
    if (bar) bar.classList.remove('hidden');
    if (bar) positionImgBar(img);
    showImageHandles(img); // R80-2：选中后显示边框缩放手柄
  } else {
    if (bar) bar.classList.add('hidden');
    hideImageHandles();
  }
}

function positionImgBar(img) {
  const bar = el('#imgbar');
  if (!bar || !img) return;
  const r = img.getBoundingClientRect();
  const bw = bar.offsetWidth || 260, bh = bar.offsetHeight || 34;
  let x = r.left + r.width / 2 - bw / 2;
  x = Math.max(8, Math.min(window.innerWidth - bw - 8, x));
  let y = r.top - bh - 10;
  if (y < 50) y = Math.min(window.innerHeight - bh - 8, r.bottom + 10);
  bar.style.left = Math.round(x) + 'px';
  bar.style.top = Math.round(y) + 'px';
}

// ---- R80-2：选中图片的边框缩放手柄（上/下/左/右 4 边 + 4 角），拖动改变 {=WxH} 尺寸 ----
let imgFrame = null;
const IMG_HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function showImageHandles(img) {
  if (!img) { hideImageHandles(); return; }
  if (!imgFrame) {
    imgFrame = document.createElement('div');
    imgFrame.id = 'ms-img-frame';
    IMG_HANDLE_DIRS.forEach((dir) => {
      const h = document.createElement('div');
      h.className = 'ms-ih';
      h.dataset.dir = dir;
      h.addEventListener('mousedown', (e) => startImageResize(e, dir));
      imgFrame.appendChild(h);
    });
    document.body.appendChild(imgFrame);
  }
  imgFrame.style.display = 'block';
  positionImageHandles(img);
}
function positionImageHandles(img) {
  if (!imgFrame) return;
  if (!img || !document.contains(img)) { imgFrame.style.display = 'none'; return; }
  const r = img.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) { imgFrame.style.display = 'none'; return; }
  imgFrame.style.left = Math.round(r.left) + 'px';
  imgFrame.style.top = Math.round(r.top) + 'px';
  imgFrame.style.width = Math.round(r.width) + 'px';
  imgFrame.style.height = Math.round(r.height) + 'px';
}
function hideImageHandles() { if (imgFrame) imgFrame.style.display = 'none'; }
// 持久化：把当前显示像素尺寸写进该图片的 {=WxH} 标注（复用 R75-4a 尺寸回写路径）
function persistImageSize(w, h) {
  if (state.sourceMode) return;
  const { mssrc, occ } = selectedImageOccurrence();
  if (!mssrc || occ < 0) return;
  const nw = Math.max(1, Math.round(w)), nh = Math.max(1, Math.round(h));
  const md = state.vditor.getValue();
  const res = rewriteImageRef(md, mssrc, occ, (m) => m[1] + mssrc + m[2] + '{=' + nw + 'x' + nh + '}');
  if (!res.ok) return;
  state.vditor.setValue(res.md);
  setDirty(true);
  refreshLinesSoon();
  fixImagesSoon();
  setTimeout(() => {
    let im = null, idx = -1;
    els('.vditor-ir .vditor-reset img').forEach(x => { if (x.dataset.mssrc === mssrc) { idx++; if (idx === occ) im = x; } });
    selectImage(im);
    resyncImageSizes();
  }, 80);
}
// 拖动某边/角手柄 → 实时改 <img> 显示尺寸，松手写回 {=WxH}
function startImageResize(e, dir) {
  e.preventDefault(); e.stopPropagation();
  const img = selImage;
  if (!img || state.sourceMode) return;
  const startW = img.offsetWidth, startH = img.offsetHeight;
  const startX = e.clientX, startY = e.clientY;
  const MIN = 24;
  document.body.classList.add('ms-img-resizing');
  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    let w = startW, h = startH;
    if (dir.indexOf('e') !== -1) w = startW + dx;
    if (dir.indexOf('w') !== -1) w = startW - dx;
    if (dir.indexOf('s') !== -1) h = startH + dy;
    if (dir.indexOf('n') !== -1) h = startH - dy;
    w = Math.max(MIN, Math.round(w));
    h = Math.max(MIN, Math.round(h));
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    positionImageHandles(img);
    positionImgBar(img);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('ms-img-resizing');
    persistImageSize(img.offsetWidth, img.offsetHeight);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 读该图片当前的标注尺寸（{=WxH}）；无标注返回 null
function currentImageAnnotatedSize(md, mssrc, occ) {
  const re = new RegExp(escapeRegExp(mssrc) + '\\s*\\)\\s*\\{\\s*=\\s*(\\d+)x(\\d+)\\s*\\}', 'g');
  let m, idx = -1;
  while ((m = re.exec(md))) { if (++idx === occ) return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) }; }
  return null;
}

// factor>0 放大/缩小；factor===0 恢复原尺寸（移除标注）
function applyImageSize(factor) {
  if (state.sourceMode) { toast(t('toast.wysiwygImgFirst')); return; }
  const { mssrc, occ } = selectedImageOccurrence();
  if (!mssrc || occ < 0) return;
  const md = state.vditor.getValue();
  const nat = { w: selImage.naturalWidth || 0, h: selImage.naturalHeight || 0 };
  const cur = currentImageAnnotatedSize(md, mssrc, occ) || (nat.w ? nat : null);
  if (!cur || !cur.w) { toast(t('toast.imgSizeFailed')); return; }
  let sizeSuffix = '';
  if (factor !== 0) {
    const nw = Math.max(1, Math.round(cur.w * factor));
    const nh = Math.max(1, Math.round(cur.h * factor));
    sizeSuffix = '{=' + nw + 'x' + nh + '}';
  }
  const res = rewriteImageRef(md, mssrc, occ, (m) => m[1] + mssrc + m[2] + sizeSuffix);
  if (!res.ok) { toast(t('toast.imgNotFound')); return; }
  state.vditor.setValue(res.md);
  setDirty(true);
  refreshLinesSoon();
  fixImagesSoon();
  // setValue 重建 DOM，旧引用失效 → 重新选中同位置图片并定位工具条 + 重放尺寸
  setTimeout(() => {
    let im = null, idx = -1;
    els('.vditor-ir .vditor-reset img').forEach(x => { if (x.dataset.mssrc === mssrc) { idx++; if (idx === occ) im = x; } });
    selectImage(im);
    resyncImageSizes();
  }, 80);
}

function removeSelectedImage() {
  const { mssrc, occ } = selectedImageOccurrence();
  if (!mssrc || occ < 0) return;
  const md = state.vditor.getValue();
  const re = new RegExp('!\\[[^\\]]*\\]\\(\\s*' + escapeRegExp(mssrc) + '\\s*\\)(?:\\s*\\{\\s*=\\s*\\d+x\\d+\\s*\\})?', 'g');
  let m, idx = -1;
  while ((m = re.exec(md))) {
    if (++idx !== occ) continue;
    let start = m.index, end = m.index + m[0].length;
    if (md[start - 1] === '\n') start--;
    else if (md[end] === '\n') end++;
    selectImage(null);
    state.vditor.setValue(md.slice(0, start) + md.slice(end));
    setDirty(true);
    refreshLinesSoon();
    return;
  }
  toast(t('toast.imgNotFound'));
}

function handleImageAction(act) {
  if (act === 'zoom-in') applyImageSize(1.2);
  else if (act === 'zoom-out') applyImageSize(1 / 1.2);
  else if (act === 'reset-size') applyImageSize(0);
  else if (act === 'remove') removeSelectedImage();
  else if (act === 'crop') openCropModal();
}

function bindImageInteractions() {
  document.addEventListener('mousedown', (e) => {
    const img = e.target.closest && e.target.closest('#editor .vditor-reset img');
    if (img) { e.preventDefault(); selectImage(img); return; }
    if (selImage && !(e.target.closest && e.target.closest('#imgbar'))) selectImage(null);
  });
  const bar = el('#imgbar');
  if (bar) {
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    els('#imgbar [data-imgact]').forEach(b => b.addEventListener('click', () => handleImageAction(b.dataset.imgact)));
  }
  window.addEventListener('scroll', () => { if (selImage) { positionImgBar(selImage); positionImageHandles(selImage); } }, true);
  window.addEventListener('resize', () => { if (selImage) { positionImgBar(selImage); positionImageHandles(selImage); } });
}

// ---- 图片裁剪（canvas 选区 → 另存新图 → 替换文中引用）----
let cropState = null;
function openCropModal() {
  const { mssrc, occ } = selectedImageOccurrence();
  if (!mssrc || occ < 0) return;
  const absPath = resolveLocalPath(selImage.getAttribute('src') || '');
  if (!absPath) { toast(t('toast.imgCropReadFailed')); return; }
  ms.invoke('fs:read-base64', { path: absPath }).then((r) => {
    if (!r || r.error || !r.dataB64) { toast(t('toast.imgCropReadFailed')); return; }
    const img = new Image();
    img.onload = () => {
      const canvas = el('#crop-canvas');
      if (!canvas) return;
      const maxW = Math.min(window.innerWidth * 0.9 - 60, 900);
      const maxH = window.innerHeight * 0.62 - 40;
      let scale = 1;
      if (img.naturalWidth > maxW) scale = maxW / img.naturalWidth;
      if (img.naturalHeight * scale > maxH) scale = maxH / img.naturalHeight;
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      cropState = { img, canvas, ctx, scale, mssrc, occ, sel: null, dragging: false, sx: 0, sy: 0, base: ctx.getImageData(0, 0, canvas.width, canvas.height) };
      canvas.onmousedown = cropMouseDown;
      canvas.onmousemove = cropMouseMove;
      canvas.onmouseup = cropMouseUp;
      el('#modal-crop').classList.remove('hidden');
      drawCrop();
    };
    img.onerror = () => { toast(t('toast.imgLoadFailed')); };
    img.src = 'data:image/png;base64,' + r.dataB64;
  }).catch(() => { toast(t('toast.imgCropReadFailed')); });
}
function cropPos(e) {
  const c = cropState.canvas;
  const r = c.getBoundingClientRect();
  const x = (e.clientX - r.left) * (c.width / r.width);
  const y = (e.clientY - r.top) * (c.height / r.height);
  return { x: Math.max(0, Math.min(c.width, x)), y: Math.max(0, Math.min(c.height, y)) };
}
function cropMouseDown(e) {
  if (!cropState) return;
  const p = cropPos(e);
  cropState.dragging = true; cropState.sx = p.x; cropState.sy = p.y;
  cropState.sel = { x: p.x, y: p.y, w: 0, h: 0 };
  drawCrop();
}
function cropMouseMove(e) {
  if (!cropState || !cropState.dragging) return;
  const p = cropPos(e);
  cropState.sel = {
    x: Math.min(cropState.sx, p.x), y: Math.min(cropState.sy, p.y),
    w: Math.abs(p.x - cropState.sx), h: Math.abs(p.y - cropState.sy)
  };
  drawCrop();
}
function cropMouseUp() { if (cropState) cropState.dragging = false; }
function drawCrop() {
  const cs = cropState; if (!cs) return;
  const ctx = cs.ctx, c = cs.canvas, s = cs.sel;
  ctx.putImageData(cs.base, 0, 0);
  if (!s || (s.w < 1 && s.h < 1)) return;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, c.width, s.y);
  ctx.fillRect(0, s.y + s.h, c.width, c.height - s.y - s.h);
  ctx.fillRect(0, s.y, s.x, s.h);
  ctx.fillRect(s.x + s.w, s.y, c.width - s.x - s.w, s.h);
  ctx.strokeStyle = '#0a84ff'; ctx.lineWidth = 2;
  ctx.strokeRect(s.x, s.y, s.w, s.h);
  ctx.restore();
}
function closeCropModal() {
  if (cropState) { cropState.canvas.onmousedown = null; cropState.canvas.onmousemove = null; cropState.canvas.onmouseup = null; }
  cropState = null;
  const m = el('#modal-crop');
  if (m) m.classList.add('hidden');
}
async function confirmCrop() {
  const cs = cropState;
  if (!cs || !cs.sel || (cs.sel.w < 2 && cs.sel.h < 2)) { toast(t('toast.cropSelFirst')); return; }
  const ox = Math.round(cs.sel.x / cs.scale), oy = Math.round(cs.sel.y / cs.scale);
  const ow = Math.max(1, Math.round(cs.sel.w / cs.scale)), oh = Math.max(1, Math.round(cs.sel.h / cs.scale));
  const off = document.createElement('canvas');
  off.width = ow; off.height = oh;
  try { off.getContext('2d').drawImage(cs.img, ox, oy, ow, oh, 0, 0, ow, oh); } catch (e) { closeCropModal(); toast(t('toast.cropFailed')); return; }
  let b64 = '';
  try { b64 = off.toDataURL('image/png').split(',')[1]; } catch (e) { b64 = ''; }
  if (!b64) { closeCropModal(); toast(t('toast.cropExportFailed')); return; }
  const r = await ms.invoke('img:save', { dataB64: b64, baseDir: dirOf(state.docPath), suggestedName: 'crop.png' });
  if (!r || !r.rel) { closeCropModal(); toast(t('toast.cropSaveFailed')); return; }
  const rel = state.docPath ? r.rel : r.abs.replace(/\\/g, '/');
  const md = state.vditor.getValue();
  const res = rewriteImageRef(md, cs.mssrc, cs.occ, (m) => m[1] + rel + m[2]);
  closeCropModal();
  if (!res.ok) { toast(t('toast.imgNotFound')); return; }
  state.vditor.setValue(res.md);
  setDirty(true);
  refreshLinesSoon();
  fixImagesSoon();
  toast(t('toast.cropped'));
}
function bindCropModal() {
  el('#crop-ok').onclick = confirmCrop;
  el('#crop-cancel').onclick = closeCropModal;
  document.addEventListener('keydown', (e) => {
    const m = el('#modal-crop');
    if (e.key === 'Escape' && m && !m.classList.contains('hidden')) closeCropModal();
  }, true);
}

// ---------------------------------------------------------------- 导出
function inlineCss(cssText, cssDir) {
  return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, u) => {
    if (/^(data:|https?:|file:)/i.test(u)) return m;
    return `url(${fileUrlOf(cssDir + '/' + u)})`;
  });
}

// R85-PDF：把 file:// URL 转成磁盘路径。桌面 等非 ASCII 路径会被 pathToFileURL 编码成
// %E6%A1%8C%E9%9D%A2，旧实现只去掉 file:/// 与斜杠、未 decodeURIComponent → 读 asar 报
// "Invalid package"，导出 PDF/HTML 的主题/KaTeX/高亮样式全部丢失（用户「PDF 格式有问题」根因）。
function fileUrlToDiskPath(rel) {
  return diskPathFromUrl(rel);
}
async function loadCssFile(rel) {
  const p = fileUrlToDiskPath(rel);
  try {
    const r = await ms.invoke('fs:read-text', { path: p });
    if (r.text) return inlineCss(r.text, p.replace(/[/\\][^/\\]*$/, ''));
  } catch (e) { }
  return '';
}

// dist53 功能2：GFM 会把同行两个孤立 ~ 配对成删除线，且 lute 配对时把 ~ 消费掉
//（「0~10 与 31~81」的 del 内容是「10 与 31」，波浪号已不在 HTML 里，事后修不了）。
// 正确修法：导出前放弃 getHTML 的已解析结果，改从原始 Markdown 源重渲染——先用
// R94 阅读视图同款规则把孤立 ~ 转义为 \~（~~对~~ 原样保留；代码 span/公式/围栏不受
// 影响，见 readerMaskMath），再 Md2HTML 出 HTML，结果与阅读视图完全一致。
// mathMode：'katex' 把公式 token 回填 KaTeX 渲染结果（PDF/HTML/打印/图片）；
//           'tex'  回填 .language-math 占位（text=原始 TeX，docx-gen 转可编辑 OMML 公式）
function renderExportBody(mathMode) {
  const { text: masked, toks } = readerMaskMath(getCurrentContent());
  let html = readerLute().Md2HTML(masked);
  for (const id in toks) {
    const tk = toks[id];
    const rep = mathMode === 'tex'
      ? (tk.display
        ? '<div class="language-math">' + escHtml(tk.tex) + '</div>'
        : '<span class="language-math">' + escHtml(tk.tex) + '</span>')
      : readerKatex(tk.tex, tk.display);
    if (tk.display) {
      // 块级公式独占段落时 lute 输出 <p>token</p>：整段替换为块级元素（div / katex-display）
      html = html.split('<p>' + id + '</p>').join(rep);
    } else {
      // dist54 修复：行内公式也可能独占整段（<p>token</p>，如单独一行的 $...$）——
      // 只替换 token、保留 <p> 包裹。旧实现整段替换成裸 span，顶层裸 span 在
      // docx-gen 中不走公式分支，Word 里该公式会退化为 TeX 纯文本
      html = html.split('<p>' + id + '</p>').join('<p>' + rep + '</p>');
    }
    html = html.split(id).join(rep);
  }
  return html;
}

// 第二道防线：del/s 内容含 ~ 而无 ~~ 的（源级转义后理论上已不产生）仍解包
function fixFalseDelHtml(htmlStr) {
  return String(htmlStr).replace(/<(del|s)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (m, tag, inner) => {
    const text = inner.replace(/<[^>]*>/g, '');
    if (text.indexOf('~') > -1 && text.indexOf('~~') === -1) return inner;
    return m;
  });
}

// dist54 修复（Word/PDF 内部链接失效）：lute 的 Md2HTML 有两处缺陷——
// ① 标题不带 id（浏览器 # 片段跳转无目标，PDF/HTML 导出后内部链接点不动）；
// ② href="#..." 中的非 ASCII 被百分号编码（#1-第一章概述… → #1-%E7%AC%AC…），
//    docx-gen 的 anchorMap 按未编码 slug 建表 → Word 内部链接全部落空。
// 这里统一处理：给 h1-h6 补 GitHub 风格 slug 作 id（算法与 docx-gen.githubSlug 完全一致，
// 重复 slug 追加 -1/-2 保证唯一），并把 href 片段解码回未编码形式。
function exportFixAnchors(htmlStr) {
  const slugOf = (s) => (s || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const decodeFrag = (v) => {
    if (/%[0-9A-Fa-f]{2}/.test(v)) { try { return decodeURIComponent(v); } catch (e) { return v; } }
    return v;
  };
  const used = {};
  htmlStr = String(htmlStr).replace(/<(h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi, (m, tag, attrs, inner) => {
    let text = inner.replace(/<[^>]*>/g, '');
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (attrs && /\sid\s*=/i.test(attrs)) {
      // 标题已带 id（如 {#custom} 原始 HTML）：不解码则与解码后的 href 不一致
      return m.replace(/id\s*=\s*"([^"]*)"/i, (mm, v) => 'id="' + decodeFrag(v) + '"');
    }
    let id = slugOf(text);
    if (!id) return m;
    if (used[id] != null) { used[id]++; id = id + '-' + used[id]; } else used[id] = 0;
    return '<' + tag + ' id="' + id + '"' + (attrs || '') + '>' + inner + '</' + tag + '>';
  });
  htmlStr = htmlStr.replace(/href="#([^"]*)"/g, (m, frag) => 'href="#' + decodeFrag(frag) + '"');
  return htmlStr;
}

async function buildExportHtml() {
  const contentTheme = resolveContentTheme();
  const hlStyle = resolveHlStyle();
  // dist53 功能2：从原始源重渲染（修 0~10 类假删除线），不再依赖 getHTML 的已解析结果
  let bodyHtml = '';
  try { bodyHtml = renderExportBody('katex'); }
  catch (e) { try { bodyHtml = state.vditor.getHTML(); } catch (e2) { bodyHtml = '<pre>' + escHtml(getCurrentContent()) + '</pre>'; } }
  const cssParts = [];
  cssParts.push(await loadCssFile(state.cdnUrl + '/dist/css/content-theme/' + contentTheme + '.css'));
  cssParts.push(await loadCssFile(state.cdnUrl + '/dist/js/katex/katex.min.css'));
  cssParts.push(await loadCssFile(state.cdnUrl + '/dist/js/highlight.js/styles/' + hlStyle + '.min.css'));
  // 图片转 base64，保证导出文件自包含
  const tmp = document.createElement('div');
  tmp.innerHTML = exportFixAnchors(fixFalseDelHtml(bodyHtml));
  // R85-PDF：用编辑器已加载的 highlight.js + KaTeX 渲染代码高亮与数学公式——
  // getHTML() 只给原始文本（<pre><code class="language-x">纯文本、<span class="language-math">原始 LaTeX），
  // 不渲染则导出 PDF/HTML/DOC 里代码无高亮、公式显示为 LaTeX 源码（用户「PDF 格式有问题」之一）。
  try {
    if (window.hljs) tmp.querySelectorAll('pre code').forEach((c) => { try { window.hljs.highlightElement(c); } catch (e) { } });
  } catch (e) { }
  try {
    if (window.katex) tmp.querySelectorAll('.language-math').forEach((n) => {
      const tex = n.getAttribute('data-math') || n.textContent || '';
      try { n.innerHTML = window.katex.renderToString(tex, { displayMode: (n.tagName === 'DIV'), throwOnError: false }); } catch (e) { }
    });
  } catch (e) { }
  for (const img of tmp.querySelectorAll('img')) {
    const abs = resolveLocalPath(img.getAttribute('src') || '');
    if (!abs) continue;
    const r = await ms.invoke('fs:read-base64', { path: abs });
    if (!r.error) img.setAttribute('src', `data:${r.mime};base64,${r.dataB64}`);
  }
  const title = baseName(state.docPath).replace(/\.(md|markdown|txt)$/i, '');
  return `<!DOCTYPE html>
<html lang="${i18nLang()}">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  body { max-width: 860px; margin: 0 auto; padding: 48px 32px; font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; font-size: 15px; color: #24292f; background: #fff; }
  img { max-width: 100%; }
  table { border-collapse: collapse; } th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
  /* dist55 修复4：代码块/行内代码长行强制折行——ASCII 图等无空格长串（如 4080 列
     的「—」分隔线）不再把页面撑到 2000px+（图片导出截图因此又宽又矮、PDF 中整行被裁掉）。
     pre 本身也要 overflow-wrap:anywhere：pre-wrap 只在空格处折，纯符号长串无空格必须靠它 */
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  code, pre code { overflow-wrap: anywhere; }
</style>
<style>${cssParts.join('\n')}</style>
</head>
<body>
${tmp.innerHTML}
</body>
</html>`;
}

async function exportPdf() {
  if (!state.vditor) return;
  const html = await buildExportHtml();
  const r = await ms.invoke('export:pdf', { html, suggestedName: baseName(state.docPath).replace(/\.(md|markdown|txt)$/i, '') + '.pdf' });
  if (r.canceled) return;
  if (r.error) { toast(t('toast.exportFailed', { e: r.error })); return; }
  toast(t('toast.exportedPdf', { p: r.path }), 3500);
}

async function exportHtml() {
  if (!state.vditor) return;
  const html = await buildExportHtml();
  const r = await ms.invoke('export:html', { html, suggestedName: baseName(state.docPath).replace(/\.(md|markdown|txt)$/i, '') + '.html' });
  if (r.canceled) return;
  if (r.error) { toast(t('toast.exportFailed', { e: r.error })); return; }
  toast(t('toast.exportedHtml', { p: r.path }), 3500);
}

// dist53 功能1：导出为图片（PNG/JPEG/WebP）——复用 buildExportHtml（含假删除线修复、
// 高亮/公式渲染、图片 base64 内联），主进程用隐藏窗口 capturePage 截图后按所选格式编码
// dist59：分辨率(1×~4×) + DPI(96/150/300/600) + 保存位置(可编辑)；超长文档自动分片(_000/_001…)、不压缩
async function exportImage() {
  try {
    if (!state.vditor) { toast(t('toast.docNotOpen')); return; }
    const sel = await showImageRes(); // 取消 → null
    if (!sel) return;
    toast(t('toast.exportImageStart'), 1800);
    const html = imgresState.html || await buildExportHtml(); // 复用弹窗测量时已构建的 HTML
    const base = baseName(state.docPath).replace(/\.(md|markdown|txt)$/i, '') || 'export';
    const r = await ms.invoke('export:image', {
      html, scale: sel.scale, dpi: sel.dpi,
      filePath: sel.path || undefined,
      suggestedName: base + '.' + imgresExtFromPath(sel.path || '')
    });
    if (!r || r.canceled) return;
    if (r.error) { toast(t('toast.exportFailed', { e: r.error })); return; }
    if (r.tiles && r.tiles > 1) {
      toast(t('toast.exportTiled', { n: r.tiles, p: r.path }), 4500); // dist59：分片导出成功
    } else if (r.scale != null && Math.abs(r.scale - sel.scale) > 0.01) {
      toast(t('toast.exportImageCapped', { p: r.path, s: r.scale, want: sel.scale }), 4500); // 超宽文档宽度降档（少见）
    } else {
      toast(t('toast.exportedImage', { p: r.path, s: (r.scale != null ? r.scale : sel.scale) }), 3500);
    }
  } catch (e) {
    toast(t('toast.exportFailed', { e: (e && e.message) || String(e) }));
  }
}

// R87：导出 Word（.docx / .doc）——真实 OOXML 容器（非 HTML 伪装）：
// 取原始 getHTML()（保留原始 LaTeX 与相对图片 src，不渲染 KaTeX/hljs、不内联 base64），
// 交由 docx-gen.js 生成 OOXML 部件（可编辑公式/真实标题样式/删除线/任务列表/分割线/
// 表格对齐/当前字体字号），主进程用极简 ZIP 组装成合法 .docx（Word/WPS 依容器嗅探亦能打开 .doc）。
async function exportDoc() {
  if (!state.vditor) return;
  // dist53 功能2：同样从原始源重渲染；公式回填 .language-math 占位，docx-gen 转 OMML 可编辑公式
  let bodyHtml = '';
  try { bodyHtml = renderExportBody('tex'); }
  catch (e) { try { bodyHtml = state.vditor.getHTML(); } catch (e2) { bodyHtml = '<pre>' + escHtml(getCurrentContent()) + '</pre>'; } }
  bodyHtml = fixFalseDelHtml(bodyHtml); // 第二道防线（源级转义后理论上已不产生假删除线）
  bodyHtml = exportFixAnchors(bodyHtml); // dist54：解码 href 片段（Word 内部链接 anchorMap 依赖未编码 slug）
  const settings = {
    contentFont: (state.settings && state.settings.contentFont) || '',
    fontSize: (state.settings && state.settings.fontSize) || 16
  };
  let parts;
  try {
    parts = await window.MsDocx.buildParts(bodyHtml, dirOf(state.docPath) || '', settings);
  } catch (e) {
    toast(t('toast.exportFailed', { e: (e && e.message || e) }));
    return;
  }
  const r = await ms.invoke('export:doc', {
    parts: parts,
    suggestedName: baseName(state.docPath).replace(/\.(md|markdown|txt)$/i, '') + '.docx'
  });
  if (r.canceled) return;
  if (r.error) { toast(t('toast.exportFailed', { e: r.error })); return; }
  toast(t('toast.exportedDoc', { p: r.path }), 3500);
}

async function printDoc() {
  if (!state.vditor) return;
  const html = await buildExportHtml();
  await ms.invoke('print:doc', { html });
}

// ---------------------------------------------------------------- 设置
// R68：设置分 tab（通用/外观/编辑/快捷键），记住最后停留的页；
// 快捷键录入中切走快捷键页 = 取消录入（Esc 语义）
let setTabMem = 'pane-general';
function setTab(paneId) {
  const tabs = el('#set-tabs');
  if (!tabs) return;
  tabs.querySelectorAll('.set-tab').forEach(b => b.classList.toggle('active', b.dataset.pane === paneId));
  el('.set-panes').querySelectorAll('.set-pane').forEach(p => p.classList.toggle('active', p.id === paneId));
  setTabMem = paneId;
  if (scCaptureId && paneId !== 'pane-shortcuts') { scCaptureId = null; renderScSettings(); }
}

// ---- R67：快捷键总览 / 自定义 / 实时冲突检测 ----
// 全部应用级快捷键由下表驱动：id + 默认组合，用户可在设置中重定义，
// 生效值恒为「默认 + 用户自定义」，非法/畸形值自动回落默认（scRebuild 归一）。
// i18n/catK：dist53 功能3——label/cat 的翻译键（解析期恒中文，切语言时 applyLangDicts 刷新）
const SC_DEFS = [
  { id: 'new-file', label: '新建', i18n: 'sc.new', cat: '文件', catK: 'cat.file', def: 'Ctrl+N' },
  { id: 'new-window', label: '新建窗口', i18n: 'sc.newWindow', cat: '文件', catK: 'cat.file', def: 'Ctrl+Shift+N' },
  { id: 'open-file', label: '打开', i18n: 'sc.open', cat: '文件', catK: 'cat.file', def: 'Ctrl+O' },
  { id: 'save', label: '保存', i18n: 'sc.save', cat: '文件', catK: 'cat.file', def: 'Ctrl+S' },
  { id: 'save-as', label: '另存为', i18n: 'sc.saveAs', cat: '文件', catK: 'cat.file', def: 'Ctrl+Shift+S' },
  { id: 'export-pdf', label: '导出 PDF', i18n: 'sc.exportPdf', cat: '文件', catK: 'cat.file', def: 'Ctrl+Shift+P' },
  { id: 'export-html', label: '导出 HTML', i18n: 'sc.exportHtml', cat: '文件', catK: 'cat.file', def: 'Ctrl+Shift+H' },
  { id: 'export-doc', label: '导出 Word', i18n: 'sc.exportDoc', cat: '文件', catK: 'cat.file', def: 'Ctrl+Shift+D' },
  { id: 'export-image', label: '导出图片', i18n: 'sc.exportImage', cat: '文件', catK: 'cat.file', def: 'Ctrl+Shift+G' },
  { id: 'print', label: '打印', i18n: 'sc.print', cat: '文件', catK: 'cat.file', def: 'Ctrl+P' },
  { id: 'settings', label: '打开设置', i18n: 'sc.settings', cat: '文件', catK: 'cat.file', def: 'Ctrl+,' },
  { id: 'undo', label: '撤销', i18n: 'sc.undo', cat: '编辑', catK: 'cat.edit', def: 'Ctrl+Z', when: () => !state.sourceMode },
  { id: 'redo', label: '重做', i18n: 'sc.redo', cat: '编辑', catK: 'cat.edit', def: 'Ctrl+Shift+Z' },
  { id: 'find', label: '查找/替换', i18n: 'sc.find', cat: '编辑', catK: 'cat.edit', def: 'Ctrl+F' },
  { id: 'bold', label: '加粗', i18n: 'sc.bold', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+B' },
  { id: 'italic', label: '斜体', i18n: 'sc.italic', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+I' },
  { id: 'strike', label: '删除线', i18n: 'sc.strike', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+Shift+D' },
  { id: 'insert-link', label: '插入链接', i18n: 'sc.insertLink', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+K' },
  { id: 'code-block', label: '代码块', i18n: 'sc.codeBlock', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+Shift+K' },
  { id: 'inline-code', label: '行内代码', i18n: 'sc.inlineCode', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+Shift+C' },
  { id: 'insert-table', label: '插入表格', i18n: 'sc.insertTable', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+Shift+T' },
  { id: 'heading-1', label: '标题 1', i18n: 'heading.h1', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+1' },
  { id: 'heading-2', label: '标题 2', i18n: 'heading.h2', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+2' },
  { id: 'heading-3', label: '标题 3', i18n: 'heading.h3', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+3' },
  { id: 'heading-4', label: '标题 4', i18n: 'heading.h4', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+4' },
  { id: 'heading-5', label: '标题 5', i18n: 'heading.h5', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+5' },
  { id: 'heading-6', label: '标题 6', i18n: 'heading.h6', cat: '格式', catK: 'cat.fmt', def: 'Ctrl+6' },
  { id: 'toggle-sidebar', label: '打开 / 隐藏侧边栏', i18n: 'sc.sidebar', cat: '视图', catK: 'cat.view', def: 'Ctrl+\\' },
  { id: 'toggle-source', label: '源代码模式', i18n: 'sc.source', cat: '视图', catK: 'cat.view', def: 'Ctrl+/' },
  { id: 'zoom-in', label: '放大字体', i18n: 'sc.zoomIn', cat: '视图', catK: 'cat.view', def: 'Ctrl+=' },
  { id: 'zoom-out', label: '缩小字体', i18n: 'sc.zoomOut', cat: '视图', catK: 'cat.view', def: 'Ctrl+-' },
  { id: 'zoom-reset', label: '重置字体', i18n: 'sc.zoomReset', cat: '视图', catK: 'cat.view', def: 'Ctrl+0' },
  { id: 'fullscreen', label: '全屏', i18n: 'sc.fullscreen', cat: '视图', catK: 'cat.view', def: 'F11' },
  { id: 'shortcuts-help', label: '快捷键说明', i18n: 'sc.shortcutsHelp', cat: '帮助', catK: 'cat.help', def: 'Ctrl+Shift+/' }
];
// 系统标准键：原生剪贴板操作，不可重定义（无法也不应重映射），但参与冲突检测
const SC_FIXED = [
  { id: 'cut', label: '剪切', i18n: 'sc.cut', cat: '编辑', catK: 'cat.edit', def: 'Ctrl+X', fixed: true },
  { id: 'copy', label: '复制', i18n: 'sc.copy', cat: '编辑', catK: 'cat.edit', def: 'Ctrl+C', fixed: true },
  { id: 'paste', label: '粘贴', i18n: 'sc.paste', cat: '编辑', catK: 'cat.edit', def: 'Ctrl+V', fixed: true },
  { id: 'select-all', label: '全选', i18n: 'sc.selectAll', cat: '编辑', catK: 'cat.edit', def: 'Ctrl+A', fixed: true }
];
const SC_CATS = ['文件', '编辑', '格式', '视图', '帮助'];
const SC_BY_ID = {};
SC_DEFS.forEach(d => { SC_BY_ID[d.id] = d; });
SC_FIXED.forEach(d => { SC_BY_ID[d.id] = d; });

// 组合串解析（R70：不再强制 Ctrl）：接受 Ctrl/Alt 修饰（可叠加 Shift）+ 单个合法键，
// 或单独的功能键 F1-F12（不带修饰）。Shift 单独不算修饰（Shift+字母 = 普通输入）。
function scParseCombo(str) {
  if (typeof str !== 'string' || !str) return null;
  const toks = str.split('+');
  if (toks.length < 1 || toks.length > 4) return null;
  const key = toks[toks.length - 1];
  const mods = toks.slice(0, -1);
  if (mods.some((t) => !/^(Ctrl|Alt|Shift)$/.test(t))) return null;
  const fm = key.match(/^F(\d{1,2})$/);
  if (fm) {
    const n = +fm[1];
    if (n < 1 || n > 12 || mods.length) return null; // 功能键单独使用
    return { ctrl: false, alt: false, shift: false, key };
  }
  if (!/^[A-Z0-9=\\\/,+\-]$/.test(key)) return null;
  const ctrl = mods.indexOf('Ctrl') !== -1, alt = mods.indexOf('Alt') !== -1, shift = mods.indexOf('Shift') !== -1;
  if (!ctrl && !alt) return null; // 必须含 Ctrl 或 Alt
  return { ctrl, alt, shift, key };
}
function scCanon(str) {
  const p = scParseCombo(str);
  if (!p) return null;
  if (!p.ctrl && !p.alt) return p.key; // 单独功能键
  return (p.ctrl ? 'Ctrl' : '') + (p.alt ? (p.ctrl ? '+' : '') + 'Alt' : '') + (p.shift ? (p.ctrl || p.alt ? '+' : '') + 'Shift' : '') + '+' + p.key;
}
// 当前生效快捷键表（默认 + 用户自定义）；scRebuild 从 settings 重建，
// 设置对话框内的实时修改直接改 scLive，保存时再落盘
let scLive = {};
function scRebuild() {
  const stored = (state.settings && state.settings.shortcuts) || {};
  scLive = {};
  SC_DEFS.forEach(d => { scLive[d.id] = scCanon(stored[d.id]) || d.def; });
  scRebuildMap();
}
// 组合 → id 的分发 Map（scLive 一变就必须重建，onGlobalKeys 查它）
let scMap = new Map();
function scRebuildMap() {
  scMap = new Map();
  SC_DEFS.forEach(d => { const v = scLive[d.id] || d.def; if (!scMap.has(v)) scMap.set(v, d.id); });
}
// 冲突检测：新组合是否已被其他自定义项、系统标准键或菜单加速键（Alt+字母）占用
function scConflict(combo, exceptId) {
  for (const d of SC_DEFS) {
    if (d.id !== exceptId && (scLive[d.id] || d.def) === combo) return d;
  }
  for (const d of SC_FIXED) {
    if (d.def === combo) return d;
  }
  for (const m of MENUS) { // 菜单加速键保留给菜单激活，不可重定义
    if (m.key && combo === 'Alt+' + m.key) return { label: ((typeof m.label === 'function') ? m.label() : m.label) + t('sc.menuAccelWord'), def: 'Alt+' + m.key, fixed: true };
  }
  return null;
}
// 按键事件 → 组合串（R70：Ctrl 或 Alt 均可，可叠加 Shift；或单独 F1-F12）。
// Cmd/Meta 不支持；Shift+= / Shift+/ 归一到基础键；Alt+字母若未被自定义占用仍归菜单加速键
function scComboFromEvent(e) {
  if (e.metaKey) return null;
  if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
    const m = e.key.match(/^F(\d{1,2})$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return 'F' + m[1];
    return null;
  }
  if (!e.ctrlKey && !e.altKey) return null; // Shift 单独不构成快捷键
  let key = e.key;
  if (key.length === 1 && /[a-z]/.test(key)) key = key.toUpperCase();
  if (key === '+') key = '='; // Shift+= 的基础键
  if (key === '?') key = '/'; // Shift+/ 的基础键
  if (!/^[A-Z0-9=\\\/,+\-]$/.test(key)) return null;
  return (e.ctrlKey ? 'Ctrl' : '') + (e.altKey ? (e.ctrlKey ? '+' : '') + 'Alt' : '') + (e.shiftKey ? (e.ctrlKey || e.altKey ? '+' : '') + 'Shift' : '') + '+' + key;
}
// 表驱动执行：id → 具体动作（与原硬编码 if 链逐条对应）
function runShortcut(id) {
  if (id.indexOf('heading-') === 0) { setHeading(parseInt(id.slice(8), 10)); return; }
  switch (id) {
    case 'new-file': newFile(); break;
    case 'new-window': ms.invoke('window:new', {}); break;
    case 'open-file': ms.invoke('dialog:open-file', {}).then(r => { if (r && r.path) openPath(r.path); }); break;
    case 'save': save(false); break;
    case 'save-as': saveAs(false); break;
    case 'export-pdf': exportPdf(); break;
    case 'export-html': exportHtml(); break;
    case 'export-doc': exportDoc(); break;
    case 'export-image': exportImage(); break; // dist54：补漏——此前缺此分支，Ctrl+Shift+G 静默无反应
    case 'print': printDoc(); break;
    case 'settings': openSettings(); break;
    case 'undo': clickToolbar('undo'); break;
    case 'redo': clickToolbar('redo'); break;
    case 'find': toggleFind(true); break;
    case 'bold': applyEmphasis('strong'); break;
    case 'italic': applyEmphasis('em'); break;
    case 'strike': applyEmphasis('s'); break;
    case 'insert-link': clickToolbar('link'); break;
    case 'code-block': clickToolbar('code'); break;
    case 'inline-code': clickToolbar('inline-code'); break;
    case 'insert-table': openTablePicker(null); break;
    case 'toggle-sidebar': toggleSidebar(); sendMenuState(); break;
    case 'toggle-source': toggleSource(); sendMenuState(); break;
    case 'zoom-in': handleMenu('zoom', [1]); break;
    case 'zoom-out': handleMenu('zoom', [-1]); break;
    case 'zoom-reset': handleMenu('zoom', [0]); break;
    case 'fullscreen': ms.invoke('window:fullscreen', {}); break;
    case 'shortcuts-help': openShortcutsModal(); break;
  }
}

// ---- R67：设置对话框内的快捷键自定义 UI（点按录入 + 逐键实时冲突检测）----
let scOpenSnap = {};    // 打开设置对话框时的生效值快照（取消/未保存关闭时回滚用）
let scCaptureId = null; // 正在录入新组合的快捷键 id（null = 未录入）

function scRowEl(id) {
  const box = el('#set-sc-list');
  return box ? box.querySelector('.sc-row[data-id="' + id + '"]') : null;
}
// R70：冲突/无效组合的悬浮提示——fixed 定位跟随视口（列表滚动容器 overflow 会裁剪
// 绝对定位的 ::after 气泡，故改用 body 级元素；mouseenter 显示、mouseleave 消失）
let scTipEl = null;
function scTipShow(anchor, text) {
  if (!scTipEl) {
    scTipEl = document.createElement('div');
    scTipEl.id = 'sc-tip';
    document.body.appendChild(scTipEl);
  }
  scTipEl.textContent = text;
  scTipEl.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const tw = scTipEl.offsetWidth, th = scTipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  let y = r.top - th - 8; // 默认在徽章上方；空间不足时翻到下方
  if (y < 8) y = r.bottom + 8;
  scTipEl.style.left = x + 'px';
  scTipEl.style.top = y + 'px';
}
function scTipHide() {
  if (scTipEl) scTipEl.classList.add('hidden');
}
function scShowMsg(id, text, ok) {
  const row = scRowEl(id);
  if (!row) return;
  const msg = row.querySelector('.sc-msg');
  if (!msg) return;
  if (text && !ok) {
    // R70：红色感叹号徽章（不再直接铺红字——长文会截断且无悬浮全文）
    msg.textContent = '';
    const warn = document.createElement('span');
    warn.className = 'sc-warn';
    warn.textContent = '!';
    warn.setAttribute('data-tip', text);
    warn.addEventListener('mouseenter', () => scTipShow(warn, text));
    warn.addEventListener('mouseleave', scTipHide);
    msg.appendChild(warn);
    return;
  }
  msg.textContent = text || '';
}
function renderScSettings() {
  scTipHide(); // 重渲染会销毁徽章锚点，悬浮提示必须一并收起
  const box = el('#set-sc-list');
  if (!box) return;
  box.innerHTML = '';
  const all = SC_DEFS.concat(SC_FIXED);
  SC_CATS.forEach(cat => {
    const items = all.filter(d => d.cat === cat);
    if (!items.length) return;
    const hd = document.createElement('div');
    hd.className = 'sc-cat';
    hd.textContent = cat;
    box.appendChild(hd);
    items.forEach(d => {
      const row = document.createElement('div');
      row.className = 'sc-row' + (d.fixed ? ' fixed' : '');
      row.dataset.id = d.id;
      if (scCaptureId === d.id) row.classList.add('capturing');
      const lab = document.createElement('span');
      lab.className = 'sc-lab';
      lab.textContent = d.label;
      row.appendChild(lab);
      if (d.fixed) {
        const tag = document.createElement('span');
        tag.className = 'sc-combo sc-fixed';
        tag.textContent = d.def + t('sc.sys');
        row.appendChild(tag);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sc-combo' + (scLive[d.id] !== d.def ? ' custom' : '');
        btn.textContent = scCaptureId === d.id ? t('sc.pressNew') : (scLive[d.id] || d.def);
        btn.addEventListener('click', () => {
          if (scCaptureId) return;
          scCaptureId = d.id;
          renderScSettings();
        });
        row.appendChild(btn);
        const rst = document.createElement('button');
        rst.type = 'button';
        rst.className = 'sc-reset';
        rst.textContent = t('sc.restore');
        rst.title = t('sc.restoreTo', { def: d.def });
        rst.addEventListener('click', () => {
          scCaptureId = null;
          scLive[d.id] = d.def;
          scRebuildMap();
          renderScSettings();
          toast(t('sc.restored', { label: d.label, def: d.def }));
        });
        row.appendChild(rst);
      }
      const msg = document.createElement('span');
      msg.className = 'sc-msg';
      row.appendChild(msg);
      box.appendChild(row);
    });
  });
}
// 全局唯一录入监听（init 时以捕获阶段注册一次）：仅当 scCaptureId 非空时接管按键。
// 逐键实时校验——无效组合提示补按，冲突立即报「与 X 冲突」并保留旧值，合法才生效。
function scOnCaptureKey(e) {
  if (!scCaptureId) return;
  const id = scCaptureId;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  if (e.key === 'Escape') { scCaptureId = null; renderScSettings(); return; }
  if (e.repeat) return; // 忽略键盘自动重复，只处理首次按下
  const combo = scComboFromEvent(e);
  if (!combo) {
    scShowMsg(id, t('sc.invalidNoCtrl'), false);
    return;
  }
  if (combo === (scLive[id] || SC_BY_ID[id].def)) { scCaptureId = null; renderScSettings(); return; } // 按回当前组合 = 保持不变
  const hit = scConflict(combo, id);
  if (hit) {
    const hitCombo = hit.fixed ? hit.def : (scLive[hit.id] || hit.def);
    scShowMsg(id, t('sc.conflict', { a: hit.label, b: hitCombo }), false);
    toast(t('sc.conflictToast', { combo, label: hit.label }), 2500);
    return;
  }
  scLive[id] = combo;
  scCaptureId = null;
  scRebuildMap(); // 立即生效：旧组合失效、新组合即刻可用
  renderScSettings();
  scShowMsg(id, t('sc.set', { combo }), true);
}
function openShortcutsModal() {
  // 快捷键说明：从注册表动态渲染（含用户自定义后的生效值与系统标准键）
  const box = el('#shortcuts-table');
  if (box) {
    box.innerHTML = '';
    const all = SC_DEFS.concat(SC_FIXED);
    SC_CATS.forEach(cat => {
      const items = all.filter(d => d.cat === cat);
      if (!items.length) return;
      const tr0 = document.createElement('tr');
      tr0.className = 'sc-cat-row';
      const td0 = document.createElement('td');
      td0.colSpan = 2;
      td0.textContent = cat;
      tr0.appendChild(td0);
      box.appendChild(tr0);
      items.forEach(d => {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = d.label;
        const td2 = document.createElement('td');
        td2.textContent = d.fixed ? d.def : (scLive[d.id] || d.def); // R74：不再显示「（系统标准）」后缀
        tr.appendChild(td1);
        tr.appendChild(td2);
        box.appendChild(tr);
      });
    });
    const trA = document.createElement('tr');
    const tdA1 = document.createElement('td');
    tdA1.textContent = t('sc.menuAccel');
    const tdA2 = document.createElement('td');
    tdA2.textContent = t('sc.menuAccelTip');
    trA.appendChild(tdA1);
    trA.appendChild(tdA2);
    box.appendChild(trA);
    const trP = document.createElement('tr');
    const tdP1 = document.createElement('td');
    tdP1.textContent = t('sc.pasteImage');
    const tdP2 = document.createElement('td');
    tdP2.textContent = t('sc.pasteImageTip');
    trP.appendChild(tdP1);
    trP.appendChild(tdP2);
    box.appendChild(trP);
  }
  el('#modal-shortcuts').classList.remove('hidden');
}

// R75-3：把设置对象填充进设置对话框的表单控件（openSettings 与「恢复默认」共用）
function fillSettingsForm(s) {
  el('#set-language').value = s.language || 'zh-CN';
  el('#set-theme').value = s.theme;
  el('#set-content-theme').value = s.contentTheme || 'auto';
  el('#set-fontsize').value = s.fontSize;
  el('#set-font').value = s.contentFont || '';
  // 兼容：保存值可能是本地化字体名或英文 family 名（跨系统）→ 按显示名 / family / 别名找回
  if (!el('#set-font').value && s.contentFont) {
    const hit = Array.from(el('#set-font').options).find(o => o.textContent === s.contentFont || o.value.toLowerCase() === String(s.contentFont).toLowerCase())
      || (() => { const e = fontEntryMatch(s.contentFont); return e ? Array.from(el('#set-font').options).find(o => o.value === e.family || o.textContent === (e.local || e.family)) : null; })();
    if (hit) el('#set-font').value = hit.value;
  }
  // dist67：优先用传入设置的 lineHeight（「恢复默认」据此把行高填回 1.75）；
  // 传入值非法时回退当前生效值（openSettings 场景二者一致，行为不变）
  const lhRaw = parseFloat(s.lineHeight);
  const lh = (Number.isFinite(lhRaw) && lhRaw >= 1 && lhRaw <= 3) ? lhRaw : currentLineHeight();
  const lhSel = el('#set-lh');
  lhSel.value = LINE_HEIGHTS.some(x => x.v === lh) ? String(lh) : 'custom';
  el('#set-lh-num').value = lh;
  el('#set-width').value = String(s.contentWidth === undefined || s.contentWidth === null ? 'full' : s.contentWidth);
  el('#set-center').checked = !!s.contentCenter;
  el('#set-wrap').checked = s.wrap !== false;
  el('#set-autosave').checked = !!s.autosave;
  el('#set-typewriter').checked = !!s.typewriter;
  el('#set-focus').checked = !!s.focusMode;
  el('#set-codelines').checked = s.codeLineNumbers !== false;
  el('#set-close-action').value = s.closeAction || 'ask';
}

function openSettings() {
  const s = state.settings;
  fillSettingsForm(s);
  // R67：快捷键自定义区——快照当前生效值（未保存关闭时回滚），渲染列表
  scOpenSnap = { ...scLive };
  scCaptureId = null;
  renderScSettings();
  setTab(setTabMem); // R68：回到上次停留的 tab
  el('#modal-settings').classList.remove('hidden');
  // 系统字体列表（主进程缓存，只查一次）
  const sel = el('#set-font');
  if (sel.options.length <= 1) {
    ms.invoke('app:list-fonts').then((fonts) => {
      if (el('#modal-settings').classList.contains('hidden')) return;
      const cur = sel.value;
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = t('set.fontDefault');
      sel.appendChild(def);
      (fonts || []).forEach((f) => {
        const fam = (typeof f === 'string') ? f : f.family;
        const lab = (typeof f === 'string') ? f : (f.local || f.family);
        const o = document.createElement('option');
        o.value = fam;
        o.textContent = lab;
        sel.appendChild(o);
      });
      // 兼容旧值：保存的可能是本地化字体名（如「微软雅黑」）或英文名（跨系统）→
      // 按 family / 显示名 / 别名映射找回选项
      let v = '';
      const want = (s && s.contentFont) || cur;
      if (want) {
        const hit = Array.from(sel.options).find(o => o.value === want || o.value.toLowerCase() === String(want).toLowerCase() || o.textContent === want)
          || (() => { const e = fontEntryMatch(want); return e ? Array.from(sel.options).find(o => o.value === e.family || o.textContent === (e.local || e.family)) : null; })();
        if (hit) v = hit.value;
      }
      sel.value = v;
    }).catch(() => { });
  }
}

async function saveSettings() {
  // 打字机模式影响编辑器渲染行为，必须整体重建；专注模式 R75 起用 CSS 类实现，可热切换
  const prevTypewriter = !!(state.settings && state.settings.typewriter);
  const prevCodeLines = (state.settings && state.settings.codeLineNumbers) !== false;
  const prevLang = (state.settings && state.settings.language) || 'zh-CN';
  const partial = {
    language: el('#set-language').value || 'zh-CN',
    theme: el('#set-theme').value,
    contentTheme: el('#set-content-theme').value,
    fontSize: parseInt(el('#set-fontsize').value, 10) || 16,
    contentFont: el('#set-font').value,
    lineHeight: Math.min(3, Math.max(1, parseFloat(el('#set-lh-num').value) || 1.75)),
    contentWidth: el('#set-width').value,
    contentCenter: el('#set-center').checked,
    wrap: el('#set-wrap').checked,
    autosave: el('#set-autosave').checked,
    typewriter: el('#set-typewriter').checked,
    focusMode: el('#set-focus').checked,
    codeLineNumbers: el('#set-codelines').checked,
    closeAction: el('#set-close-action').value
  };
  // R67：快捷键——主进程按对象整体替换合并，故落盘完整生效表（只存非默认项即可覆盖，
  // 此处直接全量存最稳）；与已存值无差异则不写，避免无谓落盘
  const storedSc = (state.settings && state.settings.shortcuts) || {};
  const scAll = {};
  SC_DEFS.forEach(d => { scAll[d.id] = scLive[d.id]; });
  if (Object.keys(scAll).some(k => scAll[k] !== storedSc[k]) || Object.keys(storedSc).some(k => !scAll[k])) {
    partial.shortcuts = scAll;
  }
  state.settings = await ms.invoke('app:set-settings', { partial });
  el('#modal-settings').classList.add('hidden');
  // dist53 功能3：语言变化 → 热切换（i18n-changed 监听器刷新 UI 文本），Vditor 按新语言重建
  const langChanged = prevLang !== ((state.settings && state.settings.language) || 'zh-CN');
  if (langChanged) {
    setLang(state.settings.language || 'zh-CN');
    try { ms.invoke('app:set-language', { lang: state.settings.language || 'zh-CN' }).catch(() => { }); } catch (e) { } // 主进程跟随（系统对话框/托盘菜单）
  }
  applyThemeDom(state.settings.theme);
  applyFontSize();
  applyFont();
  applyContentLayout();
  applyWrap();
  applyLineHeight();
  const needRebuild = prevTypewriter !== !!state.settings.typewriter || langChanged || prevCodeLines !== (state.settings.codeLineNumbers !== false);
  if (needRebuild || !applyEditorTheme()) recreateEditor(getCurrentContent());
  // R75-9：专注模式无需重建，直接按最新设置应用/清除高亮类
  applyFocusMode();
  // R67：以落盘值重建生效表（含归一），并刷新快照——此后关闭对话框不再回滚
  scRebuild();
  scOpenSnap = { ...scLive };
  toast(t('toast.settingsSaved'));
}

// dist67：「恢复默认」改走「保存才生效」——只把默认值填进表单（预览），**不**改 state.settings、
// **不**应用、**不**落盘、**不**切语言；点「保存」才落盘+应用（见 saveSettings），点「取消/关闭」
// 由 closeSettingsModal 回滚（scLive=scOpenSnap + 语言下拉还原）即丢弃。与其余设置项行为一致。
async function doSettingsReset(scope, msg) {
  let s;
  try { s = await ms.invoke('app:default-settings', { scope }); } catch (e) { toast(t('toast.resetFailed')); return; }
  if (!s) return;
  fillSettingsForm(s); // 只更新表单 UI（语言下拉/主题/字号/行高…），不动生效值
  // 快捷键填回默认（scOpenSnap 保持不变 → 取消可回滚到打开时的值；保存时才落盘 scLive）
  if (scope === 'all') {
    SC_DEFS.forEach(d => { scLive[d.id] = d.def; });
    scRebuildMap();
    renderScSettings();
  }
  toast(msg);
}

// R67：未保存关闭设置对话框（取消按钮 / Escape）——丢弃进行中修改，回滚到打开时的生效值；
// 对话框本就关闭时（如欢迎页按 Escape 会走到这里）不得回滚，否则会把生效表清空
function closeSettingsModal() {
  scCaptureId = null;
  const modal = el('#modal-settings');
  if (!modal.classList.contains('hidden')) {
    scLive = { ...scOpenSnap };
    scRebuildMap();
    // dist62 修复：语言未点「保存」不生效——取消/关闭时把下拉还原到当前生效语言（不切换、不落盘）
    const langSel = el('#set-language');
    if (langSel) langSel.value = ((state.settings && state.settings.language) || 'zh-CN');
  }
  modal.classList.add('hidden');
}

// ---------------------------------------------------------------- 自绘菜单栏
// 原生 Electron 菜单的悬浮响应无法调参（迟钝），且无法承载颜色盘/字体面板这类富 UI，
// 因此整体改用渲染层自绘：鼠标悬停即开、切换毫秒级、支持子菜单飞出与键盘导航。
function persistSettings(partial) {
  ms.invoke('app:set-settings', { partial });
}

function hasTextSelection() {
  if (state.sourceMode) {
    const ta = el('#source');
    return ta.selectionEnd > ta.selectionStart;
  }
  const sel = window.getSelection();
  return !!(sel && sel.rangeCount && !sel.isCollapsed && sel.toString());
}

const TEXT_FONTS_COMMON = ['宋体', '黑体', '楷体', '仿宋', '微软雅黑', '等线', 'Consolas'];
const TEXT_SIZES = [10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 64];
const TEXT_COLORS = ['#000000', '#444444', '#707070', '#ffffff', '#e5484d', '#f76b15', '#ff8c00', '#ffd60a', '#8bc34a', '#30a46c', '#00b8d9', '#007acc', '#2f6fd0', '#6e56cf', '#b45ccf', '#d6409f'];

// 「文件 → 设置 → 正文字体（整篇）」子菜单：整篇正文用哪个字体（勾选当前生效值）
// dist53 功能3：字体名是数据（不翻译）；仅「Consolas（等宽）」这类带本地化后缀的标签走 fontLabel
function fontLabel(name) {
  return name === 'Consolas（等宽）' ? t('font.consolasMono') : name;
}
function bodyFontSubItems() {
  const f = state.settings && state.settings.contentFont;
  const opt = (name, val) => ({ label: name, check: f === val, act: () => handleMenu('set-content-font', [val]) });
  return [
    opt(t('set.fontDefault'), ''),
    opt('宋体', '宋体'),
    opt('楷体', '楷体'),
    opt('微软雅黑', '微软雅黑'),
    opt('黑体', '黑体'),
    opt('仿宋', '仿宋'),
    opt('等线', '等线'),
    opt(t('font.consolasMono'), 'Consolas'),
    { sep: true },
    // dist58 功能3：不再跳系统设置对话框，直接展开「所有系统字体」子菜单（整篇正文字体，勾选当前生效值）
    { label: t('fmt.allFonts'), sub: bodyAllFontSubItems() }
  ];
}
// dist58 功能3：「所有系统字体」子菜单——列出系统全部字体（本地化名显示、family 应用），
// 点选即整篇切换正文内容字体（set-content-font），勾选当前 contentFont。
// 注意与 sysFontSubItems()（作用于选中文字样式）不同，这里作用于整篇。
function bodyAllFontSubItems() {
  const f = state.settings && state.settings.contentFont;
  const fonts = (sysFontsCache && sysFontsCache.length) ? sysFontsCache : [];
  const famOf = (x) => (typeof x === 'string' ? x : x.family);
  const labOf = (x) => (typeof x === 'string' ? x : (x.local || x.family));
  const items = fonts.map((x) => ({ label: labOf(x), check: f === famOf(x), act: () => handleMenu('set-content-font', [famOf(x)]) }));
  if (!items.length) items.push({ label: t('fp.loading'), disabled: true });
  return items;
}

const MENUS = [
  {
    id: 'file', label: () => t('menu.file'), key: 'F', items: () => {
      const recents = (state.recent || []).slice(0, 10);
      const saved = !!state.docPath;
      const ds = (it) => (saved ? it : Object.assign({}, it, { disabled: true }));
      const hasDoc = !!activeTab();
      const dd = (it) => (hasDoc ? it : Object.assign({}, it, { disabled: true }));
      return [
        { label: t('file.new'), accel: 'Ctrl+N', accelId: 'new-file', act: () => newFile() },
        { label: t('file.newWindow'), accel: 'Ctrl+Shift+N', accelId: 'new-window', act: () => ms.invoke('window:new', {}) },
        { sep: true },
        { label: t('file.open'), accel: 'Ctrl+O', accelId: 'open-file', act: () => ms.invoke('dialog:open-file', {}).then(r => { if (r && r.path) openPath(r.path); }) },
        { label: t('file.openFolder'), act: () => openFolderDialog() },
        { label: t('file.recentFiles'), sub: recents.length ? recents.map(p => ({ label: baseName(p), title: p, act: () => openPath(p) })) : [{ label: t('file.noRecentFiles'), disabled: true }] },
        // R75-2：最近打开的文件夹子菜单（点选后切换侧边栏文件夹）
        { label: t('file.recentFolders'), sub: (state.recentFolders || []).length ? state.recentFolders.map(p => ({ label: baseName(p) === '/' || baseName(p) === '' ? p : baseName(p), title: p, act: () => openFolder(p) })) : [{ label: t('file.noRecentFolders'), disabled: true }] },
        { sep: true },
        { label: t('file.save'), accel: 'Ctrl+S', accelId: 'save', act: () => save(false) },
        { label: t('file.saveAs'), accel: 'Ctrl+Shift+S', accelId: 'save-as', act: () => saveAs(false) },
        { label: t('file.export'), sub: [
          dd({ label: t('file.exportPdf'), accel: 'Ctrl+Shift+P', accelId: 'export-pdf', act: () => exportPdf() }),
          dd({ label: t('file.exportHtml'), accel: 'Ctrl+Shift+H', accelId: 'export-html', act: () => exportHtml() }),
          dd({ label: t('file.exportDoc'), accel: 'Ctrl+Shift+D', accelId: 'export-doc', act: () => exportDoc() }),
          dd({ label: t('file.exportImage'), accel: 'Ctrl+Shift+G', accelId: 'export-image', act: () => exportImage() }),
          dd({ label: t('file.print'), accel: 'Ctrl+P', accelId: 'print', act: () => printDoc() })
        ] },
        { sep: true },
        ds({ label: t('file.showFolder'), act: () => { if (state.docPath) ms.invoke('shell:show-item', { path: state.docPath }); else toast(t('file.docNotSaved')); } }),
        ds({ label: t('file.copyPath'), act: () => { if (state.docPath) { ms.invoke('clipboard:write', { text: state.docPath }); toast(t('file.pathCopied')); } else toast(t('file.docNotSaved')); } }),
        { sep: true },
        { label: t('file.settings'), sub: [
          { label: t('file.bodyFont'), sub: bodyFontSubItems() },
          { sep: true },
          { label: t('file.openSettings'), accel: 'Ctrl+,', accelId: 'settings', act: () => openSettings() }
        ] },
        { sep: true },
        { label: t('file.quit'), act: () => window.close() }
      ];
    }
  },
  {
    id: 'edit', label: () => t('menu.edit'), key: 'E', items: () => {
      const hasSel = hasTextSelection();
      const d = (it) => (hasSel ? it : Object.assign({}, it, { disabled: true }));
      const linkOk = !!(state.lastLink && /^https?:\/\//i.test(state.lastLink));
      const dl = (it) => (linkOk ? it : Object.assign({}, it, { disabled: true }));
      return [
        { label: t('edit.undo'), accel: 'Ctrl+Z', accelId: 'undo', act: () => clickToolbar('undo') },
        { label: t('edit.redo'), accel: 'Ctrl+Shift+Z', accelId: 'redo', act: () => clickToolbar('redo') },
        { sep: true },
        d({ label: t('edit.cut'), accel: 'Ctrl+X', act: () => { ensureEditorFocus(); document.execCommand('cut'); } }),
        d({ label: t('edit.copy'), accel: 'Ctrl+C', act: () => document.execCommand('copy') }),
        { label: t('edit.paste'), accel: 'Ctrl+V', act: () => doPaste() },
        { label: t('edit.selectAll'), accel: 'Ctrl+A', act: () => { ensureEditorFocus(); document.execCommand('selectAll'); } },
        { sep: true },
        // R75-7：提升/降低标题级别（段落提升→H1；H1 不可再提升，H6 不可再降低）
        ...(function () {
          const hl = caretHeadingLevel();
          const canPromote = !state.sourceMode && (hl === 0 || hl > 1);
          const canDemote = !state.sourceMode && hl >= 1 && hl < 6;
          return [
            { label: t('edit.promote'), accel: 'Ctrl+]', disabled: !canPromote, act: () => changeHeadingLevel(-1) },
            { label: t('edit.demote'), accel: 'Ctrl+[' , disabled: !canDemote, act: () => changeHeadingLevel(1) },
            { sep: true },
            { label: t('edit.findReplace'), accel: 'Ctrl+F', accelId: 'find', act: () => toggleFind(true) },
            { sep: true },
            dl({ label: t('edit.openLinkExt'), act: () => handleMenu('open-link-external', []) })
          ];
        })()
      ];
    }
  },
  {
    id: 'para', label: () => t('menu.para'), key: 'D', items: () => {
      const h = (lv) => ({ label: t('heading.h' + lv), accel: 'Ctrl+' + lv, accelId: 'heading-' + lv, act: () => setHeading(lv) });
      // 光标不在表格内时，行列操作一律灰显禁用（插入表格仍可点）
      const inTbl = !!getTableInfoAtCaret();
      const tdis = (it) => (inTbl ? it : Object.assign({}, it, { disabled: true }));
      return [
        h(1), h(2), h(3), h(4), h(5), h(6),
        { sep: true },
        { label: t('para.insertAbove'), act: () => insertParagraph('above') },
        { label: t('para.insertBelow'), act: () => insertParagraph('below') },
        { sep: true },
        { label: t('para.olist'), act: () => clickToolbar('ordered-list') },
        { label: t('para.ulist'), act: () => clickToolbar('list') },
        { label: t('para.tasklist'), act: () => clickToolbar('check') },
        { label: t('para.quote'), act: () => clickToolbar('quote') },
        { sep: true },
        { label: t('para.codeBlock'), accel: 'Ctrl+Shift+K', accelId: 'code-block', act: () => clickToolbar('code') },
        { label: t('para.inlineCode'), accel: 'Ctrl+Shift+C', accelId: 'inline-code', act: () => clickToolbar('inline-code') },
        { label: t('para.table'), sub: [
          { label: t('para.insertTable'), accel: 'Ctrl+Shift+T', accelId: 'insert-table', act: () => openTablePicker(null) },
          { sep: true },
          tdis({ label: t('para.rowAbove'), act: () => opTable('row-above') }),
          tdis({ label: t('para.rowBelow'), act: () => opTable('row-below') }),
          tdis({ label: t('para.rowDel'), act: () => opTable('row-del') }),
          tdis({ label: t('para.rowUp'), act: () => opTable('row-up') }),
          tdis({ label: t('para.rowDown'), act: () => opTable('row-down') }),
          { sep: true },
          tdis({ label: t('para.colLeft'), act: () => opTable('col-left') }),
          tdis({ label: t('para.colRight'), act: () => opTable('col-right') }),
          tdis({ label: t('para.colDel'), act: () => opTable('col-del') }),
          tdis({ label: t('para.colLeftMove'), act: () => opTable('col-move-left') }),
          tdis({ label: t('para.colRightMove'), act: () => opTable('col-move-right') }),
          { sep: true },
          tdis({ label: t('para.delTable'), act: () => opTable('table-del') })
        ] },
        { label: t('para.hr'), act: () => clickToolbar('line') },
        { sep: true },
        { label: t('para.insertLink'), accel: 'Ctrl+K', accelId: 'insert-link', act: () => clickToolbar('link') },
        { label: t('para.insertImage'), act: () => insertImageDialog() },
        { label: t('para.insertFormula'), act: () => insertFormula() }
      ];
    }
  },
  {
    id: 'fmt', label: () => t('menu.fmt'), key: 'G', items: () => {
      const hasSel = hasTextSelection();
      const dis = (it) => (hasSel ? it : Object.assign({}, it, { disabled: true }));
      return [
        { label: t('fmt.bold'), accel: 'Ctrl+B', accelId: 'bold', act: () => applyEmphasis('strong') },
        { label: t('fmt.italic'), accel: 'Ctrl+I', accelId: 'italic', act: () => applyEmphasis('em') },
        { label: t('fmt.strike'), accel: 'Ctrl+Shift+D', accelId: 'strike', act: () => applyEmphasis('s') },
        { sep: true },
        { label: t('fmt.font'), sub: [
          dis({ label: t('fmt.fontFollow'), act: () => applyTextStyle({ fontFamily: null }) }),
          ...TEXT_FONTS_COMMON.map((x) => dis({ label: fontLabel(x), act: () => applyTextStyle({ fontFamily: x }) })),
          { sep: true },
          dis({ label: t('fmt.fontSys'), sub: sysFontSubItems() })
        ] },
        { label: t('fmt.fontSize'), sub: [
          ...TEXT_SIZES.map((n) => dis({ label: n + ' px', act: () => applyTextStyle({ fontSize: n + 'px' }) })),
          { sep: true },
          dis({ label: t('fmt.fontSizeCustom'), act: () => openCustomSizePop() })
        ] },
        { label: t('fmt.color'), sub: [
          { type: 'colorgrid', disabled: !hasSel },
          dis({ label: t('fmt.colorCustom'), act: () => openCustomColorPop() }),
          { sep: true },
          dis({ label: t('fmt.colorReset'), act: () => applyTextStyle({ color: null }) })
        ] },
        { sep: true },
        dis({ label: t('fmt.clearStyle'), act: () => applyTextStyle({ fontFamily: null, fontSize: null, color: null }) })
      ];
    }
  },
  {
    id: 'view', label: () => t('menu.view'), key: 'S', items: () => {
      const s = state.settings || {};
      return [
        { label: el('#sidebar').classList.contains('hidden') ? t('view.showSidebar') : t('view.hideSidebar'), accel: 'Ctrl+\\', accelId: 'toggle-sidebar', act: () => { toggleSidebar(); sendMenuState(); } },
        { label: state.sourceMode ? t('view.exitSourceMode') : t('view.sourceMode'), accel: 'Ctrl+/', accelId: 'toggle-source', act: () => { toggleSource(); sendMenuState(); } },
        { label: t('view.lineNumbers'), check: !!state.showLines, act: () => { toggleLines(); sendMenuState(); } },
        { label: t('view.wrap'), check: s.wrap !== false, act: () => handleMenu('toggle-wrap', [s.wrap === false]) },
        { sep: true },
        { label: t('view.lh'), sub: [
          ...LINE_HEIGHTS.map(x => ({ label: x.name, check: Math.abs(currentLineHeight() - x.v) < 0.001, act: () => handleMenu('set-line-height', [x.v]) })),
          { sep: true },
          { label: t('view.lhCustom'), act: () => openSettings() }
        ] },
        { label: t('view.contentWidth'), sub: [
          { label: t('view.widthFull'), check: String(s.contentWidth === undefined || s.contentWidth === null ? 'full' : s.contentWidth) === 'full', act: () => handleMenu('set-content-width', ['full']) },
          { label: t('view.width1200'), check: String(s.contentWidth) === '1200', act: () => handleMenu('set-content-width', [1200]) },
          { label: t('view.width1000'), check: String(s.contentWidth) === '1000', act: () => handleMenu('set-content-width', [1000]) },
          { label: t('view.width860'), check: String(s.contentWidth) === '860', act: () => handleMenu('set-content-width', [860]) }
        ] },
        { sep: true },
        { label: t('view.zoomIn'), accel: 'Ctrl+=', accelId: 'zoom-in', act: () => handleMenu('zoom', [1]) },
        { label: t('view.zoomOut'), accel: 'Ctrl+-', accelId: 'zoom-out', act: () => handleMenu('zoom', [-1]) },
        { label: t('view.zoomReset'), accel: 'Ctrl+0', accelId: 'zoom-reset', act: () => handleMenu('zoom', [0]) },
        { sep: true },
        { label: t('view.typewriter'), check: !!s.typewriter, act: () => handleMenu('set-typewriter', [!s.typewriter]) },
        { label: t('view.focus'), check: !!s.focusMode, act: () => handleMenu('set-focus', [!s.focusMode]) },
        { sep: true },
        // R75-4b：同一时间只显示一个——全屏后为「退出全屏」，退出后为「全屏」
        { label: state.isFullScreen ? t('view.exitFullscreen') : t('view.fullscreen'), accel: 'F11', accelId: 'fullscreen', act: () => ms.invoke('window:fullscreen', {}) }
        // dist55 修复1：界面语言入口移至「文件 → 设置 → 打开设置 → 通用 → 界面语言」
        // （dist62 起改为点「保存」才生效、取消则还原），菜单不再重复提供
      ];
    }
  },
  {
    id: 'theme', label: () => t('menu.theme'), key: 'T', items: () => {
      const s = state.settings || {};
      const ct = s.contentTheme || 'auto';
      return [
        { label: t('theme.light'), check: s.theme === 'light', act: () => handleMenu('set-theme', ['light']) },
        { label: t('theme.dark'), check: s.theme === 'dark', act: () => handleMenu('set-theme', ['dark']) },
        { sep: true },
        { label: t('theme.content'), sub: [
          { label: t('theme.ctAuto'), check: ct === 'auto', act: () => handleMenu('set-content-theme', ['auto']) },
          { label: t('theme.ctLight'), check: ct === 'light', act: () => handleMenu('set-content-theme', ['light']) },
          { label: 'Ant Design', check: ct === 'ant-design', act: () => handleMenu('set-content-theme', ['ant-design']) },
          { label: t('theme.ctWechat'), check: ct === 'wechat', act: () => handleMenu('set-content-theme', ['wechat']) }
        ] }
      ];
    }
  },
  {
    id: 'help', label: () => t('menu.help'), key: 'H', items: () => [
      { label: t('help.shortcuts'), accel: 'Ctrl+Shift+/', accelId: 'shortcuts-help', act: () => openShortcutsModal() },
      { sep: true },
      { label: t('help.about'), act: () => showAbout() }
    ]
  }
];

let mbOpenId = null;   // 当前打开的顶级菜单 id
let mbActivated = false; // 菜单栏是否已被点击激活（未激活时悬停不弹菜单，避免误触）
let mbSubStack = [];   // 打开中的子菜单栈 [{fly, row}]，底→顶（支持多级）；fly._mbTimer 为该面板的延迟关闭计时器
let mbCloseTimer = null;
let mbAltDown = false; // Alt 是否按住（欢迎页时按住 Alt 临时显示菜单栏）

function buildMenuBar() {
  const bar = el('#menubar');
  if (!bar) return;
  bar.innerHTML = '';
  MENUS.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mb-item';
    b.dataset.menu = m.id;
    const lab = document.createElement('span');
    lab.className = 'mb-label';
    lab.textContent = (typeof m.label === 'function') ? m.label() : m.label;
    const key = document.createElement('span');
    key.className = 'mb-key';
    key.textContent = '(' + m.key + ')';
    b.appendChild(lab);
    b.appendChild(key);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    // 点击激活后悬停才开：未激活时悬停不弹（防误触），点击即激活并打开
    b.addEventListener('mouseenter', () => { if (mbActivated && mbOpenId !== m.id) mbOpenMenu(m.id); });
    b.addEventListener('click', () => {
      if (mbActivated && mbOpenId === m.id) mbCloseAll();
      else { mbActivated = true; mbOpenMenu(m.id); }
    });
    bar.appendChild(b);
  });
  bar.addEventListener('mouseleave', mbScheduleClose);
  // Alt 按住时高亮各菜单的助记字母；欢迎页（未打开文档）时按 Alt 也可临时显示
  document.addEventListener('keydown', (e) => {
    if (e.altKey) { mbAltDown = true; bar.classList.add('alt-mode'); bar.classList.remove('hidden'); }
  });
  document.addEventListener('keyup', (e) => {
    if (!e.altKey) { mbAltDown = false; bar.classList.remove('alt-mode'); syncMenuBarVis(); }
  });
  syncMenuBarVis();
}
// 菜单栏显隐：与品牌标签同一规则（见 syncBrandTab）——欢迎页时隐藏（按 Alt 可临时显示），
// 进入工作区（含只打开了文件夹、尚未打开文件）即显示
function syncMenuBarVis() {
  const bar = el('#menubar');
  if (bar) bar.classList.toggle('hidden', isWelcomeVisible() && !mbAltDown && !mbOpenId);
}

// 清空所有已打开的子菜单（不含顶级 fly 本身，由调用方决定是否移除 DOM）
function mbClearSubs() {
  while (mbSubStack.length) {
    const e = mbSubStack.pop();
    clearTimeout(e.fly._timer);
    e.fly.remove();
    e.row.classList.remove('kb-focus');
  }
}

// fly 的祖先链（子菜单 fly._mbParent 指向其父级 fly，顶级 fly 为 null）
function mbFlyInside(ancestorFly, fly) {
  let cur = fly;
  while (cur) {
    if (cur === ancestorFly) return true;
    cur = cur._mbParent || null;
  }
  return false;
}

function mbOpenMenu(id) {
  mbCancelClose();
  // 先清掉所有已存在的弹出面板（切换菜单时旧面板不能残留）
  mbClearSubs();
  els('.mb-fly').forEach((f) => f.remove());
  els('#menubar .mb-item.open').forEach((b) => b.classList.remove('open'));
  const def = MENUS.find((m) => m.id === id);
  const btn = el('#menubar .mb-item[data-menu="' + id + '"]');
  if (!def || !btn) return;
  const fly = document.createElement('div');
  fly.className = 'mb-fly';
  fly.dataset.menu = id;
  fly._mbParent = null;
  buildMenuItems(fly, def.items());
  document.body.appendChild(fly);
  const r = btn.getBoundingClientRect();
  fly.style.left = Math.max(8, Math.min(r.left, window.innerWidth - fly.offsetWidth - 8)) + 'px';
  fly.style.top = (r.bottom + 2) + 'px';
  fly.addEventListener('mouseenter', () => { mbCancelSubTimers(); mbCancelClose(); });
  fly.addEventListener('mouseleave', mbScheduleClose);
  mbOpenId = id;
  btn.classList.add('open');
}

function buildMenuItems(fly, items) {
  items.forEach((it) => {
    if (it.sep) { const hr = document.createElement('hr'); hr.className = 'mb-sep'; fly.appendChild(hr); return; }
    if (it.type === 'colorgrid') {
      const grid = document.createElement('div');
      grid.className = 'mb-cgrid';
      if (it.disabled) grid.classList.add('disabled');
      TEXT_COLORS.forEach((c) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'mb-cswatch';
        sw.style.background = c;
        sw.title = c;
        if (!it.disabled) sw.addEventListener('click', () => { mbCloseAll(); applyTextStyle({ color: c }); });
        grid.appendChild(sw);
      });
      fly.appendChild(grid);
      return;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mb-row' + (it.disabled ? ' disabled' : '');
    if (it.disabled) row.disabled = true;
    const check = document.createElement('span');
    check.className = 'mb-check';
    check.textContent = it.check ? '✓' : '';
    const lab = document.createElement('span');
    lab.className = 'mb-label';
    lab.textContent = (typeof it.label === 'function') ? it.label() : it.label;
    row.appendChild(check);
    row.appendChild(lab);
    // R67：可自定义项显示生效快捷键（用户重定义后菜单实时跟随），静态项原样
    if (it.accel) { const ac = document.createElement('span'); ac.className = 'mb-accel'; ac.textContent = it.accelId ? (scLive[it.accelId] || it.accel) : it.accel; row.appendChild(ac); }
    if (it.sub) { const sm = document.createElement('span'); sm.className = 'mb-sub-mark'; sm.textContent = '❯'; row.appendChild(sm); }
    if (it.title) row.title = it.title;
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('mouseenter', () => {
      // 移到同级其他行时，即时关闭不在当前路径上的子子菜单（不等待延迟）
      mbPruneSubs(row.closest('.mb-fly'), row);
      if (it.disabled) return; // 禁用项不高亮、不展开子菜单
      row.classList.add('kb-focus');
      if (it.sub) mbOpenSub(row, it.sub);
    });
    row.addEventListener('mouseleave', () => {
      // 本行挂着的子菜单仍打开时保持「选中」高亮（鼠标已进入子子菜单）
      if (!mbSubStack.some((e) => e.row === row)) row.classList.remove('kb-focus');
    });
    row.addEventListener('click', () => {
      if (it.disabled || it.sub) return;
      mbCloseAll();
      if (it.act) it.act();
    });
    fly.appendChild(row);
  });
}

// 从栈顶开始，关闭所有「不在当前行路径上」的子菜单：
// 既不是当前所在 fly 的祖先、锚点也不是当前行（即兄弟分支的残留），立即移除
function mbPruneSubs(parentFly, row) {
  while (mbSubStack.length) {
    const top = mbSubStack[mbSubStack.length - 1];
    if (mbFlyInside(top.fly, parentFly) || top.row === row) break;
    clearTimeout(top.fly._timer);
    top.fly.remove();
    top.row.classList.remove('kb-focus');
    mbSubStack.pop();
  }
}

function mbOpenSub(row, items) {
  mbCancelClose();
  const parentFly = row.closest('.mb-fly');
  // 同级路径上已打开的子菜单（鼠标从子子菜单移回本行）：直接复用，避免闪烁
  const cur = mbSubStack[mbSubStack.length - 1];
  if (cur && cur.row === row) { clearTimeout(cur.fly._timer); return; }
  const fly = document.createElement('div');
  fly.className = 'mb-fly mb-sub';
  fly._mbParent = parentFly;
  buildMenuItems(fly, items);
  document.body.appendChild(fly);
  const pr = parentFly.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  let left = pr.right + 2;
  if (left + fly.offsetWidth > window.innerWidth - 8) left = Math.max(8, pr.left - fly.offsetWidth - 2);
  let top = rr.top - 4;
  if (top + fly.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - fly.offsetHeight - 8);
  fly.style.left = left + 'px';
  fly.style.top = top + 'px';
  fly._timer = null;
  fly.addEventListener('mouseenter', () => { mbCancelSubTimers(); mbCancelClose(); });
  fly.addEventListener('mouseleave', () => {
    clearTimeout(fly._timer);
    fly._timer = setTimeout(() => mbRemoveSubFly(fly), 120);
  });
  mbSubStack.push({ fly, row, parentFly });
  row.classList.add('kb-focus'); // 子子菜单打开期间，父行保持选中状态
}

// 移除指定子菜单面板及其所有更深层子菜单
function mbRemoveSubFly(fly) {
  const i = mbSubStack.findIndex((e) => e.fly === fly);
  if (i < 0) return; // 已被上层处理
  while (mbSubStack.length > i) {
    const e = mbSubStack.pop();
    clearTimeout(e.fly._timer);
    e.fly.remove();
    e.row.classList.remove('kb-focus');
  }
}

function mbScheduleClose() {
  mbCancelClose();
  mbCloseTimer = setTimeout(() => mbCloseAll(), 140);
}
function mbCancelClose() { if (mbCloseTimer) { clearTimeout(mbCloseTimer); mbCloseTimer = null; } }
// 取消所有打开子菜单面板各自的延迟移除计时器。
// 必须清整条链路：子面板 mouseenter 若只清自己的计时器，父级子菜单的 120ms 移除
// 计时器仍在跑——鼠标从「设置」子菜单移入「正文字体（整篇）」更深层子菜单后，
// 整条菜单会在 120ms 后被父级计时器误删（用户反馈 R53-5）
function mbCancelSubTimers() {
  mbSubStack.forEach((e) => { if (e.fly._timer) { clearTimeout(e.fly._timer); e.fly._timer = null; } });
}
function mbCloseAll() {
  mbCancelClose();
  mbClearSubs();
  els('.mb-fly').forEach((f) => f.remove());
  els('#menubar .mb-item.open').forEach((b) => b.classList.remove('open'));
  els('.mb-row.kb-focus').forEach((r) => r.classList.remove('kb-focus'));
  mbOpenId = null;
  mbActivated = false; // 全部关闭后回到「需点击激活」状态
  // 菜单栏随文档状态显隐：有文档显示，欢迎页隐藏
  syncMenuBarVis();
}

function mbCurrentRows() {
  const top = mbSubStack.length ? mbSubStack[mbSubStack.length - 1].fly : null;
  const fly = top || (mbOpenId ? el('.mb-fly[data-menu="' + mbOpenId + '"]') : null);
  return fly ? Array.from(fly.querySelectorAll('.mb-row:not(:disabled)')) : [];
}

function mbNavigate(key) {
  const rows = mbCurrentRows();
  const idx = rows.findIndex((r) => r.classList.contains('kb-focus'));
  const clearF = () => els('.mb-row.kb-focus').forEach((r) => r.classList.remove('kb-focus'));
  const focusAt = (list, i) => {
    if (!list.length) return;
    clearF();
    list[i].classList.add('kb-focus');
    list[i].scrollIntoView({ block: 'nearest' });
  };
  const switchTop = (dir) => {
    const ids = MENUS.map((m) => m.id);
    const i = ids.indexOf(mbOpenId);
    if (i < 0) return;
    mbOpenMenu(ids[(i + dir + ids.length) % ids.length]);
    const rows2 = mbCurrentRows();
    focusAt(rows2, 0);
  };
  switch (key) {
    case 'ArrowDown': focusAt(rows, idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)); break;
    case 'ArrowUp': focusAt(rows, idx < 0 ? rows.length - 1 : Math.max(0, idx - 1)); break;
    case 'ArrowRight': {
      const row = rows[idx];
      if (row && row.querySelector('.mb-sub-mark')) row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      else if (mbOpenId && !mbSubStack.length) switchTop(1);
      break;
    }
    case 'ArrowLeft': {
      const top = mbSubStack[mbSubStack.length - 1];
      if (top) {
        const parentRow = top.row;
        mbRemoveSubFly(top.fly);
        clearF();
        if (parentRow) parentRow.classList.add('kb-focus');
      } else if (mbOpenId) switchTop(-1);
      break;
    }
    case 'Enter': {
      const row = rows[idx];
      if (!row) break;
      if (row.querySelector('.mb-sub-mark')) row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      else { mbCloseAll(); row.click(); }
      break;
    }
  }
}

// 全局键盘：所有加速器 + 菜单键盘导航（原生菜单已移除，这里统一接管）
function onGlobalKeys(e) {
  const k = e.key;
  const kl = k.toLowerCase();
  const mod = e.ctrlKey && !e.metaKey;
  // R70：用户自定义的 Alt 组合优先于菜单加速键（菜单加速键 Alt+字母 在冲突检测中保留、
  // 无法被绑定，这里只会命中真正的自定义项；未绑定的 Alt 组合继续走下方菜单逻辑）
  if (e.altKey) {
    const cAlt = scComboFromEvent(e);
    if (cAlt) {
      const idAlt = scMap.get(cAlt);
      if (idAlt) {
        const dAlt = SC_BY_ID[idAlt];
        const okAlt = !(dAlt && dAlt.when) || dAlt.when();
        const inFieldAlt = e.target && e.target.closest && e.target.closest('input, select');
        if (okAlt && !inFieldAlt) { e.preventDefault(); runShortcut(idAlt); return; }
        if (okAlt && inFieldAlt && idAlt === 'save') { e.preventDefault(); save(false); return; }
        return;
      }
    }
  }
  // Alt + 字母：打开对应顶级菜单
  if (e.altKey && !e.ctrlKey && !e.shiftKey && k.length === 1 && /^[a-zA-Z]$/.test(k)) {
    const m = MENUS.find((x) => x.key.toLowerCase() === kl);
    if (m) { e.preventDefault(); if (mbOpenId === m.id) mbCloseAll(); else { mbActivated = true; mbOpenMenu(m.id); } }
    return;
  }
  // 菜单打开时接管方向键/Enter/Escape
  if (mbOpenId && (k === 'ArrowDown' || k === 'ArrowUp' || k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Enter' || k === 'Escape')) {
    e.preventDefault();
    if (k === 'Escape') {
      const top = mbSubStack[mbSubStack.length - 1];
      if (top) mbRemoveSubFly(top.fly); else mbCloseAll();
    }
    else mbNavigate(k);
    return;
  }
  // 菜单栏显隐随文档状态：无文档（欢迎页）时 Escape 回到隐藏；有文档时保持显示
  if (k === 'Escape' && !mbOpenId) {
    syncMenuBarVis();
  }
  // 输入框/下拉内：只响应保存（用户自定义后跟随），避免干扰输入
  const inField = e.target && e.target.closest && e.target.closest('input, select');
  if (e.altKey) return;
  // R67：表驱动快捷键分发——组合 → id（scMap 由 scLive 重建），动作见 runShortcut；
  // 生效值 = 默认 + 用户自定义（设置中修改，实时冲突检测）
  const combo = scComboFromEvent(e);
  if (combo) {
    const id = scMap.get(combo);
    if (id) {
      const d = SC_BY_ID[id];
      const condOk = !(d && d.when) || d.when(); // 条件不满足（如源码模式下的撤销）→ 不接管，留给原生行为
      if (condOk && !inField) { e.preventDefault(); runShortcut(id); return; }
      if (condOk && inField && id === 'save') { e.preventDefault(); save(false); return; }
      return;
    }
  }
  if (inField) return;
  if (k === 'Escape') {
    toggleFind(false);
    els('#fbar .fbar-menu').forEach((m) => m.classList.add('hidden'));
    closeTablePicker();
    el('#ctxmenu').classList.add('hidden');
    closeSettingsModal();
    el('#modal-shortcuts').classList.add('hidden');
    closeFontPanel();
    const mp = document.getElementById('mini-pop');
    if (mp) mp.remove();
  }
}

// ---------------------------------------------------------------- 菜单分发
function handleMenu(action, args) {
  // R90：阅读模式（超大文件只读快速视图）按白名单放行命令，其余拦截并提示
  if (isReader()) {
    const OK = { 'new-file': 1, 'open-file-dialog': 1, 'open-folder-dialog': 1, 'find': 1, 'toggle-sidebar': 1, 'toggle-lines': 1, 'set-theme': 1, 'set-content-width': 1, 'set-content-center': 1, 'toggle-wrap': 1, 'set-line-height': 1, 'set-content-font': 1, 'zoom': 1, 'open-settings': 1, 'show-shortcuts': 1, 'reveal-in-folder': 1, 'copy-path': 1, 'open-link-external': 1 };
    if (!OK[action]) {
      toast(/^(export-|print-doc)/.test(action) ? t('toast.readerNoExport') : t('toast.readerNoEdit'));
      return;
    }
  }
  switch (action) {
    case 'new-file': newFile(); break;
    case 'open-file-dialog': ms.invoke('dialog:open-file', {}).then(r => { if (r && r.path) openPath(r.path); }); break;
    case 'open-folder-dialog': openFolderDialog(); break;
    case 'save': save(false); break;
    case 'save-as': saveAs(false); break;
    case 'export-pdf': exportPdf(); break;
    case 'export-html': exportHtml(); break;
    case 'export-doc': exportDoc(); break;
    case 'export-image': exportImage(); break; // dist54：补漏（阅读模式白名单已在上方拦截）
    case 'print-doc': printDoc(); break;
    case 'undo': clickToolbar('undo'); break;
    case 'redo': clickToolbar('redo'); break;
    case 'heading': setHeading(args[0]); break;
    case 'toolbar':
      // 表格走行列选择器；加粗/斜体/删除线走 MD 层（原生 toolbar 在 IR 下插裸 **，见 applyEmphasis 注释）；其余直接点隐藏工具栏
      if (args[0] === 'table' && !state.sourceMode) openTablePicker(null);
      else if (args[0] === 'bold' || args[0] === 'italic' || args[0] === 'strike') applyEmphasis(args[0] === 'bold' ? 'strong' : (args[0] === 'italic' ? 'em' : 's'));
      else clickToolbar(args[0]);
      break;
    case 'find': toggleFind(true); break;
    case 'insert-image-dialog': insertImageDialog(); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'toggle-source': toggleSource(); break;
    case 'toggle-lines': toggleLines(); break;
    case 'set-theme':
      setTheme(args[0]);
      persistSettings({ theme: args[0] });
      break;
    case 'set-content-theme':
      state.settings.contentTheme = args[0];
      if (!applyEditorTheme()) recreateEditor(getCurrentContent());
      persistSettings({ contentTheme: args[0] });
      break;
    case 'set-content-width':
      state.settings.contentWidth = args[0];
      applyContentLayout();
      persistSettings({ contentWidth: args[0] });
      break;
    case 'set-content-center':
      state.settings.contentCenter = !!args[0];
      applyContentLayout();
      persistSettings({ contentCenter: !!args[0] });
      break;
    case 'toggle-wrap':
      state.settings.wrap = !!args[0];
      applyWrap();
      persistSettings({ wrap: !!args[0] });
      break;
    case 'set-line-height':
      state.settings.lineHeight = Math.min(3, Math.max(1, Number(args[0]) || 1.75));
      applyLineHeight();
      persistSettings({ lineHeight: state.settings.lineHeight });
      break;
    case 'set-content-font':
      state.settings.contentFont = args[0] || '';
      applyFont();
      // 字体变化可能改变文字度量，重排行号位置
      refreshLinesSoon();
      layoutLineGutter();
      persistSettings({ contentFont: args[0] || '' });
      break;
    case 'zoom': {
      // 容错：args 必须是数组（主进程 send 传数组）；非法值一律按重置处理，
      // 避免 NaN 被 JSON 序列化成 null 污染 settings.json
      const step = Number(args && args[0]) || 0;
      const cur = state.settings.fontSize || 16;
      const next = step === 0 ? 16 : Math.min(32, Math.max(12, cur + step * 2));
      state.settings.fontSize = next;
      applyFontSize();
      refreshLinesSoon();
      persistFontSizeSoon();
      break;
    }
    case 'set-typewriter':
      state.settings.typewriter = !!args[0];
      recreateEditor(getCurrentContent());
      persistSettings({ typewriter: state.settings.typewriter });
      break;
    case 'set-focus':
      state.settings.focusMode = !!args[0];
      // R75-9：专注模式用 CSS 类实现，切换无需重建编辑器（免大文件整篇重解析卡顿）
      applyFocusMode();
      persistSettings({ focusMode: state.settings.focusMode });
      break;
    case 'open-settings': openSettings(); break;
    case 'show-shortcuts': openShortcutsModal(); break;
    case 'reveal-in-folder': if (state.docPath) ms.invoke('shell:show-item', { path: state.docPath }); break;
    case 'copy-path': if (state.docPath) ms.invoke('clipboard:write', { text: state.docPath }); toast(t('file.pathCopied')); break;
    case 'open-link-external':
      if (state.lastLink && /^https?:\/\//i.test(state.lastLink)) ms.invoke('shell:open-external', { url: state.lastLink });
      else toast(t('toast.clickLinkFirst'));
      break;
  }
}

// ---------------------------------------------------------------- 拖拽 & 粘贴
// R72：拖入本地 md 文件不再直接打开，而是先咨询——
//   ① 复制到当前文件夹并打开（文件已在当前文件夹内时 = 直接在当前窗口打开）
//   ② 在新窗口打开（新窗口目录 = 文件所在目录）
//   ③ 取消
function bindDragPaste() {
  let dragDepth = 0;
  let lastFileDrag = 0; // R77：最近一次文件拖拽活动时间（供看门狗判断拖拽是否已结束）
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
  // R75-6：本拖拽是否携带 MarkStudio 标签（用于把标题栏/标签栏临时改成可放置区）
  const hasTabDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('application/x-markstudio-tab') !== -1;
  const setOverlay = (on) => { const o = el('#drop-overlay'); if (o) o.classList.toggle('hidden', !on); };
  // R77：看门狗——活的文件拖拽会持续派发 dragover；一旦停止（松手 drop / Esc 取消 / 拖出
  // 窗口）而本窗口的 drop/dragleave 又没被可靠触发（拖到正文区时 Vditor 会先截住事件，
  // 事件不再冒泡到下方文档级 handler），dragDepth 会卡住、遮罩与「松开以打开」提示永不
  // 消失。这里兜底：拖拽活动停止 500ms 后强制清除，保证遮罩绝不会卡死。
  setInterval(() => {
    if (dragDepth > 0 && (Date.now() - lastFileDrag) > 500) { dragDepth = 0; setOverlay(false); }
  }, 250);
  document.addEventListener('dragenter', (e) => {
    if (hasTabDrag(e)) { document.body.classList.add('ms-tab-dragging'); e.preventDefault(); }
    if (!hasFiles(e)) return;
    e.preventDefault();
    lastFileDrag = Date.now();
    dragDepth++;
    setOverlay(true);
  });
  document.addEventListener('dragleave', (e) => {
    // 拖出本窗口（relatedTarget 为 null）→ 撤销标题栏「可放置」态
    if (hasTabDrag(e) && (!e.relatedTarget)) document.body.classList.remove('ms-tab-dragging');
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setOverlay(false);
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    // R77：持续刷新活动时间并自愈——拖拽进行中每次 dragover 都确保遮罩可见；即便看门狗
    // 在拖拽中途误清一次，下一次 dragover 也会立刻恢复，不会闪烁消失。
    if (hasFiles(e)) { lastFileDrag = Date.now(); setOverlay(true); }
  });
  // R77：在 Vditor「之前」拦截 Markdown/文本文件拖放。Vditor 在自己的编辑器元素上注册了
  // drop 处理（dropEvent→paste），会把 .md 当"粘贴内容"吃掉、且事件不再冒泡到下方文档级
  // drop → 拖到正文区时文件打不开、遮罩也清不掉。这里用捕获阶段（先于 Vditor 的气泡阶段）
  // 处理 md/txt 并 stopPropagation，让 .md 始终走"询问打开方式"，与拖到侧栏/状态栏一致。
  // 纯图片拖拽不在此处理（return 交给原流程：Vditor 光标插入 + 冒泡兜底，保持原行为）。
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return; // 标签拖拽等 → 交给下方冒泡 handler
    const textFiles = [];
    for (const file of e.dataTransfer.files) {
      const p = ms.getDroppedFilePath(file);
      if (p && /\.(md|markdown|txt)$/i.test(p)) textFiles.push(p);
    }
    if (!textFiles.length) return; // 无 md/txt（纯图片等）→ 保持原行为
    e.preventDefault();
    e.stopPropagation(); // 阻止 Vditor 的 paste() 也处理这次 .md 拖放
    dragDepth = 0;
    setOverlay(false);
    document.body.classList.remove('ms-tab-dragging');
    const choice = await askDropFiles(textFiles);
    await actDropFiles(choice, textFiles);
  }, { capture: true });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    setOverlay(false);
    document.body.classList.remove('ms-tab-dragging');
    // R73/R75：从另一个 MarkStudio 窗口拖入的标签（无真实文件，仅自定义类型）→
    // 本窗口以标签打开 + 通知源窗口移除，不走 R72 的文件咨询
    let movedPath = null, movedFrom = null, movedUnsaved = null;
    try {
      const raw = e.dataTransfer.getData('application/x-markstudio-tab');
      if (raw) {
        const m = JSON.parse(raw);
        if (m && m.path) { movedPath = m.path; movedFrom = m.win || null; }
        else if (m && m.content != null) { movedUnsaved = { id: m.id, name: m.name, content: m.content }; movedFrom = m.win || null; }
      }
    } catch (err) { }
    // 本窗口自己的标签（from===本窗口 id）不走跨窗分支——同窗口落点由标签栏 drop
    // 分支（重排）或下方文档区分支（取消）处理，重复处理会误删标签
    if (movedPath && movedFrom !== state.winId) {
      await openPath(movedPath);
      if (movedFrom) ms.invoke('win:tab-moved', { path: movedPath, from: movedFrom }).catch(() => { });
      return;
    }
    // R75-6：未保存标签从另一窗口拖入（含拖到标题栏）→ 以「内容」打开 + 通知源窗口移除
    if (movedUnsaved && movedFrom !== state.winId) {
      await openContentTab({ name: movedUnsaved.name, path: null, content: movedUnsaved.content });
      if (movedFrom) ms.invoke('win:remote-unsaved-moved', { tabId: movedUnsaved.id, from: movedFrom }).catch(() => { });
      return;
    }
    // R74：松手落在本窗口文档区（非标签栏）= 取消移动，标签原地不动
    if (outDrag) finishOutDrag();
    const textFiles = [];
    for (const file of e.dataTransfer.files) {
      const p = ms.getDroppedFilePath(file);
      if (p && /\.(md|markdown|txt)$/i.test(p)) textFiles.push(p);
      else if (file.type.startsWith('image/')) await saveImageAndInsert(file, file.name, false);
    }
    if (textFiles.length) {
      const choice = await askDropFiles(textFiles);
      await actDropFiles(choice, textFiles);
    }
  });
  document.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData.items || []);
    const imgItem = items.find(i => i.type.startsWith('image/'));
    if (imgItem) {
      e.preventDefault();
      const f = imgItem.getAsFile();
      if (f) await saveImageAndInsert(f, 'image.png', false);
    }
  });
}
// R72：拖入文本文件后的咨询弹窗。resolve 'copy' | 'newwin' | 'cancel'（Enter 默认 = 新窗口，无复制副作用）
function askDropFiles(paths) {
  const mask = el('#drop-modal');
  if (!mask) { // 兜底：DOM 异常时退回旧行为（直接打开）
    paths.forEach((p) => { openPath(p).catch(() => { }); });
    return Promise.resolve('cancel');
  }
  const names = paths.map((p) => baseName(p));
  const norm = (p) => p.replace(/\\/g, '/');
  const inFolder = (p) => !!state.folder && norm(p).indexOf(norm(state.folder).replace(/\/+$/, '') + '/') === 0;
  const copyBtn = el('#drop-copy');
  const outside = paths.filter((p) => !inFolder(p));
  el('#drop-title').textContent = paths.length === 1 ? t('drop.openOne', { name: names[0] }) : t('drop.openMany', { n: paths.length });
  if (!state.folder) {
    // 未打开文件夹 → 无「当前文件夹」可复制，只留新窗口选项
    copyBtn.classList.add('hidden');
    el('#drop-msg').textContent = paths.length === 1 ? paths[0] : names.join(t('list.joiner'));
  } else {
    copyBtn.classList.remove('hidden');
    copyBtn.textContent = outside.length ? t('drop.copy') : t('drop.openInCur');
    const head = t('drop.curFolder', { name: baseName(state.folder) });
    el('#drop-msg').textContent = paths.length === 1 ? head + t('sep.space') + paths[0] : head + t('sep.space') + names.join(t('list.joiner'));
  }
  mask.classList.remove('hidden');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      mask.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      resolve(r);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish('newwin'); }
    };
    document.addEventListener('keydown', onKey, true);
    copyBtn.onclick = () => finish('copy');
    el('#drop-newwin').onclick = () => finish('newwin');
    el('#drop-cancel').onclick = () => finish('cancel');
    setTimeout(() => { try { el('#drop-newwin').focus(); } catch (err) { } }, 30);
  });
}
// R72：咨询结果执行——copy=复制到当前文件夹并打开（同名不覆盖、直接开现有；已在目录内=直接打开）；
// newwin=新窗口打开（目录=首个文件所在目录，多文件一并打开）
async function actDropFiles(choice, paths) {
  if (!choice || choice === 'cancel') return;
  const norm = (p) => p.replace(/\\/g, '/');
  const inFolder = (p) => !!state.folder && norm(p).indexOf(norm(state.folder).replace(/\/+$/, '') + '/') === 0;
  if (choice === 'newwin') {
    const folder = paths[0].replace(/[\\/][^\\/]+$/, '');
    await ms.invoke('window:new', { path: paths[0], folder: folder || undefined, files: paths.length > 1 ? paths.slice(1) : undefined });
    return;
  }
  let opened = 0, copied = 0, kept = 0;
  for (const p of paths) {
    if (inFolder(p)) { await openPath(p); opened++; continue; }
    const target = state.folder.replace(/[\\/]+$/, '') + '/' + baseName(p);
    const r = await ms.invoke('fs:copy-file', { from: p, to: target });
    if (r && r.error) { toast(t('drop.copyFailed', { e: r.error })); continue; }
    if (r && r.exists) kept++; else copied++;
    await openPath(target);
    opened++;
  }
  if (opened) {
    toast(copied ? t('drop.copied', { n: copied, folder: baseName(state.folder) }) : (kept ? t('drop.dupeOpen') : t('drop.opened')));
    refreshTree();
  }
}

// ---------------------------------------------------------------- 冒烟测试
function setupSmoke() {
  if (state.smokeDone) return;
  state.smokeDone = true;
  setTimeout(async () => {
    try {
      const marker = 'MarkStudio-Smoke-Marker-' + Date.now();
      await ensureEditor();
      state.vditor.setValue(state.vditor.getValue() + '\n\n' + marker + '\n');
      await new Promise(r => setTimeout(r, 300));
      await save(true);
      await new Promise(r => setTimeout(r, 500));
      window.close();
    } catch (e) {
      // 失败也要退出，让 runner 检测到内容未变化
      window.close();
    }
  }, 2500);
}

// ---------------------------------------------------------------- 事件绑定 & 启动
function bindUi() {
  el('#btn-new').onclick = () => { newFile(); };
  el('#btn-open').onclick = () => handleMenu('open-file-dialog');
  el('#btn-open-folder').onclick = () => openFolderDialog();

  // 悬浮小工具条（列表/标题/更多 下拉菜单）
  const FBAR_ACTS = {
    'list': () => clickToolbar('list'),
    'ordered-list': () => clickToolbar('ordered-list'),
    'check': () => clickToolbar('check'),
    'bold': () => applyEmphasis('strong'),
    'italic': () => applyEmphasis('em'),
    'strike': () => applyEmphasis('s'),
    'inline-code': () => clickToolbar('inline-code'),
    'link': () => clickToolbar('link'),
    'quote': () => clickToolbar('quote'),
    'table': () => openTablePicker(el('#fbar [data-menu="more"]')),
    'code': () => clickToolbar('code'),
    'line': () => clickToolbar('line'),
    'image': () => insertImageDialog(),
    'save': () => save(false),
    'save-as': () => saveAs(false),
    'undo': () => clickToolbar('undo'),
    'redo': () => clickToolbar('redo'),
    'find': () => toggleFind(true),
    'source': () => toggleSource()
  };
  for (let i = 1; i <= 6; i++) FBAR_ACTS['h' + i] = ((lv) => () => setHeading(lv))(i);
  const closeFbarMenus = () => els('#fbar .fbar-menu').forEach(m => m.classList.add('hidden'));
  els('#fbar [data-menu]').forEach(b => b.addEventListener('click', (e) => {
    e.preventDefault();
    const m = el('#fbar-menu-' + b.dataset.menu);
    if (!m) return;
    const wasOpen = !m.classList.contains('hidden');
    closeFbarMenus();
    if (!wasOpen) m.classList.remove('hidden');
  }));
  els('#fbar .fbar-menu [data-fact]').forEach(b => b.addEventListener('click', () => {
    closeFbarMenus();
    const f = FBAR_ACTS[b.dataset.fact];
    if (f) f();
  }));
  els('#fbar .fbar-btn[data-fact]').forEach(b => b.addEventListener('click', () => {
    const f = FBAR_ACTS[b.dataset.fact];
    if (f) f();
  }));
  // 悬浮栏「字体 / 字号 / 颜色」下拉：动态填充 + 独立 data-fb 绑定（避免与 FBAR_ACTS 通用绑定冲突）
  (function buildFbarTextMenus() {
    const fontMenu = el('#fbar-menu-font');
    const sizeMenu = el('#fbar-menu-fontsize');
    const colorMenu = el('#fbar-menu-color');
    if (fontMenu) {
      const mk = (fb, font, label, extraCls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.fb = fb;
        if (font) b.dataset.font = font;
        b.textContent = label;
        if (extraCls) b.className = extraCls;
        return b;
      };
      fontMenu.appendChild(mk('font-reset', null, t('fmt.fontFollow')));
      TEXT_FONTS_COMMON.forEach((f) => fontMenu.appendChild(mk('font', f, f)));
      const sep = document.createElement('div'); sep.className = 'fbar-menu-sep'; fontMenu.appendChild(sep);
      fontMenu.appendChild(mk('font-sys', null, t('fmt.fontSysMore')));
    }
    if (sizeMenu) {
      const grid = document.createElement('div');
      grid.className = 'fbar-sizes';
      TEXT_SIZES.forEach((n) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.fb = 'size';
        b.dataset.size = String(n);
        b.textContent = n;
        grid.appendChild(b);
      });
      sizeMenu.appendChild(grid);
      const sep = document.createElement('div'); sep.className = 'fbar-menu-sep'; sizeMenu.appendChild(sep);
      const custom = document.createElement('button');
      custom.type = 'button'; custom.dataset.fb = 'size-custom'; custom.textContent = t('fmt.fontSizeCustom');
      sizeMenu.appendChild(custom);
    }
    if (colorMenu) {
      const grid = document.createElement('div');
      grid.className = 'fbar-swatches';
      TEXT_COLORS.forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sw' + (/^[#][0-9a-f]{2}/i.test(c) && c.slice(1).match(/([0-9a-f]{2})/gi).every((x) => parseInt(x, 16) > 200) ? ' sw-light' : '');
        b.style.background = c;
        b.title = c;
        b.dataset.fb = 'color';
        b.dataset.color = c;
        grid.appendChild(b);
      });
      colorMenu.appendChild(grid);
      const sep = document.createElement('div'); sep.className = 'fbar-menu-sep'; colorMenu.appendChild(sep);
      const custom = document.createElement('button');
      custom.type = 'button'; custom.dataset.fb = 'color-custom'; custom.textContent = t('fmt.colorCustom');
      colorMenu.appendChild(custom);
      const reset = document.createElement('button');
      reset.type = 'button'; reset.dataset.fb = 'color-reset'; reset.textContent = t('fmt.colorReset');
      colorMenu.appendChild(reset);
    }
    els('#fbar [data-fb]').forEach((b) => b.addEventListener('click', () => {
      closeFbarMenus();
      if (!hasTextSelection()) { toast(t('toast.selTextFirst')); return; }
      const fb = b.dataset.fb;
      if (fb === 'font-reset') applyTextStyle({ fontFamily: null });
      else if (fb === 'font') applyTextStyle({ fontFamily: b.dataset.font });
      else if (fb === 'font-sys') openFontPanel();
      else if (fb === 'size') applyTextStyle({ fontSize: b.dataset.size + 'px' });
      else if (fb === 'size-custom') openCustomSizePop();
      else if (fb === 'color') applyTextStyle({ color: b.dataset.color });
      else if (fb === 'color-custom') openCustomColorPop();
      else if (fb === 'color-reset') applyTextStyle({ color: null });
    }));
  })();
  // 悬浮栏：可按住上下拖动（默认底部居中），位置持久化到设置
  (function bindFbarDrag() {
    const bar = el('#fbar');
    if (!bar) return;
    let drag = null;
    const applyY = (bottom) => { bar.style.bottom = bottom + 'px'; };
    const savedY = state.settings && state.settings.fbarY;
    if (typeof savedY === 'number') applyY(Math.max(8, savedY));
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // 点按钮只阻止焦点漂移，不进入拖拽
      if (e.target.closest && e.target.closest('.fbar-btn')) { e.preventDefault(); return; }
      drag = { y: e.clientY, bottom: parseFloat(bar.style.bottom) || 18, moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dy = drag.y - e.clientY;
      if (!drag.moved && Math.abs(dy) < 5) return;
      drag.moved = true;
      bar.classList.add('dragging');
      const max = el('#main-col').clientHeight - bar.offsetHeight - 8;
      applyY(Math.max(8, Math.min(max, drag.bottom + dy)));
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      if (drag.moved) {
        bar.classList.remove('dragging');
        const y = Math.round(parseFloat(bar.style.bottom) || 18);
        state.settings.fbarY = y;
        ms.invoke('app:set-settings', { partial: { fbarY: y } });
        // 拖拽结束后的 click 会误触发编辑器行为，吞掉一次
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        bar.addEventListener('click', swallow, { capture: true, once: true });
      }
      drag = null;
    });
  })();
  // Ctrl + 滚轮：放大/缩小正文字体（累积 deltaY 到阈值再触发一级缩放，手感与 Ctrl+± 菜单一致）
  let wheelZoomAcc = 0;
  el('#main-col').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    wheelZoomAcc += -e.deltaY;
    if (wheelZoomAcc >= 40) { handleMenu('zoom', [1]); wheelZoomAcc = 0; }
    else if (wheelZoomAcc <= -40) { handleMenu('zoom', [-1]); wheelZoomAcc = 0; }
  }, { passive: false });
  // 正文 ↔ 悬浮栏联动：光标移动/选中变化时刷新工具按钮高亮 + 状态栏行:列
  document.addEventListener('selectionchange', () => { refreshToolbarState(); updateCursorPos(); updateFbarTextStyle(); updateFocusHighlight(); });
  // 表格选择器/操作面板
  els('#tp-ops [data-top]').forEach(b => b.addEventListener('click', () => opTable(b.dataset.top)));
  // 表格交互（R45）：单元格点选、行列宽拖拽、左上角悬浮工具条
  bindTableInteractions();
  initTabCard();
  document.addEventListener('mousedown', (e) => {
    const pk = el('#table-picker');
    if (pk && !pk.classList.contains('hidden') && !pk.contains(e.target)) closeTablePicker();
  });
  // 行号栏：滚动容器变化/窗口缩放时同步
  window.addEventListener('scroll', () => syncLineGutter(), true);
  window.addEventListener('resize', () => { refreshLinesSoon(); layoutLineGutter(); });
  document.addEventListener('mousedown', (e) => {
    const bar = el('#fbar');
    if (bar && !bar.contains(e.target)) closeFbarMenus();
  });
  el('#btn-clear-recent').onclick = async () => {
    await ms.invoke('app:clear-recent');
    if (state.tabs.length) { state.recent = []; toast(t('toast.recentCleared')); }
    else showWelcome();
  };

  els('#sidebar-tabs .tab').forEach(t => t.onclick = () => showSidebar(t.dataset.tab));

  // 查找栏
  el('#find-close').onclick = () => toggleFind(false);
  el('#find-next').onclick = () => findNext(false);
  el('#find-prev').onclick = () => findNext(true);
  el('#replace-one').onclick = replaceOne;
  el('#replace-all').onclick = replaceAll;
  el('#find-input').addEventListener('input', () => { state.findState.idx = -1; state.findState.total = 0; updateFindCount(); });
  el('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey); } });
  el('#replace-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } });
  // R75-8c：切换「区分大小写 / 全字匹配」后立即按当前关键词重查
  el('#find-case').addEventListener('change', () => { if (el('#find-input').value) findNext(false); });
  el('#find-word').addEventListener('change', () => { if (el('#find-input').value) findNext(false); });
  // R75-8b：拖动标题栏 grip 移动查找面板（关闭按钮除外），松手记忆位置
  (function () {
    const fb = el('#findbar');
    const grip = el('#findbar-grip');
    if (!fb || !grip) return;
    try {
      const saved = JSON.parse(localStorage.getItem('ms-findbar-pos') || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) applyFindbarPos(saved.x, saved.y);
    } catch (e) { }
    grip.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.findbar-close')) return;
      e.preventDefault();
      const rect = fb.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const move = (ev) => {
        const x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, ev.clientX - offX));
        const y = Math.max(4, Math.min(window.innerHeight - 48, ev.clientY - offY));
        applyFindbarPos(x, y);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        try {
          const r = fb.getBoundingClientRect();
          localStorage.setItem('ms-findbar-pos', JSON.stringify({ x: r.left, y: r.top }));
        } catch (err) { }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  })();

  // 设置
  el('#settings-ok').onclick = saveSettings;
  el('#settings-cancel').onclick = closeSettingsModal;
  // dist62 修复：界面语言改为「保存才生效」——下拉选中只在表单内暂存，不立即切换、不落盘；
  // 点「保存」由 saveSettings 统一落盘 + 热切换（setLang + app:set-language + 重建编辑器），
  // 点「取消」/关闭由 closeSettingsModal 把下拉还原到当前生效语言
  // R78-1：移除各分区的「恢复默认」按钮，只保留底部统一的「恢复默认」（重置全部）
  el('#settings-reset-all').onclick = () => doSettingsReset('all', t('toast.allDefaultsRestored'));
  // R68：设置 tab 切换（事件委托）
  el('#set-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.set-tab');
    if (b) setTab(b.dataset.pane);
  });
  el('#shortcuts-close').onclick = () => el('#modal-shortcuts').classList.add('hidden');

  // R39：Vditor 的 input 回调被延迟到停顿后（整篇 md 转换耗时），
  // 脏标记必须在 DOM input 事件上立即置位，否则「输入后立刻关闭/切标签」会漏掉未保存提示
  el('#editor').addEventListener('input', () => setDirty(true), true);

  // 源代码模式
  el('#source').addEventListener('input', () => {
    sourceEdited = true;
    const t = activeTab();
    if (t) t.content = el('#source').value;
    setDirty(true);
    scheduleStats();
    refreshLinesSoon();
    updateCursorPos();
  });
  el('#source').addEventListener('keyup', () => updateCursorPos());
  el('#source').addEventListener('click', () => updateCursorPos());
  el('#source').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      el('#source').setRangeText('    ', el('#source').selectionStart, el('#source').selectionEnd, 'end');
      el('#source').dispatchEvent(new Event('input'));
    }
  });

  // 全局快捷键 + 菜单键盘导航（自绘菜单栏，原生菜单已移除）
  document.addEventListener('keydown', onGlobalKeys);
  // R67：快捷键录入监听（捕获阶段先于 onGlobalKeys；录入中逐键校验，Esc 取消）
  document.addEventListener('keydown', scOnCaptureKey, true);
  // 点空白处关闭弹出面板（字体面板/自定义弹窗/子菜单）
  document.addEventListener('mousedown', (e) => {
    const fp = el('#fontpanel');
    if (fp && !fp.classList.contains('hidden') && !fp.contains(e.target) && !e.target.closest('.mb-row') && !e.target.closest('.mb-cswatch')) closeFontPanel();
    const mp = document.getElementById('mini-pop');
    if (mp && !mp.contains(e.target) && !e.target.closest('.mb-row')) mp.remove();
  });

  // 系统字体面板
  el('#fp-search').addEventListener('input', () => renderFontList(el('#fp-search').value));
  el('#fp-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFontPanel(); });
  el('#fp-close').addEventListener('click', closeFontPanel);

  // 行距下拉 ↔ 自定义数值 联动
  const lhSel = el('#set-lh');
  const lhNum = el('#set-lh-num');
  lhSel.addEventListener('change', () => { if (lhSel.value !== 'custom') lhNum.value = lhSel.value; });
  lhNum.addEventListener('input', () => {
    const v = parseFloat(lhNum.value);
    if (Number.isFinite(v)) lhSel.value = LINE_HEIGHTS.some(x => Math.abs(x.v - v) < 0.001) ? String(v) : 'custom';
  });

  bindDragPaste();
  initOutlineSelectionSync(); // R78-2：正文选中/光标 → 大纲章节高亮联动
  initSidebarResizer();
  initContextMenu();
  initGutterMenu();
  initCodeLangPicker();
  initTabDrag();
  initTitlebar();
  initColorPicker();
  bindImageInteractions(); // R75-4a：图片选中 + 工具条（裁剪/缩放/删除）
  bindParaBar(); // R80-3：段落/标题悬浮栏（在上方/下方插入段落）
  bindCropModal();

  ms.on('menu', (data) => handleMenu(data.action, data.args || []));
  ms.on('app:open-path', (p) => openPath(p));
  // R73：本窗口 id（标签跨窗口拖拽时作为源窗口 id 写入拖拽数据）。
  // 主动查询为主（事件通道有竞态：主进程 did-finish-load 时 bindUi 可能尚未注册监听）
  ms.invoke('win:self-id').then((id) => { if (id) state.winId = id; }).catch(() => { });
  ms.on('win:id', (id) => { state.winId = id; });
  // R73/R74：标签被拖到另一个窗口打开 → 本窗口移除该标签（有未保存改动时保留，
  // 防丢数据）；同时置 consumed（源窗口 dragend 的「开新窗口」计时器见之即止），
  // 若竞态下已开出冗余新窗口（outDragPreviewWin）则一并关掉
  ms.on('win:remote-tab-moved', (data) => {
    const p = data && data.path;
    if (outDrag && p && outDrag.path && outDrag.path.replace(/\\/g, '/') === p.replace(/\\/g, '/')) {
      outDrag.consumed = true;
      if (outDrag.timer) { clearTimeout(outDrag.timer); outDrag.timer = 0; }
    }
    if (p) {
      const norm = p.replace(/\\/g, '/');
      const tab = state.tabs.find(t => t.path && t.path.replace(/\\/g, '/') === norm);
      // R83-P4：改用 removeTabById（跨窗移除专用）——最后一个标签被拖走时关闭本窗口（而非回欢迎页）
      if (tab && !tab.dirty) removeTabById(tab.id);
    }
    if (outDragPreviewWin) {
      const pv = outDragPreviewWin;
      outDragPreviewWin = 0;
      ms.invoke('win:close-by-id', { id: pv }).catch(() => { });
    }
  });
  // R75-6：未保存标签被拖到另一窗口打开 → 本窗口移除该标签（内容已转移），
  // 置 consumed 取消「开新窗口」计时器，关掉竞态下的冗余新窗口
  ms.on('win:remote-unsaved-moved', (data) => {
    const tid = data && data.tabId;
    if (outDrag && tid && outDrag.id === tid) {
      outDrag.consumed = true;
      if (outDrag.timer) { clearTimeout(outDrag.timer); outDrag.timer = 0; }
    }
    if (tid) removeTabById(tid);
    if (outDragPreviewWin) {
      const pv = outDragPreviewWin;
      outDragPreviewWin = 0;
      ms.invoke('win:close-by-id', { id: pv }).catch(() => { });
    }
  });
  // 托盘「新建文件」（R53-8）：应用已在运行、窗口存在 → 直接新建文档标签
  ms.on('tray:new-file', () => { newFile(); });
  // 窗口关闭时的未保存处理（R50）：主进程把决定权交给应用内毛玻璃弹窗，
  // 选择「保存」后执行下面的保存循环
  ms.on('app:close-intent', async () => {
    // dist66 修复：原来 `const t = state.tabs.find(...)` 把 i18n 的 window.t 遮蔽成「标签对象」，
    // 随后 t('unsaved.askQuit') 把标签当函数调用 → TypeError（async 里变未捕获 rejection），
    // 未保存弹窗永远弹不出 → 有未保存改动时点 ×/退出「毫无反应」。改名 tab + 显式 window.t。
    const tab = state.tabs.find(x => x.id === state.activeTab) || state.tabs[0];
    const name = (tab && tab.name) || window.t('name.untitled');
    const ans = await confirmUnsaved(name, window.t('unsaved.askQuit'));
    if (ans === 'cancel') { await ms.invoke('app:close-done', { ok: false }); return; }
    if (ans === 'discard') { await ms.invoke('app:close-done', { ok: true }); return; }
    handleCloseRequest();
  });
  // 关闭确认（R62）：主进程 ask 路径改为应用内毛玻璃弹窗，选择结果回传
  ms.on('app:close-ask', () => {
    confirmClose().then((a) => {
      ms.invoke('app:close-ask-done', { action: a }).catch(() => { });
    });
  });
  async function handleCloseRequest() {
    // 多标签：逐个保存所有未保存的标签。活动标签走正常 save（可弹对话框），
    // 非活动标签直接写盘；未命名单元格弹“另存为”由用户决定
    let ok = true;
    for (const t of state.tabs) {
      if (!t.dirty) continue;
      if (t.id === state.activeTab) {
        if (!(await save(true))) ok = false;
      } else if (t.path) {
        try {
          const r = await ms.invoke('fs:write-file', { path: t.path, content: t.content, eol: t.eol, hadBom: t.hadBom });
          if (r && r.error) ok = false;
        } catch (e) { ok = false; }
      } else {
        const p = await ms.invoke('dialog:save-file', { defaultPath: mdSuggestName(t.name) });
        if (!p) continue; // 用户放弃保存，按“不保存”处理
        try {
          const r = await ms.invoke('fs:write-file', { path: p, content: t.content, eol: '\n', hadBom: false });
          if (r && r.error) ok = false;
        } catch (e) { ok = false; }
      }
    }
    await ms.invoke('app:close-done', { ok });
  }
  ms.on('fs:changed', async (data) => {
    if (!data || !data.path) return;
    const norm = String(data.path).replace(/\\/g, '/');
    const tab = state.tabs.find(t => t.path && t.path.replace(/\\/g, '/') === norm);
    if (!tab) return;
    if (tab.id === state.activeTab) {
      if (!tab.dirty) {
        await reloadCurrent();
        toast(t('toast.fileExtChanged'));
      } else {
        // 不再弹确认框：保留当前编辑，下次保存直接覆盖磁盘版本
        tab.diskStale = true;
        toast(t('toast.diskChanged'), 3000);
      }
    } else if (!tab.dirty) {
      // 非活动标签：直接刷新其内容快照（不打断当前编辑）
      const r = await ms.invoke('fs:read-file', { path: tab.path });
      if (r.error) return;
      tab.content = r.content || '';
      tab.eol = r.eol || '\n';
      tab.hadBom = !!r.hadBom;
      tab.savedContent = (r.content || '').replace(/\r\n/g, '\n');
      // R40：磁盘内容已变，缓存的 IR DOM 快照作废（切回时走整篇 md 重渲染）
      tab.irHTML = null;
      renderTabBar();
      toast(t('toast.tabExtChanged', { name: tab.name }));
    } else {
      tab.diskStale = true;
    }
  });

  // 自动保存
  setInterval(() => {
    if (state.settings && state.settings.autosave && state.dirty && state.docPath) save(true);
  }, 15000);
}

// dist53 功能3：语言热切换——解析期常量表按中文原文构造，切换时按各自 i18n 键重刷
const SC_CAT_KEYS = ['cat.file', 'cat.edit', 'cat.fmt', 'cat.view', 'cat.help'];
function applyLangDicts() {
  SC_DEFS.forEach((d) => { if (d.i18n) d.label = t(d.i18n); if (d.catK) d.cat = t(d.catK); });
  SC_FIXED.forEach((d) => { if (d.i18n) d.label = t(d.i18n); if (d.catK) d.cat = t(d.catK); });
  SC_CATS.forEach((c, i) => { SC_CATS[i] = t(SC_CAT_KEYS[i]); });
  LINE_HEIGHTS.forEach((x) => { if (x.k) x.name = t(x.k); });
  EM_NAMES.strong = t('fmt.bold'); EM_NAMES.em = t('fmt.italic'); EM_NAMES.s = t('fmt.strike');
}
// 源码模式按钮文本/标题随语言与模式同步（toggleSource 与 i18n-changed 共用）
function syncSrcBtn() {
  const srcBtn = el('.fbar-src');
  if (!srcBtn) return;
  const label = srcBtn.querySelector('.fbar-src-label');
  if (label) label.textContent = state.sourceMode ? t('src.exitLabel') : t('src.label');
  srcBtn.title = state.sourceMode ? t('fbar.srcExit') : t('fbar.src');
}
// i18n-changed 统一刷新点：重绘所有由 JS 构造的文本（静态文本由 setLang 的 data-i18n 处理）
function onI18nChanged() {
  applyLangDicts();
  buildMenuBar();
  renderTabBar();
  syncDocState();
  updateCursorPos();
  try { scheduleStats(); } catch (e) { }
  syncSrcBtn();
  const reader = el('#reader');
  const rb = el('#reader-edit');
  if (reader && !reader.classList.contains('hidden')) {
    if (rb) rb.textContent = t('reader.keepEdit');
    // 横幅句由 applyDom（data-i18n-html）重写，size 值需重算
    const rt = state.tabs.find((x) => x.id === readerTabId);
    if (rt) {
      const mb = rt.content.length / 1048576;
      const sz = el('#reader-size');
      if (sz) sz.textContent = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(rt.content.length / 1024) + ' KB';
    }
  }
  const tpOps = el('#tp-ops');
  if (tpOps && !tpOps.classList.contains('hidden')) el('#tp-ops-title').textContent = t('tp.opsIn');
  const sm = el('#modal-settings');
  if (sm && !sm.classList.contains('hidden')) { try { fillSettingsForm(state.settings); renderScSettings(); } catch (e) { } }
  const scm = el('#modal-shortcuts');
  if (scm && !scm.classList.contains('hidden')) { try { openShortcutsModal(); } catch (e) { } }
  const wm = el('#welcome');
  if (wm && !wm.classList.contains('hidden')) { try { showWelcome(); } catch (e) { } }
  const side = el('#sidebar');
  if (side && !side.classList.contains('hidden')) { try { refreshOutline(); } catch (e) { } }
}

async function init() {
  state.cdnUrl = await ms.invoke('app:cdn-url');
  state.settings = await ms.invoke('app:get-settings');
  // dist53 功能3：按落盘语言热切换（i18n-changed 监听器随后刷新全部 JS 构造文本）
  document.addEventListener('i18n-changed', onI18nChanged);
  applyLangDicts();
  setLang((state.settings && state.settings.language) || 'zh-CN');
  // R75-2：载入最近打开的文件夹（文件菜单子菜单用）
  try { state.recentFolders = await ms.invoke('app:recent-folders') || []; } catch (e) { state.recentFolders = []; }
  scRebuild(); // R67：以落盘值重建生效快捷键表（含用户自定义）
  applyThemeDom(state.settings.theme);
  applyFontSize();
  applyFont();
  applyContentLayout();
  applyWrap();
  applyLineHeight();
  applySidebarWidth();
  syncSidebarResizer();

  buildMenuBar();
  installSpanObserver();
  renderTabBar();
  preloadSysFonts();

  await ensureEditor();
  bindUi();
  sendMenuState();

  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  const folder = params.get('folder');
  const unsavedToken = params.get('unsaved'); // R75-5：新窗口打开未保存内容
  if (folder) await openFolder(folder);
  if (file) {
    await openPath(file);
  } else if (unsavedToken) {
    // R75-5/6：拖拽未保存标签到松手点 → 新窗口以内容打开
    let up = null;
    try { up = await ms.invoke('win:take-unsaved', { token: unsavedToken }); } catch (e) { }
    if (up) await openContentTab(up);
    else showWelcome();
  } else if (!folder) {
    showWelcome();
  }
  // R40：启动参数携带多个文件（拖拽多文件到 exe / 命令行多参数）→ 依次开为标签（openPath 自带去重）
  const extraFilesRaw = params.get('files');
  if (extraFilesRaw) {
    let list = [];
    try { list = JSON.parse(extraFilesRaw); } catch (err) { list = []; }
    for (const f of list) {
      if (typeof f === 'string' && f) await openPath(f);
    }
  }

  // R53-8：托盘「新建文件」而当时没有任何窗口 → 启动即新建空白文档
  if (params.get('newfile') === '1') setTimeout(() => { newFile(); }, 200);

  if (params.get('smoke') === '1') setupSmoke();

  // 开发调试模式：打开文档后自动展开大纲侧栏（打包版不会带 debug 参数）
  if (params.get('debug') === '1' && file) showSidebar('outline');
}

init();
