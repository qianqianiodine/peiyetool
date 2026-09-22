/* 生成 PWA 图标 —— node tools/make-icons.js
 * 不引入任何依赖，用 zlib 手写 PNG。改图标设计后重跑即可。
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ── PNG 编码 ────────────────────────────────────────── */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;                                   // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── 图形：烧杯 + 液体 ───────────────────────────────── */
const BG     = [0x00, 0x66, 0x9b];   // #00669b 与 CSS 主色一致
const FG     = [0xff, 0xff, 0xff];
const LIQUID = [0x86, 0xc9, 0xec];

/**
 * @param size   画布边长
 * @param scale  图形相对画布的缩放（maskable 用更小的值留安全区）
 */
function drawIcon(size, scale) {
  const W = size, H = size;
  const buf = Buffer.alloc(W * H * 4);

  const s = scale || 1;
  const cx = W / 2;

  const topY = H * (0.5 - 0.235 * s);      // 杯口
  const botY = H * (0.5 + 0.245 * s);      // 杯底
  const wTop = W * 0.285 * s;              // 上沿半宽
  const wBot = W * 0.235 * s;              // 下沿半宽（收窄，成梯形）
  const sw   = W * 0.052 * s;              // 杯壁厚度
  const lip  = W * 0.048 * s;              // 杯口向外伸出的量
  const liqY = topY + (botY - topY) * 0.44;

  /** 某高度处的杯身半宽（线性收窄） */
  const halfAt = y => {
    const t = Math.max(0, Math.min(1, (y - topY) / (botY - topY)));
    return wTop + (wBot - wTop) * t;
  };

  const SS = 3;                             // 超采样抗锯齿
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const hw  = halfAt(py);
          const adx = Math.abs(px - cx);
          const inY = py >= topY && py <= botY;
          let col = BG;

          // 杯内：液面以下填液体，以上留空
          if (inY && adx < hw - sw * 0.5) col = py > liqY ? LIQUID : BG;
          // 左右杯壁
          if (inY && Math.abs(adx - hw) < sw * 0.5) col = FG;
          // 杯底
          if (Math.abs(py - botY) < sw * 0.5 && adx < hw) col = FG;
          // 杯口：横贯顶部并向外伸出，这是"它是烧杯不是盒子"的关键特征
          if (Math.abs(py - topY) < sw * 0.5 && adx < wTop + lip) col = FG;

          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const n = SS * SS, i = (y * W + x) * 4;
      buf[i]     = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = 255;
    }
  }
  return makePNG(W, H, buf);
}

/* ── 输出 ────────────────────────────────────────────── */
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ['icon-192.png',          192, 1.0],
  ['icon-512.png',          512, 1.0],
  ['icon-maskable-512.png', 512, 0.72]   // 安全区：图形缩到 72% 以内
];

targets.forEach(([name, size, scale]) => {
  const png = drawIcon(size, scale);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('  ✓ ' + name + '  ' + size + '×' + size + '  ' + (png.length / 1024).toFixed(1) + ' KB');
});
console.log('\n图标已生成到 icons/');
