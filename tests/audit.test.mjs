import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, auditSnapshot } from '../src/fingerprint/audit.mjs';

/** A snapshot that trips no rule. Every case below mutates one field of this. */
function human(over = {}) {
  return {
    collectedAt: '2026-01-01T00:00:00.000Z',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    vendor: 'Google Inc.',
    webdriver: false,
    pluginsLength: 5,
    window: {
      innerWidth: 1280,
      innerHeight: 720,
      outerWidth: 1280,
      outerHeight: 800,
      devicePixelRatio: 1,
    },
    webgl: {
      available: true,
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    canvasA: { hash: 111, blank: false },
    canvasB: { hash: 111, blank: false },
    stackLeaks: [],
    automationGlobals: [],
    deviceMemory: 8,
    hardwareConcurrency: 8,
    language: 'zh-CN',
    languages: 'zh-CN,zh,en',
    permissions: { notifications: { query: 'default', prop: 'default' } },
    mediaDevices: { count: 3 },
    hasChromeObject: true,
    connectionEffectiveType: '4g',
    fonts: { available: 20, probed: 26 },
    maxTouchPoints: 0,
    audio: { available: true },
    webrtc: { localIps: [] },
    timezone: 'Asia/Shanghai',
    ...over,
  };
}

const ids = (report) => report.findings.map((f) => f.id);

test('the baseline snapshot is judged plausibly human', () => {
  const r = auditSnapshot(human());
  assert.equal(r.verdict, 'plausible-human');
  assert.equal(r.headlessLikelihood, 0);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.remediation, []);
  assert.deepEqual(r.counts, { critical: 0, warn: 0, info: 0 });
});

test('every rule is well formed', () => {
  const seen = new Set();
  for (const rule of RULES) {
    assert.match(rule.id, /^[a-z0-9-]+$/, rule.id);
    assert.ok(!seen.has(rule.id), `duplicate rule id ${rule.id}`);
    seen.add(rule.id);
    assert.ok(['critical', 'warn', 'info'].includes(rule.severity), rule.id);
    assert.equal(typeof rule.title, 'string', rule.id);
    assert.equal(typeof rule.test, 'function', rule.id);
    assert.equal(typeof rule.fix, 'string', rule.id);
    assert.ok(rule.fix.length > 10, `${rule.id} fix is too thin`);
  }
});

test('navigator.webdriver is critical', () => {
  const r = auditSnapshot(human({ webdriver: true }));
  assert.equal(r.verdict, 'obviously-automated');
  assert.deepEqual(ids(r), ['navigator-webdriver']);
  assert.equal(r.findings[0].severity, 'critical');
  assert.ok(r.headlessLikelihood >= 34);
});

test('a HeadlessChrome UA is critical', () => {
  const r = auditSnapshot(
    human({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
    }),
  );
  assert.ok(ids(r).includes('headless-ua'));
  assert.equal(r.verdict, 'obviously-automated');
});

test('a leaked puppeteer stack trace is critical', () => {
  const r = auditSnapshot(
    human({ stackLeaks: ['pptr:evaluate', 'webdriver'] }),
  );
  assert.ok(ids(r).includes('driver-stack-trace'));
  const finding = r.findings.find((f) => f.id === 'driver-stack-trace');
  assert.match(finding.detail, /pptr/);
});

test('automation globals are reported with their names', () => {
  const r = auditSnapshot(human({ automationGlobals: ['__playwright__binding__'] }));
  const finding = r.findings.find((f) => f.id === 'automation-global');
  assert.ok(finding, 'expected automation-global');
  assert.match(finding.detail, /__playwright__binding__/);
});

test('SwiftShader is caught as a software renderer', () => {
  const r = auditSnapshot(
    human({
      webgl: { available: true, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))' },
    }),
  );
  assert.ok(ids(r).includes('software-renderer'));
});

test('a zero-sized outer window is critical', () => {
  const r = auditSnapshot(human({ window: { innerWidth: 800, innerHeight: 600, outerWidth: 0, outerHeight: 0 } }));
  assert.ok(ids(r).includes('zero-outer-size'));
});

test('a blank canvas is critical', () => {
  const r = auditSnapshot(human({ canvasA: { hash: null, blank: true } }));
  assert.ok(ids(r).includes('canvas-blank'));
  assert.equal(r.verdict, 'obviously-automated');
});

test('a missing WebGL context is critical', () => {
  const r = auditSnapshot(human({ webgl: { available: false } }));
  assert.ok(ids(r).includes('no-webgl'));
});

test('platform/UA contradiction is critical', () => {
  const r = auditSnapshot(human({ platform: 'Linux x86_64' }));
  assert.ok(ids(r).includes('platform-ua-mismatch'));
  assert.equal(r.verdict, 'obviously-automated');
});

test('a Mac UA with Win32 platform is a contradiction too', () => {
  const r = auditSnapshot(
    human({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
    }),
  );
  assert.ok(ids(r).includes('platform-ua-mismatch'));
});

test('empty plugins on a desktop UA is critical', () => {
  const r = auditSnapshot(human({ pluginsLength: 0 }));
  assert.ok(ids(r).includes('no-plugins'));
});

test('empty plugins on a mobile UA is not flagged', () => {
  const r = auditSnapshot(
    human({
      pluginsLength: 0,
      maxTouchPoints: 5,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
    }),
  );
  assert.ok(!ids(r).includes('no-plugins'));
});

test('two warnings are enough for the suspicious verdict', () => {
  const r = auditSnapshot(human({ deviceMemory: null, hasChromeObject: false }));
  assert.equal(r.counts.critical, 0);
  assert.ok(r.counts.warn >= 2);
  assert.equal(r.verdict, 'suspicious');
});

test('one warning stays plausible but is listed', () => {
  const r = auditSnapshot(human({ deviceMemory: null }));
  assert.equal(r.counts.warn, 1);
  assert.equal(r.verdict, 'plausible-human');
  assert.deepEqual(ids(r), ['missing-device-memory']);
});

test('timezone expectation is only enforced when requested', () => {
  assert.deepEqual(ids(auditSnapshot(human())), []);
  const r = auditSnapshot(human(), { expectTimezone: 'America/New_York' });
  const finding = r.findings.find((f) => f.id === 'timezone-missing');
  assert.ok(finding);
  assert.match(finding.detail, /Asia\/Shanghai/);
});

test('unstable canvas is a warning, not a critical', () => {
  const r = auditSnapshot(human({ canvasB: { hash: 999, blank: false } }));
  const finding = r.findings.find((f) => f.id === 'canvas-unstable');
  assert.equal(finding.severity, 'warn');
  assert.equal(r.verdict, 'plausible-human');
});

test('remediation is deduplicated advice', () => {
  const r = auditSnapshot(human({ webdriver: true, stackLeaks: ['pptr:'], automationGlobals: ['x'] }));
  assert.equal(r.counts.critical, 3);
  assert.equal(new Set(r.remediation).size, r.remediation.length);
  assert.ok(r.remediation.length >= 1);
});

test('the score is clamped and monotonic in criticals', () => {
  const one = auditSnapshot(human({ webdriver: true }));
  const many = auditSnapshot(
    human({
      webdriver: true,
      pluginsLength: 0,
      canvasA: { blank: true },
      webgl: { available: false },
      window: { innerWidth: 1, innerHeight: 1, outerWidth: 0, outerHeight: 0 },
      stackLeaks: ['pptr'],
      automationGlobals: ['g'],
    }),
  );
  assert.ok(one.headlessLikelihood < many.headlessLikelihood);
  assert.ok(many.headlessLikelihood <= 100);
  assert.equal(many.headlessLikelihood, 100);
});

test('a mobile snapshot with touch is not penalised for touch', () => {
  const r = auditSnapshot(
    human({
      maxTouchPoints: 5,
      platform: 'Linux armv8l',
      userAgent:
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      pluginsLength: 0,
      mediaDevices: { count: 2 },
    }),
  );
  assert.ok(!ids(r).includes('touch-ua-mismatch'));
});
