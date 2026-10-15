// 生成 NSIS 安装界面背景图（installer-bg.bmp，24 位 BMP）
// 风格：iOS 毛玻璃——浅冷白竖渐变 + 两团高斯柔光斑（蓝/靛蓝），
// 安装窗口欢迎/完成页整页铺底，与 App 内 Liquid Glass 视觉一致。
// 用法：node build/gen-bg.js [输出路径]（默认 build/installer-bg.bmp）
const fs = require('fs');
const path = require('path');
const W = 1000, H = 700;
// 竖渐变（顶→底）：#f8f9fd → #e7ecf8
const top = [248, 249, 253], bot = [231, 236, 248];
// 柔光斑：[cx, cy, sigma, 颜色, 峰值 alpha(0-255)]
const blobs = [
  [230, 120, 260, [10, 132, 255], 60],
  [860, 620, 300, [94, 92, 230], 48],
  [700, 90, 220, [10, 132, 255], 30]
];
const px = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const base = [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t];
  for (let x = 0; x < W; x++) {
    let r = base[0], g = base[1], b = base[2];
    for (const [cx, cy, sg, col, A] of blobs) {
      const dx = x - cx, dy = y - cy;
      const a = (A / 255) * Math.exp(-(dx * dx + dy * dy) / (2 * sg * sg));
      r = r * (1 - a) + col[0] * a;
      g = g * (1 - a) + col[1] * a;
      b = b * (1 - a) + col[2] * a;
    }
    const i = (y * W + x) * 3;
    px[i] = Math.max(0, Math.min(255, Math.round(b))); // BMP 存储 BGR
    px[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    px[i + 2] = Math.max(0, Math.min(255, Math.round(r)));
  }
}
// 24 位 BMP：行自下而上，行 padding 到 4 字节
const rowSize = W * 3;
const rowPad = (4 - (rowSize % 4)) % 4;
const rows = Buffer.alloc((rowSize + rowPad) * H);
for (let y = 0; y < H; y++) {
  px.copy(rows, y * (rowSize + rowPad), (H - 1 - y) * rowSize, (H - 1 - y) * rowSize + rowSize);
}
const size = 14 + 40 + rows.length;
const hdr = Buffer.alloc(54);
hdr.write('BM', 0, 'ascii');
hdr.writeUInt32LE(size, 2);
hdr.writeUInt32LE(0, 6);
hdr.writeUInt32LE(54, 10);
hdr.writeUInt32LE(40, 14); // BITMAPINFOHEADER
hdr.writeInt32LE(W, 18);
hdr.writeInt32LE(H, 22);
hdr.writeUInt16LE(1, 26);
hdr.writeUInt16LE(24, 28);
hdr.writeUInt32LE(0, 30);
hdr.writeUInt32LE(rows.length, 34);
hdr.writeInt32LE(2835, 38); // 72dpi
hdr.writeInt32LE(2835, 42);
hdr.writeUInt32LE(0, 46);
hdr.writeUInt32LE(0, 50);
const out = process.argv[2] || path.join(__dirname, 'installer-bg.bmp');
fs.writeFileSync(out, Buffer.concat([hdr, rows]));
console.log('WROTE', out, size, 'bytes');
