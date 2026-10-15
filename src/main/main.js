const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, shell, nativeTheme, clipboard, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const zlib = require('zlib');
const iconv = require('iconv-lite');
const { pathToFileURL } = require('url');
const { execFile, spawn } = require('child_process');
const i18n = require('../renderer/i18n.js'); // dist53 功能3：主进程复用渲染层字典（setLangCore 不碰 DOM）

app.setName('MarkStudio');

// R61: Electron 没有内建 app.isQuitting()——直接调用抛 TypeError（R58 关闭流程因此
// 从首次运行即断裂：点窗口 X / 未保存弹窗确认后都会触发主进程未捕获异常弹框）。
// 改模块级标志：before-quit（托盘「退出 MarkStudio」/系统关机）时置 true
let appQuitting = false;
app.on('before-quit', () => { appQuitting = true; });

// ---------------------------------------------------------------- R87: 极简 ZIP 写入器（STORE + DEFLATE）
// 无外部依赖，用于把 OOXML 部件组装成合法的 .docx/.doc 容器（Word/WPS 依容器嗅探打开）。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(entries) {
  const chunks = []; const central = []; let offset = 0;
  const dosTime = 0; const dosDate = ((1996 - 1980) << 9) | (2 << 5) | 1; // 固定日期 1996-02-01
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.buf;
    const crc = crc32(data);
    let payload = data; let method = 0;
    try {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) { payload = deflated; method = 8; }
    } catch (err) { payload = data; method = 0; }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);       // version needed
    lh.writeUInt16LE(0x0800, 6);   // flag: UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, payload);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 限时等待：p 超过 ms 毫秒未决则 reject——导出管线任何一步卡死都不能让 UI 永远无反馈
function withTimeout(ms, p) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms); if (t.unref) t.unref(); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

// =====================================================================
// dist55 修复2：PDF 大纲（/Outlines）注入
// Electron 的 printToPDF 不生成 PDF 书签（已实测 4 组 options 均无 /Outlines），
// 这里在生成后按 HTML 标题位置手工注入：
//   1. 调用方先把隐藏窗口缩放到 PDF 内容区宽度（A4 减左右页边距），量出每个
//      h1-h6 的文档坐标 y，再按「内容区高度」折成页码；
//   2. 解析 PDF 的 /Catalog → /Pages 树拿到按序的页对象号（经典 xref 版 PDF，
//      Chromium 输出即此格式；xref stream 等非经典格式直接放弃注入、保留原 PDF）；
//   3. 追加 /Outlines 根对象 + 每个标题一个 Item 对象（CJK 标题用 UTF-16BE
//      十六进制字符串、其余用带转义的字面量字符串），改目录字典、重建 xref。
// 任何一步异常都回退原 PDF（绝不让「加书签」把原本正常的 PDF 弄坏）。
function addPdfOutline(pdf, marks, pageH) {
  try {
    const s = pdf.toString('latin1');
    const xrefPos = s.indexOf('\nxref\n');
    if (xrefPos < 0) return pdf; // 非经典 xref（xref stream 等）——放弃注入，保留原文件
    // ---- 1) 目录对象与页树（按文档顺序取叶子页对象号） ----
    const ci = s.indexOf('/Type /Catalog');
    if (ci < 0) return pdf;
    const catEnd = s.indexOf('endobj', ci);
    const pagesM = s.slice(ci, catEnd).match(/\/Pages\s+(\d+)\s+0\s+R/);
    if (!pagesM) return pdf;
    const objBody = (num) => {
      const m = s.match(new RegExp('(?:^|[\\s])' + num + ' 0 obj'));
      if (!m) return '';
      const st = m.index + m[0].length;
      return s.slice(st, s.indexOf('endobj', st));
    };
    const leaves = [];
    (function walk(num, depth) {
      if (depth > 8 || leaves.length > 2000) return;
      const body = objBody(num);
      if (!body) return;
      if (/\/Type\s*\/Pages\b/.test(body)) {
        const kids = ((body.match(/\/Kids\s*\[([^\]]*)\]/) || [0, ''])[1].match(/\d+/g)) || [];
        kids.forEach((k) => walk(k, depth + 1));
      } else if (/\/Type\s*\/Page\b/.test(body)) {
        leaves.push(num);
      }
    })(parseInt(pagesM[1], 10), 0);
    if (!leaves.length) return pdf;
    // ---- 2) 标题位置 → 书签项（页码按内容区高度折算，越界夹取） ----
    const items = (marks || [])
      .filter((m) => m && m.t && m.t.length)
      .slice(0, 500)
      .map((m) => ({
        text: m.t.slice(0, 200),
        level: Math.min(6, Math.max(1, m.l || 1)),
        page: Math.min(leaves.length - 1, Math.max(0, Math.floor((m.y || 0) / pageH)))
      }));
    if (!items.length) return pdf;
    let maxObj = 0;
    (s.match(/\b(\d+) 0 obj/g) || []).forEach((mm) => { const n = parseInt(mm, 10); if (n > maxObj) maxObj = n; });
    const rootNum = maxObj + 1;
    // PDF 字符串：含非 latin1 字符（CJK 等）用 UTF-16BE 十六进制串（带 BOM），否则字面量+转义
    function pdfTitle(t) {
      let wide = false;
      for (const ch of t) { if (ch.codePointAt(0) > 255) { wide = true; break; } }
      if (wide) {
        let hex = 'FEFF';
        for (const ch of t) {
          const cp = ch.codePointAt(0);
          if (cp > 0xFFFF) {
            hex += (0xD800 + ((cp - 0x10000) >> 10)).toString(16).padStart(4, '0');
            hex += (0xDC00 + ((cp - 0x10000) & 0x3FF)).toString(16).padStart(4, '0');
          } else hex += cp.toString(16).padStart(4, '0');
        }
        return '<' + hex + '>';
      }
      return '(' + t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
        .replace(/\r/g, '\\r').replace(/\n/g, '\\n') + ')';
    }
    // ---- 3) Outline 对象（/Parent /First /Last /Prev /Next 链接，标准扁平算法） ----
    const O = {};
    const root = O[rootNum] = { level: 0 };
    const list = [];
    const byLevel = [];
    items.forEach((it, idx) => {
      const num = rootNum + 1 + idx;
      const d = O[num] = Object.assign({ num }, it);
      while (byLevel.length > it.level) byLevel.pop();
      const prev = byLevel[it.level - 1];
      if (prev && prev.level === it.level) { // 同级：接在前一项之后（同父）
        d.Parent = prev.Parent;
        d.Prev = prev.num; prev.Next = num;
        O[d.Parent].Last = num;
      } else { // 新层级：上一节点（或根）的第一个子项
        d.Parent = byLevel.length ? byLevel[byLevel.length - 1].num : rootNum;
        const p = O[d.Parent];
        if (p.First === undefined) p.First = num;
        p.Last = num;
      }
      byLevel[it.level - 1] = d;
      list.push(d);
    });
    // 键序严格按 PDF 规范（Table 124/125）——WPS 等严格解析器拒收乱序字典
    let newObjs = '\n' + rootNum + ' 0 obj\n<</Type /Outlines/First ' + root.First +
      ' 0 R/Last ' + root.Last + ' 0 R/Count ' + items.length + '>>\nendobj\n';
    for (const d of list) {
      let dict = '<</Title ' + pdfTitle(d.text) + '/Parent ' + d.Parent + ' 0 R';
      if (d.First !== undefined) dict += '/First ' + d.First + ' 0 R';
      if (d.Last !== undefined) dict += '/Last ' + d.Last + ' 0 R';
      if (d.Prev !== undefined) dict += '/Prev ' + d.Prev + ' 0 R';
      if (d.Next !== undefined) dict += '/Next ' + d.Next + ' 0 R';
      dict += '/Dest [' + leaves[d.page] + ' 0 R /XYZ null null 1]>>';
      newObjs += d.num + ' 0 obj\n' + dict + '\nendobj\n';
    }
    // ---- 4) 拼回：目录字典加 /Outlines → 新对象 → 重建 xref → trailer ----
    // 注意：目录在文件中部（对象 80），插入字节会把其后所有对象的真实偏移推后
    // delta 字节——旧 xref 里偏移 > 插入点的条目必须同步 +delta，否则整个 PDF 报废
    const origHead = s.slice(0, xrefPos);
    const catMatch = origHead.match(/(\/Pages\s+\d+\s+0\s+R)(\s*)/);
    if (!catMatch) return pdf;
    const insertEnd = catMatch.index + catMatch[0].length;
    const head = origHead.slice(0, insertEnd) + '/Outlines ' + rootNum + ' 0 R\n' + origHead.slice(insertEnd);
    const delta = head.length - origHead.length;
    const objsBuf = Buffer.from(newObjs, 'latin1');
    const headLen = Buffer.byteLength(head, 'latin1');
    const xrefStartNew = headLen + objsBuf.length;
    // 解析旧 xref 表格（经典格式：subsections + "offset gen f|n" 行）
    const entries = {};
    const xlines = s.slice(xrefPos + 1).split('\n');
    let li = 0;
    while (li < xlines.length) {
      const hm = (xlines[li] || '').trim().match(/^(\d+)\s+(\d+)$/);
      if (hm) {
        const st = parseInt(hm[1], 10), cnt = parseInt(hm[2], 10);
        for (let k = 0; k < cnt; k++) {
          const parts = (xlines[li + 1 + k] || '').trim().split(/\s+/);
          if (parts.length >= 3) entries[st + k] = parts;
        }
        li += 1 + cnt;
      } else li++;
    }
    // 插入点之后的旧对象偏移整体 +delta
    for (const k of Object.keys(entries)) {
      if (parseInt(entries[k][0], 10) > insertEnd) {
        entries[k][0] = String(parseInt(entries[k][0], 10) + delta).padStart(10, '0');
      }
    }
    // 新对象偏移（在拼接后的头部之后的实际位置）
    const re2 = /(\d+) 0 obj[\s\S]*?endobj\n/g;
    let mch;
    while ((mch = re2.exec(newObjs)) !== null) {
      entries[parseInt(mch[1], 10)] = [String(headLen + mch.index).padStart(10, '0'), '0', 'n'];
    }
    const size = rootNum + 1 + items.length;
    let xrefOut = 'xref\n0 ' + size + '\n';
    for (let n = 0; n < size; n++) {
      const e = entries[n];
      xrefOut += e ? (e[0] + ' ' + e[1] + ' ' + e[2] + ' \n') : '0000000000 65535 f \n';
    }
    const trailerM = s.slice(xrefPos).match(/trailer\n(<<[\s\S]*?>>)/);
    const rootM = s.slice(Math.max(0, ci - 80), ci).match(/(\d+)\s+0\s+obj/);
    const trailer = trailerM
      ? trailerM[1].replace(/\/Size\s+\d+/, '/Size ' + size)
      : '<</Size ' + size + (rootM ? ' /Root ' + rootM[1] + ' 0 R' : '') + '>>';
    const tail = 'trailer\n' + trailer + '\nstartxref\n' + xrefStartNew + '\n%%EOF';
    return Buffer.concat([Buffer.from(head, 'latin1'), objsBuf, Buffer.from(xrefOut + tail, 'latin1')]);
  } catch (e) {
    return pdf; // 注入失败回退原文件
  }
}

// ---------------------------------------------------------------- 通用状态
const wins = new Set(); // 所有窗口
// R75-5：拖拽未保存标签开新窗口时暂存「待取内容」，token 经 query 传给新窗口，
// 渲染层启动后按 token 取走（内容可能很大，不走 query 字符串避免 URL 长度上限）
const pendingUnsaved = new Map();
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = { theme: 'light', contentTheme: 'auto', fontSize: 16, contentFont: '', autosave: false, typewriter: false, focusMode: false, sidebarWidth: 260, contentWidth: 'full', contentCenter: false, wrap: true, lineHeight: 1.75, closeAction: 'ask', language: 'zh-CN', codeLineNumbers: true, imageScale: 2, imageFormat: 'png', imageDpi: 300, imageSaveDir: '' };
let settingsCache = null;
// 渲染进程上报的 UI 状态（用于菜单项动态标签，如 隐藏/打开侧边栏）
let uiState = { sidebarVisible: false, sourceMode: false, showLines: true };
// dist53 功能3：主进程（托盘/系统对话框）跟随界面语言——初始取落盘设置，
// 渲染层切换语言时经 app:set-language 同步过来并即时重建托盘菜单
function applyMainLang(l) {
  i18n.setLangCore(l);
  try { trayRebuildRecent(); } catch (e) { } // 模块加载期 tray 尚在 TDZ / 未创建——忽略
}
try { applyMainLang(((loadStore().settings) || {}).language || 'zh-CN'); } catch (e) { }

function loadStore() {
  if (settingsCache) return settingsCache;
  try {
    settingsCache = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (e) {
    settingsCache = { settings: { ...DEFAULT_SETTINGS }, recent: [] };
  }
  if (!settingsCache.settings) settingsCache.settings = { ...DEFAULT_SETTINGS };
  if (!Array.isArray(settingsCache.recent)) settingsCache.recent = [];
  // R75-2：最近打开的文件夹（文件→最近文件夹 子菜单）
  if (!Array.isArray(settingsCache.recentFolders)) settingsCache.recentFolders = [];
  return settingsCache;
}
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(loadStore(), null, 2), 'utf8');
  } catch (e) { /* 忽略持久化失败 */ }
}
function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...loadStore().settings };
  // 防污染：历史上可能写入过 null/NaN，读回时统一归一为默认值
  if (!Number.isFinite(s.fontSize) || !s.fontSize) s.fontSize = DEFAULT_SETTINGS.fontSize;
  if (!Number.isFinite(s.lineHeight) || s.lineHeight < 1 || s.lineHeight > 3) s.lineHeight = DEFAULT_SETTINGS.lineHeight;
  if (!['ask', 'minimize', 'quit'].includes(s.closeAction)) s.closeAction = DEFAULT_SETTINGS.closeAction;
  // dist66：语言归一（历史/写坏值回退默认 zh-CN），配合「恢复默认」把 language 重置为简体中文
  if (!['zh-CN', 'en-US'].includes(s.language)) s.language = DEFAULT_SETTINGS.language;
  // R67：快捷键自定义表（id → 组合串），历史版本无此字段或写坏时归一为 {}
  if (!s.shortcuts || typeof s.shortcuts !== 'object' || Array.isArray(s.shortcuts)) s.shortcuts = {};
  return s;
}

function pushRecent(filePath) {
  if (!filePath) return;
  const store = loadStore();
  store.recent = [filePath, ...store.recent.filter(p => path.resolve(p) !== path.resolve(filePath))].slice(0, 15);
  saveStore();
  rebuildMenus();
  trayRebuildRecent();
}

// R75-2：记录最近打开的文件夹（去重、置顶，保留最近 10 个）
function pushRecentFolder(folderPath) {
  if (!folderPath) return;
  const store = loadStore();
  store.recentFolders = [folderPath, ...store.recentFolders.filter(p => path.resolve(p) !== path.resolve(folderPath))].slice(0, 10);
  saveStore();
  rebuildMenus();
}

// ---------------------------------------------------------------- 文本读写（UTF-8 / GBK 自动识别）
function decodeBuffer(buf) {
  let hadBom = false;
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    hadBom = true;
    body = buf.subarray(3);
  }
  // 先按 UTF-8 严格解码，失败则回退 GBK
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return { text: decoder.decode(body), encoding: 'utf-8', hadBom };
  } catch (e) {
    return { text: iconv.decode(body, 'gbk'), encoding: 'gbk', hadBom };
  }
}

function detectEol(text) {
  const idx = text.indexOf('\n');
  if (idx > 0 && text[idx - 1] === '\r') return '\r\n';
  return '\n';
}

async function readTextFile(filePath) {
  const buf = await fsp.readFile(filePath);
  const { text, encoding, hadBom } = decodeBuffer(buf);
  return { path: filePath, content: text, eol: detectEol(text), hadBom, encoding };
}

async function writeTextFile(filePath, content, eol, hadBom) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  let out = (content || '').replace(/\r\n/g, '\n').replace(/\n/g, eol || '\n');
  let buf = Buffer.from(out, 'utf8');
  if (hadBom) buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
  const tmp = filePath + '.mkstudio-tmp';
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, filePath);
  return { ok: true, mtime: (await fsp.stat(filePath)).mtimeMs };
}

// ---------------------------------------------------------------- 窗口
function filesFromArgv(argv) {
  // R40：argv 可能带多个文件（拖拽多个文件到 exe / 命令行多参数）。
  // 按命令行原始顺序全部收集并按绝对路径去重，不再只取最后一个
  const out = [];
  const seen = new Set();
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (typeof a === 'string' && /\.(md|markdown|txt)$/i.test(a) && fs.existsSync(a)) {
      const p = path.resolve(a);
      if (!seen.has(p)) { seen.add(p); out.unshift(p); }
    }
  }
  return out;
}

function titleFor(win) {
  const name = win.__docPath ? path.basename(win.__docPath) : i18n.t('name.untitled');
  return `${name}${win.__dirtyActive ? ' *' : ''} - MarkStudio`;
}

// ---------------------------------------------------------------- 任务栏图标分组（R73-1）
// Win11 默认把同一应用的所有窗口合并成一个任务栏按钮（带数字角标）。用户要求
// 「一个窗口 = 一个任务栏图标」：同一窗口内多文件标签不增图标，开新窗口才 +1。
// 做法：给每个窗口设置独立的 Application User Model ID（Win10 2004+/Win11 起
// 任务栏按「窗口级 AUMID」分组）。Electron 31 只有应用级 app.setAppUserModelId，
// 窗口级 AUMID 必须调 Win32 SetWindowInfo(WNI_APP_USER_MODEL_ID)——
// 用 PowerShell Add-Type P/Invoke（与 app:list-fonts 同一模式），HWND 取自
// win.getNativeWindowHandle()。失败无碍：回落到任务栏默认分组，不影响功能。
const AUMID_CSHARP = 'using System;using System.Runtime.InteropServices;public static class MsAumid{[DllImport("user32.dll",SetLastError=true)]public static extern bool SetWindowInfo(IntPtr hWnd,int dwItem,uint cbItem,IntPtr pvInfo);}';
const AUMID_PS = 'Add-Type -TypeDefinition $args[1];$s=$args[0];$p=[System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($s);try{[void][MsAumid]::SetWindowInfo([IntPtr][long]$args[2],2,[uint32]($s.Length*2+2),$p)}finally{[System.Runtime.InteropServices.Marshal]::FreeHGlobal($p)}';
// 一次性探测系统是否提供 SetWindowInfo（个别精简系统镜像的 user32.dll 没有该导出，
// 例如部分 VDI 镜像）——确认后不再重复 spawn，避免每次开窗口都跑一遍注定失败的脚本
let aumidSupported = null; // null=未确认 / true / false
function aumidSupportedCheck() {
  if (process.platform !== 'win32') { aumidSupported = false; return; } // AUMID 是 Windows 专有，其它平台不探测
  const probe = 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class MsProbe{[DllImport("kernel32.dll")]public static extern IntPtr GetModuleHandle(string n);[DllImport("kernel32.dll",CharSet=CharSet.Ansi)]public static extern IntPtr GetProcAddress(IntPtr h,string n);}\';([MsProbe]::GetProcAddress([MsProbe]::GetModuleHandle("user32.dll"),"SetWindowInfo") -ne [IntPtr]::Zero)';
  try {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', probe], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => { });
    ps.on('exit', () => { aumidSupported = /true/i.test(out); });
  } catch (e) { aumidSupported = false; }
}
function applyWindowAumid(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  if (aumidSupported === false) return; // 已确认系统无此 API（null=未确认，照常尝试）
  let hwnd = 0;
  try {
    const buf = win.getNativeWindowHandle();
    if (buf && buf.length >= 4) hwnd = buf.readUInt32LE(0);
  } catch (e) { return; }
  if (!hwnd) return;
  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', AUMID_PS, 'com.markstudio.app.win' + win.id, AUMID_CSHARP, String(hwnd)],
      { windowsHide: true, stdio: 'ignore' });
  } catch (e) { /* AUMID 失败不影响窗口本身 */ }
}

function createWindow(filePath, opts = {}) {
  const s = getSettings();
  const dark = s.theme === 'dark';
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // R73：标签拖出新窗口的落点（源窗口右下方偏移，WPS 式）；未指定时由系统级联
    x: Number.isFinite(opts.x) ? Math.round(opts.x) : undefined,
    y: Number.isFinite(opts.y) ? Math.round(opts.y) : undefined,
    // 无框窗口：标题栏（MarkStudio 标签 + 文件标签 + 窗口按钮）由渲染层自绘
    frame: false,
    backgroundColor: dark ? '#1e1e1e' : '#ffffff',
    autoHideMenuBar: false,
    icon: path.join(app.getAppPath(), 'resources', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true
    }
  });
  win.__docPath = filePath || null;
  win.__dirty = false;
  wins.add(win);
  // R92：渲染进程崩溃（如超大文档整篇编辑耗尽内存）自动重载——否则窗口全白，
  // 自绘的菜单栏/标题栏/标签栏全是 DOM，会随进程死亡一起"消失"，用户只能强退
  win.webContents.on('render-process-gone', (e, details) => {
    if (details && details.reason === 'clean-exit') return;
    console.error('[markstudio] renderer gone:', details && details.reason, details && details.exitCode);
    try { win.webContents.reload(); } catch (err) { }
  });
  applyWindowAumid(win); // R73-1：独立任务栏图标（尽早设置；show 前再补一次防竞争）
  // R73-2：把窗口 id 发给渲染层——标签跨窗口拖拽时源窗口 id 要放进拖拽数据，
  // 目标窗口落地后凭它通知源窗口移除对应标签
  // R73-2：把窗口 id 发给渲染层（双通道：事件 + 主动查询，防 init() 异步延迟的
  // 竞态——bindUi 的监听注册晚于 did-finish-load 时事件会丢，查询通道无此问题）
  win.webContents.once('did-finish-load', () => {
    try { win.webContents.send('win:id', win.id); } catch (e) { }
  });
  // 兜底：禁止页面 window.open 弹出新 MarkStudio 窗口（http(s) 链接交由系统浏览器打开）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const query = {};
  if (filePath) query.file = filePath;
  if (opts.extraFiles && opts.extraFiles.length) query.files = JSON.stringify(opts.extraFiles);
  if (process.env.MARKSTUDIO_FOLDER) query.folder = process.env.MARKSTUDIO_FOLDER;
  if (opts.folder) query.folder = opts.folder; // R72：新窗口打开拖入文件时，目录=文件所在目录
  if (opts.smoke) query.smoke = '1';
  if (opts.trayNewFile) query.newfile = '1';
  if (opts.debug) query.debug = '1';
  // R75-5：新窗口以「未保存内容」打开（拖拽未保存标签到松手点）——内容走 IPC 取，token 走 query
  if (opts.unsavedToken) query.unsaved = opts.unsavedToken;
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query });

  if (opts.debug) {
    // 后台管道断开时 stdout 会以异步 error 事件抛 EPIPE，吞掉以免主进程崩溃
    try { process.stdout.on('error', () => {}); process.stderr.on('error', () => {}); } catch (err) { }
    win.webContents.on('console-message', (e, level, message) => {
      try { process.stdout.write('[renderer] ' + (message || String(e)) + '\n'); } catch (err) { }
    });
  }

  win.once('ready-to-show', () => {
    applyWindowAumid(win); // R73-1：show 之前再设一次，确保任务栏按钮按窗口级 AUMID 分组
    if (opts.maximized) win.maximize();
    win.show();
    win.webContents.send('window:max-state', win.isMaximized());
    win.webContents.send('window:full-state', win.isFullScreen()); // R75：初始全屏状态（菜单「全屏/退出全屏」切换用）
  });

  // 最大化/还原状态同步给渲染层（自绘标题栏切换图标），拖顶边、双击等外部操作也能同步
  win.on('maximize', () => { try { win.webContents.send('window:max-state', true); } catch (e) { } });
  win.on('unmaximize', () => { try { win.webContents.send('window:max-state', false); } catch (e) { } });
  // R75：全屏状态同步给渲染层——视图菜单据此显示「全屏」或「退出全屏」（同一时间只出现一个）
  win.on('enter-full-screen', () => { try { win.webContents.send('window:full-state', true); } catch (e) { } });
  win.on('leave-full-screen', () => { try { win.webContents.send('window:full-state', false); } catch (e) { } });
  // R71：窗口可见性 ↔ 托盘图标互斥（show=窗口出现→托盘隐藏；hide=藏到托盘→托盘出现）
  win.on('show', syncTrayVisibility);
  win.on('hide', syncTrayVisibility);

  // R58：关闭决定（设置 closeAction）——用户点 X（或未保存弹窗里选择保存/不保存后）：
  // minimize=最小化到系统托盘（程序保持运行）/ quit=完全退出 / ask=每次询问
  // R69：minimize 用 win.hide() 而非 minimize()——任务栏窗口按钮一并消失，
  //      只保留托盘图标（用户要求）；托盘左键 / 右键「打开 MarkStudio」恢复窗口
  // R62：ask 询问改用应用内 iOS 毛玻璃弹窗（渲染层 #close-modal），不再弹系统原生框
  const requestCloseDecision = async () => {
    if (!win || win.isDestroyed() || appQuitting) return;
    const action = getSettings().closeAction || 'ask';
    if (action === 'minimize') { hideToTrayOrMinimize(win); return; }
    if (action === 'quit') { app.quit(); return; }
    // 询问弹窗已打开时忽略重复的关闭请求（用户连点 X），避免叠加
    if (win.__askingClose) return;
    win.__askingClose = true;
    let timer = null;
    const choice = await new Promise((resolve) => {
      win.__askCloseResolve = resolve;
      win.webContents.send('app:close-ask');
      // 渲染层异常（崩溃/卡死）兜底：30 秒无应答按「取消」处理，窗口原样保留。
      // R63：5 秒太短——用户读提示词、想一想就超过 5 秒，届时主进程先吞掉应答，
      // 用户再点「退出」/「最小化」时 win.__askCloseResolve 已为 null，点击静默无效
      // （用户报告「选了退出但没退出」的根因）。同时通知渲染层同步收起弹窗，
      // 避免一个「已失效但仍可点」的弹窗留下
      timer = setTimeout(() => {
        if (win.__askCloseResolve) {
          win.__askCloseResolve = null;
          resolve('cancel');
          try { win.webContents.send('app:close-ask-timeout'); } catch (err) { }
        }
      }, 30000);
    });
    if (timer) clearTimeout(timer);
    win.__askingClose = false;
    if (win.isDestroyed()) return;
    if (choice === 'quit') app.quit();
    else if (choice === 'minimize') hideToTrayOrMinimize(win); // R69：Windows 隐藏到托盘；mac/linux 最小化到 Dock/任务栏
    // 'cancel'（含超时）：什么都不做
  };

  win.on('close', (e) => {
    if (win.__closing || appQuitting) return; // 应用自身在退出（托盘「退出」/系统关机）→ 放行
    if (process.env.MARKSTUDIO_SMOKE) return; // 冒烟测试：直接关闭
    if (win.__askingClose) { e.preventDefault(); return; } // R62：关闭确认弹窗打开中
    if (win.__dirty) {
      // R50：未保存 → 先走应用内毛玻璃弹窗（保存/不保存/取消）；用户确认关闭后
      // close-done(ok=true) 再执行关闭决定
      e.preventDefault();
      win.__pendingClose = true;
      win.webContents.send('app:close-intent');
      return;
    }
    e.preventDefault();
    requestCloseDecision();
  });
  win.__closeDecision = requestCloseDecision; // 供 app:close-done（未保存弹窗结束后）复用

  win.on('closed', () => {
    wins.delete(win);
    syncTrayVisibility(); // R71：窗口被销毁（非隐藏）后重算托盘可见性
    closeWatch(win);
    if (win.__tabWatchers) {
      for (const w of win.__tabWatchers.values()) { try { w.close(); } catch (e) { } }
      win.__tabWatchers = null;
    }
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.__watcher = null;
  return win;
}

function closeWatch(win) {
  if (win.__watcher) { try { win.__watcher.close(); } catch (e) { } win.__watcher = null; }
  if (win.__tabWatchers) {
    for (const w of win.__tabWatchers.values()) { try { w.close(); } catch (e) { } }
    win.__tabWatchers = new Map();
  }
}
// 多标签：按渲染层上报的「全部已打开标签路径」做外部修改监听（增量增删，保留各文件基线 mtime）
function watchTabPaths(win, paths) {
  if (!win || win.isDestroyed()) return;
  const cur = win.__tabWatchers || (win.__tabWatchers = new Map());
  const want = new Set((paths || []).filter(Boolean).map(p => path.resolve(p)));
  for (const [p, w] of Array.from(cur.entries())) {
    if (!want.has(p)) { try { w.close(); } catch (e) { } cur.delete(p); }
  }
  for (const pRaw of want) {
    if (cur.has(pRaw)) continue;
    if (!fs.existsSync(pRaw)) continue;
    try {
      let lastMtime = fs.statSync(pRaw).mtimeMs;
      const w = fs.watch(pRaw, () => {
        try {
          const st = fs.statSync(pRaw);
          // 过滤我们自己的保存：mtime 与刚写入值一致且时间窗内，不报“外部修改”
          const own = win.__lastWriteMtime || 0;
          if (own && Math.abs(st.mtimeMs - own) < 20 && (Date.now() - (win.__lastWriteAt || 0)) < 5000) {
            lastMtime = st.mtimeMs;
            return;
          }
          if (st.mtimeMs > lastMtime + 5) {
            lastMtime = st.mtimeMs;
            if (!win.isDestroyed()) win.webContents.send('fs:changed', { path: pRaw });
          }
        } catch (e) { /* 文件可能被删除 */ }
      });
      cur.set(pRaw, w);
    } catch (e) { /* watch 失败不影响主流程 */ }
  }
}

// ---------------------------------------------------------------- 菜单
// 界面已改用渲染层自绘菜单栏（悬浮即开、切换灵敏、支持富 UI 如颜色/字体面板），
// 不再安装原生菜单；所有快捷键改由渲染层 keydown 统一处理。
function rebuildMenus() {
  Menu.setApplicationMenu(null);
}

function updateSettings(partial) {
  const store = loadStore();
  store.settings = { ...getSettings(), ...partial };
  saveStore();
  if (partial.theme) {
    nativeTheme.themeSource = partial.theme === 'dark' ? 'dark' : (partial.theme === 'auto' ? 'system' : 'light');
  }
  rebuildMenus(); // 刷新菜单勾选态（主题/宽度/字体/换行等）
}

function openPathIn(win, p) {
  // 多标签模式：一律在指定窗口内以标签页打开（渲染层负责去重/激活），不再弹出新窗口
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('app:open-path', p);
  } else {
    createWindow(p);
  }
}


// ---------------------------------------------------------------- 导出（PDF / 打印 用隐藏窗口渲染）
// ---- dist59：图片 DPI 物理分辨率元数据（PNG pHYs / JPEG JFIF APP0）+ CRC32 ----
// nativeImage 的 toPNG/toJPEG 不带 DPI（默认按 96 处理），这里直接把元数据写进字节流：
//  · PNG：pHYs 块（pixels/meter = dpi/0.0254，unit=1 米），插在 IHDR 之后并替换旧 pHYs；
//  · JPEG：JFIF APP0 密度字段（units=1 → dpi）。
let __crc32Table = null;
function crc32(buf) {
  if (!__crc32Table) {
    __crc32Table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); __crc32Table[n] = c; }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = __crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function stampPngDpi(buf, dpi) {
  try {
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return buf;
    const ppm = Math.max(1, Math.round(dpi / 0.0254));
    const data = Buffer.alloc(9); data.writeUInt32BE(ppm, 0); data.writeUInt32BE(ppm, 4); data.writeUInt8(1, 8);
    const type = Buffer.from('pHYs', 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(9, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
    const chunk = Buffer.concat([len, type, data, crc]);
    const out = [buf.slice(0, 8)]; let off = 8; let inserted = false;
    while (off + 8 <= buf.length) {
      const clen = buf.readUInt32BE(off);
      const cend = off + 12 + clen;
      const tstr = buf.slice(off + 4, off + 8).toString('ascii');
      if (tstr === 'pHYs') { /* 丢弃旧 pHYs，统一用插到 IHDR 后的新块 */ }
      else { out.push(buf.slice(off, cend)); if (tstr === 'IHDR') { out.push(chunk); inserted = true; } }
      if (tstr === 'IEND') break;
      off = cend;
    }
    if (!inserted) out.push(chunk);
    return Buffer.concat(out);
  } catch (e) { return buf; }
}
function stampJpegDpi(buf, dpi) {
  try {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    const d = Math.max(1, Math.min(65535, Math.round(dpi)));
    // 首个 APP0 已是 JFIF → 原地改单位+密度（SOI[2,3]FF E0[4,5]len[6..10]"JFIF\0"[11,12]ver[13]units[14,15]xd[16,17]yd）
    if (buf.length >= 20 && buf[2] === 0xFF && buf[3] === 0xE0 && buf.slice(6, 11).toString('ascii') === 'JFIF\x00') {
      const out = Buffer.from(buf);
      out[13] = 1; out.writeUInt16BE(d, 14); out.writeUInt16BE(d, 16);
      return out;
    }
    const payload = Buffer.alloc(14);
    Buffer.from('JFIF', 'ascii').copy(payload, 0); payload[4] = 0;
    payload[5] = 1; payload[6] = 1; payload[7] = 1;
    payload.writeUInt16BE(d, 8); payload.writeUInt16BE(d, 10);
    const seg = Buffer.concat([Buffer.from([0xFF, 0xE0, 0x00, 0x10]), payload]);
    return Buffer.concat([buf.slice(0, 2), seg, buf.slice(2)]);
  } catch (e) { return buf; }
}

// dist61：导出正文固定阅读宽度（= 隐藏窗口宽；正文 max-width 860 恒在其中，含滚动条余量）。
// 关键：不再「测量宽度」。首帧/字体换入期间隐藏窗口宽度会瞬变（实测曾停在 432，恰为 880 的一半），
// 旧逻辑用测量宽去定窗口/倍率 → 正文被压到 432 窄列 → 整篇换行变高（曾 197706）→ 分片又窄又多变、
// 尾部还多出空白片。改为固定宽度后：出图宽度一致、倍率稳定（880×4<16000→恒为所选倍率），高度按
// 860 阅读宽结算；再配合下方 settleExportWidth 先锁宽 reflow + isBlankTile 截断尾部空白，彻底稳定。
const EXPORT_W = 880;

async function renderHidden(html) {
  const tmpHtml = path.join(app.getPath('temp'), 'markstudio-export.html');
  await fsp.writeFile(tmpHtml, html, 'utf8');
  // dist60：固定内容宽度 880（> 正文 max-width 860，含滚动条余量）——否则默认窗口宽度不定，
  // 正文被压到很窄（曾见 439px）导致整篇换行变高、截图又窄又长。
  const w = new BrowserWindow({ show: false, width: 880, height: 600, useContentSize: true, webPreferences: { sandbox: true } });
  await w.loadFile(tmpHtml);
  return w;
}

// dist60：测量导出窗口正文尺寸，直到「连续两次读数一致」才返回（最多 timeoutMs）。
// 隐藏窗口首帧渲染时 CJK/KaTeX 字体尚未换入，body.scrollHeight 会瞬偏（曾偏高 2~3 倍），
// 旧「固定双采样」会把这个峰值当稳定值 → 分片数 N 过大 → 尾部整片空白。轮询到稳定可杜绝。
async function measureStable(wc, timeoutMs) {
  let prev = null;
  const t0 = Date.now();
  for (;;) {
    let cur = null;
    try {
      // dist61 修复：宽度取 CSS 盒宽 getBoundingClientRect().width（由 max-width 860 + 固定 880 窗口
      // 决定，字体换入/分块渲染期间恒定为 ~863），不再取 body.scrollWidth（内容固有宽，随内容宽窄瞬变
      // ——曾见 432px 窄读值→窗口被压窄→整篇换行变高 197706→分片又窄又多）。宽度恒定后高度按正确阅读
      // 宽度结算，配合下方 isBlankTile 截断尾部空白片，导出宽度/张数稳定且不再多出空白图。
      cur = await wc.executeJavaScript('(function(){ var b=document.body; if(!b) return null; var w=(b.getBoundingClientRect?Math.round(b.getBoundingClientRect().width):b.scrollWidth); return { w: w||800, h: b.scrollHeight||600 }; })()');
    } catch (e) { cur = null; }
    if (cur && prev && cur.w === prev.w && cur.h === prev.h) return cur; // 连续两次一致 → 布局已结算
    prev = cur;
    if (Date.now() - t0 > timeoutMs) return cur || prev || { w: 800, h: 600 }; // 超时兜底
    await sleep(80);
  }
}

// dist61：把导出窗口锁定到固定阅读宽度（EXPORT_W×scale）并缩放，等正文按最终宽度 reflow 结算后再测量。
// 首帧/字体换入期间隐藏窗口可能停在 432 窄态（880 的一半）→ 正文换行变高、高度虚高→分片又窄又多变。
// 显式 setContentSize 到 880×scale（CSS 视口恒 880）消除该瞬变；sleep(300) 给一次 reflow，随后
// measureStable 轮询高度到「连续两次一致」（宽度已锁定 880，只高度在变，稳定后即为正确的 860 阅读宽高度）。
async function settleExportWidth(w, wc, scale) {
  try { await wc.setZoomFactor(scale); } catch (e) {}
  try { w.setContentSize(Math.round(EXPORT_W * scale), 600 * scale, false); } catch (e) {}
  await sleep(300);
}

// dist61：判断一张截图是否「几乎全白」（无正文内容）。用于截断 baseH 测量虚高导致的尾部空白分片
// （字体换入尖峰 / 文档尾随空白 / body 底部留白等都会让 scrollHeight 偏大 → 分片数 N 偏大 →
//  尾部多出纯白图）。逐行抽样：只要有一行含成段内容（该行 >1% 非白像素）即判定「非空白」，
//  绝不因「某片只有少量文字」而误杀真实残片；所有抽样行都白 → 空白片。
function isBlankTile(img) {
  try {
    const sz = img.getSize ? img.getSize() : { width: 0, height: 0 };
    const w = sz.width, h = sz.height;
    if (!w || !h) return false;
    const bmp = img.toBitmap(); // 每像素 4 字节
    if (!bmp || bmp.length < w * h * 4) return false;
    const rowStep = Math.max(1, Math.floor(h / 400)); // 垂直最多 400 行抽样
    const colStep = Math.max(1, Math.floor(w / 240)); // 每行最多 240 列抽样
    for (let y = 0; y < h; y += rowStep) {
      let nonWhite = 0, sampled = 0;
      for (let x = 0; x < w; x += colStep) {
        const o = (y * w + x) * 4;
        if (bmp[o] < 245 || bmp[o + 1] < 245 || bmp[o + 2] < 245) nonWhite++;
        sampled++;
      }
      if (sampled > 0 && nonWhite > sampled * 0.01) return false; // 该行有内容 → 非空白
    }
    return true; // 所有抽样行皆白 → 空白片
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- 系统字体枚举（跨平台）
// Windows/Linux 各用系统自带工具，任一失败都回退空列表（字体选择器仅显示默认项，应用照常可用）。
// 归一化：按 family 小写去重，按本地化名（zh-Hans）排序；返回 { family, local } 数组。
function normalizeFontList(pairs) {
  const seen = new Set();
  return (pairs || [])
    .map((p) => ({ family: String(p.family || '').trim(), local: String(p.local || p.family || '').trim() }))
    .filter((f) => { if (!f.family || seen.has(f.family.toLowerCase())) return false; seen.add(f.family.toLowerCase()); return true; })
    .sort((a, b) => (a.local || '').localeCompare(b.local || '', 'zh-Hans-CN'));
}
// 运行外部命令回传 stdout（UTF-8）；出错/超时 resolve('')
function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const cp = execFile(cmd, args, { timeout: timeoutMs || 20000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : (stdout || '')));
      if (cp && cp.on) cp.on('error', () => resolve(''));
    } catch (e) { resolve(''); }
  });
}
// Windows：PowerShell + System.Drawing。管道按系统代码页（GBK）会让中文字体名乱码，故让
// PowerShell 以「无 BOM UTF-8」写入临时文件再读回；每行两列（Tab 分隔）：family + zh-CN 本地化名。
// 注意：FontFamily.GetName 只有 int(LCID) 重载，PowerShell 直接调用会绑定失败，必须走 C# Add-Type。
async function listFontsWin() {
  const tmpFile = path.join(app.getPath('temp'), 'markstudio-fonts-' + process.pid + '.txt');
  try {
    await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition \'using System;using System.Drawing.Text;using System.Text;public static class MsFontList{public static string GetAll(){var sb=new StringBuilder();var fc=new InstalledFontCollection();foreach(var fam in fc.Families){string loc=fam.Name;try{loc=fam.GetName(0x0804);}catch{ }sb.AppendLine(fam.Name+"\\t"+loc);}return sb.ToString();}}\';' +
      '$enc = New-Object System.Text.UTF8Encoding($false);' +
      '[System.IO.File]::WriteAllText(\'' + tmpFile.replace(/\\/g, '/') + '\', [MsFontList]::GetAll(), $enc)'], 20000);
    const raw = await fsp.readFile(tmpFile, 'utf8');
    return raw.split(/\r?\n/).map(s => s.replace(/^\uFEFF/, '').trim()).filter(Boolean).map((line) => {
      const i = line.indexOf('\t');
      if (i === -1) return { family: line, local: line };
      const family = line.slice(0, i).trim();
      return { family, local: line.slice(i + 1).trim() || family };
    });
  } catch (e) { return []; }
  finally { try { await fsp.unlink(tmpFile); } catch (e) { } }
}
// Linux：fontconfig 的 fc-list，取每个字体的首选 family
async function listFontsLinux() {
  let out = await runCmd('fc-list', ['--format', '%{family[0]}\n'], 15000);
  if (!out) out = await runCmd('fc-list', [':', 'family'], 15000); // 兜底：老版本 fc-list
  if (!out) return [];
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((line) => {
    const family = line.split(',')[0].trim(); // 'Family,Alt' 取首个
    return { family, local: family };
  });
}
async function enumerateSystemFonts() {
  if (process.platform === 'win32') return normalizeFontList(await listFontsWin());
  return normalizeFontList(await listFontsLinux()); // Linux（及其它 POSIX 系统）走 fc-list
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  const handler = (channel, fn) => ipcMain.handle(channel, (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return fn(payload, win, e);
  });

  handler('dialog:open-file', async (payload, win) => {
    const r = await dialog.showOpenDialog(win, {
      title: payload && payload.image ? i18n.t('dlg.insertImage') : i18n.t('dlg.openMd'),
      properties: ['openFile'],
      filters: payload && payload.image
        ? [{ name: i18n.t('dlg.image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
        : [
            { name: i18n.t('dlg.mdText'), extensions: ['md', 'markdown', 'txt'] },
            { name: i18n.t('dlg.all'), extensions: ['*'] }
          ]
    });
    if (r.canceled || !r.filePaths.length) return null;
    if (payload && payload.image) return { path: r.filePaths[0] };
    pushRecent(r.filePaths[0]);
    return readTextFile(r.filePaths[0]);
  });

  handler('dialog:open-folder', async (p, win) => {
    const r = await dialog.showOpenDialog(win, { title: i18n.t('dlg.openFolder'), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    pushRecentFolder(r.filePaths[0]); // R75-2：记住文件夹
    return r.filePaths[0];
  });

  handler('fs:read-file', async ({ path: p }) => {
    try { return await readTextFile(p); }
    catch (err) { return { error: String(err.message || err) }; }
  });

  handler('fs:write-file', async ({ path: p, content, eol, hadBom }, win) => {
    try {
      const r = await writeTextFile(p, content, eol, hadBom);
      if (win) { win.__lastWriteMtime = r.mtime; win.__lastWriteAt = Date.now(); }
      pushRecent(p);
      return r;
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  // R72：拖入文件「复制到当前文件夹」用——目标已有同名文件时不覆盖（返回 exists，
  // 渲染层直接打开现有文件，避免覆盖用户数据）
  handler('fs:copy-file', async ({ from, to }) => {
    try {
      if (!from || !to || !path.isAbsolute(from) || !path.isAbsolute(to)) return { error: i18n.t('err.pathInvalid') };
      const srcExists = await fsp.access(from).then(() => true, () => false);
      if (!srcExists) return { error: i18n.t('err.srcMissing') };
      if (await fsp.access(to).then(() => true, () => false)) return { exists: true };
      await fsp.copyFile(from, to);
      return { ok: true, to };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });

  handler('dialog:save-file', async ({ defaultPath }, win) => {
    const r = await dialog.showSaveDialog(win, {
      title: i18n.t('dlg.saveMd'),
      defaultPath: defaultPath || i18n.t('name.untitled') + '.md',
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: i18n.t('dlg.all'), extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePath) return null;
    if (!/\.(md|markdown|txt)$/i.test(r.filePath)) return r.filePath + '.md';
    return r.filePath;
  });

  handler('doc:state', ({ path: p, dirty, anyDirty }, win) => {
    if (!win) return;
    // 关闭拦截按「任一标签未保存」判断；标题星号只反映当前活动标签
    win.__dirty = !!(anyDirty || dirty);
    win.__dirtyActive = !!dirty;
    if (p !== undefined) {
      if (p && (!win.__docPath || path.resolve(win.__docPath) !== path.resolve(p))) {
        win.__docPath = p;
        pushRecent(p);
      } else if (!p) {
        win.__docPath = null;
      }
    }
    win.setTitle(titleFor(win));
  });

  // 多标签：上报全部已打开标签的文件路径，主进程增量维护 fs.watch
  handler('fs:watch-tabs', ({ paths }, win) => watchTabPaths(win, paths || []));

  // F11 全屏（自定义菜单栏后由渲染层触发）
  handler('window:fullscreen', ({ full }, win) => {
    if (!win) return;
    win.setFullScreen(full !== undefined ? !!full : !win.isFullScreen());
  });

  // 自绘标题栏：最小化 / 最大化(还原)
  handler('window:minimize', (p, win) => { if (win) win.minimize(); });
  handler('window:maximize', (p, win) => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });

  handler('app:close-done', ({ ok }, win) => {
    if (!win || !win.__pendingClose) return;
    win.__pendingClose = false;
    win.__closing = false;
    if (!ok) return; // 用户取消：窗口原样保留
    if (process.env.MARKSTUDIO_SMOKE || appQuitting) { try { win.destroy(); } catch (e) { } return; }
    // 用户确认关闭（保存/不保存）→ 执行关闭决定（设置 closeAction：最小化/退出/询问）
    if (typeof win.__closeDecision === 'function') win.__closeDecision();
    else win.destroy();
  });

  // R62：应用内关闭确认弹窗（ask 路径）的结果回传
  handler('app:close-ask-done', ({ action }, win) => {
    if (!win || !win.__askCloseResolve) return;
    const r = win.__askCloseResolve;
    win.__askCloseResolve = null;
    r(action === 'quit' ? 'quit' : (action === 'minimize' ? 'minimize' : 'cancel'));
  });

  handler('fs:read-dir', async ({ path: root }) => {
    const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '__pycache__']);
    const MD_EXT = /\.(md|markdown|txt)$/i;
    async function walk(dir, depth) {
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
      entries = entries.filter(e => !e.name.startsWith('.') && !SKIP.has(e.name));
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1, bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        const am = MD_EXT.test(a.name) ? 0 : 1, bm = MD_EXT.test(b.name) ? 0 : 1;
        if (am !== bm) return am - bm;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
      const out = [];
      for (const e of entries.slice(0, 2000)) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push({ name: e.name, path: full, isDir: true, children: depth < 8 ? await walk(full, depth + 1) : [] });
        } else {
          // 显示全部文件；openable 标记本应用能否直接编辑（md/markdown/txt）
          out.push({ name: e.name, path: full, isDir: false, openable: MD_EXT.test(e.name) });
        }
      }
      return out;
    }
    return { name: path.basename(root) || root, path: root, isDir: true, children: await walk(root, 1) };
  });

  handler('app:get-settings', () => getSettings());
  handler('app:set-settings', ({ partial }) => { updateSettings(partial || {}); return getSettings(); });
  // dist67：只读返回「按 scope 重置为默认后的设置」，**不落盘**——「恢复默认」改走渲染层
  // 「保存才生效」模型：先填表单预览，点保存才落盘+应用。单源真理仍在 DEFAULT_SETTINGS。
  handler('app:default-settings', ({ scope }) => {
    const def = DEFAULT_SETTINGS;
    if (scope === 'all') return { ...def, shortcuts: {} };
    const out = { ...getSettings() };
    const setFields = (fields) => { fields.forEach(f => { if (f in def) out[f] = def[f]; }); };
    if (scope === 'general') setFields(['theme', 'contentTheme', 'closeAction']);
    else if (scope === 'appearance') setFields(['fontSize', 'contentFont', 'lineHeight', 'contentWidth', 'contentCenter']);
    else if (scope === 'editor') setFields(['wrap', 'autosave', 'typewriter', 'focusMode']);
    return out;
  });
  // R75-3：恢复默认——按范围把对应字段重置为 DEFAULT_SETTINGS 并立即落盘。
  // 单源真理在 DEFAULT_SETTINGS（main.js），渲染层不各自硬编码默认值。
  handler('app:reset-settings', ({ scope }) => {
    const store = loadStore();
    if (!store.settings || typeof store.settings !== 'object') store.settings = {};
    const def = DEFAULT_SETTINGS;
    const setFields = (fields) => { fields.forEach(f => { if (f in def) store.settings[f] = def[f]; }); };
    if (scope === 'general') setFields(['theme', 'contentTheme', 'closeAction']);
    else if (scope === 'appearance') setFields(['fontSize', 'contentFont', 'lineHeight', 'contentWidth', 'contentCenter']);
    else if (scope === 'editor') setFields(['wrap', 'autosave', 'typewriter', 'focusMode']);
    else if (scope === 'all') {
      Object.keys(def).forEach(f => { store.settings[f] = def[f]; });
      store.settings.shortcuts = {};
    } else return getSettings(); // 未知范围：原样返回，不误改
    saveStore();
    return getSettings();
  });
  handler('app:menu-state', (s) => {
    if (s) {
      if (typeof s.sidebarVisible === 'boolean') uiState.sidebarVisible = s.sidebarVisible;
      if (typeof s.sourceMode === 'boolean') uiState.sourceMode = s.sourceMode;
      if (typeof s.showLines === 'boolean') uiState.showLines = s.showLines;
    }
    rebuildMenus();
    return true;
  });
  handler('app:recent', () => loadStore().recent || []);
  // 重命名后把最近文件里的旧路径替换为新路径（标签悬浮卡片「重命名」用）
  handler('app:recent-replace', ({ from, to }) => {
    const st = loadStore();
    if (!Array.isArray(st.recent)) st.recent = [];
    st.recent = st.recent.map(p => (p === from ? to : p));
    saveStore();
    rebuildMenus();
    trayRebuildRecent();
    return st.recent;
  });
  handler('app:clear-recent', () => { loadStore().recent = []; saveStore(); rebuildMenus(); trayRebuildRecent(); });

  // R75-2：最近文件夹（文件→最近文件夹 子菜单）
  handler('app:recent-folders', () => loadStore().recentFolders || []);
  handler('app:push-recent-folder', ({ path: p }) => { pushRecentFolder(p); return loadStore().recentFolders || []; });

  handler('shell:open-external', ({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  handler('shell:open-path', ({ path: p }) => { if (p) shell.openPath(p); });
  handler('shell:show-item', ({ path: p }) => { if (p) shell.showItemInFolder(p); });
  handler('clipboard:write', ({ text }) => clipboard.writeText(text || ''));
  handler('clipboard:read', () => clipboard.readText());

  handler('app:cdn-url', () => pathToFileURL(path.join(app.getAppPath(), 'vendor', 'vditor')).href);

  // 系统已安装字体列表（跨平台：Windows=System.Drawing / Linux=fc-list；
  // 进程内缓存，仅查询一次。任一平台失败都回退空列表，字体选择器仅显示默认项）
  let fontsCache = null;
  handler('app:list-fonts', async () => {
    if (fontsCache) return fontsCache;
    fontsCache = await enumerateSystemFonts();
    return fontsCache;
  });

  // 重命名文件（同目录内；标签悬浮卡片「重命名」用）
  handler('fs:rename', async ({ from, to }) => {
    try {
      if (!from || !to) return { error: i18n.t('err.pathEmpty') };
      const st = await fsp.stat(to).catch(() => null);
      if (st) return { error: i18n.t('err.destExists', { n: path.basename(to) }) };
      await fsp.rename(from, to);
      return { ok: true, path: to };
    } catch (e) { return { error: e.message || String(e) }; }
  });

  handler('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));

  handler('app:native-theme', ({ theme }) => {
    nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
  });

  // 图片粘贴/拖入：按内容 hash 去重保存到文档同目录 assets/
  handler('img:save', async ({ dataB64, baseDir, suggestedName }, win) => {
    const buf = Buffer.from(dataB64, 'base64');
    const dir = baseDir && fs.existsSync(baseDir) ? baseDir : app.getPath('pictures');
    const assetsDir = path.join(dir, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
    const ext = (suggestedName && /\.([a-z0-9]+)$/i.test(suggestedName)) ? RegExp.$1.toLowerCase() : 'png';
    let name = `image-${hash}.${ext}`;
    let full = path.join(assetsDir, name);
    if (!fs.existsSync(full)) await fsp.writeFile(full, buf);
    const rel = 'assets/' + name;
    return { abs: full, rel };
  });

  handler('fs:read-base64', async ({ path: p }) => {
    try {
      const buf = await fsp.readFile(p);
      return { dataB64: buf.toString('base64'), mime: guessMime(p) };
    } catch (e) { return { error: String(e.message || e) }; }
  });

  handler('fs:read-text', async ({ path: p }) => {
    try { return { text: await fsp.readFile(p, 'utf8') }; }
    catch (e) { return { error: String(e.message || e) }; }
  });

  handler('export:pdf', async ({ html, suggestedName }, win) => {
    const r = await dialog.showSaveDialog(win, {
      title: i18n.t('dlg.exportPdf'),
      defaultPath: suggestedName || i18n.t('file.exportBase') + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    // dist55 修复2：printToPDF 不生成 PDF 书签（实测 4 组 options 均无 /Outlines）——
    // 先把隐藏窗口设成 PDF 内容区尺寸（A4 减页边距，96dpi）量出各标题的文档坐标 y，
    // 生成后按「内容区高度」折页码注入 /Outlines（addPdfOutline，异常自动回退无书签）
    const A4W = Math.round(210 / 25.4 * 96); // 794
    const A4H = Math.round(297 / 25.4 * 96); // 1123
    const margins = { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 };
    const pageW = A4W - Math.round((margins.left + margins.right) * 96);
    const pageH = A4H - Math.round((margins.top + margins.bottom) * 96);
    const w = await renderHidden(html);
    try {
      let marks = [];
      try {
        w.setContentSize(pageW, 900, false);
        await sleep(250);
        marks = await withTimeout(20000, w.webContents.executeJavaScript(
          'Array.from(document.querySelectorAll(\'h1,h2,h3,h4,h5,h6\')).slice(0, 500).map(h => ({ t: (h.textContent || \'\').trim(), l: +h.tagName[1], y: h.getBoundingClientRect().top + window.scrollY })).filter(m => m.t)'
        ));
      } catch (e) { /* 量页失败不阻塞导出，只是没有书签 */ }
      const pdf = await withTimeout(120000, w.webContents.printToPDF({ printBackground: true, margins: margins, pageSize: 'A4' }));
      const out = (marks && marks.length) ? addPdfOutline(pdf, marks, pageH) : pdf;
      await fsp.writeFile(r.filePath, out);
      return { ok: true, path: r.filePath, outlines: (marks && marks.length) || 0 };
    } catch (err) {
      return { error: String(err.message || err) };
    } finally {
      w.destroy();
    }
  });

  handler('export:html', async ({ html, suggestedName }, win) => {
    const r = await dialog.showSaveDialog(win, {
      title: i18n.t('dlg.exportHtml'),
      defaultPath: suggestedName || i18n.t('file.exportBase') + '.html',
      filters: [{ name: 'HTML', extensions: ['html'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    await fsp.writeFile(r.filePath, html, 'utf8');
    return { ok: true, path: r.filePath };
  });

  // R87：导出 Word（.docx / .doc）——真实 OOXML 容器（含可编辑公式/标题样式/删除线/任务列表/表格）
  handler('export:doc', async ({ parts, suggestedName }, win) => {
    const r = await dialog.showSaveDialog(win, {
      title: i18n.t('dlg.exportDoc'),
      defaultPath: suggestedName || i18n.t('file.exportBase') + '.docx',
      filters: [
        { name: i18n.t('dlg.mdDoc'), extensions: ['docx'] },
        { name: i18n.t('dlg.mdDoc97'), extensions: ['doc'] },
        { name: i18n.t('dlg.all'), extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    try {
      const entries = (parts || []).map(p => ({ name: p.name, buf: Buffer.from(p.b64 || '', 'base64') }));
      if (!entries.length) return { error: i18n.t('toast.docNoContent') };
      const zip = makeZip(entries);
      await fsp.writeFile(r.filePath, zip);
      return { ok: true, path: r.filePath, bytes: zip.length };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  // dist59：导出为图片（PNG/JPEG）——隐藏窗口渲染后 capturePage 截图。
  //  · 不再按 16000px 高度上限降采样（那是"压缩变糊"的根源）→ 改「超长文档自动分片」：
  //    每片设备高度 ≤16000px，文件名 xxx_000 / xxx_001 …；短文档仍单张（无后缀）。
  //  · 新增 DPI：写入图片物理分辨率元数据（PNG pHYs / JPEG JFIF），缺省 300。
  //  · 格式由「保存位置」路径扩展名决定（.jpg/.jpeg→JPEG，其余→PNG），不再单设格式选项。
  handler('export:image', async ({ html, suggestedName, scale: reqScale, dpi, filePath: reqPath }, win) => {
    let filePath = reqPath;
    if (!filePath) {
      const r = await dialog.showSaveDialog(win, {
        title: i18n.t('dlg.exportImage'),
        defaultPath: suggestedName || i18n.t('file.exportBase') + '.png',
        filters: [
          { name: 'PNG (*.png)', extensions: ['png'] },
          { name: 'JPEG (*.jpg)', extensions: ['jpg', 'jpeg'] }
        ]
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      filePath = r.filePath;
    }
    const dir = path.dirname(filePath);
    let mExt = (path.basename(filePath).match(/\.([a-z0-9]+)$/i) || [])[1] || 'png';
    if (mExt === 'jpeg') mExt = 'jpg';
    const baseNoExt = path.basename(filePath).replace(/\.([a-z0-9]+)$/i, '');
    const isJpeg = (mExt === 'jpg');
    const dpiVal = (typeof dpi === 'number' && isFinite(dpi) && dpi >= 1) ? Math.round(dpi) : 300;

    const w = await renderHidden(html);
    try {
      const wc = w.webContents;
      // dist56 修复1：等 readyState=complete + 图片加载 + 字体就绪（did-finish-load 会被 404 子资源挂起 30s+）
      await withTimeout(30000, (async () => {
        while (true) {
          const s = await wc.executeJavaScript('({ rs: document.readyState, imgs: (document.images || []).length ? Array.from(document.images).every(i => i.complete) : true })');
          if (s && s.rs === 'complete' && s.imgs) break;
          await sleep(120);
        }
        try { await wc.executeJavaScript('document.fonts ? document.fonts.ready : 1'); } catch (e) {}
      })());
      await sleep(200); // reflow 结算
      const CAP = 16000; // Electron/skia 单侧截图上限（设备像素）
      const MAX_SCALE = 4;
      const req = (typeof reqScale === 'number' && isFinite(reqScale)) ? Math.min(MAX_SCALE, Math.max(1, reqScale)) : 2;
      // dist61：固定阅读宽度（EXPORT_W=880）定倍率与出图宽——宽度不再测量、不再瞬变（880×4<16000→倍率恒为所选）
      const scale = Math.min(req, CAP / EXPORT_W);
      const sliceBaseH = Math.max(1, Math.floor(CAP / scale)); // 每片 CSS 高 → 设备高 = sliceBaseH×scale ≤ CAP
      await settleExportWidth(w, wc, scale); // 锁定 880 宽 + 缩放，正文按最终宽度 reflow 结算（消除 432 窄态瞬变）
      // dist60：轮询到高度「连续两次一致」再取（宽度已锁定 880，只高度在变）——杜绝 scrollHeight 虚高→尾部空白分片
      const b = await withTimeout(8000, measureStable(wc, 3000));
      const N = Math.max(1, Math.ceil(b.h / sliceBaseH));

      const files = [];
      for (let i = 0; i < N; i++) {
        const tileBaseH = Math.min(sliceBaseH, b.h - i * sliceBaseH);
        const offset = i * sliceBaseH;
        // dist59 分片：整页内容上移 offset（负 margin 纯 CSS 位移，无滚动/区域截图的 VDI 不确定性），窗口只显示第 i 片
        try { await wc.executeJavaScript('(function(){ document.documentElement.style.overflow="hidden"; document.body.style.overflow="hidden"; document.body.style.marginTop = "-' + offset + 'px"; })()'); } catch (e) {}
        await sleep(120);
        w.setContentSize(Math.round(EXPORT_W * scale), Math.round(tileBaseH * scale), false); // 固定宽度 880
        await sleep(250);
        let img = null;
        for (let a = 0; a < 2; a++) { // 截图失败重试一次
          try { img = await withTimeout(30000, wc.capturePage()); } catch (e) { img = null; }
          if (img && !img.isEmpty()) break;
          img = null; await sleep(200);
        }
        if (!img || img.isEmpty()) return { error: 'capture failed (tile ' + i + ' of ' + N + ')' };
        // dist61：空白片检测——baseH 虚高时内容之后的分片是纯白；遇到空白片即内容已结束，
        // 丢弃该片及后续（不写出），不再多出空白图。首片就空白说明文档为空/渲染失败 → 报错。
        if (isBlankTile(img)) {
          try { img.destroy(); } catch (e) {}
          if (i === 0) return { error: 'export produced a blank image (empty document?)' };
          break;
        }
        let buf = isJpeg ? img.toJPEG(92) : img.toPNG();
        buf = isJpeg ? stampJpegDpi(buf, dpiVal) : stampPngDpi(buf, dpiVal);
        const fn = (N === 1) ? (baseNoExt + '.' + mExt) : (baseNoExt + '_' + String(i).padStart(3, '0') + '.' + mExt);
        const fp = path.join(dir, fn);
        await withTimeout(60000, fsp.writeFile(fp, buf));
        const isz = img.getSize ? img.getSize() : { width: 0, height: 0 };
        files.push({ path: fp, bytes: buf.length, imgW: isz.width, imgH: isz.height });
      }
      const first = files[0];
      return { ok: true, path: first.path, bytes: first.bytes, scale: Math.round(scale * 100) / 100, reqScale: req, dpi: dpiVal, baseW: b.w, baseH: b.h, tiles: files.length, imgW: first.imgW, imgH: first.imgH, files: files };
    } catch (err) {
      return { error: String(err.message || err) };
    } finally {
      w.destroy();
    }
  });

  // dist59：导出图片弹窗的「预计张数」预览——只渲染测量正文尺寸、不出图。
  // base 与倍率无关（CSS 像素）；渲染层据此按倍率本地算张数（同式：sliceBaseH=floor(16000/scale)，N=ceil(baseH/sliceBaseH)）。
  handler('export:measure-image', async ({ html }) => {
    const w = await renderHidden(html);
    try {
      const wc = w.webContents;
      await withTimeout(30000, (async () => {
        while (true) {
          const s = await wc.executeJavaScript('({ rs: document.readyState, imgs: (document.images || []).length ? Array.from(document.images).every(i => i.complete) : true })');
          if (s && s.rs === 'complete' && s.imgs) break;
          await sleep(120);
        }
        try { await wc.executeJavaScript('document.fonts ? document.fonts.ready : 1'); } catch (e) {}
      })());
      await sleep(200);
      // dist61：与 export:image 同——先锁固定阅读宽度（880，scale=1→CSS 视口 880）再轮询高度稳定，
      // 弹窗预估张数与实际导出一致（消除首帧 432 窄态导致的高度虚高→预估张数虚多）
      await settleExportWidth(w, wc, 1);
      const b = await withTimeout(8000, measureStable(wc, 3000));
      return { ok: true, baseW: b.w, baseH: b.h, cap: 16000, maxScale: 4 };
    } catch (err) {
      return { error: String(err.message || err) };
    } finally {
      w.destroy();
    }
  });

  // dist58：导出图片弹窗里的「浏览…保存位置」——只弹系统保存框选路径，不导出；返回 {canceled, filePath}
  handler('dialog:pick-image-path', async ({ title, defaultPath }, win) => {
    const r = await dialog.showSaveDialog(win, {
      title: title || i18n.t('dlg.exportImage'),
      defaultPath: defaultPath || '',
      filters: [
        { name: 'PNG (*.png)', extensions: ['png'] },
        { name: 'JPEG (*.jpg)', extensions: ['jpg', 'jpeg'] }
      ]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    return { canceled: false, filePath: r.filePath };
  });

  // dist53 功能3：渲染层切换语言 → 主进程跟随（系统对话框即时生效 + 重建托盘菜单）
  handler('app:set-language', async ({ lang }) => {
    applyMainLang(lang);
    return { ok: true };
  });

  handler('print:doc', async ({ html }) => {
    const w = await renderHidden(html);
    try {
      w.webContents.print({ silent: false, printBackground: true }, () => w.destroy());
      return { ok: true };
    } catch (err) {
      w.destroy();
      return { error: String(err.message || err) };
    }
  });

  handler('msg:confirm', async ({ message, detail, buttons }, win) => {
    const r = await dialog.showMessageBox(win, {
      type: 'question', message, detail: detail || '', buttons: buttons || [i18n.t('common.ok'), i18n.t('common.cancel')], noLink: true, cancelId: (buttons || [i18n.t('common.ok'), i18n.t('common.cancel')]).length - 1
    });
    return r.response;
  });

  // R72：拖入文件「新窗口打开」——新窗口目录 = 首个文件所在目录，其余文件一并打开
  // R73：标签拖出拆新窗口也走这里（x/y=源窗口右下方偏移）；返回窗口 id 供
  // 渲染层在「拖回原窗口/落到另一窗口」时关掉这个预览窗口
  handler('window:new', ({ path: p, folder: f, files: extra, x, y }) => {
    const win = createWindow(p || null, {
      folder: f || undefined,
      x,
      y,
      extraFiles: Array.isArray(extra) ? extra.filter((x2) => typeof x2 === 'string' && x2) : undefined
    });
    return { id: win.id };
  });

  // R73：渲染层主动查询本窗口 id（标签跨窗口拖拽的源窗口 id）
  handler('win:self-id', (p, win) => (win && !win.isDestroyed()) ? win.id : null);

  // R73：关掉「标签拖出」产生的预览窗口——仅当无未保存改动（__dirty 由渲染层
  // doc:state 上报，含任一脏标签）；脏时保留窗口，绝不留丢数据的口子
  handler('win:close-by-id', ({ id }) => {
    let w = null;
    for (const x of wins) { if (x.id === id && !x.isDestroyed()) { w = x; break; } }
    if (!w) return false;
    if (w.__dirty) return { skipped: 'dirty' };
    w.__closing = true;
    try { w.destroy(); } catch (e) { }
    return true;
  });

  // R73：跨窗口拖标签——目标窗口已在本窗口打开该文件，转告源窗口（按 id 找）移除
  handler('win:tab-moved', ({ path: p, from }) => {
    for (const w of wins) {
      if (w.id === from && !w.isDestroyed()) {
        try { w.webContents.send('win:remote-tab-moved', { path: p }); } catch (e) { }
        return true;
      }
    }
    return false;
  });

  // R75-5：拖拽「未保存标签」开新窗口——内容暂存于 pendingUnsaved，新窗口按 token 取走
  handler('win:open-unsaved', ({ name, path: p, content, x, y }) => {
    const token = 'u' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    pendingUnsaved.set(token, { name: name || i18n.t('name.untitled'), path: p || null, content: content || '' });
    setTimeout(() => pendingUnsaved.delete(token), 5 * 60 * 1000); // 兜底清理
    const win = createWindow(null, { x, y, unsavedToken: token });
    return { id: win.id };
  });
  // R75-5：新窗口渲染层按 token 取走暂存的未保存内容（取后即删，防串窗）
  handler('win:take-unsaved', ({ token }) => {
    const p = pendingUnsaved.get(token);
    pendingUnsaved.delete(token);
    return p || null;
  });
  // R75-6：未保存标签被拖到另一窗口打开 → 转告源窗口（按 id 找）移除该标签
  handler('win:remote-unsaved-moved', ({ tabId, from }) => {
    for (const w of wins) {
      if (w.id === from && !w.isDestroyed()) {
        try { w.webContents.send('win:remote-unsaved-moved', { tabId }); } catch (e) { }
        return true;
      }
    }
    return false;
  });
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' })[ext] || 'image/png';
}

// ---------------------------------------------------------------- 系统托盘（R53-8）
// Windows 任务栏通知区常驻应用图标；右键菜单：打开 MarkStudio / 最近打开 / 新建文件 / 退出。
// 全部窗口关闭后不再退出（Windows 下驻留托盘，仅托盘「退出 MarkStudio」退出）；
// 冒烟模式（MARKSTUDIO_SMOKE）保持原行为——最后一个窗口关闭即退出，冒烟脚本才能结束
// 动态托盘菜单的正确姿势（dist20 用户报障修复）：Electron 31 的 Menu 实例没有
// removeAll，clear() 实测是 no-op——托盘原生子菜单是 setContextMenu 时的快照，
// 事后再往旧 Menu 实例里增删都不会反映到显示出的菜单。所以「最近打开」变化时
// 整体重建菜单并重新 setContextMenu（初始建托盘 + pushRecent/重命名/清空时各重建一次）
// 「最小化到托盘」动作的跨平台实现：Windows 有常驻托盘 → 隐藏窗口（可从托盘恢复）；
// Linux 无常驻托盘 → 用系统最小化（任务栏可恢复），避免窗口隐藏后无从找回。
function hideToTrayOrMinimize(win) {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'win32' && tray) { try { win.hide(); return; } catch (e) { } }
  try { win.minimize(); } catch (e) { }
}
let tray = null;
function trayOpenApp() {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  else createWindow(null);
}
function trayNewFile() {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    try { win.webContents.send('tray:new-file'); } catch (e) { }
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  } else createWindow(null, { trayNewFile: true });
}
function trayOpenPath(p) {
  const w = BrowserWindow.getAllWindows()[0];
  // R69：窗口可能藏在托盘（hide）——先 show 再打开文件，否则文件开了窗口却看不见
  if (w) { w.show(); w.focus(); openPathIn(w, p); } else createWindow(p);
}
function trayRebuildRecent() {
  if (!tray) return;
  const recent = (loadStore().recent || []).slice(0, 5);
  const sub = recent.length
    ? recent.map((p) => ({ label: path.basename(p), title: p, click: () => trayOpenPath(p) }))
    : [{ label: i18n.t('tray.noRecent'), enabled: false }];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: i18n.t('tray.open'), click: trayOpenApp },
    { label: i18n.t('tray.recent'), submenu: sub },
    { label: i18n.t('tray.newFile'), click: trayNewFile },
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => app.quit() }
  ]));
}
function createTray() {
  if (tray) return;
  // 用 32px 位图：Win11 托盘 1x 取 16px、2x 取 32px，比直接丢 256px 源图清晰
  const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icon.png'));
  const t = new Tray(img.isEmpty() ? img : img.resize({ width: 32, height: 32 }));
  tray = t;
  t.setToolTip('MarkStudio');
  trayRebuildRecent();
  // Windows 托盘左键单击=打开（与右键菜单并存）
  t.on('click', trayOpenApp);
}
app.on('will-quit', () => { trayIconVisible = false; if (tray) { tray.destroy(); tray = null; } });
// R74：托盘图标在应用运行期间常驻（覆盖 R71 的「窗口可见时隐藏」互斥）：
// 用户澄清——任务栏的窗口按钮是「活动图标」（一个窗口一个），最右侧托盘图标
// 只要软件打开就必须一直在（右键菜单：最近打开 / 新建文件 / 退出 MarkStudio）。
// 退出应用时由 will-quit 销毁托盘。
// 注意：Electron 31 的 Tray 没有 show()/hide() API，显隐只能 destroy/重建
let trayIconVisible = false;
function showTrayIcon() {
  if (trayIconVisible || appQuitting || process.platform !== 'win32') return;
  // R76-2：测试/调试实例（MARKSTUDIO_NO_TRAY）不建托盘——它们用独立 userData 会绕过
  // 单实例锁与正式实例并存，各建一个托盘图标，用户在系统托盘里就会看到两个 MarkStudio。
  // 正式发行版不设该环境变量，托盘行为不变。
  if (process.env.MARKSTUDIO_NO_TRAY) return;
  createTray();
  trayIconVisible = true;
}
function hideTrayIcon() {
  if (!trayIconVisible) return;
  trayIconVisible = false;
  try { if (tray) { tray.destroy(); tray = null; } } catch (e) { }
}
function syncTrayVisibility() {
  showTrayIcon(); // R74：常驻——窗口 show/hide 只确保托盘存在，不再按可见性隐藏
}

// ---------------------------------------------------------------- 启动
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    // R40：拖拽多个文件到运行中的程序 → 逐个打开（渲染层 openPath 自带去重/激活）
    const files = filesFromArgv(argv);
    const win = BrowserWindow.getAllWindows()[0];
    if (files.length && win) { win.show(); win.focus(); files.forEach((f) => openPathIn(win, f)); }
    else if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } // R69：托盘隐藏窗口也要 show
    else createWindow(files[0] || null, { extraFiles: files.slice(1) });
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = getSettings().theme === 'dark' ? 'dark' : 'light';
    aumidSupportedCheck(); // R73-1：探测系统是否支持窗口级 AUMID（无则后续不再尝试）
    registerIpc();
    rebuildMenus();
    if (process.platform === 'win32') { createTray(); trayIconVisible = true; } // R53-8：Windows 任务栏托盘图标（R74 起运行期间常驻）
    const files = filesFromArgv(process.argv);
    const smoke = !!process.env.MARKSTUDIO_SMOKE;
    createWindow(files[0] || null, { smoke, maximized: !!process.env.MARKSTUDIO_MAX, debug: !!process.env.MARKSTUDIO_DEBUG, extraFiles: files.slice(1) });
  });

  app.on('window-all-closed', () => {
    // R53-8：Windows 下全部窗口关闭后驻留托盘（托盘图标常驻，右键「退出 MarkStudio」才退出）；
    // 冒烟模式与其余平台保持「最后一个窗口关闭即退出」。
    // R61：app.quit() 的完成依赖 window-all-closed 的默认退出行为——被这里的驻留逻辑
    // 吞掉后「退出」永远退不出（窗口已关、进程常驻、托盘点击无窗口可恢复）。
    // 正式退出（before-quit 已置 appQuitting：托盘「退出」/closeAction=quit/系统关机）时放行
    if (process.env.MARKSTUDIO_SMOKE) { app.quit(); return; }
    if (process.platform === 'win32' && !appQuitting) return;
    app.quit();
  });
}
