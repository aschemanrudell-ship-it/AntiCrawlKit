/**
 * Gap localisation for slider CAPTCHAs.
 *
 * Two independent methods, because sites ship two different things:
 *
 *   detectGap(background)          - single image with the notch already drawn.
 *                                    Finds the pair of strong vertical edges at a
 *                                    plausible piece width separated by a darker
 *                                    interior.
 *   matchTemplate(background, piece) - two images (background + Jigsaw piece with
 *                                    alpha). Normalised cross-correlation over the
 *                                    piece's opaque pixels.
 *
 * Both return CSS-pixel-independent integer columns; the caller scales by
 * naturalWidth / clientWidth.
 */
import { toGray } from './png.mjs';

/**
 * Per-column vertical edge energy.
 * @param {Float32Array} gray
 * @param {number} width
 * @param {number} height
 * @param {{yFrom?:number, yTo?:number}} [opts]
 */
export function columnEdgeEnergy(gray, width, height, opts = {}) {
  const yFrom = Math.max(1, Math.floor(opts.yFrom ?? 0));
  const yTo = Math.min(height - 1, Math.ceil(opts.yTo ?? height));
  const e = new Float32Array(width);
  for (let x = 1; x < width - 1; x++) {
    let sum = 0;
    for (let y = yFrom; y < yTo; y++) {
      const i = y * width + x;
      sum += Math.abs(gray[i + 1] - gray[i - 1]);
    }
    e[x] = sum / Math.max(1, yTo - yFrom);
  }
  return e;
}

/** Mean luminance of a rectangular window. */
function windowMean(gray, width, x0, x1, yFrom, yTo) {
  let sum = 0;
  let n = 0;
  for (let y = yFrom; y < yTo; y++) {
    for (let x = x0; x < x1; x++) {
      sum += gray[y * width + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Find the notch in a single background image.
 *
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {{pieceWidth?:number, minPieceWidth?:number, maxPieceWidth?:number, yFromRatio?:number, yToRatio?:number}} [opts]
 * @returns {{x:number, width:number, score:number, method:'edges', candidates:Array<{x:number,width:number,score:number}>}}
 */
export function detectGap(img, opts = {}) {
  const { width, height } = img;
  const gray = toGray(img);
  const yFrom = Math.floor(height * (opts.yFromRatio ?? 0.05));
  const yTo = Math.ceil(height * (opts.yToRatio ?? 0.95));
  const energy = columnEdgeEnergy(gray, width, height, { yFrom, yTo });

  const fixed = opts.pieceWidth ?? null;
  const minW = Math.max(8, Math.floor(opts.minPieceWidth ?? (fixed ?? Math.round(width * 0.08))));
  const maxW = Math.min(
    Math.floor(width / 2),
    Math.ceil(opts.maxPieceWidth ?? (fixed ?? Math.round(width * 0.35))),
  );

  const globalMean = windowMean(gray, width, 0, width, yFrom, yTo);
  const scored = [];

  const widths = fixed ? [fixed] : range(minW, maxW);
  for (const w of widths) {
    for (let x = 0; x + w < width; x++) {
      // Both notch borders are vertical edges; a darker interior (the masked-out
      // region) separates a real notch from a busy photo.
      const edges = energy[x] + energy[x + w];
      const inside = windowMean(gray, width, x + 2, x + w - 1, yFrom, yTo);
      const darkness = Math.max(0, globalMean - inside) / 255; // 0..1
      const score = edges * (1 + 2.5 * darkness);
      if (score > 0) scored.push({ x, width: w, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0] ?? { x: 0, width: fixed ?? minW, score: 0 };
  return {
    x: best.x,
    width: best.width,
    score: Number(best.score.toFixed(4)),
    method: 'edges',
    candidates: scored.slice(0, 8).map((c) => ({ ...c, score: Number(c.score.toFixed(4)) })),
  };
}

/**
 * Normalised cross-correlation template match.
 *
 * @param {{width:number,height:number,data:Uint8Array}} bg
 * @param {{width:number,height:number,data:Uint8Array}} piece
 * @param {{yFrom?:number, yTo?:number, alphaThreshold?:number}} [opts]
 * @returns {{x:number, y:number, score:number, method:'ncc', candidates:Array<{x:number,y:number,score:number}>}}
 */
export function matchTemplate(bg, piece, opts = {}) {
  const bgGray = toGray(bg);
  const pGray = toGray(piece);
  const alphaThreshold = opts.alphaThreshold ?? 16;

  // Opaque bounding box of the piece: the Jigsaw piece has transparent padding.
  let px0 = piece.width;
  let px1 = -1;
  let py0 = piece.height;
  let py1 = -1;
  for (let y = 0; y < piece.height; y++) {
    for (let x = 0; x < piece.width; x++) {
      const a = piece.data[(y * piece.width + x) * 4 + 3];
      if (a > alphaThreshold) {
        if (x < px0) px0 = x;
        if (x > px1) px1 = x;
        if (y < py0) py0 = y;
        if (y > py1) py1 = y;
      }
    }
  }
  if (px1 < px0 || py1 < py0) {
    throw new Error('piece image has no opaque pixels; cannot template-match');
  }

  const pw = px1 - px0 + 1;
  const ph = py1 - py0 + 1;
  if (pw > bg.width || ph > bg.height) throw new Error('piece larger than background');

  // Pre-extract the template samples once.
  const n = pw * ph;
  const tpl = new Float64Array(n);
  let tSum = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const v = pGray[(py0 + y) * piece.width + (px0 + x)];
      tpl[y * pw + x] = v;
      tSum += v;
    }
  }
  const tMean = tSum / n;
  let tVarSum = 0;
  for (let i = 0; i < n; i++) {
    const d = tpl[i] - tMean;
    tVarSum += d * d;
  }
  const tStd = Math.sqrt(tVarSum);
  if (tStd < 1e-6) throw new Error('piece image is flat; cross-correlation is undefined');

  const yFrom = Math.max(0, Math.floor(opts.yFrom ?? 0));
  const yTo = Math.min(bg.height - ph, Math.ceil(opts.yTo ?? bg.height - ph));
  const results = [];

  // Two-pass statistics per window. The one-pass form (sumSq - n*mean^2)
  // cancels catastrophically at 8-bit magnitudes and turns flat patches into
  // spurious high scores.
  const flatEpsilon = n * 1e-6;

  for (let y = yFrom; y <= yTo; y++) {
    for (let x = 0; x <= bg.width - pw; x++) {
      let sum = 0;
      for (let ty = 0; ty < ph; ty++) {
        const row = (y + ty) * bg.width + x;
        for (let tx = 0; tx < pw; tx++) sum += bgGray[row + tx];
      }
      const mean = sum / n;

      let varSum = 0;
      let cov = 0;
      for (let ty = 0; ty < ph; ty++) {
        const row = (y + ty) * bg.width + x;
        const trow = ty * pw;
        for (let tx = 0; tx < pw; tx++) {
          const d = bgGray[row + tx] - mean;
          varSum += d * d;
          cov += d * (tpl[trow + tx] - tMean);
        }
      }
      if (varSum <= flatEpsilon) continue; // flat patch: no information
      const score = cov / (Math.sqrt(varSum) * tStd);
      results.push({ x, y, score });
    }
  }

  if (!results.length) throw new Error('no candidate position scored above zero variance');
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  return {
    x: best.x,
    y: best.y,
    score: Number(best.score.toFixed(4)),
    method: 'ncc',
    candidates: results.slice(0, 8).map((c) => ({ ...c, score: Number(c.score.toFixed(4)) })),
  };
}

/**
 * Slider travel distance from a matched piece position plus the handle offset.
 * @param {{width:number}} bg
 * @param {number} gapX
 * @param {{scale?:number}} [opts]
 */
export function travelDistance(bg, gapX, opts = {}) {
  const scale = opts.scale ?? 1;
  return Math.round(gapX / scale);
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}
