// Builds the demo slider background used by the README examples (no deps).
// Run: node demo/make-bg.mjs
// real `slider` output. Not part of the shipped library.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const W = 360, H = 180;
const NOTCH_X = 120, NOTCH_W = 30, NOTCH_Y = 20, NOTCH_H = 80;

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// raw scanlines: filter byte 0 + RGB triples
const raw = Buffer.alloc(H * (1 + W * 3));
let p = 0;
for (let y = 0; y < H; y++) {
  raw[p++] = 0;
  for (let x = 0; x < W; x++) {
    const inNotch = x >= NOTCH_X && x < NOTCH_X + NOTCH_W && y >= NOTCH_Y && y < NOTCH_Y + NOTCH_H;
    if (inNotch) {
      raw[p++] = 64; raw[p++] = 70; raw[p++] = 84;
    } else {
      // soft diagonal gradient so the border is the only hard edge
      const v = 232 + Math.round(12 * Math.sin((x * 0.045) + (y * 0.03)));
      raw[p++] = v; raw[p++] = v; raw[p++] = v - 3;
    }
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // colour type: truecolour RGB

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('demo', { recursive: true });
writeFileSync('demo/bg.png', png);
console.log(`demo/bg.png  ${png.length} bytes  ${W}x${H}  notch at x=${NOTCH_X} w=${NOTCH_W}`);
