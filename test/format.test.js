// test/format.test.js — cell formatting, batch A (SPEC section 22).
//
// Six optional style keys — ff / fs / va / wrap / rot / bd — ride the EXISTING style path:
// a style patch goes through the server's STYLE_KEYS whitelist, then sanitizeDoc, then the
// engine's setStyle, then the grid paint. This file pins down the two halves of that path
// that live in shared/model.js: the validation every value must survive, and the pure
// geometry helpers (`fontStackFor`, `sanitizeBorder`, `applyBorderPreset`) the toolbar and
// the grid are built on.
//
// Three rules are followed throughout:
//   1. Only what SPEC section 22 guarantees is asserted; nothing here reaches into a
//      private field or depends on an implementation detail.
//   2. Purity is asserted literally — a case that calls a helper also compares a JSON
//      snapshot of every argument taken before the call.
//   3. THE CRITICAL CONSTRAINT gets its own section: a cell carrying none of the six new
//      keys must come out of sanitizeDoc byte-for-byte identical to what went in. Existing
//      documents are not allowed to change shape just because these keys now exist.

import { test, eq } from './run.js';

import {
  FONT_STACKS,
  FONT_LABELS,
  FONT_SIZES,
  DEFAULT_FONT_SIZE,
  BORDER_WIDTHS,
  BORDER_STYLES,
  fontStackFor,
  sanitizeBorder,
  applyBorderPreset,
  sanitizeDoc,
} from '../shared/model.js';

import { SheetEngine } from '../shared/formula/engine.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A deep, order-preserving snapshot used to prove a helper did not mutate its input. */
function snap(value) {
  return JSON.stringify(value);
}

/**
 * Run `fn()` and assert every value in `inputs` is byte-for-byte unchanged afterwards.
 * Returns whatever `fn` returned so the case can keep asserting on the result.
 */
function pure(inputs, fn, label) {
  const before = inputs.map(snap);
  const out = fn();
  for (let i = 0; i < inputs.length; i++) {
    eq(snap(inputs[i]), before[i], (label || 'helper') + ': argument ' + i + ' must not be mutated');
  }
  return out;
}

/** A one-sheet document whose only interesting content is `cells`. */
function docWithCells(cells) {
  return {
    id: 'aaaaaa111111',
    name: '서식 문서',
    sheets: [{ id: 'sh0001', name: '시트1', rows: 200, cols: 26, cells }],
    createdAt: 1730000000000,
    updatedAt: 1730000000000,
    rev: 0,
  };
}

/** Push one style through sanitizeDoc and hand back what survived (null when nothing did). */
function sanitizedStyle(style) {
  const doc = docWithCells({ A1: { input: 'x', style } });
  const out = pure([doc], () => sanitizeDoc(doc), 'sanitizeDoc');
  const cell = out.sheets[0].cells.A1;
  return cell && cell.style ? cell.style : null;
}

/** What survived for ONE style key, or undefined when the key was dropped. */
function survived(key, value) {
  const style = sanitizedStyle({ [key]: value });
  return style ? style[key] : undefined;
}

/** The sides a border patch value names, in the canonical t/r/b/l order: 'tl', 'rb', ... */
function sidesOf(value) {
  if (value === null) return null;
  return ['t', 'r', 'b', 'l'].filter((s) => value[s] !== undefined).join('');
}

/** A whole border patch reduced to { 'A1': 'tl', ... } so a case can assert it in one line. */
function shapeOf(patch) {
  const out = {};
  for (const key of Object.keys(patch)) out[key] = sidesOf(patch[key]);
  return out;
}

/** The 3x3 rectangle A1:C3, in the {r1,c1,r2,c2} form the border helpers speak. */
const RECT3 = { r1: 0, c1: 0, r2: 2, c2: 2 };

/** The nine cells of RECT3, row-major. */
const CELLS3 = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'];

/** A distinctive, fully-specified edge; nothing about it can come from a default. */
const EDGE = { w: 2, s: 'dashed', c: '#112233' };

/** A second edge, used as the border a cell already carries before a preset is applied. */
const PRE = { w: 3, s: 'dotted', c: '#abcdef' };

/** Values no style key may ever accept. JSON-safe, so `pure` can snapshot them. */
const GARBAGE = ['', 'nope', '  ', 0, 1, -1, 3.5, true, false, null, [], ['t'], {}, { w: 1 }];

// ---------------------------------------------------------------------------
// 22.1 — validation of each new key through sanitizeDoc
// ---------------------------------------------------------------------------

test('ff survives for every id in FONT_STACKS', () => {
  for (const id of Object.keys(FONT_STACKS)) {
    eq(survived('ff', id), id, 'ff "' + id + '" is a known font id and must survive');
  }
});

test('an unknown ff is dropped, and dropping it never throws', () => {
  for (const bad of GARBAGE.concat(['Default', 'MONO', 'comic sans', 'gothic ', "'Evil'"])) {
    eq(survived('ff', bad), undefined, 'ff ' + JSON.stringify(bad) + ' is not a known id');
  }
});

test('fs accepts the 6..96 boundary', () => {
  eq(survived('fs', 6), 6, '6 is the smallest legal size');
  eq(survived('fs', 96), 96, '96 is the largest legal size');
  eq(survived('fs', 7), 7, 'and everything in between');
  eq(survived('fs', 13), 13);
  eq(survived('fs', 95), 95);
});

test('an fs outside 6..96 is dropped rather than clamped', () => {
  // Dropping keeps a sender's bug visible: a silently-nudged size would still change the
  // document while looking like it had been accepted.
  eq(survived('fs', 5), undefined, '5 is just below the range');
  eq(survived('fs', 97), undefined, '97 is just above it');
  eq(survived('fs', 0), undefined);
  eq(survived('fs', -12), undefined);
  eq(survived('fs', 1e6), undefined);
});

test('a non-integer fs is dropped, and dropping it never throws', () => {
  for (const bad of [12.5, -0.5, NaN, Infinity, -Infinity, true, null, [], {}, 'huge', '']) {
    eq(survived('fs', bad), undefined, 'fs ' + JSON.stringify(bad) + ' is not an integer 6..96');
  }
});

test('every FONT_SIZES entry is a legal fs', () => {
  eq(Array.isArray(FONT_SIZES) && FONT_SIZES.length > 0, true, 'FONT_SIZES is a non-empty list');
  for (const size of FONT_SIZES) {
    eq(survived('fs', size), size, 'the toolbar offers ' + size + ', so it must validate');
  }
  eq(survived('fs', DEFAULT_FONT_SIZE), DEFAULT_FONT_SIZE, 'so must the default size');
});

test('va accepts top / middle / bottom and drops anything else', () => {
  eq(survived('va', 'top'), 'top');
  eq(survived('va', 'middle'), 'middle');
  eq(survived('va', 'bottom'), 'bottom', "the default is 'bottom', but it is still storable");
  for (const bad of GARBAGE.concat(['center', 'centre', 'baseline', 'Top', 'BOTTOM'])) {
    eq(survived('va', bad), undefined, 'va ' + JSON.stringify(bad) + ' is not one of the three');
  }
});

test('wrap accepts overflow / wrap / clip and drops anything else', () => {
  eq(survived('wrap', 'overflow'), 'overflow');
  eq(survived('wrap', 'wrap'), 'wrap');
  eq(survived('wrap', 'clip'), 'clip');
  for (const bad of GARBAGE.concat(['nowrap', 'Wrap', 'CLIP', 'ellipsis', 'hidden'])) {
    eq(survived('wrap', bad), undefined, 'wrap ' + JSON.stringify(bad) + ' is not one of the three');
  }
});

test('rot accepts -90, 0, 90 and the stacked-vertical v', () => {
  eq(survived('rot', -90), -90, '-90 is the lower bound');
  eq(survived('rot', 0), 0, 'zero survives — it is a value, not an absence');
  eq(survived('rot', 90), 90, '90 is the upper bound');
  eq(survived('rot', 'v'), 'v', "'v' means stacked vertical, not a rotation");
  eq(survived('rot', 45), 45);
  eq(survived('rot', -45), -45);
});

test('rot drops 91, -91 and x, and dropping them never throws', () => {
  eq(survived('rot', 91), undefined, '91 is one degree past the limit');
  eq(survived('rot', -91), undefined, 'and so is -91');
  eq(survived('rot', 'x'), undefined, "'x' is not a rotation");
  for (const bad of [180, 360, 12.5, NaN, Infinity, true, null, [], {}, '', 'vertical', 'vv']) {
    eq(survived('rot', bad), undefined, 'rot ' + JSON.stringify(bad) + ' is not -90..90 or v');
  }
});

test('bd survives a full four-sided spec through sanitizeDoc', () => {
  const bd = {
    t: { w: 1, s: 'solid', c: '#000000' },
    r: { w: 2, s: 'dashed', c: '#ff0000' },
    b: { w: 3, s: 'dotted', c: '#00ff00' },
    l: { w: 1, s: 'solid', c: '#0000ff' },
  };
  eq(sanitizedStyle({ bd }), { bd }, 'every side of a valid border is kept as written');
});

test('a malformed bd is dropped from the style, and dropping it never throws', () => {
  eq(survived('bd', { t: { w: 9, s: 'solid', c: '#000000' } }), undefined, 'width 9 is not 1|2|3');
  eq(survived('bd', { t: { w: 1, s: 'double', c: '#000000' } }), undefined, "'double' is not a style");
  eq(survived('bd', { t: { w: 1, s: 'solid', c: 'red' } }), undefined, "'red' is not '#rrggbb'");
  for (const bad of GARBAGE.concat(['all', 'outer'])) {
    eq(survived('bd', bad), undefined, 'bd ' + JSON.stringify(bad) + ' is not a border spec');
  }
});

test('a bad value for one new key never disturbs the keys around it', () => {
  const style = sanitizedStyle({
    b: 1,
    align: 'right',
    ff: 'nope',
    fs: 400,
    va: 'top',
    wrap: 'sideways',
    rot: 900,
    bd: 'all',
  });
  eq(style, { b: 1, align: 'right', va: 'top' }, 'the valid keys survive, the invalid ones vanish');
});

test('a cell whose only style is invalid keeps its input and loses the style entirely', () => {
  const doc = docWithCells({ A1: { input: 'x', style: { fs: 400, ff: 'nope' } } });
  const out = pure([doc], () => sanitizeDoc(doc), 'sanitizeDoc');
  eq(snap(out.sheets[0].cells.A1), '{"input":"x"}', 'no empty style object is left behind');
});

test('sanitizeDoc never throws on a hostile style, whatever the key', () => {
  const keys = ['ff', 'fs', 'va', 'wrap', 'rot', 'bd'];
  const hostile = GARBAGE.concat([
    'red;}body{display:none}',
    { t: { w: '2', s: 'solid', c: '#000000' } },
    { t: null },
    { nope: { w: 1, s: 'solid', c: '#000000' } },
    -1e9,
    1e9,
  ]);
  for (const key of keys) {
    for (const value of hostile) {
      const style = sanitizedStyle({ [key]: value });
      if (style && style[key] !== undefined) {
        // Whatever survives must itself be legal — re-sanitizing may not change it.
        eq(sanitizedStyle(style), style, key + ' kept a value that must be stable: ' + snap(value));
      }
    }
  }
});

// ---------------------------------------------------------------------------
// THE CRITICAL CONSTRAINT — existing documents are untouched
// ---------------------------------------------------------------------------

test('a cell whose style has none of the six new keys round-trips byte-for-byte', () => {
  // Written in the canonical key order sanitizeStyle emits, so an exact byte comparison is
  // a fair test of "unchanged": same keys, same order, same values.
  const styles = [
    { b: 1 },
    { i: 1, u: 1, s: 1 },
    { align: 'center' },
    { bg: '#ff0000', fg: '#0000ff' },
    { fmt: 'currency', decimals: 2 },
    { b: 1, i: 1, u: 1, s: 1, align: 'right', bg: '#ffffff', fg: '#202124', fmt: 'number', decimals: 4 },
  ];
  for (const style of styles) {
    const before = snap(style);
    const out = sanitizedStyle(style);
    eq(snap(out), before, 'a pre-batch-A style must survive sanitizeDoc unchanged: ' + before);
  }
});

test('sanitizeDoc adds none of the six new keys to a legacy cell', () => {
  const style = sanitizedStyle({ b: 1, align: 'center', fmt: 'percent', decimals: 1 });
  for (const key of ['ff', 'fs', 'va', 'wrap', 'rot', 'bd']) {
    eq(Object.prototype.hasOwnProperty.call(style, key), false, key + ' must be absent, not defaulted');
  }
  eq(Object.keys(style), ['b', 'align', 'fmt', 'decimals'], 'exactly the keys that were there');
});

test('a whole legacy cell map survives sanitizeDoc byte-for-byte', () => {
  const cells = {
    A1: { input: '=SUM(B1:B9)', style: { b: 1 } },
    B1: { input: '12', style: { align: 'right', fmt: 'number', decimals: 2 } },
    C4: { input: '안녕', style: { i: 1, bg: '#fff3cd' } },
    D9: { input: 'plain' },
  };
  const doc = docWithCells(cells);
  const before = snap(cells);
  const out = pure([doc], () => sanitizeDoc(doc), 'sanitizeDoc');
  eq(snap(out.sheets[0].cells), before, 'the document on disk is returned exactly as it was');
});

test('a legacy document is unchanged by a second pass through sanitizeDoc', () => {
  const doc = docWithCells({
    A1: { input: '1', style: { b: 1, align: 'left' } },
    B2: { input: '=A1*2', style: { fmt: 'currency', decimals: 0 } },
  });
  const once = sanitizeDoc(doc);
  const twice = pure([once], () => sanitizeDoc(once), 'sanitizeDoc');
  eq(snap(twice.sheets[0].cells), snap(once.sheets[0].cells), 'sanitizeDoc is idempotent on cells');
});

test('a cell that DOES carry the new keys keeps its legacy keys untouched beside them', () => {
  const style = sanitizedStyle({
    b: 1,
    align: 'center',
    fmt: 'number',
    decimals: 2,
    ff: 'mono',
    fs: 20,
    va: 'middle',
    wrap: 'clip',
    rot: -45,
    bd: { l: { w: 1, s: 'solid', c: '#000000' } },
  });
  eq(style.b, 1);
  eq(style.align, 'center');
  eq(style.fmt, 'number');
  eq(style.decimals, 2);
  eq(style.ff, 'mono');
  eq(style.fs, 20);
  eq(style.va, 'middle');
  eq(style.wrap, 'clip');
  eq(style.rot, -45);
  eq(style.bd, { l: { w: 1, s: 'solid', c: '#000000' } });
});

// ---------------------------------------------------------------------------
// 22.2 — fonts
// ---------------------------------------------------------------------------

test('fontStackFor returns the stack registered for each known id', () => {
  for (const id of Object.keys(FONT_STACKS)) {
    const out = pure([id], () => fontStackFor(id), 'fontStackFor');
    eq(out, FONT_STACKS[id], 'fontStackFor("' + id + '") is its own stack');
  }
});

test('fontStackFor falls back to the default for an unknown id or no id at all', () => {
  const dflt = FONT_STACKS.default;
  eq(fontStackFor('nope'), dflt, 'an unknown id');
  eq(fontStackFor(undefined), dflt, 'undefined — a cell with no ff');
  eq(fontStackFor(null), dflt);
  eq(fontStackFor(''), dflt);
  eq(fontStackFor('DEFAULT'), dflt, 'ids are exact, not case-folded');
  eq(fontStackFor(42), dflt);
  eq(fontStackFor({ id: 'mono' }), dflt);
  eq(fontStackFor(['mono']), dflt);
});

test('fontStackFor can only ever return one of the FONT_STACKS values', () => {
  // This is the injection guarantee: `ff` selects from a closed set, so nothing a client
  // sends can be interpolated into a font-family declaration.
  const allowed = Object.values(FONT_STACKS);
  const attacks = [
    'red;}body{display:none}',
    'x", sans-serif; background:url(//evil)',
    '</style><script>alert(1)</script>',
    'mono ',
    ' mono ',
  ];
  for (const attack of attacks) {
    const out = pure([attack], () => fontStackFor(attack), 'fontStackFor');
    eq(allowed.indexOf(out) >= 0, true, 'the result is a known stack, not caller text');
    eq(out.indexOf(attack) >= 0, false, 'no part of the caller text is echoed back');
  }
  for (const id of Object.keys(FONT_STACKS).concat(['nope', ''])) {
    eq(allowed.indexOf(fontStackFor(id)) >= 0, true, 'every result is a member of the set');
  }
});

test('FONT_LABELS names exactly the ids FONT_STACKS defines', () => {
  eq(Object.keys(FONT_LABELS).sort(), Object.keys(FONT_STACKS).sort(), 'the two maps agree');
  eq(typeof FONT_STACKS.default, 'string', 'there is always a default stack');
  for (const id of Object.keys(FONT_LABELS)) {
    eq(typeof FONT_LABELS[id] === 'string' && FONT_LABELS[id].length > 0, true, id + ' has a label');
  }
});

// ---------------------------------------------------------------------------
// 22.3 — sanitizeBorder
// ---------------------------------------------------------------------------

test('sanitizeBorder keeps a full four-sided spec', () => {
  const bd = {
    t: { w: 1, s: 'solid', c: '#000000' },
    r: { w: 2, s: 'dashed', c: '#ff0000' },
    b: { w: 3, s: 'dotted', c: '#00ff00' },
    l: { w: 2, s: 'solid', c: '#0000ff' },
  };
  const out = pure([bd], () => sanitizeBorder(bd), 'sanitizeBorder');
  eq(out, bd, 'nothing is dropped and nothing is invented');
});

test('sanitizeBorder accepts every legal width and style', () => {
  for (const w of BORDER_WIDTHS) {
    for (const s of BORDER_STYLES) {
      const bd = { t: { w, s, c: '#123456' } };
      eq(sanitizeBorder(bd), bd, w + 'px ' + s + ' is a legal edge');
    }
  }
});

test('sanitizeBorder drops an edge with a bad width and keeps the rest', () => {
  const bd = {
    t: { w: 5, s: 'solid', c: '#000000' },
    b: { w: 2, s: 'solid', c: '#000000' },
  };
  const out = pure([bd], () => sanitizeBorder(bd), 'sanitizeBorder');
  eq(out, { b: { w: 2, s: 'solid', c: '#000000' } }, 'only the bad edge goes');
  // A width that is present but not 1, 2 or 3 takes the whole edge with it.
  for (const w of [0, 4, -1, 1.5, true, [], {}]) {
    eq(sanitizeBorder({ t: { w, s: 'solid', c: '#000000' }, b: bd.b }), { b: bd.b }, 'width ' + snap(w));
  }
});

test('sanitizeBorder drops an edge with a bad style and keeps the rest', () => {
  const good = { w: 1, s: 'solid', c: '#000000' };
  for (const s of ['double', 'none', 'Solid', 'SOLID', '', 1, true, [], {}]) {
    const bd = { t: { w: 1, s, c: '#000000' }, r: good };
    const out = pure([bd], () => sanitizeBorder(bd), 'sanitizeBorder');
    eq(out, { r: good }, 'style ' + snap(s) + ' is not one of solid/dashed/dotted');
  }
});

test('sanitizeBorder drops an edge with a bad colour and keeps the rest', () => {
  const good = { w: 1, s: 'solid', c: '#000000' };
  for (const c of ['red', '#12345', '#gggggg', 'rgb(0,0,0)', '', 0, true, [], {}]) {
    const bd = { l: { w: 1, s: 'solid', c }, b: good };
    const out = pure([bd], () => sanitizeBorder(bd), 'sanitizeBorder');
    eq(out, { b: good }, 'colour ' + snap(c) + ' is not a #rrggbb hex');
  }
});

test('sanitizeBorder returns null when every edge is bad', () => {
  const bd = {
    t: { w: 9, s: 'solid', c: '#000000' },
    r: { w: 1, s: 'groove', c: '#000000' },
    b: { w: 1, s: 'solid', c: 'blue' },
    l: 'solid',
  };
  const out = pure([bd], () => sanitizeBorder(bd), 'sanitizeBorder');
  eq(out, null, 'nothing survived, so the whole border is nothing');
  eq(sanitizeBorder({}), null, 'an empty object names no side at all');
  eq(sanitizeBorder({ x: { w: 1, s: 'solid', c: '#000000' } }), null, "'x' is not a side");
});

test('sanitizeBorder returns null for garbage without throwing', () => {
  const junk = [null, undefined, 'all', 'outer', 0, 1, -1, NaN, true, false, [], ['t'], () => {}, Symbol('b')];
  for (const value of junk) {
    let out;
    let threw = null;
    try {
      out = sanitizeBorder(value);
    } catch (e) {
      threw = e;
    }
    eq(threw, null, 'sanitizeBorder must never throw, and it threw on ' + String(value));
    eq(out, null, 'garbage is not a border: ' + String(value));
  }
});

test('sanitizeBorder neither mutates its input nor shares an edge with it', () => {
  const bd = { t: { w: 2, s: 'dashed', c: '#112233' }, b: { w: 1, s: 'solid', c: '#000000' } };
  const before = snap(bd);
  const out = sanitizeBorder(bd);
  eq(snap(bd), before, 'the argument is only ever read');

  out.t.w = 3;
  out.b = { w: 3, s: 'dotted', c: '#ffffff' };
  delete out.t.c;
  eq(snap(bd), before, 'and mutating the result cannot reach back into it');
});

// ---------------------------------------------------------------------------
// 22.3 — applyBorderPreset
// ---------------------------------------------------------------------------

test('every preset over a 3x3 rect touches exactly the documented cells and sides', () => {
  // A1:C3. Read each expectation as "cell -> the sides that cell receives".
  const expected = {
    all: {
      A1: 'trbl', B1: 'trbl', C1: 'trbl',
      A2: 'trbl', B2: 'trbl', C2: 'trbl',
      A3: 'trbl', B3: 'trbl', C3: 'trbl',
    },
    outer: {
      A1: 'tl', B1: 't', C1: 'tr',
      A2: 'l', /* B2 untouched */ C2: 'r',
      A3: 'bl', B3: 'b', C3: 'rb',
    },
    inner: {
      A1: 'rb', B1: 'rb', C1: 'b',
      A2: 'rb', B2: 'rb', C2: 'b',
      A3: 'r', B3: 'r', /* C3 owns no interior edge */
    },
    horizontal: {
      A1: 'b', B1: 'b', C1: 'b',
      A2: 'b', B2: 'b', C2: 'b',
    },
    vertical: {
      A1: 'r', B1: 'r',
      A2: 'r', B2: 'r',
      A3: 'r', B3: 'r',
    },
    top: { A1: 't', B1: 't', C1: 't' },
    right: { C1: 'r', C2: 'r', C3: 'r' },
    bottom: { A3: 'b', B3: 'b', C3: 'b' },
    left: { A1: 'l', A2: 'l', A3: 'l' },
    none: {
      A1: null, B1: null, C1: null,
      A2: null, B2: null, C2: null,
      A3: null, B3: null, C3: null,
    },
  };

  for (const preset of Object.keys(expected)) {
    const patch = pure([RECT3, EDGE], () => applyBorderPreset(RECT3, preset, EDGE), 'applyBorderPreset');
    eq(shapeOf(patch), expected[preset], "preset '" + preset + "' touches the wrong cells or sides");
    eq(Object.keys(patch).sort(), Object.keys(expected[preset]).sort(), "preset '" + preset + "' cell set");
  }
});

test("'outer' never touches the centre cell of a 3x3 rect", () => {
  const patch = applyBorderPreset(RECT3, 'outer', EDGE);
  eq(Object.prototype.hasOwnProperty.call(patch, 'B2'), false, 'B2 is interior, so it is absent');
  eq(Object.keys(patch).length, 8, 'the perimeter is eight cells');
  // Each perimeter cell gets exactly the sides that face out of the rectangle.
  eq(sidesOf(patch.A1), 'tl', 'the top-left corner owns two lines');
  eq(sidesOf(patch.C3), 'rb', 'so does the bottom-right corner');
  eq(sidesOf(patch.B1), 't', 'a top-edge cell owns one');
  eq(sidesOf(patch.A2), 'l', 'and a left-edge cell owns one');
});

test("'inner' never writes a side that lies on the rectangle's perimeter", () => {
  const patch = applyBorderPreset(RECT3, 'inner', EDGE);
  for (const a1 of Object.keys(patch)) {
    const row = Number(a1.slice(1)) - 1;
    const col = a1.charCodeAt(0) - 65;
    const sides = patch[a1];
    if (row === RECT3.r1) eq(sides.t, undefined, a1 + ' is on the top edge, so it may not get t');
    if (row === RECT3.r2) eq(sides.b, undefined, a1 + ' is on the bottom edge, so it may not get b');
    if (col === RECT3.c1) eq(sides.l, undefined, a1 + ' is on the left edge, so it may not get l');
    if (col === RECT3.c2) eq(sides.r, undefined, a1 + ' is on the right edge, so it may not get r');
  }
  eq(Object.prototype.hasOwnProperty.call(patch, 'C3'), false, 'the far corner owns no interior edge');
});

test("'horizontal' and 'vertical' each touch only their own axis", () => {
  const h = applyBorderPreset(RECT3, 'horizontal', EDGE);
  for (const a1 of Object.keys(h)) {
    eq(sidesOf(h[a1]), 'b', a1 + ': a horizontal line is written as a bottom edge only');
    eq(h[a1].t, undefined, a1 + ' gets no top');
    eq(h[a1].l, undefined, a1 + ' gets no left');
    eq(h[a1].r, undefined, a1 + ' gets no right');
  }
  const v = applyBorderPreset(RECT3, 'vertical', EDGE);
  for (const a1 of Object.keys(v)) {
    eq(sidesOf(v[a1]), 'r', a1 + ': a vertical line is written as a right edge only');
    eq(v[a1].t, undefined, a1 + ' gets no top');
    eq(v[a1].b, undefined, a1 + ' gets no bottom');
    eq(v[a1].l, undefined, a1 + ' gets no left');
  }
  eq(Object.keys(h).sort(), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], 'the bottom row owns no inner line');
  eq(Object.keys(v).sort(), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'], 'the right column owns none either');
});

test("'none' clears every cell of the rect", () => {
  const patch = pure([RECT3, EDGE], () => applyBorderPreset(RECT3, 'none', EDGE), 'applyBorderPreset');
  eq(Object.keys(patch).sort(), CELLS3.slice().sort(), 'all nine cells are named');
  for (const a1 of CELLS3) {
    eq(patch[a1], null, a1 + ' is cleared outright, not given empty sides');
  }
  // 'none' ignores the edge entirely — there is nothing for it to draw with.
  eq(applyBorderPreset(RECT3, 'none'), patch, 'and it needs no edge at all');
});

test('a 1x1 rect yields an empty patch for inner, horizontal and vertical', () => {
  const one = { r1: 4, c1: 1, r2: 4, c2: 1 }; // B5
  for (const preset of ['inner', 'horizontal', 'vertical']) {
    const patch = pure([one, EDGE], () => applyBorderPreset(one, preset, EDGE), 'applyBorderPreset');
    eq(patch, {}, "a single cell has no shared edges, so '" + preset + "' writes nothing");
  }
  // The perimeter presets still work on it: the whole cell IS the perimeter.
  eq(shapeOf(applyBorderPreset(one, 'outer', EDGE)), { B5: 'trbl' }, "'outer' gives it all four sides");
  eq(shapeOf(applyBorderPreset(one, 'all', EDGE)), { B5: 'trbl' }, "and so does 'all'");
  eq(shapeOf(applyBorderPreset(one, 'top', EDGE)), { B5: 't' }, "'top' gives it just the top");
  eq(shapeOf(applyBorderPreset(one, 'none', EDGE)), { B5: null }, "'none' clears it");
});

test('every side a preset writes carries the requested edge, and no two cells share one', () => {
  for (const preset of ['all', 'outer', 'inner', 'horizontal', 'vertical', 'top', 'right', 'bottom', 'left']) {
    const patch = applyBorderPreset(RECT3, preset, EDGE);
    for (const a1 of Object.keys(patch)) {
      for (const side of Object.keys(patch[a1])) {
        eq(patch[a1][side], EDGE, preset + ' ' + a1 + '.' + side + ' must be the edge that was asked for');
      }
    }
  }
  // Independence: writing through one cell's edge may not change another's.
  const patch = applyBorderPreset(RECT3, 'all', EDGE);
  patch.A1.t.w = 3;
  patch.A1.t.c = '#ffffff';
  eq(patch.B1.t, EDGE, 'B1 has its own copy of the edge');
  eq(patch.A1.r, EDGE, 'so does every other side of A1');
  eq(snap(EDGE), '{"w":2,"s":"dashed","c":"#112233"}', 'and the caller-supplied edge is untouched');
});

test('applyBorderPreset accepts the grid selection shape and orders the corners', () => {
  const sel = { s: { row: 2, col: 2 }, e: { row: 0, col: 0 } }; // C3 dragged back to A1
  const patch = pure([sel, EDGE], () => applyBorderPreset(sel, 'outer', EDGE), 'applyBorderPreset');
  eq(shapeOf(patch), shapeOf(applyBorderPreset(RECT3, 'outer', EDGE)), 'a bottom-up drag is the same rect');
});

test('applyBorderPreset never throws and mutates nothing it is handed', () => {
  const junk = [null, undefined, 'all', 0, [], { r1: 'x' }, { s: {}, e: {} }];
  for (const rect of junk) {
    let threw = null;
    let out;
    try {
      out = applyBorderPreset(rect, 'outer', EDGE);
    } catch (e) {
      threw = e;
    }
    eq(threw, null, 'a malformed rect must not throw: ' + String(rect));
    eq(out !== null && typeof out === 'object', true, 'and it still returns a patch object');
  }
  for (const preset of [null, undefined, 42, 'nonsense', [], {}]) {
    let threw = null;
    let out;
    try {
      out = applyBorderPreset(RECT3, preset, EDGE);
    } catch (e) {
      threw = e;
    }
    eq(threw, null, 'an unknown preset must not throw: ' + String(preset));
    eq(out !== null && typeof out === 'object', true, 'and it still returns a patch object');
  }
  const rect = { r1: 0, c1: 0, r2: 2, c2: 2 };
  const edge = { w: 1, s: 'solid', c: '#000000' };
  const before = [snap(rect), snap(edge)];
  applyBorderPreset(rect, 'all', edge);
  applyBorderPreset(rect, 'none', edge);
  eq([snap(rect), snap(edge)], before, 'neither the rect nor the edge is ever written to');
});

test('a border patch is valid input for the style path it feeds', () => {
  // Whatever applyBorderPreset produces has to survive sanitizeDoc, or the toolbar would be
  // able to build a border the document refuses to store.
  const patch = applyBorderPreset(RECT3, 'all', EDGE);
  for (const a1 of Object.keys(patch)) {
    eq(sanitizeBorder(patch[a1]), patch[a1], a1 + ': the preset edge must validate as stored');
    eq(sanitizedStyle({ bd: patch[a1] }), { bd: patch[a1] }, a1 + ': and survive sanitizeDoc');
  }
});

// ---------------------------------------------------------------------------
// merging a preset into the border a cell already has
// ---------------------------------------------------------------------------

/**
 * The merge recipe SPEC 22.3 documents: a patch value names only the sides the preset
 * applies, so the caller spreads it over the cell's current `bd`; `null` clears the key.
 */
function applyPatchToEngine(engine, patch) {
  for (const a1 of Object.keys(patch)) {
    const sides = patch[a1];
    const current = engine.getStyle(a1).bd;
    engine.setStyle(a1, { bd: sides === null ? null : { ...(current || {}), ...sides } });
  }
}

test('a preset patch names only its own sides, so it merges instead of replacing', () => {
  const engine = new SheetEngine({ rows: 20, cols: 10 });
  for (const a1 of CELLS3) engine.setStyle(a1, { bd: { t: PRE, l: PRE } });

  const patch = applyBorderPreset(RECT3, 'bottom', EDGE);
  eq(Object.keys(patch).sort(), ['A3', 'B3', 'C3'], "'bottom' is the bottom row only");
  eq(sidesOf(patch.A3), 'b', 'and it names one side, not four');

  applyPatchToEngine(engine, patch);

  eq(engine.getStyle('A3').bd, { t: PRE, l: PRE, b: EDGE }, 'the new side joins the existing ones');
  eq(engine.getStyle('A1').bd, { t: PRE, l: PRE }, 'a cell the preset skips is left exactly as it was');
  eq(engine.getStyle('B2').bd, { t: PRE, l: PRE }, 'including the interior');
});

test('a preset overwrites only the side it owns, leaving the other three alone', () => {
  const engine = new SheetEngine({ rows: 20, cols: 10 });
  engine.setStyle('A1', { bd: { t: PRE, r: PRE, b: PRE, l: PRE } });

  applyPatchToEngine(engine, applyBorderPreset(RECT3, 'top', EDGE));
  eq(engine.getStyle('A1').bd, { t: EDGE, r: PRE, b: PRE, l: PRE }, 'only the top line was redrawn');

  applyPatchToEngine(engine, applyBorderPreset(RECT3, 'left', EDGE));
  eq(engine.getStyle('A1').bd, { t: EDGE, r: PRE, b: PRE, l: EDGE }, 'and now only the left one');
});

test("'none' replaces rather than merges: it clears the whole border", () => {
  const engine = new SheetEngine({ rows: 20, cols: 10 });
  for (const a1 of CELLS3) engine.setStyle(a1, { bd: { t: PRE, r: PRE, b: PRE, l: PRE } });
  engine.setStyle('A1', { b: 1 });

  applyPatchToEngine(engine, applyBorderPreset(RECT3, 'none', EDGE));

  for (const a1 of CELLS3) {
    eq(engine.getStyle(a1).bd, undefined, a1 + ' has no border left at all');
  }
  eq(engine.getStyle('A1').b, 1, 'and clearing borders leaves the rest of the style intact');
});

test('outer then inner covers every edge of the rectangle exactly once', () => {
  // The two presets are complements: together they draw the full grid, and no cell ends up
  // with a side written twice.
  const engine = new SheetEngine({ rows: 20, cols: 10 });
  const outer = applyBorderPreset(RECT3, 'outer', EDGE);
  const inner = applyBorderPreset(RECT3, 'inner', EDGE);
  for (const a1 of CELLS3) {
    const a = outer[a1] ? Object.keys(outer[a1]) : [];
    const b = inner[a1] ? Object.keys(inner[a1]) : [];
    for (const side of a) eq(b.indexOf(side) >= 0, false, a1 + '.' + side + ' is written by both presets');
  }

  applyPatchToEngine(engine, outer);
  applyPatchToEngine(engine, inner);
  eq(engine.getStyle('A1').bd, { t: EDGE, l: EDGE, r: EDGE, b: EDGE }, 'A1 ends up fully boxed');
  eq(engine.getStyle('B2').bd, { r: EDGE, b: EDGE }, 'the centre owns only its two interior lines');
  eq(engine.getStyle('C3').bd, { r: EDGE, b: EDGE }, 'the far corner owns only its two perimeter lines');
});
