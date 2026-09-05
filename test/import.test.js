// test/import.test.js — importing a paste from another spreadsheet (SPEC section 26).
//
// The unit under test is `parseExternalHtml` in public/js/clipboard.js: it turns the
// `text/html` flavour of a clipboard payload — arbitrary markup written by software this
// app does not control — into a rectangular grid of `{ input, style, merge }`.
//
// What this file pins down, in order of how much it matters:
//
//   1. NOTHING FROM THE MARKUP IS EVER TRUSTED. Every case below runs its result through
//      `checkGrid`, which re-validates the whole grid against SPEC 22.1: a colour must be
//      `#rrggbb`, a font must be an id from FONT_STACKS, a size must be an integer 6..96,
//      and no style value may be a raw CSS string. A style property taken verbatim from
//      the clipboard fails every case in the file at once, not just the hostile ones.
//   2. THE HOSTILE CASES MUST NOT THROW. `parseExternalHtml` is on the paste path, so its
//      only two allowed answers are a safe grid or `null`. Script, event handlers, a
//      `javascript:` URL, an iframe, `expression()`, 200 nested tables, a table claiming a
//      million cells and markup that is not a table at all each get a case here.
//   3. FORMULAS COME BACK WHERE THE SOURCE SENT THEM, AND ARE NEVER INVENTED. 시트지 and
//      Google Sheets put the formula in an attribute; Excel puts no formula on the
//      clipboard at all, so an Excel cell imports as the literal text it displayed.
//
// Every payload is paste-shaped rather than idealised: Google's `<google-sheets-html-origin>`
// wrapper and `&quot;`-escaped JSON blobs, Excel's `<head>` stylesheet, unquoted attributes,
// single-quoted inline styles, `mso-` junk and `<!--StartFragment-->` comments, and — for
// 시트지 itself — the exact bytes `serializeSelection` produces, taken from a live engine.

import { test, eq } from './run.js';
import { readFile } from 'node:fs/promises';
import { SheetEngine } from '../shared/formula/engine.js';
import { FONT_STACKS } from '../shared/model.js';

// ---------------------------------------------------------------------------
// a DOMParser stand-in for Node
// ---------------------------------------------------------------------------
//
// SPEC 26.1 requires the import to go through `new DOMParser().parseFromString(html,
// 'text/html')`. Node has no DOMParser and this project has no dependencies, so the tests
// install the small tree builder below as `globalThis.DOMParser` — it is a STAND-IN, and
// saying exactly what it does and does not model is the only way these cases mean anything:
//
//   modelled: tags, attributes (quoted, single-quoted and unquoted), character references,
//             comments and doctypes, void elements, the raw-text elements (script, style,
//             textarea, title, iframe, ...) whose contents are text and not markup, and the
//             error recovery that matters for tables — an unclosed <td>/<tr> is closed by
//             the next one, popping through open inline elements the way a real parser
//             clears the stack back to a table context, and a nested <table> is left alone.
//   NOT modelled: an implicit <tbody>, foster parenting of stray content out of a table,
//             CSS cascade or computed style of any kind, and layout. None of them change
//             what this importer reads, which is a cell's own text, its own inline `style`
//             attribute and its own colspan/rowspan.
//
// It is inert in the same sense the real thing is — it builds a tree and runs nothing — but
// it is inert because it is a parser, not because it enforces anything. The real browser's
// behaviour is covered by tools/browser.mjs; what is proved here is what the importer does
// with a DOM, not what the DOM does with the markup.

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_COMMENT = 8;
const NODE_DOCUMENT = 9;

/** Elements that never have children. */
const VOID_TAGS = new Set([
  'AREA', 'BASE', 'BASEFONT', 'BR', 'COL', 'EMBED', 'FRAME', 'HR', 'IMG', 'INPUT',
  'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
]);

/** Elements whose content is text: markup inside them can never become a cell. */
const RAW_TEXT_TAGS = new Set([
  'SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE', 'XMP', 'IFRAME', 'NOEMBED', 'NOFRAMES',
]);

/** Where an open <td>/<th>, <tr> or <tbody> is allowed to sit. */
const CELL_PARENTS = new Set(['TR', 'TBODY', 'THEAD', 'TFOOT', 'TABLE']);
const ROW_PARENTS = new Set(['TBODY', 'THEAD', 'TFOOT', 'TABLE']);
const SECTION_PARENTS = new Set(['TABLE']);

/** Opening any of these closes an open <p>. */
const CLOSES_P = new Set([
  'P', 'DIV', 'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

/** The character references these payloads actually use, plus the ones any serialiser emits. */
const NAMED_ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ensp: '\u2002', emsp: '\u2003', shy: '\u00ad', copy: '\u00a9', reg: '\u00ae',
  hellip: '\u2026', ndash: '\u2013', mdash: '\u2014', middot: '\u00b7',
}));

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const n = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return whole;
      if (n >= 0xd800 && n <= 0xdfff) return '\ufffd';
      try {
        return String.fromCodePoint(n);
      } catch (e) {
        return whole;
      }
    }
    const hit = NAMED_ENTITIES.get(body.toLowerCase());
    return hit === undefined ? whole : hit;
  });
}

class SzNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.nodeValue = null;
    this.childNodes = [];
    this.parentNode = null;
    this._index = 0;
  }

  appendChild(child) {
    child.parentNode = this;
    child._index = this.childNodes.length;
    this.childNodes.push(child);
    return child;
  }

  get firstChild() {
    return this.childNodes.length ? this.childNodes[0] : null;
  }

  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const next = p.childNodes[this._index + 1];
    return next === undefined ? null : next;
  }

  get firstElementChild() {
    for (const c of this.childNodes) if (c.nodeType === NODE_ELEMENT) return c;
    return null;
  }

  get nextElementSibling() {
    const p = this.parentNode;
    if (!p) return null;
    for (let i = this._index + 1; i < p.childNodes.length; i++) {
      if (p.childNodes[i].nodeType === NODE_ELEMENT) return p.childNodes[i];
    }
    return null;
  }

  /** Descendant text, comments excluded — iterative, so deep markup cannot blow the stack. */
  get textContent() {
    let out = '';
    const stack = [];
    for (let i = this.childNodes.length - 1; i >= 0; i--) stack.push(this.childNodes[i]);
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === NODE_TEXT) {
        out += node.nodeValue;
        continue;
      }
      if (node.nodeType !== NODE_ELEMENT) continue;
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return out;
  }

  /** Tag-name (or `*`) selectors only — the one form this importer uses. */
  querySelectorAll(selector) {
    const sel = String(selector).trim().toUpperCase();
    if (!/^(?:\*|[A-Z][A-Z0-9-]*)$/.test(sel)) {
      throw new Error('unsupported selector: ' + selector);
    }
    const out = [];
    const stack = [];
    for (let i = this.childNodes.length - 1; i >= 0; i--) stack.push(this.childNodes[i]);
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType !== NODE_ELEMENT) continue;
      if (sel === '*' || node.nodeName === sel) out.push(node);
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return out;
  }
}

class SzText extends SzNode {
  constructor(data) {
    super(NODE_TEXT, '#text');
    this.nodeValue = data;
  }

  get textContent() {
    return this.nodeValue;
  }
}

class SzComment extends SzNode {
  constructor(data) {
    super(NODE_COMMENT, '#comment');
    this.nodeValue = data;
  }

  get textContent() {
    return this.nodeValue;
  }
}

class SzElement extends SzNode {
  constructor(name, attributes) {
    super(NODE_ELEMENT, name);
    this.attributes = attributes;
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }
}

class SzDocument extends SzNode {
  constructor() {
    super(NODE_DOCUMENT, '#document');
  }
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function isNameStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isNameEnd(ch) {
  return isSpace(ch) || ch === '/' || ch === '>';
}

/** Parse a tag's attributes starting at `i`; returns { attrs, selfClosing, next }. */
function readAttributes(html, start) {
  const n = html.length;
  const attrs = new Map();
  let i = start;
  let selfClosing = false;
  while (i < n) {
    while (i < n && isSpace(html.charAt(i))) i++;
    if (i >= n) break;
    const ch = html.charAt(i);
    if (ch === '>') { i++; break; }
    if (ch === '/') {
      if (html.charAt(i + 1) === '>') { selfClosing = true; i += 2; break; }
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n) {
      const c = html.charAt(i);
      if (isSpace(c) || c === '=' || c === '>' || c === '/') break;
      i++;
    }
    const name = html.slice(nameStart, i).toLowerCase();
    let value = '';
    let k = i;
    while (k < n && isSpace(html.charAt(k))) k++;
    if (html.charAt(k) === '=') {
      k++;
      while (k < n && isSpace(html.charAt(k))) k++;
      const quote = html.charAt(k);
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, k + 1);
        value = end < 0 ? html.slice(k + 1) : html.slice(k + 1, end);
        k = end < 0 ? n : end + 1;
      } else {
        const vs = k;
        while (k < n && !isSpace(html.charAt(k)) && html.charAt(k) !== '>') k++;
        value = html.slice(vs, k);
      }
      i = k;
    }
    if (name && !attrs.has(name)) attrs.set(name, decodeEntities(value));
  }
  return { attrs, selfClosing, next: i };
}

/** Build a document from a markup string. Never throws; unterminated markup just ends. */
function parseHtmlDocument(html) {
  const doc = new SzDocument();
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const n = html.length;
  let i = 0;
  let text = '';

  const flushText = () => {
    if (text) {
      top().appendChild(new SzText(decodeEntities(text)));
      text = '';
    }
  };

  const inStack = (names) => {
    for (let k = stack.length - 1; k > 0; k--) if (names.has(stack[k].nodeName)) return true;
    return false;
  };

  const popUntilTopIn = (names) => {
    while (stack.length > 1 && !names.has(top().nodeName)) stack.pop();
  };

  // Implicit end tags. Opening a cell or a row clears the open elements back to the nearest
  // table context, which is what closes an unclosed <td> even through an open <b>.
  const autoClose = (name) => {
    if (name === 'TD' || name === 'TH') {
      if (inStack(CELL_PARENTS)) popUntilTopIn(CELL_PARENTS);
    } else if (name === 'TR') {
      if (inStack(ROW_PARENTS)) popUntilTopIn(ROW_PARENTS);
    } else if (name === 'TBODY' || name === 'THEAD' || name === 'TFOOT') {
      if (inStack(SECTION_PARENTS)) popUntilTopIn(SECTION_PARENTS);
    } else if (name === 'LI') {
      if (top().nodeName === 'LI') stack.pop();
    } else if (name === 'OPTION') {
      if (top().nodeName === 'OPTION') stack.pop();
    } else if (CLOSES_P.has(name)) {
      if (top().nodeName === 'P') stack.pop();
    }
  };

  const closeTag = (name) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].nodeName === name) {
        stack.length = k;
        return;
      }
    }
    // A stray end tag names nothing that is open; a real parser ignores it, so do we.
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    const next = html.charAt(lt + 1);

    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        flushText();
        top().appendChild(new SzComment(end < 0 ? html.slice(lt + 4) : html.slice(lt + 4, end)));
        i = end < 0 ? n : end + 3;
        continue;
      }
      const end = html.indexOf('>', lt); // doctype and friends contribute no node
      i = end < 0 ? n : end + 1;
      continue;
    }

    if (next === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    if (next === '/') {
      if (!isNameStart(html.charAt(lt + 2))) {
        const end = html.indexOf('>', lt);
        i = end < 0 ? n : end + 1;
        continue;
      }
      let j = lt + 2;
      while (j < n && !isNameEnd(html.charAt(j))) j++;
      const name = html.slice(lt + 2, j).toUpperCase();
      const end = html.indexOf('>', j);
      flushText();
      closeTag(name);
      i = end < 0 ? n : end + 1;
      continue;
    }

    if (!isNameStart(next)) {
      // `a < b`: a '<' that starts no tag is literal text, exactly as in HTML5.
      text += '<';
      i = lt + 1;
      continue;
    }

    let j = lt + 1;
    while (j < n && !isNameEnd(html.charAt(j))) j++;
    const name = html.slice(lt + 1, j).toUpperCase();
    const read = readAttributes(html, j);
    i = read.next;

    flushText();
    const el = new SzElement(name, read.attrs);
    autoClose(name);
    top().appendChild(el);

    if (read.selfClosing || VOID_TAGS.has(name)) continue;

    if (RAW_TEXT_TAGS.has(name)) {
      const re = new RegExp('</' + name + '\\s*>', 'gi');
      re.lastIndex = i;
      const m = re.exec(html);
      const rawEnd = m ? m.index : n;
      const raw = html.slice(i, rawEnd);
      // script/style keep their bytes; textarea/title decode references, as HTML says.
      if (raw) {
        el.appendChild(new SzText(
          name === 'TEXTAREA' || name === 'TITLE' ? decodeEntities(raw) : raw,
        ));
      }
      i = m ? m.index + m[0].length : n;
      continue;
    }

    stack.push(el);
  }

  flushText();
  return doc;
}

class StandInDOMParser {
  parseFromString(html, type) {
    if (type !== 'text/html') throw new Error('stand-in DOMParser handles text/html only');
    return parseHtmlDocument(String(html));
  }
}

// Installed for the whole process: only clipboard.js reads it, and it defers to a real
// DOMParser if this ever runs somewhere that has one.
if (!globalThis.DOMParser) globalThis.DOMParser = StandInDOMParser;

// ---------------------------------------------------------------------------
// loading public/js/clipboard.js in Node
// ---------------------------------------------------------------------------
//
// Same obstacle and same solution as test/data.test.js: the client tree addresses the
// shared modules the way the BROWSER sees them (`/shared/model.js`, served by
// express.static), and Node resolves that against the filesystem root. Try the plain
// import first — it is what runs the day those specifiers become relative — and otherwise
// load the module through a rewriter that maps each `/shared/...` specifier onto the real
// file and inlines any sibling client module the same way. The source is never edited on
// disk; the rewritten copy exists only as a data: URL, so the parser under test is exactly
// the one the browser loads.

const REPO_ROOT = new URL('../', import.meta.url);
const CLIPBOARD_URL = new URL('public/js/clipboard.js', REPO_ROOT).href;

/** `from '<spec>'`, `import '<spec>'` and `import('<spec>')`, capturing the specifier. */
const SPECIFIER_RE = /((?:\bfrom|\bimport)\s*\(?\s*)(['"])([^'"\n]+)\2/g;

/** file URL -> data: URL of the same module with its specifiers made absolute. */
const shimCache = new Map();

async function shimUrl(fileUrl) {
  const cached = shimCache.get(fileUrl);
  if (cached) return cached;

  const src = await readFile(new URL(fileUrl), 'utf8');
  const rewritten = new Map();
  for (const m of src.matchAll(SPECIFIER_RE)) {
    const spec = m[3];
    if (rewritten.has(spec)) continue;
    if (spec.startsWith('/')) {
      // Browser-absolute: the web root is the repository root.
      rewritten.set(spec, new URL('.' + spec, REPO_ROOT).href);
    } else if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = new URL(spec, fileUrl).href;
      // A sibling client module has the same problem; a shared module resolves as it is.
      rewritten.set(spec, target.includes('/public/') ? await shimUrl(target) : target);
    }
  }

  const out = src.replace(SPECIFIER_RE, (whole, head, quote, spec) =>
    (rewritten.has(spec) ? head + quote + rewritten.get(spec) + quote : whole)
  );
  const url = 'data:text/javascript;base64,' + Buffer.from(out, 'utf8').toString('base64');
  shimCache.set(fileUrl, url);
  return url;
}

let clipboardModule = null;

/** The clipboard module, loaded once and shared by every case below. */
function loadClipboard() {
  if (!clipboardModule) {
    clipboardModule = import(CLIPBOARD_URL).catch(async (e) => {
      const missing =
        e && (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (?:module|package)/.test(String(e.message)));
      if (!missing) throw e;
      return import(await shimUrl(CLIPBOARD_URL));
    });
  }
  return clipboardModule;
}

/** `parseExternalHtml(html)`, with the module resolved. */
async function importHtml(html) {
  const mod = await loadClipboard();
  return mod.parseExternalHtml(html);
}

// ---------------------------------------------------------------------------
// invariants — re-validated for every grid this file produces
// ---------------------------------------------------------------------------

/** SPEC 26.1: the import is capped at MAX_EDIT_CELLS cells. */
const CELL_CAP = 20000;
const GRID_MAX_ROWS = 5000;
const GRID_MAX_COLS = 702;

const STYLE_KEYS = new Set(['b', 'i', 'u', 's', 'align', 'bg', 'fg', 'fmt', 'decimals',
  'ff', 'fs', 'va', 'wrap', 'rot', 'bd']);
const HEX6 = /^#[0-9a-f]{6}$/;
const ALIGNS = new Set(['left', 'center', 'right']);
const VALIGNS = new Set(['top', 'middle', 'bottom']);
const WRAPS = new Set(['overflow', 'wrap', 'clip']);
const FMTS = new Set(['general', 'number', 'currency', 'percent', 'date', 'time', 'text']);
const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted']);

/** True when a style value is a raw string that could only have come from the markup. */
function looksLikeRawCss(v) {
  return typeof v === 'string' && /[<>(){};:#]/.test(v) && !HEX6.test(v);
}

function checkStyle(style, where) {
  if (style === null) return;
  eq(typeof style === 'object' && !Array.isArray(style), true, where + ': style must be an object or null');
  eq(Object.keys(style).length > 0, true, where + ': an empty style must be null, not {}');
  for (const key of Object.keys(style)) {
    eq(STYLE_KEYS.has(key), true, where + ': unknown style key ' + JSON.stringify(key));
    const v = style[key];
    eq(looksLikeRawCss(v), false, where + ': style.' + key + ' looks like raw CSS: ' + JSON.stringify(v));
    if (key === 'b' || key === 'i' || key === 'u' || key === 's') eq(v, 1, where + ': style.' + key);
    if (key === 'bg' || key === 'fg') eq(HEX6.test(v), true, where + ': style.' + key + ' must be #rrggbb, got ' + JSON.stringify(v));
    if (key === 'align') eq(ALIGNS.has(v), true, where + ': style.align');
    if (key === 'va') eq(VALIGNS.has(v), true, where + ': style.va');
    if (key === 'wrap') eq(WRAPS.has(v), true, where + ': style.wrap');
    if (key === 'fmt') eq(FMTS.has(v), true, where + ': style.fmt');
    if (key === 'ff') eq(Object.prototype.hasOwnProperty.call(FONT_STACKS, v), true, where + ': style.ff must be a FONT_STACKS id, got ' + JSON.stringify(v));
    if (key === 'fs') eq(Number.isInteger(v) && v >= 6 && v <= 96, true, where + ': style.fs must be an integer 6..96, got ' + JSON.stringify(v));
    if (key === 'bd') {
      eq(v && typeof v === 'object' && !Array.isArray(v), true, where + ': style.bd');
      for (const side of Object.keys(v)) {
        eq(['t', 'r', 'b', 'l'].indexOf(side) >= 0, true, where + ': style.bd side ' + side);
        const edge = v[side];
        eq(Object.keys(edge).sort().join(','), 'c,s,w', where + ': style.bd.' + side + ' shape');
        eq([1, 2, 3].indexOf(edge.w) >= 0, true, where + ': style.bd.' + side + '.w');
        eq(BORDER_STYLES.has(edge.s), true, where + ': style.bd.' + side + '.s');
        eq(HEX6.test(edge.c), true, where + ': style.bd.' + side + '.c must be #rrggbb');
      }
    }
  }
}

/**
 * Every structural guarantee SPEC 26.2 makes, checked on one result. Called by every case
 * in this file, so a regression anywhere in the importer shows up everywhere at once.
 */
function checkGrid(grid, label) {
  const where = label || 'grid';
  eq(grid !== null && typeof grid === 'object', true, where + ': must be an object');
  eq(Object.keys(grid).sort().join(','), 'cells,cols,origin,rows', where + ': result shape');
  eq(Number.isInteger(grid.rows) && grid.rows > 0, true, where + ': rows must be a positive integer');
  eq(Number.isInteger(grid.cols) && grid.cols > 0, true, where + ': cols must be a positive integer');
  eq(grid.rows <= GRID_MAX_ROWS, true, where + ': rows must fit the sheet');
  eq(grid.cols <= GRID_MAX_COLS, true, where + ': cols must fit the sheet');
  eq(grid.rows * grid.cols <= CELL_CAP, true, where + ': the import must stay inside the cell cap');
  eq(Array.isArray(grid.cells), true, where + ': cells must be an array');
  eq(grid.cells.length, grid.rows, where + ': cells.length must equal rows');

  const covered = new Map(); // "r,c" -> the anchor that claims it
  for (let r = 0; r < grid.rows; r++) {
    const line = grid.cells[r];
    eq(Array.isArray(line), true, where + ': row ' + r + ' must be an array');
    eq(line.length, grid.cols, where + ': row ' + r + ' must be ' + grid.cols + ' wide');
    for (let c = 0; c < grid.cols; c++) {
      const cell = line[c];
      const at = where + ' [' + r + '][' + c + ']';
      if (cell === null) continue;
      eq(typeof cell === 'object' && !Array.isArray(cell), true, at + ': a cell is an object or null');
      eq(Object.keys(cell).sort().join(','), 'input,merge,style', at + ': cell shape');
      eq(typeof cell.input, 'string', at + ': input must be a string');
      eq(cell.input.length <= 10000, true, at + ': input must respect the per-cell cap');
      checkStyle(cell.style, at);
      if (cell.merge === null) continue;
      eq(Object.keys(cell.merge).sort().join(','), 'cols,rows', at + ': merge shape');
      eq(Number.isInteger(cell.merge.rows) && cell.merge.rows >= 1, true, at + ': merge.rows');
      eq(Number.isInteger(cell.merge.cols) && cell.merge.cols >= 1, true, at + ': merge.cols');
      eq(cell.merge.rows > 1 || cell.merge.cols > 1, true, at + ': a 1x1 merge must be null');
      eq(r + cell.merge.rows <= grid.rows, true, at + ': merge must not claim rows past the grid');
      eq(c + cell.merge.cols <= grid.cols, true, at + ': merge must not claim cols past the grid');
      for (let dr = 0; dr < cell.merge.rows; dr++) {
        for (let dc = 0; dc < cell.merge.cols; dc++) {
          if (dr === 0 && dc === 0) continue;
          const key = (r + dr) + ',' + (c + dc);
          eq(covered.has(key), false, at + ': overlaps a merge anchored at ' + covered.get(key));
          covered.set(key, r + ',' + c);
          eq(grid.cells[r + dr][c + dc], null, at + ': covered position ' + key + ' must be null');
        }
      }
    }
  }
  return grid;
}

/** The `input` of every cell, with a covered/absent position as null. */
function inputsOf(grid) {
  return grid.cells.map((line) => line.map((cell) => (cell === null ? null : cell.input)));
}

/** The `style` of every cell, with a covered/absent position as null. */
function stylesOf(grid) {
  return grid.cells.map((line) => line.map((cell) => (cell === null ? null : cell.style)));
}

/** Nothing from the markup may reach a cell as markup or as script. */
const MARKUP_TRACES = ['<', 'javascript:', 'alert(', 'onerror', 'onclick', 'expression(', 'url('];

function assertNoMarkup(grid, label) {
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const cell = grid.cells[r][c];
      if (!cell) continue;
      for (const trace of MARKUP_TRACES) {
        eq(
          cell.input.toLowerCase().indexOf(trace) < 0,
          true,
          (label || 'grid') + ' [' + r + '][' + c + ']: input carries ' + JSON.stringify(trace) + ': ' + JSON.stringify(cell.input),
        );
      }
    }
  }
}

/** Call `fn` and report `{ threw:false, value }`, so "returned X without throwing" is one eq. */
async function noThrow(fn) {
  try {
    return { threw: false, value: await fn() };
  } catch (e) {
    return { threw: true, value: String((e && e.stack) || e) };
  }
}

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

// Google Sheets: a <meta>, its own wrapper element (never closed), a <style> block, a
// <colgroup>, `&quot;`-escaped JSON in data-sheets-value, and the formatting inline on
// every <td>. The table's own font-family/font-size are deliberately present and must NOT
// reach any cell — this importer reads a cell's own inline style and nothing else.
const GOOGLE_HTML = '<meta charset="utf-8"><google-sheets-html-origin>'
  + '<style type="text/css"><!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}--></style>'
  + '<table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"'
  + ' style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none"'
  + ' data-sheets-root="1">'
  + '<colgroup><col width="100"/><col width="100"/><col width="100"/></colgroup>'
  + '<tbody>'
  + '<tr style="height:21px;">'
  + '<td colspan="2" style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:middle;text-align:center;'
  + 'font-weight:bold;background-color:#fff2cc;color:#674ea7;"'
  + ' data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;1분기 매출&quot;}">1분기 매출</td>'
  + '<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;font-style:italic;"'
  + ' data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;비고&quot;}">비고</td>'
  + '</tr>'
  + '<tr style="height:21px;">'
  + '<td data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:10}">10</td>'
  + '<td data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:20}">20</td>'
  + '<td data-sheets-formula="=SUM(A2:B2)" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:30}">30</td>'
  + '</tr>'
  + '<tr style="height:21px;">'
  + '<td style="text-decoration:underline;">밑줄</td>'
  + '<td style="text-decoration:line-through;color:rgb(255, 0, 0);">취소선</td>'
  + '<td></td>'
  + '</tr>'
  + '</tbody></table>';

// Excel: an <html> wrapper with a <head> stylesheet whose classes are referenced by every
// cell, unquoted attributes, single-quoted inline styles, fragment comments, a bare <col>
// and `windowtext` borders. No formula anywhere — Excel does not put one on the clipboard.
const EXCEL_HTML = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">',
  '<head>',
  '<meta http-equiv=Content-Type content="text/html; charset=utf-8">',
  '<meta name=ProgId content=Excel.Sheet>',
  '<meta name=Generator content="Microsoft Excel 15">',
  '<link rel=File-List href="file:///C:/Users/B/AppData/Local/Temp/msohtmlclip1/01/clip_filelist.xml">',
  '<style>',
  '<!--table',
  '\t{mso-displayed-decimal-separator:"\\.";}',
  '.xl65',
  '\t{color:#FF0000;font-weight:700;background:#00FF00;}',
  '-->',
  '</style>',
  '</head>',
  '<body link="#0563C1" vlink="#954F72">',
  "<table border=0 cellpadding=0 cellspacing=0 width=192 style='border-collapse:collapse;table-layout:fixed;width:144pt'>",
  '<!--StartFragment-->',
  "<col width=64 span=3 style='width:48pt'>",
  "<tr height=20 style='height:15.0pt'>",
  "  <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt;font-weight:700;background:#FFFF00;border-top:1.0pt solid windowtext'>항목</td>",
  "  <td class=xl66 style='font-style:italic;text-align:right;color:#FF0000'>합계</td>",
  '  <td class=xl67 style=\'font-family:"Malgun Gothic";font-size:14.0pt\'>비고</td>',
  ' </tr>',
  "<tr height=20 style='height:15.0pt'>",
  "  <td class=xl68 style='border-top:none'>사과</td>",
  "  <td class=xl69 align=right x:num='1234.5'>1,234.5</td>",
  "  <td class=xl70 style='mso-ignore:colspan'></td>",
  ' </tr>',
  '<!--EndFragment-->',
  '</table>',
  '</body>',
  '</html>',
].join('\n');

// 시트지's own payload, byte for byte what serializeSelection writes.
const SHEETZI_HTML = '<meta charset="utf-8"><table data-sheetzi="1" style="border-collapse:collapse"><tbody>'
  + '<tr>'
  + '<td style="font-weight:700" data-sz-input="=TODAY()">2026-09-03</td>'
  + '<td data-sz-input="첫 줄&#10;둘째 줄">첫 줄<br>둘째 줄</td>'
  + '<td>서식만</td>'
  + '</tr>'
  + '</tbody></table>';

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

test('Google Sheets: values, formatting, a colspan merge and a formula all arrive', async () => {
  const grid = checkGrid(await importHtml(GOOGLE_HTML), 'google');
  eq(grid.rows, 3, 'three rows');
  eq(grid.cols, 3, 'the colspan=2 header makes the table three columns wide');

  eq(grid.cells, [
    [
      {
        input: '1분기 매출',
        style: { b: 1, align: 'center', bg: '#fff2cc', fg: '#674ea7', va: 'middle' },
        merge: { rows: 1, cols: 2 },
      },
      null,
      { input: '비고', style: { i: 1, align: 'right', va: 'bottom' }, merge: null },
    ],
    [
      { input: '10', style: null, merge: null },
      { input: '20', style: null, merge: null },
      // The formula, not the 30 it displayed.
      { input: '=SUM(A2:B2)', style: null, merge: null },
    ],
    [
      { input: '밑줄', style: { u: 1 }, merge: null },
      { input: '취소선', style: { s: 1, fg: '#ff0000' }, merge: null },
      { input: '', style: null, merge: null },
    ],
  ], 'the whole imported grid');
});

test('Google Sheets: the table element\'s own font never reaches a cell', async () => {
  // The <table> carries font-family:Arial and font-size:10pt. Inheriting them would give
  // every cell an ff/fs it never had, so only a cell's OWN inline style may be read.
  const grid = checkGrid(await importHtml(GOOGLE_HTML), 'google-font');
  for (const line of grid.cells) {
    for (const cell of line) {
      if (!cell || !cell.style) continue;
      eq(Object.prototype.hasOwnProperty.call(cell.style, 'ff'), false, 'no inherited font family');
      eq(Object.prototype.hasOwnProperty.call(cell.style, 'fs'), false, 'no inherited font size');
    }
  }
});

test('Google Sheets: a data-sheets-value blob never becomes a formula', async () => {
  // The blob is the DISPLAYED value's metadata. Nothing in it may be promoted to an input,
  // and an attribute that is not a formula (no leading '=') is not one either.
  const html = '<meta charset="utf-8"><table><tbody><tr>'
    + '<td data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;=1+1&quot;}">보통 글자</td>'
    + '<td data-sheets-formula="alert(1)">100</td>'
    + '<td data-sheets-formula="   ">200</td>'
    + '</tr></tbody></table>';
  const grid = checkGrid(await importHtml(html), 'sheets-value');
  eq(inputsOf(grid), [['보통 글자', '100', '200']], 'the displayed text, never a manufactured formula');
});

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

test('Excel: values and inline formatting arrive, and no formula is invented', async () => {
  const grid = checkGrid(await importHtml(EXCEL_HTML), 'excel');
  eq(grid.rows, 2, 'two rows');
  eq(grid.cols, 3, 'three columns');

  eq(grid.cells, [
    [
      {
        input: '항목',
        // font-weight:700 -> b, background:#FFFF00 -> bg, `1.0pt solid windowtext` -> a
        // 1px black top border. height/width are layout and are not style facts.
        style: { b: 1, bg: '#ffff00', bd: { t: { w: 1, s: 'solid', c: '#000000' } } },
        merge: null,
      },
      { input: '합계', style: { i: 1, align: 'right', fg: '#ff0000' }, merge: null },
      // 14pt -> 18.67px -> 19; "Malgun Gothic" -> the `gothic` id from FONT_STACKS.
      { input: '비고', style: { ff: 'gothic', fs: 19 }, merge: null },
    ],
    [
      // border-top:none is the absence of a border, not a border.
      { input: '사과', style: null, merge: null },
      // Excel shipped the RESULT. It stays text: a formula may never be invented from one.
      { input: '1,234.5', style: null, merge: null },
      { input: '', style: null, merge: null },
    ],
  ], 'the whole imported grid');

  for (const line of grid.cells) {
    for (const cell of line) {
      eq(cell.input.charAt(0) === '=', false, 'no cell may import as a formula');
    }
  }
});

test('Excel: the <style> block and its classes are never consulted', async () => {
  // Every cell carries a class, and `.xl65` sets color:#FF0000 and background:#00FF00.
  // Resolving a stylesheet would mean running a cascade over untrusted CSS; the importer
  // reads inline declarations only, so the first cell keeps its inline yellow and gets no
  // foreground at all.
  const grid = checkGrid(await importHtml(EXCEL_HTML), 'excel-css');
  eq(grid.cells[0][0].style.bg, '#ffff00', 'the inline background wins');
  eq(Object.prototype.hasOwnProperty.call(grid.cells[0][0].style, 'fg'), false, 'the class colour is not applied');
  eq(grid.cells[1][0].style, null, 'a cell whose only formatting is a class imports unformatted');
  assertNoMarkup(grid, 'excel-css');
});

test('Excel: presentational attributes are not style facts', async () => {
  // `align=right`, `bgcolor`, `width` and friends are attributes, not inline CSS. Reading
  // them would be a second, unvalidated path into the style object.
  const html = '<table><tr>'
    + '<td align=right bgcolor="#ff0000" width=64 nowrap>가</td>'
    + '<td style="text-align:right">나</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'presentational');
  eq(stylesOf(grid), [[null, { align: 'right' }]], 'only the inline style is read');
});

// ---------------------------------------------------------------------------
// 시트지's own payload
// ---------------------------------------------------------------------------

test('시트지: data-sz-input is the input, whatever the cell displayed', async () => {
  const grid = checkGrid(await importHtml(SHEETZI_HTML), 'sheetzi');
  eq(grid.rows, 1, 'one row');
  eq(grid.cols, 3, 'three columns');
  eq(inputsOf(grid), [[
    '=TODAY()',            // the formula, not the date it rendered as
    '첫 줄\n둘째 줄',       // a newline inside the attribute survives as a newline
    '서식만',              // no attribute: the text is the input
  ]], 'inputs');
  eq(stylesOf(grid), [[{ b: 1 }, null, null]], 'styles');
});

test('시트지: a real serializeSelection payload round-trips through the importer', async () => {
  const mod = await loadClipboard();
  const engine = new SheetEngine({ rows: 20, cols: 8 });
  engine.setInput('A1', '이름');
  engine.setInput('B1', '점수');
  engine.setInput('A2', '가');
  engine.setInput('B2', '10');
  engine.setInput('A3', '합계');
  engine.setInput('B3', '=SUM(B2:B2)');
  engine.setStyle('A1', { b: 1, align: 'center', bg: '#fff2cc', fg: '#674ea7' });
  engine.setStyle('B2', { fmt: 'currency', decimals: 2 });
  engine.setStyle('B3', { i: 1, u: 1, s: 1 });

  const payload = mod.serializeSelection(engine, 'A1:B3');
  eq(typeof payload.html === 'string' && payload.html.indexOf('data-sheetzi="1"') >= 0, true, 'a 시트지 payload');

  const grid = checkGrid(await importHtml(payload.html), 'roundtrip');
  eq(grid.rows, 3, 'three rows');
  eq(grid.cols, 2, 'two columns');

  // Every input comes back exactly as the engine holds it — including the formula, and
  // including B2, whose DISPLAY is a currency string but whose input is '10'.
  const keys = [['A1', 'B1'], ['A2', 'B2'], ['A3', 'B3']];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) {
      eq(grid.cells[r][c].input, engine.getInput(keys[r][c]), 'input at ' + keys[r][c]);
    }
  }

  eq(stylesOf(grid), [
    [{ b: 1, align: 'center', bg: '#fff2cc', fg: '#674ea7' }, null],
    // fmt/decimals are NOT in the HTML flavour — styleToCss writes no number format, so a
    // currency cell arrives unformatted. Values and formulas survive; number formats do not.
    [null, null],
    [null, { i: 1, u: 1, s: 1 }],
  ], 'styles that survive an HTML round trip');
});

// ---------------------------------------------------------------------------
// colspan / rowspan
// ---------------------------------------------------------------------------

test('colspan and rowspan build a rectangular grid with covered positions null', async () => {
  //  왼쪽 | a | b        왼쪽 spans three rows, 중간 spans two columns.
  //  ~~~~ |  중간
  //  ~~~~ | c | d
  const html = '<meta charset="utf-8"><table><tbody>'
    + '<tr><td rowspan="3">왼쪽</td><td>a</td><td>b</td></tr>'
    + '<tr><td colspan="2">중간</td></tr>'
    + '<tr><td>c</td><td>d</td></tr>'
    + '</tbody></table>';
  const grid = checkGrid(await importHtml(html), 'spans');
  eq(grid.rows, 3, 'three rows');
  eq(grid.cols, 3, 'three columns');
  eq(inputsOf(grid), [
    ['왼쪽', 'a', 'b'],
    [null, '중간', null],
    [null, 'c', 'd'],
  ], 'covered positions are null');
  eq(grid.cells[0][0].merge, { rows: 3, cols: 1 }, 'the anchor carries the three-row span');
  eq(grid.cells[1][1].merge, { rows: 1, cols: 2 }, 'the anchor carries the two-column span');
  eq(grid.cells[0][1].merge, null, 'an unmerged cell has no merge');
  eq(grid.cells[2][2].merge, null, 'an unmerged cell has no merge');
});

test('a block merged in both directions covers its whole rectangle', async () => {
  const html = '<table><tr>'
    + '<td rowspan="2" colspan="2">모서리</td><td>c1</td></tr>'
    + '<tr><td>c2</td></tr>'
    + '<tr><td>a3</td><td>b3</td><td>c3</td></tr>'
    + '</table>';
  const grid = checkGrid(await importHtml(html), 'block-merge');
  eq(grid.rows, 3, 'three rows');
  eq(grid.cols, 3, 'three columns');
  eq(inputsOf(grid), [
    ['모서리', null, 'c1'],
    [null, null, 'c2'],
    ['a3', 'b3', 'c3'],
  ], 'a 2x2 anchor covers three positions');
  eq(grid.cells[0][0].merge, { rows: 2, cols: 2 }, 'the anchor carries the full size');
});

test('a nonsense colspan or rowspan is treated as one cell', async () => {
  const html = '<table><tr>'
    + '<td colspan="0">가</td>'
    + '<td colspan="-2">나</td>'
    + '<td colspan="abc">다</td>'
    + '<td rowspan="">라</td>'
    + '<td colspan="1.9">마</td>'
    + '<td colspan="NaN">바</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'bad-spans');
  eq(grid.rows, 1, 'one row');
  eq(grid.cols, 6, 'six single cells');
  eq(inputsOf(grid), [['가', '나', '다', '라', '마', '바']], 'every cell placed once');
  for (const cell of grid.cells[0]) eq(cell.merge, null, 'no merge from a bad span');
});

// ---------------------------------------------------------------------------
// whitespace
// ---------------------------------------------------------------------------

test('a serialiser\'s newlines collapse but a <br> stays a line break', async () => {
  const html = '<table>\n  <tr>\n'
    + '    <td>\n      첫째 조각\n      둘째 조각\n    </td>\n'
    + '    <td>줄1<br>줄2<br/>줄3</td>\n'
    + '    <td style="white-space:pre">A\nB</td>\n'
    + '    <td>a&nbsp;&nbsp;b</td>\n'
    + '    <td><div>x</div><div>y</div></td>\n'
    + '  </tr>\n</table>';
  const grid = checkGrid(await importHtml(html), 'whitespace');
  eq(grid.rows, 1, 'the indentation between tags makes no extra row');
  eq(grid.cols, 5, 'five cells');
  eq(inputsOf(grid), [[
    '첫째 조각 둘째 조각',  // the serialiser's newlines and indentation collapse
    '줄1\n줄2\n줄3',        // a <br> is a break the SOURCE meant
    'A\nB',                 // white-space:pre makes the source's own newline content
    'a b',                  // &nbsp; runs collapse like any other whitespace
    'x\ny',                 // a block boundary breaks the line once, not twice
  ]], 'cell text');
});

// ---------------------------------------------------------------------------
// colours
// ---------------------------------------------------------------------------

test('colours normalise to #rrggbb, and anything unrecognised is dropped', async () => {
  const html = '<table><tr>'
    + '<td style="color:#abc">1</td>'
    + '<td style="color:#AABBCC">2</td>'
    + '<td style="color:rgb(1,2,3)">3</td>'
    + '<td style="color:rgba(1, 2, 3, 0.5)">4</td>'
    + '<td style="color:rgb(100%, 0%, 0%)">5</td>'
    + '<td style="color:red;background-color:yellow">6</td>'
    + '<td style="color:rebeccapurple">7</td>'
    + '<td style="color:var(--sz-fg)">8</td>'
    + '<td style="color:hsl(0, 100%, 50%)">9</td>'
    + '<td style="color:currentColor;background-color:transparent">10</td>'
    + '<td style="background-color:rgba(0,0,0,0)">11</td>'
    + '<td style="color:inherit;background-color:initial">12</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'colors');
  eq(stylesOf(grid), [[
    { fg: '#aabbcc' },          // #abc expands
    { fg: '#aabbcc' },          // case is normalised
    { fg: '#010203' },          // rgb()
    { fg: '#010203' },          // rgba(), alpha dropped
    { fg: '#ff0000' },          // percentage channels
    { fg: '#ff0000', bg: '#ffff00' }, // the closed named set SPEC 26.1 allows
    null,                       // a name outside that set is DROPPED, never passed through
    null,                       // a CSS variable cannot be resolved, so it is dropped
    null,                       // hsl() is not in the accepted forms
    null,                       // currentColor / transparent resolve to nothing
    null,                       // a fully transparent fill is the absence of a fill
    null,                       // inherit / initial are not colours
  ]], 'one style per cell');
});

test('an 8-digit hex keeps its rgb half and a malformed hex is dropped', async () => {
  const html = '<table><tr>'
    + '<td style="background-color:#11223344">1</td>'
    + '<td style="background-color:#12345">2</td>'
    + '<td style="background-color:#gggggg">3</td>'
    + '<td style="background-color:#">4</td>'
    + '<td style="background-color:rgb(300, -20, 999)">5</td>'
    + '<td style="background-color:rgb(1,2)">6</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'hex');
  eq(stylesOf(grid), [[
    { bg: '#112233' },
    null,
    null,
    null,
    { bg: '#ff00ff' },  // channels clamp to 0..255
    null,               // too few channels
  ]], 'hex and rgb edges');
});

// ---------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------

test('font-family maps onto the closed FONT_STACKS set; an unknown family is dropped', async () => {
  const html = '<table><tr>'
    + '<td style="font-family:Arial, Helvetica, sans-serif">1</td>'
    + '<td style="font-family:&quot;Malgun Gothic&quot;">2</td>'
    + '<td style="font-family:Consolas,monospace">3</td>'
    + "<td style=\"font-family:'Times New Roman',Times,serif\">4</td>"
    + '<td style="font-family:Batang">5</td>'
    + '<td style="font-family:Pretendard">6</td>'
    + '<td style="font-family:Wingdings">7</td>'
    + '<td style="font-family:expression(alert(1))">8</td>'
    + '<td style="font-family:">9</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'fonts');
  eq(stylesOf(grid), [[
    { ff: 'arial' },
    { ff: 'gothic' },
    { ff: 'mono' },
    { ff: 'times' },
    { ff: 'myeongjo' },
    { ff: 'default' },
    null,   // an unknown family is dropped rather than passed through as CSS
    null,   // and so is a CSS expression
    null,
  ]], 'font ids');
});

test('font-size is rounded and clamped to 6..96; nonsense is dropped', async () => {
  const html = '<table><tr>'
    + '<td style="font-size:11pt">1</td>'
    + '<td style="font-size:13px">2</td>'
    + '<td style="font-size:12">3</td>'
    + '<td style="font-size:1px">4</td>'
    + '<td style="font-size:400px">5</td>'
    + '<td style="font-size:96pt">6</td>'
    + '<td style="font-size:0">7</td>'
    + '<td style="font-size:-12px">8</td>'
    + '<td style="font-size:2em">9</td>'
    + '<td style="font-size:x-large">10</td>'
    + '<td style="font-size:huge">11</td>'
    + '<td style="font-size:12px!important">12</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'sizes');
  eq(stylesOf(grid), [[
    { fs: 15 },   // 11pt = 14.67px
    { fs: 13 },
    { fs: 12 },   // a bare number is px, which is what a serialiser means
    { fs: 6 },    // clamped up to the minimum
    { fs: 96 },   // clamped down to the maximum
    { fs: 96 },   // 96pt = 128px, clamped
    null,         // zero is not a size
    null,         // nor is a negative one
    null,         // a relative unit cannot be resolved without a cascade
    null,         // nor can a keyword
    null,         // nor can a word
    { fs: 12 },   // !important is dropped, the declaration is not
  ]], 'font sizes');
});

// ---------------------------------------------------------------------------
// hostile input
// ---------------------------------------------------------------------------

test('script, event handlers, a javascript: link and an iframe import as text only', async () => {
  const html = '<table><tr>'
    + '<td>안전<script>alert("</td><td>탈취");</script>끝</td>'
    + '<td onerror="alert(2)" onclick="steal()" style="color:#ff0000"><img src=x onerror="alert(3)">그림</td>'
    + '<td><a href="javascript:alert(4)" onclick="x()">링크</a></td>'
    + '<td><iframe src="https://evil.example/p"><td>안쪽</iframe>바깥</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'hostile-text');
  eq(grid.rows, 1, 'the markup smuggled inside <script> and <iframe> creates no cells');
  eq(grid.cols, 4, 'four cells');
  eq(inputsOf(grid), [['안전끝', '그림', '링크', '바깥']], 'text only');
  eq(stylesOf(grid), [[null, { fg: '#ff0000' }, null, null]], 'only the inline colour is a style fact');
  assertNoMarkup(grid, 'hostile-text');
});

test('a style with expression(), url() or a data: URI yields nothing', async () => {
  const html = '<table><tr>'
    + '<td style="background-color:expression(alert(1));color:url(javascript:alert(2));'
    + 'font-family:expression(x);background-image:url(&quot;x.png&quot;)">셀</td>'
    + '<td style="background:url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)">둘</td>'
    + '<td style="background:linear-gradient(red, blue)">셋</td>'
    + '<td style="behavior:url(#default#time2);-moz-binding:url(evil.xml#x)">넷</td>'
    + '<td style="font-weight:bold;background-color:expression(alert(3))">다섯</td>'
    + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'hostile-css');
  eq(inputsOf(grid), [['셀', '둘', '셋', '넷', '다섯']], 'the text still arrives');
  eq(stylesOf(grid), [[
    null, null, null, null,
    // A poisoned declaration is dropped on its own; the sound one beside it survives.
    { b: 1 },
  ]], 'nothing executable becomes a style');
  assertNoMarkup(grid, 'hostile-css');
});

test('a 200-level deep nest of tables terminates with a safe result', async () => {
  const depth = 200;
  const html = '<table><tr><td>'.repeat(depth) + '깊이' + '</td></tr></table>'.repeat(depth);
  const run = await noThrow(() => importHtml(html));
  eq(run.threw, false, 'deep nesting must not throw: ' + run.value);
  const grid = checkGrid(run.value, 'deep');
  eq(grid.rows, 1, 'the outermost table owns one row');
  eq(grid.cols, 1, 'and one cell of its own');
  eq(grid.cells[0][0].input, '깊이', 'the innermost text is flattened into that cell');
  assertNoMarkup(grid, 'deep');
});

test('a table claiming a million cells is refused before anything is allocated', async () => {
  const html = '<table><tr><td colspan="1000" rowspan="1000">폭탄</td></tr></table>';
  const run = await noThrow(() => importHtml(html));
  eq(run.threw, false, 'a span bomb must not throw: ' + run.value);
  eq(run.value, null, 'a single cell claiming a million positions imports nothing');
});

test('the cell cap holds: a 25000-cell table is truncated to 20000', async () => {
  const rows = 250;
  const cols = 100;
  const row = '<tr>' + '<td>x</td>'.repeat(cols) + '</tr>';
  const run = await noThrow(() => importHtml('<table><tbody>' + row.repeat(rows) + '</tbody></table>'));
  eq(run.threw, false, 'a large table must not throw: ' + run.value);
  const grid = checkGrid(run.value, 'cap');
  eq(grid.cols, cols, 'the width is kept');
  eq(grid.rows, CELL_CAP / cols, 'the row count is cut to what the cap allows');
  eq(grid.rows * grid.cols, CELL_CAP, 'exactly the cap, not one cell more');
  eq(grid.cells[0][0].input, 'x', 'the first cell survives');
  eq(grid.cells[grid.rows - 1][cols - 1].input, 'x', 'so does the last one inside the cap');
});

test('a wide row is cut at the last column the sheet has', async () => {
  const html = '<table><tr>' + '<td>x</td>'.repeat(800) + '</tr></table>';
  const grid = checkGrid(await importHtml(html), 'wide');
  eq(grid.rows, 1, 'one row');
  eq(grid.cols, GRID_MAX_COLS, 'the columns stop at the sheet width');
});

test('overlapping rowspans terminate and stay inside the cap', async () => {
  // The first cell reserves 900 rows of column A; every following row therefore starts at
  // column B. A walk that did not track occupancy would either loop or overwrite.
  const html = '<table><tr><td rowspan="900">기둥</td><td>b1</td></tr>'
    + '<tr><td>x</td></tr>'.repeat(50)
    + '</table>';
  const started = Date.now();
  const run = await noThrow(() => importHtml(html));
  eq(run.threw, false, 'must not throw: ' + run.value);
  const grid = checkGrid(run.value, 'rowspans');
  eq(Date.now() - started < 15000, true, 'the walk terminates promptly');
  eq(grid.cols, 2, 'two columns');
  eq(grid.cells[0][0].input, '기둥', 'the anchor holds the text');
  eq(grid.cells[0][1].input, 'b1', 'the cell beside it is not overwritten');
  eq(grid.cells[1][0], null, 'the position under the anchor is covered');
  eq(grid.cells[1][1].input, 'x', 'the next row starts in column B');
  eq(grid.cells[50][1].input, 'x', 'and so does the last one');
});

test('malformed markup with unclosed tags still yields a rectangular grid', async () => {
  // No </td>, no </tr>, no </table>, and an open <b> across a cell boundary.
  const html = '<table><tr><td><b>굵게<td>둘째<tr><td>셋째<td>';
  const run = await noThrow(() => importHtml(html));
  eq(run.threw, false, 'unclosed markup must not throw: ' + run.value);
  const grid = checkGrid(run.value, 'malformed');
  eq(grid.rows, 2, 'two rows');
  eq(grid.cols, 2, 'two columns');
  eq(inputsOf(grid), [['굵게', '둘째'], ['셋째', '']], 'each cell keeps its own text');
  // <b> is markup, not an inline style declaration: this importer reads CSS, and every
  // real spreadsheet writes font-weight inline.
  eq(stylesOf(grid), [[null, null], [null, null]], 'no style is guessed from tags');
  assertNoMarkup(grid, 'malformed');
});

test('markup that is not a table yields null', async () => {
  const cases = [
    ['<div>그냥 텍스트</div>', 'a div'],
    ['<p>a</p><p>b</p>', 'paragraphs'],
    ['<ul><li>하나</li><li>둘</li></ul>', 'a list'],
    ['<table></table>', 'an empty table'],
    ['<table><tbody></tbody></table>', 'an empty body'],
    ['<table><tr></tr></table>', 'a row with no cells'],
    ['<html><body><table>', 'an unterminated table with no rows'],
    ['<svg><rect width="10"/></svg>', 'an svg'],
    ['<!-- <table><tr><td>x</td></tr></table> -->', 'a table inside a comment'],
    ['<script>document.write("<table><tr><td>x")</script>', 'a table inside a script'],
    ['그냥 붙여넣은 글자', 'plain text with no markup at all'],
    ['', 'the empty string'],
  ];
  for (const [html, label] of cases) {
    const run = await noThrow(() => importHtml(html));
    eq(run.threw, false, label + ' must not throw: ' + run.value);
    eq(run.value, null, label + ' has no usable table');
  }
});

test('a non-string, or markup past the size limit, yields null', async () => {
  const cases = [null, undefined, 0, 42, true, {}, [], new Date(), () => '<table><tr><td>x'];
  for (const value of cases) {
    const run = await noThrow(() => importHtml(value));
    eq(run.threw, false, 'a ' + typeof value + ' must not throw: ' + run.value);
    eq(run.value, null, 'only a string can be a clipboard payload');
  }
  // 8 MB is the ceiling; one byte past it is refused rather than parsed.
  const huge = '<table><tr><td>' + 'a'.repeat(8 * 1024 * 1024) + '</td></tr></table>';
  const run = await noThrow(() => importHtml(huge));
  eq(run.threw, false, 'an oversize payload must not throw: ' + run.value);
  eq(run.value, null, 'an oversize payload is refused whole');
});

test('the biggest table wins when a payload wraps one in another', async () => {
  // Outlook and Word wrap a copied range in a layout table. The real one is the one with
  // cells of its own, and a nested table never lends its cells to its parent.
  const html = '<table class="wrapper"><tr><td>'
    + '<table><tbody>'
    + '<tr><td>가</td><td>나</td></tr>'
    + '<tr><td>다</td><td>라</td></tr>'
    + '</tbody></table>'
    + '</td></tr></table>';
  const grid = checkGrid(await importHtml(html), 'nested');
  eq(grid.rows, 2, 'the inner table is the one with cells of its own');
  eq(grid.cols, 2, 'so the wrapper contributes nothing but its one layout cell');
  eq(inputsOf(grid), [['가', '나'], ['다', '라']], 'the real range is imported');
  assertNoMarkup(grid, 'nested');
});

test('parseExternalHtml returns null where there is no DOMParser', async () => {
  // Node has none. The honest answer is "I cannot read this", and the caller then falls
  // back to the plain-text parse — never a half-read grid, never a throw.
  const saved = globalThis.DOMParser;
  try {
    delete globalThis.DOMParser;
    const run = await noThrow(() => importHtml('<table><tr><td>가</td></tr></table>'));
    eq(run.threw, false, 'a missing DOMParser must not throw: ' + run.value);
    eq(run.value, null, 'no parser, no grid');
  } finally {
    globalThis.DOMParser = saved;
  }
});

test('every payload in this file parses without a style value from the markup', async () => {
  // A last sweep: the three real payloads, re-checked as one, so a change that starts
  // passing a raw CSS string through fails here even if the case that covers it changes.
  for (const [html, label] of [[GOOGLE_HTML, 'google'], [EXCEL_HTML, 'excel'], [SHEETZI_HTML, 'sheetzi']]) {
    const run = await noThrow(() => importHtml(html));
    eq(run.threw, false, label + ' must not throw: ' + run.value);
    const grid = checkGrid(run.value, label);
    assertNoMarkup(grid, label);
  }
});
