# Verification record

Every number below comes from a command that was actually run on this machine.
If you change a module, re-run these and update this file — an unverified claim is
worse than no claim.

## Environment

| Item | Value |
|---|---|
| Date | 2026-10-30 18:52 +08:00 |
| OS | Windows 11 |
| Node | v24.19.0 (project requires >= 22) |
| Runtime deps | none (`package.json` has no `dependencies`) |
| Network used by tests | none |

## 1. Unit tests — `node --test`

```text
ℹ tests 100
ℹ pass 100
ℹ fail 0
ℹ duration_ms 538.6647
```

Breakdown by file:

| File | Tests | Covers |
|---|---|---|
| `tests/png.test.mjs` | 8 | PNG decode: signature, IHDR/PLTE/tRNS/IDAT, bit depths, filters, interlace rejection |
| `tests/slider.test.mjs` | 9 | `detectGap` (±1 px), NCC `matchTemplate`, transparent bbox, flat-piece refusal, `travelDistance` |
| `tests/track.test.mjs` | 11 | exact landing distance, determinism per seed, monotonicity, jitter budget, duration band, overshoot, CDP events |
| `tests/audit.test.mjs` | 21 | 25-rule engine: baseline clean, each critical/warn path, verdict thresholds, score clamping, remediation dedupe |
| `tests/rate.test.mjs` | 16 | token bucket serialisation, jitter band, `setRate`, AIMD halve/floor/recover, per-host isolation, backoff cap |
| `tests/webcrack.test.mjs` | 35 | detection & scoring, escapes, string tables, decoder wrappers (both forms), rotation replay, prune, blobs, packer unwrap, pipeline stages |

## 2. CLI self-check — `node src/cli.mjs doctor`

```text
ok    node >= 22  v24.19.0
ok    global WebSocket  function
ok    global fetch      function
ok    node:zlib         available
ok    node:vm           available (rotation replay enabled)
ok    png decoder       1x1, 4 bytes RGBA

all checks passed
```

## 3. End-to-end self-test — `node src/cli.mjs selftest`

```text
all 11 checks passed
```

Checks: PNG decode shape, gap detection on a synthetic notch, track terminates
exactly / deterministic / monotonic, packer unpack, escape decode, string-array
inline, **decoder-wrapper inline**, clean-file verdict, host limiter back-off,
host limiter recovery, token-bucket serialisation.

## 4. Manual end-to-end runs (not part of `npm test`)

| Command | Result |
|---|---|
| `node src/cli.mjs deobf work/sample.js` | `in obfuscated (33) -> out obfuscated (22)`; stage `string-array-inline {"arrays":1,"references":2,"decoded":2,"decoders":[{"name":"_0x9c","array":"_0x1f2a","offset":0}]}`; output contained `console.log("hello"+"world")`; `strip-debugger {"removed":3}` |
| `node src/cli.mjs --help` | lists `fingerprint / deobf / detect / slider / track / rate / doctor` |
| `node src/index.js` | prints the library help (exports + snippets) |

## 5. Not verified (honest gaps)

- **No live browser was attached.** No Chrome with `--remote-debugging-port` was
  running, so `fingerprint` was never executed end to end. Its 21 rule tests use
  synthetic snapshots; `probe.mjs` (the injected collector) is exercised only by
  the SDK-less code path — its field names are asserted by the rules, not by a
  real page.
- **No real slider challenge was solved.** `slider` was verified against
  synthetic PNGs generated in `tests/helpers/png.mjs`; `solve.mjs`'s CDP drag
  was not driven against a live target.
- `verify-ai-project` result is recorded separately in `..\PROJECTS.md`; it is a
  structural check, not a behavioural one.
