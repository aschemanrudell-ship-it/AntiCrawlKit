# Hand-off

## Read this first

1. `..\..\AGENTS.md` — area-wide rules (`D:\AIProjects`).
2. `..\AGENTS.md` — agent rules for `D:\AIProjects\DeepSeek Harness`.
3. `README.md` — what the tool does and, importantly, **Known issues**.
4. `docs/ARCHITECTURE.md` — the contract of each module.
5. `docs/VERIFY-RESULTS.md` — what was actually run, and what was not.

## Where things stand (v0.1.0, 2026-10-30)

All four subsystems are implemented and tested: `fingerprint` (25 rules),
`webcrack` (packer / string tables / decoder wrappers / rotation / pretty),
`slider` (PNG decode / gap / NCC / track / CDP solve), `rate` (token bucket /
per-host AIMD / backoff).

Verified: `node --test` 100/100, `node src/cli.mjs selftest` 11/11,
`node src/cli.mjs doctor` 6/6.

**Not verified:** no live browser was ever attached (`fingerprint` and
`slider solve` are only covered by synthetic fixtures). If you have Chrome and a
target page, that is the highest-value next step — see below.

## How to pick up work

### Wiring a real browser (highest value)

```bash
chrome --remote-debugging-port=9222 --user-data-dir=<PLACEHOLDER_PROFILE>
node src/cli.mjs fingerprint --json > headed.json
chrome --headless=new --remote-debugging-port=9223 --user-data-dir=<PLACEHOLDER_PROFILE_2>
node src/cli.mjs fingerprint --endpoint http://127.0.0.1:9223 --json > headless.json
```

Diff the two snapshots. Any rule that fires only in `headless.json` is a rule
whose `fix` text you can now trust. If the headed run *also* fires a critical
rule, that rule's expectation is wrong — fix the rule, not the browser.

### Slider end to end

`solve.mjs` is written but only its parts are tested. Drive it against a real
challenge and check: the screenshot must be PNG, the notch must be visible in
the captured viewport, and the drag must be dispatched as
`mousePressed → mouseMoved(buttons:1) → mouseReleased`.

### Adding a detector

1. Add the indicator to `INDICATORS` in `src/webcrack/detect.mjs` and a
   `DECODERS[<id>]` entry naming the stage that undoes it.
2. Add the case to `tests/webcrack.test.mjs` — a positive and a negative sample.
3. If it changes output, update `README.md` Known issues.

### Adding an audit rule

1. Add `{ id, severity, title, test, detail?, fix }` to `RULES` in
   `src/fingerprint/audit.mjs`. `fix` is mandatory — a finding without a fix is
   noise.
2. Add both a "fires" and a "does not fire (mobile)" test to
   `tests/audit.test.mjs`; the suite asserts every rule has a non-trivial `fix`.
3. Keep the severity taxonomy: critical = hard tell, warn = inconsistent/partial,
   info = context only.

## Invariants (do not break these)

- **Zero runtime dependencies.** No `dependencies` in `package.json`. If you
  reach for a library, re-read the goal first.
- **No network calls in tests.** `npm test` must stay fully offline.
- **Honest failure modes.** Out-of-range string indexes stay in the output,
  interlaced PNGs are rejected, flat pieces refuse NCC, "table found but nothing
  matched" warns. Never replace a refusal with a guess.
- **The track's last point equals the requested distance.** A test asserts it for
  every distance/seed pair; a slider that overshoots by one pixel fails.
- **`nextSteps` must name a command that exists.** It shipped once pointing at a
  non-existent `webcrack unpack`; that is a documentation bug users hit instantly.

## Known traps

- `detectGap` is ±1 px on a hard edge — two adjacent columns score identically.
  Do not "fix" this by tightening a threshold; it is the physics of a step edge.
- `stripDebugger` needs its lookarounds. Without `(?![\w$])` it rewrites
  `debuggerX` into `/*debugger*/X` — a real bug that shipped during development.
- `findStringArrays` requires **three or more** entries; two-element arrays are
  ordinary code, not a table.
- `replayRotation` runs the rotation IIFE in `node:vm` with a timeout. It is
  bounded execution, not a sandbox — treat `--rotate` as "run this file".
- `tests/helpers/png.mjs` uses aperiodic hash noise on purpose: a linear ramp
  repeats under translation and produces several near-perfect NCC matches, which
  makes template-matching assertions vacuous.

## Repository hygiene

- Repo root is the project root (`D:\AIProjects\DeepSeek Harness\AntiCrawlKit`,
  branch `main`).
- `work/` is git-ignored scratch space; delete its contents when you stop.
- Do not commit `*.png` captures (`.gitignore` allows only `docs/**/*.png`).
- Update `..\PROJECTS.md` and `..\..\PROJECT_INDEX.md` (status + verification
  columns) whenever this file's "Where things stand" changes.
- Before declaring done: `node --test`, `node src/cli.mjs selftest`,
  `node src/cli.mjs doctor`, then
  `verify-ai-project -Path 'D:\AIProjects\DeepSeek Harness\AntiCrawlKit'`.
