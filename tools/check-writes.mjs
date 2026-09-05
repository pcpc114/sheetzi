#!/usr/bin/env node
/**
 * The mutation-gate checker.  `npm run check:writes`, and part of `npm run verify`.
 *
 * WHY THIS FILE EXISTS
 *
 * SPEC 27.6 says a document whose stored state could not be READ is never served, never
 * replayed against, never truncated and never overwritten. Three consecutive review rounds
 * found the same defect in three different places, and each round it was fixed at the place
 * that was found:
 *
 *   round 4  the check sat at the function entry, before `await state.chain` — so a
 *            quarantine arriving during the wait was invisible and deleteDoc ran anyway;
 *   round 5  the check moved inside the queued task — and `writeSnapshot` still checked,
 *            then awaited `rotateBackups`, then renamed the temporary into place with
 *            nothing asked in between; `appendJournal` still checked, then awaited an open
 *            and wrote the record; `saveSnapshot` on Supabase still checked, then upserted,
 *            INSERTed a backup and ran a prune DELETE, all unasked.
 *
 * Every one of those fixes was correct about the line it touched and wrong about the file.
 * A guard whose correctness depends on somebody remembering where to put it is a
 * convention, and a convention is what failed three times. So both stores now funnel every
 * mutation through ONE place that asks immediately before the call and again after it, and
 * this checker is what stops the arrangement decaying back:
 *
 *   1. the mutating primitives appear ONLY inside the marked gate of each store, with a
 *      short allowlist of exact, non-mutating exceptions;
 *   2. the gate's own shape holds — the check is the LAST statement before the call, with
 *      no `await` between them, and the ack-rule re-check follows the call;
 *   3. on the Supabase side, every write names the document it changes, so a new call site
 *      cannot reach the database anonymously;
 *   4. neither store imports anything that could open a second way out — neither a module
 *      nor, inside an allowed module, a BINDING that was not there before.
 *
 * WHAT IS MATCHED, AND WHY IT IS THE NAME RATHER THAN THE CALL
 *
 * An earlier version of this file looked for `unlink(` — a bare identifier followed by an
 * opening parenthesis. Every one of these then reached the disk with the run exiting 0:
 *
 *     const nuke = unlink; await nuke(p);      const ops = { u: unlink }; await ops.u(p);
 *     await withRetry(unlink, p);              await unlink?.(p);          await (unlink)(p);
 *
 * and on the network side `const send = fetch; await send(url)`. The call syntax is not the
 * thing that matters; the NAME is. So a mutating primitive is now matched as an identifier
 * in ANY position — passed as an argument, stored in an object, aliased, optional-called,
 * parenthesised — and it may appear only on a line inside the gate, on a line a declared
 * exception covers, or in the `import` that binds it. Nothing else in either store may so
 * much as MENTION it.
 *
 * The set of names is not a fixed list either, because a fixed list is a list somebody has
 * to remember to extend: it omitted `cp`, `link` and `symlink`, and adding `cp` to the
 * existing `node:fs/promises` import bought an ungated overwrite of any document — exactly
 * what SPEC 27.6 forbids, since `cp` destroys its destination without reading it. Every
 * binding a store imports from `node:fs` or `node:fs/promises` is therefore treated as a
 * mutator UNLESS it is in the short list of names that provably change nothing
 * (`FS_READ_ONLY`). A binding nobody has thought about yet is gated by default.
 *
 * It reads code, not comments and not strings: the file is first blanked down to executable
 * text with the line and column layout preserved, so a sentence about `rename()` in a
 * comment cannot fail the check and a `unlink(` hidden in a template literal cannot pass it.
 * That rule governs the IMPORT scan too — it used to read the raw text, so an import inside
 * a block comment failed the run, which is the same mistake in the other direction.
 *
 * The same rule governs the EXCEPTIONS, and it did not always. A declared exception is
 * matched against the raw line — a call's own arguments are strings, and blanking them
 * would leave nothing to write an exception about — but an occurrence licenses only a call
 * whose characters lie INSIDE it. Merely appearing somewhere on the line is not enough, and
 * that gap was real: a comment quoting the exception text licensed any raw mutating call
 * that shared its line, which is the exact opposite of the property stated above.
 *
 * And it checks ITSELF, on every run. A set of fixtures goes through the same reader — the
 * call hidden in a comment, in a string, in a template literal, in a substitution, the one
 * standing beside a legitimate exception, the one chained onto it, and every indirection
 * listed above — and the run fails if any disguise gets through or any honest line is
 * reported. A checker nobody has tried to defeat is not a checker.
 *
 * WHAT THIS CHECKER DOES NOT CLAIM
 *
 * Said plainly, because a guard with unstated holes is worse than none:
 *
 *   - It does not prove the gate is CORRECT, only that nothing bypasses it. The two
 *     `assertReadable` calls inside the gate are what `tools/crash.mjs` and the unread tests
 *     exercise against a real EPERM and a held request.
 *   - It is a reader of two files, not of the program. A mutator that arrives through a
 *     THIRD module — `import { save } from '../shared/x.js'` where that module wraps
 *     `unlink` — is invisible here: the name never appears in either store. The import
 *     allowlist is what holds that line, and it is why adding to it is a decision.
 *   - A computed member access whose key is a VARIABLE (`handle[k](buf)`, `globalThis[g]`)
 *     is undecidable by any reader that does not run the program. A key written as a
 *     literal is refused (see `findDisguises`), and so is one assembled out of pieces, but
 *     `obj[k]` where `k` was computed elsewhere is not, and cannot be.
 *   - It reads two files and the names in them. It says nothing about `server.js`, which
 *     SPEC 29.1 holds to its own half of the guard.
 *
 * Exit 0 and a count of checks passed, or exit 1 and a list of problems.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// what is forbidden, and where the exceptions are
// ---------------------------------------------------------------------------

/**
 * The `node:fs` names that change nothing: reads, and the metadata calls beside them.
 * SPEC 29.1 requires a quarantined document to stay READABLE and listable, which is the
 * whole reason this list exists rather than "everything from fs is forbidden".
 *
 * Everything a store imports from `node:fs` or `node:fs/promises` that is NOT named here is
 * treated as a mutator. That direction is deliberate: a list of mutators has to be extended
 * by somebody who remembers to, and the one that shipped had no `cp`, `link` or `symlink` in
 * it. `open` is absent on purpose — its flags decide whether it creates or truncates, so it
 * is gated and the store's read-only use of it is a declared exception written out in full.
 */
const FS_READ_ONLY = new Set([
  'access', 'accessSync', 'constants', 'createReadStream', 'exists', 'existsSync',
  'fstat', 'fstatSync', 'glob', 'globSync', 'lstat', 'lstatSync', 'openAsBlob',
  'opendir', 'opendirSync', 'read', 'readSync', 'readv', 'readvSync',
  'readFile', 'readFileSync', 'readdir', 'readdirSync', 'readlink', 'readlinkSync',
  'realpath', 'realpathSync', 'stat', 'statSync', 'statfs', 'statfsSync',
  'unwatchFile', 'watch', 'watchFile',
]);

/**
 * The file store's mutating surface, as NAMES rather than as call syntax: every `node:fs`
 * entry point that can create, alter, move or destroy a byte, plus the FileHandle methods
 * that do the same. Each is matched as a whole identifier anywhere in the file's executable
 * text — `a.handle.write(...)`, `{ u: unlink }` and `withRetry(unlink, p)` are all mentions
 * of a mutator and all have to be inside the gate.
 *
 * This list is the floor, not the ceiling: the imports of the file under test add to it
 * (see `bindingsOf`), so it stays right when `node:fs` grows a name nobody here has heard
 * of. It is kept as a floor so that a file whose imports this reader failed to parse is
 * still checked against the names that matter, rather than silently checked against none.
 */
const FS_MUTATOR_NAMES = [
  'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync', 'createWriteStream',
  'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync',
  'lchmod', 'lchown', 'link', 'linkSync', 'lutimes', 'lutimesSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'open', 'openSync',
  'promises', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'unlink', 'unlinkSync',
  'utimes', 'utimesSync', 'write', 'writeSync', 'writeFile', 'writeFileSync',
  'writev', 'writevSync',
];

/**
 * The Supabase store's mutating surface is the transport, because every statement it can
 * issue is an HTTP request. `fetch` is the only way out of the process and must stay that
 * way; the rest are the ways somebody might add a second one. Names again, not call syntax:
 * `const send = fetch` is a mention of `fetch`.
 */
const NET_MUTATOR_NAMES = ['fetch', 'Request', 'XMLHttpRequest', 'WebSocket', 'EventSource'];

const NET_PATTERNS = [
  ['http.request', /\.request\s*\(/],
  ['net.connect', /\bconnect\s*\(/],
];

/**
 * Ways to reach a name without writing it. None of them appears in either store, none has
 * any business appearing there, and each one would defeat every rule above: `globalThis`
 * reaches `fetch` under any spelling, `eval` and `Function` build code out of text,
 * `require` / `createRequire` open a second module system this reader does not follow, and
 * `Reflect` fetches a property by a string this reader cannot evaluate. Refusing `Reflect`
 * by name closes one spelling of that last family, not the family: see the header.
 */
const ESCAPE_HATCHES = [
  ['globalThis', /\bglobalThis\b/],
  // Node's own alias for globalThis. `global[k](url, init)` issued a real DELETE while the
  // identical line spelled `globalThis` was refused. The word boundary keeps this from
  // matching inside `globalThis` itself.
  ['global', /\bglobal\b/],
  ['Reflect', /\bReflect\b/],
  ['eval', /\beval\b/],
  ['Function', /\bFunction\b/],
  ['require', /\brequire\b/],
  ['createRequire', /\bcreateRequire\b/],
  ['.constructor', /\.\s*constructor\b/],
  ['process.binding', /\bprocess\s*\.\s*binding\b/],
  // Loads node:fs synchronously and produces NO import statement, so the import allowlist —
  // which the header names as the defence against a mutator arriving from a third module —
  // never sees it. Verified deleting a real file with the checker exiting 0.
  ['process.getBuiltinModule', /\bgetBuiltinModule\b/],
];

/** The specifiers whose bindings are classified by `FS_READ_ONLY` rather than trusted. */
const FS_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);

const TARGETS = [
  {
    file: 'storage/fileStore.js',
    // MUTATORS is the gate's own table. Exporting it by name (`export const RAW = MUTATORS`)
    // hands every raw, ungated primitive to any importer — the same act that is refused when
    // spelled `export { unlink } from 'node:fs/promises'`. It appears only inside the gate.
    names: [...FS_MUTATOR_NAMES, 'MUTATORS'],
    patterns: [],
    // Exact source text, matched against the blanked code. Each one is a call that cannot
    // change a document: written out in full so that editing it fails this check and has
    // to be justified again.
    exceptions: [
      // The torn-tail guard opens the journal READ-ONLY to look at its last byte. Reading
      // is not writing, and a quarantined document must still be readable (SPEC 29.1).
      "open(journalPath(id), 'r')",
      // Creates data/ at boot. It names no document and cannot alter one.
      'mkdir(DATA_DIR, { recursive: true })',
    ],
    imports: ['node:fs', 'node:fs/promises', 'node:path', 'node:url', '../shared/model.js'],
    // The gate's shape: the check is the last statement before the call, and the ack-rule
    // re-check follows it. Written as source patterns so that inserting an `await` between
    // them — which is exactly how round 5 was defeated — fails here.
    shape: [
      ['the check is the last statement before the mutating call', /assertReadable\(id\);\s*const result = await run\(args\);/],
      ['the ack-rule re-check follows the mutating call', /const result = await run\(args\);\s*try\s*\{\s*assertReadable\(id\);/],
    ],
  },
  {
    file: 'storage/supabaseStore.js',
    names: NET_MUTATOR_NAMES,
    patterns: NET_PATTERNS,
    exceptions: [],
    imports: ['../shared/model.js'],
    shape: [
      ['the check is the last statement before the request goes out', /if \(guardId !== null\) assertReadable\(guardId\);\s*const res = await fetch\(/],
      ['the ack-rule re-check follows the response', /const text = await res\.text\(\);\s*if \(guardId !== null\) assertReadable\(guardId\);/],
    ],
  },
];

const GATE_BEGIN = '>>> MUTATION GATE';
const GATE_END = '<<< MUTATION GATE';

/**
 * How many lines a gate may span. Everything inside the gate is allowed, so the cheapest
 * way to make this checker say OK about a call it objects to is not to move the call — it
 * is to move the `<<< MUTATION GATE — end` marker down past it. A gate is a small region
 * one person can read in one sitting (today: 47 lines and 26), and a bound is what keeps it
 * one. It is generous on purpose: this must never be the reason an honest edit fails.
 */
const MAX_GATE_LINES = 120;

/**
 * The files under `storage/` that are not a document store and therefore have no gate.
 * `index.js` picks a backend and re-stamps its rejections (SPEC 29.1); it writes nothing.
 * Everything else in that directory is a store and has to be declared in TARGETS, or a
 * third backend added later would be the one file in the tree nobody checks.
 */
const NOT_A_STORE = new Set(['index.js']);

// ---------------------------------------------------------------------------
// code, without the comments and without the string contents
// ---------------------------------------------------------------------------

/**
 * Blank out every comment and the inside of every string, template and regular expression,
 * replacing each removed character with a space so that line and column numbers still line
 * up with the original file.
 *
 * Both directions matter. A comment explaining why `rename` moved must not fail the check —
 * this file is full of such comments and so are the two stores. And a call hidden inside a
 * template literal must not pass it, which is why `${ ... }` is followed back into code
 * rather than being blanked wholesale.
 */
function codeOnly(src) {
  const out = Array.from(src);
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // `templates` holds the brace depth at which each open template resumes.
  const templates = [];
  let depth = 0;
  let i = 0;
  let lastSignificant = '';

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      let end = src.indexOf('*/', i + 2);
      end = end < 0 ? src.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') break; // an unterminated string; stop rather than run on
        j++;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      lastSignificant = 'x'; // a string is a value, so a following `/` is division
      continue;
    }
    if (c === '`') {
      out[i] = ' ';
      templates.push(depth);
      depth = 0;
      i++;
      // Blank the literal part until `${`, a `\``, or an escape.
      let j = i;
      while (j < src.length) {
        if (src[j] === '\\') {
          blank(j, j + 2);
          j += 2;
          continue;
        }
        if (src[j] === '`') {
          out[j] = ' ';
          depth = templates.pop() ?? 0;
          j++;
          break;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          blank(j, j + 2);
          j += 2;
          break; // back to ordinary code until the matching '}'
        }
        if (src[j] !== '\n') out[j] = ' ';
        j++;
      }
      i = j;
      lastSignificant = 'x';
      continue;
    }
    if (c === '{') {
      depth++;
      lastSignificant = '{';
      i++;
      continue;
    }
    if (c === '}') {
      if (depth === 0 && templates.length) {
        // The end of a `${ ... }`: blank on until the template resumes or ends.
        out[i] = ' ';
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === '\\') {
            blank(j, j + 2);
            j += 2;
            continue;
          }
          if (src[j] === '`') {
            out[j] = ' ';
            depth = templates.pop() ?? 0;
            j++;
            break;
          }
          if (src[j] === '$' && src[j + 1] === '{') {
            blank(j, j + 2);
            j += 2;
            break;
          }
          if (src[j] !== '\n') out[j] = ' ';
          j++;
        }
        i = j;
        lastSignificant = 'x';
        continue;
      }
      depth--;
      lastSignificant = '}';
      i++;
      continue;
    }
    if (c === '/' && startsRegExp(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break;
        j++;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      lastSignificant = 'x';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out.join('');
}

// A `/` after one of these is the start of a regular expression, not a division. After an
// identifier, a number, `)` or `]` it is division.
function startsRegExp(prev) {
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
}

// ---------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------

const problems = [];
const ok = [];
let checks = 0;

/** The offset each line starts at, so a match's COLUMN is a subtraction rather than a scan. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** The 0-based line that `index` falls on. */
function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A whole-identifier match, which is the only way a mutating primitive may be named. */
function identifierPattern(name) {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
}

/**
 * The declared exception whose occurrence in `source` COVERS columns [from, to) — or null.
 *
 * Covering is the whole point. The exception is looked for in the RAW line, because a call
 * carries string arguments and the blanked text has none of them left to write an exception
 * about — so the raw line is also where a comment or a string quoting that same text lives.
 * An occurrence that does not contain the call's own characters is one of those, and it
 * licenses nothing: the call it was pretending to justify sits at other columns entirely.
 *
 * Every occurrence is tried rather than only the first, because the same exception may
 * legitimately appear twice on one line.
 */
function coveringException(source, exceptions, from, to) {
  for (const text of exceptions) {
    for (let at = source.indexOf(text); at >= 0; at = source.indexOf(text, at + 1)) {
      if (at <= from && to <= at + text.length) return text;
    }
  }
  return null;
}

/** The index of the `]` closing the `[` at `open`, or -1. Strings are blanked, so none hides. */
function closingBracket(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '[') depth++;
    else if (code[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// A `[` after one of these opens an array literal or a destructuring pattern, not a member
// access, however word-like the character before it looks.
const BRACKET_KEYWORDS = /(^|[^\w$])(await|case|const|default|delete|do|else|export|from|in|instanceof|let|new|of|return|typeof|var|void|yield)$/;

/**
 * Member accesses that spell a property name out as a literal instead of writing it —
 * `handle["write"](buf)`, `globalThis["fe" + "tch"](url)`, `h[`write`](buf)`. Blanking takes
 * the literal's characters away, so the give-away is a bracket whose contents are blank in
 * the code but quoted in the raw text.
 *
 * Two shapes are refused and one is allowed, and the line between them is exactly whether
 * the name COULD have been written plainly:
 *
 *   - one string literal that is a valid identifier — `x["write"]` — is refused: it is
 *     `x.write` written in a way this reader (and a person skimming) would not see;
 *   - a key assembled out of pieces — `x["fe" + "tch"]`, `x["wr" + suffix]` — is refused,
 *     because no honest property name needs assembling;
 *   - one string literal that is NOT a valid identifier — `headers['Content-Type']` — is
 *     allowed, because there is no other way to write it.
 *
 * A key that is a plain variable (`rows[i]`, `process.env[key]`) contains no literal at all
 * and is not reported: what it evaluates to is undecidable here, and saying so is the
 * honest answer. See "WHAT THIS CHECKER DOES NOT CLAIM" at the top of this file.
 */
function findDisguises(raw, code) {
  const hits = [];
  const re = /[\w$)\]][ \t]*\[/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    if (BRACKET_KEYWORDS.test(code.slice(0, m.index + 1))) continue;
    const close = closingBracket(code, open);
    if (close < 0) continue;
    const blanked = code.slice(open + 1, close);
    const inner = raw.slice(open + 1, close);
    let literal = false;
    for (let i = 0; i < blanked.length; i++) {
      if (blanked[i] === ' ' && (inner[i] === '"' || inner[i] === "'" || inner[i] === '`')) {
        literal = true;
        break;
      }
    }
    if (!literal) continue;
    const whole = /^\s*(['"`])([^'"`]*)\1\s*$/.exec(inner);
    if (whole && !/^[A-Za-z_$][\w$]*$/.test(whole[2])) continue; // no other way to write it
    hits.push({
      name: 'computed access',
      index: open,
      length: close - open + 1,
      hint: whole
        ? 'A property named by a string literal is that property written so that neither this '
          + 'checker nor a reader sees the name. Write it with a dot.'
        : 'A property name assembled out of pieces is a name hidden from every reader of this '
          + 'file. Write it as one plain name, with a dot.',
    });
  }
  return hits;
}

/**
 * Every mention of a mutating primitive in `code`, sorted into three piles: inside the gate,
 * covered by a declared exception, and neither — the last being the violations. `raw` and
 * `code` are the same text with the same layout, so one offset means the same line and
 * column in both. Hits are reported in source order, so a message list reads down the file.
 *
 * `skip` holds the spans of the module references (`scanModuleRefs`): an `import` is where a
 * mutator may be NAMED, and the gate is where it may be USED. Nowhere else may do either.
 *
 * This is the ONLY reader of the mutating-primitive list. Both stores and the self-tests
 * below come through here, so a fixture that defeats this function defeats the real check,
 * and a fixture it catches is caught in `storage/fileStore.js` too.
 */
function findViolations({ raw, code, mutators, exceptions, gateFrom = 0, gateTo = -1, skip = [] }) {
  const starts = lineStarts(code);
  const lines = raw.split('\n');
  const hits = [];
  for (const [name, pattern] of mutators) {
    const re = new RegExp(pattern.source, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++; // a zero-width match would otherwise spin here for ever
        continue;
      }
      hits.push({ name, index: m.index, length: m[0].length });
    }
  }
  hits.push(...findDisguises(raw, code));
  hits.sort((a, b) => a.index - b.index || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const result = { found: 0, allowed: 0, used: new Set(), violations: [] };
  for (const hit of hits) {
    if (skip.some(([from, to]) => hit.index >= from && hit.index < to)) continue;
    result.found++;
    const row = lineAt(starts, hit.index);
    const line = row + 1;
    if (line >= gateFrom && line <= gateTo) {
      result.allowed++;
      continue;
    }
    const source = lines[row] || '';
    const from = hit.index - starts[row];
    const exception = coveringException(source, exceptions, from, from + hit.length);
    if (exception !== null) {
      result.allowed++;
      result.used.add(exception);
      continue;
    }
    result.violations.push({ name: hit.name, line, source, hint: hit.hint });
  }
  return result;
}

// ---------------------------------------------------------------------------
// the modules a store reaches for, and the names it takes out of them
// ---------------------------------------------------------------------------

/** The string literal at or after `at`, read from the RAW text (blanking took its own). */
function readSpecifier(raw, at) {
  const m = /^[ \t\r\n]*(['"`])([^'"`]*)\1/.exec(raw.slice(at));
  return m ? { text: m[2], end: at + m[0].length } : null;
}

/**
 * Every module reference in the file: static imports, re-exports, bare imports and
 * `await import(...)` alike.
 *
 * It runs over the BLANKED code, which is the rule the rest of this file applies and the
 * one its header claims: an import inside a block comment is not an import, and it used to
 * fail the run. The specifier is then read from the RAW text at the same offset, because
 * blanking takes the literal's characters with it and the two texts share a layout.
 *
 * An `import` in statement position that none of the shapes below explains is returned as
 * `unparsed` rather than skipped. A reader that quietly understands nothing would report
 * nothing, which is the one failure mode a checker must not have.
 */
/**
 * The `from` of a module clause, or null.
 *
 * `/\bfrom\b/` alone also matches the `from` in `Buffer.from(...)` and `Array.from(...)`, so
 * an ordinary exported declaration was reported as "imports a module whose name is not a
 * plain string" — an honest line failing the build with a message pointing at imports, which
 * the header says must not happen. A module `from` is never a member access, so skipping the
 * ones preceded by a dot is enough; `export {x} from someVar` is still found and still
 * reported as unreadable, because there the dot is absent.
 */
function findModuleFrom(clause) {
  const re = /\bfrom\b/g;
  let m;
  while ((m = re.exec(clause))) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(clause[i])) i--;
    if (i >= 0 && clause[i] === '.') continue; // `.from(` — a method call, not a module
    return m;
  }
  return null;
}

function scanModuleRefs(raw, code) {
  const starts = lineStarts(code);
  const refs = [];
  const claimed = new Set();

  // `await import(...)` is an expression and can stand anywhere, so it is looked for first
  // and everywhere; the statement scan below then leaves those keywords alone.
  for (const m of code.matchAll(/\bimport[ \t\r\n]*\(/g)) {
    const spec = readSpecifier(raw, m.index + m[0].length);
    claimed.add(m.index);
    refs.push({
      kind: 'dynamic',
      specifier: spec ? spec.text : null,
      clause: '',
      line: lineAt(starts, m.index) + 1,
      span: [m.index, spec ? spec.end : m.index + m[0].length],
    });
  }

  for (const m of code.matchAll(/(^|[;\n])[ \t]*(import|export)\b/g)) {
    const keyword = m[2];
    // Which of the two it is, without spelling either out as a string here: the fixtures
    // below are full of pretend import statements, and `tools/check-imports.mjs` reads the
    // BODIES of plain strings looking for specifiers — so a keyword written as a literal in
    // this file would be read as one of this file's own imports. The two differ in their
    // first letter and in nothing else this scan cares about.
    const isImport = keyword[0] === 'i';
    const start = m.index + m[0].length - keyword.length;
    const end = start + keyword.length;
    if (claimed.has(start)) continue;
    if (code[end] === '.') continue; // `import.meta`, which references no module
    const line = lineAt(starts, start) + 1;
    const after = code.slice(end);
    const stop = after.indexOf(';');
    const clause = stop < 0 ? after.slice(0, 400) : after.slice(0, stop);
    const fromWord = findModuleFrom(clause);
    if (fromWord) {
      const spec = readSpecifier(raw, end + fromWord.index + fromWord[0].length);
      refs.push({
        kind: isImport ? 'static' : 'reexport',
        specifier: spec ? spec.text : null,
        clause: clause.slice(0, fromWord.index),
        line,
        span: [start, spec ? spec.end : end + clause.length],
      });
      continue;
    }
    if (!isImport) continue; // a plain export references no module
    const bare = readSpecifier(raw, end);
    if (bare) {
      refs.push({ kind: 'bare', specifier: bare.text, clause: '', line, span: [start, bare.end] });
      continue;
    }
    refs.push({ kind: 'unparsed', specifier: null, clause, line, span: [start, end] });
  }
  refs.sort((a, b) => a.span[0] - b.span[0]);
  return refs;
}

/**
 * The names an import clause binds locally: `{ a, b as c }` binds `a` and `c`, a default
 * binds its own name, and `* as ns` binds the namespace — which is returned separately
 * because a namespace hands over the whole module behind ONE name, mutators included.
 */
function bindingsOf(clause) {
  const names = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const text = part.trim();
      if (!text) continue;
      const renamed = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(text);
      names.push(renamed ? renamed[2] : text);
    }
  }
  const star = /\*\s*as\s+([\w$]+)/.exec(clause);
  const head = clause.replace(/\{[^}]*\}/, ' ').replace(/\*\s*as\s+[\w$]+/, ' ');
  for (const part of head.split(',')) {
    const text = part.trim();
    if (/^[\w$]+$/.test(text)) names.push(text); // a default binding
  }
  return { names, namespace: star ? star[1] : null };
}

/**
 * One file, read the way the two stores are read: comments and strings blanked, modules and
 * their bindings resolved, then every mention of a mutating primitive sorted into piles.
 *
 * The self-tests below call this with pretend sources and the same target shape, so a
 * fixture exercises the whole reader — the import scan included — and not a piece of it.
 */
function inspect({ raw, target, gateFrom = 0, gateTo = -1 }) {
  const code = codeOnly(raw);
  const refs = scanModuleRefs(raw, code);
  const importProblems = [];
  const tracked = new Map();

  for (const ref of refs) {
    if (ref.kind === 'unparsed') {
      importProblems.push({
        kind: 'import-unparsed',
        line: ref.line,
        text: 'an `import` this checker cannot read. It refuses rather than skipping it: a '
          + 'reader that understands nothing reports nothing. Write it as an ordinary '
          + 'declaration at the top of the file, with the module name in quotes.',
      });
      continue;
    }
    if (ref.specifier === null) {
      importProblems.push({
        kind: 'import-unreadable',
        line: ref.line,
        text: 'imports a module whose name is not a plain string, so this checker cannot tell '
          + 'what is being loaded. Name the module.',
      });
      continue;
    }
    if (!target.imports.includes(ref.specifier)) {
      importProblems.push({
        kind: 'import-unknown',
        line: ref.line,
        text: `imports '${ref.specifier}', which this checker does not know about. A new import `
          + 'can be a second way to write — add it to the allowed list here, and to the '
          + 'mutating-primitive list if it can change stored state.',
      });
    }
    if (!FS_MODULES.has(ref.specifier)) continue;
    if (ref.kind === 'dynamic') {
      importProblems.push({
        kind: 'import-dynamic-fs',
        line: ref.line,
        text: `loads '${ref.specifier}' with a dynamic import, whose bindings this checker `
          + 'cannot see. Import the exact names at the top of the file, where they are visible.',
      });
      continue;
    }
    if (ref.kind === 'reexport') {
      importProblems.push({
        kind: 'import-fs-reexport',
        line: ref.line,
        text: `re-exports from '${ref.specifier}', which hands a mutating primitive to every `
          + 'importer of this store — outside the gate by construction. Remove it.',
      });
      continue;
    }
    const { names, namespace } = bindingsOf(ref.clause);
    if (namespace) {
      importProblems.push({
        kind: 'import-fs-namespace',
        line: ref.line,
        text: `imports all of '${ref.specifier}' as \`${namespace}\`, which puts every mutator `
          + 'behind one name. Import the exact functions the store uses.',
      });
      tracked.set(namespace, ref.specifier);
    }
    for (const name of names) {
      if (FS_READ_ONLY.has(name)) continue;
      tracked.set(name, ref.specifier);
    }
  }

  const mutators = [];
  const seen = new Set();
  for (const [name, pattern] of [
    ...ESCAPE_HATCHES,
    ...target.names.map((name) => [name, identifierPattern(name)]),
    ...[...tracked.keys()].map((name) => [name, identifierPattern(name)]),
    ...target.patterns,
  ]) {
    if (seen.has(name)) continue;
    seen.add(name);
    mutators.push([name, pattern]);
  }

  const scan = findViolations({
    raw,
    code,
    mutators,
    exceptions: target.exceptions,
    gateFrom,
    gateTo,
    skip: refs.map((ref) => ref.span),
  });
  return { code, refs, importProblems, tracked: [...tracked.keys()], scan };
}

// ---------------------------------------------------------------------------
// Supabase: a write must name the document it changes
// ---------------------------------------------------------------------------

const MUTATING_VERBS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** The text between `(` at `start` and its matching `)`, or null. */
function balancedFrom(text, start) {
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

/**
 * Every `request(...)` that changes something, and whether it says which document it is for.
 *
 * The call is located in the BLANKED code, so a `request()` spelled out in a comment or
 * quoted inside a message is not counted as a write. The verb is read from the RAW source at
 * that same offset, because blanking takes the literal's own characters with it and the two
 * texts share a layout — and it is read whatever quotes it wears. That is not a detail:
 * while only `'POST'` was recognised, `request("POST", …)` shed the docId requirement
 * entirely and was not even counted, so the summary line went on claiming that every
 * mutating request named its document while one of them did not.
 *
 * The ARGUMENTS are read from the blanked code rather than the raw text, for the same reason
 * the rest of this file does: `request('POST', T, { /* docId: id *\/ body })` names no
 * document, whatever the comment says.
 *
 * A call whose method is not a literal is refused rather than skipped. There is no way to
 * tell from here whether it is a read or a write, and "cannot tell" must not read as "fine".
 */
function checkRequests(raw, code) {
  const starts = lineStarts(code);
  const result = { calls: 0, gated: 0, problems: [] };
  for (const found of code.matchAll(/\brequest\s*\(/g)) {
    const paren = found.index + found[0].length - 1;
    const line = lineAt(starts, found.index) + 1;
    if (/\bfunction\s*$/.test(code.slice(0, found.index))) continue; // the declaration itself
    const verb = /^[ \t\r\n]*(['"`])([A-Za-z]+)\1/.exec(raw.slice(paren + 1));
    if (!verb) {
      result.problems.push({
        line,
        text: 'request(…) is called with a method this checker cannot read. Write the verb as '
          + 'a plain literal, so that a write cannot reach the database looking like a read.',
      });
      continue;
    }
    if (!MUTATING_VERBS.has(verb[2].toUpperCase())) continue; // a read changes nothing
    result.calls++;
    const args = balancedFrom(code, paren);
    if (args === null) {
      result.problems.push({ line, text: 'could not read the arguments of this request() call' });
      continue;
    }
    if (!/\bdocId\s*:/.test(args)) {
      result.problems.push({
        line,
        text: `request('${verb[2]}', …) does not pass \`docId\`. A write must name the document `
          + 'it changes, because that name is what the gate checks. Without it the request is '
          + 'refused at runtime — say which document it is for.',
      });
      continue;
    }
    result.gated++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// the checker, checked against attempts to defeat it
// ---------------------------------------------------------------------------

/**
 * Every fixture below is a short piece of pretend source read by `inspect` — the same
 * function that reads the two stores, import scan and all — with the file store's mutating
 * names and its own two declared exceptions. `expect` names the mutators that MUST be
 * reported, in source order; an empty list means the line is honest and must pass in
 * silence. `used`, where given, names the exceptions that must have been consumed, so
 * "allowed" cannot quietly become "not noticed". `badImports` names the import problems the
 * fixture must produce, so a hole in the module scan is a failing test too.
 *
 * Both directions are tested, because both have been wrong. A mutating call must not get
 * through in a costume — it is code wherever it is written, and a comment quoting a declared
 * exception is not a licence for the call standing beside it. And an honest line must not be
 * reported — a `rename()` discussed in a comment or spelled out in a Korean message changes
 * no byte, an import inside a block comment is not an import, and a checker that shouts
 * about those is one people learn to skip.
 *
 * The indirection fixtures are the ones that made this section what it is. Every one of them
 * reached the disk or the network with the run exiting 0 while a mutator was matched by its
 * CALL SYNTAX rather than by its name.
 *
 * One house rule for editing them, which has nothing to do with what they test: a fixture
 * that contains an import statement is written in BACKTICKS, and the word `import` never
 * stands immediately before a quote anywhere in this file. `tools/check-imports.mjs` reads
 * the bodies of plain strings — that is where real specifiers live — and would otherwise
 * read these pretend imports as this file's own and go looking for `node:zlib` on disk.
 * Template bodies it blanks, which is why backticks are the answer rather than cleverness.
 */
const SELF_TEST_EXCEPTIONS = [
  "open(journalPath(id), 'r')",
  'mkdir(DATA_DIR, { recursive: true })',
];

const SELF_TEST_TARGET = {
  names: FS_MUTATOR_NAMES,
  patterns: [],
  exceptions: SELF_TEST_EXCEPTIONS,
  imports: ['node:fs', 'node:fs/promises', 'node:path', 'node:url', '../shared/model.js'],
};

const SELF_TEST_NET_TARGET = {
  names: NET_MUTATOR_NAMES,
  patterns: NET_PATTERNS,
  exceptions: [],
  imports: ['../shared/model.js'],
};

const SELF_TESTS = [
  {
    what: 'a bare mutating call outside the gate is reported',
    src: 'await unlink(backupPath(id, 1));',
    expect: ['unlink'],
  },
  {
    what: 'a comment quoting a declared exception does not license the call beside it',
    src: "await unlink(backupPath(id, 1)); // as with open(journalPath(id), 'r')",
    expect: ['unlink'],
  },
  {
    what: 'nor does one written before it on the same line',
    src: '/* like mkdir(DATA_DIR, { recursive: true }) */ await rename(tmp, dest);',
    expect: ['rename'],
  },
  {
    what: 'nor does a template literal holding the exception text',
    src: "const why = `open(journalPath(id), 'r')`; await unlink(p);",
    expect: ['unlink'],
  },
  {
    what: 'nor does a plain string holding it',
    src: 'const why = "open(journalPath(id), \'r\')"; await unlink(p);',
    expect: ['unlink'],
  },
  {
    what: 'a mutating call that exists only in a line comment is not code',
    src: '// await rename(tmp, dest);',
    expect: [],
  },
  {
    what: 'nor is one inside a string',
    src: "const note = 'rename(tmp, dest) 는 파일을 옮깁니다';",
    expect: [],
  },
  {
    what: 'nor one in the literal text of a template',
    src: 'const note = `rename(tmp, dest) 는 파일을 옮깁니다`;',
    expect: [],
  },
  {
    what: 'but a call inside a template substitution IS code and is reported',
    src: 'const note = `${await rename(tmp, dest)}`;',
    expect: ['rename'],
  },
  {
    what: 'the declared exception itself passes, and is recorded as used',
    src: "const rh = await open(journalPath(id), 'r');",
    expect: [],
    used: ["open(journalPath(id), 'r')"],
  },
  {
    what: 'a declared exception does not license a second call on its line',
    src: "const rh = await open(journalPath(id), 'r'); await unlink(p);",
    expect: ['unlink'],
    used: ["open(journalPath(id), 'r')"],
  },
  {
    what: 'nor a call chained onto it',
    src: "await open(journalPath(id), 'r').write(buf);",
    expect: ['write'],
    used: ["open(journalPath(id), 'r')"],
  },
  {
    what: 'an exception whose arguments were edited stops covering its own call',
    src: "const rh = await open(journalPath(id), 'r+');",
    expect: ['open'],
  },
  {
    what: 'a call inside the gate is allowed and one outside it is still reported',
    src: 'await unlink(p);\nawait rename(tmp, dest);\nconst done = true;',
    gateFrom: 2,
    gateTo: 2,
    expect: ['unlink'],
  },

  // --- indirection: the name is what is forbidden, not the shape of the call -----------
  {
    what: 'a mutator stored in a local is reported where it is NAMED',
    src: 'const nuke = unlink;\nawait nuke(p);',
    expect: ['unlink'],
  },
  {
    what: 'a mutator hidden in an object literal is still a mention of it',
    src: 'const ops = { u: unlink };\nawait ops.u(p);',
    expect: ['unlink'],
  },
  {
    what: 'a mutator handed to a retry helper never looks like a call at all',
    src: 'await withRetry(unlink, p);',
    expect: ['unlink'],
  },
  {
    what: 'an optional call is a call',
    src: 'await unlink?.(p);',
    expect: ['unlink'],
  },
  {
    what: 'and so is a parenthesised one',
    src: 'await (unlink)(p);',
    expect: ['unlink'],
  },
  {
    what: 'a handle method named by a string literal is that method, hidden',
    src: 'await h["write"](buf);',
    expect: ['computed access'],
  },
  {
    what: 'a property name that could not be written with a dot is left alone',
    src: "headers['Content-Type'] = 'application/json';",
    expect: [],
  },
  {
    what: 'a mutator returned from a helper is reported where the helper names it',
    src: 'const pick = () => unlink;\nawait pick()(p);',
    expect: ['unlink'],
  },

  // --- the imports, and the bindings they carry ---------------------------------------
  {
    what: 'a mutator added to an allowed import is tracked without being listed here',
    src: `import { cp } from 'node:fs/promises';\nawait cp(from, to);`,
    expect: ['cp'],
  },
  {
    what: 'the licence an import carries ends at the module name, not at the end of the line',
    src: `import { cp } from 'node:fs/promises'; await cp(from, to);`,
    expect: ['cp'],
  },
  {
    what: 'and so is one renamed on its way in',
    src: `import { cp as clone } from 'node:fs/promises';\nawait clone(from, to);`,
    expect: ['clone'],
  },
  {
    what: 'a read-only binding is not a mutator, and the import that binds it is not a use',
    src: `import { readFileSync } from 'node:fs';\nconst text = readFileSync(p);`,
    expect: [],
  },
  {
    what: 'a namespace import hands over every mutator behind one name',
    src: `import * as fs from 'node:fs';\nawait fs.unlink(p);`,
    expect: ['fs', 'unlink'],
    badImports: ['import-fs-namespace'],
  },
  {
    what: 're-exporting fs hands a mutator to every importer',
    src: `export { unlink } from 'node:fs/promises';`,
    expect: [],
    badImports: ['import-fs-reexport'],
  },
  {
    what: 'a dynamic import of fs hides its bindings and is refused',
    src: `const { cp } = await import('node:fs/promises');\nawait cp(from, to);`,
    expect: ['cp', 'cp'],
    badImports: ['import-dynamic-fs'],
  },
  {
    what: 'a dynamic import of an allowed module is seen and allowed',
    src: `const model = await import('../shared/model.js');`,
    expect: [],
    badImports: [],
  },
  {
    what: 'a dynamic import whose module name is computed cannot be read, and is refused',
    src: 'const mod = await import(where);',
    expect: [],
    badImports: ['import-unreadable'],
  },
  {
    what: 'an import statement inside a block comment is not one',
    src: `/* import { cp } from 'node:fs/promises'; */\nconst x = 1;`,
    expect: [],
    badImports: [],
  },
  {
    what: 'nor is one written out inside a string',
    src: `const shown = "import { cp } from 'node:fs/promises';";`,
    expect: [],
    badImports: [],
  },
  {
    what: 'an import this reader cannot parse is refused rather than skipped',
    src: `import fs = require('node:fs');`,
    expect: ['require'],
    badImports: ['import-unparsed'],
  },
  {
    what: 'an import of a module nobody declared is reported',
    src: `import { deflate } from 'node:zlib';`,
    expect: [],
    badImports: ['import-unknown'],
  },

  // --- the network side ----------------------------------------------------------------
  {
    what: 'on the network side, a string cannot hide a real request',
    target: SELF_TEST_NET_TARGET,
    src: "const shown = 'fetch(url)'; await fetch(url);",
    expect: ['fetch'],
  },
  {
    what: 'and a request only written about in a comment is not one',
    target: SELF_TEST_NET_TARGET,
    src: '// await fetch(url);',
    expect: [],
  },
  {
    what: 'fetch stored in a local is reported where it is named',
    target: SELF_TEST_NET_TARGET,
    src: 'const send = fetch;\nawait send(url);',
    expect: ['fetch'],
  },
  {
    what: 'an optional fetch is a fetch',
    target: SELF_TEST_NET_TARGET,
    src: 'await fetch?.(url);',
    expect: ['fetch'],
  },
  {
    what: 'fetch assembled out of pieces on globalThis is reported twice over',
    target: SELF_TEST_NET_TARGET,
    src: 'await globalThis["fe" + "tch"](url);',
    expect: ['globalThis', 'computed access'],
  },
  {
    what: 'fetch carried in an object is still fetch',
    target: SELF_TEST_NET_TARGET,
    src: 'const t = { go: fetch };\nawait t.go(url);',
    expect: ['fetch'],
  },
];

let defeated = 0;
for (const fixture of SELF_TESTS) {
  checks++;
  const raw = fixture.src;
  const result = inspect({
    raw,
    target: fixture.target || SELF_TEST_TARGET,
    gateFrom: fixture.gateFrom || 0,
    gateTo: fixture.gateTo || -1,
  });
  const got = result.scan.violations.map((v) => v.name);
  const want = fixture.expect;
  const sameNames = got.length === want.length && got.every((name, i) => name === want[i]);
  const wantUsed = fixture.used || null;
  const sameUsed = wantUsed === null
    || (result.scan.used.size === wantUsed.length && wantUsed.every((text) => result.scan.used.has(text)));
  const gotImports = result.importProblems.map((p) => p.kind);
  const wantImports = fixture.badImports || null;
  const sameImports = wantImports === null
    || (gotImports.length === wantImports.length && gotImports.every((kind, i) => kind === wantImports[i]));
  if (!sameNames || !sameUsed || !sameImports) {
    problems.push(
      `check-writes self-test: ${fixture.what}\n`
        + `      source:   ${raw.split('\n').join(' / ')}\n`
        + `      expected: ${want.length ? want.join(', ') : '(nothing reported)'}`
        + `${wantUsed ? ` — exceptions used: ${wantUsed.join(', ')}` : ''}`
        + `${wantImports ? ` — imports: ${wantImports.join(', ') || '(none)'}` : ''}\n`
        + `      got:      ${got.length ? got.join(', ') : '(nothing reported)'}`
        + `${wantUsed ? ` — exceptions used: ${[...result.scan.used].join(', ') || '(none)'}` : ''}`
        + `${wantImports ? ` — imports: ${gotImports.join(', ') || '(none)'}` : ''}\n`
        + '      This checker is what stops the mutation gate decaying, so a hole in it is a hole '
        + 'in SPEC 27.6. Fix the reader, not the fixture — unless the fixture really is describing '
        + 'something that is no longer forbidden, which has to be argued in writing first.',
    );
    defeated++;
  }
}

/**
 * The Supabase docId rule, put through the same treatment. The double-quoted verb is the
 * fixture that matters: it used to remove the requirement altogether AND leave the call out
 * of the count, so the summary line stayed reassuring while the write went out anonymous.
 */
const REQUEST_SELF_TESTS = [
  { what: "a single-quoted verb naming its document passes", src: "await request('POST', T, { docId: id, body });", calls: 1, gated: 1, bad: 0 },
  { what: 'a DOUBLE-quoted verb is a write like any other', src: 'await request("POST", T, { body });', calls: 1, gated: 0, bad: 1 },
  { what: 'and a double-quoted one that does name its document passes', src: 'await request("PATCH", T, { docId: id });', calls: 1, gated: 1, bad: 0 },
  { what: 'so is a backtick verb', src: 'await request(`DELETE`, T, { docId: id });', calls: 1, gated: 1, bad: 0 },
  { what: 'a read is not a write and needs no document', src: "await request('GET', T, { query });", calls: 0, gated: 0, bad: 0 },
  { what: 'a docId that exists only in a comment names nothing', src: "await request('POST', T, { /* docId: id */ body });", calls: 1, gated: 0, bad: 1 },
  { what: 'a request written about in a comment is not a request', src: "// await request('POST', T, { body });", calls: 0, gated: 0, bad: 0 },
  { what: 'the declaration of request() is not a call to it', src: 'async function request(method, table, options = {}) {', calls: 0, gated: 0, bad: 0 },
  { what: 'a verb this checker cannot read is refused, not skipped', src: 'await request(verb, T, { docId: id });', calls: 0, gated: 0, bad: 1 },
];

for (const fixture of REQUEST_SELF_TESTS) {
  checks++;
  const result = checkRequests(fixture.src, codeOnly(fixture.src));
  if (result.calls !== fixture.calls || result.gated !== fixture.gated || result.problems.length !== fixture.bad) {
    problems.push(
      `check-writes self-test (Supabase docId rule): ${fixture.what}\n`
        + `      source:   ${fixture.src}\n`
        + `      expected: ${fixture.calls} write(s), ${fixture.gated} naming a document, ${fixture.bad} problem(s)\n`
        + `      got:      ${result.calls} write(s), ${result.gated} naming a document, ${result.problems.length} problem(s)`,
    );
    defeated++;
  }
}

const attempts = SELF_TESTS.length + REQUEST_SELF_TESTS.length;
ok.push(
  defeated === 0
    ? `check-writes: ${attempts} attempts to defeat this checker, all answered correctly`
    : `check-writes: ${defeated} of ${attempts} attempts to defeat this checker GOT THROUGH`,
);

// ---------------------------------------------------------------------------
// the two stores
// ---------------------------------------------------------------------------

for (const target of TARGETS) {
  const path = join(ROOT, target.file);
  checks++;
  if (!existsSync(path)) {
    problems.push(`${target.file}: missing — the mutation gate cannot be checked`);
    continue;
  }
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');

  // --- the gate markers -----------------------------------------------------
  const begins = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (line.includes(GATE_BEGIN)) begins.push(i + 1);
    if (line.includes(GATE_END)) ends.push(i + 1);
  });
  checks++;
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) {
    problems.push(
      `${target.file}: expected exactly one "${GATE_BEGIN}" line followed by one "${GATE_END}" line, `
        + `found ${begins.length} and ${ends.length} (at ${begins.join(',') || '-'} and ${ends.join(',') || '-'}). `
        + 'The gate is the only place a mutation may be written, so it has to be findable.',
    );
    continue;
  }
  const gateFrom = begins[0];
  const gateTo = ends[0];
  checks++;
  if (gateTo - gateFrom + 1 > MAX_GATE_LINES) {
    problems.push(
      `${target.file}: the mutation gate now spans ${gateTo - gateFrom + 1} lines (${gateFrom}–${gateTo}), `
        + `more than the ${MAX_GATE_LINES} a gate may cover. Everything inside the gate is allowed, so a `
        + 'gate that has grown to hold half the file allows half the file. If a call was moved '
        + 'inside, move the call back out and route it through `mutate`; the end marker is not the '
        + 'thing to move.',
    );
    continue;
  }
  ok.push(`${target.file}: gate at lines ${gateFrom}–${gateTo}`);

  const { code, refs, importProblems, tracked, scan } = inspect({ raw, target, gateFrom, gateTo });

  // --- the gate's shape -----------------------------------------------------
  const gateCode = code.split('\n').slice(gateFrom - 1, gateTo).join('\n');
  for (const [what, pattern] of target.shape) {
    checks++;
    if (!pattern.test(gateCode)) {
      problems.push(
        `${target.file}: the gate no longer has the shape that makes it a guard — ${what}. `
          + 'A check that is not the statement immediately before the call is a check with an '
          + 'await-sized hole in it, which is exactly how rounds 4 and 5 were defeated.',
      );
    }
  }
  ok.push(`${target.file}: ${target.shape.length} gate shape rules hold`);

  // --- no mutating primitive named outside the gate -------------------------
  // An exception is still matched against the ORIGINAL line, so a changed argument stops
  // being covered by it — and it has to COVER the call's own columns, so a comment or a
  // string repeating its text licenses nothing (coveringException says why).
  checks += scan.found;
  for (const violation of scan.violations) {
    problems.push(
      `${target.file}:${violation.line}: \`${violation.name}\` outside the mutation gate (lines ${gateFrom}–${gateTo})\n`
        + `      ${violation.source.trim().slice(0, 110)}\n`
        + `      ${violation.hint || 'Every mutation must go through the gate, which asks whether the '
          + 'document is readable with nothing between the question and the call. A mutating '
          + 'primitive may be NAMED only in the import that binds it and USED only inside the '
          + 'gate. Route it through the gate, or — if it genuinely cannot change a document — '
          + 'add it to this checker\'s exception list with the reason.'}`,
    );
  }
  ok.push(
    `${target.file}: ${scan.found} mentions of a mutating primitive, `
      + `${scan.allowed} inside the gate or declared exceptions`,
  );

  // An exception nobody uses is a licence left lying around: it stops describing the code
  // and starts permitting whatever later takes that shape.
  for (const text of target.exceptions) {
    checks++;
    if (!scan.used.has(text)) {
      problems.push(
        `${target.file}: the declared exception \`${text}\` covers no mutating call any more. `
          + 'Either the call it described is gone — remove it rather than leaving a standing '
          + 'permission for code that no longer exists — or its text has drifted off the call it '
          + 'is meant to cover, in which case it permits nothing and only looks like it does.',
      );
    }
  }

  // --- nothing else is imported, and nothing else is bound ------------------
  for (const problem of importProblems) {
    checks++;
    problems.push(`${target.file}:${problem.line}: ${problem.text}`);
  }
  checks += refs.length;
  if (importProblems.length === 0) {
    ok.push(
      `${target.file}: ${refs.length} module references, all declared`
        + `${tracked.length ? `; ${tracked.length} fs bindings tracked as mutators (${tracked.join(', ')})` : ''}`,
    );
  }
}

// --- every store is a target ------------------------------------------------
// A backend added later must not be the one file in the tree nobody checks, and a target
// deleted from the list above must not pass unnoticed. The directory is the source of truth.
{
  const dir = join(ROOT, 'storage');
  checks++;
  if (existsSync(dir)) {
    const declared = new Set(TARGETS.map((target) => target.file));
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.js') || NOT_A_STORE.has(entry)) continue;
      checks++;
      if (!declared.has(`storage/${entry}`)) {
        problems.push(
          `storage/${entry}: a document store this checker knows nothing about. Every backend `
            + 'funnels its mutations through one gate (SPEC 29.1) and every backend is checked '
            + 'here — add it to TARGETS with its own gate, mutating surface and import list, or '
            + 'say in NOT_A_STORE why it cannot write.',
        );
      }
    }
    ok.push('storage/: every backend present is declared as a target');
  }
}

// ---------------------------------------------------------------------------
// Supabase only: a write must name the document it changes
// ---------------------------------------------------------------------------
{
  const path = join(ROOT, 'storage/supabaseStore.js');
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const code = codeOnly(raw);
    const result = checkRequests(raw, code);
    checks += result.calls;
    for (const problem of result.problems) {
      problems.push(`storage/supabaseStore.js:${problem.line}: ${problem.text}`);
    }
    checks++;
    if (result.calls === 0) {
      problems.push(
        'storage/supabaseStore.js: no mutating request() call found at all. Either the store '
          + 'stopped writing, or the calls no longer look the way this checker reads them.',
      );
    }
    ok.push(`storage/supabaseStore.js: ${result.gated} of ${result.calls} mutating requests name their document`);

    // The set the gate consults has to hold every mutating verb, or a write slips past as
    // though it were a read. Located in the blanked code so that a commented-out declaration
    // is not read as one, then re-read from the raw text for its contents.
    const declaration = /const MUTATING_METHODS = new Set\(\[[^\]]*\]\)/;
    const at = code.search(declaration);
    const declared = at < 0 ? null : declaration.exec(raw.slice(at));
    checks++;
    if (!declared) {
      problems.push('storage/supabaseStore.js: MUTATING_METHODS is not declared where this checker can read it');
    } else {
      for (const verb of MUTATING_VERBS) {
        checks++;
        if (!declared[0].includes(`'${verb}'`)) {
          problems.push(`storage/supabaseStore.js: MUTATING_METHODS omits '${verb}', so such a request would be sent ungated`);
        }
      }
      ok.push('storage/supabaseStore.js: MUTATING_METHODS covers POST, PATCH, PUT and DELETE');
    }
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

for (const line of ok) console.log(`  ok  ${line}`);
if (problems.length === 0) {
  console.log(`\ncheck-writes: OK — ${checks} checks passed.`);
  process.exit(0);
}
console.log(`\ncheck-writes: ${problems.length} problem(s)\n`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
