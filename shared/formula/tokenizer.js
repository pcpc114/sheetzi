// shared/formula/tokenizer.js
// Lexer for the 시트지 formula language.
// Input: formula source WITHOUT the leading '='.  Output: Token[].
// Pure ESM. Must run identically in Node and in the browser:
// no Node builtins, no npm imports, no window/document.

/**
 * ParseError is defined HERE (not in errors.js) so that tokenizer.js and parser.js
 * never form an import cycle; parser.js re-exports it.
 * It is a real Error subclass because parse failures are *thrown*, unlike FormulaError
 * which is a value stored in a cell.
 */
export class ParseError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = 'ParseError';
    // 0-based index into the source string where the problem starts (-1 if unknown).
    this.pos = Number.isInteger(pos) ? pos : -1;
  }
}

// Literal error tokens. Ordered longest-first so that a literal sharing a prefix with
// another one ('#NAME?' vs '#N/A') still matches the longest candidate.
const ERROR_LITERALS = [
  '#DIV/0!',
  '#VALUE!',
  '#ERROR!',
  '#CYCLE!',
  '#NAME?',
  '#NUM!',
  '#REF!',
  '#N/A',
];

// Sticky patterns; lastIndex is assigned before every use (see matchAt).
// Ranges must be attempted BEFORE a bare ref so 'A1:B2' never lexes as ref ':' ref.
const RE_RANGE_CELL = /\$?[A-Za-z]{1,2}\$?\d{1,7}:\$?[A-Za-z]{1,2}\$?\d{1,7}/y; // A1:B2, $A$1:$B$2
const RE_RANGE_COL = /\$?[A-Za-z]{1,2}:\$?[A-Za-z]{1,2}/y;                      // A:A, $B:$D
const RE_RANGE_ROW = /\$?\d{1,7}:\$?\d{1,7}/y;                                  // 1:3, $2:$9
const RE_REF = /\$?[A-Za-z]{1,2}\$?\d{1,7}/y;                                   // A1, $B$7
const RE_NUM = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;                     // 123, 1.5, .5, 1e-3
const RE_IDENT = /[A-Za-z_][A-Za-z0-9_.]*/y;                                    // SUM, my.name_2

// A bare sheet qualifier: letters, digits, '_' and Hangul, never starting with a digit.
// This character class mirrors isBareSheetName() in refs.js; keep the two in step. The
// tokenizer keeps its own copy so the lexer stays free of imports. The Hangul ranges are
// written as escapes so the lexer does not depend on this file's encoding.
const HANGUL_CLASS = '\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7A3\uD7B0-\uD7FF';
const RE_SHEET_BARE = new RegExp(`[A-Za-z_${HANGUL_CLASS}][A-Za-z0-9_${HANGUL_CLASS}]*`, 'y');

// First character of a bare sheet name. Hangul is included, which is why a Hangul word is
// no longer rejected outright by the main loop -- it may open a sheet qualifier.
const RE_SHEET_START = new RegExp(`[A-Za-z_${HANGUL_CLASS}]`);

// Two-character operators must be tested before the single-character ones.
const OPS2 = ['<>', '<=', '>='];
const OPS1 = ['+', '-', '*', '/', '^', '&', '%', '=', '<', '>'];

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isAlphaStart(ch) {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

// Characters that may continue a name/reference. Used as a right-boundary guard so
// that 'A1B' does not lex as ref('A1') + ident('B').
function isWordChar(ch) {
  if (ch === undefined) return false;
  return isAlphaStart(ch) || isDigit(ch) || ch === '.' || ch === '$';
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function matchAt(re, src, i) {
  re.lastIndex = i;
  const m = re.exec(src);
  return m ? m[0] : null;
}

/**
 * Try to read a sheet qualifier -- `<name>!` -- starting at `i`.
 *
 * The name is scanned left to right, NOT by splitting on the last '!': a quoted name may
 * contain '!' and spaces, so `'a!b'!A1` names the sheet `a!b`.
 *
 * @param {string} s   full source
 * @param {number} i   index of the first character of the candidate qualifier
 * @returns {{name:string, end:number}|null} the decoded name and the index just past the
 *   '!', or null when there is no qualifier here (the caller then falls through to the
 *   ordinary ref / ident / number path, exactly as before).
 * @throws {ParseError} on a quoted name that is unterminated, empty, or not followed by '!'.
 */
function scanSheetQualifier(s, i) {
  if (s[i] === "'") {
    let name = '';
    let j = i + 1;
    for (;;) {
      if (j >= s.length) {
        throw new ParseError(`시트 이름이 닫히지 않았습니다 (위치 ${i})`, i);
      }
      const ch = s[j];
      if (ch === "'") {
        if (s[j + 1] === "'") { name += "'"; j += 2; continue; } // '' is an escaped quote
        j += 1;
        break;
      }
      name += ch;
      j += 1;
    }
    if (name === '') {
      throw new ParseError(`시트 이름이 비어 있습니다 (위치 ${i})`, i);
    }
    if (s[j] !== '!') {
      throw new ParseError(`시트 이름 뒤에는 '!'가 필요합니다 (위치 ${j})`, j);
    }
    return { name, end: j + 1 };
  }

  const word = matchAt(RE_SHEET_BARE, s, i);
  if (word === null) return null;
  // Only a following '!' makes this a qualifier; otherwise it is an ordinary ref or name.
  if (s[i + word.length] !== '!') return null;
  return { name: word, end: i + word.length + 1 };
}

/**
 * Match the reference that must follow a sheet qualifier. Ranges are tried before a single
 * cell, exactly as in the unqualified path. The "not followed by '('" guard is deliberately
 * absent: a qualified name can never be a function call.
 *
 * @param {string} s full source
 * @param {number} i index just past the '!'
 * @returns {{type:'range'|'ref', len:number}|null} what was matched, or null.
 */
function matchQualifiedTarget(s, i) {
  const rc = matchAt(RE_RANGE_CELL, s, i);
  if (rc !== null && !isWordChar(s[i + rc.length])) return { type: 'range', len: rc.length };
  const rcol = matchAt(RE_RANGE_COL, s, i);
  if (rcol !== null && !isWordChar(s[i + rcol.length])) return { type: 'range', len: rcol.length };
  const rrow = matchAt(RE_RANGE_ROW, s, i);
  if (rrow !== null && !isWordChar(s[i + rrow.length])) return { type: 'range', len: rrow.length };
  const ref = matchAt(RE_REF, s, i);
  if (ref !== null && !isWordChar(s[i + ref.length])) return { type: 'ref', len: ref.length };
  return null;
}

/**
 * tokenize(src) -> Token[] where Token = { type, value, pos }.
 * type is exactly one of:
 *   'num' | 'str' | 'bool' | 'err' | 'range' | 'ref' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma'
 * A 'ref' or 'range' token may carry a sheet qualifier, which is part of its value:
 * '시트2!A1', "'매출 집계'!A1:B10". Throws ParseError on an unrecognized character, an
 * unterminated string literal or a malformed sheet qualifier.
 */
export function tokenize(src) {
  const s = src === undefined || src === null ? '' : String(src);
  const n = s.length;
  const tokens = [];
  let i = 0;

  while (i < n) {
    const c = s[i];

    if (isSpace(c)) {
      i += 1;
      continue;
    }

    // --- string literal, with doubled quotes as the escape ------------------
    if (c === '"') {
      const start = i;
      let out = '';
      i += 1;
      for (;;) {
        if (i >= n) {
          throw new ParseError(`문자열이 닫히지 않았습니다 (위치 ${start})`, start);
        }
        const ch = s[i];
        if (ch === '"') {
          if (s[i + 1] === '"') { out += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        out += ch;
        i += 1;
      }
      tokens.push({ type: 'str', value: out, pos: start });
      continue;
    }

    // --- literal error token: #N/A, #DIV/0!, ... ---------------------------
    if (c === '#') {
      const head = s.slice(i, i + 8).toUpperCase();
      let lit = null;
      for (let k = 0; k < ERROR_LITERALS.length; k += 1) {
        if (head.startsWith(ERROR_LITERALS[k])) { lit = ERROR_LITERALS[k]; break; }
      }
      if (lit === null) {
        throw new ParseError(`알 수 없는 오류 리터럴입니다 (위치 ${i})`, i);
      }
      tokens.push({ type: 'err', value: lit, pos: i });
      i += lit.length;
      continue;
    }

    // --- sheet-qualified reference: 시트2!A1, '매출 집계'!A1:B10 ----------------
    // Tried first because a qualifier may start with characters (Hangul, a quote) that the
    // block below rejects outright. When there is no '!' this returns null and the ordinary
    // path runs unchanged, so an unqualified formula lexes exactly as it always did.
    if (c === "'" || RE_SHEET_START.test(c)) {
      const q = scanSheetQualifier(s, i);
      if (q !== null) {
        const target = matchQualifiedTarget(s, q.end);
        if (target === null) {
          throw new ParseError(`시트 참조 뒤에 셀 또는 범위가 필요합니다 (위치 ${q.end})`, q.end);
        }
        const end = q.end + target.len;
        // value keeps the raw text, qualifier included; refs.js splits it again.
        tokens.push({ type: target.type, value: s.slice(i, end), pos: i });
        i = end;
        continue;
      }
    }

    // --- range / ref / bool / ident / number --------------------------------
    const alpha = isAlphaStart(c);
    if (alpha || c === '$' || isDigit(c)) {
      // 1) ranges, longest form first
      const rc = matchAt(RE_RANGE_CELL, s, i);
      if (rc !== null && !isWordChar(s[i + rc.length])) {
        tokens.push({ type: 'range', value: rc, pos: i });
        i += rc.length;
        continue;
      }
      const rcol = matchAt(RE_RANGE_COL, s, i);
      if (rcol !== null && !isWordChar(s[i + rcol.length])) {
        tokens.push({ type: 'range', value: rcol, pos: i });
        i += rcol.length;
        continue;
      }
      const rrow = matchAt(RE_RANGE_ROW, s, i);
      if (rrow !== null && !isWordChar(s[i + rrow.length])) {
        tokens.push({ type: 'range', value: rrow, pos: i });
        i += rrow.length;
        continue;
      }

      // 2) single-cell reference, but never when it is immediately followed by '('
      //    -- a name in front of '(' is a function call, which the parser decides.
      const ref = matchAt(RE_REF, s, i);
      if (ref !== null && !isWordChar(s[i + ref.length]) && s[i + ref.length] !== '(') {
        tokens.push({ type: 'ref', value: ref, pos: i });
        i += ref.length;
        continue;
      }

      // 3) bare name: TRUE/FALSE become booleans unless a '(' follows.
      if (alpha) {
        const word = matchAt(RE_IDENT, s, i);
        const upper = word.toUpperCase();
        if ((upper === 'TRUE' || upper === 'FALSE') && s[i + word.length] !== '(') {
          tokens.push({ type: 'bool', value: upper === 'TRUE', pos: i });
        } else {
          tokens.push({ type: 'ident', value: word, pos: i });
        }
        i += word.length;
        continue;
      }

      // 4) number
      if (isDigit(c)) {
        const num = matchAt(RE_NUM, s, i);
        if (num !== null) {
          tokens.push({ type: 'num', value: Number(num), pos: i });
          i += num.length;
          continue;
        }
      }

      // A '$' that did not start a valid reference.
      throw new ParseError(`알 수 없는 문자입니다: '${c}' (위치 ${i})`, i);
    }

    // --- number starting with a dot: .5 ------------------------------------
    if (c === '.') {
      const num = matchAt(RE_NUM, s, i);
      if (num !== null) {
        tokens.push({ type: 'num', value: Number(num), pos: i });
        i += num.length;
        continue;
      }
      throw new ParseError(`알 수 없는 문자입니다: '${c}' (위치 ${i})`, i);
    }

    // --- punctuation --------------------------------------------------------
    if (c === '(') { tokens.push({ type: 'lparen', value: '(', pos: i }); i += 1; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: ')', pos: i }); i += 1; continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: ',', pos: i }); i += 1; continue; }

    // --- operators: two-character forms first -------------------------------
    const two = s.slice(i, i + 2);
    if (OPS2.indexOf(two) !== -1) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (OPS1.indexOf(c) !== -1) {
      tokens.push({ type: 'op', value: c, pos: i });
      i += 1;
      continue;
    }

    throw new ParseError(`알 수 없는 문자입니다: '${c}' (위치 ${i})`, i);
  }

  return tokens;
}

/* ---------------------------------------------------------------------------
   Self-check. Inert on import by design: the whole block lives inside this
   comment. To run it, uncomment the body and execute
   `node shared/formula/tokenizer.js`.

const T = (s) => tokenize(s).map((t) => t.type + ':' + String(t.value)).join(' ');
const CHECKS = [
  ['1+2', 'num:1 op:+ num:2'],
  ['.5e-3', 'num:0.0005'],
  ['"a""b"', 'str:a"b'],
  ['TRUE', 'bool:true'],
  ['true(', 'ident:true lparen:('],
  ['#DIV/0!', 'err:#DIV/0!'],
  ['#n/a', 'err:#N/A'],
  ['A1:B2', 'range:A1:B2'],
  ['$A$1:$B$2', 'range:$A$1:$B$2'],
  ['A:A', 'range:A:A'],
  ['1:3', 'range:1:3'],
  ['A1', 'ref:A1'],
  ['$B$7', 'ref:$B$7'],
  ['SUM(A1)', 'ident:SUM lparen:( ref:A1 rparen:)'],
  ['A1(', 'ident:A1 lparen:('],
  ['A1B', 'ident:A1B'],
  ['a<>b1', 'ident:a op:<> ref:b1'],
  ['1<=2', 'num:1 op:<= num:2'],
  ['1>=2', 'num:1 op:>= num:2'],
  ['5%', 'num:5 op:%'],
  ['IF(A1,,1)', 'ident:IF lparen:( ref:A1 comma:, comma:, num:1 rparen:)'],
  ['시트2!A1', 'ref:시트2!A1'],
  ['Sheet2!$A$1', 'ref:Sheet2!$A$1'],
  ["'매출 집계'!A1:B10", "range:'매출 집계'!A1:B10"],
  ["'a!b'!A1", "ref:'a!b'!A1"],          // the '!' inside quotes is part of the name
  ["'a''b'!A1", "ref:'a''b'!A1"],        // '' is an escaped quote
  ['Sheet2!A:A', 'range:Sheet2!A:A'],
  ['SUM(시트2!A1:B2)', 'ident:SUM lparen:( range:시트2!A1:B2 rparen:)'],
];
let bad = 0;
for (const [src, want] of CHECKS) {
  const got = T(src);
  if (got !== want) { bad += 1; console.log('FAIL', src, '->', got, '| want', want); }
}
for (const src of ['"abc', '@', '1 @ 2', "'abc!A1", "''!A1", 'Sheet2!', '시트2']) {
  let threw = false;
  try { tokenize(src); } catch (e) { threw = e instanceof ParseError; }
  if (!threw) { bad += 1; console.log('FAIL expected ParseError for', src); }
}
console.log(bad === 0 ? 'tokenizer self-check OK' : 'tokenizer self-check FAILED: ' + bad);

--------------------------------------------------------------------------- */
