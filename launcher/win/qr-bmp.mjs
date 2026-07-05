// 二维码 → BMP（24-bit 未压缩，白底黑点，含静区）。
// 选 BMP 是因为：node 内建即可手写（无需 zlib/PNG 编码器/第三方），且 WinForms
// PictureBox 原生可读。托盘因此保持极薄——只显示后端写好的图片。
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("./vendor/qrcode.cjs"); // Kazuhiko Arase, MIT（见 vendor/qrcode.cjs 头）
// 用 .cjs 后缀：本仓库 package.json 是 type:module，.js 会被当 ESM 解析导致 UMD 的
// module.exports 分支不执行、require 拿到空命名空间。.cjs 强制按 CommonJS 加载。

// 返回 n×n 的 0/1 矩阵（1=黑）。typeNumber 0 = 按数据量自动选版本。
export function qrMatrix(text, ecc = "M") {
  const qr = qrcode(0, ecc);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = new Array(n);
    for (let c = 0; c < n; c++) row[c] = qr.isDark(r, c) ? 1 : 0;
    rows.push(row);
  }
  return rows;
}

// 把 0/1 矩阵渲染成 24-bit BMP Buffer。quiet=静区模块数，targetPx=目标边长（自动定标）。
export function bmpFromMatrix(matrix, { quiet = 4, targetPx = 480 } = {}) {
  const n = matrix.length;
  const total = n + quiet * 2;
  const scale = Math.max(3, Math.floor(targetPx / total));
  const dim = total * scale;

  const rowBytes = dim * 3; // BGR
  const pad = (4 - (rowBytes % 4)) % 4; // 每行 4 字节对齐
  const stride = rowBytes + pad;
  const pixels = Buffer.alloc(stride * dim, 0xff); // 先全白

  for (let mr = 0; mr < n; mr++) {
    for (let mc = 0; mc < n; mc++) {
      if (matrix[mr][mc] !== 1) continue;
      const x0 = (mc + quiet) * scale;
      const y0 = (mr + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const yTop = y0 + dy;
        const bmpRow = dim - 1 - yTop; // BMP 自底向上：数组第 0 行是图像最底行
        let off = bmpRow * stride + x0 * 3;
        for (let dx = 0; dx < scale; dx++) {
          pixels[off] = 0; pixels[off + 1] = 0; pixels[off + 2] = 0; // 黑
          off += 3;
        }
      }
    }
  }

  const fileHeader = Buffer.alloc(14);
  fileHeader.write("BM", 0, "ascii");
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);       // 头大小
  dib.writeInt32LE(dim, 4);       // 宽
  dib.writeInt32LE(dim, 8);       // 高（正=自底向上）
  dib.writeUInt16LE(1, 12);       // 平面
  dib.writeUInt16LE(24, 14);      // bpp
  dib.writeUInt32LE(0, 16);       // BI_RGB 不压缩
  dib.writeUInt32LE(pixels.length, 20);
  dib.writeInt32LE(2835, 24);     // ~72 DPI
  dib.writeInt32LE(2835, 28);
  const fileSize = 14 + 40 + pixels.length;
  fileHeader.writeUInt32LE(fileSize, 2);
  fileHeader.writeUInt32LE(54, 10); // 像素数据偏移
  return Buffer.concat([fileHeader, dib, pixels]);
}

export function writeQrBmp(text, filePath, opts = {}) {
  writeFileSync(filePath, bmpFromMatrix(qrMatrix(text, opts.ecc), opts));
  return filePath;
}
