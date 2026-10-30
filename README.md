# AntiCrawlKit

## Goal

Self-hosted anti-anti-bot toolkit: browser fingerprint audit, JS deobfuscation, CDP captcha slider solver, adaptive rate limiter - all local, zero runtime deps

## Tech stack

- Node.js with npm/pnpm; choose one package manager and keep the lockfile.

## Directory layout

```text
AntiCrawlKit/
+- README.md            # this file
+- docs/                # requirements, design, decisions
+- tests/               # automated tests
\- src/               # source code
\- .gitignore
```

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Verification commands

```bash
npm test
verify-ai-project -Path 'D:\AIProjects\DeepSeek Harness\AntiCrawlKit'
```

## Status

- Created 2026-10-30 as a $Type project. First working slice not implemented yet.

## Known issues

- Nothing implemented yet; this section must be updated as real limitations appear.

## Next steps

- Implement the first usable slice, then replace this section with the real backlog.

## Hand-off notes

- Read ..\AGENTS.md (agent rules) and ..\..\AGENTS.md (area rules) before changing anything.
- Register changes in ..\PROJECTS.md and ..\..\PROJECT_INDEX.md.
- Never commit secrets or real user data; keep placeholders like <PLACEHOLDER>.