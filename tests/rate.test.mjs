import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, HostLimiter, backoffDelay } from '../src/rate/bucket.mjs';

/** Deterministic time: sleeps advance the same clock the bucket reads. */
function harness({ ratePerSec, burst, jitterRatio = 0, random = () => 0.5 } = {}) {
  let now = 1_000;
  const waits = [];
  const bucket = new TokenBucket(
    { ratePerSec, burst, jitterRatio },
    {
      clock: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      random,
    },
  );
  return { bucket, waits, now: () => now };
}

test('a full bucket serves a take without waiting', async () => {
  const { bucket, waits } = harness({ ratePerSec: 2, burst: 2 });
  const r = await bucket.take(1);
  assert.equal(r.waitedMs, 0);
  assert.deepEqual(waits, []);
  assert.ok(Math.abs(bucket.available() - 1) < 1e-9);
});

test('draining the burst then waiting refills at the configured rate', async () => {
  const { bucket, waits } = harness({ ratePerSec: 2, burst: 2 });
  await bucket.take(1);
  await bucket.take(1);
  const third = await bucket.take(1);
  // One token at 2/s is exactly 500 ms.
  assert.equal(third.waitedMs, 500);
  assert.deepEqual(waits, [500]);
});

test('a single take never asks for more than the burst', async () => {
  const { bucket } = harness({ ratePerSec: 5, burst: 3 });
  const r = await bucket.take(999);
  assert.equal(r.waitedMs, 0);
  assert.ok(bucket.available() < 1);
});

test('concurrent takes are serialized, not double-spent', async () => {
  const { bucket } = harness({ ratePerSec: 2, burst: 2 });
  const results = await Promise.all([1, 2, 3, 4].map(() => bucket.take(1)));
  const total = results.reduce((s, r) => s + r.waitedMs, 0);
  // 4 requests, 2 free tokens, 2 more at 2/s => 1000 ms of waiting in total.
  assert.equal(total, 1000);
});

test('setRate changes throughput immediately', async () => {
  const { bucket } = harness({ ratePerSec: 2, burst: 1 });
  await bucket.take(1);
  bucket.setRate(0.5);
  const r = await bucket.take(1);
  assert.equal(r.waitedMs, 2000);
});

test('jitter keeps the wait inside the configured band', async () => {
  const { bucket, waits } = harness({
    ratePerSec: 1,
    burst: 1,
    jitterRatio: 0.5,
    random: () => 0.9,
  });
  await bucket.take(1);
  await bucket.take(1);
  // base 1000 ms, jitter ratio 0.5, random 0.9 => 1000 * (1 + 0.5*0.8) = 1400
  assert.equal(waits[0], 1400);
});

test('constructor and take reject nonsense', () => {
  assert.throws(() => new TokenBucket({ ratePerSec: 0, burst: 1 }), RangeError);
  assert.throws(() => new TokenBucket({ ratePerSec: 1, burst: 0 }), RangeError);
  const { bucket } = harness({ ratePerSec: 1, burst: 1 });
  assert.throws(() => bucket.take(0), RangeError);
});

test('a hostile status halves the rate and floors at the minimum', () => {
  const h = new HostLimiter({ ratePerSec: 16 }, { clock: () => 0, sleep: async () => {}, random: () => 0.5 });
  const url = 'https://example.com/list';
  assert.equal(h.rateFor(url), 16);
  const rates = [];
  for (let i = 0; i < 6; i++) {
    const r = h.observe(url, { status: 429 });
    assert.equal(r.action, 'decrease');
    rates.push(r.ratePerSec);
  }
  assert.deepEqual(rates, [8, 4, 2, 1, 1, 1]);
  assert.equal(h.rateFor(url), 1);
});

test('every throttle status degrades the host', () => {
  for (const status of [429, 503, 403, 412, 420]) {
    const h = new HostLimiter({ ratePerSec: 8 }, { clock: () => 0, sleep: async () => {}, random: () => 0.5 });
    const r = h.observe('https://x.test/', { status });
    assert.equal(r.action, 'decrease', `status ${status}`);
    assert.equal(r.ratePerSec, 4);
  }
});

test('a plain client error holds the rate', () => {
  const h = new HostLimiter({ ratePerSec: 8 }, { clock: () => 0, sleep: async () => {}, random: () => 0.5 });
  for (const status of [401, 404, 410]) {
    const r = h.observe('https://x.test/', { status });
    assert.equal(r.action, 'hold', `status ${status}`);
    assert.equal(r.ratePerSec, 8);
  }
});

test('a success streak restores the rate step by step, never above the ceiling', () => {
  const h = new HostLimiter(
    { ratePerSec: 16, stepPerSec: 4, recoverAfter: 3 },
    { clock: () => 0, sleep: async () => {}, random: () => 0.5 },
  );
  const url = 'https://x.test/';
  h.observe(url, { status: 429 }); // 8
  let r;
  for (let i = 0; i < 3; i++) r = h.observe(url, { status: 200 });
  assert.equal(r.action, 'increase');
  assert.equal(r.ratePerSec, 12);
  for (let i = 0; i < 3; i++) r = h.observe(url, { status: 200 });
  assert.equal(r.ratePerSec, 16);
  for (let i = 0; i < 3; i++) r = h.observe(url, { status: 200 });
  assert.equal(r.ratePerSec, 16, 'must not exceed the ceiling');
});

test('a failure resets the recovery streak', () => {
  const h = new HostLimiter(
    { ratePerSec: 10, stepPerSec: 1, recoverAfter: 2 },
    { clock: () => 0, sleep: async () => {}, random: () => 0.5 },
  );
  const url = 'https://x.test/';
  h.observe(url, { status: 429 });
  h.observe(url, { status: 200 });
  const r = h.observe(url, { ok: false });
  assert.equal(r.action, 'hold');
  assert.equal(r.ratePerSec, 5);
});

test('hosts are limited independently', () => {
  const h = new HostLimiter({ ratePerSec: 8 }, { clock: () => 0, sleep: async () => {}, random: () => 0.5 });
  h.observe('https://a.test/', { status: 429 });
  assert.equal(h.rateFor('https://a.test/'), 4);
  assert.equal(h.rateFor('https://b.test/'), 8);
});

test('snapshot reports per-host state', () => {
  const h = new HostLimiter({ ratePerSec: 4 }, { clock: () => 0, sleep: async () => {}, random: () => 0.5 });
  h.observe('https://a.test/', { status: 429 });
  const snap = h.snapshot();
  assert.ok(Array.isArray(snap.hosts) || Array.isArray(snap));
  const hosts = snap.hosts ?? snap;
  const row = hosts.find((x) => x.host === 'a.test');
  assert.ok(row, `expected a.test in ${JSON.stringify(snap)}`);
  assert.equal(row.ratePerSec, 2);
  assert.equal(row.throttles, 1);
});

test('minRatePerSec above the ceiling is rejected', () => {
  assert.throws(() => new HostLimiter({ ratePerSec: 1, minRatePerSec: 5 }), RangeError);
});

test('backoff grows, caps, and jitters', () => {
  const zero = backoffDelay({ attempt: 1, baseMs: 500, capMs: 60_000, random: () => 0 });
  const mid = backoffDelay({ attempt: 1, baseMs: 500, capMs: 60_000, random: () => 0.5 });
  const high = backoffDelay({ attempt: 1, baseMs: 500, capMs: 60_000, random: () => 0.999 });
  assert.ok(zero <= mid && mid <= high, `${zero} ${mid} ${high}`);
  assert.ok(high > zero, 'jitter must actually vary the delay');

  const small = backoffDelay({ attempt: 1, baseMs: 500, capMs: 60_000, random: () => 0.5 });
  const large = backoffDelay({ attempt: 6, baseMs: 500, capMs: 60_000, random: () => 0.5 });
  assert.ok(large > small);
  const capped = backoffDelay({ attempt: 40, baseMs: 500, capMs: 60_000, random: () => 0.5 });
  assert.ok(capped <= 60_000, `${capped} exceeded the cap`);
  assert.ok(capped >= 30_000, 'attempt 40 should sit near the cap, not below it');
});
