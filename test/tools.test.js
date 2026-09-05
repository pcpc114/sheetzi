// test/tools.test.js — tools, batch B (SPEC section 23).
//
// Five tools ship in this batch: 서식 복사, 확대/축소, 인쇄, 링크 삽입 and the 함수 도우미.
// Four of them are pure view state (a toolbar flag, a localStorage number, a grid class) and
// have nothing a Node test can hold on to. What IS testable — and what this file pins down —
// is the part of the batch that outlives a click:
//
//   1. `sanitizeLink` (SPEC 23.4). A link arrives from another collaborator, from a pasted
//      document or straight off disk, so it is hostile text by definition. This is the single
//      gate it passes through, and the allow-list is exactly http / https / mailto. The
//      rejection cases below are not hypothetical: `javascript:` with leading whitespace and
//      `java\tscript:` are the two shapes that defeat a naive scheme check, so they get their
//      own cases.
//   2. `sanitizeDoc` carrying `link` (SPEC 23.4). A valid one survives, an invalid one is
//      dropped WITHOUT taking the cell's input with it, and a cell whose only content is a
//      link is a real cell — not an empty entry to be pruned.
//   3. `FUNCTION_DOCS` covering the engine's `FUNCTIONS` table (SPEC 23.5). The 함수 도우미
//      builds its list from the engine, so a name the engine gained and the docs did not is a
//      row with no description; this file is what makes that a failing test rather than a
//      silent gap in the UI.
//   4. `buildPrintHtml` (SPEC 23.3). It is a pure string function precisely so it can be
//      tested without a print dialog: the used range becomes a real <table>, merges become
//      colspans with their covered cells omitted, values are FORMATTED the way the screen
//      formats them, and every one of them is escaped. `<script>alert(1)</script>` in a cell
//      must reach the page as six visible characters and never as an element.
//
// Only what SPEC section 23 guarantees is asserted. Nothing here reaches into a private field,
// and nothing depends on how a URL is normalised beyond the normalisation being consistent.

import { test, eq } from './run.js';
import { readFile } from 'node:fs/promises';

import { sanitizeLink, sanitizeDoc } from '../shared/model.js';
import { FUNCTIONS } from '../shared/formula/functions.js';
import { FUNCTION_DOCS, docFor } from '../shared/formula/function-docs.js';
import { SheetEngine } from '../shared/formula/engine.js';

// ---------------------------------------------------------------------------
// loading public/js/print.js in Node
// ---------------------------------------------------------------------------
//
// The client tree addresses the shared modules the way the BROWSER has to see them —
// `/shared/model.js`, served by `app.use('/shared', express.static('shared'))`. Node resolves
// a root-relative specifier against the file's own URL, so a plain import of print.js looks
// for C:/shared/model.js and fails.
//
// So: try the plain import first (it is what runs the day those specifiers become relative),
// and fall back to loading the module through a rewriter that maps each `/shared/...`
// specifier onto the real file and inlines any sibling client module the same way. The source
// is never edited on disk; the rewritten copy exists only as a data: URL. buildPrintHtml is
// therefore exercised EXACTLY as written, which is the whole point — a shim that reimplemented
// any part of it would be testing itself.

const REPO_ROOT = new URL('../', import.meta.url);
const PRINT_URL = new URL('public/js/print.js', REPO_ROOT).href;

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

let printModule = null;

/** The print module, loaded once and shared by every case below. */
function loadPrint() {
  if (!printModule) {
    printModule = import(PRINT_URL).catch(async (e) => {
      const missing = e && (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (?:module|package)/.test(String(e.message)));
      if (!missing) throw e;
      return import(await shimUrl(PRINT_URL));
    });
  }
  return printModule;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Call `sanitizeLink` and report BOTH the result and whether it threw, so a case can assert
 * "returned null without throwing" in one comparison instead of two.
 */
function link(v) {
  try {
    return { threw: false, value: sanitizeLink(v) };
  } catch (e) {
    return { threw: true, value: String((e && e.message) || e) };
  }
}

/** The result of `sanitizeLink`, asserting only that it did not throw. */
function linkValue(v) {
  const r = link(v);
  eq(r.threw, false, 'sanitizeLink must never throw');
  return r.value;
}

const REJECTED = { threw: false, value: null };

/** A one-sheet document whose only interesting content is `cells`. */
function docWithCells(cells) {
  return {
    id: 'bbbbbb222222',
    name: '도구 문서',
    sheets: [{ id: 'sh0002', name: '시트1', rows: 50, cols: 10, cells }],
    createdAt: 1730000000000,
    updatedAt: 1730000000000,
    rev: 0,
  };
}

/** Push `cells` through sanitizeDoc and hand back the sheet's surviving cell map. */
function sanitizedCells(cells) {
  const doc = docWithCells(cells);
  const before = JSON.stringify(doc);
  const out = sanitizeDoc(doc);
  eq(JSON.stringify(doc), before, 'sanitizeDoc must not mutate its argument');
  return out.sheets[0].cells;
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// The printed fixture. Two rows by three columns of used range, one merge across B1:C1, one
// formatted number, one formula and one cell of hostile text.
//
// C1 deliberately still holds text even though SPEC 21 says a merge clears its covered cells:
// a covered cell must be omitted because of the MERGE, not because it happened to be empty.
const PRINT_CELLS = {
  A1: { input: '항목', style: { b: 1 } },
  B1: { input: '수량', style: { align: 'center' } },
  C1: { input: '덮인칸텍스트' },
  A2: { input: '<script>alert(1)</script>' },
  B2: { input: '1234.5', style: { fmt: 'number', decimals: 1 } },
  C2: { input: '=B2*2' },
};

function printFixture(extra) {
  const cells = { ...PRINT_CELLS, ...(extra || {}) };
  const sheet = {
    id: 'sh0002',
    name: '판매 시트',
    rows: 50,
    cols: 10,
    cells,
    colWidths: { 1: 160 },
    rowHeights: { 0: 32 },
    frozenRows: 0,
    frozenCols: 0,
    merges: ['B1:C1'],
  };
  const engine = new SheetEngine({ rows: sheet.rows, cols: sheet.cols, cells });
  return { sheet, engine };
}

// ===========================================================================
// 23.4 — sanitizeLink: the accepted schemes
// ===========================================================================

test('sanitizeLink accepts an http URL', () => {
  const v = linkValue('http://example.com/a');
  eq(typeof v, 'string', 'http must be accepted');
  eq(v.slice(0, 7), 'http://', 'the scheme must survive intact');
  eq(v.includes('example.com'), true, 'the host must survive intact');
});

test('sanitizeLink accepts an https URL with a query and a fragment', () => {
  eq(linkValue('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
});

test('sanitizeLink accepts a mailto URL', () => {
  eq(linkValue('mailto:a@b.co.kr'), 'mailto:a@b.co.kr');
});

test('sanitizeLink accepts a path with Korean text in it', () => {
  const v = linkValue('https://example.com/문서');
  eq(typeof v, 'string', 'a non-ASCII path is still a valid https URL');
  eq(v.startsWith('https://example.com/'), true);
});

test('sanitizeLink trims leading and trailing whitespace', () => {
  const plain = linkValue('https://example.com/a');
  eq(linkValue('   https://example.com/a'), plain, 'leading whitespace');
  eq(linkValue('https://example.com/a   '), plain, 'trailing whitespace');
  eq(linkValue(' \t\n https://example.com/a \r\n '), plain, 'mixed surrounding whitespace');
  eq(plain, plain.trim(), 'the returned link must carry no whitespace of its own');
});

test('sanitizeLink handles a mixed-case scheme', () => {
  const lower = linkValue('https://example.com/Path');
  eq(linkValue('HtTpS://example.com/Path'), lower, 'HtTpS: is https:');
  eq(linkValue('HTTPS://example.com/Path'), lower, 'HTTPS: is https:');
  eq(linkValue('MAILTO:a@b.co.kr'), linkValue('mailto:a@b.co.kr'), 'MAILTO: is mailto:');
});

// ===========================================================================
// 23.4 — sanitizeLink: everything that must be rejected
// ===========================================================================

test('sanitizeLink rejects javascript:', () => {
  eq(link('javascript:alert(1)'), REJECTED);
});

test('sanitizeLink rejects javascript: hidden behind leading whitespace', () => {
  // Trimming happens before the scheme check, so the trim can never reveal an allowed link.
  eq(link('  javascript:alert(1)'), REJECTED);
  eq(link('\t\n javascript:alert(1)'), REJECTED);
});

test('sanitizeLink rejects javascript: written in mixed case', () => {
  eq(link('JaVaScRiPt:alert(1)'), REJECTED);
  eq(link('JAVASCRIPT:alert(1)'), REJECTED);
});

test('sanitizeLink rejects a scheme split by a control character', () => {
  // 'java\tscript:' is what a browser's URL parser would still read as javascript:.
  eq(link('java\tscript:alert(1)'), REJECTED);
  eq(link('java\nscript:alert(1)'), REJECTED);
  eq(link('java\u0000script:alert(1)'), REJECTED);
});

test('sanitizeLink rejects data:', () => {
  eq(link('data:text/html,<script>alert(1)</script>'), REJECTED);
  eq(link('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), REJECTED);
});

test('sanitizeLink rejects vbscript:', () => {
  eq(link('vbscript:msgbox 1'), REJECTED);
});

test('sanitizeLink rejects file:', () => {
  eq(link('file:///C:/secrets.txt'), REJECTED);
  eq(link('file:///etc/passwd'), REJECTED);
});

test('sanitizeLink rejects a string with no scheme at all', () => {
  eq(link('example.com/path'), REJECTED);
  eq(link('/just/a/path'), REJECTED);
  eq(link('그냥 글자'), REJECTED);
  eq(link(''), REJECTED);
  eq(link('   '), REJECTED);
});

test('sanitizeLink rejects a protocol-relative URL', () => {
  // '//evil.example.com' inherits whatever scheme the page is on; there is nothing to check.
  eq(link('//evil.example.com'), REJECTED);
});

test('sanitizeLink rejects a fine host carried by a scheme that is not allowed', () => {
  eq(link('ftp://example.com/pub/file.txt'), REJECTED);
  eq(link('ws://example.com/socket'), REJECTED);
  eq(link('javascript://example.com/%0aalert(1)'), REJECTED);
});

test('sanitizeLink rejects a control character anywhere in the string', () => {
  eq(link('https://example.com/\u0007bell'), REJECTED);
  eq(link('https://example.com/a\u0000b'), REJECTED);
  eq(link('https://exam\u000dple.com/'), REJECTED);
  eq(link('https://example.com/\u007f'), REJECTED);
});

test('sanitizeLink rejects a link longer than 2048 characters', () => {
  eq(link('https://example.com/' + 'a'.repeat(2100)), REJECTED);
  eq(link('mailto:' + 'a'.repeat(3000) + '@example.com'), REJECTED);
  // Just under the cap is still a link, so the rejection above is the LENGTH and not the shape.
  const short = linkValue('https://example.com/' + 'a'.repeat(1000));
  eq(typeof short, 'string', 'a 1020-character link is fine');
});

test('sanitizeLink returns null for anything that is not a string, without throwing', () => {
  for (const v of [null, undefined, 0, 42, -1, NaN, Infinity, true, false, {}, [],
    ['https://example.com/'], () => 'https://example.com/', Symbol('https://example.com/')]) {
    eq(link(v), REJECTED, 'non-string input');
  }
});

test('sanitizeLink never coerces an object through toString', () => {
  // A value that only LOOKS like a URL must not become one: the gate takes strings.
  eq(link({ toString: () => 'https://example.com/' }), REJECTED);
  eq(link({ href: 'https://example.com/' }), REJECTED);
  // A String OBJECT is not a string primitive, and typeof says so.
  eq(link(new String('https://example.com/')), REJECTED);
});

// ===========================================================================
// 23.4 — sanitizeDoc and the cell `link` field
// ===========================================================================

test('sanitizeDoc carries a valid cell link through', () => {
  const cells = sanitizedCells({ A1: { input: '홈페이지', link: 'https://example.com/a' } });
  eq(cells.A1.input, '홈페이지', 'the input is untouched');
  eq(cells.A1.link, 'https://example.com/a', 'the link survives');
});

test('sanitizeDoc drops an invalid cell link and keeps the rest of the cell', () => {
  const cells = sanitizedCells({
    A1: { input: '눌러보세요', style: { b: 1 }, link: 'javascript:alert(1)' },
  });
  eq(cells.A1.input, '눌러보세요', 'the input survives the bad link');
  eq(cells.A1.style, { b: 1 }, 'the style survives the bad link');
  eq('link' in cells.A1, false, 'the link is gone entirely, not stored as an empty string');
});

test('sanitizeDoc drops every rejected scheme from a cell', () => {
  const cells = sanitizedCells({
    A1: { input: 'a', link: 'data:text/html,<script>alert(1)</script>' },
    A2: { input: 'b', link: 'vbscript:msgbox 1' },
    A3: { input: 'c', link: 'file:///C:/secrets.txt' },
    A4: { input: 'd', link: 'example.com/no-scheme' },
    A5: { input: 'e', link: 'https://ok.example.com/' },
  });
  for (const key of ['A1', 'A2', 'A3', 'A4']) {
    eq('link' in cells[key], false, key + ' must lose its link');
    eq(typeof cells[key].input, 'string', key + ' must keep its input');
  }
  eq(cells.A5.link, 'https://ok.example.com/', 'the one valid link is unaffected by its neighbours');
});

test('sanitizeDoc keeps a cell that has ONLY a link', () => {
  const cells = sanitizedCells({ B2: { link: 'https://example.com/only' } });
  eq('B2' in cells, true, 'a link-only cell is a real cell, not an empty entry');
  eq(cells.B2.link, 'https://example.com/only');
  eq('input' in cells.B2, false, 'no input is invented for it');
});

test('sanitizeDoc drops a cell whose only content is an INVALID link', () => {
  const cells = sanitizedCells({
    B2: { link: 'javascript:alert(1)' },
    B3: { link: 'https://example.com/kept' },
  });
  eq('B2' in cells, false, 'nothing is left, so the entry must not survive as {}');
  eq('B3' in cells, true);
});

test('sanitizeDoc adds no link key to a document that has none', () => {
  // The batch must be invisible to a document that uses none of it.
  const input = { A1: { input: '=SUM(B1:B3)' }, B1: { input: '1', style: { b: 1 } } };
  const cells = sanitizedCells(input);
  eq(JSON.stringify(cells), JSON.stringify(input), 'a link-free cell map round-trips byte-for-byte');
});

test('sanitizeDoc is idempotent over links', () => {
  const once = sanitizeDoc(docWithCells({
    A1: { input: 'a', link: '  HTTPS://Example.com/x  ' },
    A2: { input: 'b', link: 'javascript:alert(1)' },
    A3: { link: 'mailto:a@b.co.kr' },
  }));
  const twice = sanitizeDoc(once);
  eq(JSON.stringify(twice.sheets[0].cells), JSON.stringify(once.sheets[0].cells));
  eq(twice.sheets[0].cells.A3.link, 'mailto:a@b.co.kr', 'a normalised link is stable');
});

test('sanitizeDoc never throws on a hostile link value', () => {
  for (const bad of [null, 0, true, {}, [], { toString: () => 'javascript:alert(1)' },
    'javascript:alert(1)', 'java\tscript:alert(1)', 'x'.repeat(9000)]) {
    const cells = sanitizedCells({ A1: { input: 'keep', link: bad } });
    eq(cells.A1.input, 'keep', 'the cell survives whatever the link was');
    eq('link' in cells.A1, false, 'and stores nothing for it');
  }
});

// ===========================================================================
// 23.5 — FUNCTION_DOCS covers the engine's FUNCTIONS table
// ===========================================================================

test('FUNCTION_DOCS has an entry for every function the engine defines', () => {
  const missing = Object.keys(FUNCTIONS).filter(
    (name) => !Object.prototype.hasOwnProperty.call(FUNCTION_DOCS, name)
  );
  eq(missing, [], 'FUNCTION_DOCS is missing ' + missing.length + ' function(s): ' + missing.join(', '));
});

test('the engine defines at least the function set SPEC section 7 requires', () => {
  // A guard on the case above: it would also pass against an EMPTY FUNCTIONS table.
  const names = Object.keys(FUNCTIONS);
  eq(names.length >= 100, true, 'expected the full library, got ' + names.length + ' function(s)');
  for (const name of ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'IF', 'VLOOKUP', 'TEXT']) {
    eq(Object.prototype.hasOwnProperty.call(FUNCTIONS, name), true, name + ' must exist');
  }
});

test('every FUNCTION_DOCS description is a non-empty string', () => {
  const bad = Object.keys(FUNCTION_DOCS).filter((name) => {
    const d = FUNCTION_DOCS[name];
    return typeof d !== 'string' || d.trim() === '';
  });
  eq(bad, [], 'these descriptions are empty or not strings: ' + bad.join(', '));
});

test('no FUNCTION_DOCS description contains an HTML angle bracket', () => {
  // The 함수 도우미 lists these next to a name; a description is inserted as text, and it
  // must not carry markup that a careless renderer could turn into an element.
  const bad = Object.keys(FUNCTION_DOCS).filter((name) => /[<>]/.test(FUNCTION_DOCS[name]));
  eq(bad, [], 'these descriptions contain < or >: ' + bad.join(', '));
});

test('docFor returns the description for a known name', () => {
  eq(docFor('SUM'), FUNCTION_DOCS.SUM);
  eq(typeof docFor('SUM'), 'string');
  eq(docFor('SUM').length > 0, true);
  eq(docFor('VLOOKUP'), FUNCTION_DOCS.VLOOKUP);
});

test('docFor returns an empty string for an unknown name', () => {
  eq(docFor('NOSUCHFUNCTION'), '');
  eq(docFor(''), '');
  // An inherited property name is not a function name either.
  eq(docFor('constructor'), '');
  eq(docFor('toString'), '');
  eq(docFor('__proto__'), '');
});

test('docFor answers for every name the engine knows', () => {
  for (const name of Object.keys(FUNCTIONS)) {
    const d = docFor(name);
    eq(typeof d, 'string', 'docFor(' + name + ') must return a string');
    eq(d, FUNCTION_DOCS[name], 'docFor(' + name + ') must match the map');
  }
});

// ===========================================================================
// 23.3 — buildPrintHtml
// ===========================================================================

test('buildPrintHtml is importable in Node and needs no document', () => {
  eq(typeof document, 'undefined', 'this test runs where there is no DOM at all');
  return loadPrint().then((mod) => {
    eq(typeof mod.buildPrintHtml, 'function', 'buildPrintHtml must be exported');
    const { sheet, engine } = printFixture();
    const html = mod.buildPrintHtml(sheet, engine, { docName: '판매', sheetName: '판매 시트' });
    eq(typeof html, 'string');
    eq(html.length > 0, true);
  });
});

test('buildPrintHtml emits a real table', () => {
  return loadPrint().then((mod) => {
    const { sheet, engine } = printFixture();
    const html = mod.buildPrintHtml(sheet, engine, { docName: '판매', sheetName: '판매 시트' });
    eq(html.includes('<table'), true, 'a <table> is what lets the browser paginate');
    eq(html.includes('</table>'), true, 'and it must be closed');
  });
});

test('buildPrintHtml emits one <td> per visible cell of the used range', () => {
  return loadPrint().then((mod) => {
    const { sheet, engine } = printFixture();
    const html = mod.buildPrintHtml(sheet, engine, { docName: '판매', sheetName: '판매 시트' });
    // Used range A1:C2 = 6 cells, minus C1 which the B1:C1 merge covers.
    eq(count(html, '<td'), 5, 'six cells in the used range, one of them covered by a merge');
  });
});

test('buildPrintHtml writes the FORMATTED value, not the stored input', () => {
  return loadPrint().then((mod) => {
    const { sheet, engine } = printFixture();
    const html = mod.buildPrintHtml(sheet, engine, { docName: '판매', sheetName: '판매 시트' });
    eq(html.includes('1,234.5'), true, 'fmt:number with decimals:1 prints as 1,234.5');
    eq(html.includes('1234.5'), false, 'the raw input must not reach the page');
    eq(html.includes('2469'), true, 'a formula prints its computed value');
    eq(html.includes('=B2*2'), false, 'a formula must not print its source text');
    eq(html.includes('항목'), true, 'plain text prints as itself');
  });
});

test('buildPrintHtml turns a merge into a colspan and omits the covered cells', () => {
  return loadPrint().then((mod) => {
    const { sheet, engine } = printFixture();
    const html = mod.buildPrintHtml(sheet, engine, { docName: '판매', sheetName: '판매 시트' });
    eq(count(html, 'colspan="2"'), 1, 'B1:C1 spans two columns');
    eq(html.includes('수량'), true, 'the merge anchor keeps its contents');
    eq(html.includes('덮인칸텍스트'), false, 'a covered cell is omitted entirely, contents and all');
  });
});

test('buildPrintHtml escapes a cell that contains markup', () => {
  return loadPrint().then((mod) => {
    const { sheet, engine } = printFixture();
    const html = mod.buildPrintHtml(sheet, engine, { docName: '판매', sheetName: '판매 시트' });
    eq(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true, 'the cell prints as visible text');
    eq(html.includes('<script'), false, 'and creates no element');
    eq(html.includes('alert(1)'), true, 'the text itself is still there, just inert');
  });
});

test('buildPrintHtml escapes markup in the document and sheet names too', () => {
  return loadPrint().then((mod) => {
    const { sheet, engine } = printFixture();
    const html = mod.buildPrintHtml(sheet, engine, {
      docName: '<script>alert("doc")</script>',
      sheetName: '<img src=x onerror=alert(1)>',
    });
    eq(html.includes('<script'), false, 'a document name cannot open an element');
    eq(html.includes('<img'), false, 'nor can a sheet name');
    eq(html.includes('&lt;img'), true, 'the name is still shown, as text');
  });
});

test('buildPrintHtml never emits a rejected link, and every anchor is rel-guarded', () => {
  return loadPrint().then((mod) => {
    const { sheet, engine } = printFixture({
      A2: { input: '눌러보세요', link: 'javascript:alert(1)' },
      B2: { input: '메일', link: 'mailto:a@b.co.kr' },
    });
    const html = mod.buildPrintHtml(sheet, engine, { docName: '판매', sheetName: '판매 시트' });
    eq(html.includes('javascript:'), false, 'a link is re-checked at the point of use');
    eq(count(html, '<a '), count(html, 'rel="noopener noreferrer"'),
      'every anchor the print document emits carries rel="noopener noreferrer"');
  });
});

test('buildPrintHtml handles a sheet with no cells at all', () => {
  return loadPrint().then((mod) => {
    const sheet = {
      id: 'sh0003', name: '빈 시트', rows: 20, cols: 5, cells: {},
      colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, merges: [],
    };
    const engine = new SheetEngine({ rows: 20, cols: 5, cells: {} });
    const html = mod.buildPrintHtml(sheet, engine, { docName: '빈 문서', sheetName: '빈 시트' });
    eq(typeof html, 'string', 'an empty sheet still produces a document');
    eq(html.includes('<table'), true, 'and still produces a table');
  });
});
