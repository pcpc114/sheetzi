// shared/formula/engine.js
// SheetEngine: cell storage, input coercion, dependency graph, recalculation.
//
// Pure ESM. Runs unchanged in Node and in the browser: no Node builtins,
// no browser globals, no npm imports.
//
// Internal cell record shape:
//   { input: string, style: object|undefined, ast: object|null,
//     value: value, isFormula: boolean, volatile: boolean }
// Formula ASTs are parsed once, on write, and cached: recalc never re-parses.

import { ERR, err, isError } from './errors.js';
import {
  MAX_ROWS,
  MAX_COLS,
  colToLetter,
  cellToA1,
  a1ToCell,
  normalizeRange,
  containsCell,
  shiftRefForStructuralEdit,
} from './refs.js';
import { parse, serialize, collectRefs, mapRefs } from './parser.js';
import { RangeValue, dateToSerial } from './values.js';
import { getFunction } from './functions.js';
import { evaluate } from './evaluator.js';

// Literal-input coercion patterns.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const PERCENT_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*%$/;
const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

// Materializing a range never allocates more than this many cells; oversized
// ranges (A:ZZ and friends) are clipped to the sheet's used extent first.
const RANGE_SOFT_CAP = 100000;
const RANGE_HARD_CAP = 200000;

export class SheetEngine {
  constructor({ rows = 200, cols = 26, cells = {}, resolveSheet = null } = {}) {
    this.rows = clampInt(rows, 1, MAX_ROWS, 200);
    this.cols = clampInt(cols, 1, MAX_COLS, 26);
    // Optional workbook hook for cross-sheet references (SPEC section 16). When it is
    // absent, the evaluator turns `=시트2!A1` into a #REF! that says so in Korean.
    // Everything above it — tokenizer, parser, AST, serializer — already understands the
    // syntax, so enabling cross-sheet reads later is this one wire plus cross-sheet
    // invalidation, not a rewrite.
    /** @type {((name: string) => object|null)|null} */
    this.resolveSheet = typeof resolveSheet === 'function' ? resolveSheet : null;

    /** @type {Map<string, object>} A1 -> cell record */
    this.cells = new Map();
    /** @type {Map<string, Set<string>>} A1 -> set of cells it reads */
    this.precedents = new Map();
    /** @type {Map<string, Set<string>>} A1 -> set of cells that read it */
    this.dependents = new Map();
    // Range precedents live in their OWN list, keyed by the dependent formula.
    // They are matched with containsCell(), so writing into a currently blank
    // cell inside A1:A100 still invalidates =SUM(A1:A100).
    /** @type {Map<string, object[]>} A1 -> normalized Range[] */
    this.rangeDeps = new Map();

    this._extentDirty = true;
    this._maxRowUsed = -1;
    this._maxColUsed = -1;

    this.bulkLoad(cells || {});
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------

  setInput(a1, input) {
    const key = normKey(a1);
    const existed = this.cells.has(key);
    this._write(key, input);
    const changed = this._recalcPass([key]);
    if (existed || this.cells.has(key)) changed.add(key);
    return changed;
  }

  setInputs(map) {
    const keys = [];
    const touched = [];
    if (map && typeof map === 'object') {
      for (const raw of Object.keys(map)) {
        const key = softKey(raw);
        if (key === null) continue;
        const existed = this.cells.has(key);
        this._write(key, map[raw]);
        keys.push(key);
        if (existed || this.cells.has(key)) touched.push(key);
      }
    }
    const changed = this._recalcPass(keys);
    for (let i = 0; i < touched.length; i++) changed.add(touched[i]);
    return changed;
  }

  getInput(a1) {
    const key = softKey(a1);
    if (key === null) return '';
    const rec = this.cells.get(key);
    return rec && typeof rec.input === 'string' ? rec.input : '';
  }

  getValue(a1) {
    const key = softKey(a1);
    if (key === null) return null;
    const rec = this.cells.get(key);
    if (!rec) return null;
    return rec.value === undefined ? null : rec.value;
  }

  getValues() {
    const out = {};
    for (const [key, rec] of this.cells) {
      if (!hasInput(rec)) continue;
      out[key] = rec.value === undefined ? null : rec.value;
    }
    return out;
  }

  isFormula(a1) {
    const key = softKey(a1);
    if (key === null) return false;
    const rec = this.cells.get(key);
    return !!(rec && rec.isFormula);
  }

  bulkLoad(cells) {
    this.cells = new Map();
    this.precedents = new Map();
    this.dependents = new Map();
    this.rangeDeps = new Map();
    this._extentDirty = true;

    if (cells && typeof cells === 'object') {
      for (const raw of Object.keys(cells)) {
        const entry = cells[raw];
        if (entry === null || entry === undefined) continue;
        const key = softKey(raw);
        if (key === null) continue;
        // The documented shape is { input, style? }; a bare string is accepted
        // as a shorthand for { input }.
        const cell = typeof entry === 'object' ? entry : { input: String(entry) };
        const rec = this._ensure(key);
        // Style first: an explicit fmt must survive input coercion.
        if (cell.style && typeof cell.style === 'object') rec.style = { ...cell.style };
        const input = cell.input === null || cell.input === undefined ? '' : String(cell.input);
        this._write(key, input);
      }
    }
    return this.recalcAll();
  }

  toJSON() {
    return { rows: this.rows, cols: this.cols, cells: this._cellsSnapshot() };
  }

  recalcAll() {
    const seeds = [];
    for (const [key, rec] of this.cells) {
      if (rec.isFormula) seeds.push(key);
    }
    return this._recalcPass(seeds);
  }

  getStyle(a1) {
    const key = softKey(a1);
    if (key === null) return {};
    const rec = this.cells.get(key);
    return rec && rec.style ? { ...rec.style } : {};
  }

  setStyle(a1, styleObj) {
    const key = normKey(a1);
    const rec = this._ensure(key);
    if (styleObj === null || styleObj === undefined) {
      // A null style clears every property (matches the wire protocol).
      rec.style = undefined;
    } else if (typeof styleObj === 'object') {
      const merged = rec.style ? { ...rec.style } : {};
      for (const prop of Object.keys(styleObj)) {
        const v = styleObj[prop];
        if (v === null) delete merged[prop];
        else merged[prop] = v;
      }
      rec.style = Object.keys(merged).length ? merged : undefined;
    }
    // A styleless, inputless cell is not worth storing.
    if (!hasInput(rec) && !rec.style) {
      this.cells.delete(key);
      this._extentDirty = true;
      return {};
    }
    return rec.style ? { ...rec.style } : {};
  }

  applyStructuralEdit(edit) {
    const kind = edit && edit.kind;
    if (kind !== 'insertRow' && kind !== 'deleteRow' && kind !== 'insertCol' && kind !== 'deleteCol') {
      return this.toJSON();
    }
    const index = clampInt(edit.index, 0, Math.max(MAX_ROWS, MAX_COLS), 0);
    const count = clampInt(edit.count === undefined ? 1 : edit.count, 1, Math.max(MAX_ROWS, MAX_COLS), 1);
    const norm = { kind, index, count };

    const isRow = kind === 'insertRow' || kind === 'deleteRow';
    const inserting = kind === 'insertRow' || kind === 'insertCol';
    const limit = isRow ? MAX_ROWS : MAX_COLS;

    // 1. Relocate cell contents.
    const moved = new Map();
    for (const [key, rec] of this.cells) {
      const { row, col } = a1ToCell(key);
      let axis = isRow ? row : col;
      if (inserting) {
        if (axis >= index) axis += count;
      } else if (axis >= index && axis < index + count) {
        continue; // inside the deleted band: the cell is gone
      } else if (axis >= index + count) {
        axis -= count;
      }
      if (axis < 0 || axis >= limit) continue; // pushed off the addressable sheet
      moved.set(isRow ? cellToA1(axis, col) : cellToA1(row, axis), rec);
    }
    this.cells = moved;
    this._extentDirty = true;

    // 2. Rewrite EVERY surviving formula, moved or not: a structural edit
    //    shifts absolute and relative references alike.
    this.precedents = new Map();
    this.dependents = new Map();
    this.rangeDeps = new Map();
    for (const [key, rec] of this.cells) {
      if (!rec.isFormula || !rec.ast) continue;
      let next = rec.ast;
      try {
        next = mapRefs(rec.ast, (ref) => shiftRefForStructuralEdit(ref, norm));
      } catch (e) {
        next = rec.ast;
      }
      rec.ast = next;
      try {
        rec.input = '=' + serialize(next);
      } catch (e) {
        // keep the previous text if serialization somehow fails
      }
      rec.volatile = astVolatile(next);
      this._registerDeps(key, next);
    }

    // 3. Full recalc, then hand back the new snapshot.
    this.recalcAll();
    return this.toJSON();
  }

  // -------------------------------------------------------------------------
  // writing / coercion
  // -------------------------------------------------------------------------

  _ensure(key) {
    let rec = this.cells.get(key);
    if (!rec) {
      rec = { input: '', style: undefined, ast: null, value: null, isFormula: false, volatile: false };
      this.cells.set(key, rec);
      this._extentDirty = true;
    }
    return rec;
  }

  // Applies one write without recalculating.
  _write(key, input) {
    this._clearDeps(key);

    if (input === null || input === undefined || input === '') {
      const rec = this.cells.get(key);
      if (!rec) return;
      if (rec.style && Object.keys(rec.style).length) {
        // Keep the formatting, drop the content.
        rec.input = '';
        rec.ast = null;
        rec.value = null;
        rec.isFormula = false;
        rec.volatile = false;
      } else {
        this.cells.delete(key);
        this._extentDirty = true;
      }
      return;
    }

    const text = String(input);
    const rec = this._ensure(key);
    rec.input = text;

    if (text.charCodeAt(0) === 61 /* = */) {
      rec.isFormula = true;
      try {
        const ast = parse(text.slice(1));
        rec.ast = ast;
        rec.volatile = astVolatile(ast);
        rec.value = undefined; // filled in by the recalc pass
        this._registerDeps(key, ast);
      } catch (e) {
        // ParseError (or anything else the parser throws): the cell holds
        // #ERROR! and has no precedents at all.
        rec.ast = null;
        rec.volatile = false;
        rec.value = err(ERR.PARSE, e && e.message ? String(e.message) : 'parse error');
      }
      return;
    }

    rec.isFormula = false;
    rec.ast = null;
    rec.volatile = false;
    rec.value = this._coerceInput(rec, text);
  }

  // Literal input -> stored value. May default style.fmt for dates/percentages.
  _coerceInput(rec, text) {
    // A leading apostrophe forces text; it is stripped from the value but the
    // raw input (with the apostrophe) is what getInput returns.
    if (text.charCodeAt(0) === 39 /* ' */) return text.slice(1);

    const t = text.trim();
    if (t === '') return text;

    if (NUMBER_RE.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return n;
    }

    const upper = t.toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;

    const serial = parseDateSerial(t);
    if (serial !== null) {
      defaultFmt(rec, 'date');
      return serial;
    }

    const pct = PERCENT_RE.exec(t);
    if (pct) {
      const n = Number(pct[1]);
      if (Number.isFinite(n)) {
        defaultFmt(rec, 'percent');
        return n / 100;
      }
    }

    return text;
  }

  // -------------------------------------------------------------------------
  // dependency graph
  // -------------------------------------------------------------------------

  _registerDeps(key, ast) {
    if (!ast) return;
    let refs;
    try {
      refs = collectRefs(ast);
    } catch (e) {
      return;
    }
    if (!refs) return;

    const cells = Array.isArray(refs.cells) ? refs.cells : [];
    if (cells.length) {
      let set = this.precedents.get(key);
      if (!set) {
        set = new Set();
        this.precedents.set(key, set);
      }
      for (let i = 0; i < cells.length; i++) {
        const pk = softKey(cells[i]);
        if (pk === null) continue;
        // Self references are kept on purpose: that is how =A1 in A1 becomes
        // a detected cycle rather than a silent no-op.
        set.add(pk);
        let back = this.dependents.get(pk);
        if (!back) {
          back = new Set();
          this.dependents.set(pk, back);
        }
        back.add(key);
      }
      if (!set.size) this.precedents.delete(key);
    }

    const ranges = Array.isArray(refs.ranges) ? refs.ranges : [];
    if (ranges.length) {
      const list = [];
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        if (!r || !r.s || !r.e) continue;
        try {
          list.push(normalizeRange(r));
        } catch (e) {
          // ignore an unusable range
        }
      }
      if (list.length) this.rangeDeps.set(key, list);
    }
  }

  _clearDeps(key) {
    const set = this.precedents.get(key);
    if (set) {
      for (const pk of set) {
        const back = this.dependents.get(pk);
        if (back) {
          back.delete(key);
          if (!back.size) this.dependents.delete(pk);
        }
      }
      this.precedents.delete(key);
    }
    this.rangeDeps.delete(key);
  }

  // Cells that must be recomputed when `key` changes: direct readers plus every
  // formula whose range precedents contain the cell.
  _dependentsOf(key) {
    const out = [];
    const direct = this.dependents.get(key);
    if (direct) for (const k of direct) out.push(k);
    if (this.rangeDeps.size) {
      let coord;
      try {
        coord = a1ToCell(key);
      } catch (e) {
        return out;
      }
      for (const [dep, ranges] of this.rangeDeps) {
        for (let i = 0; i < ranges.length; i++) {
          if (containsCell(ranges[i], coord.row, coord.col)) {
            out.push(dep);
            break;
          }
        }
      }
    }
    return out;
  }

  // Precedents of `key` restricted to the current dirty set (the only edges the
  // topological sort cares about).
  _predsInSet(key, set, coords) {
    const out = [];
    const seen = new Set();
    const direct = this.precedents.get(key);
    if (direct) {
      for (const pk of direct) {
        if (set.has(pk) && !seen.has(pk)) {
          seen.add(pk);
          out.push(pk);
        }
      }
    }
    const ranges = this.rangeDeps.get(key);
    if (ranges && ranges.length) {
      for (const other of set) {
        if (seen.has(other)) continue;
        const coord = coords.get(other);
        if (!coord) continue;
        for (let i = 0; i < ranges.length; i++) {
          if (containsCell(ranges[i], coord.row, coord.col)) {
            seen.add(other);
            out.push(other);
            break;
          }
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // recalculation
  // -------------------------------------------------------------------------

  _recalcPass(seeds) {
    const dirty = new Set();
    const stack = [];
    const push = (k) => {
      if (!dirty.has(k)) {
        dirty.add(k);
        stack.push(k);
      }
    };

    if (seeds) for (const k of seeds) push(k);
    // Volatile formulas recalculate on every pass.
    for (const [k, rec] of this.cells) {
      if (rec.isFormula && rec.volatile) push(k);
    }
    // Transitive closure over cell dependents AND range dependents.
    while (stack.length) {
      const deps = this._dependentsOf(stack.pop());
      for (let i = 0; i < deps.length; i++) push(deps[i]);
    }

    const changed = new Set();
    if (!dirty.size) return changed;

    const coords = new Map();
    for (const k of dirty) {
      try {
        coords.set(k, a1ToCell(k));
      } catch (e) {
        // unreachable for canonical keys
      }
    }

    const { order, cycle } = this._topo(dirty, coords);

    // One shared clock for the whole pass, so NOW()/TODAY() are stable.
    const now = new Date();
    const getCell = (row, col) => this._cellValue(row, col);
    const getRangeValue = (range) => this._rangeValue(range);
    const resolveSheet = this.resolveSheet;

    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const rec = this.cells.get(key);
      if (!rec || !rec.isFormula) continue; // literals were computed on write
      const prev = rec.value === undefined ? null : rec.value;
      let next;
      if (cycle.has(key)) {
        next = err(ERR.CYCLE, 'circular reference');
      } else if (!rec.ast) {
        next = prev; // parse-error cell keeps its #ERROR!
      } else {
        const coord = coords.get(key) || { row: 0, col: 0 };
        try {
          next = evaluate(rec.ast, {
            getCell, getRangeValue, resolveSheet, cell: { row: coord.row, col: coord.col }, now,
          });
        } catch (e) {
          next = err(ERR.VALUE, e && e.message ? String(e.message) : 'evaluation failed');
        }
      }
      if (next === undefined) next = null;
      rec.value = next;
      if (!sameValue(prev, next)) changed.add(key);
    }
    return changed;
  }

  // Iterative DFS topological sort over the dirty subgraph (edges point from a
  // formula to its precedents, so precedents finish first). Back edges mark
  // every cell on the current path as part of a cycle. Never recurses, so a
  // cycle can neither hang nor blow the stack.
  _topo(dirty, coords) {
    const order = [];
    const cycle = new Set();
    const status = new Map(); // key -> 1 visiting, 2 done
    const path = [];
    const pathIndex = new Map();

    for (const start of dirty) {
      if (status.get(start)) continue;
      status.set(start, 1);
      pathIndex.set(start, path.length);
      path.push(start);
      const stack = [{ key: start, preds: this._predsInSet(start, dirty, coords), i: 0 }];

      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.i < top.preds.length) {
          const next = top.preds[top.i++];
          const st = status.get(next) || 0;
          if (st === 0) {
            status.set(next, 1);
            pathIndex.set(next, path.length);
            path.push(next);
            stack.push({ key: next, preds: this._predsInSet(next, dirty, coords), i: 0 });
          } else if (st === 1) {
            // Back edge: everything from `next` to the top of the path is on a cycle.
            const from = pathIndex.get(next);
            if (from !== undefined) {
              for (let j = from; j < path.length; j++) cycle.add(path[j]);
            }
          }
        } else {
          stack.pop();
          const done = path.pop();
          pathIndex.delete(done);
          status.set(top.key, 2);
          order.push(top.key);
        }
      }
    }
    return { order, cycle };
  }

  // -------------------------------------------------------------------------
  // value access for the evaluator
  // -------------------------------------------------------------------------

  _cellValue(row, col) {
    if (typeof row !== 'number' || typeof col !== 'number' || !Number.isFinite(row) || !Number.isFinite(col)) {
      return err(ERR.REF, 'invalid reference');
    }
    const r = Math.trunc(row);
    const c = Math.trunc(col);
    if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) return err(ERR.REF, 'reference out of bounds');
    const rec = this.cells.get(cellToA1(r, c));
    if (!rec) return null; // blank cells are null, never ''
    return rec.value === undefined ? null : rec.value;
  }

  _rangeValue(range) {
    let r;
    try {
      r = normalizeRange(range);
    } catch (e) {
      return err(ERR.REF, 'invalid range');
    }
    if (!r || !r.s || !r.e) return err(ERR.REF, 'invalid range');
    if (![r.s.row, r.s.col, r.e.row, r.e.col].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return err(ERR.REF, 'invalid range');
    }

    let r0 = Math.max(0, Math.trunc(r.s.row));
    let c0 = Math.max(0, Math.trunc(r.s.col));
    let r1 = Math.min(MAX_ROWS - 1, Math.trunc(r.e.row));
    let c1 = Math.min(MAX_COLS - 1, Math.trunc(r.e.col));
    if (r1 < r0 || c1 < c0) return new RangeValue([[null]]);

    // Whole-column / whole-row ranges are clipped to what the sheet actually
    // uses so SUM(A:A) does not allocate five thousand empty slots per pass.
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > RANGE_SOFT_CAP) {
      const ext = this._extent();
      r1 = Math.min(r1, Math.max(r0, this.rows - 1, ext.row));
      c1 = Math.min(c1, Math.max(c0, this.cols - 1, ext.col));
      const width = c1 - c0 + 1;
      if ((r1 - r0 + 1) * width > RANGE_HARD_CAP) {
        r1 = r0 + Math.max(0, Math.floor(RANGE_HARD_CAP / width) - 1);
      }
    }

    const letters = [];
    for (let c = c0; c <= c1; c++) letters.push(colToLetter(c));
    const rows = [];
    for (let row = r0; row <= r1; row++) {
      const line = new Array(letters.length);
      const suffix = String(row + 1);
      for (let i = 0; i < letters.length; i++) {
        const rec = this.cells.get(letters[i] + suffix);
        line[i] = rec && rec.value !== undefined ? rec.value : null;
      }
      rows.push(line);
    }
    return new RangeValue(rows);
  }

  // Largest used row/col, cached until the cell set changes.
  _extent() {
    if (this._extentDirty) {
      let maxRow = -1;
      let maxCol = -1;
      for (const key of this.cells.keys()) {
        let coord;
        try {
          coord = a1ToCell(key);
        } catch (e) {
          continue;
        }
        if (coord.row > maxRow) maxRow = coord.row;
        if (coord.col > maxCol) maxCol = coord.col;
      }
      this._maxRowUsed = maxRow;
      this._maxColUsed = maxCol;
      this._extentDirty = false;
    }
    return { row: this._maxRowUsed, col: this._maxColUsed };
  }

  _cellsSnapshot() {
    const cells = {};
    for (const [key, rec] of this.cells) {
      const style = rec.style && Object.keys(rec.style).length ? { ...rec.style } : null;
      const input = hasInput(rec) ? rec.input : '';
      if (input === '' && !style) continue; // no empty entries
      const entry = { input };
      if (style) entry.style = style;
      cells[key] = entry;
    }
    return cells;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasInput(rec) {
  return !!rec && typeof rec.input === 'string' && rec.input !== '';
}

function clampInt(n, min, max, fallback) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

// Canonical key: uppercase A1 with no '$'. Throws RangeError on garbage.
function normKey(a1) {
  if (typeof a1 !== 'string') throw new RangeError('invalid cell reference: ' + String(a1));
  const c = a1ToCell(a1);
  return cellToA1(c.row, c.col);
}

// Lenient variant used by getters and by data coming off the wire.
function softKey(a1) {
  try {
    return normKey(a1);
  } catch (e) {
    return null;
  }
}

function defaultFmt(rec, fmt) {
  if (rec.style && rec.style.fmt) return; // never clobber an explicit format
  if (!rec.style) rec.style = {};
  rec.style.fmt = fmt;
}

// 'YYYY-MM-DD' / 'YYYY/MM/DD' -> Excel-compatible date serial, or null.
function parseDateSerial(text) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  const serial = dateToSerial(d);
  return typeof serial === 'number' && Number.isFinite(serial) ? serial : null;
}

// True when the AST calls at least one volatile function.
function astVolatile(node) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'call': {
      const def = getFunction(String(node.name || '').toUpperCase());
      if (def && def.volatile) return true;
      const args = Array.isArray(node.args) ? node.args : [];
      for (let i = 0; i < args.length; i++) {
        if (astVolatile(args[i])) return true;
      }
      return false;
    }
    case 'binary':
      return astVolatile(node.left) || astVolatile(node.right);
    case 'unary':
    case 'postfix':
      return astVolatile(node.arg);
    default:
      return false;
  }
}

function sameValue(a, b) {
  if (a === b) return true;
  if (isError(a) && isError(b)) return a.code === b.code && a.message === b.message;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  return false;
}
