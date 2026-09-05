// test/formula.test.js — tokenizer, parser/serializer, value coercion and the function library
// (SPEC sections 2, 4, 5, 6, 7, 8).
import { test, eq, close } from './run.js';
import { ERR, FormulaError, err, isError } from '../shared/formula/errors.js';
import { tokenize, ParseError } from '../shared/formula/tokenizer.js';
import { parse, serialize, collectRefs, mapRefs } from '../shared/formula/parser.js';
import {
  RangeValue,
  toNumber,
  toText,
  toBool,
  compareValues,
  flattenArgs,
  firstErrorIn,
  equalsLoose,
  EPOCH_MS,
  dateToSerial,
  serialToDate,
} from '../shared/formula/values.js';
import { getFunction, matchesCriteria } from '../shared/formula/functions.js';
import { offsetRef } from '../shared/formula/refs.js';
import { SheetEngine } from '../shared/formula/engine.js';

// --- helpers ---------------------------------------------------------------

/** FormulaError -> its code string; anything else passes through untouched. */
function code(v) {
  return v && typeof v === 'object' && typeof v.code === 'string' ? v.code : v;
}

function types(src) {
  return tokenize(src).map((t) => t.type);
}

function throwsParseError(fn) {
  try {
    fn();
  } catch (e) {
    return e instanceof ParseError;
  }
  return false;
}

// A single shared fixture sheet drives the function-library cases. It is built lazily so a
// broken engine only fails the cases that actually need a sheet.
const FIXTURE = {
  A1: '1', A2: '2', A3: '3', A4: '4', A5: '5',
  B1: '10', B2: '20', B3: '30', B4: '40', B5: '50',
  C1: 'apple', C2: 'banana', C3: 'cherry', C4: 'durian', C5: 'elderberry',
  D1: 'TRUE', D2: 'FALSE',
  E2: '0',
  F1: '10', F2: '20', F3: '30', F4: '40',
  G1: 'ten', G2: 'twenty', G3: 'thirty', G4: 'forty',
  H1: '=1/0',
  J1: '1', J3: '3',
  K1: '1', L1: '2', M1: '3',
  K2: 'one', L2: 'two', M2: 'three',
};

let fixtureEngine = null;
function fx() {
  if (!fixtureEngine) {
    const e = new SheetEngine({ rows: 200, cols: 26 });
    e.setInputs(FIXTURE);
    fixtureEngine = e;
  }
  return fixtureEngine;
}

/** Evaluate a formula body (no leading '=') against the fixture sheet. */
function v(expr) {
  const e = fx();
  e.setInput('Z200', '=' + expr);
  return e.getValue('Z200');
}

/** Evaluate a formula body and return its FormulaError code (or the raw value). */
function vc(expr) {
  return code(v(expr));
}

// --- errors.js -------------------------------------------------------------

test('errors: ERR codes have the documented spellings', () => {
  eq(ERR.DIV0, '#DIV/0!');
  eq(ERR.VALUE, '#VALUE!');
  eq(ERR.REF, '#REF!');
  eq(ERR.NAME, '#NAME?');
  eq(ERR.NUM, '#NUM!');
  eq(ERR.NA, '#N/A');
  eq(ERR.CYCLE, '#CYCLE!');
  eq(ERR.PARSE, '#ERROR!');
});

test('errors: err() builds a FormulaError carrying code and message', () => {
  const e = err(ERR.VALUE, 'bad input');
  eq(e instanceof FormulaError, true);
  eq(e.code, ERR.VALUE);
  eq(e.message, 'bad input');
});

test('errors: FormulaError.toString() is the bare code', () => {
  eq(String(err(ERR.DIV0)), '#DIV/0!');
  eq('' + err(ERR.NA, 'nope'), '#N/A');
});

test('errors: message defaults to the empty string', () => {
  eq(err(ERR.NUM).message, '');
});

test('errors: FormulaError is a value, not an Error subclass', () => {
  eq(err(ERR.REF) instanceof Error, false);
});

test('errors: isError only accepts FormulaError values', () => {
  eq(isError(err(ERR.NA)), true);
  eq(isError('#N/A'), false);
  eq(isError(null), false);
  eq(isError(0), false);
  eq(isError(new Error('x')), false);
});

// --- tokenizer -------------------------------------------------------------

test('tokenize: a formula exercising every token type', () => {
  const src = 'SUM(A1:B2,$C$3,1.5,"a""b",TRUE,#N/A)&"x"<=2';
  eq(types(src), [
    'ident', 'lparen', 'range', 'comma', 'ref', 'comma', 'num', 'comma', 'str', 'comma',
    'bool', 'comma', 'err', 'rparen', 'op', 'str', 'op', 'num',
  ]);
});

test('tokenize: values of every token type', () => {
  const t = tokenize('SUM(A1:B2,$C$3,1.5,"a""b",TRUE,#N/A)&"x"<=2');
  eq(t[0].value, 'SUM');
  eq(t[2].value, 'A1:B2');
  eq(t[4].value, '$C$3');
  eq(t[6].value, 1.5);
  eq(t[8].value, 'a"b');
  eq(t[10].value, true);
  eq(t[12].value, '#N/A');
  eq(t[14].value, '&');
  eq(t[15].value, 'x');
  eq(t[16].value, '<=');
  eq(t[17].value, 2);
});

test('tokenize: pos is the 0-based start offset', () => {
  const t = tokenize('SUM(A1:B2)');
  eq(t[0].pos, 0);
  eq(t[1].pos, 3);
  eq(t[2].pos, 4);
  eq(t[3].pos, 9);
});

test('tokenize: integer literal', () => {
  const t = tokenize('123');
  eq(t.length, 1);
  eq(t[0].type, 'num');
  eq(t[0].value, 123);
});

test('tokenize: decimal literal', () => eq(tokenize('1.5')[0].value, 1.5));
test('tokenize: leading-dot literal', () => eq(tokenize('.5')[0].value, 0.5));
test('tokenize: exponent literal', () => eq(tokenize('1e-3')[0].value, 0.001));

test('tokenize: doubled quotes decode to one quote', () => {
  const t = tokenize('"he""llo"');
  eq(t[0].type, 'str');
  eq(t[0].value, 'he"llo');
});

test('tokenize: empty string literal', () => {
  const t = tokenize('""');
  eq(t[0].type, 'str');
  eq(t[0].value, '');
});

test('tokenize: TRUE / FALSE are booleans', () => {
  eq(tokenize('TRUE')[0].type, 'bool');
  eq(tokenize('TRUE')[0].value, true);
  eq(tokenize('FALSE')[0].value, false);
});

test('tokenize: booleans are case-insensitive', () => {
  eq(tokenize('true')[0].type, 'bool');
  eq(tokenize('true')[0].value, true);
});

test('tokenize: TRUE followed by ( is an ident, not a bool', () => {
  eq(types('TRUE()'), ['ident', 'lparen', 'rparen']);
});

test('tokenize: error literals', () => {
  eq(tokenize('#N/A')[0].type, 'err');
  eq(tokenize('#N/A')[0].value, '#N/A');
  eq(tokenize('#DIV/0!')[0].value, '#DIV/0!');
  eq(tokenize('#REF!')[0].value, '#REF!');
});

test('tokenize: ranges win over refs', () => {
  eq(types('A1:B2'), ['range']);
  eq(types('$A$1:$B$2'), ['range']);
  eq(types('A:A'), ['range']);
  eq(types('1:3'), ['range']);
});

test('tokenize: a bare cell is a ref', () => {
  eq(types('A1'), ['ref']);
  eq(tokenize('$B$7')[0].type, 'ref');
  eq(tokenize('$B$7')[0].value, '$B$7');
});

test('tokenize: a name followed by ( stays an ident', () => {
  eq(types('LOG10(100)'), ['ident', 'lparen', 'num', 'rparen']);
});

test('tokenize: identifiers may hold digits, dots and underscores', () => {
  const t = tokenize('my_name.2');
  eq(t[0].type, 'ident');
  eq(t[0].value, 'my_name.2');
});

test('tokenize: every operator is one token', () => {
  eq(types('1+1'), ['num', 'op', 'num']);
  for (const op of ['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>', '<=', '>=']) {
    const t = tokenize('1' + op + '2');
    eq(t.length, 3, 'token count for ' + op);
    eq(t[1].type, 'op', 'type for ' + op);
    eq(t[1].value, op, 'value for ' + op);
  }
});

test('tokenize: percent is an operator token', () => {
  eq(types('50%'), ['num', 'op']);
  eq(tokenize('50%')[1].value, '%');
});

test('tokenize: whitespace between tokens is skipped', () => {
  eq(types('  1  +   2  '), ['num', 'op', 'num']);
  eq(tokenize('  1  +   2  ')[2].value, 2);
});

test('tokenize: whitespace inside a string is kept', () => {
  eq(tokenize('" a b "')[0].value, ' a b ');
});

test('tokenize: an unrecognized character throws ParseError', () => {
  eq(throwsParseError(() => tokenize('1 @ 2')), true);
  eq(throwsParseError(() => tokenize('~')), true);
});

test('tokenize: ParseError carries a position', () => {
  try {
    tokenize('1 @ 2');
  } catch (e) {
    eq(typeof e.pos, 'number');
    return;
  }
  throw new Error('expected tokenize to throw');
});

// --- parser: AST shapes ----------------------------------------------------

test('parse: number literal node', () => {
  const n = parse('123');
  eq(n.type, 'num');
  eq(n.value, 123);
});

test('parse: string literal node', () => {
  const n = parse('"hi"');
  eq(n.type, 'str');
  eq(n.value, 'hi');
});

test('parse: boolean literal node', () => {
  eq(parse('TRUE').type, 'bool');
  eq(parse('TRUE').value, true);
  eq(parse('FALSE').value, false);
});

test('parse: error literal node', () => {
  const n = parse('#N/A');
  eq(n.type, 'error');
  eq(n.value, '#N/A');
});

test('parse: ref node carries row/col/abs flags', () => {
  const n = parse('$B$3');
  eq(n.type, 'ref');
  eq(n.row, 2);
  eq(n.col, 1);
  eq(!!n.absRow, true);
  eq(!!n.absCol, true);
});

test('parse: range node carries both endpoints', () => {
  const n = parse('A1:B3');
  eq(n.type, 'range');
  eq({ row: n.s.row, col: n.s.col }, { row: 0, col: 0 });
  eq({ row: n.e.row, col: n.e.col }, { row: 2, col: 1 });
});

test('parse: call node uppercases the function name', () => {
  const n = parse('sum(A1,B1)');
  eq(n.type, 'call');
  eq(n.name, 'SUM');
  eq(n.args.length, 2);
});

test('parse: an empty argument slot becomes a blank node', () => {
  const n = parse('IF(A1,,"x")');
  eq(n.args.length, 3);
  eq(n.args[1].type, 'blank');
});

test('parse: unary node', () => {
  const n = parse('-A1');
  eq(n.type, 'unary');
  eq(n.op, '-');
  eq(n.arg.type, 'ref');
});

test('parse: postfix percent node', () => {
  const n = parse('50%');
  eq(n.type, 'postfix');
  eq(n.op, '%');
  eq(n.arg.value, 50);
});

test('parse: a call with no arguments', () => {
  const n = parse('PI()');
  eq(n.type, 'call');
  eq(n.name, 'PI');
  eq(n.args.length, 0);
});

test('parse: malformed input throws ParseError', () => {
  eq(throwsParseError(() => parse('1+')), true);
  eq(throwsParseError(() => parse('SUM(1')), true);
  eq(throwsParseError(() => parse('*3')), true);
});

// --- parser: precedence, structurally --------------------------------------

test('parse: * binds tighter than +', () => {
  const n = parse('1+2*3');
  eq(n.op, '+');
  eq(n.right.op, '*');
});

test('parse: parentheses override precedence', () => {
  const n = parse('(1+2)*3');
  eq(n.op, '*');
  eq(n.left.op, '+');
});

test('parse: ^ is left-associative', () => {
  const n = parse('2^3^2');
  eq(n.op, '^');
  eq(n.left.op, '^');
  eq(n.right.value, 2);
});

test('parse: unary minus binds tighter than ^', () => {
  const n = parse('-2^2');
  eq(n.type, 'binary');
  eq(n.op, '^');
  eq(n.left.type, 'unary');
});

test('parse: comparison sits below + -', () => {
  const n = parse('1+2<4');
  eq(n.op, '<');
  eq(n.left.op, '+');
});

test('parse: & sits below + but above comparison', () => {
  const n = parse('"a"&"b"="ab"');
  eq(n.op, '=');
  eq(n.left.op, '&');
});

test('parse: postfix % binds tighter than *', () => {
  const n = parse('2*3%');
  eq(n.op, '*');
  eq(n.right.type, 'postfix');
});

test('parse: + and - are left-associative', () => {
  const n = parse('1-2-3');
  eq(n.op, '-');
  eq(n.left.op, '-');
  eq(n.right.value, 3);
});

// --- parser: serialize -----------------------------------------------------

test('serialize: canonical spacing', () => {
  eq(serialize(parse('1 + 2')), '1+2');
  eq(serialize(parse('  A1  *  2  ')), 'A1*2');
});

test('serialize: uppercases function names', () => {
  eq(serialize(parse('sum(A1,B1)')), 'SUM(A1,B1)');
});

test('serialize: keeps ranges and $ flags', () => {
  eq(serialize(parse('SUM(A1:B2,3)')), 'SUM(A1:B2,3)');
  eq(serialize(parse('SUM($A$1:$B$2)')), 'SUM($A$1:$B$2)');
});

test('serialize: nested calls round-trip textually', () => {
  const src = 'IF(A1>0,SUM(B1:B3),MAX(C1,0))';
  eq(serialize(parse(src)), src);
});

test('serialize: strings keep their doubled quotes', () => {
  eq(serialize(parse('"he""llo"')), '"he""llo"');
  eq(serialize(parse('CONCAT("a","""")')), 'CONCAT("a","""")');
});

test('serialize: blank argument slots survive', () => {
  eq(serialize(parse('IF(A1,,"x")')), 'IF(A1,,"x")');
});

test('serialize: error literals survive', () => {
  eq(serialize(parse('#N/A')), '#N/A');
});

test('serialize(parse(x)) is idempotent and re-parses equivalently', () => {
  const samples = [
    '1+2*3',
    '(1+2)*3',
    '2^3^2',
    '-2^2',
    '1<>2',
    '"a"&"b"',
    '50%',
    'SUM(A1:A5)',
    'IF(A1>0,SUM(B1:B3),MAX(C1,0))',
    'VLOOKUP("k",$A$1:$C$9,3,FALSE)',
    'CONCAT("he""llo"," ","world")',
    'IF(A1,,"x")',
    'ROUND(AVERAGE(A1:A5)*100,2)/100',
    '-A1+B$2-$C3',
  ];
  for (const src of samples) {
    const once = serialize(parse(src));
    const twice = serialize(parse(once));
    eq(twice, once, 'not idempotent for ' + src);
  }
});

// --- parser: collectRefs / mapRefs -----------------------------------------

test('collectRefs: separates cells from ranges', () => {
  const r = collectRefs(parse('SUM(A1:B2)+C3'));
  eq(r.cells.includes('C3'), true);
  eq(r.ranges.length, 1);
});

test('collectRefs: cell keys drop the $ signs', () => {
  const r = collectRefs(parse('$C$3+1'));
  eq(r.cells, ['C3']);
});

test('collectRefs: finds refs nested inside calls', () => {
  const r = collectRefs(parse('IF(A1>0,B1,SUM(C1:C3))'));
  eq(r.cells.includes('A1'), true);
  eq(r.cells.includes('B1'), true);
  eq(r.ranges.length, 1);
});

test('collectRefs: a formula with no refs yields empty lists', () => {
  const r = collectRefs(parse('1+2'));
  eq(r.cells.length, 0);
  eq(r.ranges.length, 0);
});

test('mapRefs: offsets relative refs', () => {
  const out = mapRefs(parse('A1+B2'), (ref) => offsetRef(ref, 1, 0));
  eq(serialize(out), 'A2+B3');
});

test('mapRefs: offsets range endpoints', () => {
  const out = mapRefs(parse('SUM(A1:B2)'), (ref) => offsetRef(ref, 1, 0));
  eq(serialize(out), 'SUM(A2:B3)');
});

test('mapRefs: absolute axes are left where offsetRef leaves them', () => {
  const out = mapRefs(parse('$A$1+B1'), (ref) => offsetRef(ref, 2, 2));
  eq(serialize(out), '$A$1+D3');
});

test('mapRefs: deep-clones and leaves the source AST alone', () => {
  const src = parse('A1+1');
  mapRefs(src, (ref) => offsetRef(ref, 5, 5));
  eq(serialize(src), 'A1+1');
});

test('mapRefs: an oob range endpoint becomes a #REF! error node', () => {
  const out = mapRefs(parse('SUM(A1:B2)'), () => ({ oob: true }));
  eq(serialize(out), 'SUM(#REF!)');
});

test('mapRefs: an oob cell ref becomes #REF!', () => {
  const out = mapRefs(parse('A1+1'), () => ({ oob: true }));
  eq(serialize(out), '#REF!+1');
});

// --- values.js -------------------------------------------------------------

test('values: toNumber coerces blanks, booleans and numeric strings', () => {
  eq(toNumber(null), 0);
  eq(toNumber(true), 1);
  eq(toNumber(false), 0);
  eq(toNumber('12'), 12);
  eq(toNumber('1.5'), 1.5);
  eq(toNumber(7), 7);
});

test('values: toNumber rejects non-numeric text', () => {
  eq(code(toNumber('abc')), ERR.VALUE);
});

test('values: toNumber passes errors through', () => {
  eq(code(toNumber(err(ERR.DIV0))), ERR.DIV0);
});

test('values: toNumber on a RangeValue takes the first cell', () => {
  eq(toNumber(new RangeValue([[5, 6], [7, 8]])), 5);
});

test('values: toText', () => {
  eq(toText(null), '');
  eq(toText(true), 'TRUE');
  eq(toText(false), 'FALSE');
  eq(toText(1.5), '1.5');
  eq(toText(12), '12');
  eq(toText('x'), 'x');
});

test('values: toText passes errors through', () => {
  eq(code(toText(err(ERR.NA))), ERR.NA);
});

test('values: toBool', () => {
  eq(toBool(null), false);
  eq(toBool(0), false);
  eq(toBool(3), true);
  eq(toBool('TRUE'), true);
  eq(toBool('FALSE'), false);
  eq(toBool(true), true);
});

test('values: toBool rejects other text', () => {
  eq(code(toBool('banana')), ERR.VALUE);
});

test('values: compareValues orders numbers', () => {
  eq(compareValues(1, 2), -1);
  eq(compareValues(2, 1), 1);
  eq(compareValues(2, 2), 0);
});

test('values: compareValues compares strings case-insensitively', () => {
  eq(compareValues('a', 'A'), 0);
  eq(compareValues('a', 'b'), -1);
  eq(compareValues('b', 'a'), 1);
});

test('values: compareValues puts number < string < boolean', () => {
  eq(compareValues(999, 'a'), -1);
  eq(compareValues('a', true), -1);
  eq(compareValues(true, 999), 1);
});

test('values: equalsLoose', () => {
  eq(equalsLoose('A', 'a'), true);
  eq(equalsLoose(null, 0), true);
  eq(equalsLoose(1, 1), true);
  eq(equalsLoose('a', 'b'), false);
  eq(equalsLoose(1, 2), false);
});

test('values: RangeValue geometry', () => {
  const rv = new RangeValue([[1, 'a'], [null, 2]]);
  eq(rv.height, 2);
  eq(rv.width, 2);
  eq(rv.rows.length, 2);
});

test('values: RangeValue.flat() is row-major', () => {
  eq(new RangeValue([[1, 2], [3, 4]]).flat(), [1, 2, 3, 4]);
});

test('values: RangeValue.numbers() skips blanks, text and booleans', () => {
  eq(new RangeValue([[1, 'a'], [null, 2], [true, 3]]).numbers(), [1, 2, 3]);
});

test('values: RangeValue.firstError()', () => {
  eq(new RangeValue([[1, 2]]).firstError(), null);
  eq(code(new RangeValue([[1, err(ERR.DIV0)]]).firstError()), ERR.DIV0);
});

test('values: flattenArgs expands RangeValues in place', () => {
  eq(flattenArgs([1, new RangeValue([[2, 3]]), 4]), [1, 2, 3, 4]);
});

test('values: firstErrorIn', () => {
  eq(firstErrorIn([1, 'a', null]), null);
  eq(code(firstErrorIn([1, err(ERR.NAME), err(ERR.NA)])), ERR.NAME);
});

test('values: EPOCH_MS is 1899-12-30 UTC', () => {
  eq(EPOCH_MS, Date.UTC(1899, 11, 30));
});

test('values: dateToSerial matches the Excel epoch', () => {
  eq(dateToSerial(new Date(Date.UTC(1899, 11, 30))), 0);
  eq(dateToSerial(new Date(Date.UTC(2024, 0, 1))), 45292);
  eq(dateToSerial(new Date(Date.UTC(2024, 0, 15))), 45306);
});

test('values: dateToSerial keeps the time of day as a fraction', () => {
  close(dateToSerial(new Date(Date.UTC(2024, 0, 15, 12, 0, 0))), 45306.5, 1e-9);
});

test('values: serialToDate is the inverse of dateToSerial', () => {
  const d = serialToDate(45306);
  eq(d.getUTCFullYear(), 2024);
  eq(d.getUTCMonth(), 0);
  eq(d.getUTCDate(), 15);
  eq(dateToSerial(serialToDate(12345)), 12345);
});

// --- evaluator: operators (driven through a SheetEngine) -------------------

test('eval: 1+2*3 = 7', () => eq(v('1+2*3'), 7));
test('eval: (1+2)*3 = 9', () => eq(v('(1+2)*3'), 9));
test('eval: 2^3^2 = 64 (left-assoc)', () => eq(v('2^3^2'), 64));
test('eval: -2^2 = 4 (unary binds tighter)', () => eq(v('-2^2'), 4));
test('eval: 2^-1 = 0.5', () => close(v('2^-1'), 0.5));
test('eval: 1<2 is TRUE', () => eq(v('1<2'), true));
test('eval: 2<>2 is FALSE', () => eq(v('2<>2'), false));
test('eval: 2>=2 is TRUE', () => eq(v('2>=2'), true));
test('eval: "a"&"b" = "ab"', () => eq(v('"a"&"b"'), 'ab'));
test('eval: 50% = 0.5', () => close(v('50%'), 0.5));
test('eval: 2*3% = 0.06', () => close(v('2*3%'), 0.06, 1e-12));
test('eval: comparison sits below arithmetic', () => eq(v('1+2<4'), true));
test('eval: & sits above comparison', () => eq(v('"a"&"b"="ab"'), true));
test('eval: 10/4 = 2.5', () => eq(v('10/4'), 2.5));
test('eval: 5-8 = -3', () => eq(v('5-8'), -3));
test('eval: & coerces numbers to text', () => eq(v('1&2'), '12'));
test('eval: arithmetic coerces numeric strings', () => eq(v('"1"+1'), 2));
test('eval: arithmetic coerces booleans', () => eq(v('TRUE+1'), 2));
test('eval: "=" compares text case-insensitively', () => eq(v('"a"="A"'), true));
test('eval: division by zero is #DIV/0!', () => eq(vc('1/0'), ERR.DIV0));
test('eval: errors propagate through arithmetic', () => eq(vc('1/0+1'), ERR.DIV0));
test('eval: errors propagate through &', () => eq(vc('(1/0)&"x"'), ERR.DIV0));
test('eval: non-numeric text in arithmetic is #VALUE!', () => eq(vc('"abc"+1'), ERR.VALUE));
test('eval: a blank cell is 0 in arithmetic', () => eq(v('E1+1'), 1));
test('eval: a blank cell is "" in concatenation', () => eq(v('E1&"x"'), 'x'));
test('eval: a range used as a scalar takes its top-left cell', () => eq(v('A1:A3+0'), 1));
test('eval: an unknown function is #NAME?', () => eq(vc('NOSUCHFUNCTION(1)'), ERR.NAME));
test('eval: wrong arity is #VALUE!', () => eq(vc('ABS(1,2,3)'), ERR.VALUE));

// --- functions: math -------------------------------------------------------

test('SUM over a range', () => eq(v('SUM(A1:A5)'), 15));
test('SUM mixes ranges and scalars', () => eq(v('SUM(A1:A5,10)'), 25));
test('SUM edge: text inside a range contributes nothing', () => eq(v('SUM(C1:C5)'), 0));
test('SUM edge: blanks inside a range contribute nothing', () => eq(v('SUM(J1:J3)'), 4));
test('PRODUCT', () => eq(v('PRODUCT(A1:A4)'), 24));
test('ABS', () => {
  eq(v('ABS(-5)'), 5);
  eq(v('ABS(5)'), 5);
});
test('ROUND', () => eq(v('ROUND(3.14159,2)'), 3.14));
test('ROUND edge: halves round away from zero', () => eq(v('ROUND(2.5,0)'), 3));
test('ROUNDUP', () => close(v('ROUNDUP(1.21,1)'), 1.3, 1e-12));
test('ROUNDDOWN', () => close(v('ROUNDDOWN(1.29,1)'), 1.2, 1e-12));
test('CEILING to a multiple', () => eq(v('CEILING(7,3)'), 9));
test('FLOOR to a multiple', () => eq(v('FLOOR(7,3)'), 6));
test('INT', () => eq(v('INT(2.9)'), 2));
test('TRUNC', () => eq(v('TRUNC(2.9)'), 2));
test('MOD', () => eq(v('MOD(10,3)'), 1));
test('MOD edge: a zero divisor is #DIV/0!', () => eq(vc('MOD(5,0)'), ERR.DIV0));
test('POWER', () => eq(v('POWER(2,10)'), 1024));
test('SQRT', () => eq(v('SQRT(16)'), 4));
test('EXP', () => close(v('EXP(1)'), Math.E, 1e-12));
test('LN', () => close(v('LN(1)'), 0, 1e-12));
test('LOG with an explicit base', () => close(v('LOG(8,2)'), 3, 1e-12));
test('LOG10', () => close(v('LOG10(1000)'), 3, 1e-12));
test('SIGN', () => {
  eq(v('SIGN(-3)'), -1);
  eq(v('SIGN(0)'), 0);
  eq(v('SIGN(3)'), 1);
});
test('PI', () => close(v('PI()'), Math.PI, 1e-12));
test('RAND stays in [0,1)', () => {
  const r = v('RAND()');
  eq(typeof r, 'number');
  eq(r >= 0 && r < 1, true);
});
test('RANDBETWEEN', () => {
  eq(v('RANDBETWEEN(5,5)'), 5);
  const r = v('RANDBETWEEN(1,3)');
  eq(r >= 1 && r <= 3, true);
});
test('GCD', () => eq(v('GCD(12,18)'), 6));
test('LCM', () => eq(v('LCM(4,6)'), 12));
test('SUMPRODUCT', () => eq(v('SUMPRODUCT(A1:A3,B1:B3)'), 140));
test('SUMSQ', () => eq(v('SUMSQ(3,4)'), 25));

// --- functions: statistics -------------------------------------------------

test('AVERAGE', () => eq(v('AVERAGE(A1:A5)'), 3));
test('AVERAGE edge: no numbers in range is #DIV/0!', () => eq(vc('AVERAGE(C1:C5)'), ERR.DIV0));
test('AVERAGE edge: blanks are not counted', () => eq(v('AVERAGE(J1:J3)'), 2));
test('AVERAGEA', () => eq(v('AVERAGEA(A1:A5)'), 3));
test('MEDIAN odd count', () => eq(v('MEDIAN(A1:A5)'), 3));
test('MEDIAN even count', () => eq(v('MEDIAN(1,2,3,4)'), 2.5));
test('MIN', () => eq(v('MIN(A1:A5)'), 1));
test('MAX', () => eq(v('MAX(A1:A5)'), 5));
test('COUNT counts numbers only', () => {
  eq(v('COUNT(A1:A5)'), 5);
  eq(v('COUNT(C1:C5)'), 0);
});
test('COUNTA counts non-empty cells', () => {
  eq(v('COUNTA(C1:C5)'), 5);
  eq(v('COUNTA(J1:J3)'), 2);
});
test('COUNTBLANK', () => eq(v('COUNTBLANK(J1:J3)'), 1));
test('COUNTIF with a comparison criterion', () => eq(v('COUNTIF(A1:A5,">2")'), 3));
test('COUNTIF edge: * wildcard on text', () => eq(v('COUNTIF(C1:C5,"a*")'), 1));
test('COUNTIF edge: plain equality criterion', () => eq(v('COUNTIF(A1:A5,3)'), 1));
test('COUNTIFS across two ranges', () => eq(v('COUNTIFS(A1:A5,">1",B1:B5,"<50")'), 3));
test('SUMIF with a sum_range', () => eq(v('SUMIF(A1:A5,">2",B1:B5)'), 120));
test('SUMIF edge: two-argument form sums the tested range', () => eq(v('SUMIF(A1:A5,">2")'), 12));
test('SUMIF edge: wildcard criterion picks the matching row', () => eq(v('SUMIF(C1:C5,"a*",A1:A5)'), 1));
test('SUMIFS', () => eq(v('SUMIFS(B1:B5,A1:A5,">=3")'), 120));
test('AVERAGEIF', () => eq(v('AVERAGEIF(A1:A5,">3")'), 4.5));
test('AVERAGEIFS', () => eq(v('AVERAGEIFS(B1:B5,A1:A5,">3")'), 45));
test('STDEV (sample)', () => close(v('STDEV(A1:A5)'), Math.sqrt(2.5), 1e-9));
test('STDEVP (population)', () => close(v('STDEVP(A1:A5)'), Math.sqrt(2), 1e-9));
test('VAR (sample)', () => close(v('VAR(A1:A5)'), 2.5, 1e-9));
test('VARP (population)', () => close(v('VARP(A1:A5)'), 2, 1e-9));
test('LARGE', () => {
  eq(v('LARGE(A1:A5,1)'), 5);
  eq(v('LARGE(A1:A5,2)'), 4);
});
test('SMALL', () => {
  eq(v('SMALL(A1:A5,1)'), 1);
  eq(v('SMALL(A1:A5,2)'), 2);
});
test('RANK defaults to descending', () => eq(v('RANK(4,A1:A5)'), 2));
test('MODE', () => eq(v('MODE(1,2,2,3)'), 2));

// --- functions: logic ------------------------------------------------------

test('IF picks a branch', () => {
  eq(v('IF(TRUE,1,2)'), 1);
  eq(v('IF(FALSE,1,2)'), 2);
});
test('IF edge: the untaken branch is never evaluated', () => eq(v('IF(TRUE,1,1/0)'), 1));
test('IF over a comparison', () => eq(v('IF(A1<A2,"less","more")'), 'less'));
test('IFS returns the first matching branch', () => eq(v('IFS(FALSE,1,TRUE,2)'), 2));
test('AND', () => {
  eq(v('AND(TRUE,1<2)'), true);
  eq(v('AND(TRUE,FALSE)'), false);
});
test('OR', () => {
  eq(v('OR(FALSE,TRUE)'), true);
  eq(v('OR(FALSE,FALSE)'), false);
});
test('NOT', () => {
  eq(v('NOT(FALSE)'), true);
  eq(v('NOT(TRUE)'), false);
});
test('XOR', () => {
  eq(v('XOR(TRUE,FALSE)'), true);
  eq(v('XOR(TRUE,TRUE)'), false);
});
test('TRUE() and FALSE()', () => {
  eq(v('TRUE()'), true);
  eq(v('FALSE()'), false);
});
test('IFERROR swaps an error for the fallback', () => eq(v('IFERROR(1/0,"x")'), 'x'));
test('IFERROR edge: a clean value passes straight through', () => eq(v('IFERROR(5,"x")'), 5));
test('IFNA catches #N/A', () => eq(v('IFNA(NA(),"n")'), 'n'));
test('IFNA lets other errors through', () => eq(vc('IFNA(1/0,"n")'), ERR.DIV0));
test('SWITCH matches a case', () => eq(v('SWITCH(2,1,"a",2,"b","z")'), 'b'));
test('SWITCH falls back to the default', () => eq(v('SWITCH(9,1,"a","z")'), 'z'));

// --- functions: text -------------------------------------------------------

test('CONCAT', () => eq(v('CONCAT("a","b")'), 'ab'));
test('CONCAT edge: numbers and booleans are coerced to text', () => eq(v('CONCAT("a",1,TRUE)'), 'a1TRUE'));
test('CONCATENATE', () => eq(v('CONCATENATE("한","글")'), '한글'));
test('TEXTJOIN with a delimiter', () => eq(v('TEXTJOIN("-",TRUE,"a","b")'), 'a-b'));
test('TEXTJOIN skips blanks when asked', () => eq(v('TEXTJOIN(",",TRUE,"a",E1,"b")'), 'a,b'));
test('LEN', () => {
  eq(v('LEN("hello")'), 5);
  eq(v('LEN("")'), 0);
});
test('LEFT', () => eq(v('LEFT("hello",2)'), 'he'));
test('RIGHT', () => eq(v('RIGHT("hello",2)'), 'lo'));
test('MID', () => eq(v('MID("hello",2,3)'), 'ell'));
test('UPPER', () => eq(v('UPPER("abc")'), 'ABC'));
test('LOWER', () => eq(v('LOWER("ABC")'), 'abc'));
test('PROPER', () => eq(v('PROPER("hello world")'), 'Hello World'));
test('TRIM', () => eq(v('TRIM("  abc  ")'), 'abc'));
test('SUBSTITUTE replaces every occurrence', () => eq(v('SUBSTITUTE("a-b-c","-","+")'), 'a+b+c'));
test('REPLACE replaces by position', () => eq(v('REPLACE("abcdef",2,3,"X")'), 'aXef'));
test('FIND is 1-based', () => eq(v('FIND("b","abc")'), 2));
test('SEARCH is case-insensitive', () => eq(v('SEARCH("B","abc")'), 2));
test('REPT', () => eq(v('REPT("ab",3)'), 'ababab'));
test('VALUE parses a numeric string', () => eq(v('VALUE("123")'), 123));
test('EXACT is case-sensitive', () => {
  eq(v('EXACT("a","A")'), false);
  eq(v('EXACT("a","a")'), true);
});
test('CHAR', () => eq(v('CHAR(65)'), 'A'));
test('CODE', () => eq(v('CODE("A")'), 65));
test('TEXT with a thousands format', () => eq(v('TEXT(1234.5,"#,##0.00")'), '1,234.50'));
test('TEXT edge: percent format', () => eq(v('TEXT(0.5,"0%")'), '50%'));
test('TEXT edge: date format', () => eq(v('TEXT(DATE(2024,1,15),"yyyy-mm-dd")'), '2024-01-15'));
test('TEXT edge: mm/dd/yyyy format', () => eq(v('TEXT(DATE(2024,1,15),"mm/dd/yyyy")'), '01/15/2024'));
test('TEXT with a plain integer format', () => eq(v('TEXT(7,"0")'), '7'));

// --- functions: lookup -----------------------------------------------------

test('VLOOKUP exact match', () => eq(v('VLOOKUP(20,F1:G4,2,FALSE)'), 'twenty'));
test('VLOOKUP edge: no exact match is #N/A', () => eq(vc('VLOOKUP(25,F1:G4,2,FALSE)'), ERR.NA));
test('VLOOKUP approximate match falls back to the largest smaller key', () => {
  eq(v('VLOOKUP(25,F1:G4,2,TRUE)'), 'twenty');
});
test('HLOOKUP exact match', () => eq(v('HLOOKUP(2,K1:M2,2,FALSE)'), 'two'));
test('INDEX into a single column', () => eq(v('INDEX(A1:A5,3)'), 3));
test('INDEX edge: row and column into a 2D range', () => eq(v('INDEX(F1:G4,2,2)'), 'twenty'));
test('MATCH exact', () => eq(v('MATCH(30,F1:F4,0)'), 3));
test('MATCH edge: no match is #N/A', () => eq(vc('MATCH("nope",F1:F4,0)'), ERR.NA));
test('MATCH approximate on sorted data', () => eq(v('MATCH(35,F1:F4,1)'), 3));
test('CHOOSE', () => eq(v('CHOOSE(2,"a","b","c")'), 'b'));
test('ROW()/COLUMN() report the containing cell', () => {
  const e = new SheetEngine({ rows: 50, cols: 10 });
  e.setInput('C7', '=ROW()');
  e.setInput('D9', '=COLUMN()');
  eq(e.getValue('C7'), 7);
  eq(e.getValue('D9'), 4);
});
test('ROW(ref)/COLUMN(ref) report the referenced cell', () => {
  eq(v('ROW(B3)'), 3);
  eq(v('COLUMN(C1)'), 3);
});
test('ROWS / COLUMNS measure a range', () => {
  eq(v('ROWS(A1:A5)'), 5);
  eq(v('COLUMNS(A1:C1)'), 3);
});
test('OFFSET moves down a column', () => eq(v('OFFSET(A1,2,0)'), 3));
test('OFFSET moves across a row', () => eq(v('OFFSET(A1,0,1)'), 10));
test('INDIRECT resolves a literal address', () => eq(v('INDIRECT("A2")'), 2));
test('INDIRECT resolves a built-up address', () => eq(v('INDIRECT("B"&2)'), 20));

// --- functions: date -------------------------------------------------------

test('TODAY returns a whole date serial', () => {
  const t = v('TODAY()');
  eq(typeof t, 'number');
  eq(Number.isInteger(t), true);
  eq(t > 40000, true);
});
test('NOW returns a serial at or after TODAY', () => {
  const now = v('NOW()');
  const today = v('TODAY()');
  eq(typeof now, 'number');
  eq(now >= today, true);
  eq(now < today + 1.0001, true);
});
test('DATE builds the documented serial', () => eq(v('DATE(2024,1,15)'), 45306));
test('DATE edge: a 13th month rolls into the next year', () => eq(v('YEAR(DATE(2024,13,1))'), 2025));
test('YEAR / MONTH / DAY', () => {
  eq(v('YEAR(DATE(2024,1,15))'), 2024);
  eq(v('MONTH(DATE(2024,1,15))'), 1);
  eq(v('DAY(DATE(2024,1,15))'), 15);
});
test('HOUR of a half-day serial', () => eq(v('HOUR(0.5)'), 12));
test('MINUTE', () => eq(v('MINUTE(TIME(1,30,0))'), 30));
test('SECOND', () => eq(v('SECOND(TIME(0,11,15))'), 15));
test('TIME is a day fraction', () => close(v('TIME(1,30,0)'), 0.0625, 1e-12));
test('WEEKDAY (2024-01-15 is a Monday)', () => eq(v('WEEKDAY(DATE(2024,1,15))'), 2));
test('DAYS', () => eq(v('DAYS(DATE(2024,1,31),DATE(2024,1,1))'), 30));
test('EDATE clamps to the end of a shorter month', () => {
  eq(v('DAY(EDATE(DATE(2024,1,31),1))'), 29);
  eq(v('MONTH(EDATE(DATE(2024,1,31),1))'), 2);
});
test('EOMONTH finds the last day of a month', () => {
  eq(v('DAY(EOMONTH(DATE(2024,2,10),0))'), 29);
  eq(v('MONTH(EOMONTH(DATE(2024,2,10),0))'), 2);
});
test('DATEDIF in years, months and days', () => {
  eq(v('DATEDIF(DATE(2024,1,1),DATE(2025,3,1),"Y")'), 1);
  eq(v('DATEDIF(DATE(2024,1,1),DATE(2025,3,1),"M")'), 14);
  eq(v('DATEDIF(DATE(2024,1,1),DATE(2025,3,1),"D")'), 425);
});

// --- functions: info -------------------------------------------------------

test('ISBLANK', () => {
  eq(v('ISBLANK(E1)'), true);
  eq(v('ISBLANK(A1)'), false);
});
test('ISNUMBER', () => {
  eq(v('ISNUMBER(A1)'), true);
  eq(v('ISNUMBER(C1)'), false);
});
test('ISTEXT', () => {
  eq(v('ISTEXT(C1)'), true);
  eq(v('ISTEXT(A1)'), false);
});
test('ISERROR catches every error, #N/A included', () => {
  eq(v('ISERROR(1/0)'), true);
  eq(v('ISERROR(NA())'), true);
  eq(v('ISERROR(1)'), false);
});
test('ISERR ignores #N/A', () => {
  eq(v('ISERR(1/0)'), true);
  eq(v('ISERR(NA())'), false);
});
test('ISNA', () => {
  eq(v('ISNA(NA())'), true);
  eq(v('ISNA(1/0)'), false);
});
test('ISLOGICAL', () => {
  eq(v('ISLOGICAL(D1)'), true);
  eq(v('ISLOGICAL(A1)'), false);
});
test('NA produces the #N/A value', () => eq(vc('NA()'), ERR.NA));
test('TYPE', () => {
  eq(v('TYPE(1)'), 1);
  eq(v('TYPE("a")'), 2);
  eq(v('TYPE(TRUE)'), 4);
});

// --- functions: registry and criteria --------------------------------------

test('getFunction looks names up case-insensitively', () => {
  const def = getFunction('sum');
  eq(!!def, true);
  eq(typeof def.fn, 'function');
  eq(typeof def.minArgs, 'number');
});

test('getFunction returns undefined for unknown names', () => {
  eq(getFunction('NOSUCHFUNCTION'), undefined);
});

test('getFunction exposes the volatile flag on volatile functions', () => {
  eq(!!getFunction('RAND').volatile, true);
  eq(!!getFunction('NOW').volatile, true);
  eq(!!getFunction('TODAY').volatile, true);
  eq(!!getFunction('OFFSET').volatile, true);
  eq(!!getFunction('INDIRECT').volatile, true);
  eq(!!getFunction('RANDBETWEEN').volatile, true);
});

test('getFunction marks the lazy functions lazy', () => {
  for (const name of ['IF', 'IFS', 'AND', 'OR', 'IFERROR', 'IFNA', 'SWITCH', 'CHOOSE', 'INDIRECT', 'OFFSET']) {
    eq(!!getFunction(name).lazy, true, name + ' must be lazy');
  }
});

test('every required function is registered', () => {
  const required = (
    'SUM PRODUCT ABS ROUND ROUNDUP ROUNDDOWN CEILING FLOOR INT TRUNC MOD POWER SQRT EXP LN LOG ' +
    'LOG10 SIGN PI RAND RANDBETWEEN GCD LCM SUMPRODUCT SUMSQ ' +
    'AVERAGE AVERAGEA MEDIAN MIN MAX COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS SUMIF SUMIFS ' +
    'AVERAGEIF AVERAGEIFS STDEV STDEVP VAR VARP LARGE SMALL RANK MODE ' +
    'IF IFS AND OR NOT XOR TRUE FALSE IFERROR IFNA SWITCH ' +
    'CONCAT CONCATENATE TEXTJOIN LEN LEFT RIGHT MID UPPER LOWER PROPER TRIM SUBSTITUTE REPLACE ' +
    'FIND SEARCH REPT VALUE EXACT CHAR CODE TEXT ' +
    'VLOOKUP HLOOKUP INDEX MATCH CHOOSE ROW COLUMN ROWS COLUMNS OFFSET INDIRECT ' +
    'TODAY NOW DATE YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY DAYS EDATE EOMONTH DATEDIF TIME ' +
    'ISBLANK ISNUMBER ISTEXT ISERROR ISERR ISNA ISLOGICAL NA TYPE'
  ).split(' ');
  const missing = required.filter((n) => !getFunction(n));
  eq(missing, []);
});

test('matchesCriteria: comparison operators', () => {
  eq(matchesCriteria(5, '>3'), true);
  eq(matchesCriteria(2, '>3'), false);
  eq(matchesCriteria(3, '<=3'), true);
  eq(matchesCriteria(4, '<=3'), false);
});

test('matchesCriteria: equality forms', () => {
  eq(matchesCriteria(3, 3), true);
  eq(matchesCriteria(3, '=3'), true);
  eq(matchesCriteria('x', '=x'), true);
  eq(matchesCriteria('x', 'x'), true);
  eq(matchesCriteria('y', 'x'), false);
});

test('matchesCriteria: inequality', () => {
  eq(matchesCriteria('y', '<>x'), true);
  eq(matchesCriteria('x', '<>x'), false);
});

test('matchesCriteria: wildcards', () => {
  eq(matchesCriteria('apple', 'a*'), true);
  eq(matchesCriteria('banana', 'a*'), false);
  eq(matchesCriteria('cat', '?at'), true);
  eq(matchesCriteria('coat', '?at'), false);
});
