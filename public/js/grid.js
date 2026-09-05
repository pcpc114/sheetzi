/**
 * grid.js — 시트지 grid view: windowed rendering, selection, in-cell editing.
 *
 * DOM / CSS contract for public/css/style.css
 * ------------------------------------------
 * Base class names (SPEC §12):
 *   .sz-grid          root element created by this module (position:relative)
 *   .sz-viewport      the scrolling pane that holds the non-frozen cells
 *   .sz-spacer        empty box sized to the whole sheet; it drives the scrollbars
 *   .sz-cell          one rendered cell
 *   .sz-cell-active   the active cell (2px accent outline)
 *   .sz-cell-selected a cell inside the selection / fill preview / pointed range
 *   .sz-colhead       one column header (A, B, C ...)
 *   .sz-rowhead       one row header (1, 2, 3 ...)
 *   .sz-corner        the top-left select-all box
 *   .sz-editor        the in-cell editor (a <textarea>)
 *   .sz-fill          the fill handle at the bottom-right of the selection
 *   .sz-resize-guide  the live guide line drawn while resizing a column / row
 *   .sz-menu          the right-click context menu
 *   .sz-menu-item     one <button> inside the menu
 *   .sz-peer-cursor   a remote user's cell outline
 *   .sz-peer-label    the small name chip drawn on a remote cursor
 *   .sz-frozen        a frozen band layer
 *
 * Extra names this module emits (style them or ignore them):
 *   .sz-cells             layer that holds the scrolling cell nodes
 *   .sz-colhead-layer     clipping band that holds the column headers
 *   .sz-rowhead-layer     clipping band that holds the row headers
 *   .sz-overlay           clipped, pointer-transparent layer (editor, fill handle, peers)
 *   .sz-frozen-top .sz-frozen-left .sz-frozen-corner   (always with .sz-frozen)
 *   .sz-colhead-grip .sz-rowhead-grip                  (drag zone on a header divider)
 *   .sz-colhead-active .sz-rowhead-active              (header of a selected column / row)
 *   .sz-resize-guide-h                                 (horizontal variant of the guide)
 *   .sz-cell-link         the <a> a linked cell's text is rendered inside (SPEC 23.4)
 *   .sz-cell-link-glyph   the small trailing glyph inside that <a>; clicking it follows
 *   .sz-painting          on the ROOT while the format painter is armed (SPEC 23.1)
 *   .sz-filter-btn        the dropdown glyph on a header cell of the filter range (24.1);
 *                         .sz-filter-btn-on marks a column that sorts or hides something
 *   .sz-chart-layer       the layer holding the charts, inside the scrolling viewport
 *   .sz-chart             one chart, an <svg> placed in sheet coordinates (24.2)
 *   .sz-chart-handle      the corner grip that resizes a chart; a SIBLING of the <svg>,
 *                         never a child of it, because renderChart owns the svg's children
 *   .sz-cell-comment      the corner triangle on a cell carrying a thread (24.3);
 *                         .sz-cell-comment-resolved marks a resolved one
 *
 * Rules the stylesheet must respect:
 *  1. Geometry — position / left / top / right / bottom / width / height / transform /
 *     display / overflow — is written inline by this module for every element above.
 *     Do not set those properties in CSS; set borders, colors, fonts, z-index instead.
 *  2. .sz-cell receives `background-color` and `color` inline from the cell's style object,
 *     so .sz-cell-selected must paint its tint with `box-shadow: inset 0 0 0 999px rgba(...)`
 *     (or a ::after overlay) — never with `background`.
 *  3. .sz-editor lives in the DOM permanently and keeps keyboard focus even when no cell is
 *     being edited: that is how typing and IME composition start an edit. Never give it
 *     `display:none`, and let this module own its size.
 *  4. .sz-resize-guide needs a visible `background`; its size and orientation are inline.
 *  5. Header height is 26px and the row-header band is 46px wide (constants below); if the
 *     stylesheet wants different metrics they must be changed here too.
 *  6. A merged rectangle (SPEC section 21.4) is ONE .sz-cell node placed at its anchor and
 *     sized to the union of its cells; it carries data-merge="A1:C1" next to its data-a1.
 *     The covered cells emit no node at all, so that one box is the only thing painted over
 *     the area — style it through `.sz-cell[data-merge]` when it needs to differ.
 *  7. SPEC section 22 cell formatting is inline too: `font-family`, `font-size`,
 *     `align-content`, `white-space`, `transform`/`transform-origin`, `writing-mode` and
 *     `box-shadow` are written by _paintCell from the cell's style object. Only cells that
 *     actually carry one of ff/fs/va/wrap/rot/bd get any of them, so the stylesheet still
 *     owns the default look — but where a cell DOES carry `bd`, its inline `box-shadow`
 *     outranks .sz-cell-selected, so this module re-supplies the grid lines and the
 *     selection wash itself (see CELL_LINES / SEL_WASH below). Do not move those two
 *     shadows out of the stylesheet; keep the copies here in sync with them.
 *  8. SPEC section 23.2 zoom. Every pixel this module computes is a DOCUMENT pixel run
 *     through _z() exactly once, so nothing downstream ever divides by the factor. The
 *     grid is deliberately NOT `transform: scale()`d: the viewport's scroll box would
 *     keep its unscaled size and every hit test, scroll offset and overlay position
 *     would need a compensating divide. Text follows through the two custom properties
 *     `--sz-fs` / `--sz-fs-sm`, which this module overrides on the ROOT while the zoom is
 *     not 1 and removes again at 1, so the stylesheet's own values apply verbatim at 100%.
 *     Do not hard-code `font-size` on .sz-cell / .sz-colhead / .sz-rowhead / .sz-corner /
 *     .sz-editor in px; keep them on those two variables or they will stop scaling.
 *     `sheet.colWidths` / `sheet.rowHeights` stay UNSCALED: zoom is a view preference and
 *     never reaches the document.
 *  9. SPEC section 24.1 filter view. A ROW INDEX AND A SCREEN POSITION ARE NO LONGER THE
 *     SAME NUMBER. `sheet.filter` can hide rows and reorder them, and it does so as a
 *     VIEW: the document is never touched, so no formula can be corrupted by a sort.
 *     The mapping lives in exactly one place — `_viewRows` (display index -> absolute
 *     row) and `_rowView` (absolute row -> display index, -1 when hidden) — and every
 *     consumer goes through `_rowOf` / `_viewOf` / `_oy`. `_ry` is therefore indexed by
 *     DISPLAY position, never by row. With no filter (or a filter that hides nothing and
 *     sorts nothing) both arrays are null, the two accessors are the identity, and every
 *     path in this file computes precisely what it computed before filters existed.
 *     The mapping is rebuilt only when `sheet.filter` is replaced or when data inside the
 *     filter range changes — never per frame and never per cell.
 * 10. SPEC section 24.2 charts. `.sz-chart-layer` is a zero-sized, pointer-transparent
 *     layer INSIDE the scrolling viewport, so charts scroll with the cells for free and
 *     need no per-frame work. Each chart is positioned in SHEET pixels run through _z(),
 *     so it follows zoom like everything else, and only the <svg> and its handle take
 *     pointer events — a click that misses a chart reaches the cell underneath.
 * 11. SPEC section 24.3 comments. The corner triangle is a real child node of the cell,
 *     so it has to be un-mounted when a recycled node lands on a cell with no thread.
 *     Its colour comes from `--sz-comment-mark` with a built-in fallback, so the mark is
 *     visible even before the stylesheet names one; its geometry is inline as usual.
 *
 * SPEC section 25.3 auto-grow. A sheet starts at 200 x 26 and 행 삽입 only ever shifts
 * cells WITHIN it, so the grid asks for a bigger sheet once the user reaches the end of
 * it. Growth is ADDITIVE and nothing but `sheet.rows` / `sheet.cols` changes, which is
 * what makes doing it automatically safe: no cell moves and no formula is rewritten, so
 * a merge, a filter, a chart or a comment cannot be disturbed by it. Like onMerge, the
 * grid only REPORTS it — on the ordinary `onMeta` patch, as the absolute new extent
 * { rows } / { cols } — and the host applies it and re-renders, so it replicates exactly
 * the way a column width does. It never fires while a pointer gesture is live, at most
 * once a second per axis, and never at all past MAX_ROWS / MAX_COLS. See _maybeGrow.
 *
 * Constructor callbacks (SPEC section 12, plus onMerge from section 21.4):
 *   onEdit(cellsPatch), onCursor(sel), onStructural(edit), onMeta(patch)
 *     onMeta also carries { rows } / { cols } when the sheet grew (SPEC 25.2/25.3)
 *   onMerge(mode, rect)   mode is 'all' | 'horizontal' | 'vertical' | 'none'
 *     Emitted by the 셀 병합 / 병합 해제 context-menu entries. The grid never rewrites
 *     sheet.merges itself: a merge is an `edit` (clearing the covered cells) plus a `meta`
 *     (the new list), and both belong to the host, which owns the history stack and the
 *     socket. The host applies them and calls render(). `rect` is the current selection
 *     already grown over merges, and carries BOTH shapes — {r1,c1,r2,c2} for the
 *     shared/model.js merge helpers and {s:{row,col},e:{row,col}} for the selection shape
 *     used everywhere else in the client.
 *
 * Batch-C callbacks (SPEC section 24). Like onMerge, the grid never writes the sheet
 * state behind them: it reports the gesture and the host owns the history stack and the
 * socket, applies the change and calls render().
 *   onFilterMenu(col, rect)   the sz-filter-btn on a header cell of the filter range was
 *     clicked. `col` is the ABSOLUTE column index (the grid speaks absolute coordinates
 *     everywhere else, and `data-a1` is absolute too). `rect` is a plain copy of the
 *     glyph's viewport rectangle — {left,top,right,bottom,width,height} — for anchoring
 *     the panel, and it also carries `col`, `relCol` (the index inside filter.range, which
 *     is what filter.hidden / filter.sort.col are keyed by), `range` and `a1`, so the host
 *     never has to recompute the range's origin to know which column was meant.
 *   onChartChange(chart)      a chart was moved or resized. Fired ONCE, on release, with
 *     a fresh copy of the chart carrying its new x/y/w/h. Everything else on it is
 *     unchanged; the host sends the whole list on the `meta` frame as patch.charts.
 *   onCommentOpen(cell, rect) the sz-cell-comment triangle was clicked. `cell` is the A1
 *     key of the thread's cell (the same shape getSelection().active uses) and `rect` is
 *     the mark's viewport rectangle. The cell is selected first, so the panel and the
 *     selection can never disagree about which cell is being discussed.
 */

import {
  cellToA1,
  a1ToCell,
  colToLetter,
  normalizeRange,
  offsetRef,
  MAX_ROWS,
  MAX_COLS,
} from '/shared/formula/refs.js';
import { parse, serialize, mapRefs } from '/shared/formula/parser.js';
import {
  mergeAt,
  mergeRect,
  mergeAnchor,
  expandOverMerges,
  shiftMerges,
  shiftFilter,
  shiftCharts,
  shiftComments,
  computeVisibleRows,
  computeSortOrder,
  fontStackFor,
  sanitizeLink,
  ROW_GROW_STEP,
  COL_GROW_STEP,
} from '/shared/model.js';
import { formatValue, alignFor } from './format.js';
import { chartSeries, renderChart } from './chart.js';
import { onNextFrame } from './schedule.js';

/* ---------------------------------------------------------------- constants */

const DEFAULT_COL_WIDTH = 104; // must match shared/model.js
const DEFAULT_ROW_HEIGHT = 26; // must match shared/model.js
const HEADER_H = 26; // column header band height
const HEADER_W = 46; // row header band width
const OVERSCAN = 2; // extra rows/cols rendered outside the viewport
const MIN_COL_WIDTH = 24;
const MAX_COL_WIDTH = 800;
const MIN_ROW_HEIGHT = 16;
const MAX_ROW_HEIGHT = 400;
const GRIP = 6; // px width of a header resize grip
const SCAN_LIMIT = 20000; // biggest range we walk cell-by-cell
const AUTOSCROLL_MAX = 24; // px per frame
// How many merge-covered cells the A1 lookup map is allowed to enumerate. Real documents
// merge titles and label blocks, so the whole index is a handful of entries; the cap only
// exists so that one absurd rectangle (A1:ZZ5000) cannot allocate millions of strings.
// Anything past the cap falls back to a rect test over the few oversized entries.
const MERGE_INDEX_LIMIT = 20000;

// Shared empties for the (overwhelmingly common) no-merge sheet: the merge index then
// costs one reference assignment and every merge lookup is a single boolean test.
const NO_RECTS = [];
const NO_KEYS = [];
const EMPTY_MAP = new Map();

// --- SPEC section 22.5: cell formatting, batch A -------------------------------------
// The two shadow fragments below are copied VERBATIM from public/css/style.css so that a
// bordered cell can compose its border insets with the lines the stylesheet already draws.
// They must stay in sync with the `.sz-cell` / `.sz-cell-selected` rules; both use the
// same custom properties, so dark mode follows with no extra work here.
//
// Why an inline box-shadow at all: `bd` MUST be drawn as inset shadows rather than a real
// CSS border, because a border participates in the box and would shift every cell to the
// right of it by its width. An inline box-shadow, however, outranks `.sz-cell-selected`
// and `.sz-cell-active`, so a bordered cell has to re-supply the grid lines AND the
// selection wash itself — that is exactly what _paintCell composes and _paintSelection
// switches between. A cell with no `bd` never gets an inline box-shadow at all and so
// keeps precisely the shadow the stylesheet gives it today.
const CELL_LINES = 'inset -1px 0 0 var(--sz-line),inset 0 -1px 0 var(--sz-line)';
const SEL_WASH = 'inset 0 0 0 9999px var(--sz-sel-fill)';

// Border sides in the canonical order used by shared/model.js, each with the inset
// box-shadow template that paints it. `%` is replaced by the edge width in px.
// box-shadow inset syntax is `inset <x> <y> <blur> <spread> <color>`; a side is drawn by
// offsetting a zero-blur shadow inwards by its own width.
const BORDER_SHADOWS = [
  ['t', 'inset 0 ', 'px 0 0 '],
  ['r', 'inset -', 'px 0 0 0 '],
  ['b', 'inset 0 -', 'px 0 0 '],
  ['l', 'inset ', 'px 0 0 0 '],
];

// Rotation limits, mirroring shared/model.js. sanitizeDoc already clamps, but the grid
// also renders styles that never went through the wire (a local edit paints before the
// server echoes it), so the renderer clamps too rather than trusting its input.
const MAX_ROTATION = 90;
/** A spilling cell borrows at most this many columns, so one long string cannot
 *  make the renderer walk the whole row. */
const MAX_SPILL_COLS = 20;

// --- SPEC section 23.2: 확대/축소 --------------------------------------------------
// The clamp SPEC 23.2 states. The toolbar offers 50..200%, but setZoom is public API and
// clamps whatever it is handed rather than trusting the caller.
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
// The two typography tokens the grid's own elements read, copied from
// public/css/style.css (`:root { --sz-fs: 13px; --sz-fs-sm: 12px }`). They are overridden
// on the grid ROOT while zoomed and removed again at 100%, so a zoom of 1 leaves the
// cascade in precisely the state it is in today. Keep these two numbers in sync with the
// stylesheet; nothing breaks if they drift, but zoomed text stops matching zoomed boxes.
const BASE_FS = 13;
const BASE_FS_SM = 12;

// --- SPEC section 23.4: 링크 삽입 ---------------------------------------------------
// The trailing affordance drawn inside a linked cell's <a>. A PLAIN click anywhere else
// in the cell selects it as usual (a linked cell must stay as easy to edit as any other);
// only Ctrl/Cmd+click, or a click on this glyph, follows the link.
const LINK_GLYPH = '↗';

// --- SPEC section 24: data features, batch C ----------------------------------------
// A y offset no row can occupy. `_oy` answers with it for a row the current filter view
// hides, and every overlay bounds test (the fill handle, peer cursors) rejects it — so a
// hidden row simply draws nothing instead of drawing at a wrong place.
const HIDDEN_POS = -1e7;

// The dropdown glyph drawn on a header cell of the filter range, and the width of its
// button in DOCUMENT pixels (it goes through _z like every other measurement).
const FILTER_GLYPH = '▾';
const FILTER_BTN_W = 15;

// The corner triangle on a commented cell, in document pixels, and the colour it falls
// back to when the stylesheet has not defined --sz-comment-mark.
const COMMENT_MARK = 7;
const COMMENT_MARK_FILL = 'var(--sz-comment-mark,#f9ab00)';

// --- SPEC section 25.3: auto-grow ---------------------------------------------------
// How close to the far edge the rendered window (or the active cell) has to come before
// the sheet is extended. The numbers are deliberately asymmetric: a row step is cheap and
// invisible, a column step shifts the horizontal scrollbar, so columns wait until the end
// is genuinely in sight.
const GROW_TRIGGER_ROWS = 50;
const GROW_TRIGGER_COLS = 5;
// One growth request per second PER AXIS. A flick-scroll to the bottom of a 200-row sheet
// fires dozens of scroll events; without this every one of them would queue a `meta` frame
// and a full re-render. The two axes are throttled separately so a diagonal scroll can
// still extend both.
const GROW_THROTTLE_MS = 1000;

const SVG_NS = 'http://www.w3.org/2000/svg';

// Chart geometry limits, mirroring shared/model.js (sanitizeChart). The grid clamps too,
// because a chart being dragged has not been through the wire yet.
const MIN_CHART_SIZE = 80;
const MAX_CHART_SIZE = 4000;
const MAX_CHART_POS = 2000000;
const DEFAULT_CHART_W = 480;
const DEFAULT_CHART_H = 300;
// Field separator for a chart's redraw signature: a control character no title can
// carry (sanitizeChart strips them), so two different charts can never run their
// fields together into the same string.
const SIG_SEP = String.fromCharCode(1);
// Side of the resize grip, in SCREEN pixels: it is a pointer affordance rather than part
// of the drawing, so it stays the same size at every zoom.
const CHART_HANDLE = 12;

const ARROWS = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

const MENU_ITEMS = [
  ['위에 행 삽입', 'insertRowAbove'],
  ['아래에 행 삽입', 'insertRowBelow'],
  ['왼쪽에 열 삽입', 'insertColLeft'],
  ['오른쪽에 열 삽입', 'insertColRight'],
  ['행 삭제', 'deleteRow'],
  ['열 삭제', 'deleteCol'],
  ['내용 지우기', 'clear'],
  ['셀 병합', 'mergeAll'],
  ['병합 해제', 'mergeNone'],
];

/* ------------------------------------------------------------------ helpers */

function noop() {}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function div(cls) {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  return el;
}

function css(el, props) {
  Object.assign(el.style, props);
  return el;
}

/** A colour we are willing to paste into a CSS declaration. */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * `style.bd` -> the inset box-shadow fragment that draws its four sides, or '' when the
 * cell has no borders. The caller appends CELL_LINES (and, when selected, SEL_WASH).
 *
 * Two deliberate limits, both forced by box-shadow being the only way to paint an edge
 * without changing the box:
 *  - `s` ('solid' | 'dashed' | 'dotted') is ACCEPTED and STORED but every edge renders
 *    solid: a box-shadow has no line style. Width and colour are honoured exactly.
 *  - Adjacent cells may each declare the shared edge; both are drawn, one inside each box,
 *    and the heavier simply wins visually (SPEC 22.3 says not to deduplicate).
 *
 * The colour is re-validated here even though sanitizeDoc already did: a style can reach
 * the renderer without a server round-trip, and this string is concatenated straight into
 * a declaration. An unusable colour falls back to black rather than dropping the edge,
 * matching sanitizeBorderEdge's own default.
 */
function borderShadow(bd) {
  if (!bd || typeof bd !== 'object') return '';
  let out = '';
  for (let i = 0; i < BORDER_SHADOWS.length; i++) {
    const spec = BORDER_SHADOWS[i];
    const edge = bd[spec[0]];
    if (!edge || typeof edge !== 'object') continue;
    const w = typeof edge.w === 'number' && Number.isFinite(edge.w)
      ? clamp(Math.round(edge.w), 1, 3)
      : 1;
    const c = typeof edge.c === 'string' && HEX6.test(edge.c) ? edge.c : '#000000';
    const piece = spec[1] + w + spec[2] + c;
    out = out ? out + ',' + piece : piece;
  }
  return out;
}

/**
 * `style.va` -> the `align-content` value for the cell's grid box, or '' to leave the
 * stylesheet alone.
 *
 * The stylesheet centres every cell vertically (`.sz-cell { display:grid;
 * align-content:center }`), and the hard rule for this batch is that a cell carrying none
 * of the six new keys must render byte-for-byte as it does today. So ABSENT `va` writes
 * nothing at all and stays centred, while each of the three explicit values maps to what
 * it says on the tin. An explicit 'bottom' therefore does move text to the bottom even
 * though SPEC 22.1 calls 'bottom' the notional default — the alternative (mapping
 * 'bottom' onto centre) would make 세로 정렬 아래 and 가운데 indistinguishable.
 */
function valignCss(va) {
  switch (va) {
    case 'top':
      return 'start';
    case 'middle':
      return 'center';
    case 'bottom':
      return 'end';
    default:
      return '';
  }
}

/**
 * Build the <a> a linked cell renders its text inside (SPEC 23.4).
 *
 * Constructed node by node — never with innerHTML and never by concatenating a cell value
 * into markup. The value itself only ever reaches the DOM as a text node, and `href` is
 * written later from the sanitised URL alone (see Grid#_cellLink), so a cell holding
 * `<img onerror=...>` or `javascript:alert(1)` is inert both as text and as a target.
 *
 * `rel="noopener noreferrer"` is not optional: `target="_blank"` otherwise hands the
 * opened page a live `window.opener` back into this document.
 */
function makeLinkAnchor() {
  const a = document.createElement('a');
  a.className = 'sz-cell-link';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const label = document.createTextNode('');
  a.appendChild(label);
  const glyph = document.createElement('span');
  glyph.className = 'sz-cell-link-glyph';
  glyph.textContent = LINK_GLYPH;
  // decorative: the anchor already carries the destination for assistive tech
  glyph.setAttribute('aria-hidden', 'true');
  a.appendChild(glyph);
  a.__label = label;
  return a;
}

/** True when this mouse/click event asks to FOLLOW a link rather than select its cell. */
function isLinkFollow(e, anchor) {
  if (!anchor) return false;
  if (e.ctrlKey || e.metaKey) return true;
  const t = e.target;
  return !!(t && t.closest && t.closest('.sz-cell-link-glyph'));
}

/** The .sz-cell-link ancestor of an event target, or null. */
function linkTarget(e) {
  const t = e.target;
  return t && t.closest ? t.closest('.sz-cell-link') : null;
}

/**
 * A DOMRect copied into a plain, mutable object. The batch-C callbacks hand the host a
 * rectangle to anchor a panel to; a live DOMRect is read-only and goes stale, and the
 * callers below want to hang a couple of extra fields on it.
 */
function boxOf(el) {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

/** Normalize a {s:{row,col},e:{row,col}} pair through the shared helper. */
function normRange(range) {
  const n = normalizeRange({ s: { ...range.s }, e: { ...range.e } });
  return {
    s: { row: n.s.row, col: n.s.col },
    e: { row: n.e.row, col: n.e.col },
  };
}

function inRange(r, row, col) {
  return !!r && row >= r.s.row && row <= r.e.row && col >= r.s.col && col <= r.e.col;
}

/**
 * True when the inclusive span [a,b] touches the rendered band on one axis: either the
 * windowed run lo..hi (empty when hi < lo) or the frozen run 0..frozen-1.
 */
function bandHit(a, b, lo, hi, frozen) {
  if (frozen > 0 && a < frozen) return true;
  return lo <= hi && b >= lo && a <= hi;
}

/** True when `text` is a plain number literal (used by the fill series detector). */
function numericInput(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t[0] === '=') return false;
  return Number.isFinite(Number(t));
}

/** Trim float noise produced by repeated addition. */
function tidyNumber(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Number(n.toFixed(10));
  return String(Object.is(r, -0) ? 0 : r);
}

/** Positive modulo. */
function mod(a, n) {
  return ((a % n) + n) % n;
}

/** The sheet-shaped object the grid falls back to when the host supplies none. */
function blankSheet() {
  return {
    id: '',
    name: '',
    rows: 200,
    cols: 26,
    cells: {},
    colWidths: {},
    rowHeights: {},
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    // Batch-C state (SPEC section 24), empty rather than undefined so every reader can
    // take it without a guard — the same contract emptySheet() gives a real sheet.
    filter: null,
    charts: [],
    comments: {},
  };
}

/* -------------------------------------------------------------------- Grid */

export class Grid {
  /**
   * The grid is bound to ONE sheet of a document (SPEC section 10): every metric it
   * reads — rows, cols, colWidths, rowHeights, frozenRows, frozenCols, cells — comes
   * from that sheet object, and `engine` is that sheet's own SheetEngine. The host
   * swaps both together with setSheet() when the user changes tab.
   *
   * @param {HTMLElement|string} container host element (emptied and owned by the grid)
   * @param {{engine:object, sheet:object, onEdit?:Function, onCursor?:Function,
   *          onStructural?:Function, onMeta?:Function, onMerge?:Function}} opts
   */
  constructor(container, opts = {}) {
    this.container =
      typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.container) throw new Error('Grid: container element not found');

    this.engine = opts.engine;
    this.sheet = opts.sheet || blankSheet();
    this.onEdit = opts.onEdit || noop;
    this.onCursor = opts.onCursor || noop;
    this.onStructural = opts.onStructural || noop;
    this.onMeta = opts.onMeta || noop;
    this.onMerge = opts.onMerge || noop;
    // SPEC section 24 — see the callback block in the file header.
    this.onFilterMenu = opts.onFilterMenu || noop;
    this.onChartChange = opts.onChartChange || noop;
    this.onCommentOpen = opts.onCommentOpen || noop;
    /** onNotice(message, tone) — the grid refusing something has to say why. */
    this.onNotice = opts.onNotice || noop;

    // internal state -------------------------------------------------------
    this._listeners = [];
    this._cells = new Map(); // A1 -> node
    this._pool = []; // recycled cell nodes
    this._colHeads = new Map(); // col -> node
    this._rowHeads = new Map(); // row -> node
    this._peerEls = [];
    this._peers = [];
    this._sel = {
      active: { row: 0, col: 0 },
      range: { s: { row: 0, col: 0 }, e: { row: 0, col: 0 } }, // s = anchor, e = focus
    };
    this._editing = null; // {row, col, a1, typed}
    this._pointRef = null; // {start, end, a:{row,col}, b:{row,col}|null}
    this._pointRange = null; // normalized highlight for the pointed ref
    this._fillPreview = null; // normalized range painted while dragging the handle
    this._drag = null;
    this._menuEl = null;
    this._raf = 0;
    this._autoRaf = 0;
    this._lastMouse = null;
    this._tabAnchorCol = null;
    this._selfEdit = false;
    this._destroyed = false;

    // SPEC 23.2 — view zoom. A per-viewer preference: it multiplies every pixel the grid
    // computes (through _z) and never touches sheet.colWidths / sheet.rowHeights.
    this._zoom = 1;
    this._hw = HEADER_W; // scaled row-header band width  (_layout recomputes)
    this._hh = HEADER_H; // scaled column-header band height
    // SPEC 23.1 — the painter's cursor class. All of its state lives in main.js.
    this._painting = false;

    // merge index (SPEC 21.4) — see _buildMergeIndex()
    this._hasMerges = false;
    this._mergeSrc = null;
    this._mergeKeys = NO_KEYS;
    this._mergeRects = NO_RECTS;
    this._mergeCover = EMPTY_MAP;
    this._mergeAnchors = EMPTY_MAP;
    this._mergeBigKeys = NO_KEYS;
    this._mergeByKey = EMPTY_MAP;
    this._mergeGen = 0;
    this._selCache = null;

    // --- SPEC 24.1 filter view -------------------------------------------
    // The ONE mapping between a row index and a screen position. Both arrays are null
    // whenever the view is the identity, which is the case for every sheet with no
    // filter and for a filter that neither hides nor sorts anything; `_rowOf`/`_viewOf`
    // then cost one null test and return their argument.
    this._viewRows = null; // Int32Array: display index -> absolute row
    this._rowView = null; // Int32Array: absolute row -> display index, -1 when hidden
    this._viewCount = 0; // number of rows the view paints (_layout fills it in)
    this._filterSrc = null; // last seen sheet.filter, by reference
    this._filterRect = null; // {r1,c1,r2,c2} of filter.range, or null
    this._rowViewDirty = true;
    // Reading a computed value for the pure helpers in shared/model.js, which must not
    // import the engine. Built once so the row view never allocates a closure per pass.
    this._valueOf = (row, col) => {
      try {
        return this.engine.getValue(cellToA1(row, col));
      } catch {
        return null;
      }
    };

    // --- SPEC 25.3 auto-grow ----------------------------------------------
    // Last time each axis was extended, as a millisecond timestamp; 0 means "never", so
    // the first trigger always passes. Two scalars rather than an object: `_maybeGrow`
    // runs on the scroll path and must not allocate.
    this._growRowsAt = 0;
    this._growColsAt = 0;
    this._growBusy = false;
    // The row count `_buildRowView` was last built for. Growing the sheet adds display
    // positions, so a view built for the old count would leave every new row unpainted.
    this._viewSrcRows = -1;

    // --- SPEC 24.2 charts -------------------------------------------------
    this._chartEls = new Map(); // chart id -> { id, svg, handle, chart, rect, sig }
    this._chartSrc = null; // last seen sheet.charts, by reference
    this._chartGen = 0; // bumped when every chart must be redrawn (zoom)

    // --- SPEC 24.3 comments -----------------------------------------------
    this._commentSrc = null; // last seen sheet.comments, by reference
    this._comments = null; // that map, or null when the sheet carries no thread
    this._hasComments = false;

    this._buildDom();
    this._bindEvents();
    this.render();
  }

  /* ----------------------------------------------------------------- DOM */

  _buildDom() {
    const root = div('sz-grid');
    root.tabIndex = -1;
    // Every descendant of this root is absolutely positioned, so as a normal-flow
    // block the root would collapse to zero height and the viewport (inset:0) would
    // collapse with it — no rows intersect the window, no cells render. Pin the root
    // to its container's box instead, and make sure that container establishes a
    // containing block even if the host stylesheet left it static.
    css(root, { position: 'absolute', inset: '0', overflow: 'hidden' });
    this.el = root;

    // scrolling pane -------------------------------------------------------
    const vp = div('sz-viewport');
    css(vp, { position: 'absolute', overflow: 'auto' });
    const spacer = div('sz-spacer');
    css(spacer, { position: 'absolute', left: '0', top: '0', width: '0', height: '0' });
    const cells = div('sz-cells');
    css(cells, { position: 'absolute', left: '0', top: '0', width: '0', height: '0' });
    // SPEC 24.2 — the chart layer sits INSIDE the scrolling viewport, immediately over
    // the cells layer, and shares its coordinate space. That is what makes charts scroll
    // with the grid without a single line of per-frame work. It is zero-sized with
    // `overflow: visible`, so it adds nothing to the scrollable extent the spacer
    // defines, and pointer-transparent, so only the charts themselves take clicks.
    const chartLayer = div('sz-chart-layer');
    css(chartLayer, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      overflow: 'visible',
      pointerEvents: 'none',
    });
    vp.appendChild(spacer);
    vp.appendChild(cells);
    vp.appendChild(chartLayer);
    root.appendChild(vp);
    this._vp = vp;
    this._spacer = spacer;
    this._cellsLayer = cells;
    this._chartLayer = chartLayer;

    // frozen bands ---------------------------------------------------------
    const topPane = div('sz-frozen sz-frozen-top');
    css(topPane, { position: 'absolute', overflow: 'hidden' });
    const topInner = div();
    css(topInner, { position: 'absolute', left: '0', top: '0', width: '0', height: '0' });
    topPane.appendChild(topInner);

    const leftPane = div('sz-frozen sz-frozen-left');
    css(leftPane, { position: 'absolute', overflow: 'hidden' });
    const leftInner = div();
    css(leftInner, { position: 'absolute', left: '0', top: '0', width: '0', height: '0' });
    leftPane.appendChild(leftInner);

    const cornerPane = div('sz-frozen sz-frozen-corner');
    css(cornerPane, { position: 'absolute', overflow: 'hidden' });

    root.appendChild(topPane);
    root.appendChild(leftPane);
    root.appendChild(cornerPane);
    this._topPane = topPane;
    this._topInner = topInner;
    this._leftPane = leftPane;
    this._leftInner = leftInner;
    this._cornerPane = cornerPane;

    // headers --------------------------------------------------------------
    const colLayer = div('sz-colhead-layer');
    css(colLayer, { position: 'absolute', overflow: 'hidden' });
    const colFrozen = div();
    css(colFrozen, { position: 'absolute', left: '0', top: '0', width: '0', height: '100%' });
    const colInner = div();
    css(colInner, { position: 'absolute', left: '0', top: '0', width: '0', height: '100%' });
    colLayer.appendChild(colInner);
    colLayer.appendChild(colFrozen);

    const rowLayer = div('sz-rowhead-layer');
    css(rowLayer, { position: 'absolute', overflow: 'hidden' });
    const rowFrozen = div();
    css(rowFrozen, { position: 'absolute', left: '0', top: '0', width: '100%', height: '0' });
    const rowInner = div();
    css(rowInner, { position: 'absolute', left: '0', top: '0', width: '100%', height: '0' });
    rowLayer.appendChild(rowInner);
    rowLayer.appendChild(rowFrozen);

    const corner = div('sz-corner');
    css(corner, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: HEADER_W + 'px',
      height: HEADER_H + 'px',
    });

    root.appendChild(colLayer);
    root.appendChild(rowLayer);
    root.appendChild(corner);
    this._colLayer = colLayer;
    this._colInner = colInner;
    this._colFrozen = colFrozen;
    this._rowLayer = rowLayer;
    this._rowInner = rowInner;
    this._rowFrozen = rowFrozen;
    this._cornerBox = corner;

    // overlay: editor, fill handle, remote cursors -------------------------
    const overlay = div('sz-overlay');
    css(overlay, { position: 'absolute', overflow: 'hidden', pointerEvents: 'none' });

    const editor = document.createElement('textarea');
    editor.className = 'sz-editor';
    editor.wrap = 'off';
    editor.spellcheck = false;
    editor.setAttribute('autocomplete', 'off');
    css(editor, {
      position: 'absolute',
      display: 'block',
      resize: 'none',
      boxSizing: 'border-box',
      whiteSpace: 'pre',
      overflow: 'hidden',
    });
    overlay.appendChild(editor);

    const fill = div('sz-fill');
    css(fill, {
      position: 'absolute',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'auto',
      cursor: 'crosshair',
      display: 'none',
    });
    overlay.appendChild(fill);

    root.appendChild(overlay);
    this._overlay = overlay;
    this._editor = editor;
    this._fill = fill;

    // resize guide ---------------------------------------------------------
    const guide = div('sz-resize-guide');
    css(guide, { position: 'absolute', display: 'none', pointerEvents: 'none' });
    root.appendChild(guide);
    this._guide = guide;

    this.container.innerHTML = '';
    // The root is absolutely positioned, so it resolves against the nearest positioned
    // ancestor. If the container is static the root would escape to the page box.
    const hostPos = getComputedStyle(this.container).position;
    if (hostPos === 'static') this.container.style.position = 'relative';
    this.container.appendChild(root);
    this._setEditorIdle();
  }

  /* ------------------------------------------------------------- metrics */

  /**
   * Document pixels -> screen pixels. THE one place the zoom factor is applied
   * (SPEC 23.2), which is why nothing else in this file — hit-testing, scrolling, the
   * fill handle, merges, frozen panes, peer cursors, auto-fit — carries any zoom
   * arithmetic of its own.
   *
   * At a zoom of 1 this is the identity on every input the grid feeds it, so the whole
   * module produces byte-identical geometry to the version that had no zoom at all.
   * Away from 1 the result is rounded, so cell boxes stay on whole pixels and the
   * cumulative offsets built from them (which are sums of these same rounded values)
   * keep agreeing with the boxes to the pixel — a half-pixel column would put a hairline
   * seam between a cell and the header that is supposed to sit exactly above it.
   */
  _z(px) {
    return this._zoom === 1 ? px : Math.round(px * this._zoom);
  }

  /**
   * Column width as STORED in the document, in unscaled pixels. This is the value the
   * resize drag, auto-fit and the `meta` frame work in, so a zoomed viewer writes the
   * same number a 100% viewer would (SPEC 23.2: zoom never mutates the sheet).
   */
  _docColW(col) {
    const w = Number((this.sheet.colWidths || {})[col]);
    return Number.isFinite(w) && w > 0
      ? clamp(w, MIN_COL_WIDTH, MAX_COL_WIDTH)
      : DEFAULT_COL_WIDTH;
  }

  /** Row height as stored in the document, unscaled. See _docColW. */
  _docRowH(row) {
    const h = Number((this.sheet.rowHeights || {})[row]);
    return Number.isFinite(h) && h > 0
      ? clamp(h, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT)
      : DEFAULT_ROW_HEIGHT;
  }

  /** On-screen column width. Every renderer, hit test and overlay uses this one. */
  _colW(col) {
    return this._z(this._docColW(col));
  }

  /** On-screen row height. */
  _rowH(row) {
    return this._z(this._docRowH(row));
  }

  /** Rebuild cumulative pixel offsets and the frozen band sizes. */
  _layout() {
    const d = this.sheet;
    // Header bands scale with everything else, so the row numbers keep matching the rows
    // and the column letters keep matching the columns.
    this._hw = this._z(HEADER_W);
    this._hh = this._z(HEADER_H);
    this.rows = Math.max(1, Math.floor(d.rows || (this.engine && this.engine.rows) || 200));
    this.cols = Math.max(1, Math.floor(d.cols || (this.engine && this.engine.cols) || 26));
    // The filter view decides how many rows are PAINTED and in what order, so it is built
    // before anything that measures them (SPEC 24.1).
    this._ensureRowView();
    // Frozen rows are the first N rows OF THE VIEW, so the band keeps holding the table's
    // header after a sort — and so `_ry[frozenRows]` is always in range.
    this.frozenRows = clamp(Math.floor(d.frozenRows || 0), 0, Math.min(this._viewCount - 1, 50));
    this.frozenCols = clamp(Math.floor(d.frozenCols || 0), 0, Math.min(this.cols - 1, 26));

    const cx = new Float64Array(this.cols + 1);
    for (let c = 0; c < this.cols; c++) cx[c + 1] = cx[c] + this._colW(c);
    // `_ry` is indexed by DISPLAY position, not by row: with no filter the two are the
    // same number and this loop is exactly the one that was here before.
    const view = this._viewRows;
    const ry = new Float64Array(this._viewCount + 1);
    if (view) {
      for (let i = 0; i < this._viewCount; i++) ry[i + 1] = ry[i] + this._rowH(view[i]);
    } else {
      for (let r = 0; r < this.rows; r++) ry[r + 1] = ry[r] + this._rowH(r);
    }
    this._cx = cx;
    this._ry = ry;
    this._fw = cx[this.frozenCols];
    this._fh = ry[this.frozenRows];

    // The merge index depends on rows/cols AND on the pixel offsets just computed, so it
    // is rebuilt here — once per render(), never per cell and never per frame.
    this._buildMergeIndex();

    // keep the selection inside the sheet
    this._sel.active = this._anchorCell(this._clampCell(this._sel.active));
    this._sel.range = {
      s: this._clampCell(this._sel.range.s),
      e: this._clampCell(this._sel.range.e),
    };
  }

  _clampCell(c) {
    const row = c && Number.isFinite(c.row) ? Math.floor(c.row) : 0;
    const col = c && Number.isFinite(c.col) ? Math.floor(c.col) : 0;
    return { row: clamp(row, 0, this.rows - 1), col: clamp(col, 0, this.cols - 1) };
  }

  /* ---------------------------------------------------- filter view (24.1) */

  /**
   * Rebuild the row mapping from `sheet.filter`, if it is stale.
   *
   * This is THE place where "which rows are painted, and in what order" is decided
   * (SPEC 24.1). Everything downstream — the window, hit-testing, scrolling, the y
   * offsets, selection, keyboard movement, the fill handle, merges, frozen panes and
   * peer cursors — reads the result through `_rowOf` / `_viewOf` / `_oy` and never looks
   * at `sheet.filter` again.
   *
   * It runs when the filter object is REPLACED or when data inside the filter range
   * changes (refreshCells marks it dirty), never per frame: both helpers are O(rows).
   */
  _ensureRowView() {
    const filter = this.sheet ? this.sheet.filter : null;
    // `_viewSrcRows` is the third term because a sheet can GROW (SPEC 25): the filter
    // object is unchanged and nothing is dirty, but the view is one array shorter than
    // the sheet and would silently refuse to paint the rows that were just added. It
    // catches a remote peer's growth arriving as a `meta` frame just as well as this
    // grid's own, and costs one integer compare on every other render.
    if (!this._rowViewDirty && filter === this._filterSrc && this._viewSrcRows === this.rows) {
      return;
    }
    this._buildRowView(filter);
  }

  /** Collapse to the identity mapping: no rows hidden, no rows moved. */
  _identityRowView() {
    this._viewRows = null;
    this._rowView = null;
    this._viewCount = this.rows;
  }

  _buildRowView(filter) {
    this._filterSrc = filter;
    this._rowViewDirty = false;
    this._filterRect = null;
    const rows = this.rows;
    this._viewSrcRows = rows;
    if (!filter || typeof filter.range !== 'string') {
      // The overwhelmingly common case: no filter at all. Neither helper is called, so a
      // plain sheet pays one property read for this whole feature.
      this._identityRowView();
      return;
    }
    const rect = mergeRect(filter.range);
    if (!rect || rect.r1 >= rows || rect.c1 >= this.cols) {
      this._identityRowView();
      return;
    }
    this._filterRect = rect;

    const cells = (this.sheet && this.sheet.cells) || {};
    let order = null;
    let visible = null;
    try {
      order = computeSortOrder(cells, filter, this._valueOf, rows);
      visible = computeVisibleRows(cells, filter, this._valueOf, rows);
    } catch (e) {
      // A filter must never be able to take the grid down: fall back to the plain sheet.
      console.error('Grid filter view failed', e);
      this._identityRowView();
      return;
    }

    // Is the result actually the identity? A filter that hides nothing and sorts nothing
    // is extremely common (it is the state a freshly created filter is in), and it must
    // cost exactly what no filter costs from here on.
    let same = visible.size >= rows;
    if (same) {
      for (let i = 0; i < rows; i++) {
        if (order[i] !== i) {
          same = false;
          break;
        }
      }
    }
    if (same) {
      this._identityRowView();
      return;
    }

    const rowView = new Int32Array(rows).fill(-1);
    const list = new Int32Array(visible.size);
    let n = 0;
    for (let i = 0; i < order.length; i++) {
      const row = order[i];
      if (row < 0 || row >= rows || !visible.has(row)) continue;
      rowView[row] = n;
      list[n++] = row;
    }
    if (n === 0) {
      // Nothing left to paint. That cannot happen through sanitizeFilter (the header row
      // always survives), but an empty sheet is never the right answer, so fall back.
      this._identityRowView();
      return;
    }
    this._viewRows = n === list.length ? list : list.slice(0, n);
    this._rowView = rowView;
    this._viewCount = n;
  }

  /** Display position -> absolute row. The identity when nothing is filtered. */
  _rowOf(vi) {
    const v = this._viewRows;
    return v ? v[vi] : vi;
  }

  /** Absolute row -> display position, or -1 when the filter hides it. */
  _viewOf(row) {
    const v = this._rowView;
    if (!v) return row;
    return row >= 0 && row < v.length ? v[row] : -1;
  }

  /** True when this row is painted at all. Always true with no filter. */
  _rowShown(row) {
    return this._viewOf(row) >= 0;
  }

  /**
   * One row step in DISPLAY space, so arrows, Tab, Enter and PageUp/PageDown walk past a
   * hidden row instead of into it. Clamps at both ends, like the identity path's
   * `_clampCell` does. With no filter this is `row + dr`, exactly as before.
   */
  _stepRow(row, dr) {
    if (!dr) return row;
    if (!this._viewRows) return row + dr;
    const vi = this._viewOf(row);
    if (vi < 0) return row + dr; // the cursor sits on a hidden row: step absolutely
    const t = vi + dr;
    if (t < 0) return this._rowOf(0);
    if (t >= this._viewCount) return this._rowOf(this._viewCount - 1);
    return this._rowOf(t);
  }

  /** The next row in display order, or -1 when there is none (used by Ctrl+Arrow). */
  _advRow(row, dr) {
    if (!dr) return row;
    if (!this._viewRows) {
      const t = row + dr;
      return t < 0 || t >= this.rows ? -1 : t;
    }
    const vi = this._viewOf(row);
    if (vi < 0) {
      const t = row + dr;
      return t < 0 || t >= this.rows ? -1 : t;
    }
    const t = vi + dr;
    return t < 0 || t >= this._viewCount ? -1 : this._rowOf(t);
  }

  /**
   * True when any of these A1 keys lies inside the filter range — i.e. when an edit may
   * have changed which rows the view shows, or their order. Only ever called while a
   * filter exists, and the key set an edit produces is small.
   */
  _touchesFilter(keys) {
    const rect = this._filterRect;
    if (!rect) return false;
    for (const key of keys) {
      let c;
      try {
        c = a1ToCell(key);
      } catch {
        continue;
      }
      if (c.row >= rect.r1 && c.row <= rect.r2 && c.col >= rect.c1 && c.col <= rect.c2) {
        return true;
      }
    }
    return false;
  }

  /** Height of the display band spanning absolute rows r1..r2 (used by merges). */
  _spanH(r1, r2) {
    if (!this._viewRows) return this._ry[r2 + 1] - this._ry[r1];
    const a = this._viewOf(r1);
    const b = this._viewOf(r2);
    if (a < 0) return 0;
    // A merge whose rows were split apart by a sort or a filter cannot span a contiguous
    // band any more, so it falls back to its anchor row's own height rather than covering
    // rows that are no longer under it.
    if (b < a) return this._ry[a + 1] - this._ry[a];
    return this._ry[b + 1] - this._ry[a];
  }

  /* -------------------------------------------------------------- merges */

  /**
   * Index sheet.merges once, so that nothing downstream ever scans the list per cell.
   *
   * It produces, from the sheet's `merges` array (SPEC 21.1):
   *   _mergeRects    [{key, r1, c1, r2, c2, w, h}] clipped to the sheet, in list order
   *   _mergeCover    Map A1 -> that entry, for EVERY cell of every rectangle including
   *                  its anchor, so "which merge covers this cell" is one Map.get
   *   _mergeAnchors  Map anchor A1 -> that entry (rect + pixel width/height), which is
   *                  what rendering, the editor and hit tests read
   *   _mergeBigKeys  the few rectangles too large to enumerate into _mergeCover; they
   *                  are answered by mergeAt() over that key list and _mergeByKey
   *   _hasMerges     false for a sheet with no merges — every merge-aware path in this
   *                  file tests it first and then behaves exactly as it did before merges
   *                  existed, allocating nothing
   *
   * Called from _layout() (so, once per render) and from _renderCells when the sheet's
   * merge array has been REPLACED behind our back. A host that mutates the same array in
   * place must call render(); that is the documented contract for colWidths too.
   */
  /** A1 keys whose rendered width currently borrows from empty neighbours. */
  get _spilling() {
    if (!this.__spilling) this.__spilling = new Set();
    return this.__spilling;
  }

  _buildMergeIndex() {
    const src = this.sheet ? this.sheet.merges : null;
    this._mergeSrc = src;
    this._selCache = null;
    this._mergeGen++;
    if (!Array.isArray(src) || src.length === 0) {
      this._hasMerges = false;
      this._mergeKeys = NO_KEYS;
      this._mergeRects = NO_RECTS;
      this._mergeCover = EMPTY_MAP;
      this._mergeAnchors = EMPTY_MAP;
      this._mergeBigKeys = NO_KEYS;
      this._mergeByKey = EMPTY_MAP;
      return;
    }

    const rects = [];
    const cover = new Map();
    const anchors = new Map();
    const bigKeys = [];
    const byKey = new Map();
    const cx = this._cx;
    let budget = MERGE_INDEX_LIMIT;

    for (const key of src) {
      if (typeof key !== 'string') continue;
      const rect = mergeRect(key);
      const anchor = rect ? mergeAnchor(key) : null;
      if (!rect || !anchor) continue;
      // A merge that starts outside this sheet is ignored; one that hangs off the edge is
      // clipped, exactly as normalizeMergeList would have done on the way in.
      if (rect.r1 >= this.rows || rect.c1 >= this.cols) continue;
      const r2 = Math.min(rect.r2, this.rows - 1);
      const c2 = Math.min(rect.c2, this.cols - 1);
      if (r2 === rect.r1 && c2 === rect.c1) continue; // clipped down to a single cell
      const m = {
        key,
        r1: rect.r1,
        c1: rect.c1,
        r2,
        c2,
        // Display positions of the rectangle's first and last row (SPEC 24.1). They are
        // the row indexes themselves when nothing is filtered, and they are what the
        // window test and `_bandFor` compare against — a merge whose anchor row is
        // hidden (vr1 < 0) is not drawn at all.
        vr1: this._viewOf(rect.r1),
        vr2: this._viewOf(r2),
        w: cx[c2 + 1] - cx[rect.c1],
        h: this._spanH(rect.r1, r2),
      };
      rects.push(m);
      byKey.set(key, m);
      anchors.set(cellToA1(m.r1, m.c1), m);
      const cells = (m.r2 - m.r1 + 1) * (m.c2 - m.c1 + 1);
      if (cells <= budget) {
        budget -= cells;
        for (let r = m.r1; r <= m.r2; r++) {
          for (let c = m.c1; c <= m.c2; c++) cover.set(cellToA1(r, c), m);
        }
      } else {
        bigKeys.push(key);
      }
    }

    this._hasMerges = rects.length > 0;
    this._mergeKeys = src;
    this._mergeRects = rects;
    this._mergeCover = cover;
    this._mergeAnchors = anchors;
    this._mergeBigKeys = bigKeys;
    this._mergeByKey = byKey;
  }

  /**
   * The merge entry covering (row, col), or null. `a1` is an optional already-computed
   * key for the cell — every hot caller has one, which keeps this allocation-free.
   */
  _mergeCoverAt(row, col, a1) {
    if (!this._hasMerges) return null;
    const m = this._mergeCover.get(a1 || cellToA1(row, col));
    if (m) return m;
    if (this._mergeBigKeys.length === 0) return null;
    const key = mergeAt(this._mergeBigKeys, row, col);
    return key ? this._mergeByKey.get(key) || null : null;
  }

  /** The anchor of the merge containing `cell`, or `cell` itself when it is not merged. */
  _anchorCell(cell) {
    if (!this._hasMerges) return cell;
    const m = this._mergeCoverAt(cell.row, cell.col);
    return m && (m.r1 !== cell.row || m.c1 !== cell.col) ? { row: m.r1, col: m.c1 } : cell;
  }

  /**
   * Grow a {s,e} selection rectangle until it holds every merge it touches whole
   * (SPEC 21.4). Returns the input untouched when the sheet has no merges.
   */
  _expandOver(rect) {
    if (!this._hasMerges) return rect;
    const g = expandOverMerges(this._mergeKeys, rect);
    if (
      g.r1 === rect.s.row &&
      g.c1 === rect.s.col &&
      g.r2 === rect.e.row &&
      g.c2 === rect.e.col
    ) {
      return rect;
    }
    return { s: { row: g.r1, col: g.c1 }, e: { row: g.r2, col: g.c2 } };
  }

  _colAt(x) {
    const a = this._cx;
    if (x <= 0) return 0;
    if (x >= a[this.cols]) return this.cols - 1;
    let lo = 0;
    let hi = this.cols - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Sheet y -> DISPLAY position (SPEC 24.1). `_ry` is indexed by display position. */
  _viewAt(y) {
    const a = this._ry;
    const n = this._viewCount;
    if (y <= 0) return 0;
    if (y >= a[n]) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Sheet y -> absolute row. Hit tests speak absolute rows, as they always have. */
  _rowAt(y) {
    return this._rowOf(this._viewAt(y));
  }

  /** x of a column relative to the body origin (right of the row headers). */
  _ox(col) {
    return this._cx[col] - (col < this.frozenCols ? 0 : this._vp.scrollLeft);
  }

  /**
   * y of a row relative to the body origin (below the column headers), or HIDDEN_POS
   * when the filter view does not paint that row at all. Every overlay that positions
   * itself from this rejects HIDDEN_POS by its own bounds test.
   */
  _oy(row) {
    const vi = this._viewOf(row);
    if (vi < 0) return HIDDEN_POS;
    return this._ry[vi] - (vi < this.frozenRows ? 0 : this._vp.scrollTop);
  }

  /* ------------------------------------------------------------ rendering */

  /** Full re-render: metrics, pane geometry, cells, headers, overlays. */
  render() {
    if (this._destroyed) return;
    this._layout();
    this._applyGeometry();
    this._syncScroll();
    this._renderCells(true);
    this._renderHeaders(true);
    this._renderCharts();
    this._paintSelection();
    this._positionEditor();
    this._positionFill();
    this._renderPeers();
    this._rescanScroll();
  }

  _applyGeometry() {
    const totalW = this._cx[this.cols];
    // The scrollable height is the height of what is PAINTED, so hiding rows shortens
    // the scrollbar exactly as hiding rows should (SPEC 24.1).
    const totalH = this._ry[this._viewCount];
    const fw = this._fw;
    const fh = this._fh;
    // Zoomed header metrics (SPEC 23.2). At a zoom of 1 these are HEADER_W / HEADER_H.
    const hw = this._hw;
    const hh = this._hh;

    css(this._vp, {
      left: hw + fw + 'px',
      top: hh + fh + 'px',
      right: '0px',
      bottom: '0px',
    });
    css(this._spacer, {
      width: Math.max(0, totalW - fw) + 'px',
      height: Math.max(0, totalH - fh) + 'px',
    });

    css(this._topPane, {
      left: hw + fw + 'px',
      top: hh + 'px',
      right: '0px',
      height: fh + 'px',
      display: fh > 0 ? 'block' : 'none',
    });
    css(this._leftPane, {
      left: hw + 'px',
      top: hh + fh + 'px',
      width: fw + 'px',
      bottom: '0px',
      display: fw > 0 ? 'block' : 'none',
    });
    css(this._cornerPane, {
      left: hw + 'px',
      top: hh + 'px',
      width: fw + 'px',
      height: fh + 'px',
      display: fw > 0 && fh > 0 ? 'block' : 'none',
    });

    css(this._colLayer, {
      left: hw + 'px',
      top: '0px',
      right: '0px',
      height: hh + 'px',
    });
    css(this._rowLayer, {
      left: '0px',
      top: hh + 'px',
      width: hw + 'px',
      bottom: '0px',
    });
    // The select-all box is sized here rather than only at build time, so it follows zoom
    // along with the two bands it sits between.
    css(this._cornerBox, { width: hw + 'px', height: hh + 'px' });
    css(this._overlay, {
      left: hw + 'px',
      top: hh + 'px',
      right: '0px',
      bottom: '0px',
    });
  }

  /** Keep the header bands and frozen bands aligned with the scroll offset. */
  _syncScroll() {
    const sl = this._vp.scrollLeft;
    const st = this._vp.scrollTop;
    // Remember what this paint is being computed FROM. Resizing the spacer — which is
    // what growing a sheet does — can make the browser clamp or reset the offset during
    // layout, and that adjustment produces no scroll event we could react to. Without
    // this record the grid would keep showing a window it computed for an offset the
    // element no longer has: after a grow, the bottom of the OLD sheet, frozen in place
    // and immune to further scrolling because every later offset write is a no-op.
    this._paintedTop = st;
    this._paintedLeft = sl;
    this._colInner.style.transform = 'translateX(' + -sl + 'px)';
    this._topInner.style.transform = 'translateX(' + -sl + 'px)';
    this._rowInner.style.transform = 'translateY(' + -st + 'px)';
    this._leftInner.style.transform = 'translateY(' + -st + 'px)';
  }

  /**
   * Visible (overscanned) window. `c0`/`c1` are column indexes; `r0`/`r1` are DISPLAY
   * positions, which are row indexes only while the view is the identity (SPEC 24.1).
   * Callers turn a display position into a row with `_rowOf`.
   */
  _window() {
    const vw = this._vp.clientWidth;
    const vh = this._vp.clientHeight;
    const sl = this._vp.scrollLeft;
    const st = this._vp.scrollTop;
    const fw = this._fw;
    const fh = this._fh;
    let c0 = this._colAt(fw + sl) - OVERSCAN;
    let c1 = this._colAt(fw + sl + Math.max(0, vw - 1)) + OVERSCAN;
    let r0 = this._viewAt(fh + st) - OVERSCAN;
    let r1 = this._viewAt(fh + st + Math.max(0, vh - 1)) + OVERSCAN;
    c0 = Math.max(this.frozenCols, c0);
    c1 = Math.min(this.cols - 1, c1);
    r0 = Math.max(this.frozenRows, r0);
    r1 = Math.min(this._viewCount - 1, r1);
    if (vw <= 0 || vh <= 0) {
      // container not laid out yet — render the frozen bands only
      c1 = c0 - 1;
      r1 = r0 - 1;
    }
    return { r0, r1, c0, c1 };
  }

  _makeCell() {
    const el = div('sz-cell');
    css(el, {
      position: 'absolute',
      overflow: 'hidden',
      whiteSpace: 'pre',
      boxSizing: 'border-box',
    });
    // Last-written value of every SPEC 22 property, seeded with what the four declarations
    // above and the stylesheet already produce. Cell nodes are recycled as the viewport
    // scrolls, so a property one cell set MUST be reset when the next cell to land on this
    // node does not set it; comparing against these fields is what makes both the reset and
    // the no-op case free. '' / 0 mean "nothing written inline".
    el.__ff = '';   // font-family      (style.ff)
    el.__fs = 0;    // font-size in px  (style.fs)
    el.__va = '';   // align-content    (style.va)
    el.__ws = 'pre'; // white-space     (style.wrap)
    el.__rot = 0;   // 0 | 'v' | degrees (style.rot)
    el.__bd = '';   // border insets    (style.bd)
    el.__bdm = false; // whether __shA/__shB were built for a merged rectangle
    el.__shA = '';  // composed box-shadow, unselected
    el.__shB = '';  // composed box-shadow, selected
    el.__shCur = ''; // which of the two is currently written inline
    el.__ex = 0;    // extra width, in px, borrowed from empty neighbours (style.wrap)
    // Text lives in its own span so that rotation can be applied to the TEXT rather than
    // to the cell box. Rotating the cell would tilt its opaque background and its
    // grid-line/border inset shadows along with it, painting diagonally over the rows
    // above and below. While no rotation is set the span carries no styles at all, so
    // rendering is identical to writing text straight into the cell.
    const txt = document.createElement('span');
    // SPEC 23.4. The span holds EXACTLY ONE child: this text node for an ordinary cell, or
    // the <a> for a linked one. Tracking which is mounted on the node (__link) is what
    // stops a recycled node from carrying a previous cell's anchor — the paint pass
    // recomputes the link for the A1 key that just landed here and swaps the two back.
    const plain = document.createTextNode('');
    txt.appendChild(plain);
    el.appendChild(txt);
    el.__txt = txt;
    el.__plain = plain;
    el.__a = null;   // the <a>, built on first use and then reused (may be detached)
    el.__link = '';  // href currently mounted; '' means the plain text node is the child
    // SPEC 24.1 / 24.3 — the filter glyph and the comment triangle. Both are extra child
    // nodes, so like __link they are tracked on the node: a recycled node MUST drop the
    // previous cell's glyph, and comparing against these fields is what makes both the
    // reset and the (overwhelmingly common) nothing-to-do case free.
    el.__flt = null;   // the <button>, built on first use (may be detached)
    el.__fltCol = -1;  // column the button currently belongs to
    el.__cmtEl = null; // the triangle, built on first use (may be detached)
    el.__cmt = '';     // '' | 'open' | 'done'
    return el;
  }

  /**
   * The layer + origin one cell would be rendered into, mirroring the four bands below.
   * `vi` is the row's DISPLAY position; the band a row belongs to follows the view, so a
   * frozen band keeps holding the top of the view after a sort (SPEC 24.1).
   */
  _bandFor(r, c, vi) {
    const fw = this._fw;
    const fh = this._fh;
    const v = vi === undefined ? this._viewOf(r) : vi;
    const y = v < 0 ? HIDDEN_POS : this._ry[v];
    if (v >= 0 && v < this.frozenRows && c < this.frozenCols) {
      return { layer: this._cornerPane, x: this._cx[c], y };
    }
    if (v >= 0 && v < this.frozenRows) return { layer: this._topInner, x: this._cx[c] - fw, y };
    if (c < this.frozenCols) return { layer: this._leftInner, x: this._cx[c], y: y - fh };
    return { layer: this._cellsLayer, x: this._cx[c] - fw, y: y - fh };
  }

  /** Windowed cell rendering: recycle nodes, only repaint what changed. */
  _renderCells(force) {
    // The host may have swapped in a new merge list without a full render (an incoming
    // `meta` frame does exactly that). One reference test per frame catches it.
    let mergeChanged = false;
    if (this.sheet && this.sheet.merges !== this._mergeSrc) {
      this._buildMergeIndex();
      mergeChanged = true;
    }
    // The same one-reference-test trick for the two batch-C maps the renderer reads
    // (SPEC 24.1 / 24.3). A replaced filter changes every y offset, so it needs the whole
    // layout back — `_layout` rebuilds the row view, `_ry`, and the merge index with it.
    if (this.sheet && this.sheet.filter !== this._filterSrc) {
      this._layout();
      this._applyGeometry();
      mergeChanged = true;
    }
    if (this.sheet && this.sheet.comments !== this._commentSrc) {
      this._buildCommentIndex();
      mergeChanged = true;
    }
    // A replaced chart list touches no cell, so it does not force a repaint — it just
    // syncs the layer (SPEC 24.2).
    if (this.sheet && this.sheet.charts !== this._chartSrc) this._renderCharts();
    const repaintAll = force || mergeChanged;
    const merged = this._hasMerges;
    const w = this._window();
    const fr = this.frozenRows;
    const fc = this.frozenCols;
    const fw = this._fw;
    const fh = this._fh;
    const need = new Map();

    const add = (r, c, layer, x, y) => {
      const key = cellToA1(r, c);
      if (merged) {
        // A covered cell renders nothing at all — not an empty node (SPEC 21.4). Its
        // rectangle is drawn once, from the anchor pass below.
        if (this._mergeCoverAt(r, c, key)) return;
      }
      need.set(key, { r, c, layer, x, y, m: null });
    };

    // `vi` walks DISPLAY positions and `_rowOf` turns each into the row it paints
    // (SPEC 24.1). With no filter `_rowOf(vi) === vi` and these are the loops that were
    // here before, over the same numbers, with the same y offsets.
    for (let vi = w.r0; vi <= w.r1; vi++) {
      const r = this._rowOf(vi);
      const y = this._ry[vi] - fh;
      for (let c = w.c0; c <= w.c1; c++) {
        add(r, c, this._cellsLayer, this._cx[c] - fw, y);
      }
    }
    if (fr > 0) {
      for (let vi = 0; vi < fr; vi++) {
        const r = this._rowOf(vi);
        const y = this._ry[vi];
        for (let c = w.c0; c <= w.c1; c++) add(r, c, this._topInner, this._cx[c] - fw, y);
      }
    }
    if (fc > 0) {
      for (let vi = w.r0; vi <= w.r1; vi++) {
        const r = this._rowOf(vi);
        const y = this._ry[vi] - fh;
        for (let c = 0; c < fc; c++) add(r, c, this._leftInner, this._cx[c], y);
      }
    }
    if (fr > 0 && fc > 0) {
      for (let vi = 0; vi < fr; vi++) {
        const r = this._rowOf(vi);
        const y = this._ry[vi];
        for (let c = 0; c < fc; c++) add(r, c, this._cornerPane, this._cx[c], y);
      }
    }
    if (merged) {
      // One pass over the merge list (never per cell): a rectangle whose anchor has been
      // scrolled off the top or the left still has to be drawn while any part of it is
      // inside the window, so the anchor node is added from the rectangle, not from the
      // window loops. The list is short and hard-capped at MAX_MERGES.
      for (const m of this._mergeRects) {
        // The window is in display positions, so the rectangle is tested by its own
        // display span; an anchor the filter hides (vr1 < 0) is not drawn at all.
        if (m.vr1 < 0) continue;
        if (!bandHit(m.vr1, Math.max(m.vr1, m.vr2), w.r0, w.r1, fr)) continue;
        if (!bandHit(m.c1, m.c2, w.c0, w.c1, fc)) continue;
        const band = this._bandFor(m.r1, m.c1, m.vr1);
        need.set(cellToA1(m.r1, m.c1), {
          r: m.r1,
          c: m.c1,
          layer: band.layer,
          x: band.x,
          y: band.y,
          m,
        });
      }
    }

    for (const [key, node] of this._cells) {
      if (!need.has(key)) {
        node.remove();
        this._cells.delete(key);
        if (this._pool.length < 400) this._pool.push(node);
      }
    }

    for (const [key, info] of need) {
      let node = this._cells.get(key);
      let fresh = false;
      if (!node) {
        node = this._pool.pop() || this._makeCell();
        this._cells.set(key, node);
        fresh = true;
      }
      if (node.parentNode !== info.layer) info.layer.appendChild(node);
      const st = node.style;
      if (node.__x !== info.x) {
        st.left = info.x + 'px';
        node.__x = info.x;
      }
      if (node.__y !== info.y) {
        st.top = info.y + 'px';
        node.__y = info.y;
      }
      // A merged rectangle is one node sized to the union of its cells.
      const cw = info.m ? info.m.w : this._colW(info.c);
      const ch = info.m ? info.m.h : this._rowH(info.r);
      if (node.__w !== cw) {
        st.width = cw + 'px';
        node.__w = cw;
        node.__ex = 0;   // the spill below is measured from this base; re-apply it
      }
      if (node.__h !== ch) {
        st.height = ch + 'px';
        node.__h = ch;
      }
      node.__row = info.r;
      node.__col = info.c;
      if (repaintAll || fresh || node.__key !== key) {
        node.__key = key;
        this._paintCell(node, key);
      }
    }
  }

  /**
   * The sanitised hyperlink stored on a cell, or '' (SPEC 23.4).
   *
   * The link lives on the DOCUMENT cell record, not in the engine — the engine stores
   * `input` and `style` and nothing else — so it is read straight from `sheet.cells`.
   *
   * It is re-sanitised here even though `sanitizeDoc` already ran on the way in, for the
   * same reason `borderShadow` re-validates its colours: a locally applied edit paints
   * before the server has echoed it, so the value the renderer sees has not necessarily
   * been through the wire. This is the only function that produces an href, which makes
   * "an unsafe scheme cannot be rendered" a property of one four-line function rather
   * than of every call site.
   */
  _cellLink(a1) {
    const cells = this.sheet ? this.sheet.cells : null;
    const rec = cells ? cells[a1] : null;
    if (!rec || !rec.link) return '';
    return sanitizeLink(rec.link) || '';
  }

  /**
   * Index `sheet.comments` (SPEC 24.3). One reference test per frame catches a replaced
   * map, exactly as the merge index does; a sheet with no thread sets `_hasComments`
   * false and every paint then skips the mark with a single boolean.
   */
  _buildCommentIndex() {
    const src = this.sheet ? this.sheet.comments : null;
    this._commentSrc = src;
    const usable = src && typeof src === 'object' ? src : null;
    this._comments = usable;
    this._hasComments = !!(usable && Object.keys(usable).length);
  }

  /** The thread on a cell, or null. */
  _commentAt(a1) {
    if (!this._hasComments) return null;
    const t = this._comments[a1];
    return t && typeof t === 'object' ? t : null;
  }

  /**
   * Mount / un-mount the filter glyph on a cell (SPEC 24.1).
   *
   * The button is a real child of the cell node, and cell nodes are RECYCLED as the
   * viewport scrolls — so the un-mount branch matters as much as the mount one, or a
   * header cell's glyph would ride a recycled node onto an ordinary cell.
   */
  _paintFilterBtn(node, row, col) {
    const rect = this._filterRect;
    const on = !!rect && row === rect.r1 && col >= rect.c1 && col <= rect.c2;
    if (!on) {
      if (node.__flt) {
        node.__flt.remove();
        node.__fltCol = -1;
      }
      return;
    }
    let btn = node.__flt;
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sz-filter-btn';
      btn.textContent = FILTER_GLYPH;
      btn.setAttribute('aria-label', '필터');
      btn.tabIndex = -1;
      css(btn, {
        position: 'absolute',
        right: '0px',
        top: '0px',
        height: '100%',
        boxSizing: 'border-box',
        padding: '0',
        lineHeight: '1',
        cursor: 'pointer',
        pointerEvents: 'auto',
      });
      node.__flt = btn;
    }
    btn.style.width = this._z(FILTER_BTN_W) + 'px';
    if (node.__fltCol !== col) {
      node.__fltCol = col;
      // The A1 key is what the mousedown handler reads back, so the button carries its
      // own coordinates rather than depending on where the node happens to sit later.
      btn.__col = col;
      btn.__row = row;
    }
    const rel = col - rect.c1;
    const filter = this.sheet.filter;
    const hidden = filter && filter.hidden ? filter.hidden[String(rel)] : null;
    const sorted = !!(filter && filter.sort && filter.sort.col === rel);
    const active = sorted || (Array.isArray(hidden) && hidden.length > 0);
    if (btn.classList.contains('sz-filter-btn-on') !== active) {
      btn.classList.toggle('sz-filter-btn-on', active);
    }
    if (btn.parentNode !== node) node.appendChild(btn);
  }

  /**
   * Mount / un-mount the comment triangle on a cell (SPEC 24.3). Same recycling rule as
   * the filter glyph: a node that stops being a commented cell has to lose its mark.
   */
  _paintCommentMark(node, a1) {
    const thread = this._commentAt(a1);
    const state = thread ? (thread.resolved ? 'done' : 'open') : '';
    if (node.__cmt === state) return;
    node.__cmt = state;
    if (!state) {
      if (node.__cmtEl) node.__cmtEl.remove();
      return;
    }
    let mark = node.__cmtEl;
    if (!mark) {
      mark = div('sz-cell-comment');
      // Geometry inline as everywhere else; the colour comes from a custom property so
      // the stylesheet owns the look, with a fallback so the mark is never invisible.
      css(mark, {
        position: 'absolute',
        right: '0px',
        top: '0px',
        background: COMMENT_MARK_FILL,
        clipPath: 'polygon(100% 0, 0 0, 100% 100%)',
        pointerEvents: 'auto',
        cursor: 'pointer',
      });
      mark.setAttribute('aria-hidden', 'true');
      node.__cmtEl = mark;
    }
    const size = this._z(COMMENT_MARK) + 'px';
    mark.style.width = size;
    mark.style.height = size;
    mark.classList.toggle('sz-cell-comment-resolved', state === 'done');
    if (mark.parentNode !== node) node.appendChild(mark);
  }

  /**
   * Report a click on a header cell's filter glyph (SPEC 24.1). The grid opens nothing
   * itself: the panel is the host's, because it needs the document, the socket and the
   * history stack to apply a sort or a hidden-value list.
   */
  _openFilterMenu(btn) {
    const rect = this._filterRect;
    const col = btn.__col;
    if (!rect || typeof col !== 'number') return;
    const filter = this.sheet ? this.sheet.filter : null;
    const box = boxOf(btn);
    // Both the absolute column (what the grid speaks) and the column index INSIDE the
    // filter range (what filter.hidden / filter.sort.col are keyed by) travel with the
    // rectangle, so the host never has to rediscover the range's origin.
    box.col = col;
    box.relCol = col - rect.c1;
    box.range = filter && typeof filter.range === 'string' ? filter.range : '';
    box.a1 = cellToA1(btn.__row, col);
    try {
      this.onFilterMenu(col, box);
    } catch (e) {
      console.error('Grid onFilterMenu failed', e);
    }
  }

  /** Report a click on a cell's comment triangle (SPEC 24.3). */
  _openComment(cellNode, mark) {
    const a1 = cellNode.dataset ? cellNode.dataset.a1 : '';
    if (!a1) return;
    try {
      this.onCommentOpen(a1, boxOf(mark));
    } catch (e) {
      console.error('Grid onCommentOpen failed', e);
    }
  }

  /** Write one cell's text and style-driven inline properties. */
  _paintCell(node, a1) {
    const eng = this.engine;
    let value = null;
    let style = null;
    try {
      value = eng.getValue(a1);
      style = eng.getStyle ? eng.getStyle(a1) : null;
    } catch {
      value = null;
    }
    style = style || {};
    let text = '';
    let align = 'left';
    try {
      const t = formatValue(value, style);
      text = t == null ? '' : String(t);
      align = alignFor(value, style) || 'left';
    } catch {
      text = value == null ? '' : String(value);
    }
    node.className = 'sz-cell';
    // Cell nodes are recycled as the viewport scrolls, so the A1 key lives on the node
    // rather than being derivable from its position. It makes the grid inspectable in
    // devtools and lets the browser test address a cell directly.
    node.dataset.a1 = a1;
    // A merged rectangle advertises its range; nodes are recycled, so a node that stops
    // being an anchor has to lose the attribute again.
    const m = this._hasMerges ? this._mergeAnchors.get(a1) : null;
    if (m) {
      if (node.__merge !== m.key) {
        node.__merge = m.key;
        node.dataset.merge = m.key;
      }
    } else if (node.__merge) {
      node.__merge = null;
      delete node.dataset.merge;
    }
    // SPEC 24.1 / 24.3 — the two affordances that hang off a cell. Both are no-ops (one
    // property test each) on a sheet with no filter and no comment, and both un-mount
    // themselves so a recycled node never carries a previous cell's glyph.
    if (this._filterRect) this._paintFilterBtn(node, node.__row, node.__col);
    else if (node.__flt) this._paintFilterBtn(node, -1, -1);
    this._paintCommentMark(node, a1);
    /* --- SPEC section 23.4: 링크 --------------------------------------------------
       A linked cell renders its text inside an <a target="_blank" rel="noopener
       noreferrer" class="sz-cell-link">; every other cell renders it into the plain text
       node the span was built with. The href comes from _cellLink, which is the ONLY
       producer of one and returns nothing but a sanitizeLink() result, so an
       attacker-supplied `javascript:` or `data:` cell can never reach the DOM as a
       target. Text is written with nodeValue — no markup is ever built from a value.

       Nodes are recycled as the viewport scrolls, so __link is compared on every paint:
       a node that carried a link and lands on an unlinked cell puts its plain text node
       back, and one that lands on a differently-linked cell gets the new href. */
    const link = this._cellLink(a1);
    if (node.__link !== link) {
      node.__link = link;
      const span = node.__txt;
      if (link) {
        const a = node.__a || (node.__a = makeLinkAnchor());
        a.setAttribute('href', link);
        if (node.__plain.parentNode === span) span.removeChild(node.__plain);
        if (a.parentNode !== span) span.appendChild(a);
      } else {
        if (node.__a && node.__a.parentNode === span) span.removeChild(node.__a);
        if (node.__plain.parentNode !== span) span.appendChild(node.__plain);
      }
    }
    // Written into a text node, not with node.textContent: that would delete the span.
    const label = link ? node.__a.__label : node.__plain;
    if (label.nodeValue !== text) label.nodeValue = text;
    const s = node.style;
    s.textAlign = align;
    s.fontWeight = style.b ? '700' : '';
    s.fontStyle = style.i ? 'italic' : '';
    let deco = '';
    if (style.u) deco = 'underline';
    if (style.s) deco = deco ? deco + ' line-through' : 'line-through';
    s.textDecoration = deco;
    s.backgroundColor = style.bg || '';
    s.color = style.fg || '';

    /* --- SPEC section 22.5: ff / fs / va / wrap / rot / bd ----------------------------
       Every property below is written ONLY when its value actually changes, and the
       tracking field seeded in _makeCell is what turns a RECYCLED node back to plain when
       the cell that lands on it next drops the key. That reset is the whole risk in this
       feature: a node that once rendered 48px rotated text is handed straight to an
       ordinary cell as the viewport scrolls.

       A cell carrying none of the six keys takes every branch's "no value" case, where the
       tracked value already matches — so not one declaration is added, removed or
       reordered and the node's inline style string stays exactly what it was before this
       section existed. Merged rectangles go through this same function (they are one
       .sz-cell node at the anchor), so they honour all six with no extra path. */

    const ff = typeof style.ff === 'string' && style.ff ? style.ff : '';
    if (node.__ff !== ff) {
      node.__ff = ff;
      // fontStackFor is the ONLY producer of a font string: the id is looked up in a
      // closed set, so an invented `ff` can never inject CSS here.
      s.fontFamily = ff ? fontStackFor(ff) : '';
    }

    // An explicit `fs` is a DOCUMENT pixel size, so it goes through _z like every other
    // measurement (SPEC 23.2); a cell without one inherits --sz-fs, which the root already
    // scales. __fs tracks the unscaled value, which is safe because setZoom() drops every
    // cell node before repainting — no node ever survives a zoom change with stale
    // tracking. At a zoom of 1, _z is the identity and this writes exactly what it did.
    const fs = typeof style.fs === 'number' && style.fs > 0 ? Math.round(style.fs) : 0;
    if (node.__fs !== fs) {
      node.__fs = fs;
      s.fontSize = fs ? this._z(fs) + 'px' : '';
    }

    const va = valignCss(style.va);
    if (node.__va !== va) {
      node.__va = va;
      s.alignContent = va;
    }

    // wrap. Cells are `white-space:pre; overflow:hidden` inline (see _makeCell), so
    // clipping is the default and stays the default — untouched cells keep exactly the
    // appearance they had before this feature existed.
    //   'wrap'     reflow inside the cell
    //   'clip'     the default, spelled explicitly
    //   'overflow' borrow the width of the empty cells to the right, the way a long
    //              label runs past its column in a spreadsheet. It stops at the first
    //              neighbour that holds something, so it can never hide real data.
    const ws = style.wrap === 'wrap' ? 'pre-wrap' : 'pre';
    if (node.__ws !== ws) {
      node.__ws = ws;
      s.whiteSpace = ws;
    }
    const ex = this._spillWidth(node, style, text);
    if (node.__ex !== ex) {
      node.__ex = ex;
      s.width = (node.__w + ex) + 'px';
      // Spilled text has to paint over the empty neighbours, which carry their own
      // opaque background and are siblings in an arbitrary, recycling-driven DOM order.
      s.zIndex = ex ? '1' : '';
    }
    // A spilling cell's width depends on its NEIGHBOURS' contents, so an edit two columns
    // away can invalidate it. refreshCells() repaints only the keys it was handed, which
    // would leave the stale spill on screen; this set is how it knows to widen the repaint.
    if (ex) this._spilling.add(a1);
    else this._spilling.delete(a1);

    // rot. An integer tilts the cell; 'v' stacks it with a writing-mode instead. The two
    // are mutually exclusive, so each branch clears the other's properties.
    let rot = 0;
    if (style.rot === 'v') rot = 'v';
    else if (typeof style.rot === 'number' && Number.isFinite(style.rot)) {
      rot = clamp(Math.round(style.rot), -MAX_ROTATION, MAX_ROTATION);
    }
    if (node.__rot !== rot) {
      node.__rot = rot;
      const ts = node.__txt.style;
      if (rot === 'v') {
        ts.transform = '';
        ts.transformOrigin = '';
        ts.display = '';
        // vertical-rl reflows the text without transforming any box, so it is safe to put
        // on the cell itself. With the default `text-orientation: mixed` Hangul and CJK
        // glyphs stack upright (세로로 쌓기) while Latin runs sideways, as Sheets renders it.
        s.writingMode = 'vertical-rl';
      } else if (rot) {
        // A positive `rot` tilts text UPWARDS, which is a negative CSS angle. The transform
        // goes on the text span: a transform on the cell would rotate its background and
        // its inset border shadows too, smearing them across the neighbouring rows.
        // A transform has no effect on a non-replaced inline box, so the span becomes
        // inline-block for exactly as long as a rotation is set.
        s.writingMode = '';
        ts.display = 'inline-block';
        ts.transform = 'rotate(' + -rot + 'deg)';
        ts.transformOrigin = '50% 50%';
      } else {
        s.writingMode = '';
        ts.transform = '';
        ts.transformOrigin = '';
        ts.display = '';
      }
    }

    // bd. `node.className = 'sz-cell'` above dropped the selection classes, so the node is
    // unselected at this instant and takes __shA; _paintSelection swaps in __shB the moment
    // it decides the cell is inside the selection. Both variants are composed here, once
    // per paint, so the per-frame selection pass never allocates.
    const bd = borderShadow(style.bd);
    const bdm = !!m;
    if (node.__bd !== bd || node.__bdm !== bdm) {
      node.__bd = bd;
      node.__bdm = bdm;
      if (bd) {
        // Borders first so they paint ON TOP of the grid lines they replace; the wash last
        // so the lines stay legible through it — the same order .sz-cell-selected uses.
        node.__shA = bd + ',' + CELL_LINES;
        // A merged rectangle paints its wash as a background-image instead (a 9999px
        // spread stops meeting in the middle on a box that big), and that background rule
        // still applies, so its selected shadow is its unselected one.
        node.__shB = bdm ? node.__shA : node.__shA + ',' + SEL_WASH;
      } else {
        node.__shA = '';
        node.__shB = '';
      }
    }
    if (node.__shCur !== node.__shA) {
      node.__shCur = node.__shA;
      s.boxShadow = node.__shA;
    }
  }

  _makeColHead() {
    const el = div('sz-colhead');
    css(el, { position: 'absolute', top: '0px', height: '100%', boxSizing: 'border-box' });
    const label = document.createTextNode('');
    el.appendChild(label);
    const grip = div('sz-colhead-grip');
    css(grip, {
      position: 'absolute',
      top: '0px',
      right: '0px',
      width: GRIP + 'px',
      height: '100%',
      cursor: 'col-resize',
    });
    el.appendChild(grip);
    el.__label = label;
    return el;
  }

  _makeRowHead() {
    const el = div('sz-rowhead');
    css(el, { position: 'absolute', left: '0px', width: '100%', boxSizing: 'border-box' });
    const label = document.createTextNode('');
    el.appendChild(label);
    const grip = div('sz-rowhead-grip');
    css(grip, {
      position: 'absolute',
      left: '0px',
      bottom: '0px',
      width: '100%',
      height: GRIP + 'px',
      cursor: 'row-resize',
    });
    el.appendChild(grip);
    el.__label = label;
    return el;
  }

  _renderHeaders() {
    const w = this._window();
    const fc = this.frozenCols;
    const fr = this.frozenRows;
    const needCols = new Map();
    const needRows = new Map();

    for (let c = 0; c < fc; c++) needCols.set(c, this._colFrozen);
    for (let c = w.c0; c <= w.c1; c++) needCols.set(c, this._colInner);
    // Row header nodes are keyed by DISPLAY position, so a node keeps its slot on screen
    // while the row it labels changes with the sort (SPEC 24.1). The LABEL stays the
    // absolute row number — a filter view never renumbers rows.
    for (let vi = 0; vi < fr; vi++) needRows.set(vi, this._rowFrozen);
    for (let vi = w.r0; vi <= w.r1; vi++) needRows.set(vi, this._rowInner);

    for (const [c, node] of this._colHeads) {
      if (!needCols.has(c)) {
        node.remove();
        this._colHeads.delete(c);
      }
    }
    for (const [c, parent] of needCols) {
      let node = this._colHeads.get(c);
      if (!node) {
        node = this._makeColHead();
        this._colHeads.set(c, node);
      }
      if (node.parentNode !== parent) parent.appendChild(node);
      node.__col = c;
      node.style.left = this._cx[c] + 'px';
      node.style.width = this._colW(c) + 'px';
      const text = colToLetter(c);
      if (node.__label.nodeValue !== text) node.__label.nodeValue = text;
    }

    for (const [vi, node] of this._rowHeads) {
      if (!needRows.has(vi)) {
        node.remove();
        this._rowHeads.delete(vi);
      }
    }
    for (const [vi, parent] of needRows) {
      let node = this._rowHeads.get(vi);
      if (!node) {
        node = this._makeRowHead();
        this._rowHeads.set(vi, node);
      }
      if (node.parentNode !== parent) parent.appendChild(node);
      const r = this._rowOf(vi);
      node.__row = r; // the ROW, which is what every consumer of a header node wants
      node.__vi = vi;
      node.style.top = this._ry[vi] + 'px';
      node.style.height = this._rowH(r) + 'px';
      const text = String(r + 1);
      if (node.__label.nodeValue !== text) node.__label.nodeValue = text;
    }
  }

  /** Re-apply selection classes to every live cell and header node. */
  _paintSelection() {
    const r = this._selRange();
    const fp = this._fillPreview;
    const pr = this._pointRange;
    const a = this._sel.active;
    for (const node of this._cells.values()) {
      const row = node.__row;
      const col = node.__col;
      const active = row === a.row && col === a.col;
      const sel = (inRange(r, row, col) && !active) || inRange(fp, row, col) || inRange(pr, row, col);
      if (node.classList.contains('sz-cell-active') !== active) {
        node.classList.toggle('sz-cell-active', active);
      }
      if (node.classList.contains('sz-cell-selected') !== sel) {
        node.classList.toggle('sz-cell-selected', sel);
      }
      // A bordered cell (SPEC 22.3) carries its shadow inline, and an inline box-shadow
      // outranks .sz-cell-selected — so for those cells the selection wash has to be
      // switched in here instead of being left to the stylesheet. Both strings were
      // composed in _paintCell, so this costs one comparison per cell and allocates
      // nothing; a cell with no borders (__bd === '') skips it entirely.
      if (node.__bd) {
        const want = sel ? node.__shB : node.__shA;
        if (node.__shCur !== want) {
          node.__shCur = want;
          node.style.boxShadow = want;
        }
      }
    }
    // Mirror the highlight to aria-selected as well: the class drives the paint,
    // the attribute is what a screen reader announces.
    for (const [c, node] of this._colHeads) {
      const on = c >= r.s.col && c <= r.e.col;
      node.classList.toggle('sz-colhead-active', on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    // Keyed by display position, so the row a header node labels is read off the node
    // (SPEC 24.1); with no filter the two are the same number.
    for (const node of this._rowHeads.values()) {
      const row = node.__row;
      const on = row >= r.s.row && row <= r.e.row;
      node.classList.toggle('sz-rowhead-active', on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  /**
   * Extra width, in pixels, that a `wrap: 'overflow'` cell may borrow from the empty
   * cells to its right. Returns 0 for every other cell, so the common path costs one
   * property comparison and nothing else.
   *
   * Only empty neighbours are consumed, and the scan stops at the first one that holds
   * anything, so spilled text can never cover real data. Merged rectangles never spill:
   * they already span their own width.
   */
  _spillWidth(node, style, text) {
    if (style.wrap !== 'overflow' || !text || node.__merge) return 0;
    const row = node.__row;
    const col = node.__col;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return 0;
    let extra = 0;
    const last = Math.min(this.cols - 1, col + MAX_SPILL_COLS);
    for (let c = col + 1; c <= last; c++) {
      const key = cellToA1(row, c);
      if (this._hasMerges && this._mergeCover.has(key)) break;
      let v = null;
      try { v = this.engine.getValue(key); } catch { v = null; }
      if (v !== null && v !== undefined && v !== '') break;
      extra += this._colW(c);
    }
    return extra;
  }

  /** Repaint only the given A1 keys (fast path used after an edit). */
  refreshCells(keys) {
    if (!keys || this._destroyed) return;
    const list = keys instanceof Set || Array.isArray(keys) ? keys : Object.keys(keys);
    // SPEC 24.2 — a chart redraws only when a cell inside ITS OWN range changed, which is
    // exactly what this key set says. No chart on the sheet: one Map.size test.
    if (this._chartEls.size) this._chartsAfterEdit(list);
    // SPEC 24.1 — a write inside the filter range can change which rows survive and in
    // what order, so the mapping (and every y offset derived from it) has to be rebuilt.
    // That is a full render; it happens only when a filter exists AND the edit landed
    // inside its range, so an ordinary sheet never reaches it.
    if (this._filterRect && this._touchesFilter(list)) {
      this._rowViewDirty = true;
      this.render();
      return;
    }
    // Any cell that is spilling has a width derived from its neighbours' contents, so an
    // edit anywhere can invalidate a cell that is not in `keys`. Spilling is rare and the
    // window holds only a few hundred nodes, so repainting all of them is both simpler
    // and cheaper than working out which spills the edit could have reached.
    if (this._spilling.size) {
      for (const [key, node] of this._cells) this._paintCell(node, key);
      this._paintSelection();
      return;
    }
    let touched = false;
    for (const key of list) {
      const node = this._cells.get(key);
      if (node) {
        this._paintCell(node, key);
        touched = true;
      }
    }
    if (touched) this._paintSelection();
  }

  /** Schedule a windowed re-render on the next frame (scroll / resize path). */
  /**
   * Did the viewport move underneath the paint we just did? A layout change can shift
   * the offset without a scroll event, so this is the only way to notice. Comparing two
   * integers per frame is cheap, and it converges: the re-render paints from the offset
   * the element actually has, after which the two agree.
   */
  _rescanScroll() {
    if (this._destroyed || !this._vp) return;
    if (this._vp.scrollTop !== this._paintedTop || this._vp.scrollLeft !== this._paintedLeft) {
      this._invalidate();
    }
  }

  _invalidate() {
    if (this._raf || this._destroyed) return;
    // onNextFrame, not a bare rAF: a hidden or occluded tab never gets a frame, which
    // would leave this._raf latched and stop every future repaint.
    this._raf = onNextFrame(() => {
      this._raf = 0;
      if (this._destroyed) return;
      this._syncScroll();
      this._renderCells(false);
      this._renderHeaders(false);
      this._paintSelection();
      this._positionEditor();
      this._positionFill();
      this._renderPeers();
      // Last, so a growth-driven render() replaces work that is already finished rather
      // than work that is half done (SPEC 25.3).
      this._maybeGrow();
      this._rescanScroll();
    });
  }

  /* ------------------------------------------------------------ selection */

  /**
   * The effective selection: the stored anchor/focus pair normalized, then grown so it
   * contains every merge it touches whole (SPEC 21.4). `_sel.range` itself keeps the RAW
   * anchor/focus pair, because that is what shift-extension direction depends on.
   *
   * The result is memoized on the range object's identity plus the merge-index
   * generation — _paintSelection asks for it on every repaint and expandOverMerges
   * reparses the merge list on each call. Treat the returned rect as read-only.
   */
  _selRange() {
    const raw = this._sel.range;
    const cached = this._selCache;
    if (cached && cached.raw === raw && cached.gen === this._mergeGen) return cached.out;
    const out = this._expandOver(normRange(raw));
    this._selCache = { raw, gen: this._mergeGen, out };
    return out;
  }

  /** -> { active:'B2', range:{s:{row,col}, e:{row,col}} } */
  getSelection() {
    const r = this._selRange();
    const a = this._anchorCell(this._sel.active);
    return {
      active: cellToA1(a.row, a.col),
      range: {
        s: { row: r.s.row, col: r.s.col },
        e: { row: r.e.row, col: r.e.col },
      },
    };
  }

  setSelection(sel) {
    if (!sel) return;
    let active = sel.active;
    if (typeof active === 'string') {
      try {
        const c = a1ToCell(active);
        active = { row: c.row, col: c.col };
      } catch {
        active = null;
      }
    }
    let range = sel.range;
    if (!range && active) range = { s: active, e: active };
    if (!range) return;
    if (!active) active = range.s;
    this._sel.active = this._anchorCell(this._clampCell(active));
    this._sel.range = { s: this._clampCell(range.s), e: this._clampCell(range.e) };
    this._tabAnchorCol = null;
    this._scrollIntoView(this._sel.active.row, this._sel.active.col);
    this._afterSelChange(true);
  }

  focusCell(a1) {
    let c;
    try {
      c = a1ToCell(a1);
    } catch {
      return;
    }
    this._selectCell(c.row, c.col);
    this._editor.focus({ preventScroll: true });
  }

  _selectCell(row, col) {
    // Clicking (or arrowing onto) any cell of a merged rectangle selects the rectangle,
    // and the active cell is its anchor — SPEC 21.4. _selRange() grows the stored 1x1
    // range back over the merge, so nothing else here has to know.
    const c = this._anchorCell(this._clampCell({ row, col }));
    this._sel.active = c;
    this._sel.range = { s: { ...c }, e: { ...c } };
    this._scrollIntoView(c.row, c.col);
    this._afterSelChange(true);
  }

  /** Move the focus end of the selection; the anchor and active cell stay put. */
  /**
   * Move the selection's focus end to (row,col).
   *
   * `emit` decides whether the host is told. A mouse drag leaves it false and emits ONCE
   * from mouseup instead, so a drag across a sheet costs one cursor frame rather than one
   * per mousemove. A KEYBOARD extension has no such end event, so it must pass true —
   * otherwise the name box, the 합계/평균/개수 readout and the merge button all keep
   * showing the previous, smaller selection until the next click.
   */
  _extendTo(row, col, emit = false) {
    const c = this._clampCell({ row, col });
    if (this._sel.range.e.row === c.row && this._sel.range.e.col === c.col) return;
    this._sel.range = { s: this._sel.range.s, e: c };
    this._scrollIntoView(c.row, c.col);
    this._afterSelChange(emit);
  }

  _selectRange(r0, c0, r1, c1, activeRow, activeCol) {
    this._sel.range = { s: this._clampCell({ row: r0, col: c0 }), e: this._clampCell({ row: r1, col: c1 }) };
    this._sel.active = this._anchorCell(
      this._clampCell({
        row: activeRow == null ? r0 : activeRow,
        col: activeCol == null ? c0 : activeCol,
      }),
    );
    this._afterSelChange(true);
  }

  _selectCols(c0, c1) {
    this._selectRange(0, c0, this.rows - 1, c1, 0, c0);
  }

  _selectRows(r0, r1) {
    this._selectRange(r0, 0, r1, this.cols - 1, r0, 0);
  }

  _selectAll() {
    this._selectRange(0, 0, this.rows - 1, this.cols - 1, this._sel.active.row, this._sel.active.col);
  }

  _afterSelChange(emit) {
    this._paintSelection();
    this._positionEditor();
    this._positionFill();
    if (emit !== false) this._emitCursor();
    // Arrowing onto the last row must extend the sheet exactly as scrolling to it does,
    // or the keyboard would still hit a wall the mouse no longer does (SPEC 25.3).
    this._maybeGrow();
  }

  /**
   * @param {boolean} [settled=true] false while a gesture is still in progress — the
   *   anchor emitted at mousedown, and each step of a drag. The host needs the
   *   distinction for anything that ACTS on a selection rather than merely displaying
   *   it: the format painter must fire once, on the range the user finished drawing,
   *   not on the 1x1 anchor the moment the button went down.
   */
  _emitCursor(settled) {
    try {
      // A selection is settled once the pointer gesture that produced it is over. Any
      // emission while `_drag` is live is the anchor or an intermediate step of a drag.
      this.onCursor(this.getSelection(), settled !== false && !this._drag);
    } catch (e) {
      console.error('Grid onCursor failed', e);
    }
  }

  _scrollIntoView(row, col) {
    const vp = this._vp;
    if (col >= this.frozenCols) {
      const x0 = this._cx[col] - this._fw;
      const x1 = this._cx[col + 1] - this._fw;
      if (x0 < vp.scrollLeft) vp.scrollLeft = x0;
      else if (x1 > vp.scrollLeft + vp.clientWidth) vp.scrollLeft = x1 - vp.clientWidth;
    }
    // Vertical scrolling is measured in DISPLAY positions (SPEC 24.1); a row the filter
    // hides has no position to scroll to, so the view simply stays where it is.
    const vi = this._viewOf(row);
    if (vi >= this.frozenRows) {
      const y0 = this._ry[vi] - this._fh;
      const y1 = this._ry[vi + 1] - this._fh;
      if (y0 < vp.scrollTop) vp.scrollTop = y0;
      else if (y1 > vp.scrollTop + vp.clientHeight) vp.scrollTop = y1 - vp.clientHeight;
    }
  }

  /* -------------------------------------------------------------- content */

  _input(row, col) {
    try {
      return this.engine.getInput(cellToA1(row, col)) || '';
    } catch {
      return '';
    }
  }

  _hasData(row, col) {
    return this._input(row, col) !== '';
  }

  /**
   * Excel-style Ctrl+Arrow: jump to the next edge of a data run.
   *
   * The row axis walks in DISPLAY order (SPEC 24.1), so a jump skips the rows the filter
   * hides instead of stopping on them; `_advRow` answers -1 when there is no next row,
   * which is the same "past the edge" condition the old `ok()` test expressed. With no
   * filter `_advRow(r, dr)` is `r + dr` bounded by the sheet, so this is the previous
   * algorithm over the previous numbers.
   */
  _dataEdge(row, col, dr, dc) {
    const maxC = this.cols - 1;
    // one step from (r,c), or null when that leaves the sheet / the view
    const step = (r, c) => {
      const nr = this._advRow(r, dr);
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nc > maxC) return null;
      return { row: nr, col: nc };
    };
    let r = row;
    let c = col;
    let next = step(r, c);
    if (!next) return { row: r, col: c };
    if (this._hasData(r, c) && this._hasData(next.row, next.col)) {
      while (next && this._hasData(next.row, next.col)) {
        r = next.row;
        c = next.col;
        next = step(r, c);
      }
      return { row: r, col: c };
    }
    while (next && !this._hasData(next.row, next.col)) {
      const after = step(next.row, next.col);
      if (!after) {
        next = null;
        break;
      }
      next = after;
    }
    if (next) return { row: next.row, col: next.col };
    // Nothing further along this run: land on the last cell the view offers.
    return {
      row: dr > 0 ? this._rowOf(this._viewCount - 1) : dr < 0 ? this._rowOf(0) : r,
      col: dc > 0 ? maxC : dc < 0 ? 0 : c,
    };
  }

  /** A1 keys with content inside `range` (walks the sheet when the range is huge). */
  _nonEmptyKeysInRange(range) {
    const rows = range.e.row - range.s.row + 1;
    const cols = range.e.col - range.s.col + 1;
    const out = [];
    if (rows * cols <= SCAN_LIMIT) {
      for (let r = range.s.row; r <= range.e.row; r++) {
        for (let c = range.s.col; c <= range.e.col; c++) {
          const a1 = cellToA1(r, c);
          if (this.engine.getInput(a1) !== '') out.push(a1);
        }
      }
      return out;
    }
    let values = {};
    try {
      values = this.engine.getValues() || {};
    } catch {
      values = {};
    }
    for (const key of Object.keys(values)) {
      let c;
      try {
        c = a1ToCell(key);
      } catch {
        continue;
      }
      if (inRange(range, c.row, c.col)) out.push(key);
    }
    return out;
  }

  /** Mirror an input change into the plain sheet object. */
  _syncSheetCell(a1, input) {
    const cells = this.sheet.cells || (this.sheet.cells = {});
    const cur = cells[a1];
    if (input === null || input === '') {
      if (!cur) return;
      // A record that still carries presentation state survives an emptied input, so the
      // record is only dropped when nothing is left on it. `link` (SPEC 23.4) is kept for
      // the same reason `style` is: 내용 지우기 clears the CONTENTS, and the grid never
      // discards something the user did not ask it to — 링크 제거 is the way to drop a
      // link. This mirrors the server, which treats `link` like `input`: it is cleared
      // only by an explicit null of its own.
      if (cur.style || cur.link) delete cur.input;
      else delete cells[a1];
      return;
    }
    if (cur) cur.input = input;
    else cells[a1] = { input };
  }

  /**
   * Apply { A1: string|null } to the engine first, then notify the host, then
   * repaint exactly the keys whose value changed.
   */
  _applyInputs(map) {
    const keys = Object.keys(map);
    if (!keys.length) return null;
    let changed = null;
    try {
      changed = this.engine.setInputs(map);
    } catch (e) {
      console.error('Grid setInputs failed', e);
      return null;
    }
    const patch = {};
    for (const key of keys) {
      patch[key] = { input: map[key] };
      this._syncSheetCell(key, map[key]);
    }
    try {
      this.onEdit(patch);
    } catch (e) {
      console.error('Grid onEdit failed', e);
    }
    const repaint = new Set(keys);
    if (changed && typeof changed.forEach === 'function') changed.forEach((k) => repaint.add(k));
    this.refreshCells(repaint);
    return repaint;
  }

  /** Delete / Backspace / 내용 지우기. */
  _clearContents() {
    let keys = this._nonEmptyKeysInRange(this._selRange());
    if (!keys.length) return;
    // SPEC 24.1 — a filter hides rows, it does not select them. Clearing a selection that
    // spans a hidden row must not empty a cell the user cannot see; a selection is a
    // rectangle in ROW coordinates, so without this a Delete over a filtered table would
    // silently destroy the rows it was filtering out. Costs nothing when nothing is
    // hidden (`_viewRows` is null and the filter is skipped entirely).
    if (this._viewRows) {
      keys = keys.filter((key) => {
        try {
          return this._rowShown(a1ToCell(key).row);
        } catch {
          return true;
        }
      });
      if (!keys.length) return;
    }
    const map = {};
    for (const key of keys) map[key] = null;
    this._applyInputs(map);
  }

  /**
   * Bind the grid to another sheet: its engine and its geometry swap together.
   *
   * Everything that describes a POSITION inside the old sheet is dropped, because
   * none of it means anything in the new one — the selection, the scroll offset, an
   * open editor, the fill handle, a half-finished drag, the context menu and the
   * pointed-reference highlight. Leaving any of it behind is how a tab switch ends
   * up showing the previous sheet's selection, or worse, commits an edit into the
   * wrong sheet.
   *
   * @param {object} engine  the new sheet's SheetEngine (falsy keeps the current one)
   * @param {object} sheet   the new sheet object (falsy keeps the current one)
   */
  setSheet(engine, sheet) {
    if (this._destroyed) return;
    if (engine) this.engine = engine;
    if (sheet) this.sheet = sheet;

    // per-sheet view state ------------------------------------------------
    this._editing = null;
    this._pointRef = null;
    this._pointRange = null;
    this._fillPreview = null;
    this._drag = null;
    this._tabAnchorCol = null;
    this._lastMouse = null;
    this._stopAutoScroll();
    this._closeMenu();
    this._setEditorIdle();
    // the old sheet's merge geometry means nothing here; render() rebuilds it
    this._mergeSrc = null;
    this._hasMerges = false;
    this._mergeKeys = NO_KEYS;
    this._mergeRects = NO_RECTS;
    this._mergeCover = EMPTY_MAP;
    this._mergeAnchors = EMPTY_MAP;
    this._mergeBigKeys = NO_KEYS;
    this._mergeByKey = EMPTY_MAP;
    this._selCache = null;
    this._mergeGen++;
    // Batch-C state belongs to the sheet that is going away, exactly as the merge index
    // does: the filter view, the charts and the comment index are all rebuilt by the
    // render() below from the new sheet's own state.
    this._filterSrc = null;
    this._filterRect = null;
    this._rowViewDirty = true;
    this._identityRowView();
    this._clearCharts();
    this._chartSrc = null;
    this._commentSrc = null;
    this._comments = null;
    this._hasComments = false;
    this._sel = {
      active: { row: 0, col: 0 },
      range: { s: { row: 0, col: 0 }, e: { row: 0, col: 0 } },
    };
    if (this._vp) {
      this._vp.scrollLeft = 0;
      this._vp.scrollTop = 0;
    }

    // every rendered node belongs to the old sheet ------------------------
    this._dropNodes();
    for (const el of this._peerEls) el.remove();
    this._peerEls.length = 0;
    this._peers = [];

    this.render();
  }

  /* ------------------------------------------------------- view: zoom (23.2) */

  /** The current zoom factor. 1 is 100%. */
  getZoom() {
    return this._zoom;
  }

  /**
   * Set the view zoom (SPEC 23.2). `factor` is a multiplier, clamped to 0.5 .. 2.
   *
   * Zoom is a per-viewer VIEW preference: it multiplies what the grid draws and never
   * touches `sheet.colWidths`, `sheet.rowHeights` or anything else that reaches the
   * document or the wire. The host owns persisting it (localStorage `sz.zoom`).
   *
   * Two things happen here beyond storing the number:
   *
   *  - every rendered cell node is dropped. Each node caches the last value it was given
   *    for each paint property (font size, borders, spill width...), and those caches are
   *    keyed on UNSCALED values, so a surviving node would compare equal and keep the
   *    previous zoom's pixels. Throwing them away is both correct and cheap: a zoom
   *    change is a deliberate click, and the window holds a few hundred nodes.
   *  - the scroll offset is re-derived. It is measured in scaled pixels, so leaving it
   *    alone would teleport the viewer to a different part of the sheet. The top-left
   *    non-frozen cell is read before the relayout and scrolled back to afterwards, which
   *    keeps the same region of the sheet on screen at any factor.
   */
  setZoom(factor) {
    if (this._destroyed) return;
    const n = Number(factor);
    const z = clamp(Number.isFinite(n) && n > 0 ? n : 1, MIN_ZOOM, MAX_ZOOM);
    if (z === this._zoom) return;

    // Where we are looking now, in sheet coordinates rather than pixels.
    const anchorCol = this._colAt(this._fw + this._vp.scrollLeft);
    // The anchor is a DISPLAY position, not a row: the filter view may hide or reorder
    // rows, and `_ry` is indexed by display position (SPEC 24.1). Zoom does not change
    // the view, so the same slot is still the right one to scroll back to.
    const anchorRow = this._viewAt(this._fh + this._vp.scrollTop);

    this._zoom = z;
    this._applyZoomFont();
    this._dropNodes();
    this._layout();
    // _applyGeometry BEFORE the scroll assignment, not just inside the render() below:
    // the spacer is what gives the viewport its scrollable extent, so writing an offset
    // while the spacer still has the old (smaller) size would have the browser clamp it
    // and the restore would land short every time the user zoomed in.
    this._applyGeometry();
    this._vp.scrollLeft = Math.max(0, this._cx[Math.max(anchorCol, this.frozenCols)] - this._fw);
    this._vp.scrollTop = Math.max(
      0,
      this._ry[clamp(Math.max(anchorRow, this.frozenRows), 0, this._viewCount)] - this._fh,
    );

    this.render();
  }

  /**
   * Text size follows the zoom through the two typography custom properties, set on the
   * grid ROOT so that cells, headers, the corner and the in-cell editor all move together
   * from one write. At a zoom of 1 the properties are REMOVED rather than set to their
   * own default, so the cascade is left in exactly the state it has today.
   */
  _applyZoomFont() {
    const s = this.el.style;
    if (this._zoom === 1) {
      s.removeProperty('--sz-fs');
      s.removeProperty('--sz-fs-sm');
      return;
    }
    s.setProperty('--sz-fs', this._z(BASE_FS) + 'px');
    s.setProperty('--sz-fs-sm', this._z(BASE_FS_SM) + 'px');
  }

  /** Discard every rendered cell / header node, including the recycling pool. */
  _dropNodes() {
    this._cells.forEach((node) => node.remove());
    this._cells.clear();
    this._pool.length = 0;
    this._colHeads.forEach((node) => node.remove());
    this._colHeads.clear();
    this._rowHeads.forEach((node) => node.remove());
    this._rowHeads.clear();
    this._spilling.clear();
    // The off-screen measuring cell inherits the grid's font size, so it has to be rebuilt
    // rather than reused with a stale one.
    if (this._measure) {
      this._measure.remove();
      this._measure = null;
    }
  }

  /* ---------------------------------------------------- view: painter (23.1) */

  /**
   * Show or hide the format-painter cursor (SPEC 23.1). The grid holds NO painter state:
   * arming, stickiness, the copied style and applying it all live in main.js, which
   * simply drives this class so the pointer changes over the sheet.
   */
  setPainting(on) {
    const want = !!on;
    if (this._painting === want || !this.el) return;
    this._painting = want;
    this.el.classList.toggle('sz-painting', want);
  }

  /* --------------------------------------------------------------- editor */

  /**
   * The editor textarea is always in the DOM and keeps focus so that typing and
   * IME composition can start an edit. Idle = 1px and invisible.
   */
  _setEditorIdle() {
    const s = this._editor.style;
    s.opacity = '0';
    s.pointerEvents = 'none';
    s.width = '1px';
    s.height = '1px';
    s.zIndex = '';
    this._editor.readOnly = false;
    this._selfEdit = true;
    this._editor.value = '';
    this._selfEdit = false;
  }

  _setEditorOpen() {
    const s = this._editor.style;
    s.opacity = '';
    s.pointerEvents = 'auto';
    s.zIndex = '20';
  }

  /** Place the editor over its cell (or over the active cell while idle). */
  _positionEditor() {
    if (!this._vp) return;
    const ed = this._editing || this._sel.active;
    const row = ed.row;
    const col = ed.col;
    const ow = this._overlay.clientWidth;
    const oh = this._overlay.clientHeight;
    const x = this._ox(col);
    const y = this._oy(row);
    const s = this._editor.style;
    if (!this._editing) {
      // keep the invisible caret box inside the clipped overlay so that focus()
      // can never scroll it into view
      s.left = clamp(x, 0, Math.max(0, ow - 1)) + 'px';
      s.top = clamp(y, 0, Math.max(0, oh - 1)) + 'px';
      return;
    }
    // Editing a merged rectangle happens at its anchor, so the editor covers the whole
    // rectangle rather than just the anchor's own column and row (SPEC 21.4).
    const m = this._hasMerges ? this._mergeAnchors.get(cellToA1(row, col)) : null;
    const cw = m ? m.w : this._colW(col);
    const ch = m ? m.h : this._rowH(row);
    s.left = x + 'px';
    s.top = y + 'px';
    s.width = cw + 'px';
    s.height = ch + 'px';
    const maxW = Math.max(cw, ow - x - 2);
    const maxH = Math.max(ch, oh - y - 2);
    const needW = this._editor.scrollWidth + 4;
    if (needW > cw) s.width = Math.min(needW, maxW) + 'px';
    const needH = this._editor.scrollHeight;
    if (needH > ch) s.height = Math.min(needH, maxH) + 'px';
  }

  beginEdit(initialText) {
    // Typing / F2 / double-click over a merged rectangle always edits the anchor.
    const { row, col } = this._anchorCell(this._sel.active);
    // Refuse to open an editor on a row the filter hides. _positionEditor would place it
    // at HIDDEN_POS — far off-screen — and the keystroke would commit into a row the user
    // cannot see. Re-home the selection to the nearest painted row instead.
    if (this._viewRows && !this._rowShown(row)) {
      const t = this._stepRow(row, 1);
      if (this._rowShown(t)) this._selectCell(t, col);
      this.onNotice('숨겨진 행은 편집할 수 없습니다.', 'error');
      return;
    }
    const a1 = cellToA1(row, col);
    let text;
    if (initialText === undefined || initialText === null) {
      try {
        text = this.engine.getInput(a1) || '';
      } catch {
        text = '';
      }
      this._editing = { row, col, a1, typed: false };
    } else {
      text = String(initialText);
      this._editing = { row, col, a1, typed: text !== '' };
    }
    this._pointRef = null;
    this._pointRange = null;
    this._selfEdit = true;
    this._editor.value = text;
    this._selfEdit = false;
    this._setEditorOpen();
    this._positionEditor();
    this._editor.focus({ preventScroll: true });
    const end = this._editor.value.length;
    this._editor.setSelectionRange(end, end);
    this._positionFill();
    this._paintSelection();
  }

  /** Enter edit mode because a character (or IME text) landed in the textarea. */
  _beginEditFromInput() {
    const { row, col } = this._anchorCell(this._sel.active);
    this._editing = { row, col, a1: cellToA1(row, col), typed: true };
    this._pointRef = null;
    this._pointRange = null;
    this._setEditorOpen();
    this._positionEditor();
    this._positionFill();
    this._paintSelection();
  }

  commitEdit() {
    if (!this._editing) return;
    const { a1 } = this._editing;
    const text = this._editor.value;
    this._editing = null;
    this._pointRef = null;
    this._pointRange = null;
    this._setEditorIdle();
    this._positionEditor();
    let prev = '';
    try {
      prev = this.engine.getInput(a1) || '';
    } catch {
      prev = '';
    }
    if (text !== prev) this._applyInputs({ [a1]: text === '' ? null : text });
    this._positionFill();
    this._paintSelection();
    this._editor.focus({ preventScroll: true });
  }

  cancelEdit() {
    if (!this._editing) return;
    this._editing = null;
    this._pointRef = null;
    this._pointRange = null;
    this._setEditorIdle();
    this._positionEditor();
    this._positionFill();
    this._paintSelection();
    this._editor.focus({ preventScroll: true });
  }

  /* ----------------------------------------------------------- point mode */

  /** True when a cell reference may be inserted at the caret right now. */
  _canPoint() {
    if (!this._editing) return false;
    const v = this._editor.value;
    if (v[0] !== '=') return false;
    const caret = this._editor.selectionStart;
    if (caret !== this._editor.selectionEnd) return false;
    if (this._pointRef && this._pointRef.end === caret) return true;
    const before = v.slice(0, caret);
    return /(^=|[-+*/^&(,:=<>])\s*$/.test(before);
  }

  _pointText(a, b) {
    if (!b || (a.row === b.row && a.col === b.col)) return cellToA1(a.row, a.col);
    const r = normRange({ s: a, e: b });
    return cellToA1(r.s.row, r.s.col) + ':' + cellToA1(r.e.row, r.e.col);
  }

  /** Insert (or replace) the pointed reference at the caret. */
  _writePoint(a, b) {
    const el = this._editor;
    const text = this._pointText(a, b);
    const start = this._pointRef ? this._pointRef.start : el.selectionStart;
    const end = this._pointRef ? this._pointRef.end : el.selectionEnd;
    const value = el.value.slice(0, start) + text + el.value.slice(end);
    this._selfEdit = true;
    el.value = value;
    this._selfEdit = false;
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
    this._pointRef = { start, end: caret, a: { ...a }, b: b ? { ...b } : null };
    this._pointRange = normRange({ s: a, e: b || a });
    this._positionEditor();
    this._paintSelection();
  }

  /** Arrow keys while pointing: move (or extend) the pointed reference. */
  _pointMove(dr, dc, extend) {
    let a;
    let b = null;
    // A pointed reference steps over a merged rectangle the same way the selection does,
    // and lands on its anchor — the covered cells are empty, so they are never what the
    // user meant to reference.
    if (!this._pointRef) {
      a = this._anchorCell(this._clampCell(this._stepFrom(this._editing, dr, dc)));
    } else if (extend) {
      a = this._pointRef.a;
      const cur = this._pointRef.b || this._pointRef.a;
      b = this._clampCell(this._stepFrom(cur, dr, dc));
    } else {
      const cur = this._pointRef.b || this._pointRef.a;
      a = this._anchorCell(this._clampCell(this._stepFrom(cur, dr, dc)));
    }
    this._writePoint(a, b);
    this._scrollIntoView((b || a).row, (b || a).col);
  }

  /* ------------------------------------------------------------- keyboard */

  /**
   * One step from `cell`, treating a merged rectangle as a single cell: the step leaves
   * from the rectangle's far edge, so it lands past it instead of on a covered cell
   * (SPEC 21.4). PageUp/PageDown pass a larger |dr| and are measured the same way.
   */
  _stepFrom(cell, dr, dc) {
    const m = this._hasMerges ? this._mergeCoverAt(cell.row, cell.col) : null;
    // The row step goes through the view (SPEC 24.1) so arrows, Tab, Enter and
    // PageUp/PageDown walk over the rows a filter hides rather than landing on them.
    // `_stepRow(r, dr)` is `r + dr` whenever the view is the identity.
    if (!m) return { row: this._stepRow(cell.row, dr), col: cell.col + dc };
    return {
      row: dr > 0 ? this._stepRow(m.r2, dr) : dr < 0 ? this._stepRow(m.r1, dr) : cell.row,
      col: dc > 0 ? m.c2 + dc : dc < 0 ? m.c1 + dc : cell.col,
    };
  }

  _moveActive(dr, dc, extend, jump) {
    const cur = extend ? this._sel.range.e : this._sel.active;
    const target = jump
      ? this._dataEdge(cur.row, cur.col, dr, dc)
      : this._stepFrom(cur, dr, dc);
    // Keyboard extension: emit. _moveActive is only ever called with extend=true from
    // the arrow / PageUp / PageDown key handlers, which have no mouseup to emit from.
    if (extend) this._extendTo(target.row, target.col, true);
    else this._selectCell(target.row, target.col);
  }

  /**
   * The selection's rows in DISPLAY order, skipping any the filter hides. Returns null
   * when no view mapping is active, so the identity path allocates nothing.
   */
  _selRowsShown(r) {
    if (!this._viewRows) return null;
    const out = [];
    for (let row = r.s.row; row <= r.e.row; row++) {
      if (this._rowShown(row)) out.push(row);
    }
    out.sort((x, y) => this._viewOf(x) - this._viewOf(y));
    return out;
  }

  /** Tab / Enter inside a multi-cell selection cycles the active cell. */
  _advanceInSelection(dr, dc) {
    const r = this._selRange();
    // The ring walks the rows the grid PAINTS. Indexing absolute rows would step the
    // active cell onto rows the filter hides, where it would be invisible and edits
    // would land out of sight.
    const rowList = this._selRowsShown(r);
    const rows = rowList ? rowList.length : r.e.row - r.s.row + 1;
    const cols = r.e.col - r.s.col + 1;
    const n = rows * cols;
    if (n <= 1) return false;
    const a = this._sel.active;
    if (!inRange(r, a.row, a.col)) return false;
    const rowAt = (i) => (rowList ? rowList[i] : r.s.row + i);
    const rowIdx = rowList ? rowList.indexOf(a.row) : a.row - r.s.row;
    if (rowIdx < 0) return false;   // the active cell sits on a hidden row
    const at = (idx) =>
      dc !== 0
        ? { row: rowAt(Math.floor(idx / cols)), col: r.s.col + (idx % cols) }
        : { row: rowAt(idx % rows), col: r.s.col + Math.floor(idx / rows) };
    const step = dc !== 0 ? dc : dr;
    let idx =
      dc !== 0
        ? mod(rowIdx * cols + (a.col - r.s.col) + dc, n)
        : mod((a.col - r.s.col) * rows + rowIdx + dr, n);
    let next = at(idx);
    if (this._hasMerges) {
      for (let guard = 0; guard < n; guard++) {
        const m = this._mergeCoverAt(next.row, next.col);
        if (!m || (m.r1 === next.row && m.c1 === next.col)) break;
        idx = mod(idx + step, n);
        next = at(idx);
      }
      // The lap came back to where it started: the selection holds exactly one stop —
      // a single merged rectangle. Then Tab/Enter must leave it, like any single cell,
      // so hand the move back to the caller instead of standing still.
      if (next.row === a.row && next.col === a.col) return false;
    }
    this._sel.active = next;
    this._scrollIntoView(this._sel.active.row, this._sel.active.col);
    this._afterSelChange(true);
    return true;
  }

  _enterMove(dir) {
    if (this._advanceInSelection(dir, 0)) return;
    if (this._tabAnchorCol != null) {
      const col = this._tabAnchorCol;
      // _stepFrom, not row+dir: Enter down a column that runs through a merged
      // rectangle has to clear the whole rectangle or it would land back on its anchor.
      const t = this._stepFrom({ row: this._sel.active.row, col }, dir, 0);
      this._selectCell(t.row, t.col);
      return;
    }
    this._moveActive(dir, 0, false, false);
  }

  _tabMove(dir) {
    if (this._tabAnchorCol == null) this._tabAnchorCol = this._sel.active.col;
    if (this._advanceInSelection(0, dir)) return;
    this._moveActive(0, dir, false, false);
  }

  _pageRows() {
    // clientHeight is in SCREEN pixels, so the row height it is divided by has to be a
    // screen height too. DEFAULT_ROW_HEIGHT is a document constant; without _z() the
    // PageUp/PageDown jump is wrong by exactly the zoom factor. _z is the identity at
    // zoom 1, so this is unchanged for anyone who never touches the zoom control.
    return Math.max(1, Math.floor(this._vp.clientHeight / this._z(DEFAULT_ROW_HEIGHT)) - 1);
  }

  /** Bottom-right corner of the used area (Ctrl+End). */
  _lastDataCell() {
    let maxRow = 0;
    let maxCol = 0;
    let values = {};
    try {
      values = this.engine.getValues() || {};
    } catch {
      values = {};
    }
    for (const key of Object.keys(values)) {
      let c;
      try {
        c = a1ToCell(key);
      } catch {
        continue;
      }
      if (c.row > maxRow) maxRow = c.row;
      if (c.col > maxCol) maxCol = c.col;
    }
    return { row: clamp(maxRow, 0, this.rows - 1), col: clamp(maxCol, 0, this.cols - 1) };
  }

  /** Last column holding data in `row` (End). */
  _rowEnd(row) {
    for (let c = this.cols - 1; c >= 0; c--) if (this._hasData(row, c)) return c;
    return 0;
  }

  _onEditorKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return; // let the IME finish first
    if (this._menuEl && e.key === 'Escape') {
      e.preventDefault();
      this._closeMenu();
      return;
    }
    if (this._editing) this._editKeyDown(e);
    else this._gridKeyDown(e);
  }

  _editKeyDown(e) {
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      this.cancelEdit();
      return;
    }
    if (k === 'Enter') {
      if (e.altKey) return; // Alt+Enter inserts a newline
      e.preventDefault();
      this.commitEdit();
      if (e.shiftKey) this._enterMove(-1);
      else this._enterMove(1);
      return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      this.commitEdit();
      this._tabMove(e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'F2') {
      e.preventDefault();
      this._editing.typed = false; // switch from overwrite typing to caret editing
      return;
    }
    if (ARROWS[k]) {
      const [dr, dc] = ARROWS[k];
      if (this._canPoint()) {
        e.preventDefault();
        this._pointMove(dr, dc, e.shiftKey);
        return;
      }
      if (this._editing.typed && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.commitEdit();
        this._moveActive(dr, dc, false, false);
      }
      return; // otherwise the caret moves inside the text
    }
  }

  _gridKeyDown(e) {
    const k = e.key;
    const meta = e.ctrlKey || e.metaKey;

    if (ARROWS[k]) {
      e.preventDefault();
      this._tabAnchorCol = null;
      const [dr, dc] = ARROWS[k];
      this._moveActive(dr, dc, e.shiftKey, meta);
      return;
    }
    if (k === 'Enter') {
      e.preventDefault();
      this._enterMove(e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      this._tabMove(e.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'F2') {
      e.preventDefault();
      this.beginEdit();
      return;
    }
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      this._clearContents();
      return;
    }
    if (k === 'Escape') {
      e.preventDefault();
      this._closeMenu();
      this._selectCell(this._sel.active.row, this._sel.active.col);
      return;
    }
    if (k === 'Home') {
      e.preventDefault();
      this._tabAnchorCol = null;
      const row = meta ? 0 : this._sel.active.row;
      if (e.shiftKey) this._extendTo(row, 0, true);
      else this._selectCell(row, 0);
      return;
    }
    if (k === 'End') {
      e.preventDefault();
      this._tabAnchorCol = null;
      const target = meta ? this._lastDataCell() : { row: this._sel.active.row, col: this._rowEnd(this._sel.active.row) };
      if (e.shiftKey) this._extendTo(target.row, target.col, true);
      else this._selectCell(target.row, target.col);
      return;
    }
    if (k === 'PageUp' || k === 'PageDown') {
      e.preventDefault();
      this._tabAnchorCol = null;
      const dr = (k === 'PageDown' ? 1 : -1) * this._pageRows();
      this._moveActive(dr, 0, e.shiftKey, false);
      return;
    }
    if (meta && (k === 'a' || k === 'A')) {
      e.preventDefault();
      this._selectAll();
      return;
    }
    if (k === ' ' && meta) {
      // Ctrl+Space / Ctrl+Shift+Space: select the column / the whole sheet
      e.preventDefault();
      const r = this._selRange();
      if (e.shiftKey) this._selectAll();
      else this._selectCols(r.s.col, r.e.col);
      return;
    }
    if (k === ' ' && e.shiftKey) {
      e.preventDefault();
      const r = this._selRange();
      this._selectRows(r.s.row, r.e.row);
      return;
    }
    // Any other single printable character (and every IME sequence) is allowed to
    // land in the textarea; _onEditorInput turns it into an edit.
  }

  _onEditorInput() {
    if (this._selfEdit) return;
    if (!this._editing) {
      if (this._editor.value === '') return;
      this._beginEditFromInput();
      return;
    }
    this._pointRef = null;
    if (this._pointRange) {
      this._pointRange = null;
      this._paintSelection();
    }
    this._positionEditor();
  }

  _onEditorPaste(e) {
    // While idle the textarea must not swallow the paste: clipboard.js listens on
    // the document and needs the event to arrive with nothing inserted here.
    if (!this._editing) e.preventDefault();
  }

  _onEditorBlur() {
    if (this._editing) this.commitEdit();
  }

  /* ----------------------------------------------------------------- mouse */

  _on(target, type, fn, opts) {
    const handler = (e) => {
      if (this._destroyed) return;
      fn.call(this, e);
    };
    target.addEventListener(type, handler, opts);
    this._listeners.push({ target, type, handler, opts });
  }

  _bindEvents() {
    this._on(this.el, 'mousedown', this._onMouseDown);
    this._on(this.el, 'click', this._onClick);
    this._on(this.el, 'dblclick', this._onDblClick);
    this._on(this.el, 'contextmenu', this._onContextMenu);
    this._on(this._vp, 'scroll', this._onScroll, { passive: true });
    this._on(this._editor, 'keydown', this._onEditorKeyDown);
    this._on(this._editor, 'input', this._onEditorInput);
    this._on(this._editor, 'paste', this._onEditorPaste);
    this._on(this._editor, 'blur', this._onEditorBlur);
    this._on(document, 'mousemove', this._onMouseMove);
    this._on(document, 'mouseup', this._onMouseUp);
    this._on(document, 'mousedown', this._onDocMouseDown, true);
    this._on(window, 'resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => {
        if (!this._destroyed) this._invalidate();
      });
      this._ro.observe(this.el);
    }
  }

  _onScroll() {
    this._invalidate();
  }

  _onResize() {
    this._invalidate();
  }

  _onDocMouseDown(e) {
    if (this._menuEl && !this._menuEl.contains(e.target)) this._closeMenu();
  }

  /**
   * SPEC 23.4 — a click that landed on a linked cell's <a>.
   *
   * The anchor is a real link, so the browser would open it on ANY click. A plain click
   * has to keep selecting the cell instead (a linked cell must stay as easy to edit as
   * any other), so every activation that was not asked for is cancelled here. The
   * gestures that ARE asked for — Ctrl/Cmd+click and a click on the trailing glyph — fall
   * through untouched and open in a new tab through the anchor's own target/rel.
   */
  _onClick(e) {
    const anchor = linkTarget(e);
    if (anchor && !isLinkFollow(e, anchor)) e.preventDefault();
  }

  /** clientX/clientY -> {row, col}, clamped to the visible body area. */
  _hitTest(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const hw = this._hw;
    const hh = this._hh;
    const bw = Math.max(1, rect.width - hw);
    const bh = Math.max(1, rect.height - hh);
    const bx = clamp(clientX - rect.left - hw, 0, bw - 1);
    const by = clamp(clientY - rect.top - hh, 0, bh - 1);
    const ax = bx < this._fw ? bx : bx + this._vp.scrollLeft;
    const ay = by < this._fh ? by : by + this._vp.scrollTop;
    return { row: this._rowAt(ay), col: this._colAt(ax) };
  }

  _onMouseDown(e) {
    if (e.button === 2) return;
    const t = e.target;
    if (this._menuEl && this._menuEl.contains(t)) return;
    this._closeMenu();
    this._lastMouse = { x: e.clientX, y: e.clientY };

    if (t === this._fill) {
      e.preventDefault();
      this._drag = { kind: 'fill', src: this._selRange() };
      this._startAutoScroll();
      return;
    }
    // --- SPEC section 24: the three affordances that own their own gesture ------------
    // They are tested before anything that hit-tests a coordinate, because each of them
    // sits ON a cell and would otherwise be swallowed by the selection path.
    const grip = t.closest ? t.closest('.sz-chart-handle') : null;
    if (grip && grip.__chartId) {
      e.preventDefault();
      if (this._editing) this.commitEdit();
      if (this._startChartDrag(grip.__chartId, 'chartresize', e)) return;
    }
    const chartEl = t.closest ? t.closest('.sz-chart') : null;
    if (chartEl && chartEl.__chartId) {
      e.preventDefault();
      if (this._editing) this.commitEdit();
      if (this._startChartDrag(chartEl.__chartId, 'chartmove', e)) return;
    }
    const fbtn = t.closest ? t.closest('.sz-filter-btn') : null;
    if (fbtn && fbtn.__col != null) {
      e.preventDefault();
      if (this._editing) this.commitEdit();
      this._editor.focus({ preventScroll: true });
      this._openFilterMenu(fbtn);
      return;
    }
    const mark = t.closest ? t.closest('.sz-cell-comment') : null;
    if (mark) {
      const cell = mark.parentNode;
      if (cell && cell.__row != null) {
        e.preventDefault();
        if (this._editing) this.commitEdit();
        this._editor.focus({ preventScroll: true });
        // The cell is selected first, so the thread panel and the selection can never
        // disagree about which cell is being discussed.
        this._selectCell(cell.__row, cell.__col);
        this._openComment(cell, mark);
        return;
      }
    }
    if (t.classList && t.classList.contains('sz-colhead-grip')) {
      e.preventDefault();
      this._startColResize(t.parentNode.__col, e.clientX);
      return;
    }
    if (t.classList && t.classList.contains('sz-rowhead-grip')) {
      e.preventDefault();
      this._startRowResize(t.parentNode.__row, e.clientY);
      return;
    }
    const colHead = t.closest ? t.closest('.sz-colhead') : null;
    if (colHead && colHead.__col != null) {
      e.preventDefault();
      if (this._editing) this.commitEdit();
      this._editor.focus({ preventScroll: true });
      this._tabAnchorCol = null;
      const c = colHead.__col;
      if (e.shiftKey) {
        const from = this._sel.range.s.col;
        this._drag = { kind: 'colhead', from };   // before the emission — see _emitCursor
        this._selectRange(0, from, this.rows - 1, c, 0, from);
      } else {
        this._drag = { kind: 'colhead', from: c };
        this._selectCols(c, c);
      }
      this._startAutoScroll();
      return;
    }
    const rowHead = t.closest ? t.closest('.sz-rowhead') : null;
    if (rowHead && rowHead.__row != null) {
      e.preventDefault();
      if (this._editing) this.commitEdit();
      this._editor.focus({ preventScroll: true });
      this._tabAnchorCol = null;
      const r = rowHead.__row;
      if (e.shiftKey) {
        const from = this._sel.range.s.row;
        this._drag = { kind: 'rowhead', from };   // before the emission — see _emitCursor
        this._selectRange(from, 0, r, this.cols - 1, from, 0);
      } else {
        this._drag = { kind: 'rowhead', from: r };
        this._selectRows(r, r);
      }
      this._startAutoScroll();
      return;
    }
    if (t.closest && t.closest('.sz-corner')) {
      e.preventDefault();
      if (this._editing) this.commitEdit();
      this._editor.focus({ preventScroll: true });
      this._selectAll();
      return;
    }
    if (t === this._editor) return; // caret placement inside the open editor
    if (t === this._vp) {
      // ignore clicks that landed on the scrollbars
      const r = this._vp.getBoundingClientRect();
      if (
        e.clientX - r.left >= this._vp.clientWidth ||
        e.clientY - r.top >= this._vp.clientHeight
      ) {
        return;
      }
    }

    // SPEC 23.4 — a link-following gesture (Ctrl/Cmd+click, or a click on the trailing
    // glyph) is handed to the anchor: return WITHOUT preventDefault, since suppressing the
    // mousedown default would leave the click to be cancelled by _onClick. Pointing at a
    // cell while typing a formula still wins, so that branch is tested first.
    const anchor = linkTarget(e);
    if (anchor && !(this._editing && this._canPoint()) && isLinkFollow(e, anchor)) {
      if (this._editing) this.commitEdit();
      return;
    }

    const hit = this._hitTest(e.clientX, e.clientY);
    if (this._editing && this._canPoint()) {
      e.preventDefault();
      const p = this._anchorCell({ row: hit.row, col: hit.col });
      this._writePoint({ row: p.row, col: p.col }, null);
      this._drag = { kind: 'point', a: { row: p.row, col: p.col } };
      return;
    }
    if (this._editing) this.commitEdit();
    e.preventDefault();
    this._editor.focus({ preventScroll: true });
    this._tabAnchorCol = null;
    // Marked as a drag BEFORE the selection changes: _emitCursor reads `_drag` to decide
    // whether a selection has settled, and the anchor this mousedown produces has not.
    // Anything that ACTS on a selection (the format painter) must wait for the mouseup.
    this._drag = { kind: 'cell' };
    if (e.shiftKey) this._extendTo(hit.row, hit.col);
    else this._selectCell(hit.row, hit.col);
    this._startAutoScroll();
  }

  _onMouseMove(e) {
    if (!this._drag) return;
    this._lastMouse = { x: e.clientX, y: e.clientY };
    const d = this._drag;
    if (d.kind === 'cell') {
      const hit = this._hitTest(e.clientX, e.clientY);
      this._extendTo(hit.row, hit.col);
      return;
    }
    if (d.kind === 'colhead') {
      const hit = this._hitTest(e.clientX, e.clientY);
      const c0 = Math.min(d.from, hit.col);
      const c1 = Math.max(d.from, hit.col);
      this._selectRange(0, c0, this.rows - 1, c1, 0, d.from);
      return;
    }
    if (d.kind === 'rowhead') {
      const hit = this._hitTest(e.clientX, e.clientY);
      // Ordered by DISPLAY position: under a sort the absolute numbers of the two ends
      // say nothing about which rows lie between them on screen, and a min/max over
      // absolute rows would highlight rows the pointer never crossed.
      const a = this._viewPos(d.from);
      const b = this._viewPos(hit.row);
      const r0 = this._rowAtPos(Math.min(a, b));
      const r1 = this._rowAtPos(Math.max(a, b));
      this._selectRange(r0, 0, r1, this.cols - 1, d.from, 0);
      return;
    }
    if (d.kind === 'point') {
      const hit = this._hitTest(e.clientX, e.clientY);
      this._writePoint(d.a, { row: hit.row, col: hit.col });
      return;
    }
    if (d.kind === 'fill') {
      this._updateFillPreview(this._hitTest(e.clientX, e.clientY));
      return;
    }
    if (d.kind === 'chartmove' || d.kind === 'chartresize') {
      this._moveChartDrag(e);
      return;
    }
    // A resize is tracked in DOCUMENT pixels, because that is what gets written back to
    // the sheet (SPEC 23.2: zoom never mutates the document). The pointer moves in screen
    // pixels, so the delta — and only the delta — is converted here; the clamps then apply
    // to the number the document will actually hold. At a zoom of 1 this is the old code.
    if (d.kind === 'colresize') {
      const dx = (e.clientX - d.startX) / this._zoom;
      d.w = clamp(d.startW + dx, MIN_COL_WIDTH, MAX_COL_WIDTH);
      this._guide.style.left = this._colGuideX(d.col, d.w) + 'px';
      return;
    }
    if (d.kind === 'rowresize') {
      const dy = (e.clientY - d.startY) / this._zoom;
      d.h = clamp(d.startH + dy, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
      this._guide.style.top = this._rowGuideY(d.row, d.h) + 'px';
    }
  }

  _onMouseUp() {
    const d = this._drag;
    if (!d) return;
    // Cleared first: the emission below is the settled one, and _emitCursor reads
    // `_drag` to decide.
    this._drag = null;
    this._stopAutoScroll();
    if (d.kind === 'colresize') this._finishColResize(d);
    else if (d.kind === 'rowresize') this._finishRowResize(d);
    else if (d.kind === 'fill') this._finishFill(d);
    // A chart drag never touched the selection, so it must not emit a cursor either.
    else if (d.kind === 'chartmove' || d.kind === 'chartresize') this._finishChartDrag(d);
    else if (d.kind !== 'point') this._emitCursor();
  }

  _onDblClick(e) {
    const t = e.target;
    if (t.classList && t.classList.contains('sz-colhead-grip')) {
      e.preventDefault();
      this._autoFitCol(t.parentNode.__col);
      return;
    }
    if (t.classList && t.classList.contains('sz-rowhead-grip')) {
      e.preventDefault();
      this._autoFitRow(t.parentNode.__row);
      return;
    }
    if (this._editing) return;
    if (t.closest && (t.closest('.sz-colhead') || t.closest('.sz-rowhead') || t.closest('.sz-corner'))) {
      return;
    }
    // SPEC section 24 — a double click on a chart, a filter glyph or a comment mark is
    // never a request to edit the cell underneath it.
    if (
      t.closest &&
      (t.closest('.sz-chart') ||
        t.closest('.sz-chart-handle') ||
        t.closest('.sz-filter-btn') ||
        t.closest('.sz-cell-comment'))
    ) {
      return;
    }
    if (t === this._vp) {
      const r = this._vp.getBoundingClientRect();
      if (e.clientX - r.left >= this._vp.clientWidth || e.clientY - r.top >= this._vp.clientHeight) {
        return;
      }
    }
    e.preventDefault();
    const hit = this._hitTest(e.clientX, e.clientY);
    this._selectCell(hit.row, hit.col);
    this.beginEdit();
  }

  _startAutoScroll() {
    if (this._autoRaf) return;
    const step = () => {
      if (this._destroyed || !this._drag) {
        this._autoRaf = 0;
        return;
      }
      this._autoScrollStep();
      this._autoRaf = requestAnimationFrame(step);
    };
    this._autoRaf = requestAnimationFrame(step);
  }

  _stopAutoScroll() {
    if (this._autoRaf) cancelAnimationFrame(this._autoRaf);
    this._autoRaf = 0;
  }

  _autoScrollStep() {
    const m = this._lastMouse;
    if (!m) return;
    const r = this._vp.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (m.x < r.left) dx = m.x - r.left;
    else if (m.x > r.right) dx = m.x - r.right;
    if (m.y < r.top) dy = m.y - r.top;
    else if (m.y > r.bottom) dy = m.y - r.bottom;
    if (!dx && !dy) return;
    this._vp.scrollLeft += clamp(dx, -AUTOSCROLL_MAX, AUTOSCROLL_MAX);
    this._vp.scrollTop += clamp(dy, -AUTOSCROLL_MAX, AUTOSCROLL_MAX);
    const hit = this._hitTest(m.x, m.y);
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'cell') this._extendTo(hit.row, hit.col);
    else if (d.kind === 'fill') this._updateFillPreview(hit);
    else if (d.kind === 'colhead') {
      this._selectRange(0, Math.min(d.from, hit.col), this.rows - 1, Math.max(d.from, hit.col), 0, d.from);
    } else if (d.kind === 'rowhead') {
      this._selectRange(Math.min(d.from, hit.row), 0, Math.max(d.from, hit.row), this.cols - 1, d.from, 0);
    }
  }

  /* ----------------------------------------------------------- fill handle */

  _positionFill() {
    const s = this._fill.style;
    if (this._editing) {
      s.display = 'none';
      return;
    }
    const r = this._selRange();
    // The bottom of the selection ON SCREEN, which under a sort is not its maximum
    // absolute row — and when that row is filtered out, _oy returns HIDDEN_POS and the
    // handle would vanish from a selection the user can plainly see.
    const bottomRow = this._lastShownRow(r);
    if (bottomRow < 0) {
      s.display = 'none';
      return;
    }
    const x = this._ox(r.e.col) + this._colW(r.e.col);
    const y = this._oy(bottomRow) + this._rowH(bottomRow);
    const ow = this._overlay.clientWidth;
    const oh = this._overlay.clientHeight;
    if (x < 1 || y < 1 || x > ow || y > oh) {
      s.display = 'none';
      return;
    }
    s.display = 'block';
    s.left = x + 'px';
    s.top = y + 'px';
  }

  /**
   * Display position of an absolute row, falling back to the row itself when no view
   * mapping is active. A hidden row reports the position of the nearest shown row above
   * it, so a drag that passes over hidden rows still yields a monotonic distance.
   */
  /** The absolute row of a selection that sits LOWEST on screen, or -1 if none shows. */
  _lastShownRow(r) {
    if (!this._viewRows) return r.e.row;
    let best = -1;
    let bestPos = -1;
    for (let row = r.s.row; row <= r.e.row; row++) {
      const p = this._viewOf(row);
      if (p > bestPos) { bestPos = p; best = row; }
    }
    return best;
  }

  _viewPos(row) {
    if (!this._viewRows) return row;
    const v = this._viewOf(row);
    if (v >= 0) return v;
    for (let r = row - 1; r >= 0; r--) {
      const p = this._viewOf(r);
      if (p >= 0) return p;
    }
    return 0;
  }

  /** Inverse of _viewPos: the absolute row shown at a display position. */
  _rowAtPos(pos) {
    if (!this._viewRows) return clamp(pos, 0, this.rows - 1);
    return this._rowOf(clamp(pos, 0, this._viewRows.length - 1));
  }

  _updateFillPreview(hit) {
    const d = this._drag;
    if (!d || d.kind !== 'fill') return;
    const src = d.src;
    // Vertical distance is measured in DISPLAY positions, not absolute rows. Under a
    // sort or a filter the two disagree, and an absolute-row subtraction would make the
    // drag cover rows the pointer never passed over — which _computeFill would then
    // write into.
    const vHit = this._viewPos(hit.row);
    const vTop = this._viewPos(src.s.row);
    const vBot = this._viewPos(src.e.row);
    let dr = 0;
    let dc = 0;
    if (vHit > vBot) dr = vHit - vBot;
    else if (vHit < vTop) dr = vHit - vTop;
    if (hit.col > src.e.col) dc = hit.col - src.e.col;
    else if (hit.col < src.s.col) dc = hit.col - src.s.col;

    if (dr === 0 && dc === 0) {
      d.axis = null;
      d.target = null;
      this._fillPreview = null;
    } else if (Math.abs(dr) >= Math.abs(dc)) {
      d.axis = 'v';
      // Ordered by DISPLAY position, then mapped back, so the band is the run of rows the
      // pointer actually crossed on screen.
      const a = Math.min(vTop, vHit);
      const b = Math.max(vBot, vHit);
      // The fill target is a selection like any other, so it grows over merges too.
      d.target = this._expandOver({
        s: { row: this._rowAtPos(a), col: src.s.col },
        e: { row: this._rowAtPos(b), col: src.e.col },
      });
      d.vFrom = a;
      d.vTo = b;
      this._fillPreview = d.target;
    } else {
      d.axis = 'h';
      d.target = this._expandOver({
        s: { row: src.s.row, col: Math.min(src.s.col, hit.col) },
        e: { row: src.e.row, col: Math.max(src.e.col, hit.col) },
      });
      this._fillPreview = d.target;
    }
    this._paintSelection();
  }

  _finishFill(d) {
    this._fillPreview = null;
    if (!d.target || !d.axis) {
      this._paintSelection();
      this._positionFill();
      return;
    }
    const map = this._computeFill(d.src, d.target, d.axis);
    if (Object.keys(map).length) this._applyInputs(map);
    this._sel.range = { s: { ...d.target.s }, e: { ...d.target.e } };
    if (!inRange(d.target, this._sel.active.row, this._sel.active.col)) {
      this._sel.active = this._anchorCell({ ...d.target.s });
    }
    this._afterSelChange(true);
  }

  /** Linear series over one fill lane, or null when it is not a plain number run. */
  _laneSeries(i0, i1, get) {
    const n = i1 - i0 + 1;
    if (n < 2) return null;
    const nums = [];
    for (let i = i0; i <= i1; i++) {
      const text = get(i);
      if (!numericInput(text)) return null;
      nums.push(Number(text.trim()));
    }
    return { first: nums[0], step: (nums[n - 1] - nums[0]) / (n - 1) };
  }

  /** Relative-reference translation for a copied formula. */
  _translateFormula(text, dRow, dCol) {
    if (typeof text !== 'string' || text[0] !== '=') return text;
    if (dRow === 0 && dCol === 0) return text;
    try {
      const ast = parse(text.slice(1));
      const moved = mapRefs(ast, (ref) => offsetRef(ref, dRow, dCol));
      return '=' + serialize(moved);
    } catch {
      return text;
    }
  }

  /** Build the { A1: input|null } patch for one fill drag. */
  _computeFill(src, tgt, axis) {
    const map = {};
    let budget = SCAN_LIMIT; // never emit a patch larger than the server accepts
    const srcRows = src.e.row - src.s.row + 1;
    const srcCols = src.e.col - src.s.col + 1;
    const lanes = new Map();
    if (axis === 'v') {
      for (let c = src.s.col; c <= src.e.col; c++) {
        lanes.set(c, this._laneSeries(src.s.row, src.e.row, (i) => this._input(i, c)));
      }
    } else {
      for (let r = src.s.row; r <= src.e.row; r++) {
        lanes.set(r, this._laneSeries(src.s.col, src.e.col, (i) => this._input(r, i)));
      }
    }
    for (let r = tgt.s.row; r <= tgt.e.row && budget > 0; r++) {
      // A row the filter hides is not part of what the user dragged over, so a fill never
      // writes into it (SPEC 24.1) — the same rule Delete follows.
      if (this._viewRows && !this._rowShown(r)) continue;
      for (let c = tgt.s.col; c <= tgt.e.col && budget > 0; c++) {
        if (inRange(src, r, c)) continue;
        const a1 = cellToA1(r, c);
        // Never write into a covered cell: the merge invariant is that only the anchor
        // holds anything, and that is what keeps the formula engine merge-free.
        if (this._hasMerges) {
          const m = this._mergeCoverAt(r, c, a1);
          if (m && (m.r1 !== r || m.c1 !== c)) continue;
        }
        budget--;
        let sr;
        let sc;
        let idx;
        if (axis === 'v') {
          sc = c;
          idx = r - src.s.row;
          sr = src.s.row + mod(idx, srcRows);
        } else {
          sr = r;
          idx = c - src.s.col;
          sc = src.s.col + mod(idx, srcCols);
        }
        const lane = lanes.get(axis === 'v' ? c : r);
        if (lane) {
          map[a1] = tidyNumber(lane.first + lane.step * idx);
          continue;
        }
        const text = this._input(sr, sc);
        if (text === '') {
          if (this._input(r, c) !== '') map[a1] = null;
          continue;
        }
        map[a1] = this._translateFormula(text, r - sr, c - sc);
      }
    }
    return map;
  }

  /* ---------------------------------------------------------- resize / fit */

  // `w` / `h` are DOCUMENT pixels (that is what the drag tracks), so they are scaled here
  // like every other measurement; the header offset is already scaled.
  _colGuideX(col, w) {
    return this._hw + this._ox(col) + this._z(w);
  }

  _rowGuideY(row, h) {
    return this._hh + this._oy(row) + this._z(h);
  }

  _startColResize(col, clientX) {
    if (col == null) return;
    const startW = this._docColW(col);
    this._drag = { kind: 'colresize', col, startX: clientX, startW, w: startW };
    this._guide.classList.remove('sz-resize-guide-h');
    css(this._guide, {
      display: 'block',
      left: this._colGuideX(col, startW) + 'px',
      top: '0px',
      bottom: '0px',
      right: '',
      width: '2px',
      height: '',
    });
  }

  _startRowResize(row, clientY) {
    if (row == null) return;
    const startH = this._docRowH(row);
    this._drag = { kind: 'rowresize', row, startY: clientY, startH, h: startH };
    this._guide.classList.add('sz-resize-guide-h');
    css(this._guide, {
      display: 'block',
      left: '0px',
      right: '0px',
      top: this._rowGuideY(row, startH) + 'px',
      bottom: '',
      width: '',
      height: '2px',
    });
  }

  _finishColResize(d) {
    this._guide.style.display = 'none';
    const w = Math.round(d.w == null ? d.startW : d.w);
    if (w === Math.round(d.startW)) return;
    this._setColWidth(d.col, w);
  }

  _finishRowResize(d) {
    this._guide.style.display = 'none';
    const h = Math.round(d.h == null ? d.startH : d.h);
    if (h === Math.round(d.startH)) return;
    this._setRowHeight(d.row, h);
  }

  /** Columns the resize applies to: the whole selected band when full columns are selected. */
  _resizeColSpan(col) {
    const r = this._selRange();
    if (r.s.row === 0 && r.e.row === this.rows - 1 && col >= r.s.col && col <= r.e.col) {
      return [r.s.col, r.e.col];
    }
    return [col, col];
  }

  /**
   * The rows a height change applies to: the whole selection when the user grabbed a row
   * inside a whole-row selection, otherwise just the grabbed row. Returns a LIST rather
   * than a span so a filtered selection cannot resize the rows it is hiding.
   */
  _resizeRowSpan(row) {
    const r = this._selRange();
    if (r.s.col === 0 && r.e.col === this.cols - 1 && row >= r.s.row && row <= r.e.row) {
      if (this._viewRows) return this._shownRowsIn(r);
      const out = [];
      for (let i = r.s.row; i <= r.e.row; i++) out.push(i);
      return out;
    }
    return [row];
  }

  _setColWidth(col, w) {
    const widths = Object.assign({}, this.sheet.colWidths || {});
    const [c0, c1] = this._resizeColSpan(col);
    for (let c = c0; c <= c1; c++) widths[String(c)] = w;
    this.sheet.colWidths = widths;
    this.render();
    try {
      this.onMeta({ colWidths: Object.assign({}, widths) });
    } catch (e) {
      console.error('Grid onMeta failed', e);
    }
  }

  _setRowHeight(row, h) {
    const heights = Object.assign({}, this.sheet.rowHeights || {});
    for (const r of this._resizeRowSpan(row)) heights[String(r)] = h;
    this.sheet.rowHeights = heights;
    this.render();
    try {
      this.onMeta({ rowHeights: Object.assign({}, heights) });
    } catch (e) {
      console.error('Grid onMeta failed', e);
    }
  }

  /* --------------------------------------------------- growing a sheet (25.3) */

  /**
   * Extend the sheet when the user reaches the end of it (SPEC 25.3).
   *
   * A sheet starts at 200 x 26 and 행 삽입 only shifts cells WITHIN it, so without this
   * the grid is a wall. Growth is strictly ADDITIVE — nothing but `sheet.rows` /
   * `sheet.cols` changes — which is precisely why it is safe to do behind the user's
   * back: no cell moves, no formula is rewritten, no merge, filter, chart or comment is
   * touched, so there is nothing an unlucky moment could corrupt.
   *
   * Fired from two places, because the two ways of reaching the edge are independent:
   *   - the tail of the coalesced repaint (scrolling, and a resize that reveals the end),
   *   - `_afterSelChange`, so arrowing onto the last row grows the sheet even when the
   *     row was already on screen and no scroll event ever happens.
   *
   * Four rules keep it out of the way:
   *   - never while `_drag` is live. A cell drag, a fill, a header selection, a column
   *     or row resize and a chart move are all aimed at a specific pixel; moving the
   *     scrollbar under a pointer that is still down would move what it is aimed at.
   *   - at most one request per second PER AXIS (`GROW_THROTTLE_MS`), so a flick-scroll
   *     to the bottom cannot queue a dozen growth frames and a dozen re-renders.
   *   - silently nothing at `MAX_ROWS` / `MAX_COLS`. Reaching the end of a 5000-row
   *     sheet is not an error and must not produce a message or a wasted frame.
   *   - no allocation. This runs on the scroll path; it reads two scalars, runs the two
   *     binary searches `_window()` runs and compares integers.
   */
  _maybeGrow() {
    if (this._destroyed || this._growBusy || this._drag) return;
    const rows = this.rows;
    const cols = this.cols;
    const roomRows = rows < MAX_ROWS;
    const roomCols = cols < MAX_COLS;
    if (!roomRows && !roomCols) return; // already as big as a sheet gets

    // Moving the SELECTION onto the far row or column counts as reaching the end, not
    // only scrolling there. The active cell is the test, never the range: Ctrl+A selects
    // to the last row and column of every sheet and must not grow anything.
    let nearRow = roomRows && this._sel.active.row >= rows - 1;
    let nearCol = roomCols && this._sel.active.col >= cols - 1;

    const vp = this._vp;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    // A viewport with no box renders nothing (see `_window()`), so it is not near
    // anything; the selection test above still applies.
    if (vw > 0 && vh > 0) {
      if (roomRows && !nearRow) {
        // The DISPLAY position of the sheet's final row. With no filter that is
        // `rows - 1` and the comparison below is literally "the bottom of the rendered
        // window is within GROW_TRIGGER_ROWS of the last row" (SPEC 24.1 made a row
        // index and a screen position two different numbers; this is the one place the
        // extent has to be measured in the second). A filter that HIDES the last row
        // leaves it with no position, and auto-grow stays out of it entirely — the
        // manual control of SPEC 25.4 is how you extend a sheet whose end is not shown.
        const lastVi = this._viewOf(rows - 1);
        if (lastVi >= 0) {
          const vi1 = Math.min(
            this._viewCount - 1,
            this._viewAt(this._fh + vp.scrollTop + Math.max(0, vh - 1)) + OVERSCAN,
          );
          nearRow = vi1 >= lastVi - GROW_TRIGGER_ROWS;
        }
      }
      if (roomCols && !nearCol) {
        const c1 = Math.min(
          cols - 1,
          this._colAt(this._fw + vp.scrollLeft + Math.max(0, vw - 1)) + OVERSCAN,
        );
        nearCol = c1 >= cols - 1 - GROW_TRIGGER_COLS;
      }
    }
    if (!nearRow && !nearCol) return;

    const now = Date.now();
    let dRows = 0;
    let dCols = 0;
    // The last step is clamped to what is left, so a sheet at 4200 rows grows to exactly
    // MAX_ROWS rather than being refused for not having a full step of room.
    if (nearRow && now - this._growRowsAt >= GROW_THROTTLE_MS) {
      dRows = Math.min(ROW_GROW_STEP, MAX_ROWS - rows);
    }
    if (nearCol && now - this._growColsAt >= GROW_THROTTLE_MS) {
      dCols = Math.min(COL_GROW_STEP, MAX_COLS - cols);
    }
    if (dRows <= 0 && dCols <= 0) return; // throttled: try again on the next frame
    if (dRows > 0) this._growRowsAt = now;
    if (dCols > 0) this._growColsAt = now;
    this._grow(dRows, dCols);
  }

  /**
   * Ask the host for a bigger sheet, as one ordinary `meta` patch (SPEC 25.2). The
   * values are the ABSOLUTE new extent, not a delta, exactly as the wire carries it.
   *
   * The grid does NOT write `sheet.rows` itself and does not re-render here, for the
   * same reason it never rewrites `sheet.merges` (see the header): the host owns the
   * document, the engine and the socket. Growing means the engine's extent has to move
   * with the sheet's — `A:A` stops at the last row — and that is the host's to do; a
   * grid that had already bumped `sheet.rows` would leave it computing a delta of zero
   * and the growth would never reach the engine, the server or anyone else. Reporting
   * and applying are also what keeps the repaint OFF the stack this runs on: auto-grow
   * fires from inside scroll and key handling, and the host schedules the render for
   * the next frame instead of repainting underneath the handler that asked for it.
   *
   * Everything the new extent touches is then picked up by that one render: `_layout()`
   * re-reads `sheet.rows` / `sheet.cols`, rebuilds the cumulative offsets and the merge
   * index and resizes the spacer that drives the scrollbars, while the headers, the hit
   * tests and the windowed render are all derived from the window rather than cached per
   * sheet. The single cached-per-sheet structure is the filter row view, and
   * `_ensureRowView` notices the new row count through `_viewSrcRows` — which is also
   * what makes a REMOTE peer's growth land correctly, since it arrives by exactly the
   * same route.
   *
   * A request computed from an extent the host has already grown past simply asks for a
   * size the sheet already has, and the host declines it; there is no state to unwind.
   */
  _grow(dRows, dCols) {
    const patch = {};
    if (dRows > 0) patch.rows = this.rows + dRows;
    if (dCols > 0) patch.cols = this.cols + dCols;
    this._growBusy = true;
    try {
      this.onMeta(patch);
    } catch (e) {
      console.error('Grid onMeta failed', e);
    } finally {
      this._growBusy = false;
    }
  }

  /** Off-screen node used to measure the natural size of rendered text. */
  _measureNode() {
    if (!this._measure) {
      const el = div('sz-cell');
      css(el, {
        position: 'absolute',
        left: '-99999px',
        top: '0px',
        width: 'auto',
        height: 'auto',
        whiteSpace: 'pre',
        visibility: 'hidden',
        pointerEvents: 'none',
      });
      this.el.appendChild(el);
      this._measure = el;
    }
    return this._measure;
  }

  _autoFitCol(col) {
    if (col == null) return;
    const m = this._measureNode();
    let w = 0;
    for (const node of this._cells.values()) {
      // a merged rectangle spans several columns, so its text says nothing about this one
      // The TEXT span is measured, not the whole node: a cell may also carry a filter
      // glyph or a comment mark (SPEC 24.1 / 24.3), and neither is part of its content.
      if (node.__col !== col || node.__merge || !node.__txt.textContent) continue;
      m.textContent = node.__txt.textContent;
      // Every property that changes the text's box has to be copied, or a column of
      // 24px cells is measured in the stylesheet's 13px base font and auto-fits far
      // too narrow.
      m.style.fontWeight = node.style.fontWeight;
      m.style.fontStyle = node.style.fontStyle;
      m.style.fontFamily = node.style.fontFamily;
      m.style.fontSize = node.style.fontSize;
      w = Math.max(w, m.offsetWidth);
    }
    m.textContent = '';
    // The measurement is in SCREEN pixels (the measuring cell inherits the zoomed font),
    // but the width being written is a document one, so it converts back before the
    // padding is added — the padding belongs to the document too. `/ 1` at 100%.
    const next =
      w > 0
        ? clamp(Math.ceil(w / this._zoom) + 8, MIN_COL_WIDTH, MAX_COL_WIDTH)
        : DEFAULT_COL_WIDTH;
    this._setColWidth(col, next);
  }

  _autoFitRow(row) {
    if (row == null) return;
    const m = this._measureNode();
    let h = 0;
    for (const node of this._cells.values()) {
      if (node.__row !== row || node.__merge || !node.__txt.textContent) continue;
      m.textContent = node.__txt.textContent;
      m.style.fontWeight = node.style.fontWeight;
      m.style.fontStyle = node.style.fontStyle;
      m.style.fontFamily = node.style.fontFamily;
      m.style.fontSize = node.style.fontSize;
      h = Math.max(h, m.offsetHeight);
    }
    m.textContent = '';
    // Screen pixels -> document pixels, as in _autoFitCol.
    const next =
      h > 0
        ? clamp(Math.ceil(h / this._zoom) + 4, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT)
        : DEFAULT_ROW_HEIGHT;
    this._setRowHeight(row, next);
  }

  /* --------------------------------------------------------- context menu */

  _onContextMenu(e) {
    const t = e.target;
    if (t.closest && t.closest('.sz-menu')) return;
    // A chart covers cells it has nothing to do with, so the row/column menu would act on
    // whatever happens to be underneath it (SPEC 24.2). Leave the browser menu alone.
    if (t.closest && (t.closest('.sz-chart') || t.closest('.sz-chart-handle'))) return;
    e.preventDefault();
    if (this._editing) this.commitEdit();
    this._editor.focus({ preventScroll: true });

    const colHead = t.closest ? t.closest('.sz-colhead') : null;
    const rowHead = t.closest ? t.closest('.sz-rowhead') : null;
    const r = this._selRange();
    if (colHead && colHead.__col != null) {
      const c = colHead.__col;
      const whole = r.s.row === 0 && r.e.row === this.rows - 1;
      if (!(whole && c >= r.s.col && c <= r.e.col)) this._selectCols(c, c);
    } else if (rowHead && rowHead.__row != null) {
      const row = rowHead.__row;
      const whole = r.s.col === 0 && r.e.col === this.cols - 1;
      if (!(whole && row >= r.s.row && row <= r.e.row)) this._selectRows(row, row);
    } else if (!(t.closest && t.closest('.sz-corner'))) {
      const hit = this._hitTest(e.clientX, e.clientY);
      if (!inRange(r, hit.row, hit.col)) this._selectCell(hit.row, hit.col);
    }

    const rect = this.el.getBoundingClientRect();
    this._openMenu(e.clientX - rect.left, e.clientY - rect.top);
  }

  _openMenu(x, y) {
    this._closeMenu();
    const menu = div('sz-menu');
    css(menu, { position: 'absolute', left: x + 'px', top: y + 'px' });
    // The menu is a chrome surface that happens to live inside the grid box, so it opts
    // out of the zoomed typography the root sets (SPEC 23.2 scales the SHEET, not the UI).
    if (this._zoom !== 1) {
      menu.style.setProperty('--sz-fs', BASE_FS + 'px');
      menu.style.setProperty('--sz-fs-sm', BASE_FS_SM + 'px');
    }
    for (const [label, cmd] of MENU_ITEMS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sz-menu-item';
      item.textContent = label;
      css(item, { display: 'block', width: '100%', textAlign: 'left' });
      item.addEventListener('mousedown', (ev) => ev.preventDefault());
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._closeMenu();
        this._menuCommand(cmd);
        this._editor.focus({ preventScroll: true });
      });
      menu.appendChild(item);
    }
    this.el.appendChild(menu);
    this._menuEl = menu;
    // keep the menu inside the grid box
    const rect = this.el.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    if (box.right > rect.right) menu.style.left = Math.max(0, x - box.width) + 'px';
    if (box.bottom > rect.bottom) menu.style.top = Math.max(0, y - box.height) + 'px';
  }

  _closeMenu() {
    if (this._menuEl) {
      this._menuEl.remove();
      this._menuEl = null;
    }
  }

  /**
   * The absolute rows of `r` that the view actually paints. Under a filter a selection
   * spans absolute rows the user cannot see, and a structural edit derived from that span
   * would move or destroy them.
   */
  _shownRowsIn(r) {
    const out = [];
    for (let row = r.s.row; row <= r.e.row; row++) if (this._rowShown(row)) out.push(row);
    return out;
  }

  _menuCommand(cmd) {
    const r = this._selRange();
    const span = r.e.row - r.s.row + 1;
    const shownRows = this._viewRows ? this._shownRowsIn(r) : null;
    // Insert as many rows as the user can SEE selected; deleting a span that contains
    // hidden rows is refused outright, because one contiguous delete cannot skip them and
    // silently destroying filtered-out data is the worst outcome available here.
    const rowCount = shownRows ? Math.max(1, shownRows.length) : span;
    const hidesRows = !!shownRows && shownRows.length !== span;
    const colCount = r.e.col - r.s.col + 1;
    switch (cmd) {
      case 'insertRowAbove':
        this._structural({ kind: 'insertRow', index: r.s.row, count: rowCount });
        break;
      case 'insertRowBelow':
        this._structural({ kind: 'insertRow', index: r.e.row + 1, count: rowCount });
        break;
      case 'insertColLeft':
        this._structural({ kind: 'insertCol', index: r.s.col, count: colCount });
        break;
      case 'insertColRight':
        this._structural({ kind: 'insertCol', index: r.e.col + 1, count: colCount });
        break;
      case 'deleteRow':
        if (hidesRows) {
          this.onNotice('선택 범위에 필터로 숨겨진 행이 있어 삭제할 수 없습니다. 필터를 끄고 삭제하세요.', 'error');
          break;
        }
        this._structural({ kind: 'deleteRow', index: r.s.row, count: rowCount });
        break;
      case 'deleteCol':
        this._structural({ kind: 'deleteCol', index: r.s.col, count: colCount });
        break;
      case 'clear':
        this._clearContents();
        break;
      case 'mergeAll':
        this.requestMerge('all');
        break;
      case 'mergeNone':
        this.requestMerge('none');
        break;
      default:
        break;
    }
  }

  /**
   * Ask the host to merge (or unmerge) the current selection — SPEC 21.4.
   *
   * The grid deliberately does not touch sheet.merges itself: a merge is an `edit` frame
   * clearing the covered cells plus a `meta` frame carrying the new list, and both the
   * history stack and the socket belong to the host. It applies them and calls render(),
   * which rebuilds the merge index.
   *
   * @param {'all'|'horizontal'|'vertical'|'none'} mode
   */
  requestMerge(mode) {
    const r = this._selRange();
    const rect = {
      r1: r.s.row,
      c1: r.s.col,
      r2: r.e.row,
      c2: r.e.col,
      s: { row: r.s.row, col: r.s.col },
      e: { row: r.e.row, col: r.e.col },
    };
    try {
      this.onMerge(mode === 'none' ? 'none' : mode || 'all', rect);
    } catch (e) {
      console.error('Grid onMerge failed', e);
    }
  }

  /* ------------------------------------------------------ structural edits */

  /** Shift colWidths / rowHeights / freeze counts / merges to match a structural edit. */
  _shiftSizeMap(edit) {
    // Merged rectangles move, grow and disappear with the band, exactly as the server
    // will compute it on its own copy (SPEC 21.3). Doing it locally too keeps the view
    // correct in the moment between the edit and the server's full-document answer.
    if (Array.isArray(this.sheet.merges) && this.sheet.merges.length) {
      this.sheet.merges = shiftMerges(this.sheet.merges, edit, this.sheet.rows, this.sheet.cols);
    }
    // The batch-C state moves with the band for the same reason (SPEC 24.1 / 24.2 /
    // 24.3): the server recomputes all of it on its own copy and resends the whole
    // document, but until that answer arrives the view has to stay honest — a filter
    // range, a chart's source range and a comment's cell all follow the rows they
    // describe, and a comment on a deleted row disappears with it.
    const rows = this.sheet.rows;
    const cols = this.sheet.cols;
    if (this.sheet.filter) {
      this.sheet.filter = shiftFilter(this.sheet.filter, edit, rows, cols);
    }
    if (Array.isArray(this.sheet.charts) && this.sheet.charts.length) {
      this.sheet.charts = shiftCharts(this.sheet.charts, edit, rows, cols);
    }
    if (this.sheet.comments && Object.keys(this.sheet.comments).length) {
      this.sheet.comments = shiftComments(this.sheet.comments, edit, rows, cols);
    }
    const isRow = edit.kind === 'insertRow' || edit.kind === 'deleteRow';
    const insert = edit.kind === 'insertRow' || edit.kind === 'insertCol';
    const src = (isRow ? this.sheet.rowHeights : this.sheet.colWidths) || {};
    const out = {};
    for (const key of Object.keys(src)) {
      const i = Number(key);
      if (!Number.isFinite(i)) continue;
      if (insert) {
        out[String(i >= edit.index ? i + edit.count : i)] = src[key];
      } else if (i < edit.index) {
        out[key] = src[key];
      } else if (i >= edit.index + edit.count) {
        out[String(i - edit.count)] = src[key];
      }
    }
    if (isRow) {
      this.sheet.rowHeights = out;
      const fr = Number(this.sheet.frozenRows) || 0;
      if (edit.index < fr) this.sheet.frozenRows = Math.max(0, fr + (insert ? edit.count : -edit.count));
    } else {
      this.sheet.colWidths = out;
      const fc = Number(this.sheet.frozenCols) || 0;
      if (edit.index < fc) this.sheet.frozenCols = Math.max(0, fc + (insert ? edit.count : -edit.count));
    }
  }

  /** Apply locally first, then tell the host (which forwards it to the server). */
  _structural(edit) {
    if (!edit || !edit.count || edit.count < 1) return;
    let snap = null;
    try {
      snap = this.engine.applyStructuralEdit(edit);
    } catch (e) {
      console.error('Grid applyStructuralEdit failed', e);
      return;
    }
    if (snap) {
      if (Number.isFinite(snap.rows)) this.sheet.rows = snap.rows;
      if (Number.isFinite(snap.cols)) this.sheet.cols = snap.cols;
      if (snap.cells) this.sheet.cells = snap.cells;
    }
    this._shiftSizeMap(edit);
    // Every chart's data moved even when its own range did not, so they all redraw once.
    this._chartGen++;
    try {
      this.onStructural(edit);
    } catch (e) {
      console.error('Grid onStructural failed', e);
    }
    this._cells.forEach((node) => node.remove());
    this._cells.clear();
    this.render();
    this._emitCursor();
  }

  /* ---------------------------------------------------------- peer cursors */

  setPeerCursors(peers) {
    this._peers = Array.isArray(peers) ? peers.slice() : [];
    this._renderPeers();
  }

  _renderPeers() {
    for (const el of this._peerEls) el.remove();
    this._peerEls.length = 0;
    if (!this._peers.length || this._destroyed) return;
    const ow = this._overlay.clientWidth;
    const oh = this._overlay.clientHeight;

    for (const peer of this._peers) {
      if (!peer || !peer.active) continue;
      const color = typeof peer.color === 'string' && peer.color ? peer.color : '#888888';
      const tint = /^#[0-9a-f]{6}$/i.test(color) ? color + '22' : 'transparent';

      // selected range (drawn under the active-cell outline)
      const range = peer.range;
      if (range && range.s && range.e) {
        // A peer's rectangle obeys the same merge rule as ours, so it is drawn grown.
        const r = this._expandOver(normRange({ s: range.s, e: range.e }));
        const multi = r.s.row !== r.e.row || r.s.col !== r.e.col;
        // A rectangle whose first or last row the filter hides has no band to draw
        // (SPEC 24.1); the peer's active-cell outline below is skipped the same way.
        const shown = this._rowShown(r.s.row) && this._rowShown(r.e.row);
        if (multi && shown && r.e.row < this.rows && r.e.col < this.cols) {
          const x0 = this._ox(r.s.col);
          const y0 = this._oy(r.s.row);
          const x1 = this._ox(r.e.col) + this._colW(r.e.col);
          const y1 = this._oy(r.e.row) + this._rowH(r.e.row);
          if (x1 > 0 && y1 > 0 && x0 < ow && y0 < oh) {
            const box = div('sz-peer-cursor');
            css(box, {
              position: 'absolute',
              left: x0 + 'px',
              top: y0 + 'px',
              width: Math.max(0, x1 - x0) + 'px',
              height: Math.max(0, y1 - y0) + 'px',
              outline: '1px solid ' + color,
              outlineOffset: '-1px',
              background: tint,
              pointerEvents: 'none',
            });
            this._overlay.appendChild(box);
            this._peerEls.push(box);
          }
        }
      }

      let cell;
      try {
        cell = a1ToCell(peer.active);
      } catch {
        continue;
      }
      if (cell.row >= this.rows || cell.col >= this.cols) continue;
      // A remote cursor on a merged rectangle outlines the whole rectangle.
      const pm = this._hasMerges ? this._mergeCoverAt(cell.row, cell.col) : null;
      const prow = pm ? pm.r1 : cell.row;
      const pcol = pm ? pm.c1 : cell.col;
      if (!this._rowShown(prow)) continue;
      const x = this._ox(pcol);
      const y = this._oy(prow);
      const w = pm ? pm.w : this._colW(pcol);
      const h = pm ? pm.h : this._rowH(prow);
      if (x + w <= 0 || y + h <= 0 || x >= ow || y >= oh) continue;

      const el = div('sz-peer-cursor');
      css(el, {
        position: 'absolute',
        left: x + 'px',
        top: y + 'px',
        width: w + 'px',
        height: h + 'px',
        outline: '2px solid ' + color,
        outlineOffset: '-2px',
        pointerEvents: 'none',
      });
      const label = div('sz-peer-label');
      label.textContent = peer.name || '익명';
      css(label, {
        position: 'absolute',
        left: '100%',
        bottom: '100%',
        transform: 'translateX(-100%)',
        background: color,
        color: '#ffffff',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      });
      el.appendChild(label);
      this._overlay.appendChild(el);
      this._peerEls.push(el);
    }
  }

  /* --------------------------------------------------------- charts (24.2) */

  /**
   * Sync `.sz-chart-layer` with `sheet.charts`.
   *
   * Position and size are written on every pass (a few style assignments per chart, and
   * a sheet has at most MAX_CHARTS of them); the DRAWING is redone only when something
   * that changes the picture changed — the geometry, the type, the range, the title, the
   * header flags, the legend position, or the zoom. Cell edits come in through
   * `refreshCells` instead, which redraws only the charts whose own range was touched.
   *
   * Charts live inside the scrolling viewport, so scrolling needs no work here at all.
   */
  _renderCharts() {
    if (this._destroyed || !this._chartLayer) return;
    const list = this.sheet && Array.isArray(this.sheet.charts) ? this.sheet.charts : null;
    this._chartSrc = this.sheet ? this.sheet.charts : null;
    if (!list || !list.length) {
      if (this._chartEls.size) this._clearCharts();
      return;
    }
    const seen = new Set();
    for (const chart of list) {
      if (!chart || typeof chart !== 'object') continue;
      const id = typeof chart.id === 'string' && chart.id ? chart.id : '';
      if (!id || seen.has(id)) continue;
      const rect = mergeRect(chart.range);
      if (!rect) continue; // a chart with no readable range has nothing to draw
      seen.add(id);
      let entry = this._chartEls.get(id);
      if (!entry) {
        entry = this._makeChart(id);
        this._chartEls.set(id, entry);
      }
      entry.chart = chart;
      entry.rect = rect;
      this._placeChart(entry, chart.x, chart.y, chart.w, chart.h);
      const sig = this._chartSig(chart);
      if (entry.sig !== sig) {
        entry.sig = sig;
        this._drawChart(entry);
      }
    }
    for (const [id, entry] of this._chartEls) {
      if (seen.has(id)) continue;
      entry.svg.remove();
      entry.handle.remove();
      this._chartEls.delete(id);
    }
  }

  _makeChart(id) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sz-chart');
    // The layer is pointer-transparent, so a chart takes clicks only over its own box:
    // a click that misses every chart reaches the cell underneath (SPEC 24.2).
    css(svg, { position: 'absolute', overflow: 'hidden', pointerEvents: 'auto', cursor: 'move' });
    svg.__chartId = id;
    // The grip is a SIBLING of the <svg>, never a child: renderChart owns the svg's
    // children and would wipe a handle placed inside it on the next redraw.
    const handle = div('sz-chart-handle');
    css(handle, {
      position: 'absolute',
      pointerEvents: 'auto',
      cursor: 'nwse-resize',
      // Same contract as the comment mark: geometry is ours, the look is the
      // stylesheet's, and the fallback keeps the grip visible until it names one.
      background: 'var(--sz-chart-handle,#1a73e8)',
    });
    handle.__chartId = id;
    this._chartLayer.appendChild(svg);
    this._chartLayer.appendChild(handle);
    return { id, svg, handle, chart: null, rect: null, sig: '' };
  }

  _clearCharts() {
    for (const entry of this._chartEls.values()) {
      entry.svg.remove();
      entry.handle.remove();
    }
    this._chartEls.clear();
  }

  /**
   * Everything that changes the drawing. Geometry is in it because the layout is, and
   * the fields are joined with a character no title can hold, so two different charts
   * can never produce the same signature by running their fields together.
   */
  _chartSig(chart) {
    return [
      chart.type,
      chart.range,
      chart.title,
      chart.headerRow ? 1 : 0,
      chart.headerCol ? 1 : 0,
      chart.legend,
      this._chartW(chart.w),
      this._chartH(chart.h),
      this._zoom,
      this._chartGen,
    ].map(String).join(SIG_SEP);
  }

  _chartX(v) {
    const n = Number(v);
    return clamp(Number.isFinite(n) ? Math.round(n) : 0, 0, MAX_CHART_POS);
  }

  _chartW(v) {
    const n = Number(v);
    return clamp(Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_CHART_W, MIN_CHART_SIZE, MAX_CHART_SIZE);
  }

  _chartH(v) {
    const n = Number(v);
    return clamp(Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_CHART_H, MIN_CHART_SIZE, MAX_CHART_SIZE);
  }

  /**
   * Place one chart, in SHEET pixels run through `_z` (SPEC 24.2): it therefore follows
   * the zoom, and because the layer shares the cells layer's coordinate space it also
   * scrolls with the grid for free. `x`/`y`/`w`/`h` are document pixels, exactly like
   * colWidths — a chart's position never depends on the viewer's zoom.
   */
  _placeChart(entry, x, y, w, h) {
    const px = this._z(this._chartX(x)) - this._fw;
    const py = this._z(this._chartX(y)) - this._fh;
    const pw = Math.max(1, this._z(this._chartW(w)));
    const ph = Math.max(1, this._z(this._chartH(h)));
    const s = entry.svg.style;
    s.left = px + 'px';
    s.top = py + 'px';
    s.width = pw + 'px';
    s.height = ph + 'px';
    const g = entry.handle.style;
    g.left = px + pw - CHART_HANDLE + 'px';
    g.top = py + ph - CHART_HANDLE + 'px';
    g.width = CHART_HANDLE + 'px';
    g.height = CHART_HANDLE + 'px';
  }

  /** Draw (or redraw) one chart's contents from the sheet's current values. */
  _drawChart(entry) {
    const chart = entry.chart;
    if (!chart) return;
    const w = this._chartW(chart.w);
    const h = this._chartH(chart.h);
    try {
      const data = chartSeries((this.sheet && this.sheet.cells) || {}, chart, this._valueOf);
      renderChart(entry.svg, chart, data);
    } catch (e) {
      // One unusable chart must never take the grid's render pass down with it.
      console.error('Grid renderChart failed', e);
    }
    // The svg is SIZED in screen pixels but DRAWN in document pixels, so it needs a
    // viewBox to scale with the zoom. renderChart normally sets one; this only fills in
    // the gap, and never overwrites a viewBox the renderer chose for itself.
    if (!entry.svg.getAttribute('viewBox')) {
      entry.svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    }
  }

  /**
   * Redraw the charts an edit actually reached (SPEC 24.2). `keys` is the changed-key set
   * the host already hands `refreshCells`, so nothing new has to be tracked to know that
   * a cell inside a chart's range moved.
   */
  _chartsAfterEdit(keys) {
    const cells = [];
    for (const key of keys) {
      try {
        const c = a1ToCell(key);
        cells.push(c);
      } catch {
        // not a cell key: ignore
      }
    }
    if (!cells.length) return;
    for (const entry of this._chartEls.values()) {
      const r = entry.rect;
      if (!r) continue;
      for (const c of cells) {
        if (c.row >= r.r1 && c.row <= r.r2 && c.col >= r.c1 && c.col <= r.c2) {
          this._drawChart(entry);
          break;
        }
      }
    }
  }

  /** Start a chart move / resize drag from a mousedown on its box or its grip. */
  _startChartDrag(id, kind, e) {
    const entry = this._chartEls.get(id);
    if (!entry || !entry.chart) return false;
    const chart = entry.chart;
    this._drag = {
      kind,
      entry,
      startX: e.clientX,
      startY: e.clientY,
      x: this._chartX(chart.x),
      y: this._chartX(chart.y),
      w: this._chartW(chart.w),
      h: this._chartH(chart.h),
      moved: false,
    };
    return true;
  }

  /** Live geometry while a chart is being dragged. Document pixels, like a resize. */
  _moveChartDrag(e) {
    const d = this._drag;
    if (!d || !d.entry) return;
    const dx = (e.clientX - d.startX) / this._zoom;
    const dy = (e.clientY - d.startY) / this._zoom;
    if (dx || dy) d.moved = true;
    // d.x/d.y/d.w/d.h are the geometry as it was when the gesture started, so the drag
    // is always measured from one fixed origin and never accumulates rounding.
    if (d.kind === 'chartmove') {
      d.nx = clamp(Math.round(d.x + dx), 0, MAX_CHART_POS);
      d.ny = clamp(Math.round(d.y + dy), 0, MAX_CHART_POS);
      this._placeChart(d.entry, d.nx, d.ny, d.w, d.h);
      return;
    }
    d.nw = clamp(Math.round(d.w + dx), MIN_CHART_SIZE, MAX_CHART_SIZE);
    d.nh = clamp(Math.round(d.h + dy), MIN_CHART_SIZE, MAX_CHART_SIZE);
    this._placeChart(d.entry, d.x, d.y, d.nw, d.nh);
  }

  /**
   * Commit a chart drag: write the new geometry onto the sheet's own chart object (so the
   * view is right immediately), redraw it at its new size, and report it ONCE. The grid
   * never sends anything itself — the host owns the history stack and the socket, exactly
   * as it does for merges.
   */
  _finishChartDrag(d) {
    const entry = d.entry;
    if (!entry || !entry.chart) return;
    const chart = entry.chart;
    if (!d.moved) {
      this._placeChart(entry, chart.x, chart.y, chart.w, chart.h);
      return;
    }
    if (d.kind === 'chartmove') {
      chart.x = d.nx === undefined ? this._chartX(chart.x) : d.nx;
      chart.y = d.ny === undefined ? this._chartX(chart.y) : d.ny;
    } else {
      chart.w = d.nw === undefined ? this._chartW(chart.w) : d.nw;
      chart.h = d.nh === undefined ? this._chartH(chart.h) : d.nh;
    }
    this._placeChart(entry, chart.x, chart.y, chart.w, chart.h);
    const sig = this._chartSig(chart);
    if (entry.sig !== sig) {
      entry.sig = sig;
      this._drawChart(entry); // a resized chart re-lays out, it does not merely stretch
    }
    try {
      this.onChartChange(Object.assign({}, chart));
    } catch (e) {
      console.error('Grid onChartChange failed', e);
    }
  }

  /* -------------------------------------------------------------- teardown */

  destroy() {
    if (this._destroyed) return;
    this._closeMenu();
    this._stopAutoScroll();
    this._destroyed = true;
    if (typeof this._raf === 'function') this._raf();
    this._raf = 0;
    for (const l of this._listeners) {
      l.target.removeEventListener(l.type, l.handler, l.opts);
    }
    this._listeners.length = 0;
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    for (const el of this._peerEls) el.remove();
    this._peerEls.length = 0;
    this._peers.length = 0;
    this._cells.clear();
    this._colHeads.clear();
    this._rowHeads.clear();
    this._pool.length = 0;
    this._editing = null;
    this._hasMerges = false;
    this._mergeSrc = null;
    this._mergeKeys = NO_KEYS;
    this._mergeRects = NO_RECTS;
    this._mergeCover = EMPTY_MAP;
    this._mergeAnchors = EMPTY_MAP;
    this._mergeBigKeys = NO_KEYS;
    this._mergeByKey = EMPTY_MAP;
    this._selCache = null;
    this._clearCharts();
    this._viewRows = null;
    this._rowView = null;
    this._filterSrc = null;
    this._filterRect = null;
    this._comments = null;
    this._hasComments = false;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}
