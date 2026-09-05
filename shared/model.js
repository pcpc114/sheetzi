// shared/model.js — document model helpers and constants (multi-sheet document, v2).
//
// This module is imported by BOTH Node (server.js) and the browser, therefore:
//   - pure ESM, explicit .js extensions in every import specifier
//   - no Node builtin (fs / path / crypto / ...)
//   - no browser global (window / document)
//   - no npm dependency
// It imports exactly two modules out of shared/formula/, both of them leaves:
//   - values.js, for `compareValues` and `toText` — the sort and filter helpers of batch C
//     have to order values exactly the way a formula does, and re-implementing that
//     comparison here would be two definitions of "less than" waiting to drift apart;
//   - refs.js, for MAX_ROWS / MAX_COLS — the hard extent of a sheet. `growSheet` clamps
//     against it, and clamping against a hand-copied 5000/702 would be a second definition
//     of "how big can a sheet get" waiting to drift apart from the reference math.
// values.js imports only errors.js and refs.js imports nothing at all, so there is no
// cycle; in particular this module still does NOT import the engine.
//
// Document shape (SPEC section 10):
//
//   {
//     id, name,
//     sheets: [ { id, name, color, rows, cols, cells, colWidths, rowHeights,
//                 frozenRows, frozenCols, merges, filter, charts, comments }, ... ],
//                                                 // 1..MAX_SHEETS, order IS tab order
//     createdAt, updatedAt, rev
//   }
//
// A v1 document kept exactly one sheet inline on the document itself (top-level `cells`,
// `rows`, `cols`, `colWidths`, `rowHeights`, `frozenRows`, `frozenCols`). Those files are
// already on disk, so `sanitizeDoc` migrates them on load — see MIGRATION below.
//
// `merges` (SPEC section 21) is the sheet's merged-cell geometry: normalized A1 range
// strings such as ['A1:C1']. Every helper that produces a sheet gives it an array, so it
// is never undefined; the geometry itself lives in the "merged cells" section below.
//
// Cell formatting (SPEC section 22) adds six optional style keys — ff, fs, va, wrap, rot
// and bd — validated by `sanitizeStyle` and supported by the font and border helpers in
// the "cell formatting" section below. Every one of them is optional, and a cell carrying
// none of them sanitizes exactly as it did before they existed.
//
// Growing a sheet (SPEC section 25) adds ROW_GROW_STEP, COL_GROW_STEP and `growSheet`.
// A sheet starts at 200 x 26 and can grow to MAX_ROWS x MAX_COLS (5000 x 702), which the
// engine has always supported. Growth is strictly ADDITIVE — it changes `rows` / `cols`
// and nothing else — so it can never move a cell, a merge, a chart range or a comment,
// and therefore can never corrupt a formula. There is no shrink path here at all. See the
// "growing a sheet" section at the bottom of this file.
//
// Tools batch B (SPEC section 23) adds ONE optional field to the cell record: `link`, a
// hyperlink validated by `sanitizeLink`. It is attacker-controlled text, so only http,
// https and mailto survive; everything else (javascript:, data:, vbscript:, file:,
// protocol-relative and scheme-less input) is dropped. A cell carrying no `link`
// sanitizes exactly as it did before, key for key and in the same order.
//
// Data features batch C (SPEC section 24) adds THREE optional fields to the sheet:
// `filter` (a sort/filter view), `charts` (inline-SVG charts) and `comments` (comment
// threads keyed by A1). Sorting and filtering are a VIEW — `computeSortOrder` and
// `computeVisibleRows` say how to paint rows, and the stored rows are never reordered or
// removed — so no sort and no filter can corrupt a formula. A sheet with no filter, no
// chart and no comment pays only three cheap "nothing here" checks. See the batch-C
// section below.
//
// Every sheet mutation helper here is PURE: it returns a NEW document object and never
// mutates the one it was given. Untouched sheets are shared by reference (structural
// sharing); a sheet that changes is replaced by a fresh object. When an operation is a
// no-op (unknown id, limit reached, nothing actually changed) the SAME document reference
// is returned, so a caller may use `next === doc` as a cheap "nothing happened" test.

import { compareValues, toText } from './formula/values.js';
import { MAX_ROWS, MAX_COLS } from './formula/refs.js';

export const DEFAULT_ROWS = 200;
export const DEFAULT_COLS = 26;
export const DEFAULT_COL_WIDTH = 104;
export const DEFAULT_ROW_HEIGHT = 26;

/** Hard cap on sheets per document. `addSheet` / `duplicateSheet` refuse to go past it. */
export const MAX_SHEETS = 50;

/** Name given to the first sheet of a new document, and to a migrated v1 sheet. */
export const DEFAULT_SHEET_NAME = '시트1';

// Hard sheet limits. These ARE MAX_ROWS / MAX_COLS from shared/formula/refs.js, kept under
// the local names this module has always used for them: every existing clamp behaves
// exactly as before, and there is now a single definition of the extent rather than a copy
// of the numbers sitting next to a comment promising they match.
const LIMIT_ROWS = MAX_ROWS; // 5000
const LIMIT_COLS = MAX_COLS; // 702 — A .. ZZ

// Pixel ranges accepted for per-column / per-row sizing.
const MIN_COL_WIDTH = 40;
const MAX_COL_WIDTH = 800;
const MIN_ROW_HEIGHT = 18;
const MAX_ROW_HEIGHT = 400;

const MAX_NAME_LEN = 200; // document name
const MAX_SHEET_NAME_LEN = 100; // sheet name (SPEC: 1..100 chars)
const MAX_INPUT_LEN = 10000;

// Default document title (user-facing).
const DEFAULT_NAME = '제목 없는 스프레드시트';

// Prefix used to invent a sheet name when none was supplied: 시트1, 시트2, ...
const SHEET_NAME_PREFIX = '시트';

// Suffix appended to a duplicated sheet's name (user-facing).
const DUPLICATE_SUFFIX = ' 복사본';

const ID_RE = /^[a-z0-9]{6,24}$/;
// Sheet ids are generated as 6 base36 characters (SPEC: 5..8). Validation is deliberately
// a little more tolerant than generation so an id minted elsewhere is never churned on
// reload — an id must survive renames, reordering and a round trip through disk.
const SHEET_ID_RE = /^[a-z0-9]{5,24}$/;
const CELL_KEY_RE = /^([A-Z]{1,2})([0-9]{1,5})$/;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const ALIGNS = new Set(['left', 'center', 'right']);
const FORMATS = new Set(['general', 'number', 'currency', 'percent', 'date', 'time', 'text']);
const STYLE_FLAGS = ['b', 'i', 'u', 's'];

/**
 * @typedef {Object} Sheet
 * @property {string} id          stable for the life of the sheet; survives renames
 * @property {string} name        unique within the document, 1..100 chars
 * @property {string|null} color  '#rrggbb' tab colour, or null
 * @property {number} rows
 * @property {number} cols
 * @property {Object<string,{input?:string,style?:Object,link?:string}>} cells
 *            keyed by A1, no empty entries; `link` is an http/https/mailto URL
 * @property {Object<string,number>} colWidths   keys are stringified col indexes
 * @property {Object<string,number>} rowHeights  keys are stringified row indexes
 * @property {number} frozenRows
 * @property {number} frozenCols
 * @property {string[]} merges   normalized, non-overlapping A1 ranges; [] when none
 * @property {Filter|null} filter          the sort/filter VIEW; null when there is none
 * @property {Chart[]} charts              inline-SVG charts; [] when there are none
 * @property {Object<string,CommentThread>} comments   threads keyed by A1; {} when none
 */

/**
 * @typedef {Object} Doc
 * @property {string} id
 * @property {string} name
 * @property {Sheet[]} sheets   1..MAX_SHEETS entries; array order IS the tab order
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} rev
 */

// ---------------------------------------------------------------------------
// small internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Coerce to an integer inside [min,max]; anything unusable falls back to `dflt`.
function clampInt(v, min, max, dflt) {
  let n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  n = Math.round(n);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// 'A' -> 0, 'Z' -> 25, 'AA' -> 26. Letters must already be uppercase A-Z.
function lettersToCol(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64); // 'A' === 65
  }
  return n - 1;
}

// 'B3' -> {row:2, col:1}; anything else -> null. Never throws.
function parseCellKey(key) {
  const m = CELL_KEY_RE.exec(key);
  if (!m) return null;
  const col = lettersToCol(m[1]);
  const row = Number(m[2]) - 1;
  if (!Number.isInteger(row) || row < 0 || row >= LIMIT_ROWS) return null;
  if (col < 0 || col >= LIMIT_COLS) return null;
  return { row, col };
}

// '#RRGGBB' / '#rgb' -> lowercase 6-digit hex; anything else -> null.
// Sheet tab colours use exactly the same rule as cell bg/fg colours.
function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!HEX_RE.test(s)) return null;
  if (s.length === 4) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return s;
}

// Replace control characters with spaces, collapse runs of spaces/tabs, trim.
function collapse(v) {
  let out = '';
  for (const ch of v) {
    const code = ch.codePointAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

// Document name. Falls back to the default title; never empty.
function sanitizeName(v) {
  if (typeof v !== 'string') return DEFAULT_NAME;
  const s = collapse(v);
  if (!s) return DEFAULT_NAME;
  return s.slice(0, MAX_NAME_LEN);
}

// Sheet name: trimmed, control characters removed, capped at 100 chars.
// Returns '' when nothing usable is left — the caller decides the fallback.
function sanitizeSheetName(v) {
  if (typeof v !== 'string') return '';
  const s = collapse(v);
  if (!s) return '';
  return s.slice(0, MAX_SHEET_NAME_LEN).trim();
}

// Names are compared case-insensitively for uniqueness, which is what a formula
// resolving '시트2!A1' will need later (SPEC section 16).
function nameKey(name) {
  return typeof name === 'string' ? name.toLowerCase() : '';
}

// Cell input is a string; numbers/booleans coming from hand-edited JSON are coerced.
function sanitizeInput(v) {
  if (typeof v === 'string') return v.length > MAX_INPUT_LEN ? v.slice(0, MAX_INPUT_LEN) : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return undefined;
}

// Keep only known style keys with sane values. Returns null when nothing survives.
//
// The batch-A keys (ff / fs / va / wrap / rot / bd — SPEC section 22) are appended AFTER
// the original ones and only when they are both present and valid, so a style carrying
// none of them produces byte-for-byte the object it produced before they existed: same
// keys, same insertion order, same values. That is what keeps existing documents
// rendering identically. Their validators live in the cell-formatting section below.
function sanitizeStyle(v) {
  if (!isPlainObject(v)) return null;
  const out = {};
  for (const flag of STYLE_FLAGS) {
    if (v[flag]) out[flag] = 1;
  }
  if (typeof v.align === 'string' && ALIGNS.has(v.align)) out.align = v.align;
  const bg = normalizeHex(v.bg);
  if (bg) out.bg = bg;
  const fg = normalizeHex(v.fg);
  if (fg) out.fg = fg;
  if (typeof v.fmt === 'string' && FORMATS.has(v.fmt)) out.fmt = v.fmt;
  if (v.decimals !== undefined && v.decimals !== null) {
    const d = clampInt(v.decimals, 0, 6, null);
    if (d !== null) out.decimals = d;
  }
  const ff = sanitizeFontId(v.ff);
  if (ff) out.ff = ff;
  const fs = sanitizeFontSize(v.fs);
  if (fs !== null) out.fs = fs;
  const va = sanitizeVAlign(v.va);
  if (va) out.va = va;
  const wrap = sanitizeWrap(v.wrap);
  if (wrap) out.wrap = wrap;
  const rot = sanitizeRotation(v.rot);
  if (rot !== null) out.rot = rot;
  const bd = sanitizeBorder(v.bd);
  if (bd) out.bd = bd;
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// hyperlinks (SPEC section 23.4)
//
// A cell may carry a `link`. Its value arrives from another collaborator over the wire,
// from a pasted document, or straight off disk, so it is ALWAYS treated as hostile text.
// `sanitizeLink` is the single gate every stored link passes through: it is called by
// `sanitizeCells` below, and the server runs the same function on an incoming edit.
//
// The rule is an allow-list of exactly three schemes. Anything else — `javascript:`,
// `data:`, `vbscript:`, `file:`, a protocol-relative `//host` or a bare `host/path` that
// a browser could later resolve into one of those — is rejected outright.
// ---------------------------------------------------------------------------

/** Hard cap on a stored hyperlink, before and after normalisation. */
const MAX_LINK_LEN = 2048;

/** The ONLY schemes a cell link may use. Compared against `URL#protocol` (with its ':'). */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

// True when the string holds a C0 control, DEL, or a C1 control. Those characters can
// smuggle a scheme past a naive reader ("java\tscript:"), split a header, or terminate an
// attribute, and they have no business in a URL a human typed.
function hasControlChar(s) {
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) return true;
  }
  return false;
}

/**
 * Validate a cell hyperlink and return its normalised form.
 *
 * Only `http:`, `https:` and `mailto:` are accepted. Everything else returns `null`:
 *
 *   sanitizeLink('https://example.com/a?b=1')  -> 'https://example.com/a?b=1'
 *   sanitizeLink('  http://EXAMPLE.com  ')     -> 'http://example.com/'   (trimmed, normalised)
 *   sanitizeLink('mailto:a@b.co.kr')           -> 'mailto:a@b.co.kr'
 *   sanitizeLink('javascript:alert(1)')        -> null
 *   sanitizeLink('data:text/html,<script>')    -> null
 *   sanitizeLink('vbscript:msgbox 1')          -> null
 *   sanitizeLink('file:///C:/secrets.txt')     -> null
 *   sanitizeLink('//evil.example.com')         -> null   (protocol-relative)
 *   sanitizeLink('example.com/path')           -> null   (no scheme at all)
 *   sanitizeLink('java\tscript:alert(1)')      -> null   (control character)
 *   sanitizeLink(42)                           -> null
 *
 * The string is PARSED rather than pattern-matched: `URL` (a global in both Node and the
 * browser, and not a Node builtin import) does the work, and a throw is simply an invalid
 * link. Parsing is what makes the scheme check trustworthy — a regex over the raw text
 * can be fooled by case, by whitespace the URL parser strips, and by percent-encoding,
 * whereas `URL#protocol` is the scheme the browser itself would act on.
 *
 * Beyond the scheme:
 *   - surrounding whitespace is trimmed; a control character anywhere is fatal
 *   - the length is capped at 2048 characters, checked on the input AND on the result
 *     (normalisation can percent-encode and therefore grow the string)
 *   - http/https must name a host, and mailto must name something after the colon, so an
 *     empty `http://` or a bare `mailto:` is rejected rather than stored as dead text
 *   - embedded credentials (`https://real.example.com@evil.example/`) are rejected: the
 *     scheme is fine but the visible text lies about where the link goes, which is the
 *     one deception a spreadsheet cell is perfectly shaped to carry
 *
 * NEVER throws, whatever it is handed.
 *
 * @param {any} v
 * @returns {string|null} the normalised URL, or null when it is not an allowed link
 */
export function sanitizeLink(v) {
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (!raw || raw.length > MAX_LINK_LEN) return null;
  if (hasControlChar(raw)) return null;
  // Guard the global itself so this module can never throw in an exotic runtime.
  if (typeof URL !== 'function') return null;

  let url;
  try {
    // No base argument: a scheme-less or protocol-relative string has nothing to resolve
    // against and therefore throws, which is exactly the rejection we want.
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!LINK_SCHEMES.has(url.protocol)) return null;
  if (url.protocol === 'mailto:') {
    if (!url.pathname) return null;
  } else if (!url.hostname) {
    return null;
  }
  if (url.username || url.password) return null;

  const href = url.href;
  if (!href || href.length > MAX_LINK_LEN) return null;
  return href;
}

// Sanitize a { '<index>': pixels } map against an index count and a pixel range.
function sanitizeSizeMap(src, count, min, max) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const key of Object.keys(src)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    const px = clampInt(src[key], min, max, null);
    if (px === null) continue;
    out[String(idx)] = px;
  }
  return out;
}

// Sanitize a cell map against a sheet's dimensions. Drops out-of-sheet keys, unknown
// style keys, invalid links and entries that end up carrying nothing at all.
//
// `link` is appended AFTER input and style and only when it survives `sanitizeLink`, so a
// cell without one produces byte-for-byte the object it produced before links existed. A
// cell whose ONLY content is a link is still a real cell and is kept.
function sanitizeCells(src, rows, cols) {
  const cells = {};
  if (!isPlainObject(src)) return cells;
  for (const rawKey of Object.keys(src)) {
    const key = String(rawKey).toUpperCase();
    const pos = parseCellKey(key);
    if (!pos) continue;
    if (pos.row >= rows || pos.col >= cols) continue; // outside the sheet
    const entry = src[rawKey];
    if (!isPlainObject(entry)) continue;
    const out = {};
    const input = sanitizeInput(entry.input);
    if (input !== undefined && input !== '') out.input = input;
    const style = sanitizeStyle(entry.style);
    if (style) out.style = style;
    const link = sanitizeLink(entry.link);
    if (link) out.link = link;
    if (out.input === undefined && !out.style && !out.link) continue; // no empty entries
    cells[key] = out;
  }
  return cells;
}

// Deep copy of a cell map. Every style value is a primitive EXCEPT `bd`, which is a
// nested { t?, r?, b?, l? } of { w, s, c } edges — so a plain spread would leave the copy
// sharing that object with the original. `bd` is therefore cloned one level deeper, and
// the result shares NO mutable object with `src`.
function cloneCells(src) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const key of Object.keys(src)) {
    const entry = src[key];
    if (!isPlainObject(entry)) continue;
    const copy = {};
    if (typeof entry.input === 'string' && entry.input !== '') copy.input = entry.input;
    if (isPlainObject(entry.style)) {
      const style = { ...entry.style };
      if (style.bd !== undefined) {
        const bd = cloneBorderValue(style.bd);
        if (bd) style.bd = bd;
        else delete style.bd;
      }
      if (Object.keys(style).length) copy.style = style;
    }
    // A duplicated sheet keeps its hyperlinks; the value is an immutable string, and it
    // has already been through sanitizeLink on the way in.
    if (typeof entry.link === 'string' && entry.link !== '') copy.link = entry.link;
    if (copy.input === undefined && !copy.style && copy.link === undefined) continue;
    out[key] = copy;
  }
  return out;
}

// Deep copy of a { '<index>': pixels } map (values are numbers).
function cloneSizeMap(src) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const key of Object.keys(src)) {
    const px = src[key];
    if (typeof px === 'number' && Number.isFinite(px)) out[String(key)] = px;
  }
  return out;
}

// The document's sheet array, or [] for anything that is not one yet.
function sheetsOf(doc) {
  return doc && Array.isArray(doc.sheets) ? doc.sheets : [];
}

// Build the successor document. Every document-level field is carried over untouched;
// `rev` / `updatedAt` bookkeeping belongs to the server, not to these pure helpers.
function withSheets(doc, sheets) {
  return { ...doc, sheets };
}

function takenIdsOf(sheets) {
  const set = new Set();
  for (const s of sheets) {
    if (s && typeof s.id === 'string') set.add(s.id);
  }
  return set;
}

function takenNamesOf(sheets, skipIndex = -1) {
  const set = new Set();
  for (let i = 0; i < sheets.length; i++) {
    if (i === skipIndex) continue;
    const s = sheets[i];
    if (s && typeof s.name === 'string') set.add(nameKey(s.name));
  }
  return set;
}

// ---------------------------------------------------------------------------
// id generation
// ---------------------------------------------------------------------------

// Internal counter + per-load salt, mixed with the caller-supplied numeric seed.
// No node:crypto and no browser crypto — identical behaviour in both runtimes.
let ID_COUNTER = 0;
const ID_SALT = (Math.floor(Math.random() * 0xffffffff) ^ 0x5bf03635) >>> 0;

function mix32(n) {
  let x = n >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

// 36^4 === 1679616 — four base36 characters per 32-bit word.
function chunk4(n) {
  const s = (n >>> 0) % 1679616;
  return s.toString(36).padStart(4, '0');
}

// `len` base36 characters from a 32-bit word (len <= 6 keeps this exact in a double).
function chunk(n, len) {
  const mod = Math.pow(36, len);
  const s = (n >>> 0) % mod;
  return s.toString(36).padStart(len, '0');
}

// Split a possibly-huge numeric seed into two 32-bit halves.
function seedWords(seed) {
  const raw = typeof seed === 'number' ? seed : Number(seed);
  const s = Number.isFinite(raw) ? Math.floor(Math.abs(raw)) : 0;
  return { lo: s >>> 0, hi: Math.floor(s / 4294967296) >>> 0 };
}

/**
 * 12-character base36 id matching /^[a-z0-9]{6,24}$/ — used for document ids.
 * MUST NOT use node:crypto. `seed` is a number supplied by the caller (the server
 * passes Date.now()); uniqueness does not depend on it, the per-load salt and the
 * internal counter carry that on their own.
 *
 * @param {number} seed
 * @returns {string}
 */
export function newId(seed) {
  const { lo, hi } = seedWords(seed);
  ID_COUNTER = (ID_COUNTER + 1) >>> 0;
  const a = mix32((lo ^ ID_SALT) >>> 0);
  const b = mix32((hi ^ ID_COUNTER ^ a) >>> 0);
  const c = mix32((a ^ Math.imul(b, 0x85ebca6b) ^ (ID_COUNTER << 13)) >>> 0);
  return chunk4(a) + chunk4(b) + chunk4(c);
}

/**
 * 6-character base36 sheet id (inside the 5..8 range the spec allows).
 * Same discipline as `newId`: caller-supplied numeric seed, per-load salt, internal
 * counter. No node:crypto, no Date.now() in here.
 *
 * @param {number} [seed]
 * @returns {string}
 */
function newSheetId(seed) {
  const { lo, hi } = seedWords(seed);
  ID_COUNTER = (ID_COUNTER + 1) >>> 0;
  const a = mix32((lo ^ ID_SALT ^ ID_COUNTER) >>> 0);
  const b = mix32((hi ^ a ^ Math.imul(ID_COUNTER, 0x9e3779b1)) >>> 0);
  return chunk(a, 4) + chunk(b, 2);
}

// A sheet id that is free within `taken`. Falls back to a deterministic scan so this can
// never loop forever, whatever the random stream does.
function freeSheetId(taken, seed) {
  for (let i = 0; i < 64; i++) {
    const id = newSheetId((seed || 0) + i);
    if (!taken.has(id)) return id;
  }
  for (let k = 0; k <= 100000; k++) {
    const id = 'sh' + chunk(k, 4);
    if (!taken.has(id)) return id;
  }
  return 'sh' + chunk(taken.size, 4); // unreachable: taken is capped at MAX_SHEETS
}

// ---------------------------------------------------------------------------
// sheet names
// ---------------------------------------------------------------------------

// Lowest free '시트<n>' (n starts at 1, so an empty document yields DEFAULT_SHEET_NAME).
function defaultSheetName(takenLower) {
  for (let n = 1; ; n++) {
    const candidate = SHEET_NAME_PREFIX + n;
    if (!takenLower.has(nameKey(candidate))) return candidate;
  }
}

/**
 * Resolve `wanted` to a name free within `takenLower` (a Set of lowercased names).
 * Empty/unusable -> '시트<n>' with the lowest free n. Otherwise ' (2)', ' (3)', ... is
 * appended until the name is free, trimming the base so the total stays <= 100 chars.
 */
function uniqueNameAmong(takenLower, wanted) {
  const base = sanitizeSheetName(wanted);
  if (!base) return defaultSheetName(takenLower);
  if (!takenLower.has(nameKey(base))) return base;
  for (let n = 2; n <= 2000; n++) {
    const suffix = ' (' + n + ')';
    let stem = base;
    if (stem.length + suffix.length > MAX_SHEET_NAME_LEN) {
      stem = stem.slice(0, MAX_SHEET_NAME_LEN - suffix.length).trim();
      if (!stem) stem = SHEET_NAME_PREFIX;
    }
    const candidate = stem + suffix;
    if (!takenLower.has(nameKey(candidate))) return candidate;
  }
  return defaultSheetName(takenLower); // unreachable with <= MAX_SHEETS sheets
}

/**
 * A sheet name that is not already used in `doc`.
 * '시트1' -> '시트1 (2)' -> '시트1 (3)'; an empty/blank `wanted` becomes the lowest free
 * '시트<n>'. Comparison is case-insensitive. Pure: `doc` is only read.
 *
 * @param {Doc} doc
 * @param {string} [wanted]
 * @returns {string}
 */
export function uniqueSheetName(doc, wanted) {
  return uniqueNameAmong(takenNamesOf(sheetsOf(doc)), wanted);
}

// ---------------------------------------------------------------------------
// merged cells (SPEC section 21)
//
// A merge is presentation and selection only. Merging KEEPS the top-left ("anchor")
// cell's contents and CLEARS every other covered cell, exactly as Google Sheets does.
// The covered cells are therefore genuinely empty afterwards, which is the whole reason
// nothing under shared/formula/ knows about merges: `=SUM(A1:C1)` over a merged A1:C1
// sums the anchor plus two blank cells and is already correct.
//
// Two representations are used here:
//   - the STORED form, a normalized uppercase A1 range string: 'A1:C1'
//   - the internal geometry form, a "rect": { r1, c1, r2, c2 }, 0-indexed and inclusive
//     on both ends, with r1 <= r2 and c1 <= c2
//
// Every function in this section is PURE: its arguments are only ever read, and every
// array/object it hands back is freshly built.
// ---------------------------------------------------------------------------

/** Hard cap on merged rectangles per sheet. Extra entries are dropped, never merged. */
export const MAX_MERGES = 2000;

// Upper bound on how many keys `planMerge` will enumerate into `clear`. It mirrors the
// 200000-cell cap `rangeCells()` in shared/formula/refs.js enforces, and exists so that
// merging an absurd selection cannot allocate millions of strings on the main thread.
// Every realistic merge is orders of magnitude below it (a whole default 200x26 sheet is
// 5200 cells).
const MERGE_CLEAR_LIMIT = 200000;

// Parsing the same handful of range strings happens on every grid repaint, so the result
// is memoised. The cache is keyed by the exact input string (strings are immutable, so
// this is safe) and every hit is copied out, so no caller can ever mutate a cached rect.
const MERGE_PARSE_CACHE = new Map();
const MERGE_PARSE_CACHE_LIMIT = 4096;

// 0 -> 'A', 25 -> 'Z', 26 -> 'AA' (bijective base-26); the inverse of lettersToCol.
function colLetters(col) {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// (0,0) -> 'A1'
function cellKeyOf(row, col) {
  return colLetters(col) + (row + 1);
}

// 'a1:$c$2' -> {r1:0,c1:0,r2:1,c2:2}. Uppercases, drops '$', and orders the corners, so a
// backwards range like 'C2:A1' normalizes rather than being thrown away. Anything that is
// not a parseable, in-bounds A1 range -> null. NEVER throws.
function parseMergeKeyUncached(text) {
  if (text.length > 32) return null; // the longest legal range is 'ZZ5000:ZZ5000' (13)
  const s = text.replace(/\$/g, '').trim().toUpperCase();
  // A sheet qualifier ('시트2!A1:B2') is a reference, not a merge on THIS sheet.
  if (!s || s.indexOf('!') >= 0) return null;
  const parts = s.split(':');
  if (parts.length > 2) return null;
  const a = parseCellKey(parts[0].trim());
  if (!a) return null;
  const b = parts.length === 2 ? parseCellKey(parts[1].trim()) : a;
  if (!b) return null;
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

// Memoised parseMergeKeyUncached. Always returns a FRESH rect (or null).
function parseMergeKey(value) {
  if (typeof value !== 'string') return null;
  if (MERGE_PARSE_CACHE.has(value)) {
    const hit = MERGE_PARSE_CACHE.get(value);
    return hit === null ? null : { ...hit };
  }
  const rect = parseMergeKeyUncached(value);
  // A flat clear is enough: the cache is a pure speed-up, never a source of truth.
  if (MERGE_PARSE_CACHE.size >= MERGE_PARSE_CACHE_LIMIT) MERGE_PARSE_CACHE.clear();
  MERGE_PARSE_CACHE.set(value, rect);
  return rect === null ? null : { ...rect };
}

// {r1:0,c1:0,r2:1,c2:2} -> 'A1:C2'
function rectKey(rect) {
  return cellKeyOf(rect.r1, rect.c1) + ':' + cellKeyOf(rect.r2, rect.c2);
}

function rectCellCount(rect) {
  return (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);
}

function rectsOverlap(a, b) {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

function rectHolds(rect, row, col) {
  return row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2;
}

// Sort order for the stored list: row, then column (SPEC 21.1). r2/c2 are compared too so
// the order is total and two equal lists always serialize identically.
function compareRects(a, b) {
  return a.r1 - b.r1 || a.c1 - b.c1 || a.r2 - b.r2 || a.c2 - b.c2;
}

// A usable 0-based index from anything at all: garbage becomes 0, and the value is kept
// inside the hard addressable sheet.
function toIndex(v, max) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  const i = Math.floor(n);
  if (i < 0) return 0;
  return i > max ? max : i;
}

// Accept a rect in either shape and return a FRESH, ordered, in-range rect:
//   { r1, c1, r2, c2 }             the geometry form used throughout this section
//   { s:{row,col}, e:{row,col} }   the selection shape the grid works with
// Never throws and never returns null: unusable input degrades to the A1 cell.
function normalizeRect(rect) {
  const src = isPlainObject(rect) ? rect : {};
  const maxRow = LIMIT_ROWS - 1;
  const maxCol = LIMIT_COLS - 1;
  let r1;
  let c1;
  let r2;
  let c2;
  if (isPlainObject(src.s) || isPlainObject(src.e)) {
    const s = isPlainObject(src.s) ? src.s : {};
    const e = isPlainObject(src.e) ? src.e : {};
    r1 = toIndex(s.row, maxRow);
    c1 = toIndex(s.col, maxCol);
    r2 = toIndex(e.row, maxRow);
    c2 = toIndex(e.col, maxCol);
  } else {
    r1 = toIndex(src.r1, maxRow);
    c1 = toIndex(src.c1, maxCol);
    r2 = toIndex(src.r2, maxRow);
    c2 = toIndex(src.c2, maxCol);
  }
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

// Parse a whole merge list into rects, silently dropping every unusable entry.
function parseMergeList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const rect = parseMergeKey(entry);
    if (rect) out.push(rect);
  }
  return out;
}

// Shift one axis of a rect for a structural edit. `a`/`b` are the inclusive start/end on
// that axis. Returns {a, b}, or null when the span is wholly inside a deleted band.
function shiftSpan(a, b, inserting, index, count) {
  if (inserting) {
    if (a >= index) return { a: a + count, b: b + count }; // entirely after -> moves
    if (b >= index) return { a, b: b + count }; // spans the insert point -> grows
    return { a, b }; // entirely before -> untouched
  }
  const end = index + count; // exclusive end of the deleted band
  // Map each endpoint through the deletion: before the band it stays put, inside the band
  // it collapses onto the band edge, after the band it moves back by `count`.
  const na = a < index ? a : a < end ? index : a - count;
  const nb = b < index ? b : b < end ? index - 1 : b - count;
  if (nb < na) return null; // every row/column it covered is gone
  return { a: na, b: nb };
}

/**
 * Force an arbitrary list into the canonical merge list of SPEC 21.1.
 *
 * Every invariant is enforced here and nowhere else, so anything that reaches storage or
 * the wire has already been through this function:
 *   - every entry is a valid uppercase `A1:B2` range with no `$`
 *   - start is above/left of end (a backwards `C2:A1` is reordered, not dropped)
 *   - every entry covers at least 2 cells (a 1x1 "merge" is dropped)
 *   - every entry lies inside `rows` x `cols` (an entry hanging off the edge is CLIPPED;
 *     one that starts outside the sheet is dropped)
 *   - entries never overlap: when two overlap the FIRST in input order wins and the later
 *     one is dropped
 *   - the result is sorted by row, then column, so two equal lists are deep-equal
 *   - at most MAX_MERGES entries
 *
 * It NEVER throws. A non-array, a null entry, a number, 'nonsense', 'ZZZZ9999:A1' and a
 * sheet-qualified '시트2!A1:B2' are all simply dropped.
 *
 * `rows`/`cols` that are missing or non-numeric fall back to the hard sheet limits
 * (5000 x 702) rather than to the 200x26 default, so calling this without dimensions
 * validates the shape without silently clipping a legitimate merge. A numeric value is
 * clamped into 1..limit, exactly as everywhere else in this module.
 *
 * @param {any} list       candidate merge list (normally string[])
 * @param {number} [rows]  the sheet's row count
 * @param {number} [cols]  the sheet's column count
 * @returns {string[]} a fresh, canonical merge list
 */
export function normalizeMergeList(list, rows, cols) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const maxRows = clampInt(rows, 1, LIMIT_ROWS, LIMIT_ROWS);
  const maxCols = clampInt(cols, 1, LIMIT_COLS, LIMIT_COLS);

  const kept = [];
  for (const entry of list) {
    if (kept.length >= MAX_MERGES) break;
    const rect = parseMergeKey(entry); // a fresh object, safe to adjust in place
    if (!rect) continue;
    if (rect.r1 >= maxRows || rect.c1 >= maxCols) continue; // starts outside the sheet
    if (rect.r2 >= maxRows) rect.r2 = maxRows - 1; // clip to the sheet
    if (rect.c2 >= maxCols) rect.c2 = maxCols - 1;
    if (rectCellCount(rect) < 2) continue; // a single cell is not a merge
    // Overlap check against what has already been accepted. The list is short in every
    // real document (and hard-capped at MAX_MERGES), so a linear scan is the right shape.
    let clash = false;
    for (const seen of kept) {
      if (rectsOverlap(seen, rect)) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    kept.push(rect);
  }

  kept.sort(compareRects);
  return kept.map(rectKey);
}

/**
 * Geometry of one stored merge.
 *
 *   mergeRect('A1:C2')  ->  { r1: 0, c1: 0, r2: 1, c2: 2 }
 *
 * Corners are ordered and `$`/case are normalized, so 'c2:$a$1' yields the same rect.
 *
 * @param {string} rangeStr
 * @returns {{r1:number,c1:number,r2:number,c2:number}|null} null when unparseable
 */
export function mergeRect(rangeStr) {
  return parseMergeKey(rangeStr);
}

/**
 * Top-left cell of a stored merge — the one cell that keeps its contents.
 *
 *   mergeAnchor('B4:D9')  ->  { row: 3, col: 1 }
 *
 * @param {string} rangeStr
 * @returns {{row:number,col:number}|null} null when unparseable
 */
export function mergeAnchor(rangeStr) {
  const rect = parseMergeKey(rangeStr);
  return rect ? { row: rect.r1, col: rect.c1 } : null;
}

/**
 * The merge covering (row, col), if any.
 *
 *   mergeAt(['A1:C1'], 0, 2)  ->  'A1:C1'
 *   mergeAt(['A1:C1'], 1, 2)  ->  null
 *
 * Returns the entry exactly as it appears in `merges` (lists are always normalized, so
 * that is the canonical string), which keeps `merges.indexOf(mergeAt(...))` honest.
 *
 * @param {string[]} merges
 * @param {number} row
 * @param {number} col
 * @returns {string|null}
 */
export function mergeAt(merges, row, col) {
  if (!Array.isArray(merges) || merges.length === 0) return null;
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  for (const entry of merges) {
    const rect = parseMergeKey(entry);
    if (rect && rectHolds(rect, row, col)) return entry;
  }
  return null;
}

/**
 * Grow `rect` until no merge is only PARTIALLY covered by it — the rule that makes every
 * selection contain whole merged rectangles (SPEC 21.4).
 *
 *   expandOverMerges(['A1:C1'], { r1:0, c1:0, r2:0, c2:0 })  ->  { r1:0, c1:0, r2:0, c2:2 }
 *
 * It iterates to a FIXED POINT: swallowing one merge can bring a second into partial
 * overlap, which then has to be swallowed too. The loop is bounded by the number of
 * merges (a pass that grows nothing stops it, and a growing rect can absorb each
 * rectangle only once), so a pathological list can never spin forever.
 *
 * Accepts either rect shape and always returns a NEW rect; `rect` itself is never
 * touched, not even when nothing grows.
 *
 * @param {string[]} merges
 * @param {{r1:number,c1:number,r2:number,c2:number}|{s:{row:number,col:number},e:{row:number,col:number}}} rect
 * @returns {{r1:number,c1:number,r2:number,c2:number}}
 */
export function expandOverMerges(merges, rect) {
  let cur = normalizeRect(rect);
  const rects = parseMergeList(merges);
  if (!rects.length) return cur;

  // Each pass must strictly grow the rect to continue, and a growing rect can absorb any
  // one merge only once, so rects.length + 1 passes is a hard ceiling on the fixed point.
  const maxPasses = rects.length + 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let grew = false;
    for (const m of rects) {
      if (!rectsOverlap(m, cur)) continue;
      if (m.r1 >= cur.r1 && m.c1 >= cur.c1 && m.r2 <= cur.r2 && m.c2 <= cur.c2) continue;
      cur = {
        r1: Math.min(cur.r1, m.r1),
        c1: Math.min(cur.c1, m.c1),
        r2: Math.max(cur.r2, m.r2),
        c2: Math.max(cur.c2, m.c2),
      };
      grew = true;
    }
    if (!grew) break;
  }
  return cur;
}

// Row-major sort key for a cell, so `clear` comes back in natural reading order.
function cellOrder(row, col) {
  return row * LIMIT_COLS + col;
}

/**
 * Plan a merge over `rect`, in one of three modes.
 *
 *   'all'         one rectangle covering the whole rect
 *   'horizontal'  one rectangle per ROW of rect, each spanning its full width
 *   'vertical'    one rectangle per COLUMN of rect, each spanning its full height
 *
 * Any other `mode` (including undefined) is treated as `'all'`. Any existing merge that
 * intersects `rect` is absorbed (dropped) first — the new rectangles replace it. A
 * single-cell result is never emitted, so merging a 1-column selection 'horizontal'ly
 * produces nothing at all.
 *
 * The returned `clear` is every covered cell EXCEPT each new rectangle's anchor, sorted
 * row-major. The caller sends it as an ordinary `cells` patch of nulls, which is what
 * makes a merge undoable through the normal history path — and what makes the covered
 * cells genuinely empty for the formula engine.
 *
 * Worked example — a 2-row x 3-column selection over A1:C2, on a sheet whose only other
 * merge (B5:C5) is far away and is therefore kept:
 *
 *   planMerge(['B5:C5'], { r1:0, c1:0, r2:1, c2:2 }, 'all')
 *     -> { merges: ['A1:C2', 'B5:C5'], clear: ['B1','C1','A2','B2','C2'] }
 *   planMerge(['B5:C5'], { r1:0, c1:0, r2:1, c2:2 }, 'horizontal')
 *     -> { merges: ['A1:C1', 'A2:C2', 'B5:C5'], clear: ['B1','C1','B2','C2'] }
 *   planMerge(['B5:C5'], { r1:0, c1:0, r2:1, c2:2 }, 'vertical')
 *     -> { merges: ['A1:A2', 'B1:B2', 'C1:C2', 'B5:C5'], clear: ['A2','B2','C2'] }
 *   planMerge([], { r1:0, c1:0, r2:1, c2:0 }, 'horizontal')
 *     -> { merges: [], clear: [] }            // one column wide: nothing to merge
 *
 * Both returned arrays are fresh; `merges` is canonical (normalizeMergeList has run over
 * it) and `clear` only ever names cells inside a rectangle that actually survived into
 * `merges`. Enumeration of `clear` stops at MERGE_CLEAR_LIMIT keys, which no realistic
 * selection comes close to.
 *
 * @param {string[]} merges  the sheet's current merge list
 * @param {{r1:number,c1:number,r2:number,c2:number}|{s:{row:number,col:number},e:{row:number,col:number}}} rect
 * @param {'all'|'horizontal'|'vertical'} [mode]
 * @returns {{merges: string[], clear: string[]}}
 */
export function planMerge(merges, rect, mode) {
  const target = normalizeRect(rect);
  // Existing merges that touch the target are absorbed; the rest survive untouched.
  const survivors = parseMergeList(merges).filter((m) => !rectsOverlap(m, target));

  const fresh = [];
  if (mode === 'horizontal') {
    if (target.c2 > target.c1) {
      for (let r = target.r1; r <= target.r2; r++) {
        fresh.push({ r1: r, c1: target.c1, r2: r, c2: target.c2 });
      }
    }
  } else if (mode === 'vertical') {
    if (target.r2 > target.r1) {
      for (let c = target.c1; c <= target.c2; c++) {
        fresh.push({ r1: target.r1, c1: c, r2: target.r2, c2: c });
      }
    }
  } else if (rectCellCount(target) >= 2) {
    fresh.push({ ...target });
  }

  // The new rectangles are offered FIRST, so if MAX_MERGES is already crowded it is the
  // user's explicit action that survives rather than being silently ignored.
  const keys = fresh.map(rectKey).concat(survivors.map(rectKey));
  const nextMerges = normalizeMergeList(keys, LIMIT_ROWS, LIMIT_COLS);

  // `clear` is derived from the rectangles that actually made it into the result, so a
  // rectangle dropped by the cap never has its cells emptied.
  const accepted = new Set(nextMerges);
  const pending = [];
  let overflow = false;
  for (const f of fresh) {
    if (overflow) break;
    if (!accepted.has(rectKey(f))) continue;
    for (let r = f.r1; r <= f.r2 && !overflow; r++) {
      for (let c = f.c1; c <= f.c2; c++) {
        if (r === f.r1 && c === f.c1) continue; // the anchor keeps its contents
        if (pending.length >= MERGE_CLEAR_LIMIT) {
          overflow = true;
          break;
        }
        pending.push(cellOrder(r, c));
      }
    }
  }
  // 'vertical' fills column by column, so the sort is what makes `clear` row-major.
  pending.sort((a, b) => a - b);
  const clear = pending.map((n) => cellKeyOf(Math.floor(n / LIMIT_COLS), n % LIMIT_COLS));

  return { merges: nextMerges, clear };
}

/**
 * Plan an unmerge over `rect`: every merge intersecting it is dropped, the rest kept.
 *
 *   planUnmerge(['A1:C1', 'B5:C5'], { r1:0, c1:0, r2:0, c2:0 })  ->  { merges: ['B5:C5'] }
 *
 * Nothing is cleared and nothing is restored — unmerging only removes geometry, exactly
 * like Google Sheets, where the cells the merge had emptied stay empty.
 *
 * @param {string[]} merges
 * @param {{r1:number,c1:number,r2:number,c2:number}|{s:{row:number,col:number},e:{row:number,col:number}}} rect
 * @returns {{merges: string[]}}
 */
export function planUnmerge(merges, rect) {
  const target = normalizeRect(rect);
  const kept = parseMergeList(merges).filter((m) => !rectsOverlap(m, target));
  return { merges: normalizeMergeList(kept.map(rectKey), LIMIT_ROWS, LIMIT_COLS) };
}

/**
 * Move merge geometry through a structural edit, alongside the cell contents the engine
 * moves and the colWidths/rowHeights the server shifts.
 *
 * `edit` is the usual `{ kind:'insertRow'|'deleteRow'|'insertCol'|'deleteCol', index,
 * count }`. Per rectangle, on the axis the edit touches:
 *   - entirely before the edit     -> untouched
 *   - entirely after it            -> moved
 *   - spanning an insert point     -> grows by `count`
 *   - partially deleted            -> shrinks
 *   - wholly inside a deleted band -> disappears
 * and afterwards a rectangle that has shrunk (or been clipped by the sheet edge) to a
 * single cell disappears too, because a 1x1 merge is not a merge.
 *
 * Worked example, all on `['B2:D2']` (row 2, columns B..D) in a 200x26 sheet:
 *
 *   shiftMerges(['B2:D2'], { kind:'insertCol', index:2, count:1 }, 200, 26) -> ['B2:E2']
 *       // the new column lands inside the rectangle, so the rectangle grows
 *   shiftMerges(['B2:D2'], { kind:'insertCol', index:1, count:1 }, 200, 26) -> ['C2:E2']
 *       // inserted at its left edge: the whole rectangle slides right
 *   shiftMerges(['B2:D2'], { kind:'insertCol', index:4, count:1 }, 200, 26) -> ['B2:D2']
 *       // inserted past its right edge: nothing to do
 *   shiftMerges(['B2:D2'], { kind:'deleteCol', index:3, count:1 }, 200, 26) -> ['B2:C2']
 *       // column D is gone, so the rectangle shrinks by one
 *   shiftMerges(['B2:D2'], { kind:'deleteCol', index:1, count:3 }, 200, 26) -> []
 *       // every column it covered was deleted
 *   shiftMerges(['B2:C2'], { kind:'deleteCol', index:2, count:1 }, 200, 26) -> []
 *       // what is left is a single cell, which is not a merge
 *
 * An unknown `kind` (or a non-object `edit`) leaves the geometry alone and simply
 * re-normalizes it. The result is always re-normalized against `rows`/`cols`, so it comes
 * back canonical, overlap-free and inside the sheet.
 *
 * @param {string[]} merges
 * @param {{kind:string,index:number,count:number}} edit
 * @param {number} rows   the sheet's row count AFTER the edit
 * @param {number} cols   the sheet's column count AFTER the edit
 * @returns {string[]} a fresh, canonical merge list
 */
export function shiftMerges(merges, edit, rows, cols) {
  const kind = isPlainObject(edit) ? edit.kind : null;
  const isRow = kind === 'insertRow' || kind === 'deleteRow';
  const isCol = kind === 'insertCol' || kind === 'deleteCol';
  if (!isRow && !isCol) return normalizeMergeList(merges, rows, cols);

  const limit = isRow ? LIMIT_ROWS : LIMIT_COLS;
  const index = clampInt(edit.index, 0, limit, 0);
  const count = clampInt(edit.count === undefined ? 1 : edit.count, 1, limit, 1);
  const inserting = kind === 'insertRow' || kind === 'insertCol';

  const out = [];
  for (const m of parseMergeList(merges)) {
    const span = isRow
      ? shiftSpan(m.r1, m.r2, inserting, index, count)
      : shiftSpan(m.c1, m.c2, inserting, index, count);
    if (!span) continue; // wholly inside the deleted band
    const next = isRow
      ? { r1: span.a, c1: m.c1, r2: span.b, c2: m.c2 }
      : { r1: m.r1, c1: span.a, r2: m.r2, c2: span.b };
    if (rectCellCount(next) < 2) continue; // shrunk to a single cell
    out.push(rectKey(next));
  }
  // Re-normalize: clips anything an insert pushed off the sheet, drops what that clipping
  // reduces to a single cell, and restores the sort order.
  return normalizeMergeList(out, rows, cols);
}

// ---------------------------------------------------------------------------
// cell formatting, batch A (SPEC section 22)
//
// Six optional style keys ride the EXISTING style path — a style patch goes through the
// server's STYLE_KEYS whitelist, then `sanitizeStyle` below, then the engine's setStyle,
// then the grid paint. Nothing new exists at the protocol level:
//
//   ff    font family, one of the ids in FONT_STACKS
//   fs    font size in px, an integer 6..96
//   va    vertical alignment: 'top' | 'middle' | 'bottom'      (default 'bottom')
//   wrap  overflow behaviour: 'overflow' | 'wrap' | 'clip'     (default 'overflow')
//   rot   rotation: an integer -90..90, or 'v' (stacked vertical)
//   bd    borders: { t?, r?, b?, l? }, each an { w, s, c } edge
//
// Every key is OPTIONAL and absent means the default, so a cell that carries none of them
// sanitizes — and therefore renders — exactly as it did before this section existed.
//
// `FONT_STACKS` is a CLOSED set on purpose: `fontStackFor` is the only place in the whole
// codebase that turns a font choice into a CSS font-family string, so a hostile `ff` can
// never be interpolated into a style declaration. Never build a font string any other way.
//
// Every function here is PURE: arguments are only read, and everything handed back is
// freshly allocated (down to each individual border edge object).
// ---------------------------------------------------------------------------

/**
 * The closed set of selectable fonts: id -> CSS font-family list.
 * `default` is the app's own Korean-friendly stack, matching public/css/style.css.
 * @type {Object<string,string>}
 */
export const FONT_STACKS = {
  default: "'Pretendard','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',system-ui,sans-serif",
  gothic: "'Malgun Gothic','Apple SD Gothic Neo',sans-serif",
  myeongjo: "'Batang','Apple SD Gothic Neo',serif",
  mono: "'D2Coding','Consolas','Courier New',monospace",
  arial: 'Arial,Helvetica,sans-serif',
  times: "'Times New Roman',Times,serif",
};

/**
 * User-facing label per font id (Korean where a Korean name exists).
 * @type {Object<string,string>}
 */
export const FONT_LABELS = {
  default: '기본값',
  gothic: '고딕',
  myeongjo: '명조',
  mono: '고정폭',
  arial: 'Arial',
  times: 'Times',
};

/** The sizes offered by the toolbar's size menu. Any integer 6..96 is still valid. */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 30, 36, 48, 60];

/** The size a cell with no `fs` renders at — matches the stylesheet's cell font size. */
export const DEFAULT_FONT_SIZE = 13;

/** Widths a border edge may use, in px. */
export const BORDER_WIDTHS = [1, 2, 3];

/** Line styles a border edge may use. */
export const BORDER_STYLES = ['solid', 'dashed', 'dotted'];

// Membership is tested through Sets built once from the literals above, so a polluted
// Object.prototype can never make an unknown id look valid.
const FONT_IDS = new Set(Object.keys(FONT_STACKS));
const DEFAULT_FONT_ID = 'default';

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 96;

const VALIGNS = new Set(['top', 'middle', 'bottom']);
const WRAPS = new Set(['overflow', 'wrap', 'clip']);

// Rotation is an integer degree in [-MAX_ROTATION, MAX_ROTATION], or the string 'v'
// ("stacked vertical", which is a writing-mode rather than a rotation).
const MAX_ROTATION = 90;
const ROTATION_VERTICAL = 'v';

// Border sides, in the canonical order used for every object this module builds. Fixing
// the order keeps two equal border specs deep-equal AND byte-identical once serialized.
const BORDER_SIDES = ['t', 'r', 'b', 'l'];
const BORDER_WIDTH_SET = new Set(BORDER_WIDTHS);
const BORDER_STYLE_SET = new Set(BORDER_STYLES);

// What an edge field falls back to when it is simply absent.
const DEFAULT_BORDER_WIDTH = 1;
const DEFAULT_BORDER_STYLE = 'solid';
const DEFAULT_BORDER_COLOR = '#000000';

/** The presets `applyBorderPreset` understands. Anything else is a no-op. */
const BORDER_PRESETS = new Set([
  'all', 'outer', 'inner', 'top', 'right', 'bottom', 'left', 'horizontal', 'vertical', 'none',
]);

// Upper bound on how many cells `applyBorderPreset` will enumerate, mirroring the
// 200000-cell cap used by rangeCells() and by planMerge()'s `clear`. A whole default
// 200x26 sheet is 5200 cells, so no realistic selection comes near it.
const BORDER_PATCH_LIMIT = 200000;

/**
 * @typedef {Object} BorderEdge
 * @property {1|2|3} w                              width in px
 * @property {'solid'|'dashed'|'dotted'} s          line style
 * @property {string} c                             '#rrggbb'
 */

/**
 * @typedef {Object} Border
 * @property {BorderEdge} [t] top edge
 * @property {BorderEdge} [r] right edge
 * @property {BorderEdge} [b] bottom edge
 * @property {BorderEdge} [l] left edge
 */

/**
 * The CSS font-family string for a font id.
 *
 *   fontStackFor('mono')      -> "'D2Coding','Consolas','Courier New',monospace"
 *   fontStackFor('nope')      -> the default stack
 *   fontStackFor(undefined)   -> the default stack
 *
 * This is the ONLY place a font string is produced. Because the id is looked up in a
 * closed set and never interpolated, an `ff` value invented by a hostile client can only
 * ever select one of six known-good strings — it can never inject CSS.
 *
 * @param {any} id
 * @returns {string} a CSS font-family list, never empty
 */
export function fontStackFor(id) {
  if (typeof id === 'string' && FONT_IDS.has(id)) return FONT_STACKS[id];
  return FONT_STACKS[DEFAULT_FONT_ID];
}

// A strict integer from a number or a decimal string. No rounding and no clamping: 12.5,
// '1e2', '0x10', ' ', true, null and [] are all rejected. Anything unusable -> null.
function strictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^[+-]?[0-9]{1,7}$/.test(s)) return null;
    const n = Number(s);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

// style.ff -> a known font id, or null.
function sanitizeFontId(v) {
  return typeof v === 'string' && FONT_IDS.has(v) ? v : null;
}

// style.fs -> an integer inside 6..96, or null. Out of range is DROPPED, not clamped:
// a size nobody can read is a bug in the sender, and silently keeping a nearby value
// would hide it while still changing the document.
function sanitizeFontSize(v) {
  const n = strictInt(v);
  if (n === null || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) return null;
  return n;
}

// style.va -> 'top' | 'middle' | 'bottom', or null.
function sanitizeVAlign(v) {
  return typeof v === 'string' && VALIGNS.has(v) ? v : null;
}

// style.wrap -> 'overflow' | 'wrap' | 'clip', or null.
function sanitizeWrap(v) {
  return typeof v === 'string' && WRAPS.has(v) ? v : null;
}

// style.rot -> an integer -90..90, or 'v', or null. 'V' is accepted and normalized.
function sanitizeRotation(v) {
  if (typeof v === 'string' && v.trim().toLowerCase() === ROTATION_VERTICAL) {
    return ROTATION_VERTICAL;
  }
  const n = strictInt(v);
  if (n === null || n < -MAX_ROTATION || n > MAX_ROTATION) return null;
  return n;
}

/**
 * Validate one border edge.
 *
 * A field that is absent (or explicitly null) takes its default — `{}` is therefore a
 * perfectly good "1px solid black" edge. A field that is PRESENT but invalid drops the
 * whole edge, because a border of a width or colour the sender did not ask for is worse
 * than no border at all.
 *
 *   sanitizeBorderEdge({ w: 2, s: 'dashed', c: '#FF0000' }) -> { w:2, s:'dashed', c:'#ff0000' }
 *   sanitizeBorderEdge({ c: '#f00' })                       -> { w:1, s:'solid',  c:'#ff0000' }
 *   sanitizeBorderEdge({})                                  -> { w:1, s:'solid',  c:'#000000' }
 *   sanitizeBorderEdge({ w: 9 })                            -> null
 *   sanitizeBorderEdge('solid')                             -> null
 *
 * Always returns a FRESH object, with its keys in the canonical w/s/c order.
 *
 * @param {any} edge
 * @returns {BorderEdge|null}
 */
function sanitizeBorderEdge(edge) {
  if (!isPlainObject(edge)) return null;

  let w = DEFAULT_BORDER_WIDTH;
  if (edge.w !== undefined && edge.w !== null) {
    const n = strictInt(edge.w);
    if (n === null || !BORDER_WIDTH_SET.has(n)) return null;
    w = n;
  }

  let s = DEFAULT_BORDER_STYLE;
  if (edge.s !== undefined && edge.s !== null) {
    if (typeof edge.s !== 'string' || !BORDER_STYLE_SET.has(edge.s)) return null;
    s = edge.s;
  }

  let c = DEFAULT_BORDER_COLOR;
  if (edge.c !== undefined && edge.c !== null) {
    const hex = normalizeHex(edge.c);
    if (!hex) return null;
    c = hex;
  }

  return { w, s, c };
}

/**
 * Validate a whole `style.bd` value.
 *
 * Returns a fresh `{ t?, r?, b?, l? }` whose sides are in canonical order, or `null` when
 * nothing usable survives — which is exactly the value that CLEARS the key on its way
 * through the engine's `setStyle`, so "no valid border" and "no border" are the same
 * thing everywhere downstream.
 *
 *   sanitizeBorder({ t: { w:1, s:'solid', c:'#000000' } })
 *     -> { t: { w:1, s:'solid', c:'#000000' } }
 *   sanitizeBorder({ b: { w:2, s:'dotted', c:'#123ABC' }, x: { w:1 } })
 *     -> { b: { w:2, s:'dotted', c:'#123abc' } }        // 'x' is not a side
 *   sanitizeBorder({ t: { w: 7 }, l: {} })
 *     -> { l: { w:1, s:'solid', c:'#000000' } }         // the malformed edge is dropped
 *   sanitizeBorder({ t: { w: 7 } })   -> null           // nothing survived
 *   sanitizeBorder('all')             -> null
 *   sanitizeBorder(null)              -> null
 *
 * NEVER throws, whatever it is handed. `bd` itself is only ever read.
 *
 * @param {any} bd
 * @returns {Border|null}
 */
export function sanitizeBorder(bd) {
  if (!isPlainObject(bd)) return null;
  const out = {};
  for (const side of BORDER_SIDES) {
    const edge = sanitizeBorderEdge(bd[side]);
    if (edge) out[side] = edge;
  }
  return Object.keys(out).length ? out : null;
}

// Deep copy of a stored `style.bd` value, used by the cell-cloning path so a duplicated
// sheet shares NO mutable object with its original. Unlike sanitizeBorder this does not
// validate — it is only ever handed data that already went through sanitizeDoc — but it
// does keep to the four known sides, which is all that is ever stored.
function cloneBorderValue(bd) {
  if (!isPlainObject(bd)) return null;
  const out = {};
  for (const side of BORDER_SIDES) {
    const edge = bd[side];
    if (isPlainObject(edge)) out[side] = { ...edge };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Build the per-cell border patch for one toolbar preset.
 *
 * The result is `{ 'A1': Border|null, ... }`: a cell the preset does not touch is simply
 * ABSENT from it, and only `'none'` ever produces `null` (which clears that cell's
 * borders outright). The values are PARTIAL borders naming just the sides the preset
 * applies — the caller merges each one into that cell's existing `bd`:
 *
 *   const patch = applyBorderPreset(sel, 'outer', edge);
 *   for (const [a1, sides] of Object.entries(patch)) {
 *     const bd = sides === null ? null : { ...engine.getStyle(a1).bd, ...sides };
 *     cells[a1] = { style: { bd } };          // bd === null clears the key
 *   }
 *
 * This function reads and writes NO document: it is pure geometry plus a validated edge.
 *
 * An inner (shared) edge is written ONCE, onto the cell above/left of the pair — as the
 * upper cell's `b`, or the left cell's `r`. Both neighbours drawing the same line would
 * be harmless (SPEC 22.3 explicitly tolerates it), but a single owner keeps the patch
 * half the size and makes `'outer'` + `'inner'` cover every edge of the rectangle exactly
 * once. `'all'`, which is defined as every side of every cell, does double up on interior
 * edges — that is what the spec asks for, and the grid draws both.
 *
 * Presets:
 *
 *   'all'         every side of every cell
 *   'outer'       the perimeter only — the top row's `t`, the bottom row's `b`, the left
 *                 column's `l`, the right column's `r`; interior cells are untouched
 *   'inner'       the shared edges only; the perimeter is untouched
 *   'horizontal'  the inner horizontal edges only
 *   'vertical'    the inner vertical edges only
 *   'top' | 'right' | 'bottom' | 'left'   that one side of the perimeter
 *   'none'        null for every cell of the rect
 *
 * A 1x1 rect has no shared edges, so `'inner'`, `'horizontal'` and `'vertical'` return an
 * EMPTY patch for it, while `'outer'` and `'all'` both give that single cell all four
 * sides.
 *
 * Worked example — `'outer'` over A1:C2 (2 rows x 3 columns), with `E` standing for the
 * validated edge (each cell gets its own copy, never a shared object):
 *
 *   const E = { w: 1, s: 'solid', c: '#000000' };
 *   applyBorderPreset({ r1:0, c1:0, r2:1, c2:2 }, 'outer', E)
 *     -> { A1: { t:E, l:E },        B1: { t:E },        C1: { t:E, r:E },
 *          A2: { b:E, l:E },        B2: { b:E },        C2: { r:E, b:E } }
 *
 *        A1 is the top-LEFT corner, so it owns both the top and the left line; B1 sits on
 *        the top edge only; C2 is the bottom-RIGHT corner. Nothing is written on the
 *        A1|B1 or A1|A2 boundaries — those are interior.
 *
 * The same rect with `'inner'`:
 *
 *   applyBorderPreset({ r1:0, c1:0, r2:1, c2:2 }, 'inner', E)
 *     -> { A1: { r:E, b:E },        B1: { r:E, b:E },   C1: { b:E },
 *          A2: { r:E },             B2: { r:E } }
 *
 *        The two vertical lines (A|B and B|C) are written as A1/A2's and B1/B2's `r`; the
 *        one horizontal line (row 1|row 2) as row 1's `b`. C2 owns no interior edge at
 *        all, so it does not appear in the patch. Note that the perimeter is untouched:
 *        C1 gets `b` because that is the interior line under it, not `r`.
 *
 * And the degenerate cases:
 *
 *   applyBorderPreset({ r1:4, c1:1, r2:4, c2:1 }, 'inner', E)   -> {}
 *   applyBorderPreset({ r1:0, c1:0, r2:0, c2:1 }, 'none', E)    -> { A1: null, B1: null }
 *   applyBorderPreset({ r1:0, c1:0, r2:0, c2:1 }, 'nonsense', E)-> {}
 *
 * `rect` may be either shape the rest of this module accepts — `{r1,c1,r2,c2}` or the
 * grid's `{s:{row,col}, e:{row,col}}` — and its corners are ordered for you, so a
 * bottom-up drag works. `edge` is validated with the same rules as a stored edge; when it
 * is missing or malformed the default 1px solid black edge is used, so the user always
 * gets a visible border rather than a silent no-op.
 *
 * Enumeration stops at 200000 cells, which no realistic selection reaches.
 *
 * @param {{r1:number,c1:number,r2:number,c2:number}|{s:{row:number,col:number},e:{row:number,col:number}}} rect
 * @param {'all'|'outer'|'inner'|'top'|'right'|'bottom'|'left'|'horizontal'|'vertical'|'none'} preset
 * @param {BorderEdge} [edge]
 * @returns {Object<string, Border|null>} a fresh patch; `{}` when the preset touches nothing
 */
export function applyBorderPreset(rect, preset, edge) {
  const patch = {};
  if (typeof preset !== 'string' || !BORDER_PRESETS.has(preset)) return patch;

  const { r1, c1, r2, c2 } = normalizeRect(rect);
  let emitted = 0;

  if (preset === 'none') {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (emitted >= BORDER_PATCH_LIMIT) return patch;
        patch[cellKeyOf(r, c)] = null;
        emitted++;
      }
    }
    return patch;
  }

  // A malformed edge still draws: falling back beats swallowing the user's click.
  const base = sanitizeBorderEdge(edge) || {
    w: DEFAULT_BORDER_WIDTH,
    s: DEFAULT_BORDER_STYLE,
    c: DEFAULT_BORDER_COLOR,
  };

  // Which sides this preset writes on the cell at (r, c). Sides are assigned in the
  // canonical t/r/b/l order, and each one gets its OWN copy of the edge so no two cells
  // of the patch ever share a mutable object.
  const emit = (r, c) => {
    let top = false;
    let right = false;
    let bottom = false;
    let left = false;
    switch (preset) {
      case 'all':
        top = right = bottom = left = true;
        break;
      case 'outer':
        top = r === r1;
        bottom = r === r2;
        left = c === c1;
        right = c === c2;
        break;
      case 'inner':
        bottom = r < r2;
        right = c < c2;
        break;
      case 'horizontal':
        bottom = r < r2;
        break;
      case 'vertical':
        right = c < c2;
        break;
      case 'top':
        top = r === r1;
        break;
      case 'right':
        right = c === c2;
        break;
      case 'bottom':
        bottom = r === r2;
        break;
      case 'left':
        left = c === c1;
        break;
      default:
        break;
    }
    if (!top && !right && !bottom && !left) return true;
    if (emitted >= BORDER_PATCH_LIMIT) return false;
    const sides = {};
    if (top) sides.t = { ...base };
    if (right) sides.r = { ...base };
    if (bottom) sides.b = { ...base };
    if (left) sides.l = { ...base };
    patch[cellKeyOf(r, c)] = sides;
    emitted++;
    return true;
  };

  // Narrow the sweep to the band each preset can possibly write in, so a whole-sheet
  // selection with a one-line preset costs one line's worth of work, not the sheet's.
  const rowStart = preset === 'bottom' ? r2 : r1;
  const rowEnd = preset === 'top' ? r1 : preset === 'horizontal' ? r2 - 1 : r2;
  const colStart = preset === 'right' ? c2 : c1;
  const colEnd = preset === 'left' ? c1 : preset === 'vertical' ? c2 - 1 : c2;

  for (let r = rowStart; r <= rowEnd; r++) {
    // 'outer' writes nothing between the first and last column of an interior row, so
    // those two columns are visited directly instead of scanning across.
    if (preset === 'outer' && r !== r1 && r !== r2) {
      if (!emit(r, c1)) return patch;
      if (c2 !== c1 && !emit(r, c2)) return patch;
      continue;
    }
    for (let c = colStart; c <= colEnd; c++) {
      if (!emit(r, c)) return patch;
    }
  }
  return patch;
}

// ---------------------------------------------------------------------------
// data features, batch C (SPEC section 24)
//
// Three features that work on RANGES of data rather than on single cells. Each owns one
// optional field on the sheet, and a sheet that carries none of them costs nothing:
//
//   sheet.filter    a sort/filter VIEW           -> null when there is none
//   sheet.charts    inline-SVG charts            -> [] when there are none
//   sheet.comments  comment threads, keyed by A1 -> {} when there are none
//
// The single most important property here is that SORTING AND FILTERING ARE A VIEW. The
// document's rows are never reordered and never removed: `computeSortOrder` returns the
// order to PAINT rows in and `computeVisibleRows` returns which rows to paint at all. The
// engine keeps seeing the sheet exactly as it is stored, so no sort and no filter can ever
// move a cell out from under a formula. That is the whole design, and nothing below is
// allowed to write back into `cells`.
//
// The two compute helpers take an injected `valueOf(row, col)` so this module never
// imports the formula engine (which would be a cycle through the server, and dead weight
// in every consumer that only needs the document shape). `valueOf` returns a COMPUTED
// value from the value domain of shared/formula/values.js; when it is omitted the helpers
// fall back to reading raw inputs out of `cells`, which is enough for a filter dropdown
// built from static data.
//
// Ordering follows `compareValues` from shared/formula/values.js, so a sort matches
// formula semantics exactly: numbers before text before booleans, text compared
// case-insensitively. On top of that this module adds ONE rule of its own -- BLANK CELLS
// SORT LAST IN BOTH DIRECTIONS -- because a descending sort that floats every empty row to
// the top is the single thing users notice and complain about.
//
// SECURITY: comment text, comment author names and chart titles are user-supplied and
// arrive over the wire. They are validated here (length caps, control characters removed)
// but they are still TEXT: every consumer must insert them with `textContent`, never with
// `innerHTML`. Nothing in this module produces markup. `author`, `authorId` and `at` are
// stamped by the SERVER; the validation below deliberately does not, and cannot, make a
// client-supplied author trustworthy -- it only makes it harmless.
//
// Every function in this section is PURE: its arguments are only read, and everything it
// hands back is freshly allocated.
// ---------------------------------------------------------------------------

/** Hard cap on charts per sheet (SPEC 24.2). Extra entries are dropped, never merged. */
export const MAX_CHARTS = 20;

/** Hard cap on one comment message, in code points (SPEC 24.3). */
export const MAX_COMMENT_LEN = 4000;

/** Hard cap on comment threads per sheet (SPEC 24.3). */
export const MAX_COMMENTS_PER_SHEET = 500;

// --- filter -----------------------------------------------------------------

// Longest stored "hidden value" string. Display values are short in practice; the cap only
// exists so a hostile client cannot park megabytes in a filter definition.
const MAX_FILTER_VALUE_LEN = 1000;

// Hard caps on one filter definition: how many values may be hidden in a single column,
// and how many distinct values a dropdown will enumerate.
const MAX_FILTER_HIDDEN_VALUES = 5000;
const MAX_FILTER_DISTINCT = 2000;

// --- chart ------------------------------------------------------------------

const CHART_TYPE_SET = new Set(['column', 'bar', 'line', 'area', 'pie', 'scatter']);
const DEFAULT_CHART_TYPE = 'column';

const CHART_LEGEND_SET = new Set(['right', 'bottom', 'none']);
const DEFAULT_CHART_LEGEND = 'right';

const MAX_CHART_TITLE_LEN = 200;

// Pixel bounds. A chart is positioned in SHEET coordinates, and the tallest addressable
// sheet is 5000 rows x 400 px, so the position cap has to be generous; the size cap is
// what keeps a single chart from claiming an absurd slice of the overlay layer.
const MAX_CHART_POS = 2000000;
const MIN_CHART_SIZE = 80;
const MAX_CHART_SIZE = 4000;
const DEFAULT_CHART_W = 480;
const DEFAULT_CHART_H = 300;

// --- comment ----------------------------------------------------------------

const MAX_MESSAGES_PER_THREAD = 200;
const MAX_AUTHOR_LEN = 100;
const MAX_AUTHOR_ID_LEN = 64;

// Shown when a stored message carries no usable author name. The server stamps the real
// one; this is only ever seen on a hand-edited or truncated file.
const DEFAULT_COMMENT_AUTHOR = '익명';

// Timestamps are milliseconds since the epoch. The ceiling keeps a hostile `at` from
// producing a Date the UI cannot format.
const MAX_TIMESTAMP = 8640000000000000;

// Generated ids for charts, threads and messages: a two-letter prefix plus four base36
// characters. Validation is more tolerant than generation so an id minted elsewhere
// survives a round trip through disk untouched.
const SHORT_ID_RE = /^[a-z0-9]{4,24}$/;

// A numeric literal, for the raw-input fallback reader. Deliberately the same shape as
// NUMERIC_RE in shared/formula/values.js: no grouping separators, no hex, no leading '+'
// surprises.
const RAW_NUMERIC_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/**
 * @typedef {Object} FilterSort
 * @property {number} col  column index RELATIVE to the filter range (0 is its first column)
 * @property {'asc'|'desc'} dir
 */

/**
 * @typedef {Object} Filter
 * @property {string} range                       normalized A1 range, header row included
 * @property {boolean} header                     treat the range's first row as headers
 * @property {FilterSort|null} sort
 * @property {Object<string,string[]>} hidden     per RELATIVE column, the values HIDDEN
 */

/**
 * @typedef {Object} Chart
 * @property {string} id
 * @property {'column'|'bar'|'line'|'area'|'pie'|'scatter'} type
 * @property {string} range                       normalized A1 range
 * @property {string} title                       user text; render with textContent
 * @property {boolean} headerRow                  first row of range holds series names
 * @property {boolean} headerCol                  first column of range holds categories
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {'right'|'bottom'|'none'} legend
 */

/**
 * @typedef {Object} CommentMessage
 * @property {string} id
 * @property {string} author     display name, stamped by the SERVER; render with textContent
 * @property {string} authorId   peer id, stamped by the SERVER
 * @property {string} text       user text; render with textContent
 * @property {number} at         epoch ms, stamped by the SERVER; 0 when unknown
 */

/**
 * @typedef {Object} CommentThread
 * @property {string} id
 * @property {string} cell       the A1 key this thread hangs on (always its own map key)
 * @property {boolean} resolved
 * @property {CommentMessage[]} messages   at least one; a thread with none is dropped
 */

// A short id that is free within `taken` (which may be null). Same discipline as
// freeSheetId: caller-supplied numeric seed, per-load salt, internal counter, and a
// deterministic scan as a fallback so it can never loop forever.
function freeShortId(taken, prefix, seed) {
  for (let i = 0; i < 64; i++) {
    const id = prefix + newSheetId((seed || 0) + i).slice(0, 4);
    if (!taken || !taken.has(id)) return id;
  }
  for (let k = 0; k <= 100000; k++) {
    const id = prefix + chunk(k, 4);
    if (!taken || !taken.has(id)) return id;
  }
  return prefix + chunk(taken ? taken.size : 0, 4); // unreachable: every list is capped
}

/**
 * The DISPLAY text of a computed value — the string a filter matches against and a filter
 * dropdown lists. Blank is `''`, a number is its shortest round-trip form, a boolean is
 * `'TRUE'`/`'FALSE'`, and an error is its code (`'#DIV/0!'`).
 *
 * `toText` does the work, so this is the same text the formula engine would produce for
 * `&`, which is what keeps a filter's stored values matching the cells they came from.
 * Number FORMATTING (currency, decimals, dates) is deliberately NOT applied: it is a
 * per-cell style, and a filter that changed its matches when you changed a decimal place
 * would be a bug, not a feature.
 */
function displayText(v) {
  const t = toText(v);
  return typeof t === 'string' ? t : String(t);
}

// A value counts as blank when the cell looks empty: no value at all, or empty text.
function isBlankValue(v) {
  return v === null || v === undefined || v === '';
}

// Sort rank, coarser than compareValues' so errors have a defined home:
//   0 number (and Date, which is a serial) | 1 text | 2 boolean | 3 error/other | 4 blank
function sortRank(v) {
  if (isBlankValue(v)) return 4;
  if (typeof v === 'number') return Number.isFinite(v) ? 0 : 3;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  if (v instanceof Date) return 0;
  return 3;
}

// Ascending comparison of two NON-blank values. Ranks decide first (number < text <
// boolean < error); inside a rank compareValues does the work, so text is compared
// case-insensitively exactly as a formula would. compareValues can itself answer with a
// FormulaError for a pair it refuses to order — that is treated as "equal", which leaves
// the stable tie-break in charge instead of throwing away the row.
function compareRankedValues(a, b) {
  const ra = sortRank(a);
  const rb = sortRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 3) {
    const sa = displayText(a);
    const sb = displayText(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  const c = compareValues(a, b);
  return typeof c === 'number' ? c : 0;
}

// The comparator every ordering in this section uses. Blanks are pinned LAST before the
// direction is applied, so they stay last in a descending sort too.
function compareSortKeys(a, b, desc) {
  const ba = isBlankValue(a);
  const bb = isBlankValue(b);
  if (ba || bb) return ba && bb ? 0 : ba ? 1 : -1;
  const c = compareRankedValues(a, b);
  return desc ? -c : c;
}

// Build the `valueOf(row, col)` the compute helpers read through.
//
// When the caller injects one (the grid passes the engine's `getValue`) it is used, and
// wrapped so a throw from foreign code can never escape a pure helper. When it is absent
// the raw `cells` map is read instead and its inputs are interpreted the way the engine
// would interpret a literal: a numeric string becomes a number, TRUE/FALSE become
// booleans, and a formula is left as its own text (it cannot be computed here). That
// fallback is what lets `filterColumnValues(cells, range, col, header)` — the signature
// SPEC 24.1 names — work with nothing but a document.
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
  const map = isPlainObject(cells) ? cells : null;
  if (!map) return () => null;
  return (row, col) => {
    const entry = map[cellKeyOf(row, col)];
    if (!isPlainObject(entry)) return null;
    const input = entry.input;
    if (typeof input !== 'string' || input === '') return null;
    if (input.charCodeAt(0) === 61) return input; // '=' — a formula, uncomputable here
    const t = input.trim();
    if (t && RAW_NUMERIC_RE.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return n;
    }
    const upper = t.toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;
    return input;
  };
}

// One stored "hidden value" -> its canonical display text, or null when the entry cannot
// be a display value at all. `null` maps to '' so that "hide the blanks" is expressible.
function hiddenValueText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > MAX_FILTER_VALUE_LEN ? v.slice(0, MAX_FILTER_VALUE_LEN) : v;
  if (typeof v === 'number' && Number.isFinite(v)) return displayText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return null;
}

// Codepoint order for two plain strings. Used only to make stored lists deterministic.
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Parse a filter/chart range against a sheet's dimensions. Returns a FRESH rect clipped to
// the sheet, or null when the range is unparseable or starts outside it.
function rangeRectIn(value, maxRows, maxCols) {
  const rect = parseMergeKey(value);
  if (!rect) return null;
  if (rect.r1 >= maxRows || rect.c1 >= maxCols) return null;
  if (rect.r2 >= maxRows) rect.r2 = maxRows - 1;
  if (rect.c2 >= maxCols) rect.c2 = maxCols - 1;
  return rect;
}

/**
 * Validate / repair a sort-and-filter view (SPEC 24.1).
 *
 * The stored shape is:
 *
 *   { range: 'A1:F200', header: true,
 *     sort: { col: 2, dir: 'asc' } | null,
 *     hidden: { '2': ['취소', '보류'] } }
 *
 * `sort.col` and every `hidden` key are RELATIVE to `range` — column 0 is the range's own
 * first column — so moving the range does not have to rewrite them.
 *
 * Rules:
 *   - `range` must parse as an A1 range and must START inside `rows` x `cols`; an entry
 *     hanging off the far edge is CLIPPED, one that starts outside is fatal. The result is
 *     re-emitted canonically ('a1:$f$200' and 'F200:A1' both become 'A1:F200').
 *   - `header` defaults to TRUE when absent or null — a filter is nearly always created
 *     over a table that has a header row, and that is the value SPEC 24.1 shows.
 *   - `sort` survives only when `col` is an integer inside the range's width AND `dir` is
 *     'asc' or 'desc' (case-insensitively); anything else becomes `null`. A half-valid
 *     sort is dropped rather than guessed at, because guessing reorders the user's data.
 *   - `hidden` keeps only integer keys inside the range's width. Values are coerced to
 *     display text (a number or boolean is accepted and normalised), deduplicated, sorted
 *     and capped; a column whose list ends up empty is REMOVED, since a column with no
 *     hidden values filters nothing.
 *
 * NEVER throws. A non-object, a missing range, `'nonsense'`, a sheet-qualified
 * `'시트2!A1:B2'` and a range past the sheet all return `null`.
 *
 *   sanitizeFilter({ range: 'a1:c10' }, 200, 26)
 *     -> { range: 'A1:C10', header: true, sort: null, hidden: {} }
 *   sanitizeFilter({ range: 'A1:C10', header: false,
 *                    sort: { col: 1, dir: 'DESC' },
 *                    hidden: { '1': ['b', 'a', 'b'], '9': ['x'], '0': [] } }, 200, 26)
 *     -> { range: 'A1:C10', header: false, sort: { col: 1, dir: 'desc' },
 *          hidden: { '1': ['a', 'b'] } }        // '9' is outside the range, '0' is empty
 *   sanitizeFilter({ range: 'A1:C10', sort: { col: 7, dir: 'asc' } }, 200, 26)
 *     -> { range: 'A1:C10', header: true, sort: null, hidden: {} }
 *   sanitizeFilter(null, 200, 26)        -> null
 *   sanitizeFilter({ range: 'ZZ1:ZZ9' }, 200, 26) -> null   // starts past column Z
 *
 * `rows`/`cols` that are missing or non-numeric fall back to the hard sheet limits
 * (5000 x 702), so calling this without dimensions validates the shape without clipping.
 *
 * @param {any} f
 * @param {number} [rows]
 * @param {number} [cols]
 * @returns {Filter|null}
 */
export function sanitizeFilter(f, rows, cols) {
  if (!isPlainObject(f)) return null;
  const maxRows = clampInt(rows, 1, LIMIT_ROWS, LIMIT_ROWS);
  const maxCols = clampInt(cols, 1, LIMIT_COLS, LIMIT_COLS);
  const rect = rangeRectIn(f.range, maxRows, maxCols);
  if (!rect) return null;

  const width = rect.c2 - rect.c1 + 1;
  const header = f.header === undefined || f.header === null ? true : !!f.header;

  let sort = null;
  if (isPlainObject(f.sort)) {
    const col = strictInt(f.sort.col);
    const dir = typeof f.sort.dir === 'string' ? f.sort.dir.trim().toLowerCase() : '';
    if (col !== null && col >= 0 && col < width && (dir === 'asc' || dir === 'desc')) {
      sort = { col, dir };
    }
  }

  const hidden = {};
  if (isPlainObject(f.hidden)) {
    // Keys are collected with their ORIGINAL spelling so a padded '02' still finds its
    // list, then visited in ascending column order so the result is deterministic.
    const seenCols = new Set();
    const wanted = [];
    for (const key of Object.keys(f.hidden)) {
      const col = strictInt(key);
      if (col === null || col < 0 || col >= width || seenCols.has(col)) continue;
      seenCols.add(col);
      wanted.push({ col, key });
    }
    wanted.sort((a, b) => a.col - b.col);
    for (const { col, key } of wanted) {
      const raw = f.hidden[key];
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const seen = new Set();
      const list = [];
      for (const entry of raw) {
        if (list.length >= MAX_FILTER_HIDDEN_VALUES) break;
        const text = hiddenValueText(entry);
        if (text === null || seen.has(text)) continue;
        seen.add(text);
        list.push(text);
      }
      if (!list.length) continue; // a column with no hidden values filters nothing
      list.sort(compareText);
      hidden[String(col)] = list;
    }
  }

  return { range: rectKey(rect), header, sort, hidden };
}

/**
 * The distinct DISPLAY values of one filter column, with their counts — the data behind
 * the filter dropdown's checkbox list (SPEC 24.1).
 *
 * `col` is RELATIVE to `range`, matching `filter.sort.col` and the keys of
 * `filter.hidden`. When `header` is true the range's first row is skipped, so the header
 * text never shows up as one of its own column's values.
 *
 * `values` is sorted with the SAME comparator a sort uses — numbers before text before
 * booleans, text case-insensitively, blanks last — so the dropdown lists 9 before 10
 * rather than in string order. `counts` is a Map from each display value to how many rows
 * carry it, inserted in the same order, so iterating either gives the same sequence. The
 * blank bucket is the empty string `''`; the caller labels it (전체 / (공백)) itself.
 *
 *   // A1:B4 where B holds 30, (blank), 10, and A1:B1 is a header row
 *   filterColumnValues(cells, 'A1:B4', 1, true, valueOf)
 *     -> { values: ['10', '30', ''], counts: Map { '10' => 1, '30' => 1, '' => 1 } }
 *
 * `valueOf(row, col)` is optional: without it the raw `cells` map is read instead, which
 * is enough for a sheet of literals and degrades gracefully (a formula lists as its own
 * text) rather than throwing. Enumeration stops after MAX_FILTER_DISTINCT distinct values;
 * rows past that point still increment an existing bucket, they just cannot open a new one.
 *
 * NEVER throws. An unparseable range, or a `col` outside the range, yields
 * `{ values: [], counts: new Map() }`.
 *
 * @param {Object<string,{input?:string}>} cells
 * @param {string} range
 * @param {number} col      RELATIVE column index inside `range`
 * @param {boolean} [header]
 * @param {(row:number, col:number)=>any} [valueOf]
 * @returns {{values: string[], counts: Map<string, number>}}
 */
export function filterColumnValues(cells, range, col, header, valueOf) {
  const out = { values: [], counts: new Map() };
  const rect = parseMergeKey(range);
  if (!rect) return out;
  const rel = strictInt(col);
  if (rel === null || rel < 0 || rel > rect.c2 - rect.c1) return out;

  const abs = rect.c1 + rel;
  const useHeader = header === undefined || header === null ? true : !!header;
  const first = rect.r1 + (useHeader ? 1 : 0);
  const read = valueReader(cells, valueOf);

  // text -> { text, value, count }. The first value seen for a bucket is kept so the
  // ordering can use the real value (30 as a number) rather than its display string.
  const buckets = new Map();
  for (let row = first; row <= rect.r2; row++) {
    const value = read(row, abs);
    const text = displayText(value);
    const hit = buckets.get(text);
    if (hit) {
      hit.count++;
    } else if (buckets.size < MAX_FILTER_DISTINCT) {
      buckets.set(text, { text, value, count: 1 });
    }
  }

  const list = Array.from(buckets.values());
  list.sort((a, b) => compareSortKeys(a.value, b.value, false) || compareText(a.text, b.text));
  for (const item of list) {
    out.values.push(item.text);
    out.counts.set(item.text, item.count);
  }
  return out;
}

/**
 * Which rows survive the filter (SPEC 24.1).
 *
 * Returns a Set of ABSOLUTE row indexes to PAINT. Nothing is deleted and nothing is
 * moved: the grid simply skips a row that is not in the set, exactly as it skips a hidden
 * row, and every formula still sees the full sheet.
 *
 * Rules:
 *   - rows OUTSIDE the filter range are always visible;
 *   - the header row, when `filter.header`, is always visible;
 *   - a row is hidden when ANY filtered column's display value is in that column's hidden
 *     list (columns combine with AND, which is what every spreadsheet does);
 *   - a column with no hidden values filters nothing;
 *   - a missing, malformed or empty filter hides nothing at all.
 *
 *   // filter { range:'A1:B5', header:true, hidden:{ '1': ['보류'] } } and a column B of
 *   // ['상태', '완료', '보류', '완료', '보류'] over rows 1..5
 *   computeVisibleRows(cells, filter, valueOf, 5)   ->  Set { 0, 1, 3 }
 *
 * `rowCount` is the sheet's row count. It is optional only so the three-argument signature
 * SPEC 24.1 names keeps working; PASS IT. The set spans `0 .. rowCount-1`, and without it
 * the whole addressable 5000 rows are enumerated, which is correct but larger than the
 * caller needs.
 *
 * NEVER throws, and never calls `valueOf` at all when nothing is hidden — a sheet with no
 * filter costs one Set fill and no cell reads. It is still O(rows), so the caller should
 * compute it when the filter or the data changes, not on every repaint.
 *
 * @param {Object<string,{input?:string}>} cells
 * @param {Filter|null} filter
 * @param {(row:number, col:number)=>any} [valueOf]
 * @param {number} [rowCount]
 * @returns {Set<number>} absolute row indexes that survive
 */
export function computeVisibleRows(cells, filter, valueOf, rowCount) {
  const bound = clampInt(rowCount, 1, LIMIT_ROWS, LIMIT_ROWS);
  const visible = new Set();
  for (let row = 0; row < bound; row++) visible.add(row);

  const f = sanitizeFilter(filter, LIMIT_ROWS, LIMIT_COLS);
  if (!f) return visible;
  const rect = parseMergeKey(f.range);
  if (!rect) return visible;

  // One Set per filtered column, built once so the row loop is a hash lookup per column.
  const columns = [];
  for (const key of Object.keys(f.hidden)) {
    const values = f.hidden[key];
    if (!Array.isArray(values) || !values.length) continue;
    columns.push({ col: rect.c1 + Number(key), hidden: new Set(values) });
  }
  if (!columns.length) return visible; // nothing is hidden: every row survives

  const read = valueReader(cells, valueOf);
  const first = rect.r1 + (f.header ? 1 : 0); // the header row is never filtered out
  const last = Math.min(rect.r2, bound - 1);
  for (let row = first; row <= last; row++) {
    for (const column of columns) {
      if (column.hidden.has(displayText(read(row, column.col)))) {
        visible.delete(row);
        break;
      }
    }
  }
  return visible;
}

/**
 * The order to PAINT rows in (SPEC 24.1).
 *
 * Returns absolute row indexes in DISPLAY order: `order[0]` is the row to draw first.
 * With no sort it is the identity order `[0, 1, 2, ...]`. The document is never touched —
 * this is the entire reason a sort here cannot corrupt a formula the way a real row move
 * would.
 *
 * Rules:
 *   - only the rows INSIDE the filter range are permuted, and only among themselves;
 *     every row above or below the range keeps its own position;
 *   - the header row, when `filter.header`, NEVER moves;
 *   - ordering is `compareValues` from shared/formula/values.js, so it matches formula
 *     semantics: numbers < text < booleans, text case-insensitively;
 *   - BLANK CELLS SORT LAST IN BOTH DIRECTIONS;
 *   - the sort is STABLE: rows with equal keys keep their original relative order, and the
 *     tie-break is never reversed by `dir: 'desc'`.
 *
 * Worked example. A filter over `A1:B6` with a header row, sorting on the range's column
 * 1 (spreadsheet column B). The sheet, with absolute row indexes on the left:
 *
 *   0   '이름'  |  '점수'     <- the header row
 *   1   '가'    |  30
 *   2   '나'    |  (blank)
 *   3   '다'    |  10
 *   4   '라'    |  '십'        <- text, not a number
 *   5   '마'    |  10
 *
 *   const filter = { range:'A1:B6', header:true, sort:{ col:1, dir:'asc' }, hidden:{} };
 *   computeSortOrder(cells, filter, valueOf, 6)      ->  [0, 3, 5, 1, 4, 2]
 *
 *     0  the header row, pinned in place
 *     3  10       numbers come first ...
 *     5  10       ... and 10 === 10, so the STABLE order keeps row 3 ahead of row 5
 *     1  30
 *     4  '십'     text sorts after every number
 *     2  (blank)  blanks LAST
 *
 *   const desc = { ...filter, sort:{ col:1, dir:'desc' } };
 *   computeSortOrder(cells, desc, valueOf, 6)        ->  [0, 4, 1, 3, 5, 2]
 *
 *     0  the header again
 *     4  '십'     the whole ordering is reversed, so text now leads ...
 *     1  30
 *     3  10       ... but 10 === 10 STILL keeps row 3 ahead of row 5, because the
 *     5  10           tie-break is the original position and is never reversed
 *     2  (blank)  and the blank is STILL last -- that is the detail people notice
 *
 * `rowCount` is the sheet's row count; see `computeVisibleRows` for why it is optional.
 * A sheet with no sort should not call this at all — the identity order is exactly what
 * the grid already does — and a sheet with one should cache the result rather than
 * re-sorting on every repaint.
 *
 * NEVER throws.
 *
 * @param {Object<string,{input?:string}>} cells
 * @param {Filter|null} filter
 * @param {(row:number, col:number)=>any} [valueOf]
 * @param {number} [rowCount]
 * @returns {number[]} absolute row indexes, in display order
 */
export function computeSortOrder(cells, filter, valueOf, rowCount) {
  const bound = clampInt(rowCount, 1, LIMIT_ROWS, LIMIT_ROWS);
  const order = new Array(bound);
  for (let row = 0; row < bound; row++) order[row] = row;

  const f = sanitizeFilter(filter, LIMIT_ROWS, LIMIT_COLS);
  if (!f || !f.sort) return order;
  const rect = parseMergeKey(f.range);
  if (!rect) return order;

  const first = rect.r1 + (f.header ? 1 : 0); // the header row never moves
  const last = Math.min(rect.r2, bound - 1);
  if (last <= first) return order; // zero or one sortable row: nothing to do

  const col = rect.c1 + f.sort.col;
  const desc = f.sort.dir === 'desc';
  const read = valueReader(cells, valueOf);

  // `pos` makes the sort stable no matter what the host's Array#sort does, and it is
  // compared unreversed so equal keys keep their original order in BOTH directions.
  const band = [];
  for (let row = first; row <= last; row++) {
    band.push({ row, key: read(row, col), pos: band.length });
  }
  band.sort((a, b) => compareSortKeys(a.key, b.key, desc) || a.pos - b.pos);
  for (let i = 0; i < band.length; i++) order[first + i] = band[i].row;
  return order;
}

/**
 * Validate / repair one chart (SPEC 24.2).
 *
 * Returns a fresh, canonical chart, or `null` when it is unusable. The ONLY fatal problem
 * is the range: a chart with no data to draw is nothing at all. Everything else is clamped
 * to something drawable, because a chart that silently vanishes because its width arrived
 * as a string is worse than a chart at its default size.
 *
 *   - `id`      kept when it looks like an id, otherwise generated (like a sheet id).
 *               `sanitizeChartList` resolves collisions across a list.
 *   - `type`    CLAMPED to one of column | bar | line | area | pie | scatter;
 *               anything else becomes 'column'.
 *   - `range`   must parse and must START inside `rows` x `cols`; clipped to the sheet,
 *               re-emitted canonically. Fatal when absent or outside.
 *   - `title`   user text: control characters removed, whitespace collapsed, capped at
 *               200 characters. Render it with textContent — it is never markup.
 *   - `headerRow` / `headerCol`  plain booleans, default false.
 *   - `x`,`y`   clamped to 0..2000000 px (sheet coordinates, not screen coordinates).
 *   - `w`,`h`   clamped to 80..4000 px; a missing or unusable value takes 480 x 300.
 *   - `legend`  'right' | 'bottom' | 'none', default 'right'.
 *
 *   sanitizeChart({ range: 'a1:c10' }, 200, 26)
 *     -> { id:'ch…', type:'column', range:'A1:C10', title:'', headerRow:false,
 *          headerCol:false, x:0, y:0, w:480, h:300, legend:'right' }
 *   sanitizeChart({ range: 'A1:C10', type: 'donut', w: 5, legend: 'left' }, 200, 26)
 *     -> { …, type:'column', w:80, legend:'right' }
 *   sanitizeChart({ type: 'pie' }, 200, 26)   -> null      // no range
 *   sanitizeChart('pie', 200, 26)             -> null
 *
 * NEVER throws.
 *
 * @param {any} c
 * @param {number} [rows]
 * @param {number} [cols]
 * @returns {Chart|null}
 */
export function sanitizeChart(c, rows, cols) {
  if (!isPlainObject(c)) return null;
  const maxRows = clampInt(rows, 1, LIMIT_ROWS, LIMIT_ROWS);
  const maxCols = clampInt(cols, 1, LIMIT_COLS, LIMIT_COLS);
  const rect = rangeRectIn(c.range, maxRows, maxCols);
  if (!rect) return null;

  const id = typeof c.id === 'string' && SHORT_ID_RE.test(c.id) ? c.id : freeShortId(null, 'ch', 0);
  const type = typeof c.type === 'string' && CHART_TYPE_SET.has(c.type) ? c.type : DEFAULT_CHART_TYPE;
  const title = typeof c.title === 'string' ? collapse(c.title).slice(0, MAX_CHART_TITLE_LEN) : '';
  const legend =
    typeof c.legend === 'string' && CHART_LEGEND_SET.has(c.legend) ? c.legend : DEFAULT_CHART_LEGEND;

  return {
    id,
    type,
    range: rectKey(rect),
    title,
    headerRow: !!c.headerRow,
    headerCol: !!c.headerCol,
    x: clampInt(c.x, 0, MAX_CHART_POS, 0),
    y: clampInt(c.y, 0, MAX_CHART_POS, 0),
    w: clampInt(c.w, MIN_CHART_SIZE, MAX_CHART_SIZE, DEFAULT_CHART_W),
    h: clampInt(c.h, MIN_CHART_SIZE, MAX_CHART_SIZE, DEFAULT_CHART_H),
    legend,
  };
}

/**
 * Validate / repair a whole chart list (SPEC 24.2).
 *
 * Invalid entries are DROPPED without throwing, ids are made unique inside the list (the
 * first spelling of a duplicate wins and the later one is re-minted), document order is
 * preserved because it is the paint order, and the list is capped at MAX_CHARTS.
 *
 *   sanitizeChartList([{ range:'A1:B2' }, 'nope', null, { type:'pie' }], 200, 26)
 *     -> [ { id:'ch…', type:'column', range:'A1:B2', … } ]
 *   sanitizeChartList(null, 200, 26)   -> []
 *
 * @param {any} list
 * @param {number} [rows]
 * @param {number} [cols]
 * @returns {Chart[]} a fresh list, at most MAX_CHARTS long
 */
export function sanitizeChartList(list, rows, cols) {
  const out = [];
  if (!Array.isArray(list) || list.length === 0) return out;
  const taken = new Set();
  for (const entry of list) {
    if (out.length >= MAX_CHARTS) break;
    let chart = null;
    try {
      chart = sanitizeChart(entry, rows, cols);
    } catch {
      chart = null; // a single unreadable chart must never take the document down
    }
    if (!chart) continue;
    if (taken.has(chart.id)) chart = { ...chart, id: freeShortId(taken, 'ch', out.length) };
    taken.add(chart.id);
    out.push(chart);
  }
  return out;
}

// Comment text: user-supplied, so every character is inspected. Control characters are
// removed, with two deliberate exceptions — TAB and NEWLINE — because a comment thread is
// prose and people press Enter in it. CR / CRLF are folded to a single LF first so a
// message typed on Windows does not double-space itself. The result is trimmed and capped
// at MAX_COMMENT_LEN CODE POINTS (not UTF-16 units), so the cap can never slice an emoji
// or a Hangul syllable in half.
//
// This is a hygiene pass, not an escaping pass: the text is still arbitrary user input and
// MUST be inserted with textContent. Nothing here makes it safe as HTML, and nothing here
// tries to.
function cleanCommentText(v) {
  if (typeof v !== 'string' || v === '') return '';
  const folded = v.replace(/\r\n?/g, '\n');
  let out = '';
  for (const ch of folded) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10) {
      out += ch; // tab and newline survive
      continue;
    }
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) continue;
    out += ch;
  }
  out = out.trim();
  if (out.length > MAX_COMMENT_LEN) {
    const points = Array.from(out);
    if (points.length > MAX_COMMENT_LEN) out = points.slice(0, MAX_COMMENT_LEN).join('');
    out = out.trim();
  }
  return out;
}

// One message of a thread. `author` / `authorId` / `at` are SERVER-stamped fields; this
// only bounds them. A message with no text left after cleaning is not a message.
function sanitizeMessage(m, takenIds, seed) {
  if (!isPlainObject(m)) return null;
  const text = cleanCommentText(m.text);
  if (!text) return null;

  const id =
    typeof m.id === 'string' && SHORT_ID_RE.test(m.id) && !takenIds.has(m.id)
      ? m.id
      : freeShortId(takenIds, 'ms', seed);
  const author =
    (typeof m.author === 'string' ? collapse(m.author).slice(0, MAX_AUTHOR_LEN) : '') ||
    DEFAULT_COMMENT_AUTHOR;
  const authorId =
    typeof m.authorId === 'string' ? collapse(m.authorId).slice(0, MAX_AUTHOR_ID_LEN) : '';

  // A timestamp that is not a positive finite number becomes 0 ("unknown"). It is never
  // replaced with the current time: this module has no clock, and inventing one here would
  // let a client's malformed frame masquerade as a fresh comment.
  const raw = typeof m.at === 'number' ? m.at : Number(m.at);
  const at = Number.isFinite(raw) && raw > 0 ? Math.floor(Math.min(raw, MAX_TIMESTAMP)) : 0;

  return { id, author, authorId, text, at };
}

// One thread. `cell` is forced to the map key it was found under — a thread can never
// claim to live somewhere other than where it is stored.
function sanitizeThread(src, key) {
  if (!isPlainObject(src)) return null;
  const messages = [];
  const takenIds = new Set();
  const raw = Array.isArray(src.messages) ? src.messages : [];
  for (const entry of raw) {
    if (messages.length >= MAX_MESSAGES_PER_THREAD) break;
    const msg = sanitizeMessage(entry, takenIds, messages.length);
    if (!msg) continue;
    takenIds.add(msg.id);
    messages.push(msg);
  }
  if (!messages.length) return null; // a thread with nothing in it is not a thread

  const id = typeof src.id === 'string' && SHORT_ID_RE.test(src.id) ? src.id : freeShortId(null, 'cm', 0);
  return { id, cell: key, resolved: !!src.resolved, messages };
}

/**
 * Validate / repair a sheet's comment threads (SPEC 24.3).
 *
 * The stored shape is a map from cell key to thread:
 *
 *   { 'B4': { id, cell:'B4', resolved:false,
 *             messages: [{ id, author, authorId, text, at }] } }
 *
 * Rules:
 *   - every key must be a cell A1 inside `rows` x `cols`; it is uppercased and canonical
 *     ('b4' and 'B4' are the same thread, first one wins). Anything else is dropped.
 *   - `thread.cell` is FORCED to its own key; a thread cannot claim another cell.
 *   - `id`s are kept when they look like ids and generated otherwise, and made unique
 *     across the sheet (threads) and within a thread (messages).
 *   - `resolved` is a plain boolean.
 *   - each message needs non-empty text after cleaning: control characters are stripped
 *     (tab and newline survive), the text is trimmed and capped at MAX_COMMENT_LEN code
 *     points. A message with nothing left is dropped, and a thread with no messages left
 *     is dropped with it.
 *   - `author` / `authorId` are bounded strings; `at` is a positive integer or 0.
 *     NONE of these are trustworthy just because they validate — the SERVER stamps them,
 *     and must overwrite whatever a client sent.
 *   - threads come back sorted row-major, so two equal comment maps serialize identically.
 *   - at most MAX_COMMENTS_PER_SHEET threads and MAX_MESSAGES_PER_THREAD messages each.
 *
 *   sanitizeComments({ b4: { messages: [{ text: ' 확인 부탁드립니다 ', author: '민수',
 *                                         authorId: 'p1', at: 1730000000000 }] } }, 200, 26)
 *     -> { B4: { id:'cm…', cell:'B4', resolved:false,
 *                messages: [{ id:'ms…', author:'민수', authorId:'p1',
 *                             text:'확인 부탁드립니다', at:1730000000000 }] } }
 *   sanitizeComments({ B4: { messages: [{ text: '   ' }] } }, 200, 26)  -> {}
 *   sanitizeComments({ ZZZ9999: { messages: [{ text: 'x' }] } }, 200, 26) -> {}
 *   sanitizeComments('nope', 200, 26)  -> {}
 *
 * NEVER throws, whatever it is handed.
 *
 * @param {any} map
 * @param {number} [rows]
 * @param {number} [cols]
 * @returns {Object<string, CommentThread>} a fresh map
 */
export function sanitizeComments(map, rows, cols) {
  const out = {};
  if (!isPlainObject(map)) return out;
  const maxRows = clampInt(rows, 1, LIMIT_ROWS, LIMIT_ROWS);
  const maxCols = clampInt(cols, 1, LIMIT_COLS, LIMIT_COLS);

  const entries = [];
  const seenKeys = new Set();
  for (const rawKey of Object.keys(map)) {
    const key = String(rawKey).toUpperCase();
    if (seenKeys.has(key)) continue; // 'b4' and 'B4' are the same cell; the first wins
    const pos = parseCellKey(key);
    if (!pos) continue;
    if (pos.row >= maxRows || pos.col >= maxCols) continue; // outside the sheet
    let thread = null;
    try {
      thread = sanitizeThread(map[rawKey], key);
    } catch {
      thread = null; // one unreadable thread must never take the document down
    }
    if (!thread) continue;
    seenKeys.add(key);
    entries.push({ order: cellOrder(pos.row, pos.col), key, thread });
  }

  entries.sort((a, b) => a.order - b.order);
  const takenIds = new Set();
  let kept = 0;
  for (const entry of entries) {
    if (kept >= MAX_COMMENTS_PER_SHEET) break;
    let thread = entry.thread;
    if (takenIds.has(thread.id)) thread = { ...thread, id: freeShortId(takenIds, 'cm', kept) };
    takenIds.add(thread.id);
    out[entry.key] = thread;
    kept++;
  }
  return out;
}

// The axis a structural edit acts on, plus its normalised index/count. Returns null for
// anything that is not one of the four structural kinds.
function structAxis(edit) {
  const kind = isPlainObject(edit) ? edit.kind : null;
  const isRow = kind === 'insertRow' || kind === 'deleteRow';
  const isCol = kind === 'insertCol' || kind === 'deleteCol';
  if (!isRow && !isCol) return null;
  const limit = isRow ? LIMIT_ROWS : LIMIT_COLS;
  return {
    isRow,
    inserting: kind === 'insertRow' || kind === 'insertCol',
    index: clampInt(edit.index, 0, limit, 0),
    count: clampInt(edit.count === undefined ? 1 : edit.count, 1, limit, 1),
    limit,
  };
}

// Move a rect through a structural edit. Returns a fresh rect, or null when every row or
// column it covered was deleted.
function shiftRect(rect, axis) {
  const span = axis.isRow
    ? shiftSpan(rect.r1, rect.r2, axis.inserting, axis.index, axis.count)
    : shiftSpan(rect.c1, rect.c2, axis.inserting, axis.index, axis.count);
  if (!span) return null;
  return axis.isRow
    ? { r1: span.a, c1: rect.c1, r2: span.b, c2: rect.c2 }
    : { r1: rect.r1, c1: span.a, r2: rect.r2, c2: span.b };
}

// Move one absolute row/column index through a structural edit. Returns null when it was
// deleted or pushed off the sheet.
function shiftIndex(value, axis) {
  let next = value;
  if (axis.inserting) {
    if (next >= axis.index) next += axis.count;
  } else if (next >= axis.index && next < axis.index + axis.count) {
    return null; // inside the deleted band
  } else if (next >= axis.index + axis.count) {
    next -= axis.count;
  }
  return next >= 0 && next < axis.limit ? next : null;
}

/**
 * Move a filter view through a structural edit, alongside the cells the engine moves and
 * the merges `shiftMerges` moves (SPEC 24.1 + 24.3).
 *
 * `edit` is the usual `{ kind:'insertRow'|'deleteRow'|'insertCol'|'deleteCol', index,
 * count }`. The range follows the same rules a merged rectangle does: an insert before it
 * slides it, an insert inside it grows it, a delete shrinks it, and a filter whose whole
 * band is deleted returns `null`.
 *
 * The subtle part is that `sort.col` and the `hidden` keys are RELATIVE to the range, so a
 * COLUMN edit has to remap them: the column each one names is moved as an absolute
 * column, then re-expressed against the range's new left edge. A column that was deleted
 * loses its hidden list, and a sort on a deleted column becomes `null` — the alternative,
 * leaving the index alone, would silently sort by a different column's data.
 *
 *   // range B2:E9 covers columns B C D E, so relative column 2 is D and 3 is E:
 *   const f = { range:'B2:E9', header:true, sort:{ col:2, dir:'asc' },
 *               hidden:{ '3': ['x'] } };            // sort on D, hiding a value in E
 *   shiftFilter(f, { kind:'insertCol', index:1, count:1 }, 200, 27)
 *     -> { range:'C2:F9', header:true, sort:{ col:2, dir:'asc' }, hidden:{ '3': ['x'] } }
 *        // a column landed before the range: the whole range slid right and every
 *        // relative index is unchanged, because D and E slid with it
 *   shiftFilter(f, { kind:'insertCol', index:3, count:1 }, 200, 27)
 *     -> { range:'B2:F9', header:true, sort:{ col:3, dir:'asc' }, hidden:{ '4': ['x'] } }
 *        // a column landed INSIDE the range at D, so the range grew and D/E moved right
 *   shiftFilter(f, { kind:'deleteCol', index:3, count:1 }, 200, 25)
 *     -> { range:'B2:D9', header:true, sort:null, hidden:{ '2': ['x'] } }
 *        // column D is gone: the sort on it is dropped, E's hidden list follows it left
 *   shiftFilter(f, { kind:'deleteCol', index:1, count:4 }, 200, 22)   -> null
 *        // every column the filter covered was deleted
 *
 * An unknown `kind` (or a non-object `edit`) just re-validates the filter against the new
 * dimensions. The result always comes back through `sanitizeFilter`, so it is canonical.
 *
 * @param {Filter|null} filter
 * @param {{kind:string,index:number,count:number}} edit
 * @param {number} rows  the sheet's row count AFTER the edit
 * @param {number} cols  the sheet's column count AFTER the edit
 * @returns {Filter|null}
 */
export function shiftFilter(filter, edit, rows, cols) {
  const current = sanitizeFilter(filter, LIMIT_ROWS, LIMIT_COLS);
  if (!current) return null;
  const axis = structAxis(edit);
  if (!axis) return sanitizeFilter(current, rows, cols);

  const rect = parseMergeKey(current.range);
  if (!rect) return null;
  const next = shiftRect(rect, axis);
  if (!next) return null; // every row/column the filter covered is gone

  let sort = current.sort;
  let hidden = current.hidden;
  if (!axis.isRow) {
    // Relative -> absolute -> shifted -> relative again, against the NEW left edge.
    const remap = (rel) => {
      const moved = shiftIndex(rect.c1 + rel, axis);
      if (moved === null) return null;
      const out = moved - next.c1;
      return out >= 0 && out <= next.c2 - next.c1 ? out : null;
    };
    sort = null;
    if (current.sort) {
      const col = remap(current.sort.col);
      if (col !== null) sort = { col, dir: current.sort.dir };
    }
    hidden = {};
    for (const key of Object.keys(current.hidden)) {
      const col = remap(Number(key));
      if (col === null) continue;
      hidden[String(col)] = current.hidden[key];
    }
  }

  return sanitizeFilter({ range: rectKey(next), header: current.header, sort, hidden }, rows, cols);
}

/**
 * Move every chart's range through a structural edit (SPEC 24.2).
 *
 * A chart whose range is wholly inside a deleted band disappears; the others grow, shrink
 * or slide exactly as a merged rectangle does. `x`, `y`, `w` and `h` are PIXEL geometry in
 * sheet coordinates and are deliberately left alone: this module does not know the sheet's
 * column widths, so it cannot honestly reposition a chart, and a chart that stays put is
 * far easier to understand than one that jumps by a guessed amount.
 *
 *   shiftCharts([{ id:'ch01', range:'B2:D9', … }], { kind:'deleteCol', index:1, count:1 }, 200, 25)
 *     -> [{ id:'ch01', range:'B2:C9', … }]
 *   shiftCharts([{ id:'ch01', range:'B2:D9', … }], { kind:'deleteCol', index:1, count:3 }, 200, 23)
 *     -> []
 *
 * @param {Chart[]} charts
 * @param {{kind:string,index:number,count:number}} edit
 * @param {number} rows  the sheet's row count AFTER the edit
 * @param {number} cols  the sheet's column count AFTER the edit
 * @returns {Chart[]} a fresh, canonical list
 */
export function shiftCharts(charts, edit, rows, cols) {
  const list = sanitizeChartList(charts, LIMIT_ROWS, LIMIT_COLS);
  if (!list.length) return [];
  const axis = structAxis(edit);
  if (!axis) return sanitizeChartList(list, rows, cols);

  const moved = [];
  for (const chart of list) {
    const rect = parseMergeKey(chart.range);
    if (!rect) continue;
    const next = shiftRect(rect, axis);
    if (!next) continue; // the whole band the chart plotted is gone
    moved.push({ ...chart, range: rectKey(next) });
  }
  return sanitizeChartList(moved, rows, cols);
}

/**
 * Move every comment thread through a structural edit (SPEC 24.3).
 *
 * A comment key follows its cell, exactly as `shiftCellLinks` moves a hyperlink: an insert
 * before it pushes it down/right, a delete before it pulls it back, and a comment on a
 * deleted row or column is DROPPED along with the cell it annotated.
 *
 *   shiftComments({ B4: t }, { kind:'insertRow', index:0, count:2 }, 202, 26) -> { B6: … }
 *   shiftComments({ B4: t }, { kind:'deleteRow', index:3, count:1 }, 199, 26) -> {}
 *   shiftComments({ B4: t }, { kind:'deleteCol', index:0, count:1 }, 200, 25) -> { A4: … }
 *
 * Each surviving thread's `cell` is rewritten to its new key, so a thread never disagrees
 * with where it is stored. The result comes back through `sanitizeComments`, so it is
 * canonical and re-sorted row-major.
 *
 * @param {Object<string, CommentThread>} comments
 * @param {{kind:string,index:number,count:number}} edit
 * @param {number} rows  the sheet's row count AFTER the edit
 * @param {number} cols  the sheet's column count AFTER the edit
 * @returns {Object<string, CommentThread>} a fresh map
 */
export function shiftComments(comments, edit, rows, cols) {
  const map = sanitizeComments(comments, LIMIT_ROWS, LIMIT_COLS);
  const keys = Object.keys(map);
  if (!keys.length) return {};
  const axis = structAxis(edit);
  if (!axis) return sanitizeComments(map, rows, cols);

  const moved = {};
  for (const key of keys) {
    const pos = parseCellKey(key);
    if (!pos) continue;
    const next = shiftIndex(axis.isRow ? pos.row : pos.col, axis);
    if (next === null) continue; // the cell, and with it the thread, is gone
    const nextKey = axis.isRow ? cellKeyOf(next, pos.col) : cellKeyOf(pos.row, next);
    if (moved[nextKey]) continue; // defensive: the mapping is injective, so unreachable
    moved[nextKey] = { ...map[key], cell: nextKey };
  }
  return sanitizeComments(moved, rows, cols);
}

// ---------------------------------------------------------------------------
// sheets
// ---------------------------------------------------------------------------

/**
 * Build a brand new, empty sheet object.
 * An id that does not look like a sheet id is replaced by a generated one; an empty name
 * falls back to DEFAULT_SHEET_NAME. Uniqueness inside a document is the caller's job —
 * `addSheet` / `duplicateSheet` / `sanitizeDoc` all go through `uniqueSheetName`.
 *
 * `merges` starts as an empty array, never undefined, so every consumer can iterate it
 * without a guard.
 *
 * @param {string} [id]
 * @param {string} [name]
 * @returns {Sheet}
 */
export function emptySheet(id, name) {
  const sheetId = typeof id === 'string' && SHEET_ID_RE.test(id) ? id : newSheetId(0);
  return {
    id: sheetId,
    name: sanitizeSheetName(name) || DEFAULT_SHEET_NAME,
    color: null,
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
    cells: {},
    colWidths: {},
    rowHeights: {},
    frozenRows: 0,
    frozenCols: 0,
    merges: [],
    // Batch-C state starts empty, never undefined, so every consumer can read it without
    // a guard — the same contract `merges` already has.
    filter: null,
    charts: [],
    comments: {},
  };
}

/**
 * Validate / repair one sheet-shaped object.
 * `takenIds` / `takenNames` accumulate what has already been used inside the document, so
 * a duplicate id or name is replaced rather than kept. Both sets are updated in place.
 * Never throws.
 *
 * @param {any} src
 * @param {Set<string>} takenIds
 * @param {Set<string>} takenNames  lowercased names
 * @returns {Sheet}
 */
function sanitizeSheet(src, takenIds, takenNames) {
  const obj = isPlainObject(src) ? src : {};
  const rows = clampInt(obj.rows, 1, LIMIT_ROWS, DEFAULT_ROWS);
  const cols = clampInt(obj.cols, 1, LIMIT_COLS, DEFAULT_COLS);

  const id =
    typeof obj.id === 'string' && SHEET_ID_RE.test(obj.id) && !takenIds.has(obj.id)
      ? obj.id
      : freeSheetId(takenIds, 0);
  const name = uniqueNameAmong(takenNames, obj.name);

  takenIds.add(id);
  takenNames.add(nameKey(name));

  return {
    id,
    name,
    color: normalizeHex(obj.color),
    rows,
    cols,
    cells: sanitizeCells(obj.cells, rows, cols),
    colWidths: sanitizeSizeMap(obj.colWidths, cols, MIN_COL_WIDTH, MAX_COL_WIDTH),
    rowHeights: sanitizeSizeMap(obj.rowHeights, rows, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT),
    frozenRows: clampInt(obj.frozenRows, 0, rows, 0),
    frozenCols: clampInt(obj.frozenCols, 0, cols, 0),
    // A missing / malformed list becomes [], never undefined: every consumer iterates it.
    merges: normalizeMergeList(obj.merges, rows, cols),
    // Batch C (SPEC section 24). Each validator answers with its own "nothing here" value
    // — null / [] / {} — so a sheet written before these existed loads with them empty
    // rather than undefined, and a sheet carrying them keeps exactly what survives
    // validation. All three are clipped to this sheet's rows x cols.
    filter: sanitizeFilter(obj.filter, rows, cols),
    charts: sanitizeChartList(obj.charts, rows, cols),
    comments: sanitizeComments(obj.comments, rows, cols),
  };
}

// MIGRATION — project a v1 document (one sheet stored inline on the document) onto the
// sheet shape. The document's own `name` is deliberately NOT used as the sheet name: a
// migrated sheet is always DEFAULT_SHEET_NAME, the document keeps its own title.
function legacySheetSource(obj) {
  return {
    id: null,
    name: DEFAULT_SHEET_NAME,
    color: null,
    rows: obj.rows,
    cols: obj.cols,
    cells: obj.cells,
    colWidths: obj.colWidths,
    rowHeights: obj.rowHeights,
    frozenRows: obj.frozenRows,
    frozenCols: obj.frozenCols,
    // v1 predates merged cells; carried across anyway so a hand-edited file is not lost.
    merges: obj.merges,
    // Likewise for the batch-C fields: v1 never wrote them, but a hand-edited file might.
    filter: obj.filter,
    charts: obj.charts,
    comments: obj.comments,
  };
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/**
 * Build a brand new, empty document holding exactly one blank sheet named '시트1'.
 *
 * @param {string} [id]    reused when it is a valid document id, otherwise generated
 * @param {string} [name]  document title; blank falls back to '제목 없는 스프레드시트'
 * @returns {Doc}
 */
export function emptyDoc(id, name) {
  const now = Date.now();
  const docId = typeof id === 'string' && ID_RE.test(id) ? id : newId(now);
  return {
    id: docId,
    name: sanitizeName(name),
    sheets: [emptySheet(newSheetId(now), DEFAULT_SHEET_NAME)],
    createdAt: now,
    updatedAt: now,
    rev: 0,
  };
}

/**
 * Validate / repair an arbitrary object into a well-formed multi-sheet document.
 *
 * - drops unknown keys, clamps sizes, removes out-of-sheet cells and empty entries
 * - MIGRATES a v1 document (top-level cells/rows/cols/colWidths/rowHeights/frozenRows/
 *   frozenCols, no `sheets`) into a single sheet named DEFAULT_SHEET_NAME, carrying every
 *   field across
 * - a `sheets` field that is missing, empty, not an array, or holds nothing usable yields
 *   exactly one sheet (the migrated v1 sheet when there is legacy content, else a blank one)
 * - idempotent: a v2 document passes through unchanged, ids and names included
 * - sheet ids and names are made unique inside the document; sheets past MAX_SHEETS are
 *   dropped
 *
 * Throws TypeError only when `obj` is not an object. It runs against files already on
 * disk, so it never throws on a partially-corrupt document.
 *
 * @param {any} obj
 * @returns {Doc}
 */
export function sanitizeDoc(obj) {
  // Only a non-object (or null) is rejected; any object — however malformed — is repaired.
  if (obj === null || typeof obj !== 'object') {
    throw new TypeError('sanitizeDoc: expected a document object');
  }
  const now = Date.now();

  const id = typeof obj.id === 'string' && ID_RE.test(obj.id) ? obj.id : newId(now);
  const name = sanitizeName(obj.name);

  const takenIds = new Set();
  const takenNames = new Set();
  const sheets = [];

  const rawSheets = Array.isArray(obj.sheets) ? obj.sheets : [];
  for (const entry of rawSheets) {
    if (sheets.length >= MAX_SHEETS) break;
    if (!isPlainObject(entry)) continue;
    try {
      sheets.push(sanitizeSheet(entry, takenIds, takenNames));
    } catch {
      // A single unreadable sheet entry is skipped; loading the document must not fail.
    }
  }

  if (!sheets.length) {
    // No usable `sheets` array: either a v1 document to migrate, or an empty shell.
    try {
      sheets.push(sanitizeSheet(legacySheetSource(obj), takenIds, takenNames));
    } catch {
      sheets.push(emptySheet(freeSheetId(takenIds, 0), DEFAULT_SHEET_NAME));
    }
  }

  const createdRaw = Number(obj.createdAt);
  const createdAt = Number.isFinite(createdRaw) && createdRaw > 0 ? Math.floor(createdRaw) : now;
  const updatedRaw = Number(obj.updatedAt);
  const updatedAt = Number.isFinite(updatedRaw) && updatedRaw > 0 ? Math.floor(updatedRaw) : createdAt;

  return {
    id,
    name,
    sheets,
    createdAt,
    updatedAt,
    rev: clampInt(obj.rev, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

// ---------------------------------------------------------------------------
// pure sheet operations
//
// Every helper below returns a NEW document and never mutates its argument. A no-op
// returns the SAME reference, so `next === doc` means "refused / nothing changed".
// ---------------------------------------------------------------------------

/**
 * Look a sheet up by id.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @returns {Sheet|null} the live sheet object (do not mutate it), or null when absent
 */
export function findSheet(doc, sheetId) {
  if (typeof sheetId !== 'string' || !sheetId) return null;
  const sheets = sheetsOf(doc);
  for (const sheet of sheets) {
    if (sheet && sheet.id === sheetId) return sheet;
  }
  return null;
}

/**
 * Position of a sheet in tab order.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @returns {number} index, or -1 when the sheet is absent
 */
export function sheetIndex(doc, sheetId) {
  if (typeof sheetId !== 'string' || !sheetId) return -1;
  const sheets = sheetsOf(doc);
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i] && sheets[i].id === sheetId) return i;
  }
  return -1;
}

/**
 * Append a new blank sheet.
 * Placed directly after `afterId` when that sheet exists, otherwise at the end.
 * Refuses (returns the document unchanged, with `sheet: null`) once MAX_SHEETS is reached
 * — the server turns that into an error frame; this helper never throws.
 *
 * @param {Doc} doc
 * @param {{id?:string, name?:string, afterId?:string, seed?:number}} [opts]
 * @returns {{doc: Doc, sheet: Sheet|null}}
 */
export function addSheet(doc, opts = {}) {
  const options = isPlainObject(opts) ? opts : {};
  const sheets = sheetsOf(doc);
  if (sheets.length >= MAX_SHEETS) return { doc, sheet: null };

  const takenIds = takenIdsOf(sheets);
  const id =
    typeof options.id === 'string' && SHEET_ID_RE.test(options.id) && !takenIds.has(options.id)
      ? options.id
      : freeSheetId(takenIds, options.seed);
  const name = uniqueNameAmong(takenNamesOf(sheets), options.name);

  const sheet = emptySheet(id, name);
  const next = sheets.slice();
  const after = typeof options.afterId === 'string' ? sheetIndex(doc, options.afterId) : -1;
  if (after >= 0) next.splice(after + 1, 0, sheet);
  else next.push(sheet);

  return { doc: withSheets(doc, next), sheet };
}

/**
 * Rename a sheet. The name is trimmed, capped at 100 chars and made unique against the
 * OTHER sheets (so renaming a sheet to the name it already has is a no-op rather than
 * producing 'name (2)'). An empty name falls back to the lowest free '시트<n>'.
 * An unknown `sheetId` returns the document unchanged.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @param {string} name
 * @returns {Doc}
 */
export function renameSheet(doc, sheetId, name) {
  const idx = sheetIndex(doc, sheetId);
  if (idx < 0) return doc;
  const sheets = sheetsOf(doc);
  const next = uniqueNameAmong(takenNamesOf(sheets, idx), name);
  if (next === sheets[idx].name) return doc;
  const arr = sheets.slice();
  arr[idx] = { ...sheets[idx], name: next };
  return withSheets(doc, arr);
}

/**
 * Remove a sheet. Refuses to remove the last one (a document always has at least one
 * sheet) and ignores an unknown id — both return the document unchanged.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @returns {Doc}
 */
export function deleteSheet(doc, sheetId) {
  const sheets = sheetsOf(doc);
  if (sheets.length <= 1) return doc;
  const idx = sheetIndex(doc, sheetId);
  if (idx < 0) return doc;
  const arr = sheets.slice();
  arr.splice(idx, 1);
  return withSheets(doc, arr);
}

/**
 * Move a sheet to `index` in tab order. The index is clamped into range; a non-numeric
 * index, an unknown sheet id, or a move that changes nothing returns the document
 * unchanged.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @param {number} index
 * @returns {Doc}
 */
export function reorderSheet(doc, sheetId, index) {
  const idx = sheetIndex(doc, sheetId);
  if (idx < 0) return doc;
  const sheets = sheetsOf(doc);
  const target = clampInt(index, 0, sheets.length - 1, idx);
  if (target === idx) return doc;
  const arr = sheets.slice();
  const [moved] = arr.splice(idx, 1);
  arr.splice(target, 0, moved);
  return withSheets(doc, arr);
}

/**
 * Duplicate a sheet, inserting the copy directly after the original.
 * The copy is deep: cells, colWidths, rowHeights and every style object are fresh, so it
 * shares NO mutable object with the original. Its default name is
 * `uniqueSheetName(doc, original.name + ' 복사본')`.
 * Refuses (document unchanged, `sheet: null`) on an unknown id or once MAX_SHEETS is
 * reached; never throws.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @param {{id?:string, name?:string, seed?:number}} [opts]
 * @returns {{doc: Doc, sheet: Sheet|null}}
 */
export function duplicateSheet(doc, sheetId, opts = {}) {
  const options = isPlainObject(opts) ? opts : {};
  const idx = sheetIndex(doc, sheetId);
  if (idx < 0) return { doc, sheet: null };
  const sheets = sheetsOf(doc);
  if (sheets.length >= MAX_SHEETS) return { doc, sheet: null };

  const src = sheets[idx];
  const takenIds = takenIdsOf(sheets);
  const id =
    typeof options.id === 'string' && SHEET_ID_RE.test(options.id) && !takenIds.has(options.id)
      ? options.id
      : freeSheetId(takenIds, options.seed);
  const wanted =
    typeof options.name === 'string' && sanitizeSheetName(options.name)
      ? options.name
      : String(src.name || DEFAULT_SHEET_NAME) + DUPLICATE_SUFFIX;
  const name = uniqueNameAmong(takenNamesOf(sheets), wanted);

  const rows = clampInt(src.rows, 1, LIMIT_ROWS, DEFAULT_ROWS);
  const cols = clampInt(src.cols, 1, LIMIT_COLS, DEFAULT_COLS);
  const sheet = {
    id,
    name,
    color: normalizeHex(src.color),
    rows,
    cols,
    cells: cloneCells(src.cells),
    colWidths: cloneSizeMap(src.colWidths),
    rowHeights: cloneSizeMap(src.rowHeights),
    frozenRows: clampInt(src.frozenRows, 0, rows, 0),
    frozenCols: clampInt(src.frozenCols, 0, cols, 0),
    // Fresh array of immutable strings: the copy shares nothing with the original.
    merges: normalizeMergeList(src.merges, rows, cols),
    // The batch-C validators all rebuild their result from scratch, so the duplicate
    // shares no mutable object with the original here either.
    filter: sanitizeFilter(src.filter, rows, cols),
    charts: sanitizeChartList(src.charts, rows, cols),
    comments: sanitizeComments(src.comments, rows, cols),
  };

  const arr = sheets.slice();
  arr.splice(idx + 1, 0, sheet);
  return { doc: withSheets(doc, arr), sheet };
}

/**
 * Set (or clear) a sheet's tab colour.
 * Accepts '#rrggbb' case-insensitively — and '#rgb', which is expanded — storing it
 * lowercased, exactly like cell bg/fg colours. Anything else, `null` included, clears the
 * colour. An unknown sheet id, or a colour that is already set, returns the document
 * unchanged.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @param {string|null} color
 * @returns {Doc}
 */
export function setSheetColor(doc, sheetId, color) {
  const idx = sheetIndex(doc, sheetId);
  if (idx < 0) return doc;
  const sheets = sheetsOf(doc);
  const next = normalizeHex(color);
  if (next === (sheets[idx].color === undefined ? null : sheets[idx].color)) return doc;
  const arr = sheets.slice();
  arr[idx] = { ...sheets[idx], color: next };
  return withSheets(doc, arr);
}

// ---------------------------------------------------------------------------
// growing a sheet (SPEC section 25)
//
// A sheet starts at DEFAULT_ROWS x DEFAULT_COLS (200 x 26, A..Z) and can grow up to
// LIMIT_ROWS x LIMIT_COLS (5000 x 702, A..ZZ) — the extent shared/formula/ has supported
// all along. Until growth existed there was no way to reach past the starting size at
// all: 행 삽입 shifts cells WITHIN the sheet and never changes its extent, so a user simply
// ran out of grid.
//
// Two properties are what make growth safe to fire at any moment, including from an
// auto-grow that triggers while the user is scrolling:
//
//   1. It is strictly ADDITIVE. `rows` / `cols` are the ONLY fields that change; cells,
//      merges, filter, charts, comments, colWidths and rowHeights are carried across by
//      reference, untouched and unmoved. Not one key is rewritten, so no formula, merge
//      rectangle, chart range or comment anchor can be invalidated. Contrast a structural
//      edit, which has to shift every one of those and rewrite every reference.
//   2. There is deliberately NO shrink. Removing rows that hold data — or that a formula,
//      a merge or a chart range points at — is what 행 삭제 is for, and that path already
//      carries the reference rewriting (`shiftRefForStructuralEdit`, `shiftMerges`,
//      `shiftFilter`, `shiftCharts`, `shiftComments`) that makes removal safe. A negative
//      request here is ignored, never applied as a shrink.
//
// `sanitizeDoc` needs nothing new: it has always clamped `rows`/`cols` into 1..LIMIT with
// `clampInt`, so a grown extent survives a round trip through disk and the wire, and only
// a missing or unusable value falls back to the 200 x 26 default.
// ---------------------------------------------------------------------------

/** Rows added by one press of 맨 아래에 행 추가, and by one auto-grow at the bottom edge. */
export const ROW_GROW_STEP = 1000;

/** Columns added by one press of 오른쪽에 열 추가, and by one auto-grow at the right edge. */
export const COL_GROW_STEP = 26;

// How much to actually add on one axis: the request, floored to a whole count, never
// negative and never more than `remaining`. Anything unusable — undefined, null, NaN,
// Infinity, a negative number, a non-numeric string — means "add nothing", which is what
// keeps growSheet's no-op identity guarantee true for every kind of junk a caller can
// hand it. Flooring (rather than rounding) means a fractional request can only ever grow
// by less than it asked for, never by more.
function growAmount(request, remaining) {
  if (remaining <= 0) return 0;
  const n = typeof request === 'number' ? request : Number(request);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const want = Math.floor(n);
  if (want <= 0) return 0;
  return want > remaining ? remaining : want;
}

/**
 * Grow one sheet's extent by `rows` rows and/or `cols` columns.
 *
 * PURE: the document handed in is never mutated. A sheet that actually grows is replaced
 * by a fresh object (spread, so every other field — cells, merges, filter, charts,
 * comments, colWidths, rowHeights, frozen panes, name, colour — is carried across by
 * reference in its original key order); every other sheet is shared as-is.
 *
 * When nothing would change the SAME document reference comes back, so a caller can use
 * `next === doc` as a cheap "nothing happened" test — which is exactly what the auto-grow
 * path needs, since it fires speculatively on every scroll near an edge and must not emit
 * a wire frame for a sheet that is already at its maximum.
 *
 * Growth is clamped to LIMIT_ROWS / LIMIT_COLS (MAX_ROWS / MAX_COLS in
 * shared/formula/refs.js — 5000 x 702). A request for more than remains grows by exactly
 * what remains. A negative or non-finite request is ignored; there is no shrink path.
 *
 * Worked example — the whole life of a sheet, from new to maximum:
 *
 *   const doc = emptyDoc('abc123def456', '보고서');   // one sheet, 200 x 26
 *   const id  = doc.sheets[0].id;
 *
 *   const a = growSheet(doc, id, { rows: ROW_GROW_STEP });
 *   //  a !== doc ; a.sheets[0] -> { rows: 1200, cols: 26 }
 *   //  doc.sheets[0] is still { rows: 200, cols: 26 } — the argument was not touched
 *
 *   const b = growSheet(a, id, { cols: COL_GROW_STEP });   // rows defaults to 0
 *   //  b.sheets[0] -> { rows: 1200, cols: 52 }            // now A..AZ
 *
 *   const c = growSheet(b, id, { rows: 99999, cols: 99999 });
 *   //  c.sheets[0] -> { rows: 5000, cols: 702 }           // CLAMPED: grew by what remained
 *   //                                                     // (3800 rows and 650 columns)
 *
 *   growSheet(c, id, { rows: ROW_GROW_STEP, cols: COL_GROW_STEP }) === c   // at the maximum
 *   growSheet(c, id, {})                                           === c   // nothing asked
 *   growSheet(b, id, { rows: 0, cols: 0 })                         === b   // zero request
 *   growSheet(b, id, { rows: -500 })                               === b   // never a shrink
 *   growSheet(b, id, { rows: NaN, cols: Infinity })                === b   // not a number
 *   growSheet(b, 'no-such-sheet', { rows: 1000 })                  === b   // unknown sheet
 *
 * A partially-satisfiable request still applies: on a 4900-row sheet
 * `growSheet(doc, id, { rows: ROW_GROW_STEP })` yields 5000, not 5900 and not a refusal.
 * The two axes are independent — `{ rows: 1000, cols: 99999 }` on a 4000 x 26 sheet grows
 * rows to 5000 and columns to 702 in the one call.
 *
 * Never throws, whatever it is handed.
 *
 * @param {Doc} doc
 * @param {string} sheetId
 * @param {{rows?:number, cols?:number}} [opts]
 * @returns {Doc} a new document, or `doc` itself when nothing changed
 */
export function growSheet(doc, sheetId, opts = {}) {
  const idx = sheetIndex(doc, sheetId);
  if (idx < 0) return doc;

  const options = isPlainObject(opts) ? opts : {};
  const sheets = sheetsOf(doc);
  const sheet = sheets[idx];

  // Read the current extent through the same clamp everything else in this module uses,
  // so "what remains" is measured against a sane number even for a hand-edited sheet.
  const curRows = clampInt(sheet.rows, 1, LIMIT_ROWS, DEFAULT_ROWS);
  const curCols = clampInt(sheet.cols, 1, LIMIT_COLS, DEFAULT_COLS);

  const addRows = growAmount(options.rows, LIMIT_ROWS - curRows);
  const addCols = growAmount(options.cols, LIMIT_COLS - curCols);
  // Both axes refused: hand back the very same document, untouched.
  if (addRows === 0 && addCols === 0) return doc;

  const arr = sheets.slice();
  // Spread: `rows` and `cols` already exist on the sheet, so this replaces their values in
  // place and leaves every other field — and the key order — exactly as it was.
  arr[idx] = { ...sheet, rows: curRows + addRows, cols: curCols + addCols };
  return withSheets(doc, arr);
}
