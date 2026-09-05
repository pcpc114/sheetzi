// clipboard.js — copy / cut / paste bridging the grid and the system clipboard.
//
//   serializeSelection -> { text (TSV of display values), html (a table), inputs (raw 2D) }
//   parseClipboard     -> string[][] from TSV or CSV (quoted fields supported)
//   pasteInto          -> a cells patch; it never touches the engine itself.
//   parseExternalHtml  -> a grid imported from another spreadsheet's text/html (SPEC 26)

import { parse, serialize, mapRefs } from '/shared/formula/parser.js';
import {
  cellToA1, a1ToCell, isA1, parseRange, offsetRef, MAX_ROWS, MAX_COLS,
} from '/shared/formula/refs.js';
import { FONT_STACKS, sanitizeBorder, fontStackFor} from '/shared/model.js';
import { formatValue } from './format.js';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// ---------------------------------------------------------------- utilities

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Attribute-safe: whitespace inside an attribute value would be normalized. */
function escapeAttr(s) {
  return escapeHtml(s)
    .replace(/\t/g, '&#9;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

/** Cell text: keep line breaks visible when pasted into Excel/Sheets. */
function escapeCellHtml(s) {
  return escapeHtml(s).replace(/\r\n|\r|\n/g, '<br>');
}

/** Quote a TSV/CSV field only when it needs it. */
function delimitedField(value, delim) {
  const s = value == null ? '' : String(value);
  if (s.indexOf(delim) < 0 && s.indexOf('\n') < 0 && s.indexOf('\r') < 0 && s.indexOf('"') < 0) {
    return s;
  }
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * A detached copy of a cell style. Only `bd` is nested (its four edges are objects),
 * so one extra level is enough — but it IS necessary: without it the clipboard would
 * alias the live document and a later border change would rewrite what was copied.
 */
function cloneStyle(st) {
  if (!st || typeof st !== 'object') return null;
  const out = {};
  for (const k of Object.keys(st)) {
    const v = st[k];
    if (k === 'bd' && v && typeof v === 'object') {
      const bd = {};
      for (const side of Object.keys(v)) {
        bd[side] = v[side] && typeof v[side] === 'object' ? { ...v[side] } : v[side];
      }
      out.bd = bd;
    } else {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Cell style -> inline CSS, so a paste into Excel/Sheets keeps the look.
 *
 * This must emit everything `styleFromDeclarations` below knows how to read back. It is
 * not only what other applications see: a copy made in one 시트지 tab and pasted into
 * ANOTHER one takes the external path, because the internal clipboard is per-window. Any
 * property missing here is therefore silently dropped on a cross-tab paste — while the
 * toast still says 서식 포함.
 */
function styleToCss(st) {
  if (!st || typeof st !== 'object') return '';
  const css = [];
  if (st.b) css.push('font-weight:700');
  if (st.i) css.push('font-style:italic');
  const deco = [];
  if (st.u) deco.push('underline');
  if (st.s) deco.push('line-through');
  if (deco.length) css.push('text-decoration:' + deco.join(' '));
  if (st.align === 'left' || st.align === 'center' || st.align === 'right') {
    css.push('text-align:' + st.align);
  }
  if (typeof st.bg === 'string' && HEX_COLOR.test(st.bg)) css.push('background-color:' + st.bg);
  if (typeof st.fg === 'string' && HEX_COLOR.test(st.fg)) css.push('color:' + st.fg);

  // The four the exporter used to forget.
  if (typeof st.ff === 'string' && st.ff) {
    const stack = fontStackFor(st.ff);
    if (stack) css.push('font-family:' + stack);
  }
  if (Number.isFinite(st.fs) && st.fs > 0) css.push('font-size:' + Math.round(st.fs) + 'px');
  if (st.va === 'top' || st.va === 'middle' || st.va === 'bottom') {
    css.push('vertical-align:' + (st.va === 'middle' ? 'middle' : st.va));
  }
  if (st.bd && typeof st.bd === 'object') {
    for (const [key, side] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) {
      const edge = st.bd[key];
      if (!edge || typeof edge !== 'object') continue;
      const w = Number.isFinite(edge.w) ? Math.round(edge.w) : 1;
      const style = typeof edge.s === 'string' ? edge.s : 'solid';
      const colour = typeof edge.c === 'string' && HEX_COLOR.test(edge.c) ? edge.c : '#000000';
      css.push('border-' + side + ':' + w + 'px ' + style + ' ' + colour);
    }
  }
  return css.join(';');
}

/** Accept a Range, a selection ({active, range}), an A1 string, or {row,col}. */
function resolveRange(sel) {
  if (!sel) return null;

  if (typeof sel === 'string') {
    try {
      return rectOf(parseRange(sel));
    } catch (e) {
      try {
        const c = a1ToCell(sel);
        return { s: { row: c.row, col: c.col }, e: { row: c.row, col: c.col } };
      } catch (e2) {
        return null;
      }
    }
  }
  if (sel.s && sel.e) return rectOf(sel);
  if (sel.range && sel.range.s && sel.range.e) return rectOf(sel.range);
  if (typeof sel.active === 'string') {
    try {
      const c = a1ToCell(sel.active);
      return { s: { row: c.row, col: c.col }, e: { row: c.row, col: c.col } };
    } catch (e) {
      return null;
    }
  }
  if (Number.isFinite(sel.row) && Number.isFinite(sel.col)) {
    return { s: { row: sel.row, col: sel.col }, e: { row: sel.row, col: sel.col } };
  }
  return null;
}

/** Normalized {s,e} rectangle of plain {row,col} corners. */
function rectOf(range) {
  const sr = Number(range.s.row) || 0;
  const sc = Number(range.s.col) || 0;
  const er = Number(range.e.row) || 0;
  const ec = Number(range.e.col) || 0;
  return {
    s: { row: Math.min(sr, er), col: Math.min(sc, ec) },
    e: { row: Math.max(sr, er), col: Math.max(sc, ec) },
  };
}

/** Source anchor (top-left of the copied region) used for relative translation. */
function resolveAnchor(opts) {
  if (!opts) return null;
  const candidates = [opts.sourceAnchor, opts.anchor, opts.origin, opts.sourceRange, opts.source];
  for (const cand of candidates) {
    if (cand === undefined || cand === null) continue;
    if (typeof cand === 'string') {
      try {
        const c = a1ToCell(cand);
        return { row: c.row, col: c.col };
      } catch (e) {
        try {
          const r = rectOf(parseRange(cand));
          return { row: r.s.row, col: r.s.col };
        } catch (e2) { continue; }
      }
    }
    const rect = resolveRange(cand);
    if (rect) return { row: rect.s.row, col: rect.s.col };
  }
  if (Number.isFinite(opts.sourceRow) && Number.isFinite(opts.sourceCol)) {
    return { row: opts.sourceRow, col: opts.sourceCol };
  }
  return null;
}

/** Coerce anything paste-shaped into a rectangular string[][]. */
function normalizeGrid(grid2d) {
  let rows = grid2d;
  if (typeof rows === 'string') rows = parseClipboard(rows);
  if (!Array.isArray(rows)) return [];
  const out = [];
  let width = 0;
  for (const row of rows) {
    const line = Array.isArray(row)
      ? row.map((v) => (v == null ? '' : String(v)))
      : [row == null ? '' : String(row)];
    if (line.length > width) width = line.length;
    out.push(line);
  }
  if (out.length === 0 || width === 0) return [];
  for (const line of out) {
    while (line.length < width) line.push('');
  }
  return out;
}

function styleAt(styles, i, j) {
  if (!Array.isArray(styles)) return null;
  const row = styles[i];
  if (!Array.isArray(row)) return null;
  const st = row[j];
  return st && typeof st === 'object' ? st : null;
}

/** Shift every relative reference in a formula by (dRow, dCol). */
function translateFormula(input, dRow, dCol) {
  if (dRow === 0 && dCol === 0) return input;
  try {
    const ast = parse(input.slice(1));
    const moved = mapRefs(ast, (ref) => offsetRef(ref, dRow, dCol));
    return '=' + serialize(moved);
  } catch (e) {
    return input; // unparseable text is pasted verbatim
  }
}

// ------------------------------------------------------------------ exports

/**
 * Build the clipboard payload for a selection.
 * @param {object} engine SheetEngine
 * @param {object} range  Range | selection | 'A1:B3'
 * @returns {{text:string, html:string, inputs:string[][], styles:(object|null)[][]}}
 */
export function serializeSelection(engine, range) {
  const rect = resolveRange(range);
  if (!rect || !engine) return { text: '', html: '', inputs: [], styles: [] };

  const displayRows = [];
  const inputs = [];
  const styles = [];
  const htmlRows = [];

  for (let r = rect.s.row; r <= rect.e.row; r++) {
    const displayLine = [];
    const inputLine = [];
    const styleLine = [];
    const tds = [];
    for (let c = rect.s.col; c <= rect.e.col; c++) {
      let a1;
      try {
        a1 = cellToA1(r, c);
      } catch (e) {
        continue;
      }
      const value = typeof engine.getValue === 'function' ? engine.getValue(a1) : null;
      const style = typeof engine.getStyle === 'function' ? engine.getStyle(a1) : null;
      const input = typeof engine.getInput === 'function' ? (engine.getInput(a1) || '') : '';
      const display = formatValue(value, style);

      displayLine.push(display);
      inputLine.push(input);
      // A deep copy: the engine hands back its own object, and the clipboard has to
      // survive later edits to the cell it came from. `bd` is a nested object, so a
      // shallow spread would share the border edges with the live document.
      styleLine.push(cloneStyle(style));

      const css = styleToCss(style);
      tds.push(
        '<td'
        + (css ? ' style="' + escapeAttr(css) + '"' : '')
        + (input ? ' data-sz-input="' + escapeAttr(input) + '"' : '')
        + '>' + escapeCellHtml(display) + '</td>',
      );
    }
    displayRows.push(displayLine);
    inputs.push(inputLine);
    styles.push(styleLine);
    htmlRows.push('<tr>' + tds.join('') + '</tr>');
  }

  const text = displayRows
    .map((line) => line.map((v) => delimitedField(v, '\t')).join('\t'))
    .join('\n');

  // The copied range travels with the markup. A copy pasted into ANOTHER 시트지 tab takes
  // the external path (the internal clipboard is per-window), and without an origin the
  // importer has nothing to translate relative references against — =A1+B1 copied from C1
  // would stay =A1+B1 wherever it landed. Google Sheets and Excel ship no such marker, so
  // their formulas can only be pasted verbatim; ours need not be.
  const originA1 = cellToA1(rect.s.row, rect.s.col);
  const html = '<meta charset="utf-8"><table data-sheetzi="1" data-sz-origin="'
    + escapeAttr(originA1) + '" '
    + 'style="border-collapse:collapse"><tbody>'
    + htmlRows.join('')
    + '</tbody></table>';

  // `styles` is what makes an internal paste reproduce the formatting, and `inputs` is what
  // makes it reproduce formulas rather than their printed results; leaving either out of
  // the return silently degrades every paste to values-only. SPEC 12 pins all four fields.
  return { text, html, inputs, styles };
}

/**
 * Parse clipboard text into a rectangular grid. The delimiter (tab or comma)
 * is auto-detected; quoted fields may contain the delimiter, quotes ("") and
 * newlines.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseClipboard(text) {
  if (typeof text !== 'string' || text === '') return [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const delim = detectDelimiter(src);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let i = 0;

  while (i < src.length) {
    const ch = src.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; i += 1; continue; }
    if (ch === delim) { row.push(field); field = ''; atFieldStart = true; i += 1; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
      i += 1;
      continue;
    }
    field += ch;
    atFieldStart = false;
    i += 1;
  }
  row.push(field);
  rows.push(row);

  // A trailing newline yields one spurious empty row.
  if (rows.length > 1) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') rows.pop();
  }

  let width = 0;
  for (const line of rows) if (line.length > width) width = line.length;
  for (const line of rows) while (line.length < width) line.push('');
  return rows;
}

/** Tab wins whenever a top-level tab exists; otherwise comma-separated. */
function detectDelimiter(src) {
  let inQuotes = false;
  let atFieldStart = true;
  let tabs = 0;
  let commas = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') i += 1;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; continue; }
    if (ch === '\t') { tabs += 1; atFieldStart = true; continue; }
    if (ch === ',') { commas += 1; atFieldStart = true; continue; }
    if (ch === '\n') { atFieldStart = true; continue; }
    atFieldStart = false;
  }
  if (tabs > 0) return '\t';
  return commas > 0 ? ',' : '\t';
}

/**
 * Compute the cells patch for pasting `grid2d` at `targetSel`.
 * Formulas get their relative references translated by the paste offset, and
 * the source block is tiled when the target is an exact multiple of it.
 * The engine is only read, never mutated.
 *
 * @param {object} engine    SheetEngine (used for its bounds only)
 * @param {object} targetSel selection | Range | 'A1'
 * @param {string[][]} grid2d raw inputs (or display text) to paste
 * @param {object} [opts]    { sourceAnchor, translate, cut, styles }
 * @returns {object} { 'A1': {input}|{input,style}|{input:null} }
 */
export function pasteInto(engine, targetSel, grid2d, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const patch = {};

  const src = normalizeGrid(grid2d);
  if (src.length === 0) return patch;
  const srcH = src.length;
  const srcW = src[0].length;

  const target = resolveRange(targetSel);
  if (!target) return patch;

  const top = target.s.row;
  const left = target.s.col;
  const tRows = target.e.row - target.s.row + 1;
  const tCols = target.e.col - target.s.col + 1;

  // Tile the source only when the target is an exact multiple of it.
  let repRows = 1;
  let repCols = 1;
  if (tRows % srcH === 0 && tCols % srcW === 0 && (tRows > srcH || tCols > srcW)) {
    repRows = tRows / srcH;
    repCols = tCols / srcW;
  }

  const anchor = resolveAnchor(options);
  const translate = options.translate !== false && options.cut !== true && !!anchor;

  const maxRow = (Number.isFinite(engine && engine.rows) ? engine.rows : MAX_ROWS) - 1;
  const maxCol = (Number.isFinite(engine && engine.cols) ? engine.cols : MAX_COLS) - 1;

  for (let ti = 0; ti < repRows; ti++) {
    for (let tj = 0; tj < repCols; tj++) {
      const baseRow = top + ti * srcH;
      const baseCol = left + tj * srcW;
      const dRow = anchor ? baseRow - anchor.row : 0;
      const dCol = anchor ? baseCol - anchor.col : 0;

      for (let i = 0; i < srcH; i++) {
        for (let j = 0; j < srcW; j++) {
          const row = baseRow + i;
          const col = baseCol + j;
          if (row < 0 || col < 0 || row > maxRow || col > maxCol) continue;

          const raw = src[i][j] == null ? '' : String(src[i][j]);
          const input = (translate && raw.charAt(0) === '=')
            ? translateFormula(raw, dRow, dCol)
            : raw;

          let a1;
          try {
            a1 = cellToA1(row, col);
          } catch (e) {
            continue;
          }
          const style = styleAt(options.styles, i, j);
          if (input === '') {
            patch[a1] = style ? { input: '', style } : { input: null };
          } else {
            patch[a1] = style ? { input, style } : { input };
          }
        }
      }
    }
  }

  return patch;
}

// ---------------------------------------------------------------------------
// External paste — importing a table copied from another spreadsheet (SPEC 26)
// ---------------------------------------------------------------------------
//
// Every spreadsheet puts two flavours of the same selection on the clipboard: the
// displayed values as tab-separated `text/plain`, and a `text/html` <table> that carries
// the formatting. Google Sheets additionally hides each cell's FORMULA in an attribute.
// Reading that HTML is what turns a paste from a data transfer into a real import.
//
// Excel does NOT put formulas on the clipboard at all — only their results — so a formula
// can be recovered from 시트지 and from Google Sheets, never from Excel. That is a limit
// of what Excel sends rather than something this code can work around, which is why the
// paste tells the user what it actually imported instead of leaving them to assume their
// formulas were dropped on the floor here.
//
// SECURITY. The markup is arbitrary text from an unknown source, and what comes out of it
// shapes cells in a document other people also open. Three rules make that safe, and
// every one of them is load-bearing:
//
//   1. It is parsed with `DOMParser` into an INERT document: no script runs, no resource
//      loads, and nothing is ever attached to the live page. It never goes near innerHTML.
//   2. Only the handful of facts SPEC 26.1 lists are read out — the cell's text, its
//      colspan/rowspan, its inline `style` attribute, and the formula attributes. A
//      <style> block, a class, an event handler, an <img>: all ignored.
//   3. Every fact taken out is treated as untrusted TEXT and mapped onto the closed sets
//      the app already owns. A colour becomes `#rrggbb` or is dropped; a font becomes one
//      of `FONT_STACKS`' ids matched BY NAME or is dropped; a border goes through
//      `sanitizeBorder`. Nothing from the markup is ever assigned to a style property as
//      a raw string, so there is no path from the clipboard into a CSS declaration.
//
// The walk is bounded at every step — cells, rows, columns, spans, text length, DOM depth
// and declaration count — so a hostile or merely enormous table cannot lock the tab.

/**
 * Hard cap on how many cells one import may produce. It mirrors the per-edit cap in
 * main.js: a paste that could not be sent as a single edit frame is not worth building.
 */
const MAX_EXTERNAL_CELLS = 20000;

/** Beyond this the markup is not a spreadsheet selection; the plain-text path handles it. */
const MAX_EXTERNAL_HTML = 8 * 1024 * 1024;

/** Per-cell text cap, mirroring MAX_INPUT_LEN in shared/model.js. */
const MAX_CELL_TEXT = 10000;

/** Bounds on the per-cell work: style attribute size, declarations, nodes and depth. */
const MAX_STYLE_ATTR = 4096;
const MAX_DECLARATIONS = 96;
const MAX_TEXT_NODES = 4000;
const MAX_TEXT_DEPTH = 32;
const MAX_SHEETS_VALUE = 8192;
const MAX_TABLES = 64;

/** Control characters, minus tab and newline, which a cell may legitimately hold. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Elements whose text is markup plumbing rather than cell content. */
const SKIP_TAGS = new Set([
  'STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK',
  'OBJECT', 'IFRAME', 'COLGROUP', 'COL',
]);

/** Elements that end a line when a cell holds several blocks. */
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'TR', 'BLOCKQUOTE', 'PRE']);

/** `white-space` values that make a newline in the source deliberate. */
const PRE_WHITESPACE = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces', '-moz-pre-wrap']);

/**
 * The short named-colour set SPEC 26.1 allows beside `#rrggbb` and `rgb()`. It is a closed
 * lookup, not a passthrough: a name that is not in here is dropped, so nothing from the
 * markup can reach a style property unmapped. `windowtext` earns its place because Excel
 * writes every one of its borders with it.
 */
const NAMED_COLORS = new Map(Object.entries({
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff',
  maroon: '#800000', red: '#ff0000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff',
  green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00', navy: '#000080',
  blue: '#0000ff', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500',
  windowtext: '#000000',
}));

/** CSS lengths this importer understands, in px per unit. Relative units are unknowable. */
const LENGTH_UNITS = new Map(Object.entries({
  px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6,
}));

const LENGTH_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/;

/** text-align / vertical-align, mapped onto the app's own closed sets (SPEC 22.1). */
const ALIGN_MAP = new Map(Object.entries({
  left: 'left', center: 'center', right: 'right', start: 'left', end: 'right',
}));
const VALIGN_MAP = new Map(Object.entries({
  top: 'top', middle: 'middle', bottom: 'bottom',
}));

/** Border line styles, folded onto the three the `bd` shape allows. */
const BORDER_STYLE_MAP = new Map(Object.entries({
  solid: 'solid', double: 'solid', groove: 'solid', ridge: 'solid',
  inset: 'solid', outset: 'solid', dashed: 'dashed', dotted: 'dotted',
}));
const BORDER_OFF_STYLES = new Set(['none', 'hidden']);
const BORDER_WIDTH_KEYWORDS = new Map(Object.entries({ thin: 1, medium: 2, thick: 3 }));

/** The four sides, as `bd` keys paired with their CSS names. */
const BORDER_SIDES = [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']];

/** Strip a quoted CSS font name down to a comparable lowercase key. */
function unquoteFontName(raw) {
  return String(raw).trim().replace(/^["']/, '').replace(/["']$/, '').trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * font-family name -> `FONT_STACKS` id, derived from the stacks themselves so the table can
 * never drift from the closed set. A name listed by several stacks goes to the one that
 * names it EARLIEST ('Malgun Gothic' leads the `gothic` stack but trails inside `default`,
 * so it imports as 고딕), and a tie goes to the first id in declaration order.
 */
const FONT_NAME_TO_ID = (() => {
  const map = new Map();
  for (const id of Object.keys(FONT_STACKS)) {
    const names = String(FONT_STACKS[id]).split(',');
    for (let i = 0; i < names.length; i++) {
      const name = unquoteFontName(names[i]);
      if (!name) continue;
      const prev = map.get(name);
      if (!prev || i < prev.rank) map.set(name, { id, rank: i });
    }
    if (!map.has(id)) map.set(id, { id, rank: 0 });
  }
  return map;
})();

// ------------------------------------------------------- untrusted-text helpers

function stripControls(s) {
  return String(s).replace(CONTROL_CHARS, '');
}

function lowerOf(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** `getAttribute` that cannot throw and always yields a string. */
function getAttr(el, name) {
  try {
    const v = el.getAttribute(name);
    return typeof v === 'string' ? v : '';
  } catch (e) {
    return '';
  }
}

/** An attribute read as untrusted text: length-capped and stripped of control characters. */
function attrText(el, name) {
  const raw = getAttr(el, name);
  if (!raw) return '';
  return stripControls(raw.length > MAX_CELL_TEXT ? raw.slice(0, MAX_CELL_TEXT) : raw);
}

/**
 * A CSS colour, normalised to lowercase `#rrggbb`, or null.
 * Accepts `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha dropped), `rgb()`/`rgba()` with numbers or
 * percentages, and the closed named set. Everything else — `transparent`, `inherit`,
 * `currentColor`, a `var()`, a gradient, anything unrecognised — is dropped.
 */
function cssColor(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s || s.length > 64) return null;

  if (s.charAt(0) === '#') {
    if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7);
    return null;
  }

  const m = /^rgba?\(([^()]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter((p) => p !== '');
    if (parts.length < 3) return null;
    // A fully transparent fill is the absence of a fill, not a black one.
    if (parts.length >= 4) {
      const rawA = parts[3];
      const a = rawA.charAt(rawA.length - 1) === '%' ? parseFloat(rawA) / 100 : parseFloat(rawA);
      if (Number.isFinite(a) && a <= 0) return null;
    }
    let out = '#';
    for (let i = 0; i < 3; i++) {
      const p = parts[i];
      const n = p.charAt(p.length - 1) === '%' ? (parseFloat(p) * 255) / 100 : parseFloat(p);
      if (!Number.isFinite(n)) return null;
      const byte = Math.max(0, Math.min(255, Math.round(n)));
      out += byte.toString(16).padStart(2, '0');
    }
    return out;
  }

  return NAMED_COLORS.get(s) || null;
}

/** A CSS length in px, or null when it is missing, relative or unparseable. */
function cssLengthPx(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s || s.length > 32) return null;
  const m = LENGTH_RE.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (!unit) return n; // a bare number is what a serialiser means by px
  const factor = LENGTH_UNITS.get(unit);
  if (factor === undefined) return null;
  return n * factor;
}

// ------------------------------------------------------------ inline CSS parsing

/**
 * Split an inline `style` attribute into a property -> value map.
 *
 * Declarations are separated by `;` at the top level only, so a `;` inside quotes or
 * inside `rgb(...)` does not split one. Property names are lowercased; values keep their
 * case (font names need it) but have their internal whitespace collapsed, because a
 * serialiser is free to wrap a long attribute across lines. `!important` is dropped.
 */
function parseDeclarations(text) {
  const out = new Map();
  if (typeof text !== 'string' || text === '') return out;
  const src = text.length > MAX_STYLE_ATTR ? text.slice(0, MAX_STYLE_ATTR) : text;

  let i = 0;
  while (i < src.length && out.size < MAX_DECLARATIONS) {
    const start = i;
    let depth = 0;
    let quote = '';
    while (i < src.length) {
      const ch = src.charAt(i);
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        if (depth > 0) depth -= 1;
      } else if (ch === ';' && depth === 0) {
        break;
      }
      i += 1;
    }
    const decl = src.slice(start, i);
    i += 1; // step over the ';'

    const colon = decl.indexOf(':');
    if (colon > 0) {
      const prop = stripControls(decl.slice(0, colon)).trim().toLowerCase();
      const value = stripControls(decl.slice(colon + 1))
        .replace(/!\s*important\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (prop && value && !out.has(prop)) out.set(prop, value);
    }
  }
  return out;
}

/** Split a CSS value on whitespace, keeping `rgb(1, 2, 3)` in one piece. */
function splitValueTokens(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  const s = String(value);
  for (let i = 0; i < s.length && out.length < 8; i++) {
    const ch = s.charAt(i);
    if (ch === '(') { depth += 1; cur += ch; continue; }
    if (ch === ')') { if (depth > 0) depth -= 1; cur += ch; continue; }
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur && out.length < 8) out.push(cur);
  return out;
}

/** A border width token in px (1..3), 0 when the edge is switched off, or null. */
function borderWidthValue(token) {
  const key = String(token).trim().toLowerCase();
  const keyword = BORDER_WIDTH_KEYWORDS.get(key);
  if (keyword !== undefined) return keyword;
  const px = cssLengthPx(key);
  if (px === null) return null;
  if (px <= 0) return 0;
  return Math.max(1, Math.min(3, Math.round(px)));
}

/**
 * A `border` / `border-<side>` shorthand, as `{ off: true }` or `{ w?, s?, c? }`.
 * Returns null when the value contributes nothing recognisable.
 */
function parseBorderShorthand(value) {
  if (typeof value !== 'string' || !value) return null;
  const tokens = splitValueTokens(value);
  if (!tokens.length) return null;
  const edge = {};
  let seen = false;
  for (const token of tokens) {
    const key = token.trim().toLowerCase();
    if (!key) continue;
    if (BORDER_OFF_STYLES.has(key)) return { off: true };
    const style = BORDER_STYLE_MAP.get(key);
    if (style) { edge.s = style; seen = true; continue; }
    const width = borderWidthValue(key);
    if (width === 0) return { off: true };
    if (width !== null) { edge.w = width; seen = true; continue; }
    const color = cssColor(key);
    if (color) { edge.c = color; seen = true; }
  }
  return seen ? edge : null;
}

/**
 * Resolve one side into a `{ w, s, c }` edge, or null for "no border on this side".
 * Precedence follows CSS: the `border` shorthand, then `border-<side>`, then the three
 * `border-<side>-*` longhands.
 */
function resolveBorderSide(decls, side, base) {
  let acc = base ? { ...base } : null;
  const own = parseBorderShorthand(decls.get('border-' + side));
  if (own) acc = { ...own };

  const rawWidth = decls.get('border-' + side + '-width');
  const rawStyle = decls.get('border-' + side + '-style');
  const rawColor = decls.get('border-' + side + '-color');

  if (rawWidth || rawStyle || rawColor) {
    let off = !!(acc && acc.off);
    const cur = acc && !acc.off ? { ...acc } : {};
    if (rawStyle) {
      const key = lowerOf(rawStyle);
      if (BORDER_OFF_STYLES.has(key)) {
        off = true;
      } else {
        const style = BORDER_STYLE_MAP.get(key);
        if (style) { cur.s = style; off = false; }
      }
    }
    if (rawWidth) {
      const w = borderWidthValue(rawWidth);
      if (w === 0) off = true;
      else if (w !== null) cur.w = w;
    }
    if (rawColor) {
      const c = cssColor(rawColor);
      if (c) cur.c = c;
    }
    acc = off ? { off: true } : cur;
  }

  if (!acc || acc.off) return null;
  if (acc.w === undefined && acc.s === undefined && acc.c === undefined) return null;
  return { w: acc.w || 1, s: acc.s || 'solid', c: acc.c || '#000000' };
}

/** The four sides as a validated `style.bd`, or null. */
function bordersFrom(decls) {
  const base = parseBorderShorthand(decls.get('border'));
  const raw = {};
  let any = false;
  for (const [key, side] of BORDER_SIDES) {
    const edge = resolveBorderSide(decls, side, base);
    if (edge) { raw[key] = edge; any = true; }
  }
  // sanitizeBorder is the same gate the wire and the disk use, so an edge this importer
  // built wrongly is dropped here rather than stored.
  return any ? sanitizeBorder(raw) : null;
}

/** A font-family list matched against FONT_STACKS by name. Unrecognised -> null (dropped). */
function fontIdFor(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split(',');
  for (let i = 0; i < parts.length && i < 8; i++) {
    const name = unquoteFontName(parts[i]);
    if (!name) continue;
    const hit = FONT_NAME_TO_ID.get(name);
    if (hit) return hit.id;
  }
  return null;
}

/** A font size in px, rounded and clamped to 6..96, or null. */
function fontSizeFrom(value) {
  const px = cssLengthPx(value);
  if (px === null || px <= 0) return null;
  return Math.max(6, Math.min(96, Math.round(px)));
}

/**
 * Turn a cell's inline declarations into a style object of the SPEC 22.1 shape, or null
 * when nothing recognisable survived. Keys are emitted in the same order `sanitizeStyle`
 * uses, so a style that makes the round trip compares equal key for key.
 */
function styleFromDeclarations(decls) {
  const out = {};

  const weight = lowerOf(decls.get('font-weight'));
  if (weight) {
    if (weight === 'bold' || weight === 'bolder') {
      out.b = 1;
    } else {
      const n = parseInt(weight, 10);
      if (Number.isFinite(n) && n >= 600) out.b = 1;
    }
  }

  const fontStyle = lowerOf(decls.get('font-style'));
  if (fontStyle === 'italic' || fontStyle === 'oblique') out.i = 1;

  const deco = lowerOf(decls.get('text-decoration-line') || decls.get('text-decoration'));
  if (deco && deco !== 'none') {
    if (deco.indexOf('underline') >= 0) out.u = 1;
    if (deco.indexOf('line-through') >= 0) out.s = 1;
  }

  const align = ALIGN_MAP.get(lowerOf(decls.get('text-align')));
  if (align) out.align = align;

  // `background` is accepted only when the whole value is a colour; a gradient or an
  // image URL parses as nothing and is therefore dropped.
  const bg = cssColor(decls.get('background-color')) || cssColor(decls.get('background'));
  if (bg) out.bg = bg;

  const fg = cssColor(decls.get('color'));
  if (fg) out.fg = fg;

  const ff = fontIdFor(decls.get('font-family'));
  if (ff) out.ff = ff;

  const fs = fontSizeFrom(decls.get('font-size'));
  if (fs !== null) out.fs = fs;

  const va = VALIGN_MAP.get(lowerOf(decls.get('vertical-align')));
  if (va) out.va = va;

  const bd = bordersFrom(decls);
  if (bd) out.bd = bd;

  return Object.keys(out).length ? out : null;
}

// -------------------------------------------------------------- cell extraction

/**
 * Finish a cell's collected lines.
 *
 * Outside `white-space: pre` every run of whitespace — including the newlines and
 * indentation a serialiser puts between tags — collapses to a single space, which is what
 * the browser itself would render. Only the breaks the SOURCE meant (a `<br>`, a block
 * boundary, or a newline inside pre text) survive, because those are the ones a
 * spreadsheet cell stores as a real line break.
 */
function finishCellText(lines, pre) {
  const out = [];
  for (const line of lines) {
    const clean = stripControls(line);
    out.push(pre ? clean : clean.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim());
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  const t = out.join('\n');
  return t.length > MAX_CELL_TEXT ? t.slice(0, MAX_CELL_TEXT) : t;
}

/**
 * A cell's text, taken from text nodes only — never innerHTML, never a serialised subtree.
 *
 * A `<br>` is a hard break and always starts a line; a block element is a soft break that
 * only starts one when the current line already has something on it, so `<p>a</p><p>b</p>`
 * is two lines rather than four. With `white-space: pre` in force the source's own
 * newlines break lines too. Everything else is collapsed by `finishCellText`.
 */
function extractText(el, pre) {
  const lines = [''];
  let nodes = 0;
  let len = 0;
  const done = () => len >= MAX_CELL_TEXT || nodes >= MAX_TEXT_NODES;

  const append = (data) => {
    const text = String(data).replace(/\r\n?/g, '\n');
    len += text.length;
    if (!pre) { lines[lines.length - 1] += text; return; }
    // Under `pre` a newline in the source is content, not layout.
    const segs = text.split('\n');
    for (let i = 0; i < segs.length; i++) {
      if (i > 0) lines.push('');
      lines[lines.length - 1] += segs[i];
    }
  };

  const breakLine = (soft) => {
    if (soft && lines[lines.length - 1].trim() === '') return;
    lines.push('');
    len += 1;
  };

  const walk = (node, depth) => {
    if (done()) return;
    nodes += 1;
    const type = node.nodeType;
    if (type === 3 || type === 4) {
      append(node.nodeValue || '');
      return;
    }
    if (type !== 1) return; // comments and processing instructions carry no cell text
    const tag = String(node.nodeName || '').toUpperCase();
    if (tag === 'BR') { breakLine(false); return; }
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) breakLine(true);
    if (depth < MAX_TEXT_DEPTH) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        walk(child, depth + 1);
        if (done()) break;
      }
    } else {
      // Past the depth guard the subtree is taken whole rather than dropped: textContent
      // is the browser's own flattening, it allocates once, and the length cap still holds.
      const flat = node.textContent;
      if (typeof flat === 'string' && flat) append(flat.slice(0, MAX_CELL_TEXT));
    }
    if (block) breakLine(true);
  };

  for (let child = el.firstChild; child; child = child.nextSibling) {
    walk(child, 1);
    if (done()) break;
  }

  return finishCellText(lines, pre);
}

/** Google's `data-sheets-value` is a JSON blob; only a formula field is taken from it. */
function formulaFromSheetsValue(blob) {
  if (blob.length > MAX_SHEETS_VALUE) return null;
  let obj;
  try {
    obj = JSON.parse(blob);
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const key of ['formula', 'f']) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = obj[key];
    if (typeof v !== 'string') continue;
    const s = stripControls(v.length > MAX_CELL_TEXT ? v.slice(0, MAX_CELL_TEXT) : v).trim();
    if (s.charAt(0) === '=') return s;
  }
  return null;
}

/**
 * The formula behind a cell, or null when the source did not ship one.
 *
 *   data-sz-input        시트지's own copy — the raw input, formula or not, used verbatim
 *   data-sheets-formula  Google Sheets' formula
 *   data-sheets-value    Google's value blob, which sometimes carries the only copy
 *
 * Excel is absent from that list on purpose: it puts no formula on the clipboard, and a
 * formula must never be invented from a displayed value.
 */
function formulaOf(el) {
  const own = attrText(el, 'data-sz-input');
  if (own !== '') return own;

  const sheets = attrText(el, 'data-sheets-formula').trim();
  if (sheets.charAt(0) === '=') return sheets;

  const blob = attrText(el, 'data-sheets-value');
  if (blob) {
    const fromBlob = formulaFromSheetsValue(blob);
    if (fromBlob) return fromBlob;
  }
  return null;
}

/** One `<td>`/`<th>` -> `{ input, style, merge }`; `merge` is filled in by the caller. */
function cellFrom(el) {
  const decls = parseDeclarations(getAttr(el, 'style'));
  const pre = PRE_WHITESPACE.has(lowerOf(decls.get('white-space')));
  const text = extractText(el, pre);
  const formula = formulaOf(el);
  return {
    input: formula === null ? text : formula,
    style: styleFromDeclarations(decls),
    merge: null,
  };
}

// ------------------------------------------------------------------ table walk

/** The rows that belong to this table itself — a nested table's rows are not its own. */
function tableRows(table) {
  const rows = [];
  for (let child = table.firstElementChild; child; child = child.nextElementSibling) {
    const tag = String(child.nodeName || '').toUpperCase();
    if (tag === 'TR') {
      rows.push(child);
    } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      for (let tr = child.firstElementChild; tr; tr = tr.nextElementSibling) {
        if (String(tr.nodeName || '').toUpperCase() === 'TR') rows.push(tr);
        if (rows.length >= MAX_ROWS) return rows;
      }
    }
    if (rows.length >= MAX_ROWS) return rows;
  }
  return rows;
}

/** The cells of one row. A nested table's cells are children of ITS rows, never of this. */
function rowCells(tr) {
  const cells = [];
  for (let el = tr.firstElementChild; el; el = el.nextElementSibling) {
    const tag = String(el.nodeName || '').toUpperCase();
    if (tag === 'TD' || tag === 'TH') cells.push(el);
    if (cells.length >= MAX_COLS) break;
  }
  return cells;
}

/** A colspan/rowspan attribute, clamped to what can still be placed. */
function spanOf(el, name, limit) {
  const n = parseInt(getAttr(el, name).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.min(n, limit));
}

/**
 * The table to import: the one with the most cells of its own, ties going to the first in
 * document order. Wrapper markup, `<meta>`, comments and a layout table wrapped around the
 * real one are therefore all ignored without having to be recognised.
 */
function pickTable(doc) {
  let list;
  try {
    list = doc.querySelectorAll('table');
  } catch (e) {
    return null;
  }
  if (!list || !list.length) return null;

  let best = null;
  let bestScore = 0;
  const limit = Math.min(list.length, MAX_TABLES);
  for (let i = 0; i < limit; i++) {
    const table = list[i];
    let score = 0;
    for (const tr of tableRows(table)) score += rowCells(tr).length;
    if (score > bestScore) { bestScore = score; best = table; }
  }
  return bestScore > 0 ? best : null;
}

/** Walk one table into the row-major grid, honouring colspan and rowspan. */
function buildGrid(table) {
  const rows = tableRows(table);
  if (!rows.length) return null;

  const grid = [];   // grid[r][c] = cell | null
  const filled = []; // occupancy, so a rowspan reserves the positions below its anchor
  let width = 0;
  let placed = 0;
  let stop = false;

  const ensure = (r) => {
    while (grid.length <= r) { grid.push([]); filled.push([]); }
  };

  for (let r = 0; r < rows.length && r < MAX_ROWS && !stop; r++) {
    ensure(r);
    const cells = rowCells(rows[r]);
    let c = 0;
    for (let k = 0; k < cells.length; k++) {
      while (c < MAX_COLS && filled[r][c]) c += 1;
      if (c >= MAX_COLS) break;

      const el = cells[k];
      const colspan = spanOf(el, 'colspan', MAX_COLS - c);
      const rowspan = spanOf(el, 'rowspan', MAX_ROWS - r);
      const area = colspan * rowspan;

      // The cap is checked BEFORE anything is read or allocated, so a hostile
      // rowspan="5000" colspan="702" costs one multiplication rather than a grid.
      if (placed + area > MAX_EXTERNAL_CELLS) { stop = true; break; }

      const cell = cellFrom(el);
      if (rowspan > 1 || colspan > 1) cell.merge = { rows: rowspan, cols: colspan };

      ensure(r + rowspan - 1);
      for (let dr = 0; dr < rowspan; dr++) {
        const outRow = grid[r + dr];
        const fillRow = filled[r + dr];
        for (let dc = 0; dc < colspan; dc++) {
          const cc = c + dc;
          fillRow[cc] = true;
          outRow[cc] = (dr === 0 && dc === 0) ? cell : null;
        }
      }

      placed += area;
      if (c + colspan > width) width = c + colspan;
      c += colspan;
    }
  }

  if (!placed || !width || !grid.length) return null;

  // Rectangularise. A ragged table — 20000 one-cell rows and a single wide one — would
  // multiply out far past the cap, so the row count is trimmed to what the cap allows.
  let rowCount = Math.min(grid.length, MAX_ROWS);
  if (width * rowCount > MAX_EXTERNAL_CELLS) {
    rowCount = Math.max(1, Math.floor(MAX_EXTERNAL_CELLS / width));
  }

  const cells = [];
  for (let r = 0; r < rowCount; r++) {
    const src = grid[r] || [];
    const line = new Array(width);
    for (let c = 0; c < width; c++) {
      const v = src[c];
      if (v === undefined) { line[c] = null; continue; }
      // A merge may not claim rows or columns the finished grid does not have.
      if (v && v.merge) {
        const mr = Math.max(1, Math.min(v.merge.rows, rowCount - r));
        const mc = Math.max(1, Math.min(v.merge.cols, width - c));
        v.merge = (mr > 1 || mc > 1) ? { rows: mr, cols: mc } : null;
      }
      line[c] = v;
    }
    cells.push(line);
  }

  return { rows: rowCount, cols: width, cells };
}

/**
 * Import the `text/html` flavour of a clipboard selection (SPEC 26.2).
 *
 * @param {string} html the raw `text/html` payload, from any spreadsheet
 * @returns {{rows:number, cols:number, cells:Array<Array<object|null>>}|null}
 *   null when the markup holds no usable table; otherwise a rectangular row-major grid.
 *   Each entry is `{ input, style, merge }` or null:
 *     `input`  the recovered formula when the source shipped one, else the literal text
 *     `style`  a sanitised style object of the SPEC 22.1 shape, or null
 *     `merge`  `{ rows, cols }` on the anchor of a merged block, else null; every position
 *              it covers is null, exactly like a position no cell ever reached
 *
 * NEVER throws, whatever it is handed, and returns null wherever it cannot be sure — the
 * caller then falls back to the plain-text parse, which is what happens today.
 */
export function parseExternalHtml(html) {
  try {
    if (typeof html !== 'string') return null;
    if (html === '' || html.length > MAX_EXTERNAL_HTML) return null;
    if (html.indexOf('<') < 0) return null;

    // DOMParser is a browser global. In Node — where this module is imported so the parser
    // can be tested — there is nothing to parse with, and null is the honest answer.
    const Parser = (typeof globalThis !== 'undefined' && globalThis.DOMParser)
      || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (typeof Parser !== 'function') return null;

    // An INERT document: no script runs, no resource loads, nothing is attached to the
    // live page. This is the only way markup from the clipboard is ever turned into DOM.
    const doc = new Parser().parseFromString(html, 'text/html');
    if (!doc) return null;

    const table = pickTable(doc);
    if (!table) return null;

    const grid = buildGrid(table);
    if (!grid) return null;
    // Always present, so every caller sees one shape. null means the source did not say
    // where the copy came from, which is the normal case for Excel and Google Sheets.
    grid.origin = null;
    // Only OUR OWN markup says where it was copied from, and only that lets the importer
    // translate relative references the way an internal paste does. Google Sheets and
    // Excel ship no such marker, so their formulas are pasted verbatim — which is what
    // the README and SPEC 26.2 say, rather than a silently wrong adjustment.
    const originAttr = table.getAttribute && table.getAttribute('data-sz-origin');
    if (typeof originAttr === 'string' && isA1(originAttr.trim().toUpperCase())) {
      try {
        const cell = a1ToCell(originAttr.trim().toUpperCase());
        if (Number.isInteger(cell.row) && Number.isInteger(cell.col)) {
          grid.origin = { row: cell.row, col: cell.col };
        }
      } catch (e) { /* an unusable origin simply means no translation */ }
    }
    return grid;
  } catch (e) {
    return null;
  }
}
