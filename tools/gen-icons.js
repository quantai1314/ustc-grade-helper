// 用法: node tools/gen-icons.js  → 生成 icons/icon16|48|128.png（antd 蓝底白对勾）
const fs = require('fs');
const zlib = require('zlib');
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function genPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const [x1, y1, x2, y2, x3, y3] = [0.24 * size, 0.55 * size, 0.44 * size, 0.74 * size, 0.78 * size, 0.28 * size];
  const th = size * 0.09;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      const onCheck = distToSeg(x, y, x1, y1, x2, y2) < th / 2 || distToSeg(x, y, x2, y2, x3, y3) < th / 2;
      raw[o] = onCheck ? 255 : 22; raw[o + 1] = onCheck ? 255 : 119; raw[o + 2] = onCheck ? 255 : 255; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
fs.mkdirSync('icons', { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(`icons/icon${s}.png`, genPng(s));
console.log('icons generated');
