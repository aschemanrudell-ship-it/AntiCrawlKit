# AntiCrawlKit

Four local instruments for the "the site fights back" half of browser automation:

| Instrument | Question it answers |
|---|---|
| `fingerprint` | Why does this page think I am a robot? |
| `webcrack` | What did this file do to hide itself, and can I undo it? |
| `slider` | Where is the notch, and how do I drag to it like a person? |
| `rate` | How fast can I go before I get throttled — and how do I back off? |

Everything runs on the box. No network services, no telemetry, **no runtime
dependencies** — only Node's own `WebSocket`, `fetch`, `node:zlib` and `node:vm`.

## Goal

Replace the guesswork in scraping and browser automation with measurements:
audit a live page for automation leaks, deobfuscate the JS that fingerprints you,
solve image-drag challenges offline, and pace requests with an adaptive limiter.
The point is not to *spoof* a human but to *know* which of your own signals are
inhuman, so you can fix them at the source (headed window, real GPU, honest UA).

## Tech stack

- Node.js **>= 22** (ESM only, `node --test` for tests).
- Zero runtime dependencies. `package.json` has no `dependencies` block on purpose.
- CDP (Chrome DevTools Protocol) over the global `WebSocket` for live page work.

## Directory layout

```text
AntiCrawlKit/
+- src/
|  +- index.js              # library entry: exports + help text
|  +- cli.mjs               # `anticrawl <command>` ; also `selftest`
|  +- lib/cdp.mjs           # minimal CDP client (target list, attach, evaluate)
|  +- fingerprint/
|  |  +- probe.mjs          # in-page snapshot collector (injected source string)
|  |  +- audit.mjs          # 26 rules -> verdict + findings + remediation
|  +- webcrack/
|  |  +- detect.mjs         # technique detection + metrics + next steps
|  |  +- strings.mjs        # string tables, decoder wrappers, rotation, blobs
|  |  +- pretty.mjs         # re-indenter, debugger stripper, tidy
|  |  +- deobfuscate.mjs    # packer -> strings -> strip -> pretty pipeline
|  +- slider/
|  |  +- png.mjs            # dependency-free PNG decoder (zlib inflate)
|  |  +- detect.mjs         # edge-energy gap finder + NCC template matcher
|  |  +- track.mjs          # humanised pointer path + CDP event conversion
|  |  +- solve.mjs          # CDP screenshot -> decode -> gap -> drag
|  +- rate/bucket.mjs       # TokenBucket, HostLimiter (AIMD), backoff
+- tests/                   # node --test, fully offline
+- docs/                    # architecture, verification record, hand-off
\- skill/SKILL.md           # agent-facing wrapper (copied into the DSH skills dir)
```

## Install

Nothing to install beyond Node:

```bash
node --version        # must be >= 22
npm run doctor        # verifies WebSocket, fetch, zlib, vm, PNG decoder
```

Optional global command:

```bash
npm link              # then `anticrawl --help`
```

## Run

```bash
# 1. Launch Chrome yourself with a debug port, then audit it.
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile
npm run cli -- fingerprint --json
npm run cli -- fingerprint --expect-timezone Asia/Shanghai --webrtc

# 2. What is this file hiding?
npm run cli -- detect suspicious.js
npm run cli -- deobf suspicious.js --out clean.js
npm run cli -- deobf suspicious.js --rotate --prune --json

# 3. Slider notch, offline, from a saved screenshot.
npm run cli -- slider bg.png                      # notch only
npm run cli -- slider bg.png --piece piece.png    # template match

# 4. A drag track as JSON (feed it to Input.dispatchMouseEvent).
npm run cli -- track --distance 137 --seed 42

# 5. Rate limiter against a fake clock.
npm run cli -- rate
```

## Library

```js
import { auditPage } from './src/fingerprint/audit.mjs';
import { deobfuscate } from './src/webcrack/deobfuscate.mjs';
import { decodePng } from './src/slider/png.mjs';
import { detectGap, travelDistance } from './src/slider/detect.mjs';
import { HostLimiter, backoffDelay } from './src/rate/bucket.mjs';

const audit = await auditPage('http://127.0.0.1:9222', { expectTimezone: 'Asia/Shanghai' });
// -> { verdict, headlessLikelihood, counts, findings[], remediation[] }

const { code, report } = deobfuscate(source, { rotate: true, prune: true });
// -> report.before / report.after / report.stages / report.warnings

const limiter = new HostLimiter({ ratePerSec: 2 });
await limiter.acquire('https://example.test/list');
limiter.observe('https://example.test/list', { status: 429 }); // -> halves the rate
```

## Verification commands

```bash
npm test      # 100 tests, all offline, ~0.5 s
npm run selftest   # 11 end-to-end checks over every subsystem
npm run doctor     # 6 runtime capability checks
verify-ai-project -Path 'D:\AIProjects\DeepSeek Harness\AntiCrawlKit'
```

Last recorded run: see [docs/VERIFY-RESULTS.md](docs/VERIFY-RESULTS.md).

## Status

- **v0.1.0 — all four instruments usable.** 100/100 tests, 11/11 selftest
  checks, 6/6 doctor checks pass on Node v24.19.0 / Windows 11.
- `fingerprint`: 25 rules across critical/warn/info (10 / 12 / 3), scored verdict
  (`plausibly-human` → `obviously-automated`), per-finding remediation.
- `webcrack`: p.a.c.k.e.r unwrapping, string-table inlining **including decoder
  wrappers** (`function _0xd(i){i=i-0x1;return T[i]}`), optional rotation replay
  in an isolated `vm`, debugger stripping, re-indent.
- `slider`: dependency-free PNG decode (bit depth 1-16, colour types 0/2/3/4/6),
  edge-energy gap detection, NCC template matching, jittery humanised tracks
  with overshoot correction, CDP event conversion.
- `rate`: token bucket with jitter, per-host AIMD limiter (halve on 429/503/403/
  412/420, step back up after a success streak), full-jitter exponential backoff.

## Known issues

These are real limits, not TODOs disguised as features:

1. **`fingerprint` needs an external browser.** The tool never launches Chrome.
   With no CDP endpoint you get a connection error — by design.
2. **Slider detection is ±1 px** on a hard step edge (two adjacent columns score
   identically). Real sliders tolerate several pixels; do not expect sub-pixel
   accuracy from `detectGap`.
3. **PNG only for slider images.** JPEG/WebP are not decoded. Use
   `Page.captureScreenshot {format:'png'}`. Interlaced (Adam7) PNGs are rejected
   explicitly rather than silently mis-decoded.
4. **`webcrack` is heuristic, not an AST.** No control-flow-flattening reversal,
   no JSFuck/Aaencode *decoding* (detection only), no dead-code removal. It
   targets the obfuscator.io family.
5. **String inlining is single-level.** It handles literal indexes (`T[0x1]`) and
   one decoder wrapper. Nested decoders (`f(g(i))`) and arithmetic indexes
   (`T[i-0x1+k]`) are left alone — with a warning, never silently wrong.
6. **`--rotate` executes the rotation IIFE** in a `node:vm` context with a
   timeout. That is still execution: only run it on files you are willing to run.
7. **`rate` state is in-memory.** Restarting the process forgets every host's
   rate. No proxy pool, no persistence.
8. **No fingerprint spoofing.** This is an audit tool: it tells you what leaks,
   it does not patch your browser for you.

## Next steps

- End-to-end `slider solve` against a real CDP target (only the pure functions
  are tested today).
- `--json` on every command (currently `fingerprint`, `deobf`, `detect`, `track`).
- Nested-decoder resolution in `webcrack` (two-pass inline).
- JSFuck/Aaencode/JSJiami decoders behind the existing detection.
- Optional `types/index.d.ts`.
- Compare-mode for `fingerprint`: diff two snapshots (headed vs headless) into a
  single "what changed" table.

## Hand-off notes

- Read `..\AGENTS.md` (agent rules) and `..\..\AGENTS.md` (area rules) first.
- Register changes in `..\PROJECTS.md` and `..\..\PROJECT_INDEX.md`.
- Never commit secrets or real user data; keep placeholders like `<PLACEHOLDER>`.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching a module —
  each one has a stated contract, and the tests encode it.
- `work/` is scratch space and git-ignored; `npm test` does not need it.
- The `skill/` directory is the agent-facing surface. If you change CLI flags or
  module exports, update `skill/SKILL.md` too.
