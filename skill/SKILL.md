---
name: anticrawl-kit
description: Local anti-anti-bot toolkit — audit a live page for automation leaks over CDP, deobfuscate obfuscator.io-style JavaScript (p.a.c.k.e.r + string tables + decoder wrappers), locate slider-captcha notches in PNG screenshots and generate humanised drag tracks, and pace requests with a per-host adaptive rate limiter. Use when a scraping/automation target starts blocking you, when a page's JS fingerprints your browser, when you must solve an image-drag challenge, or when you need request pacing that does not look like a metronome. Everything runs locally with zero runtime dependencies.
whenToUse: Use when the task is "the site is fighting back": automation-fingerprint leaks, obfuscated JS that needs reading, slider captchas, or 429/403 rate limiting. Do not load for plain page scraping with no anti-bot signal.
metadata:
  version: "1"
  project: D:\AIProjects\DeepSeek Harness\AntiCrawlKit
---

# AntiCrawlKit

Four instruments, no dependencies, no network calls of their own. Requires
**Node >= 22** (uses the global `WebSocket`, `fetch`, `node:zlib`, `node:vm`).

Project root: `D:\AIProjects\DeepSeek Harness\AntiCrawlKit`

## Step 0 — verify the runtime first

```bash
cd "D:/AIProjects/DeepSeek Harness/AntiCrawlKit"
node --version          # must be >= 22
node src/cli.mjs doctor     # 6 capability checks; all must pass
node src/cli.mjs selftest   # 11 end-to-end checks; all must pass
```

If `doctor` fails on `node:vm`, rotation replay is unavailable but everything
else still works. If it fails on `global WebSocket`, `fingerprint` cannot attach.

## Workflow A — "why does the page think I am a robot?"

The tool never launches a browser. Start Chrome yourself with a debug port:

```bash
chrome --remote-debugging-port=9222 --user-data-dir=<PLACEHOLDER_PROFILE>
node src/cli.mjs fingerprint                          # verdict + findings
node src/cli.mjs fingerprint --json                   # full snapshot + rules
node src/cli.mjs fingerprint --webrtc                 # + local IP exposure
node src/cli.mjs fingerprint --expect-timezone Asia/Shanghai
```

Read the verdict, then act on `remediation[]` — each finding names the fix:

| Finding | Meaning | Fix |
|---|---|---|
| `navigator-webdriver` | a driver is attached | attach over raw CDP instead |
| `headless-ua` / `zero-outer-size` | headless, or no real window | run headed |
| `software-renderer` | SwiftShader / llvmpipe | enable a real GPU (`--use-angle=d3d11`) |
| `driver-stack-trace` / `automation-global` | puppeteer/playwright bindings leak | drop the driver library |
| `platform-ua-mismatch` | UA spoofed without `platform` | spoof both or neither |
| `canvas-blank` / `no-webgl` | no rendering stack | headed browser with GPU |

Never "fix" a single signal in isolation — an inconsistent spoof scores worse
than no spoof. `--json` gives you the raw snapshot to diff before/after a change.

## Workflow B — reading obfuscated JavaScript

```bash
node src/cli.mjs detect <FILE>              # techniques + metrics + next steps
node src/cli.mjs deobf <FILE>               # unpack -> inline -> strip -> pretty
node src/cli.mjs deobf <FILE> --out clean.js
node src/cli.mjs deobf <FILE> --rotate --prune --json
```

Pipeline order is fixed and each stage is reported:

1. `packer-unpack` — Dean Edwards `p.a.c.k.e.r` dictionaries, decoded without
   `eval`; nested payloads unwrap to a depth cap (a cap hit is a warning).
2. `string-array-inline` — resolves `T[0x1f]` **and decoder wrappers**
   `function _0xd(i){ i = i - 0x1; return T[i] }` used as `_0xd(0x1)`.
   `--rotate` replays the rotation IIFE inside `node:vm` (a timeout-bounded
   execution) so the rotated order is used. `--prune` deletes the table after.
3. `strip-debugger` — removes `debugger` statements, keeps `debuggerX`.
4. `pretty` — re-indent (`--no-pretty` skips).

Unmatched indexes are left in place and always produce a warning. If
`stats.decoded === 0`, the build computes indexes arithmetically
(`T[i - 0x1 + k]`) — recover that manually; the tool will not guess.

## Workflow C — slider captcha

Capture the background (and piece) as **PNG** — CDP
`Page.captureScreenshot {format:'png'}`, not JPEG.

```bash
node src/cli.mjs slider <BG_PNG>                    # notch x + width
node src/cli.mjs slider <BG_PNG> --piece <PIECE_PNG>   # template match
node src/cli.mjs track --distance <PIXELS> --seed <N>  # drag track JSON
```

From code:

```js
import { decodePng } from './src/slider/png.mjs';
import { detectGap, matchTemplate, travelDistance } from './src/slider/detect.mjs';
import { generateTrack, toCdpEvents } from './src/slider/track.mjs';

const bg = decodePng(await readFile('<BG_PNG>'));
const gap = detectGap(bg, { pieceWidth: 42 });      // -> { x, width, score }
const track = generateTrack({ distance: travelDistance(bg, gap.x), seed: 7 });
const events = toCdpEvents(track.points, { startX: 40, startY: 300 });
// dispatch each event with Input.dispatchMouseEvent (press -> moves -> release)
```

Precision is **±1 px** on a hard edge; real sliders tolerate several pixels.
Interlaced PNGs are rejected explicitly — do not retry, re-capture.

## Workflow D — pacing that does not look like a metronome

```js
import { HostLimiter, backoffDelay } from './src/rate/bucket.mjs';

const limiter = new HostLimiter({ ratePerSec: 2 });   // per-host ceiling
await limiter.acquire('<URL>');                        // waits for a slot
const res = await fetch('<URL>');
limiter.observe('<URL>', { status: res.status });      // 429 -> halves the rate
// on a hard failure: await sleep(backoffDelay({ attempt, baseMs: 500, capMs: 60000 }))
```

`429/503/403/412/420` halve the host rate down to a floor; `401/404/410` hold it
(a wrong request is not a throttle); a success streak steps it back up. State is
in-memory only — restarting the process forgets every host.

## Rules

- **Do not** add runtime dependencies. The zero-dependency property is the point.
- **Do not** bypass the audit by patching the browser for the user: report the
  finding and its fix.
- `--rotate` executes the rotation IIFE. Only run it on files you would be
  willing to run.
- Keep `skill/SKILL.md` in sync with the CLI flags; the project copy is the
  source of truth.
- Verify with `node src/cli.mjs selftest` before claiming the toolkit works, and
  `npm test` (100 offline tests) after any module change.
