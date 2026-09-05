# 시트지 — Collaborative Web Spreadsheet: Module Contract

This file is the **binding interface contract**. Every module MUST match these signatures
exactly. Do not invent alternative names or shapes. If something is underspecified, choose
the option that keeps these signatures intact.

Runtime: Node.js >= 20, `"type": "module"` (native ESM everywhere).
The `shared/` tree is imported by BOTH Node and the browser, so it must be:
  - pure ESM with **explicit `.js` extensions** in every import specifier
  - free of any Node builtin (`fs`, `path`, `crypto`, ...) and any browser global (`window`, `document`)
  - free of any npm dependency

---

## 0. Directory layout (authoritative)

Authoritative means COMPLETE: every shipped path is here, and `tools/check-spec.mjs` reads
this block as the list of files that must exist. A file the project needs but this tree
omits is a file nothing checks and a file a reader building from this contract never
creates — which is how `env.js` (below) can go missing and the password gate silently not
exist at all.

That failure already happened to this very block. `.gitignore`, `.gitattributes`,
`package-lock.json` and `tools/check-writes.mjs` ship and were absent from the tree below,
and `.gitignore` is the load-bearing one: it is the only thing keeping `.env` — where 28.1
and 29.3 put `SZ_PASSWORD` and the Supabase secret key — out of the repository. A
reader building from a contract that omits it ships no `.gitignore`, and their first
`git add -A` commits the site password, the service key and every stored document.

So `check-spec` reads this block in BOTH directions: every path listed must exist, and
every file in the working tree must be listed. The exemptions are an explicit ignore list
in that checker — `node_modules/`, `.git/`, the real `.env` and its per-environment
siblings, and editor/OS scratch files — plus any DOT-PREFIXED DIRECTORY, which is what
keeps the `.sz-envtest-*` sandboxes `test/env.test.js` builds inside this root from being
read as a second copy of the project. Dot-prefixed FILES are checked like any other:
`.gitignore`, `.gitattributes` and `.env.example` are shipped files, and skipping them is
how three of them stayed unlisted for five review rounds.

Adding a file to the project without adding a line here therefore fails
`npm run check:spec` loudly. That is the point: silence is what let four files ship
unlisted.

One notation rule the checker relies on: a directory written with a trailing `/` and
**no children enumerated under it** — `data/`, `docs/shots/` — stands for its whole
subtree. Every other directory has its contents listed below it, and an unlisted file
inside one of those is an error.

```
package.json
package-lock.json               # the resolved dependency tree; committed, not generated
.gitignore                      # load-bearing, not incidental: the only thing keeping
                                #   `.env` — SZ_PASSWORD / SZ_PASSWORD_HASH /
                                #   SZ_SESSION_SECRET / SUPABASE_SERVICE_KEY (28.1, 29.3)
                                #   — out of the repository. Also excludes `data/*.json`,
                                #   `data/*.tmp` and `*.log`. It does NOT yet cover the
                                #   `<id>.bak.N` backup ring (27.2), so `git add -A` still
                                #   commits those document copies
.gitattributes                  # `* text=auto eol=lf`
.env.example                    # every variable of 28.1 and 29.3 plus PORT, with no values
render.yaml                     # optional Render Blueprint; the dashboard route in
                                #   docs/DEPLOY.md needs no file and is the primary one
README.md                       # the operator-facing document
env.js                          # loads .env into process.env; imported FIRST by server.js
server.js                       # express + ws + the WebSocket protocol + access control
shared/
  model.js                      # document model helpers + constants
  formula/
    errors.js                   # FormulaError + ERR codes
    refs.js                     # A1 <-> {row,col}, ranges, ref transforms
    tokenizer.js                # string -> Token[]
    parser.js                   # Token[] -> AST, plus serialize()
    values.js                   # value coercion + RangeValue
    functions.js                # the function library
    evaluator.js                # AST -> value
    engine.js                   # SheetEngine: dep graph + recalc
    function-docs.js            # one-line Korean description per function
public/
  index.html                    # the EDITOR page
  home.html                     # the document list (site root)
  login.html                    # the password gate
  css/style.css
  js/
    main.js                     # editor bootstrap / wiring
    home.js                     # document list page
    grid.js                     # grid rendering, selection, editing
    net.js                      # websocket client
    presence.js                 # remote cursors + user list
    toolbar.js                  # toolbar + formula bar
    clipboard.js                # copy/cut/paste (TSV)
    history.js                  # undo/redo
    format.js                   # number/date display formatting
    schedule.js                 # rAF-with-timer-fallback repaint scheduler
    outbox.js                   # unsent frames, persisted so a closed tab keeps them
    login.js                    # the password gate page
    print.js                    # build + print a paginated view of a sheet
    chart.js                    # inline-SVG chart rendering
    sheetbar.js                 # bottom sheet tab strip
    docsmenu.js                 # document create / list
storage/
  index.js                      # picks a backend from the environment
  fileStore.js                  # data/*.json + journal + backups
  supabaseStore.js              # PostgREST over fetch, no client library
test/
  run.js                        # zero-dep test runner (node test/run.js)
  unreadable.js                 # makes one real file unreadable by the OS, for 27.6
  data.test.js
  engine.test.js
  env.test.js
  format.test.js
  formula.test.js
  grow.test.js
  harness.test.js
  import.test.js
  journal.test.js
  merge.test.js
  outbox.test.js
  refs.test.js
  regress.test.js
  sheets.test.js
  storage.test.js
  tools.test.js
  unread.test.js
tools/
  check-imports.mjs             # static import checker (npm run check:imports)
  check-spec.mjs                # this document vs the code (npm run check:spec)
  harness-env.mjs               # the ONE way a harness may start server.js
  smoke.mjs                     # end-to-end smoke test
  crash.mjs                     # durability suite, both backends (29.5)
  auth.mjs                      # access-control harness (section 28)
  browser.mjs                   # real-browser end-to-end test
  fakesupabase.mjs              # in-memory PostgREST stand-in (29.5)
  hash-password.mjs             # npm run hash-password (28.1)
  check-writes.mjs              # the mutation gate of 27.6 / 29.1 (npm run check:writes)
data/                           # runtime documents, journals and backups
docs/
  SPEC.md                       # this file
  DEPLOY.md                     # the operator's step-by-step deployment walkthrough
  supabase.sql                  # the three tables of 29.3; the operator runs it once
  shots/                        # README screenshots
```

---

## 1. Coordinates and keys

- Rows and columns are **0-indexed** internally. Row 0 displays as "1"; col 0 displays as "A".
- The canonical cell key used in the document model, the dependency graph and the wire
  protocol is the **uppercase A1 string with no `$`**: `"A1"`, `"BC42"`.
- Never use `"r,c"` tuples as keys anywhere.

---

## 2. `shared/formula/errors.js`

```js
export const ERR = {
  DIV0:  '#DIV/0!',
  VALUE: '#VALUE!',
  REF:   '#REF!',
  NAME:  '#NAME?',
  NUM:   '#NUM!',
  NA:    '#N/A',
  CYCLE: '#CYCLE!',
  PARSE: '#ERROR!',
};

export class FormulaError {
  constructor(code, message = '')   // code is one of ERR.*
  code                              // '#DIV/0!'
  message                           // human-readable detail, may be ''
  toString()                        // returns this.code
}

export function err(code, message)  // -> new FormulaError(code, message)
export function isError(v)          // -> v instanceof FormulaError
```

`FormulaError` is a plain class (NOT an `Error` subclass) because it is a *value*, not a throw.

Parse failures are reported by throwing `ParseError` (see tokenizer.js); the engine catches it
and stores `err(ERR.PARSE, msg)` as the cell value.

---

## 3. `shared/formula/refs.js`

```js
export const MAX_ROWS = 5000;
export const MAX_COLS = 702;                 // A .. ZZ

export function colToLetter(col)             // 0->'A', 25->'Z', 26->'AA'
export function letterToCol(letters)         // 'A'->0, 'AA'->26 (case-insensitive)
export function cellToA1(row, col)           // (0,0) -> 'A1'
export function a1ToCell(a1)                 // 'A1' or '$B$3' -> {sheet, row, col, absRow, absCol}
                                             // accepts a qualified 'Sheet2!A1'; sheet is null
                                             // when unqualified. Throws RangeError if malformed.
export function isA1(s)                      // boolean, cheap regex test

// Sheet qualifiers. See section 16 for the syntax and why this seam exists now.
export function splitSheetRef(text)          // 'Sheet2!A1' -> {sheet:'Sheet2', ref:'A1'}
                                             // 'A1' -> {sheet:null, ref:'A1'}
export function quoteSheetName(name)         // '매출 집계' -> "'매출 집계'"
export function isBareSheetName(name)        // boolean
```

Ranges. A Range is: `{sheet:null|string, s:{row,col,absRow,absCol}, e:{row,col,absRow,absCol}}`

```js
export function parseRange(text)             // 'A1:B3' -> Range ; also accepts 'A:A' and '1:3'
                                             // whole-column 'A:A' -> rows 0..MAX_ROWS-1, .wholeCol=true
                                             // whole-row    '1:1' -> cols 0..MAX_COLS-1, .wholeRow=true
export function normalizeRange(range)        // returns a copy with s<=e on both axes
export function rangeToA1(range)             // Range -> 'A1:B3' (preserves $ flags)
export function iterRange(range, fn)         // fn(row, col) row-major; returns undefined
export function rangeCells(range)            // -> ['A1','A2',...] row-major (cap 200000, else RangeError)
export function rangeSize(range)             // -> {rows, cols}
export function containsCell(range, row, col)// boolean
```

Reference transforms (used by copy/paste and row/col insert-delete):

```js
export function offsetRef(refObj, dRow, dCol)
  // returns a NEW ref object shifted by (dRow,dCol); an absolute axis ($) is NOT shifted.
  // out-of-bounds (row<0, col<0, >=MAX) -> returns {oob:true}

export function shiftRefForStructuralEdit(refObj, edit)
  // edit = {kind:'insertRow'|'deleteRow'|'insertCol'|'deleteCol', index, count}
  // Shifts BOTH absolute and relative refs (structural edits move everything).
  // A ref inside a deleted band -> {oob:true}  (renders as #REF!)
```

---

## 4. `shared/formula/tokenizer.js`

```js
export function tokenize(src)   // src = formula text WITHOUT the leading '='
// -> Token[]   Token = { type, value, pos }
```

Token `type` values, exactly:
`'num' | 'str' | 'bool' | 'err' | 'range' | 'ref' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma'`

Rules:
- `'num'` — `123`, `1.5`, `.5`, `1e-3`. `value` is a JS number.
- `'str'` — double-quoted; a doubled quote inside is an escaped quote. `value` is the decoded string.
- `'bool'` — bare `TRUE`/`FALSE` (case-insensitive) not followed by `(`. `value` is a JS boolean.
- `'err'` — a literal error token like `#N/A`, `#DIV/0!`. `value` is the code string.
- `'range'` — matched BEFORE `'ref'`: `A1:B2`, `$A$1:$B$2`, `A:A`, `1:3`. `value` is the raw text.
- `'ref'` — `A1`, `$B$7`, when NOT immediately followed by `(`. `value` is the raw text.
- Either may carry a sheet qualifier, which is part of the token's `value`: `시트2!A1`,
  `'매출 집계'!A1:B10`. A quoted qualifier may contain `!`, spaces and doubled `''`, so the
  qualifier must be scanned BEFORE the `A1` part rather than by splitting on the last `!`.
- `'ident'` — a name (letters, digits, `_`, `.`) that is not a ref/bool. `value` is the raw text.
  A name immediately followed by `(` is a function call; the parser decides, not the tokenizer.
- `'op'` — one of `+ - * / ^ & % = <> < > <= >=`. `value` is the operator string.
- Whitespace between tokens is skipped. `pos` is the 0-based index in `src` where the token starts.
- On an unrecognized character: throw `ParseError`.

`ParseError` is defined and exported **from tokenizer.js** (parser.js re-exports it) so the two
modules do not form an import cycle:

```js
export class ParseError extends Error { constructor(message, pos) ; pos }
```

---

## 5. `shared/formula/parser.js`

```js
export { ParseError } from './tokenizer.js';
export function parse(src)          // src WITHOUT leading '='  -> AST node ; throws ParseError
export function serialize(node)     // AST -> formula text WITHOUT leading '='
export function collectRefs(node)   // -> { cells: string[] (LOCAL only, A1, no $),
                                    //      ranges: Range[] (LOCAL only), sheets: string[] }
export function mapRefs(node, fn)   // deep-clone AST, applying fn to every ref/range endpoint.
                                    // fn(refObj) -> refObj | {oob:true}
                                    // a range with an oob endpoint becomes {type:'error', value:'#REF!'}
```

AST node shapes, exactly:

```js
{ type:'num',   value: Number }
{ type:'str',   value: String }
{ type:'bool',  value: Boolean }
{ type:'error', value: '#N/A' }
{ type:'blank' }
{ type:'ref',   sheet:null|string, row, col, absRow, absCol }
{ type:'range', sheet:null|string, s:{row,col,absRow,absCol}, e:{...}, wholeCol?:true, wholeRow?:true }
{ type:'unary',   op:'-'|'+', arg }
{ type:'postfix', op:'%', arg }
{ type:'binary',  op, left, right }             // op in: = <> < > <= >= & + - * / ^
{ type:'call',  name:'SUM', args:[node,...] }   // name is UPPERCASED
```

Precedence, lowest to highest (Excel-compatible):
1. comparison `= <> < > <= >=` (left-assoc)
2. `&` (left-assoc)
3. `+ -` (left-assoc)
4. `* /` (left-assoc)
5. `^` (left-assoc — matches Excel: `2^3^2` = 64)
6. unary `-` / `+`
7. postfix `%`
8. primary: literal, ref, range, `(` expr `)`, call

Empty argument slots are allowed in calls: `IF(A1,,"x")` yields `{type:'blank'}` for the
missing arg. `{type:'blank'}` evaluates to `null`.

`serialize` must round-trip: `serialize(parse(x))` re-parses to an equivalent AST.
It emits canonical spacing (no spaces except inside strings) and UPPERCASE function names.

---

## 6. `shared/formula/values.js`

The **value domain** is: `number | string | boolean | null | FormulaError | RangeValue`.
`null` means blank cell.

```js
export class RangeValue {
  constructor(rows)          // rows: value[][]  (2D, row-major)
  rows                       // value[][]
  get height() / get width()
  flat()                     // value[] row-major
  numbers()                  // numbers only; blanks/strings/bools skipped (Excel SUM semantics)
  firstError()               // FormulaError | null
}

export function toNumber(v)   // null->0, true->1, false->0, numeric string->Number,
                              // non-numeric string -> err(ERR.VALUE), RangeValue -> first cell,
                              // FormulaError passthrough. Returns number | FormulaError.
export function toText(v)     // null->'', true->'TRUE', number->shortest round-trip string,
                              // FormulaError passthrough. Returns string | FormulaError.
export function toBool(v)     // null->false, 0->false, nonzero->true, 'TRUE'/'FALSE' strings,
                              // other strings -> err(ERR.VALUE). Returns boolean | FormulaError.
export function compareValues(a, b)   // -> -1|0|1|FormulaError. Ordering: number < string < boolean
                                      // (Excel rule). Strings compare case-insensitively.
export function flattenArgs(args)     // args: value[] -> value[] with RangeValues expanded
export function firstErrorIn(args)    // -> FormulaError | null
export function equalsLoose(a, b)     // '=' operator semantics (case-insensitive strings, null==0)

// Date serials (Excel/Sheets compatible; day 0 is 1899-12-30 UTC).
export const EPOCH_MS                 // Date.UTC(1899,11,30)
export function dateToSerial(d)       // Date -> number (fractional for time-of-day)
export function serialToDate(n)       // number -> Date (UTC)
```

---

## 7. `shared/formula/functions.js`

```js
export const FUNCTIONS = {
  SUM: {
    minArgs: 1, maxArgs: Infinity,
    lazy: false,          // optional, default false
    volatile: false,      // optional, default false
    fn: (args, ctx) => value
  },
  // ...
}
export function getFunction(name)   // uppercase lookup -> def | undefined
export function matchesCriteria(value, criteria)  // shared by COUNTIF/SUMIF/*IFS
```

- **Eager (`lazy` falsy)**: `args` is an array of already-evaluated values
  (`number|string|boolean|null|FormulaError|RangeValue`). The evaluator does NOT
  short-circuit errors — each `fn` decides (most should call `firstErrorIn(args)` first,
  but `ISERROR`/`IFERROR`/`COUNT` deliberately do not).
- **Lazy (`lazy: true`)**: `args` is an array of **AST nodes**; call `ctx.evalNode(node)`
  to evaluate on demand. Required for `IF`, `IFS`, `AND`, `OR`, `IFERROR`, `IFNA`,
  `SWITCH`, `CHOOSE`, `INDIRECT`, `OFFSET`.
- `ctx` is `{ evalNode(node), getCell(row,col), getRangeValue(range), cell:{row,col}, now }`
  where `ctx.now` is a fixed Date for the whole recalc pass (so `NOW()` is stable within a pass).
- Arity is enforced by the evaluator before `fn` runs.
- Mark `RAND`, `RANDBETWEEN`, `TODAY`, `NOW`, `OFFSET`, `INDIRECT` as `volatile: true`.

Required function set (implement ALL of these):

- **Math**: `SUM PRODUCT ABS ROUND ROUNDUP ROUNDDOWN CEILING FLOOR INT TRUNC MOD POWER SQRT EXP LN LOG LOG10 SIGN PI RAND RANDBETWEEN GCD LCM SUMPRODUCT SUMSQ`
- **Stats**: `AVERAGE AVERAGEA MEDIAN MIN MAX COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS SUMIF SUMIFS AVERAGEIF AVERAGEIFS STDEV STDEVP VAR VARP LARGE SMALL RANK MODE`
- **Logic**: `IF IFS AND OR NOT XOR TRUE FALSE IFERROR IFNA SWITCH`
- **Text**: `CONCAT CONCATENATE TEXTJOIN LEN LEFT RIGHT MID UPPER LOWER PROPER TRIM SUBSTITUTE REPLACE FIND SEARCH REPT VALUE EXACT CHAR CODE TEXT`
- **Lookup**: `VLOOKUP HLOOKUP INDEX MATCH CHOOSE ROW COLUMN ROWS COLUMNS OFFSET INDIRECT`
- **Date**: `TODAY NOW DATE YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY DAYS EDATE EOMONTH DATEDIF TIME`
- **Info**: `ISBLANK ISNUMBER ISTEXT ISERROR ISERR ISNA ISLOGICAL NA TYPE`

Criteria strings must support `">5"`, `"<=3"`, `"<>x"`, `"=x"`, plain equality, and `*`/`?`
wildcards.

`TEXT(value, fmt)` supports at minimum: `0`, `0.00`, `#,##0`, `#,##0.00`, `0%`, `0.00%`,
`yyyy-mm-dd`, `mm/dd/yyyy`, `hh:mm`, `hh:mm:ss`, and literal passthrough for anything else.

---

## 8. `shared/formula/evaluator.js`

```js
export function evaluate(node, ctx)   // -> value; never throws for formula-level problems,
                                      //    returns a FormulaError instead
```

`ctx` must provide `getCell(row,col) -> value`, `getRangeValue(range) -> RangeValue`,
`cell:{row,col}`, `now: Date`. The evaluator adds `evalNode` to the ctx it passes to lazy fns.

Operator semantics:
- Arithmetic coerces via `toNumber`; any operand error propagates.
- `&` coerces via `toText`.
- Division by zero -> `err(ERR.DIV0)`.
- A `range` node used where a scalar is expected coerces to its top-left cell's value.
- Unknown function name -> `err(ERR.NAME, name)`.
- Wrong arity -> `err(ERR.VALUE, 'wrong number of arguments')`.
- Guard recursion depth at 200 -> `err(ERR.NUM, 'too deep')`.

---

## 9. `shared/formula/engine.js`

```js
export class SheetEngine {
  constructor({ rows = 200, cols = 26, cells = {} } = {})

  rows; cols

  setInput(a1, input)        // input: string | null (null/'' clears). Reparses, updates deps,
                             // recalcs affected cells. -> Set<string> of A1 keys whose value
                             // changed (always includes a1 itself if it existed or now exists).
  setInputs(map)             // { A1: input, ... } applied as one batch -> Set<string>
  getInput(a1)               // -> string ('' if empty)
  getValue(a1)               // -> value
  getValues()                // -> { A1: value } for all non-empty cells
  isFormula(a1)              // -> boolean
  bulkLoad(cells)            // { A1: {input, style?} } — replaces everything, full recalc
  toJSON()                   // -> { rows, cols, cells: {A1:{input, style?}} }
  recalcAll()
  getStyle(a1)
  setStyle(a1, styleObj)     // shallow-merged; a null property value deletes that key
  applyStructuralEdit(edit)  // edit as in shiftRefForStructuralEdit; moves cell contents,
                             // rewrites every formula via mapRefs+serialize, full recalc.
                             // -> { rows, cols, cells } snapshot of the new state
}
```

Requirements:
- **Dependency graph**: `precedents: Map<a1, Set<a1>>`, `dependents: Map<a1, Set<a1>>`.
  Range precedents are ALSO registered as a `{range, dependent}` list and checked with
  `containsCell`, so a formula over `A1:A100` is invalidated by a write into a
  currently-blank cell inside it. Do not rely on cell-level expansion alone.
- **Recalc**: dirty-set + DFS topological order. Detect cycles and set every cell on the
  cycle to `err(ERR.CYCLE)`.
- **Volatile cells** (formulas calling a `volatile` function) recalc on every pass.
- `ctx.now` is created ONCE per recalc pass.
- Blank cells referenced by formulas evaluate to `null`, not `''`.

---

## 10. `shared/model.js`

```js
export const DEFAULT_ROWS = 200;
export const DEFAULT_COLS = 26;
export const DEFAULT_COL_WIDTH = 104;
export const DEFAULT_ROW_HEIGHT = 26;

// Style object: { b:1, i:1, u:1, s:1, align:'left'|'center'|'right',
//                 bg:'#rrggbb', fg:'#rrggbb',
//                 fmt:'general'|'number'|'currency'|'percent'|'date'|'time'|'text',
//                 decimals:0..6,
//                 ff, fs, va, wrap, rot, bd }   // see section 22
export const MAX_SHEETS = 50;
export const DEFAULT_SHEET_NAME = '시트1';

export function emptyDoc(id, name)   // -> full document object (shape below), with one sheet
export function emptySheet(id, name) // -> a single blank sheet object
export function sanitizeDoc(obj)     // -> validated document; drops unknown keys, clamps sizes,
                                     //    MIGRATES a legacy single-sheet document (see below).
                                     //    Throws TypeError if obj is not an object.
export function newId(seed)          // 12-char base36 id. MUST NOT use node:crypto.
                                     //    seed is a number supplied by the caller.

// --- sheet helpers (pure; each returns a NEW document, never mutates its argument) ---
export function findSheet(doc, sheetId)         // -> sheet | null
export function sheetIndex(doc, sheetId)        // -> number (-1 when absent)
export function uniqueSheetName(doc, wanted)    // -> a name not already used in doc
                                                //    ('시트1' -> '시트1 (2)' -> '시트1 (3)')
export function addSheet(doc, { id, name, afterId })      // -> { doc, sheet }
export function renameSheet(doc, sheetId, name)           // -> doc
export function deleteSheet(doc, sheetId)                 // -> doc (refuses to remove the last)
export function reorderSheet(doc, sheetId, index)         // -> doc
export function duplicateSheet(doc, sheetId, { id, name })// -> { doc, sheet }
export function setSheetColor(doc, sheetId, color)        // -> doc (null clears)
```

Document shape — the WHOLE of what is stored and sent over the wire. Sections 21 to 25 add
the last five fields (`merges`, `link`, `filter`, `charts`, `comments`) and are where each
one is specified; they are repeated here because `sanitizeDoc` DROPS UNKNOWN KEYS, so a
`sanitizeDoc` written from a shape that has forgotten one deletes that field out of every
document it loads, on the first save after boot, with no error and no way back:

```js
{
  id: 'abc123def456',
  name: '제목 없는 스프레드시트',
  sheets: [                       // 1..MAX_SHEETS entries, order IS the tab order
    {
      id: 'sh1a2b',               // stable for the life of the sheet; survives renames
      name: '시트1',               // unique within the document (see uniqueSheetName)
      color: null,                // '#rrggbb' tab colour, or null
      rows: 200,
      cols: 26,
      cells: { 'A1': { input: '=SUM(B1:B9)', style: { b:1 }, link: null } },  // no empty entries
                                  // `link` is optional and per-cell; see 23.4
      colWidths: { '2': 160 },    // keys are stringified col indexes
      rowHeights: { '5': 40 },
      frozenRows: 0,
      frozenCols: 0,
      merges: ['A1:C1'],          // normalized A1 ranges; see section 21
      filter: null,               // one sort/filter VIEW, or null; see 24.1
      charts: [],                 // see 24.2
      comments: {}                // keyed by A1; see 24.3
    }
  ],
  createdAt: 1730000000000,
  updatedAt: 1730000000000,
  rev: 42                         // monotonic, bumped by the server per applied edit
}
```

There is deliberately **no `activeSheetId`** on the document: which tab you are looking at is
per-viewer, not per-document, and lives in the URL hash (`#doc=<id>&sheet=<sheetId>`).

### Legacy migration (required)

`sanitizeDoc` must accept a v1 document — one with top-level `cells` / `rows` / `cols` /
`colWidths` / `rowHeights` / `frozenRows` / `frozenCols` and no `sheets` — and return it wrapped
as a single sheet named `DEFAULT_SHEET_NAME`. Files written before sheets existed are already on
disk; the server loads them through `sanitizeDoc` at boot, so migration MUST happen there and
must be idempotent. A document that has `sheets` is never re-migrated, and a `sheets` array that
is missing, empty or not an array yields exactly one blank sheet.

---

## 11. `server.js`

Express + `ws`. No other runtime deps.

- `app.use(express.static(PUBLIC_DIR, { index: false }))`,
  `app.use('/shared', express.static(SHARED_DIR))` — both directories resolved from
  `server.js`'s own location, never from `process.cwd()`, so `node /somewhere/server.js`
  from another working directory serves the same files `npm start` does.
- `GET  /` -> `public/home.html` (the document list)
- `GET  /edit` -> `public/index.html` (the spreadsheet editor)
- `GET  /api/docs` -> `[{id,name,updatedAt,rev,sheetCount}]` (newest first)
- `POST /api/docs` body `{name?}` -> the new document
- `GET  /api/docs/:id` -> the document, 404 if missing
- `PATCH /api/docs/:id` body `{name}` -> `{ok:true}`
- `DELETE /api/docs/:id` -> `{ok:true}`
- `GET  /api/docs/:id/csv` -> `text/csv` of **computed** values (uses `SheetEngine`),
  with `Content-Disposition: attachment`
- `GET  /healthz` -> `{ok:true}`
- WebSocket on the same HTTP server at path `/ws`.

`{ index: false }` is what keeps the editor off `/`, and it is not optional. It is NOT
ordering: the static middleware is registered FIRST and `app.get('/')` after it, which is
the opposite of what an earlier draft of this section claimed. With `express.static`'s
default (`index: 'index.html'`) the static handler answers `/` with `public/index.html` —
the EDITOR — and `app.get('/')` is never reached at all. So a reader who copies a bare
`express.static('public')` out of a shorter contract, or a maintainer who deletes
`index: false` on being told the ordering protects them, gets a blank spreadsheet at the
site root instead of the document list, with no error anywhere. Verified by running it,
both ways.

Persistence. **Sections 27 and 29 own this and supersede the paragraph this one replaces.**
What still holds at the `server.js` level:

- Writes are debounced 400 ms per document, and the debounced write is a COMPACTION of the
  journal, not the source of truth (27.1). Every accepted operation is journaled before it
  is broadcast or acknowledged.
- All documents are loaded into memory at boot — snapshot first, then the journal replayed
  on top of it (27.1) — except the ones quarantined as unreadable, which are never loaded
  and never served (27.6).
- Doc ids are validated against `/^[a-z0-9]{6,24}$/` before ANY path join.
- `server.js` reaches the store only through the `storage/` interface of 29.1. It performs
  no `fs` call for document data, and `data/` is not necessarily where a document lives:
  with `SUPABASE_URL` set, the same interface is served by Postgres (29.3).

What is NOT true, and was, in the paragraph this replaces: *"a corrupt JSON file is skipped
with a console warning"*. Skipping is exactly the ABSENT/CORRUPT/UNREAD collapse 27.6
exists to forbid, and it is how acknowledged work disappears. A `<id>.json` that read in
full and will not parse is CORRUPT: `loadDoc` falls through to `<id>.bak.1..5` (29.2). One
that could not be READ at all is UNREAD: the document is quarantined — not skipped, not
served empty, not written over (27.6). Nothing at this layer is allowed to turn a failed
read into an empty document.

### WebSocket protocol (JSON text frames)

Every frame that touches cell data carries a `sheetId`. A frame whose `sheetId` names a sheet
that does not exist is answered with `{t:'error'}` and otherwise ignored — never applied to
some other sheet.

Client -> server:
```js
{ t:'hello',  docId, name, color }
{ t:'edit',   docId, sheetId, cells: { 'A1': { input?:string|null, style?:object|null } } }
{ t:'struct', docId, sheetId, edit: {kind, index, count} }
{ t:'meta',   docId, sheetId, patch: { colWidths?, rowHeights?, frozenRows?, frozenCols?, merges? } }
{ t:'docmeta',docId, patch: { name? } }                      // document-level, no sheetId
{ t:'sheet',  docId, op, ... }                               // see the sheet ops table
{ t:'cursor', docId, sheetId, active:'B2', range:{s:{row,col},e:{row,col}} }
{ t:'ping' }
```

Server -> client:
```js
{ t:'welcome', you:{id,name,color}, doc, peers:[{id,name,color,sheetId,active,range}] }
{ t:'edit',   sheetId, cells, rev, by }    // broadcast to everyone incl. sender (idempotent)
{ t:'struct', sheetId, edit, doc, rev, by }// full doc resend (structural edits are rare)
{ t:'meta',   sheetId, patch, rev, by }
{ t:'docmeta',patch, rev, by }
{ t:'sheets', doc, rev, by }               // full doc resend after ANY sheet op
{ t:'peers',  peers }                      // sent on join/leave
{ t:'cursor', id, sheetId, active, range }
{ t:'error',  message }
{ t:'pong' }
```

### Sheet operations

```js
{ t:'sheet', docId, op:'add',       name?, afterId? }
{ t:'sheet', docId, op:'rename',    sheetId, name }
{ t:'sheet', docId, op:'delete',    sheetId }
{ t:'sheet', docId, op:'reorder',   sheetId, index }
{ t:'sheet', docId, op:'duplicate', sheetId, name? }
{ t:'sheet', docId, op:'color',     sheetId, color }   // '#rrggbb' or null to clear
```

Every op is applied with the corresponding pure helper from `shared/model.js`, bumps `rev`,
schedules a save, and broadcasts `{t:'sheets', doc, ...}` with the whole document. Sheet ops are
rare, so a full resend is preferred over a delta — it removes every chance of a client holding a
sheet list the server does not have.

Server-side rules, enforced regardless of what the client sends:
- names are trimmed, capped at 100 chars, and made unique via `uniqueSheetName`
- an empty name after trimming falls back to the default `시트N`
- `delete` on the only remaining sheet is refused with `{t:'error'}`
- `add`/`duplicate` past `MAX_SHEETS` is refused with `{t:'error'}`
- `reorder` clamps `index` into range
- an unknown `sheetId` is refused with `{t:'error'}`

Conflict policy: **last-write-wins per cell**. `rev` is informational; do not reject edits on it.
The server merges the incoming `cells` patch into that sheet, bumps `rev`, schedules a save, and
broadcasts.

Clearing has two distinct meanings, and they must not be conflated — the difference is the
difference between `Delete` and `Ctrl+X`:

| patch entry            | meaning                                                       |
|------------------------|---------------------------------------------------------------|
| `{ input: null }`      | clear the CONTENT only; style and link survive                 |
| `{ style: null }`      | clear the style only; content and link survive                 |
| `{ link: null }`       | clear the link only                                            |
| `null` (whole entry)   | remove the cell entirely — content, style and link             |

A cell is dropped from the document only when nothing is left in it: no input, no style and no
link. `Delete` therefore sends `{ input: null }` and leaves the formatting in place, matching
every other spreadsheet, while `Ctrl+X` sends `null` and takes the formatting with it.

Hardening: reject frames > 256 KB, cap `cells` per edit at 20000, answer malformed JSON with
`{t:'error'}` instead of throwing, heartbeat-ping every 30 s and terminate dead sockets.

### HTTP additions

- `GET  /api/docs/:id/csv?sheet=<sheetId>` — exports that sheet; without the parameter, the
  first sheet. An unknown sheet id is a 404.

Port: `process.env.PORT || 3000`. On boot print `http://localhost:<port>`.

---

## 12. Client modules

All client modules are ESM loaded from `index.html` via
`<script type="module" src="./js/main.js"></script>`.
They import the engine as `import { SheetEngine } from '/shared/formula/engine.js'`.

### `public/js/format.js`
```js
export function formatValue(value, style)   // -> display string (FormulaError -> its code,
                                            //    fmt/decimals, date serials, TRUE/FALSE)
export function alignFor(value, style)      // -> 'left'|'center'|'right' (numbers right by default)
```

### `public/js/schedule.js`
```js
export function onNextFrame(fn, maxDelayMs = 200)   // -> cancel()
```
Runs `fn` on the next animation frame, or after `maxDelayMs` if no frame arrives.
Every coalesced repaint (grid re-render, toolbar, presence) MUST schedule through this
rather than calling `requestAnimationFrame` directly: a hidden or occluded tab receives
no frames, so a bare rAF latches the caller's `pending` flag and repainting stops for
good — which in a collaborative app means a second window silently stops showing peers.

### `public/js/history.js`
```js
export class History {
  push(entry)       // entry: { undo(){}, redo(){}, label }
  undo() / redo()   // -> boolean (false if nothing to do)
  canUndo() / canRedo()
  clear()
}
```
Cap at 200 entries.

### `public/js/grid.js`
```js
export class Grid {
  constructor(container, { engine, sheet, onEdit, onCursor, onStructural, onMeta })
  render()                       // full re-render
  refreshCells(keys)             // repaint just these A1 keys (fast path)
  setSheet(engine, sheet)        // swap to another sheet's engine + geometry, then rerender
  focusCell(a1)
  getSelection()                 // -> { active:'B2', range:{s:{row,col},e:{row,col}} }
  setSelection(sel)
  setPeerCursors(peers)          // draw remote selections
  beginEdit(initialText)
  commitEdit() / cancelEdit()
  destroy()
}
```

Callbacks the Grid invokes (the host wires these to the network):
- `onEdit(cellsPatch)` — `{ 'A1': {input}|{style}|null }`, already applied locally
- `onCursor(sel)` — selection changed
- `onStructural(edit)` — insert/delete row/col
- `onMeta(patch)` — column width / row height / freeze changes

Behaviour requirements:
- Column headers A..Z.., row headers 1..N, a corner select-all box.
- Windowed rendering: only render rows/cols intersecting the viewport (+2 overscan) so 5000
  rows stay smooth. Use absolutely-positioned cells inside a sized spacer, not a `<table>`.
- Selection: click, click-drag, shift-click, `Ctrl/Cmd+A`, header click selects a whole row/col.
- Keyboard: arrows, `Ctrl+arrow` (jump to data edge), `Tab`/`Shift+Tab`, `Enter`/`Shift+Enter`,
  `Home`/`End`, `PageUp`/`PageDown`, `F2` edit, `Delete`/`Backspace` clear, typing any
  printable char starts editing, `Escape` cancels.
- In-cell editor overlaid on the cell; while a formula is being typed, clicking another cell
  inserts its reference into the formula.
- Fill handle at the bottom-right of the selection: drag to fill, with relative-reference
  translation (via `mapRefs` + `serialize`) and linear-series detection for plain numbers.
- Column resize by dragging the header edge; double-click auto-fits.
- Right-click context menu: insert/delete row above-below / left-right, clear contents.
- Frozen rows/cols honoured.
- Peer cursors drawn as a 2px colored outline plus a small name label.

### `public/js/net.js`
```js
export class Net {
  constructor({ docId, name, color, handlers })
  // handlers: { onWelcome, onEdit, onStruct, onMeta, onSheets, onDocMeta,
  //             onPeers, onCursor, onStatus, onAck?, onError? }
  connect()
  send(msg)
  sendEdit(cells)      // coalesced: buffers 60 ms, then flushes one frame
  sendCursor(sel)      // throttled to 100 ms
  isOpen()             // -> boolean
  flush()              // push the 60 ms edit buffer out NOW, without waiting for the timer
  close()
}
```
Auto-reconnect on a fixed backoff ladder (0.5, 1, 2, 4, 8 s). On reconnect it re-sends `hello`
and adopts the server's document wholesale.

Every handler above is load-bearing, and the four that a short list tends to drop are the
four that break something silently:

- `onSheets` and `onDocMeta` receive the `{t:'sheets'}` and `{t:'docmeta'}` frames of
  section 11. Without them a tab added in one window never appears in another, and the
  broadcast is discarded with no error anywhere.
- `onAck` receives `{t:'ack', opId, rev}` (27.3). It is what drains the outbox. Without it
  the outbox only ever grows, the save indicator never returns to `저장됨`, and 27.4's
  `MAX_OUTBOX` cap eventually starts dropping real work.
- `onError` receives `{t:'error', ...}`, including the quarantine refusal of 27.6, whose
  `retry: true` decides whether the client keeps the frame or drops it.

`onStatus` receives **four** values, not three:
`'connecting' | 'online' | 'offline' | 'unauthorized'`. The fourth is required by 28.3 and
is the one an implementer omits. A `/ws` upgrade refused for want of a session is not a
network problem and must not be retried: `Net` stops the backoff ladder for good and
reports `'unauthorized'`, and the host turns that into 로그인이 필요합니다 and sends the
user to the login page. Treating it as `'offline'` reconnects into the same refusal every
0.5, 1, 2, 4, 8 seconds, for ever, while the person watches a status that says the network
is merely down.

### `public/js/presence.js`
```js
export function renderPeers(container, peers, you)   // avatar chips in the header
export function colorForId(id)                        // deterministic pleasant color
```

### `public/js/toolbar.js`
```js
export class Toolbar {
  constructor(root, { onCommand })   // onCommand(name, payload)
  setState({ style, value, formula, selectionLabel, stats })
}
```
Commands: `bold italic underline strike align:left align:center align:right fmt:general
fmt:number fmt:currency fmt:percent fmt:date fmt:text decimals:inc decimals:dec bg:<hex>
fg:<hex> undo redo insertRowAbove insertRowBelow insertColLeft insertColRight deleteRow
deleteCol clear freeze:rows freeze:cols export:csv`.

Also owns the **formula bar**: a name box showing the active ref, and an input bound to the
active cell's raw input.

### `public/js/clipboard.js`
```js
export function serializeSelection(engine, range)
  // -> { text, html, inputs, styles }   ALL FOUR; see below
  //    text    TSV of the DISPLAY values
  //    html    a <table> carrying the formatting, `data-sheetzi="1"`,
  //            `data-sz-origin` and per-cell `data-sz-input` (26.2)
  //    inputs  string[][] of the RAW inputs, row-major — what an internal paste
  //            replays, so formulas survive a copy inside this window
  //    styles  (style|null)[][] row-major, deep-copied off the engine — what makes
  //            an internal paste reproduce formatting instead of values only
export function parseClipboard(text)                // TSV/CSV -> string[][]
export function pasteInto(engine, targetSel, grid2d, opts) // -> cellsPatch (formulas translated)
export function parseExternalHtml(html)             // see 26.2
```

`inputs` and `styles` are not conveniences. This block is the ONLY place the return shape
is written down — 26.2 specifies `parseExternalHtml` and says nothing about this function —
so a reader who builds `serializeSelection` to return `{ text, html }` alone produces an
internal copy/paste that pastes displayed strings: every formula becomes its printed result
and every colour, border and font is lost, with nothing on screen to say so. The deep copy
matters too: the engine hands back its own style object, and `bd` is nested, so a shallow
spread would leave the clipboard sharing border edges with a live cell.

---

## 13. Styling (`public/css/style.css`)

- Google-Sheets-like but with its own identity. Light theme primary; also support
  `@media (prefers-color-scheme: dark)` via CSS custom properties on `:root`.
- Korean-friendly font stack:
  `'Pretendard','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',system-ui,sans-serif`.
- Grid lines 1px `#e0e0e0`; header band `#f8f9fa`; active cell outline 2px `#1a73e8`;
  selection fill `rgba(26,115,232,.10)`.
- No external network requests (no Google Fonts link) — the app must work offline.
- All interactive controls need a visible `:focus-visible` ring.

---

## 14. Tests (`test/`)

`test/run.js` is a zero-dependency runner. It exports a tiny harness and imports the
`*.test.js` files, which register cases against it.

```js
// test/run.js exports:
export function test(name, fn)
export function eq(actual, expected, msg)      // deep equality
export function close(actual, expected, eps)   // numeric
```

`node test/run.js` prints PASS/FAIL per case and exits non-zero on any failure.
Cover at minimum: A1<->rc round-trips, range expansion, operator precedence, every function's
happy path plus one edge case, error propagation, circular-reference detection, dependency
invalidation through a blank cell inside a range, and structural-edit reference rewriting.

---

## 15. package.json

```json
{
  "name": "sheetzi",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Collaborative web spreadsheet with a hand-written formula engine",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node test/run.js",
    "hash-password": "node tools/hash-password.mjs",
    "check:imports": "node tools/check-imports.mjs",
    "check:spec": "node tools/check-spec.mjs",
    "check:writes": "node tools/check-writes.mjs",
    "smoke": "node tools/smoke.mjs",
    "crash": "node tools/crash.mjs",
    "auth": "node tools/auth.mjs",
    "verify": "node tools/check-imports.mjs && node tools/check-spec.mjs && node tools/check-writes.mjs && node test/run.js && node tools/smoke.mjs && node tools/crash.mjs && node tools/auth.mjs && node tools/browser.mjs",
    "browser": "node tools/browser.mjs"
  },
  "engines": { "node": ">=20.12" },
  "dependencies": { "express": "^4.21.2", "ws": "^8.18.0" }
}
```

The scripts are part of the contract, not decoration: other sections tell the reader to run
them by name — `npm run hash-password` (28.1), `node tools/crash.mjs` (29.2, 29.5),
`npm run check:writes` (27.6, 29.1). A `package.json` written with only the first three
leaves every one of those instructions pointing at nothing. `verify` is the one that runs
them all, and it is what "the last line reports how many checks passed" refers to.

`check:writes` is inside `verify` and not an optional extra: it is the checker that stops
the 27.6 mutation gate decaying, and a `verify` chain assembled without it reports success
over a store that can once again overwrite a document it never read.

The list is also CLOSED in the other direction: a script here must name a file that exists.
`migrate-to-supabase` was removed along with `tools/migrate-to-supabase.mjs` (29.4), and a
script left behind pointing at a deleted tool is worse than the tool was — `npm run` prints
it in its menu, so the operator finds it, runs it, and gets a module-not-found stack instead
of an answer.

`>=20.12` rather than `>=20`, because `process.loadEnvFile` — which `env.js` uses to read
`.env` before any other module chooses a storage backend or a password — landed in 20.12.
Dependencies stay at exactly two; nothing in this document may add a third.

---

## 16. Cross-sheet references — the forward-compatible seam

`=시트2!A1` is **not evaluated yet**. It IS parsed, represented and reported, so that turning it
on later is a wiring change rather than a rewrite of the tokenizer, parser and AST. Getting this
seam in now is the whole reason the shapes below exist; do not "simplify" them away.

### 16.1 Reference syntax

A sheet-qualified reference is `<sheet>!<ref>`:

```
시트2!A1            bare name: letters, digits, _ and Hangul, not starting with a digit
'매출 집계'!A1:B10   quoted name: any character; an inner ' is doubled ('')
Sheet2!$A$1
```

`refs.js` gains:

```js
export function splitSheetRef(text)
  // 'Sheet2!A1' -> { sheet: 'Sheet2', ref: 'A1' }
  // "'매출 집계'!A1" -> { sheet: '매출 집계', ref: 'A1' }
  // 'A1' -> { sheet: null, ref: 'A1' }
  // Throws RangeError on a malformed qualifier (empty name, unterminated quote).
export function quoteSheetName(name)
  // 'Sheet2' -> 'Sheet2' ; '매출 집계' -> "'매출 집계'" ; "a'b" -> "'a''b'"
  // Quotes when the name is not a bare identifier.
export function isBareSheetName(name)   // boolean
```

`a1ToCell` and `parseRange` accept a qualified string and put the sheet on the result:
`a1ToCell('Sheet2!A1')` -> `{ sheet:'Sheet2', row:0, col:0, absRow:false, absCol:false }`.
For an unqualified reference `sheet` is `null`. **Every existing caller keeps working**: the new
field is additive and `null` everywhere it was absent before.

### 16.2 AST

`ref` and `range` nodes gain a `sheet` field, `null` when unqualified:

```js
{ type:'ref',   sheet:null|string, row, col, absRow, absCol }
{ type:'range', sheet:null|string, s:{...}, e:{...}, wholeCol?, wholeRow? }
```

- `serialize` re-emits the qualifier through `quoteSheetName`.
- `collectRefs` returns `{ cells, ranges, sheets }` where `sheets` is the sorted unique list of
  foreign sheet names used. **`cells` and `ranges` contain LOCAL references only** — a
  cross-sheet reference must never be registered as a precedent in a single sheet's dependency
  graph, or the graph would invalidate the wrong cell.
- `mapRefs` leaves a node whose `sheet` is non-null completely untouched: a structural edit in
  one sheet must not rewrite coordinates that belong to another.

### 16.3 Evaluation

`evaluate`'s ctx gains one optional member:

```js
ctx.resolveSheet(name)   // -> a sheet-like source, or null/undefined when unavailable
```

The evaluator handles a `sheet`-qualified node like this:
1. if `ctx.resolveSheet` is absent, or returns nothing, produce
   `err(ERR.REF, '다른 시트 참조는 아직 지원하지 않습니다: <name>')`;
2. otherwise read through the returned source with the same `getCell` / `getRangeValue` shape.

`SheetEngine`'s constructor accepts `{ resolveSheet }` and passes it straight through. Today
nothing supplies it, so every cross-sheet formula evaluates to a `#REF!` **whose `message`
explains why in Korean** — a user who tries it gets told it is unsupported, never a silent zero
or a confusing generic error.

When cross-sheet evaluation is switched on later, the remaining work is exactly: supply
`resolveSheet` from the workbook, and extend invalidation so a write in one sheet dirties the
dependents recorded in others. Nothing above changes.

---

## 17. `public/js/sheetbar.js` — the bottom sheet tab strip

```js
export class SheetBar {
  constructor(root, { onCommand })
  // onCommand(name, payload):
  //   'select'    { sheetId }
  //   'add'       { afterId }
  //   'rename'    { sheetId, name }
  //   'delete'    { sheetId }
  //   'duplicate' { sheetId }
  //   'reorder'   { sheetId, index }
  //   'color'     { sheetId, color }   // color null clears
  setState({ sheets, activeId, peers })   // peers: [{id,name,color,sheetId}] for tab presence
  destroy()
}
```

Sits between the grid and the status bar, aligned left, mirroring Google Sheets:

- a `+` button on the far left, then the tabs in document order
- the active tab is visually raised; a tab with a colour shows it as a thick underline
- double-click a tab, or pick 이름 바꾸기 from its menu, to rename **inline** (a contenteditable
  or an input overlaid on the tab) — never `window.prompt`, which blocks the renderer thread
- a caret on the active tab opens a menu: 이름 바꾸기 / 복사본 만들기 / 색상 변경 / 삭제.
  삭제 is disabled when only one sheet remains
- drag a tab horizontally to reorder, with a drop indicator; dropping emits `reorder`
- when the strip overflows, it scrolls horizontally and the active tab is scrolled into view
- a small stack of peer dots on a tab shows who is currently on that sheet
- full keyboard support: `←`/`→` move between tabs when the strip has focus, `Enter` renames,
  each tab is a real `<button>` with `aria-selected`

Class names: `sz-sheetbar`, `sz-sheet-add`, `sz-sheet-tabs`, `sz-sheet-tab`,
`sz-sheet-tab-active`, `sz-sheet-tab-color`, `sz-sheet-caret`, `sz-sheet-rename`,
`sz-sheet-drop`, `sz-sheet-peer`, `sz-sheet-menu`, `sz-sheet-menu-item`.

## 18. `public/js/docsmenu.js` — document create / list

```js
export class DocsMenu {
  constructor(root, { onCommand })
  // onCommand(name, payload):
  //   'create'  {}
  //   'open'    { docId }
  //   'rename'  { docId, name }
  //   'delete'  { docId }
  //   'refresh' {}
  setState({ docs, currentId, busy })   // docs: [{id,name,updatedAt,rev}]
  open() / close() / destroy()
}
```

Rendered from the header. A `새 문서` button creates and opens one immediately; a `내 문서`
button opens a panel listing every document newest-first with its name and relative updated
time (`방금 전`, `3분 전`, `어제`). Each row opens on click and carries rename/delete actions;
the current document is marked and cannot be deleted from the list without a confirm step.
Deleting is confirmed inline inside the row (a 삭제 / 취소 pair), never with `window.confirm`.

Class names: `sz-docs`, `sz-docs-panel`, `sz-docs-item`, `sz-docs-item-current`,
`sz-docs-name`, `sz-docs-time`, `sz-docs-actions`, `sz-docs-empty`, `sz-docs-confirm`.

## 19. Client architecture with multiple sheets

`main.js` holds **one `SheetEngine` per sheet**, created lazily and cached by sheet id, so
switching tabs is instant and a background sheet keeps its computed values. Rules:

- switching tabs never touches the network beyond a `cursor` frame carrying the new `sheetId`
- the URL hash carries both ids: `#doc=<docId>&sheet=<sheetId>`; an unknown sheet id in the hash
  falls back to the first sheet and rewrites the hash
- a `sheets` frame rebuilds the engine cache: engines for sheets that still exist are kept
  (their values stay valid), engines for deleted sheets are dropped
- an incoming `edit` for a sheet the viewer is not looking at is still applied to that sheet's
  engine, so switching to it shows current data without a refetch
- peer cursors are drawn only for peers whose `sheetId` matches the sheet on screen; the others
  are shown as dots on their tab in the sheet bar
- undo/redo entries record the `sheetId` they belong to and switch to that sheet before applying,
  so `Ctrl+Z` can never silently edit a sheet the user is not looking at


---

## 20. `public/home.html` + `public/js/home.js` — the document list

The site root is a list of documents, the way sheets.google.com is. The editor lives at
`/edit#doc=<docId>&sheet=<sheetId>`.

**URL compatibility is a hard requirement.** Links of the form `/#doc=<id>` were handed out
before this page existed, so `home.js` must, before rendering anything, check for a `doc=` in
its own hash and `location.replace('/edit' + location.hash)`. Using `replace` (not `href`)
keeps the redirect out of the back-button history, so Back from the editor reaches the page the
user actually came from rather than bouncing them forward again.

```js
// public/js/home.js — no exports; it is the page's entry module.
```

Behaviour:
- Loads `GET /api/docs` and renders one card per document, newest first.
- Each card shows the document name, the sheet count (`시트 N장`), and the relative modified
  time (`방금 전`, `N분 전`, `N시간 전`, `어제`, `N일 전`, else `YYYY-MM-DD`).
- A prominent **새 문서 만들기** card sits first in the grid; it POSTs and navigates straight
  into the new document.
- Clicking a card opens `/edit#doc=<id>`. The whole card is one link target, and it is a real
  `<a href>` so middle-click and ctrl-click open a new tab.
- Each card has an overflow menu: 이름 바꾸기 (inline input, Enter commits / Escape reverts) and
  삭제 (confirmed inline inside the card, never `window.confirm`).
- A search field filters by name as you type, case-insensitively; it never hits the network.
- A sort control offers 최근 수정순 (default) and 이름순.
- Empty state: a Korean explanation plus a create button. A search that matches nothing shows a
  distinct "검색 결과가 없습니다" state that offers to clear the search.
- A failed fetch renders a readable Korean error panel with a 다시 시도 button — never a blank
  page.
- Everything is keyboard reachable, with a visible `:focus-visible` ring, and the grid is a real
  list for assistive tech.

Class names: `sz-home`, `sz-home-header`, `sz-home-logo`, `sz-home-search`, `sz-home-sort`,
`sz-home-main`, `sz-home-grid`, `sz-home-card`, `sz-home-card-new`, `sz-home-card-name`,
`sz-home-card-meta`, `sz-home-card-menu`, `sz-home-rename`, `sz-home-confirm`, `sz-home-empty`,
`sz-home-error`.

The editor's own logo (`.sz-logo` in `public/index.html`) becomes a link to `/`.

---

## 21. Merged cells

A merge is **presentation and selection only**. Merging keeps the top-left ("anchor") cell's
contents and CLEARS every other covered cell, exactly as Google Sheets does. That single
decision is what keeps the formula engine untouched: after a merge the covered cells are
genuinely empty, so `=SUM(A1:C1)` over a merged `A1:C1` sums the anchor and two blanks and is
correct with no merge-awareness anywhere in `shared/formula/`.

### 21.1 Storage

Each sheet gains `merges`, an array of normalized uppercase A1 range strings:

```js
sheet.merges = ['A1:C1', 'B4:B8']
```

Invariants, enforced by `normalizeMergeList` and re-enforced by `sanitizeDoc`:
- every entry is a valid `A1:B2` range, uppercase, no `$`, start above/left of end
- every entry covers at least 2 cells (a 1x1 "merge" is dropped)
- entries never overlap each other
- entries lie inside the sheet's `rows`/`cols`
- the list is sorted by row then column, so equality checks are stable
- at most `MAX_MERGES` entries

### 21.2 `shared/model.js` additions

```js
export const MAX_MERGES = 2000;

export function normalizeMergeList(list, rows, cols)  // -> string[] obeying every invariant above
export function mergeRect(rangeStr)                   // 'A1:C2' -> {r1, c1, r2, c2}
export function mergeAnchor(rangeStr)                 // 'A1:C2' -> {row:0, col:0}
export function mergeAt(merges, row, col)             // -> the range string covering (row,col), or null
export function expandOverMerges(merges, rect)        // grow {r1,c1,r2,c2} until no merge is
                                                      //   partially covered; returns a new rect
export function planMerge(merges, rect, mode)
  // mode: 'all' | 'horizontal' | 'vertical'
  //   'all'        -> one rectangle covering rect
  //   'horizontal' -> one rectangle per ROW of rect (each spanning its full width)
  //   'vertical'   -> one rectangle per COLUMN of rect (each spanning its full height)
  // Any existing merge that intersects rect is absorbed (removed) first.
  // -> { merges: string[], clear: string[] }
  //    `clear` lists every A1 key that must be emptied: all covered cells except each
  //    new rectangle's anchor. The caller sends that as an ordinary cells patch, so a
  //    merge is undoable through the normal history path.
export function planUnmerge(merges, rect)             // -> { merges: string[] }
                                                      //    drops every merge intersecting rect
export function shiftMerges(merges, edit, rows, cols) // insert/delete rows/cols: grow, move or
                                                      //   drop each rectangle; a rectangle wholly
                                                      //   inside a deleted band disappears
```

All of these are pure and never mutate their arguments. `mode` values other than the three
listed are treated as `'all'`.

### 21.3 Wire protocol

Merges travel on the existing `meta` frame — they are sheet-level presentation state like
column widths, and a new frame type would add protocol surface for no benefit:

```js
{ t:'meta', docId, sheetId, patch: { merges: ['A1:C1', ...] } }
```

The array REPLACES the sheet's list (it is not merged key-by-key). The server re-runs
`normalizeMergeList` on whatever arrives, so a client cannot install overlapping or
out-of-bounds rectangles. `applyStructEdit` runs `shiftMerges` alongside the existing
colWidths/rowHeights shifting.

A merge is therefore two frames: an `edit` clearing the covered cells, then a `meta` carrying
the new list. They are independent and both last-write-wins, so no ordering guarantee is needed.

### 21.4 Grid behaviour (`public/js/grid.js`)

- A merged rectangle renders as ONE `.sz-cell` node at the anchor, sized to the union of its
  cells and carrying `data-a1` of the anchor plus `data-merge="A1:C1"`. Covered cells render
  nothing at all — not an empty node.
- Clicking anywhere in a merged rectangle selects the whole rectangle; `getSelection().active`
  is the anchor.
- Every selection the grid produces is passed through `expandOverMerges`, so a drag that clips
  a merge grows to contain it. This applies to click-drag, shift-click, `Ctrl+A`, header
  selection and the fill handle.
- Arrow keys treat a merged rectangle as one cell: entering it lands on the anchor, and leaving
  it steps past the far edge rather than into a covered cell. `Tab`/`Enter` behave the same.
- Editing (typing, `F2`, the formula bar) always targets the anchor.
- `Delete` over a merged rectangle clears the anchor.
- Frozen panes, windowed rendering and peer cursors must all keep working: a merge that starts
  outside the rendered window but extends into it still has to be drawn.
- The context menu gains 셀 병합 / 병합 해제 entries.

### 21.5 Toolbar

A merge control sits after the alignment group: a main button (셀 병합 / 병합 해제, toggling on
whether the selection already contains a merge) plus a caret opening
전체 병합 / 가로로 병합 / 세로로 병합 / 병합 해제.

Commands: `merge:all`, `merge:horizontal`, `merge:vertical`, `merge:none`.

`Toolbar.setState` gains `merged: boolean` (the active selection contains at least one merge) so
the main button can show the right label.

Class names: `sz-tb-merge`, `sz-tb-merge-menu`.

### 21.6 Copy / paste and CSV

- Copying a range that contains merges copies the anchor values; the TSV/HTML payload is
  rectangular, with covered cells empty. Merge geometry is NOT carried across a paste (matching
  the simplest correct behaviour — the target keeps its own merges).
- CSV export writes the anchor value in the anchor's cell and leaves covered cells empty.

---

## 22. Cell formatting, batch A

Six additions to the cell style object. They all travel the existing path — style patch ->
server `STYLE_KEYS` whitelist -> `sanitizeDoc` validation -> engine `setStyle` -> grid paint —
so nothing new is invented at the protocol level; the work is the validation, the rendering and
the controls.

### 22.1 New style keys

| key   | value                                            | meaning | ABSENT renders as |
|-------|--------------------------------------------------|---------|-------------------|
| `ff`  | one of the ids in `FONT_STACKS`                  | font family | the stylesheet's own stack, which is `FONT_STACKS.default` |
| `fs`  | integer 6..96                                    | font size in px | `--sz-fs`, which is `DEFAULT_FONT_SIZE` (13) |
| `va`  | `'top' \| 'middle' \| 'bottom'`                  | vertical alignment | **CENTRED** — none of the three (22.5) |
| `wrap`| `'overflow' \| 'wrap' \| 'clip'`                 | text overflow behaviour | **CLIPPED**, exactly as `'clip'` (22.5) |
| `rot` | integer -90..90, or `'v'` for stacked vertical   | text rotation | upright: no transform, no writing-mode |
| `bd`  | border spec, see 22.3                            | cell borders | no border on any side (22.3) |

Every key is optional, and ABSENT is a state of its own rather than shorthand for a member
of the second column. The renderer writes NOTHING for an absent key, so the cell keeps
whatever `public/css/style.css` already gives it — which is the entire reason a document
written before this section renders byte for byte as it did. The fourth column above is
therefore a property of that STYLESHEET, and it is the column a reader gets wrong: for `va`
and `wrap` it is neither the first value in the list nor the one this table used to name.
An implementation that treats an absent `wrap` as `'overflow'` makes every unstyled long
label spill across its neighbours, and one that treats an absent `va` as `'bottom'` drops
every unstyled cell's text to the floor. Both change the appearance of every existing
document. 22.5 states each case against the code that implements it — `valignCss` and the
`wrap` branch of the cell paint, both in `public/js/grid.js`.

An absent `va` and an explicit `va: 'middle'` do RENDER identically, as do an absent `wrap`
and `wrap: 'clip'`. What differs is what is STORED, and that difference is exactly what the
controls of 22.4 may not misreport: a cell that has chosen nothing must not be shown as
having chosen something.

`sanitizeDoc` drops anything malformed, and `server.js` adds all six to `STYLE_KEYS`.

### 22.2 Fonts

`shared/model.js` exports the closed set of font choices, so client and server agree and a
malicious `ff` cannot inject CSS:

```js
export const FONT_STACKS = {
  default: "'Pretendard','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',system-ui,sans-serif",
  gothic:  "'Malgun Gothic','Apple SD Gothic Neo',sans-serif",
  myeongjo:"'Batang','Apple SD Gothic Neo',serif",
  mono:    "'D2Coding','Consolas','Courier New',monospace",
  arial:   "Arial,Helvetica,sans-serif",
  times:   "'Times New Roman',Times,serif",
};
export const FONT_LABELS = { default: '기본값', gothic: '고딕', myeongjo: '명조',
                             mono: '고정폭', arial: 'Arial', times: 'Times' };
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 30, 36, 48, 60];
export const DEFAULT_FONT_SIZE = 13;
export function fontStackFor(id)   // -> a CSS font-family string; unknown id -> the default
```

The grid sets `font-family` from `fontStackFor(style.ff)` and `font-size` from `style.fs`.
A row whose tallest cell needs more height than `rowHeights` provides is NOT auto-grown in this
batch; text is clipped by the existing cell overflow rules.

### 22.3 Borders

```js
// style.bd — every side optional; an absent side means no border.
{ t?: Edge, r?: Edge, b?: Edge, l?: Edge }
// Edge = { w: 1|2|3, s: 'solid'|'dashed'|'dotted', c: '#rrggbb' }
```

`shared/model.js` exports:

```js
export const BORDER_WIDTHS = [1, 2, 3];
export const BORDER_STYLES = ['solid', 'dashed', 'dotted'];
export function sanitizeBorder(bd)          // -> a valid bd object, or null
export function applyBorderPreset(rect, preset, edge)
  // preset: 'all' | 'outer' | 'inner' | 'top' | 'right' | 'bottom' | 'left' |
  //         'horizontal' | 'vertical' | 'none'
  // -> { 'A1': {t?,r?,b?,l?} | null, ... } a per-cell bd patch covering rect.
  //    'none' yields null for every cell in rect.
  //    Presets apply the edge to the correct sides of the correct cells: 'outer' only
  //    touches the rectangle's perimeter, 'inner' only the shared edges, and so on.
```

Rendering: the grid draws borders as `box-shadow` insets on the cell, NOT as CSS `border`,
because a real border would shift the cell's box and misalign the grid. A cell with no `bd`
keeps exactly the box-shadow the stylesheet already gives it, so the no-border path is
unchanged. Adjacent cells may both specify the shared edge; both are drawn and the heavier one
simply wins visually — no attempt is made to deduplicate.

### 22.4 Toolbar controls

Added, in this order, matching the reference layout:

- **글꼴** — a dropdown listing `FONT_LABELS`, each rendered in its own face.
- **글꼴 크기** — a `−` / value / `+` control; the value is also a menu of `FONT_SIZES`.
  `−`/`+` step through `FONT_SIZES`, clamping at the ends.
- **테두리** — a grid-icon button opening a 3x3 preset picker plus width / style / colour
  sub-controls. Commands: `border:<preset>`.
- **세로 정렬** — a dropdown: 위 / 가운데 / 아래. Commands: `valign:top|middle|bottom`.
- **텍스트 줄바꿈** — a dropdown: 넘치기 / 줄바꿈 / 자르기. Commands: `wrap:overflow|wrap|clip`.
- **텍스트 회전** — a dropdown of presets (기울임 없음 / 위로 기울임 / 아래로 기울임 /
  세로로 쌓기 / 90° 회전). Commands: `rotate:<value>` where value is an integer or `v`.

`Toolbar.setState` gains `ff`, `fs`, `va`, `wrap`, `rot` and `bd` so every control can show the
active cell's current value.

**A control may only claim a choice the cell actually carries.** `va` and `wrap` have no
default INSIDE their enum (22.1), so a cell with neither key has chosen nothing, and the
세로 정렬 and 텍스트 줄바꿈 controls must mark nothing as active: every row of the dropdown
stays `aria-checked="false"`, and the button's tooltip names the RENDERED default rather
than a value the user picked — `세로 정렬: 기본값 (가운데)`, `텍스트 줄바꿈: 기본값 (자르기)`,
each naming what 22.1's fourth column says the cell renders as. A normaliser that folds an
absent key onto a member of the list instead — the obvious implementation, and the one that
shipped — makes the toolbar assert 아래 over a cell whose text the grid is centring, which
is the control telling the user something false about their own document. `public/js/toolbar.js`
keeps that normaliser (`normStyleChoice`) separate from the ones for `ff`, `fs` and `rot`
for exactly this reason: those three have a real default in their own domain
(`FONT_STACKS.default`, `DEFAULT_FONT_SIZE`, no rotation) and may go on showing it, as may
테두리, which lights up only when the cell carries a `bd`.

Class names: `sz-tb-font`, `sz-tb-fontsize`, `sz-tb-size-step`, `sz-tb-border`,
`sz-tb-border-grid`, `sz-tb-valign`, `sz-tb-wrap`, `sz-tb-rotate`, plus `sz-tb-drop` for the
shared dropdown surface.

### 22.5 Rendering rules

- `va` maps to the cell's `align-content` — the cell box is `display: grid`, not flex.
  `'top'` -> `start`, `'middle'` -> `center`, `'bottom'` -> `end`. An ABSENT `va` writes
  nothing at all, so the cell keeps the stylesheet's own `align-content: center` and renders
  CENTRED. That is why 22.1 does not call `'bottom'` the default: absent and `'bottom'` are
  different renderings, and it is absent — not `'bottom'` — that reproduces today's
  appearance exactly, which is the requirement. An explicit `'bottom'` really does move the
  text to the floor; mapping it back onto centre so the table's old wording could be true
  would make 세로 정렬 아래 and 가운데 indistinguishable. The toolbar follows the same rule
  and marks nothing while `va` is absent (22.4).
- Cells clip by default and always have: `.sz-cell` is `white-space: pre; overflow: hidden`.
  `wrap: 'clip'` spells that default out explicitly and changes nothing.
  `wrap: 'wrap'` sets `white-space: pre-wrap`, reflowing inside the cell.
  `wrap: 'overflow'` makes the cell BORROW the width of the empty cells to its right, so a
  long label runs past its own column the way it does in a spreadsheet. The scan stops at
  the first neighbour holding anything (so spilled text can never hide real data), at a
  merged rectangle, at the sheet edge, or after `MAX_SPILL_COLS` columns. A spilling cell
  gets `z-index: 1` because its empty neighbours paint their own opaque background and the
  cell nodes are siblings in a recycling-driven DOM order.
  A cell with no `wrap` key keeps the default clipping — existing documents are unchanged,
  and the 텍스트 줄바꿈 control marks nothing while it is absent (22.4). Note which way
  round this is: absent behaves as `'clip'`, the LAST value in the enum, never as
  `'overflow'`, the first.
- `rot` numeric applies `transform: rotate(-NDEG)` **to an inner text span**, never to the
  cell node: a transform on the cell rotates its opaque background and its inset border
  shadows too, smearing them diagonally across the rows above and below. The span is
  `display: inline-block` only while a rotation is set (a transform has no effect on a
  non-replaced inline box) and carries no styles at all otherwise.
  `rot: 'v'` sets `writing-mode: vertical-rl` on the cell — that reflows text without
  transforming any box, so it is safe there — and clears any rotation.
- These are inline styles set by the renderer, exactly like the existing bold/align handling.
  A cell with none of the six keys must end up with the identical inline style it has today.

---

## 23. Tools, batch B

Five tools. Four are view- or document-level and touch no cell data; one (링크) adds a field to
the cell record.

### 23.1 서식 복사 (format painter)

Toolbar button `sz-tb-painter`. Command `painter:toggle`.

- A single click arms the painter with the ACTIVE cell's style and turns the button on. The next
  selection the user makes has that style applied, and the painter disarms.
- A double click arms it **sticky**: it keeps applying to every subsequent selection until it is
  switched off, `Escape` is pressed, or the sheet changes.
- While armed the grid carries the class `sz-painting` so the cursor can change.
- It copies the STYLE only — never the input, never a link, never merge geometry.
- Applying is an ordinary style patch through the normal edit path, so it is undoable and
  replicated with no new plumbing.

`Grid` gains `setPainting(on)` (adds/removes the class) and reports selections as it already
does; all of the state lives in `main.js`.

### 23.2 확대/축소 (zoom)

Toolbar control `sz-tb-zoom`: a percentage button opening 50 / 75 / 90 / 100 / 125 / 150 / 200.
Command `zoom:<n>`.

Zoom is a **per-viewer view preference**, not document state: it is stored in `localStorage`
under `sz.zoom`, never sent over the wire and never written to the document.

Implementation: the grid multiplies its pixel geometry by the factor — column widths, row
heights, header sizes and the base font size. It must NOT use a CSS `transform: scale()` on the
grid, because the viewport's own scroll box would keep its unscaled size and every hit-test,
scroll offset and overlay position would need a compensating divide.

`Grid` gains:
```js
setZoom(factor)     // 0.5 .. 2, clamped; re-lays out and repaints
getZoom()
```
Everything the grid measures in pixels goes through the factor in ONE place, so that resize,
auto-fit, the fill handle, merges, frozen panes and peer cursors all follow without their own
arithmetic. Column widths stored in the document stay unscaled — zoom never mutates the doc.

### 23.3 인쇄 (print)

Toolbar button `sz-tb-print`. Command `print`.

The grid renders only the cells in the viewport, so printing the live DOM would print a screen's
worth of cells. Instead `main.js` builds a self-contained print document from the sheet's used
range and prints that:

```js
// public/js/print.js
export function buildPrintHtml(sheet, engine, options)   // -> a complete HTML string
export function printSheet(sheet, engine, options)       // builds it, prints it, cleans up
// options: { docName, sheetName, orientation:'portrait'|'landscape', gridlines:boolean }
```

- The used range is the bounding box of every non-empty cell, capped at 5000 rows.
- It emits a real `<table>` so the browser paginates it, with `colgroup` widths from the sheet,
  `thead` repeating the column letters on every page when `gridlines` is on, and each cell
  carrying its own resolved style (bold, colours, alignment, font, borders, formats).
- Merged cells become `colspan`/`rowspan`; covered cells are omitted.
- It runs in a hidden same-origin `<iframe>`, calls `print()` on it and removes it afterwards;
  a popup window is not used because popup blockers break it silently.
- Every value is inserted as TEXT, never as HTML.

### 23.4 링크 삽입

A cell record gains an optional `link`:

```js
cells: { 'A1': { input: '홈페이지', style: {...}, link: 'https://example.com' } }
```

`shared/model.js` exports `sanitizeLink(v)` which accepts only `http:`, `https:` and `mailto:`
URLs, rejects everything else (notably `javascript:` and `data:`) and returns `null` when
invalid. `sanitizeDoc` runs it over every cell, and `server.js` treats `link` exactly like
`input`: a `null` clears it.

- Wire: the existing `edit` frame's cell patch may carry `link`, alongside `input` and `style`.
- Toolbar button `sz-tb-link`, command `link:set` / `link:clear`. `link:set` opens a small
  inline panel with a URL field and 적용 / 제거, prefilled from the active cell.
- The grid renders a linked cell's text inside an `<a>` with `target="_blank"` and
  `rel="noopener noreferrer"`, styled `sz-cell-link`. A plain click still SELECTS the cell —
  only `Ctrl`/`Cmd`+click or a click on the small trailing link glyph follows it, so linking a
  cell never makes it hard to edit.
- CSV export writes the cell's value, not its URL.

### 23.5 함수 도우미 (Σ)

Toolbar control `sz-tb-fx`, a button plus a caret.

- The button inserts `=SUM(<guess>)` into the first empty cell below (or right of) the selection,
  where `<guess>` is the contiguous run of numbers immediately above (or left of) it. With a
  multi-cell selection it uses exactly that range.
- The caret opens a menu: SUM / AVERAGE / COUNT / MAX / MIN, each inserting the same way, plus
  기타 함수 which opens a searchable list of every function in the engine.
- The list is built from the engine's own `FUNCTIONS` table, so it can never drift from what the
  parser accepts. Each row shows the name and a one-line Korean description from a new
  `shared/formula/function-docs.js` map; a function with no entry still lists, with its name
  only. Choosing one starts an edit in the active cell with `=NAME(` already typed.
- Commands: `fx:sum`, `fx:average`, `fx:count`, `fx:max`, `fx:min`, `fx:more`.

Class names: `sz-tb-painter`, `sz-tb-zoom`, `sz-tb-print`, `sz-tb-link`, `sz-tb-fx`,
`sz-fx-list`, `sz-fx-search`, `sz-fx-item`, `sz-link-panel`, `sz-cell-link`, `sz-painting`.

---

## 24. Data features, batch C

Three features that operate on ranges of data rather than on single cells: sorting and
filtering, charts, and comments. Each one owns a slice of sheet-level state.

### 24.1 정렬 / 필터

A sheet may carry one filter view:

```js
sheet.filter = {
  range: 'A1:F200',        // normalized A1 range, header row included
  header: true,            // treat the first row as headers
  sort: { col: 2, dir: 'asc' } | null,       // col is relative to range
  hidden: { '2': ['취소', '보류'] } | {},     // per relative column, the values HIDDEN
}
```

`shared/model.js` exports:

```js
export function sanitizeFilter(f, rows, cols)   // -> a valid filter object, or null
export function filterColumnValues(cells, range, col, header)
  // -> { values: string[], counts: Map } the distinct DISPLAY values of that column,
  //    sorted, for the filter dropdown
export function computeVisibleRows(cells, filter, valueOf)
  // -> Set<number> of ABSOLUTE row indexes that survive the filter
export function computeSortOrder(cells, filter, valueOf)
  // -> number[] of absolute row indexes in display order; identity order when no sort
```

`valueOf(row, col)` is injected so the pure helpers never import the engine.

Rules:
- Sorting is a **view**, not a rewrite: the document's rows are never reordered, so a sort can
  never corrupt formulas. The grid renders rows in the order `computeSortOrder` returns.
- Filtering hides rows in the grid the way a hidden row would be hidden; formulas are unaffected
  and still see every row, matching the behaviour of a filter view rather than a deletion.
- Ordering follows `compareValues` from `shared/formula/values.js` so it matches formula
  semantics: numbers before text before booleans, text case-insensitively.
- Blank cells sort last in both directions.
- Wire: the whole filter object travels on the existing `meta` frame as `patch.filter`,
  replacing the previous value; `null` clears it. The server re-runs `sanitizeFilter`.

UI:
- Toolbar `sz-tb-filter`: 필터 만들기 / 필터 끄기 over the selection.
- Each header cell of the filter range gains a `sz-filter-btn` glyph opening a panel
  (`sz-filter-panel`) with 오름차순 정렬 / 내림차순 정렬, a search field, and a checkbox list of
  the column's distinct values with 전체 선택 / 선택 해제.
- The status bar reports `N개 중 M개 표시` while a filter hides anything.

### 24.2 차트

A sheet may carry charts:

```js
sheet.charts = [{
  id: 'ch1a2b',
  type: 'column' | 'bar' | 'line' | 'area' | 'pie' | 'scatter',
  range: 'A1:C10',
  title: '분기 매출',
  headerRow: true,        // first row of range is the series names
  headerCol: true,        // first column is the category labels
  x: 320, y: 80,          // px offset within the sheet
  w: 480, h: 300,
  legend: 'right' | 'bottom' | 'none',
}]
```

`shared/model.js` exports `sanitizeChart`, `sanitizeChartList` and `MAX_CHARTS = 20`.

`public/js/chart.js` renders one chart as **inline SVG**, with no library:

```js
export function chartSeries(cells, chart, valueOf)   // -> { categories, series } plain data
export function renderChart(svgEl, chart, data)      // draws into an existing <svg>
export const CHART_TYPES                             // [{id, label}] for the picker
```

- Charts are drawn into an overlay layer above the grid, positioned in sheet coordinates so they
  scroll with it and follow zoom.
- A chart re-renders when any cell inside its range changes; the grid reports that through the
  existing changed-key set rather than re-rendering on every edit.
- Dragging a chart moves it, dragging its corner resizes it; both write back through the `meta`
  frame as `patch.charts`.
- Colours come from a fixed 10-colour palette defined as tokens, so charts follow the theme.
- Axis ticks are chosen with a nice-number algorithm (1/2/5 x 10^n) and the value axis always
  includes zero for column, bar and area types.
- Every text node in the SVG is set with `textContent`, never markup.

UI: toolbar `sz-tb-chart` inserts a chart from the selection and opens a side panel
(`sz-chart-panel`) with type, title, range, header toggles and legend position.

### 24.3 댓글

A sheet may carry comment threads:

```js
sheet.comments = {
  'B4': { id, cell:'B4', resolved:false,
          messages: [{ id, author, authorId, text, at }] }
}
```

`shared/model.js` exports `sanitizeComments`, `MAX_COMMENT_LEN = 4000` and
`MAX_COMMENTS_PER_SHEET = 500`.

- Wire: a new frame `{ t:'comment', docId, sheetId, op:'add'|'reply'|'resolve'|'reopen'|'delete',
  cell, threadId?, messageId?, text? }`. The server applies it with the pure helpers, stamps
  `author` from the peer's display name and `at` from its own clock (never from the client),
  bumps `rev`, saves and broadcasts `{ t:'comments', sheetId, comments, rev, by }`.
- A commented cell shows a small triangle in its top-right corner (`sz-cell-comment`); clicking
  it or the toolbar button opens the thread panel (`sz-comment-panel`).
- Structural edits move comment keys exactly as they move cells; a comment on a deleted row is
  dropped.
- Comment text is displayed as TEXT, never as markup, and is capped at `MAX_COMMENT_LEN`.
- Toolbar `sz-tb-comment` adds a comment to the active cell; the panel lists every thread on the
  sheet with 해결 / 다시 열기 / 삭제.

Class names: `sz-tb-filter`, `sz-filter-btn`, `sz-filter-panel`, `sz-filter-list`,
`sz-tb-chart`, `sz-chart-layer`, `sz-chart`, `sz-chart-panel`, `sz-chart-handle`,
`sz-tb-comment`, `sz-cell-comment`, `sz-comment-panel`, `sz-comment-thread`, `sz-comment-msg`.


---

## 25. Growing a sheet

A sheet starts at `DEFAULT_ROWS` x `DEFAULT_COLS` (200 x 26, A..Z) and can grow to
`MAX_ROWS` x `MAX_COLS` (5000 x 702, A..ZZ). Until now there was no way to reach past the
starting size at all: 행 삽입 shifts cells WITHIN the sheet and never changes its extent.

### 25.1 Model

`shared/model.js` gains:

```js
export const ROW_GROW_STEP = 1000;   // one press of the button
export const COL_GROW_STEP = 26;     // one press of the button
export function growSheet(doc, sheetId, { rows = 0, cols = 0 })
  // -> doc  (pure; returns the document unchanged when nothing would change)
  // Adds `rows` rows and/or `cols` columns to that sheet, clamped so the result never
  // exceeds MAX_ROWS / MAX_COLS. Growing NEVER touches cells, merges, filters, charts
  // or comments: the extent is the only thing that changes, so it cannot corrupt a
  // formula or move anything.
```

Growing is strictly additive. There is deliberately no shrink: removing rows that hold
data — or that a formula, a merge or a chart range points at — is what 행 삭제 is for, and
it already carries the reference rewriting that makes it safe.

### 25.2 Wire

Growth travels on the existing `meta` frame, because the extent is sheet-level geometry
like column widths:

```js
{ t:'meta', docId, sheetId, patch: { rows: 1200, cols: 52 } }
```

The server clamps both to `[current, MAX]` — a client can only ever grow a sheet, never
shrink it by this route — and broadcasts the stored values.

### 25.3 Auto-grow

The grid grows a sheet on its own when the user reaches the end of it, which is what makes
the limit invisible in normal use:

- Scrolling to within `GROW_TRIGGER_ROWS` (50) of the last row appends `ROW_GROW_STEP`
  rows; the same within `GROW_TRIGGER_COLS` (5) of the last column appends
  `COL_GROW_STEP` columns.
- Moving the selection onto the last row or column with the keyboard does the same.
- Auto-grow fires at most once per second per axis, so a fast scroll cannot queue a dozen
  growth frames, and it stops silently at the maximum.
- It is reported through the existing `onMeta` callback, so it is replicated like any
  other geometry change.

### 25.4 Manual grow

Below the grid, aligned with the sheet bar, a row of controls:

`맨 아래에 행 [1000] 개 추가`   `오른쪽에 열 [26] 개 추가`

Commands `grow:rows` and `grow:cols`, each with the requested count as the payload. The
number is an editable input, capped at what remains before the maximum. When a sheet is
already at its limit the control is disabled and says 최대 크기입니다.

Class names: `sz-grow`, `sz-grow-rows`, `sz-grow-cols`, `sz-grow-input`, `sz-grow-btn`.

The status bar reports the current extent, so the size is never a mystery:
`200행 x 26열` next to the selection readout.


---

## 26. Pasting from Excel and Google Sheets

A paste from another spreadsheet currently keeps only the text. The clipboard carries far
more than that: alongside `text/plain` (the displayed values, tab separated) every
spreadsheet also writes a `text/html` table that describes the formatting, and Google
Sheets additionally hides the FORMULA of each cell in an attribute. Reading that turns a
paste from a data transfer into a real import.

Excel does not put formulas on the clipboard at all — only their results — so formulas can
be recovered from Google Sheets but not from Excel. That is a limitation of what Excel
sends, not something this code can work around; `docs`/README must say so plainly rather
than let a user think their formulas were lost.

### 26.1 Security

The HTML is arbitrary markup from an unknown source. It is parsed for the handful of facts
this app wants and everything else is discarded:

- Parse with `new DOMParser().parseFromString(html, 'text/html')` — an inert document that
  runs no script and loads no resource. Never `innerHTML` into the live page.
- Read only: cell text, `colspan`/`rowspan`, the inline `style` of each cell, and Google's
  `data-sheets-value` / `data-sheets-formula` attributes.
- Every value taken out is treated as untrusted text. Colours must match `#rrggbb` or a
  short named set; anything else is dropped. Nothing from the HTML is ever assigned to a
  style property as a raw string.
- Cap the import at `MAX_EXTERNAL_CELLS` and ignore anything past it, so a hostile or
  enormous table cannot lock the tab. It is `clipboard.js`'s own constant, holding the same
  20000 as `main.js`'s `MAX_EDIT_CELLS` and mirroring it by value rather than by import:
  a paste that could not be sent as one edit frame is not worth building.

### 26.2 `public/js/clipboard.js`

```js
export function parseExternalHtml(html)
  // -> null when the markup holds no usable table, otherwise
  //    { rows: number, cols: number,
  //      cells: [[{ input, style, merge } | null, ...], ...],    // row-major
  //      origin?: { row, col } }   // where the copy came from, when the source said
  //    `input`  the formula when one was recoverable, else the literal text
  //    `style`  a sanitised cell style object (SPEC 22.1 shape), or null
  //    `merge`  { rows, cols } on the anchor of a merged block, else null;
  //             cells covered by a merge are null in the grid
```

Recognised sources, by what they leave in the markup:

| source | text | formatting | formula |
|--------|------|-----------|---------|
| 시트지 (`data-sheetzi="1"`) | ✓ | ✓ | ✓ (`data-sz-input`) |
| Google Sheets | ✓ | ✓ | ✓ (`data-sheets-formula`) |
| Excel / LibreOffice | ✓ | ✓ | ✗ (not on the clipboard) |

Style facts read from the inline CSS of each `<td>`: `font-weight`, `font-style`,
`text-decoration`, `color`, `background-color`, `text-align`, `vertical-align`,
`font-family` (mapped onto the closed `FONT_STACKS` set, never used raw), `font-size`
(rounded, clamped to 6..96) and the four `border-*` sides (mapped onto the `bd` shape).

A formula arrives already in A1 notation. Whether its relative references can be
translated depends on whether the source said where the copy came from:

- **시트지** stamps the copied range on the table as `data-sz-origin="<top-left A1>"`, so a
  copy pasted into another tab or window is translated exactly like an internal paste. That
  path is common — the internal clipboard is per-window, so a second tab always takes this
  route. Without the attribute `grid.origin` stays `null` and there is nothing to translate
  against: `=A1+B1` copied from `C1` would land as `=A1+B1` wherever it was pasted.
- **Google Sheets and Excel** ship no such marker. Their formulas are pasted VERBATIM.
  Guessing an origin would silently produce wrong numbers, which is worse than pasting
  what was copied; the README says so plainly.

### 26.3 Paste flow

`onPasteEvent` in `main.js` gains a step:

1. If the clipboard text matches this app's own last copy, use the internal payload as now.
2. Otherwise, if `text/html` is present, run `parseExternalHtml`. When it yields a table
   whose shape matches the plain-text grid, use it — values, styles and merges together.
3. Otherwise fall back to the plain-text parse, exactly as today.

The result is applied through the same `commitLocalEdit` path as any other edit, so it is
undoable, replicated and validated server-side with no new plumbing. Merges arrive as a
`meta` patch alongside the cells, the way the merge feature already sends them.

A paste that imported formatting reports what it did in the status toast, e.g.
`24칸을 붙여넣었습니다 (서식 포함)`, so nothing is silently dropped or silently added.


---

## 27. Durability — nothing typed may be lost

The requirement is absolute: once a person types something, it survives. Everything in this
section exists to close a specific way that can fail today.

Where it can currently be lost:

| moment | what is lost | why |
|--------|--------------|-----|
| the process dies within the 400 ms save debounce | the last edits | they existed only in memory |
| the tab closes while the socket is down | the queued edits | the outbound queue is in memory |
| a bad bulk edit or a corrupt write | the document | there is no history to fall back on |
| any of the above | the user's confidence | nothing on screen says whether it was saved |
| a snapshot or journal that could not be READ | every acknowledged edit since the last compaction | a failed read was filed as an empty one (27.6) |

### 27.1 Server: an append-only journal

The full-document JSON snapshot stops being the source of truth and becomes a compaction of
one. Every accepted operation is appended to `data/<id>.log` — one JSON object per line —
**before** it is broadcast and before it is acknowledged.

```js
{ "t":"edit",  "sheetId":"sh1a2b", "cells":{...}, "rev":42, "at":1730000000000 }
{ "t":"meta",  "sheetId":"sh1a2b", "patch":{...},  "rev":43, "at":1730000000001 }
{ "t":"sheet", "op":"add", "doc":{...},            "rev":44, "at":1730000000002 }
```

The full set of record types, because replay has to know every one of them: `doc` (a
document created), `docmeta` (a rename or another document-level patch), `edit`, `struct`
(a row/column insert or delete), `meta` (a sheet-level patch), `comment` and `sheet` (a
tab added, renamed, deleted, reordered or duplicated). A type replay does not recognise is
skipped, never guessed at.

- The append is issued immediately, so a process crash — the realistic failure — loses
  nothing: the bytes are already with the operating system.
- `fsync` runs at most every `FSYNC_MS` (200) and always before a clean shutdown, which
  bounds what an OS-level crash could cost to a fifth of a second rather than to whatever
  the debounce happened to be holding.
- Appends for one document are serialised, so lines can never interleave.
- A line that fails to parse on replay is skipped with a warning; one bad record must never
  cost the whole document.

**Boot** loads `<id>.json`, then replays `<id>.log` on top of it. A snapshot written while
the journal held newer records is therefore harmless: the journal wins.

**Compaction** happens on the existing debounce: write the snapshot atomically (tmp +
rename), then truncate the journal. Order matters — truncating first would open a window
where neither copy holds the data.

### 27.2 Server: snapshot backups

Before a snapshot replaces `<id>.json`, the previous file is rotated to `<id>.bak.1`, and
the existing backups shift down, keeping `BACKUP_COUNT` (5) of them. A corrupt write or a
regretted bulk edit is then recoverable by hand, and `GET /api/docs/:id/backups` lists what
exists with its timestamp and size.

Rotation is best-effort: a failure to rotate is logged and never blocks the save.

### 27.3 Server: acknowledgement

An `edit`, `struct`, `meta`, `docmeta`, `sheet` or `comment` frame may carry a
client-generated `opId` (a short opaque string). Once the operation is journaled, the
server replies to its sender only:

```js
{ t:'ack', opId, rev }
```

An ack means *this is on disk*, not merely *received*. That distinction is the whole point:
it is what lets the client keep an edit until it is genuinely safe, and what lets the UI
tell the truth.

### 27.4 Client: an outbox that survives the tab

`public/js/outbox.js`:

```js
export class Outbox {
  constructor(docId)                 // one per document
  add(frame)                         // -> opId; persists immediately
  ack(opId)                          // drop it; persists
  pending()                          // -> frame[] in original order
  size()
  clear()
}
```

- Backed by `localStorage` under `sz.outbox.<docId>`, written synchronously on every add
  and ack, so a tab that is closed or crashes keeps its unsent work.
- Capped at `MAX_OUTBOX` (2000) frames; past that the oldest are dropped and the user is
  told, because silently discarding work is exactly what this section forbids.
- On boot, after `welcome`, every pending frame is re-sent in order. They are idempotent
  (last-write-wins per cell), so replaying one the server already had is harmless.
- `localStorage` can be unavailable (private mode, quota). The outbox degrades to memory
  only and `main.js` says so once, rather than pretending to be durable.

### 27.5 Client: never leave silently

- `beforeunload` warns while `outbox.size() > 0`, so closing a tab with unsent work asks
  first — with exactly ONE exception, which is not optional and must be implemented:

  **A deliberate trip to the login page does not warn.** `goToLogin()` (any `401`) and the
  로그아웃 button both set a redirecting flag; while that flag is set AND the outbox can
  persist, `beforeunload` returns nothing and the browser leaves silently. It is safe
  because both paths flush the 60 ms edit coalescer into the outbox BEFORE navigating, so
  every keystroke is already in `localStorage`, and 27.4 replays the whole outbox after the
  next `welcome` — the work survives the trip, so there is nothing to warn about. Warning
  would offer a "stay" that leads back to a page which can no longer save anything: every
  frame it sends is refused for want of a session, and the person would go on typing into a
  tab that cannot acknowledge a thing.

  When the outbox CANNOT persist (27.4's memory-only degradation) the flag changes nothing
  and the warning stands. That is the one case where leaving really does cost the work, and
  it is why the exception is written as "redirecting **and** persisting", never as
  "redirecting".
- The header carries a save indicator (`sz-save`), driven only by the outbox and the socket:

| state | text |
|-------|------|
| nothing pending, socket up | `저장됨` |
| pending, socket up | `저장 중…` |
| pending, socket down | `저장 대기 중 (N)` |
| outbox unavailable | `저장됨 (이 브라우저에는 임시 보관 불가)` |

The indicator must never read `저장됨` while anything is unacknowledged. It is the one
thing on screen a person will trust, so it may only ever under-promise.

### 27.6 A read that failed is never an empty document

There are three things a store can find where a document should be, and collapsing any two
of them is how acknowledged work disappears:

| outcome | what it means | what it licenses |
|---------|---------------|------------------|
| ABSENT | nothing is stored — `ENOENT`, no row | create it, serve it empty, carry on |
| CORRUPT | the bytes were read IN FULL and will not parse | fall back to a backup, count the bad lines, carry on |
| UNREAD | the bytes could not be read at all | nothing whatsoever |

ABSENT and CORRUPT are conclusions drawn from something the process actually saw. UNREAD is
the absence of a conclusion: `EACCES`, `EIO`, `EBUSY`, `EPERM`, `ERR_FS_FILE_TOO_LARGE`, a
scanner holding the file open for the second boot happened to touch it, a disk on the way
out, a `2xx` whose body arrived damaged. The data IS there and we failed to see it.

Filed as ABSENT it reads as "empty journal": boot serves the document at the snapshot's
`rev` while the acknowledged records sit unread in the log, new edits mint revisions that
collide with them, and the next compaction truncates them away. Filed as CORRUPT it reads
as "damaged snapshot": an older backup is substituted for a `<id>.json` that was merely
busy, and the save that follows rotates the good copy down the backup ring until it drops
off the end. Both destroy data the process never once looked at, and both look like
ordinary recovery in the log.

**The invariant. Every backend and every caller is held to it:**

> A document whose stored state could not be READ is never served for editing, never
> replayed against, never truncated, and never overwritten.

#### Quarantine

The first UNREAD outcome for a document takes that document out of service for the rest of
the process — not one operation, the document:

- boot does not load it, so nothing can edit it and its `rev` cannot advance;
- `saveSnapshot`, `truncateJournal` and `deleteDoc` refuse for it;
- `appendJournal` resolves `false` for it, which is the existing "not durable" answer: the
  operation is not acknowledged and the client keeps it in its outbox (27.4);
- every OTHER document keeps working. One unreadable document must not be an outage.

The middle two are refused by the STORE — in BOTH backends, each keeping its own
per-document state — and again by `server.js`, which never asks. The first and the last are
`server.js`'s alone, because only it decides what to load and what to serve. 29.1 sets out
the split and says why the store's half may never be left to the caller.

Both backends funnel every mutation through ONE gate that asserts readability immediately
before the call, and `npm run check:writes` (15) is what stops that arrangement decaying: it
reads both stores as code, with comments and string literals blanked out, and fails if a
mutating primitive — an `fs` call that creates, alters, moves or removes a file, or a
`POST`/`PATCH`/`PUT`/`DELETE` against any of the three tables — appears anywhere but inside
the marked gate, or if the check stops being the last statement before the call. Three
consecutive review rounds fixed this same defect in three different places and each fix was
correct about its line and wrong about its file; a guard whose correctness depends on
somebody remembering where to put it is a convention, and the convention is what failed.
The checker cannot prove the gate is CORRECT — `tools/crash.mjs` and the unread tests do
that against a real `EPERM` — only that nothing gets past it.

The store names the failure once per document, at error level, the moment it happens:

```
[시트지] <id>: 저널을 읽지 못했습니다 (EACCES: permission denied, open …).
         내용을 확인할 수 없어 이 문서는 손대지 않습니다. 원인을 고친 뒤 서버를 다시 시작하세요.
```

and boot adds the count and the ids, so nobody has to spot one line in a hundred:
`[시트지] 문서 N개를 읽지 못해 열지 않았습니다: <id, id…>`

A person who asks for a quarantined document is told it cannot be opened right now —
never `404`, which reads as "no such document" and invites making a new one on top of it.
What is pinned here is the SHAPE, not one sentence somebody will reword:

| where | answer |
|-------|--------|
| `GET /api/docs/:id` and every other document route | HTTP **503**, never 404, never 200 |
| that 503's JSON body | `{ error: 'doc_unreadable', docId, message, steps }` |
| a WebSocket frame naming the document | `{ t: 'error', code: 'doc_unreadable', docId, retry: true, message, steps, opId? }` |
| `GET /api/docs` | the document is still LISTED, with `unreadable: true` |

`message` is one short sentence a non-technical person can act on — today
`이 문서를 지금은 열 수 없습니다.` — and `steps` expands it: the work is still there, the
server failed to read it THIS TIME, a restart usually fixes it, tell the administrator if
it does not. Neither may carry an errno, a path, a stack or a key; those go to the log,
where the operator is. Both come from ONE definition in `server.js`, so the 503 and the
socket frame can never disagree.

`retry: true` on the frame is load-bearing and not optional: without it the client DROPS
the frame from its outbox, and the guard against losing acknowledged work would become the
cause of losing unacknowledged work. `code` lets a client explain once instead of once per
replayed frame.

Listing the document is deliberate too. Leaving it out of `GET /api/docs` would tell
somebody their spreadsheet is gone, which is false and is the fastest possible way to get a
replacement created on top of it.

#### Why nothing is written down

The quarantine lives in memory and a restart clears it. An in-memory guard is normally
worthless, and worse than worthless because it looks like protection — so here is the
reason this one holds:

**while a document is quarantined, nothing about it in the store can change.** No snapshot,
no append, no truncate, no delete — on the disk, that is no write to `<id>.json`, `<id>.log`
or the backup ring; in Postgres it is no `INSERT` into `sz_journal`, no upsert of
`sz_documents`, no `DELETE` against any of the three tables. The next boot therefore reads
the very same bytes, or queries the very same rows, and re-derives the same answer from
them: either the read succeeds — and replay is then CORRECT, because the snapshot's `rev`
never moved past the records the journal is still holding — or it fails again and the
document is quarantined again. The state is re-derived from the store every boot, never
remembered.

`rev` is the hinge. It moves only when a snapshot is written, and a snapshot is one of the
things being refused, so a quarantined document cannot acquire a `rev` that would make the
next boot's replay skip records it has not folded in. Refusing the snapshot is not one
refusal among four; it is the one that makes the other three re-derivable.

That is precisely what the earlier attempt got wrong, and it is worth writing down because
it looked right. It refused the truncate alone and let the document go on being served: the
`rev` climbed past the unread records, into snapshots that did not contain them; the next
boot then read the journal perfectly, replayed nothing — replay skips every record with
`rev <= doc.rev` — and truncated with a clear conscience. The guard did not fail. It
succeeded, and handed the deletion to the next boot. Refusing one destructive step is not a
quarantine; the document has to stop moving.

A durable marker — `data/<id>.unread`, or a row in a fourth table — was the alternative,
and it is rejected on both backends for the same two reasons. The store that could not
answer a read is the store that may refuse the marker, so the protection would be missing
exactly when it is needed; and a marker that outlives the fault is a permanent outage of
its own, a document nobody can bring back without deleting a file or running SQL by hand.
The stateless rule needs neither and cannot go stale.

Clearing a quarantine is a restart, once the operator has dealt with whatever held the
file or whatever the database was doing. That is the cheap side of the asymmetry this whole
section rests on: **failing loudly costs a restart; failing quietly costs somebody's
typing, permanently.** Where the two cannot be told apart, refuse.

One thing the refusal must not become is an outage in a costume. Only a read of a
document's STORED STATE quarantines — `loadDoc` and `readJournal`, the two whose answer a
caller would otherwise mistake for "absent" or "damaged". A failed WRITE does not: it wrote
nothing, the journal keeps everything, and the next debounce simply tries again. A transient
502 during a save must not cost a document until the next restart.

### 27.7 What is still not guaranteed

Stated plainly, because a durability claim with unstated holes is worse than none:

- A machine losing power within `FSYNC_MS` of a keystroke can still lose that keystroke.
  This is a property of the FILE backend only: a committed Postgres row has no equivalent
  window (29.3).
- `data/` living on one disk means that disk is a single point of failure; real safety
  needs an off-machine copy, which is what the Supabase backend provides (29). With no
  `SUPABASE_URL` configured, that single point of failure is still exactly what is running.
- The outbox protects a closed tab, not a wiped browser profile.
- A quarantined document (27.6) is unavailable until the server is restarted. Nothing in it
  is lost — that is the point — but the people who were editing it cannot get back in on
  their own, and no amount of retrying will change that. It is the price of the refusal, and
  it is paid deliberately.


---

## 28. Access control — a shared password

One password for the whole site. Anyone who knows it can read and write everything; there
are no per-user permissions. That is the scope the owner chose, and the README must say so
plainly so nobody mistakes it for per-user security.

The app is intended to go on the internet, which is what makes the details below
non-optional. A password that travels in clear text, or a gate that only covers HTTP while
the WebSocket stays open, is not a lock.

### 28.1 Configuration

Read from the environment, never from a file in the repository:

| variable | meaning |
|----------|---------|
| `SZ_PASSWORD` | the shared password. **Empty or unset disables the gate entirely** |
| `SZ_PASSWORD_HASH` | alternative to the above: `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>` |
| `SZ_SESSION_SECRET` | random string signing the session cookie |
| `SZ_SESSION_DAYS` | session lifetime in days, default 14, silently capped at 365 |

- Supplying `SZ_PASSWORD` in plain text is accepted for convenience; the server derives a
  scrypt hash at boot and never keeps the plaintext beyond that. `SZ_PASSWORD_HASH` is
  preferred for a real deployment, and `npm run hash-password` prints one. Both must
  therefore appear in `.env.example`, or the operator who follows this paragraph finds no
  line to fill in and deploys the plaintext instead — which is the outcome this bullet
  exists to prevent. `check-spec` holds the file to that in both directions: every
  `SZ_*` / `SUPABASE_*` name the shipped tree reads, plus `PORT`, must have a line in
  `.env.example` and be named in this document, and a line in `.env.example` that no
  shipped file reads is an error too.
- When BOTH are set, `SZ_PASSWORD_HASH` wins and `SZ_PASSWORD` is ignored. A
  `SZ_PASSWORD_HASH` that does not parse is FATAL: the server refuses to boot and says
  why. Neither carrying on with the gate off (which publishes every document) nor
  carrying on with the gate on (which locks everybody out) is an acceptable answer to a
  password the operator meant to set.
- When the gate is ON and `SZ_SESSION_SECRET` is missing, the server generates a random
  one at boot and warns loudly that every restart will log everyone out. It must not
  invent a silent default: a predictable signing key is the same as no key.
- The gate being OFF is logged at boot, every boot, in plain language.

### 28.2 Sessions

A stateless signed cookie, so no server-side session store is needed:

```
sz_session = <payloadB64>.<hmacB64>
payload = { exp: <epoch ms>, v: <token version> }
```

- `HMAC-SHA256` over the payload with `SZ_SESSION_SECRET`, compared in constant time.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` from `SZ_SESSION_DAYS`,
  and `Secure` whenever the request arrived over HTTPS. `app.set('trust proxy', 1)` so
  that is detected correctly behind a reverse proxy, which is how every host runs it.
- `v` is bumped by a config change, so rotating the secret or the password logs everyone
  out. That is the only revocation mechanism a stateless cookie can have, and the README
  says so.

### 28.3 What is protected

**Everything.** Not just the pages:

- Every route except the eight paths the gate opens BY NAME, and no others:

  | open path | why |
  |-----------|-----|
  | `/login` | the gate page itself |
  | `/login.html` | the same file by its real name |
  | `/api/login` | the form's endpoint (28.5) |
  | `/api/logout` | clearing a cookie must work even once the session has expired; a `401` here would bounce the user to the page they were already leaving for |
  | `/healthz` | the host's liveness probe, which has no session |
  | `/css/style.css` | the login page shares the app's stylesheet and tokens (28.5) |
  | `/js/login.js` | the login page's own module |
  | `/favicon.ico` | requested by the browser on the login page itself |

  `/js/login.js` is **not** optional and is the one a reader drops. `public/login.html`
  loads it as `<script type="module" src="/js/login.js">`, so a gate that leaves it closed
  answers that request with a `302` to `/login`, the submit handler never binds, and NOBODY
  CAN LOG IN — with no error anywhere, because a redirected module is not a failed request.

  Nothing outside that set is open. An unauthenticated visitor cannot pull down the editor,
  the document list, or any module under `/shared`.
- **The WebSocket upgrade.** This is the one that gets forgotten: a gate on HTTP alone
  leaves `/ws` open, and `/ws` can read and write every document in the system. The
  upgrade handler parses the cookie and destroys the socket before the handshake when it
  does not verify.
- An unauthenticated HTML request redirects to `/login?next=<path>`; an unauthenticated
  API request gets `401 {error:'auth_required'}` rather than a redirect, so the client can
  tell the difference and send the user to the login page itself.

### 28.4 Rate limiting

Per client IP: `MAX_LOGIN_ATTEMPTS` (10) failures in `LOGIN_WINDOW_MS` (15 minutes) →
`429` with a `Retry-After`, regardless of whether the next password is right. A successful
login clears the counter. The comparison itself is constant time, and the failure response
is identical whatever the reason, so nothing can be learned from timing or wording.

### 28.5 The login page

`public/login.html` + `public/js/login.js` — a small page with one password field, a
submit button and an error area. It shares `style.css` and the app's tokens.

- `POST /api/login` with `{ password, next }` → sets the cookie and answers
  `{ ok: true, next }`; the page navigates there. `next` is accepted only when it is a
  same-origin path beginning with a single `/`, so it cannot be used as an open redirect.
- `POST /api/logout` clears the cookie. The editor header gets a 로그아웃 button, shown
  only when the gate is on (`GET /api/version` reports `auth: true`).
- The page must not reveal whether a password is set, how long it is, or how many
  attempts remain beyond the rate-limit response.


---

## 29. Storage backends — files or Supabase

`data/` on one disk is a single point of failure: the machine it lives on is the only copy.
Section 27 made a crash survivable; this makes the DISK survivable, by letting the same
document store live in Postgres instead.

The two are chosen by configuration, never by code. With no `SUPABASE_URL` the server
behaves exactly as it does today — that is what every existing harness runs against, and
what someone running it locally gets without setting anything up.

### 29.1 The interface

`storage/index.js` picks a backend at boot and exports it. Both implement:

```js
export const name                                    // 'file' | 'supabase', for the boot log
export async function init()                         // create/verify whatever it needs
export async function listDocIds()                   // -> string[]
export async function loadDoc(id)                    // -> { doc, fromBackup, raw } | null; rejects if UNREAD
export async function saveSnapshot(id, doc)          // atomic replace + backup rotation
export async function appendJournal(id, record)      // -> boolean; DURABLE on true
export async function readJournal(id)                // -> { records, badLines }; rejects if UNREAD
export async function truncateJournal(id)            // after a snapshot, never before
export async function listBackups(id)                // -> [{ index, name, at, size }], newest first
export async function deleteDoc(id)                  // document, journal and backups
export async function flush()                        // before a clean exit
```

That is the MINIMUM. A backend may return an extra field or accept an extra optional
argument (29.3 names the two that exist), but only where a caller written to the signatures
above behaves identically without them — never as a field a caller has to notice to stay
safe, which is the mistake the next heading is about.

Every existing durability rule in section 27 is a property of this interface, not of the
file implementation: `appendJournal` resolving true means the record is durable, the
snapshot is written before the journal is truncated, and a boot loads the snapshot then
replays the journal on top.

`server.js` talks only to this interface. It must contain no `fs` call for document data
after this change.

#### A read that fails is a REJECTION, never a value

SPEC 27.6 defines three outcomes. This is where each one arrives at a caller:

| call | ABSENT | CORRUPT | UNREAD |
|------|--------|---------|--------|
| `loadDoc(id)` | `null` | the next readable copy, `fromBackup: true` | **rejects** |
| `readJournal(id)` | `{ records: [], badLines: 0 }` | the records that parsed, `badLines` counting the rest | **rejects** |
| `listDocIds()` | `[]` (no `data/` yet, no rows) | — | **rejects** |

`loadDoc` and `readJournal` reject for UNREAD and for nothing else, which is what lets a
caller read any rejection from them as *quarantine this document* without having to
classify it. The rejection carries:

```js
err.code === 'ESTOREUNREAD'   // a string, compared exactly like err.code === 'ENOENT'
err.docId                     // the document it is about
err.cause                     // the underlying error, so the errno survives
err.message                   // Korean, naming the document and the step that failed
```

Both backends stamp the tag themselves, and `storage/index.js` stamps it again on anything
that arrives untagged out of the three reads above. The belt and the braces are both wanted:
the backend's own tag is what a caller that imports `storage/fileStore.js` or
`storage/supabaseStore.js` DIRECTLY still gets, and `storage/index.js` is what guarantees
the shape for a backend added later that forgot. Callers may test the code; they must not
*require* it, because treating an untagged rejection as anything other than UNREAD is the
exact finding this contract exists to prevent.

**Why a rejection rather than a field on the result.** A field is ignorable by
construction, and it was ignored: every caller destructured `records` and `badLines` and
drew its conclusions from those two, so a third field would have changed nothing until each
call site was edited by hand — and the call site that mattered was the one nobody was
looking at. A rejection cannot be ignored. The default behaviour of a caller that has never
heard of UNREAD becomes "stop", which is the safe direction, and the unsafe reading has to
be written on purpose.

What quarantine (27.6) does to the rest of the interface, for a document that has produced
one UNREAD outcome in this process:

- `saveSnapshot`, `truncateJournal` and `deleteDoc` reject with the same `ESTOREUNREAD`.
  These are the three calls that can overwrite or destroy what was not read.
- `appendJournal` resolves `false`. It never throws: `false` is already its documented
  "not durable, do not acknowledge" answer, every call site handles it, and the client
  keeps the frame in its outbox (SPEC 27.4). A quarantined document accepts no new records
  because their `rev` numbers would collide with the unread ones already in the log.
- `listBackups` and `flush` are unaffected. Neither writes over anything: listing is
  read-only, and `flush` only makes bytes already written durable.
- `listDocIds` quarantines nothing. It names no document — finding out which ids exist is
  the very thing that failed — so it rejects with the tag and quarantines none of them.
  Boot stops on that rejection, which is the protection; a process-wide refusal invented
  here would be a behaviour neither backend's caller expects.
- The quarantine is never lifted inside the process, not even by a later successful read.
  Lifting it is what turned the previous guard into the deletion it was meant to prevent
  (27.6), and a restart re-derives it from the store for free.

Nothing here is optional for one backend. A store that cannot tell UNREAD from ABSENT
cannot honour SPEC 27 at all, whatever it does with the rest.

#### Which layer enforces what

Three layers, and the SPEC is precise about which one owes what, because a gap here is
invisible until a second caller walks into it:

| layer | what it is responsible for |
|-------|----------------------------|
| `storage/fileStore.js`, `storage/supabaseStore.js` | the quarantine itself: each keeps its own per-document unread state, set by a failed `loadDoc` or `readJournal`, checked by `saveSnapshot`, `truncateJournal`, `deleteDoc` and `appendJournal`, never lifted |
| `storage/index.js` | one shape for the rejection whichever backend produced it — `code`, `docId`, `cause` |
| `server.js` | the POLICY on top: which documents it puts in `docs`, the 503 and the socket refusal, the boot summary, and its own `unreadableDocs` map so a document quarantined mid-session stops being served immediately |

The store's guard is the one that must not be skipped. `server.js` is the only caller in the
tree today, and it will not be the last — a script run by hand, a backup job, an exporter —
and a caller that reimplements the guard is a caller that will one day get it wrong or
forget it entirely. That is not hypothetical: the guard existed only in `server.js` for one
round, the Supabase backend had no quarantine state at all, and the second caller that
existed then — the migration tool since removed (29.4) — inherited exactly the data loss the
interface was supposed to make impossible. Every new caller gets the refusals for free, and
a caller that does nothing at all about UNREAD still cannot destroy what it did not read.

That the tree is briefly down to one caller is not a reason to move the guard up into
`server.js`. The store is where it belongs precisely because the next caller is written by
someone who has not read this section.

`npm run check:writes` (15) enforces the store's half mechanically, so it survives editors
who have not read this either. It fails if any mutating primitive in `storage/fileStore.js`
or `storage/supabaseStore.js` — the `fs` calls that create, alter, move or remove a file,
and every `POST`, `PATCH`, `PUT` and `DELETE` on the wire — sits outside the one gate that
asserts readability immediately before it, if an `await` creeps between that assertion and
the call it guards, or, on the Supabase side, if a write reaches the database without naming
the document it changes. It reads executable text only: a `rename()` quoted in a comment
cannot fail the run, and an `unlink(` hidden in a template literal cannot pass it. It is
inside `verify` and is not an optional extra (15).

`server.js` keeping its own map is not redundancy to be tidied away. The store refuses one
operation at a time; `server.js` has to stop the document being SERVED, refuse to seat an
editor, keep the debounce from firing at all, and tell the people already sitting in it —
none of which a store can do, and all of which have to happen before the store's refusal
would ever be reached.


### 29.2 The file backend

`storage/fileStore.js` — exactly today's behaviour, moved: `data/<id>.json`, `<id>.log`,
`<id>.bak.1..5`, the debounced atomic snapshot, the fsync policy, the torn-tail guard.
Its tests are the existing ones; `node tools/crash.mjs` must keep passing unchanged.

How it draws the three lines of SPEC 27.6, since on a filesystem they are one `catch`:

- `ENOENT` is ABSENT, and only `ENOENT`. That is the ordinary "no journal yet", and the one
  instant inside `rotateBackups` when `<id>.json` has been renamed away and the temporary is
  not yet in its place — which is why `loadDoc` falling through to `<id>.bak.1` is safe for
  that errno and for no other.
- Bytes that arrived in full and will not `JSON.parse` are CORRUPT: a torn last journal line
  is counted in `badLines`, a damaged `<id>.json` falls through to the next backup. Nothing
  here is narrowed; a corrupt file is still recovered from exactly as it was.
- **Every other errno is UNREAD.** `EACCES`, `EIO`, `EBUSY`, `EPERM`, `EISDIR`,
  `ERR_FS_FILE_TOO_LARGE` and anything else `readFileSync` can raise mean the file is there
  and this process failed to see it.

`loadDoc` scans `<id>.json` and then the backups newest-first, and that scan **stops at the
first file it could not read**. Descending past an UNREAD file is what would substitute an
older backup for a newer snapshot that was merely busy, and the save that follows would then
rotate the newer one off the end of the ring. Descending past an ABSENT or a CORRUPT file is
still correct, because in both cases the process has seen what is there.


### 29.3 The Supabase backend

`storage/supabaseStore.js` — PostgREST over `fetch`. No client library, no new dependency.

| variable | meaning |
|----------|---------|
| `SUPABASE_URL` | `https://<project>.supabase.co`. Its presence selects this backend |
| `SUPABASE_SERVICE_KEY` | the project's SECRET key: a current `sb_secret_…` (the dashboard's `Secret keys`, preferred) or a legacy `service_role` JWT. **Server only.** Never a `Publishable key` / `anon` key — those have no privileges here |
| `SUPABASE_SCHEMA` | optional, defaults to `public` |

Three tables, created by `docs/supabase.sql` which the operator runs once:

```sql
sz_documents (id text primary key, doc jsonb not null, rev bigint, updated_at bigint)
sz_journal   (seq bigserial primary key, doc_id text not null, rec jsonb not null, at bigint)
sz_backups   (seq bigserial primary key, doc_id text not null, doc jsonb not null, at bigint)
```

Rules:
- `appendJournal` inserts one `sz_journal` row and resolves true only on a 2xx. A committed
  row IS durable, so there is no fsync equivalent and no window to lose — this backend is
  strictly safer than the file one, and the boot log says which is in use.
- `saveSnapshot` upserts `sz_documents`, inserts a `sz_backups` row, and deletes backups
  past the newest `BACKUP_COUNT` for that document.
- `truncateJournal` deletes that document's `sz_journal` rows up to the highest `seq` the
  snapshot included — **never a blanket delete**, or a record appended during the snapshot
  would be lost.
- The key rides on `apikey` on EVERY request, and on `Authorization: Bearer` only when it
  is a legacy JWT. That rule is not simplifiable and the heading below is why. The key
  itself is never logged, never sent to the browser and never put in an error message or a
  response; its FORMAT is logged once at boot, its value never — not even a prefix.
- The service key bypasses RLS, so the SQL enables RLS with NO policies on all three
  tables: the browser-safe key of the pair — `sb_publishable_…` today, `anon` before it,
  both resolving to the `anon` Postgres role — can then do nothing at all. It also
  `revoke all ... from anon, authenticated` on each table, which is a second lock rather
  than a restatement of the first — RLS turned off by a later hand, or a policy added by
  somebody who read the dashboard's "no policies" warning as a fault, still finds no grant
  behind it. Both halves ship in `docs/supabase.sql`, and a reader who rebuilds that file
  from this section must write both. `init()` verifies only that the three tables exist
  with the columns above; it cannot see the grants, so nothing at runtime will notice their
  absence.
- A network failure is a failure: `appendJournal` resolves false, the operation is not
  acknowledged, and the client keeps it in its outbox (SPEC 27.4). It must never resolve
  true on a request it did not confirm.
- Retry a failed request twice with a short backoff before giving up, since a transient
  502 from a hosted database is ordinary.
- A response this process could not READ is a failed request, never an empty result. `no
  rows` is a fact about the database and compaction is allowed to delete against it; an
  unreadable answer is not, and a 2xx with a damaged body throws rather than resolving to an
  empty list.

#### Which headers carry the key — and why that depends on the key

Supabase issues two generations of key and both work against the same project at the same
time. All four exist in the dashboard today:

| what the dashboard calls it | shape | what it is | ours? |
|---|---|---|---|
| `Secret keys` | `sb_secret_…` | an opaque string, **not a JWT**; resolves to the `service_role` Postgres role, which has BYPASSRLS | **yes — prefer this** |
| `Publishable key` | `sb_publishable_…` | opaque, browser-safe, resolves to `anon` | no — no privileges here |
| legacy `service_role` | `eyJ…`, a signed JWT | the previous secret key. Still accepted; Supabase deprecates the legacy pair at the END OF 2026 | yes, still works |
| legacy `anon` | `eyJ…`, a signed JWT | the previous browser key | no — no privileges here |

The rule, decided from the KEY ITSELF and never from a setting an operator has to
understand:

> `apikey: <key>` on every request, always. `Authorization: Bearer <key>` **only when the
> key is a JWT.**

`apikey` is what the gateway resolves to a Postgres role, and for a secret key that role is
`service_role` with BYPASSRLS — the whole privilege, out of that one header, exactly as the
legacy key had it. `Authorization: Bearer` is what PostgREST itself authenticates with, so
for a legacy key it is not decoration: dropping it is how a deployment that works today
stops working.

Sending it for a NEW key is the mirror-image mistake, and it is why "send both and be safe"
is wrong rather than merely untidy. The current keys are not JWTs, and anything that tries
to verify one as a JWT fails — so a `Bearer` header carrying `sb_secret_…` hands the far
end a token it cannot check, and the header meant to authenticate the request becomes the
header that refuses it. The cost of getting this backwards is not abstract: it locks out
precisely the operator standing in front of today's dashboard, whose only non-legacy option
is the key that must not be sent that way.

A key counts as a JWT when it has the SHAPE of one — three dot-separated base64url segments
whose first begins `eyJ`, which is what `{"` encodes to. The decision is made on that shape
and NOT on a list of prefixes, so a key form Supabase mints after this was written is
handled correctly the day it appears: "not a JWT" is the safe side, and `apikey` alone is
what the new system wants. `sb_secret_` and `sb_publishable_` are recognised for one
purpose only — to NAME what was configured in the boot log. The classification runs once,
when the configuration is read; no request re-examines the key.

Two things follow from reading the key at all, and the first of them is a refusal rather
than a warning:

- **A key with no privileges is refused at BOOT**, before any request goes out: a
  `sb_publishable_…` key, and a legacy JWT whose `role` claim is `anon`. Both are valid
  keys the gateway accepts, and both resolve to `anon` — the role this section's own SQL
  leaves with RLS on, no policies and no grants. A server started on one would boot, serve
  the login page, seat people in a document and refuse every write: a site that runs and
  cannot save, which is the hardest failure to read from the outside and the one that
  quietly costs somebody's typing. Failing loudly costs a restart — 27.6's asymmetry, in
  the configuration layer. **Nothing else is refused.** A shape this code has never seen is
  used as configured, because refusing on a guess is an outage in the costume of caution.
- **`role` is read out of the JWT's payload** — the middle segment, base64url and not the
  part that makes a JWT a secret — for that one comparison, and the answer is narrowed to
  the two role names Supabase mints. A payload that will not decode, or that names a role
  this code does not know, is left alone. Nothing decoded is ever printed.

What the boot log carries is the FORMAT and never the value: `레거시 JWT 키
(service_role)`, `새 형식 비밀 키 (sb_secret_)`, and which headers that format will be sent
on. It is what lets an operator tell a wrong-key problem from a wrong-URL problem without
pasting a secret to anybody, and it is the only thing about the key that any log, error or
response may ever carry.

How it draws the three lines of SPEC 27.6, which on PostgREST are not one `catch`:

- **ABSENT** is a 2xx carrying no matching row. A fact about the database: create it, serve
  it empty, carry on, delete against it.
- **CORRUPT** is a row that arrived IN FULL whose `jsonb` is not usable — a `doc` that
  `sanitizeDoc` refuses, a `rec` that is not an object. Skipped and counted exactly as the
  file store skips a line that will not parse, and `loadDoc` falls through to the next
  backup. One bad row must never cost the whole document.
- **UNREAD** is everything that stops this process from seeing what the rows hold: a
  timeout, a dropped connection, a 4xx, a 5xx that survived its retries, a 2xx whose body
  will not parse, a `GET` that answered with something other than a row list, and a paging
  walk that could not prove it reached the end. The rows ARE there and we failed to read
  them.

`loadDoc` asks for the backups in ONE query rather than one per copy, so there is no scan to
descend — but the rule is the file backend's rule all the same: a failure of the
`sz_documents` query or of the `sz_backups` query aborts `loadDoc` and quarantines, and only
a query that SUCCEEDED and matched nothing usable may produce `null`. Substituting an older
copy for a newer one this process could not read is the same silent rollback either way.

The quarantine of SPEC 27.6 is implemented HERE, in the backend, not only in `server.js`
(29.1). `loadDoc` and `readJournal` mark the document on any UNREAD outcome and never
unmark it; `saveSnapshot`, `truncateJournal` and `deleteDoc` reject for a marked document
and `appendJournal` resolves `false`. Nothing inside a WRITE marks, `saveSnapshot`'s own
high-water-mark read included: it failing means nothing was written, the caller does not
truncate, the journal keeps everything and the next debounce retries — quarantining on it
would turn one transient 502 into a document nobody can open until a restart.

The state is a per-process map with no row behind it, and it holds across a restart for the
same reason the file backend's does, stated in database terms: while a document is marked,
this backend issues no statement that touches it — no `INSERT` into `sz_journal`, no upsert
of `sz_documents`, no `INSERT`, prune or `DELETE` on `sz_backups`, no `DELETE` anywhere. Not
one tuple for that document is created, replaced or removed, so the next boot queries the
same rows and re-derives the same answer. `rev` moves only in `saveSnapshot`, and refusing
that one statement is what stops the stored snapshot advancing past journal rows nobody
read — which was the whole mechanism of the loss this exists to prevent.

The refusal is worth MORE here than on a disk, not less. `sz_documents` holds one row per
document and the upsert REPLACES it; there is no rename putting the unread copy safely into
a backup ring first, so a snapshot written over an unread document would leave its stored
value nowhere but `sz_backups`, whose insert is explicitly best-effort. There is nothing to
roll back to.

Two additions to the SPEC 29.1 signatures, used by neither `storage/index.js` nor
`server.js` and available to a caller that talks to this backend directly:
`readJournal` also returns `seq`, the journal seq the read is CERTAIN to have covered, and
`truncateJournal(id, upTo)` accepts that seq back and deletes to the LOWER of it and the
snapshot's own mark. Both may only ever understate. A caller that ignores them gets exactly
the SPEC 29.1 behaviour.

### 29.4 Switching backends — there is no migration tool

`SUPABASE_URL` picks the backend at boot (29.1) and that is the ENTIRE switch. Setting it
points the server at a project whose three tables are empty.

**What the operator sees first is NOT an empty document list.** Boot seeds a starter
document into any store it finds empty, and that code runs for EVERY backend — `server.js`
calls `storage.init()`, loads what is there, and creates `createStarterDoc()` when it read
zero documents and quarantined none. So a brand-new Supabase project shows exactly one
document: `시작 시트`, two sheets, made of sample sales figures, on the FIXED id `start1`,
with `[시트지] 시작 문서를 만들었습니다: 시작 시트 (start1)` in the boot log. Nothing was
copied from `data/` — the seed wrote it, seconds ago, into the empty tables.

This has to be said here and in the README and in `docs/supabase.sql`, all three, because
`start1` is also the id the file backend's own starter took: an operator told to expect an
empty list instead finds a document holding somebody else's numbers under the same id as
their `data/start1.json`, and the only readings available to them are "my data half
arrived" and "my data was overwritten". Both are false and both invite exactly the wrong
next action. The seed is also what makes the LIST non-empty while every real document is
still only in `data/` — the emptiness of the tables is a fact about the store, not about
the screen. Nothing copies itself across, in either direction:

- `data/` is not read, not written, not renamed and not deleted. `storage/index.js`
  forwards every call to the CHOSEN backend, so with Supabase selected `fileStore.init()` is
  never called and no code path reaches the folder — not even to create it. Every snapshot,
  journal and backup in it stays byte for byte what it was, and clearing `SUPABASE_URL`
  brings all of it straight back. That is a property of the forwarding, not a promise made
  in prose.
- A document that exists in `data/` does not exist in Postgres until a person puts it there.
- The seeded starter is written INTO the chosen backend, like any other document. It is not
  a view of `data/start1.json` and shares nothing with it but the id; deleting it touches no
  file.

**There is no `npm run` script and no file under `tools/` that moves documents between the
two.** One existed and was deleted, and re-adding one is new work held to 27.6, not the
restoration of a file. The reasons are recorded because they are the ones that would be
forgotten first: the tool was run once, by hand, on real data, with no undo, and two review
rounds found five verified defects in it — among them a report that said 복사됨 for a
document the same run had made unreachable, a line that said 아무것도 쓰지 않았습니다
printed after the destructive write had already landed, and a newer document at the
destination rolled back to an older local file. Set against a `data/` folder holding one
document, deleting it removed more risk than capability.

What replaces it is the operator carrying content over BY HAND, which is possible because
the clipboard payload is an interchange format (26.2). Two 시트지 tabs, `Ctrl+A`,
`Ctrl+C`, `Ctrl+V`: the destination takes the external path — the internal clipboard is
per-window — so `parseExternalHtml` reads the `text/html` table `serializeSelection` (12)
wrote. What survives is therefore fixed by those two functions and by nothing else, and the
README may promise exactly this and no more:

| carried across | NOT carried across |
|----------------|--------------------|
| cell values | merged cells: `serializeSelection` emits no `colspan`/`rowspan`, which is 21.6 restated from the writing end |
| formulas, verbatim in the markup as `data-sz-input` | number formats: `fmt` and `decimals` have no CSS to travel in, so a currency cell arrives as its raw number |
| relative references, translated against `data-sz-origin` | `wrap` and `rot`, for that same reason |
| bold, italic, underline, strike-through, horizontal and vertical alignment, text colour, fill colour, font, font size and the four borders — the keys `styleToCss` writes | cell HYPERLINKS. `link` is a cell field and not a style key (23.4), so `styleToCss` never sees one, `serializeSelection` emits no `<a>` and no attribute carrying it, `cellFrom` reads none back, and every entry `pasteInto` writes is `{ input, style }` with no `link` key at all. The anchor TEXT arrives; the destination does not |
|  | column widths, row heights, frozen panes, filters, charts, comments, sheet names and tab colours: sheet-level state that was never on the clipboard |

The hyperlink row is the one that fails WORST, so it is spelled out rather than left in a
cell: `reportImport` (`main.js`) says `(서식 포함)` for any paste that carried styles, so a
person moving a document watches a confident "formatting included" toast while every link
in it is dropped, with the visible text unchanged and nothing on screen different. It is
also the only entry here that a reader could mistake for present, because the anchor text
survives the trip unchanged. The mechanical version of this row: the string `link` appears
in `public/js/clipboard.js` **zero** times. That is the whole finding, and it is one grep.

Two limits belong here rather than only in the README, because both fail SILENTLY and both
are properties of code this document already pins:

- `pasteInto` writes one patch entry per source cell, blanks included, and `main.js` refuses
  a patch above `MAX_EDIT_CELLS` (20000) with a toast and pastes nothing. `Ctrl+A` selects
  the whole grid rather than the used range, so a sheet wider or taller than that cap has to
  be carried in blocks.
- `pasteInto` clips to the target sheet's own `rows`/`cols` and drops what falls outside
  with no message. A destination sheet must be grown (25.4) to the source's extent BEFORE
  the paste, or the columns past its width are gone with nothing on screen to say so.
- A paste writes `{ input, style }` and no `link` key at all, so a link ALREADY on a
  destination cell survives the paste and stays pointing where it did — new text, old
  target. Nothing here creates that; it is stated so the row above is not read as "links are
  cleared".

### 29.5 Testing without a project

`tools/fakesupabase.mjs` is a minimal PostgREST stand-in over the three tables, kept in
memory, with fault injection for the failures that matter: a request answered with a status
it chose, a connection dropped with no answer at all, and a 2xx whose body is damaged after
the write has really happened — the last aimable at one table, verb and document, so a case
about one document's journal cannot quietly become a case about another's.

It also models the AUTHENTICATION the two key systems produce, because the header rule
above is otherwise untestable without somebody's real project: `apikey` is required on
every request, `Authorization` is OPTIONAL, a bearer token that is not a JWT is refused the
way PostgREST refuses one it cannot verify, and a key that resolves to `anon` is refused
for want of privileges — a project built by `docs/supabase.sql` grants it nothing. The
asymmetry is deliberate. Stricter than the real service fails a store that is correct and
sends somebody hunting for a bug that is not there; looser than it blesses a configuration
that will fail on the operator, in front of their data. Where the stand-in cannot know, it
keeps the real misconfiguration failing.

`tools/crash.mjs` runs its whole shared suite twice — once against `data/`, once against
the stand-in — and then the cases that only one backend can have: a real file made
unreadable by the operating system for the file store, and a refused write, a row appended
during a snapshot and an unreadable response body for Supabase. So the durability guarantees
are verified for BOTH backends without needing anyone's credentials, and the real project is
a configuration change rather than an untested code path.
