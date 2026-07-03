#!/usr/bin/env node
// 纯 Node PNG 图标生成器（零依赖）。生成 PWA/桌面所需图标到 remote/web/icons/。
// 图案：深色圆角底 + 绿色对话气泡（呼应"远程查看会话"），maskable 安全区居中。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "icons");

// —— 最小 PNG 编码（RGBA / 8bit / truecolor+alpha）——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rows with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// —— 绘制 ——
function roundRectHit(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  if (dx <= 0 && Math.abs(y - cy) <= h / 2) return true;
  if (dy <= 0 && Math.abs(x - cx) <= w / 2) return true;
  return dx > 0 && dy > 0 && dx * dx + dy * dy <= r * r;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 512; // 以 512 为基准缩放
  const bg = [18, 23, 29]; // #12171d 铺满（maskable 无透明角）
  const bubble = [52, 209, 127]; // #34d17f
  const line = [10, 30, 20];
  // 气泡几何（居中安全区）
  const cx = 256 * s, cy = 238 * s;
  const bw = 300 * s, bh = 220 * s, br = 52 * s;
  // 尾巴三角（左下）
  const tailX = 176 * s, tailBaseY = cy + bh / 2 - 8 * s, tailTipX = 132 * s, tailTipY = cy + bh / 2 + 46 * s;
  // 气泡内两条横线
  const lines = [
    { y: 210 * s, w: 190 * s },
    { y: 262 * s, w: 128 * s },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = bg;
      // 气泡
      if (roundRectHit(x, y, cx, cy, bw, bh, br)) c = bubble;
      // 尾巴（简单三角：tailTip 到 tailBase 区间的斜边）
      if (y > cy && y < tailTipY && x < tailX && x > tailTipX) {
        const t = (y - tailBaseY) / (tailTipY - tailBaseY);
        const leftEdge = tailX - t * (tailX - tailTipX);
        if (x > leftEdge && y < tailBaseY + (tailTipY - tailBaseY)) c = bubble;
      }
      // 气泡内横线
      for (const ln of lines) {
        if (roundRectHit(x, y, cx - (300 * s - ln.w) / 2 + (300 * s - 220 * s) / 2, ln.y, ln.w, 26 * s, 13 * s)) {
          if (roundRectHit(x, y, cx, cy, bw - 20 * s, bh - 20 * s, br)) c = line;
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512, 180]) {
  const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  writeFileSync(join(OUT, name), render(size));
  console.log(`生成 icons/${name} (${size}x${size})`);
}
