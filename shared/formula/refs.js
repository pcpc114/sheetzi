/**
 * @file A1 reference math: `A1` <-> `{row, col}`, ranges, and reference transforms.
 *
 * Rows and columns are 0-indexed internally. Row 0 displays as "1", column 0 as "A".
 * The canonical cell key everywhere else in the app (document model, dependency graph,
 * wire protocol) is the uppercase A1 string with no `$`, e.g. `"A1"`, `"BC42"`.
 *
 * A "ref object" is `{row, col, absRow, absCol}` where the `abs*` booleans record whether
 * the user wrote a `$` on that axis.
 *
 * A "Range" is `{sheet, s: refObj, e: refObj}` plus optional `wholeCol` / `wholeRow` markers.
 * `s`/`e` are kept exactly as written (so `B3:A1` round-trips); every consumer here
 * normalizes internally, and {@link normalizeRange} exposes that explicitly.
 *
 * A reference may carry a sheet qualifier (`Sheet2!A1`, `'매출 집계'!A1:B10`). The qualifier
 * lives on the ref/Range object as `sheet`, and is `null` for an ordinary same-sheet
 * reference — which is what every pre-existing caller produces and consumes.
 *
 * Pure ESM, no Node builtins, no browser globals.
 */

/** Maximum number of rows on a sheet (row indexes 0 .. 4999). @type {number} */
export const MAX_ROWS = 5000;

/** Maximum number of columns on a sheet: A .. ZZ (col indexes 0 .. 701). @type {number} */
export const MAX_COLS = 702;

/** Hard cap on how many cells {@link rangeCells} will materialize at once. */
const MAX_RANGE_CELLS = 200000;

/** `A1`, `$A1`, `A$1`, `$A$1` -- 1..3 letters, 1..5 digits. Bounds are checked separately. */
const A1_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,5})$/;

/** A bare column part of a whole-column range: `A`, `$BC`. */
const COL_ONLY_RE = /^(\$?)([A-Za-z]{1,3})$/;

/** A bare row part of a whole-row range: `1`, `$42`. */
const ROW_ONLY_RE = /^(\$?)([0-9]{1,5})$/;

/**
 * Hangul code points allowed in an unquoted sheet name: Jamo, Compatibility Jamo,
 * Extended-A/B and the Syllables block.
 */
const HANGUL_CLASS = '\\u1100-\\u11FF\\u3130-\\u318F\\uA960-\\uA97F\\uAC00-\\uD7A3\\uD7B0-\\uD7FF';

/**
 * A bare (unquoted) sheet name: letters, digits, `_` and Hangul, never starting with a
 * digit. Anything else — spaces, punctuation, `!` — must be written in single quotes.
 * The tokenizer mirrors this character class; keep the two in step.
 */
const BARE_SHEET_RE = new RegExp(`^[A-Za-z_${HANGUL_CLASS}][A-Za-z0-9_${HANGUL_CLASS}]*$`);

/** Single quote, the delimiter of a quoted sheet name. */
const QUOTE = "'";

/**
 * Column index -> letters, bijective base-26 (`0 -> 'A'`, `25 -> 'Z'`, `26 -> 'AA'`,
 * `701 -> 'ZZ'`, `702 -> 'AAA'`). Handles 1..3 letters and beyond.
 *
 * @param {number} col 0-based column index; must be a non-negative integer.
 * @returns {string} Uppercase column letters.
 * @throws {RangeError} If `col` is not a non-negative integer.
 */
export function colToLetter(col) {
  if (!Number.isInteger(col) || col < 0) {
    throw new RangeError(`colToLetter: invalid column index ${String(col)}`);
  }
  let n = col;
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

/**
 * Letters -> column index, case-insensitive (`'a' -> 0`, `'AA' -> 26`, `'ZZ' -> 701`,
 * `'AAA' -> 702`). A leading `$` is tolerated and ignored.
 *
 * @param {string} letters 1..3 ASCII letters, optionally `$`-prefixed.
 * @returns {number} 0-based column index.
 * @throws {RangeError} If `letters` is not 1..3 ASCII letters.
 */
export function letterToCol(letters) {
  const raw =
    typeof letters === 'string' && letters.charCodeAt(0) === 36 ? letters.slice(1) : letters;
  if (typeof raw !== 'string' || !/^[A-Za-z]{1,3}$/.test(raw)) {
    throw new RangeError(`letterToCol: invalid column letters ${JSON.stringify(letters)}`);
  }
  const up = raw.toUpperCase();
  let n = 0;
  for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
  return n - 1;
}

/**
 * `(row, col)` -> canonical A1 key (never emits `$`).
 *
 * Deliberately lenient about the upper bound so callers that compute speculative
 * coordinates (grid rendering, fill handles) cannot crash; only negatives and
 * non-integers are rejected.
 *
 * @param {number} row 0-based row index.
 * @param {number} col 0-based column index.
 * @returns {string} e.g. `'A1'`, `'BC42'`.
 * @throws {RangeError} If either coordinate is not a non-negative integer.
 */
export function cellToA1(row, col) {
  if (!Number.isInteger(row) || row < 0) {
    throw new RangeError(`cellToA1: invalid row index ${String(row)}`);
  }
  return colToLetter(col) + String(row + 1);
}

/**
 * Is `name` writable as a sheet qualifier without quotes?
 *
 * @param {unknown} name Candidate sheet name.
 * @returns {boolean} `true` for `'Sheet2'`, `'시트2'`, `'_a1'`; `false` for `'매출 집계'`,
 *   `'2024'`, `''`.
 */
export function isBareSheetName(name) {
  return typeof name === 'string' && BARE_SHEET_RE.test(name);
}

/**
 * Render a sheet name for use in a formula: bare when it can be, single-quoted otherwise,
 * with every inner quote doubled.
 *
 * @param {string} name Sheet name.
 * @returns {string} e.g. `'Sheet2'` -> `Sheet2`, `'매출 집계'` -> `'매출 집계'`,
 *   `"a'b"` -> `'a''b'`.
 */
export function quoteSheetName(name) {
  const s = name === undefined || name === null ? '' : String(name);
  if (isBareSheetName(s)) return s;
  return QUOTE + s.split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
}

/**
 * Split an optional sheet qualifier off the front of a reference.
 *
 * The name is scanned left to right, never by splitting on the last `!`: a quoted name may
 * itself contain `!`, so `'a!b'!A1` refers to the sheet named `a!b`, not to a sheet called
 * `'a`.
 *
 * @param {string} text Reference text, qualified or not.
 * @returns {{sheet:string|null, ref:string}} The sheet name (`null` when unqualified) and
 *   the remaining reference text, which is NOT validated here.
 * @throws {RangeError} On a malformed qualifier: an empty name, an unterminated quote, or a
 *   quoted name that is not followed by `!`.
 */
export function splitSheetRef(text) {
  if (typeof text !== 'string') {
    throw new RangeError(`splitSheetRef: expected a string, got ${typeof text}`);
  }

  if (text[0] === QUOTE) {
    let name = '';
    let i = 1;
    for (;;) {
      if (i >= text.length) {
        throw new RangeError(`splitSheetRef: unterminated sheet name ${JSON.stringify(text)}`);
      }
      const ch = text[i];
      if (ch === QUOTE) {
        if (text[i + 1] === QUOTE) { name += QUOTE; i += 2; continue; } // '' is an escaped quote
        i += 1;
        break;
      }
      name += ch;
      i += 1;
    }
    if (name === '') {
      throw new RangeError(`splitSheetRef: empty sheet name ${JSON.stringify(text)}`);
    }
    if (text[i] !== '!') {
      throw new RangeError(`splitSheetRef: expected '!' after the sheet name ${JSON.stringify(text)}`);
    }
    return { sheet: name, ref: text.slice(i + 1) };
  }

  // A bare name cannot contain '!', so the first one ends the qualifier.
  const bang = text.indexOf('!');
  if (bang < 0) return { sheet: null, ref: text };
  const name = text.slice(0, bang);
  if (name === '') {
    throw new RangeError(`splitSheetRef: empty sheet name ${JSON.stringify(text)}`);
  }
  if (!isBareSheetName(name)) {
    throw new RangeError(`splitSheetRef: invalid sheet name ${JSON.stringify(name)}`);
  }
  return { sheet: name, ref: text.slice(bang + 1) };
}

/**
 * The four coordinate fields of a ref object, without the sheet qualifier. Range endpoints
 * never carry a sheet of their own: the qualifier belongs to the Range.
 *
 * @param {{row:number, col:number, absRow:boolean, absCol:boolean}} c Ref object.
 * @returns {{row:number, col:number, absRow:boolean, absCol:boolean}} A new endpoint.
 */
function endpointOf(c) {
  return { row: c.row, col: c.col, absRow: c.absRow, absCol: c.absCol };
}

/**
 * Parse a single A1 reference, recording the `$` flags and an optional sheet qualifier.
 *
 * @param {string} a1 e.g. `'A1'`, `'$B$3'`, `'b$7'`, `'Sheet2!A1'`, `"'매출 집계'!$A$1"`.
 * @returns {{sheet:string|null, row:number, col:number, absRow:boolean, absCol:boolean}}
 *   Ref object; `sheet` is `null` for an unqualified reference.
 * @throws {RangeError} If the text is malformed, or addresses a cell outside
 *   `MAX_ROWS` / `MAX_COLS`.
 */
export function a1ToCell(a1) {
  if (typeof a1 !== 'string') {
    throw new RangeError(`a1ToCell: expected a string, got ${typeof a1}`);
  }
  const split = splitSheetRef(a1);
  const m = A1_RE.exec(split.ref);
  if (!m) throw new RangeError(`a1ToCell: malformed reference ${JSON.stringify(a1)}`);
  const col = letterToCol(m[2]);
  const row = Number(m[4]) - 1;
  if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) {
    throw new RangeError(`a1ToCell: reference out of bounds ${JSON.stringify(a1)}`);
  }
  return { sheet: split.sheet, row, col, absRow: m[3] === '$', absCol: m[1] === '$' };
}

/**
 * Cheap syntactic test for a single A1 reference. Does not check sheet bounds.
 *
 * @param {unknown} s Candidate text.
 * @returns {boolean} `true` for `'A1'`, `'$B$3'`; `false` for `'A'`, `'1'`, `'A1:B2'`.
 */
export function isA1(s) {
  return typeof s === 'string' && A1_RE.test(s);
}

/**
 * Parse range text into a Range.
 *
 * Accepted forms:
 *  - cell pair:    `'A1:B3'`, `'$A$1:$B$3'`, `'B3:A1'` (kept unnormalized)
 *  - whole column: `'A:A'`, `'$A:$B'`  -> rows `0 .. MAX_ROWS-1`, `wholeCol: true`
 *  - whole row:    `'1:1'`, `'3:7'`    -> cols `0 .. MAX_COLS-1`, `wholeRow: true`
 *  - a bare cell:  `'A1'` -> a 1x1 range (convenience for callers that accept either)
 *
 * Any of those may carry a sheet qualifier (`'Sheet2!A1:B3'`, `"'매출 집계'!A:A"`), which
 * lands on `sheet`; `sheet` is `null` for an unqualified range.
 *
 * @param {string} text Range text.
 * @returns {{sheet:string|null,
 *            s:{row:number,col:number,absRow:boolean,absCol:boolean},
 *            e:{row:number,col:number,absRow:boolean,absCol:boolean},
 *            wholeCol?:true, wholeRow?:true}} Range.
 * @throws {RangeError} On malformed or out-of-bounds text.
 */
export function parseRange(text) {
  if (typeof text !== 'string') {
    throw new RangeError(`parseRange: expected a string, got ${typeof text}`);
  }
  const split = splitSheetRef(text);
  const sheet = split.sheet;
  const body = split.ref;

  const i = body.indexOf(':');
  if (i < 0) {
    const c = endpointOf(a1ToCell(body));
    return { sheet, s: { ...c }, e: { ...c } };
  }
  const left = body.slice(0, i);
  const right = body.slice(i + 1);

  if (A1_RE.test(left) && A1_RE.test(right)) {
    return { sheet, s: endpointOf(a1ToCell(left)), e: endpointOf(a1ToCell(right)) };
  }

  const lc = COL_ONLY_RE.exec(left);
  const rc = COL_ONLY_RE.exec(right);
  if (lc && rc) {
    const c1 = letterToCol(lc[2]);
    const c2 = letterToCol(rc[2]);
    if (c1 >= MAX_COLS || c2 >= MAX_COLS) {
      throw new RangeError(`parseRange: column out of bounds ${JSON.stringify(text)}`);
    }
    return {
      sheet,
      s: { row: 0, col: c1, absRow: false, absCol: lc[1] === '$' },
      e: { row: MAX_ROWS - 1, col: c2, absRow: false, absCol: rc[1] === '$' },
      wholeCol: true,
    };
  }

  const lr = ROW_ONLY_RE.exec(left);
  const rr = ROW_ONLY_RE.exec(right);
  if (lr && rr) {
    const r1 = Number(lr[2]) - 1;
    const r2 = Number(rr[2]) - 1;
    if (r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS) {
      throw new RangeError(`parseRange: row out of bounds ${JSON.stringify(text)}`);
    }
    return {
      sheet,
      s: { row: r1, col: 0, absRow: lr[1] === '$', absCol: false },
      e: { row: r2, col: MAX_COLS - 1, absRow: rr[1] === '$', absCol: false },
      wholeRow: true,
    };
  }

  throw new RangeError(`parseRange: malformed range ${JSON.stringify(text)}`);
}

/**
 * Copy of `range` with `s <= e` on both axes. Each axis is ordered independently and the
 * `$` flag travels with its coordinate. `wholeCol` / `wholeRow` markers are preserved, and
 * so is the sheet qualifier when the input carries one — reordering endpoints must never
 * silently turn a cross-sheet range into a local one.
 *
 * @param {{sheet?:string|null, s:object, e:object, wholeCol?:boolean, wholeRow?:boolean}} range Range.
 * @returns {{sheet?:string|null, s:object, e:object, wholeCol?:true, wholeRow?:true}} A new,
 *   ordered Range.
 */
export function normalizeRange(range) {
  const s = range.s;
  const e = range.e;
  const rowFirst = s.row <= e.row;
  const colFirst = s.col <= e.col;
  const out = {
    s: {
      row: rowFirst ? s.row : e.row,
      col: colFirst ? s.col : e.col,
      absRow: !!(rowFirst ? s.absRow : e.absRow),
      absCol: !!(colFirst ? s.absCol : e.absCol),
    },
    e: {
      row: rowFirst ? e.row : s.row,
      col: colFirst ? e.col : s.col,
      absRow: !!(rowFirst ? e.absRow : s.absRow),
      absCol: !!(colFirst ? e.absCol : s.absCol),
    },
  };
  if (range.sheet !== undefined) out.sheet = range.sheet;
  if (range.wholeCol) out.wholeCol = true;
  if (range.wholeRow) out.wholeRow = true;
  return out;
}

/**
 * Render one ref object, `$` flags included.
 *
 * @param {{row:number, col:number, absRow?:boolean, absCol?:boolean}} r Ref object.
 * @returns {string} e.g. `'$B$3'`.
 */
function refToA1(r) {
  return `${r.absCol ? '$' : ''}${colToLetter(r.col)}${r.absRow ? '$' : ''}${r.row + 1}`;
}

/**
 * Range -> text, preserving `$` flags and whole-column / whole-row shorthand.
 *
 * The sheet qualifier is deliberately NOT emitted: this renders the coordinate label the UI
 * shows for a selection (name box, status bar), which is always about the sheet on screen.
 * Formula text is produced by `serialize()` in parser.js, which does re-emit the qualifier.
 *
 * @param {{s:object, e:object, wholeCol?:boolean, wholeRow?:boolean}} range Range.
 * @returns {string} e.g. `'A1:B3'`, `'$A$1:$B$3'`, `'A:A'`, `'3:7'`.
 */
export function rangeToA1(range) {
  const s = range.s;
  const e = range.e;
  if (range.wholeCol) {
    return `${s.absCol ? '$' : ''}${colToLetter(s.col)}:${e.absCol ? '$' : ''}${colToLetter(e.col)}`;
  }
  if (range.wholeRow) {
    return `${s.absRow ? '$' : ''}${s.row + 1}:${e.absRow ? '$' : ''}${e.row + 1}`;
  }
  return `${refToA1(s)}:${refToA1(e)}`;
}

/**
 * Call `fn(row, col)` for every cell in `range`, row-major. The range is normalized first,
 * so a reversed range still iterates top-left to bottom-right.
 *
 * @param {{s:object, e:object}} range Range.
 * @param {(row:number, col:number) => void} fn Visitor.
 * @returns {undefined} Always `undefined`.
 */
export function iterRange(range, fn) {
  const n = normalizeRange(range);
  for (let r = n.s.row; r <= n.e.row; r++) {
    for (let c = n.s.col; c <= n.e.col; c++) fn(r, c);
  }
  return undefined;
}

/**
 * Materialize a range as canonical A1 keys, row-major.
 *
 * @param {{s:object, e:object}} range Range.
 * @returns {string[]} e.g. `['A1','B1','A2','B2']`.
 * @throws {RangeError} If the range holds more than 200000 cells (e.g. `A:ZZ`).
 */
export function rangeCells(range) {
  const n = normalizeRange(range);
  const rows = n.e.row - n.s.row + 1;
  const cols = n.e.col - n.s.col + 1;
  const total = rows * cols;
  if (total > MAX_RANGE_CELLS) {
    throw new RangeError(`rangeCells: range too large (${total} cells, max ${MAX_RANGE_CELLS})`);
  }
  const out = new Array(total);
  let i = 0;
  for (let r = n.s.row; r <= n.e.row; r++) {
    const rowLabel = String(r + 1);
    for (let c = n.s.col; c <= n.e.col; c++) out[i++] = colToLetter(c) + rowLabel;
  }
  return out;
}

/**
 * Inclusive dimensions of a range.
 *
 * @param {{s:object, e:object}} range Range.
 * @returns {{rows:number, cols:number}} Height and width, both >= 1.
 */
export function rangeSize(range) {
  const n = normalizeRange(range);
  return { rows: n.e.row - n.s.row + 1, cols: n.e.col - n.s.col + 1 };
}

/**
 * Does a range cover a cell? Used by the engine to invalidate range formulas when a
 * currently-blank cell inside the range is written.
 *
 * @param {{s:object, e:object}} range Range.
 * @param {number} row 0-based row index.
 * @param {number} col 0-based column index.
 * @returns {boolean} `true` when `(row, col)` lies inside the (normalized) range.
 */
export function containsCell(range, row, col) {
  const n = normalizeRange(range);
  return row >= n.s.row && row <= n.e.row && col >= n.s.col && col <= n.e.col;
}

/**
 * Copy/paste translation: shift a ref by a delta. An axis marked absolute (`$`) is left
 * alone; only the relative axes move.
 *
 * @param {{row:number, col:number, absRow?:boolean, absCol?:boolean}} refObj Source ref.
 * @param {number} dRow Row delta (may be negative).
 * @param {number} dCol Column delta (may be negative).
 * @returns {{row:number,col:number,absRow:boolean,absCol:boolean}|{oob:true}} A NEW ref
 *   object, or `{oob:true}` when the result falls off the sheet (renders as `#REF!`).
 */
export function offsetRef(refObj, dRow, dCol) {
  const dr = Number.isFinite(dRow) ? Math.trunc(dRow) : 0;
  const dc = Number.isFinite(dCol) ? Math.trunc(dCol) : 0;
  const absRow = !!refObj.absRow;
  const absCol = !!refObj.absCol;
  const row = absRow ? refObj.row : refObj.row + dr;
  const col = absCol ? refObj.col : refObj.col + dc;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return { oob: true };
  if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) return { oob: true };
  return { row, col, absRow, absCol };
}

/**
 * Row/column insert-delete translation.
 *
 * Unlike copy/paste, a structural edit physically relocates cells, so BOTH relative and
 * absolute refs move. A ref that sat inside a deleted band no longer has a target and
 * becomes `{oob:true}` (rendered as `#REF!`).
 *
 * An insert never pushes a ref off the sheet: a coordinate that would overflow clamps to
 * the last row / column. That keeps the sentinel endpoint of whole-column (`A:A`) and
 * whole-row (`1:1`) ranges valid, which would otherwise turn every such range into
 * `#REF!` on any insert.
 *
 * A malformed or unrecognized `edit` leaves the ref untouched rather than throwing, so a
 * hostile websocket frame cannot crash a recalc.
 *
 * @param {{row:number, col:number, absRow?:boolean, absCol?:boolean}} refObj Source ref.
 * @param {{kind:'insertRow'|'deleteRow'|'insertCol'|'deleteCol', index:number, count?:number}} edit
 *   The structural edit; `index` is the 0-based band start, `count` defaults to 1.
 * @returns {{row:number,col:number,absRow:boolean,absCol:boolean}|{oob:true}} A NEW ref
 *   object, or `{oob:true}`.
 */
export function shiftRefForStructuralEdit(refObj, edit) {
  const base = {
    row: refObj.row,
    col: refObj.col,
    absRow: !!refObj.absRow,
    absCol: !!refObj.absCol,
  };
  if (!edit || typeof edit !== 'object') return base;
  const index = Number(edit.index);
  if (!Number.isInteger(index) || index < 0) return base;
  const count = Number.isFinite(edit.count) ? Math.trunc(edit.count) : 1;
  if (count < 1) return base;

  switch (edit.kind) {
    case 'insertRow': return shiftAxis(base, 'row', index, count, true, MAX_ROWS);
    case 'deleteRow': return shiftAxis(base, 'row', index, count, false, MAX_ROWS);
    case 'insertCol': return shiftAxis(base, 'col', index, count, true, MAX_COLS);
    case 'deleteCol': return shiftAxis(base, 'col', index, count, false, MAX_COLS);
    default: return base;
  }
}

/**
 * One-axis implementation of {@link shiftRefForStructuralEdit}.
 *
 * @param {{row:number,col:number,absRow:boolean,absCol:boolean}} base Ref copy to shift.
 * @param {'row'|'col'} axis Which coordinate moves.
 * @param {number} index Band start (0-based).
 * @param {number} count Band size (>= 1).
 * @param {boolean} inserting `true` for insert, `false` for delete.
 * @param {number} max Axis limit (`MAX_ROWS` or `MAX_COLS`).
 * @returns {{row:number,col:number,absRow:boolean,absCol:boolean}|{oob:true}} Result.
 */
function shiftAxis(base, axis, index, count, inserting, max) {
  const v = base[axis];
  if (!Number.isInteger(v)) return { oob: true };

  if (inserting) {
    if (v < index) return base;
    const moved = v + count;
    return { ...base, [axis]: moved >= max ? max - 1 : moved }; // clamp, never fall off
  }

  if (v < index) return base;
  if (v < index + count) return { oob: true }; // sat inside the deleted band
  return { ...base, [axis]: v - count };
}
