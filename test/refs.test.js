// test/refs.test.js — A1 notation, ranges and reference transforms (SPEC section 3).
import { test, eq } from './run.js';
import {
  MAX_ROWS,
  MAX_COLS,
  colToLetter,
  letterToCol,
  cellToA1,
  a1ToCell,
  isA1,
  parseRange,
  normalizeRange,
  rangeToA1,
  iterRange,
  rangeCells,
  rangeSize,
  containsCell,
  offsetRef,
  shiftRefForStructuralEdit,
} from '../shared/formula/refs.js';

// --- helpers ---------------------------------------------------------------

/** True when fn() throws a RangeError. */
function throwsRangeError(fn) {
  try {
    fn();
  } catch (e) {
    return e instanceof RangeError;
  }
  return false;
}

/** Absolute flags are only specified as truthy/falsy, so compare them loosely. */
function absFlags(ref) {
  return { absRow: !!ref.absRow, absCol: !!ref.absCol };
}

// --- constants -------------------------------------------------------------

test('refs: MAX_ROWS / MAX_COLS constants', () => {
  eq(MAX_ROWS, 5000);
  eq(MAX_COLS, 702);
});

// --- colToLetter / letterToCol --------------------------------------------

test('colToLetter: 0 -> A', () => eq(colToLetter(0), 'A'));
test('colToLetter: 25 -> Z', () => eq(colToLetter(25), 'Z'));
test('colToLetter: 26 -> AA', () => eq(colToLetter(26), 'AA'));
test('colToLetter: 51 -> AZ', () => eq(colToLetter(51), 'AZ'));
test('colToLetter: 52 -> BA', () => eq(colToLetter(52), 'BA'));
test('colToLetter: 701 -> ZZ (last column)', () => eq(colToLetter(701), 'ZZ'));

test('letterToCol: A -> 0', () => eq(letterToCol('A'), 0));
test('letterToCol: Z -> 25', () => eq(letterToCol('Z'), 25));
test('letterToCol: AA -> 26', () => eq(letterToCol('AA'), 26));
test('letterToCol: ZZ -> 701', () => eq(letterToCol('ZZ'), 701));
test('letterToCol is case-insensitive', () => {
  eq(letterToCol('aa'), 26);
  eq(letterToCol('bA'), 52);
});

test('colToLetter/letterToCol round-trip for 0,25,26,51,52,701', () => {
  for (const n of [0, 25, 26, 51, 52, 701]) {
    eq(letterToCol(colToLetter(n)), n, 'round-trip of col ' + n);
  }
});

test('colToLetter/letterToCol round-trip over the whole column space', () => {
  for (let n = 0; n < MAX_COLS; n++) {
    if (letterToCol(colToLetter(n)) !== n) throw new Error('round-trip broke at col ' + n);
  }
});

// --- cellToA1 / a1ToCell / isA1 -------------------------------------------

test('cellToA1: (0,0) -> A1', () => eq(cellToA1(0, 0), 'A1'));
test('cellToA1: (41,54) -> BC42', () => eq(cellToA1(41, 54), 'BC42'));
test('cellToA1: (4999,701) -> ZZ5000', () => eq(cellToA1(4999, 701), 'ZZ5000'));

test('a1ToCell: A1 has no absolute axes', () => {
  const c = a1ToCell('A1');
  eq(c.row, 0);
  eq(c.col, 0);
  eq(absFlags(c), { absRow: false, absCol: false });
});

test('a1ToCell: BC42 -> row 41, col 54', () => {
  const c = a1ToCell('BC42');
  eq(c.row, 41);
  eq(c.col, 54);
});

test('a1ToCell: $B$3 marks both axes absolute', () => {
  const c = a1ToCell('$B$3');
  eq(c.row, 2);
  eq(c.col, 1);
  eq(absFlags(c), { absRow: true, absCol: true });
});

test('a1ToCell: $B3 is column-absolute only', () => {
  const c = a1ToCell('$B3');
  eq(c.row, 2);
  eq(c.col, 1);
  eq(absFlags(c), { absRow: false, absCol: true });
});

test('a1ToCell: B$3 is row-absolute only', () => {
  const c = a1ToCell('B$3');
  eq(c.row, 2);
  eq(c.col, 1);
  eq(absFlags(c), { absRow: true, absCol: false });
});

test('a1ToCell/cellToA1 round-trip', () => {
  for (const a1 of ['A1', 'B2', 'Z100', 'AA1', 'BC42', 'ZZ5000']) {
    const c = a1ToCell(a1);
    eq(cellToA1(c.row, c.col), a1, 'round-trip of ' + a1);
  }
});

test('a1ToCell throws RangeError on malformed input', () => {
  for (const bad of ['', 'A', '1', 'A1:B2', 'hello', '$']) {
    eq(throwsRangeError(() => a1ToCell(bad)), true, 'expected RangeError for ' + JSON.stringify(bad));
  }
});

test('isA1 accepts plain and absolute cell refs', () => {
  eq(isA1('A1'), true);
  eq(isA1('BC42'), true);
  eq(isA1('$A$1'), true);
});

test('isA1 rejects non-cells', () => {
  eq(isA1('A'), false);
  eq(isA1('1'), false);
  eq(isA1(''), false);
  eq(isA1('A1:B2'), false);
});

// --- parseRange ------------------------------------------------------------

test('parseRange: A1:B3 endpoints', () => {
  const r = parseRange('A1:B3');
  eq({ row: r.s.row, col: r.s.col }, { row: 0, col: 0 });
  eq({ row: r.e.row, col: r.e.col }, { row: 2, col: 1 });
});

test('parseRange: A1:B3 has no absolute flags', () => {
  const r = parseRange('A1:B3');
  eq(absFlags(r.s), { absRow: false, absCol: false });
  eq(absFlags(r.e), { absRow: false, absCol: false });
});

test('parseRange: $A$1:$B$3 keeps every $ flag', () => {
  const r = parseRange('$A$1:$B$3');
  eq({ row: r.s.row, col: r.s.col }, { row: 0, col: 0 });
  eq({ row: r.e.row, col: r.e.col }, { row: 2, col: 1 });
  eq(absFlags(r.s), { absRow: true, absCol: true });
  eq(absFlags(r.e), { absRow: true, absCol: true });
});

test('parseRange: A:A is a whole column', () => {
  const r = parseRange('A:A');
  eq(r.s.col, 0);
  eq(r.e.col, 0);
  eq(r.s.row, 0);
  eq(r.e.row, MAX_ROWS - 1);
  eq(!!r.wholeCol, true);
});

test('parseRange: 2:4 is a whole row band', () => {
  const r = parseRange('2:4');
  eq(r.s.row, 1);
  eq(r.e.row, 3);
  eq(r.s.col, 0);
  eq(r.e.col, MAX_COLS - 1);
  eq(!!r.wholeRow, true);
});

test('parseRange: B2:D9 spans the expected size', () => {
  eq(rangeSize(parseRange('B2:D9')), { rows: 8, cols: 3 });
});

// --- normalizeRange --------------------------------------------------------

test('normalizeRange flips a reversed range', () => {
  const n = normalizeRange(parseRange('B3:A1'));
  eq({ row: n.s.row, col: n.s.col }, { row: 0, col: 0 });
  eq({ row: n.e.row, col: n.e.col }, { row: 2, col: 1 });
});

test('normalizeRange returns a copy and leaves the input alone', () => {
  const r = parseRange('B3:A1');
  const n = normalizeRange(r);
  eq(r.s.row, 2, 'source start row untouched');
  eq(r.s.col, 1, 'source start col untouched');
  eq(n === r, false);
});

test('normalizeRange is a no-op on an already ordered range', () => {
  const n = normalizeRange(parseRange('A1:B3'));
  eq(rangeSize(n), { rows: 3, cols: 2 });
  eq({ row: n.s.row, col: n.s.col }, { row: 0, col: 0 });
});

test('normalizeRange handles a single reversed axis', () => {
  const n = normalizeRange(parseRange('A3:B1'));
  eq({ row: n.s.row, col: n.s.col }, { row: 0, col: 0 });
  eq({ row: n.e.row, col: n.e.col }, { row: 2, col: 1 });
});

// --- rangeToA1 -------------------------------------------------------------

test('rangeToA1 round-trips a plain range', () => eq(rangeToA1(parseRange('A1:B3')), 'A1:B3'));
test('rangeToA1 preserves $ flags', () => eq(rangeToA1(parseRange('$A$1:$B$3')), '$A$1:$B$3'));
test('rangeToA1 preserves mixed $ flags', () => eq(rangeToA1(parseRange('$A1:B$3')), '$A1:B$3'));

// --- iterRange / rangeCells / rangeSize / containsCell ---------------------

test('iterRange visits row-major and returns undefined', () => {
  const seen = [];
  const out = iterRange(parseRange('A1:B3'), (row, col) => seen.push([row, col]));
  eq(out, undefined);
  eq(seen, [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]]);
});

test('iterRange visit count matches rangeSize', () => {
  let n = 0;
  const r = parseRange('C2:F9');
  iterRange(r, () => { n++; });
  const size = rangeSize(r);
  eq(n, size.rows * size.cols);
  eq(n, 32);
});

test('rangeCells: single column keeps sheet order', () => {
  eq(rangeCells(parseRange('A1:A3')), ['A1', 'A2', 'A3']);
});

test('rangeCells: single row', () => {
  eq(rangeCells(parseRange('A1:C1')), ['A1', 'B1', 'C1']);
});

test('rangeCells: A1:B3 is row-major', () => {
  eq(rangeCells(parseRange('A1:B3')), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
});

test('rangeCells: count and corner cells', () => {
  const cells = rangeCells(parseRange('A1:B3'));
  eq(cells.length, 6);
  eq(cells[0], 'A1');
  eq(cells[cells.length - 1], 'B3');
});

test('rangeCells: keys carry no $ even for an absolute range', () => {
  eq(rangeCells(parseRange('$A$1:$A$2')), ['A1', 'A2']);
});

test('rangeCells: whole column expands to MAX_ROWS cells', () => {
  const cells = rangeCells(parseRange('A:A'));
  eq(cells.length, MAX_ROWS);
  eq(cells[0], 'A1');
  eq(cells[MAX_ROWS - 1], 'A' + MAX_ROWS);
});

test('rangeCells: throws RangeError past the 200000 cap', () => {
  eq(throwsRangeError(() => rangeCells(parseRange('A1:ZZ1000'))), true);
});

test('rangeSize: whole column', () => eq(rangeSize(parseRange('A:A')), { rows: MAX_ROWS, cols: 1 }));
test('rangeSize: whole row', () => eq(rangeSize(parseRange('3:3')), { rows: 1, cols: MAX_COLS }));
test('rangeSize: single cell range', () => eq(rangeSize(parseRange('D4:D4')), { rows: 1, cols: 1 }));

test('containsCell: inside', () => eq(containsCell(parseRange('B2:D5'), 3, 2), true));
test('containsCell: top-left corner is inclusive', () => eq(containsCell(parseRange('B2:D5'), 1, 1), true));
test('containsCell: bottom-right corner is inclusive', () => eq(containsCell(parseRange('B2:D5'), 4, 3), true));
test('containsCell: outside above', () => eq(containsCell(parseRange('B2:D5'), 0, 2), false));
test('containsCell: outside below', () => eq(containsCell(parseRange('B2:D5'), 5, 2), false));
test('containsCell: outside left', () => eq(containsCell(parseRange('B2:D5'), 3, 0), false));
test('containsCell: outside right', () => eq(containsCell(parseRange('B2:D5'), 3, 4), false));
test('containsCell: whole column ignores the row', () => {
  eq(containsCell(parseRange('B:B'), 4321, 1), true);
  eq(containsCell(parseRange('B:B'), 4321, 2), false);
});

// --- offsetRef -------------------------------------------------------------

test('offsetRef shifts a relative ref on both axes', () => {
  const r = offsetRef(a1ToCell('A1'), 2, 3);
  eq({ row: r.row, col: r.col }, { row: 2, col: 3 });
  eq(!!r.oob, false);
});

test('offsetRef returns a new object and does not mutate the source', () => {
  const src = a1ToCell('A1');
  const r = offsetRef(src, 2, 3);
  eq(r === src, false);
  eq({ row: src.row, col: src.col }, { row: 0, col: 0 });
});

test('offsetRef leaves a fully absolute ref in place', () => {
  const r = offsetRef(a1ToCell('$B$3'), 5, 7);
  eq({ row: r.row, col: r.col }, { row: 2, col: 1 });
});

test('offsetRef: absolute row axis only', () => {
  const r = offsetRef(a1ToCell('B$3'), 5, 7);
  eq(r.row, 2, 'absolute row stays');
  eq(r.col, 8, 'relative column moves');
});

test('offsetRef: absolute column axis only', () => {
  const r = offsetRef(a1ToCell('$B3'), 5, 7);
  eq(r.row, 7, 'relative row moves');
  eq(r.col, 1, 'absolute column stays');
});

test('offsetRef keeps the $ flags on the result', () => {
  const r = offsetRef(a1ToCell('$B3'), 1, 0);
  eq(absFlags(r), { absRow: false, absCol: true });
});

test('offsetRef: negative row goes out of bounds', () => {
  eq(offsetRef(a1ToCell('A1'), -1, 0).oob, true);
});

test('offsetRef: negative column goes out of bounds', () => {
  eq(offsetRef(a1ToCell('A1'), 0, -1).oob, true);
});

test('offsetRef: past the last row goes out of bounds', () => {
  eq(offsetRef(a1ToCell('A' + MAX_ROWS), 1, 0).oob, true);
});

test('offsetRef: past the last column goes out of bounds', () => {
  eq(offsetRef(a1ToCell(colToLetter(MAX_COLS - 1) + '1'), 0, 1).oob, true);
});

test('offsetRef: a zero offset is the identity', () => {
  const r = offsetRef(a1ToCell('C7'), 0, 0);
  eq({ row: r.row, col: r.col }, { row: 6, col: 2 });
  eq(!!r.oob, false);
});

test('offsetRef: an absolute axis is not pushed out of bounds', () => {
  const r = offsetRef(a1ToCell('$A$1'), -5, -5);
  eq(!!r.oob, false);
  eq({ row: r.row, col: r.col }, { row: 0, col: 0 });
});

// --- shiftRefForStructuralEdit --------------------------------------------

test('shiftRef: insertRow before the ref pushes it down', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'insertRow', index: 2, count: 1 });
  eq(r.row, 5);
  eq(r.col, 1, 'column untouched by a row edit');
});

test('shiftRef: insertRow at the ref row pushes it down', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'insertRow', index: 4, count: 1 });
  eq(r.row, 5);
});

test('shiftRef: insertRow after the ref leaves it alone', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'insertRow', index: 10, count: 1 });
  eq(r.row, 4);
  eq(!!r.oob, false);
});

test('shiftRef: insertRow with count > 1', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'insertRow', index: 0, count: 3 });
  eq(r.row, 7);
});

test('shiftRef: structural edits move ABSOLUTE refs too', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('$B$5'), { kind: 'insertRow', index: 0, count: 1 });
  eq(r.row, 5);
  eq(absFlags(r), { absRow: true, absCol: true }, '$ flags survive the shift');
});

test('shiftRef: deleteRow containing the ref yields oob', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'deleteRow', index: 4, count: 1 });
  eq(r.oob, true);
});

test('shiftRef: deleteRow band containing the ref yields oob', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'deleteRow', index: 3, count: 3 });
  eq(r.oob, true);
});

test('shiftRef: deleteRow before the ref pulls it up', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'deleteRow', index: 1, count: 2 });
  eq(r.row, 2);
  eq(r.col, 1);
});

test('shiftRef: deleteRow after the ref leaves it alone', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'deleteRow', index: 10, count: 1 });
  eq(r.row, 4);
  eq(!!r.oob, false);
});

test('shiftRef: deleteRow just below the ref leaves it alone', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('B5'), { kind: 'deleteRow', index: 5, count: 1 });
  eq(r.row, 4);
});

test('shiftRef: deleteRow of the first row hits a ref living there', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('A1'), { kind: 'deleteRow', index: 0, count: 1 });
  eq(r.oob, true);
});

test('shiftRef: insertCol before the ref pushes it right', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('C1'), { kind: 'insertCol', index: 0, count: 2 });
  eq(r.col, 4);
  eq(r.row, 0, 'row untouched by a column edit');
});

test('shiftRef: insertCol after the ref leaves it alone', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('C1'), { kind: 'insertCol', index: 5, count: 1 });
  eq(r.col, 2);
});

test('shiftRef: deleteCol containing the ref yields oob', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('C1'), { kind: 'deleteCol', index: 2, count: 1 });
  eq(r.oob, true);
});

test('shiftRef: deleteCol before the ref pulls it left', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('C1'), { kind: 'deleteCol', index: 0, count: 2 });
  eq(r.col, 0);
  eq(!!r.oob, false);
});

test('shiftRef: deleteCol moves an absolute column ref as well', () => {
  const r = shiftRefForStructuralEdit(a1ToCell('$C$1'), { kind: 'deleteCol', index: 0, count: 1 });
  eq(r.col, 1);
});
