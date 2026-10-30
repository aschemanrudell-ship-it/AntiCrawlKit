# Architecture

Four subsystems, one shared constraint: **no runtime dependencies, no network
calls of our own**. Each module states a contract, and the tests in `tests/`
encode that contract. Change a contract, change its test.

```text
            +-------------------- src/cli.mjs ---------------------+
            |  fingerprint | deobf | detect | slider | track |      |
            |  rate | doctor | selftest                             |
            +-------+----------+---------+---------+---------------+
                    |          |         |         |
      fingerprint/  |  webcrack/         |  slider/        rate/
        probe.mjs   |   detect.mjs       |   png.mjs      bucket.mjs
        audit.mjs   |   strings.mjs      |   detect.mjs   (no deps)
            |       |   pretty.mjs       |   track.mjs
            |       |   deobfuscate.mjs  |   solve.mjs
            +-------+----------+---------+---------+
                               |
                        lib/cdp.mjs  (WebSocket + fetch only)
```

## `lib/cdp.mjs` — the only thing that touches a browser

- `listTargets(endpoint)` — `GET /json/list`.
- `pickPageTarget(targets, preferId)` — scores targets; prefers `http(s)` pages
  over `chrome://`, `devtools://`, `about:blank`.
- `CdpClient.connect(wsUrl)` → `{ on, send, evaluate, close }`.
  `evaluate(expr)` uses `Runtime.evaluate` with `returnByValue: true` and throws
  `page evaluation failed: …` when the page raises.
- `attach(endpoint, { targetId })` → `{ client, target, targets }`.

Contract: **no driver, no injected bindings.** A plain CDP session does not
create `window.__puppeteer_*` or `cdc_` globals, which is exactly why the
fingerprint audit can report a clean baseline.

## `fingerprint/` — measure, do not spoof

`probe.mjs` exports a single string, `PROBE_SOURCE`, which is injected via
`Runtime.evaluate`. It returns one flat snapshot: UA/platform/vendor, plugin and
MIME counts, screen vs window geometry, canvas hashes (drawn twice to test
stability), WebGL vendor/renderer plus limits, AudioContext hash, font probe
(width-diff against three baselines), permission query-vs-property pairs, media
devices, and — only when asked — WebRTC candidate IPs.

`audit.mjs` runs 25 rules over that snapshot (10 critical, 12 warn, 3 info). Each rule is
`{ id, severity, title, test(raw, opts), detail?, fix }`:

- **critical** — a hard automation tell (`navigator.webdriver`, `HeadlessChrome`,
  zero outer window, SwiftShader renderer, driver tokens in an error stack,
  UA/platform contradiction, blank canvas, missing WebGL, empty plugins on a
  desktop UA).
- **warn** — a partial or inconsistent spoof (`languages[0] !== language`,
  vendor overridden without the rest, missing `deviceMemory`, no `window.chrome`,
  unstable canvas, too few fonts, timezone mismatch).
- **info** — context (`navigator.connection` absent, AudioContext failed,
  WebRTC private IP).

Scoring is deliberately blunt and documented: `likelihood = min(100, 34c + 9w + 2i)`,
verdict `obviously-automated` (any critical) → `suspicious` (2+ warns) →
`plausible-human`. Every finding carries a `fix`, deduplicated into
`remediation[]`.

## `webcrack/` — regex heuristics, honest about it

Pipeline order matters: **unpack → inline → strip → pretty**.

1. `unpackPacker` decodes Dean Edwards `p.a.c.k.e.r` payloads by running the
   dictionary substitution itself (no `eval` of the payload). Nested payloads
   unwrap up to a depth cap; hitting the cap is reported as a warning, not
   silently accepted.
2. `inlineStringArrays` resolves, in this order:
   - direct literal access `T[0x1f]`;
   - **decoder wrappers** `function _0xd(i){ i = i - 0x1; return T[i] }` used as
     `_0xd(0x1)`, including the `var _0xd = function(i){…}` form;
   - optional `--rotate`: replay the rotation IIFE in a `node:vm` context with a
     timeout, then use the rotated order.
   Out-of-range indexes are left in place, and "found a table but matched
   nothing" always produces a warning — the tool never claims a decode it did
   not make.
3. `stripDebugger` removes `debugger` statements only. Lookarounds keep
   `debuggerX` and `a.debugger` intact.
4. `prettyJs` re-indents; `tidy` collapses blank runs.

`detect.mjs` reports `{ score, verdict, techniques[], metrics, nextSteps }`.
Severity weights: critical 40, high 22, medium 11, low 4, info 0. `nextSteps`
always names a command that actually exists (`anticrawl deobf <file>`).

## `slider/` — image in, pixel out

- `png.mjs`: real PNG decode through `node:zlib` inflate — 5 filter types, bit
  depths 1/2/4/8/16, colour types 0/2/3/4/6, `tRNS` transparency. Interlaced
  (Adam7) input is **rejected with an explicit error** instead of producing
  garbage.
- `detect.mjs`: `detectGap` scores column energy (sum of vertical gradients at
  both notch borders, penalised when the notch interior is brighter than the
  background); `matchTemplate` is normalised cross-correlation over the opaque
  bounding box of a padded piece, refused when the piece is flat (NCC is
  undefined there).
- `track.mjs`: piecewise-eased path with jitter and an optional small overshoot
  followed by a correction. The **last point always equals the requested
  distance** — a test asserts it for every distance/seed pair.
- `solve.mjs`: CDP screenshot → decode → gap → track → `Input.dispatchMouseEvent`.

## `rate/bucket.mjs` — two shapes of patience

- `TokenBucket`: `take(n)` is serialised through an internal queue so two
  concurrent callers cannot both observe the same token. Jitter is uniform
  around the refill time, so inter-arrival times never sit on a grid.
- `HostLimiter`: per-host AIMD. Throttle statuses (429/503/403/412/420) halve the
  rate down to a floor; success streaks step it back up by `stepPerSec` after
  `recoverAfter` hits, never above the ceiling. Plain client errors (401/404/410)
  hold the rate — they mean "wrong request", not "too fast".
- `backoffDelay`: full-jitter exponential, capped.

Both accept injected `{ clock, sleep, random }`, which is why the 16 limiter
tests run deterministically in ~120 ms with no real waiting.

## Testing strategy

- Pure functions get direct unit tests with synthetic fixtures generated in
  `tests/helpers/png.mjs` (aperiodic hash noise — a linear ramp repeats under
  translation and would make NCC assertions meaningless).
- No test opens a socket, launches a browser, or needs the network.
- `npm run selftest` exercises every subsystem end-to-end through the CLI;
  `npm run doctor` checks the runtime's capabilities (WebSocket, fetch, zlib, vm,
  PNG decode).
