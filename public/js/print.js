// print.js — SPEC 23.3 인쇄. Build a self-contained, paginated print document for one
// sheet and hand it to the browser's print dialog.
//
// WHY THIS EXISTS. The grid paints only the cells that intersect the viewport (SPEC 12,
// windowed rendering), so handing the live DOM to window.print() prints one screenful and
// stops. This module walks the sheet's USED RANGE instead and emits a plain <table> —
// the one layout primitive browsers know how to paginate. Rows break between pages, a
// <thead> repeats at the top of each one, and a <colgroup> pins every column to the width
// the document stores.
//
// Exports (SPEC 23.3):
//   buildPrintHtml(sheet, engine, options)  -> a complete HTML document string
//   printSheet(sheet, engine, options)      -> renders it hidden, prints it, cleans up
//   options: { docName, sheetName, orientation:'portrait'|'landscape', gridlines:boolean }
//
// buildPrintHtml touches no DOM at all: it is a pure string function, which is what makes
// the whole feature inspectable (and testable) without a print dialog in the way.
//
// SECURITY. Every interpolated value here is attacker-controlled — one collaborator's
// cell text, sheet name and link end up inside another collaborator's print document. So:
//   - every text run goes through esc(): & < > " ' become entities, so a cell holding
//     `<script>` prints as the six characters `<script>` and never becomes markup;
//   - no CSS value is ever copied out of a style object. Each one is REPRODUCED from a
//     closed set — a hex-colour regex, a clamped integer, a keyword whitelist, or
//     model.js's own fontStackFor / sanitizeBorder — so an invented style key cannot
//     inject a declaration, let alone escape the attribute;
//   - a link is re-checked with model.js's sanitizeLink (http / https / mailto only,
//     javascript: and data: rejected) and every emitted anchor carries
//     rel="noopener noreferrer".

import { formatValue, alignFor } from './format.js';
import {
  DEFAULT_ROWS,
  DEFAULT_COLS,
  DEFAULT_COL_WIDTH,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_FONT_SIZE,
  DEFAULT_SHEET_NAME,
  BORDER_STYLES,
  fontStackFor,
  sanitizeBorder,
  sanitizeLink,
  mergeRect,
  expandOverMerges,
} from '/shared/model.js';
import { MAX_ROWS, MAX_COLS, cellToA1, a1ToCell, colToLetter } from '/shared/formula/refs.js';

// ---------------------------------------------------------------- constants

/** SPEC 23.3: the used range is capped at 5000 rows, which is also the sheet ceiling. */
const PRINT_MAX_ROWS = MAX_ROWS;

/** Pixel guards. A stored width is already validated, but print must never emit garbage. */
const MIN_TRACK_PX = 1;
const MAX_TRACK_PX = 2000;

/** Height of the repeated column-letter header row. */
const HEAD_ROW_PX = 22;

/** Font size clamp, mirroring the `fs` style key's documented range (SPEC 22.1). */
const MIN_FONT_PX = 6;
const MAX_FONT_PX = 96;

/** Rotation clamp, mirroring the `rot` style key's documented range (SPEC 22.1). */
const MAX_ROTATION = 90;

/**
 * (row, col) packed into one integer, used ONLY as a local lookup key for merge geometry.
 * The document model's cell key is the A1 string and stays the A1 string (SPEC 1); this
 * never leaves the module.
 */
const POS_STRIDE = MAX_COLS + 1;

const DEFAULT_DOC_NAME = '제목 없는 스프레드시트';
const MAX_NAME_LEN = 200;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** `style.va` -> a table cell's vertical-align. Absent stays middle, matching the grid. */
const VALIGN_CSS = { top: 'top', middle: 'middle', bottom: 'bottom' };

/** `style.bd` side key -> the CSS side it names. */
const BORDER_SIDES = [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']];

/**
 * Marks the document this module generated. The iframe's load event can also fire for the
 * initial about:blank document; printing THAT would spool a blank page, so the load
 * handler waits for a document carrying this attribute.
 */
const READY_ATTR = 'data-sz-print';

/** A document with no external resources parses in milliseconds; this is a stuck-frame guard. */
const LOAD_TIMEOUT_MS = 20000;

/**
 * How long the iframe outlives print(). Every current browser blocks in print() until the
 * dialog closes, so this is normally dead time — but a browser that returns early still
 * needs the document alive long enough to spool it.
 */
const REMOVE_DELAY_MS = 1200;

// ---------------------------------------------------------------- escaping

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape a value for insertion into HTML text OR into a double-quoted attribute.
 *
 * `'` is escaped too even though nothing here emits single-quoted attributes: the font
 * stacks from `fontStackFor` are full of them, and `&#39;` decodes back to `'` before the
 * CSS parser ever sees the style attribute, so quoted family names survive intact.
 *
 * @param {any} v
 * @returns {string}
 */
function esc(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// ---------------------------------------------------------------- small helpers

function isObj(v) {
  return !!v && typeof v === 'object';
}

/** A positive integer from anything, clamped, with a fallback for unusable input. */
function trackPx(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_TRACK_PX, Math.max(MIN_TRACK_PX, n));
}

/** A sheet dimension from the sheet, the engine, or the documented default. */
function dimension(a, b, fallback, max) {
  for (const v of [a, b]) {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) return Math.min(max, n);
  }
  return Math.min(max, fallback);
}

/** A display name, trimmed and capped; blank or non-string falls back. */
function displayName(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (!s) return fallback;
  return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN) : s;
}

/** An A1 key -> {row, col}, or null. Never throws (a1ToCell throws on malformed input). */
function softCell(a1) {
  if (typeof a1 !== 'string' || !a1) return null;
  let rc = null;
  try {
    rc = a1ToCell(a1);
  } catch {
    return null;
  }
  if (!rc || rc.sheet) return null;
  if (!Number.isInteger(rc.row) || !Number.isInteger(rc.col)) return null;
  if (rc.row < 0 || rc.col < 0) return null;
  return rc;
}

/** A validated `#rgb` / `#rrggbb` / `#rrggbbaa` colour, or ''. */
function hexColor(v) {
  return typeof v === 'string' && HEX_COLOR.test(v) ? v : '';
}

/** `style.fs` -> a clamped integer pixel size, or 0 when unset. */
function fontPx(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, n));
}

/** `style.rot` -> a clamped integer angle, or 0 when unset / 'v' / unusable. */
function numericRot(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const n = Math.round(v);
  return Math.min(MAX_ROTATION, Math.max(-MAX_ROTATION, n));
}

/** Human text for a caught value, for the Error messages printSheet throws. */
function errText(e) {
  if (e && typeof e.message === 'string' && e.message) return e.message;
  try {
    return String(e);
  } catch {
    return '알 수 없는 오류';
  }
}

// ---------------------------------------------------------------- options

/**
 * @param {any} options
 * @param {object} sheet
 * @returns {{docName:string, sheetName:string, orientation:string, gridlines:boolean}}
 */
function normalizeOptions(options, sheet) {
  const o = isObj(options) ? options : {};
  return {
    docName: displayName(o.docName, DEFAULT_DOC_NAME),
    sheetName: displayName(o.sheetName, displayName(sheet.name, DEFAULT_SHEET_NAME)),
    // Anything that is not the string 'landscape' prints portrait: the value reaches an
    // @page rule, so it is reproduced from a two-value set rather than interpolated.
    orientation: o.orientation === 'landscape' ? 'landscape' : 'portrait',
    // Absent means ON, matching what a spreadsheet prints by default.
    gridlines: o.gridlines === undefined || o.gridlines === null ? true : !!o.gridlines,
  };
}

// ---------------------------------------------------------------- used range

/**
 * The bounding box of everything worth printing, plus the set of positions that hold
 * something (which lets the render loop skip the whole style pipeline for blank cells).
 *
 * Two sources are unioned:
 *   - `sheet.cells`, the document record — the only place a style-only or link-only cell
 *     exists, since neither produces a value;
 *   - `engine.getValues()`, the computed values — the authority on what a formula shows.
 *
 * @returns {{rect:{r1,c1,r2,c2}|null, live:Set<number>}}
 */
function scanSheet(records, engine, rows, cols) {
  const live = new Set();
  let r1 = Infinity;
  let c1 = Infinity;
  let r2 = -1;
  let c2 = -1;

  const note = (row, col) => {
    if (row >= rows || col >= cols) return;
    live.add(row * POS_STRIDE + col);
    if (row < r1) r1 = row;
    if (col < c1) c1 = col;
    if (row > r2) r2 = row;
    if (col > c2) c2 = col;
  };

  for (const key of Object.keys(records)) {
    if (!recordHasContent(records[key])) continue;
    const rc = softCell(key);
    if (rc) note(rc.row, rc.col);
  }

  let values = null;
  if (engine && typeof engine.getValues === 'function') {
    try {
      values = engine.getValues();
    } catch {
      values = null;
    }
  }
  if (isObj(values)) {
    for (const key of Object.keys(values)) {
      const rc = softCell(key);
      if (rc) note(rc.row, rc.col);
    }
  }

  if (r2 < 0) return { rect: null, live };
  return { rect: { r1, c1, r2, c2 }, live };
}

/** Does a stored cell record carry anything a printed page would show? */
function recordHasContent(rec) {
  if (rec === null || rec === undefined) return false;
  if (typeof rec === 'string') return rec !== '';
  if (typeof rec !== 'object') return false;
  if (typeof rec.input === 'string' && rec.input !== '') return true;
  if (isObj(rec.style) && Object.keys(rec.style).length > 0) return true;
  if (typeof rec.link === 'string' && rec.link !== '') return true;
  return false;
}

/**
 * Clamp a rect into the sheet, grow it over any merge it only partially covers, clamp
 * again, then apply the 5000-row cap from the top of the range.
 */
function finalizeRect(rect, merges, rows, cols) {
  let box = {
    r1: Math.max(0, Math.min(rect.r1, rows - 1)),
    c1: Math.max(0, Math.min(rect.c1, cols - 1)),
    r2: Math.max(0, Math.min(rect.r2, rows - 1)),
    c2: Math.max(0, Math.min(rect.c2, cols - 1)),
  };

  // A merge that hangs off the edge of the used range would otherwise be clipped, and a
  // clipped merge means a printed row whose colspans no longer add up to the column count.
  if (Array.isArray(merges) && merges.length) {
    let grown = box;
    try {
      grown = expandOverMerges(merges, box);
    } catch {
      grown = box;
    }
    if (grown && Number.isInteger(grown.r1)) {
      box = {
        r1: Math.max(0, Math.min(grown.r1, rows - 1)),
        c1: Math.max(0, Math.min(grown.c1, cols - 1)),
        r2: Math.max(0, Math.min(grown.r2, rows - 1)),
        c2: Math.max(0, Math.min(grown.c2, cols - 1)),
      };
    }
  }

  if (box.r2 - box.r1 + 1 > PRINT_MAX_ROWS) box.r2 = box.r1 + PRINT_MAX_ROWS - 1;
  return box;
}

// ---------------------------------------------------------------- merges

/**
 * Turn the sheet's merge list into table geometry over `box`.
 *
 *   spans:   position -> { rows, cols, a1 }  the cell to emit with rowspan/colspan
 *   covered: positions to omit entirely (SPEC 23.3)
 *
 * A merge is CLIPPED to the printed box rather than skipped, and the clipped top-left is
 * where the cell is emitted while its text still comes from the real anchor. That keeps
 * the invariant a table cannot survive without: every row's colspans sum to the column
 * count. Overlapping entries are impossible in a normalized document (SPEC 21.1), but a
 * hand-edited file could carry them, so an entry that would collide with one already
 * placed is dropped rather than allowed to skew the table.
 */
function mergePlan(merges, box) {
  const spans = new Map();
  const covered = new Set();
  if (!Array.isArray(merges) || merges.length === 0) return { spans, covered };

  for (const entry of merges) {
    let m = null;
    try {
      m = mergeRect(entry);
    } catch {
      m = null;
    }
    if (!m) continue;
    if (m.r2 < box.r1 || m.r1 > box.r2 || m.c2 < box.c1 || m.c1 > box.c2) continue;

    const r1 = Math.max(m.r1, box.r1);
    const c1 = Math.max(m.c1, box.c1);
    const r2 = Math.min(m.r2, box.r2);
    const c2 = Math.min(m.c2, box.c2);
    if (r2 < r1 || c2 < c1) continue;
    if (r1 === r2 && c1 === c2) continue; // nothing to span

    let clash = false;
    for (let r = r1; r <= r2 && !clash; r++) {
      for (let c = c1; c <= c2; c++) {
        const pos = r * POS_STRIDE + c;
        if (covered.has(pos) || spans.has(pos)) {
          clash = true;
          break;
        }
      }
    }
    if (clash) continue;

    spans.set(r1 * POS_STRIDE + c1, {
      rows: r2 - r1 + 1,
      cols: c2 - c1 + 1,
      a1: cellToA1(m.r1, m.c1), // the anchor keeps the contents (SPEC 21)
    });
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        covered.add(r * POS_STRIDE + c);
      }
    }
  }
  return { spans, covered };
}

// ---------------------------------------------------------------- cell rendering

/** The style to paint with: the engine's resolved copy, falling back to the record's. */
function resolveStyle(engine, a1, rec) {
  let style = null;
  if (engine && typeof engine.getStyle === 'function') {
    try {
      style = engine.getStyle(a1);
    } catch {
      style = null;
    }
  }
  if ((!isObj(style) || Object.keys(style).length === 0) && isObj(rec) && isObj(rec.style)) {
    style = rec.style;
  }
  return isObj(style) ? style : {};
}

/**
 * The value to format. The engine is the authority — it is what the screen shows — and
 * the stored input is only a fallback for a caller that passed no engine at all.
 */
function resolveValue(engine, a1, rec) {
  if (engine && typeof engine.getValue === 'function') {
    try {
      return engine.getValue(a1);
    } catch {
      /* fall through to the record */
    }
  }
  if (typeof rec === 'string') return rec === '' ? null : rec;
  if (isObj(rec) && typeof rec.input === 'string') return rec.input === '' ? null : rec.input;
  return null;
}

/** `style.bd` -> validated `border-<side>` declarations. */
function borderDeclarations(bd) {
  const out = [];
  let clean = null;
  try {
    clean = sanitizeBorder(bd);
  } catch {
    clean = null;
  }
  if (!isObj(clean)) return out;
  for (const [key, side] of BORDER_SIDES) {
    const edge = clean[key];
    if (!isObj(edge)) continue;
    const w = Math.min(3, Math.max(1, Math.round(Number(edge.w)) || 1));
    const s = BORDER_STYLES.indexOf(edge.s) >= 0 ? edge.s : 'solid';
    const c = hexColor(edge.c) || '#000000';
    out.push('border-' + side + ':' + w + 'px ' + s + ' ' + c);
  }
  return out;
}

/**
 * The full inline style for one printed cell.
 *
 * Every declaration is REBUILT from a validated primitive; nothing is copied through from
 * the style object, so no value in a document can add a declaration of its own.
 */
function cellCss(style, align) {
  const out = [];

  // 'left' is the table cell default, so only the other two are worth emitting.
  if (align === 'center' || align === 'right') out.push('text-align:' + align);

  const va = VALIGN_CSS[style.va];
  if (va) out.push('vertical-align:' + va);

  if (style.b) out.push('font-weight:700');
  if (style.i) out.push('font-style:italic');
  let deco = '';
  if (style.u) deco = 'underline';
  if (style.s) deco = deco ? deco + ' line-through' : 'line-through';
  if (deco) out.push('text-decoration:' + deco);

  const fg = hexColor(style.fg);
  if (fg) out.push('color:' + fg);
  const bg = hexColor(style.bg);
  if (bg) out.push('background-color:' + bg);

  // fontStackFor is the ONLY producer of a font string: the id is looked up in a closed
  // set (SPEC 22.2), so an invented `ff` selects a known-good stack or the default.
  if (typeof style.ff === 'string' && style.ff) out.push('font-family:' + fontStackFor(style.ff));
  const fs = fontPx(style.fs);
  if (fs) out.push('font-size:' + fs + 'px');

  // The stylesheet clips (`white-space:pre`), matching the grid; only 'wrap' reflows.
  // 'overflow' cannot borrow a neighbour's width inside a table, so it clips like 'clip'.
  if (style.wrap === 'wrap') out.push('white-space:pre-wrap');

  // 'v' stacks the text without transforming any box, so it is safe on the cell itself.
  // A numeric rotation goes on an inner span instead — see renderCell.
  if (style.rot === 'v') out.push('writing-mode:vertical-rl');

  for (const decl of borderDeclarations(style.bd)) out.push(decl);

  return out.join(';');
}

/** One `<td>`, complete with span attributes, resolved style and escaped text. */
function renderCell(ctx, row, col, span) {
  let attrs = '';
  if (span) {
    if (span.rows > 1) attrs += ' rowspan="' + span.rows + '"';
    if (span.cols > 1) attrs += ' colspan="' + span.cols + '"';
  }

  const a1 = span ? span.a1 : cellToA1(row, col);

  // Fast path: a blank, unstyled, unlinked cell needs no value lookup and no formatting.
  // On a sparse sheet this is nearly every cell inside the bounding box.
  if (!span && !ctx.live.has(row * POS_STRIDE + col)) return '<td' + attrs + '></td>';

  const rec = ctx.records[a1];
  const style = resolveStyle(ctx.engine, a1, rec);
  const value = resolveValue(ctx.engine, a1, rec);

  // formatValue is imported so print and screen agree on every number, date and error
  // code; there is deliberately no second formatting implementation in this file.
  let text = '';
  try {
    const t = formatValue(value, style);
    text = t === null || t === undefined ? '' : String(t);
  } catch {
    text = value === null || value === undefined ? '' : String(value);
  }
  let align = 'left';
  try {
    align = alignFor(value, style) || 'left';
  } catch {
    align = 'left';
  }

  let inner = esc(text);

  // A hyperlink is attacker-controlled text: it is re-validated here, at the point of
  // use, rather than trusted because it came out of a document.
  if (inner) {
    const href = sanitizeLink(isObj(rec) ? rec.link : null);
    if (href) {
      inner = '<a class="sz-p-link" href="' + esc(href) + '" rel="noopener noreferrer">'
        + inner + '</a>';
    }
  }

  const rot = numericRot(style.rot);
  if (rot && inner) {
    // A positive `rot` tilts text upwards, which is a negative CSS angle (SPEC 22.5). The
    // transform goes on a span: on the cell it would rotate the background and borders too.
    inner = '<span class="sz-p-rot" style="transform:rotate(' + -rot + 'deg)">' + inner + '</span>';
  }

  const css = cellCss(style, align);
  return '<td' + attrs + (css ? ' style="' + esc(css) + '"' : '') + '>' + inner + '</td>';
}

// ---------------------------------------------------------------- document assembly

function buildStyleSheet(orientation) {
  return [
    ':root{color-scheme:light}',
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0;background:#ffffff}',
    'body{font-family:' + fontStackFor('default') + ';font-size:' + DEFAULT_FONT_SIZE + 'px;'
      + 'line-height:1.25;color:#000000;'
      // Cell fills are data, not decoration: they must survive the browser's default
      // "do not print backgrounds" behaviour.
      + '-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.sz-p-head{padding:0 0 6px;margin:0 0 10px;border-bottom:1px solid #d0d0d0;'
      + 'font-size:12px;color:#5f6368}',
    '.sz-p-doc{font-size:15px;font-weight:700;color:#000000}',
    '.sz-p-sep{padding:0 6px;color:#9aa0a6}',
    '.sz-p-sheet{font-weight:500;color:#3c4043}',
    '.sz-p-empty{margin:16px 0;font-size:12px;color:#5f6368}',
    'table.sz-p-table{border-collapse:collapse;table-layout:fixed}',
    '.sz-p-table td,.sz-p-table th{padding:0 5px;overflow:hidden;white-space:pre;'
      + 'text-align:left;vertical-align:middle;font-weight:400;font-variant-numeric:tabular-nums}',
    '.sz-p-table thead th{background:#f8f9fa;color:#5f6368;font-size:12px;font-weight:500;'
      + 'text-align:center}',
    // Gridlines are opt-in; without the class the table draws no rules of its own and a
    // cell's own `bd` borders are the only lines on the page.
    '.sz-p-grid td,.sz-p-grid th{border:1px solid #d0d0d0}',
    '.sz-p-link{color:inherit;text-decoration:underline}',
    // A transform has no effect on a non-replaced inline box.
    '.sz-p-rot{display:inline-block;transform-origin:50% 50%}',
    'thead{display:table-header-group}',
    'tr{break-inside:avoid;page-break-inside:avoid}',
    '@page{size:' + orientation + ';margin:12mm 10mm}',
  ].join('\n');
}

function buildTable(ctx) {
  const { box, opts, plan } = ctx;
  const parts = [];

  let total = 0;
  const widths = [];
  for (let c = box.c1; c <= box.c2; c++) {
    const w = trackPx(ctx.colWidths[String(c)], DEFAULT_COL_WIDTH);
    widths.push(w);
    total += w;
  }

  parts.push('<table class="sz-p-table' + (opts.gridlines ? ' sz-p-grid' : '')
    + '" style="width:' + total + 'px">');

  parts.push('<colgroup>');
  for (let i = 0; i < widths.length; i++) parts.push('<col style="width:' + widths[i] + 'px">');
  parts.push('</colgroup>');

  // SPEC 23.3: the column-letter header repeats on every page when gridlines are on.
  // `display:table-header-group` is what makes the browser repeat it.
  if (opts.gridlines) {
    parts.push('<thead><tr style="height:' + HEAD_ROW_PX + 'px">');
    for (let c = box.c1; c <= box.c2; c++) {
      parts.push('<th scope="col">' + esc(colToLetter(c)) + '</th>');
    }
    parts.push('</tr></thead>');
  }

  parts.push('<tbody>');
  for (let r = box.r1; r <= box.r2; r++) {
    const h = trackPx(ctx.rowHeights[String(r)], DEFAULT_ROW_HEIGHT);
    parts.push('<tr style="height:' + h + 'px">');
    for (let c = box.c1; c <= box.c2; c++) {
      const pos = r * POS_STRIDE + c;
      if (plan.covered.has(pos)) continue; // a covered cell is omitted entirely
      parts.push(renderCell(ctx, r, c, plan.spans.get(pos) || null));
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');

  return parts.join('');
}

/**
 * Build a complete, self-contained HTML document for one sheet.
 *
 * @param {object} sheet    the sheet record: { name, rows, cols, cells, colWidths,
 *                          rowHeights, merges }
 * @param {object} engine   a SheetEngine for that sheet (values + resolved styles).
 *                          A null engine falls back to the stored inputs.
 * @param {object} [options] { docName, sheetName, orientation, gridlines }
 * @returns {string} a complete HTML document, ready for an iframe's srcdoc
 */
export function buildPrintHtml(sheet, engine, options) {
  const sh = isObj(sheet) ? sheet : {};
  const eng = engine && typeof engine.getValue === 'function' ? engine : null;
  const opts = normalizeOptions(options, sh);

  const records = isObj(sh.cells) ? sh.cells : {};
  const rows = dimension(sh.rows, eng ? eng.rows : null, DEFAULT_ROWS, MAX_ROWS);
  const cols = dimension(sh.cols, eng ? eng.cols : null, DEFAULT_COLS, MAX_COLS);

  const scan = scanSheet(records, eng, rows, cols);
  const empty = scan.rect === null;
  // An empty sheet still gets a real (1x1) table, so the output shape never varies.
  const box = empty
    ? { r1: 0, c1: 0, r2: 0, c2: 0 }
    : finalizeRect(scan.rect, sh.merges, rows, cols);

  const ctx = {
    box,
    opts,
    engine: eng,
    records,
    live: scan.live,
    colWidths: isObj(sh.colWidths) ? sh.colWidths : {},
    rowHeights: isObj(sh.rowHeights) ? sh.rowHeights : {},
    plan: mergePlan(sh.merges, box),
  };

  const title = opts.docName + ' — ' + opts.sheetName;
  const head = '<div class="sz-p-head">'
    + '<span class="sz-p-doc">' + esc(opts.docName) + '</span>'
    + '<span class="sz-p-sep">/</span>'
    + '<span class="sz-p-sheet">' + esc(opts.sheetName) + '</span>'
    + '</div>';
  const note = empty ? '<p class="sz-p-empty">인쇄할 내용이 없습니다.</p>' : '';

  return '<!DOCTYPE html>\n'
    + '<html lang="ko" ' + READY_ATTR + '="1">\n'
    + '<head>\n'
    + '<meta charset="utf-8">\n'
    + '<title>' + esc(title) + '</title>\n'
    + '<style>\n' + buildStyleSheet(opts.orientation) + '\n</style>\n'
    + '</head>\n'
    + '<body>\n'
    + head + note + buildTable(ctx) + '\n'
    + '</body>\n'
    + '</html>\n';
}

// ---------------------------------------------------------------- printing

/** Is this the document we built, rather than the iframe's initial about:blank? */
function frameIsReady(frame) {
  let doc = null;
  try {
    doc = frame.contentDocument;
  } catch {
    // Unreadable means we cannot verify; trust the load event rather than hang.
    return true;
  }
  if (!doc || !doc.documentElement) return false;
  return doc.documentElement.getAttribute(READY_ATTR) === '1';
}

/**
 * Build the print document, render it in a hidden same-origin iframe, print it and remove
 * the iframe again.
 *
 * A popup window is NOT used: blockers kill it silently, so the user would click 인쇄 and
 * get nothing at all with no way to tell why.
 *
 * Failure handling is deliberately split. Anything detectable before the iframe is in the
 * DOM — no document, a build failure — throws SYNCHRONOUSLY, so the plain
 * `try { printSheet(...) } catch (e) { toast(e.message) }` a caller writes catches it.
 * Anything after that (the frame never loads, print() throws) rejects the returned promise
 * with an Error carrying the same kind of Korean message. Either way the iframe is removed
 * on every path: there is no exit from this function that leaves one attached.
 *
 * @param {object} sheet
 * @param {object} engine
 * @param {object} [options] { docName, sheetName, orientation, gridlines }
 * @returns {Promise<void>} resolves once print() has been handed the document
 * @throws {Error} when the document cannot be built or the iframe cannot be created
 */
export function printSheet(sheet, engine, options) {
  if (typeof document === 'undefined' || !document || !document.body) {
    throw new Error('인쇄할 수 있는 문서가 없습니다.');
  }

  let html;
  try {
    html = buildPrintHtml(sheet, engine, options);
  } catch (e) {
    throw new Error('인쇄 문서를 만들지 못했습니다: ' + errText(e));
  }

  let frame;
  try {
    frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.title = '인쇄 미리보기';
    const s = frame.style;
    // Off-screen but fully laid out: a display:none or zero-sized frame has nothing to
    // paginate, and some browsers refuse to print it at all.
    s.position = 'fixed';
    s.left = '-10000px';
    s.top = '0px';
    s.width = '820px';
    s.height = '1160px';
    s.border = '0';
    s.opacity = '0';
    s.pointerEvents = 'none';
  } catch (e) {
    throw new Error('인쇄 창을 만들지 못했습니다: ' + errText(e));
  }

  return new Promise((resolve, reject) => {
    let settled = false;   // the promise has been resolved or rejected
    let started = false;   // print() has been called; never do it twice
    let loadTimer = 0;
    let removeTimer = 0;
    let printWin = null;

    const removeFrame = () => {
      if (removeTimer) {
        clearTimeout(removeTimer);
        removeTimer = 0;
      }
      if (printWin) {
        try {
          printWin.removeEventListener('afterprint', onAfterPrint);
        } catch {
          /* the frame may already be detached */
        }
        printWin = null;
      }
      frame.onload = null;
      frame.onerror = null;
      try {
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      } catch {
        /* already gone */
      }
    };

    const fail = (message) => {
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = 0;
      }
      removeFrame();
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    function onAfterPrint() {
      removeFrame();
    }

    const onLoad = () => {
      if (started || settled) return;
      // The initial about:blank document also fires load in some browsers; printing it
      // would spool a blank page. Wait for the document this module generated.
      if (!frameIsReady(frame)) return;
      started = true;
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = 0;
      }

      let win = null;
      try {
        win = frame.contentWindow;
      } catch {
        win = null;
      }
      if (!win || typeof win.print !== 'function') {
        fail('인쇄 창을 열지 못했습니다.');
        return;
      }

      try {
        printWin = win;
        try {
          win.addEventListener('afterprint', onAfterPrint);
        } catch {
          /* not fatal: the timer below removes the frame anyway */
        }
        try {
          win.focus();
        } catch {
          /* focus is a nicety, not a requirement */
        }
        win.print();
      } catch (e) {
        fail('인쇄를 시작하지 못했습니다: ' + errText(e));
        return;
      }

      settled = true;
      // print() blocks until the dialog closes in every current browser, so the frame is
      // usually removed immediately after; the delay only covers one that returns early.
      removeTimer = setTimeout(removeFrame, REMOVE_DELAY_MS);
      resolve();
    };

    frame.onload = onLoad;
    frame.onerror = () => fail('인쇄 문서를 불러오지 못했습니다.');

    // srcdoc is set BEFORE insertion so the frame's first navigation is our document, and
    // it keeps this page's origin, which is what lets the load handler read it back.
    let wrote = false;
    try {
      if ('srcdoc' in frame) {
        frame.srcdoc = html;
        wrote = true;
      }
    } catch {
      wrote = false;
    }

    try {
      document.body.appendChild(frame);
    } catch (e) {
      fail('인쇄 창을 열지 못했습니다: ' + errText(e));
      return;
    }

    if (!wrote) {
      // Fallback for a browser without srcdoc: write into the frame's own document. That
      // path fires no load event, so the handler is invoked once the write completes.
      try {
        const idoc = frame.contentDocument;
        if (!idoc) throw new Error('contentDocument');
        idoc.open();
        idoc.write(html);
        idoc.close();
      } catch (e) {
        fail('인쇄 문서를 불러오지 못했습니다: ' + errText(e));
        return;
      }
      setTimeout(onLoad, 0);
    }

    loadTimer = setTimeout(() => {
      fail('인쇄 문서를 불러오지 못했습니다. 다시 시도해 주세요.');
    }, LOAD_TIMEOUT_MS);
  });
}
