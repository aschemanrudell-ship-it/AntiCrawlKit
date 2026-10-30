/**
 * Rate limiting that survives real-world anti-bot pacing rules.
 *
 * Two layers:
 *   TokenBucket  - hard concurrency/throughput ceiling with jittered pacing, so
 *                  request timing never forms the perfectly periodic pattern
 *                  that trivially identifies a script.
 *   HostLimiter  - per-host adaptivity on top: 429/403/503 signals shrink the
 *                  effective rate immediately; success streaks let it grow back
 *                  slowly (additive-increase / multiplicative-decrease).
 *
 * The clock is injectable so tests run instantly and deterministically.
 */

/** @typedef {{ratePerSec:number, burst:number, jitterRatio?:number}} BucketOptions */

const defaultClock = () => Date.now();
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic-free randomness: callers may inject for tests. */
const defaultRandom = () => Math.random();

export class TokenBucket {
  #rate;
  #burst;
  #jitterRatio;
  #tokens;
  #last;
  #clock;
  #sleep;
  #random;
  #queue = Promise.resolve();

  /**
   * @param {BucketOptions} opts
   * @param {{clock?:()=>number, sleep?:(ms:number)=>Promise<void>, random?:()=>number}} [deps]
   */
  constructor(opts, deps = {}) {
    if (!(opts.ratePerSec > 0)) throw new RangeError('ratePerSec must be > 0');
    if (!(opts.burst >= 1)) throw new RangeError('burst must be >= 1');
    this.#rate = opts.ratePerSec;
    this.#burst = opts.burst;
    this.#jitterRatio = Math.min(Math.max(opts.jitterRatio ?? 0.25, 0), 0.95);
    this.#tokens = opts.burst; // start full: burst headroom is intentional
    this.#clock = deps.clock ?? defaultClock;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? defaultRandom;
    this.#last = this.#clock();
  }

  get ratePerSec() {
    return this.#rate;
  }

  /** Change throughput at runtime (adaptive limiter uses this). */
  setRate(ratePerSec) {
    if (!(ratePerSec > 0)) throw new RangeError('ratePerSec must be > 0');
    this.#refill();
    this.#rate = ratePerSec;
  }

  #refill() {
    const now = this.#clock();
    const elapsed = Math.max(0, now - this.#last) / 1000;
    this.#last = now;
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsed * this.#rate);
  }

  /** Tokens available right now (after refill). */
  available() {
    this.#refill();
    return this.#tokens;
  }

  /**
   * Wait until `n` tokens are available, then consume them.
   * Serialized through an internal queue so concurrent callers cannot both
   * observe the same token.
   * @param {number} [n]
   * @returns {Promise<{waitedMs:number}>}
   */
  take(n = 1) {
    if (!(n > 0)) throw new RangeError('n must be > 0');
    const run = async () => {
      let waitedMs = 0;
      // A single take never asks for more than the bucket can hold.
      const need = Math.min(n, this.#burst);
      for (;;) {
        this.#refill();
        const deficit = need - this.#tokens;
        if (deficit <= 0) break;
        const base = (deficit / this.#rate) * 1000;
        // Uniform jitter keeps inter-arrival times off any fixed grid.
        const jitter = base * this.#jitterRatio * (this.#random() * 2 - 1);
        const wait = Math.max(1, Math.round(base + jitter));
        waitedMs += wait;
        await this.#sleep(wait);
      }
      this.#tokens -= need;
      return { waitedMs };
    };
    const p = this.#queue.then(run, run);
    // Keep the chain alive even when a caller rejects.
    this.#queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }
}

/** Status codes that mean "you are going too fast / look automated". */
const THROTTLE_STATUS = new Set([429, 503, 403, 412, 420]);
/** Status codes that mean "the host is ours to keep hammering". */
const HOSTILE_STATUS = new Set([401, 404, 410]);

/**
 * Per-host adaptive limiter.
 *
 * Multiplicative decrease on throttle (×0.5, floor `minRate`), additive
 * increase after `recoverAfter` consecutive successes (+`stepPerSec`), capped
 * at the configured ceiling. Hosts are independent: one 429 must not slow down
 * a different site.
 */
export class HostLimiter {
  #ceiling;
  #minRate;
  #stepPerSec;
  #recoverAfter;
  #jitterRatio;
  #coins;
  #deps;
  #state = new Map();

  /**
   * @param {{ratePerSec?:number, burst?:number, minRatePerSec?:number,
   *          stepPerSec?:number, recoverAfter?:number, jitterRatio?:number}} [opts]
   * @param {{clock?:()=>number, sleep?:(ms:number)=>Promise<void>, random?:()=>number}} [deps]
   */
  constructor(opts = {}, deps = {}) {
    const ceiling = opts.ratePerSec ?? 2;
    if (!(ceiling > 0)) throw new RangeError('ratePerSec must be > 0');
    this.#ceiling = ceiling;
    this.#minRate = opts.minRatePerSec ?? Math.max(0.1, ceiling / 16);
    if (this.#minRate > ceiling) throw new RangeError('minRatePerSec must be <= ratePerSec');
    this.#stepPerSec = opts.stepPerSec ?? ceiling / 10;
    this.#recoverAfter = opts.recoverAfter ?? 10;
    this.#jitterRatio = opts.jitterRatio ?? 0.25;
    this.#coins = opts.burst ?? undefined; // kept for tests/documentation
    this.#deps = deps;
  }

  get ceiling() {
    return this.#ceiling;
  }

  #host(href) {
    let host;
    try {
      host = new URL(href).host;
    } catch {
      host = String(href);
    }
    let entry = this.#state.get(host);
    if (!entry) {
      entry = {
        host,
        ratePerSec: this.#ceiling,
        streak: 0,
        throttles: 0,
        bucket: new TokenBucket(
          {
            ratePerSec: this.#ceiling,
            burst: Math.max(2, Math.ceil(this.#ceiling)),
            jitterRatio: this.#jitterRatio,
          },
          this.#deps,
        ),
      };
      this.#state.set(host, entry);
    }
    return entry;
  }

  /** Current effective rate for a host (after adaptations). */
  rateFor(href) {
    return this.#host(href).ratePerSec;
  }

  /** Wait for a slot on this host. */
  async acquire(href, n = 1) {
    return this.#host(href).bucket.take(n);
  }

  /**
   * Report the outcome of a request so the limiter can adapt.
   * @param {string} href
   * @param {{status?:number, ok?:boolean, error?:unknown}} outcome
   * @returns {{ratePerSec:number, action:'decrease'|'increase'|'hold', host:string}}
   */
  observe(href, outcome = {}) {
    const entry = this.#host(href);
    const status = outcome.status;
    const ok = outcome.ok ?? (status != null && status >= 200 && status < 300);

    if (status != null && THROTTLE_STATUS.has(status)) {
      const next = Math.max(this.#minRate, entry.ratePerSec * 0.5);
      this.#apply(entry, next);
      entry.throttles += 1;
      entry.streak = 0;
      return { host: entry.host, ratePerSec: next, action: 'decrease' };
    }

    if (status != null && HOSTILE_STATUS.has(status)) {
      entry.streak = 0;
      return { host: entry.host, ratePerSec: entry.ratePerSec, action: 'hold' };
    }

    if (ok) {
      entry.streak += 1;
      if (entry.streak >= this.#recoverAfter && entry.ratePerSec < this.#ceiling) {
        const next = Math.min(this.#ceiling, entry.ratePerSec + this.#stepPerSec);
        this.#apply(entry, next);
        entry.streak = 0;
        return { host: entry.host, ratePerSec: next, action: 'increase' };
      }
    } else {
      entry.streak = 0;
    }
    return { host: entry.host, ratePerSec: entry.ratePerSec, action: 'hold' };
  }

  #apply(entry, ratePerSec) {
    entry.ratePerSec = ratePerSec;
    entry.bucket.setRate(ratePerSec);
    // Burst never exceeds the ceiling's whole-second capacity, but must stay
    // >= 2 so a refill can always satisfy a single take.
    const burst = Math.max(2, Math.ceil(ratePerSec));
    entry.bucket = new TokenBucket(
      { ratePerSec, burst, jitterRatio: this.#jitterRatio },
      this.#deps,
    );
  }

  /** Snapshot for logs/dashboards. */
  snapshot() {
    return [...this.#state.values()].map(({ host, ratePerSec, throttles, streak }) => ({
      host,
      ratePerSec: Number(ratePerSec.toFixed(3)),
      throttles,
      streak,
    }));
  }
}

/**
 * Exponential backoff with full jitter (AWS pattern) for retry loops.
 * @param {{attempt:number, baseMs?:number, capMs?:number, random?:()=>number}} o
 */
export function backoffDelay({ attempt, baseMs = 500, capMs = 60_000, random = Math.random }) {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * exp);
}
