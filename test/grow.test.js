// test/grow.test.js — growing a sheet (SPEC section 25).
//
// A sheet ships at DEFAULT_ROWS x DEFAULT_COLS (200 x 26) and may grow to
// MAX_ROWS x MAX_COLS (5000 x 702). `growSheet` is the ONLY way that extent ever
// increases, and it is a pure helper in shared/model.js, so this file is where the
// promises of section 25 get pinned down:
//
//   1. GROWTH IS STRICTLY ADDITIVE. Cells, merges, filter, charts, comments, colWidths
//      and rowHeights come out the other side deep-equal to what went in. A grown sheet
//      cannot corrupt a formula or move anything, and that is proved twice: once by
//      deep-comparing every one of those fields, and once by rebuilding a SheetEngine on
//      the grown geometry and checking a formula sitting in the LAST row still holds the
//      same text and still computes the same value.
//   2. NOTHING HAPPENED IS DETECTABLE. A request that would change nothing — zero,
//      negative, NaN, junk, an unknown sheet, a sheet already at the maximum — returns
//      the SAME document reference, so a caller (the auto-grow path fires speculatively
//      on every scroll near an edge) can test `next === doc` instead of emitting a wire
//      frame for a sheet that cannot grow.
//   3. THE CEILING IS A CLAMP, NOT A REFUSAL. A request for more than remains grows by
//      exactly what remains.
//
// Two rules are followed throughout:
//   - Only what SPEC section 25 guarantees is asserted; nothing here reaches into a
//     private field or depends on an implementation detail.
//   - Purity is asserted literally — a case that calls the helper also compares a JSON
//     snapshot of the document taken before the call.

import { test, eq } from './run.js';

import {
  DEFAULT_ROWS,
  DEFAULT_COLS,
  ROW_GROW_STEP,
  COL_GROW_STEP,
  growSheet,
  sanitizeDoc,
  emptyDoc,
  findSheet,
} from '../shared/model.js';

import { MAX_ROWS, MAX_COLS } from '../shared/formula/refs.js';
import { SheetEngine } from '../shared/formula/engine.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A deep, order-preserving snapshot used to prove the helper did not mutate its input. */
function snapshot(doc) {
  return JSON.stringify(doc);
}

/**
 * Run `fn(doc)` and assert the document it was handed is byte-for-byte unchanged
 * afterwards. Returns whatever `fn` returned so a case can keep asserting on it.
 */
function pure(doc, fn, label) {
  const before = snapshot(doc);
  const out = fn(doc);
  eq(snapshot(doc), before, (label || 'growSheet') + ' must not mutate its input document');
  return out;
}

/** `{rows, cols}` of one sheet — the only thing growth is allowed to change. */
function extent(doc, sheetId) {
  const sheet = findSheet(doc, sheetId);
  return sheet ? { rows: sheet.rows, cols: sheet.cols } : null;
}

// A document with two sheets. The first carries one of EVERYTHING section 25 promises not
// to touch — cells (including a formula in the last row and one in the last column), a
// merge, a filter view, a chart, a comment thread, a column width and a row height — plus
// frozen panes and a tab colour. The second sheet exists so a case can prove growing one
// sheet leaves its neighbours alone.
const SHEET_ID = 'shgrw1';
const OTHER_ID = 'shgrw2';

function richDoc() {
  return sanitizeDoc({
    id: 'growdoc00001',
    name: '성장 테스트 문서',
    sheets: [
      {
        id: SHEET_ID,
        name: '데이터',
        color: '#34a853',
        rows: DEFAULT_ROWS,
        cols: DEFAULT_COLS,
        cells: {
          A1: { input: '항목' },
          A2: { input: '10' },
          A3: { input: '20' },
          B2: { input: '=A2*2', style: { b: 1, fmt: 'number', decimals: 2 } },
          Z1: { input: '=COLUMN()' },
          A200: { input: '5' },
          B200: { input: '=SUM(A2:A200)' },
        },
        colWidths: { 2: 160 },
        rowHeights: { 5: 40 },
        frozenRows: 1,
        frozenCols: 1,
        merges: ['C1:E1'],
        filter: {
          range: 'A1:C100',
          header: true,
          sort: { col: 0, dir: 'asc' },
          hidden: { 1: ['취소', '보류'] },
        },
        charts: [
          {
            id: 'chgrw1',
            type: 'line',
            range: 'A1:B10',
            title: '분기 추이',
            headerRow: true,
            headerCol: true,
            x: 320,
            y: 80,
            w: 480,
            h: 300,
            legend: 'right',
          },
        ],
        comments: {
          B4: {
            id: 'cmgrw1',
            cell: 'B4',
            resolved: false,
            messages: [
              { id: 'msgrw1', author: '민수', authorId: 'p1', text: '확인 부탁드립니다', at: 1730000000000 },
            ],
          },
        },
      },
      { id: OTHER_ID, name: '보조', rows: DEFAULT_ROWS, cols: DEFAULT_COLS },
    ],
    createdAt: 1730000000000,
    updatedAt: 1730000000000,
    rev: 7,
  });
}

/** A sheet with a given extent and no content — for the clamp arithmetic. */
function docSized(rows, cols) {
  return sanitizeDoc({
    id: 'growdoc00002',
    name: '크기 테스트',
    sheets: [{ id: SHEET_ID, name: '데이터', rows, cols }],
    createdAt: 1730000000000,
    updatedAt: 1730000000000,
    rev: 1,
  });
}

/** Rebuild an engine on a sheet's stored geometry and cells, exactly as a client does. */
function engineFor(sheet) {
  return new SheetEngine({ rows: sheet.rows, cols: sheet.cols, cells: sheet.cells });
}

/** Replace one sheet's cell map, without disturbing anything else. */
function withCell(doc, sheetId, key, entry) {
  return {
    ...doc,
    sheets: doc.sheets.map((s) =>
      s.id === sheetId ? { ...s, cells: { ...s.cells, [key]: entry } } : s
    ),
  };
}

// ---------------------------------------------------------------------------
// the growth steps
// ---------------------------------------------------------------------------

test('ROW_GROW_STEP / COL_GROW_STEP are the sizes SPEC 25.1 names', () => {
  eq(ROW_GROW_STEP, 1000, 'one press of 맨 아래에 행 추가 adds 1000 rows');
  eq(COL_GROW_STEP, 26, 'one press of 오른쪽에 열 추가 adds 26 columns — one more A..Z band');
});

// ---------------------------------------------------------------------------
// growth adds what was asked for
// ---------------------------------------------------------------------------

test('growSheet adds the requested rows and returns a NEW document', () => {
  const doc = richDoc();
  eq(extent(doc, SHEET_ID), { rows: DEFAULT_ROWS, cols: DEFAULT_COLS }, 'a new sheet starts at 200 x 26');

  const next = pure(doc, (d) => growSheet(d, SHEET_ID, { rows: ROW_GROW_STEP }));
  eq(next === doc, false, 'a document that actually grew is a new object');
  eq(extent(next, SHEET_ID), { rows: DEFAULT_ROWS + ROW_GROW_STEP, cols: DEFAULT_COLS }, '200 -> 1200 rows');
  eq(extent(doc, SHEET_ID), { rows: DEFAULT_ROWS, cols: DEFAULT_COLS }, 'the argument still reads 200 x 26');
});

test('growSheet adds the requested columns, and both axes in one call', () => {
  const doc = richDoc();

  const cols = pure(doc, (d) => growSheet(d, SHEET_ID, { cols: COL_GROW_STEP }));
  eq(extent(cols, SHEET_ID), { rows: DEFAULT_ROWS, cols: DEFAULT_COLS + COL_GROW_STEP }, 'A..Z -> A..AZ');

  const both = pure(doc, (d) => growSheet(d, SHEET_ID, { rows: 300, cols: 4 }));
  eq(extent(both, SHEET_ID), { rows: 500, cols: 30 }, 'the two axes grow independently in one call');

  // Growth composes: three presses of the row button reach 3200.
  let stacked = doc;
  for (let i = 0; i < 3; i++) stacked = growSheet(stacked, SHEET_ID, { rows: ROW_GROW_STEP });
  eq(extent(stacked, SHEET_ID), { rows: DEFAULT_ROWS + 3 * ROW_GROW_STEP, cols: DEFAULT_COLS }, '200 -> 3200');
});

test('growSheet grows exactly one sheet', () => {
  const doc = richDoc();
  const next = pure(doc, (d) => growSheet(d, SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP }));

  eq(extent(next, OTHER_ID), { rows: DEFAULT_ROWS, cols: DEFAULT_COLS }, 'the neighbouring sheet keeps its own extent');
  eq(findSheet(next, OTHER_ID), findSheet(doc, OTHER_ID), 'and is otherwise untouched');
  eq(next.sheets.map((s) => s.id), [SHEET_ID, OTHER_ID], 'tab order is preserved');

  // Document-level bookkeeping belongs to the server, not to a pure helper.
  eq(
    { id: next.id, name: next.name, createdAt: next.createdAt, updatedAt: next.updatedAt, rev: next.rev },
    { id: doc.id, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt, rev: doc.rev },
    'the document envelope is carried across unchanged'
  );
});

// ---------------------------------------------------------------------------
// the ceiling
// ---------------------------------------------------------------------------

test('growSheet clamps a too-large request to MAX_ROWS / MAX_COLS', () => {
  const doc = richDoc();

  const huge = pure(doc, (d) => growSheet(d, SHEET_ID, { rows: 99999, cols: 99999 }));
  eq(extent(huge, SHEET_ID), { rows: MAX_ROWS, cols: MAX_COLS }, 'clamped to 5000 x 702, not refused');

  // A partially satisfiable request still applies, and grows by exactly what remains.
  const nearly = docSized(MAX_ROWS - 100, MAX_COLS - 2);
  const filled = pure(nearly, (d) => growSheet(d, SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP }));
  eq(extent(filled, SHEET_ID), { rows: MAX_ROWS, cols: MAX_COLS }, '4900 + 1000 rows is 5000, not 5900');

  // The axes clamp independently: one may be capped while the other has room to spare.
  const lopsided = pure(docSized(MAX_ROWS - 10, DEFAULT_COLS), (d) =>
    growSheet(d, SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP })
  );
  eq(extent(lopsided, SHEET_ID), { rows: MAX_ROWS, cols: DEFAULT_COLS + COL_GROW_STEP }, 'rows capped, columns not');
});

test('growSheet at the maximum returns the SAME document object', () => {
  const atMax = docSized(MAX_ROWS, MAX_COLS);
  eq(extent(atMax, SHEET_ID), { rows: MAX_ROWS, cols: MAX_COLS }, 'the fixture really is at the ceiling');

  for (const req of [{ rows: 1 }, { cols: 1 }, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP }, { rows: 99999 }]) {
    const out = pure(atMax, (d) => growSheet(d, SHEET_ID, req));
    eq(out === atMax, true, 'nothing to give: the very same reference comes back for ' + JSON.stringify(req));
  }

  // Only the exhausted axis is refused; a sheet at the row ceiling can still gain columns.
  const rowsFull = docSized(MAX_ROWS, DEFAULT_COLS);
  const grown = growSheet(rowsFull, SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP });
  eq(grown === rowsFull, false, 'one usable axis is enough to produce a new document');
  eq(extent(grown, SHEET_ID), { rows: MAX_ROWS, cols: DEFAULT_COLS + COL_GROW_STEP }, 'columns grew, rows stood still');
});

// ---------------------------------------------------------------------------
// requests that must do nothing — and must never shrink
// ---------------------------------------------------------------------------

test('a zero, negative, NaN or non-numeric request changes nothing', () => {
  // Start from a sheet that has ALREADY grown, so a bug that shrinks instead of refusing
  // has somewhere to shrink to.
  const doc = growSheet(richDoc(), SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP });
  const grownExtent = { rows: DEFAULT_ROWS + ROW_GROW_STEP, cols: DEFAULT_COLS + COL_GROW_STEP };
  eq(extent(doc, SHEET_ID), grownExtent, 'the fixture is 1200 x 52 before anything is asked of it');

  const refused = [
    { rows: 0, cols: 0 },
    { rows: 0 },
    { cols: 0 },
    { rows: -1 },
    { rows: -500, cols: -500 },
    { cols: -MAX_COLS },
    { rows: NaN },
    { cols: NaN },
    { rows: NaN, cols: NaN },
    { rows: Infinity },
    { cols: -Infinity },
    { rows: 'abc' },
    { cols: '많이' },
    { rows: '' },
    { rows: {} },
    { cols: ['x'] },
    { rows: null },
    { cols: undefined },
    { rows: false },
    { rows: () => ROW_GROW_STEP },
    {},
  ];

  for (const req of refused) {
    const out = pure(doc, (d) => growSheet(d, SHEET_ID, req));
    eq(out === doc, true, 'no-op request returns the same document: ' + String(req.rows) + '/' + String(req.cols));
    eq(extent(out, SHEET_ID), grownExtent, 'and never shrinks the sheet');
  }

  // A missing or unusable options bag is the same as asking for nothing.
  for (const opts of [undefined, null, 'rows', 7, []]) {
    const out = growSheet(doc, SHEET_ID, opts);
    eq(out === doc, true, 'unusable options are a no-op: ' + JSON.stringify(opts ?? null));
  }
  eq(growSheet(doc, SHEET_ID) === doc, true, 'omitting the options entirely is a no-op');
});

test('an unknown sheetId returns the document unchanged', () => {
  const doc = richDoc();
  for (const id of ['nosuchsheet', SHEET_ID + 'x', '', 'SHGRW1', null, undefined, 0, {}]) {
    const out = pure(doc, (d) => growSheet(d, id, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP }));
    eq(out === doc, true, 'unknown sheet id is refused: ' + String(id));
  }
  eq(extent(doc, SHEET_ID), { rows: DEFAULT_ROWS, cols: DEFAULT_COLS }, 'no sheet grew by accident');
});

test('a grown extent is always a whole number of rows and columns', () => {
  const doc = richDoc();
  const out = growSheet(doc, SHEET_ID, { rows: 100.7, cols: 3.9 });
  const size = extent(out, SHEET_ID);
  eq(Number.isInteger(size.rows) && Number.isInteger(size.cols), true, 'the extent stays integral');
  eq(size.rows >= DEFAULT_ROWS && size.rows <= DEFAULT_ROWS + 100.7, true, 'rows grew by no more than asked');
  eq(size.cols >= DEFAULT_COLS && size.cols <= DEFAULT_COLS + 3.9, true, 'columns grew by no more than asked');
});

// ---------------------------------------------------------------------------
// growth touches nothing but the extent
// ---------------------------------------------------------------------------

test('growth leaves cells, merges, filter, charts, comments and sizes untouched', () => {
  const doc = richDoc();
  const before = findSheet(doc, SHEET_ID);
  const next = pure(doc, (d) => growSheet(d, SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP }));
  const after = findSheet(next, SHEET_ID);

  eq(after.cells, before.cells, 'every cell — input, style and key — survives verbatim');
  eq(after.merges, before.merges, 'merged rectangles are not moved or re-clipped');
  eq(after.filter, before.filter, 'the filter view keeps its range, sort and hidden values');
  eq(after.charts, before.charts, 'chart ranges and geometry are untouched');
  eq(after.comments, before.comments, 'comment threads stay on their cells');
  eq(after.colWidths, before.colWidths, 'column widths are untouched');
  eq(after.rowHeights, before.rowHeights, 'row heights are untouched');
  eq(after.frozenRows, before.frozenRows, 'frozen rows are untouched');
  eq(after.frozenCols, before.frozenCols, 'frozen cols are untouched');
  eq(after.id, before.id, 'the sheet id is stable');
  eq(after.name, before.name, 'the sheet name is stable');
  eq(after.color, before.color, 'the tab colour is stable');

  // Said once more, the blunt way: the ONLY difference between the two sheets is rows/cols.
  eq(
    { ...after, rows: before.rows, cols: before.cols },
    { ...before },
    'nothing but rows and cols differs'
  );
});

test('growth does not move anything: a formula in the last row still evaluates the same', () => {
  const doc = richDoc();
  const before = findSheet(doc, SHEET_ID);
  const engBefore = engineFor(before);

  eq(engBefore.getInput('B200'), '=SUM(A2:A200)', 'the fixture formula sits in the last row');
  eq(engBefore.getValue('B200'), 35, '10 + 20 + 5');
  eq(engBefore.getValue('B2'), 20, 'and one in the middle of the sheet');
  eq(engBefore.getValue('Z1'), DEFAULT_COLS, 'a formula in the last column reports column 26');

  const next = growSheet(doc, SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP });
  const after = findSheet(next, SHEET_ID);
  const engAfter = engineFor(after);

  eq(after.rows, DEFAULT_ROWS + ROW_GROW_STEP, 'there are now 1000 blank rows beneath the formula');
  eq(after.cols, DEFAULT_COLS + COL_GROW_STEP, 'and 26 blank columns to its right');

  eq(engAfter.getInput('B200'), engBefore.getInput('B200'), 'the formula text is byte-identical');
  eq(engAfter.getValue('B200'), engBefore.getValue('B200'), 'and it computes the same value');
  eq(engAfter.getInput('A200'), '5', 'the value it reads has not moved either');
  eq(engAfter.getValue('B2'), engBefore.getValue('B2'), 'unrelated formulas are unaffected');
  eq(engAfter.getValue('Z1'), DEFAULT_COLS, 'Z1 is still column 26 — growth appended, it did not shift');
  eq(engAfter.getValues(), engBefore.getValues(), 'every computed value in the sheet is unchanged');

  // Growth made room: the far corner of the new extent is now a writable cell.
  const changed = engAfter.setInput('AZ1200', '=B200+1');
  eq(changed.has('AZ1200'), true, 'the new bottom-right corner accepts a formula');
  eq(engAfter.getValue('AZ1200'), 36, 'which reads the old data correctly');
  eq(engAfter.getValue('B200'), 35, 'and does not disturb it');
});

test('growSheet is pure — the input document is unchanged, deeply', () => {
  const doc = richDoc();
  const before = snapshot(doc);

  const a = growSheet(doc, SHEET_ID, { rows: ROW_GROW_STEP });
  const b = growSheet(a, SHEET_ID, { cols: COL_GROW_STEP });
  const c = growSheet(b, SHEET_ID, { rows: 99999, cols: 99999 });

  eq(snapshot(doc), before, 'the original document is byte-for-byte what it was');
  eq(extent(doc, SHEET_ID), { rows: DEFAULT_ROWS, cols: DEFAULT_COLS }, 'still 200 x 26');
  eq(extent(a, SHEET_ID), { rows: 1200, cols: DEFAULT_COLS }, 'first step');
  eq(extent(b, SHEET_ID), { rows: 1200, cols: 52 }, 'second step');
  eq(extent(c, SHEET_ID), { rows: MAX_ROWS, cols: MAX_COLS }, 'third step reaches the ceiling');
  eq(a === doc || b === a || c === b, false, 'each growing step produced a new document');
});

// ---------------------------------------------------------------------------
// persistence: a grown sheet survives disk and the wire
// ---------------------------------------------------------------------------

test('sanitizeDoc round-trips a grown sheet (1200 x 52) without resetting it', () => {
  const grown = growSheet(richDoc(), SHEET_ID, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP });
  const roundTripped = sanitizeDoc(JSON.parse(JSON.stringify(grown)));

  eq(extent(roundTripped, SHEET_ID), { rows: 1200, cols: 52 }, 'the extent is NOT reset to 200 x 26');
  eq(roundTripped, grown, 'the whole document survives the round trip unchanged');

  // The far corner of the grown sheet is inside it, so its cell is kept — while the same
  // cell in an ungrown sheet is dropped as out-of-sheet. Growth is what made the room.
  const corner = { input: '끝' };
  const keptIn = sanitizeDoc(JSON.parse(JSON.stringify(withCell(grown, SHEET_ID, 'AZ1200', corner))));
  eq(findSheet(keptIn, SHEET_ID).cells.AZ1200, corner, 'AZ1200 is a real cell of a 1200 x 52 sheet');

  const ungrown = richDoc();
  const droppedFrom = sanitizeDoc(JSON.parse(JSON.stringify(withCell(ungrown, SHEET_ID, 'AZ1200', corner))));
  eq(findSheet(droppedFrom, SHEET_ID).cells.AZ1200, undefined, 'and is outside a 200 x 26 sheet');

  // A sheet grown to the ceiling round-trips too — 5000 x 702 is the documented maximum,
  // so sanitizeDoc must not clamp it back down.
  const maxed = growSheet(richDoc(), SHEET_ID, { rows: 99999, cols: 99999 });
  eq(
    extent(sanitizeDoc(JSON.parse(JSON.stringify(maxed))), SHEET_ID),
    { rows: MAX_ROWS, cols: MAX_COLS },
    'the maximum extent survives a save and load'
  );
});

test('a sheet nobody grows behaves exactly as it did before', () => {
  const doc = emptyDoc('growdoc00003', '기본 문서');
  const sheet = doc.sheets[0];
  eq({ rows: sheet.rows, cols: sheet.cols }, { rows: DEFAULT_ROWS, cols: DEFAULT_COLS }, 'a brand new sheet is 200 x 26');
  eq(sanitizeDoc(JSON.parse(JSON.stringify(doc))), doc, 'and round-trips unchanged');
  eq(growSheet(doc, sheet.id, { rows: 0, cols: 0 }) === doc, true, 'growing it by nothing is free');
});
