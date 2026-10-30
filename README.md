# AntiCrawlKit

**English** | [简体中文](README.zh-CN.md)

A site starts fighting back: the page decides you are a robot, hands you a slider,
or starts answering `429`. AntiCrawlKit is four local commands that replace
guessing with measurement — *which* signals gave you away, *what* the obfuscated
JS is doing, *where* the notch is, *how fast* you can go.

No network services, no telemetry, **no runtime dependencies**. Everything runs on
your machine with Node's own `WebSocket`, `fetch`, `node:zlib` and `node:vm`.

| Symptom | Command | What you get back |
|---|---|---|
| "This page thinks I am a bot" | `fingerprint` | The rules that hit (e.g. `headless-ua`), a 0–100 score, and a fix per finding |
| "What is this file hiding?" | `detect`, `deobf` | Detected techniques + metrics, then readable code |
| "The slider will not go through" | `slider`, `track` | Notch column and width, plus a drag path with real timing |
| "I keep getting 429" | `rate` | A per-host rate that adapts down on throttle and back up on success |

## What it actually does — real output, not mock-ups

### 1. Audit a page: what gives me away?

Point it at a Chrome you started with a debug port (`--remote-debugging-port`).
It attaches over CDP, collects ~40 signals in the page, and scores them against
25 rules.

```console
$ node src/cli.mjs fingerprint --expect-timezone Asia/Shanghai
target      about:blank
url         about:blank
verdict     obviously-automated
likelihood  52/100
counts      critical=1 warn=2 info=0

[critical] headless-ua - UA advertises HeadlessChrome
         fix: Launch with a real UI (headless: false) or set a full desktop UA
              via Network.setUserAgentOverride plus matching client hints.
[warn] canvas-unstable - Canvas fingerprint is not stable between two draws
         fix: Expected only when the page injects canvas noise. If you did not
              opt into noise, something is rewriting toDataURL.
[warn] missing-device-memory - navigator.deviceMemory is missing on a Chrome UA
         fix: deviceMemory is present on real Chrome (8 by default). Restore it
              in an init script if a stealth patch deleted it.
```

That is a real run against `Chrome/156.0.8078.73 --headless=new`. A headed window
usually lands on `plausibly-human`; the difference between the two runs is exactly
what you need to fix. `--json` dumps the whole snapshot so you can diff before and
after a change.

### 2. Read obfuscated JS: what is this file doing?

```console
$ node src/cli.mjs detect demo/obfuscated.js
verdict   obfuscated (score 22/100)
size      374 bytes, 7 lines, longest line 130
literals  6 strings, 0 eval, 0 Function()

[high] string-array - String-array obfuscation (_0x… identifiers)
         string table `_0x1f2a` with index access

next steps:
  - run `anticrawl deobf <file>` to inline the string array (decoder wrappers included)
```

Then undo it — including the decoder wrapper, which is the part most tools miss:

```console
$ node src/cli.mjs deobf demo/obfuscated.js
in   obfuscated (22)
out  obfuscated (22)

stages:
  string-array-inline  {"arrays":1,"references":4,"decoded":4,
                        "decoders":[{"name":"_0x9c","array":"_0x1f2a","offset":0}],
                        "rotated":[],"pruned":[]}
  strip-debugger  {"removed":1}
  pretty  {"lines":22}
--- output ---
console.log("hello"+"world");
console["log"]("spam");
```

The `_0x9c(i)` wrapper became its values, the `debugger` trap became a comment,
the rotation IIFE is still there for you to inspect or `--prune` away.

### 3. Slider captcha: where is the notch?

Feed it a PNG of the background. No browser, no network — pure pixel math.

```console
$ node src/cli.mjs slider demo/bg.png
method   edges
position x=120 width=29
score    290.888
image    360x180

candidates:
  x=120 w=29 score=290.888
  x=120 w=30 score=290.7014
  x=119 w=30 score=290.544
```

Ground truth for that synthetic image was `x=120, w=30` — correct column, width
±1 px, which is the documented precision on a hard step edge. Then:

```console
$ node src/cli.mjs track --distance 137 --seed 42
{ "distance": 137, "durationMs": 457, "moves": 52, "overshoot": 1,
  "wallClockMs": 460, "points": [ { "x": 1, "y": -2, "dt": 7 }, … ] }
```

`points` is `{dx, dy, dt}` you replay with `Input.dispatchMouseEvent`; overshoot
and settle-back are included, so the path does not stop dead on arrival.

### 4. Pacing: how fast before I get throttled?

```console
$ node src/cli.mjs rate
bucket: rate=2/s burst=2 (fake clock, jitter off for readability)
  take #1: waited 0ms, clock=0ms
  take #3: waited 500ms, clock=500ms

adaptive host limiter:
  start rate 2/s (ceiling 2, recoverAfter 3)
  HTTP 200 -> hold     2.00/s
  HTTP 429 -> decrease 1.00/s
  HTTP 429 -> decrease 0.50/s
```

Halving on `429/503/403/412/420`, holding on `401/404/410` (a wrong request is
not a throttle), stepping back up after a success streak.

## Quickstart — five minutes

```bash
git clone https://github.com/aschemanrudell-ship-it/AntiCrawlKit.git
cd AntiCrawlKit
node --version              # must be >= 22
node src/cli.mjs doctor     # 6 capability checks
node --test                 # 100 offline tests, ~0.5 s
```

Then try the two halves that need nothing from the internet:

```bash
node src/cli.mjs detect demo/obfuscated.js      # techniques in the sample
node src/cli.mjs deobf  demo/obfuscated.js      # recovered code
```

And the one that needs your browser — start Chrome yourself, the tool never
launches it:

```bash
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile
node src/cli.mjs fingerprint                    # defaults to 127.0.0.1:9222
```

Read the findings, fix the ones that are actually true, re-run, compare with
`--json`. That loop is the whole point.

## Use it as an agent skill

`skill/SKILL.md` is a ready-made skill definition (YAML front matter + four
workflows + rules) so a coding agent can use this toolkit instead of re-inventing
it. It names the exact commands, the order to run them in, and the traps
(±1 px, `--rotate` executes code, never fix one signal in isolation).

What the agent gets when the skill is loaded:

- **Trigger condition** — the skill declares `whenToUse`: anti-bot signals,
  fingerprint leaks, obfuscated JS, slider captchas, 429/403 throttling. On a
  plain scrape with no such signal, the agent should not load it.
- **Workflow A** — start Chrome with a debug port, run `fingerprint`, read
  verdict → `remediation[]`, with a finding→fix table.
- **Workflow B** — the fixed pipeline order (`packer-unpack` →
  `string-array-inline` → `strip-debugger` → `pretty`) and what a `decoded: 0`
  result means.
- **Workflow C** — capture PNG via CDP, `slider` → `travelDistance` →
  `generateTrack` → `toCdpEvents` → `Input.dispatchMouseEvent`.
- **Workflow D** — wire `HostLimiter.observe()` into the fetch loop.

Install it where your agent looks for skills:

```bash
# DeepSeek Harness / dsh (DSH_HOME defaults to ~/.dsh)
mkdir -p "$DSH_HOME/skills/anticrawl-kit"
cp skill/SKILL.md "$DSH_HOME/skills/anticrawl-kit/SKILL.md"

# Claude Code (project-local or ~/.claude/skills/)
mkdir -p .claude/skills/anticrawl-kit
cp skill/SKILL.md .claude/skills/anticrawl-kit/SKILL.md
```

The `name:` field (`anticrawl-kit`) becomes the skill id. After that, asking the
agent to "check why this site thinks I am a bot" makes it load the skill and run
`fingerprint` with the right flags — instead of writing a puppeteer script from
scratch.

No skill support? Paste `skill/SKILL.md` into the conversation as a system-style
prompt; it is written to be usable standalone.

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
|  |  +- audit.mjs          # 25 rules -> verdict + findings + remediation
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
+- demo/                    # a real obfuscator.io-style sample to try commands on
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
