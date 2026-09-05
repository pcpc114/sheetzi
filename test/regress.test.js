// test/regress.test.js — pinned regressions.
//
// Every case here failed at some point during development. They are kept separate from
// the behavioural suites so the reason each one exists stays visible: a bare assertion
// that `=SUM(A:A)` survives a row insert says nothing, but the comment above it explains
// why that once produced #REF! and must never do so again.

import { test, eq } from './run.js';
import { SheetEngine } from '../shared/formula/engine.js';
import { parse, serialize, mapRefs } from '../shared/formula/parser.js';
import { shiftRefForStructuralEdit, MAX_ROWS } from '../shared/formula/refs.js';
import { sanitizeDoc, emptyDoc } from '../shared/model.js';

// ---------------------------------------------------------------------------
// Whole-column / whole-row ranges under structural edits.
//
// A range like A:A stores sentinel coordinates on its spanning axis (rows 0..MAX_ROWS-1).
// mapRefs used to hand those sentinels to the ref transform like ordinary coordinates, so
// inserting a row pushed the end sentinel to MAX_ROWS (reported out of bounds) and deleting
// row 0 put the start sentinel inside the deleted band — either way the formula collapsed
// to #REF!. When it did survive, the shifted sentinel disagreed with the 'A:A' text that
// serialize() re-emits, so the cell's stored input and its cached AST drifted apart and
// dependency tracking silently stopped following writes into the range.
// ---------------------------------------------------------------------------

test('whole-column range survives a row insert above it', () => {
  const e = new SheetEngine({ rows: 200, cols: 26 });
  e.setInput('A1', '5');
  e.setInput('A2', '7');
  e.setInput('C1', '=SUM(A:A)');
  eq(e.getValue('C1'), 12, 'precondition');

  e.applyStructuralEdit({ kind: 'insertRow', index: 0, count: 1 });
  eq(e.getInput('C2'), '=SUM(A:A)', 'the formula text must be unchanged');
  eq(e.getValue('C2'), 12, 'and it must still compute');
});

test('whole-column range keeps tracking writes after a row insert', () => {
  const e = new SheetEngine({ rows: 200, cols: 26 });
  e.setInput('A1', '5');
  e.setInput('A2', '7');
  e.setInput('C1', '=SUM(A:A)');
  e.applyStructuralEdit({ kind: 'insertRow', index: 0, count: 1 });

  // The AST used to keep a range starting at row 1, so a write into row 0 fell outside
  // it and the dependent never recalculated.
  const changed = e.setInput('A1', '100');
  eq(changed.has('C2'), true, 'the dependent must be in the changed set');
  eq(e.getValue('C2'), 112, '100 + 5 + 7');
});

test('whole-column range survives deleting a row it spans', () => {
  const e = new SheetEngine({ rows: 200, cols: 26 });
  e.setInput('A2', '5');
  e.setInput('A3', '7');
  e.setInput('C5', '=SUM(A:A)');
  eq(e.getValue('C5'), 12, 'precondition');

  e.applyStructuralEdit({ kind: 'deleteRow', index: 0, count: 1 });
  eq(e.getInput('C4'), '=SUM(A:A)', 'deleting row 0 must not produce #REF!');
  eq(e.getValue('C4'), 12, 'the surviving values still sum');
});

test('whole-column range is rewritten by a column insert', () => {
  const e = new SheetEngine({ rows: 200, cols: 26 });
  e.setInput('A1', '5');
  e.setInput('C1', '=SUM(A:A)');
  e.applyStructuralEdit({ kind: 'insertCol', index: 0, count: 1 });
  eq(e.getInput('D1'), '=SUM(B:B)', 'the column reference must follow the shift');
  eq(e.getValue('D1'), 5, 'and still compute');
});

test('whole-column range becomes #REF! only when its column is deleted', () => {
  const e = new SheetEngine({ rows: 200, cols: 26 });
  e.setInput('A1', '5');
  e.setInput('C1', '=SUM(A:A)');
  e.applyStructuralEdit({ kind: 'deleteCol', index: 0, count: 1 });
  eq(String(e.getValue('B1')), '#REF!', 'the referenced column is gone');
});

test('whole-row range survives a column insert', () => {
  const e = new SheetEngine({ rows: 200, cols: 26 });
  e.setInput('B1', '4');
  e.setInput('C1', '6');
  e.setInput('A5', '=SUM(1:1)');
  eq(e.getValue('A5'), 10, 'precondition');

  e.applyStructuralEdit({ kind: 'insertCol', index: 0, count: 1 });
  eq(e.getInput('B5'), '=SUM(1:1)', 'the row span must be unchanged');
  eq(e.getValue('B5'), 10, 'and still compute');
});

test('mapRefs leaves the span sentinels of a whole-column node intact', () => {
  const ast = parse('SUM(A:A)');
  const shifted = mapRefs(ast, (ref) =>
    shiftRefForStructuralEdit(ref, { kind: 'insertRow', index: 0, count: 1 }));
  eq(serialize(shifted), 'SUM(A:A)', 'text round-trips');
  const range = shifted.args[0];
  eq(range.type, 'range', 'still a range, not #REF!');
  eq(range.s.row, 0, 'start sentinel pinned to the first row');
  eq(range.e.row, MAX_ROWS - 1, 'end sentinel pinned to the last row');
});

// ---------------------------------------------------------------------------
// Inserting after the last row/column.
//
// "아래에 행 삽입" on the final row sends index === rows, one past the end. The server
// clamped that to rows-1, which inserts BEFORE the last row instead and pushes the last
// row's contents to index `rows`, where sanitizeDoc drops them — silent data loss.
// The engine must accept the one-past-the-end index.
// ---------------------------------------------------------------------------

test('inserting a row one past the last row keeps the last row intact', () => {
  const e = new SheetEngine({ rows: 5, cols: 3 });
  e.setInput('A5', '마지막');
  e.applyStructuralEdit({ kind: 'insertRow', index: 5, count: 1 });
  eq(e.getValue('A5'), '마지막', 'the final row must not move or vanish');
});

test('inserting a column one past the last column keeps it intact', () => {
  const e = new SheetEngine({ rows: 5, cols: 3 });
  e.setInput('C1', '끝열');
  e.applyStructuralEdit({ kind: 'insertCol', index: 3, count: 1 });
  eq(e.getValue('C1'), '끝열', 'the final column must not move or vanish');
});

// ---------------------------------------------------------------------------
// sanitizeDoc must repair rather than throw, and must not silently keep values the
// server would reject — the broadcast path now replays what was stored, so whatever
// sanitizeDoc decides is what every client sees.
// ---------------------------------------------------------------------------

test('sanitizeDoc repairs a hostile document instead of throwing', () => {
  const doc = sanitizeDoc({
    id: '../../etc/passwd',
    name: 42,
    rows: 9e9,
    cols: -3,
    cells: {
      A1: { input: 'ok' },
      'not a ref': { input: 'dropped' },
      ZZZZ99999: { input: 'out of sheet' },
      B2: 'not an object',
    },
    colWidths: { 0: 99999, 1: 'wide' },
    rowHeights: { 0: -5 },
    frozenRows: 'many',
    extraneous: true,
  });
  // The hostile input above is in the LEGACY (pre-sheets) shape, so this doubles as a
  // migration test: it must come back as a document with exactly one sheet.
  const sheet = doc.sheets[0];
  eq(typeof doc.id, 'string', 'a valid id is generated');
  eq(/^[a-z0-9]{6,24}$/.test(doc.id), true, 'and it is path-safe');
  eq(Array.isArray(doc.sheets) && doc.sheets.length === 1, true, 'migrated to exactly one sheet');
  eq(sheet.rows <= 5000 && sheet.rows >= 1, true, 'rows clamped');
  eq(sheet.cols <= 702 && sheet.cols >= 1, true, 'cols clamped');
  eq(sheet.cells.A1.input, 'ok', 'the valid cell survives');
  eq('not a ref' in sheet.cells, false, 'a malformed key is dropped');
  eq('extraneous' in doc, false, 'unknown top-level keys are dropped');
  eq(doc.cells, undefined, 'no stray top-level cells are left behind');
  eq(Number.isFinite(sheet.frozenRows), true, 'frozenRows coerced to a number');
});

test('sanitizeDoc round-trips a document it produced', () => {
  const first = emptyDoc('abc123def456', '테스트');
  first.sheets[0].cells.A1 = { input: '=1+1' };
  first.sheets[0].cells.B2 = { input: '값', style: { b: 1, align: 'center' } };
  const second = sanitizeDoc(JSON.parse(JSON.stringify(first)));
  eq(second.sheets[0].cells.A1.input, '=1+1', 'formula preserved');
  eq(second.sheets[0].cells.B2.style.b, 1, 'style preserved');
  eq(second.name, '테스트', 'name preserved');
  eq(second.sheets.length, 1, 'sheet count unchanged');
  eq(second.sheets[0].id, first.sheets[0].id, 'the sheet id is stable across a round trip');

  // Idempotence: sanitizing an already-migrated document must not re-wrap it.
  const third = sanitizeDoc(JSON.parse(JSON.stringify(second)));
  eq(third.sheets.length, 1, 'a v2 document is not re-migrated');
  eq(third.sheets[0].cells.A1.input, '=1+1', 'and keeps its cells');
});

// ---------------------------------------------------------------------------
// A cell whose formula references a cell that is itself blank must evaluate to 0, not
// "", and must recalculate when that blank cell is later filled — the range-dependency
// path that is easiest to get wrong.
// ---------------------------------------------------------------------------

test('a formula over a range picks up a first write into a blank cell in it', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('D1', '=SUM(A1:A10)');
  eq(e.getValue('D1'), 0, 'an empty range sums to 0');
  const changed = e.setInput('A7', '3');
  eq(changed.has('D1'), true, 'the dependent must be invalidated');
  eq(e.getValue('D1'), 3, 'and recomputed');
});
