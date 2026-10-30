import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, toGray } from '../src/slider/png.mjs';
import { columnEdgeEnergy, detectGap, matchTemplate, travelDistance } from '../src/slider/detect.mjs';
import { makePng, crop } from './helpers/png.mjs';

/** White canvas with a dark notch at [gapX, gapX + gapW). */
function notchImage({ width = 300, height = 150, gapX = 120, gapW = 40, gapTone = 60 } = {}) {
  const buf = makePng(width, height, (x) => {
    const inGap = x >= gapX && x < gapX + gapW;
    const v = inGap ? gapTone : 245;
    return [v, v, v, 255];
  });
  return decodePng(buf);
}

test('columnEdgeEnergy spikes on both notch borders', () => {
  const img = notchImage();
  const gray = toGray(img);
  const e = columnEdgeEnergy(gray, img.width, img.height);
  assert.ok(e[120] > 0, 'left border has energy');
  assert.ok(e[160] > 0, 'right border has energy');
  assert.equal(e[60], 0, 'flat area has no energy');
});

test('detectGap finds the notch with a known piece width', () => {
  const img = notchImage();
  const gap = detectGap(img, { pieceWidth: 40 });
  assert.equal(gap.method, 'edges');
  // A hard step edge is ambiguous to the pixel (119 vs 120); real sliders
  // tolerate several pixels, so ±1 is the honest precision claim.
  assert.ok(Math.abs(gap.x - 120) <= 1, `expected ~120, got ${gap.x}`);
  assert.equal(gap.width, 40);
  assert.ok(gap.score > 0);
});

test('detectGap finds the notch when the width is unknown', () => {
  const img = notchImage({ gapX: 90, gapW: 36 });
  const gap = detectGap(img);
  assert.ok(Math.abs(gap.x - 90) <= 2, `expected ~90, got ${gap.x}`);
  assert.ok(Math.abs(gap.width - 36) <= 3, `expected ~36, got ${gap.width}`);
});

test('detectGap returns ranked candidates', () => {
  const img = notchImage();
  const gap = detectGap(img, { pieceWidth: 40 });
  assert.ok(Array.isArray(gap.candidates));
  assert.ok(gap.candidates.length > 0);
  assert.equal(gap.candidates[0].x, gap.x);
  assert.ok(gap.candidates.every((c) => c.score <= gap.score));
});

test('detectGap on a flat image returns a low score instead of throwing', () => {
  const flat = decodePng(makePng(120, 80, () => [255, 255, 255, 255]));
  const gap = detectGap(flat, { pieceWidth: 30 });
  assert.equal(gap.score, 0);
  assert.equal(gap.method, 'edges');
});

/**
 * Aperiodic noise. Linear ramps (x*7 + y*13) look random but repeat under
 * translation modulo 256, which produces several near-perfect NCC matches and
 * makes the assertions meaningless.
 */
function noise(x, y, seed = 0) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return Math.floor((s - Math.floor(s)) * 256) & 0xff;
}

test('matchTemplate recovers the crop origin', () => {
  const bg = decodePng(
    makePng(200, 120, (x, y) => [noise(x, y, 1), noise(x, y, 2), noise(x, y, 3), 255]),
  );
  const piece = crop(bg, 72, 40, 32, 32);
  const hit = matchTemplate(bg, piece);
  assert.equal(hit.method, 'ncc');
  assert.equal(hit.x, 72);
  assert.equal(hit.y, 40);
  assert.ok(hit.score > 0.99, `score ${hit.score} should be ~1 for an exact crop`);
});

test('matchTemplate honours the opaque bounding box of a padded piece', () => {
  const bg = decodePng(makePng(180, 100, (x, y) => {
    const v = noise(x, y, 5);
    return [v, v, v, 255];
  }));
  // 24x24 padded piece with a 12x12 opaque core taken from (50, 30).
  const core = crop(bg, 50, 30, 12, 12);
  const padded = { width: 24, height: 24, data: new Uint8Array(24 * 24 * 4) };
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const s = (y * 12 + x) * 4;
      const d = ((y + 6) * 24 + (x + 6)) * 4;
      padded.data[d] = core.data[s];
      padded.data[d + 1] = core.data[s + 1];
      padded.data[d + 2] = core.data[s + 2];
      padded.data[d + 3] = 255;
    }
  }
  const hit = matchTemplate(bg, padded);
  assert.equal(hit.x, 50);
  assert.equal(hit.y, 30);
});

test('matchTemplate refuses a flat piece', () => {
  const bg = decodePng(makePng(60, 60, (x, y) => [x * 4, y * 4, 0, 255]));
  const flatPiece = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(200) };
  for (let i = 3; i < flatPiece.data.length; i += 4) flatPiece.data[i] = 255;
  assert.throws(() => matchTemplate(bg, flatPiece), /flat/);
});

test('matchTemplate refuses a fully transparent piece', () => {
  const bg = decodePng(makePng(40, 40, (x) => [x * 6, 0, 0, 255]));
  const empty = { width: 6, height: 6, data: new Uint8Array(6 * 6 * 4) };
  assert.throws(() => matchTemplate(bg, empty), /no opaque pixels/);
});

test('travelDistance scales into CSS pixels', () => {
  assert.equal(travelDistance({ width: 300 }, 120), 120);
  assert.equal(travelDistance({ width: 600 }, 240, { scale: 2 }), 120);
});
