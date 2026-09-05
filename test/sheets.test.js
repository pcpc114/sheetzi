// test/sheets.test.js — the multi-sheet document model (SPEC section 10) and the
// cross-sheet reference seam (SPEC section 16).
//
// Two things are under test here and nothing else:
//
//   1. shared/model.js — sanitizeDoc's v1 -> v2 migration plus the six pure sheet
//      helpers. "Pure" is asserted literally: every case that calls a helper also
//      compares a JSON snapshot of the input document taken before the call.
//   2. The cross-sheet seam — parse / serialize / collectRefs / mapRefs carrying a
//      `sheet` qualifier, and a SheetEngine reporting an unresolvable one as a #REF!
//      that explains itself in Korean.
//
// Only what SPEC.md guarantees is asserted; nothing here reaches into a private field.

import { test, eq } from './run.js';

import {
  MAX_SHEETS,
  DEFAULT_SHEET_NAME,
  DEFAULT_ROWS,
  DEFAULT_COLS,
  emptyDoc,
  emptySheet,
  sanitizeDoc,
  findSheet,
  sheetIndex,
  uniqueSheetName,
  addSheet,
  renameSheet,
  deleteSheet,
  reorderSheet,
  duplicateSheet,
  setSheetColor,
} from '../shared/model.js';

import { parse, serialize, collectRefs, mapRefs } from '../shared/formula/parser.js';
import {
  splitSheetRef,
  quoteSheetName,
  isBareSheetName,
  a1ToCell,
  parseRange,
  cellToA1,
  shiftRefForStructuralEdit,
} from '../shared/formula/refs.js';
import { SheetEngine } from '../shared/formula/engine.js';
import { RangeValue } from '../shared/formula/values.js';
import { ERR, isError } from '../shared/formula/errors.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A deep, order-preserving snapshot used to prove a helper did not mutate its input. */
function snapshot(doc) {
  return JSON.stringify(doc);
}

/**
 * Run `fn(doc)` and assert the document it was given is byte-for-byte unchanged
 * afterwards. Returns whatever `fn` returned so a case can keep asserting on it.
 */
function pure(doc, fn, label) {
  const before = snapshot(doc);
  const out = fn(doc);
  eq(snapshot(doc), before, (label || 'helper') + ' must not mutate its input document');
  return out;
}

/** The tab order as a list of names — the shape most reorder/delete cases compare. */
function names(doc) {
  return doc.sheets.map((s) => s.name);
}

/** A document with `count` sheets, named 'S0', 'S1', ... in tab order. */
function docWith(count) {
  let doc = sanitizeDoc({
    id: 'aaaaaa111111',
    name: '테스트 문서',
    sheets: [{ id: 'sh0000', name: 'S0' }],
    createdAt: 1730000000000,
    updatedAt: 1730000000000,
    rev: 0,
  });
  for (let i = 1; i < count; i++) doc = addSheet(doc, { name: 'S' + i }).doc;
  return doc;
}

/** A single-sheet document with content in every sheet field, for duplicate/migrate cases. */
function richDoc() {
  return sanitizeDoc({
    id: 'bbbbbb222222',
    name: '원본 문서',
    sheets: [
      {
        id: 'sh0001',
        name: '원본',
        color: '#ff8800',
        rows: 100,
        cols: 20,
        cells: {
          A1: { input: '1', style: { b: 1, fg: '#123456' } },
          B2: { input: '=A1+1' },
          C3: { style: { align: 'center' } },
        },
        colWidths: { 2: 160 },
        rowHeights: { 3: 40 },
        frozenRows: 2,
        frozenCols: 1,
      },
    ],
    createdAt: 1730000000000,
    updatedAt: 1730000000500,
    rev: 12,
  });
}

/** A v1 document: one sheet stored inline on the document itself. */
function legacyDoc() {
  return {
    id: 'abcdef123456',
    name: '매출 보고서',
    rows: 120,
    cols: 12,
    cells: {
      A1: { input: '1' },
      B2: { input: '=A1+1', style: { b: 1 } },
    },
    colWidths: { 2: 160 },
    rowHeights: { 5: 40 },
    frozenRows: 1,
    frozenCols: 2,
    createdAt: 1730000000000,
    updatedAt: 1730000000001,
    rev: 7,
  };
}

/** True when `fn()` throws a TypeError. */
function throwsTypeError(fn) {
  try {
    fn();
  } catch (e) {
    return e instanceof TypeError;
  }
  return false;
}

/** True when `fn()` throws a RangeError. */
function throwsRangeError(fn) {
  try {
    fn();
  } catch (e) {
    return e instanceof RangeError;
  }
  return false;
}

/**
 * A sheet-like value source for ctx.resolveSheet / SheetEngine({resolveSheet}).
 * SPEC 16.3: the source is read with the same getCell / getRangeValue shape as the
 * local sheet, so a plain object with those two methods is all a foreign sheet is.
 */
function sourceFrom(values) {
  const get = (row, col) => {
    const v = values[cellToA1(row, col)];
    return v === undefined ? null : v;
  };
  return {
    getCell: get,
    getRangeValue(range) {
      const r0 = Math.min(range.s.row, range.e.row);
      const r1 = Math.max(range.s.row, range.e.row);
      const c0 = Math.min(range.s.col, range.e.col);
      const c1 = Math.max(range.s.col, range.e.col);
      const rows = [];
      for (let r = r0; r <= r1; r++) {
        const line = [];
        for (let c = c0; c <= c1; c++) line.push(get(r, c));
        rows.push(line);
      }
      return new RangeValue(rows);
    },
  };
}

/** The Korean explanation SPEC 16.3 requires on an unresolvable cross-sheet reference. */
function unsupportedMessage(name) {
  return '다른 시트 참조는 아직 지원하지 않습니다: ' + name;
}

// ===========================================================================
// sanitizeDoc — legacy migration
// ===========================================================================

test('sanitizeDoc wraps a v1 document in exactly one sheet', () => {
  const doc = sanitizeDoc(legacyDoc());
  eq(Array.isArray(doc.sheets), true, 'sheets must be an array');
  eq(doc.sheets.length, 1, 'a v1 document holds exactly one sheet');
  eq(doc.sheets[0].name, DEFAULT_SHEET_NAME, 'the migrated sheet is named 시트1');
});

test('sanitizeDoc migration carries every v1 sheet field across', () => {
  const sheet = sanitizeDoc(legacyDoc()).sheets[0];
  eq(sheet.rows, 120, 'rows');
  eq(sheet.cols, 12, 'cols');
  eq(sheet.cells.A1, { input: '1' }, 'cells.A1');
  eq(sheet.cells.B2, { input: '=A1+1', style: { b: 1 } }, 'cells.B2 keeps its style');
  eq(sheet.colWidths, { 2: 160 }, 'colWidths');
  eq(sheet.rowHeights, { 5: 40 }, 'rowHeights');
  eq(sheet.frozenRows, 1, 'frozenRows');
  eq(sheet.frozenCols, 2, 'frozenCols');
  eq(sheet.color, null, 'a migrated sheet has no tab colour');
  eq(typeof sheet.id, 'string', 'the migrated sheet gets an id');
  eq(sheet.id.length > 0, true, 'and the id is not empty');
});

test('sanitizeDoc migration keeps the document-level fields', () => {
  const doc = sanitizeDoc(legacyDoc());
  eq(doc.id, 'abcdef123456', 'a valid id is reused');
  eq(doc.name, '매출 보고서', 'the document title is the document title, not the sheet name');
  eq(doc.createdAt, 1730000000000, 'createdAt');
  eq(doc.updatedAt, 1730000000001, 'updatedAt');
  eq(doc.rev, 7, 'rev');
});

test('sanitizeDoc migration drops the v1 top-level sheet fields', () => {
  const doc = sanitizeDoc(legacyDoc());
  eq(Object.keys(doc).sort(), ['createdAt', 'id', 'name', 'rev', 'sheets', 'updatedAt'],
    'the v2 document shape is exactly these keys');
});

test('sanitizeDoc migration is idempotent', () => {
  const once = sanitizeDoc(legacyDoc());
  const twice = sanitizeDoc(once);
  eq(twice, once, 'a second pass changes nothing at all — ids and names included');
});

test('sanitizeDoc migration is idempotent three passes deep', () => {
  const once = sanitizeDoc(legacyDoc());
  eq(sanitizeDoc(sanitizeDoc(sanitizeDoc(once))), once);
});

test('sanitizeDoc leaves a v2 document untouched', () => {
  const v2 = {
    id: 'cccccc333333',
    name: '문서',
    sheets: [
      {
        id: 'sh0001',
        name: '가',
        color: '#0000ff',
        rows: 200,
        cols: 26,
        cells: { A1: { input: '=1+1' } },
        colWidths: { 0: 200 },
        rowHeights: { 1: 30 },
        frozenRows: 1,
        frozenCols: 1,
      },
      {
        id: 'sh0002',
        name: '나',
        color: null,
        rows: 50,
        cols: 10,
        cells: {},
        colWidths: {},
        rowHeights: {},
        frozenRows: 0,
        frozenCols: 0,
      },
    ],
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    rev: 3,
  };
  // sanitizeDoc guarantees every sheet carries a merges array (SPEC 21.1), and likewise a
  // filter / charts / comments slot (SPEC 24), so that no consumer has to guard before
  // reading them. A v2 document written before those fields existed therefore comes back
  // with merges: [], filter: null, charts: [] and comments: {} added — that is the
  // contract, not drift.
  const out = sanitizeDoc(v2);
  eq(out.sheets.map((sheet) => sheet.merges), [[], []], 'every sheet gains an empty merge list');
  eq(out.sheets.map((sheet) => sheet.filter), [null, null], 'and an empty filter slot');
  eq(out.sheets.map((sheet) => sheet.charts), [[], []], 'and an empty chart list');
  eq(out.sheets.map((sheet) => sheet.comments), [{}, {}], 'and an empty comment map');
  const expected = {
    ...v2,
    sheets: v2.sheets.map((sheet) => ({ ...sheet, merges: [], filter: null, charts: [], comments: {} })),
  };
  eq(out, expected, 'nothing else about a well-formed v2 document changes');
});

test('sanitizeDoc never re-migrates a document that already has sheets', () => {
  // Legacy fields alongside a real sheets array: the sheets array wins outright.
  const doc = sanitizeDoc({
    id: 'dddddd444444',
    rows: 33,
    cols: 4,
    cells: { Z9: { input: '레거시' } },
    frozenRows: 3,
    sheets: [{ id: 'sh0001', name: 'S', rows: 200, cols: 26, cells: { A1: { input: '유지' } } }],
  });
  eq(doc.sheets.length, 1, 'no extra sheet is invented for the legacy fields');
  eq(Object.keys(doc.sheets[0].cells), ['A1'], 'the legacy cells are not merged in');
  eq(doc.sheets[0].cells.A1.input, '유지');
  eq(doc.sheets[0].rows, 200, 'the legacy rows count is ignored');
  eq(doc.sheets[0].frozenRows, 0, 'so is the legacy freeze');
});

test('sanitizeDoc yields one blank sheet for a document with no sheets at all', () => {
  const doc = sanitizeDoc({ id: 'eeeeee555555', name: '빈 문서' });
  eq(doc.sheets.length, 1);
  eq(doc.sheets[0].name, DEFAULT_SHEET_NAME);
  eq(doc.sheets[0].cells, {}, 'blank means no cells');
  eq(doc.sheets[0].rows, DEFAULT_ROWS);
  eq(doc.sheets[0].cols, DEFAULT_COLS);
  eq(doc.sheets[0].frozenRows, 0);
  eq(doc.sheets[0].frozenCols, 0);
  eq(doc.sheets[0].colWidths, {});
  eq(doc.sheets[0].rowHeights, {});
});

test('sanitizeDoc yields one blank sheet for an empty sheets array', () => {
  const doc = sanitizeDoc({ sheets: [] });
  eq(doc.sheets.length, 1);
  eq(doc.sheets[0].name, DEFAULT_SHEET_NAME);
  eq(doc.sheets[0].cells, {});
});

test('sanitizeDoc yields one blank sheet when sheets is not an array', () => {
  for (const bad of ['시트', 42, true, null, {}, { 0: { name: 'x' } }]) {
    const doc = sanitizeDoc({ sheets: bad });
    eq(doc.sheets.length, 1, 'sheets: ' + JSON.stringify(bad) + ' -> one sheet');
    eq(doc.sheets[0].name, DEFAULT_SHEET_NAME);
  }
});

test('sanitizeDoc keeps a document with only junk entries in sheets usable', () => {
  const doc = sanitizeDoc({ sheets: [null, 42, 'x', undefined, true] });
  eq(doc.sheets.length, 1, 'nothing usable survives, so one blank sheet is produced');
  eq(doc.sheets[0].name, DEFAULT_SHEET_NAME);
});

test('sanitizeDoc repairs a partially-corrupt document instead of throwing', () => {
  const doc = sanitizeDoc({
    id: 5,
    name: {},
    createdAt: '어제',
    updatedAt: NaN,
    rev: -3,
    sheets: [
      null,
      42,
      'x',
      { id: 'sh0001', name: 'A', rows: -5, cols: 'abc', cells: 'nope', colWidths: { q: 'x' }, rowHeights: 7, color: 'red', frozenRows: 'z', frozenCols: null },
      { id: 'sh0001', name: 'A' },
    ],
  });
  eq(doc.sheets.length >= 1, true, 'at least one sheet always survives');
  eq(typeof doc.id, 'string', 'a bad id is replaced');
  eq(/^[a-z0-9]{6,24}$/.test(doc.id), true, 'and the replacement is path-safe');
  eq(typeof doc.name, 'string', 'a bad name is replaced');
  eq(doc.name.length > 0, true);
  eq(doc.rev >= 0, true, 'a negative rev is clamped');
  eq(Number.isFinite(doc.createdAt) && doc.createdAt > 0, true, 'createdAt is a real timestamp');
  eq(Number.isFinite(doc.updatedAt) && doc.updatedAt > 0, true, 'updatedAt is a real timestamp');
  for (const s of doc.sheets) {
    eq(typeof s.id === 'string' && s.id.length > 0, true, 'every sheet has an id');
    eq(typeof s.name === 'string' && s.name.length > 0, true, 'every sheet has a name');
    eq(Number.isInteger(s.rows) && s.rows >= 1, true, 'rows is a positive integer');
    eq(Number.isInteger(s.cols) && s.cols >= 1, true, 'cols is a positive integer');
    eq(s.cells !== null && typeof s.cells === 'object', true, 'cells is an object');
    eq(s.colWidths !== null && typeof s.colWidths === 'object', true, 'colWidths is an object');
    eq(s.rowHeights !== null && typeof s.rowHeights === 'object', true, 'rowHeights is an object');
    eq(s.color, null, 'an unparseable tab colour becomes null');
    eq(Number.isInteger(s.frozenRows) && s.frozenRows >= 0, true, 'frozenRows');
    eq(Number.isInteger(s.frozenCols) && s.frozenCols >= 0, true, 'frozenCols');
  }
  eq(new Set(doc.sheets.map((s) => s.id)).size, doc.sheets.length, 'sheet ids are unique');
  eq(new Set(doc.sheets.map((s) => s.name)).size, doc.sheets.length, 'sheet names are unique');
});

test('sanitizeDoc never returns more than MAX_SHEETS sheets', () => {
  const doc = sanitizeDoc({ sheets: Array.from({ length: MAX_SHEETS + 12 }, (_, i) => ({ name: 'S' + i })) });
  eq(doc.sheets.length >= 1, true);
  eq(doc.sheets.length <= MAX_SHEETS, true, 'the document shape allows 1..MAX_SHEETS');
});

test('sanitizeDoc throws a TypeError for anything that is not an object', () => {
  for (const bad of [null, undefined, 0, 42, '', '문서', true, Symbol('x')]) {
    eq(throwsTypeError(() => sanitizeDoc(bad)), true, 'sanitizeDoc(' + String(bad) + ')');
  }
});

test('sanitizeDoc does not mutate the object it is given', () => {
  const v1 = legacyDoc();
  const before = snapshot(v1);
  sanitizeDoc(v1);
  eq(snapshot(v1), before, 'the caller keeps its own object');
});

test('emptyDoc produces a document sanitizeDoc accepts unchanged', () => {
  const doc = emptyDoc('ffffff666666', '새 문서');
  eq(doc.sheets.length, 1);
  eq(doc.sheets[0].name, DEFAULT_SHEET_NAME);
  eq(sanitizeDoc(doc), doc, 'a fresh document is already canonical');
});

test('emptySheet produces a blank sheet', () => {
  const sheet = emptySheet('sh0009', '가계부');
  eq(sheet.id, 'sh0009');
  eq(sheet.name, '가계부');
  eq(sheet.cells, {});
  eq(sheet.color, null);
  eq(sheet.rows, DEFAULT_ROWS);
  eq(sheet.cols, DEFAULT_COLS);
  eq(sheet.frozenRows, 0);
  eq(sheet.frozenCols, 0);
});

// ===========================================================================
// findSheet / sheetIndex
// ===========================================================================

test('findSheet returns the sheet with that id, or null', () => {
  const doc = docWith(3);
  eq(findSheet(doc, doc.sheets[1].id).name, 'S1');
  eq(findSheet(doc, '없는아이디'), null);
  eq(findSheet(doc, ''), null);
  eq(findSheet(doc, null), null);
  eq(findSheet(doc, undefined), null);
});

test('sheetIndex reports tab order and -1 when absent', () => {
  const doc = docWith(3);
  eq(sheetIndex(doc, doc.sheets[0].id), 0);
  eq(sheetIndex(doc, doc.sheets[2].id), 2);
  eq(sheetIndex(doc, '없는아이디'), -1);
  eq(sheetIndex(doc, null), -1);
});

// ===========================================================================
// uniqueSheetName
// ===========================================================================

test('uniqueSheetName returns a free name unchanged', () => {
  const doc = docWith(2);
  eq(pure(doc, (d) => uniqueSheetName(d, '매출'), 'uniqueSheetName'), '매출');
});

test('uniqueSheetName suffixes a colliding name with (2)', () => {
  const doc = docWith(2);
  eq(uniqueSheetName(doc, 'S0'), 'S0 (2)');
  eq(uniqueSheetName(doc, 'S1'), 'S1 (2)');
});

test('uniqueSheetName walks the suffix up past an existing (2)', () => {
  let doc = docWith(1);
  doc = addSheet(doc, { name: 'S0 (2)' }).doc;
  eq(uniqueSheetName(doc, 'S0'), 'S0 (3)');
  doc = addSheet(doc, { name: 'S0 (3)' }).doc;
  eq(uniqueSheetName(doc, 'S0'), 'S0 (4)');
});

test('uniqueSheetName collides case-insensitively', () => {
  const doc = docWith(1); // 'S0'
  eq(uniqueSheetName(doc, 's0') !== 's0', true, 'names differing only in case are the same name');
});

test('uniqueSheetName invents a name for an empty request', () => {
  const doc = docWith(1);
  const taken = new Set(names(doc));
  for (const wanted of ['', '   ', '\t', undefined, null, 42, {}]) {
    const name = uniqueSheetName(doc, wanted);
    eq(typeof name, 'string', 'always a string for ' + JSON.stringify(wanted));
    eq(name.length > 0, true, 'never empty');
    eq(taken.has(name), false, 'and never a name already in use');
  }
});

test('uniqueSheetName falls back to the 시트N family for a blank request', () => {
  const doc = docWith(1);
  eq(/^시트[0-9]+$/.test(uniqueSheetName(doc, '')), true, 'a blank name becomes 시트N');
});

test('uniqueSheetName caps a name at 100 characters', () => {
  const doc = docWith(1);
  eq(uniqueSheetName(doc, 'x'.repeat(150)).length, 100, 'a 150-char request is cut to 100');
  eq(uniqueSheetName(doc, 'x'.repeat(101)).length, 100);
  eq(uniqueSheetName(doc, 'x'.repeat(100)).length, 100, 'exactly 100 fits as-is');
});

test('uniqueSheetName keeps the 100-char cap while disambiguating', () => {
  const long = 'y'.repeat(100);
  const doc = addSheet(docWith(1), { name: long }).doc;
  const next = uniqueSheetName(doc, long);
  eq(next.length <= 100, true, 'the suffix must not push the name past the cap');
  eq(next === long, false, 'and it must differ from the name already in use');
});

test('uniqueSheetName does not read a document that has no sheets yet', () => {
  const name = uniqueSheetName({ id: 'x', name: 'y' }, '매출');
  eq(name, '매출', 'nothing is taken, so the wanted name is free');
});

// ===========================================================================
// addSheet
// ===========================================================================

test('addSheet appends to the end by default', () => {
  const doc = docWith(3);
  const res = pure(doc, (d) => addSheet(d, {}), 'addSheet');
  eq(res.doc.sheets.length, 4);
  eq(res.doc.sheets[3].id, res.sheet.id, 'the new sheet is last');
  eq(findSheet(res.doc, res.sheet.id).name, res.sheet.name, 'and it is findable by id');
});

test('addSheet inserts directly after afterId', () => {
  const doc = docWith(3);
  const res = addSheet(doc, { name: 'X', afterId: doc.sheets[0].id });
  eq(names(res.doc), ['S0', 'X', 'S1', 'S2']);
  eq(sheetIndex(res.doc, res.sheet.id), 1);
});

test('addSheet inserts after the middle sheet', () => {
  const doc = docWith(3);
  const res = addSheet(doc, { name: 'X', afterId: doc.sheets[1].id });
  eq(names(res.doc), ['S0', 'S1', 'X', 'S2']);
});

test('addSheet with afterId on the last sheet still appends', () => {
  const doc = docWith(3);
  const res = addSheet(doc, { name: 'X', afterId: doc.sheets[2].id });
  eq(names(res.doc), ['S0', 'S1', 'S2', 'X']);
});

test('addSheet appends when afterId names no sheet', () => {
  const doc = docWith(3);
  eq(names(addSheet(doc, { name: 'X', afterId: '없는아이디' }).doc), ['S0', 'S1', 'S2', 'X']);
  eq(names(addSheet(doc, { name: 'Y', afterId: null }).doc), ['S0', 'S1', 'S2', 'Y']);
});

test('addSheet honours a requested name and makes a colliding one unique', () => {
  const doc = docWith(2);
  eq(addSheet(doc, { name: '매출' }).sheet.name, '매출');
  const collide = addSheet(doc, { name: 'S0' });
  eq(collide.sheet.name === 'S0', false, 'the name is already in use');
  eq(new Set(names(collide.doc)).size, 3, 'so every name in the document stays unique');
});

test('addSheet gives the new sheet a blank body', () => {
  const sheet = addSheet(docWith(1), {}).sheet;
  eq(sheet.cells, {});
  eq(sheet.colWidths, {});
  eq(sheet.rowHeights, {});
  eq(sheet.color, null);
  eq(sheet.frozenRows, 0);
  eq(sheet.frozenCols, 0);
  eq(sheet.rows, DEFAULT_ROWS);
  eq(sheet.cols, DEFAULT_COLS);
});

test('addSheet mints a unique id for every sheet', () => {
  let doc = docWith(1);
  for (let i = 0; i < 20; i++) doc = addSheet(doc, {}).doc;
  const ids = doc.sheets.map((s) => s.id);
  eq(ids.length, 21);
  eq(new Set(ids).size, 21, 'no two sheets share an id');
  for (const id of ids) eq(typeof id === 'string' && id.length > 0, true, 'ids are non-empty strings');
});

test('addSheet keeps names unique across many additions', () => {
  let doc = docWith(1);
  for (let i = 0; i < 20; i++) doc = addSheet(doc, {}).doc;
  eq(new Set(names(doc).map((n) => n.toLowerCase())).size, 21, 'no two sheets share a name');
});

test('addSheet uses a requested id', () => {
  const res = addSheet(docWith(1), { id: 'sh9z9z' });
  eq(res.sheet.id, 'sh9z9z');
  eq(findSheet(res.doc, 'sh9z9z').id, 'sh9z9z');
});

test('addSheet refuses to go past MAX_SHEETS', () => {
  let doc = docWith(1);
  while (doc.sheets.length < MAX_SHEETS) doc = addSheet(doc, {}).doc;
  eq(doc.sheets.length, MAX_SHEETS, 'precondition: the document is full');

  const res = pure(doc, (d) => addSheet(d, {}), 'addSheet at the cap');
  eq(res.doc.sheets.length, MAX_SHEETS, 'no sheet is added');
  eq(!res.sheet, true, 'and no sheet is reported back');
  eq(names(res.doc), names(doc), 'the tab order is untouched');
});

test('addSheet accepts being called with no options at all', () => {
  const res = addSheet(docWith(1));
  eq(res.doc.sheets.length, 2);
  eq(typeof res.sheet.name, 'string');
  eq(res.sheet.name.length > 0, true);
});

// ===========================================================================
// renameSheet
// ===========================================================================

test('renameSheet applies a free name', () => {
  const doc = docWith(3);
  const next = pure(doc, (d) => renameSheet(d, d.sheets[1].id, '매출 집계'), 'renameSheet');
  eq(names(next), ['S0', '매출 집계', 'S2']);
  eq(next.sheets[1].id, doc.sheets[1].id, 'the id survives the rename');
});

test('renameSheet keeps every other sheet field intact', () => {
  const doc = richDoc();
  const next = renameSheet(doc, 'sh0001', '새 이름');
  const before = doc.sheets[0];
  const after = next.sheets[0];
  eq(after.name, '새 이름');
  eq(after.cells, before.cells, 'cells');
  eq(after.color, before.color, 'colour');
  eq(after.rows, before.rows, 'rows');
  eq(after.frozenRows, before.frozenRows, 'freeze');
});

test('renameSheet enforces uniqueness against the other sheets', () => {
  const doc = docWith(3);
  const next = renameSheet(doc, doc.sheets[0].id, 'S1');
  eq(next.sheets[0].name === 'S1', false, 'S1 is taken');
  eq(next.sheets[1].name, 'S1', 'the sheet that owns the name keeps it');
  eq(new Set(names(next)).size, 3, 'all three names stay distinct');
});

test('renameSheet renaming a sheet to its own name is a no-op', () => {
  const doc = docWith(3);
  const next = renameSheet(doc, doc.sheets[1].id, 'S1');
  eq(names(next), ['S0', 'S1', 'S2'], 'no " (2)" is appended to the name it already has');
});

test('renameSheet trims surrounding whitespace', () => {
  const doc = docWith(2);
  eq(renameSheet(doc, doc.sheets[0].id, '  보고서  ').sheets[0].name, '보고서');
  eq(renameSheet(doc, doc.sheets[0].id, '\t가계부\t').sheets[0].name, '가계부');
});

test('renameSheet falls back when the new name is empty', () => {
  const doc = docWith(2);
  for (const blank of ['', '   ', '\t\t', null, undefined, 42]) {
    const next = renameSheet(doc, doc.sheets[0].id, blank);
    const name = next.sheets[0].name;
    eq(typeof name === 'string' && name.length > 0, true, 'never empty for ' + JSON.stringify(blank));
    eq(new Set(names(next)).size, 2, 'and still unique in the document');
    eq(/^시트[0-9]+$/.test(name), true, 'the fallback is the default 시트N');
  }
});

test('renameSheet caps the name at 100 characters', () => {
  const doc = docWith(2);
  eq(renameSheet(doc, doc.sheets[0].id, 'z'.repeat(150)).sheets[0].name.length, 100);
});

test('renameSheet ignores an unknown sheet id', () => {
  const doc = docWith(3);
  const next = pure(doc, (d) => renameSheet(d, '없는아이디', '무시'), 'renameSheet(unknown)');
  eq(names(next), ['S0', 'S1', 'S2'], 'nothing is renamed');
  eq(next.sheets.length, 3, 'and nothing is added');
});

// ===========================================================================
// deleteSheet
// ===========================================================================

test('deleteSheet refuses to remove the last sheet', () => {
  const doc = docWith(1);
  const next = pure(doc, (d) => deleteSheet(d, d.sheets[0].id), 'deleteSheet(last)');
  eq(next.sheets.length, 1, 'a document always keeps at least one sheet');
  eq(next.sheets[0].id, doc.sheets[0].id, 'and it is the same sheet');
});

test('deleteSheet removes the sheet with that id', () => {
  const doc = docWith(3);
  const next = pure(doc, (d) => deleteSheet(d, d.sheets[1].id), 'deleteSheet');
  eq(names(next), ['S0', 'S2'], 'the middle sheet goes, tab order is preserved');
  eq(findSheet(next, doc.sheets[1].id), null, 'and it is gone for good');
});

test('deleteSheet removes the first and the last sheet correctly', () => {
  const doc = docWith(3);
  eq(names(deleteSheet(doc, doc.sheets[0].id)), ['S1', 'S2']);
  eq(names(deleteSheet(doc, doc.sheets[2].id)), ['S0', 'S1']);
});

test('deleteSheet ignores an unknown sheet id', () => {
  const doc = docWith(3);
  eq(names(deleteSheet(doc, '없는아이디')), ['S0', 'S1', 'S2']);
  eq(names(deleteSheet(doc, '')), ['S0', 'S1', 'S2']);
});

test('deleteSheet down to one, then refuses', () => {
  let doc = docWith(3);
  doc = deleteSheet(doc, doc.sheets[2].id);
  doc = deleteSheet(doc, doc.sheets[1].id);
  eq(names(doc), ['S0']);
  doc = deleteSheet(doc, doc.sheets[0].id);
  eq(names(doc), ['S0'], 'the last one is not removable');
});

// ===========================================================================
// reorderSheet
// ===========================================================================

test('reorderSheet moves a sheet forward', () => {
  const doc = docWith(3);
  eq(names(pure(doc, (d) => reorderSheet(d, d.sheets[0].id, 2), 'reorderSheet')), ['S1', 'S2', 'S0']);
  eq(names(reorderSheet(doc, doc.sheets[0].id, 1)), ['S1', 'S0', 'S2']);
});

test('reorderSheet moves a sheet backward', () => {
  const doc = docWith(3);
  eq(names(reorderSheet(doc, doc.sheets[2].id, 0)), ['S2', 'S0', 'S1']);
  eq(names(reorderSheet(doc, doc.sheets[2].id, 1)), ['S0', 'S2', 'S1']);
});

test('reorderSheet clamps an index past the end', () => {
  const doc = docWith(3);
  eq(names(reorderSheet(doc, doc.sheets[0].id, 99)), ['S1', 'S2', 'S0']);
  eq(names(reorderSheet(doc, doc.sheets[0].id, 3)), ['S1', 'S2', 'S0']);
});

test('reorderSheet clamps a negative index', () => {
  const doc = docWith(3);
  eq(names(reorderSheet(doc, doc.sheets[2].id, -5)), ['S2', 'S0', 'S1']);
  eq(names(reorderSheet(doc, doc.sheets[2].id, -1)), ['S2', 'S0', 'S1']);
});

test('reorderSheet to the position it already holds changes nothing', () => {
  const doc = docWith(3);
  eq(names(reorderSheet(doc, doc.sheets[1].id, 1)), ['S0', 'S1', 'S2']);
});

test('reorderSheet ignores an unknown sheet id', () => {
  const doc = docWith(3);
  eq(names(pure(doc, (d) => reorderSheet(d, '없는아이디', 0), 'reorderSheet(unknown)')), ['S0', 'S1', 'S2']);
});

test('reorderSheet keeps every sheet exactly once', () => {
  const doc = docWith(5);
  const next = reorderSheet(doc, doc.sheets[3].id, 1);
  eq(next.sheets.length, 5);
  eq(new Set(next.sheets.map((s) => s.id)).size, 5, 'no sheet is lost or duplicated');
  eq(names(next), ['S0', 'S3', 'S1', 'S2', 'S4']);
});

// ===========================================================================
// duplicateSheet
// ===========================================================================

test('duplicateSheet copies every field of the source sheet', () => {
  const doc = richDoc();
  const res = pure(doc, (d) => duplicateSheet(d, 'sh0001', {}), 'duplicateSheet');
  const src = doc.sheets[0];
  const copy = res.sheet;
  eq(res.doc.sheets.length, 2);
  eq(copy.cells, src.cells, 'cells are equal');
  eq(copy.colWidths, src.colWidths, 'colWidths are equal');
  eq(copy.rowHeights, src.rowHeights, 'rowHeights are equal');
  eq(copy.rows, src.rows);
  eq(copy.cols, src.cols);
  eq(copy.color, src.color);
  eq(copy.frozenRows, src.frozenRows);
  eq(copy.frozenCols, src.frozenCols);
});

test('duplicateSheet gives the copy a fresh unique name and id', () => {
  const doc = richDoc();
  const res = duplicateSheet(doc, 'sh0001', {});
  eq(res.sheet.name === doc.sheets[0].name, false, 'the copy is not named after the original');
  eq(res.sheet.id === doc.sheets[0].id, false, 'and it has its own id');
  eq(new Set(names(res.doc)).size, 2, 'both names are distinct');
  eq(new Set(res.doc.sheets.map((s) => s.id)).size, 2, 'both ids are distinct');
  eq(findSheet(res.doc, res.sheet.id).name, res.sheet.name, 'the copy is findable by id');
});

test('duplicateSheet honours an explicit name', () => {
  const res = duplicateSheet(richDoc(), 'sh0001', { name: '백업' });
  eq(res.sheet.name, '백업');
});

test('duplicateSheet makes an explicit name unique when it collides', () => {
  const res = duplicateSheet(richDoc(), 'sh0001', { name: '원본' });
  eq(res.sheet.name === '원본', false, 'the original already owns that name');
  eq(new Set(names(res.doc)).size, 2);
});

test('duplicateSheet does not share the cells object with the original', () => {
  const doc = richDoc();
  const res = duplicateSheet(doc, 'sh0001', {});
  const copy = findSheet(res.doc, res.sheet.id);
  const original = findSheet(res.doc, 'sh0001');
  eq(copy.cells !== original.cells, true, 'the cell maps are different objects');

  copy.cells.A1.input = '변경됨';
  eq(original.cells.A1.input, '1', 'mutating the copy must not touch the original');

  copy.cells.D4 = { input: '새로' };
  eq(original.cells.D4, undefined, 'adding a cell to the copy must not add one to the original');

  delete copy.cells.B2;
  eq(original.cells.B2.input, '=A1+1', 'deleting from the copy must not delete from the original');
});

test('duplicateSheet does not share a style object with the original', () => {
  const doc = richDoc();
  const res = duplicateSheet(doc, 'sh0001', {});
  const copy = findSheet(res.doc, res.sheet.id);
  const original = findSheet(res.doc, 'sh0001');
  eq(copy.cells.A1.style, original.cells.A1.style, 'the styles start out equal');
  eq(copy.cells.A1.style !== original.cells.A1.style, true, 'but they are separate objects');

  copy.cells.A1.style.b = 0;
  copy.cells.A1.style.i = 1;
  eq(original.cells.A1.style.b, 1, 'the original style is untouched');
  eq(original.cells.A1.style.i, undefined, 'in both directions');
});

test('duplicateSheet does not share the size maps with the original', () => {
  const doc = richDoc();
  const res = duplicateSheet(doc, 'sh0001', {});
  const copy = findSheet(res.doc, res.sheet.id);
  const original = findSheet(res.doc, 'sh0001');
  eq(copy.colWidths !== original.colWidths, true);
  eq(copy.rowHeights !== original.rowHeights, true);

  copy.colWidths['2'] = 400;
  copy.rowHeights['3'] = 400;
  eq(original.colWidths['2'], 160, 'colWidths stay separate');
  eq(original.rowHeights['3'], 40, 'rowHeights stay separate');
});

test('duplicateSheet leaves the source document completely alone', () => {
  const doc = richDoc();
  const before = snapshot(doc);
  const res = duplicateSheet(doc, 'sh0001', {});
  const copy = findSheet(res.doc, res.sheet.id);
  copy.cells.A1.input = '변경됨';
  copy.cells.A1.style.b = 0;
  eq(snapshot(doc), before, 'even after the copy is mutated, the input document is unchanged');
});

test('duplicateSheet refuses an unknown sheet id', () => {
  const doc = richDoc();
  const res = pure(doc, (d) => duplicateSheet(d, '없는아이디', {}), 'duplicateSheet(unknown)');
  eq(res.doc.sheets.length, 1, 'nothing is added');
  eq(!res.sheet, true, 'and no sheet is reported back');
});

test('duplicateSheet refuses to go past MAX_SHEETS', () => {
  let doc = richDoc();
  while (doc.sheets.length < MAX_SHEETS) doc = addSheet(doc, {}).doc;
  const res = pure(doc, (d) => duplicateSheet(d, 'sh0001', {}), 'duplicateSheet at the cap');
  eq(res.doc.sheets.length, MAX_SHEETS, 'no sheet is added');
  eq(!res.sheet, true, 'and no sheet is reported back');
});

test('duplicateSheet accepts being called with no options at all', () => {
  const res = duplicateSheet(richDoc(), 'sh0001');
  eq(res.doc.sheets.length, 2);
  eq(typeof res.sheet.name, 'string');
  eq(res.sheet.name.length > 0, true);
});

// ===========================================================================
// setSheetColor
// ===========================================================================

test('setSheetColor keeps a valid hex colour', () => {
  const doc = docWith(2);
  const next = pure(doc, (d) => setSheetColor(d, d.sheets[0].id, '#00ff00'), 'setSheetColor');
  eq(next.sheets[0].color, '#00ff00');
  eq(next.sheets[1].color, null, 'the other sheet is untouched');
});

test('setSheetColor accepts an uppercase hex colour', () => {
  const doc = docWith(1);
  const color = setSheetColor(doc, doc.sheets[0].id, '#FF8800').sheets[0].color;
  eq(typeof color, 'string');
  eq(color.toLowerCase(), '#ff8800', 'case does not change which colour it is');
});

test('setSheetColor turns an invalid colour into null', () => {
  const doc = docWith(1);
  const id = doc.sheets[0].id;
  for (const bad of ['빨강', 'red', '#xyzxyz', 'ff8800', '#12345', '#1234567', '', '  ', 123, true, {}, [], undefined]) {
    eq(setSheetColor(doc, id, bad).sheets[0].color, null, 'colour ' + JSON.stringify(bad) + ' is not a colour');
  }
});

test('setSheetColor with null clears an existing colour', () => {
  const doc = docWith(1);
  const painted = setSheetColor(doc, doc.sheets[0].id, '#00ff00');
  eq(painted.sheets[0].color, '#00ff00', 'precondition');
  eq(setSheetColor(painted, painted.sheets[0].id, null).sheets[0].color, null, 'null clears it');
  // richDoc() starts out with a colour, so clearing it is a real change, not a no-op.
  eq(richDoc().sheets[0].color, '#ff8800', 'precondition');
  eq(setSheetColor(richDoc(), 'sh0001', null).sheets[0].color, null);
});

test('setSheetColor keeps every other sheet field intact', () => {
  const doc = richDoc();
  const next = setSheetColor(doc, 'sh0001', '#123456');
  eq(next.sheets[0].name, doc.sheets[0].name);
  eq(next.sheets[0].id, doc.sheets[0].id);
  eq(next.sheets[0].cells, doc.sheets[0].cells);
  eq(next.sheets[0].frozenCols, doc.sheets[0].frozenCols);
});

test('setSheetColor ignores an unknown sheet id', () => {
  const doc = richDoc();
  const next = pure(doc, (d) => setSheetColor(d, '없는아이디', '#00ff00'), 'setSheetColor(unknown)');
  eq(next.sheets[0].color, '#ff8800', 'the real sheet keeps its colour');
  eq(next.sheets.length, 1);
});

// ===========================================================================
// purity — every helper leaves its input document alone
// ===========================================================================

test('every sheet helper leaves its input document unmodified', () => {
  const base = richDoc();
  const withThree = docWith(3);
  const calls = [
    ['addSheet', withThree, (d) => addSheet(d, { name: '새 시트' })],
    ['addSheet(afterId)', withThree, (d) => addSheet(d, { name: '새 시트', afterId: d.sheets[0].id })],
    ['renameSheet', withThree, (d) => renameSheet(d, d.sheets[0].id, '이름')],
    ['renameSheet(collide)', withThree, (d) => renameSheet(d, d.sheets[0].id, 'S1')],
    ['deleteSheet', withThree, (d) => deleteSheet(d, d.sheets[1].id)],
    ['deleteSheet(last)', docWith(1), (d) => deleteSheet(d, d.sheets[0].id)],
    ['reorderSheet(forward)', withThree, (d) => reorderSheet(d, d.sheets[0].id, 2)],
    ['reorderSheet(backward)', withThree, (d) => reorderSheet(d, d.sheets[2].id, 0)],
    ['reorderSheet(clamped)', withThree, (d) => reorderSheet(d, d.sheets[0].id, 999)],
    ['duplicateSheet', base, (d) => duplicateSheet(d, 'sh0001', {})],
    ['setSheetColor', base, (d) => setSheetColor(d, 'sh0001', '#00ff00')],
    ['setSheetColor(clear)', base, (d) => setSheetColor(d, 'sh0001', null)],
    ['uniqueSheetName', withThree, (d) => uniqueSheetName(d, 'S0')],
    ['findSheet', withThree, (d) => findSheet(d, d.sheets[0].id)],
    ['sheetIndex', withThree, (d) => sheetIndex(d, d.sheets[0].id)],
  ];
  for (const [label, doc, fn] of calls) pure(doc, fn, label);
});

test('a sheet helper does not alias the sheet object it replaces', () => {
  // The successor document may share untouched sheets by reference, but the sheet an
  // operation changes must be a new object, or the "pure" contract is only skin deep.
  const doc = docWith(3);
  const renamed = renameSheet(doc, doc.sheets[0].id, '바뀜');
  eq(renamed.sheets[0] !== doc.sheets[0], true, 'the renamed sheet is a fresh object');
  eq(doc.sheets[0].name, 'S0', 'and the original still reads the old name');

  const painted = setSheetColor(doc, doc.sheets[1].id, '#00ff00');
  eq(painted.sheets[1] !== doc.sheets[1], true, 'the recoloured sheet is a fresh object');
  eq(doc.sheets[1].color, null, 'and the original still has no colour');
});

test('a sheet helper does not alias the sheets array', () => {
  const doc = docWith(3);
  const added = addSheet(doc, {}).doc;
  eq(added.sheets !== doc.sheets, true, 'the array is copied, never pushed into');
  eq(doc.sheets.length, 3, 'so the original list keeps its length');
});

// ===========================================================================
// cross-sheet seam — refs.js
// ===========================================================================

test('splitSheetRef splits a bare qualifier', () => {
  eq(splitSheetRef('Sheet2!A1'), { sheet: 'Sheet2', ref: 'A1' });
  eq(splitSheetRef('시트2!A1'), { sheet: '시트2', ref: 'A1' });
  eq(splitSheetRef('시트2!A1:B10'), { sheet: '시트2', ref: 'A1:B10' });
  eq(splitSheetRef('Sheet2!$A$1'), { sheet: 'Sheet2', ref: '$A$1' });
});

test('splitSheetRef reports an unqualified reference as sheet null', () => {
  eq(splitSheetRef('A1'), { sheet: null, ref: 'A1' });
  eq(splitSheetRef('$B$3'), { sheet: null, ref: '$B$3' });
  eq(splitSheetRef('A1:B10'), { sheet: null, ref: 'A1:B10' });
  eq(splitSheetRef(''), { sheet: null, ref: '' });
});

test('splitSheetRef splits a quoted qualifier', () => {
  eq(splitSheetRef("'매출 집계'!A1"), { sheet: '매출 집계', ref: 'A1' });
  eq(splitSheetRef("'매출 집계'!A1:B10"), { sheet: '매출 집계', ref: 'A1:B10' });
  eq(splitSheetRef("'2024'!A1"), { sheet: '2024', ref: 'A1' });
});

test('splitSheetRef keeps a ! that is inside a quoted name', () => {
  // Splitting on the last '!' would name the sheet "'a" and lose the rest.
  eq(splitSheetRef("'a!b'!A1"), { sheet: 'a!b', ref: 'A1' });
  eq(splitSheetRef("'!'!A1"), { sheet: '!', ref: 'A1' });
  eq(splitSheetRef("'a!b!c'!A1:B2"), { sheet: 'a!b!c', ref: 'A1:B2' });
});

test('splitSheetRef decodes a doubled quote inside a quoted name', () => {
  eq(splitSheetRef("'a''b'!A1"), { sheet: "a'b", ref: 'A1' });
  eq(splitSheetRef("'a''b''c'!A1"), { sheet: "a'b'c", ref: 'A1' });
  // A sheet literally named ' is written open-quote, doubled-quote, close-quote.
  eq(splitSheetRef("''''!A1"), { sheet: "'", ref: 'A1' });
  eq(splitSheetRef("'''a'!A1"), { sheet: "'a", ref: 'A1' }, 'a leading escaped quote');
  eq(splitSheetRef("'a'''!A1"), { sheet: "a'", ref: 'A1' }, 'a trailing escaped quote');
});

test('splitSheetRef throws a RangeError on a malformed qualifier', () => {
  eq(throwsRangeError(() => splitSheetRef("'미완성!A1")), true, 'unterminated quote');
  eq(throwsRangeError(() => splitSheetRef('!A1')), true, 'empty bare name');
  eq(throwsRangeError(() => splitSheetRef("''!A1")), true, 'empty quoted name');
  eq(throwsRangeError(() => splitSheetRef("'시트2'A1")), true, "quoted name not followed by '!'");
});

test('quoteSheetName leaves a bare name alone', () => {
  eq(quoteSheetName('Sheet2'), 'Sheet2');
  eq(quoteSheetName('시트2'), '시트2');
  eq(quoteSheetName('_a1'), '_a1');
  eq(quoteSheetName('매출집계'), '매출집계');
});

test('quoteSheetName quotes a name that needs it', () => {
  eq(quoteSheetName('매출 집계'), "'매출 집계'");
  eq(quoteSheetName('2024'), "'2024'");
  eq(quoteSheetName('a!b'), "'a!b'");
  eq(quoteSheetName('a-b'), "'a-b'");
});

test('quoteSheetName doubles an inner quote', () => {
  eq(quoteSheetName("a'b"), "'a''b'");
  eq(quoteSheetName("'"), "''''");
});

test('quoteSheetName and splitSheetRef round-trip every name', () => {
  const cases = ['Sheet2', '시트2', '매출 집계', '2024', "a'b", 'a!b', "'", "a!'b", '_x', '가 나 다'];
  for (const name of cases) {
    const text = quoteSheetName(name) + '!A1';
    eq(splitSheetRef(text), { sheet: name, ref: 'A1' }, 'round trip of ' + JSON.stringify(name));
  }
});

test('isBareSheetName tells apart the names that need quoting', () => {
  eq(isBareSheetName('Sheet2'), true);
  eq(isBareSheetName('시트2'), true);
  eq(isBareSheetName('_x'), true);
  eq(isBareSheetName('매출 집계'), false, 'a space forces quoting');
  eq(isBareSheetName('2024'), false, 'a leading digit forces quoting');
  eq(isBareSheetName('a!b'), false);
  eq(isBareSheetName("a'b"), false);
  eq(isBareSheetName(''), false);
  eq(isBareSheetName(null), false);
  eq(isBareSheetName(42), false);
});

test('a1ToCell puts the qualifier on the ref object', () => {
  eq(a1ToCell('시트2!A1'), { sheet: '시트2', row: 0, col: 0, absRow: false, absCol: false });
  eq(a1ToCell('Sheet2!$B$3'), { sheet: 'Sheet2', row: 2, col: 1, absRow: true, absCol: true });
  eq(a1ToCell("'매출 집계'!C10"), { sheet: '매출 집계', row: 9, col: 2, absRow: false, absCol: false });
});

test('a1ToCell reports sheet null for an unqualified reference', () => {
  eq(a1ToCell('A1'), { sheet: null, row: 0, col: 0, absRow: false, absCol: false });
  eq(a1ToCell('$B$3').sheet, null);
});

test('parseRange puts the qualifier on the range', () => {
  eq(parseRange("'매출 집계'!A1:B10").sheet, '매출 집계');
  eq(parseRange('시트2!A1:B3').sheet, '시트2');
  eq(parseRange('시트2!A:A').sheet, '시트2');
  eq(parseRange('A1:B3').sheet, null, 'an unqualified range is local');
});

// ===========================================================================
// cross-sheet seam — parser.js
// ===========================================================================

test('parse produces a ref node carrying the sheet name', () => {
  eq(parse('시트2!A1'), { type: 'ref', sheet: '시트2', row: 0, col: 0, absRow: false, absCol: false });
  eq(parse('Sheet2!$B$3'), { type: 'ref', sheet: 'Sheet2', row: 2, col: 1, absRow: true, absCol: true });
});

test('parse produces a range node carrying a quoted sheet name', () => {
  eq(parse("'매출 집계'!A1:B10"), {
    type: 'range',
    sheet: '매출 집계',
    s: { row: 0, col: 0, absRow: false, absCol: false },
    e: { row: 9, col: 1, absRow: false, absCol: false },
  });
});

test('parse leaves sheet null on a local reference', () => {
  eq(parse('A1').sheet, null);
  eq(parse('A1:B3').sheet, null);
});

test('parse handles a qualified reference inside an expression', () => {
  const ast = parse('SUM(시트2!A1:A5)+시트2!B1');
  eq(ast.type, 'binary');
  eq(ast.left.type, 'call');
  eq(ast.left.args[0].sheet, '시트2');
  eq(ast.right.sheet, '시트2');
});

test('serialize round-trips a bare sheet qualifier', () => {
  eq(serialize(parse('시트2!A1')), '시트2!A1');
  eq(serialize(parse('Sheet2!$B$3')), 'Sheet2!$B$3');
  eq(serialize(parse('시트2!A1:B10')), '시트2!A1:B10');
  eq(serialize(parse('SUM(시트2!A1:A5)')), 'SUM(시트2!A1:A5)');
});

test('serialize round-trips a quoted sheet qualifier', () => {
  eq(serialize(parse("'매출 집계'!A1:B10")), "'매출 집계'!A1:B10");
  eq(serialize(parse("'매출 집계'!$A$1")), "'매출 집계'!$A$1");
  eq(serialize(parse("'a''b'!A1")), "'a''b'!A1");
});

test('serialize quotes a sheet name only when it has to', () => {
  eq(serialize(parse("'시트2'!A1")), '시트2!A1', 'unnecessary quotes are dropped');
  eq(serialize(parse("'Sheet2'!A1:B2")), 'Sheet2!A1:B2');
});

test('serialize output re-parses to the same AST', () => {
  for (const src of ['시트2!A1', "'매출 집계'!A1:B10", 'SUM(시트2!A1:A5)+A1', "'a''b'!$A$1"]) {
    const once = parse(src);
    eq(parse(serialize(once)), once, 'round trip of ' + src);
  }
});

test('collectRefs puts a foreign sheet name in .sheets', () => {
  const refs = collectRefs(parse("A1+시트2!B2+SUM(C1:C3)+'매출 집계'!D4"));
  eq(refs.sheets, ['매출 집계', '시트2'], 'sorted and unique');
});

test('collectRefs keeps foreign references out of .cells and .ranges', () => {
  const refs = collectRefs(parse("A1+시트2!B2+SUM(C1:C3)+'매출 집계'!D4:E9"));
  eq(refs.cells, ['A1'], 'B2 belongs to another sheet and must not be a local precedent');
  eq(refs.ranges.length, 1, 'only the local range is registered');
  eq(refs.ranges[0].s, { row: 0, col: 2, absRow: false, absCol: false });
  eq(refs.ranges[0].e, { row: 2, col: 2, absRow: false, absCol: false });
  eq(refs.ranges[0].sheet, null, 'a registered range is always local');
});

test('collectRefs reports no sheets for a purely local formula', () => {
  const refs = collectRefs(parse('A1+SUM(B1:B3)'));
  eq(refs.sheets, []);
  eq(refs.cells, ['A1']);
  eq(refs.ranges.length, 1);
});

test('collectRefs deduplicates a sheet name used many times', () => {
  const refs = collectRefs(parse('시트2!A1+시트2!B2+SUM(시트2!C1:C9)'));
  eq(refs.sheets, ['시트2']);
  eq(refs.cells, [], 'every reference is foreign');
  eq(refs.ranges, []);
});

test('mapRefs leaves a foreign ref untouched under a structural edit', () => {
  const edit = { kind: 'insertRow', index: 0, count: 1 };
  const out = mapRefs(parse('시트2!B2+B2'), (r) => shiftRefForStructuralEdit(r, edit));
  eq(serialize(out), '시트2!B2+B3', 'only the local reference moves');
});

test('mapRefs leaves a foreign range untouched under a structural edit', () => {
  const edit = { kind: 'insertRow', index: 0, count: 1 };
  const out = mapRefs(parse("'매출 집계'!A1:B2+A1:B2"), (r) => shiftRefForStructuralEdit(r, edit));
  eq(serialize(out), "'매출 집계'!A1:B2+A2:B3");
});

test('mapRefs leaves a foreign ref untouched even when fn reports out of bounds', () => {
  eq(serialize(mapRefs(parse('시트2!A1'), () => ({ oob: true }))), '시트2!A1');
  eq(serialize(mapRefs(parse("'매출 집계'!A1:B2"), () => ({ oob: true }))), "'매출 집계'!A1:B2");
  eq(serialize(mapRefs(parse('A1'), () => ({ oob: true }))), '#REF!', 'a local ref still becomes #REF!');
});

test('mapRefs deep-clones a foreign node rather than sharing it', () => {
  const ast = parse('시트2!A1');
  const out = mapRefs(ast, (r) => r);
  eq(out, ast, 'equal in value');
  eq(out !== ast, true, 'but a different object');
});

test('mapRefs under a column delete keeps the other sheet out of it', () => {
  const edit = { kind: 'deleteCol', index: 0, count: 1 };
  const out = mapRefs(parse('시트2!A1+B1'), (r) => shiftRefForStructuralEdit(r, edit));
  eq(serialize(out), '시트2!A1+A1', 'the local B1 slides left; 시트2!A1 does not');
});

// ===========================================================================
// cross-sheet seam — evaluation (SPEC 16.3)
// ===========================================================================

test('a cross-sheet reference with no resolveSheet evaluates to #REF!', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('A1', '=시트2!A1');
  const v = e.getValue('A1');
  eq(isError(v), true, 'the value is a FormulaError');
  eq(v.code, ERR.REF, 'and its code is #REF!');
  eq(String(v), '#REF!', 'it renders as #REF!');
});

test('the #REF! for a cross-sheet reference explains itself in Korean', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('A1', '=시트2!A1');
  const v = e.getValue('A1');
  eq(v.message.includes('아직 지원하지 않습니다'), true, 'the user is told it is unsupported');
  eq(v.message, unsupportedMessage('시트2'), 'and which sheet they asked for');
});

test('a cross-sheet range with no resolveSheet also reports the Korean #REF!', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('B1', "=SUM('매출 집계'!A1:A5)");
  const v = e.getValue('B1');
  eq(isError(v), true);
  eq(v.code, ERR.REF);
  eq(v.message, unsupportedMessage('매출 집계'), 'the name is reported unquoted');
});

test('a cross-sheet formula never evaluates to a silent zero', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('A1', '=시트2!A1+1');
  const v = e.getValue('A1');
  eq(isError(v), true, 'the error propagates through arithmetic');
  eq(v.code, ERR.REF);
});

test('a cross-sheet formula keeps its input text intact', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('A1', "=SUM('매출 집계'!A1:B10)");
  eq(e.getInput('A1'), "=SUM('매출 집계'!A1:B10)");
  eq(e.isFormula('A1'), true);
});

test('a structural edit rewrites the local half of a cross-sheet formula only', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('C1', '=시트2!B2+B2');
  e.applyStructuralEdit({ kind: 'insertRow', index: 0, count: 1 });
  eq(e.getInput('C2'), '=시트2!B2+B3', 'the other sheet keeps its coordinates');
});

test('a SheetEngine given a resolveSheet reads the foreign cell', () => {
  const 시트2 = sourceFrom({ A1: 10, A2: 32, B1: '값' });
  const e = new SheetEngine({
    rows: 50,
    cols: 10,
    resolveSheet: (name) => (name === '시트2' ? 시트2 : null),
  });
  e.setInput('A1', '=시트2!A1');
  eq(e.getValue('A1'), 10);
  e.setInput('A2', '=시트2!B1');
  eq(e.getValue('A2'), '값');
  e.setInput('A3', '=시트2!A1+시트2!A2');
  eq(e.getValue('A3'), 42);
});

test('a SheetEngine given a resolveSheet reads a foreign range', () => {
  const 시트2 = sourceFrom({ A1: 1, A2: 2, A3: 3, B1: 10, B2: 20, B3: 30 });
  const e = new SheetEngine({
    rows: 50,
    cols: 10,
    resolveSheet: (name) => (name === '시트2' ? 시트2 : null),
  });
  e.setInput('A1', '=SUM(시트2!A1:B3)');
  eq(e.getValue('A1'), 66);
  e.setInput('A2', '=COUNT(시트2!A1:A3)');
  eq(e.getValue('A2'), 3);
});

test('resolveSheet is consulted for a quoted sheet name too', () => {
  const 매출 = sourceFrom({ A1: 100, A2: 200 });
  const e = new SheetEngine({
    rows: 50,
    cols: 10,
    resolveSheet: (name) => (name === '매출 집계' ? 매출 : null),
  });
  e.setInput('A1', "=SUM('매출 집계'!A1:A2)");
  eq(e.getValue('A1'), 300);
});

test('resolveSheet returning nothing still yields the Korean #REF!', () => {
  const e = new SheetEngine({
    rows: 50,
    cols: 10,
    resolveSheet: (name) => (name === '시트2' ? sourceFrom({ A1: 1 }) : null),
  });
  e.setInput('A1', '=시트3!A1');
  const v = e.getValue('A1');
  eq(isError(v), true);
  eq(v.code, ERR.REF);
  eq(v.message, unsupportedMessage('시트3'), 'the unresolvable name is the one reported');
});

test('a cross-sheet read is not confused with the local cell of the same address', () => {
  const 시트2 = sourceFrom({ A1: 10 });
  const e = new SheetEngine({
    rows: 50,
    cols: 10,
    resolveSheet: (name) => (name === '시트2' ? 시트2 : null),
  });
  e.setInput('A1', '1');
  e.setInput('B1', '=시트2!A1');
  e.setInput('C1', '=시트2!A1+A1');
  eq(e.getValue('B1'), 10, 'the foreign A1 is read, not the local one');
  eq(e.getValue('C1'), 11, '10 + 1');

  e.setInput('A1', '999');
  eq(e.getValue('B1'), 10, 'a local write must not leak into a cross-sheet read');
  eq(e.getValue('C1'), 1009, 'while the local half still recalculates');
});

test('a blank foreign cell reads as blank, not as an error', () => {
  const 시트2 = sourceFrom({ A1: 5 });
  const e = new SheetEngine({
    rows: 50,
    cols: 10,
    resolveSheet: (name) => (name === '시트2' ? 시트2 : null),
  });
  e.setInput('A1', '=시트2!Z9');
  eq(e.getValue('A1'), null, 'an empty foreign cell is blank');
  e.setInput('A2', '=시트2!Z9+1');
  eq(e.getValue('A2'), 1, 'and coerces to 0 in arithmetic');
});
