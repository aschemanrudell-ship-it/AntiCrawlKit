/**
 * Human-ish pointer tracks for drag interactions.
 *
 * A straight line with uniform timing is the single cheapest thing a bot
 * detection script can spot: real trajectories have a velocity envelope
 * (accelerate, cruise, decelerate), micro-jitter on both axes, and a small
 * overshoot-and-correct at the end.
 *
 * Everything here is pure: given a seed you get the same track back, so the
 * tests and the README examples are reproducible.
 */

/** mulberry32 - tiny deterministic PRNG. */
export function createRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Symmetric jitter in [-m, +m]. */
function jitter(rng, m) {
  return (rng() * 2 - 1) * m;
}

/**
 * Build an integer progress table from a trapezoidal velocity envelope.
 * @param {number} n number of intervals
 * @param {number} accel fraction of the track spent accelerating
 * @param {number} decel fraction spent decelerating
 * @param {() => number} rng
 */
function progressTable(n, accel, decel, rng) {
  const v = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    let raw;
    if (u <= accel) raw = u / accel;
    else if (u >= 1 - decel) raw = (1 - u) / decel;
    else raw = 1;
    // Cruise phase wobbles: humans do not hold a constant speed.
    v[i] = Math.max(0.02, raw) * (1 + jitter(rng, 0.06));
  }
  const total = v.reduce((s, x) => s + x, 0);
  const p = new Float64Array(n + 1);
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    acc += v[i];
    p[i] = acc / total;
  }
  p[n] = 1; // exact landing regardless of float drift
  return p;
}

/**
 * @param {{distance:number, steps?:number, seed?:number, jitterY?:number,
 *          overshootProbability?:number, durationMs?:number}} opts
 * @returns {{distance:number, durationMs:number, points:Array<{x:number,y:number,dt:number}>,
 *            overshoot:number}}
 */
export function generateTrack(opts) {
  const distance = Math.round(Number(opts.distance));
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error(`distance must be a positive number, got ${opts.distance}`);
  }
  const rng = opts.seed === undefined ? Math.random : createRng(opts.seed);
  const steps = Math.max(6, Math.min(160, opts.steps ?? Math.round(distance / 3) + 8));
  const durationMs = Math.max(
    220,
    Math.round(opts.durationMs ?? 260 + distance * 1.35 + jitter(rng, 60)),
  );
  const maxY = opts.jitterY ?? 2;
  const overshootProb = opts.overshootProbability ?? 0.6;

  const p = progressTable(steps, 0.22 + rng() * 0.1, 0.18 + rng() * 0.12, rng);

  /** @type {Array<{x:number,y:number,dt:number}>} */
  const points = [];
  let lastX = 0;
  let y = 0;

  for (let i = 1; i <= steps; i++) {
    const x = Math.round(distance * p[i]);
    const dt = Math.max(4, Math.round((durationMs / steps) * (0.82 + rng() * 0.36)));
    // Random walk on y, pulled back toward the axis so it never drifts away.
    y += jitter(rng, maxY);
    y = Math.max(-maxY, Math.min(maxY, y * 0.85));
    if (x === lastX) continue; // no zero-length move events
    points.push({ x, y: Math.round(y), dt });
    lastX = x;
  }

  // Overshoot then correct: the last human move is rarely pixel-perfect.
  let overshoot = 0;
  if (rng() < overshootProb && distance > 20) {
    overshoot = 1 + Math.floor(rng() * 3);
    points.push({ x: distance + overshoot, y: Math.round(y), dt: 12 + Math.floor(rng() * 10) });
    points.push({ x: distance, y: Math.round(y), dt: 18 + Math.floor(rng() * 14) });
  } else if (points.length && points[points.length - 1].x !== distance) {
    points.push({ x: distance, y: Math.round(y), dt: 14 + Math.floor(rng() * 10) });
  }

  return { distance, durationMs, points, overshoot };
}

/**
 * Turn track points into CDP `Input.dispatchMouseEvent` params.
 * @param {Array<{x:number,y:number,dt:number}>} points
 * @param {{startX:number, startY:number, button?:'left'|'right'|'middle'}} opts
 */
export function toCdpEvents(points, opts) {
  const button = opts.button ?? 'left';
  const x0 = opts.startX;
  const y0 = opts.startY;
  /** @type {Array<{type:string, x:number, y:number, button:string, buttons?:number, clickCount:number}>} */
  const events = [
    { type: 'mousePressed', x: x0, y: y0, button, clickCount: 1 },
  ];
  for (const p of points) {
    events.push({
      type: 'mouseMoved',
      x: x0 + p.x,
      y: y0 + p.y,
      button,
      buttons: 1,
      clickCount: 1,
    });
  }
  const last = points.length ? points[points.length - 1] : { x: 0, y: 0 };
  events.push({
    type: 'mouseReleased',
    x: x0 + last.x,
    y: y0 + last.y,
    button,
    clickCount: 1,
  });
  return events;
}

/**
 * Timeline helper: total wall-clock cost of a track, used to sanity-check that a
 * solve is not suspiciously fast.
 */
export function trackDuration(points) {
  return points.reduce((s, p) => s + p.dt, 0);
}
