// shared/formula/function-docs.js — one short Korean line per engine function.
//
// This module is imported by BOTH Node and the browser, therefore:
//   - pure ESM, explicit .js extensions in every import specifier
//   - no Node builtin (fs / path / crypto / ...)
//   - no browser global (window / document)
//   - no npm dependency
// It imports NOTHING at all: it is a flat data map, so it can never drag a runtime-
// specific dependency into whatever loads it, and the 함수 도우미 (SPEC section 23.5) can
// pull it in from the toolbar without touching the engine.
//
// The list of NAMES belongs to `shared/formula/functions.js` — the 함수 도우미 builds its
// menu by iterating the engine's own FUNCTIONS table, so what the user sees can never
// drift from what the parser accepts. This file only supplies the prose: a name with no
// entry here still lists, with its name alone (that is what `docFor` returning '' means).
// Every one of the 114 functions the engine ships today does have an entry, in the same
// order the FUNCTIONS table declares them.
//
// House style for the descriptions, since these are read by people who do not program:
//   - one line, plain Korean, no formula syntax and no English jargon
//   - say what it DOES, not how it is implemented
//   - where the argument shape is the whole point (VLOOKUP, TEXTJOIN, DATEDIF), say it
//   - 칸 = cell, 범위 = range, 값 = value

/**
 * Function name (uppercase, exactly as the engine spells it) -> one-line Korean description.
 *
 * Frozen because it is shared, read-only reference data: a stray write from the UI must
 * not be able to rewrite what every other viewer is shown.
 *
 * @type {Readonly<Object<string,string>>}
 */
export const FUNCTION_DOCS = Object.freeze({
  // --- 수학 ---
  SUM: '범위나 숫자들을 모두 더한 합계를 구합니다',
  PRODUCT: '숫자들을 모두 곱한 값을 구합니다',
  ABS: '부호를 뗀 절댓값을 구합니다',
  ROUND: '지정한 자릿수에서 반올림합니다',
  ROUNDUP: '지정한 자릿수에서 무조건 올림합니다',
  ROUNDDOWN: '지정한 자릿수에서 무조건 내림합니다',
  CEILING: '기준이 되는 값의 배수로 올림합니다',
  FLOOR: '기준이 되는 값의 배수로 내림합니다',
  INT: '소수점 아래를 버리고 더 작은 정수로 내립니다',
  TRUNC: '반올림하지 않고 소수점 아래를 잘라냅니다',
  MOD: '나눗셈을 하고 남은 나머지를 구합니다',
  POWER: '숫자를 지정한 횟수만큼 거듭제곱합니다',
  SQRT: '제곱근(루트) 값을 구합니다',
  EXP: '자연상수 e를 지정한 만큼 거듭제곱합니다',
  LN: '밑이 e인 자연로그 값을 구합니다',
  LOG: '지정한 밑의 로그 값을 구합니다(밑을 생략하면 10)',
  LOG10: '밑이 10인 상용로그 값을 구합니다',
  SIGN: '양수면 1, 0이면 0, 음수면 -1을 돌려줍니다',
  PI: '원주율 3.141592...를 돌려줍니다',
  RAND: '0 이상 1 미만의 무작위 숫자를 만듭니다',
  RANDBETWEEN: '지정한 두 정수 사이의 무작위 정수를 만듭니다',
  GCD: '숫자들의 최대공약수를 구합니다',
  LCM: '숫자들의 최소공배수를 구합니다',
  SUMPRODUCT: '두 범위를 같은 자리끼리 곱한 뒤 모두 더합니다',
  SUMSQ: '숫자들을 각각 제곱해서 더합니다',

  // --- 통계 ---
  AVERAGE: '숫자들의 평균을 구합니다',
  AVERAGEA: '글자와 논리값까지 0이나 1로 세어 평균을 구합니다',
  MEDIAN: '크기순으로 늘어놓았을 때 한가운데 오는 값을 구합니다',
  MIN: '가장 작은 값을 찾습니다',
  MAX: '가장 큰 값을 찾습니다',
  COUNT: '숫자가 들어 있는 칸이 몇 개인지 셉니다',
  COUNTA: '비어 있지 않은 칸이 몇 개인지 셉니다',
  COUNTBLANK: '비어 있는 칸이 몇 개인지 셉니다',
  COUNTIF: '조건에 맞는 칸이 몇 개인지 셉니다',
  COUNTIFS: '여러 조건을 모두 만족하는 칸이 몇 개인지 셉니다',
  SUMIF: '조건에 맞는 칸의 값만 골라 더합니다',
  SUMIFS: '여러 조건을 모두 만족하는 칸의 값만 골라 더합니다',
  AVERAGEIF: '조건에 맞는 칸의 값만 골라 평균을 구합니다',
  AVERAGEIFS: '여러 조건을 모두 만족하는 칸의 평균을 구합니다',
  STDEV: '표본 자료의 표준편차를 구합니다',
  STDEVP: '전체 자료의 표준편차를 구합니다',
  VAR: '표본 자료의 분산을 구합니다',
  VARP: '전체 자료의 분산을 구합니다',
  LARGE: '큰 쪽에서 몇 번째인 값을 찾습니다',
  SMALL: '작은 쪽에서 몇 번째인 값을 찾습니다',
  RANK: '값이 범위 안에서 몇 등인지 구합니다',
  MODE: '가장 자주 나오는 값을 찾습니다',

  // --- 논리 ---
  IF: '조건이 참이면 앞의 값을, 거짓이면 뒤의 값을 돌려줍니다',
  IFS: '여러 조건을 차례로 살펴 처음 맞는 조건의 값을 돌려줍니다',
  AND: '조건이 모두 참일 때만 TRUE가 됩니다',
  OR: '조건 중 하나라도 참이면 TRUE가 됩니다',
  NOT: '참과 거짓을 서로 뒤집습니다',
  XOR: '참인 조건의 개수가 홀수일 때 TRUE가 됩니다',
  TRUE: '논리값 참(TRUE)을 돌려줍니다',
  FALSE: '논리값 거짓(FALSE)을 돌려줍니다',
  IFERROR: '값이 오류이면 대신 정해 둔 값을 보여줍니다',
  IFNA: '값이 #N/A 오류일 때만 대신 정해 둔 값을 보여줍니다',
  SWITCH: '값을 여러 경우와 차례로 견주어 맞는 결과를 돌려줍니다',

  // --- 텍스트 ---
  CONCAT: '여러 값을 하나의 글자로 이어 붙입니다',
  CONCATENATE: '여러 값을 하나의 글자로 이어 붙입니다(CONCAT과 같습니다)',
  TEXTJOIN: '값 사이에 구분 기호를 끼워 넣어 이어 붙입니다',
  LEN: '글자가 몇 자인지 셉니다',
  LEFT: '왼쪽에서부터 지정한 개수만큼 글자를 잘라냅니다',
  RIGHT: '오른쪽에서부터 지정한 개수만큼 글자를 잘라냅니다',
  MID: '지정한 위치부터 원하는 개수만큼 글자를 잘라냅니다',
  UPPER: '영문을 모두 대문자로 바꿉니다',
  LOWER: '영문을 모두 소문자로 바꿉니다',
  PROPER: '낱말마다 첫 글자만 대문자로 바꿉니다',
  TRIM: '앞뒤 공백을 없애고 사이의 공백은 하나로 줄입니다',
  SUBSTITUTE: '글자 안에서 찾은 말을 다른 말로 바꿉니다',
  REPLACE: '지정한 위치의 글자를 다른 글자로 바꿉니다',
  FIND: '찾는 글자가 몇 번째에 있는지 알려줍니다(대소문자를 구분합니다)',
  SEARCH: '찾는 글자가 몇 번째에 있는지 알려줍니다(대소문자를 구분하지 않습니다)',
  REPT: '같은 글자를 지정한 횟수만큼 반복합니다',
  VALUE: '숫자처럼 적힌 글자를 진짜 숫자로 바꿉니다',
  EXACT: '두 글자가 똑같은지 확인합니다(대소문자를 구분합니다)',
  CHAR: '문자 코드 번호에 해당하는 글자를 돌려줍니다',
  CODE: '첫 글자의 문자 코드 번호를 돌려줍니다',
  TEXT: '숫자나 날짜를 원하는 표시 형식의 글자로 바꿉니다',

  // --- 찾기와 참조 ---
  VLOOKUP: '세로로 찾아 같은 행의 다른 열 값을 돌려줍니다',
  HLOOKUP: '가로로 찾아 같은 열의 다른 행 값을 돌려줍니다',
  INDEX: '범위에서 몇 번째 행, 몇 번째 열에 있는 값을 꺼냅니다',
  MATCH: '찾는 값이 범위에서 몇 번째에 있는지 알려줍니다',
  CHOOSE: '번호에 해당하는 값을 골라 돌려줍니다',
  ROW: '칸의 행 번호를 알려줍니다',
  COLUMN: '칸의 열 번호를 알려줍니다',
  ROWS: '범위가 몇 행인지 알려줍니다',
  COLUMNS: '범위가 몇 열인지 알려줍니다',
  OFFSET: '기준 칸에서 지정한 만큼 떨어진 칸이나 범위를 가리킵니다',
  INDIRECT: '글자로 적어 둔 주소를 실제 참조로 바꿉니다',

  // --- 날짜와 시간 ---
  TODAY: '오늘 날짜를 돌려줍니다',
  NOW: '오늘 날짜와 지금 시각을 함께 돌려줍니다',
  DATE: '연, 월, 일 숫자를 모아 하나의 날짜로 만듭니다',
  YEAR: '날짜에서 연도만 꺼냅니다',
  MONTH: '날짜에서 월만 꺼냅니다',
  DAY: '날짜에서 일만 꺼냅니다',
  HOUR: '시각에서 시만 꺼냅니다',
  MINUTE: '시각에서 분만 꺼냅니다',
  SECOND: '시각에서 초만 꺼냅니다',
  WEEKDAY: '날짜가 무슨 요일인지 번호로 알려줍니다',
  DAYS: '두 날짜 사이가 며칠인지 구합니다',
  EDATE: '몇 개월 앞이나 뒤의 같은 날짜를 구합니다',
  EOMONTH: '몇 개월 앞이나 뒤에 있는 달의 마지막 날을 구합니다',
  DATEDIF: '두 날짜의 차이를 연, 월, 일 중 원하는 단위로 구합니다',
  TIME: '시, 분, 초 숫자를 모아 하나의 시각으로 만듭니다',

  // --- 정보 ---
  ISBLANK: '칸이 비어 있으면 TRUE가 됩니다',
  ISNUMBER: '값이 숫자이면 TRUE가 됩니다',
  ISTEXT: '값이 글자이면 TRUE가 됩니다',
  ISERROR: '값이 오류이면 TRUE가 됩니다',
  ISERR: '#N/A를 뺀 나머지 오류일 때 TRUE가 됩니다',
  ISNA: '값이 #N/A 오류이면 TRUE가 됩니다',
  ISLOGICAL: '값이 TRUE나 FALSE이면 TRUE가 됩니다',
  NA: '"값 없음"을 뜻하는 #N/A 오류를 일부러 만듭니다',
  TYPE: '값이 어떤 종류인지 번호로 알려줍니다',
});

/**
 * The one-line Korean description for a function name.
 *
 *   docFor('sum')      -> '범위나 숫자들을 모두 더한 합계를 구합니다'
 *   docFor('NOSUCH')   -> ''
 *   docFor(null)       -> ''
 *
 * The name is matched case-insensitively (the engine uppercases names, but the 함수 도우미
 * search box does not). Lookup goes through `hasOwnProperty`, so an inherited property
 * name such as 'constructor' or 'toString' returns '' rather than a function object.
 *
 * Returning '' rather than the name itself is deliberate: the caller already knows the
 * name and decides how to render a row with no description.
 *
 * @param {any} name
 * @returns {string} the description, or '' when there is none
 */
export function docFor(name) {
  if (typeof name !== 'string') return '';
  const key = name.trim().toUpperCase();
  if (!key) return '';
  return Object.prototype.hasOwnProperty.call(FUNCTION_DOCS, key) ? FUNCTION_DOCS[key] : '';
}
