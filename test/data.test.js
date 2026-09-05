// test/data.test.js — data features, batch C (SPEC section 24).
//
// Three features that work on RANGES rather than single cells: 정렬/필터, 차트 and 댓글.
// Almost all of the logic that can be wrong is pure, and it lives in two places:
// shared/model.js (validation + the sort/filter maths + structural-edit movement) and the
// data half of public/js/chart.js. This file pins both down.
//
// What matters most about this batch, and therefore what gets the most cases here:
//
//   1. A SORT IS A VIEW. `computeSortOrder` returns row indexes to PAINT; the document is
//      never reordered, so a sort can never corrupt a formula. The same goes for
//      `computeVisibleRows`: it hides rows, it does not delete them. Both are proved here
//      by checking the returned order/set only — nothing under test is allowed to touch
//      the cells it was handed, which the purity harness below asserts literally.
//   2. BLANKS SORT LAST IN BOTH DIRECTIONS, and the stable tie-break is never reversed by
//      `dir:'desc'`. Those are the two details a naive comparator gets wrong.
//   3. EVERYTHING FROM A CLIENT IS HOSTILE. A comment's text, its author name and its
//      timestamp, a chart's title and type, a filter's range: each has a case here for the
//      malformed shape, and every validator must answer with its own "nothing here" value
//      instead of throwing.
//
// Two rules are followed throughout:
//   - Only what SPEC section 24 guarantees is asserted. Ids are generated with a per-load
//     salt, so no case compares one; they are checked for shape and uniqueness instead.
//   - Purity is asserted literally — a case that calls a helper also compares a JSON
//     snapshot of every argument taken before the call.

import { test, eq } from './run.js';
import { readFile } from 'node:fs/promises';

import {
  MAX_CHARTS,
  MAX_COMMENT_LEN,
  MAX_COMMENTS_PER_SHEET,
  sanitizeFilter,
  filterColumnValues,
  computeVisibleRows,
  computeSortOrder,
  sanitizeChart,
  sanitizeChartList,
  sanitizeComments,
  shiftFilter,
  shiftCharts,
  shiftComments,
  sanitizeDoc,
} from '../shared/model.js';

// ---------------------------------------------------------------------------
// loading public/js/chart.js in Node
// ---------------------------------------------------------------------------
//
// SPEC 24.2 requires the data half of chart.js to be DOM-free and exercisable in Node, and
// that is exactly what is tested at the bottom of this file. The only obstacle is the
// import specifier: the client tree addresses the shared modules the way the BROWSER has to
// see them (`/shared/formula/refs.js`, served by express.static), and Node resolves a
// root-relative specifier against the filesystem root, so a plain import looks for
// C:/shared/formula/refs.js and fails.
//
// So: try the plain import first (it is what runs the day those specifiers become relative),
// and fall back to loading the module through a rewriter that maps each `/shared/...`
// specifier onto the real file and inlines any sibling client module the same way. The
// source is never edited on disk; the rewritten copy exists only as a data: URL, so
// `chartSeries` is exercised EXACTLY as written. If the module touched `document` at module
// scope, this import would throw and every chart case below would fail — which is the point.

const REPO_ROOT = new URL('../', import.meta.url);
const CHART_URL = new URL('public/js/chart.js', REPO_ROOT).href;

/** `from '<spec>'`, `import '<spec>'` and `import('<spec>')`, capturing the specifier. */
const SPECIFIER_RE = /((?:\bfrom|\bimport)\s*\(?\s*)(['"])([^'"\n]+)\2/g;

/** file URL -> data: URL of the same module with its specifiers made absolute. */
const shimCache = new Map();

async function shimUrl(fileUrl) {
  const cached = shimCache.get(fileUrl);
  if (cached) return cached;

  const src = await readFile(new URL(fileUrl), 'utf8');
  const rewritten = new Map();
  for (const m of src.matchAll(SPECIFIER_RE)) {
    const spec = m[3];
    if (rewritten.has(spec)) continue;
    if (spec.startsWith('/')) {
      // Browser-absolute: the web root is the repository root.
      rewritten.set(spec, new URL('.' + spec, REPO_ROOT).href);
    } else if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = new URL(spec, fileUrl).href;
      // A sibling client module has the same problem; a shared module resolves as it is.
      rewritten.set(spec, target.includes('/public/') ? await shimUrl(target) : target);
    }
  }

  const out = src.replace(SPECIFIER_RE, (whole, head, quote, spec) =>
    (rewritten.has(spec) ? head + quote + rewritten.get(spec) + quote : whole)
  );
  const url = 'data:text/javascript;base64,' + Buffer.from(out, 'utf8').toString('base64');
  shimCache.set(fileUrl, url);
  return url;
}

let chartModule = null;

/** The chart module, loaded once and shared by every case below. */
function loadChart() {
  if (!chartModule) {
    chartModule = import(CHART_URL).catch(async (e) => {
      const missing =
        e && (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (?:module|package)/.test(String(e.message)));
      if (!missing) throw e;
      return import(await shimUrl(CHART_URL));
    });
  }
  return chartModule;
}

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

/**
 * A `valueOf(row, col)` over a 2D literal grid — the same injection point the grid uses to
 * hand the engine's computed values to these pure helpers. Out-of-grid reads are blank,
 * exactly as an empty cell is.
 */
function readerFor(grid) {
  return (row, col) => {
    const line = grid[row];
    if (!line) return null;
    const v = line[col];
    return v === undefined ? null : v;
  };
}

/** A Set of row indexes as a sorted array, so failures print something readable. */
function rows(set) {
  return Array.from(set).sort((a, b) => a - b);
}

/** A filter over `range` sorting its relative column `col`. */
function sortFilter(range, col, dir, header) {
  return { range, header: header === undefined ? true : header, sort: { col, dir }, hidden: {} };
}

/** Everything a chart carries except its generated id, which is never asserted. */
function withoutId(chart) {
  if (!chart) return chart;
  const out = {};
  for (const k of Object.keys(chart)) if (k !== 'id') out[k] = chart[k];
  return out;
}

/** Call `fn` and report `{ threw:false, value }`, so "returned X without throwing" is one eq. */
function noThrow(fn) {
  try {
    return { threw: false, value: fn() };
  } catch (e) {
    return { threw: true, value: String((e && e.message) || e) };
  }
}

// The worked example from SPEC 24.1, absolute row indexes on the left:
//   0  '이름' | '점수'   <- header
//   1  '가'   | 30
//   2  '나'   | (blank)
//   3  '다'   | 10
//   4  '라'   | '십'     <- text, not a number
//   5  '마'   | 10
const SCORES = [
  ['이름', '점수'],
  ['가', 30],
  ['나', null],
  ['다', 10],
  ['라', '십'],
  ['마', 10],
];

// ---------------------------------------------------------------------------
// computeSortOrder — SPEC 24.1
// ---------------------------------------------------------------------------

test('computeSortOrder returns the identity order when there is no sort', () => {
  const valueOf = readerFor(SCORES);
  const noSort = { range: 'A1:B6', header: true, sort: null, hidden: {} };
  eq(computeSortOrder({}, noSort, valueOf, 6), [0, 1, 2, 3, 4, 5], 'sort:null is the identity');
  eq(computeSortOrder({}, null, valueOf, 6), [0, 1, 2, 3, 4, 5], 'no filter at all is the identity');
  eq(computeSortOrder({}, undefined, valueOf, 6), [0, 1, 2, 3, 4, 5], 'undefined is the identity');
  eq(computeSortOrder({}, 'nonsense', valueOf, 6), [0, 1, 2, 3, 4, 5], 'garbage is the identity');
  eq(
    computeSortOrder({}, { range: 'A1:B6', header: true, sort: { col: 9, dir: 'asc' }, hidden: {} }, valueOf, 6),
    [0, 1, 2, 3, 4, 5],
    'a sort column outside the range is dropped, leaving the identity'
  );
});

test('computeSortOrder sorts numbers, ascending and descending', () => {
  // Rows 1..4 hold 3, 10, -2, 7; rows 0, 5 and 6 are outside the filter range.
  const grid = [[5], [3], [10], [-2], [7], [100], [1]];
  const valueOf = readerFor(grid);
  const filter = sortFilter('A2:A5', 0, 'asc', false);
  eq(computeSortOrder({}, filter, valueOf, 7), [0, 3, 1, 4, 2, 5, 6], 'ascending: -2, 3, 7, 10');
  eq(
    computeSortOrder({}, sortFilter('A2:A5', 0, 'desc', false), valueOf, 7),
    [0, 2, 4, 1, 3, 5, 6],
    'descending: 10, 7, 3, -2'
  );
});

test('computeSortOrder sorts text case-insensitively, ascending and descending', () => {
  // Rows 1..4: banana, Apple, cherry, apple. 'Apple' and 'apple' compare EQUAL.
  const grid = [['머리글'], ['banana'], ['Apple'], ['cherry'], ['apple']];
  const valueOf = readerFor(grid);
  eq(
    computeSortOrder({}, sortFilter('A1:A5', 0, 'asc'), valueOf, 5),
    [0, 2, 4, 1, 3],
    'ascending: Apple, apple, banana, cherry'
  );
  eq(
    computeSortOrder({}, sortFilter('A1:A5', 0, 'desc'), valueOf, 5),
    [0, 3, 1, 2, 4],
    'descending: cherry, banana, then Apple/apple in their ORIGINAL order'
  );
});

test('computeSortOrder orders a mixed column numbers < text < booleans', () => {
  // Rows 1..7: TRUE, '나', 2, blank, 'a', 1, FALSE.
  const grid = [['키'], [true], ['나'], [2], [null], ['a'], [1], [false]];
  const valueOf = readerFor(grid);
  eq(
    computeSortOrder({}, sortFilter('A1:A8', 0, 'asc'), valueOf, 8),
    [0, 6, 3, 5, 2, 7, 1, 4],
    'ascending: 1, 2, then a, 나, then FALSE, TRUE, then the blank'
  );
  eq(
    computeSortOrder({}, sortFilter('A1:A8', 0, 'desc'), valueOf, 8),
    [0, 1, 7, 2, 5, 3, 6, 4],
    'descending reverses the ranks: TRUE, FALSE, 나, a, 2, 1 — and the blank is STILL last'
  );
});

test('computeSortOrder keeps blanks last in BOTH directions', () => {
  const valueOf = readerFor(SCORES);
  const asc = computeSortOrder({}, sortFilter('A1:B6', 1, 'asc'), valueOf, 6);
  const desc = computeSortOrder({}, sortFilter('A1:B6', 1, 'desc'), valueOf, 6);
  eq(asc[asc.length - 1], 2, 'ascending: the blank row is drawn last');
  eq(desc[desc.length - 1], 2, 'descending: the blank row is STILL drawn last');
});

test('computeSortOrder never moves the header row', () => {
  const valueOf = readerFor(SCORES);
  eq(computeSortOrder({}, sortFilter('A1:B6', 1, 'asc'), valueOf, 6)[0], 0, 'header stays first, ascending');
  eq(computeSortOrder({}, sortFilter('A1:B6', 1, 'desc'), valueOf, 6)[0], 0, 'header stays first, descending');
  // With header:false the first row is ordinary data: '점수' is text, so it sorts after the
  // numbers, which is the proof that the pin above is the header flag and not the range edge.
  const bare = computeSortOrder({}, sortFilter('A1:B6', 1, 'asc', false), valueOf, 6);
  eq(bare[0] !== 0, true, 'header:false lets the first row move like any other');
  eq(bare[bare.length - 1], 2, 'and the blank is still last');
});

test('computeSortOrder is stable for equal keys, in both directions', () => {
  // Rows 3 and 5 both hold 10; row 3 must stay ahead of row 5 whichever way the sort runs.
  const valueOf = readerFor(SCORES);
  const asc = computeSortOrder({}, sortFilter('A1:B6', 1, 'asc'), valueOf, 6);
  eq(asc, [0, 3, 5, 1, 4, 2], 'ascending: 10 (row 3), 10 (row 5), 30, 십, blank');
  eq(asc.indexOf(3) < asc.indexOf(5), true, 'equal keys keep their original relative order');

  const desc = computeSortOrder({}, sortFilter('A1:B6', 1, 'desc'), valueOf, 6);
  eq(desc, [0, 4, 1, 3, 5, 2], 'descending: 십, 30, 10 (row 3), 10 (row 5), blank');
  eq(desc.indexOf(3) < desc.indexOf(5), true, 'the tie-break is NOT reversed by dir:desc');
});

test('computeSortOrder permutes only the rows inside the range', () => {
  const grid = [[9], [9], [3], [1], [2], [9], [9]];
  const valueOf = readerFor(grid);
  const order = computeSortOrder({}, sortFilter('A3:A5', 0, 'asc', false), valueOf, 7);
  eq(order.length, 7, 'every row of the sheet is present exactly once');
  eq(order.slice(0, 2), [0, 1], 'rows above the range keep their position');
  eq(order.slice(5), [5, 6], 'rows below the range keep their position');
  eq(order.slice(2, 5), [3, 4, 2], 'only the banded rows are permuted, among themselves');
});

// ---------------------------------------------------------------------------
// computeVisibleRows — SPEC 24.1
// ---------------------------------------------------------------------------

// Rows 0..5: a header, then 완료 / 보류 / 완료 / 보류 / 취소 with a numeric second column.
const STATUSES = [
  ['상태', '값'],
  ['완료', 1],
  ['보류', 2],
  ['완료', 3],
  ['보류', 4],
  ['취소', 5],
];

test('computeVisibleRows removes exactly the rows carrying a hidden value', () => {
  const valueOf = readerFor(STATUSES);
  const filter = { range: 'A1:B6', header: true, sort: null, hidden: { 0: ['보류'] } };
  const visible = pure([filter], () => computeVisibleRows({}, filter, valueOf, 6), 'computeVisibleRows');
  eq(rows(visible), [0, 1, 3, 5], 'rows 2 and 4 hold 보류 and are the only ones hidden');
  eq(visible instanceof Set, true, 'the result is a Set of absolute row indexes');
});

test('computeVisibleRows leaves rows outside the filter range visible', () => {
  const valueOf = readerFor(STATUSES);
  // The range stops at row 3 (A1:B4); rows 4 and 5 also hold 보류/취소 but are outside it.
  const filter = { range: 'A1:B4', header: true, sort: null, hidden: { 0: ['보류', '취소'] } };
  eq(rows(computeVisibleRows({}, filter, valueOf, 8)), [0, 1, 3, 4, 5, 6, 7], 'only row 2 is inside and hidden');
});

test('computeVisibleRows keeps the header row visible', () => {
  const valueOf = readerFor(STATUSES);
  const hidesHeader = { range: 'A1:B6', header: true, sort: null, hidden: { 0: ['상태', '보류'] } };
  eq(rows(computeVisibleRows({}, hidesHeader, valueOf, 6)), [0, 1, 3, 5], 'the header is never filtered out');
  // header:false makes the first row ordinary data, and then it CAN be hidden.
  const bare = { range: 'A1:B6', header: false, sort: null, hidden: { 0: ['상태'] } };
  eq(rows(computeVisibleRows({}, bare, valueOf, 6)), [1, 2, 3, 4, 5], 'header:false leaves row 0 filterable');
});

test('computeVisibleRows hides nothing when a column has no hidden values', () => {
  const valueOf = readerFor(STATUSES);
  const all = [0, 1, 2, 3, 4, 5];
  eq(rows(computeVisibleRows({}, { range: 'A1:B6', header: true, sort: null, hidden: {} }, valueOf, 6)), all, 'empty hidden map');
  eq(rows(computeVisibleRows({}, { range: 'A1:B6', header: true, sort: null, hidden: { 0: [] } }, valueOf, 6)), all, 'an empty list filters nothing');
  eq(rows(computeVisibleRows({}, null, valueOf, 6)), all, 'no filter at all');
  eq(rows(computeVisibleRows({}, 'nonsense', valueOf, 6)), all, 'garbage hides nothing');
});

test('computeVisibleRows intersects two filtered columns', () => {
  const valueOf = readerFor(STATUSES);
  // Column 0 hides 보류 (rows 2, 4); column 1 hides the value 3 (row 3).
  const filter = { range: 'A1:B6', header: true, sort: null, hidden: { 0: ['보류'], 1: ['3'] } };
  eq(rows(computeVisibleRows({}, filter, valueOf, 6)), [0, 1, 5], 'a row must pass BOTH columns');

  const onlyFirst = { range: 'A1:B6', header: true, sort: null, hidden: { 0: ['보류'] } };
  const onlySecond = { range: 'A1:B6', header: true, sort: null, hidden: { 1: ['3'] } };
  eq(rows(computeVisibleRows({}, onlyFirst, valueOf, 6)), [0, 1, 3, 5], 'column 0 alone');
  eq(rows(computeVisibleRows({}, onlySecond, valueOf, 6)), [0, 1, 2, 4, 5], 'column 1 alone');
});

// ---------------------------------------------------------------------------
// filterColumnValues — SPEC 24.1
// ---------------------------------------------------------------------------

test('filterColumnValues lists distinct values with counts, sorted, blank included', () => {
  // Column B over A1:B7 with a header row: 30, blank, 10, 30, blank, 10.
  const cells = {
    A1: { input: '이름' }, B1: { input: '점수' },
    B2: { input: '30' },
    B4: { input: '10' },
    B5: { input: '30' },
    B7: { input: '10' },
  };
  const out = pure([cells], () => filterColumnValues(cells, 'A1:B7', 1, true), 'filterColumnValues');
  eq(out.values, ['10', '30', ''], 'numbers in numeric order, the blank bucket last');
  eq(out.counts instanceof Map, true, 'counts is a Map');
  eq(Array.from(out.counts), [['10', 2], ['30', 2], ['', 2]], 'every distinct value carries its count');
  eq(Array.from(out.counts.keys()), out.values, 'counts iterates in the same order as values');
});

test('filterColumnValues sorts with the same comparator a sort uses', () => {
  // 9 must come before 10 (numeric, not string order); text follows every number; a blank
  // is last; and 'X'/'x' are one bucket apiece because the display text differs.
  const grid = [['머리글'], ['x'], ['X'], ['y'], [9], [10], [null]];
  const out = filterColumnValues({}, 'A1:A7', 0, true, readerFor(grid));
  eq(out.values, ['9', '10', 'X', 'x', 'y', ''], 'numbers, then text, then the blank');
  eq(Array.from(out.counts.values()), [1, 1, 1, 1, 1, 1], 'one row each');
});

test('filterColumnValues skips the header row only when header is true', () => {
  const grid = [['상태'], ['완료'], ['완료'], ['보류']];
  eq(filterColumnValues({}, 'A1:A4', 0, true, readerFor(grid)).values, ['보류', '완료'], 'header excluded');
  eq(
    filterColumnValues({}, 'A1:A4', 0, false, readerFor(grid)).values,
    ['보류', '상태', '완료'],
    'header:false lists the header text as a value'
  );
});

test('filterColumnValues answers empty for an unusable range or column', () => {
  const cells = { A1: { input: 'x' } };
  eq(noThrow(() => filterColumnValues(cells, 'nonsense', 0, true)), { threw: false, value: { values: [], counts: new Map() } }, 'bad range');
  eq(noThrow(() => filterColumnValues(cells, 'A1:B4', 9, true)), { threw: false, value: { values: [], counts: new Map() } }, 'column outside the range');
  eq(noThrow(() => filterColumnValues(cells, 'A1:B4', -1, true)), { threw: false, value: { values: [], counts: new Map() } }, 'negative column');
  eq(noThrow(() => filterColumnValues(null, 'A1:B4', 0, true)), { threw: false, value: { values: [''], counts: new Map([['', 3]]) } }, 'no cells: three blank rows');
});

// ---------------------------------------------------------------------------
// sanitizeFilter — SPEC 24.1
// ---------------------------------------------------------------------------

test('sanitizeFilter passes a valid filter through, canonically', () => {
  const f = { range: 'A1:C10', header: false, sort: { col: 1, dir: 'desc' }, hidden: { 1: ['a', 'b'] } };
  const out = pure([f], () => sanitizeFilter(f, 200, 26), 'sanitizeFilter');
  eq(out, { range: 'A1:C10', header: false, sort: { col: 1, dir: 'desc' }, hidden: { 1: ['a', 'b'] } }, 'unchanged');
  eq(out === f, false, 'a fresh object is returned, not the argument');

  eq(
    sanitizeFilter({ range: 'a1:$c$10' }, 200, 26),
    { range: 'A1:C10', header: true, sort: null, hidden: {} },
    'the range is uppercased and stripped of $; header defaults to true'
  );
  eq(sanitizeFilter({ range: 'C10:A1' }, 200, 26).range, 'A1:C10', 'a reversed range is normalized');
  eq(
    sanitizeFilter({ range: 'A1:C10', sort: { col: 2, dir: 'DESC' } }, 200, 26).sort,
    { col: 2, dir: 'desc' },
    'the direction is case-insensitive'
  );
  eq(
    sanitizeFilter({ range: 'A1:C10', hidden: { 1: ['b', 'a', 'b'] } }, 200, 26).hidden,
    { 1: ['a', 'b'] },
    'hidden values are deduplicated and sorted'
  );
});

test('sanitizeFilter clips a range hanging off the sheet and drops one starting outside', () => {
  eq(sanitizeFilter({ range: 'A1:Z500' }, 100, 26).range, 'A1:Z100', 'the far edge is clipped to the sheet');
  eq(sanitizeFilter({ range: 'A1:AZ10' }, 200, 26).range, 'A1:Z10', 'clipped on the column axis too');
  eq(sanitizeFilter({ range: 'A300:C400' }, 200, 26), null, 'a range starting below the sheet is dropped');
  eq(sanitizeFilter({ range: 'ZZ1:ZZ9' }, 200, 26), null, 'a range starting past the last column is dropped');
});

test('sanitizeFilter drops a sort column outside the range', () => {
  eq(sanitizeFilter({ range: 'A1:C10', sort: { col: 7, dir: 'asc' } }, 200, 26).sort, null, 'past the right edge');
  eq(sanitizeFilter({ range: 'A1:C10', sort: { col: -1, dir: 'asc' } }, 200, 26).sort, null, 'negative');
  eq(sanitizeFilter({ range: 'A1:C10', sort: { col: 1.5, dir: 'asc' } }, 200, 26).sort, null, 'not an integer');
  eq(sanitizeFilter({ range: 'A1:C10', sort: { col: 1, dir: 'sideways' } }, 200, 26).sort, null, 'unknown direction');
  eq(sanitizeFilter({ range: 'A1:C10', sort: { col: 1 } }, 200, 26).sort, null, 'no direction at all');
  eq(sanitizeFilter({ range: 'A1:C10', sort: 'asc' }, 200, 26).sort, null, 'a non-object sort');
  eq(sanitizeFilter({ range: 'A1:C10', sort: { col: 2, dir: 'asc' } }, 200, 26).sort, { col: 2, dir: 'asc' }, 'the last column IS inside');

  // A hidden list keyed outside the range goes the same way, and an empty list is removed.
  eq(
    sanitizeFilter({ range: 'A1:C10', hidden: { 1: ['x'], 9: ['y'], 0: [] } }, 200, 26).hidden,
    { 1: ['x'] },
    'out-of-range and empty hidden columns are dropped'
  );
});

test('sanitizeFilter returns null for garbage without throwing', () => {
  for (const bad of [null, undefined, 0, 42, '', 'nonsense', [], [1, 2], true, { }, { range: '' }, { range: 5 }, { range: 'A1:' }, { range: '시트2!A1:B2' }, { range: {} }]) {
    eq(noThrow(() => sanitizeFilter(bad, 200, 26)), { threw: false, value: null }, 'garbage: ' + snap(bad));
  }
  // A hostile `hidden` must not take the filter down with it.
  eq(
    noThrow(() => sanitizeFilter({ range: 'A1:C10', hidden: { 1: 'x', 2: null, 3: [{}, [], null, undefined] } }, 200, 26)),
    { threw: false, value: { range: 'A1:C10', header: true, sort: null, hidden: {} } },
    'unusable hidden entries are dropped, the filter survives'
  );
});

// ---------------------------------------------------------------------------
// sanitizeChart / sanitizeChartList — SPEC 24.2
// ---------------------------------------------------------------------------

test('sanitizeChart passes a valid chart through and defaults the rest', () => {
  const c = {
    id: 'ch1a2b', type: 'line', range: 'A1:C10', title: '분기 매출',
    headerRow: true, headerCol: true, x: 320, y: 80, w: 480, h: 300, legend: 'bottom',
  };
  const out = pure([c], () => sanitizeChart(c, 200, 26), 'sanitizeChart');
  eq(out, c, 'a fully valid chart is unchanged');
  eq(out === c, false, 'a fresh object is returned');

  const bare = sanitizeChart({ range: 'a1:c10' }, 200, 26);
  eq(
    withoutId(bare),
    { type: 'column', range: 'A1:C10', title: '', headerRow: false, headerCol: false, x: 0, y: 0, w: 480, h: 300, legend: 'right' },
    'defaults: column type, no headers, 480x300 at the origin, legend right'
  );
  eq(typeof bare.id === 'string' && bare.id.length > 0, true, 'a missing id is generated');
});

test('sanitizeChart rejects an unknown type and an unknown legend', () => {
  eq(sanitizeChart({ range: 'A1:B2', type: 'donut' }, 200, 26).type, 'column', 'unknown type falls back to column');
  eq(sanitizeChart({ range: 'A1:B2', type: 'COLUMN' }, 200, 26).type, 'column', 'the id is case-sensitive');
  eq(sanitizeChart({ range: 'A1:B2', type: 7 }, 200, 26).type, 'column', 'a non-string type');
  for (const t of ['column', 'bar', 'line', 'area', 'pie', 'scatter']) {
    eq(sanitizeChart({ range: 'A1:B2', type: t }, 200, 26).type, t, 'the six spec types survive: ' + t);
  }
  eq(sanitizeChart({ range: 'A1:B2', legend: 'left' }, 200, 26).legend, 'right', 'unknown legend falls back to right');
  for (const l of ['right', 'bottom', 'none']) {
    eq(sanitizeChart({ range: 'A1:B2', legend: l }, 200, 26).legend, l, 'the three legend positions survive: ' + l);
  }
});

test('sanitizeChart clamps x, y, w and h', () => {
  const tiny = sanitizeChart({ range: 'A1:B2', x: -50, y: -1, w: 5, h: 0 }, 200, 26);
  eq(tiny.x, 0, 'a negative x clamps to 0');
  eq(tiny.y, 0, 'a negative y clamps to 0');
  eq(tiny.w >= 80, true, 'w is clamped up to the minimum drawable width');
  eq(tiny.h >= 80, true, 'h is clamped up to the minimum drawable height');

  const huge = sanitizeChart({ range: 'A1:B2', x: 1e12, y: 1e12, w: 1e9, h: 1e9 }, 200, 26);
  eq(huge.x <= 2000000 && huge.x > 0, true, 'x is clamped down to a sane sheet coordinate');
  eq(huge.y <= 2000000 && huge.y > 0, true, 'y is clamped down too');
  eq(huge.w <= 4000, true, 'w is capped');
  eq(huge.h <= 4000, true, 'h is capped');

  const junk = sanitizeChart({ range: 'A1:B2', x: 'left', y: null, w: 'wide', h: NaN }, 200, 26);
  eq({ x: junk.x, y: junk.y, w: junk.w, h: junk.h }, { x: 0, y: 0, w: 480, h: 300 }, 'unusable geometry takes the defaults');
});

test('sanitizeChart caps a long title and keeps it as plain text', () => {
  const long = sanitizeChart({ range: 'A1:B2', title: '가'.repeat(5000) }, 200, 26);
  eq(long.title.length <= 200, true, 'the title is capped');
  eq(long.title.length > 0, true, 'and not emptied');
  eq(sanitizeChart({ range: 'A1:B2', title: '분기 매출' }, 200, 26).title, '분기 매출', 'a normal title is untouched');
  eq(sanitizeChart({ range: 'A1:B2', title: 42 }, 200, 26).title, '', 'a non-string title becomes empty');
  // The title is user text. It is never markup, and nothing here escapes it — the consumer
  // must insert it with textContent, so the characters must survive verbatim.
  eq(
    sanitizeChart({ range: 'A1:B2', title: '<script>alert(1)</script>' }, 200, 26).title,
    '<script>alert(1)</script>',
    'a title is kept as literal text, never rewritten into an escape sequence'
  );
});

test('sanitizeChart treats a missing or out-of-sheet range as fatal', () => {
  eq(sanitizeChart({ type: 'pie' }, 200, 26), null, 'a chart with no range is nothing at all');
  eq(sanitizeChart({ range: 'ZZ1:ZZ9' }, 200, 26), null, 'a range starting past the sheet');
  eq(sanitizeChart({ range: 'A1:AZ99' }, 200, 26).range, 'A1:Z99', 'a range hanging off the edge is clipped');
});

test('sanitizeChartList drops garbage entries and holds MAX_CHARTS', () => {
  const list = [{ range: 'A1:B2' }, 'nope', null, undefined, 42, [], { type: 'pie' }, { range: 'C1:D9', type: 'pie' }];
  const out = pure([list], () => sanitizeChartList(list, 200, 26), 'sanitizeChartList');
  eq(out.length, 2, 'only the two entries with a usable range survive');
  eq(out.map((c) => c.range), ['A1:B2', 'C1:D9'], 'document order is preserved — it is the paint order');
  eq(out.map((c) => c.type), ['column', 'pie'], 'each survivor is individually sanitized');

  eq(noThrow(() => sanitizeChartList(null, 200, 26)), { threw: false, value: [] }, 'null is an empty list');
  eq(noThrow(() => sanitizeChartList('charts', 200, 26)), { threw: false, value: [] }, 'a string is an empty list');
  eq(noThrow(() => sanitizeChartList({ 0: { range: 'A1:B2' } }, 200, 26)), { threw: false, value: [] }, 'a non-array is an empty list');

  const many = [];
  for (let i = 0; i < MAX_CHARTS + 7; i++) many.push({ range: 'A1:B2', title: '차트 ' + i });
  const capped = sanitizeChartList(many, 200, 26);
  eq(capped.length, MAX_CHARTS, 'the list is capped at MAX_CHARTS');
  eq(capped[0].title, '차트 0', 'the first charts are the ones kept');
  eq(new Set(capped.map((c) => c.id)).size, MAX_CHARTS, 'every id in the list is unique');

  const dupes = sanitizeChartList([{ id: 'ch0001', range: 'A1:B2' }, { id: 'ch0001', range: 'C1:D2' }], 200, 26);
  eq(dupes.length, 2, 'a duplicate id does not drop the chart');
  eq(dupes[0].id, 'ch0001', 'the first spelling wins');
  eq(dupes[1].id !== 'ch0001', true, 'the later one is re-minted');
});

// ---------------------------------------------------------------------------
// sanitizeComments — SPEC 24.3
// ---------------------------------------------------------------------------

test('sanitizeComments passes a valid thread map through', () => {
  const map = {
    B4: {
      id: 'cm1a2b', cell: 'B4', resolved: false,
      messages: [{ id: 'ms1a2b', author: '민수', authorId: 'p1', text: '확인 부탁드립니다', at: 1730000000000 }],
    },
  };
  const out = pure([map], () => sanitizeComments(map, 200, 26), 'sanitizeComments');
  eq(out, map, 'a fully valid map survives unchanged');
  eq(out === map, false, 'a fresh map is returned');
  eq(out.B4 === map.B4, false, 'and a fresh thread inside it');

  // The key is canonical, and a thread can never claim a cell other than the one it is
  // stored under — the client does not get to point a thread somewhere else.
  const lower = sanitizeComments({ b4: { cell: 'Z9', resolved: 1, messages: [{ text: '  안녕  ' }] } }, 200, 26);
  eq(Object.keys(lower), ['B4'], 'the key is uppercased');
  eq(lower.B4.cell, 'B4', 'thread.cell is forced to its own key');
  eq(lower.B4.resolved, true, 'resolved is coerced to a real boolean');
  eq(lower.B4.messages[0].text, '안녕', 'message text is trimmed');
  eq(typeof lower.B4.id === 'string' && lower.B4.id.length > 0, true, 'a missing thread id is generated');
  eq(typeof lower.B4.messages[0].id === 'string' && lower.B4.messages[0].id.length > 0, true, 'so is a message id');

  eq(Object.keys(sanitizeComments({ C1: { messages: [{ text: 'c' }] }, A2: { messages: [{ text: 'a' }] }, B1: { messages: [{ text: 'b' }] } }, 200, 26)), ['B1', 'C1', 'A2'], 'threads come back row-major');
});

test('sanitizeComments caps a message at MAX_COMMENT_LEN', () => {
  const over = sanitizeComments({ A1: { messages: [{ text: '가'.repeat(MAX_COMMENT_LEN + 50) }] } }, 200, 26);
  eq(Array.from(over.A1.messages[0].text).length, MAX_COMMENT_LEN, 'capped at MAX_COMMENT_LEN code points');

  const exact = sanitizeComments({ A1: { messages: [{ text: '나'.repeat(MAX_COMMENT_LEN) }] } }, 200, 26);
  eq(Array.from(exact.A1.messages[0].text).length, MAX_COMMENT_LEN, 'a message exactly at the cap is untouched');

  // Code points, not UTF-16 units: the cap must never slice a surrogate pair in half.
  const emoji = sanitizeComments({ A1: { messages: [{ text: '🙂'.repeat(MAX_COMMENT_LEN + 10) }] } }, 200, 26);
  eq(Array.from(emoji.A1.messages[0].text).length, MAX_COMMENT_LEN, 'emoji count as one code point each');
  eq(emoji.A1.messages[0].text.includes('\uFFFD'), false, 'no replacement character: nothing was cut mid-pair');
});

test('sanitizeComments strips control characters but keeps tab and newline', () => {
  const out = sanitizeComments({ A1: { messages: [{ text: 'a\u0000b\u0007c\td\ne\u001Bf' }] } }, 200, 26);
  eq(out.A1.messages[0].text, 'abc\td\nef', 'NUL, BEL and ESC are removed; tab and newline survive');
  eq(sanitizeComments({ A1: { messages: [{ text: '줄1\r\n줄2\r줄3' }] } }, 200, 26).A1.messages[0].text, '줄1\n줄2\n줄3', 'CRLF and CR fold to LF');
  eq(sanitizeComments({ A1: { messages: [{ text: '\u0001\u0002\u0003' }] } }, 200, 26), {}, 'a message of nothing but control characters is dropped, and with it the thread');
  eq(sanitizeComments({ A1: { messages: [{ text: '   ' }] } }, 200, 26), {}, 'so is a whitespace-only message');
  // Comment text is data, never markup: the characters survive verbatim and the consumer
  // is the one obliged to insert them with textContent.
  eq(
    sanitizeComments({ A1: { messages: [{ text: '<img src=x onerror=alert(1)>' }] } }, 200, 26).A1.messages[0].text,
    '<img src=x onerror=alert(1)>',
    'markup-looking text is kept literally, not escaped and not stripped'
  );
});

test('sanitizeComments holds MAX_COMMENTS_PER_SHEET', () => {
  const many = {};
  for (let r = 0; r < MAX_COMMENTS_PER_SHEET + 9; r++) many['A' + (r + 1)] = { messages: [{ text: '메모 ' + r }] };
  const out = sanitizeComments(many, 1000, 26);
  const keys = Object.keys(out);
  eq(keys.length, MAX_COMMENTS_PER_SHEET, 'capped at MAX_COMMENTS_PER_SHEET threads');
  eq(keys[0], 'A1', 'kept in row-major order, from the top');
  eq(keys[keys.length - 1], 'A' + MAX_COMMENTS_PER_SHEET, 'the last kept thread is the 500th row');
  eq(new Set(keys).size, keys.length, 'no duplicate keys');
  eq(new Set(Object.values(out).map((t) => t.id)).size, keys.length, 'every thread id is unique');
});

test('sanitizeComments drops a thread whose cell key is malformed', () => {
  const map = {
    B: { messages: [{ text: '열만' }] },
    4: { messages: [{ text: '행만' }] },
    B4x: { messages: [{ text: '꼬리' }] },
    '': { messages: [{ text: '빈 키' }] },
    A0: { messages: [{ text: '0행' }] },
    '$B$4': { messages: [{ text: '절대참조' }] },
    'A1:B2': { messages: [{ text: '범위' }] },
    ZZZ9999: { messages: [{ text: '시트 밖' }] },
    B4: { messages: [{ text: '정상' }] },
  };
  const out = pure([map], () => sanitizeComments(map, 200, 26), 'sanitizeComments');
  eq(Object.keys(out), ['B4'], 'only the well-formed key inside the sheet survives');
  eq(out.B4.messages[0].text, '정상', 'and it keeps its message');
});

test('sanitizeComments returns an empty map for garbage without throwing', () => {
  for (const bad of [null, undefined, 0, 42, '', 'nope', [], [1], true]) {
    eq(noThrow(() => sanitizeComments(bad, 200, 26)), { threw: false, value: {} }, 'garbage: ' + snap(bad));
  }
  // One unreadable thread must never take the rest of the sheet down.
  const mixed = { A1: 'string', A2: null, A3: [], A4: { messages: 'x' }, A5: { messages: [] }, A6: { messages: [{ text: '남는다' }] } };
  eq(noThrow(() => Object.keys(sanitizeComments(mixed, 200, 26))), { threw: false, value: ['A6'] }, 'the readable thread survives beside the unreadable ones');
});

test('sanitizeComments bounds an author and a timestamp without trusting them', () => {
  // These fields are SERVER-stamped. Validation cannot make a client-supplied author
  // trustworthy; it only makes it harmless and bounded.
  const out = sanitizeComments(
    { A1: { messages: [{ text: 'x', author: '가'.repeat(400), authorId: 'p'.repeat(400), at: -5 }, { text: 'y', at: 1730000000000 }, { text: 'z', at: 'nope' }] } },
    200, 26
  );
  const msgs = out.A1.messages;
  eq(msgs.length, 3, 'all three messages survive');
  eq(msgs[0].author.length <= 100, true, 'the author name is bounded');
  eq(msgs[0].authorId.length <= 64, true, 'the author id is bounded');
  eq(msgs[0].at, 0, 'a negative timestamp becomes 0 (unknown), never "now"');
  eq(msgs[1].at, 1730000000000, 'a real timestamp survives');
  eq(msgs[2].at, 0, 'an unparseable timestamp becomes 0');
  eq(typeof sanitizeComments({ A1: { messages: [{ text: 'x' }] } }, 200, 26).A1.messages[0].author, 'string', 'a missing author still yields a string');
  eq(new Set(msgs.map((m) => m.id)).size, 3, 'message ids are unique inside a thread');
});

// ---------------------------------------------------------------------------
// structural edits move all three — SPEC 24.1 / 24.2 / 24.3
// ---------------------------------------------------------------------------

test('inserting a row above a filter range shifts it', () => {
  const f = { range: 'A5:C10', header: true, sort: { col: 1, dir: 'asc' }, hidden: { 2: ['x'] } };
  const out = pure([f], () => shiftFilter(f, { kind: 'insertRow', index: 0, count: 2 }, 202, 26), 'shiftFilter');
  eq(out.range, 'A7:C12', 'the whole band slid down by two rows');
  eq(out.sort, { col: 1, dir: 'asc' }, 'a row edit leaves the relative sort column alone');
  eq(out.hidden, { 2: ['x'] }, 'and the relative hidden keys');

  eq(shiftFilter(f, { kind: 'insertRow', index: 6, count: 1 }, 201, 26).range, 'A5:C11', 'an insert INSIDE the range grows it');
  eq(shiftFilter(f, { kind: 'insertRow', index: 20, count: 3 }, 203, 26).range, 'A5:C10', 'an insert below the range leaves it alone');
  eq(shiftFilter(f, { kind: 'deleteRow', index: 0, count: 2 }, 198, 26).range, 'A3:C8', 'a delete above pulls it back');
  eq(shiftFilter(f, { kind: 'deleteRow', index: 4, count: 6 }, 194, 26), null, 'deleting every row it covered drops the filter');
});

test('a column edit remaps a filter sort column and hidden keys', () => {
  // B2:E9 covers columns B C D E, so relative column 2 is D and 3 is E.
  const f = { range: 'B2:E9', header: true, sort: { col: 2, dir: 'asc' }, hidden: { 3: ['x'] } };
  eq(
    shiftFilter(f, { kind: 'insertCol', index: 1, count: 1 }, 200, 27),
    { range: 'C2:F9', header: true, sort: { col: 2, dir: 'asc' }, hidden: { 3: ['x'] } },
    'a column before the range slides everything; relative indexes are unchanged'
  );
  eq(
    shiftFilter(f, { kind: 'insertCol', index: 3, count: 1 }, 200, 27),
    { range: 'B2:F9', header: true, sort: { col: 3, dir: 'asc' }, hidden: { 4: ['x'] } },
    'a column landing inside grows the range and pushes D and E right'
  );
  eq(
    shiftFilter(f, { kind: 'deleteCol', index: 3, count: 1 }, 200, 25),
    { range: 'B2:D9', header: true, sort: null, hidden: { 2: ['x'] } },
    "column D is gone: its sort is dropped rather than silently sorting E's data"
  );
  eq(shiftFilter(f, { kind: 'deleteCol', index: 1, count: 4 }, 200, 22), null, 'every column it covered was deleted');
});

test('inserting a row above a chart range shifts it, and deleting its rows drops it', () => {
  const charts = [{
    id: 'ch01', type: 'line', range: 'B4:D9', title: '분기 매출',
    headerRow: true, headerCol: true, x: 10, y: 20, w: 300, h: 200, legend: 'bottom',
  }];
  const out = pure([charts], () => shiftCharts(charts, { kind: 'insertRow', index: 0, count: 2 }, 202, 26), 'shiftCharts');
  eq(out.length, 1, 'the chart survives');
  eq(out[0].range, 'B6:D11', 'its range slid down by two rows');
  eq(withoutId({ ...out[0], range: 'B4:D9' }), withoutId(charts[0]), 'nothing but the range changed — pixel geometry is left alone');

  eq(shiftCharts(charts, { kind: 'insertRow', index: 5, count: 1 }, 201, 26)[0].range, 'B4:D10', 'an insert inside grows the range');
  eq(shiftCharts(charts, { kind: 'deleteCol', index: 1, count: 1 }, 200, 25)[0].range, 'B4:C9', 'a column delete inside shrinks it');
  eq(shiftCharts(charts, { kind: 'deleteRow', index: 3, count: 6 }, 194, 26), [], 'deleting every row the chart plotted drops the chart');
  eq(shiftCharts(charts, { kind: 'deleteCol', index: 1, count: 3 }, 200, 23), [], 'so does deleting every column');
  eq(shiftCharts(charts, { kind: 'deleteRow', index: 4, count: 2 }, 198, 26)[0].range, 'B4:D7', 'a partial row delete only shrinks it');
  eq(noThrow(() => shiftCharts(null, { kind: 'insertRow', index: 0, count: 1 }, 201, 26)), { threw: false, value: [] }, 'no charts, no trouble');
});

test('a structural edit moves a comment key, and a delete on its row drops it', () => {
  const thread = { id: 'cm01', cell: 'B4', resolved: false, messages: [{ id: 'ms01', author: '민수', authorId: 'p1', text: '확인', at: 1730000000000 }] };
  const map = { B4: thread };

  const down = pure([map], () => shiftComments(map, { kind: 'insertRow', index: 0, count: 2 }, 202, 26), 'shiftComments');
  eq(Object.keys(down), ['B6'], 'a row inserted above moves the key down');
  eq(down.B6.cell, 'B6', 'and the thread agrees about where it now lives');
  eq(down.B6.messages, thread.messages, 'the messages ride along untouched');

  eq(Object.keys(shiftComments(map, { kind: 'insertCol', index: 0, count: 1 }, 200, 27)), ['C4'], 'a column inserted left moves it right');
  eq(Object.keys(shiftComments(map, { kind: 'deleteCol', index: 0, count: 1 }, 200, 25)), ['A4'], 'a column deleted left pulls it back');
  eq(Object.keys(shiftComments(map, { kind: 'deleteRow', index: 0, count: 2 }, 198, 26)), ['B2'], 'a row deleted above pulls it up');

  eq(shiftComments(map, { kind: 'deleteRow', index: 3, count: 1 }, 199, 26), {}, 'deleting the row the comment sits on drops it');
  eq(shiftComments(map, { kind: 'deleteCol', index: 1, count: 1 }, 200, 25), {}, 'so does deleting its column');

  const two = { B4: thread, B9: { ...thread, id: 'cm02', cell: 'B9' } };
  const survivor = shiftComments(two, { kind: 'deleteRow', index: 3, count: 1 }, 199, 26);
  eq(Object.keys(survivor), ['B8'], 'the comment below the deleted row moves up while the one on it is dropped');
});

// ---------------------------------------------------------------------------
// a sheet with none of this must be unchanged — SPEC 24 intro
// ---------------------------------------------------------------------------

test('a sheet with no filter, no chart and no comment loads with all three empty', () => {
  const doc = sanitizeDoc({
    id: 'aaaaaa111111',
    name: '데이터 문서',
    sheets: [{ id: 'sh0001', name: '시트1', rows: 50, cols: 10, cells: { A1: { input: '1' } } }],
    createdAt: 1730000000000,
    updatedAt: 1730000000000,
    rev: 1,
  });
  const sheet = doc.sheets[0];
  eq(sheet.filter, null, 'no filter view');
  eq(sheet.charts, [], 'no charts, and never undefined');
  eq(sheet.comments, {}, 'no comments, and never undefined');
  eq(sheet.cells, { A1: { input: '1' } }, 'the cells are untouched by any of this');

  // And the helpers over an unfiltered sheet are exactly the no-op the grid does today.
  eq(computeSortOrder(sheet.cells, sheet.filter, null, 5), [0, 1, 2, 3, 4], 'identity order');
  eq(rows(computeVisibleRows(sheet.cells, sheet.filter, null, 5)), [0, 1, 2, 3, 4], 'every row visible');
});

// ---------------------------------------------------------------------------
// chartSeries — SPEC 24.2 (public/js/chart.js, importable in Node)
// ---------------------------------------------------------------------------

// A 3x3 range A1:C3:
//        A       B       C
//   1   '월'    '매출'   '비용'
//   2   '1월'    10       3
//   3   '2월'    20      '없음'
const CHART_GRID = [
  ['월', '매출', '비용'],
  ['1월', 10, 3],
  ['2월', 20, '없음'],
];

test('chartSeries splits the range on headerRow and headerCol', async () => {
  const { chartSeries } = await loadChart();
  const valueOf = readerFor(CHART_GRID);

  const both = chartSeries({}, { range: 'A1:C3', headerRow: true, headerCol: true }, valueOf);
  eq(both.categories, ['1월', '2월'], 'the first column supplies the category labels');
  eq(both.series.map((s) => s.name), ['매출', '비용'], 'the first row supplies the series names');
  eq(both.series.map((s) => s.values), [[10, 20], [3, null]], 'each remaining column is one series');

  const rowOnly = chartSeries({}, { range: 'A1:C3', headerRow: true, headerCol: false }, valueOf);
  eq(rowOnly.categories, ['1', '2'], 'without headerCol the categories are 1..n');
  eq(rowOnly.series.map((s) => s.name), ['월', '매출', '비용'], 'every column is a series, named from the header row');

  const colOnly = chartSeries({}, { range: 'A1:C3', headerRow: false, headerCol: true }, valueOf);
  eq(colOnly.categories, ['월', '1월', '2월'], 'without headerRow the first row is data, so it is a category');
  eq(colOnly.series.length, 2, 'two series');
  eq(colOnly.series.map((s) => s.values), [[null, 10, 20], [null, 3, null]], 'the header text reads as a gap');

  const neither = chartSeries({}, { range: 'A1:C3', headerRow: false, headerCol: false }, valueOf);
  eq(neither.categories, ['1', '2', '3'], 'three categories');
  eq(neither.series.length, 3, 'three series');
  eq(neither.series.every((s) => typeof s.name === 'string' && s.name.length > 0), true, 'an unnamed series still gets a legend label');
});

test('chartSeries turns a non-numeric cell into null, not 0', async () => {
  const { chartSeries } = await loadChart();
  const grid = [
    ['계열'],
    [10],
    ['없음'],
    [null],
    [true],
    [''],
    [{ code: '#DIV/0!' }],
    [0],
  ];
  const data = chartSeries({}, { range: 'A1:A8', headerRow: true, headerCol: false }, readerFor(grid));
  eq(
    data.series[0].values,
    [10, null, null, null, null, null, 0],
    'text, blank, boolean, empty string and an error are GAPS; a real 0 stays 0'
  );
});

test('chartSeries yields empty series for an empty or unusable range', async () => {
  const { chartSeries } = await loadChart();
  const empty = { categories: [], series: [] };
  const valueOf = readerFor(CHART_GRID);
  const strip = (d) => ({ categories: d.categories, series: d.series });

  eq(strip(chartSeries({}, { range: 'A1:A1', headerRow: true, headerCol: false }, valueOf)), empty, 'a header row and nothing under it');
  eq(strip(chartSeries({}, { range: 'A1:A9', headerRow: false, headerCol: true }, valueOf)), empty, 'a header column and nothing beside it');
  eq(noThrow(() => strip(chartSeries({}, { range: 'nonsense' }, valueOf))), { threw: false, value: empty }, 'an unparseable range');
  eq(noThrow(() => strip(chartSeries({}, null, valueOf))), { threw: false, value: empty }, 'no chart at all');
  eq(noThrow(() => strip(chartSeries({}, {}, valueOf))), { threw: false, value: empty }, 'a chart with no range');
  eq(noThrow(() => strip(chartSeries(null, { range: 'A1:B2' }, null))), { threw: false, value: { categories: ['1', '2'], series: [{ name: '계열 1', values: [null, null] }, { name: '계열 2', values: [null, null] }] } }, 'no cells and no reader: a blank chart, not a throw');
});

test('chartSeries reads the raw cell map when no valueOf is injected', async () => {
  const { chartSeries } = await loadChart();
  const cells = { A1: { input: '매출' }, A2: { input: '5' }, A3: { input: 'abc' } };
  const data = chartSeries(cells, { range: 'A1:A3', headerRow: true, headerCol: false });
  eq(data.categories, ['1', '2'], 'two data rows');
  eq(data.series.map((s) => s.name), ['매출'], 'the header cell names the series');
  eq(data.series[0].values, [5, null], 'a numeric literal plots; text is a gap');
});

test('CHART_TYPES lists exactly the six types SPEC 24.2 names', async () => {
  const { CHART_TYPES } = await loadChart();
  eq(CHART_TYPES.map((t) => t.id), ['column', 'bar', 'line', 'area', 'pie', 'scatter'], 'ids, in picker order');
  eq(CHART_TYPES.every((t) => typeof t.label === 'string' && t.label.length > 0), true, 'each carries a Korean label');
  // Every id the picker offers must be one sanitizeChart accepts, or the picker could
  // produce a chart the document immediately rewrites to 'column'.
  for (const t of CHART_TYPES) {
    eq(sanitizeChart({ range: 'A1:B2', type: t.id }, 200, 26).type, t.id, 'sanitizeChart accepts ' + t.id);
  }
});

// ---------------------------------------------------------------------------
// purity — every helper leaves its inputs untouched
// ---------------------------------------------------------------------------

test('every batch-C helper is pure', async () => {
  const { chartSeries } = await loadChart();

  const cells = { A1: { input: '이름' }, B1: { input: '점수' }, B2: { input: '30' }, B3: { input: '10' }, B4: { input: '' } };
  const filter = { range: 'A1:B4', header: true, sort: { col: 1, dir: 'desc' }, hidden: { 1: ['30'] } };
  const chart = { id: 'ch01', type: 'pie', range: 'A1:B4', title: '점수', headerRow: true, headerCol: true, x: 5, y: 6, w: 200, h: 150, legend: 'none' };
  const charts = [chart];
  const comments = { B2: { id: 'cm01', cell: 'B2', resolved: false, messages: [{ id: 'ms01', author: '민수', authorId: 'p1', text: '확인', at: 1730000000000 }] } };
  const edit = { kind: 'insertRow', index: 0, count: 1 };
  const valueOf = readerFor(SCORES);

  const inputs = [cells, filter, chart, charts, comments, edit];

  pure(inputs, () => computeSortOrder(cells, filter, valueOf, 4), 'computeSortOrder');
  pure(inputs, () => computeVisibleRows(cells, filter, valueOf, 4), 'computeVisibleRows');
  pure(inputs, () => filterColumnValues(cells, filter.range, 1, filter.header, valueOf), 'filterColumnValues');
  pure(inputs, () => sanitizeFilter(filter, 200, 26), 'sanitizeFilter');
  pure(inputs, () => sanitizeChart(chart, 200, 26), 'sanitizeChart');
  pure(inputs, () => sanitizeChartList(charts, 200, 26), 'sanitizeChartList');
  pure(inputs, () => sanitizeComments(comments, 200, 26), 'sanitizeComments');
  pure(inputs, () => shiftFilter(filter, edit, 201, 26), 'shiftFilter');
  pure(inputs, () => shiftCharts(charts, edit, 201, 26), 'shiftCharts');
  pure(inputs, () => shiftComments(comments, edit, 201, 26), 'shiftComments');
  pure(inputs, () => chartSeries(cells, chart, valueOf), 'chartSeries');

  // The returned structures must be fresh too: mutating a result can never reach back into
  // the argument it was derived from.
  const list = sanitizeChartList(charts, 200, 26);
  list[0].title = '바뀜';
  eq(chart.title, '점수', 'mutating a sanitized chart does not touch the source');

  const threads = sanitizeComments(comments, 200, 26);
  threads.B2.messages[0].text = '바뀜';
  eq(comments.B2.messages[0].text, '확인', 'mutating a sanitized thread does not touch the source');

  const order = computeSortOrder(cells, filter, valueOf, 4);
  order[0] = 99;
  eq(computeSortOrder(cells, filter, valueOf, 4)[0], 0, 'the order array is freshly allocated each call');
});
