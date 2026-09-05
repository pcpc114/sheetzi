// test/merge.test.js — merged cells (SPEC section 21).
//
// Everything under test here is a pure helper in shared/model.js. Merge geometry is
// decided in exactly one place, so this file is where that geometry gets pinned down:
// the invariants of `normalizeMergeList`, the fixed-point growth of `expandOverMerges`,
// the three modes of `planMerge`, and how a rectangle survives (or does not survive) a
// structural edit.
//
// Two rules are followed throughout:
//   1. Only what SPEC section 21 guarantees is asserted; nothing here reaches into a
//      private field or depends on an implementation detail.
//   2. Purity is asserted literally — a case that calls a helper also compares a JSON
//      snapshot of every argument taken before the call.
//
// The integration case at the bottom is the proof of the decision the whole feature
// rests on: a merge KEEPS the anchor and CLEARS every other covered cell, so the covered
// cells are genuinely empty and nothing under shared/formula/ needs merge awareness.

import { test, eq } from './run.js';

import {
  MAX_MERGES,
  normalizeMergeList,
  mergeRect,
  mergeAnchor,
  mergeAt,
  expandOverMerges,
  planMerge,
  planUnmerge,
  shiftMerges,
  sanitizeDoc,
  emptyDoc,
  emptySheet,
  duplicateSheet,
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

/** The {r1,c1,r2,c2} geometry form the merge helpers speak (0-indexed, inclusive). */
function rect(r1, c1, r2, c2) {
  return { r1, c1, r2, c2 };
}

/** A one-sheet document whose only interesting field is `merges`. */
function docWith(merges, rows, cols) {
  return sanitizeDoc({
    id: 'aaaaaa111111',
    name: '병합 문서',
    sheets: [
      {
        id: 'sh0001',
        name: '시트1',
        rows: rows === undefined ? 200 : rows,
        cols: cols === undefined ? 26 : cols,
        merges,
      },
    ],
    createdAt: 1730000000000,
    updatedAt: 1730000000000,
    rev: 3,
  });
}

// ---------------------------------------------------------------------------
// normalizeMergeList — every invariant of SPEC 21.1
// ---------------------------------------------------------------------------

test('normalizeMergeList passes a valid list through, sorted by row then column', () => {
  eq(normalizeMergeList(['A1:C1', 'B4:B8'], 200, 26), ['A1:C1', 'B4:B8'], 'already sorted');
  eq(normalizeMergeList(['B4:B8', 'A1:C1'], 200, 26), ['A1:C1', 'B4:B8'], 'sorted by row first');
  eq(
    normalizeMergeList(['C1:D1', 'A1:B1', 'A3:B3'], 200, 26),
    ['A1:B1', 'C1:D1', 'A3:B3'],
    'same row: sorted by column'
  );
  eq(normalizeMergeList([], 200, 26), [], 'an empty list stays empty');
  eq(normalizeMergeList(['A1:C1'], 200, 26), ['A1:C1'], 'a single entry passes through');
});

test('normalizeMergeList drops a 1x1 range', () => {
  eq(normalizeMergeList(['A1:A1'], 200, 26), [], 'a 1x1 range is not a merge');
  eq(normalizeMergeList(['B7:B7'], 200, 26), [], 'anywhere on the sheet');
  eq(normalizeMergeList(['A1'], 200, 26), [], 'a bare cell reference is not a merge either');
  eq(normalizeMergeList(['A1:A1', 'A1:C1'], 200, 26), ['A1:C1'], 'the real merge beside it survives');
  eq(normalizeMergeList(['A1:A2'], 200, 26), ['A1:A2'], 'two cells IS a merge');
  eq(normalizeMergeList(['A1:B1'], 200, 26), ['A1:B1'], 'two cells across is a merge too');
});

test('normalizeMergeList reorders a reversed range', () => {
  eq(normalizeMergeList(['C3:A1'], 200, 26), ['A1:C3'], 'both axes reversed');
  eq(normalizeMergeList(['C1:A1'], 200, 26), ['A1:C1'], 'columns reversed');
  eq(normalizeMergeList(['A3:A1'], 200, 26), ['A1:A3'], 'rows reversed');
  eq(normalizeMergeList(['A3:C1'], 200, 26), ['A1:C3'], 'one axis each way');
});

test('normalizeMergeList strips dollar signs and uppercases', () => {
  eq(normalizeMergeList(['$A$1:$C$1'], 200, 26), ['A1:C1'], 'fully absolute');
  eq(normalizeMergeList(['A$1:$C1'], 200, 26), ['A1:C1'], 'mixed absolute');
  eq(normalizeMergeList(['a1:c1'], 200, 26), ['A1:C1'], 'lowercase');
  eq(normalizeMergeList(['$b$4:b$8'], 200, 26), ['B4:B8'], 'lowercase and absolute together');
  eq(normalizeMergeList(['aa1:ab2'], 200, 702), ['AA1:AB2'], 'two-letter columns');
});

test('normalizeMergeList clips a range that hangs off the sheet edge', () => {
  eq(normalizeMergeList(['A1:AZ1'], 200, 26), ['A1:Z1'], 'clipped to the last column');
  eq(normalizeMergeList(['A199:A250'], 200, 26), ['A199:A200'], 'clipped to the last row');
  eq(normalizeMergeList(['Y199:AB250'], 200, 26), ['Y199:Z200'], 'clipped on both axes');
  eq(normalizeMergeList(['A1:C1'], 200, 26), ['A1:C1'], 'a range well inside is left alone');
});

test('normalizeMergeList drops a range that starts outside the sheet', () => {
  eq(normalizeMergeList(['A201:C205'], 200, 26), [], 'starts past the last row');
  eq(normalizeMergeList(['AA1:AC1'], 200, 26), [], 'starts past the last column');
  eq(normalizeMergeList(['Z1:AB1'], 200, 26), [], 'clipping it leaves a single cell, so it goes too');
  eq(normalizeMergeList(['A201:C205', 'A1:C1'], 200, 26), ['A1:C1'], 'the in-bounds entry survives');
});

test('normalizeMergeList keeps the FIRST of two overlapping entries', () => {
  eq(normalizeMergeList(['A1:C1', 'B1:D1'], 200, 26), ['A1:C1'], 'the later overlapping entry is dropped');
  eq(normalizeMergeList(['B1:D1', 'A1:C1'], 200, 26), ['B1:D1'], 'input order decides, not sort order');
  eq(normalizeMergeList(['A1:C3', 'B2:B2'], 200, 26), ['A1:C3'], 'a contained entry loses');
  eq(
    normalizeMergeList(['A1:B2', 'B2:C3', 'C3:D4'], 200, 26),
    ['A1:B2', 'C3:D4'],
    'a chain of overlaps: the first wins, the next free one is kept'
  );
  eq(
    normalizeMergeList(['A1:B1', 'C1:D1'], 200, 26),
    ['A1:B1', 'C1:D1'],
    'merely adjacent rectangles do not overlap'
  );
});

test('normalizeMergeList drops garbage without throwing', () => {
  eq(normalizeMergeList([null, 42, 'nonsense', [], {}, 'A1:C1'], 200, 26), ['A1:C1'], 'the spec cases');
  eq(
    normalizeMergeList([undefined, true, NaN, -1, '', '   ', ':', 'A1:', ':C1', 'A1:B2:C3'], 200, 26),
    [],
    'nothing usable survives'
  );
  eq(normalizeMergeList(['시트2!A1:B2'], 200, 26), [], 'a sheet-qualified range is a reference, not a merge');
  eq(normalizeMergeList(['A0:C0'], 200, 26), [], 'row 0 does not exist in A1 notation');
  eq(normalizeMergeList([{ r1: 0, c1: 0, r2: 0, c2: 2 }], 200, 26), [], 'a rect object is not a stored entry');
});

test('normalizeMergeList returns an empty array for a non-array argument', () => {
  eq(normalizeMergeList('A1:C1', 200, 26), [], 'a bare string');
  eq(normalizeMergeList(null, 200, 26), [], 'null');
  eq(normalizeMergeList(undefined, 200, 26), [], 'undefined');
  eq(normalizeMergeList(42, 200, 26), [], 'a number');
  eq(normalizeMergeList({ 0: 'A1:C1' }, 200, 26), [], 'an array-like object');
  eq(normalizeMergeList(['A1:C1']), ['A1:C1'], 'omitted dimensions still validate the shape');
});

test('normalizeMergeList caps the list at MAX_MERGES', () => {
  const many = [];
  for (let i = 0; i < MAX_MERGES + 25; i++) many.push('A' + (i * 2 + 1) + ':B' + (i * 2 + 1));

  const capped = normalizeMergeList(many, 5000, 26);
  eq(capped.length, MAX_MERGES, 'the surplus is dropped');
  eq(capped[0], 'A1:B1', 'the earliest entry is kept');
  eq(capped[MAX_MERGES - 1], 'A' + ((MAX_MERGES - 1) * 2 + 1) + ':B' + ((MAX_MERGES - 1) * 2 + 1), 'the cap keeps a prefix');

  eq(normalizeMergeList(many.slice(0, MAX_MERGES), 5000, 26).length, MAX_MERGES, 'exactly MAX_MERGES all fit');
  eq(normalizeMergeList(many.slice(0, MAX_MERGES - 1), 5000, 26).length, MAX_MERGES - 1, 'below the cap nothing is lost');
});

// ---------------------------------------------------------------------------
// mergeRect / mergeAnchor / mergeAt
// ---------------------------------------------------------------------------

test('mergeRect returns 0-indexed inclusive geometry', () => {
  eq(mergeRect('A1:C2'), rect(0, 0, 1, 2), 'A1:C2 spans rows 0..1 and columns 0..2');
  eq(mergeRect('B4:D9'), rect(3, 1, 8, 3), 'off the origin');
  eq(mergeRect('A1:A2'), rect(0, 0, 1, 0), 'a vertical pair');
  eq(mergeRect('c2:$a$1'), rect(0, 0, 1, 2), 'case, $ and corner order are all normalized');
  eq(mergeRect('nonsense'), null, 'garbage yields null, never a throw');
  eq(mergeRect(''), null, 'an empty string');
  eq(mergeRect(null), null, 'null');
  eq(mergeRect(42), null, 'a number');
});

test('mergeAnchor returns the top-left cell of a merge', () => {
  eq(mergeAnchor('A1:C2'), { row: 0, col: 0 }, 'the origin');
  eq(mergeAnchor('B4:D9'), { row: 3, col: 1 }, 'B4 is row 3, column 1');
  eq(mergeAnchor('D9:B4'), { row: 3, col: 1 }, 'a reversed range still anchors at its top-left');
  eq(mergeAnchor('$B$4:$D$9'), { row: 3, col: 1 }, 'dollar signs are irrelevant');
  eq(mergeAnchor('nonsense'), null, 'garbage yields null');
  eq(mergeAnchor(null), null, 'null');
});

test('mergeAt finds the merge covering a cell, and null just outside it', () => {
  const merges = ['A1:C1', 'B4:B8'];

  eq(mergeAt(merges, 0, 0), 'A1:C1', 'the anchor');
  eq(mergeAt(merges, 0, 1), 'A1:C1', 'a covered cell');
  eq(mergeAt(merges, 0, 2), 'A1:C1', 'the far corner');
  eq(mergeAt(merges, 3, 1), 'B4:B8', 'the second merge, at its anchor');
  eq(mergeAt(merges, 7, 1), 'B4:B8', 'the second merge, at its end');
  eq(mergeAt(merges, 5, 1), 'B4:B8', 'the second merge, in the middle');

  eq(mergeAt(merges, 0, 3), null, 'one column past the right edge');
  eq(mergeAt(merges, 1, 2), null, 'one row below the bottom edge');
  eq(mergeAt(merges, 2, 1), null, 'one row above B4:B8');
  eq(mergeAt(merges, 8, 1), null, 'one row below B4:B8');
  eq(mergeAt(merges, 5, 0), null, 'one column left of B4:B8');
  eq(mergeAt(merges, 5, 2), null, 'one column right of B4:B8');

  eq(mergeAt([], 0, 0), null, 'an empty list covers nothing');
  eq(mergeAt(null, 0, 0), null, 'a non-array list covers nothing');
  eq(mergeAt(['nonsense'], 0, 0), null, 'an unparseable entry covers nothing');
});

test('mergeAt returns the entry exactly as it is stored', () => {
  const merges = normalizeMergeList(['$c$1:a$1'], 200, 26);
  const hit = mergeAt(merges, 0, 1);
  eq(hit, 'A1:C1', 'the canonical string');
  eq(merges.indexOf(hit) >= 0, true, 'so merges.indexOf(mergeAt(...)) finds it');
});

// ---------------------------------------------------------------------------
// expandOverMerges — the fixed point
// ---------------------------------------------------------------------------

test('expandOverMerges grows a rect that clips one merge', () => {
  eq(expandOverMerges(['A1:C1'], rect(0, 0, 0, 0)), rect(0, 0, 0, 2), 'a click on the anchor takes the whole merge');
  eq(expandOverMerges(['A1:C1'], rect(0, 1, 0, 1)), rect(0, 0, 0, 2), 'a click on a covered cell too');
  eq(expandOverMerges(['B4:B8'], rect(4, 1, 5, 1)), rect(3, 1, 7, 1), 'growth happens on both ends of an axis');
  eq(expandOverMerges(['B2:C3'], rect(0, 0, 2, 1)), rect(0, 0, 2, 2), 'growth on the other axis as well');
});

test('expandOverMerges reaches a fixed point through a chain of merges', () => {
  // A1:B1 is clipped by the starting rect. Swallowing it widens the rect to column B,
  // which brings B2:C2 into partial overlap; that must be swallowed too.
  const chain = ['A1:B1', 'B2:C2'];
  eq(expandOverMerges(chain, rect(0, 0, 1, 0)), rect(0, 0, 1, 2), 'both merges end up contained');
  eq(
    expandOverMerges(['B2:C2', 'A1:B1'], rect(0, 0, 1, 0)),
    rect(0, 0, 1, 2),
    'and the answer does not depend on the order of the list'
  );

  // A longer chain, one step per column, to prove the loop really iterates.
  const stairs = ['A1:B1', 'B2:C2', 'C3:D3', 'D4:E4'];
  eq(expandOverMerges(stairs, rect(0, 0, 3, 0)), rect(0, 0, 3, 4), 'four links are all followed');
  eq(expandOverMerges(stairs, rect(0, 0, 0, 0)), rect(0, 0, 0, 1), 'a rect that only touches the first link stops there');
});

test('expandOverMerges leaves a rect that partially covers nothing unchanged', () => {
  eq(expandOverMerges(['E5:F6'], rect(0, 0, 1, 1)), rect(0, 0, 1, 1), 'no merge is touched at all');
  eq(expandOverMerges(['B2:C2'], rect(0, 0, 3, 3)), rect(0, 0, 3, 3), 'a merge already wholly inside does not grow it');
  eq(expandOverMerges(['A1:C1'], rect(0, 0, 0, 2)), rect(0, 0, 0, 2), 'a rect exactly matching a merge is stable');
  eq(expandOverMerges([], rect(2, 2, 4, 4)), rect(2, 2, 4, 4), 'an empty merge list changes nothing');
  eq(expandOverMerges(null, rect(2, 2, 4, 4)), rect(2, 2, 4, 4), 'nor does a non-array list');
});

test('expandOverMerges is idempotent', () => {
  const merges = ['A1:B1', 'B2:C2', 'E5:F6'];
  const once = expandOverMerges(merges, rect(0, 0, 1, 0));
  const twice = expandOverMerges(merges, once);
  eq(twice, once, 'expanding an expanded rect changes nothing');
});

// ---------------------------------------------------------------------------
// planMerge
// ---------------------------------------------------------------------------

test('planMerge "all" makes one rectangle and clears every covered cell but the anchor', () => {
  const plan = planMerge(['B5:C5'], rect(0, 0, 1, 2), 'all');
  eq(plan.merges, ['A1:C2', 'B5:C5'], 'one new rectangle; the distant merge is untouched');
  eq(plan.clear, ['B1', 'C1', 'A2', 'B2', 'C2'], 'every covered cell except A1, in reading order');

  const wide = planMerge([], rect(0, 0, 2, 2), 'all');
  eq(wide.merges, ['A1:C3'], '3x3 becomes one rectangle');
  eq(wide.clear, ['B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'], 'clear is sorted row-major');

  const pair = planMerge([], rect(0, 0, 0, 1), 'all');
  eq(pair.merges, ['A1:B1'], 'the smallest possible merge');
  eq(pair.clear, ['B1'], 'clearing exactly one cell');
});

test('planMerge "all" of a single cell produces nothing', () => {
  const plan = planMerge(['E5:F5'], rect(0, 0, 0, 0), 'all');
  eq(plan.merges, ['E5:F5'], 'a 1x1 selection is not a merge, and the existing list is kept');
  eq(plan.clear, [], 'so nothing is cleared');
});

test('planMerge "horizontal" makes one rectangle per row', () => {
  const plan = planMerge(['B5:C5'], rect(0, 0, 1, 2), 'horizontal');
  eq(plan.merges, ['A1:C1', 'A2:C2', 'B5:C5'], 'one rectangle per row, each spanning the full width');
  eq(plan.clear, ['B1', 'C1', 'B2', 'C2'], 'each row keeps its own anchor');

  const three = planMerge([], rect(2, 1, 4, 2), 'horizontal');
  eq(three.merges, ['B3:C3', 'B4:C4', 'B5:C5'], 'three rows, three rectangles');
  eq(three.clear, ['C3', 'C4', 'C5'], 'one cleared cell per row');
});

test('planMerge "horizontal" over a single-column selection produces no merges', () => {
  const plan = planMerge([], rect(0, 0, 3, 0), 'horizontal');
  eq(plan.merges, [], 'a one-cell-wide row cannot be merged horizontally');
  eq(plan.clear, [], 'and nothing is cleared');

  const kept = planMerge(['E5:F5'], rect(0, 0, 3, 0), 'horizontal');
  eq(kept.merges, ['E5:F5'], 'an unrelated existing merge is still kept');
  eq(kept.clear, [], 'still nothing to clear');
});

test('planMerge "vertical" makes one rectangle per column', () => {
  const plan = planMerge(['B5:C5'], rect(0, 0, 1, 2), 'vertical');
  eq(plan.merges, ['A1:A2', 'B1:B2', 'C1:C2', 'B5:C5'], 'one rectangle per column, each full height');
  eq(plan.clear, ['A2', 'B2', 'C2'], 'each column keeps its own anchor, and clear is still row-major');

  const tall = planMerge([], rect(0, 0, 2, 1), 'vertical');
  eq(tall.merges, ['A1:A3', 'B1:B3'], 'two columns, two rectangles');
  eq(tall.clear, ['A2', 'B2', 'A3', 'B3'], 'sorted by row before column');
});

test('planMerge "vertical" over a single-row selection produces no merges', () => {
  const plan = planMerge([], rect(0, 0, 0, 3), 'vertical');
  eq(plan.merges, [], 'a one-cell-tall column cannot be merged vertically');
  eq(plan.clear, [], 'and nothing is cleared');

  const kept = planMerge(['E5:F5'], rect(0, 0, 0, 3), 'vertical');
  eq(kept.merges, ['E5:F5'], 'an unrelated existing merge is still kept');
  eq(kept.clear, [], 'still nothing to clear');
});

test('planMerge treats an unknown mode as "all"', () => {
  const expected = planMerge([], rect(0, 0, 1, 2), 'all');
  eq(planMerge([], rect(0, 0, 1, 2), 'diagonal'), expected, 'an invented mode');
  eq(planMerge([], rect(0, 0, 1, 2)), expected, 'an omitted mode');
  eq(planMerge([], rect(0, 0, 1, 2), null), expected, 'null');
  eq(planMerge([], rect(0, 0, 1, 2), 'HORIZONTAL'), expected, 'the mode is matched exactly, not case-insensitively');
});

test('planMerge absorbs an existing overlapping merge rather than leaving an overlap behind', () => {
  const plan = planMerge(['B1:B3'], rect(0, 0, 0, 2), 'all');
  eq(plan.merges, ['A1:C1'], 'the intersecting rectangle is gone, replaced by the new one');
  eq(plan.clear, ['B1', 'C1'], 'the new rectangle still clears everything but its anchor');
  eq(normalizeMergeList(plan.merges, 200, 26), plan.merges, 'the result is already canonical and overlap-free');

  const mixed = planMerge(['A1:B1', 'D1:E1', 'A5:B5'], rect(0, 0, 1, 3), 'all');
  eq(mixed.merges, ['A1:D2', 'A5:B5'], 'both intersecting merges absorbed, the distant one kept');

  const perRow = planMerge(['A1:C2'], rect(0, 0, 1, 2), 'horizontal');
  eq(perRow.merges, ['A1:C1', 'A2:C2'], 'a block merge can be replaced by per-row merges');
});

// ---------------------------------------------------------------------------
// planUnmerge
// ---------------------------------------------------------------------------

test('planUnmerge drops every intersecting merge and leaves the others alone', () => {
  eq(planUnmerge(['A1:C1', 'B5:C5'], rect(0, 0, 0, 0)), { merges: ['B5:C5'] }, 'one cell inside a merge unmerges it');
  eq(
    planUnmerge(['A1:B1', 'D1:E1', 'A5:A7'], rect(0, 0, 0, 3)),
    { merges: ['A5:A7'] },
    'a range that clips two merges drops both'
  );
  eq(
    planUnmerge(['A1:B1', 'D5:E5'], rect(9, 9, 9, 9)),
    { merges: ['A1:B1', 'D5:E5'] },
    'a selection touching no merge changes nothing'
  );
  eq(planUnmerge(['A1:B1', 'D5:E5'], rect(0, 0, 199, 25)), { merges: [] }, 'select-all unmerges everything');
  eq(planUnmerge([], rect(0, 0, 1, 1)), { merges: [] }, 'unmerging an empty list is a no-op');
  eq(planUnmerge(null, rect(0, 0, 1, 1)), { merges: [] }, 'a non-array list yields an empty list');
});

test('planUnmerge only removes geometry — it never restores cleared cells', () => {
  const plan = planUnmerge(['A1:C1'], rect(0, 0, 0, 2));
  eq(plan.merges, [], 'the merge is gone');
  eq(Object.prototype.hasOwnProperty.call(plan, 'clear'), false, 'and no cell patch comes back with it');
});

// ---------------------------------------------------------------------------
// shiftMerges — structural edits
// ---------------------------------------------------------------------------

test('shiftMerges: insertRow', () => {
  const m = ['C3:E5']; // rows 2..4, columns 2..4
  eq(shiftMerges(m, { kind: 'insertRow', index: 10, count: 1 }, 200, 26), ['C3:E5'], 'inserted below it: untouched');
  eq(shiftMerges(m, { kind: 'insertRow', index: 5, count: 1 }, 200, 26), ['C3:E5'], 'inserted just past its last row');
  eq(shiftMerges(m, { kind: 'insertRow', index: 0, count: 1 }, 200, 26), ['C4:E6'], 'inserted above it: moved down');
  eq(shiftMerges(m, { kind: 'insertRow', index: 2, count: 1 }, 200, 26), ['C4:E6'], 'inserted at its first row: moved');
  eq(shiftMerges(m, { kind: 'insertRow', index: 3, count: 2 }, 200, 26), ['C3:E7'], 'inserted inside it: grown by 2');
  eq(shiftMerges(m, { kind: 'insertRow', index: 4, count: 1 }, 200, 26), ['C3:E6'], 'inserted at its last row: grown');
  eq(shiftMerges(m, { kind: 'insertRow', index: 0, count: 2 }, 200, 26), ['C5:E7'], 'the column span never changes');
});

test('shiftMerges: deleteRow', () => {
  const m = ['C3:E5']; // rows 2..4
  eq(shiftMerges(m, { kind: 'deleteRow', index: 10, count: 1 }, 200, 26), ['C3:E5'], 'deleted below it: untouched');
  eq(shiftMerges(m, { kind: 'deleteRow', index: 0, count: 1 }, 200, 26), ['C2:E4'], 'deleted above it: moved up');
  eq(shiftMerges(m, { kind: 'deleteRow', index: 4, count: 1 }, 200, 26), ['C3:E4'], 'its last row deleted: shrunk');
  eq(shiftMerges(m, { kind: 'deleteRow', index: 2, count: 1 }, 200, 26), ['C3:E4'], 'its first row deleted: shrunk');
  eq(shiftMerges(m, { kind: 'deleteRow', index: 1, count: 2 }, 200, 26), ['C2:E3'], 'straddling its top edge');
  eq(shiftMerges(m, { kind: 'deleteRow', index: 2, count: 3 }, 200, 26), [], 'wholly deleted: gone');
  eq(shiftMerges(m, { kind: 'deleteRow', index: 0, count: 10 }, 200, 26), [], 'swallowed by a bigger band');
  eq(shiftMerges(['C3:C4'], { kind: 'deleteRow', index: 3, count: 1 }, 200, 26), [], 'shrunk to one cell: gone');
});

test('shiftMerges: insertCol', () => {
  const m = ['B2:D2']; // row 1, columns 1..3
  eq(shiftMerges(m, { kind: 'insertCol', index: 4, count: 1 }, 200, 26), ['B2:D2'], 'inserted past its right edge');
  eq(shiftMerges(m, { kind: 'insertCol', index: 0, count: 1 }, 200, 26), ['C2:E2'], 'inserted left of it: moved right');
  eq(shiftMerges(m, { kind: 'insertCol', index: 1, count: 1 }, 200, 26), ['C2:E2'], 'inserted at its first column: moved');
  eq(shiftMerges(m, { kind: 'insertCol', index: 2, count: 1 }, 200, 26), ['B2:E2'], 'inserted inside it: grown');
  eq(shiftMerges(m, { kind: 'insertCol', index: 3, count: 2 }, 200, 26), ['B2:F2'], 'inserted at its last column: grown by 2');
  eq(shiftMerges(['C3:E5'], { kind: 'insertCol', index: 0, count: 2 }, 200, 26), ['E3:G5'], 'the row span never changes');
  eq(shiftMerges(['Y1:Z1'], { kind: 'insertCol', index: 0, count: 1 }, 200, 26), [], 'pushed off the sheet edge: gone');
});

test('shiftMerges: deleteCol', () => {
  const m = ['B2:D2']; // columns 1..3
  eq(shiftMerges(m, { kind: 'deleteCol', index: 5, count: 1 }, 200, 26), ['B2:D2'], 'deleted right of it: untouched');
  eq(shiftMerges(m, { kind: 'deleteCol', index: 0, count: 1 }, 200, 26), ['A2:C2'], 'deleted left of it: moved left');
  eq(shiftMerges(m, { kind: 'deleteCol', index: 3, count: 1 }, 200, 26), ['B2:C2'], 'its last column deleted: shrunk');
  eq(shiftMerges(m, { kind: 'deleteCol', index: 1, count: 1 }, 200, 26), ['B2:C2'], 'its first column deleted: shrunk');
  eq(shiftMerges(m, { kind: 'deleteCol', index: 1, count: 3 }, 200, 26), [], 'wholly deleted: gone');
  eq(shiftMerges(['C3:D3'], { kind: 'deleteCol', index: 3, count: 1 }, 200, 26), [], 'shrunk to one cell: gone');
});

test('shiftMerges moves a whole list at once and re-normalizes it', () => {
  const merges = ['A1:B1', 'C3:E5', 'A10:A12'];
  eq(
    shiftMerges(merges, { kind: 'deleteRow', index: 2, count: 2 }, 200, 26),
    ['A1:B1', 'C3:E3', 'A8:A10'],
    'untouched, shrunk and moved rectangles in one call'
  );
  eq(
    shiftMerges(merges, { kind: 'insertRow', index: 0, count: 1 }, 200, 26),
    ['A2:B2', 'C4:E6', 'A11:A13'],
    'and the result stays sorted by row'
  );
});

test('shiftMerges leaves geometry alone for a non-structural edit', () => {
  eq(shiftMerges(['C3:E5'], { kind: 'nope', index: 0, count: 1 }, 200, 26), ['C3:E5'], 'an unknown kind');
  eq(shiftMerges(['C3:E5'], null, 200, 26), ['C3:E5'], 'a null edit');
  eq(shiftMerges(['c3:$e$5'], null, 200, 26), ['C3:E5'], 'but the list still comes back canonical');
  eq(shiftMerges([], { kind: 'insertRow', index: 0, count: 1 }, 200, 26), [], 'an empty list');
  eq(shiftMerges(null, { kind: 'insertRow', index: 0, count: 1 }, 200, 26), [], 'a non-array list');
});

test('shiftMerges clips the result to the sheet it is given', () => {
  eq(shiftMerges(['A1:C1'], { kind: 'insertCol', index: 0, count: 1 }, 200, 3), ['B1:C1'], 'clipped to 3 columns');
  eq(shiftMerges(['A1:C1'], { kind: 'insertCol', index: 0, count: 1 }, 200, 2), [], 'clipped down to one cell: gone');
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

test('every merge helper leaves its arguments untouched', () => {
  const merges = ['A1:C1', 'B4:B8'];
  const target = rect(0, 0, 1, 1);
  const edit = { kind: 'insertRow', index: 0, count: 1 };

  pure([merges], () => normalizeMergeList(merges, 200, 26), 'normalizeMergeList');
  pure([merges], () => mergeAt(merges, 0, 1), 'mergeAt');
  pure([merges, target], () => expandOverMerges(merges, target), 'expandOverMerges');
  pure([merges, target], () => planMerge(merges, target, 'all'), 'planMerge all');
  pure([merges, target], () => planMerge(merges, target, 'horizontal'), 'planMerge horizontal');
  pure([merges, target], () => planMerge(merges, target, 'vertical'), 'planMerge vertical');
  pure([merges, target], () => planUnmerge(merges, target), 'planUnmerge');
  pure([merges, edit], () => shiftMerges(merges, edit, 200, 26), 'shiftMerges');
});

test('merge helpers hand back fresh objects a caller may keep', () => {
  const merges = ['A1:C1'];
  const target = rect(0, 0, 0, 0);

  const grown = expandOverMerges(merges, target);
  eq(grown === target, false, 'expandOverMerges never returns the rect it was given');
  grown.r1 = 99;
  eq(target, rect(0, 0, 0, 0), 'so mutating the result cannot reach back into the caller');

  const first = mergeRect('A1:C2');
  first.r1 = 99;
  eq(mergeRect('A1:C2'), rect(0, 0, 1, 2), 'nor can it corrupt the next call');

  const plan = planMerge(merges, rect(0, 0, 1, 2), 'all');
  plan.merges.push('Z1:Z2');
  plan.clear.push('Z9');
  eq(merges, ['A1:C1'], 'and the plan arrays are not the list that was passed in');
  eq(planMerge(merges, rect(0, 0, 1, 2), 'all').merges, ['A1:C2'], 'a repeated call gives the same answer');
});

test('expandOverMerges leaves an untouched rect untouched even when nothing grows', () => {
  const target = rect(2, 2, 3, 3);
  const out = pure([target], () => expandOverMerges(['A1:B1'], target), 'expandOverMerges');
  eq(out, rect(2, 2, 3, 3), 'the geometry is copied through unchanged');
  eq(out === target, false, 'as a new object');
});

// ---------------------------------------------------------------------------
// sanitizeDoc / duplicateSheet
// ---------------------------------------------------------------------------

test('sanitizeDoc keeps a normalized merge list on a sheet that has one', () => {
  const doc = docWith(['b4:b8', '$A$1:C1', 'A1:A1']);
  eq(doc.sheets[0].merges, ['A1:C1', 'B4:B8'], 'uppercased, $-stripped, sorted, 1x1 dropped');

  const again = sanitizeDoc(doc);
  eq(again.sheets[0].merges, ['A1:C1', 'B4:B8'], 'sanitizeDoc is idempotent over merges');

  const clipped = docWith(['A9:A20', 'A50:B51'], 10, 5);
  eq(clipped.sheets[0].merges, ['A9:A10'], 'clipped to the sheet, the out-of-sheet entry dropped');
});

test('sanitizeDoc gives a sheet without merges an empty array', () => {
  eq(docWith(undefined).sheets[0].merges, [], 'a sheet with no merges field');
  eq(emptySheet('sh0002', '시트2').merges, [], 'emptySheet');
  eq(emptyDoc('bbbbbb222222', '새 문서').sheets[0].merges, [], 'emptyDoc');
  eq(sanitizeDoc({ id: 'cccccc333333' }).sheets[0].merges, [], 'a document with no sheets at all');
  eq(
    sanitizeDoc({ id: 'dddddd444444', rows: 50, cols: 10, cells: { A1: { input: '1' } } }).sheets[0].merges,
    [],
    'a migrated v1 document'
  );
});

test('sanitizeDoc survives a hostile merges value', () => {
  eq(docWith('A1:C1').sheets[0].merges, [], 'a bare string');
  eq(docWith(42).sheets[0].merges, [], 'a number');
  eq(docWith(null).sheets[0].merges, [], 'null');
  eq(docWith({ 0: 'A1:C1' }).sheets[0].merges, [], 'an array-like object');
  eq(docWith([null, 42, 'nonsense', [], {}, 'A1:C1']).sheets[0].merges, ['A1:C1'], 'a list of junk plus one real entry');
  eq(docWith(['A1:C1', 'B1:D1']).sheets[0].merges, ['A1:C1'], 'overlapping entries cannot reach storage');
});

test('duplicateSheet deep-copies the merge list', () => {
  const doc = docWith(['A1:C1', 'B4:B8']);
  const before = snap(doc);

  const { doc: next, sheet } = duplicateSheet(doc, 'sh0001', {});
  eq(snap(doc), before, 'duplicateSheet must not mutate its document');
  eq(sheet.merges, ['A1:C1', 'B4:B8'], 'the copy carries the same geometry');
  eq(sheet.merges === doc.sheets[0].merges, false, 'but not the same array');

  sheet.merges.push('E5:F5');
  sheet.merges[0] = 'Z1:Z2';
  eq(doc.sheets[0].merges, ['A1:C1', 'B4:B8'], 'mutating the copy cannot touch the original');
  eq(next.sheets[0].merges, ['A1:C1', 'B4:B8'], 'nor the original inside the returned document');
});

// ---------------------------------------------------------------------------
// integration — why shared/formula/ needs no merge awareness
// ---------------------------------------------------------------------------

test('a SUM over a merged range equals the anchor alone once the clear list is applied', () => {
  const engine = new SheetEngine({ rows: 20, cols: 10 });
  engine.setInputs({ A1: '5', B1: '7', C1: '9', D1: '=SUM(A1:C1)' });
  eq(engine.getValue('D1'), 21, 'unmerged, all three cells count');

  const plan = planMerge([], rect(0, 0, 0, 2), 'all');
  eq(plan.merges, ['A1:C1'], 'the merge covers A1:C1');
  eq(plan.clear, ['B1', 'C1'], 'and the covered cells are cleared');

  const patch = {};
  for (const key of plan.clear) patch[key] = null;
  engine.setInputs(patch);

  eq(engine.getValue('A1'), 5, 'the anchor keeps its contents');
  eq(engine.getValue('B1'), null, 'a covered cell is genuinely empty');
  eq(engine.getValue('C1'), null, 'all of them');
  eq(engine.getValue('D1'), 5, 'so the SUM is the anchor alone, with no merge-aware code anywhere');

  engine.setInput('A1', '11');
  eq(engine.getValue('D1'), 11, 'and editing the anchor still recalculates normally');
});

test('COUNT and AVERAGE over a merged range see one value, not three', () => {
  const engine = new SheetEngine({ rows: 20, cols: 10 });
  engine.setInputs({
    A1: '2',
    B1: '4',
    C1: '6',
    A3: '=COUNT(A1:C1)',
    A4: '=AVERAGE(A1:C1)',
    A5: '=COUNTBLANK(A1:C1)',
  });
  eq(engine.getValue('A3'), 3, 'three numbers before the merge');
  eq(engine.getValue('A4'), 4, 'averaging all three');
  eq(engine.getValue('A5'), 0, 'nothing blank yet');

  const plan = planMerge([], rect(0, 0, 0, 2), 'all');
  const patch = {};
  for (const key of plan.clear) patch[key] = null;
  engine.setInputs(patch);

  eq(engine.getValue('A3'), 1, 'the covered cells are blank, so COUNT sees one number');
  eq(engine.getValue('A4'), 2, 'and AVERAGE is the anchor alone');
  eq(engine.getValue('A5'), 2, 'the two covered cells count as blank');
});

test('a vertical merge clears the right cells for the engine', () => {
  const engine = new SheetEngine({ rows: 20, cols: 10 });
  engine.setInputs({
    A1: '1', B1: '2',
    A2: '3', B2: '4',
    D1: '=SUM(A1:B2)',
  });
  eq(engine.getValue('D1'), 10, 'the whole block sums');

  const plan = planMerge([], rect(0, 0, 1, 1), 'vertical');
  eq(plan.merges, ['A1:A2', 'B1:B2'], 'one rectangle per column');
  eq(plan.clear, ['A2', 'B2'], 'each column keeps its own anchor');

  const patch = {};
  for (const key of plan.clear) patch[key] = null;
  engine.setInputs(patch);
  eq(engine.getValue('D1'), 3, 'so only the two anchors are left to sum');
});
