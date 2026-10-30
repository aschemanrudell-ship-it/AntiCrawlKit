/**
 * The page-side probe: one self-contained async IIFE that collects the raw
 * signals an anti-bot script would look at, and returns them as plain JSON.
 *
 * Kept as a source string (not a bundled script file) so it can be shipped to
 * `Runtime.evaluate` with no extra request that a network observer could see.
 * Everything is wrapped in try/catch: a hostile page that breaks one getter
 * must not lose the other thirty signals.
 */
export const PROBE_SOURCE = String.raw`
(async (opts) => {
  const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } };
  const sig = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  const n = navigator;
  const out = {
    collectedAt: Date.now(),
    href: safe(() => location.href, ''),
    readyState: safe(() => document.readyState, ''),
    userAgent: safe(() => n.userAgent, ''),
    appVersion: safe(() => n.appVersion, ''),
    platform: safe(() => n.platform, ''),
    vendor: safe(() => n.vendor, ''),
    product: safe(() => n.product, ''),
    productSub: safe(() => n.productSub, ''),
    language: safe(() => n.language, ''),
    languages: safe(() => n.languages && n.languages.join(','), ''),
    hardwareConcurrency: safe(() => n.hardwareConcurrency, null),
    deviceMemory: safe(() => n.deviceMemory, null),
    maxTouchPoints: safe(() => n.maxTouchPoints, null),
    doNotTrack: safe(() => n.doNotTrack, null),
    webdriver: safe(() => n.webdriver, null),
    cookieEnabled: safe(() => n.cookieEnabled, null),
    pdfViewerEnabled: safe(() => n.pdfViewerEnabled, null),
    pluginsLength: safe(() => n.plugins.length, -1),
    mimeTypesLength: safe(() => n.mimeTypes.length, -1),
    pluginNames: safe(() => Array.from(n.plugins).map((p) => p.name).join('|'), ''),
    hasChromeObject: safe(() => typeof window.chrome === 'object' && window.chrome !== null, false),
    chromeRuntimeId: safe(() => (window.chrome && window.chrome.runtime && window.chrome.runtime.id) || null, null),
    chromeLoadTimes: safe(() => typeof window.chrome?.loadTimes === 'function', false),
    connectionEffectiveType: safe(() => n.connection && n.connection.effectiveType, null),
    connectionDownlink: safe(() => n.connection && n.connection.downlink, null),
    screen: safe(() => ({
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    }), null),
    window: safe(() => ({
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenX: window.screenX ?? window.screenLeft, screenY: window.screenY ?? window.screenTop,
    }), null),
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, ''),
    timezoneOffsetMinutes: safe(() => new Date().getTimezoneOffset(), null),
    locale: safe(() => Intl.DateTimeFormat().resolvedOptions().locale, ''),
    calendar: safe(() => Intl.DateTimeFormat().resolvedOptions().calendar, null),
    hasTouchEvent: safe(() => 'ontouchstart' in window, false),
    stackLeaks: safe(() => {
      const s = new Error('probe').stack || '';
      const needles = [
        'pptr:', 'puppeteer', 'playwright', 'webdriver', 'selenium',
        'cdc_', '__puppeteer', '__playwright', '__driver', 'Cypress',
        'remote-debugging', 'devtools'
      ];
      const lower = s.toLowerCase();
      return needles.filter((k) => lower.includes(k.toLowerCase()));
    }, []),
    automationGlobals: safe(() => {
      const keys = ['__nightmare', '_phantom', 'callPhantom', 'domAutomation',
        'domAutomationController', '__webdriver_evaluate', '__selenium_evaluate',
        '__fxdriver_evaluate', '__driver_unwrapped', '__webdriver_script_fn',
        '__playwright__binding__', '__pw_manual', '_Selenium_IDE_Recorder',
        '__puppeteer_evaluation_script__', '__webdriverFunc'];
      return keys.filter((k) => k in window);
    }, []),
    navigatorOwnKeys: safe(() => {
      const s = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(n)));
      const expected = ['webdriver'];
      return expected.filter((k) => s.has(k));
    }, []),
  };

  // --- canvas fingerprint (two draws: stability is itself a signal) ---
  const canvasHash = (variant) => safe(() => {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 60;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'top';
    ctx.font = '14px "Arial"';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 100, 20);
    ctx.fillStyle = variant ? '#03f' : '#069';
    ctx.fillText('AntiCrawlKit ' + (variant ? 'B' : 'A') + ' \u4e2d\u6587', 2, 4);
    ctx.strokeStyle = 'rgba(102,204,0,0.7)';
    ctx.beginPath(); ctx.arc(60, 40, 18, 0, Math.PI * 1.5, true); ctx.stroke();
    const data = c.toDataURL();
    return { hash: sig(data), length: data.length, blank: data.length < 100 };
  }, null);
  out.canvasA = canvasHash(false);
  out.canvasB = canvasHash(true);
  out.canvasStable = !!(out.canvasA && out.canvasB && out.canvasA.hash === out.canvasB.hash);

  // --- webgl ---
  out.webgl = safe(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { available: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const params = {
      available: true,
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    };
    params.signature = sig([params.version, params.vendor, params.renderer, params.maxTextureSize].join('|'));
    return params;
  }, { available: false });

  // --- webgl2 presence ---
  out.hasWebgl2 = safe(() => !!(document.createElement('canvas').getContext('webgl2')), false);

  // --- audio fingerprint ---
  out.audio = await (async () => {
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OAC) return { available: false };
      const ctx = new OAC(1, 44100, 44100);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(0);
      const buf = await ctx.startRendering();
      const ch = buf.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < ch.length; i += 7) sum += Math.abs(ch[i]);
      return { available: true, hash: sig(String(sum)), sum: Number(sum.toFixed(6)) };
    } catch (e) {
      return { available: false, error: String(e && e.message || e) };
    }
  })();

  // --- font availability by width differential ---
  out.fonts = safe(() => {
    const base = ['monospace', 'sans-serif', 'serif'];
    const probe = ['Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara',
      'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Helvetica',
      'Impact', 'Lucida Console', 'Microsoft YaHei', 'MS Gothic', 'PingFang SC',
      'Roboto', 'Segoe UI', 'SimSun', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
      'Verdana', 'Noto Sans', 'DejaVu Sans', 'Ubuntu', 'Liberation Sans'];
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return { available: 0, detected: [] };
    const widthOf = (font) => { ctx.font = '72px ' + font; return ctx.measureText('mmMwWLliI0O&1').width; };
    const baseW = {};
    for (const b of base) baseW[b] = widthOf('"' + b + '"');
    const detected = probe.filter((f) => {
      const w = widthOf('"' + f + '"');
      return base.every((b) => Math.abs(w - baseW[b]) > 0.5);
    });
    return { available: detected.length, detected, probed: probe.length };
  }, { available: 0, detected: [] });

  // --- permissions consistency ---
  out.permissions = await (async () => {
    const names = ['notifications', 'geolocation', 'camera', 'microphone'];
    const res = {};
    for (const name of names) {
      res[name] = await (async () => {
        let query = null;
        try { query = (await navigator.permissions.query({ name })).state; } catch (e) { query = 'error'; }
        let prop = null;
        if (name === 'notifications') prop = safe(() => Notification.permission, null);
        return { query, prop };
      })();
    }
    return res;
  })();

  // --- media devices (container/headless often report zero) ---
  out.mediaDevices = await (async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { available: false, count: -1 };
      const list = await navigator.mediaDevices.enumerateDevices();
      return { available: true, count: list.length, kinds: Array.from(new Set(list.map((d) => d.kind))) };
    } catch (e) {
      return { available: false, count: -2, error: String(e && e.message || e) };
    }
  })();

  // --- optional webrtc leak collection ---
  out.webrtc = { requested: !!opts.includeWebRtc, candidates: [], localIps: [] };
  if (opts.includeWebRtc) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, opts.webrtcTimeoutMs || 2000);
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('probe');
        const ips = new Set();
        pc.onicecandidate = (ev) => {
          const c = ev && ev.candidate && ev.candidate.candidate;
          if (!c) return;
          out.webrtc.candidates.push(c);
          const m = c.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
          if (m) ips.add(m[1]);
        };
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
        setTimeout(() => {
          clearTimeout(timer);
          out.webrtc.localIps = [...ips];
          try { pc.close(); } catch (e) { /* ignore */ }
          finish();
        }, opts.webrtcTimeoutMs || 1500);
      } catch (e) {
        clearTimeout(timer);
        finish();
      }
    });
  }

  return out;
})
`;
