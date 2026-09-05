// test/engine.test.js — SheetEngine: value coercion, dependency graph, recalc, structural edits
// and serialization (SPEC section 9).
import { test, eq } from './run.js';
import { ERR } from '../shared/formula/errors.js';
import { SheetEngine } from '../shared/formula/engine.js';

// --- helpers ---------------------------------------------------------------

/** FormulaError -> its code string; anything else passes through untouched. */
function code(v) {
  return v && typeof v === 'object' && typeof v.code === 'string' ? v.code : v;
}

/** A fresh default-sized engine, optionally preloaded with raw inputs. */
function eng(inputs) {
  const e = new SheetEngine();
  if (inputs) e.setInputs(inputs);
  return e;
}

/** getValue with "empty" normalised to null, since an unset cell is blank either way. */
function val(e, a1) {
  const x = e.getValue(a1);
  return x === undefined ? null : x;
}

// --- constructor -----------------------------------------------------------

test('engine: default size', () => {
  const e = new SheetEngine();
  eq(e.rows, 200);
  eq(e.cols, 26);
});

test('engine: explicit size', () => {
  const e = new SheetEngine({ rows: 10, cols: 5 });
  eq(e.rows, 10);
  eq(e.cols, 5);
});

test('engine: constructor accepts preloaded cells', () => {
  const e = new SheetEngine({ rows: 10, cols: 5, cells: { A1: { input: '=1+1' } } });
  eq(e.getValue('A1'), 2);
});

// --- value coercion on write ----------------------------------------------

test('write: integers become numbers', () => {
  const e = eng({ A1: '42' });
  eq(e.getValue('A1'), 42);
  eq(typeof e.getValue('A1'), 'number');
});

test('write: decimals and negatives become numbers', () => {
  const e = eng({ A1: '3.5', A2: '-7' });
  eq(e.getValue('A1'), 3.5);
  eq(e.getValue('A2'), -7);
});

test('write: TRUE/FALSE become booleans', () => {
  const e = eng({ A1: 'TRUE', A2: 'FALSE' });
  eq(e.getValue('A1'), true);
  eq(e.getValue('A2'), false);
});

test('write: percents become fractions', () => {
  const e = eng({ A1: '50%', A2: '12.5%' });
  eq(e.getValue('A1'), 0.5);
  eq(e.getValue('A2'), 0.125);
});

test('write: an ISO date becomes a date serial', () => {
  const e = eng({ A1: '2024-01-15' });
  eq(e.getValue('A1'), 45306);
});

test('write: a leading apostrophe forces text', () => {
  const e = eng({ A1: "'0123" });
  eq(e.getValue('A1'), '0123');
});

test('write: a leading apostrophe keeps a number as text', () => {
  const e = eng({ A1: "'42" });
  eq(e.getValue('A1'), '42');
  eq(typeof e.getValue('A1'), 'string');
});

test('write: plain text stays text', () => {
  const e = eng({ A1: 'hello' });
  eq(e.getValue('A1'), 'hello');
});

test('write: null clears a cell', () => {
  const e = eng({ A1: '42' });
  e.setInput('A1', null);
  eq(val(e, 'A1'), null);
  eq(e.getInput('A1'), '');
});

test('write: the empty string clears a cell', () => {
  const e = eng({ A1: '42' });
  e.setInput('A1', '');
  eq(val(e, 'A1'), null);
});

test('write: getInput returns the raw text and "" for empty cells', () => {
  const e = eng({ A1: '=1+1', A2: 'hello' });
  eq(e.getInput('A1'), '=1+1');
  eq(e.getInput('A2'), 'hello');
  eq(e.getInput('C9'), '');
});

test('write: isFormula distinguishes formulas from literals', () => {
  const e = eng({ A1: '=1+1', A2: '42', A3: 'hello' });
  eq(e.isFormula('A1'), true);
  eq(e.isFormula('A2'), false);
  eq(e.isFormula('A3'), false);
  eq(e.isFormula('C9'), false);
});

test('write: a formula computes its value', () => {
  const e = eng({ A1: '=1+1' });
  eq(e.getValue('A1'), 2);
});

// --- dependency graph and recalc ------------------------------------------

test('deps: a chain A -> B -> C computes on load', () => {
  const e = eng({ A1: '1', B1: '=A1*2', C1: '=B1+3' });
  eq(e.getValue('B1'), 2);
  eq(e.getValue('C1'), 5);
});

test('deps: editing the head of a chain recalcs the tail', () => {
  const e = eng({ A1: '1', B1: '=A1*2', C1: '=B1+3' });
  e.setInput('A1', '10');
  eq(e.getValue('B1'), 20);
  eq(e.getValue('C1'), 23);
});

test('deps: setInput returns a Set of the changed keys', () => {
  const e = eng({ A1: '1', B1: '=A1*2', C1: '=B1+3', D1: '99' });
  const changed = e.setInput('A1', '10');
  eq(changed instanceof Set, true);
  eq(changed.has('A1'), true);
  eq(changed.has('B1'), true);
  eq(changed.has('C1'), true);
});

test('deps: the changed set leaves unrelated cells out', () => {
  const e = eng({ A1: '1', B1: '=A1*2', D1: '99' });
  const changed = e.setInput('A1', '10');
  eq(changed.has('D1'), false);
});

test('deps: the changed set includes a brand new cell', () => {
  const e = eng();
  const changed = e.setInput('F5', '7');
  eq(changed.has('F5'), true);
});

test('deps: the changed set includes a cleared cell', () => {
  const e = eng({ A1: '1' });
  const changed = e.setInput('A1', null);
  eq(changed.has('A1'), true);
});

test('deps: retargeting a formula drops its stale precedent', () => {
  const e = eng({ B1: '1', C1: '5', A1: '=B1' });
  eq(e.getValue('A1'), 1);
  e.setInput('A1', '=C1');
  eq(e.getValue('A1'), 5);
  const changed = e.setInput('B1', '9');
  eq(e.getValue('A1'), 5, 'the old precedent must no longer drive A1');
  eq(changed.has('A1'), false);
});

test('deps: a range formula follows edits inside the range', () => {
  const e = eng({ A1: '=SUM(B1:B10)', B1: '1' });
  eq(e.getValue('A1'), 1);
  e.setInput('B2', '2');
  eq(e.getValue('A1'), 3);
});

test('deps: a write into a previously BLANK cell inside a range invalidates it', () => {
  const e = eng({ A1: '=SUM(B1:B10)' });
  eq(e.getValue('A1'), 0);
  const changed = e.setInput('B5', '7');
  eq(e.getValue('A1'), 7, 'the range dependent must recalc');
  eq(changed.has('A1'), true, 'and be reported as changed');
});

test('deps: a whole-column range formula follows a blank-cell write', () => {
  const e = eng({ A1: '=COUNT(C1:C50)' });
  eq(e.getValue('A1'), 0);
  e.setInput('C20', '5');
  eq(e.getValue('A1'), 1);
});

test('deps: clearing a cell inside a range invalidates the dependent', () => {
  const e = eng({ A1: '=SUM(B1:B10)', B3: '4' });
  eq(e.getValue('A1'), 4);
  e.setInput('B3', null);
  eq(e.getValue('A1'), 0);
});

test('deps: setInputs applies a batch regardless of key order', () => {
  const e = eng();
  const changed = e.setInputs({ B1: '=A1+1', A1: '1' });
  eq(e.getValue('B1'), 2);
  eq(changed.has('A1'), true);
  eq(changed.has('B1'), true);
});

test('deps: a diamond dependency recalcs once and correctly', () => {
  const e = eng({ A1: '2', B1: '=A1*3', C1: '=A1*5', D1: '=B1+C1' });
  eq(e.getValue('D1'), 16);
  e.setInput('A1', '4');
  eq(e.getValue('D1'), 32);
});

test('deps: a blank precedent evaluates to null, not ""', () => {
  const e = eng({ A1: '=ISBLANK(B1)', A2: '=B1+1', A3: '=B1&"x"' });
  eq(e.getValue('A1'), true);
  eq(e.getValue('A2'), 1);
  eq(e.getValue('A3'), 'x');
});

// --- circular references ---------------------------------------------------

test('cycle: a two-cell cycle is #CYCLE! on both cells', () => {
  const e = eng({ A1: '=B1', B1: '=A1' });
  eq(code(e.getValue('A1')), ERR.CYCLE);
  eq(code(e.getValue('B1')), ERR.CYCLE);
});

test('cycle: a self reference is #CYCLE!', () => {
  const e = eng({ A1: '=A1+1' });
  eq(code(e.getValue('A1')), ERR.CYCLE);
});

test('cycle: a three-cell cycle marks every member', () => {
  const e = eng({ A1: '=B1', B1: '=C1', C1: '=A1' });
  eq(code(e.getValue('A1')), ERR.CYCLE);
  eq(code(e.getValue('B1')), ERR.CYCLE);
  eq(code(e.getValue('C1')), ERR.CYCLE);
});

test('cycle: a cycle closed by a later edit is still detected', () => {
  const e = eng({ A1: '=B1' });
  eq(code(e.getValue('A1')) === ERR.CYCLE, false, 'no cycle yet');
  e.setInput('B1', '=A1');
  eq(code(e.getValue('A1')), ERR.CYCLE);
  eq(code(e.getValue('B1')), ERR.CYCLE);
});

test('cycle: breaking the cycle restores real values', () => {
  const e = eng({ A1: '=B1', B1: '=A1' });
  eq(code(e.getValue('A1')), ERR.CYCLE);
  e.setInput('B1', '5');
  eq(e.getValue('B1'), 5);
  eq(e.getValue('A1'), 5);
});

test('cycle: a cycle through a range is detected', () => {
  const e = eng({ A1: '=SUM(B1:B3)', B2: '=A1' });
  eq(code(e.getValue('A1')), ERR.CYCLE);
  eq(code(e.getValue('B2')), ERR.CYCLE);
});

// --- error values and propagation -----------------------------------------

test('errors: #DIV/0! is stored as a value', () => {
  const e = eng({ A1: '=1/0' });
  eq(code(e.getValue('A1')), ERR.DIV0);
});

test('errors: #DIV/0! propagates to a dependent', () => {
  const e = eng({ A1: '=1/0', B1: '=A1+1' });
  eq(code(e.getValue('B1')), ERR.DIV0);
});

test('errors: propagation reaches two levels down', () => {
  const e = eng({ A1: '=1/0', B1: '=A1+1', C1: '=B1*2' });
  eq(code(e.getValue('C1')), ERR.DIV0);
});

test('errors: fixing the source clears the dependents', () => {
  const e = eng({ A1: '=1/0', B1: '=A1+1' });
  eq(code(e.getValue('B1')), ERR.DIV0);
  e.setInput('A1', '=1/1');
  eq(e.getValue('A1'), 1);
  eq(e.getValue('B1'), 2);
});

test('errors: a division by a blank cell is #DIV/0!', () => {
  const e = eng({ A1: '=1/B1' });
  eq(code(e.getValue('A1')), ERR.DIV0);
});

test('errors: a parse failure is stored as #ERROR!', () => {
  const e = eng({ A1: '=1+' });
  eq(code(e.getValue('A1')), ERR.PARSE);
});

test('errors: an unclosed call is #ERROR!', () => {
  const e = eng({ A1: '=SUM(' });
  eq(code(e.getValue('A1')), ERR.PARSE);
});

test('errors: an unknown function is #NAME?', () => {
  const e = eng({ A1: '=NOSUCHFUNCTION(1)' });
  eq(code(e.getValue('A1')), ERR.NAME);
});

test('errors: IFERROR can absorb a broken precedent', () => {
  const e = eng({ A1: '=1/0', B1: '=IFERROR(A1,"안전")' });
  eq(e.getValue('B1'), '안전');
});

// --- volatile recalculation ------------------------------------------------

test('volatile: an INDIRECT cell picks up a target it never statically referenced', () => {
  const e = eng({ B1: '1', A1: '=INDIRECT("B1")' });
  eq(e.getValue('A1'), 1);
  e.setInput('B1', '2');
  eq(e.getValue('A1'), 2, 'volatile cells recalc on every pass');
});

test('volatile: an OFFSET cell recalcs after an unrelated edit', () => {
  const e = eng({ B1: '1', A1: '=OFFSET(B1,0,0)' });
  eq(e.getValue('A1'), 1);
  e.setInput('B1', '3');
  e.setInput('J9', 'unrelated');
  eq(e.getValue('A1'), 3);
});

test('volatile: RAND stays in range across recalcs', () => {
  const e = eng({ A1: '=RAND()' });
  for (let i = 0; i < 3; i++) {
    e.recalcAll();
    const r = e.getValue('A1');
    eq(typeof r, 'number');
    eq(r >= 0 && r < 1, true);
  }
});

test('recalcAll: a static sheet keeps its values', () => {
  const e = eng({ A1: '2', B1: '=A1*3', C1: '=B1+1' });
  e.recalcAll();
  eq(e.getValue('B1'), 6);
  eq(e.getValue('C1'), 7);
  e.recalcAll();
  eq(e.getValue('C1'), 7);
});

// --- structural edits ------------------------------------------------------

test('struct: insertRow moves plain values down', () => {
  const e = eng({ A1: 'top', A3: '7' });
  e.applyStructuralEdit({ kind: 'insertRow', index: 1, count: 1 });
  eq(e.getValue('A1'), 'top', 'rows above the insert stay put');
  eq(e.getValue('A4'), 7);
  eq(val(e, 'A3'), null);
});

test('struct: insertRow rewrites a formula that points below it', () => {
  const e = eng({ A1: '=B5', B5: '42' });
  eq(e.getValue('A1'), 42);
  e.applyStructuralEdit({ kind: 'insertRow', index: 2, count: 1 });
  eq(e.getInput('A1'), '=B6');
  eq(e.getValue('B6'), 42);
  eq(e.getValue('A1'), 42);
  eq(val(e, 'B5'), null);
});

test('struct: insertRow returns a snapshot of the new state', () => {
  const e = eng({ A1: '=B5', B5: '42' });
  const snap = e.applyStructuralEdit({ kind: 'insertRow', index: 2, count: 1 });
  eq(typeof snap.rows, 'number');
  eq(typeof snap.cols, 'number');
  eq(snap.cells.A1.input, '=B6');
  eq(snap.cells.B6.input, '42');
});

test('struct: insertRow stretches a range that spans the insert point', () => {
  const e = eng({ B1: '1', B2: '2', B3: '3', A10: '=SUM(B1:B3)' });
  eq(e.getValue('A10'), 6);
  e.applyStructuralEdit({ kind: 'insertRow', index: 1, count: 1 });
  eq(e.getInput('A11'), '=SUM(B1:B4)');
  eq(e.getValue('A11'), 6);
});

test('struct: insertRow with count > 1', () => {
  const e = eng({ A1: '=B5', B5: '42' });
  e.applyStructuralEdit({ kind: 'insertRow', index: 0, count: 3 });
  eq(e.getInput('A4'), '=B8');
  eq(e.getValue('A4'), 42);
});

test('struct: deleteRow of a referenced cell yields #REF!', () => {
  const e = eng({ A1: '=B5', B5: '42' });
  e.applyStructuralEdit({ kind: 'deleteRow', index: 4, count: 1 });
  eq(code(e.getValue('A1')), ERR.REF);
  eq(e.getInput('A1').indexOf('#REF!') >= 0, true, 'the stored formula is rewritten too');
});

test('struct: deleteRow above a reference pulls it up', () => {
  const e = eng({ A1: '=B5', B5: '42' });
  e.applyStructuralEdit({ kind: 'deleteRow', index: 1, count: 1 });
  eq(e.getInput('A1'), '=B4');
  eq(e.getValue('A1'), 42);
});

test('struct: deleteRow removes the deleted row contents', () => {
  const e = eng({ A2: 'gone', A3: 'kept' });
  e.applyStructuralEdit({ kind: 'deleteRow', index: 1, count: 1 });
  eq(e.getValue('A2'), 'kept');
  eq(val(e, 'A3'), null);
});

test('struct: insertCol moves plain values right', () => {
  const e = eng({ C3: '7' });
  e.applyStructuralEdit({ kind: 'insertCol', index: 0, count: 1 });
  eq(e.getValue('D3'), 7);
  eq(val(e, 'C3'), null);
});

test('struct: insertCol rewrites a formula that points right of it', () => {
  const e = eng({ A1: '=C3', C3: '7' });
  e.applyStructuralEdit({ kind: 'insertCol', index: 1, count: 1 });
  eq(e.getInput('A1'), '=D3');
  eq(e.getValue('A1'), 7);
});

test('struct: deleteCol of a referenced cell yields #REF!', () => {
  const e = eng({ A1: '=C3', C3: '7' });
  e.applyStructuralEdit({ kind: 'deleteCol', index: 2, count: 1 });
  eq(code(e.getValue('A1')), ERR.REF);
});

test('struct: deleteCol left of a reference pulls it left', () => {
  const e = eng({ A1: '5', D1: '=C2', C2: '9' });
  e.applyStructuralEdit({ kind: 'deleteCol', index: 1, count: 1 });
  eq(e.getInput('C1'), '=B2');
  eq(e.getValue('C1'), 9);
});

test('struct: absolute references are shifted as well', () => {
  const e = eng({ A1: '=$B$5', B5: '42' });
  e.applyStructuralEdit({ kind: 'insertRow', index: 0, count: 1 });
  eq(e.getInput('A2'), '=$B$6');
  eq(e.getValue('A2'), 42);
});

test('struct: values keep recalculating after the edit', () => {
  const e = eng({ A1: '=B5*2', B5: '21' });
  e.applyStructuralEdit({ kind: 'insertRow', index: 2, count: 1 });
  eq(e.getValue('A1'), 42);
  e.setInput('B6', '5');
  eq(e.getValue('A1'), 10);
});

// --- bulkLoad / toJSON -----------------------------------------------------

const DOC_CELLS = {
  A1: { input: '1' },
  A2: { input: '2' },
  A3: { input: '=SUM(A1:A2)' },
  B1: { input: 'hi', style: { b: 1 } },
};

test('bulkLoad: formulas are computed on load', () => {
  const e = new SheetEngine();
  e.bulkLoad(DOC_CELLS);
  eq(e.getValue('A1'), 1);
  eq(e.getValue('A3'), 3);
  eq(e.getValue('B1'), 'hi');
});

test('bulkLoad: replaces everything that was there before', () => {
  const e = eng({ D4: '99' });
  eq(e.getValue('D4'), 99);
  e.bulkLoad({ A1: { input: '5' } });
  eq(e.getValue('A1'), 5);
  eq(val(e, 'D4'), null);
  eq(e.getInput('D4'), '');
});

test('toJSON: shape and contents', () => {
  const e = new SheetEngine();
  e.bulkLoad(DOC_CELLS);
  const json = e.toJSON();
  eq(json.rows, e.rows);
  eq(json.cols, e.cols);
  eq(json.cells.A1.input, '1');
  eq(json.cells.A3.input, '=SUM(A1:A2)');
  eq(json.cells.B1.input, 'hi');
  eq(json.cells.B1.style.b, 1);
  eq(Object.keys(json.cells).length, 4);
});

test('toJSON: cleared cells leave no entry behind', () => {
  const e = eng({ A1: '1', A2: '2' });
  e.setInput('A1', null);
  const json = e.toJSON();
  eq(Object.prototype.hasOwnProperty.call(json.cells, 'A1'), false);
  eq(json.cells.A2.input, '2');
});

test('round-trip: bulkLoad(toJSON().cells) reproduces the sheet', () => {
  const a = new SheetEngine();
  a.bulkLoad(DOC_CELLS);
  const json = a.toJSON();

  const b = new SheetEngine();
  b.bulkLoad(json.cells);
  eq(b.getValue('A3'), 3);
  eq(b.getInput('A3'), '=SUM(A1:A2)');
  eq(b.getStyle('B1').b, 1);
  eq(b.toJSON().cells, json.cells, 'a second round-trip is stable');
});

test('round-trip: the constructor accepts a toJSON() payload', () => {
  const a = new SheetEngine({ rows: 30, cols: 12 });
  a.bulkLoad(DOC_CELLS);
  const json = a.toJSON();
  const b = new SheetEngine({ rows: json.rows, cols: json.cols, cells: json.cells });
  eq(b.rows, 30);
  eq(b.cols, 12);
  eq(b.getValue('A3'), 3);
});

test('round-trip: a structural snapshot can be loaded back', () => {
  const a = eng({ A1: '=B5', B5: '42' });
  const snap = a.applyStructuralEdit({ kind: 'insertRow', index: 2, count: 1 });
  const b = new SheetEngine({ rows: snap.rows, cols: snap.cols, cells: snap.cells });
  eq(b.getValue('A1'), 42);
  eq(b.getInput('A1'), '=B6');
});

// --- getValues / styles ----------------------------------------------------

test('getValues: reports every non-empty cell', () => {
  const e = eng({ A1: '1', A2: '=A1+1', B1: 'text' });
  const vals = e.getValues();
  eq(vals.A1, 1);
  eq(vals.A2, 2);
  eq(vals.B1, 'text');
  eq(Object.prototype.hasOwnProperty.call(vals, 'C3'), false);
});

test('getValues: error cells are reported as FormulaError values', () => {
  const e = eng({ A1: '=1/0' });
  eq(code(e.getValues().A1), ERR.DIV0);
});

test('style: setStyle stores and getStyle reads back', () => {
  const e = eng();
  e.setStyle('A1', { b: 1, fg: '#ff0000' });
  eq(e.getStyle('A1').b, 1);
  eq(e.getStyle('A1').fg, '#ff0000');
});

test('style: setStyle merges shallowly', () => {
  const e = eng();
  e.setStyle('A1', { b: 1, fg: '#ff0000' });
  e.setStyle('A1', { i: 1 });
  eq(e.getStyle('A1').b, 1, 'existing keys survive');
  eq(e.getStyle('A1').i, 1);
});

test('style: a null property value deletes that key', () => {
  const e = eng();
  e.setStyle('A1', { b: 1, fg: '#ff0000' });
  e.setStyle('A1', { b: null });
  eq(e.getStyle('A1').b, undefined);
  eq(e.getStyle('A1').fg, '#ff0000', 'the other keys are untouched');
});

test('style: styling a cell does not disturb its value', () => {
  const e = eng({ A1: '=1+1' });
  e.setStyle('A1', { b: 1 });
  eq(e.getValue('A1'), 2);
  eq(e.getInput('A1'), '=1+1');
});
