/**
 * Fingerprint consistency audit.
 *
 * Anti-bot vendors do not look for a single flag; they cross-check a dozen
 * cheap signals against each other and score the contradictions. This module
 * encodes that same cross-check so a local run tells you which specific
 * contradiction an existing browser session is leaking, plus a concrete
 * remediation for each one.
 *
 * Two entry points:
 *   auditSnapshot(raw)  - pure, offline, testable
 *   auditPage(endpoint) - attach over CDP and collect first
 */
import { attach } from '../lib/cdp.mjs';
import { PROBE_SOURCE } from './probe.mjs';

/** @typedef {'critical'|'warn'|'info'} Severity */

/** Expected navigator.platform for a UA family. */
const PLATFORM_EXPECTATION = [
  { ua: /Windows NT/i, platform: /^Win(32|64)/i, label: 'Windows' },
  { ua: /Macintosh|Mac OS X/i, platform: /^MacIntel$/i, label: 'macOS' },
  { ua: /Android/i, platform: /^(Linux|Android)/i, label: 'Android' },
  { ua: /iPhone|iPad|iPod/i, platform: /^(iPhone|iPad|iPod)/i, label: 'iOS' },
  { ua: /CrOS/i, platform: /^Linux/i, label: 'ChromeOS' },
  { ua: /Linux/i, platform: /^Linux/i, label: 'Linux' },
];

/** GPU renderers that mean "software rasterizer", i.e. no real GPU. */
const SOFTWARE_RENDERER =
  /(swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|mesa offscreen|angle \(google, vulkan [^)]*swiftshader)/i;

/** Strings that only appear in a stack when an automation driver is attached. */
const DRIVER_STACK = /(pptr:|puppeteer|playwright|selenium|webdriver|cdc_|__driver|cypress|remote-debugging)/i;

/** @type {Array<{id:string,severity:Severity,title:string,test:(raw:any)=>boolean,detail?:(raw:any)=>string,fix:string}>} */
export const RULES = [
  {
    id: 'navigator-webdriver',
    severity: 'critical',
    title: 'navigator.webdriver is true',
    test: (raw) => raw.webdriver === true,
    fix: 'Attach over CDP to a normally launched browser instead of using a driver flag; or override the getter in an init script (Page.addScriptToEvaluateOnNewDocument).',
  },
  {
    id: 'headless-ua',
    severity: 'critical',
    title: 'UA advertises HeadlessChrome',
    test: (raw) => /HeadlessChrome/i.test(raw.userAgent ?? ''),
    fix: 'Launch with a real UI (headless: false) or set a full desktop UA via Network.setUserAgentOverride plus matching client hints.',
  },
  {
    id: 'driver-stack-trace',
    severity: 'critical',
    title: 'Error stack leaks an automation driver',
    test: (raw) => (raw.stackLeaks ?? []).some((k) => DRIVER_STACK.test(k)),
    detail: (raw) => `leaked tokens: ${(raw.stackLeaks ?? []).join(', ')}`,
    fix: 'Use raw CDP without injecting driver bindings, or scrub Error.prepareStackTrace in an early init script.',
  },
  {
    id: 'automation-global',
    severity: 'critical',
    title: 'Automation global present on window',
    test: (raw) => (raw.automationGlobals ?? []).length > 0,
    detail: (raw) => `found: ${(raw.automationGlobals ?? []).join(', ')}`,
    fix: 'Disable the driver library that installs these globals; plain CDP does not create any of them.',
  },
  {
    id: 'no-plugins',
    severity: 'critical',
    title: 'navigator.plugins is empty on a desktop UA',
    test: (raw) =>
      raw.pluginsLength === 0 &&
      !/Android|iPhone|iPad|Mobile/i.test(raw.userAgent ?? ''),
    fix: 'Headless Chrome ships zero plugins. Run headed, or patch navigator.plugins to a plausible PDF-viewer set in an init script.',
  },
  {
    id: 'zero-outer-size',
    severity: 'critical',
    title: 'window.outerWidth/outerHeight is 0 (no real window)',
    test: (raw) => raw.window && (raw.window.outerWidth === 0 || raw.window.outerHeight === 0),
    fix: 'Use a headed browser window. A zero-sized outer frame is a hard headless tell on every major detector.',
  },
  {
    id: 'software-renderer',
    severity: 'critical',
    title: 'WebGL renderer is a software rasterizer',
    test: (raw) => {
      const w = raw.webgl ?? {};
      return SOFTWARE_RENDERER.test(`${w.unmaskedRenderer ?? ''} ${w.renderer ?? ''}`);
    },
    detail: (raw) => `renderer: ${raw.webgl?.unmaskedRenderer ?? raw.webgl?.renderer ?? 'n/a'}`,
    fix: 'Enable real GPU: pass --use-angle=d3d11 (Windows) / --use-gl=angle, or run headed on a machine with a GPU. SwiftShader is unmistakable.',
  },
  {
    id: 'platform-ua-mismatch',
    severity: 'critical',
    title: 'navigator.platform contradicts the UA',
    test: (raw) => {
      const ua = raw.userAgent ?? '';
      const pf = raw.platform ?? '';
      if (!ua || !pf) return false;
      const rule = PLATFORM_EXPECTATION.find((r) => r.ua.test(ua));
      if (!rule) return false;
      // A UA-clobbering setup that forgot platform is the classic leak.
      return !rule.platform.test(pf);
    },
    detail: (raw) => `UA says "${(raw.userAgent ?? '').slice(0, 40)}…", platform says "${raw.platform}"`,
    fix: 'Set navigator.platform to match the spoofed UA in the same init script; changing one without the other is worse than changing neither.',
  },
  {
    id: 'clobbered-vendor',
    severity: 'warn',
    title: 'navigator.vendor is not Chrome-like for a Chrome UA',
    test: (raw) => /Chrome\//.test(raw.userAgent ?? '') && raw.vendor !== 'Google Inc.',
    detail: (raw) => `vendor: ${JSON.stringify(raw.vendor)}`,
    fix: 'Keep navigator.vendor as "Google Inc." on Chromium; only change it together with a full Browser fingerprint preset.',
  },
  {
    id: 'missing-device-memory',
    severity: 'warn',
    title: 'navigator.deviceMemory is missing on a Chrome UA',
    test: (raw) => /Chrome\/\d/.test(raw.userAgent ?? '') && raw.deviceMemory == null,
    fix: 'deviceMemory is present on real Chrome (8 by default). Restore it in an init script if a stealth patch deleted it.',
  },
  {
    id: 'missing-hardware-concurrency',
    severity: 'warn',
    title: 'navigator.hardwareConcurrency missing or zero',
    test: (raw) => raw.hardwareConcurrency == null || raw.hardwareConcurrency === 0,
    fix: 'Set hardwareConcurrency to the host core count (2–16); zero is not a real machine.',
  },
  {
    id: 'languages-inconsistent',
    severity: 'warn',
    title: 'navigator.languages disagrees with navigator.language',
    test: (raw) => {
      const langs = (raw.languages ?? '').split(',').filter(Boolean);
      if (!raw.language || !langs.length) return false;
      return langs[0].toLowerCase() !== raw.language.toLowerCase();
    },
    detail: (raw) => `language=${raw.language} languages=${raw.languages}`,
    fix: 'languages[0] must equal language. A mismatch is only ever produced by a partial spoof.',
  },
  {
    id: 'empty-languages',
    severity: 'warn',
    title: 'navigator.languages is empty',
    test: (raw) => !raw.languages,
    fix: 'Set a realistic list such as "zh-CN,zh,en"; empty is a container default.',
  },
  {
    id: 'canvas-unstable',
    severity: 'warn',
    title: 'Canvas fingerprint is not stable between two draws',
    test: (raw) => raw.canvasA && raw.canvasB && raw.canvasA.hash !== raw.canvasB.hash,
    fix: 'Expected only when the page injects canvas noise. If you did not opt into noise, something is rewriting toDataURL.',
  },
  {
    id: 'canvas-blank',
    severity: 'critical',
    title: 'Canvas 2D is unavailable or returns blank data',
    test: (raw) => !raw.canvasA || raw.canvasA.blank === true,
    fix: 'Headless without SwiftShader, or a canvas-blocking extension. Headed Chrome always produces real pixels.',
  },
  {
    id: 'no-webgl',
    severity: 'critical',
    title: 'WebGL context unavailable',
    test: (raw) => raw.webgl?.available === false,
    fix: 'A browser with no WebGL cannot be a normal desktop Chrome. Enable GPU or --enable-unsafe-swiftshader at minimum.',
  },
  {
    id: 'notification-permission-inconsistent',
    severity: 'warn',
    title: 'Notification.permission disagrees with permissions.query',
    test: (raw) => {
      const p = raw.permissions?.notifications;
      if (!p || p.query === 'error' || p.prop == null) return false;
      if (p.query === 'denied' && p.prop === 'denied') return false;
      if (p.query === 'granted' && p.prop === 'granted') return false;
      return p.query !== p.prop;
    },
    detail: (raw) => `query=${raw.permissions?.notifications?.query} prop=${raw.permissions?.notifications?.prop}`,
    fix: 'A headless default of denied while query reports prompt is a known tell. Grant the permission explicitly or keep both consistent.',
  },
  {
    id: 'no-media-devices',
    severity: 'warn',
    title: 'enumerateDevices() returns nothing',
    test: (raw) => raw.mediaDevices?.count === 0 && !/Android|iPhone|Mobile/i.test(raw.userAgent ?? ''),
    fix: 'A desktop browser exposes at least a default audio output. Present a dummy device or run where audio exists.',
  },
  {
    id: 'missing-connection',
    severity: 'info',
    title: 'navigator.connection is absent',
    test: (raw) => /Chrome\/\d/.test(raw.userAgent ?? '') && raw.connectionEffectiveType == null,
    fix: 'Chrome exposes NetworkInformation. Its absence suggests a stripped environment.',
  },
  {
    id: 'no-chrome-object',
    severity: 'warn',
    title: 'window.chrome is missing on a Chrome UA',
    test: (raw) => /Chrome\/\d/.test(raw.userAgent ?? '') && raw.hasChromeObject !== true,
    fix: 'Real Chrome always has window.chrome (with loadTimes). Its absence is a strong headless-era tell.',
  },
  {
    id: 'fonts-cropped',
    severity: 'warn',
    title: 'Fewer than 6 of the probed system fonts resolve',
    test: (raw) => (raw.fonts?.available ?? 0) < 6,
    detail: (raw) => `detected ${raw.fonts?.available ?? 0}/${raw.fonts?.probed ?? 0}`,
    fix: 'A container/minimal image has almost no fonts, which changes every text-metric fingerprint. Install a normal font set.',
  },
  {
    id: 'touch-ua-mismatch',
    severity: 'warn',
    title: 'Mobile UA but maxTouchPoints is 0',
    test: (raw) => /Android|iPhone|iPad|Mobile/i.test(raw.userAgent ?? '') && raw.maxTouchPoints === 0,
    fix: 'Spoofing a phone UA without touch emulation is a contradiction. Use Emulation.setTouchEmulationEnabled and matching device metrics.',
  },
  {
    id: 'audio-unavailable',
    severity: 'info',
    title: 'AudioContext rendering failed',
    test: (raw) => raw.audio?.available === false,
    fix: 'Non-fatal, but AudioContext absence is uncommon on real hardware; it correlates with minimal containers.',
  },
  {
    id: 'webrtc-private-ip',
    severity: 'info',
    title: 'WebRTC exposed a private network address',
    test: (raw) => (raw.webrtc?.localIps ?? []).some((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)),
    detail: (raw) => `ips: ${(raw.webrtc?.localIps ?? []).join(', ')}`,
    fix: 'Expected on a LAN. If the session claims to be elsewhere, set WebRTC policy to disable non-proxied UDP.',
  },
  {
    id: 'timezone-missing',
    severity: 'warn',
    title: 'Timezone resolves to an unexpected value',
    test: (raw, opts) => Boolean(opts?.expectTimezone) && raw.timezone !== opts.expectTimezone,
    detail: (raw, opts) => `got ${raw.timezone}, expected ${opts.expectTimezone}`,
    fix: 'Timezone must match the proxy egress and the UA locale. Set it at the OS or via Emulation.setTimezoneOverride.',
  },
];

/**
 * Run every rule against one raw snapshot.
 * @param {any} raw
 * @param {{expectTimezone?:string}} [opts]
 */
export function auditSnapshot(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('auditSnapshot needs a probe snapshot object');
  const findings = [];
  for (const rule of RULES) {
    let hit = false;
    try {
      hit = rule.test(raw, opts) === true;
    } catch {
      hit = false;
    }
    if (!hit) continue;
    findings.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      detail: rule.detail ? safeDetail(rule.detail, raw, opts) : '',
      fix: rule.fix,
    });
  }
  const order = { critical: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));

  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  // Weighted score: criticals dominate, warnings accumulate, infos barely move.
  const headlessLikelihood = Math.min(100, counts.critical * 34 + counts.warn * 9 + counts.info * 2);
  const verdict =
    counts.critical > 0 ? 'obviously-automated' : counts.warn >= 2 ? 'suspicious' : 'plausible-human';

  return {
    collectedAt: raw.collectedAt ?? null,
    href: raw.href ?? '',
    verdict,
    headlessLikelihood,
    counts,
    findings,
    remediation: [...new Set(findings.map((f) => f.fix))],
  };
}

function safeDetail(fn, raw, opts) {
  try {
    return String(fn(raw, opts) ?? '');
  } catch {
    return '';
  }
}

/**
 * Attach to a live browser, run the probe, audit the result.
 * @param {string} endpoint DevTools HTTP endpoint, e.g. http://127.0.0.1:9222
 * @param {{targetId?:string, includeWebRtc?:boolean, expectTimezone?:string, timeoutMs?:number}} [opts]
 */
export async function auditPage(endpoint, opts = {}) {
  const { client, target } = await attach(endpoint, {
    targetId: opts.targetId,
    timeoutMs: opts.timeoutMs,
  });
  try {
    await client.send('Runtime.enable', {}, { timeoutMs: opts.timeoutMs }).catch(() => {});
    const expression = `(${PROBE_SOURCE})({ includeWebRtc: ${opts.includeWebRtc === true} })`;
    const raw = await client.evaluate(expression, {
      awaitPromise: true,
      timeoutMs: opts.timeoutMs ?? 45_000,
    });
    if (!raw || typeof raw !== 'object') throw new Error('probe returned no data');
    return {
      target: { id: target.id, title: target.title, url: target.url },
      raw,
      ...auditSnapshot(raw, { expectTimezone: opts.expectTimezone }),
    };
  } finally {
    client.close();
  }
}
