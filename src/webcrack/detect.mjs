/**
 * Obfuscation technique detection.
 *
 * Purely structural: we count shapes that specific obfuscator families emit.
 * No execution, no AST, no network. The output is meant to answer one question
 * before any decoding work starts: *what kind of mess is this, and which decoder
 * should run first?*
 */

/** Indicators, in rough priority order (cheap ones first). */
const INDICATORS = [
  {
    id: 'jsfuck',
    title: 'JSFuck / only-bracket encoding',
    severity: 'critical',
    test: (src) => {
      const stripped = src.replace(/\s+/g, '');
      if (stripped.length < 200) return null;
      const allowed = /^[\[\]()!+\-~]+$/.test(stripped.slice(0, 2000));
      return allowed ? { detail: `first 2000 chars use only []()!+-~ (${stripped.length} total)` } : null;
    },
  },
  {
    id: 'aaencode',
    title: 'aaencode (kaomoji identifiers)',
    severity: 'critical',
    test: (src) => {
      const hits = src.match(/[\u30a0-\u30ff]{3,}|[\uff61-\uff9f]{3,}/g);
      return hits && hits.length > 8 ? { detail: `${hits.length} kaomoji runs` } : null;
    },
  },
  {
    id: 'jjencode',
    title: 'jjencode ($_ symbol alphabet)',
    severity: 'critical',
    test: (src) => {
      const hits = src.match(/\$\$?|_+\$|\$_+/g);
      const dollar = (src.match(/\$/g) ?? []).length;
      return dollar > 40 && hits.length > 20 ? { detail: `${dollar} dollar signs` } : null;
    },
  },
  {
    id: 'eval-packer',
    title: 'Dean Edwards p.a.c.k.e.r (eval + base-62 dict)',
    severity: 'critical',
    test: (src) =>
      /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/.test(src)
        ? { detail: 'eval(function(p,a,c,k,e,d){...}) signature found' }
        : null,
  },
  {
    id: 'string-array',
    title: 'String-array obfuscation (_0x… identifiers)',
    severity: 'high',
    test: (src) => {
      const ids = src.match(/\b_0x[0-9a-fA-F]{3,8}\b/g) ?? [];
      const unique = new Set(ids).size;
      if (unique >= 8) return { detail: `${ids.length} references, ${unique} unique identifiers` };

      // Short samples: a string-literal table plus index access is already the
      // pattern, even when the identifiers were renamed by hand.
      const table =
        /(?:var|let|const)\s+([A-Za-z_$][\w$]{1,24})\s*=\s*\[\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(
          src,
        );
      if (table) {
        const name = table[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${name}\\s*\\[`).test(src)) {
          return { detail: `string table \`${table[1]}\` with index access` };
        }
      }
      return null;
    },
  },
  {
    id: 'array-rotation',
    title: 'String-array rotation IIFE',
    severity: 'high',
    test: (src) => {
      const loop = /while\s*\(\s*(?:!!\[\]|true|1)\s*\)/.test(src);
      const shift = /\.(shift|push)\s*\(/.test(src);
      return loop && shift ? { detail: 'while(!![]) loop with shift/push mutation' } : null;
    },
  },
  {
    id: 'self-defending',
    title: 'Self-defending / anti-beautify guard',
    severity: 'medium',
    test: (src) => {
      const regExpCtor = /RegExp\s*\(/.test(src) || /new\s+RegExp/.test(src);
      const toStringProbe = /\.toString\s*\(\s*\)/.test(src);
      const ctorProbe = /\.constructor\s*\(/.test(src);
      return regExpCtor && toStringProbe && ctorProbe
        ? { detail: 'RegExp + toString + constructor probe pattern' }
        : null;
    },
  },
  {
    id: 'debugger-loop',
    title: 'Debugger trap (anti-devtools)',
    severity: 'medium',
    test: (src) => {
      const direct = (src.match(/\bdebugger\s*;/g) ?? []).length;
      const indirect = /Function\s*\(\s*['"]debugger/.test(src);
      return direct >= 3 || indirect
        ? { detail: `${direct} debugger statements${indirect ? ' + Function("debugger")' : ''}` }
        : null;
    },
  },
  {
    id: 'eval-atob',
    title: 'eval() over an encoded payload',
    severity: 'medium',
    test: (src) => {
      const hit = /eval\s*\(\s*(atob|decodeURIComponent|unescape|String\.fromCharCode)\s*\(/.exec(src);
      return hit ? { detail: `${hit[1]}() feeds eval()` } : null;
    },
  },
  {
    id: 'hex-escapes',
    title: 'Hex escape encoding',
    severity: 'medium',
    test: (src) => {
      const hits = (src.match(/\\x[0-9a-fA-F]{2}/g) ?? []).length;
      const ratio = hits / Math.max(1, src.length / 1000);
      return hits > 60 && ratio > 0.5 ? { detail: `${hits} \\xNN escapes (${ratio.toFixed(1)} per KB)` } : null;
    },
  },
  {
    id: 'unicode-escapes',
    title: 'Unicode escape encoding',
    severity: 'low',
    test: (src) => {
      const hits = (src.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length;
      return hits > 80 ? { detail: `${hits} \\uNNNN escapes` } : null;
    },
  },
  {
    id: 'base64-blob',
    title: 'Long base64 blob',
    severity: 'medium',
    test: (src) => {
      const blobs = src.match(/[A-Za-z0-9+/]{120,}={0,2}/g);
      return blobs && blobs.length
        ? { detail: `${blobs.length} blob(s), longest ${Math.max(...blobs.map((b) => b.length))} chars` }
        : null;
    },
  },
  {
    id: 'control-flow-flattening',
    title: 'Control-flow flattening (switch dispatcher)',
    severity: 'high',
    test: (src) => {
      const switches = (src.match(/\bswitch\s*\(/g) ?? []).length;
      const cases = (src.match(/\bcase\s+/g) ?? []).length;
      const labels = (src.match(/\bwhile\s*\(\s*!!\[\]\s*\)/g) ?? []).length;
      if (switches >= 2 && cases >= 25 && labels >= 1) {
        return { detail: `${switches} switch blocks, ${cases} cases, ${labels} dispatcher loops` };
      }
      return null;
    },
  },
  {
    id: 'proxy-globals',
    title: 'Proxy / getter-obfuscated globals',
    severity: 'low',
    test: (src) => {
      const proxies = (src.match(/new\s+Proxy\s*\(/g) ?? []).length;
      const getters = (src.match(/\bObject\.defineProperty\s*\(/g) ?? []).length;
      return proxies + getters >= 12
        ? { detail: `${proxies} Proxy, ${getters} defineProperty` }
        : null;
    },
  },
  {
    id: 'wasm-embedded',
    title: 'Embedded WebAssembly module',
    severity: 'info',
    test: (src) =>
      /WebAssembly\.(instantiate|compile)/.test(src) ? { detail: 'WebAssembly instantiation present' } : null,
  },
];

/** Which decoders can make progress against each technique. */
const DECODERS = {
  jsfuck: ['jsfuck-unwrap'],
  aaencode: ['aaencode-unwrap'],
  jjencode: ['jjencode-unwrap'],
  'eval-packer': ['packer-unpack'],
  'eval-atob': ['base64-extract', 'pretty-only'],
  'string-array': ['string-array-inline'],
  'array-rotation': ['string-array-rotate'],
  'self-defending': ['pretty-only'],
  'debugger-loop': ['strip-debugger'],
  'hex-escapes': ['escape-decode'],
  'unicode-escapes': ['escape-decode'],
  'base64-blob': ['base64-extract'],
  'control-flow-flattening': ['pretty-only'],
  'proxy-globals': [],
  'wasm-embedded': [],
};

/**
 * @param {string} source
 * @returns {{score:number, verdict:string, techniques:Array<object>, metrics:object, nextSteps:string[]}}
 */
export function detectObfuscation(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');

  const techniques = [];
  for (const ind of INDICATORS) {
    const hit = ind.test(source);
    if (!hit) continue;
    techniques.push({
      id: ind.id,
      title: ind.title,
      severity: ind.severity,
      confidence: ind.severity === 'critical' ? 'high' : 'medium',
      detail: hit.detail,
      decoders: DECODERS[ind.id] ?? [],
    });
  }

  const metrics = {
    length: source.length,
    lines: source.split('\n').length,
    longLines: source.split('\n').filter((l) => l.length > 500).length,
    identifiers: (source.match(/\b_0x[0-9a-fA-F]+\b/g) ?? []).length,
    evalCalls: (source.match(/\beval\s*\(/g) ?? []).length,
    functionCtor: (source.match(/\bnew\s+Function\s*\(|\bFunction\s*\(/g) ?? []).length,
    atobCalls: (source.match(/\batob\s*\(/g) ?? []).length,
    stringLiterals: (source.match(/'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/g) ?? []).length,
    maxLineLength: source.split('\n').reduce((m, l) => Math.max(m, l.length), 0),
    whitespaceRatio: 1 - source.replace(/\s+/g, '').length / Math.max(1, source.length),
  };

  const weight = { critical: 40, high: 22, medium: 11, low: 4, info: 0 };
  const raw = techniques.reduce((s, t) => s + (weight[t.severity] ?? 0), 0);
  const score = Math.min(100, raw);

  let verdict;
  if (score === 0) verdict = 'clean';
  else if (score < 20) verdict = 'lightly-obfuscated';
  else if (score < 55) verdict = 'obfuscated';
  else verdict = 'heavily-obfuscated';

  const nextSteps = [];
  const has = (id) => techniques.some((t) => t.id === id);
  if (has('eval-packer'))
    nextSteps.push('run `anticrawl deobf <file>`: p.a.c.k.e.r payloads decode without execution');
  if (has('string-array'))
    nextSteps.push('run `anticrawl deobf <file>` to inline the string array (decoder wrappers included)');
  if (has('array-rotation')) nextSteps.push('string array is rotated: pass --rotate to replay the rotation IIFE in an isolated vm');
  if (has('self-defending')) nextSteps.push('self-defending guard: beautify before running, do not evaluate in a real page');
  if (has('debugger-loop')) nextSteps.push('strip `debugger;` statements before loading in a debugger');
  if (has('control-flow-flattening')) nextSteps.push('control flow is flattened: recover the dispatcher cases manually or with a symbolic run');
  if (!techniques.length) nextSteps.push('nothing to undo; the source looks like ordinary (possibly minified) JS');

  return { score, verdict, techniques, metrics, nextSteps };
}
