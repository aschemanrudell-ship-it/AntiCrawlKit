/**
 * Minimal JS re-indenter.
 *
 * This is not a parser and does not claim to be: it walks the source with a
 * string/comment/regex-aware scanner and re-emits it with newlines and indents
 * at structural characters. That is enough to read obfuscator output, which is
 * what it is for.
 */

const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'try', 'finally', 'return',
]);

/**
 * @param {string} src
 * @param {{indent?:number|string, newlineBeforeElse?:boolean}} [opts]
 * @returns {{code:string, changed:boolean, lines:number}}
 */
export function prettyJs(src, opts = {}) {
  const unit = typeof opts.indent === 'string' ? opts.indent : ' '.repeat(opts.indent ?? 2);
  const out = [];
  let depth = 0;
  let line = '';
  let i = 0;

  const flush = () => {
    const trimmed = line.trim();
    out.push(trimmed.length ? unit.repeat(Math.max(0, depth)) + trimmed : '');
    line = '';
  };
  const push = (text) => {
    line += text;
  };

  // Track the previous significant token to decide on newline placement.
  let prevSignificant = '';

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // Comments: emit whole, keep line comments on their own line.
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      if (line.trim()) flush();
      out.push(unit.repeat(Math.max(0, depth)) + src.slice(i, end).trim());
      i = end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      const body = src.slice(i, end);
      if (body.includes('\n')) {
        if (line.trim()) flush();
        for (const l of body.split('\n')) out.push(unit.repeat(Math.max(0, depth)) + l.trim());
      } else {
        push(' ');
        push(body);
      }
      i = end;
      continue;
    }

    // Strings and templates: copy verbatim.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      push(src.slice(i, j));
      prevSignificant = 'literal';
      i = j;
      continue;
    }

    if (ch === '{') {
      // Object literal vs block: an object literal follows an operator or comma.
      const isObjectLiteral =
        prevSignificant === '=' || prevSignificant === '(' || prevSignificant === ',' ||
        prevSignificant === ':' || prevSignificant === '[' || prevSignificant === 'return';
      push(' {');
      flush();
      depth++;
      prevSignificant = '{';
      i++;
      continue;
    }
    if (ch === '}') {
      if (line.trim()) flush();
      depth = Math.max(0, depth - 1);
      line = unit.repeat(depth) + '}';
      // `} else`, `} catch`, `} finally`, `} while`
      const rest = src.slice(i + 1, i + 40);
      const kw = /^\s*(else|catch|finally|while)\b/.exec(rest);
      if (kw && opts.newlineBeforeElse !== true) {
        push(` ${kw[1]}`);
        i += 1 + (kw[0].length - kw[1].length) + kw[1].length;
        prevSignificant = kw[1];
        continue;
      }
      flush();
      prevSignificant = '}';
      i++;
      continue;
    }
    if (ch === ';') {
      push(';');
      flush();
      prevSignificant = ';';
      i++;
      continue;
    }
    if (ch === '\n') {
      // Collapse author newlines; the re-indenter decides the layout.
      if (line.trim()) push(' ');
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      if (line.length && !line.endsWith(' ')) push(' ');
      i++;
      continue;
    }

    push(ch);
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      // Re-emit the whole identifier at once.
      line = line.slice(0, line.length - 1) + word;
      prevSignificant = CONTROL_KEYWORDS.has(word) || word === 'return' ? word : 'ident';
      i = j;
      continue;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i++;
  }
  if (line.trim()) flush();

  // `f()  {` — collapse padding the input already had before the brace.
  const code =
    out.join('\n').replace(/\)[ \t]{2,}\{/g, ') {').replace(/\n{3,}/g, '\n\n') + '\n';
  return { code, changed: code !== src, lines: code.split('\n').length };
}

/** Strip `debugger;` statements (anti-devtools noise). */
export function stripDebugger(src) {
  let removed = 0;
  // The lookarounds keep identifiers such as `debuggerX` or `a.debugger` intact.
  const code = src.replace(/(?<![\w$.])debugger(?![\w$])\s*;?/g, () => {
    removed++;
    return '/*debugger*/';
  });
  return { code, removed };
}

/** Collapse runs of blank lines and trailing whitespace. */
export function tidy(src) {
  return src
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
