#!/usr/bin/env node
/**
 * Command line surface. Every subcommand is a thin wrapper over the library so
 * behaviour cannot drift between the two entry points.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { auditPage } from './fingerprint/audit.mjs';
import { decodePng } from './slider/png.mjs';
import { detectGap, matchTemplate } from './slider/detect.mjs';
import { generateTrack, toCdpEvents, trackDuration } from './slider/track.mjs';
import { TokenBucket, HostLimiter, backoffDelay } from './rate/bucket.mjs';
import { detectObfuscation } from './webcrack/detect.mjs';
import { deobfuscate, unpackPacker } from './webcrack/deobfuscate.mjs';
import { decodeEscapes, findEncodedBlobs, inlineStringArrays } from './webcrack/strings.mjs';

const HELP = `anticrawl - self-hosted anti-anti-bot toolkit

Usage: anticrawl <command> [options]

Commands
  fingerprint     Audit a live page for automation leaks (needs a CDP endpoint)
  deobf <file>    Deobfuscate a JS file (packer -> string array -> pretty)
  detect <file>   Report which obfuscation techniques a file uses
  slider <bg.png> Locate a slider notch offline, optionally with --piece
  track --distance N   Print a humanised drag track (JSON)
  rate            Exercise the adaptive rate limiter against a fake clock
  doctor          Check the local runtime for the pieces this tool needs

Fingerprint options
  --endpoint <url>        CDP HTTP endpoint (default http://127.0.0.1:9222)
  --target <id>           Target id to attach to (default: best page target)
  --webrtc                Also probe WebRTC local IP exposure (slower)
  --expect-timezone <tz>  Flag a timezone mismatch against this zone
  --json                  Emit the full audit object

Deobfuscation options
  --out <file>            Write the deobfuscated source here
  --rotate                Replay the string-array rotation IIFE in an isolated vm
  --prune                 Delete the string array declaration after inlining
  --no-pretty             Skip the re-indenter
  --json                  Emit the full report

Other
  -h, --help              Show this help
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

async function readInput(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  return readFile(path, 'utf8');
}

/* ------------------------------------------------------------------ commands */

async function cmdFingerprint(flags) {
  const endpoint = flags.endpoint ?? 'http://127.0.0.1:9222';
  const result = await auditPage(endpoint, {
    targetId: flags.target,
    includeWebRtc: Boolean(flags.webrtc),
    expectTimezone: typeof flags['expect-timezone'] === 'string' ? flags['expect-timezone'] : undefined,
  });
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return result.verdict === 'plausibly-human' ? 0 : 1;
  }
  out(`target      ${result.target.title || '(untitled)'}`);
  out(`url         ${result.target.url}`);
  out(`verdict     ${result.verdict}`);
  out(`likelihood  ${result.headlessLikelihood}/100`);
  out(`counts      critical=${result.counts.critical} warn=${result.counts.warn} info=${result.counts.info}`);
  if (result.findings.length) {
    out('');
    for (const f of result.findings) {
      out(`[${f.severity}] ${f.id} - ${f.title}`);
      if (f.detail) out(`         ${f.detail}`);
      out(`         fix: ${f.fix}`);
    }
  } else {
    out('\nno findings: the page looks like a normal browser session');
  }
  return result.verdict === 'plausibly-human' ? 0 : 1;
}

async function cmdDetect(flags, positional) {
  const file = positional[0];
  if (!file) throw new Error('detect needs a file path');
  const src = await readInput(file);
  const report = detectObfuscation(src);
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  out(`verdict   ${report.verdict} (score ${report.score}/100)`);
  out(`size      ${report.metrics.length} bytes, ${report.metrics.lines} lines, longest line ${report.metrics.maxLineLength}`);
  out(`literals  ${report.metrics.stringLiterals} strings, ${report.metrics.evalCalls} eval, ${report.metrics.functionCtor} Function()`);
  if (report.techniques.length) {
    out('');
    for (const t of report.techniques) {
      out(`[${t.severity}] ${t.id} - ${t.title}`);
      out(`         ${t.detail}`);
    }
  }
  out('');
  out('next steps:');
  for (const s of report.nextSteps) out(`  - ${s}`);
  const blobs = findEncodedBlobs(src);
  if (blobs.length) {
    out('');
    out(`encoded blobs: ${blobs.length}`);
    for (const b of blobs.slice(0, 5)) out(`  ${b.kind} @${b.offset} len=${b.length} H=${b.entropy}`);
  }
  return 0;
}

async function cmdDeobf(flags, positional) {
  const file = positional[0];
  if (!file) throw new Error('deobf needs a file path');
  const src = await readInput(file);

  const { code, report } = deobfuscate(src, {
    rotate: Boolean(flags.rotate),
    prune: Boolean(flags.prune),
    pretty: flags['no-pretty'] ? false : true,
  });

  if (typeof flags.out === 'string') {
    await writeFile(flags.out, code, 'utf8');
  }
  if (flags.json) {
    out(JSON.stringify({ report, outputPath: flags.out ?? null, outputLength: code.length }, null, 2));
    return 0;
  }

  out(`in   ${report.before.verdict} (${report.before.score})`);
  out(`out  ${report.after.verdict} (${report.after.score})`);
  out('');
  out('stages:');
  for (const s of report.stages) out(`  ${s.name}  ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'name')))}`);
  if (!report.stages.length) out('  (nothing to do)');
  if (report.warnings.length) {
    out('');
    out('warnings:');
    for (const w of report.warnings) out(`  - ${w}`);
  }
  out('');
  if (typeof flags.out === 'string') {
    out(`wrote ${code.length} bytes to ${flags.out}`);
  } else {
    out('--- output ---');
    out(code.length > 4000 ? `${code.slice(0, 4000)}\n... (${code.length - 4000} more bytes; use --out to save)` : code);
  }
  return 0;
}

async function cmdSlider(flags, positional) {
  const bgPath = positional[0];
  if (!bgPath) throw new Error('slider needs a background PNG path');
  const bg = decodePng(await readFile(bgPath));

  let result;
  if (typeof flags.piece === 'string') {
    const piece = decodePng(await readFile(flags.piece));
    result = matchTemplate(bg, piece);
  } else {
    result = detectGap(bg, {
      pieceWidth: flags.width ? Number(flags.width) : undefined,
    });
  }

  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  out(`method   ${result.method}`);
  out(`position x=${result.x}${result.width ? ` width=${result.width}` : ''}${result.y !== undefined ? ` y=${result.y}` : ''}`);
  out(`score    ${result.score}`);
  out(`image    ${bg.width}x${bg.height}`);
  if (result.candidates?.length) {
    out('');
    out('candidates:');
    for (const c of result.candidates) {
      out(`  x=${c.x}${c.width ? ` w=${c.width}` : ''}${c.y !== undefined ? ` y=${c.y}` : ''} score=${c.score}`);
    }
  }
  return 0;
}

async function cmdTrack(flags) {
  const distance = Number(flags.distance ?? 120);
  const track = generateTrack({
    distance,
    seed: flags.seed !== undefined ? Number(flags.seed) : undefined,
    steps: flags.steps ? Number(flags.steps) : undefined,
  });
  const events = toCdpEvents(track.points, { startX: 0, startY: 0 });
  out(JSON.stringify({
    distance: track.distance,
    durationMs: track.durationMs,
    moves: track.points.length,
    overshoot: track.overshoot,
    wallClockMs: trackDuration(track.points),
    points: track.points,
    cdpEvents: events,
  }, null, 2));
  return 0;
}

async function cmdRate(flags) {
  const rate = Number(flags.rate ?? 2);
  const count = Number(flags.count ?? 5);
  const limiter = new HostLimiter({
    ratePerSec: rate,
    burst: rate,
    recoverAfter: 3,
    stepPerSec: rate / 4,
  });

  let clock = 0;
  const bucket = new TokenBucket(
    { ratePerSec: rate, burst: rate, jitterRatio: 0 },
    { clock: () => clock, sleep: async (ms) => { clock += ms; } },
  );

  out(`bucket: rate=${rate}/s burst=${rate} (fake clock, jitter off for readability)`);
  const waits = [];
  for (let i = 0; i < count; i++) {
    const { waitedMs } = await bucket.take();
    waits.push(Math.round(waitedMs));
    out(`  take #${i + 1}: waited ${Math.round(waitedMs)}ms, clock=${clock}ms`);
  }
  const avg = waits.reduce((a, b) => a + b, 0) / Math.max(1, waits.length);
  out(`  mean wait ${avg.toFixed(1)}ms (expected ~${Math.round(1000 / rate)}ms for a saturated bucket)`);

  out('');
  out('adaptive host limiter:');
  const host = 'https://example.test/search';
  out(`  start rate ${limiter.rateFor(host)}/s (ceiling ${rate}, recoverAfter 3)`);
  for (const status of [200, 200, 429, 429, 200, 200, 200, 200]) {
    const r = limiter.observe(host, { status });
    out(`  HTTP ${status} -> ${r.action.padEnd(8)} ${r.ratePerSec.toFixed(2)}/s`);
  }
  out('');
  out('backoff ladder (full jitter, so these are upper bounds):');
  for (const attempt of [1, 2, 3, 4, 5]) {
    out(`  attempt ${attempt}: <= ${Math.round(backoffDelay({ attempt }))}ms`);
  }
  return 0;
}

async function cmdDoctor() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(['node >= 22', nodeMajor >= 22, `v${process.versions.node}`]);
  checks.push(['global WebSocket', typeof WebSocket === 'function', typeof WebSocket]);
  checks.push(['global fetch', typeof fetch === 'function', typeof fetch]);
  checks.push(['node:zlib', true, 'available']);

  let vmOk = true;
  let vmDetail = 'available';
  try {
    const vm = await import('node:vm');
    vm.runInNewContext('1+1', Object.create(null), { timeout: 50 });
    vmDetail = 'available (rotation replay enabled)';
  } catch (e) {
    vmOk = false;
    vmDetail = `unavailable: ${e.message}`;
  }
  checks.push(['node:vm', vmOk, vmDetail]);

  // Self-check the decoder on a known 1x1 PNG.
  let pngOk = false;
  let pngDetail = '';
  try {
    const tiny = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const img = decodePng(tiny);
    pngOk = img.width === 1 && img.height === 1 && img.data.length === 4;
    pngDetail = `${img.width}x${img.height}, ${img.data.length} bytes RGBA`;
  } catch (e) {
    pngDetail = e.message;
  }
  checks.push(['png decoder', pngOk, pngDetail]);

  let width = 0;
  for (const [name, ok, detail] of checks) {
    width = Math.max(width, name.length);
    out(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(width)}  ${detail}`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  out('');
  out(failed ? `${failed} check(s) failed` : 'all checks passed');
  return failed ? 1 : 0;
}

async function cmdSelftest() {
  /** @type {Array<{name:string, ok:boolean, detail:string}>} */
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: String(detail) });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  };

  await check('track terminates exactly', () => {
    const t = generateTrack({ distance: 137, seed: 7 });
    const last = t.points[t.points.length - 1];
    if (last.x !== 137) throw new Error(`ended at ${last.x}`);
    return `${t.points.length} moves over ${t.durationMs}ms`;
  });

  await check('track is deterministic for a seed', () => {
    const a = JSON.stringify(generateTrack({ distance: 90, seed: 42 }).points);
    const b = JSON.stringify(generateTrack({ distance: 90, seed: 42 }).points);
    if (a !== b) throw new Error('same seed produced different tracks');
    return 'stable';
  });

  await check('track never moves backwards past zero', () => {
    const t = generateTrack({ distance: 60, seed: 3 });
    let prev = 0;
    for (const p of t.points) {
      if (p.x < 0) throw new Error(`negative x ${p.x}`);
      if (p.x < prev - 4) throw new Error(`unexpected jump back ${prev} -> ${p.x}`);
      prev = p.x;
    }
    return `${t.points.length} monotonic moves`;
  });

  await check('packer unpack', () => {
    const packed = `eval(function(p,a,c,k,e,d){return p}('0 1',62,2,'var|hello'.split('|'),0,{}))`;
    const r = unpackPacker(packed);
    if (!r.matched) throw new Error('payload not recognised');
    if (r.code !== 'var hello') throw new Error(`got ${JSON.stringify(r.code)}`);
    return `${r.stats.substitutions} substitutions -> ${JSON.stringify(r.code)}`;
  });

  await check('escape decode', () => {
    const v = decodeEscapes('\\x41\\u0042\\u{43}');
    if (v !== 'ABC') throw new Error(`got ${v}`);
    return v;
  });

  await check('detect finds a string array', () => {
    const src = `var _0xabc=['alpha','beta','gamma','delta'];console.log(_0xabc[0x2]);`;
    const d = detectObfuscation(src);
    if (!d.techniques.some((t) => t.id === 'string-array')) throw new Error('string-array not detected');
    const inlined = inlineStringArrays(src);
    if (!inlined.code.includes('"gamma"')) throw new Error('inline failed');
    return `${inlined.stats.references} reference(s) inlined`;
  });

  await check('inline resolves decoder wrappers', () => {
    const src = `var _0xabc=['one','two','three'];function _0xd(i){i=i-0x1;return _0xabc[i];}var out=_0xd(0x1);`;
    const r = inlineStringArrays(src);
    if (!r.code.includes('"one"')) throw new Error(`decoder call not resolved: ${r.code}`);
    if (r.stats.decoded !== 1) throw new Error(`decoded=${r.stats.decoded}`);
    return `${r.stats.decoded} decoder call(s)`;
  });

  await check('detect flags a clean file as clean', () => {
    const d = detectObfuscation('function add(a,b){return a+b}');
    if (d.verdict !== 'clean') throw new Error(`verdict=${d.verdict}`);
    return d.verdict;
  });

  await check('host limiter backs off on 429', () => {
    const l = new HostLimiter({ ratePerSec: 4, burst: 4 });
    const r = l.observe('https://h.test/', { status: 429 });
    if (r.action !== 'decrease') throw new Error(`action=${r.action}`);
    return `${r.ratePerSec}/s`;
  });

  await check('host limiter recovers after a streak', () => {
    const l = new HostLimiter({ ratePerSec: 4, burst: 4, recoverAfter: 2, stepPerSec: 1 });
    l.observe('https://h.test/', { status: 429 });
    l.observe('https://h.test/', { status: 200 });
    const r = l.observe('https://h.test/', { status: 200 });
    if (r.action !== 'increase') throw new Error(`action=${r.action}`);
    return `${r.ratePerSec.toFixed(2)}/s`;
  });

  await check('token bucket serialises', async () => {
    let clock = 0;
    const b = new TokenBucket(
      { ratePerSec: 1, burst: 1, jitterRatio: 0 },
      { clock: () => clock, sleep: async (ms) => { clock += ms; } },
    );
    await b.take();
    const { waitedMs } = await b.take();
    if (waitedMs < 900) throw new Error(`waited only ${waitedMs}ms`);
    return `${Math.round(waitedMs)}ms`;
  });

  let width = 0;
  for (const r of results) width = Math.max(width, r.name.length);
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    out(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  out('');
  out(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  return failed ? 1 : 0;
}

/* -------------------------------------------------------------------- dispatch */

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const [command] = positional;
  if (flags.help || !command || command === 'help') {
    out(HELP);
    return 0;
  }

  try {
    switch (command) {
      case 'fingerprint':
        return await cmdFingerprint(flags);
      case 'detect':
        return await cmdDetect(flags, positional.slice(1));
      case 'deobf':
      case 'deobfuscate':
        return await cmdDeobf(flags, positional.slice(1));
      case 'slider':
        return await cmdSlider(flags, positional.slice(1));
      case 'track':
        return await cmdTrack(flags);
      case 'rate':
        return await cmdRate(flags);
      case 'doctor':
        return await cmdDoctor();
      case 'selftest':
        return await cmdSelftest();
      default:
        err(`unknown command: ${command}`);
        out(HELP);
        return 2;
    }
  } catch (e) {
    err(`error: ${e.message}`);
    if (process.env.ANTICRAWL_DEBUG) err(e.stack ?? '');
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => {
    err(`fatal: ${e?.message ?? e}`);
    process.exit(1);
  });
}
