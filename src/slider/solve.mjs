/**
 * End-to-end slider solve over CDP.
 *
 * Pipeline: capture a screen region as PNG -> decode -> locate the notch ->
 * derive the travel distance with the real scale factor -> replay a human-ish
 * drag. Every step is exposed separately so a caller can drive only part of it
 * (for example, capture once and solve several frames offline).
 */
import { decodePng } from './png.mjs';
import { detectGap, matchTemplate } from './detect.mjs';
import { generateTrack, toCdpEvents, trackDuration } from './track.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Screenshot a CSS-pixel region and decode it.
 * @param {import('../lib/cdp.mjs').CdpClient} client
 * @param {{x:number,y:number,width:number,height:number,scale?:number}} clip
 * @returns {Promise<{image:{width:number,height:number,data:Uint8Array}, scaleFactor:number, clip:object}>}
 */
export async function captureRegion(client, clip) {
  const params = {
    format: 'png',
    clip: {
      x: clip.x,
      y: clip.y,
      width: clip.width,
      height: clip.height,
      scale: clip.scale ?? 1,
    },
    captureBeyondViewport: false,
  };
  const { data } = await client.send('Page.captureScreenshot', params);
  if (!data) throw new Error('Page.captureScreenshot returned no data');
  const image = decodePng(Buffer.from(data, 'base64'));
  // Chrome multiplies clip by the device scale factor; recover it from the
  // actual pixel width so distance arithmetic stays in CSS pixels.
  const scaleFactor = clip.width > 0 ? image.width / clip.width : 1;
  return { image, scaleFactor, clip };
}

/**
 * Locate the notch in an already-captured background.
 * @param {{width:number,height:number,data:Uint8Array}} background
 * @param {{piece?:{width:number,height:number,data:Uint8Array}, pieceWidth?:number, scaleFactor?:number}} [opts]
 */
export function locateGap(background, opts = {}) {
  const scaleFactor = opts.scaleFactor ?? 1;
  if (opts.piece) {
    const m = matchTemplate(background, opts.piece);
    return { ...m, distance: Math.round(m.x / scaleFactor) };
  }
  const g = detectGap(background, { pieceWidth: opts.pieceWidth });
  return { ...g, distance: Math.round(g.x / scaleFactor) };
}

/**
 * Replay a drag with per-move delays.
 * @param {import('../lib/cdp.mjs').CdpClient} client
 * @param {{from:{x:number,y:number}, distance:number, seed?:number, steps?:number,
 *          durationMs?:number, jitterY?:number, settleMs?:number}} opts
 */
export async function dragSlider(client, opts) {
  const track = generateTrack({
    distance: opts.distance,
    steps: opts.steps,
    seed: opts.seed,
    durationMs: opts.durationMs,
    jitterY: opts.jitterY,
  });
  const events = toCdpEvents(track.points, { startX: opts.from.x, startY: opts.from.y });

  for (const ev of events) {
    const { type, ...rest } = ev;
    await client.send('Input.dispatchMouseEvent', { type, ...rest });
    if (type === 'mouseMoved') {
      const idx = events.indexOf(ev);
      const dt = track.points[idx - 1]?.dt ?? 12;
      await sleep(dt);
    } else {
      await sleep(opts.settleMs ?? 30);
    }
  }

  return {
    distance: track.distance,
    overshoot: track.overshoot,
    moves: track.points.length,
    durationMs: trackDuration(track.points),
    seed: opts.seed ?? null,
  };
}

/**
 * Capture, solve, drag.
 * @param {import('../lib/cdp.mjs').CdpClient} client
 * @param {{region:{x:number,y:number,width:number,height:number},
 *          from:{x:number,y:number}, pieceRegion?:{x:number,y:number,width:number,height:number},
 *          pieceWidth?:number, seed?:number, durationMs?:number, dryRun?:boolean}} opts
 */
export async function solveAndDrag(client, opts) {
  const bg = await captureRegion(client, opts.region);
  let piece;
  let pieceScale = 1;
  if (opts.pieceRegion) {
    const cap = await captureRegion(client, opts.pieceRegion);
    piece = cap.image;
    pieceScale = cap.scaleFactor;
  }

  const gap = locateGap(bg.image, {
    piece,
    pieceWidth: opts.pieceWidth,
    scaleFactor: bg.scaleFactor,
  });

  if (piece && pieceScale !== bg.scaleFactor) {
    // The two captures disagree about pixel density; refuse rather than silently
    // produce a distance that is off by the ratio.
    throw new Error(
      `capture scale mismatch: background ${bg.scaleFactor} vs piece ${pieceScale}`,
    );
  }

  const result = {
    gap,
    distance: gap.distance,
    captureScale: bg.scaleFactor,
    region: opts.region,
  };

  if (opts.dryRun) return result;

  result.drag = await dragSlider(client, {
    from: opts.from,
    distance: gap.distance,
    seed: opts.seed,
    durationMs: opts.durationMs,
  });
  return result;
}
