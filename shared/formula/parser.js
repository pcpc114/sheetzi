// shared/formula/parser.js
// Recursive-descent / precedence-climbing parser for the 시트지 formula language,
// plus the canonical serializer and the reference walkers used by copy/paste and
// by structural edits.
// Pure ESM. Must run identically in Node and in the browser.

import { tokenize, ParseError } from './tokenizer.js';
import {
  a1ToCell,
  cellToA1,
  colToLetter,
  parseRange,
  quoteSheetName,
  MAX_ROWS,
  MAX_COLS,
} from './refs.js';

// Re-exported so callers only need one import for parse + its error type.
export { ParseError };

// Binary operator precedence, lowest level first. Every level is LEFT-associative,
// including '^' (Excel: 2^3^2 === 64).
const BIN_LEVELS = [
  ['=', '<>', '<', '>', '<=', '>='], // 1 comparison
  ['&'],                             // 2 concatenation
  ['+', '-'],                        // 3 additive
  ['*', '/'],                        // 4 multiplicative
  ['^'],                             // 5 power
];

// op -> numeric precedence (1..5)
const OP_PREC = new Map();
for (let level = 0; level < BIN_LEVELS.length; level += 1) {
  for (const op of BIN_LEVELS[level]) OP_PREC.set(op, level + 1);
}

const PREC_UNARY = 6;
const PREC_POSTFIX = 7;
const PREC_PRIMARY = 8;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function tokenText(tok) {
  if (!tok) return '';
  if (tok.type === 'str') return `"${String(tok.value).replace(/"/g, '""')}"`;
  if (tok.type === 'bool') return tok.value ? 'TRUE' : 'FALSE';
  return String(tok.value);
}

// A stable {row,col,absRow,absCol} shape, decoupled from whatever refs.js returns,
// so that parse -> serialize -> parse produces structurally identical nodes.
function cloneEndpoint(p) {
  return {
    row: p.row,
    col: p.col,
    absRow: !!p.absRow,
    absCol: !!p.absCol,
  };
}

/**
 * Map one endpoint of a whole-column / whole-row range, transforming only the axis that
 * carries a real reference and leaving the spanning axis at its sentinel.
 *
 * `fn` is opaque — it takes a whole {row,col} and answers with a whole {row,col} or
 * {oob:true}, so there is no way to ask it about a single axis. Instead we probe with
 * several positions along the spanning axis and keep the first answer that survives.
 * A structural edit deletes one contiguous band, so probes at the start, middle and end
 * of the span cannot all fall inside it unless the entire axis is gone — in which case
 * every probe is oob and #REF! is the right answer.
 *
 * @param {{row:number,col:number,absRow:boolean,absCol:boolean}} endpoint
 * @param {(ref:object)=>object} fn        the caller's ref transform
 * @param {'col'|'row'} meaningful         which axis is a real reference
 */
function mapSpanEndpoint(endpoint, fn, meaningful) {
  const span = meaningful === 'col' ? 'row' : 'col';
  const limit = meaningful === 'col' ? MAX_ROWS : MAX_COLS;
  const probes = [endpoint[span], 0, Math.floor(limit / 2), limit - 1];
  for (const value of probes) {
    if (!Number.isInteger(value) || value < 0 || value >= limit) continue;
    const out = fn({ ...cloneEndpoint(endpoint), [span]: value });
    // Keep the transformed meaningful axis; restore the sentinel we started with.
    if (!isOob(out)) return { ...cloneEndpoint(out), [span]: endpoint[span] };
  }
  return { oob: true };
}

/**
 * The foreign-sheet name on a 'ref' / 'range' node, or null when the node points at the
 * sheet it lives on. Every ref/range node carries `sheet`, but hand-built nodes from older
 * callers may omit it, so `undefined` counts as local.
 *
 * @param {object} node AST node.
 * @returns {string|null} A non-empty sheet name, or null.
 */
function foreignSheet(node) {
  const name = node && node.sheet;
  return typeof name === 'string' && name !== '' ? name : null;
}

// A ref transform result is unusable when it is flagged oob or is not a real cell.
function isOob(r) {
  if (!r || typeof r !== 'object') return true;
  if (r.oob === true) return true;
  return !Number.isInteger(r.row) || !Number.isInteger(r.col);
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

class Parser {
  constructor(tokens, endPos) {
    this.toks = tokens;
    this.i = 0;
    this.endPos = endPos;
  }

  peek(k = 0) {
    const t = this.toks[this.i + k];
    return t === undefined ? null : t;
  }

  next() {
    const t = this.toks[this.i];
    this.i += 1;
    return t === undefined ? null : t;
  }

  atEndError() {
    return new ParseError(`수식이 완결되지 않았습니다 (위치 ${this.endPos})`, this.endPos);
  }

  // expr := binary(level 0)
  parseExpression() {
    return this.parseBinary(0);
  }

  parseBinary(level) {
    if (level >= BIN_LEVELS.length) return this.parseUnary();
    const ops = BIN_LEVELS[level];
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== 'op' || ops.indexOf(t.value) === -1) break;
      this.i += 1;
      const right = this.parseBinary(level + 1); // left-associative: same level not re-entered
      left = { type: 'binary', op: t.value, left, right };
    }
    return left;
  }

  // Unary +/- binds tighter than '^' (Excel: -2^2 === 4).
  parseUnary() {
    const t = this.peek();
    if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.i += 1;
      const arg = this.parseUnary();
      return { type: 'unary', op: t.value, arg };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== 'op' || t.value !== '%') break;
      this.i += 1;
      node = { type: 'postfix', op: '%', arg: node };
    }
    return node;
  }

  parsePrimary() {
    const t = this.next();
    if (!t) throw this.atEndError();

    switch (t.type) {
      case 'num':
        return { type: 'num', value: t.value };
      case 'str':
        return { type: 'str', value: t.value };
      case 'bool':
        return { type: 'bool', value: t.value };
      case 'err':
        return { type: 'error', value: t.value };
      case 'ref': {
        let c;
        try {
          c = a1ToCell(t.value);
        } catch (e) {
          throw new ParseError(`잘못된 셀 참조입니다: '${t.value}' (위치 ${t.pos})`, t.pos);
        }
        return {
          type: 'ref',
          sheet: c.sheet === undefined ? null : c.sheet,
          row: c.row,
          col: c.col,
          absRow: !!c.absRow,
          absCol: !!c.absCol,
        };
      }
      case 'range': {
        let r;
        try {
          r = parseRange(t.value);
        } catch (e) {
          throw new ParseError(`잘못된 범위 참조입니다: '${t.value}' (위치 ${t.pos})`, t.pos);
        }
        const node = {
          type: 'range',
          sheet: r.sheet === undefined ? null : r.sheet,
          s: cloneEndpoint(r.s),
          e: cloneEndpoint(r.e),
        };
        if (r.wholeCol) node.wholeCol = true;
        if (r.wholeRow) node.wholeRow = true;
        return node;
      }
      case 'lparen': {
        const inner = this.parseExpression();
        const close = this.next();
        if (!close) throw new ParseError(`닫는 괄호 ')'가 필요합니다 (위치 ${this.endPos})`, this.endPos);
        if (close.type !== 'rparen') {
          throw new ParseError(`닫는 괄호 ')'가 필요합니다 (위치 ${close.pos})`, close.pos);
        }
        // Grouping leaves no node of its own; serialize() re-adds the parentheses
        // that the tree shape needs.
        return inner;
      }
      case 'ident': {
        const nt = this.peek();
        if (nt && nt.type === 'lparen') {
          this.i += 1;
          return this.parseCall(t);
        }
        throw new ParseError(`알 수 없는 이름입니다: '${t.value}' (위치 ${t.pos})`, t.pos);
      }
      default:
        throw new ParseError(`예상치 못한 토큰 '${tokenText(t)}' (위치 ${t.pos})`, t.pos);
    }
  }

  // The '(' has already been consumed.
  parseCall(nameTok) {
    const name = String(nameTok.value).toUpperCase();
    const args = [];

    const first = this.peek();
    if (first && first.type === 'rparen') {
      this.i += 1;
      return { type: 'call', name, args };
    }

    for (;;) {
      const t = this.peek();
      if (!t) throw new ParseError(`닫는 괄호 ')'가 필요합니다 (위치 ${this.endPos})`, this.endPos);
      // An empty slot -- IF(A1,,1) has three arguments, the middle one blank.
      if (t.type === 'comma' || t.type === 'rparen') {
        args.push({ type: 'blank' });
      } else {
        args.push(this.parseExpression());
      }
      const sep = this.next();
      if (!sep) throw new ParseError(`닫는 괄호 ')'가 필요합니다 (위치 ${this.endPos})`, this.endPos);
      if (sep.type === 'comma') continue;
      if (sep.type === 'rparen') break;
      throw new ParseError(
        `인수 구분자 ',' 또는 닫는 괄호 ')'가 필요합니다 (위치 ${sep.pos})`,
        sep.pos,
      );
    }

    return { type: 'call', name, args };
  }
}

/**
 * parse(src) -> AST node. src is the formula text WITHOUT the leading '='.
 * Throws ParseError; trailing content after a complete expression is an error,
 * never silently ignored.
 */
export function parse(src) {
  const text = src === undefined || src === null ? '' : String(src);
  const tokens = tokenize(text);
  const p = new Parser(tokens, text.length);
  const node = p.parseExpression();
  const rest = p.peek();
  if (rest) {
    throw new ParseError(
      `수식 뒤에 불필요한 내용이 있습니다: '${tokenText(rest)}' (위치 ${rest.pos})`,
      rest.pos,
    );
  }
  return node;
}

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

// Effective precedence of a node when it appears as an operand.
// A negative numeric literal is treated as if it were a unary expression so that
// hand-built nodes such as {type:'num',value:-5} still round-trip.
function precOf(node) {
  if (!node || typeof node !== 'object') return PREC_PRIMARY;
  switch (node.type) {
    case 'binary': {
      const p = OP_PREC.get(node.op);
      return p === undefined ? 1 : p;
    }
    case 'unary':
      return PREC_UNARY;
    case 'postfix':
      return PREC_POSTFIX;
    case 'num':
      return typeof node.value === 'number' && node.value < 0 ? PREC_UNARY : PREC_PRIMARY;
    default:
      return PREC_PRIMARY;
  }
}

// Serialize a child, wrapping it in parentheses only when the tree shape needs them.
function operand(node, minPrec) {
  const text = serialize(node);
  return precOf(node) < minPrec ? `(${text})` : text;
}

function numberLiteral(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '#NUM!';
  return String(v);
}

function refText(p) {
  return `${p.absCol ? '$' : ''}${colToLetter(p.col)}${p.absRow ? '$' : ''}${p.row + 1}`;
}

function colText(p) {
  return `${p.absCol ? '$' : ''}${colToLetter(p.col)}`;
}

function rowText(p) {
  return `${p.absRow ? '$' : ''}${p.row + 1}`;
}

function rangeText(node) {
  if (node.wholeCol) return `${colText(node.s)}:${colText(node.e)}`;
  if (node.wholeRow) return `${rowText(node.s)}:${rowText(node.e)}`;
  return `${refText(node.s)}:${refText(node.e)}`;
}

// "시트2!" / "'매출 집계'!" for a foreign node, '' for a local one. quoteSheetName decides
// whether quotes are needed, so serialize -> parse round-trips any legal sheet name.
function sheetPrefix(node) {
  const name = foreignSheet(node);
  return name === null ? '' : `${quoteSheetName(name)}!`;
}

/**
 * serialize(node) -> formula text WITHOUT the leading '='.
 * Canonical spacing (no spaces outside string literals), UPPERCASE function names,
 * '$' flags preserved, strings quoted with doubled inner quotes, and exactly the
 * parentheses required to preserve the tree shape.
 */
export function serialize(node) {
  if (node === null || node === undefined) return '';
  switch (node.type) {
    case 'num':
      return numberLiteral(node.value);
    case 'str':
      return `"${String(node.value).replace(/"/g, '""')}"`;
    case 'bool':
      return node.value ? 'TRUE' : 'FALSE';
    case 'error':
      return String(node.value);
    case 'blank':
      return '';
    case 'ref':
      return sheetPrefix(node) + refText(node);
    case 'range':
      return sheetPrefix(node) + rangeText(node);
    case 'unary':
      // PREC_UNARY + 1 keeps '-(-1)' and '-(-5 literal)' unambiguous.
      return node.op + operand(node.arg, PREC_UNARY + 1);
    case 'postfix':
      return operand(node.arg, PREC_POSTFIX) + node.op;
    case 'binary': {
      const p = precOf(node);
      // Left-associative: an operand of equal precedence on the RIGHT needs parens.
      return operand(node.left, p) + node.op + operand(node.right, p + 1);
    }
    case 'call': {
      const args = Array.isArray(node.args) ? node.args : [];
      return `${String(node.name).toUpperCase()}(${args.map((a) => serialize(a)).join(',')})`;
    }
    default:
      throw new ParseError(`직렬화할 수 없는 노드입니다: '${node && node.type}'`, -1);
  }
}

// ---------------------------------------------------------------------------
// reference walkers
// ---------------------------------------------------------------------------

/**
 * collectRefs(node) -> { cells: string[], ranges: Range[], sheets: string[] }
 *
 * cells are canonical A1 keys with no '$', deduplicated in first-seen order.
 * ranges are fresh Range objects ({sheet:null,s,e} plus wholeCol/wholeRow when set).
 *
 * cells and ranges hold LOCAL references only. A cross-sheet reference contributes its
 * sheet name to `sheets` (sorted, unique) and nothing else: registering 'Sheet2!A1' as a
 * precedent in THIS sheet's dependency graph would make a write to the local A1 invalidate
 * a formula that never reads it, and leave the real precedent untracked.
 */
export function collectRefs(node) {
  const cells = [];
  const ranges = [];
  const seen = new Set();
  const sheetSet = new Set();

  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    switch (n.type) {
      case 'ref': {
        const foreign = foreignSheet(n);
        if (foreign !== null) {
          sheetSet.add(foreign);
          break;
        }
        const key = cellToA1(n.row, n.col);
        if (!seen.has(key)) {
          seen.add(key);
          cells.push(key);
        }
        break;
      }
      case 'range': {
        const foreign = foreignSheet(n);
        if (foreign !== null) {
          sheetSet.add(foreign);
          break;
        }
        const r = { sheet: null, s: cloneEndpoint(n.s), e: cloneEndpoint(n.e) };
        if (n.wholeCol) r.wholeCol = true;
        if (n.wholeRow) r.wholeRow = true;
        ranges.push(r);
        break;
      }
      case 'unary':
      case 'postfix':
        walk(n.arg);
        break;
      case 'binary':
        walk(n.left);
        walk(n.right);
        break;
      case 'call':
        if (Array.isArray(n.args)) for (const a of n.args) walk(a);
        break;
      default:
        break;
    }
  };

  walk(node);
  return { cells, ranges, sheets: Array.from(sheetSet).sort() };
}

/**
 * mapRefs(node, fn) -> deep-cloned AST with every reference passed through fn.
 * fn(refObj) -> refObj | {oob:true}. A 'ref' node whose result is oob, or a 'range'
 * node with an oob endpoint, becomes {type:'error', value:'#REF!'}.
 * fn is always called for BOTH range endpoints, even when the first one is oob.
 *
 * A node that points at another sheet is deep-cloned but NOT transformed: fn describes a
 * copy/paste offset or a row/column insert-delete that happened on THIS sheet, and applying
 * it to another sheet's coordinates would silently corrupt a formula the edit never touched.
 */
export function mapRefs(node, fn) {
  if (!node || typeof node !== 'object') return node;

  switch (node.type) {
    case 'ref': {
      if (foreignSheet(node) !== null) {
        return {
          type: 'ref',
          sheet: node.sheet,
          row: node.row,
          col: node.col,
          absRow: !!node.absRow,
          absCol: !!node.absCol,
        };
      }
      const out = fn(cloneEndpoint(node));
      if (isOob(out)) return { type: 'error', value: '#REF!' };
      return {
        type: 'ref',
        sheet: null,
        row: out.row,
        col: out.col,
        absRow: !!out.absRow,
        absCol: !!out.absCol,
      };
    }
    case 'range': {
      if (foreignSheet(node) !== null) {
        const kept = {
          type: 'range',
          sheet: node.sheet,
          s: cloneEndpoint(node.s),
          e: cloneEndpoint(node.e),
        };
        if (node.wholeCol) kept.wholeCol = true;
        if (node.wholeRow) kept.wholeRow = true;
        return kept;
      }
      // A whole-column ('A:A') or whole-row ('1:3') range stores sentinel coordinates
      // on its spanning axis — rows 0..MAX_ROWS-1, or cols 0..MAX_COLS-1. Those are not
      // real references: serialize() re-emits 'A:A' from the column pair alone and never
      // looks at the rows. Feeding them to `fn` like ordinary coordinates breaks the node
      // two ways. Inserting a row shifts the sentinel to MAX_ROWS, which reports oob and
      // turns the range into #REF!; deleting row 0 puts the other sentinel inside the
      // deleted band, with the same result. Even when it survives, the shifted sentinel
      // disagrees with the text serialize() produces, so the cell's input and its cached
      // AST drift apart. Map only the meaningful axis and pin the span back.
      const whole = node.wholeCol ? 'col' : (node.wholeRow ? 'row' : null);
      const s = whole ? mapSpanEndpoint(node.s, fn, whole) : fn(cloneEndpoint(node.s));
      const e = whole ? mapSpanEndpoint(node.e, fn, whole) : fn(cloneEndpoint(node.e));
      if (isOob(s) || isOob(e)) return { type: 'error', value: '#REF!' };
      const out = { type: 'range', sheet: null, s: cloneEndpoint(s), e: cloneEndpoint(e) };
      if (node.wholeCol) out.wholeCol = true;
      if (node.wholeRow) out.wholeRow = true;
      return out;
    }
    case 'unary':
      return { type: 'unary', op: node.op, arg: mapRefs(node.arg, fn) };
    case 'postfix':
      return { type: 'postfix', op: node.op, arg: mapRefs(node.arg, fn) };
    case 'binary':
      return {
        type: 'binary',
        op: node.op,
        left: mapRefs(node.left, fn),
        right: mapRefs(node.right, fn),
      };
    case 'call':
      return {
        type: 'call',
        name: node.name,
        args: (Array.isArray(node.args) ? node.args : []).map((a) => mapRefs(a, fn)),
      };
    case 'blank':
      return { type: 'blank' };
    default:
      // num / str / bool / error literals
      return { ...node };
  }
}

/* ---------------------------------------------------------------------------
   Self-check. Inert on import by design: the whole block lives inside this
   comment. To run it, uncomment the body and execute
   `node shared/formula/parser.js`.

const S = (x) => serialize(parse(x));
const J = (x) => JSON.stringify(x);
let bad = 0;
const eq = (label, got, want) => {
  if (got !== want) { bad += 1; console.log('FAIL', label, '->', got, '| want', want); }
};

// canonical serialization + parenthesis minimality
eq('add', S('1 + 2'), '1+2');
eq('prec', S('1+2*3'), '1+2*3');
eq('group', S('(1+2)*3'), '(1+2)*3');
eq('drop', S('1+(2*3)'), '1+2*3');
eq('leftassoc', S('1-2-3'), '1-2-3');
eq('rightgroup', S('1-(2-3)'), '1-(2-3)');
eq('powleft', S('2^3^2'), '2^3^2');
eq('powgroup', S('2^(3^2)'), '2^(3^2)');
eq('unarypow', S('-2^2'), '-2^2');
eq('pct', S('-5%'), '-5%');
eq('cmp', S('a1<>b1'), 'A1<>B1');
eq('concat', S('"a" & "b"'), '"a"&"b"');
eq('quote', S('"say ""hi"""'), '"say ""hi"""');
eq('fn', S('sum(a1:b2, 3)'), 'SUM(A1:B2,3)');
eq('blank', S('IF(A1,,1)'), 'IF(A1,,1)');
eq('abs', S('$a$1:$b$2'), '$A$1:$B$2');
eq('wholecol', S('a:a'), 'A:A');
eq('wholerow', S('1:3'), '1:3');
eq('noargs', S('PI()'), 'PI()');
eq('err', S('#N/A'), '#N/A');
eq('bool', S('true'), 'TRUE');

// sheet qualifiers: quoted only when the name is not a bare identifier
eq('sheet bare', S('시트2!a1'), '시트2!A1');
eq('sheet unquote', S("'Sheet2'!A1"), 'Sheet2!A1');
eq('sheet quote', S("'매출 집계'!a1:b10"), "'매출 집계'!A1:B10");
eq('sheet inner quote', S("'a''b'!A1"), "'a''b'!A1");
eq('sheet wholecol', S('Sheet2!a:a'), 'Sheet2!A:A');
eq('sheet local is null', String(parse('A1').sheet), 'null');

// three arguments, middle blank
eq('argc', String(parse('IF(A1,,1)').args.length), '3');

// round-trip: parse(serialize(parse(x))) deep-equals parse(x)
const RT = [
  '1+2*3-4/5', '(1+2)*(3+4)', '2^3^2', '2^(3^2)', '-2^2', '-(-1)', '5%%',
  'SUM(A1:B2,IF(A1>0,"y","n"),,-3)', 'A1&"x"&B2', '$A$1+A$1+$A1+A1',
  'A:A', '$B:$D', '1:3', 'NOT(TRUE)', '#DIV/0!', '1<2=TRUE', '.5e-3',
  'SUM(1,)', '((A1))', 'AVERAGE(A1:A10)*100%',
  '시트2!A1', "'매출 집계'!A1:B10", "'a''b'!$A$1", 'Sheet2!A:A', 'A1+시트2!B2',
];
for (const x of RT) {
  const a = parse(x);
  const b = parse(serialize(a));
  if (J(a) !== J(b)) { bad += 1; console.log('FAIL round-trip', x, J(a), J(b)); }
}

// trailing garbage and other failures must throw
for (const x of ['1+2 3', '1+', 'SUM(1', ')', '', 'FOO', '1 2', 'A1 B1']) {
  let threw = false;
  try { parse(x); } catch (e) { threw = e instanceof ParseError; }
  if (!threw) { bad += 1; console.log('FAIL expected ParseError for', x); }
}

// collectRefs
const cr = collectRefs(parse('A1+A1+SUM(B1:C3)+$A$1+D4'));
eq('cells', J(cr.cells), J(['A1', 'D4']));
eq('ranges', String(cr.ranges.length), '1');
eq('range shape', J(cr.ranges[0].s), J({ row: 0, col: 1, absRow: false, absCol: false }));

// mapRefs
const shifted = mapRefs(parse('A1+SUM(B1:C3)'), (r) => ({
  row: r.absRow ? r.row : r.row + 1, col: r.col, absRow: r.absRow, absCol: r.absCol,
}));
eq('mapRefs', serialize(shifted), 'A2+SUM(B2:C4)');
const dead = mapRefs(parse('SUM(B1:C3)'), (r) => (r.row === 0 ? { oob: true } : r));
eq('mapRefs oob', serialize(dead), 'SUM(#REF!)');

// cross-sheet: foreign refs stay out of the local dependency lists and out of mapRefs
const xr = collectRefs(parse('A1+시트2!B2+SUM(시트2!C1:C3)+Zeta!A1'));
eq('collectRefs local cells', J(xr.cells), J(['A1']));
eq('collectRefs local ranges', String(xr.ranges.length), '0');
eq('collectRefs sheets', J(xr.sheets), J(['Zeta', '시트2']));
const foreign = mapRefs(parse('시트2!A1+D1'), (r) => ({ ...r, row: r.row + 1 }));
eq('mapRefs skips foreign', serialize(foreign), '시트2!A1+D2');

console.log(bad === 0 ? 'parser self-check OK' : 'parser self-check FAILED: ' + bad);

--------------------------------------------------------------------------- */
