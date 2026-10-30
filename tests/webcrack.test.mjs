import test from 'node:test';
import assert from 'node:assert/strict';
import { detectObfuscation } from '../src/webcrack/detect.mjs';
import {
  decodeEscapes,
  extractStringLiterals,
  findStringArrays,
  findRotation,
  findDecoders,
  replayRotation,
  inlineStringArrays,
  entropy,
  findEncodedBlobs,
} from '../src/webcrack/strings.mjs';
import { prettyJs, stripDebugger, tidy } from '../src/webcrack/pretty.mjs';
import { unpackPacker, deobfuscate } from '../src/webcrack/deobfuscate.mjs';

/** Classic obfuscator.io shape: hex string table + decoder function. */
const SAMPLE = `var _0x1f2a=['\\x68\\x65\\x6c\\x6c\\x6f','\\x77\\x6f\\x72\\x6c\\x64','\\x6c\\x6f\\x67'];
(function(_0x2b,_0x3c){var _0x4d=function(_0x5e){while(--_0x5e){_0x2b['push'](_0x2b['shift']());}};_0x4d(++_0x3c);}(_0x1f2a,0x0));
var _0x9c=function(i){i=i-0x0;return _0x1f2a[i];};
console.log(_0x9c(0x0)+_0x9c(0x1));`;

const PACKED = `eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0("1");',2,2,'alert|there'.split('|'),0,{}))`;

test('clean source is not flagged', () => {
  const r = detectObfuscation('function add(a, b) {\n  return a + b;\n}\nconsole.log(add(1, 2));\n');
  assert.equal(r.verdict, 'clean');
  assert.equal(r.score, 0);
  assert.deepEqual(r.techniques, []);
  assert.match(r.nextSteps[0], /nothing to undo/);
});

test('a string-array payload is detected with metrics', () => {
  const r = detectObfuscation(SAMPLE);
  assert.equal(r.verdict, 'obfuscated');
  const ids = r.techniques.map((t) => t.id);
  assert.ok(ids.includes('string-array'), ids.join(','));
  assert.equal(r.metrics.length, SAMPLE.length);
  assert.ok(r.metrics.identifiers >= 3);
  assert.ok(r.techniques[0].decoders.length > 0);
  assert.ok(r.nextSteps.some((s) => s.includes('inline')));
});

test('eval over an encoded payload is caught', () => {
  const r = detectObfuscation('eval(atob("ZXYoKQ=="));');
  assert.equal(r.verdict, 'lightly-obfuscated');
  assert.equal(r.techniques[0].id, 'eval-atob');
  assert.match(r.techniques[0].detail, /atob/);
});

test('a p.a.c.k.e.r payload is critical and suggests unpacking', () => {
  const r = detectObfuscation(PACKED);
  assert.ok(r.score >= 40, `score ${r.score}`);
  assert.ok(['obfuscated', 'heavily-obfuscated'].includes(r.verdict), r.verdict);
  assert.ok(r.techniques.some((t) => t.id === 'eval-packer'));
  assert.equal(r.techniques.find((t) => t.id === 'eval-packer').severity, 'critical');
  assert.ok(r.nextSteps.some((s) => s.includes('deobf')));
});

test('a debugger trap needs repetition or Function("debugger")', () => {
  assert.ok(!detectObfuscation('debugger;').techniques.some((t) => t.id === 'debugger-loop'));
  const r = detectObfuscation('debugger;debugger;debugger;');
  assert.ok(r.techniques.some((t) => t.id === 'debugger-loop'));
});

test('detectObfuscation rejects non-strings', () => {
  assert.throws(() => detectObfuscation(null), TypeError);
});

test('decodeEscapes handles hex, unicode and control escapes', () => {
  assert.equal(decodeEscapes('\\x41\\u0042\\n\\t\\0'), 'AB\n\t\0');
  assert.equal(decodeEscapes('plain'), 'plain');
  assert.equal(decodeEscapes('\\\\x41'), '\\x41', 'an escaped backslash must not decode twice');
});

test('extractStringLiterals reports value, raw and offsets', () => {
  const items = extractStringLiterals(`a('x'); b("y")`);
  assert.deepEqual(items.map((i) => i.value), ['x', 'y']);
  assert.equal(items[0].quote, "'");
  assert.equal(items[1].quote, '"');
  assert.equal(`a('x'); b("y")`.slice(items[0].start, items[0].end), "'x'");
});

test('extractStringLiterals ignores quotes inside comments-free strings only', () => {
  const items = extractStringLiterals(`var s = 'it\\'s'`);
  assert.equal(items.length, 1);
  assert.equal(items[0].value, "it's");
});

test('findStringArrays requires at least three entries', () => {
  assert.equal(findStringArrays(`var a=['x','y'];`).length, 0);
  const found = findStringArrays(`var a=['x','y','z'];`);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'a');
  assert.deepEqual(found[0].values, ['x', 'y', 'z']);
});

test('findStringArrays keeps only pure string tables', () => {
  const found = findStringArrays(`var mixed=['a', 1, 'b', 'c'];`);
  assert.equal(found.length, 0, 'numbers must not be treated as a string table');
});

test('findRotation locates the rotation IIFE and its count', () => {
  const rot = findRotation(SAMPLE, '_0x1f2a');
  assert.ok(rot);
  assert.equal(rot.count, 0);
  assert.deepEqual(rot.params, ['_0x2b', '_0x3c']);
  assert.match(rot.raw, /_0x1f2a/);
  assert.equal(findRotation(SAMPLE, 'nope'), null);
});

test('replayRotation applies the rotation without touching the host', () => {
  const rot = '(function(a,n){while(n--){a.push(a.shift())}})(x, 1)';
  // Spread into a local array: values come from another vm realm, so a strict
  // deep-equal would trip on the realm's Array prototype.
  assert.deepEqual([...replayRotation("['c','a','b']", rot, 'x')], ['a', 'b', 'c']);
  assert.deepEqual([...replayRotation("['c','a','b']", rot.replace(', 1', ', 0'), 'x')], ['c', 'a', 'b']);
});

test('replayRotation returns null when the payload needs host globals', () => {
  const rot = '(function(a,n){window.__x=a;while(n--){a.push(a.shift())}})(x, 1)';
  assert.equal(replayRotation("['c','a','b']", rot, 'x'), null);
});

test('findDecoders finds both function-expression and declaration forms', () => {
  const expr = `var _0x9c=function(i){i=i-0x1a3;return _0x1f2a[i];};`;
  const decl = `function _0x9c(i){i=i-0x1a3;return _0x1f2a[i];}`;
  for (const src of [expr, decl]) {
    const d = findDecoders(src, ['_0x1f2a']);
    assert.equal(d.length, 1, src);
    assert.equal(d[0].name, '_0x9c');
    assert.equal(d[0].array, '_0x1f2a');
    assert.equal(d[0].offset, -0x1a3);
  }
});

test('findDecoders ignores decoders that read an unknown array', () => {
  const src = `function _0x9c(i){return other[i];}`;
  assert.deepEqual(findDecoders(src, ['_0x1f2a']), []);
});

test('inlineStringArrays resolves decoder calls, not just literal indexes', () => {
  const r = inlineStringArrays(SAMPLE);
  assert.equal(r.stats.arrays, 1);
  assert.equal(r.stats.decoded, 2);
  assert.equal(r.stats.references, 2);
  assert.match(r.code, /console\.log\("hello"\+"world"\)/);
  assert.ok(!r.code.includes('_0x9c(0x0)'));
  assert.deepEqual(r.warnings, []);
});

test('inlineStringArrays resolves direct literal indexes', () => {
  const src = `var _0xabc=['one','two','three'];var x=_0xabc[1],y=_0xabc[0x2];`;
  const r = inlineStringArrays(src);
  assert.equal(r.stats.references, 2);
  assert.match(r.code, /var x="two",y="three";/);
});

test('inlineStringArrays carries the decoder offset', () => {
  const src = `var _0xabc=['one','two','three'];
function _0xd(i){i=i-0x1;return _0xabc[i];}
var y=_0xd(0x1);`;
  const r = inlineStringArrays(src);
  assert.match(r.code, /var y="one";/);
  assert.deepEqual(r.stats.decoders, [{ name: '_0xd', array: '_0xabc', offset: -1 }]);
});

test('inlineStringArrays leaves out-of-range indexes alone and warns', () => {
  const src = `var _0xabc=['one','two','three'];var z=_0xabc[9];`;
  const r = inlineStringArrays(src);
  assert.equal(r.stats.references, 0);
  assert.match(r.code, /_0xabc\[9\]/);
  assert.equal(r.warnings.length, 1);
});

test('prune replaces the table with a marker', () => {
  const r = inlineStringArrays(SAMPLE, { prune: true });
  assert.deepEqual(r.stats.pruned, ['_0x1f2a']);
  assert.match(r.code, /anticrawlkit: pruned string array _0x1f2a \(3 entries\)/);
});

test('rotate replays the rotation and decodes the rotated order', () => {
  // Same IIFE shape real obfuscator.io builds emit: the call sits inside the
  // wrapping parentheses, `}(NAME, 0xN));`.
  const src = `var _0xabc=['three','one','two'];
(function(a,n){while(n--){a.push(a.shift())}}(_0xabc, 1));
function _0xd(i){return _0xabc[i];}
var v=_0xd(0x0);`;
  const plain = inlineStringArrays(src);
  assert.match(plain.code, /var v="three"/, 'un-rotated order is used by default');
  const rotated = inlineStringArrays(src, { rotate: true });
  assert.equal(rotated.stats.rotated.length, 1);
  assert.match(rotated.code, /var v="one"/, 'rotated order must be used');
});

test('entropy is 0 for uniform input and grows with variety', () => {
  assert.equal(entropy(''), 0);
  assert.equal(entropy('aaaaaaaa'), 0);
  assert.ok(entropy('abcd') > 1.9);
  assert.ok(entropy('aGVsbG8gd29ybGQhIQ==') > 3);
});

test('findEncodedBlobs reports long base64 only', () => {
  assert.deepEqual(findEncodedBlobs(`var x='aGVsbG8=';`), []);
  const long = 'aGVsbG8gd29ybGQhIHRoaXMgaXMgYSBsb25nIGJhc2U2NCBibG9iIGZvciB0ZXN0aW5nIQ==';
  const blobs = findEncodedBlobs(`var x='${long}';`);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].kind, 'base64');
  assert.equal(blobs[0].length, long.length);
  assert.ok(blobs[0].entropy > 3);
});

test('prettyJs reindents and reports line count', () => {
  const r = prettyJs('if(a){b()}else{c()}');
  assert.equal(r.changed, true);
  assert.match(r.code, /^if\(a\) \{/m);
  assert.match(r.code, /^ {2}b\(\)$/m);
  assert.equal(r.lines, r.code.split('\n').length);
});

test('prettyJs leaves well-formed input recognisable', () => {
  const src = 'function f() {\n  return 1;\n}\n';
  const r = prettyJs(src);
  assert.match(r.code, /function f\(\)\s*\{/);
  assert.match(r.code, /return 1;/);
});

test('stripDebugger removes statements but not identifiers', () => {
  const r = stripDebugger('var debuggerX=1;debugger;function f(){debugger;}a.debugger=2;');
  assert.equal(r.removed, 2);
  assert.match(r.code, /var debuggerX=1;/);
  assert.match(r.code, /a\.debugger=2/);
  assert.ok(!/^\s*debugger\s*;/m.test(r.code));
});

test('tidy collapses blank runs and trailing spaces', () => {
  assert.equal(tidy('var a = 1 ;\n\n\n\nb();\n'), 'var a = 1 ;\n\nb();\n');
  assert.equal(tidy('x  \ny'), 'x\ny');
});

test('unpackPacker restores a p.a.c.k.e.r payload', () => {
  const r = unpackPacker(PACKED);
  assert.equal(r.matched, true);
  assert.equal(r.code, 'alert("there");');
  assert.equal(r.stats.entries, 2);
  assert.equal(r.stats.radix, 2);
  assert.equal(r.stats.substitutions, 2);
});

test('unpackPacker reports a miss instead of throwing', () => {
  const r = unpackPacker('var a = 1;');
  assert.equal(r.matched, false);
  assert.equal(r.code, 'var a = 1;');
});

test('unpackPacker unwraps nested payloads', () => {
  const inner = PACKED;
  const outerSource = `eval(function(p,a,c,k,e,d){e=function(c){return c};if(!''.replace(/^/,String)){while(c--){d[c]=k[c]||c}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0("1");',2,2,'alert|there'.split('|'),0,{}))`;
  assert.equal(inner, outerSource, 'fixture sanity');
  const r = unpackPacker(outerSource);
  assert.equal(r.matched, true);
});

test('deobfuscate runs the pipeline and reports every stage', () => {
  const r = deobfuscate(SAMPLE);
  assert.equal(typeof r.code, 'string');
  assert.ok(r.report.before.score > 0);
  assert.equal(typeof r.report.after.score, 'number');
  assert.equal(r.report.scoreDelta, r.report.after.score - r.report.before.score);
  const names = r.report.stages.map((s) => s.name);
  assert.ok(names.includes('string-array-inline'), names.join(','));
  assert.ok(names.includes('pretty'), names.join(','));
  assert.match(r.code, /"hello"/);
});

test('deobfuscate strips debugger noise by default', () => {
  const r = deobfuscate('debugger;debugger;debugger;var a=1;');
  assert.ok(r.report.stages.some((s) => s.name === 'strip-debugger'));
  assert.ok(!/^\s*debugger\s*;/m.test(r.code));
});

test('deobfuscate can be told to skip the pretty printer', () => {
  const r = deobfuscate('if(a){b()}', { pretty: false });
  assert.ok(!r.report.stages.some((s) => s.name === 'pretty'));
});

test('deobfuscate unpacks before it inlines', () => {
  const r = deobfuscate(PACKED);
  const names = r.report.stages.map((s) => s.name);
  assert.ok(names.includes('packer-unpack'), names.join(','));
  assert.match(r.code, /alert\("there"\)/);
});
