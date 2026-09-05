// chart.js — SPEC 24.2 차트. One chart, drawn as inline SVG, with no library.
//
// WHY THIS SHAPE. The project has no build step, so a charting library is not an option:
// every mark here is an SVG element created with createElementNS and appended to the
// <svg> the caller owns. That also keeps the feature honest about its cost — a render is
// synchronous and allocates one fragment, because it runs every time a cell inside the
// chart's range changes.
//
// The module is split in two halves that never touch each other's world:
//
//   chartSeries(cells, chart, valueOf)  PURE data extraction. No DOM at all, not even at
//                                       import time, so it can be exercised in Node.
//   renderChart(svgEl, chart, data)     Drawing only. It never reads the document model;
//                                       everything it paints comes from `data`.
//
// That seam is what makes the two independently testable, and it is why a chart can be
// re-rendered on a resize without re-reading a single cell.
//
// SECURITY. A chart title and every series / category label are user-supplied text that
// arrives over the wire from another collaborator. Every one of them reaches the SVG
// through `node.textContent`, never through innerHTML and never as markup, so a label
// holding `<script>` renders as those eight characters. No string from the document is
// ever used as an attribute name, an element name, a colour, or a URL.
//
// THEME. Colours are read from CSS custom properties (--sz-chart-1 .. --sz-chart-10 plus
// the surface / text / line tokens) so a chart follows light and dark mode with no
// JavaScript involvement. getComputedStyle is called ONCE per render — it forces style
// resolution, and calling it per element would turn a 200-mark chart into 200 reflows.
//
// LEGIBILITY. Type sizes, padding, tick counts and label thinning are all derived from the
// measured pixel box, so the same code produces a readable chart at 200x120 and at
// 1200x800. Nothing is hard-coded to one size.

import { parseRange, normalizeRange, cellToA1 } from '/shared/formula/refs.js';

// ---------------------------------------------------------------- constants

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The picker's list. `id` matches sheet.charts[].type exactly (SPEC 24.2). */
export const CHART_TYPES = Object.freeze([
  Object.freeze({ id: 'column', label: '세로 막대' }),
  Object.freeze({ id: 'bar', label: '가로 막대' }),
  Object.freeze({ id: 'line', label: '꺾은선' }),
  Object.freeze({ id: 'area', label: '영역' }),
  Object.freeze({ id: 'pie', label: '원형' }),
  Object.freeze({ id: 'scatter', label: '분산형' }),
]);

const TYPE_SET = new Set(CHART_TYPES.map((t) => t.id));
const DEFAULT_TYPE = 'column';

const LEGEND_SET = new Set(['right', 'bottom', 'none']);
const DEFAULT_LEGEND = 'right';

/** Types whose value axis must contain zero, so bar/area geometry has a real baseline. */
const ZERO_BASED = new Set(['column', 'bar', 'area']);

// Extraction caps. A chart range may legally span a whole column (5000 rows), and a chart
// with thousands of categories is unreadable long before it is slow — but the render must
// stay bounded either way, so the data step truncates rather than the paint step.
const MAX_POINTS = 2000;
const MAX_SERIES = 30;
const MAX_LABEL_LEN = 200;

// Pixel bounds for the drawing box, mirroring MIN/MAX_CHART_SIZE in shared/model.js.
const DEFAULT_W = 480;
const DEFAULT_H = 300;
const MIN_PX = 40;
const MAX_PX = 4000;

// Markers cost one element per point, so they are only drawn while they still read as
// individual observations.
const MAX_MARKER_POINTS = 60;

const MSG_NO_DATA = '표시할 데이터가 없습니다';
const MSG_PIE_POSITIVE = '원형 차트는 양수 값만 표시합니다';
const SERIES_FALLBACK = '계열 ';

/**
 * Fallback palette, used for any --sz-chart-N the stylesheet does not define. These are
 * chosen to stay distinguishable on both a white and a near-black ground, so a chart is
 * never unreadable just because the theme tokens are missing.
 */
const FALLBACK_PALETTE = Object.freeze([
  '#1a73e8', '#e8710a', '#1e8e3e', '#d93025', '#9334e6',
  '#12b5cb', '#e52592', '#f9ab00', '#3949ab', '#00897b',
]);

const FALLBACK_TEXT = '#1f2328';
const FALLBACK_MUTED = '#5f6368';
const FALLBACK_LINE = '#e0e0e0';
const FALLBACK_LINE_STRONG = '#c8ced6';
const FALLBACK_SURFACE = '#ffffff';
const FALLBACK_ON_COLOR = '#ffffff';

// A plain numeric literal, deliberately the same shape the engine accepts: no hex, no
// currency symbol, no locale digits.
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
// A thousands-grouped number, e.g. "1,234" or "-12,345.60". Accepted because a pasted
// report is full of them and treating them as text would silently blank a whole series.
const GROUPED_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

// ============================================================================
// Data extraction — pure, DOM-free, importable in Node.
// ============================================================================

/** Duck-typed FormulaError check (avoids instanceof across module copies). */
function isFormulaError(v) {
  return !!v && typeof v === 'object' && typeof v.code === 'string' && v.code.charAt(0) === '#';
}

/** Duck-typed RangeValue check. */
function isRangeValue(v) {
  return !!v && typeof v === 'object' && Array.isArray(v.rows);
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Shortest round-trip text for a number; never yields "-0". */
function numText(n) {
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0';
  return String(n);
}

/**
 * One cell value -> its label text. Errors show their code (a chart that silently drops
 * a #DIV/0! category would be lying about the data), blanks become ''.
 */
function labelOf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > MAX_LABEL_LEN ? v.slice(0, MAX_LABEL_LEN) : v;
  if (typeof v === 'number') return numText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (isFormulaError(v)) return v.code;
  if (isRangeValue(v)) {
    const first = v.rows.length && Array.isArray(v.rows[0]) ? v.rows[0][0] : null;
    return labelOf(first === undefined ? null : first);
  }
  return '';
}

/**
 * One cell value -> a plottable number, or null for a GAP.
 *
 * Returning null rather than 0 is the whole point (SPEC 24.2): a blank cell in the middle
 * of a line must break the line, not drag it down to the axis. Booleans, errors and text
 * that is not a number are gaps for the same reason.
 */
function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    if (NUMERIC_RE.test(t)) {
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    if (GROUPED_RE.test(t)) {
      const n = Number(t.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  if (isRangeValue(v)) {
    const first = v.rows.length && Array.isArray(v.rows[0]) ? v.rows[0][0] : null;
    return first === undefined || isRangeValue(first) ? null : numberOf(first);
  }
  return null;
}

/**
 * Build the `valueOf(row, col)` used to read the range.
 *
 * The injected reader (the grid passes the engine's computed lookup) is wrapped so a
 * throw from foreign code can never escape this module. Without one, the raw `cells` map
 * is read and its inputs are interpreted the way a literal would be — which is what lets
 * `chartSeries(cells, chart)` work with nothing but a document, exactly as the sibling
 * filter helpers in shared/model.js do.
 */
function valueReader(cells, valueOf) {
  if (typeof valueOf === 'function') {
    return (row, col) => {
      try {
        const v = valueOf(row, col);
        return v === undefined ? null : v;
      } catch {
        return null;
      }
    };
  }
  const map = cells && typeof cells === 'object' && !Array.isArray(cells) ? cells : null;
  if (!map) return () => null;
  return (row, col) => {
    const entry = map[cellToA1(row, col)];
    if (!entry || typeof entry !== 'object') return null;
    const input = entry.input;
    if (typeof input !== 'string' || input === '') return null;
    if (input.charCodeAt(0) === 61) return input; // '=' — a formula, uncomputable here
    const t = input.trim();
    if (t && (NUMERIC_RE.test(t) || GROUPED_RE.test(t))) {
      const n = Number(t.replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
    const upper = t.toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;
    return input;
  };
}

/** chart.range -> {r1,c1,r2,c2}, or null when it cannot be parsed. */
function chartRect(chart) {
  if (!chart || typeof chart.range !== 'string' || !chart.range) return null;
  let r;
  try {
    r = normalizeRange(parseRange(chart.range));
  } catch {
    return null;
  }
  return { r1: r.s.row, c1: r.s.col, r2: r.e.row, c2: r.e.col };
}

/**
 * Read a chart's range and split it into category labels and named series (SPEC 24.2).
 *
 * Layout: series run down COLUMNS. Each row of the range is one category, each column one
 * series — the arrangement a spreadsheet user already has on screen when they select a
 * table with headers across the top and labels down the left.
 *
 *   headerRow  the range's first ROW holds the series names
 *   headerCol  the range's first COLUMN holds the category labels
 *
 * With `headerCol` off the categories are just 1..n. With `headerRow` off (or a blank
 * header cell) a series is named `계열 N`, because a nameless entry in a legend tells the
 * reader nothing.
 *
 * Every value goes through `numberOf`, so a non-numeric cell becomes `null` — a GAP, not
 * a zero.
 *
 *   chartSeries(cells, { range:'A1:C3', headerRow:true, headerCol:true }, valueOf)
 *     -> { categories:['1월','2월'],
 *          categoryNumbers:[null,null],
 *          series:[{ name:'매출', values:[10,20] }, { name:'비용', values:[3,null] }] }
 *
 * `categoryNumbers` is the numeric reading of the same category cells; the scatter plot
 * uses it as its X axis and falls back to 1..n when a category is not a number. NEVER
 * throws: an unparseable range or a hostile `chart` yields empty arrays.
 *
 * @param {Record<string, {input?: string}>} cells  the sheet's cell map (fallback reader)
 * @param {{range:string, headerRow?:boolean, headerCol?:boolean}} chart
 * @param {(row:number, col:number)=>any} [valueOf]  computed-value reader
 * @returns {{categories: string[], categoryNumbers: (number|null)[],
 *            series: {name:string, values:(number|null)[]}[]}}
 */
export function chartSeries(cells, chart, valueOf) {
  const rect = chartRect(chart);
  if (!rect) return { categories: [], categoryNumbers: [], series: [] };

  const read = valueReader(cells, valueOf);
  const headerRow = !!(chart && chart.headerRow);
  const headerCol = !!(chart && chart.headerCol);

  const firstRow = rect.r1 + (headerRow ? 1 : 0);
  const firstCol = rect.c1 + (headerCol ? 1 : 0);
  if (firstRow > rect.r2 || firstCol > rect.c2) {
    return { categories: [], categoryNumbers: [], series: [] };
  }

  const rowCount = Math.min(rect.r2 - firstRow + 1, MAX_POINTS);
  const colCount = Math.min(rect.c2 - firstCol + 1, MAX_SERIES);

  const categories = new Array(rowCount);
  const categoryNumbers = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    if (headerCol) {
      const v = read(firstRow + i, rect.c1);
      categories[i] = labelOf(v);
      categoryNumbers[i] = numberOf(v);
    } else {
      categories[i] = String(i + 1);
      categoryNumbers[i] = i + 1;
    }
  }

  const series = new Array(colCount);
  for (let j = 0; j < colCount; j++) {
    const col = firstCol + j;
    let name = headerRow ? labelOf(read(rect.r1, col)) : '';
    if (!name) name = SERIES_FALLBACK + (j + 1);
    const values = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) values[i] = numberOf(read(firstRow + i, col));
    series[j] = { name, values };
  }

  return { categories, categoryNumbers, series };
}

// ============================================================================
// Scales, ticks and text metrics — pure maths, shared by every chart type.
// ============================================================================

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Snap a coordinate so a 1px stroke lands on a device pixel instead of straddling two. */
function crisp(v) {
  return Math.round(v) + 0.5;
}

/**
 * The nice-number step from Heckbert's axis algorithm: 1, 2, 5 or 10 x 10^n.
 * `round` picks the nearest such number; otherwise the smallest one that is >= x.
 */
function niceNum(x, round) {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const exp = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, exp);
  let nf;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  const r = nf * Math.pow(10, exp);
  // Math.pow(10, exp) underflows to 0 below ~1e-324 and overflows above ~1e308, either
  // of which turns the "nice" step into 0 or Infinity and poisons every coordinate
  // derived from it. Fall back to the raw magnitude, which is at least usable.
  return Number.isFinite(r) && r > 0 ? r : x;
}

/**
 * A value-axis domain with a nice step (SPEC 24.2).
 * Both ends are pushed outwards onto a multiple of the step, so the first and last
 * gridline are real numbers rather than whatever the data happened to reach.
 */
function niceScale(min, max, maxTicks) {
  // Clamped well inside the double range so `hi - lo` below cannot overflow to Infinity.
  // A spreadsheet can legitimately hold 1e308 and -1e308 in the same column; the axis
  // then has to stay a finite, drawable thing rather than produce NaN geometry.
  const LIMIT = Number.MAX_VALUE / 8;
  let lo = Number.isFinite(min) ? clamp(min, -LIMIT, LIMIT) : 0;
  let hi = Number.isFinite(max) ? clamp(max, -LIMIT, LIMIT) : 1;
  if (hi < lo) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  if (hi === lo) {
    // All values equal: give the single level room to breathe instead of dividing by zero.
    const pad = Math.abs(hi) * 0.5 || 1;
    lo -= pad;
    hi += pad;
  }
  const ticks = clamp(Math.round(maxTicks) || 2, 2, 12);
  const step = niceNum(niceNum(hi - lo, false) / (ticks - 1), true);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  // Last line of defence: if any of it came out non-finite or degenerate, fall back to
  // the raw domain with an even step. An ugly axis beats a chart of NaN coordinates or
  // one that silently renders nothing at all.
  if (!Number.isFinite(niceLo) || !Number.isFinite(niceHi) || !(step > 0)
      || !(niceHi > niceLo)) {
    const raw = (hi - lo) / (ticks - 1);
    return { min: lo, max: hi, step: Number.isFinite(raw) && raw > 0 ? raw : 1 };
  }
  return { min: niceLo, max: niceHi, step };
}

/** The tick values of a scale, with float dust snapped back onto the step grid. */
function tickValues(scale) {
  const out = [];
  const n = clamp(Math.round((scale.max - scale.min) / scale.step), 1, 40);
  for (let i = 0; i <= n; i++) {
    let v = scale.min + i * scale.step;
    const snapped = Math.round(v / scale.step) * scale.step;
    if (Math.abs(snapped - v) <= Math.abs(scale.step) * 1e-9) v = snapped;
    if (Math.abs(v) <= Math.abs(scale.step) * 1e-9) v = 0;
    out.push(v);
  }
  return out;
}

/** How many decimals a tick label needs to distinguish consecutive steps. */
function decimalsFor(step) {
  const s = Math.abs(step);
  if (!(s > 0) || !Number.isFinite(s)) return 0;
  const e = Math.floor(Math.log10(s) + 1e-9);
  return e >= 0 ? 0 : Math.min(6, -e);
}

/** Thousands separators, applied to the integer part only. */
function group(s) {
  const neg = s.charAt(0) === '-';
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const int = dot < 0 ? body : body.slice(0, dot);
  const frac = dot < 0 ? '' : body.slice(dot);
  return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + frac;
}

/** A tick label: grouped fixed decimals, or exponential when the magnitude is extreme. */
function tickText(v, step) {
  if (!Number.isFinite(v)) return '';
  const av = Math.abs(v);
  if (av !== 0 && (av >= 1e12 || av < 1e-6)) return v.toExponential(1);
  let s = v.toFixed(decimalsFor(step));
  if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1); // never render "-0"
  return group(s);
}

/**
 * Estimated text width in px, without touching the DOM.
 *
 * Measuring for real would mean a layout per label, which is exactly the cost this module
 * is trying to avoid. Hangul, Han and full-width forms are one em; everything else is
 * about half, which is accurate enough to lay out an axis and is only ever used to decide
 * how much room to reserve and where to truncate.
 */
function estTextWidth(str, fs) {
  let units = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    units += wide ? 1 : 0.53;
  }
  return units * fs;
}

/** Longest estimated width in a list of strings. */
function maxTextWidth(list, fs) {
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const t = estTextWidth(list[i], fs);
    if (t > w) w = t;
  }
  return w;
}

/** Cut a label to fit `maxPx`, appending an ellipsis. Returns '' when nothing fits. */
function truncate(str, fs, maxPx) {
  if (!str) return '';
  if (maxPx <= 0) return '';
  if (estTextWidth(str, fs) <= maxPx) return str;
  const ellW = estTextWidth('…', fs);
  if (ellW > maxPx) return '';
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = estTextWidth(ch, fs);
    if (w + cw + ellW > maxPx) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Show every Nth label so neighbours cannot collide. */
function thinStep(slotPx, needPx) {
  if (!(slotPx > 0)) return 1;
  return Math.max(1, Math.ceil(needPx / slotPx));
}

// ============================================================================
// SVG plumbing
// ============================================================================

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Create an SVG element, set its attributes and append it to the render fragment. */
function mk(ctx, name, attrs) {
  const node = ctx.doc.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const key in attrs) {
      const v = attrs[key];
      if (v === null || v === undefined || v === '') continue;
      node.setAttribute(key, typeof v === 'number' ? String(round2(v)) : String(v));
    }
  }
  ctx.frag.appendChild(node);
  return node;
}

/**
 * Append a <text> node. The string is installed with textContent, so a label containing
 * markup renders as its own characters — this is the ONLY way text enters the SVG.
 */
function label(ctx, str, x, y, fs, fill, anchor) {
  if (!str) return null;
  const node = mk(ctx, 'text', {
    x,
    y,
    'font-size': fs,
    fill,
    'text-anchor': anchor || 'start',
  });
  node.textContent = str;
  return node;
}

function line(ctx, x1, y1, x2, y2, stroke, width) {
  return mk(ctx, 'line', {
    x1,
    y1,
    x2,
    y2,
    stroke,
    'stroke-width': width || 1,
    'shape-rendering': 'crispEdges',
  });
}

// ============================================================================
// Theme
// ============================================================================

/**
 * Read every colour this render needs in ONE getComputedStyle call (SPEC 24.2).
 * A token the stylesheet does not define comes back as '', and the built-in fallback is
 * used instead, so a chart is never invisible because a variable is missing.
 */
function readTheme(el) {
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  let cs = null;
  try {
    if (view && typeof view.getComputedStyle === 'function') cs = view.getComputedStyle(el);
  } catch {
    cs = null;
  }
  const get = (name, fallback) => {
    if (!cs) return fallback;
    let v = '';
    try {
      v = cs.getPropertyValue(name);
    } catch {
      v = '';
    }
    const t = v ? v.trim() : '';
    return t || fallback;
  };
  const palette = new Array(FALLBACK_PALETTE.length);
  for (let i = 0; i < FALLBACK_PALETTE.length; i++) {
    palette[i] = get('--sz-chart-' + (i + 1), FALLBACK_PALETTE[i]);
  }
  return {
    palette,
    text: get('--sz-text', FALLBACK_TEXT),
    muted: get('--sz-text-muted', FALLBACK_MUTED),
    line: get('--sz-line', FALLBACK_LINE),
    lineStrong: get('--sz-line-strong', FALLBACK_LINE_STRONG),
    surface: get('--sz-surface', FALLBACK_SURFACE),
    onColor: get('--sz-on-color', FALLBACK_ON_COLOR),
  };
}

function colorAt(theme, i) {
  const p = theme.palette;
  return p[((i % p.length) + p.length) % p.length];
}

// ============================================================================
// Render-time normalization
// ============================================================================

/** Reduce a stored chart record to exactly the fields the renderer trusts. */
function normalizeChartSpec(chart) {
  const c = chart && typeof chart === 'object' ? chart : {};
  const type = typeof c.type === 'string' && TYPE_SET.has(c.type) ? c.type : DEFAULT_TYPE;
  const legend =
    typeof c.legend === 'string' && LEGEND_SET.has(c.legend) ? c.legend : DEFAULT_LEGEND;
  let title = typeof c.title === 'string' ? c.title.replace(/\s+/g, ' ').trim() : '';
  if (title.length > MAX_LABEL_LEN) title = title.slice(0, MAX_LABEL_LEN);
  const w = Number.isFinite(c.w) && c.w > 0 ? c.w : DEFAULT_W;
  const h = Number.isFinite(c.h) && c.h > 0 ? c.h : DEFAULT_H;
  return { type, legend, title, w, h };
}

/**
 * Accept whatever `data` the caller passed and hand back arrays with known shapes: same
 * length categories, numbers-or-null values, at most MAX_SERIES series. This is what lets
 * renderChart be called with hand-built data without a defensive check on every access.
 */
function normalizeData(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawCats = Array.isArray(src.categories) ? src.categories : [];
  const rawSeries = Array.isArray(src.series) ? src.series : [];

  // The point count is the longest of the category list and the series, so hand-built data
  // that omits `categories` still plots — the missing labels become 1..n.
  let n = rawCats.length;
  for (let j = 0; j < rawSeries.length && j < MAX_SERIES; j++) {
    const s = rawSeries[j];
    if (s && typeof s === 'object' && Array.isArray(s.values) && s.values.length > n) {
      n = s.values.length;
    }
  }
  n = Math.min(n, MAX_POINTS);

  const categories = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i >= rawCats.length) categories[i] = String(i + 1);
    else categories[i] = typeof rawCats[i] === 'string' ? rawCats[i] : labelOf(rawCats[i]);
  }

  const rawNums = Array.isArray(src.categoryNumbers) ? src.categoryNumbers : null;
  const categoryNumbers = new Array(n);
  for (let i = 0; i < n; i++) {
    if (rawNums) {
      categoryNumbers[i] = isFiniteNum(rawNums[i]) ? rawNums[i] : null;
    } else {
      categoryNumbers[i] = numberOf(categories[i]);
    }
  }

  const count = Math.min(rawSeries.length, MAX_SERIES);
  const series = [];
  for (let j = 0; j < count; j++) {
    const s = rawSeries[j] && typeof rawSeries[j] === 'object' ? rawSeries[j] : {};
    const vals = Array.isArray(s.values) ? s.values : [];
    const values = new Array(n);
    for (let i = 0; i < n; i++) values[i] = isFiniteNum(vals[i]) ? vals[i] : null;
    let name = typeof s.name === 'string' ? s.name : '';
    if (name.length > MAX_LABEL_LEN) name = name.slice(0, MAX_LABEL_LEN);
    if (!name) name = SERIES_FALLBACK + (j + 1);
    series.push({ name, values });
  }
  return { categories, categoryNumbers, series };
}

/** Does anything at all plot? A chart of pure gaps must say so, not draw empty axes. */
function hasAnyPoint(data) {
  if (!data.categories.length) return false;
  for (const s of data.series) {
    for (let i = 0; i < s.values.length; i++) if (s.values[i] !== null) return true;
  }
  return false;
}

/** Is this series entirely gaps? Such a series still gets a legend row, but no marks. */
function isAllGaps(series) {
  for (let i = 0; i < series.values.length; i++) if (series.values[i] !== null) return false;
  return true;
}

/**
 * Value domain over every series, forced to contain zero for the bar-like types and
 * guaranteed non-degenerate (min < max) whatever the data does.
 */
function domainOf(series, includeZero) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    const v = s.values;
    for (let i = 0; i < v.length; i++) {
      const n = v[i];
      if (n === null) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  if (min === Infinity) {
    min = 0;
    max = 1;
  }
  if (includeZero) {
    if (min > 0) min = 0;
    if (max < 0) max = 0;
  }
  if (min === max) {
    // Everything is the same number. Zero-based types keep their baseline at zero; the
    // others get a symmetric window so the flat line lands in the middle of the plot.
    if (includeZero) {
      max = min + 1;
    } else {
      const pad = Math.abs(min) * 0.5 || 1;
      min -= pad;
      max += pad;
    }
  }
  return { min, max };
}

/** Type sizes and paddings derived from the box, so 200x120 stays legible. */
function metrics(w, h) {
  const fs = clamp(Math.round(Math.min(w, h * 1.6) / 26), 9, 13);
  return {
    fs,
    titleFs: clamp(fs + 2, 10, 16),
    tickFs: clamp(fs - 1, 8, 12),
    pad: clamp(Math.round(fs * 0.7), 5, 12),
    gap: clamp(Math.round(fs * 0.4), 3, 6),
    swatch: clamp(Math.round(fs * 0.8), 8, 11),
  };
}

// ============================================================================
// renderChart
// ============================================================================

/**
 * Draw `data` into an existing `<svg>` (SPEC 24.2).
 *
 * The element is emptied and repainted from scratch: one document fragment is built and
 * appended once, so the browser lays out the chart a single time no matter how many marks
 * it contains. The viewBox is set to the element's MEASURED pixel box, which gives a 1:1
 * user-unit-to-pixel mapping (type stays exactly the size it was computed for) while still
 * letting the browser scale the finished drawing if the element is later resized without
 * a re-render.
 *
 * Degenerate inputs are all handled explicitly rather than by accident: no data, a single
 * point, every value identical, every value negative, and a series that is entirely gaps.
 * NEVER throws — a chart that cannot be drawn shows a Korean message inside its own frame.
 *
 * @param {SVGElement} svgEl        the <svg> to draw into (its children are replaced)
 * @param {object} chart            the stored chart record (type, title, legend, w, h)
 * @param {object} data             the output of chartSeries
 * @returns {void}
 */
export function renderChart(svgEl, chart, data) {
  if (!svgEl || typeof svgEl.appendChild !== 'function') return;
  const doc = svgEl.ownerDocument;
  if (!doc || typeof doc.createElementNS !== 'function') return;

  const spec = normalizeChartSpec(chart);
  const size = measure(svgEl, spec);

  clearNode(svgEl);
  svgEl.setAttribute('viewBox', '0 0 ' + size.w + ' ' + size.h);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svgEl.setAttribute('role', 'img');
  // Only supply a size when the caller has not: a chart laid out by CSS (the usual case in
  // the overlay layer) must keep its own box, and an <svg> with neither attribute nor rule
  // would otherwise collapse to the 300x150 replaced-element default.
  if (!svgEl.getAttribute('width') && !svgEl.getAttribute('height')) {
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
  }

  const ctx = {
    doc,
    frag: doc.createDocumentFragment(),
    w: size.w,
    h: size.h,
    theme: readTheme(svgEl),
    chart: spec,
  };

  if (spec.title) {
    const t = mk(ctx, 'title', null);
    t.textContent = spec.title;
  }

  paint(ctx, normalizeData(data));
  svgEl.appendChild(ctx.frag);
}

/** The drawing box: the element's real size, or the stored size when it has none. */
function measure(svgEl, spec) {
  let w = 0;
  let h = 0;
  try {
    if (typeof svgEl.getBoundingClientRect === 'function') {
      const r = svgEl.getBoundingClientRect();
      if (r) {
        w = r.width;
        h = r.height;
      }
    }
  } catch {
    w = 0;
    h = 0;
  }
  if (!(w > 1)) w = svgEl.clientWidth || 0;
  if (!(h > 1)) h = svgEl.clientHeight || 0;
  if (!(w > 1)) w = spec.w;
  if (!(h > 1)) h = spec.h;
  return {
    w: clamp(Math.round(w), MIN_PX, MAX_PX),
    h: clamp(Math.round(h), MIN_PX, MAX_PX),
  };
}

function paint(ctx, data) {
  const m = metrics(ctx.w, ctx.h);
  const theme = ctx.theme;

  mk(ctx, 'rect', { x: 0, y: 0, width: ctx.w, height: ctx.h, fill: theme.surface });

  let top = m.pad;
  if (ctx.chart.title) {
    const text = truncate(ctx.chart.title, m.titleFs, ctx.w - m.pad * 2);
    label(ctx, text, ctx.w / 2, top + m.titleFs, m.titleFs, theme.text, 'middle');
    top += m.titleFs + m.gap;
  }

  const area = {
    x: m.pad,
    y: top,
    w: ctx.w - m.pad * 2,
    h: ctx.h - top - m.pad,
  };
  if (area.w < 16 || area.h < 16) return;

  if (!hasAnyPoint(data)) {
    drawMessage(ctx, m, area, MSG_NO_DATA);
    return;
  }

  if (ctx.chart.type === 'pie') {
    drawPie(ctx, m, area, data);
    return;
  }

  const items = data.series.map((s, i) => ({ label: s.name, color: colorAt(theme, i) }));
  const plot = drawLegend(ctx, m, area, items);
  if (plot.w < 16 || plot.h < 16) return;

  if (ctx.chart.type === 'bar') drawBar(ctx, m, plot, data);
  else if (ctx.chart.type === 'scatter') drawScatter(ctx, m, plot, data);
  else drawVertical(ctx, m, plot, data, ctx.chart.type);
}

/** Centred explanatory text, used for every "there is nothing to draw" outcome. */
function drawMessage(ctx, m, area, msg) {
  const text = truncate(msg, m.fs, area.w);
  label(ctx, text, area.x + area.w / 2, area.y + area.h / 2 + m.fs * 0.35, m.fs,
    ctx.theme.muted, 'middle');
}

// ---------------------------------------------------------------- legend

/**
 * Draw the legend and return the rectangle left over for the plot.
 *
 * A 'right' legend on a narrow chart is demoted to 'bottom', and a legend that cannot fit
 * even one row is dropped entirely — at 200x120 the data matters more than the key. When
 * the entries do not all fit, the last slot becomes `외 N개` so nothing is silently lost.
 */
function drawLegend(ctx, m, area, items) {
  const pos = ctx.chart.legend;
  if (pos === 'none' || !items.length) return area;

  const rowH = Math.max(m.fs + 4, m.swatch + 4);
  const side = pos === 'right' && area.w >= 220 ? 'right' : 'bottom';

  if (side === 'right') {
    const maxW = Math.min(area.w * 0.4, 220);
    const textW = maxTextWidth(items.map((it) => it.label), m.fs);
    const boxW = clamp(Math.round(m.swatch + m.gap + textW + 2), 32, Math.round(maxW));
    const fit = Math.floor(area.h / rowH);
    if (fit < 1 || area.w - boxW < 60) return area;

    const shown = items.length <= fit ? items.length : Math.max(1, fit - 1);
    const rows = shown + (shown < items.length ? 1 : 0);
    const x = area.x + area.w - boxW;
    let y = area.y + Math.max(0, (area.h - rows * rowH) / 2);
    const textMax = boxW - m.swatch - m.gap - 2;

    for (let i = 0; i < shown; i++) {
      legendEntry(ctx, m, items[i], x, y, rowH, textMax);
      y += rowH;
    }
    if (shown < items.length) {
      label(ctx, '외 ' + (items.length - shown) + '개', x, y + rowH / 2 + m.fs * 0.35,
        m.fs, ctx.theme.muted, 'start');
    }
    return { x: area.x, y: area.y, w: area.w - boxW - m.gap, h: area.h };
  }

  // Bottom: flow entries left to right, wrapping, centred on each row.
  const gapX = m.gap * 2;
  const widths = items.map((it) =>
    Math.min(m.swatch + m.gap + estTextWidth(it.label, m.fs), area.w));
  const maxRows = Math.max(1, Math.floor((area.h * 0.34) / rowH));
  const rows = [];
  let row = [];
  let rowW = 0;
  for (let i = 0; i < items.length; i++) {
    const wNeed = widths[i] + (row.length ? gapX : 0);
    if (row.length && rowW + wNeed > area.w) {
      rows.push({ items: row, width: rowW });
      row = [];
      rowW = 0;
      if (rows.length >= maxRows) break;
    }
    row.push(i);
    rowW += row.length === 1 ? widths[i] : wNeed;
  }
  if (row.length && rows.length < maxRows) rows.push({ items: row, width: rowW });
  if (!rows.length) return area;

  // Count what actually made it into a row: a row dropped for want of vertical space is
  // still hidden, and the overflow chip has to admit to it.
  let used = 0;
  for (const r of rows) used += r.items.length;
  const hidden = items.length - used;

  const boxH = rows.length * rowH;
  if (area.h - boxH < 40) return area;

  let y = area.y + area.h - boxH;
  for (let r = 0; r < rows.length; r++) {
    const list = rows[r].items;
    let x = area.x + Math.max(0, (area.w - rows[r].width) / 2);
    for (let k = 0; k < list.length; k++) {
      const idx = list[k];
      const overflow = hidden > 0 && r === rows.length - 1 && k === list.length - 1;
      if (overflow) {
        label(ctx, '외 ' + (hidden + 1) + '개', x, y + rowH / 2 + m.fs * 0.35, m.fs,
          ctx.theme.muted, 'start');
      } else {
        legendEntry(ctx, m, items[idx], x, y, rowH, widths[idx] - m.swatch - m.gap);
      }
      x += widths[idx] + gapX;
    }
    y += rowH;
  }
  return { x: area.x, y: area.y, w: area.w, h: area.h - boxH - m.gap };
}

function legendEntry(ctx, m, item, x, y, rowH, textMax) {
  const sy = y + (rowH - m.swatch) / 2;
  mk(ctx, 'rect', {
    x,
    y: sy,
    width: m.swatch,
    height: m.swatch,
    rx: 2,
    fill: item.color,
  });
  const text = truncate(item.label, m.fs, textMax);
  label(ctx, text, x + m.swatch + m.gap, y + rowH / 2 + m.fs * 0.35, m.fs, ctx.theme.text);
}

// ---------------------------------------------------------------- axes

/** Map a value onto the vertical axis of `box`. */
function yAt(scale, box, v) {
  const span = scale.max - scale.min;
  if (!(span > 0)) return box.y + box.h / 2;
  const t = (clamp(v, scale.min, scale.max) - scale.min) / span;
  return box.y + box.h - t * box.h;
}

/** Map a value onto the horizontal axis of `box`. */
function xAt(scale, box, v) {
  const span = scale.max - scale.min;
  if (!(span > 0)) return box.x + box.w / 2;
  const t = (clamp(v, scale.min, scale.max) - scale.min) / span;
  return box.x + t * box.w;
}

/** Horizontal gridlines + left-hand value labels + tick marks. */
function drawValueAxisY(ctx, m, box, scale, ticks, labels) {
  const theme = ctx.theme;
  for (let i = 0; i < ticks.length; i++) {
    const y = crisp(yAt(scale, box, ticks[i]));
    const zero = ticks[i] === 0 && scale.min < 0 && scale.max > 0;
    line(ctx, box.x, y, box.x + box.w, y, zero ? theme.lineStrong : theme.line, 1);
    line(ctx, box.x - 3, y, box.x, y, theme.lineStrong, 1);
    label(ctx, labels[i], box.x - 5, y + m.tickFs * 0.35, m.tickFs, theme.muted, 'end');
  }
  line(ctx, crisp(box.x), box.y, crisp(box.x), box.y + box.h, theme.lineStrong, 1);
}

/** Vertical gridlines + bottom value labels + tick marks. */
function drawValueAxisX(ctx, m, box, scale, ticks, labels) {
  const theme = ctx.theme;
  const slot = box.w / Math.max(1, ticks.length - 1);
  const step = thinStep(slot, maxTextWidth(labels, m.tickFs) + 8);
  for (let i = 0; i < ticks.length; i++) {
    const x = crisp(xAt(scale, box, ticks[i]));
    const zero = ticks[i] === 0 && scale.min < 0 && scale.max > 0;
    line(ctx, x, box.y, x, box.y + box.h, zero ? theme.lineStrong : theme.line, 1);
    line(ctx, x, box.y + box.h, x, box.y + box.h + 3, theme.lineStrong, 1);
    if (i % step === 0) {
      label(ctx, labels[i], x, box.y + box.h + 3 + m.tickFs, m.tickFs, theme.muted, 'middle');
    }
  }
  line(ctx, box.x, crisp(box.y + box.h), box.x + box.w, crisp(box.y + box.h), theme.lineStrong, 1);
}

/** Category labels under a banded horizontal axis, thinned until they stop colliding. */
function drawCategoryAxisX(ctx, m, box, categories) {
  const n = categories.length;
  if (!n) return;
  const band = box.w / n;
  const step = thinStep(band, maxTextWidth(categories, m.tickFs) + 6);
  const maxW = band * step - 4;
  const y = box.y + box.h + 3 + m.tickFs;
  for (let i = 0; i < n; i += step) {
    const text = truncate(categories[i], m.tickFs, maxW);
    label(ctx, text, box.x + band * (i + 0.5), y, m.tickFs, ctx.theme.muted, 'middle');
  }
}

/** Category labels beside a banded vertical axis (the 가로 막대 case). */
function drawCategoryAxisY(ctx, m, box, categories, width) {
  const n = categories.length;
  if (!n) return;
  const band = box.h / n;
  const step = thinStep(band, m.tickFs + 3);
  for (let i = 0; i < n; i += step) {
    const text = truncate(categories[i], m.tickFs, width - 5);
    label(ctx, text, box.x - 5, box.y + band * (i + 0.5) + m.tickFs * 0.35, m.tickFs,
      ctx.theme.muted, 'end');
  }
}

// ---------------------------------------------------------------- column / line / area

/**
 * The three chart types that share a category X axis and a value Y axis.
 * `type` is 'column', 'line' or 'area'.
 */
function drawVertical(ctx, m, area, data, type) {
  const zeroBased = ZERO_BASED.has(type);
  const dom = domainOf(data.series, zeroBased);

  // Reserve the bottom band for category labels first, so the tick count is chosen
  // against the height the plot will really have.
  const catBand = m.tickFs + 6;
  const plotH = area.h - catBand;
  if (plotH < 16) return;

  const maxTicks = clamp(Math.floor(plotH / (m.tickFs * 2.4)), 2, 8);
  const scale = niceScale(dom.min, dom.max, maxTicks);
  const ticks = tickValues(scale);
  const labels = ticks.map((v) => tickText(v, scale.step));
  const axisW = Math.min(area.w * 0.42, maxTextWidth(labels, m.tickFs) + 8);

  const box = { x: area.x + axisW, y: area.y, w: area.w - axisW, h: plotH };
  if (box.w < 12 || box.h < 12) return;

  drawValueAxisY(ctx, m, box, scale, ticks, labels);
  // The category baseline is drawn after the gridlines so it is not overdrawn by the one
  // that happens to sit on it.
  line(ctx, box.x, crisp(box.y + box.h), box.x + box.w, crisp(box.y + box.h),
    ctx.theme.lineStrong, 1);
  drawCategoryAxisX(ctx, m, box, data.categories);

  if (type === 'column') drawColumns(ctx, box, data, scale);
  else drawLines(ctx, box, data, scale, type === 'area');
}

function drawColumns(ctx, box, data, scale) {
  const n = data.categories.length;
  const live = data.series.filter((s) => !isAllGaps(s));
  if (!n || !live.length) return;

  const band = box.w / n;
  const groupW = band * 0.78;
  const barW = groupW / live.length;
  const inner = barW > 3 ? barW - 1 : barW;
  const baseY = yAt(scale, box, clamp(0, scale.min, scale.max));

  let slot = 0;
  for (let j = 0; j < data.series.length; j++) {
    const s = data.series[j];
    if (isAllGaps(s)) continue; // an all-gap series keeps its legend row and nothing else
    const color = colorAt(ctx.theme, j);
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v === null) continue; // a gap draws no bar
      const y = yAt(scale, box, v);
      const h = Math.abs(y - baseY);
      if (h < 0.5) continue; // an exactly-zero value has no bar to draw
      const x = box.x + band * i + (band - groupW) / 2 + barW * slot;
      mk(ctx, 'rect', {
        x,
        y: Math.min(y, baseY),
        width: Math.max(inner, 0.5),
        height: h,
        fill: color,
      });
    }
    slot++;
  }
}

/**
 * Line and area. Each series is split into contiguous runs of real values: a gap ENDS a
 * run rather than being interpolated across, so a missing point leaves a hole instead of
 * pulling the line toward the axis. A run of exactly one point is drawn as a marker,
 * which is also what makes a single-point chart visible at all.
 */
function drawLines(ctx, box, data, scale, filled) {
  const n = data.categories.length;
  if (!n) return;
  const band = box.w / n;
  const baseY = yAt(scale, box, clamp(0, scale.min, scale.max));
  const markers = n <= MAX_MARKER_POINTS;

  for (let j = 0; j < data.series.length; j++) {
    const s = data.series[j];
    if (isAllGaps(s)) continue;
    const color = colorAt(ctx.theme, j);
    let run = [];

    const flush = () => {
      if (!run.length) return;
      if (run.length === 1) {
        mk(ctx, 'circle', { cx: run[0].x, cy: run[0].y, r: 3, fill: color });
      } else {
        const pts = run.map((p) => round2(p.x) + ',' + round2(p.y)).join(' ');
        if (filled) {
          const first = run[0];
          const last = run[run.length - 1];
          mk(ctx, 'polygon', {
            points: round2(first.x) + ',' + round2(baseY) + ' ' + pts + ' ' +
              round2(last.x) + ',' + round2(baseY),
            fill: color,
            'fill-opacity': 0.22,
          });
        }
        mk(ctx, 'polyline', {
          points: pts,
          fill: 'none',
          stroke: color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        });
        if (markers) {
          for (const p of run) mk(ctx, 'circle', { cx: p.x, cy: p.y, r: 2.2, fill: color });
        }
      }
      run = [];
    };

    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v === null) {
        flush();
        continue;
      }
      run.push({ x: box.x + band * (i + 0.5), y: yAt(scale, box, v) });
    }
    flush();
  }
}

// ---------------------------------------------------------------- bar (horizontal)

function drawBar(ctx, m, area, data) {
  const dom = domainOf(data.series, true);
  const n = data.categories.length;
  if (!n) return;

  const valueBand = m.tickFs + 6;
  const plotH = area.h - valueBand;
  if (plotH < 16) return;

  const catW = Math.min(area.w * 0.42, maxTextWidth(data.categories, m.tickFs) + 8);
  const boxW = area.w - catW;
  if (boxW < 12) return;

  const maxTicks = clamp(Math.floor(boxW / (m.tickFs * 4.5)), 2, 8);
  const scale = niceScale(dom.min, dom.max, maxTicks);
  const ticks = tickValues(scale);
  const labels = ticks.map((v) => tickText(v, scale.step));

  const box = { x: area.x + catW, y: area.y, w: boxW, h: plotH };
  drawValueAxisX(ctx, m, box, scale, ticks, labels);
  drawCategoryAxisY(ctx, m, box, data.categories, catW);
  line(ctx, crisp(box.x), box.y, crisp(box.x), box.y + box.h, ctx.theme.lineStrong, 1);

  const live = data.series.filter((s) => !isAllGaps(s));
  if (!live.length) return;
  const band = box.h / n;
  const groupH = band * 0.78;
  const barH = groupH / live.length;
  const inner = barH > 3 ? barH - 1 : barH;
  const baseX = xAt(scale, box, clamp(0, scale.min, scale.max));

  let slot = 0;
  for (let j = 0; j < data.series.length; j++) {
    const s = data.series[j];
    if (isAllGaps(s)) continue;
    const color = colorAt(ctx.theme, j);
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v === null) continue;
      const x = xAt(scale, box, v);
      const w = Math.abs(x - baseX);
      if (w < 0.5) continue;
      mk(ctx, 'rect', {
        x: Math.min(x, baseX),
        y: box.y + band * i + (band - groupH) / 2 + barH * slot,
        width: w,
        height: Math.max(inner, 0.5),
        fill: color,
      });
    }
    slot++;
  }
}

// ---------------------------------------------------------------- scatter

/**
 * Scatter. X comes from the category column read as numbers (`categoryNumbers`); when the
 * categories are not numeric — text labels, say — the point index 1..n is used instead, so
 * the chart still plots something meaningful rather than collapsing onto one column.
 * Neither axis is forced to contain zero: a cloud around (1000, 1000) should fill the plot.
 */
function drawScatter(ctx, m, area, data) {
  const n = data.categories.length;
  if (!n) return;

  let xs = data.categoryNumbers;
  let numeric = false;
  for (let i = 0; i < n; i++) {
    if (isFiniteNum(xs[i])) {
      numeric = true;
      break;
    }
  }
  if (!numeric) {
    xs = new Array(n);
    for (let i = 0; i < n; i++) xs[i] = i + 1;
  }

  let xMin = Infinity;
  let xMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    if (!isFiniteNum(v)) continue;
    if (v < xMin) xMin = v;
    if (v > xMax) xMax = v;
  }
  if (xMin === Infinity) {
    xMin = 0;
    xMax = 1;
  }

  const yDom = domainOf(data.series, false);
  const valueBand = m.tickFs + 6;
  const plotH = area.h - valueBand;
  if (plotH < 16) return;

  const maxTicksY = clamp(Math.floor(plotH / (m.tickFs * 2.4)), 2, 8);
  const yScale = niceScale(yDom.min, yDom.max, maxTicksY);
  const yTicks = tickValues(yScale);
  const yLabels = yTicks.map((v) => tickText(v, yScale.step));
  const axisW = Math.min(area.w * 0.42, maxTextWidth(yLabels, m.tickFs) + 8);

  const box = { x: area.x + axisW, y: area.y, w: area.w - axisW, h: plotH };
  if (box.w < 12 || box.h < 12) return;

  const maxTicksX = clamp(Math.floor(box.w / (m.tickFs * 4.5)), 2, 8);
  const xScale = niceScale(xMin, xMax, maxTicksX);
  const xTicks = tickValues(xScale);
  const xLabels = xTicks.map((v) => tickText(v, xScale.step));

  // Y first, so the X axis line lands on top of the horizontal gridline that shares it.
  drawValueAxisY(ctx, m, box, yScale, yTicks, yLabels);
  drawValueAxisX(ctx, m, box, xScale, xTicks, xLabels);

  const r = clamp(Math.round(m.fs * 0.28), 2, 4);
  for (let j = 0; j < data.series.length; j++) {
    const s = data.series[j];
    if (isAllGaps(s)) continue;
    const color = colorAt(ctx.theme, j);
    for (let i = 0; i < n; i++) {
      const y = s.values[i];
      const x = xs[i];
      if (y === null || !isFiniteNum(x)) continue; // either coordinate missing -> no point
      mk(ctx, 'circle', {
        cx: xAt(xScale, box, x),
        cy: yAt(yScale, box, y),
        r,
        fill: color,
        'fill-opacity': 0.85,
      });
    }
  }
}

// ---------------------------------------------------------------- pie

/**
 * Slices for a pie: the first series that has any value at all, restricted to POSITIVE
 * values. A pie is a part-of-whole picture, and a negative slice has no honest area — so
 * negatives and zeros are dropped rather than drawn as their absolute value, and a series
 * with nothing positive left says so instead of rendering a meaningless disc.
 */
function pieModel(data) {
  let src = null;
  for (const s of data.series) {
    if (!isAllGaps(s)) {
      src = s;
      break;
    }
  }
  if (!src) return { slices: [], reason: MSG_NO_DATA };

  const slices = [];
  let total = 0;
  for (let i = 0; i < data.categories.length; i++) {
    const v = src.values[i];
    if (v === null || !(v > 0)) continue;
    slices.push({ label: data.categories[i] || String(i + 1), value: v });
    total += v;
  }
  if (!slices.length || !(total > 0)) return { slices: [], reason: MSG_PIE_POSITIVE };
  for (const s of slices) s.frac = s.value / total;
  return { slices, total, reason: '' };
}

function drawPie(ctx, m, area, data) {
  const pie = pieModel(data);
  if (!pie.slices.length) {
    drawMessage(ctx, m, area, pie.reason || MSG_NO_DATA);
    return;
  }

  const items = pie.slices.map((s, i) => ({ label: s.label, color: colorAt(ctx.theme, i) }));
  const box = drawLegend(ctx, m, area, items);
  if (box.w < 16 || box.h < 16) return;

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = Math.max(4, Math.min(box.w, box.h) / 2 - 2);
  const showPct = r >= 34;

  let a0 = -Math.PI / 2;
  for (let i = 0; i < pie.slices.length; i++) {
    const s = pie.slices[i];
    const color = items[i].color;
    const sweep = s.frac * Math.PI * 2;
    const a1 = a0 + sweep;

    if (s.frac >= 0.9999) {
      // A single slice is a full circle; an arc from A back to A would draw nothing.
      mk(ctx, 'circle', { cx, cy, r, fill: color, stroke: ctx.theme.surface,
        'stroke-width': 1 });
    } else {
      const x0 = cx + r * Math.cos(a0);
      const y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1);
      const y1 = cy + r * Math.sin(a1);
      const large = sweep > Math.PI ? 1 : 0;
      mk(ctx, 'path', {
        d: 'M' + round2(cx) + ',' + round2(cy) +
          ' L' + round2(x0) + ',' + round2(y0) +
          ' A' + round2(r) + ',' + round2(r) + ' 0 ' + large + ' 1 ' +
          round2(x1) + ',' + round2(y1) + ' Z',
        fill: color,
        stroke: ctx.theme.surface,
        'stroke-width': 1,
      });
    }

    if (showPct && s.frac >= 0.06) {
      const mid = a0 + sweep / 2;
      const pct = s.frac * 100;
      label(ctx, (pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10) + '%',
        cx + Math.cos(mid) * r * 0.62,
        cy + Math.sin(mid) * r * 0.62 + m.tickFs * 0.35,
        m.tickFs, ctx.theme.onColor, 'middle');
    }
    a0 = a1;
  }
}
