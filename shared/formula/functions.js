/**
 * @file The 시트지 function library.
 *
 * Every entry of {@link FUNCTIONS} is `{ minArgs, maxArgs, lazy?, volatile?, fn }`.
 *
 *  - **Eager** (`lazy` falsy): `fn(args, ctx)` receives already-evaluated values
 *    (`number | string | boolean | null | FormulaError | RangeValue`). The evaluator does
 *    NOT short-circuit errors, so each `fn` decides for itself whether to propagate them.
 *  - **Lazy** (`lazy: true`): `fn(nodes, ctx)` receives raw AST nodes and evaluates what it
 *    needs with `ctx.evalNode(node)`.
 *
 * `ctx` is `{ evalNode(node), getCell(row, col), getRangeValue(range), cell:{row,col}, now }`.
 * `ctx.now` is fixed for a whole recalc pass so `NOW()` is stable within it.
 *
 * Arity is enforced by the evaluator before `fn` runs; the guards here are for robustness
 * only. Pure ESM: no Node builtins, no browser globals, no dependencies.
 */

import { ERR, err, isError } from './errors.js';
import {
  RangeValue,
  toNumber,
  toText,
  toBool,
  compareValues,
  flattenArgs,
  firstErrorIn,
  equalsLoose,
  dateToSerial,
  serialToDate,
} from './values.js';
import { MAX_ROWS, MAX_COLS, isA1, a1ToCell, parseRange, normalizeRange } from './refs.js';

/* ================================================================== *
 * Shared helpers
 * ================================================================== */

const HAS_OWN = Object.prototype.hasOwnProperty;

/** Excel's per-cell text limit; REPT and friends refuse to exceed it. */
const MAX_TEXT = 32767;

/** Seconds in one day, the denominator of the serial-date fraction. */
const SECONDS_PER_DAY = 86400;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * True when `v` looks like an AST node rather than an evaluated value. Lazy functions use
 * this so they keep working even if they are handed evaluated values.
 *
 * @param {*} v Anything.
 * @returns {boolean} `true` for an AST node.
 */
function isNode(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.type === 'string' &&
    !(v instanceof RangeValue) &&
    !isError(v)
  );
}

/**
 * True for the `{type:'blank'}` node produced by an empty argument slot.
 * @param {*} v Anything.
 * @returns {boolean} `true` for a blank node.
 */
function isBlankNode(v) {
  return isNode(v) && v.type === 'blank';
}

/**
 * Evaluate one lazy argument. Missing and blank slots become `null`; an already-evaluated
 * value is passed straight through.
 *
 * @param {*} node AST node (or value).
 * @param {object} ctx Evaluation context.
 * @returns {*} The value.
 */
function ev(node, ctx) {
  if (node === undefined || node === null) return null;
  if (!isNode(node)) return node;
  if (node.type === 'blank') return null;
  return ctx.evalNode(node);
}

/**
 * Scalar view of a value: a {@link RangeValue} collapses to its top-left cell.
 * @param {*} v Any value.
 * @returns {*} A scalar value.
 */
function scalarOf(v) {
  if (v instanceof RangeValue) {
    const row = v.rows.length ? v.rows[0] : null;
    const cell = row && row.length ? row[0] : null;
    return cell === undefined ? null : cell;
  }
  return v === undefined ? null : v;
}

/**
 * Wrap any value as a {@link RangeValue} so grid-shaped code can stay uniform.
 * @param {*} v Any value.
 * @returns {RangeValue} `v` itself when it is already a block, else a 1x1 block.
 */
function asRange(v) {
  if (v instanceof RangeValue) return v;
  return new RangeValue([[v === undefined ? null : v]]);
}

/** @param {*} v Value. @returns {number|import('./errors.js').FormulaError} Number or error. */
function num(v) {
  return toNumber(scalarOf(v));
}

/** @param {*} v Value. @returns {number|import('./errors.js').FormulaError} Truncated number or error. */
function int(v) {
  const x = num(v);
  return isError(x) ? x : Math.trunc(x);
}

/** @param {*} v Value. @returns {string|import('./errors.js').FormulaError} Text or error. */
function str(v) {
  return toText(scalarOf(v));
}

/** @param {*} v Value. @returns {boolean|import('./errors.js').FormulaError} Boolean or error. */
function bool(v) {
  return toBool(scalarOf(v));
}

/**
 * Collect numeric operands for the aggregate math functions: cells inside a range
 * contribute only real numbers, while scalar arguments are coerced (so `SUM("3", TRUE)`
 * is 4). Any error -- direct or inside a range -- aborts.
 *
 * @param {*[]} args Argument values.
 * @returns {number[]|import('./errors.js').FormulaError} Numbers, or the first error.
 */
function numberList(args) {
  const out = [];
  for (const a of args) {
    if (isError(a)) return a;
    if (a instanceof RangeValue) {
      const e = a.firstError();
      if (e) return e;
      const ns = a.numbers();
      for (let i = 0; i < ns.length; i++) out.push(ns[i]);
      continue;
    }
    if (a === null || a === undefined) continue;
    if (typeof a === 'number') {
      if (!Number.isFinite(a)) return err(ERR.NUM, 'not a finite number');
      out.push(a);
      continue;
    }
    if (typeof a === 'boolean') {
      out.push(a ? 1 : 0);
      continue;
    }
    const x = toNumber(a);
    if (isError(x)) return x;
    out.push(x);
  }
  return out;
}

/**
 * AVERAGEA-style collection: text counts as `0`, logicals as `1`/`0`, blanks are skipped.
 *
 * @param {*[]} args Argument values.
 * @returns {number[]|import('./errors.js').FormulaError} Numbers, or the first error.
 */
function numberListA(args) {
  const out = [];
  for (const v of flattenArgs(args)) {
    if (isError(v)) return v;
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'boolean') out.push(v ? 1 : 0);
    else out.push(0);
  }
  return out;
}

/** @param {number[]} list Numbers. @returns {number} Their sum. */
function sumOf(list) {
  let s = 0;
  for (let i = 0; i < list.length; i++) s += list[i];
  return s;
}

/** @param {number[]} list Numbers. @returns {number} Their arithmetic mean. */
function meanOf(list) {
  return sumOf(list) / list.length;
}

/**
 * Sample (`n-1`) or population (`n`) variance.
 *
 * @param {number[]} list Numbers.
 * @param {boolean} sample `true` for the sample estimator.
 * @returns {number|import('./errors.js').FormulaError} Variance, or `#DIV/0!`.
 */
function variance(list, sample) {
  const n = list.length;
  if (sample ? n < 2 : n < 1) return err(ERR.DIV0, 'not enough data points');
  const mu = meanOf(list);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = list[i] - mu;
    acc += d * d;
  }
  return acc / (sample ? n - 1 : n);
}

/**
 * Strip binary floating-point noise before a rounding decision
 * (`267.49999999999997` -> `267.5`).
 *
 * @param {number} x Number.
 * @returns {number} `x` rounded to 15 significant digits.
 */
function clean(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number(x.toPrecision(15));
}

/**
 * Multiply by a power of ten through the decimal string form, avoiding the error that
 * `x * 10 ** n` introduces.
 *
 * @param {number} x Number.
 * @param {number} exp Power of ten.
 * @returns {number} `x * 10 ** exp`.
 */
function shiftExp(x, exp) {
  if (x === 0 || !Number.isFinite(x)) return x;
  const parts = String(x).split('e');
  const mantissa = parts[0];
  const e = parts.length > 1 ? Number(parts[1]) : 0;
  return Number(mantissa + 'e' + (e + exp));
}

/**
 * Round to a number of decimals using one of the three spreadsheet modes.
 *
 * @param {number} x Value.
 * @param {number} digits Decimal places (may be negative).
 * @param {'half'|'up'|'down'} mode `'half'` rounds halves away from zero, `'up'` always
 *   away from zero, `'down'` always toward zero.
 * @returns {number} The rounded value.
 */
function roundMode(x, digits, mode) {
  if (!Number.isFinite(x) || x === 0) return x;
  const sign = x < 0 ? -1 : 1;
  const shifted = clean(shiftExp(Math.abs(x), digits));
  let r;
  if (mode === 'up') r = Math.ceil(shifted);
  else if (mode === 'down') r = Math.floor(shifted);
  else r = Math.round(shifted);
  return sign * shiftExp(r, -digits);
}

/** @param {number} a First. @param {number} b Second. @returns {number} Greatest common divisor. */
function gcd2(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Build a Range literal in the shape refs.js uses.
 *
 * @param {number} r0 Start row. @param {number} c0 Start column.
 * @param {number} r1 End row.   @param {number} c1 End column.
 * @returns {{s:object,e:object}} The range.
 */
function mkRange(r0, c0, r1, c1) {
  return {
    s: { row: r0, col: c0, absRow: false, absCol: false },
    e: { row: r1, col: c1, absRow: false, absCol: false },
  };
}

/** @param {number} n Number. @param {number} width Digits. @returns {string} Zero-padded text. */
function pad(n, width) {
  let s = String(Math.abs(Math.trunc(n)));
  while (s.length < width) s = '0' + s;
  return n < 0 ? '-' + s : s;
}

/** @param {string} s Text. @returns {string} `s` with every regex metacharacter escaped. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ================================================================== *
 * Criteria matching -- COUNTIF / COUNTIFS / SUMIF(S) / AVERAGEIF(S)
 * ================================================================== */

/**
 * True when the pattern needs wildcard-aware matching: it holds either a live `*`/`?` or a
 * `~` escape, which must be stripped before the text is compared.
 *
 * @param {string} s Pattern.
 * @returns {boolean} `true` when the pattern is not a plain literal.
 */
function hasWildcard(s) {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '~') {
      const next = s[i + 1];
      if (next === '*' || next === '?' || next === '~') return true;
      continue;
    }
    if (ch === '*' || ch === '?') return true;
  }
  return false;
}

/**
 * Translate an Excel wildcard pattern into regex source. `*` is any run of characters,
 * `?` is exactly one, and `~` escapes the next `*`, `?` or `~`.
 *
 * @param {string} pattern Wildcard pattern.
 * @returns {string} Unanchored regex source.
 */
function wildcardBody(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~') {
      const next = pattern[i + 1];
      if (next === '*' || next === '?' || next === '~') {
        out += escapeRe(next);
        i++;
      } else {
        out += '~';
      }
    } else if (ch === '*') {
      out += '[\\s\\S]*';
    } else if (ch === '?') {
      out += '[\\s\\S]';
    } else {
      out += escapeRe(ch);
    }
  }
  return out;
}

/**
 * Anchored {@link RegExp} for a wildcard pattern.
 * @param {string} pattern Wildcard pattern.
 * @param {string} [flags] Regex flags.
 * @returns {RegExp} The compiled matcher.
 */
function wildcardToRegExp(pattern, flags) {
  return new RegExp('^' + wildcardBody(pattern) + '$', flags);
}

/**
 * Give the operand half of a criteria string a type: `'TRUE'`/`'FALSE'` become booleans,
 * anything fully numeric becomes a number, everything else stays text.
 *
 * @param {string} s Operand text.
 * @returns {string|number|boolean} The typed operand.
 */
function coerceOperand(s) {
  const t = s.trim();
  if (t === '') return '';
  const up = t.toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  if (/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(t)) return Number(t);
  return s;
}

/**
 * Equality half of criteria matching, including wildcards for text operands.
 *
 * @param {*} val Cell value.
 * @param {string|number|boolean} operand Typed operand.
 * @param {string} [raw] Original operand text, used for wildcard matching.
 * @returns {boolean} `true` on a match.
 */
function criteriaEquals(val, operand, raw) {
  if (isError(val)) return false;
  if (typeof operand === 'string') {
    if (operand === '') return val === null || val === '';
    const pattern = raw === undefined ? operand : raw;
    if (hasWildcard(pattern)) {
      if (typeof val !== 'string') return false;
      return wildcardToRegExp(pattern, 'i').test(val);
    }
    if (typeof val === 'string') return val.toUpperCase() === operand.toUpperCase();
    return false;
  }
  if (typeof operand === 'number') {
    if (typeof val === 'number') return val === operand;
    if (typeof val === 'string') {
      const t = val.trim();
      if (t === '') return false;
      const n = Number(t);
      return Number.isFinite(n) && n === operand;
    }
    return false;
  }
  if (typeof operand === 'boolean') return typeof val === 'boolean' && val === operand;
  return val === null || val === '';
}

/**
 * Ordering half of criteria matching. Unlike the `<` operator this refuses to compare
 * across types -- text never satisfies `">5"` -- so it returns `null` for "not comparable".
 *
 * @param {*} val Cell value.
 * @param {string|number|boolean} operand Typed operand.
 * @returns {-1|0|1|null} Ordering, or `null` when the two are not comparable.
 */
function criteriaCompare(val, operand) {
  if (isError(val)) return null;
  if (typeof operand === 'number') {
    let v = val;
    if (typeof v === 'string') {
      const t = v.trim();
      const n = t === '' ? NaN : Number(t);
      if (!Number.isFinite(n)) return null;
      v = n;
    }
    if (typeof v !== 'number') return null;
    return v < operand ? -1 : v > operand ? 1 : 0;
  }
  if (typeof operand === 'boolean') {
    if (typeof val !== 'boolean') return null;
    const a = val ? 1 : 0;
    const b = operand ? 1 : 0;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof val !== 'string') return null;
  const a = val.toUpperCase();
  const b = String(operand).toUpperCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Test one value against one spreadsheet criteria expression.
 *
 * Supports `">5"`, `">=5"`, `"<5"`, `"<=5"`, `"<>x"`, `"=x"`, bare equality, and the `*`
 * and `?` wildcards (escaped with `~`). Numbers and booleans may be passed directly.
 *
 * @param {*} value The cell value under test.
 * @param {*} criteria The criteria value or expression.
 * @returns {boolean} `true` when the value satisfies the criteria.
 */
export function matchesCriteria(value, criteria) {
  const crit = scalarOf(criteria);
  const val = scalarOf(value);

  if (isError(crit)) return isError(val) && val.code === crit.code;
  if (crit === null) return val === null || val === '';
  if (typeof crit === 'number') return criteriaEquals(val, crit);
  if (typeof crit === 'boolean') return criteriaEquals(val, crit);

  const text = String(crit);
  const m = /^(<=|>=|<>|=|<|>)/.exec(text);
  if (!m) return criteriaEquals(val, coerceOperand(text), text);

  const op = m[1];
  const rest = text.slice(op.length);
  const operand = coerceOperand(rest);
  if (op === '=') return criteriaEquals(val, operand, rest);
  if (op === '<>') return !criteriaEquals(val, operand, rest);

  const c = criteriaCompare(val, operand);
  if (c === null) return false;
  if (op === '<') return c < 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  return c >= 0;
}

/**
 * Walk a criteria range, calling `visit(rowIndex, colIndex)` for every position that
 * satisfies every `(range, criteria)` pair.
 *
 * @param {*[]} pairs Flat list `[range1, crit1, range2, crit2, ...]`.
 * @param {(r:number,c:number)=>void} visit Called for each matching position.
 * @returns {import('./errors.js').FormulaError|null} An error when the ranges disagree in
 *   shape, else `null`.
 */
function forEachMatch(pairs, visit) {
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    return err(ERR.VALUE, 'criteria must come in range/criteria pairs');
  }
  const ranges = [];
  const criteria = [];
  for (let i = 0; i < pairs.length; i += 2) {
    ranges.push(asRange(pairs[i]));
    criteria.push(pairs[i + 1]);
  }
  const height = ranges[0].height;
  const width = ranges[0].width;
  for (const r of ranges) {
    if (r.height !== height || r.width !== width) {
      return err(ERR.VALUE, 'criteria ranges must all have the same size');
    }
  }
  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      let ok = true;
      for (let k = 0; k < ranges.length; k++) {
        const row = ranges[k].rows[i];
        const cell = row ? row[j] : null;
        if (!matchesCriteria(cell === undefined ? null : cell, criteria[k])) {
          ok = false;
          break;
        }
      }
      if (ok) visit(i, j);
    }
  }
  return null;
}

/* ================================================================== *
 * Lookup helpers
 * ================================================================== */

/**
 * Locate a key in a one-dimensional list.
 *
 * @param {*[]} list Candidate values in sheet order.
 * @param {*} key The value being looked up.
 * @param {0|1|-1} mode `0` exact (wildcards honoured for text keys), `1` largest value
 *   `<= key` assuming ascending order, `-1` smallest value `>= key` assuming descending.
 * @returns {number} 0-based index, or `-1` when there is no match.
 */
function lookupIndex(list, key, mode) {
  if (mode === 0) {
    const wild = typeof key === 'string' && hasWildcard(key);
    const re = wild ? wildcardToRegExp(key, 'i') : null;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (wild) {
        if (typeof v === 'string' && re.test(v)) return i;
        continue;
      }
      if (isError(v)) continue;
      if (equalsLoose(v, key) === true) return i;
    }
    return -1;
  }
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    // Blanks and errors are simply not candidates; they must not stop the scan either,
    // because a sorted lookup column commonly ends in blank cells.
    if (v === null || v === undefined || isError(v)) continue;
    const c = compareValues(v, key);
    if (isError(c)) continue;
    if (mode === 1) {
      if (c <= 0) best = i;
      else break;
    } else if (c >= 0) best = i;
    else break;
  }
  return best;
}

/**
 * Read one column out of a block.
 * @param {RangeValue} rv Block.
 * @param {number} c 0-based column index.
 * @returns {*[]} The column, top to bottom.
 */
function columnOf(rv, c) {
  const out = [];
  for (const row of rv.rows) out.push(row[c] === undefined ? null : row[c]);
  return out;
}

/**
 * Read one row out of a block.
 * @param {RangeValue} rv Block.
 * @param {number} r 0-based row index.
 * @returns {*[]} The row, left to right.
 */
function rowOf(rv, r) {
  const row = rv.rows[r] || [];
  const out = [];
  for (let c = 0; c < rv.width; c++) out.push(row[c] === undefined ? null : row[c]);
  return out;
}

/**
 * Turn the first argument of `OFFSET` into a Range. Only literal `ref` and `range` nodes
 * carry the positional information a reference argument needs.
 *
 * @param {*} node AST node.
 * @param {object} ctx Evaluation context.
 * @returns {{s:object,e:object}|import('./errors.js').FormulaError} The range or `#REF!`.
 */
function nodeToRange(node, ctx) {
  if (isNode(node)) {
    if (node.type === 'ref') return mkRange(node.row, node.col, node.row, node.col);
    if (node.type === 'range') {
      const r = normalizeRange({ s: { ...node.s }, e: { ...node.e } });
      return mkRange(r.s.row, r.s.col, r.e.row, r.e.col);
    }
    if (node.type === 'error') return err(node.value || ERR.REF, 'reference error');
  }
  if (isError(node)) return node;
  return err(ERR.REF, 'a cell or range reference is required');
}

/**
 * Parse an A1-style target for `INDIRECT`.
 *
 * @param {string} text Reference text, e.g. `'B7'` or `'A1:C3'`.
 * @returns {{single:boolean,range:object}|import('./errors.js').FormulaError} The target.
 */
function parseA1Target(text) {
  const t = text.trim();
  if (t === '') return err(ERR.REF, 'empty reference');
  if (t.indexOf(':') >= 0) {
    try {
      const r = normalizeRange(parseRange(t));
      return { single: false, range: r };
    } catch (e) {
      return err(ERR.REF, 'not a valid range: ' + t);
    }
  }
  if (!isA1(t)) return err(ERR.REF, 'not a valid reference: ' + t);
  try {
    const c = a1ToCell(t);
    return { single: true, range: mkRange(c.row, c.col, c.row, c.col) };
  } catch (e) {
    return err(ERR.REF, 'reference out of bounds: ' + t);
  }
}

/**
 * Parse one R1C1 coordinate, absolute (`R2C3`) or relative (`R[-1]C[2]`); an omitted axis
 * means "the current row/column".
 *
 * @param {string} part Coordinate text.
 * @param {{row:number,col:number}} home The formula's own cell.
 * @returns {{row:number,col:number}|null} The cell, or `null` when it does not parse.
 */
function parseR1C1Cell(part, home) {
  const m = /^R(?:\[(-?\d+)\]|(\d+))?C(?:\[(-?\d+)\]|(\d+))?$/i.exec(part.trim());
  if (!m) return null;
  const row = m[1] !== undefined ? home.row + Number(m[1]) : m[2] !== undefined ? Number(m[2]) - 1 : home.row;
  const col = m[3] !== undefined ? home.col + Number(m[3]) : m[4] !== undefined ? Number(m[4]) - 1 : home.col;
  return { row, col };
}

/**
 * Parse an R1C1-style target for `INDIRECT(text, FALSE)`.
 *
 * @param {string} text Reference text.
 * @param {object} ctx Evaluation context.
 * @returns {{single:boolean,range:object}|import('./errors.js').FormulaError} The target.
 */
function parseR1C1Target(text, ctx) {
  const home = ctx && ctx.cell ? ctx.cell : { row: 0, col: 0 };
  const t = text.trim();
  const i = t.indexOf(':');
  const a = parseR1C1Cell(i < 0 ? t : t.slice(0, i), home);
  const b = i < 0 ? a : parseR1C1Cell(t.slice(i + 1), home);
  if (!a || !b) return err(ERR.REF, 'not a valid R1C1 reference: ' + text);
  const r0 = Math.min(a.row, b.row);
  const c0 = Math.min(a.col, b.col);
  const r1 = Math.max(a.row, b.row);
  const c1 = Math.max(a.col, b.col);
  if (r0 < 0 || c0 < 0 || r1 >= MAX_ROWS || c1 >= MAX_COLS) {
    return err(ERR.REF, 'reference out of bounds: ' + text);
  }
  return { single: i < 0, range: mkRange(r0, c0, r1, c1) };
}

/* ================================================================== *
 * Date helpers
 * ================================================================== */

/**
 * Build a UTC `Date` without JS's two-digit-year remapping. Month and day overflow the
 * same way `Date.UTC` handles them, which is what `DATE(2024,13,1)` expects.
 *
 * @param {number} y Full year. @param {number} m 1-based month. @param {number} d Day.
 * @returns {Date} The UTC date at midnight.
 */
function utcDate(y, m, d) {
  const dt = new Date(Date.UTC(2000, m - 1, d));
  dt.setUTCFullYear(y);
  return dt;
}

/**
 * Number of days in a month.
 * @param {number} y Full year. @param {number} m 1-based month.
 * @returns {number} 28..31.
 */
function daysInMonth(y, m) {
  return utcDate(y, m + 1, 0).getUTCDate();
}

/**
 * Split a serial date into its calendar parts (time of day discarded).
 * @param {number} serial Serial date.
 * @returns {{y:number,m:number,d:number}} Year, 1-based month, day.
 */
function ymdOf(serial) {
  const dt = serialToDate(Math.floor(serial));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Split the fractional part of a serial into a time of day. Rounding to whole seconds
 * keeps `TIME(9,30,0)` from reading back as 09:29:59.
 *
 * @param {number} serial Serial date.
 * @returns {{h:number,mi:number,s:number}} Hours, minutes, seconds.
 */
function hmsOf(serial) {
  const frac = serial - Math.floor(serial);
  let total = Math.round(frac * SECONDS_PER_DAY);
  if (total >= SECONDS_PER_DAY) total -= SECONDS_PER_DAY;
  return {
    h: Math.floor(total / 3600),
    mi: Math.floor(total / 60) % 60,
    s: total % 60,
  };
}

/**
 * Coerce an argument to a serial date, rejecting the negative serials that have no
 * calendar meaning.
 *
 * @param {*} v Value.
 * @returns {number|import('./errors.js').FormulaError} Serial, or `#NUM!`.
 */
function serialArg(v) {
  const n = num(v);
  if (isError(n)) return n;
  if (n < 0) return err(ERR.NUM, 'date serial must not be negative');
  return n;
}

/* ================================================================== *
 * TEXT() formatting engine
 * ================================================================== */

/** Numeric pattern: optional literal prefix, integer part, optional decimals, suffix. */
const NUM_FMT_RE = /^([^#0]*)([#0][#0,]*)(?:\.([#0]+))?([^#0]*)$/;

/**
 * Insert thousands separators into a run of digits.
 * @param {string} digits Integer digits.
 * @returns {string} Grouped digits.
 */
function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Drop the escaping syntax from the literal parts of a format string.
 * @param {string} s Literal text.
 * @returns {string} Display text.
 */
function stripLiterals(s) {
  return s.replace(/\\(.)/g, '$1').replace(/"/g, '');
}

/**
 * Render a number through a numeric format pattern such as `#,##0.00` or `0.00%`.
 *
 * @param {number} x The number.
 * @param {string} fmt The pattern.
 * @returns {string|null} The formatted text, or `null` when `fmt` is not numeric.
 */
function applyNumberFormat(x, fmt) {
  const m = NUM_FMT_RE.exec(fmt);
  if (!m) return null;
  const prefix = m[1] || '';
  const intPat = m[2] || '';
  const decPat = m[3] || '';
  const suffix = m[4] || '';
  const percent = prefix.indexOf('%') >= 0 || suffix.indexOf('%') >= 0;

  const value = percent ? x * 100 : x;
  const decimals = decPat.length;
  const fixed = Math.abs(value).toFixed(decimals);
  const dot = fixed.indexOf('.');
  let intDigits = dot < 0 ? fixed : fixed.slice(0, dot);
  const decDigits = dot < 0 ? '' : fixed.slice(dot + 1);

  const minInt = (intPat.match(/0/g) || []).length;
  while (intDigits.length < minInt) intDigits = '0' + intDigits;
  if (minInt === 0 && intDigits === '0' && decimals > 0) intDigits = '';
  if (intPat.indexOf(',') >= 0) intDigits = groupThousands(intDigits);

  let body = intDigits + (decimals > 0 ? '.' + decDigits : '');
  if (value < 0 && /[1-9]/.test(fixed)) body = '-' + body;
  return stripLiterals(prefix) + body + stripLiterals(suffix);
}

/**
 * Render a serial date through a date/time pattern. Supported tokens: `y`/`yy`/`yyyy`,
 * `m`..`mmmmm` (month, or minutes next to an hour or seconds token), `d`..`dddd`,
 * `h`/`hh`, `s`/`ss` and `AM/PM`. Everything else, including `\`-escaped and
 * `"`-quoted runs, is copied through.
 *
 * @param {number} serial Serial date.
 * @param {string} fmt The pattern.
 * @returns {string} The formatted text.
 */
function applyDateFormat(serial, fmt) {
  const parts = [];
  const re = /(\\.)|("[^"]*")|(am\/pm|a\/p)|(y+|m+|d+|h+|s+)/gi;
  let last = 0;
  let m;
  while ((m = re.exec(fmt)) !== null) {
    if (m.index > last) parts.push({ lit: fmt.slice(last, m.index) });
    if (m[1]) parts.push({ lit: m[1].slice(1) });
    else if (m[2]) parts.push({ lit: m[2].slice(1, -1) });
    else if (m[3]) parts.push({ ampm: m[3] });
    else parts.push({ tok: m[4].toLowerCase() });
    last = re.lastIndex;
  }
  if (last < fmt.length) parts.push({ lit: fmt.slice(last) });

  // An `m` run means minutes when it sits next to an hour or a seconds token.
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.tok || p.tok[0] !== 'm') continue;
    let prev = '';
    let next = '';
    for (let j = i - 1; j >= 0; j--) if (parts[j].tok) { prev = parts[j].tok[0]; break; }
    for (let j = i + 1; j < parts.length; j++) if (parts[j].tok) { next = parts[j].tok[0]; break; }
    p.minute = prev === 'h' || next === 's';
  }

  const cal = ymdOf(serial);
  const time = hmsOf(serial);
  const weekday = serialToDate(Math.floor(serial)).getUTCDay();
  const twelve = parts.some((p) => p.ampm);
  let out = '';
  for (const p of parts) {
    if (p.lit !== undefined) {
      out += p.lit;
      continue;
    }
    if (p.ampm !== undefined) {
      const pm = time.h >= 12;
      const short = p.ampm.toLowerCase() === 'a/p';
      let word = short ? (pm ? 'P' : 'A') : pm ? 'PM' : 'AM';
      if (p.ampm === p.ampm.toLowerCase()) word = word.toLowerCase();
      out += word;
      continue;
    }
    const tok = p.tok;
    const n = tok.length;
    if (tok[0] === 'y') {
      out += n <= 2 ? pad(cal.y % 100, 2) : pad(cal.y, 4);
    } else if (tok[0] === 'm' && p.minute) {
      out += n >= 2 ? pad(time.mi, 2) : String(time.mi);
    } else if (tok[0] === 'm') {
      if (n === 1) out += String(cal.m);
      else if (n === 2) out += pad(cal.m, 2);
      else if (n === 3) out += MONTH_NAMES[cal.m - 1].slice(0, 3);
      else if (n === 4) out += MONTH_NAMES[cal.m - 1];
      else out += MONTH_NAMES[cal.m - 1].slice(0, 1);
    } else if (tok[0] === 'd') {
      if (n === 1) out += String(cal.d);
      else if (n === 2) out += pad(cal.d, 2);
      else if (n === 3) out += DAY_NAMES[weekday].slice(0, 3);
      else out += DAY_NAMES[weekday];
    } else if (tok[0] === 'h') {
      const h = twelve ? time.h % 12 || 12 : time.h;
      out += n >= 2 ? pad(h, 2) : String(h);
    } else {
      out += n >= 2 ? pad(time.s, 2) : String(time.s);
    }
  }
  return out;
}

/* ================================================================== *
 * 1. Math
 * ================================================================== */

const MATH_FUNCTIONS = {
  SUM: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      return isError(list) ? list : sumOf(list);
    },
  },

  PRODUCT: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      if (list.length === 0) return 0;
      let p = 1;
      for (let i = 0; i < list.length; i++) p *= list[i];
      return p;
    },
  },

  ABS: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const x = num(args[0]);
      return isError(x) ? x : Math.abs(x);
    },
  },

  ROUND: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      const d = args.length > 1 ? int(args[1]) : 0;
      if (isError(d)) return d;
      return roundMode(x, d, 'half');
    },
  },

  ROUNDUP: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      const d = args.length > 1 ? int(args[1]) : 0;
      if (isError(d)) return d;
      return roundMode(x, d, 'up');
    },
  },

  ROUNDDOWN: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      const d = args.length > 1 ? int(args[1]) : 0;
      if (isError(d)) return d;
      return roundMode(x, d, 'down');
    },
  },

  CEILING: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      let sig = 1;
      if (args.length > 1) {
        const s = num(args[1]);
        if (isError(s)) return s;
        sig = s;
      }
      if (sig === 0) return 0;
      if (x > 0 && sig < 0) return err(ERR.NUM, 'significance must not oppose the value sign');
      return clean(Math.ceil(clean(x / sig)) * sig);
    },
  },

  FLOOR: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      let sig = 1;
      if (args.length > 1) {
        const s = num(args[1]);
        if (isError(s)) return s;
        sig = s;
      }
      if (sig === 0) return err(ERR.DIV0, 'significance must not be zero');
      if (x > 0 && sig < 0) return err(ERR.NUM, 'significance must not oppose the value sign');
      return clean(Math.floor(clean(x / sig)) * sig);
    },
  },

  INT: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const x = num(args[0]);
      return isError(x) ? x : Math.floor(x);
    },
  },

  TRUNC: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      const d = args.length > 1 ? int(args[1]) : 0;
      if (isError(d)) return d;
      return roundMode(x, d, 'down');
    },
  },

  MOD: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const a = num(args[0]);
      if (isError(a)) return a;
      const b = num(args[1]);
      if (isError(b)) return b;
      if (b === 0) return err(ERR.DIV0, 'modulo by zero');
      // Excel's MOD takes the sign of the divisor, unlike JS's % operator.
      return clean(a - b * Math.floor(a / b));
    },
  },

  POWER: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const a = num(args[0]);
      if (isError(a)) return a;
      const b = num(args[1]);
      if (isError(b)) return b;
      const r = Math.pow(a, b);
      if (Number.isNaN(r)) return err(ERR.NUM, 'undefined power');
      if (!Number.isFinite(r)) return err(ERR.NUM, 'result is out of range');
      return r;
    },
  },

  SQRT: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      if (x < 0) return err(ERR.NUM, 'square root of a negative number');
      return Math.sqrt(x);
    },
  },

  EXP: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      const r = Math.exp(x);
      if (!Number.isFinite(r)) return err(ERR.NUM, 'result is out of range');
      return r;
    },
  },

  LN: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      if (x <= 0) return err(ERR.NUM, 'logarithm of a non-positive number');
      return Math.log(x);
    },
  },

  LOG: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      let base = 10;
      if (args.length > 1) {
        const b = num(args[1]);
        if (isError(b)) return b;
        base = b;
      }
      if (x <= 0) return err(ERR.NUM, 'logarithm of a non-positive number');
      if (base <= 0 || base === 1) return err(ERR.NUM, 'invalid logarithm base');
      return Math.log(x) / Math.log(base);
    },
  },

  LOG10: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      if (x <= 0) return err(ERR.NUM, 'logarithm of a non-positive number');
      return Math.log10(x);
    },
  },

  SIGN: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      return x > 0 ? 1 : x < 0 ? -1 : 0;
    },
  },

  PI: { minArgs: 0, maxArgs: 0, fn: () => Math.PI },

  RAND: { minArgs: 0, maxArgs: 0, volatile: true, fn: () => Math.random() },

  RANDBETWEEN: {
    minArgs: 2,
    maxArgs: 2,
    volatile: true,
    fn: (args) => {
      const lo = num(args[0]);
      if (isError(lo)) return lo;
      const hi = num(args[1]);
      if (isError(hi)) return hi;
      const bottom = Math.ceil(lo);
      const top = Math.floor(hi);
      if (bottom > top) return err(ERR.NUM, 'bottom must not exceed top');
      return bottom + Math.floor(Math.random() * (top - bottom + 1));
    },
  },

  GCD: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      let g = 0;
      for (const raw of list) {
        const v = Math.trunc(raw);
        if (v < 0) return err(ERR.NUM, 'GCD needs non-negative numbers');
        g = gcd2(g, v);
      }
      return g;
    },
  },

  LCM: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      let l = 1;
      for (const raw of list) {
        const v = Math.trunc(raw);
        if (v < 0) return err(ERR.NUM, 'LCM needs non-negative numbers');
        if (v === 0) return 0;
        l = (l / gcd2(l, v)) * v;
        if (!Number.isFinite(l)) return err(ERR.NUM, 'result is out of range');
      }
      return l;
    },
  },

  SUMPRODUCT: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const e = firstErrorIn(args);
      if (e) return e;
      const blocks = args.map(asRange);
      let height = 1;
      let width = 1;
      for (const b of blocks) {
        if (b.height > height) height = b.height;
        if (b.width > width) width = b.width;
      }
      for (const b of blocks) {
        // A 1x1 argument broadcasts; anything else must match the common shape.
        if ((b.height !== height && b.height !== 1) || (b.width !== width && b.width !== 1)) {
          return err(ERR.VALUE, 'arrays must have the same dimensions');
        }
      }
      let total = 0;
      for (let i = 0; i < height; i++) {
        for (let j = 0; j < width; j++) {
          let p = 1;
          for (const b of blocks) {
            const row = b.rows[b.height === 1 ? 0 : i];
            const cell = row ? row[b.width === 1 ? 0 : j] : null;
            p *= typeof cell === 'number' ? cell : 0;
          }
          total += p;
        }
      }
      return total;
    },
  },

  SUMSQ: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      let total = 0;
      for (const x of list) total += x * x;
      return total;
    },
  },
};

/* ================================================================== *
 * 2. Statistics
 * ================================================================== */

const STAT_FUNCTIONS = {
  AVERAGE: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      if (list.length === 0) return err(ERR.DIV0, 'no numeric values');
      return meanOf(list);
    },
  },

  AVERAGEA: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberListA(args);
      if (isError(list)) return list;
      if (list.length === 0) return err(ERR.DIV0, 'no values');
      return meanOf(list);
    },
  },

  MEDIAN: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      if (list.length === 0) return err(ERR.NUM, 'no numeric values');
      const sorted = list.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    },
  },

  MIN: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      if (list.length === 0) return 0;
      let m = list[0];
      for (const x of list) if (x < m) m = x;
      return m;
    },
  },

  MAX: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      if (list.length === 0) return 0;
      let m = list[0];
      for (const x of list) if (x > m) m = x;
      return m;
    },
  },

  COUNT: {
    minArgs: 1,
    maxArgs: Infinity,
    // Deliberately does not propagate errors: COUNT simply does not count them.
    fn: (args) => {
      let c = 0;
      for (const a of args) {
        if (a instanceof RangeValue) {
          for (const v of a.flat()) if (typeof v === 'number') c++;
        } else if (typeof a === 'number') c++;
        else if (typeof a === 'boolean') c++;
        else if (typeof a === 'string') {
          const n = toNumber(a);
          if (!isError(n)) c++;
        }
      }
      return c;
    },
  },

  COUNTA: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      let c = 0;
      for (const v of flattenArgs(args)) if (v !== null && v !== undefined) c++;
      return c;
    },
  },

  COUNTBLANK: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      let c = 0;
      for (const v of flattenArgs(args)) if (v === null || v === undefined || v === '') c++;
      return c;
    },
  },

  COUNTIF: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      let c = 0;
      const e = forEachMatch([args[0], args[1]], () => {
        c++;
      });
      return e || c;
    },
  },

  COUNTIFS: {
    minArgs: 2,
    maxArgs: Infinity,
    fn: (args) => {
      let c = 0;
      const e = forEachMatch(args, () => {
        c++;
      });
      return e || c;
    },
  },

  SUMIF: {
    minArgs: 2,
    maxArgs: 3,
    fn: (args) => {
      const critRange = asRange(args[0]);
      const sumRange = args.length > 2 ? asRange(args[2]) : critRange;
      let total = 0;
      const e = forEachMatch([critRange, args[1]], (i, j) => {
        const row = sumRange.rows[i];
        const cell = row ? row[j] : null;
        if (typeof cell === 'number') total += cell;
      });
      return e || total;
    },
  },

  SUMIFS: {
    minArgs: 3,
    maxArgs: Infinity,
    fn: (args) => {
      const sumRange = asRange(args[0]);
      let total = 0;
      const e = forEachMatch(args.slice(1), (i, j) => {
        const row = sumRange.rows[i];
        const cell = row ? row[j] : null;
        if (typeof cell === 'number') total += cell;
      });
      return e || total;
    },
  },

  AVERAGEIF: {
    minArgs: 2,
    maxArgs: 3,
    fn: (args) => {
      const critRange = asRange(args[0]);
      const avgRange = args.length > 2 ? asRange(args[2]) : critRange;
      let total = 0;
      let n = 0;
      const e = forEachMatch([critRange, args[1]], (i, j) => {
        const row = avgRange.rows[i];
        const cell = row ? row[j] : null;
        if (typeof cell === 'number') {
          total += cell;
          n++;
        }
      });
      if (e) return e;
      if (n === 0) return err(ERR.DIV0, 'no matching numeric values');
      return total / n;
    },
  },

  AVERAGEIFS: {
    minArgs: 3,
    maxArgs: Infinity,
    fn: (args) => {
      const avgRange = asRange(args[0]);
      let total = 0;
      let n = 0;
      const e = forEachMatch(args.slice(1), (i, j) => {
        const row = avgRange.rows[i];
        const cell = row ? row[j] : null;
        if (typeof cell === 'number') {
          total += cell;
          n++;
        }
      });
      if (e) return e;
      if (n === 0) return err(ERR.DIV0, 'no matching numeric values');
      return total / n;
    },
  },

  STDEV: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      const v = variance(list, true);
      return isError(v) ? v : Math.sqrt(v);
    },
  },

  STDEVP: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      const v = variance(list, false);
      return isError(v) ? v : Math.sqrt(v);
    },
  },

  VAR: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      return variance(list, true);
    },
  },

  VARP: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      return variance(list, false);
    },
  },

  LARGE: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const list = numberList([args[0]]);
      if (isError(list)) return list;
      const k = int(args[1]);
      if (isError(k)) return k;
      if (k < 1 || k > list.length) return err(ERR.NUM, 'k is out of range');
      const sorted = list.slice().sort((a, b) => b - a);
      return sorted[k - 1];
    },
  },

  SMALL: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const list = numberList([args[0]]);
      if (isError(list)) return list;
      const k = int(args[1]);
      if (isError(k)) return k;
      if (k < 1 || k > list.length) return err(ERR.NUM, 'k is out of range');
      const sorted = list.slice().sort((a, b) => a - b);
      return sorted[k - 1];
    },
  },

  RANK: {
    minArgs: 2,
    maxArgs: 3,
    fn: (args) => {
      const x = num(args[0]);
      if (isError(x)) return x;
      const list = numberList([args[1]]);
      if (isError(list)) return list;
      let ascending = false;
      if (args.length > 2) {
        const o = num(args[2]);
        if (isError(o)) return o;
        ascending = o !== 0;
      }
      let found = false;
      let rank = 1;
      for (const v of list) {
        if (v === x) found = true;
        else if (ascending ? v < x : v > x) rank++;
      }
      return found ? rank : err(ERR.NA, 'value is not in the list');
    },
  },

  MODE: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const list = numberList(args);
      if (isError(list)) return list;
      const counts = new Map();
      let best = null;
      let bestCount = 1;
      for (const v of list) {
        const c = (counts.get(v) || 0) + 1;
        counts.set(v, c);
        if (c > bestCount) {
          bestCount = c;
          best = v;
        }
      }
      if (best === null) return err(ERR.NA, 'no value occurs more than once');
      return best;
    },
  },
};

/* ================================================================== *
 * 3. Logic
 * ================================================================== */

/**
 * Fold the arguments of AND/OR into a single truth value. Excel evaluates every argument
 * (so an error anywhere still surfaces), ignores text and blanks found inside a range, and
 * reports `#VALUE!` when nothing boolean was supplied at all.
 *
 * @param {*[]} nodes AST nodes.
 * @param {object} ctx Evaluation context.
 * @param {boolean} isAnd `true` for AND, `false` for OR.
 * @returns {boolean|import('./errors.js').FormulaError} The result.
 */
function foldBooleans(nodes, ctx, isAnd) {
  let seen = false;
  let acc = isAnd;
  for (const node of nodes) {
    const v = ev(node, ctx);
    if (isError(v)) return v;
    if (v instanceof RangeValue) {
      const e = v.firstError();
      if (e) return e;
      for (const cell of v.flat()) {
        if (cell === null || cell === undefined || typeof cell === 'string') continue;
        const b = toBool(cell);
        if (isError(b)) return b;
        seen = true;
        acc = isAnd ? acc && b : acc || b;
      }
      continue;
    }
    if (v === null) continue;
    const b = toBool(v);
    if (isError(b)) return b;
    seen = true;
    acc = isAnd ? acc && b : acc || b;
  }
  if (!seen) return err(ERR.VALUE, 'no logical values supplied');
  return acc;
}

const LOGIC_FUNCTIONS = {
  IF: {
    minArgs: 2,
    maxArgs: 3,
    lazy: true,
    fn: (nodes, ctx) => {
      const cond = ev(nodes[0], ctx);
      if (isError(cond)) return cond;
      const b = toBool(scalarOf(cond));
      if (isError(b)) return b;
      if (b) return ev(nodes[1], ctx);
      return nodes.length > 2 ? ev(nodes[2], ctx) : false;
    },
  },

  IFS: {
    minArgs: 2,
    maxArgs: Infinity,
    lazy: true,
    fn: (nodes, ctx) => {
      for (let i = 0; i + 1 < nodes.length; i += 2) {
        const cond = ev(nodes[i], ctx);
        if (isError(cond)) return cond;
        const b = toBool(scalarOf(cond));
        if (isError(b)) return b;
        if (b) return ev(nodes[i + 1], ctx);
      }
      return err(ERR.NA, 'no condition matched');
    },
  },

  AND: {
    minArgs: 1,
    maxArgs: Infinity,
    lazy: true,
    fn: (nodes, ctx) => foldBooleans(nodes, ctx, true),
  },

  OR: {
    minArgs: 1,
    maxArgs: Infinity,
    lazy: true,
    fn: (nodes, ctx) => foldBooleans(nodes, ctx, false),
  },

  NOT: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const b = bool(args[0]);
      return isError(b) ? b : !b;
    },
  },

  XOR: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      let trues = 0;
      let seen = false;
      for (const v of flattenArgs(args)) {
        if (isError(v)) return v;
        if (v === null || v === undefined || typeof v === 'string') continue;
        const b = toBool(v);
        if (isError(b)) return b;
        seen = true;
        if (b) trues++;
      }
      if (!seen) return err(ERR.VALUE, 'no logical values supplied');
      return trues % 2 === 1;
    },
  },

  TRUE: { minArgs: 0, maxArgs: 0, fn: () => true },

  FALSE: { minArgs: 0, maxArgs: 0, fn: () => false },

  IFERROR: {
    minArgs: 2,
    maxArgs: 2,
    lazy: true,
    // Deliberately does not pre-check for errors: catching one is the whole point.
    fn: (nodes, ctx) => {
      const v = ev(nodes[0], ctx);
      if (isError(v)) return ev(nodes[1], ctx);
      if (v instanceof RangeValue && v.firstError()) return ev(nodes[1], ctx);
      return v;
    },
  },

  IFNA: {
    minArgs: 2,
    maxArgs: 2,
    lazy: true,
    fn: (nodes, ctx) => {
      const v = ev(nodes[0], ctx);
      if (isError(v) && v.code === ERR.NA) return ev(nodes[1], ctx);
      return v;
    },
  },

  SWITCH: {
    minArgs: 3,
    maxArgs: Infinity,
    lazy: true,
    fn: (nodes, ctx) => {
      const subject = scalarOf(ev(nodes[0], ctx));
      if (isError(subject)) return subject;
      let i = 1;
      for (; i + 1 < nodes.length; i += 2) {
        const candidate = scalarOf(ev(nodes[i], ctx));
        if (isError(candidate)) return candidate;
        if (equalsLoose(subject, candidate) === true) return ev(nodes[i + 1], ctx);
      }
      // An odd number of trailing arguments means the last one is the default.
      if (i < nodes.length) return ev(nodes[i], ctx);
      return err(ERR.NA, 'no case matched');
    },
  },
};

/* ================================================================== *
 * 4. Text
 * ================================================================== */

const TEXT_FUNCTIONS = {
  CONCAT: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      let out = '';
      for (const v of flattenArgs(args)) {
        const t = toText(v);
        if (isError(t)) return t;
        out += t;
      }
      if (out.length > MAX_TEXT) return err(ERR.VALUE, 'text is too long');
      return out;
    },
  },

  CONCATENATE: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      let out = '';
      for (const v of flattenArgs(args)) {
        const t = toText(v);
        if (isError(t)) return t;
        out += t;
      }
      if (out.length > MAX_TEXT) return err(ERR.VALUE, 'text is too long');
      return out;
    },
  },

  TEXTJOIN: {
    minArgs: 3,
    maxArgs: Infinity,
    fn: (args) => {
      const delim = str(args[0]);
      if (isError(delim)) return delim;
      const ignoreEmpty = bool(args[1]);
      if (isError(ignoreEmpty)) return ignoreEmpty;
      const pieces = [];
      for (const v of flattenArgs(args.slice(2))) {
        if (isError(v)) return v;
        if (ignoreEmpty && (v === null || v === undefined || v === '')) continue;
        const t = toText(v);
        if (isError(t)) return t;
        pieces.push(t);
      }
      const out = pieces.join(delim);
      if (out.length > MAX_TEXT) return err(ERR.VALUE, 'text is too long');
      return out;
    },
  },

  LEN: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const t = str(args[0]);
      return isError(t) ? t : t.length;
    },
  },

  LEFT: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      const n = args.length > 1 ? int(args[1]) : 1;
      if (isError(n)) return n;
      if (n < 0) return err(ERR.VALUE, 'character count must not be negative');
      return t.slice(0, n);
    },
  },

  RIGHT: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      const n = args.length > 1 ? int(args[1]) : 1;
      if (isError(n)) return n;
      if (n < 0) return err(ERR.VALUE, 'character count must not be negative');
      return n === 0 ? '' : t.slice(Math.max(0, t.length - n));
    },
  },

  MID: {
    minArgs: 3,
    maxArgs: 3,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      const start = int(args[1]);
      if (isError(start)) return start;
      const len = int(args[2]);
      if (isError(len)) return len;
      if (start < 1) return err(ERR.VALUE, 'start position must be at least 1');
      if (len < 0) return err(ERR.VALUE, 'length must not be negative');
      return t.slice(start - 1, start - 1 + len);
    },
  },

  UPPER: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const t = str(args[0]);
      return isError(t) ? t : t.toUpperCase();
    },
  },

  LOWER: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const t = str(args[0]);
      return isError(t) ? t : t.toLowerCase();
    },
  },

  PROPER: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      return t.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    },
  },

  TRIM: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      return t.replace(/ +/g, ' ').replace(/^ | $/g, '');
    },
  },

  SUBSTITUTE: {
    minArgs: 3,
    maxArgs: 4,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      const oldText = str(args[1]);
      if (isError(oldText)) return oldText;
      const newText = str(args[2]);
      if (isError(newText)) return newText;
      if (oldText === '') return t;
      if (args.length > 3) {
        const which = int(args[3]);
        if (isError(which)) return which;
        if (which < 1) return err(ERR.VALUE, 'instance number must be at least 1');
        let from = 0;
        for (let seen = 1; ; seen++) {
          const at = t.indexOf(oldText, from);
          if (at < 0) return t;
          if (seen === which) return t.slice(0, at) + newText + t.slice(at + oldText.length);
          from = at + oldText.length;
        }
      }
      return t.split(oldText).join(newText);
    },
  },

  REPLACE: {
    minArgs: 4,
    maxArgs: 4,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      const start = int(args[1]);
      if (isError(start)) return start;
      const count = int(args[2]);
      if (isError(count)) return count;
      const newText = str(args[3]);
      if (isError(newText)) return newText;
      if (start < 1) return err(ERR.VALUE, 'start position must be at least 1');
      if (count < 0) return err(ERR.VALUE, 'character count must not be negative');
      const head = t.slice(0, start - 1);
      const tail = t.slice(start - 1 + count);
      return head + newText + tail;
    },
  },

  FIND: {
    minArgs: 2,
    maxArgs: 3,
    fn: (args) => {
      const needle = str(args[0]);
      if (isError(needle)) return needle;
      const hay = str(args[1]);
      if (isError(hay)) return hay;
      const start = args.length > 2 ? int(args[2]) : 1;
      if (isError(start)) return start;
      if (start < 1 || start > hay.length + 1) return err(ERR.VALUE, 'start position is out of range');
      const at = hay.indexOf(needle, start - 1);
      if (at < 0) return err(ERR.VALUE, 'text not found');
      return at + 1;
    },
  },

  SEARCH: {
    minArgs: 2,
    maxArgs: 3,
    fn: (args) => {
      const needle = str(args[0]);
      if (isError(needle)) return needle;
      const hay = str(args[1]);
      if (isError(hay)) return hay;
      const start = args.length > 2 ? int(args[2]) : 1;
      if (isError(start)) return start;
      if (start < 1 || start > hay.length + 1) return err(ERR.VALUE, 'start position is out of range');
      const tail = hay.slice(start - 1);
      const at = hasWildcard(needle)
        ? tail.search(new RegExp(wildcardBody(needle), 'i'))
        : tail.toLowerCase().indexOf(needle.toLowerCase());
      if (at < 0) return err(ERR.VALUE, 'text not found');
      return start + at;
    },
  },

  REPT: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      const n = int(args[1]);
      if (isError(n)) return n;
      if (n < 0) return err(ERR.VALUE, 'repeat count must not be negative');
      if (t.length * n > MAX_TEXT) return err(ERR.VALUE, 'text is too long');
      return t.repeat(n);
    },
  },

  VALUE: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const v = scalarOf(args[0]);
      if (isError(v)) return v;
      if (typeof v === 'number') return v;
      if (v === null) return 0;
      if (typeof v === 'boolean') return err(ERR.VALUE, 'a logical value is not a number');
      const t = String(v).trim();
      if (t === '') return 0;
      // Percentages, thousands separators and a leading currency symbol are all accepted.
      const pct = /%$/.test(t);
      const body = (pct ? t.slice(0, -1) : t).replace(/^[^\d+.-]+/, '').replace(/,/g, '').trim();
      if (/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(body)) {
        const n = Number(body);
        return pct ? n / 100 : n;
      }
      // ISO dates and clock times convert to their serial value.
      const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
      if (iso) return dateToSerial(utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3])));
      const clock = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
      if (clock) {
        const secs = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] || 0);
        return secs / SECONDS_PER_DAY;
      }
      return err(ERR.VALUE, 'text is not a number');
    },
  },

  EXACT: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const a = str(args[0]);
      if (isError(a)) return a;
      const b = str(args[1]);
      if (isError(b)) return b;
      return a === b;
    },
  },

  CHAR: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const n = int(args[0]);
      if (isError(n)) return n;
      if (n < 1 || n > 65535) return err(ERR.VALUE, 'character code is out of range');
      return String.fromCharCode(n);
    },
  },

  CODE: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const t = str(args[0]);
      if (isError(t)) return t;
      if (t.length === 0) return err(ERR.VALUE, 'text is empty');
      return t.charCodeAt(0);
    },
  },

  TEXT: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const v = scalarOf(args[0]);
      if (isError(v)) return v;
      const fmt = str(args[1]);
      if (isError(fmt)) return fmt;
      if (fmt.trim() === '') return '';
      if (/^general$/i.test(fmt.trim())) return toText(v);
      if (/[#0]/.test(fmt)) {
        const x = toNumber(v);
        if (isError(x)) return x;
        const out = applyNumberFormat(x, fmt);
        if (out !== null) return out;
      }
      const bare = fmt.replace(/\\./g, '').replace(/"[^"]*"/g, '');
      if (/[ymdhs]/i.test(bare)) {
        const x = toNumber(v);
        if (isError(x)) return x;
        if (x < 0) return err(ERR.NUM, 'date serial must not be negative');
        return applyDateFormat(x, fmt);
      }
      return stripLiterals(fmt);
    },
  },
};

/* ================================================================== *
 * 5. Lookup and reference
 * ================================================================== */

const LOOKUP_FUNCTIONS = {
  VLOOKUP: {
    minArgs: 3,
    maxArgs: 4,
    fn: (args) => {
      const key = scalarOf(args[0]);
      if (isError(key)) return key;
      const table = asRange(args[1]);
      const index = int(args[2]);
      if (isError(index)) return index;
      // The 4th argument defaults to TRUE: an approximate match over sorted data.
      let approximate = true;
      if (args.length > 3 && args[3] !== undefined) {
        const b = bool(args[3]);
        if (isError(b)) return b;
        approximate = b;
      }
      if (index < 1) return err(ERR.VALUE, 'column index must be at least 1');
      if (index > table.width) return err(ERR.REF, 'column index is past the end of the range');
      const at = lookupIndex(columnOf(table, 0), key, approximate ? 1 : 0);
      if (at < 0) return err(ERR.NA, 'value not found');
      const row = table.rows[at] || [];
      const cell = row[index - 1];
      return cell === undefined ? null : cell;
    },
  },

  HLOOKUP: {
    minArgs: 3,
    maxArgs: 4,
    fn: (args) => {
      const key = scalarOf(args[0]);
      if (isError(key)) return key;
      const table = asRange(args[1]);
      const index = int(args[2]);
      if (isError(index)) return index;
      let approximate = true;
      if (args.length > 3 && args[3] !== undefined) {
        const b = bool(args[3]);
        if (isError(b)) return b;
        approximate = b;
      }
      if (index < 1) return err(ERR.VALUE, 'row index must be at least 1');
      if (index > table.height) return err(ERR.REF, 'row index is past the end of the range');
      const at = lookupIndex(rowOf(table, 0), key, approximate ? 1 : 0);
      if (at < 0) return err(ERR.NA, 'value not found');
      const row = table.rows[index - 1] || [];
      const cell = row[at];
      return cell === undefined ? null : cell;
    },
  },

  INDEX: {
    minArgs: 2,
    maxArgs: 3,
    fn: (args) => {
      const block = asRange(args[0]);
      let rowIdx = int(args[1]);
      if (isError(rowIdx)) return rowIdx;
      let colIdx = 0;
      const hasCol = args.length > 2 && args[2] !== undefined && args[2] !== null;
      if (hasCol) {
        const c = int(args[2]);
        if (isError(c)) return c;
        colIdx = c;
      } else if (block.height === 1 && block.width > 1) {
        // A single-row range addressed with one index selects a column.
        colIdx = rowIdx;
        rowIdx = 1;
      }
      if (rowIdx < 0 || colIdx < 0) return err(ERR.VALUE, 'index must not be negative');
      if (rowIdx > block.height || colIdx > block.width) {
        return err(ERR.REF, 'index is outside the range');
      }
      if (rowIdx === 0 && colIdx === 0) return block;
      if (rowIdx === 0) {
        return new RangeValue(block.rows.map((r) => [r[colIdx - 1] === undefined ? null : r[colIdx - 1]]));
      }
      if (colIdx === 0) return new RangeValue([rowOf(block, rowIdx - 1)]);
      const row = block.rows[rowIdx - 1] || [];
      const cell = row[colIdx - 1];
      return cell === undefined ? null : cell;
    },
  },

  MATCH: {
    minArgs: 2,
    maxArgs: 3,
    fn: (args) => {
      const key = scalarOf(args[0]);
      if (isError(key)) return key;
      const block = asRange(args[1]);
      let type = 1;
      if (args.length > 2 && args[2] !== undefined) {
        const t = int(args[2]);
        if (isError(t)) return t;
        type = t;
      }
      const mode = type > 0 ? 1 : type < 0 ? -1 : 0;
      const at = lookupIndex(block.flat(), key, mode);
      if (at < 0) return err(ERR.NA, 'value not found');
      return at + 1;
    },
  },

  CHOOSE: {
    minArgs: 2,
    maxArgs: Infinity,
    lazy: true,
    fn: (nodes, ctx) => {
      const k = int(ev(nodes[0], ctx));
      if (isError(k)) return k;
      if (k < 1 || k > nodes.length - 1) return err(ERR.VALUE, 'index is out of range');
      return ev(nodes[k], ctx);
    },
  },

  ROW: {
    minArgs: 0,
    maxArgs: 1,
    // Lazy so that ROW(B7) can read the reference itself rather than the value it holds.
    lazy: true,
    fn: (nodes, ctx) => {
      const home = (ctx && ctx.cell ? ctx.cell.row : 0) + 1;
      if (nodes.length === 0 || isBlankNode(nodes[0])) return home;
      const node = nodes[0];
      if (isNode(node)) {
        if (node.type === 'ref') return node.row + 1;
        if (node.type === 'range') return Math.min(node.s.row, node.e.row) + 1;
        const v = ctx.evalNode(node);
        if (isError(v)) return v;
        return home;
      }
      if (isError(node)) return node;
      return home;
    },
  },

  COLUMN: {
    minArgs: 0,
    maxArgs: 1,
    lazy: true,
    fn: (nodes, ctx) => {
      const home = (ctx && ctx.cell ? ctx.cell.col : 0) + 1;
      if (nodes.length === 0 || isBlankNode(nodes[0])) return home;
      const node = nodes[0];
      if (isNode(node)) {
        if (node.type === 'ref') return node.col + 1;
        if (node.type === 'range') return Math.min(node.s.col, node.e.col) + 1;
        const v = ctx.evalNode(node);
        if (isError(v)) return v;
        return home;
      }
      if (isError(node)) return node;
      return home;
    },
  },

  ROWS: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      if (isError(args[0])) return args[0];
      return args[0] instanceof RangeValue ? args[0].height : 1;
    },
  },

  COLUMNS: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      if (isError(args[0])) return args[0];
      return args[0] instanceof RangeValue ? args[0].width : 1;
    },
  },

  OFFSET: {
    minArgs: 3,
    maxArgs: 5,
    lazy: true,
    volatile: true,
    fn: (nodes, ctx) => {
      const base = nodeToRange(nodes[0], ctx);
      if (isError(base)) return base;
      const dRow = int(ev(nodes[1], ctx));
      if (isError(dRow)) return dRow;
      const dCol = int(ev(nodes[2], ctx));
      if (isError(dCol)) return dCol;

      let height = base.e.row - base.s.row + 1;
      let width = base.e.col - base.s.col + 1;
      if (nodes.length > 3 && !isBlankNode(nodes[3])) {
        const h = int(ev(nodes[3], ctx));
        if (isError(h)) return h;
        height = h;
      }
      if (nodes.length > 4 && !isBlankNode(nodes[4])) {
        const w = int(ev(nodes[4], ctx));
        if (isError(w)) return w;
        width = w;
      }
      if (height === 0 || width === 0) return err(ERR.REF, 'height and width must not be zero');

      let r0 = base.s.row + dRow;
      let c0 = base.s.col + dCol;
      let r1 = r0 + height - 1;
      let c1 = c0 + width - 1;
      // A negative height/width extends backwards from the anchor.
      if (height < 0) {
        r1 = r0;
        r0 = r0 + height + 1;
      }
      if (width < 0) {
        c1 = c0;
        c0 = c0 + width + 1;
      }
      if (r0 < 0 || c0 < 0 || r1 >= MAX_ROWS || c1 >= MAX_COLS) {
        return err(ERR.REF, 'offset falls outside the sheet');
      }
      if (r0 === r1 && c0 === c1) return ctx.getCell(r0, c0);
      return ctx.getRangeValue(mkRange(r0, c0, r1, c1));
    },
  },

  INDIRECT: {
    minArgs: 1,
    maxArgs: 2,
    lazy: true,
    volatile: true,
    fn: (nodes, ctx) => {
      const text = str(ev(nodes[0], ctx));
      if (isError(text)) return text;
      let a1Style = true;
      if (nodes.length > 1 && !isBlankNode(nodes[1])) {
        const b = bool(ev(nodes[1], ctx));
        if (isError(b)) return b;
        a1Style = b;
      }
      const target = a1Style ? parseA1Target(text) : parseR1C1Target(text, ctx);
      if (isError(target)) return target;
      if (target.single) return ctx.getCell(target.range.s.row, target.range.s.col);
      return ctx.getRangeValue(target.range);
    },
  },
};

/* ================================================================== *
 * 6. Date and time
 * ================================================================== */

const DATE_FUNCTIONS = {
  TODAY: {
    minArgs: 0,
    maxArgs: 0,
    volatile: true,
    fn: (args, ctx) => Math.floor(dateToSerial(ctx && ctx.now ? ctx.now : new Date())),
  },

  NOW: {
    minArgs: 0,
    maxArgs: 0,
    volatile: true,
    fn: (args, ctx) => dateToSerial(ctx && ctx.now ? ctx.now : new Date()),
  },

  DATE: {
    minArgs: 3,
    maxArgs: 3,
    fn: (args) => {
      let year = int(args[0]);
      if (isError(year)) return year;
      const month = int(args[1]);
      if (isError(month)) return month;
      const day = int(args[2]);
      if (isError(day)) return day;
      if (year < 0) return err(ERR.NUM, 'year must not be negative');
      // Excel reads a year below 1900 as an offset from 1900.
      if (year < 1900) year += 1900;
      const totalMonths = year * 12 + (month - 1);
      const y = Math.floor(totalMonths / 12);
      const m = ((totalMonths % 12) + 12) % 12 + 1;
      const serial = dateToSerial(utcDate(y, m, 1)) + (day - 1);
      if (!Number.isFinite(serial)) return err(ERR.NUM, 'date is out of range');
      if (serial < 0) return err(ERR.NUM, 'date is before the epoch');
      return serial;
    },
  },

  YEAR: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const s = serialArg(args[0]);
      return isError(s) ? s : ymdOf(s).y;
    },
  },

  MONTH: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const s = serialArg(args[0]);
      return isError(s) ? s : ymdOf(s).m;
    },
  },

  DAY: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const s = serialArg(args[0]);
      return isError(s) ? s : ymdOf(s).d;
    },
  },

  HOUR: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const s = serialArg(args[0]);
      return isError(s) ? s : hmsOf(s).h;
    },
  },

  MINUTE: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const s = serialArg(args[0]);
      return isError(s) ? s : hmsOf(s).mi;
    },
  },

  SECOND: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const s = serialArg(args[0]);
      return isError(s) ? s : hmsOf(s).s;
    },
  },

  WEEKDAY: {
    minArgs: 1,
    maxArgs: 2,
    fn: (args) => {
      const s = serialArg(args[0]);
      if (isError(s)) return s;
      let type = 1;
      if (args.length > 1) {
        const t = int(args[1]);
        if (isError(t)) return t;
        type = t;
      }
      const dow = serialToDate(Math.floor(s)).getUTCDay(); // 0 = Sunday
      if (type === 1) return dow + 1;
      if (type === 2) return ((dow + 6) % 7) + 1;
      if (type === 3) return (dow + 6) % 7;
      if (type >= 11 && type <= 17) return ((dow + 7 - (type - 10)) % 7) + 1;
      return err(ERR.NUM, 'unsupported weekday type');
    },
  },

  DAYS: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const end = serialArg(args[0]);
      if (isError(end)) return end;
      const start = serialArg(args[1]);
      if (isError(start)) return start;
      return Math.trunc(end) - Math.trunc(start);
    },
  },

  EDATE: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const s = serialArg(args[0]);
      if (isError(s)) return s;
      const months = int(args[1]);
      if (isError(months)) return months;
      const cal = ymdOf(s);
      const total = cal.y * 12 + (cal.m - 1) + months;
      const y = Math.floor(total / 12);
      const m = ((total % 12) + 12) % 12 + 1;
      const day = Math.min(cal.d, daysInMonth(y, m));
      const out = dateToSerial(utcDate(y, m, day));
      if (out < 0) return err(ERR.NUM, 'date is before the epoch');
      return out;
    },
  },

  EOMONTH: {
    minArgs: 2,
    maxArgs: 2,
    fn: (args) => {
      const s = serialArg(args[0]);
      if (isError(s)) return s;
      const months = int(args[1]);
      if (isError(months)) return months;
      const cal = ymdOf(s);
      const total = cal.y * 12 + (cal.m - 1) + months;
      const y = Math.floor(total / 12);
      const m = ((total % 12) + 12) % 12 + 1;
      const out = dateToSerial(utcDate(y, m, daysInMonth(y, m)));
      if (out < 0) return err(ERR.NUM, 'date is before the epoch');
      return out;
    },
  },

  DATEDIF: {
    minArgs: 3,
    maxArgs: 3,
    fn: (args) => {
      const startSerial = serialArg(args[0]);
      if (isError(startSerial)) return startSerial;
      const endSerial = serialArg(args[1]);
      if (isError(endSerial)) return endSerial;
      const unitText = str(args[2]);
      if (isError(unitText)) return unitText;
      if (endSerial < startSerial) return err(ERR.NUM, 'the end date precedes the start date');

      const a = ymdOf(startSerial);
      const b = ymdOf(endSerial);
      const unit = unitText.trim().toUpperCase();

      if (unit === 'D') return Math.floor(endSerial) - Math.floor(startSerial);
      if (unit === 'Y') {
        let y = b.y - a.y;
        if (b.m < a.m || (b.m === a.m && b.d < a.d)) y--;
        return y;
      }
      if (unit === 'M') {
        let m = (b.y - a.y) * 12 + (b.m - a.m);
        if (b.d < a.d) m--;
        return m;
      }
      if (unit === 'MD') {
        if (b.d >= a.d) return b.d - a.d;
        const prevMonth = b.m === 1 ? 12 : b.m - 1;
        const prevYear = b.m === 1 ? b.y - 1 : b.y;
        return daysInMonth(prevYear, prevMonth) - a.d + b.d;
      }
      if (unit === 'YM') {
        let m = ((b.m - a.m) % 12 + 12) % 12;
        if (b.d < a.d) m = (m - 1 + 12) % 12;
        return m;
      }
      if (unit === 'YD') {
        let years = b.y - a.y;
        if (b.m < a.m || (b.m === a.m && b.d < a.d)) years--;
        const day = Math.min(a.d, daysInMonth(a.y + years, a.m));
        const anniversary = dateToSerial(utcDate(a.y + years, a.m, day));
        return Math.floor(endSerial) - anniversary;
      }
      return err(ERR.NUM, 'unsupported unit: ' + unitText);
    },
  },

  TIME: {
    minArgs: 3,
    maxArgs: 3,
    fn: (args) => {
      const h = int(args[0]);
      if (isError(h)) return h;
      const mi = int(args[1]);
      if (isError(mi)) return mi;
      const s = int(args[2]);
      if (isError(s)) return s;
      const total = h * 3600 + mi * 60 + s;
      if (total < 0) return err(ERR.NUM, 'time must not be negative');
      return (total % SECONDS_PER_DAY) / SECONDS_PER_DAY;
    },
  },
};

/* ================================================================== *
 * 7. Information
 * ================================================================== */

const INFO_FUNCTIONS = {
  ISBLANK: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => scalarOf(args[0]) === null,
  },

  ISNUMBER: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => typeof scalarOf(args[0]) === 'number',
  },

  ISTEXT: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => typeof scalarOf(args[0]) === 'string',
  },

  ISERROR: {
    minArgs: 1,
    maxArgs: 1,
    // Deliberately does not propagate: detecting the error is the point.
    fn: (args) => isError(scalarOf(args[0])),
  },

  ISERR: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const v = scalarOf(args[0]);
      return isError(v) && v.code !== ERR.NA;
    },
  },

  ISNA: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const v = scalarOf(args[0]);
      return isError(v) && v.code === ERR.NA;
    },
  },

  ISLOGICAL: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => typeof scalarOf(args[0]) === 'boolean',
  },

  NA: { minArgs: 0, maxArgs: 0, fn: () => err(ERR.NA, 'value not available') },

  TYPE: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const v = args[0];
      if (v instanceof RangeValue) return 64;
      if (isError(v)) return 16;
      if (typeof v === 'boolean') return 4;
      if (typeof v === 'string') return 2;
      return 1;
    },
  },
};

/* ================================================================== *
 * Registry
 * ================================================================== */

/**
 * The complete function library, keyed by UPPERCASE name.
 * @type {Record<string, {minArgs:number,maxArgs:number,lazy?:boolean,volatile?:boolean,fn:Function}>}
 */
export const FUNCTIONS = {
  ...MATH_FUNCTIONS,
  ...STAT_FUNCTIONS,
  ...LOGIC_FUNCTIONS,
  ...TEXT_FUNCTIONS,
  ...LOOKUP_FUNCTIONS,
  ...DATE_FUNCTIONS,
  ...INFO_FUNCTIONS,
};

/**
 * Look up a function definition by name, case-insensitively.
 *
 * @param {string} name Function name as written in the formula.
 * @returns {object|undefined} The definition, or `undefined` when the name is unknown.
 */
export function getFunction(name) {
  if (typeof name !== 'string') return undefined;
  const key = name.toUpperCase();
  return HAS_OWN.call(FUNCTIONS, key) ? FUNCTIONS[key] : undefined;
}
