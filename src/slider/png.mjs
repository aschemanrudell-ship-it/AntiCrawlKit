/**
 * Minimal PNG decoder (zlib is in Node core).
 *
 * Why hand-rolled: the slider module has to look at the pixels a page actually
 * served, and every image library would be a runtime dependency plus a native
 * build. PNG's non-interlaced subset is small enough to own: IHDR + PLTE + IDAT,
 * five filter types, color types 0/2/3/4/6.
 *
 * Returns RGBA8 regardless of source layout so every downstream consumer sees
 * one shape.
 */
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @typedef {{width:number, height:number, data:Uint8Array}} RgbaImage */

export class PngError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PngError';
  }
}

/**
 * Decode a non-interlaced PNG buffer to RGBA8.
 * @param {Buffer|Uint8Array} input
 * @returns {RgbaImage}
 */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngError('not a PNG (bad signature)');
  }

  let pos = 8;
  /** @type {null | {width:number,height:number,bitDepth:number,colorType:number,interlace:number}} */
  let ihdr = null;
  /** @type {Buffer|null} */
  let palette = null;
  /** @type {Buffer|null} */
  let transparency = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    const end = start + length;
    if (end + 4 > buf.length) throw new PngError(`truncated chunk ${type}`);
    const data = buf.subarray(start, end);
    pos = end + 4; // skip CRC (we do not verify it: decode tolerance matters more here)

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new PngError('missing IHDR');
  if (!idat.length) throw new PngError('missing IDAT');
  if (ihdr.interlace !== 0) {
    throw new PngError('interlaced (Adam7) PNG is not supported; use a non-interlaced source');
  }
  if (![1, 2, 4, 8, 16].includes(ihdr.bitDepth)) {
    throw new PngError(`unsupported bit depth ${ihdr.bitDepth}`);
  }

  const channels = channelCount(ihdr.colorType);
  if (channels === 0) throw new PngError(`unsupported color type ${ihdr.colorType}`);
  if (ihdr.colorType === 3 && !palette) throw new PngError('palette PNG without PLTE');

  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * ihdr.bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const bytesPerRow = Math.ceil((ihdr.width * bitsPerPixel) / 8);

  if (raw.length < (bytesPerRow + 1) * ihdr.height) {
    throw new PngError(`inflated data too short: ${raw.length} < ${(bytesPerRow + 1) * ihdr.height}`);
  }

  const scan = new Uint8Array(bytesPerRow * ihdr.height);
  unfilter(raw, scan, bytesPerRow, ihdr.height, bytesPerPixel);

  const out = new Uint8Array(ihdr.width * ihdr.height * 4);
  materialize(scan, out, ihdr, palette, transparency, bytesPerRow);
  return { width: ihdr.width, height: ihdr.height, data: out };
}

function channelCount(colorType) {
  switch (colorType) {
    case 0: return 1; // grayscale
    case 2: return 3; // rgb
    case 3: return 1; // palette index
    case 4: return 2; // gray + alpha
    case 6: return 4; // rgba
    default: return 0;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverse the per-row PNG filters in place. */
function unfilter(raw, out, bytesPerRow, height, bpp) {
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const rowStart = y * bytesPerRow;
    const prevStart = (y - 1) * bytesPerRow;
    for (let i = 0; i < bytesPerRow; i++) {
      const x = raw[rp + i];
      const a = i >= bpp ? out[rowStart + i - bpp] : 0;
      const b = y > 0 ? out[prevStart + i] : 0;
      const c = y > 0 && i >= bpp ? out[prevStart + i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new PngError(`bad filter type ${filter} on row ${y}`);
      }
      out[rowStart + i] = v & 0xff;
    }
    rp += bytesPerRow;
  }
}

/** Expand packed samples / palette / gray to RGBA8. */
function materialize(scan, out, ihdr, palette, transparency, bytesPerRow) {
  const { width, height, bitDepth, colorType } = ihdr;
  const channels = channelCount(colorType);
  const sampleOf = (rowOff, index) => {
    // index = sample index within the row (0-based)
    if (bitDepth === 8) return scan[rowOff + index];
    if (bitDepth === 16) return scan[rowOff + index * 2]; // high byte: 8-bit fidelity is enough here
    const bitPos = index * bitDepth;
    const byte = scan[rowOff + (bitPos >> 3)];
    const shift = 8 - bitDepth - (bitPos & 7);
    const mask = (1 << bitDepth) - 1;
    return (byte >> shift) & mask;
  };
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;

  for (let y = 0; y < height; y++) {
    const rowOff = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sampleOf(rowOff, x);
        const p = idx * 3;
        out[o] = palette[p] ?? 0;
        out[o + 1] = palette[p + 1] ?? 0;
        out[o + 2] = palette[p + 2] ?? 0;
        out[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
        continue;
      }
      const base = x * channels;
      if (colorType === 0) {
        const g = Math.round(sampleOf(rowOff, base) * scale);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = 255;
      } else if (colorType === 4) {
        const g = sampleOf(rowOff, base);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = sampleOf(rowOff, base + 1);
      } else if (colorType === 2) {
        out[o] = sampleOf(rowOff, base);
        out[o + 1] = sampleOf(rowOff, base + 1);
        out[o + 2] = sampleOf(rowOff, base + 2);
        out[o + 3] = 255;
      } else {
        out[o] = sampleOf(rowOff, base);
        out[o + 1] = sampleOf(rowOff, base + 1);
        out[o + 2] = sampleOf(rowOff, base + 2);
        out[o + 3] = sampleOf(rowOff, base + 3);
      }
    }
  }
}

/**
 * Luminance (Rec. 601), returned as Float32Array of 0..255.
 * @param {RgbaImage} img
 */
export function toGray(img) {
  const { width, height, data } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}
