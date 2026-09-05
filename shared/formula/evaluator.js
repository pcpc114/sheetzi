// shared/formula/evaluator.js
// Turns a parsed formula AST (see SPEC section 5) into a value.
//
// Pure ESM. Runs unchanged in Node and in the browser: no Node builtins,
// no browser globals, no npm imports.
//
// The value domain is: number | string | boolean | null | FormulaError | RangeValue.
// This module never throws for a formula-level problem; it returns a FormulaError.

import { ERR, err, isError } from './errors.js';
import { RangeValue, toNumber, toText, compareValues, equalsLoose } from './values.js';
import { getFunction } from './functions.js';

// Recursion guard. Nested evaluation deeper than this yields #NUM!.
const MAX_DEPTH = 200;

/**
 * Evaluate an AST node.
 *
 * @param {object} node AST node produced by parser.parse()
 * @param {{getCell:Function,getRangeValue:Function,cell:{row:number,col:number},now:Date,
 *          resolveSheet?:Function}} ctx
 *   `resolveSheet(name)` is optional; see {@link foreignSource}. Without it every
 *   cross-sheet reference evaluates to a `#REF!` that explains itself in Korean.
 * @returns {number|string|boolean|null|object} value (FormulaError on failure)
 */
export function evaluate(node, ctx) {
  const state = { depth: 0, base: ctx || {}, fnCtx: null };
  state.fnCtx = makeFnCtx(state);
  // A formula's final result is always scalar: a leftover RangeValue (a lazy
  // function may hand one back) collapses to its top-left cell.
  return collapseResult(evalNode(node, state, false));
}

// ---------------------------------------------------------------------------
// context handed to function implementations
// ---------------------------------------------------------------------------

// The evaluator copies the host ctx and adds evalNode(). getCell/getRangeValue
// are wrapped so the host object stays the receiver (`this`) and so undefined
// never leaks into the value domain.
function makeFnCtx(state) {
  const base = state.base;
  const ctx = {};
  for (const key in base) {
    if (Object.prototype.hasOwnProperty.call(base, key)) ctx[key] = base[key];
  }
  ctx.cell = base.cell && typeof base.cell === 'object' ? base.cell : { row: 0, col: 0 };
  ctx.now = base.now || new Date();
  ctx.getCell = (row, col) => readCell(base, row, col);
  // A Range built from a sheet-qualified AST node still carries its `sheet`, so a function
  // that hands one back (OFFSET, INDIRECT) reads the sheet the user actually named.
  ctx.getRangeValue = (range) => {
    const name = sheetOf(range);
    if (name === null) return readRange(base, range);
    const src = foreignSource(base, name);
    return isError(src) ? src : readRange(src, localRange(range));
  };
  // Lazy functions evaluate their AST arguments through this. Range-preserving,
  // so AND(A1:A5) and SUM(IFERROR(A1:A5,0)) see the whole range.
  ctx.evalNode = (n) => evalNode(n, state, true);
  return ctx;
}

function readCell(base, row, col) {
  const r = toIndex(row);
  const c = toIndex(col);
  if (r === null || c === null) return err(ERR.REF, 'invalid reference');
  if (!base || typeof base.getCell !== 'function') return err(ERR.REF, 'no cell source');
  const v = base.getCell(r, c);
  return v === undefined ? null : v;
}

function readRange(base, range) {
  if (!range || !range.s || !range.e) return err(ERR.REF, 'invalid range');
  if (!base || typeof base.getRangeValue !== 'function') return err(ERR.REF, 'no range source');
  const v = base.getRangeValue(range);
  if (v === undefined || v === null) return new RangeValue([[null]]);
  return v;
}

function toIndex(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i < 0 ? null : i;
}

// ---------------------------------------------------------------------------
// cross-sheet references (SPEC section 16)
// ---------------------------------------------------------------------------

/**
 * The foreign sheet named by a ref/range node or by a Range, or null when it belongs to
 * the sheet being evaluated. Nodes written before sheets existed have no `sheet` field at
 * all, which counts as local.
 *
 * @param {object} x AST node or Range.
 * @returns {string|null} A non-empty sheet name, or null.
 */
function sheetOf(x) {
  const name = x && x.sheet;
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * A copy of `range` with the qualifier stripped. The source has already been chosen by the
 * time the range reaches it, so it must see plain coordinates and never re-resolve.
 *
 * @param {{s:object, e:object, wholeCol?:boolean, wholeRow?:boolean}} range Range.
 * @returns {{s:object, e:object, wholeCol?:true, wholeRow?:true}} Local range.
 */
function localRange(range) {
  const out = { s: { ...range.s }, e: { ...range.e } };
  if (range.wholeCol) out.wholeCol = true;
  if (range.wholeRow) out.wholeRow = true;
  return out;
}

/**
 * Cross-sheet evaluation is not wired up yet (SPEC 16.3), so the user must be told why in
 * their own language rather than being handed a silent zero or a bare '#REF!'.
 *
 * @param {string} name Sheet name as written in the formula.
 * @returns {object} FormulaError.
 */
function crossSheetUnsupported(name) {
  return err(ERR.REF, '다른 시트 참조는 아직 지원하지 않습니다: ' + String(name));
}

/**
 * Resolve a sheet name to a value source through the optional `ctx.resolveSheet` hook.
 *
 * The result is read with the very same getCell / getRangeValue shape as the local sheet,
 * so switching cross-sheet evaluation on later is purely a matter of supplying the hook.
 *
 * @param {object} base The host ctx passed to evaluate().
 * @param {string} name Sheet name.
 * @returns {object} A source object, or a FormulaError when none is available.
 */
function foreignSource(base, name) {
  const resolve = base ? base.resolveSheet : null;
  if (typeof resolve !== 'function') return crossSheetUnsupported(name);
  let src;
  try {
    src = resolve.call(base, name);
  } catch (e) {
    return crossSheetUnsupported(name);
  }
  if (!src || typeof src !== 'object') return crossSheetUnsupported(name);
  return src;
}

// ---------------------------------------------------------------------------
// core walk
// ---------------------------------------------------------------------------

function evalNode(node, state, preserveRange) {
  if (node === null || node === undefined) return null;
  if (state.depth >= MAX_DEPTH) return err(ERR.NUM, 'too deep');
  state.depth++;
  try {
    const v = evalInner(node, state, preserveRange);
    return v === undefined ? null : v;
  } catch (e) {
    // A misbehaving function implementation must not take the sheet down.
    if (isError(e)) return e;
    return err(ERR.VALUE, e && e.message ? String(e.message) : 'evaluation failed');
  } finally {
    state.depth--;
  }
}

function evalInner(node, state, preserveRange) {
  switch (node.type) {
    case 'num': {
      const n = typeof node.value === 'number' ? node.value : Number(node.value);
      return Number.isFinite(n) ? n : err(ERR.NUM, 'invalid number literal');
    }
    case 'str':
      return node.value === undefined || node.value === null ? '' : String(node.value);
    case 'bool':
      return !!node.value;
    case 'error':
      return err(node.value || ERR.VALUE, '');
    case 'blank':
      return null;
    case 'ref': {
      const name = sheetOf(node);
      if (name === null) return readCell(state.base, node.row, node.col);
      const src = foreignSource(state.base, name);
      return isError(src) ? src : readCell(src, node.row, node.col);
    }
    case 'range': {
      const name = sheetOf(node);
      let src = state.base;
      if (name !== null) {
        src = foreignSource(state.base, name);
        if (isError(src)) return src;
      }
      if (preserveRange) return readRange(src, nodeToRange(node));
      // Scalar position: a range collapses to its top-left cell. Read that one
      // cell directly instead of materializing the whole (possibly huge) range.
      const row = Math.min(num(node.s && node.s.row), num(node.e && node.e.row));
      const col = Math.min(num(node.s && node.s.col), num(node.e && node.e.col));
      return readCell(src, row, col);
    }
    case 'unary': {
      const n = toNumber(evalNode(node.arg, state, false));
      if (isError(n)) return n;
      if (node.op === '-') return -n;
      if (node.op === '+') return n;
      return err(ERR.VALUE, 'unknown unary operator: ' + node.op);
    }
    case 'postfix': {
      if (node.op !== '%') return err(ERR.VALUE, 'unknown postfix operator: ' + node.op);
      const n = toNumber(evalNode(node.arg, state, false));
      if (isError(n)) return n;
      return n / 100;
    }
    case 'binary':
      return evalBinary(node, state);
    case 'call':
      return evalCall(node, state);
    default:
      return err(ERR.VALUE, 'unsupported node type ' + String(node.type));
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// An AST range node already carries the Range shape ({s,e}); hand functions a
// clean copy so nobody mutates the cached AST.
function nodeToRange(node) {
  const range = { s: { ...node.s }, e: { ...node.e } };
  if (node.wholeCol) range.wholeCol = true;
  if (node.wholeRow) range.wholeRow = true;
  return range;
}

function evalBinary(node, state) {
  const op = node.op;
  // Both operands sit in scalar position.
  const a = evalNode(node.left, state, false);
  if (isError(a)) return a;
  const b = evalNode(node.right, state, false);
  if (isError(b)) return b;

  switch (op) {
    case '&': {
      const x = toText(a);
      if (isError(x)) return x;
      const y = toText(b);
      if (isError(y)) return y;
      return x + y;
    }
    case '=':
    case '<>': {
      const eq = equalsLoose(a, b);
      if (isError(eq)) return eq;
      return op === '=' ? !!eq : !eq;
    }
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const c = compareValues(a, b);
      if (isError(c)) return c;
      if (op === '<') return c < 0;
      if (op === '>') return c > 0;
      if (op === '<=') return c <= 0;
      return c >= 0;
    }
    case '+':
    case '-':
    case '*':
    case '/':
    case '^': {
      const x = toNumber(a);
      if (isError(x)) return x;
      const y = toNumber(b);
      if (isError(y)) return y;
      let r;
      if (op === '+') r = x + y;
      else if (op === '-') r = x - y;
      else if (op === '*') r = x * y;
      else if (op === '/') {
        if (y === 0) return err(ERR.DIV0, 'division by zero');
        r = x / y;
      } else r = Math.pow(x, y);
      if (typeof r !== 'number' || !Number.isFinite(r)) return err(ERR.NUM, 'result is not a finite number');
      return r;
    }
    default:
      return err(ERR.VALUE, 'unknown operator: ' + String(op));
  }
}

function evalCall(node, state) {
  const name = String(node.name || '').toUpperCase();
  const def = getFunction(name);
  if (!def || typeof def.fn !== 'function') return err(ERR.NAME, name);

  const args = Array.isArray(node.args) ? node.args : [];
  // Arity is enforced here, before fn ever runs.
  const min = typeof def.minArgs === 'number' ? def.minArgs : 0;
  const max = typeof def.maxArgs === 'number' ? def.maxArgs : Infinity;
  if (args.length < min || args.length > max) return err(ERR.VALUE, 'wrong number of arguments');

  if (def.lazy) return def.fn(args, state.fnCtx);

  // Eager: arguments are evaluated in range-preserving mode so SUM(A1:A5)
  // receives one RangeValue rather than the top-left cell. Errors are NOT
  // short-circuited here: each function decides (ISERROR/IFERROR/COUNT need
  // to see them).
  const values = new Array(args.length);
  for (let i = 0; i < args.length; i++) values[i] = evalNode(args[i], state, true);
  return def.fn(values, state.fnCtx);
}

// ---------------------------------------------------------------------------
// result normalization
// ---------------------------------------------------------------------------

function isRangeValue(v) {
  if (v instanceof RangeValue) return true;
  return !!v && typeof v === 'object' && Array.isArray(v.rows) && typeof v.flat === 'function';
}

function collapseResult(v) {
  if (v === undefined) return null;
  if (isRangeValue(v)) {
    const rows = v.rows;
    if (!rows || !rows.length || !rows[0] || !rows[0].length) return null;
    const first = rows[0][0];
    return first === undefined ? null : first;
  }
  return v;
}
