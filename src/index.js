/**
 * AntiCrawlKit - library entry point.
 *
 * Everything is dependency-free and offline by construction: fingerprints are
 * collected from a browser you already control over CDP, JS is decoded as text,
 * slider images are decoded with node:zlib, and pacing is clock-injectable.
 *
 * Run `node src/index.js` for a tour of the modules, or `node src/cli.mjs --help`
 * for the command line.
 */
export { CdpClient, CdpError, attach, listTargets, pickPageTarget } from './lib/cdp.mjs';

export { PROBE_SOURCE } from './fingerprint/probe.mjs';
export { auditSnapshot, auditPage, RULES } from './fingerprint/audit.mjs';

export { TokenBucket, HostLimiter, backoffDelay } from './rate/bucket.mjs';

export { decodePng, toGray, PngError } from './slider/png.mjs';
export { detectGap, matchTemplate, columnEdgeEnergy, travelDistance } from './slider/detect.mjs';
export { generateTrack, toCdpEvents, trackDuration, createRng } from './slider/track.mjs';
export { captureRegion, locateGap, dragSlider, solveAndDrag } from './slider/solve.mjs';

export { detectObfuscation } from './webcrack/detect.mjs';
export { decodeEscapes, extractStringLiterals, findStringArrays, findRotation,
         replayRotation, inlineStringArrays, entropy, findEncodedBlobs } from './webcrack/strings.mjs';
export { prettyJs, stripDebugger, tidy } from './webcrack/pretty.mjs';
export { deobfuscate, unpackPacker } from './webcrack/deobfuscate.mjs';

import { auditPage } from './fingerprint/audit.mjs';
import { decodePng, toGray } from './slider/png.mjs';
import { detectGap, matchTemplate } from './slider/detect.mjs';
import { generateTrack } from './slider/track.mjs';
import { TokenBucket, HostLimiter } from './rate/bucket.mjs';
import { detectObfuscation } from './webcrack/detect.mjs';
import { deobfuscate } from './webcrack/deobfuscate.mjs';

const TOUR = `anticrawl - self-hosted anti-anti-bot toolkit (library mode)

Four instruments, no runtime dependencies:

  fingerprint   audit a live page for automation leaks
                  await auditPage('http://127.0.0.1:9222')
                  -> { verdict, headlessLikelihood, findings[], remediation[] }

  webcrack      identify and undo JS obfuscation
                  detectObfuscation(src) -> { verdict, score, techniques[] }
                  deobfuscate(src, {rotate:true}) -> { code, report }

  slider        solve image-drag challenges
                  decodePng(buf) / detectGap(img) / matchTemplate(bg, piece)
                  generateTrack({distance, seed}) -> human-ish pointer path

  rate          pacing that does not look like a metronome
                  new HostLimiter({ratePerSec:2}).observe(url, {status:429})

CLI:  node src/cli.mjs --help
`;

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  process.stdout.write(TOUR);
  // Keep the exports reachable for inspection without leaving dead code.
  void [auditPage, decodePng, toGray, detectGap, matchTemplate, generateTrack,
        TokenBucket, HostLimiter, detectObfuscation, deobfuscate];
}
