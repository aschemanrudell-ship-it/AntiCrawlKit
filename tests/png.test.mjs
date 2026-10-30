import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, toGray, PngError } from '../src/slider/png.mjs';
import { makePng } from './helpers/png.mjs';

test('decodes a 1x1 RGBA png', () => {
  const png = makePng(1, 1, () => [10, 20, 30, 255]);
  const img = decodePng(png);
  assert.equal(img.width, 1);
  assert.equal(img.height, 1);
  assert.deepEqual([...img.data], [10, 20, 30, 255]);
});

test('decodes a gradient exactly', () => {
  const png = makePng(4, 3, (x, y) => [x * 60, y * 80, 7, 255]);
  const img = decodePng(png);
  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      const o = (y * 4 + x) * 4;
      assert.deepEqual([img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]],
        [x * 60, y * 80, 7, 255]);
    }
  }
});

test('accepts a Buffer and a plain Uint8Array', () => {
  const png = makePng(2, 2, () => [1, 2, 3, 4]);
  assert.equal(decodePng(png).width, 2);
  assert.equal(decodePng(new Uint8Array(png)).width, 2);
});

test('rejects a non-png buffer', () => {
  assert.throws(() => decodePng(Buffer.from('not an image at all')), PngError);
});

test('rejects gif input', () => {
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
  assert.throws(() => decodePng(gif), /bad signature/);
});

test('reconstructs rows filtered with Sub, Up, Average and Paeth', () => {
  // Hand-build a 4x4 grayscale (colorType 0) image: one row per filter type.
  const width = 4;
  const height = 4;
  const source = [
    [10, 20, 30, 40],
    [15, 25, 35, 45],
    [20, 30, 40, 50],
    [25, 35, 45, 55],
  ];

  const filtered = [];
  for (let y = 0; y < height; y++) {
    const filter = y; // 0,1,2,3 (4 is paeth, add a 5th row below)
    const row = source[y];
    const prev = y > 0 ? source[y - 1] : [0, 0, 0, 0];
    const out = [];
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? row[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      let predicted;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else predicted = (a + b) >> 1;
      out.push((row[x] - predicted) & 0xff);
    }
    filtered.push({ filter, bytes: out });
  }
  // Fifth row exercises Paeth.
  {
    const y = 4;
    const row = [30, 40, 50, 60];
    const prev = source[3];
    const out = [];
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? row[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
        ? a
        : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out.push((row[x] - paeth) & 0xff);
    }
    filtered.push({ filter: 4, bytes: out });
  }

  const raw = Buffer.alloc(filtered.length * (width + 1));
  filtered.forEach((row, i) => {
    raw[i * (width + 1)] = row.filter;
    for (let x = 0; x < width; x++) raw[i * (width + 1) + 1 + x] = row.bytes[x];
  });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(5, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // grayscale
  const png = craftPng(ihdr, deflateSync(raw));

  const img = decodePng(png);
  const expected = [...source, [30, 40, 50, 60]];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      assert.equal(img.data[o], expected[y][x], `pixel ${x},${y}`);
      assert.equal(img.data[o + 1], expected[y][x]);
      assert.equal(img.data[o + 3], 255);
    }
  }
});

test('toGray uses Rec.601 weights', () => {
  const img = {
    width: 2,
    height: 1,
    data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
  };
  const g = toGray(img);
  assert.ok(Math.abs(g[0] - 0.299 * 255) < 0.01);
  assert.ok(Math.abs(g[1] - 0.114 * 255) < 0.01);
});

/* --------------------------------------------------------------- helpers */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function craftPng(ihdr, idat) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
