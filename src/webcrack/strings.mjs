/**
 * String-level helpers: literal extraction, escape decoding, and string-array
 * inlining (including rotation replay).
 *
 * The rotation replay is the one place this toolkit runs foreign code, so it is
 * deliberately narrow: only the array declaration plus the IIFE that mutates it
 * go into a fresh `node:vm` context that has no require, no fetch, no timers
 * beyond the watchdog, and a hard timeout.
 */
import vm from 'node:vm';

/** Decode JS string escapes: \\, \n, \t, \xNN, \uNNNN, \u{...}. */
export function decodeEscapes(input) {
  return input.replace(
    /\\(\\|n|r|t|b|f|v|0|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|.)/g,
    (m, body) => {
      switch (body) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return '\0';
        case '\\': return '\\';
        default:
          if (body[0] === 'x') return String.fromCharCode(parseInt(body.slice(1), 16));
          if (body[0] === 'u' && body[1] === '{') {
            return String.fromCodePoint(parseInt(body.slice(2, -1), 16));
          }
          if (body[0] === 'u') return String.fromCharCode(parseInt(body.slice(1), 16));
          return body; // unknown escape: keep the raw character
      }
    },
  );
}

/**
 * Scan JS source for string literal ranges.
 * @param {string} src
 * @returns {Array<{value:string, raw:string, start:number, end:number, quote:string}>}
 */
export function extractStringLiterals(src) {
  /** @type {Array<{value:string, raw:string, start:number, end:number, quote:string}>} */
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      const quote = ch;
      i++;
      let body = '';
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
          body += c + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        if (quote === '`' && c === '$' && src[i + 1] === '{') {
          // Template interpolation: skip the balanced expression, keep a marker.
          let depth = 1;
          i += 2;
          const exprStart = i;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          body += `\${${src.slice(exprStart, i - 1)}}`;
          continue;
        }
        body += c;
        i++;
      }
      if (closed) {
        out.push({
          value: quote === '`' && body.includes('${') ? body : decodeEscapes(body),
          raw: src.slice(start, i),
          start,
          end: i,
          quote,
        });
      }
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Find `NAME = ['a','b',...]` declarations that look like obfuscator string arrays.
 * @param {string} src
 */
export function findStringArrays(src) {
  const results = [];
  const re = /(?:var|let|const)?\s*\b([A-Za-z_$][\w$]{0,24})\s*=\s*\[((?:\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,?)+)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, name, body] = m;
    const items = extractStringLiterals(body);
    if (items.length < 3) continue; // not a string table
    results.push({
      name,
      values: items.map((it) => it.value),
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    });
  }
  return results;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find the decoder wrapper almost every obfuscator.io build emits:
 *
 *     function _0x9c(_0x5e) { _0x5e = _0x5e - 0x1a3; return _0x1f2a[_0x5e]; }
 *
 * Call sites are `_0x9c(0x1a3)` rather than `_0x1f2a[0]`, so without this the
 * inliner matches nothing on real payloads. Only decoders whose return
 * expression reads a *known* string array are reported, which keeps the match
 * anchored to something we can actually substitute.
 *
 * @param {string} src
 * @param {string[]} arrayNames
 * @returns {Array<{name:string,array:string,offset:number,raw:string}>}
 */
export function findDecoders(src, arrayNames) {
  const known = new Set(arrayNames);
  const found = [];
  // Both shapes occur: `function _0x9c(i){…}` and `var _0x9c=function(i){…}`.
  const fnRe =
    /(?:(?:var|let|const)\s+([A-Za-z_$][\w$]{0,24})\s*=\s*)?function\s*([A-Za-z_$][\w$]{0,24})?\s*\(\s*([A-Za-z_$][\w$]{0,24})\s*\)\s*\{([\s\S]{0,800}?)\}/g;
  let m;
  while ((m = fnRe.exec(src)) !== null) {
    const name = m[1] ?? m[2];
    const param = m[3];
    const body = m[4];
    if (!name) continue;
    const access = new RegExp(
      `return\\s+([A-Za-z_$][\\w$]{0,24})\\s*\\[\\s*${reEsc(param)}\\s*\\]`,
    ).exec(body);
    if (!access) continue;
    const array = access[1];
    if (!known.has(array)) continue;
    const shift = new RegExp(
      `${reEsc(param)}\\s*=\\s*${reEsc(param)}\\s*([+-])\\s*(0x[0-9a-fA-F]+|\\d+)`,
    ).exec(body);
    const offset = shift
      ? (shift[1] === '-' ? -1 : 1) * Number(shift[2])
      : 0;
    found.push({ name, array, offset, raw: m[0] });
  }
  return found;
}

/**
 * Find the IIFE that rotates a string array: `(function(a,b){...})(NAME, 0xNN)`.
 * @param {string} src
 * @param {string} arrayName
 */
export function findRotation(src, arrayName) {
  const escaped = arrayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\(\\s*function\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]{0,4000}?)\\}\\s*\\(\\s*${escaped}\\s*,\\s*(0x[0-9a-fA-F]+|\\d+)\\s*\\)\\s*\\)`,
  );
  const m = re.exec(src);
  if (!m) return null;
  return {
    raw: m[0],
    params: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    count: Number(m[3]),
    start: m.index,
    end: m.index + m[0].length,
  };
}

/**
 * Replay a rotation IIFE in an isolated vm and return the rotated array.
 * Returns null when the payload touches anything the sandbox does not provide.
 * @param {string} declaration  the `NAME = [...]` source text
 * @param {string} rotation     the IIFE source text
 * @param {string} name
 * @param {number} [timeoutMs]
 */
export function replayRotation(declaration, rotation, name, timeoutMs = 250) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  try {
    vm.runInContext(`var ${name} = ${declaration};`, context, { timeout: timeoutMs });
    vm.runInContext(`;${rotation};`, context, { timeout: timeoutMs });
    const out = sandbox[name];
    if (!Array.isArray(out)) return null;
    return out.map((v) => (typeof v === 'string' ? v : String(v)));
  } catch {
    return null;
  }
}

/**
 * Replace `NAME[<int>]` accesses with the resolved string literal.
 *
 * @param {string} src
 * @param {{rotate?:boolean, prune?:boolean, maxArrays?:number}} [opts]
 * @returns {{code:string, stats:object, warnings:string[]}}
 */
export function inlineStringArrays(src, opts = {}) {
  const arrays = findStringArrays(src).slice(0, opts.maxArrays ?? 8);
  const warnings = [];
  const stats = {
    arrays: arrays.length,
    references: 0,
    decoded: 0,
    decoders: [],
    rotated: [],
    pruned: [],
  };
  let code = src;

  for (const arr of arrays) {
    let values = arr.values;
    if (opts.rotate) {
      const rot = findRotation(src, arr.name);
      if (rot) {
        const declared = arr.raw.replace(/^(?:var|let|const)\s*/, '');
        const rotated = replayRotation(declared.slice(declared.indexOf('=') + 1), rot.raw, arr.name);
        if (rotated) {
          values = rotated;
          stats.rotated.push({ name: arr.name, count: rot.count, length: rotated.length });
        } else {
          warnings.push(
            `rotation for ${arr.name} could not be replayed in isolation (it references host globals); using the un-rotated order`,
          );
        }
      }
    }

    /** Substitute one literal index; returns null when it is out of range. */
    const resolve = (lit) => {
      const idx = Number(lit);
      if (!Number.isInteger(idx) || idx < 0 || idx >= values.length) return null;
      return JSON.stringify(values[idx]);
    };

    // (a) direct literal access: NAME[0x1f]
    const accessRe = new RegExp(
      `${reEsc(arr.name)}\\s*\\[\\s*(0x[0-9a-fA-F]+|\\d+)\\s*\\]`,
      'g',
    );
    code = code.replace(accessRe, (m, lit) => {
      const value = resolve(lit);
      if (value === null) return m;
      stats.references++;
      return value;
    });

    // (b) decoder calls: DEC(0x1f) where DEC reads this array.
    for (const dec of findDecoders(code, [arr.name])) {
      if (!stats.decoders.some((d) => d.name === dec.name)) {
        stats.decoders.push({ name: dec.name, array: dec.array, offset: dec.offset });
      }
      const callRe = new RegExp(
        `${reEsc(dec.name)}\\s*\\(\\s*(0x[0-9a-fA-F]+|\\d+)\\s*\\)`,
        'g',
      );
      code = code.replace(callRe, (m, lit) => {
        const value = resolve(Number(lit) + dec.offset);
        if (value === null) return m;
        stats.references++;
        stats.decoded++;
        return value;
      });
    }

    if (opts.prune) {
      const declRe = new RegExp(
        `(?:var|let|const)?\\s*\\b${reEsc(arr.name)}\\s*=\\s*\\[(?:\\s*(?:'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")\\s*,?)+\\]`,
        'g',
      );
      let pruned = false;
      code = code.replace(declRe, () => {
        pruned = true;
        return `/* anticrawlkit: pruned string array ${arr.name} (${values.length} entries) */`;
      });
      if (pruned) stats.pruned.push(arr.name);
    }
  }

  if (arrays.length && stats.references === 0) {
    warnings.push(
      'string arrays found but no access matched: this build may compute indexes arithmetically (NAME[fn(i)]) and needs manual or symbolic recovery',
    );
  }

  return { code, stats, warnings };
}

/** Shannon entropy in bits per character. */
export function entropy(str) {
  if (!str.length) return 0;
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Long high-entropy runs that are probably encoded payloads.
 * @param {string} src
 * @param {{minLength?:number}} [opts]
 */
export function findEncodedBlobs(src, opts = {}) {
  const minLength = opts.minLength ?? 60;
  const out = [];
  const re = new RegExp(`[A-Za-z0-9+/=_-]{${minLength},}`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const value = m[0];
    const isB64 = /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
    const isHex = /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0;
    const h = entropy(value);
    if (!isB64 && !isHex && h < 4.2) continue;
    out.push({
      offset: m.index,
      length: value.length,
      kind: isHex ? 'hex' : isB64 ? 'base64' : 'opaque',
      entropy: Number(h.toFixed(3)),
      sample: value.slice(0, 48),
    });
  }
  return out;
}
