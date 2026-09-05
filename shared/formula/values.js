/**
 * @file The spreadsheet value domain and every coercion between its members.
 *
 * A value is one of:
 *   `number | string | boolean | null | FormulaError | RangeValue`
 * where `null` means "blank cell" (never `''`, never `undefined`).
 *
 * Coercions never throw: a bad conversion returns a {@link FormulaError} value, which the
 * caller propagates. Numbers are always finite -- `NaN` and `+/-Infinity` are reported as
 * `#NUM!`, matching what a spreadsheet shows.
 *
 * Pure ESM, no Node builtins, no browser globals.
 */

import { ERR, FormulaError, err } from './errors.js';

/**
 * @typedef {number|string|boolean|null|FormulaError|RangeValue} Value
 *   One member of the spreadsheet value domain.
 */

/** Milliseconds in one day; the unit of the serial-date fraction. */
const MS_PER_DAY = 86400000;

/**
 * Strings accepted by {@link toNumber}: an optional sign, digits with an optional decimal
 * part, and an optional exponent. Grouping separators (`'1,234'`) are deliberately NOT
 * accepted -- they are locale-dependent and Excel rejects them in arithmetic too.
 */
const NUMERIC_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/**
 * A rectangular block of values, produced whenever a range node is evaluated.
 *
 * Stored row-major: `rows[r][c]`. Blank cells inside the block are `null`.
 */
export class RangeValue {
  /**
   * @param {Value[][]} rows 2D, row-major. A row that is not an array is wrapped, so a
   *   flat array degrades gracefully into a single column instead of corrupting indexing.
   */
  constructor(rows) {
    /** @type {Value[][]} The backing grid, row-major. */
    this.rows = Array.isArray(rows) ? rows.map((r) => (Array.isArray(r) ? r : [r])) : [];
  }

  /**
   * Number of rows in the block.
   * @returns {number} Height, `0` for an empty block.
   */
  get height() {
    return this.rows.length;
  }

  /**
   * Number of columns in the block (the widest row, for robustness against ragged input).
   * @returns {number} Width, `0` for an empty block.
   */
  get width() {
    let w = 0;
    for (const r of this.rows) if (r.length > w) w = r.length;
    return w;
  }

  /**
   * All cells in row-major order, blanks included.
   * @returns {Value[]} A new flat array.
   */
  flat() {
    const out = [];
    for (const r of this.rows) for (const v of r) out.push(v);
    return out;
  }

  /**
   * Only the numeric cells, in row-major order. Blanks, text, booleans and errors inside a
   * range are skipped -- these are Excel's SUM/AVERAGE semantics, where text and logicals
   * count only when passed as direct arguments, not when they sit inside a range.
   * @returns {number[]} Finite numbers.
   */
  numbers() {
    const out = [];
    for (const r of this.rows) {
      for (const v of r) if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  /**
   * The first error in the block, scanning row-major.
   * @returns {FormulaError|null} The error, or `null` when the block holds none.
   */
  firstError() {
    for (const r of this.rows) {
      for (const v of r) if (v instanceof FormulaError) return v;
    }
    return null;
  }
}

/**
 * Top-left cell of a block, used wherever a range appears in scalar position.
 *
 * @param {RangeValue} rv Block.
 * @returns {Value} The top-left value, or `#VALUE!` when the block is empty.
 */
function firstCellOf(rv) {
  const rows = rv.rows;
  if (rows.length === 0 || rows[0].length === 0) return err(ERR.VALUE, 'empty range');
  return rows[0][0];
}

/**
 * Render a finite number with its shortest round-trip decimal form.
 *
 * `String(n)` is already shortest-round-trip in JS; the trailing-zero strip is a guard
 * against `'1.0'`-style artifacts arriving from other formatting paths, and `-0` is
 * normalized to `'0'`.
 *
 * @param {number} n Number.
 * @returns {string|FormulaError} Text, or `#NUM!` for a non-finite number.
 */
function numberToText(n) {
  if (!Number.isFinite(n)) return err(ERR.NUM, 'not a finite number');
  if (Object.is(n, -0)) return '0';
  let s = String(n);
  if (/\.[0-9]*0+$/.test(s)) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/**
 * Coerce to a number.
 *
 * `null` -> `0`; `true` -> `1`; `false` -> `0`; a numeric string (surrounding whitespace
 * allowed, `''` -> `0`) -> its number; a `Date` -> its serial; a {@link RangeValue} -> its
 * top-left cell; a {@link FormulaError} passes through untouched.
 *
 * @param {Value|Date} v Any value.
 * @returns {number|FormulaError} A finite number, or an error value.
 */
export function toNumber(v) {
  if (v instanceof FormulaError) return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : err(ERR.NUM, 'not a finite number');
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0;
    if (!NUMERIC_RE.test(t)) return err(ERR.VALUE, `${JSON.stringify(v)} is not a number`);
    const n = Number(t);
    return Number.isFinite(n) ? n : err(ERR.NUM, 'not a finite number');
  }
  if (v instanceof RangeValue) {
    const c = firstCellOf(v);
    return c instanceof FormulaError ? c : toNumber(c);
  }
  if (v instanceof Date) {
    const s = dateToSerial(v);
    return Number.isFinite(s) ? s : err(ERR.VALUE, 'invalid date');
  }
  return err(ERR.VALUE, 'unsupported value');
}

/**
 * Coerce to text.
 *
 * `null` -> `''`; booleans -> `'TRUE'` / `'FALSE'`; numbers -> shortest round-trip form;
 * a {@link RangeValue} -> its top-left cell; a {@link FormulaError} passes through.
 *
 * @param {Value|Date} v Any value.
 * @returns {string|FormulaError} Text, or an error value.
 */
export function toText(v) {
  if (v instanceof FormulaError) return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberToText(v);
  if (v instanceof RangeValue) {
    const c = firstCellOf(v);
    return c instanceof FormulaError ? c : toText(c);
  }
  if (v instanceof Date) return numberToText(dateToSerial(v));
  return err(ERR.VALUE, 'unsupported value');
}

/**
 * Coerce to a boolean.
 *
 * `null` -> `false`; `0` -> `false`; any other number -> `true`; the strings `'TRUE'` and
 * `'FALSE'` (case-insensitive, surrounding whitespace allowed) -> their boolean; any other
 * string -> `#VALUE!` (a numeric string is NOT coerced, matching Excel). A
 * {@link RangeValue} uses its top-left cell; a {@link FormulaError} passes through.
 *
 * @param {Value} v Any value.
 * @returns {boolean|FormulaError} A boolean, or an error value.
 */
export function toBool(v) {
  if (v instanceof FormulaError) return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return err(ERR.NUM, 'not a finite number');
    return v !== 0;
  }
  if (typeof v === 'string') {
    const t = v.trim().toUpperCase();
    if (t === 'TRUE') return true;
    if (t === 'FALSE') return false;
    return err(ERR.VALUE, `${JSON.stringify(v)} is not a boolean`);
  }
  if (v instanceof RangeValue) {
    const c = firstCellOf(v);
    return c instanceof FormulaError ? c : toBool(c);
  }
  return err(ERR.VALUE, 'unsupported value');
}

/**
 * Type rank for cross-type ordering: number < string < boolean (Excel's rule).
 *
 * @param {Value} v A scalar value (never `null`, never a range, never an error).
 * @returns {number} `0` number, `1` string, `2` boolean, `3` anything else.
 */
function rankOf(v) {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

/**
 * The value a blank takes on when compared against `other`: `0` against a number, `''`
 * against text, `false` against a boolean.
 *
 * @param {Value} other The other operand.
 * @returns {number|string|boolean} The stand-in for the blank.
 */
function blankLike(other) {
  if (typeof other === 'string') return '';
  if (typeof other === 'boolean') return false;
  return 0;
}

/**
 * Three-way comparison used by `<`, `<=`, `>`, `>=` and by sorting helpers.
 *
 * Ordering across types is Excel's: every number sorts before every string, and every
 * string before every boolean. Same-type comparison is numeric for numbers,
 * case-insensitive (code-unit, locale independent so Node and the browser agree) for
 * strings, and `false < true` for booleans. A blank adopts the other operand's type.
 *
 * @param {Value} a Left operand.
 * @param {Value} b Right operand.
 * @returns {-1|0|1|FormulaError} Ordering, or the first error encountered.
 */
export function compareValues(a, b) {
  if (a instanceof FormulaError) return a;
  if (b instanceof FormulaError) return b;

  let x = a instanceof RangeValue ? firstCellOf(a) : a;
  let y = b instanceof RangeValue ? firstCellOf(b) : b;
  if (x instanceof FormulaError) return x;
  if (y instanceof FormulaError) return y;
  if (x instanceof Date) x = dateToSerial(x);
  if (y instanceof Date) y = dateToSerial(y);
  if (x === undefined) x = null;
  if (y === undefined) y = null;

  if (x === null && y === null) return 0;
  if (x === null) x = blankLike(y);
  if (y === null) y = blankLike(x);

  const rx = rankOf(x);
  const ry = rankOf(y);
  if (rx === 3 || ry === 3) return err(ERR.VALUE, 'value is not comparable');
  if (rx !== ry) return rx < ry ? -1 : 1;

  if (rx === 0) return x < y ? -1 : x > y ? 1 : 0;
  if (rx === 1) {
    const lx = x.toLowerCase();
    const ly = y.toLowerCase();
    return lx < ly ? -1 : lx > ly ? 1 : 0;
  }
  return x === y ? 0 : x ? 1 : -1;
}

/**
 * Expand every {@link RangeValue} (and any nested plain array) in an argument list into a
 * single flat list of scalars, row-major. Used by the aggregate functions.
 *
 * @param {Value[]} args Argument values.
 * @returns {Value[]} A new flat array of scalars.
 */
export function flattenArgs(args) {
  const out = [];
  const push = (v) => {
    if (v instanceof RangeValue) {
      for (const row of v.rows) for (const cell of row) out.push(cell);
    } else if (Array.isArray(v)) {
      for (const item of v) push(item);
    } else {
      out.push(v === undefined ? null : v);
    }
  };
  for (const a of args || []) push(a);
  return out;
}

/**
 * The first error anywhere in an argument list, ranges and nested arrays included.
 * Most eager functions call this before doing any work; `ISERROR`, `IFERROR` and `COUNT`
 * deliberately do not.
 *
 * @param {Value[]} args Argument values.
 * @returns {FormulaError|null} The first error, or `null`.
 */
export function firstErrorIn(args) {
  for (const a of args || []) {
    if (a instanceof FormulaError) return a;
    if (a instanceof RangeValue) {
      const e = a.firstError();
      if (e) return e;
    } else if (Array.isArray(a)) {
      const e = firstErrorIn(a);
      if (e) return e;
    }
  }
  return null;
}

/**
 * Equality with `=` operator semantics: strings compare case-insensitively, a blank equals
 * `0` and equals `''`, and booleans compare only against booleans (so `TRUE = 1` is
 * false). Errors are equal only to an error with the same code; an error compared against
 * a non-error is `false` (the evaluator normally propagates errors before reaching here).
 *
 * @param {Value} a Left operand.
 * @param {Value} b Right operand.
 * @returns {boolean} `true` when the two values are loosely equal.
 */
export function equalsLoose(a, b) {
  if (a instanceof FormulaError || b instanceof FormulaError) {
    return a instanceof FormulaError && b instanceof FormulaError && a.code === b.code;
  }

  let x = a instanceof RangeValue ? (a.rows.length && a.rows[0].length ? a.rows[0][0] : null) : a;
  let y = b instanceof RangeValue ? (b.rows.length && b.rows[0].length ? b.rows[0][0] : null) : b;
  if (x instanceof FormulaError || y instanceof FormulaError) {
    return x instanceof FormulaError && y instanceof FormulaError && x.code === y.code;
  }
  if (x instanceof Date) x = dateToSerial(x);
  if (y instanceof Date) y = dateToSerial(y);
  if (x === undefined) x = null;
  if (y === undefined) y = null;

  if (x === null && y === null) return true;
  if (x === null) return y === 0 || y === '';
  if (y === null) return x === 0 || x === '';

  if (typeof x === 'string' && typeof y === 'string') return x.toLowerCase() === y.toLowerCase();
  if (typeof x === 'boolean' || typeof y === 'boolean') {
    return typeof x === 'boolean' && typeof y === 'boolean' && x === y;
  }
  return x === y;
}

/**
 * Day 0 of the serial-date system, 1899-12-30 UTC -- the Google-Sheets epoch, and the one
 * that makes every date from 1900-03-01 onward agree with Excel (whose own epoch is one day
 * earlier but which counts a phantom 1900-02-29). 2024-01-01 is serial 45292 in all three.
 * @type {number}
 */
export const EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * `Date` -> serial number. Whole UTC days convert exactly; a time of day becomes the
 * fractional part (noon -> `.5`). All arithmetic is in UTC, so serials never shift with
 * the viewer's time zone.
 *
 * @param {Date|number} d A `Date`, or a serial that is returned unchanged.
 * @returns {number} The serial, or `NaN` for an invalid date.
 */
export function dateToSerial(d) {
  if (typeof d === 'number') return d;
  const t = d instanceof Date ? d.getTime() : NaN;
  if (!Number.isFinite(t)) return NaN;
  return (t - EPOCH_MS) / MS_PER_DAY;
}

/**
 * Serial number -> `Date` (UTC). Inverse of {@link dateToSerial}: whole days round-trip
 * exactly, and the fractional part is rounded to the nearest millisecond so binary
 * floating point cannot shave a millisecond off a time of day.
 *
 * @param {number} n Serial number; may be fractional or negative.
 * @returns {Date} A `Date`, or an invalid `Date` when `n` is not a finite number.
 */
export function serialToDate(n) {
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return new Date(NaN);
  return new Date(EPOCH_MS + Math.round(num * MS_PER_DAY));
}
