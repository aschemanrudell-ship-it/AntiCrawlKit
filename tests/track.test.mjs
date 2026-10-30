import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTrack, toCdpEvents, trackDuration, createRng } from '../src/slider/track.mjs';

test('a track always lands exactly on the requested distance', () => {
  for (const distance of [12, 37, 90, 137, 480]) {
    for (const seed of [1, 2, 3]) {
      const t = generateTrack({ distance, seed });
      assert.equal(t.points[t.points.length - 1].x, distance, `distance ${distance} seed ${seed}`);
    }
  }
});

test('the same seed produces the same track', () => {
  const a = generateTrack({ distance: 120, seed: 1234 });
  const b = generateTrack({ distance: 120, seed: 1234 });
  assert.deepEqual(a.points, b.points);
  assert.equal(a.durationMs, b.durationMs);
});

test('different seeds diverge', () => {
  const a = generateTrack({ distance: 200, seed: 1 });
  const b = generateTrack({ distance: 200, seed: 2 });
  assert.notDeepEqual(a.points, b.points);
});

test('moves are strictly increasing except the overshoot correction', () => {
  const t = generateTrack({ distance: 150, seed: 9 });
  let prev = 0;
  for (const p of t.points) {
    assert.ok(p.x >= 0, 'no negative positions');
    if (p.x < prev) {
      // The only backwards move allowed is the overshoot correction at the end.
      assert.equal(p.x, t.distance, 'backwards move must land on the target');
    }
    prev = p.x;
  }
});

test('y never drifts more than the jitter budget', () => {
  const t = generateTrack({ distance: 300, seed: 5, jitterY: 2 });
  for (const p of t.points) {
    assert.ok(Math.abs(p.y) <= 2, `y=${p.y}`);
  }
});

test('durations stay in a human range', () => {
  for (const distance of [10, 100, 600]) {
    const t = generateTrack({ distance, seed: 4 });
    const wall = trackDuration(t.points);
    assert.ok(wall >= 200, `too fast: ${wall}ms for ${distance}px`);
    assert.ok(wall <= 3000, `too slow: ${wall}ms for ${distance}px`);
  }
});

test('overshoot is occasionally produced and is small', () => {
  let seen = 0;
  for (let seed = 0; seed < 40; seed++) {
    const t = generateTrack({ distance: 200, seed, overshootProbability: 1 });
    if (t.overshoot > 0) {
      seen++;
      assert.ok(t.overshoot >= 1 && t.overshoot <= 3, `overshoot ${t.overshoot}`);
    }
  }
  assert.equal(seen, 40, 'overshootProbability=1 must always overshoot');
});

test('rejects a non-positive distance', () => {
  assert.throws(() => generateTrack({ distance: 0 }), /positive/);
  assert.throws(() => generateTrack({ distance: -10 }), /positive/);
});

test('toCdpEvents brackets the moves with press and release', () => {
  const t = generateTrack({ distance: 80, seed: 11 });
  const events = toCdpEvents(t.points, { startX: 40, startY: 300 });
  assert.equal(events[0].type, 'mousePressed');
  assert.equal(events[0].x, 40);
  assert.equal(events[0].y, 300);
  assert.equal(events.at(-1).type, 'mouseReleased');
  const moves = events.filter((e) => e.type === 'mouseMoved');
  assert.equal(moves.length, t.points.length);
  assert.equal(moves[0].x, 40 + t.points[0].x);
  assert.ok(moves.every((m) => m.buttons === 1), 'drag moves must carry the button mask');
  assert.equal(events.at(-1).x, 40 + t.distance);
});

test('toCdpEvents honours the button choice', () => {
  const t = generateTrack({ distance: 40, seed: 2 });
  const [press] = toCdpEvents(t.points, { startX: 0, startY: 0, button: 'right' });
  assert.equal(press.button, 'right');
});

test('createRng is a stable unit-interval generator', () => {
  const rng = createRng(99);
  const values = Array.from({ length: 200 }, () => rng());
  assert.ok(values.every((v) => v >= 0 && v < 1));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(mean > 0.35 && mean < 0.65, `suspicious mean ${mean}`);
  // Same seed, same sequence.
  const again = Array.from({ length: 5 }, () => createRng(99)());
  assert.equal(new Set(again).size, 1);
});
