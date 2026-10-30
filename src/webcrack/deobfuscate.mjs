/**
 * The pipeline. Stages run in dependency order and each one reports what it
 * changed, because "deobfuscation" without a diff is indistinguishable from a
 * minifier having a bad day.
 */
import { detectObfuscation } from './detect.mjs';
import { inlineStringArrays } from './strings.mjs';
import { prettyJs, stripDebugger, tidy } from './pretty.mjs';

/**
 * Unpack a Dean Edwards p.a.c.k.e.r payload without evaluating it.
 *
 * The unpacker body is a pure string substitution over base-N indices, so we
 * reimplement it instead of handing attacker-controlled source to eval.
 *
 * @param {string} src
 * @returns {{code:string, matched:boolean, depth:number, stats:{entries:number, radix:number, substitutions:number}}}
 */
export function unpackPacker(src) {
  const re =
    /\}\s*\(\s*(['"])((?:[^\\]|\\.)*?)\1\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(['"])((?:[^\\]|\\.)*?)\5\s*\.\s*split\s*\(\s*(['"])\|\7\s*\)/;
  const m = re.exec(src);
  if (!m) {
    return { code: src, matched: false, depth: 0, stats: { entries: 0, radix: 0, substitutions: 0 } };
  }

  const payload = unescapeJs(m[2]);
  const radix = Number(m[3]);
  const count = Number(m[4]);
  const keywords = unescapeJs(m[6]).split('|');

  const encode = (n) => {
    let c = n;
    const head = c < radix ? '' : encode(Math.floor(c / radix));
    c = c % radix;
    return head + (c > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  };

  /** @type {Record<string,string>} */
  const table = Object.create(null);
  for (let i = 0; i < count; i++) {
    const key = encode(i);
    const value = keywords[i];
    table[key] = value !== undefined && value !== '' ? value : key;
  }

  let substitutions = 0;
  const code = payload.replace(/\b\w+\b/g, (word) => {
    const hit = table[word];
    if (hit === undefined) return word;
    substitutions++;
    return hit;
  });

  return {
    code,
    matched: true,
    depth: 1,
    stats: { entries: count, radix, substitutions },
  };
}

function unescapeJs(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (mm, b) => {
    if (b[0] === 'u' && b[1] === '{') return String.fromCodePoint(parseInt(b.slice(2, -1), 16));
    if (b[0] === 'u') return String.fromCharCode(parseInt(b.slice(1), 16));
    if (b[0] === 'x') return String.fromCharCode(parseInt(b.slice(1), 16));
    switch (b) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      default: return b;
    }
  });
}

/**
 * Run the full pipeline.
 *
 * @param {string} source
 * @param {{rotate?:boolean, prune?:boolean, pretty?:boolean, stripDebugger?:boolean,
 *          maxPackerDepth?:number}} [opts]
 */
export function deobfuscate(source, opts = {}) {
  const stages = [];
  const warnings = [];

  const before = detectObfuscation(source);
  let code = source;

  // 1. Repeated packer unwrapping (packers nest).
  const maxDepth = opts.maxPackerDepth ?? 3;
  let packerRounds = 0;
  for (let d = 0; d < maxDepth; d++) {
    const unpacked = unpackPacker(code);
    if (!unpacked.matched) break;
    code = unpacked.code;
    packerRounds++;
    stages.push({
      name: 'packer-unpack',
      round: packerRounds,
      entries: unpacked.stats.entries,
      radix: unpacked.stats.radix,
      substitutions: unpacked.stats.substitutions,
    });
  }
  if (packerRounds === maxDepth) {
    warnings.push(`packer unwrap stopped at the depth cap (${maxDepth}); payload may still be nested`);
  }

  // 2. String-array inlining (and rotation replay when asked).
  const inlined = inlineStringArrays(code, { rotate: opts.rotate, prune: opts.prune });
  if (inlined.stats.arrays) {
    code = inlined.code;
    stages.push({ name: 'string-array-inline', ...inlined.stats });
    warnings.push(...inlined.warnings);
  }

  // 3. Anti-devtools noise.
  if (opts.stripDebugger !== false) {
    const stripped = stripDebugger(code);
    if (stripped.removed) {
      code = stripped.code;
      stages.push({ name: 'strip-debugger', removed: stripped.removed });
    }
  }

  // 4. Layout.
  if (opts.pretty !== false) {
    const formatted = prettyJs(code);
    code = tidy(formatted.code);
    stages.push({ name: 'pretty', lines: formatted.lines });
  }

  const after = detectObfuscation(code);

  return {
    code,
    report: {
      before,
      after,
      scoreDelta: after.score - before.score,
      stages,
      warnings,
    },
  };
}

export { detectObfuscation };
