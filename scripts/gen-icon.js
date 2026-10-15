// 生成应用图标：纯 Node 实现（PNG 编码 + ICO 组装），无外部依赖
// 图标：蓝紫渐变圆角方块 + 白色 M
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------- CRC32 ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------- 绘制 ----------------
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sdRoundBox(px, py, cx, cy, half, r) {
  const qx = Math.abs(px - cx) - (half - r);
  const qy = Math.abs(py - cy) - (half - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const gx = x1 + t * dx - px, gy = y1 + t * dy - py;
  return Math.sqrt(gx * gx + gy * gy);
}

function render(size) {
  const s = size / 1024;
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const radius = 224 * s;
  // M 轮廓（1024 坐标系）
  const pts = [[296, 760], [296, 300], [512, 570], [728, 300], [728, 760]].map(([x, y]) => [x * s, y * s]);
  const strokeHalf = 48 * s;
  const c1 = [86, 140, 255], c2 = [158, 96, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const i = (y * size + x) * 4;
      // 圆角方块（带抗锯齿）
      const sd = sdRoundBox(px, py, half, half, half - 0.5, radius);
      const cover = clamp(0.5 - sd, 0, 1);
      if (cover <= 0) continue;
      const t = clamp((px + py) / (2 * size), 0, 1);
      let r = c1[0] + (c2[0] - c1[0]) * t;
      let g = c1[1] + (c2[1] - c1[1]) * t;
      let b = c1[2] + (c2[2] - c1[2]) * t;
      // 白色 M
      let md = Infinity;
      for (let k = 0; k < pts.length - 1; k++) {
        md = Math.min(md, distToSegment(px, py, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
      }
      const mCover = clamp(strokeHalf + 0.5 - md, 0, 1);
      r = r + (255 - r) * mCover;
      g = g + (255 - g) * mCover;
      b = b + (255 - b) * mCover;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return rgba;
}

// ---------------- ICO ----------------
function bmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const maskRow = Math.ceil(size / 32) * 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y, dstRow = size - 1 - y; // 自底向上
    for (let x = 0; x < size; x++) {
      const si = (srcRow * size + x) * 4;
      const di = (dstRow * size + x) * 4;
      pixels[di] = rgba[si + 2];     // B
      pixels[di + 1] = rgba[si + 1]; // G
      pixels[di + 2] = rgba[si];     // R
      pixels[di + 3] = rgba[si + 3]; // A
    }
  }
  const mask = Buffer.alloc(maskRow * size); // 全 0（不透明由 alpha 决定）
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(sizes) {
  const entries = sizes.map((sz) => {
    const rgba = render(sz);
    if (sz >= 128) return { size: sz, data: encodePNG(rgba, sz, sz) };
    return { size: sz, data: bmpEntry(rgba, sz) };
  });
  const count = entries.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const dirEntries = [];
  const blobs = [];
  for (const e of entries) {
    const de = Buffer.alloc(16);
    de[0] = e.size % 256;
    de[1] = e.size % 256;
    de[2] = 0; de[3] = 0;
    de.writeUInt16LE(1, 4);
    de.writeUInt16LE(32, 6);
    de.writeUInt32LE(e.data.length, 8);
    de.writeUInt32LE(offset, 12);
    offset += e.data.length;
    dirEntries.push(de);
    blobs.push(e.data);
  }
  return Buffer.concat([dir, ...dirEntries, ...blobs]);
}

const outDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(outDir, { recursive: true });
const sizes = [256, 128, 64, 48, 32, 24, 16];
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(sizes));
// icon.png 用 512：既满足 Linux 打包（AppImage/deb/rpm 推荐 ≥512）也供托盘/界面徽标缩放使用
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(render(512), 512, 512));
console.log('[gen-icon] resources/icon.ico（256..16）与 icon.png（512×512）已生成');
