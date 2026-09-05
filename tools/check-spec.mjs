#!/usr/bin/env node
/**
 * Spec-coverage checker.
 *
 * Reads docs/SPEC.md as the source of truth and verifies the implementation actually
 * delivers what it promises:
 *   1. the spec's authoritative layout (section 0) and the working tree agree IN BOTH
 *      DIRECTIONS — every path the tree lists exists, and every file that exists is
 *      listed;
 *   2. every `export function NAME` / `export class NAME` named in a spec code block
 *      exists in the corresponding module;
 *   3. every function named in the required function set (section 7) is present in the
 *      FUNCTIONS table, is callable, is not a stub, and carries the volatile/lazy flags
 *      the spec pins;
 *   4. no browser, server or storage source file contains a TODO/FIXME/"not implemented"
 *      marker;
 *   5. no shipped file reaches an external URL, with ONE named exception;
 *   6. the README does not deny a feature the code ships, and its function count and
 *      function table match the FUNCTIONS table;
 *   7. docs/SPEC.md itself does not contradict the code: no name stripped out of a
 *      sentence, every unauthenticated path named, every clipboard interchange attribute
 *      documented, every `SPEC <n>.<n>` citation resolving to a real heading.
 *
 * The last line reports how many individual checks passed, because the README promises
 * a reader that every verification command ends with that number.
 *
 * Usage: node tools/check-spec.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'docs', 'SPEC.md');
const rel = (p) => relative(ROOT, p).split(sep).join('/');

if (!existsSync(SPEC)) {
  console.error('check-spec: docs/SPEC.md is missing');
  process.exit(2);
}
const spec = readFileSync(SPEC, 'utf8');
const problems = [];
const ok = [];

/**
 * How many individual verifications this run actually performed.
 *
 * The README tells the reader that the last line of every verification command reports
 * the number of checks it passed, and that this number is always the true answer. That
 * sentence was false here until this counter existed: the run ended with a sentence and
 * no number, so a reader following the instruction literally found nothing to read. It
 * counts ASSERTIONS — one per file whose existence was demanded, one per export the spec
 * pins, one per required function, one per shape rule — not the grouped `ok` lines below,
 * because "12" would have been a different wrong answer to the same question.
 */
let checks = 0;

// ---------------------------------------------------------------- 1. file layout
//
// Section 0 calls its own tree COMPLETE — "every shipped path is here". That sentence was
// false and this pass could not see it: it asked only LISTED -> EXISTS, so a file that
// shipped without a line in the tree was invisible to the one check whose whole job is the
// tree. Four had shipped that way: `.gitignore`, `.gitattributes`, `package-lock.json` and
// `tools/check-writes.mjs`.
//
// `.gitignore` is why that matters rather than being tidiness. It is the only thing keeping
// `.env` — SZ_PASSWORD and the Supabase service_role key (SPEC 28.1, 29.3) — out of the
// repository, and section 0's own rationale is that a reader building from the contract
// never creates a file the tree omits. Such a reader ships no `.gitignore`, and their first
// `git add -A` commits the site password, the service key and every stored document.
//
// So the pass runs BOTH ways. EXISTS -> LISTED is the direction that catches a NEW file,
// and it is a problem rather than a warning: an unlisted path fails the run, and the ignore
// list below is the only way out of it.

/**
 * Paths that genuinely have no place in a contract.
 *
 * Every entry is a hole in the EXISTS -> LISTED direction, so the list is short and
 * literal. A pattern wide enough to swallow a real source file would put this pass back
 * where it started. `.env.example` is deliberately NOT exempt — it is a shipped file the
 * contract names — and only the real `.env` and its per-environment siblings are skipped.
 */
const IGNORED_DIRS = ['node_modules', '.git'];
const IGNORED_PATTERNS = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)desktop\.ini$/i,
  /\.(tmp|swp|swo|orig|rej)$/,
  /~$/,
  /(^|\/)npm-debug\.log/,
];

function ignoredPath(p) {
  if (IGNORED_DIRS.some((d) => p === d || p.startsWith(`${d}/`))) return true;
  if (p === '.env' || (p.startsWith('.env.') && p !== '.env.example')) return true;
  return IGNORED_PATTERNS.some((re) => re.test(p));
}

/**
 * The tree of section 0, read into two things:
 *
 *   expectedFiles  every path written WITHOUT a trailing slash — each must exist;
 *   opaqueDirs     every directory written WITH a trailing slash and no children
 *                  enumerated under it (`data/`, `docs/shots/`). Such an entry stands for
 *                  its whole subtree, which is how runtime documents and screenshots stay
 *                  out of the file list without an ignore-list entry of their own.
 *
 * A directory whose contents ARE spelled out (`public/js/`, `tools/`) is not opaque, so an
 * unlisted file inside one of those is an error. The distinction is read off the SPEC
 * itself rather than hard-coded here, so enumerating a subtree later automatically starts
 * holding it to the same standard.
 */
const layoutBlock = spec.split('## 0. Directory layout')[1]?.split('```')[1] ?? '';
const expectedFiles = [];
const opaqueDirs = [];
{
  const stack = [];
  const dirs = [];
  const withChildren = new Set();
  for (const raw of layoutBlock.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const name = line.trim();
    const depth = Math.floor(indent / 2);
    stack.length = depth;
    if (depth > 0) withChildren.add(stack.join('/'));
    const path = [...stack, name.replace(/\/$/, '')].join('/');
    stack.push(name.replace(/\/$/, ''));
    if (name.endsWith('/')) dirs.push(path);
    else expectedFiles.push(path);
  }
  for (const d of dirs) if (!withChildren.has(d)) opaqueDirs.push(d);
}

// A tree that parsed to nothing would make both directions pass vacuously, which is the
// one failure mode a checker may never have. The floor is far below the real count and
// exists only to notice that the fences or the heading moved.
checks++;
if (expectedFiles.length < 20) {
  problems.push(
    `docs/SPEC.md section 0: the layout block parsed to ${expectedFiles.length} file(s) — `
    + 'the tree or its code fences moved, and both directions of this check are now vacuous'
  );
}

// --- 1a. LISTED -> EXISTS ------------------------------------------------------------
let layoutChecked = 0;
for (const f of expectedFiles) {
  layoutChecked++;
  checks++;
  const abs = join(ROOT, f);
  if (!existsSync(abs)) {
    problems.push(`missing file promised by spec section 0: ${f}`);
    continue;
  }
  checks++;
  if (!statSync(abs).isFile()) {
    problems.push(`spec section 0 lists ${f} as a file, but it is a directory on disk`);
  }
}

// --- 1b. EXISTS -> LISTED ------------------------------------------------------------
/**
 * Every file in the working tree, as project-relative paths.
 *
 * Dot-prefixed DIRECTORIES are skipped and dot-prefixed FILES are not, and the asymmetry
 * is deliberate on both sides. `collect()` below skips every dot name, and
 * `test/env.test.js` depends on that: it makes sandbox copies of the server at
 * `.sz-envtest-<random>/` inside this very root, and one left behind by a killed run must
 * never be read as a second copy of the project. Those sandboxes are directories, so
 * skipping directories keeps that promise intact.
 *
 * Dot-prefixed files are the opposite case. `.gitignore`, `.gitattributes` and
 * `.env.example` are shipped files the contract names, and `.gitignore` going unlisted for
 * five review rounds is the reason this direction exists at all. Skipping them here would
 * leave the hole exactly where it was found. The real `.env` is excluded by name in
 * `ignoredPath` instead.
 */
function walkTree(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (ignoredPath(p)) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      walkTree(join(dir, entry.name), p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}
const listedFiles = new Set(expectedFiles);
const underOpaqueDir = (p) => opaqueDirs.some((d) => p === d || p.startsWith(`${d}/`));
let unlistedChecked = 0;
for (const p of walkTree(ROOT, '', [])) {
  unlistedChecked++;
  checks++;
  if (listedFiles.has(p) || underOpaqueDir(p)) continue;
  problems.push(
    `shipped file missing from docs/SPEC.md section 0: ${p} — section 0 declares that tree `
    + 'COMPLETE, so add the line there; if this path genuinely does not belong in the '
    + 'contract, add it to the ignore list at the top of tools/check-spec.mjs instead'
  );
}
ok.push(
  `layout: ${layoutChecked} declared paths exist, ${unlistedChecked} working-tree files are `
  + `declared (subtrees taken whole: ${opaqueDirs.join(' ') || 'none'})`
);

// ------------------------------------------------- 2. exported symbols per module
const SECTION_TO_FILE = [
  [/## 2\. `([^`]+)`/, 'shared/formula/errors.js'],
  [/## 3\. `([^`]+)`/, 'shared/formula/refs.js'],
  [/## 4\. `([^`]+)`/, 'shared/formula/tokenizer.js'],
  [/## 5\. `([^`]+)`/, 'shared/formula/parser.js'],
  [/## 6\. `([^`]+)`/, 'shared/formula/values.js'],
  [/## 7\. `([^`]+)`/, 'shared/formula/functions.js'],
  [/## 8\. `([^`]+)`/, 'shared/formula/evaluator.js'],
  [/## 9\. `([^`]+)`/, 'shared/formula/engine.js'],
  [/## 10\. `([^`]+)`/, 'shared/model.js'],
];

function sectionText(headingRe) {
  const m = spec.match(headingRe);
  if (!m) return '';
  const start = m.index;
  const rest = spec.slice(start + 1);
  const nextIdx = rest.search(/\n## /);
  return nextIdx === -1 ? spec.slice(start) : spec.slice(start, start + 1 + nextIdx);
}

for (const [headingRe, file] of SECTION_TO_FILE) {
  const text = sectionText(headingRe);
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue; // already reported by the layout pass
  const src = readFileSync(abs, 'utf8');
  const declared = new Set();
  for (const m of src.matchAll(
    /\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  )) declared.add(m[1]);
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      declared.add((t.split(/\s+as\s+/)[1] || t).trim());
    }
  }

  const wanted = new Set();
  for (const m of text.matchAll(
    /^\s*export\s+(?:function\s+|class\s+|const\s+)([A-Za-z_$][\w$]*)/gm
  )) wanted.add(m[1]);
  for (const m of text.matchAll(/^\s*export\s*\{\s*([A-Za-z_$][\w$]*)/gm)) wanted.add(m[1]);

  for (const name of wanted) {
    checks++;
    if (!declared.has(name)) problems.push(`${file}: spec requires \`export ${name}\` but it is not exported`);
  }
  ok.push(`${file}: ${wanted.size} spec-declared exports checked`);
}

// ------------------------------------------------------- 3. the function library
const fnSection = sectionText(/## 7\. `([^`]+)`/);
const required = new Set();
for (const m of fnSection.matchAll(/^- \*\*[A-Za-z]+\*\*: `([^`]+)`/gm)) {
  for (const name of m[1].split(/\s+/)) if (/^[A-Z][A-Z0-9.]*$/.test(name)) required.add(name);
}

/**
 * The names the FUNCTIONS table actually holds, upper-cased. Hoisted out of the block
 * below so pass 6 can hold the README's function count and function table to it.
 * @type {Set<string>|null}
 */
let functionNames = null;

const fnFile = join(ROOT, 'shared/formula/functions.js');
if (existsSync(fnFile) && required.size) {
  let FUNCTIONS = null;
  try {
    ({ FUNCTIONS } = await import(pathToUrl(fnFile)));
  } catch (e) {
    problems.push(`shared/formula/functions.js failed to import: ${e.message}`);
  }
  if (FUNCTIONS) {
    const have = new Set(Object.keys(FUNCTIONS).map((k) => k.toUpperCase()));
    functionNames = have;
    const missing = [...required].filter((n) => !have.has(n)).sort();
    checks += required.size; // one presence check per function the spec requires
    if (missing.length) {
      problems.push(`functions.js is missing ${missing.length} required function(s): ${missing.join(' ')}`);
    }
    // shape + stub detection
    for (const [name, def] of Object.entries(FUNCTIONS)) {
      checks++;
      if (!def || typeof def !== 'object') {
        problems.push(`FUNCTIONS.${name} is not an object`);
        continue;
      }
      checks += 4;
      if (typeof def.fn !== 'function') problems.push(`FUNCTIONS.${name}.fn is not a function`);
      if (typeof def.minArgs !== 'number') problems.push(`FUNCTIONS.${name}.minArgs is missing`);
      if (typeof def.maxArgs !== 'number') problems.push(`FUNCTIONS.${name}.maxArgs is missing`);
      if (def.minArgs > def.maxArgs) problems.push(`FUNCTIONS.${name} has minArgs > maxArgs`);
      if (typeof def.fn === 'function') {
        checks++;
        const body = def.fn.toString();
        if (/\bTODO\b|\bnot implemented\b|throw new Error\(\s*['"]unimplemented/i.test(body)) {
          problems.push(`FUNCTIONS.${name} looks like a stub`);
        }
      }
    }
    const extra = [...have].filter((n) => !required.has(n));
    ok.push(`functions: ${required.size} required present, ${extra.length} extra (${extra.slice(0, 8).join(' ')}${extra.length > 8 ? ' …' : ''})`);

    // Volatile / lazy flags the spec pins down explicitly.
    for (const n of ['RAND', 'RANDBETWEEN', 'TODAY', 'NOW', 'OFFSET', 'INDIRECT']) {
      if (!have.has(n)) continue;
      checks++;
      if (!FUNCTIONS[n]?.volatile) problems.push(`FUNCTIONS.${n} must be marked volatile:true`);
    }
    for (const n of ['IF', 'IFS', 'AND', 'OR', 'IFERROR', 'IFNA', 'SWITCH', 'CHOOSE', 'INDIRECT', 'OFFSET']) {
      if (!have.has(n)) continue;
      checks++;
      if (!FUNCTIONS[n]?.lazy) problems.push(`FUNCTIONS.${n} must be marked lazy:true`);
    }
  }
}

// --------------------------------------------------------- 4. no stubs anywhere
function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'data' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.(js|mjs|css|html)$/.test(name)) out.push(p);
  }
  return out;
}
/**
 * The file sets the passes below work over.
 *
 * They are named separately rather than pooled into one `sources` array, because the
 * passes want different ones — and pooling them had made three of those passes quietly
 * narrower than their own descriptions. `sources` was shared/, public/, test/ and
 * server.js, so `storage/` — where the whole of SPEC 27.6 lives — and `env.js`, which
 * decides whether the password gate exists at all, were scanned by nothing.
 */
const shippedSources = [
  ...collect(join(ROOT, 'shared')),
  ...collect(join(ROOT, 'public')),
  ...collect(join(ROOT, 'storage')),
  ...(existsSync(join(ROOT, 'server.js')) ? [join(ROOT, 'server.js')] : []),
  ...(existsSync(join(ROOT, 'env.js')) ? [join(ROOT, 'env.js')] : []),
];
const testSources = collect(join(ROOT, 'test'));

/**
 * The checkers and harnesses under tools/. They are held to the SPEC-citation rule (7e)
 * but NOT to the stub scan, because two of them — this file and check-writes.mjs — match
 * on the words TODO and FIXME by design and would flag themselves.
 */
const toolSources = collect(join(ROOT, 'tools'));

/** Everything the browser loads or the server runs, plus the tests. */
const sources = [...shippedSources, ...testSources];
for (const f of sources) {
  checks++;
  const src = readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line) || /not\s+implemented/i.test(line)) {
      problems.push(`${rel(f)}:${i + 1}: leftover marker — ${line.trim().slice(0, 90)}`);
    }
  });
}
ok.push(`stubs: ${sources.length} source files scanned for TODO/FIXME markers`);

// --------------------------------------------- 5. no external network references
// XML namespace URIs are identifiers, not fetches — SVG and XHTML literally require them.
const NAMESPACE_URI = /^https?:\/\/www\.w3\.org\//;

/**
 * The ONE exception, named rather than implied.
 *
 * SPEC 13 says the app makes no external network request — it must work offline — and
 * this pass is what holds it to that. SPEC 29.3 then makes `storage/supabaseStore.js` a
 * PostgREST client over `fetch`, so reaching an external URL is the entire purpose of
 * that one file. Excluding it by name keeps this pass true of everything else, which is
 * better than the alternative that was in place: not scanning `storage/` at all, so the
 * two file-backend modules beside it went unchecked as well.
 */
const NETWORK_BACKENDS = new Set(['storage/supabaseStore.js']);

let shippedScanned = 0;
for (const f of shippedSources) {
  if (NETWORK_BACKENDS.has(rel(f))) continue;
  shippedScanned++;
  checks++;
  const src = readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    const m = line.match(/https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'")]+/);
    if (m && !NAMESPACE_URI.test(m[0]) && !/^\s*(\*|\/\/)/.test(line)) {
      problems.push(`${rel(f)}:${i + 1}: external URL in shipped code — ${m[0].slice(0, 70)}`);
    }
  });
}
ok.push(`network: ${shippedScanned} shipped files scanned for external URLs`);

function pathToUrl(p) {
  return 'file:///' + p.split(sep).join('/').replace(/^\/+/, '');
}

// ------------------------------------------- 6. the README must not contradict the code
//
// A README that describes a feature the code no longer has — or denies one it now has —
// is worse than no README: people make deployment decisions from it. This caught a real
// case, where "인증이 없습니다" survived the day authentication was added.
{
  const readmePath = join(ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    const serverSrc = existsSync(join(ROOT, 'server.js'))
      ? readFileSync(join(ROOT, 'server.js'), 'utf8')
      : '';

    // Each rule: if the code contains `evidence`, the README must NOT contain `denial`.
    const rules = [
      { feature: '접속 비밀번호', evidence: /SZ_PASSWORD/, denial: /인증이 없습니다|인증·권한 없음|로그인이 없습니다/ },
      { feature: '시트 탭', evidence: /sheets\s*:/, denial: /시트 탭 없음|문서 하나에 시트 한 장/ },
      { feature: '셀 병합', evidence: /normalizeMergeList/, denial: /셀 병합 없음|병합 없음/ },
      { feature: '차트', evidence: /sanitizeChartList/, denial: /차트[^\n]{0,12}없[음습]/ },
      { feature: '정렬·필터', evidence: /sanitizeFilter/, denial: /필터[^\n]{0,12}없[음습]/ },
      { feature: '댓글', evidence: /sanitizeComments/, denial: /댓글[^\n]{0,12}없[음습]/ },
    ];

    let readmeChecked = 0;
    for (const rule of rules) {
      if (!rule.evidence.test(serverSrc)) continue;
      readmeChecked++;
      checks++;
      const hit = readme.match(rule.denial);
      if (!hit) continue;
      const line = readme.slice(0, hit.index).split('\n').length;
      problems.push(
        `README.md:${line}: says "${hit[0]}" but ${rule.feature} is implemented — `
        + 'a README that denies a shipped feature misleads deployment decisions'
      );
    }
    ok.push(`README: ${readmeChecked} of ${rules.length} feature claims cross-checked against the code`);

    // --- the README's function count and function table -------------------------------
    //
    // The README names a number — "내장 함수 114개" — and then lists all of them. Both go
    // stale the moment a function is added or removed, and nothing used to notice: the
    // README's own closing paragraph says its numbers are checked by nobody, which is how
    // three separate wrong counts survived in it. This is the count that CAN be checked
    // mechanically, so it is, and it stops being a promise nobody keeps.
    if (functionNames) {
      // EVERY "함수 N개" in the file, not just the headline one: the same number is
      // repeated in the directory tree, and a check that guards one copy while the other
      // rots is the kind of half-measure this pass exists to stop.
      //
      // The pattern is deliberately wide, so a THIRD copy of the number written later is
      // caught too. The cost of that width is a sentence that says "함수 N개" about
      // something else, which fails here and is fixed by rewording the sentence — the
      // message below says so. A loud false positive costs a minute; a silent stale count
      // is what put three wrong numbers in this file.
      const countClaims = [...readme.matchAll(/함수\s*\*{0,2}(\d+)개/g)];
      if (!countClaims.length) {
        problems.push(
          'README.md: no "함수 N개" claim found — if the count moved or was removed, this '
          + 'check has to move with it, or the number goes back to being unverified'
        );
      }
      for (const claim of countClaims) {
        checks++;
        const claimed = Number(claim[1]);
        if (claimed !== functionNames.size) {
          const line = readme.slice(0, claim.index).split('\n').length;
          problems.push(
            `README.md:${line}: claims 함수 ${claimed}개 but FUNCTIONS holds ${functionNames.size} `
            + '— fix the number, or, if this sentence is not about the built-in function '
            + 'library, reword it so it does not read as "함수 N개"'
          );
        }
      }

      // The listed names, taken from the table rows whose second cell is nothing but a
      // backticked run of function names. Any other table in the file fails that shape.
      const listed = new Set();
      for (const m of readme.matchAll(/^\|[^|\n]+\|\s*`([^`\n]+)`\s*\|\s*$/gm)) {
        const tokens = m[1].split(/\s+/).filter(Boolean);
        if (tokens.length < 3) continue;
        if (!tokens.every((t) => /^[A-Z][A-Z0-9.]*$/.test(t))) continue;
        for (const t of tokens) listed.add(t);
      }
      if (listed.size) {
        checks += 2;
        const ghosts = [...listed].filter((n) => !functionNames.has(n)).sort();
        const unlisted = [...functionNames].filter((n) => !listed.has(n)).sort();
        if (ghosts.length) {
          problems.push(
            `README.md: lists ${ghosts.length} function(s) the code does not have: ${ghosts.join(' ')}`
          );
        }
        if (unlisted.length) {
          problems.push(
            `README.md: does not list ${unlisted.length} function(s) the code ships: ${unlisted.join(' ')}`
          );
        }
        ok.push(`README: ${listed.size} listed function names matched against FUNCTIONS`);
      }
    }
  }
}

// ------------------------------- 7. the SPEC must not contradict the code either
//
// Pass 6 holds the README to the code. Nothing held docs/SPEC.md to it, and docs/SPEC.md
// is the BINDING contract — parallel implementations are written against it without
// reading each other's code, so a false sentence in it becomes a real defect in whatever
// is written next. Six doc-lies were found there by hand across four review rounds. These
// are the classes of them a machine can catch, added the round the fifth and sixth were
// found, so the seventh has to survive a check rather than a reader.
//
// Deliberately NOT here: any attempt to read English and decide whether it is true. Each
// check below compares a LITERAL in the code against the text of the SPEC, which is the
// only comparison that cannot itself be wrong.
{
  const specLines = spec.split('\n');

  // --- 7a. a name stripped out of a sentence -----------------------------------------
  //
  // Two of the six were this: the name of a thing had been removed and the sentence closed
  // over the hole. "stamps the copied range on the table as , so a copy pasted…" — the
  // attribute name is simply gone, and the sentence still reads as prose. A reader
  // implementing from it omits `data-sz-origin` and every cross-tab paste silently stops
  // translating its formulas. The signature is a preposition or a linking verb followed
  // immediately by a comma, or an inline code span with nothing in it.
  {
    const HOLE = /\b(as|is|are|to|via|by|called|named|attribute|key|field|flag)\s+,/;
    let fence = false;
    for (let i = 0; i < specLines.length; i++) {
      const line = specLines[i];
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      checks++;
      if (HOLE.test(line)) {
        problems.push(
          `docs/SPEC.md:${i + 1}: a name looks to have been stripped out of this sentence — `
          + `${line.trim().slice(0, 90)}`
        );
      }
      // An inline code span holding only whitespace. Backticks are paired off in order so
      // that two adjacent spans — `a`   `b` — are not mistaken for one empty one.
      const ticks = [];
      for (let c = 0; c < line.length; c++) if (line[c] === '`') ticks.push(c);
      for (let p = 0; p + 1 < ticks.length; p += 2) {
        if (!line.slice(ticks[p] + 1, ticks[p + 1]).trim()) {
          problems.push(`docs/SPEC.md:${i + 1}: empty inline code span — ${line.trim().slice(0, 90)}`);
          break;
        }
      }
    }
  }

  // --- 7b. the same hole, in a shipped comment ---------------------------------------
  //
  // `//  is what makes an internal paste reproduce the formatting` — the subject of the
  // sentence was the name of the thing, and it went the same way. A `//` block that OPENS
  // on a bare verb is missing its subject. Continuation lines of a wrapped comment start
  // on verbs legitimately and are excluded by the previous-line test; `*` JSDoc bodies are
  // not scanned at all for the same reason.
  {
    const HEADLESS =
      /^\s*\/\/\s{2,}(is|are|was|were|does|do|makes|means|holds|carries|says|lists|names|sets|returns|keeps|gives|takes|tells)\b/;
    for (const f of sources) {
      const lines = readFileSync(f, 'utf8').split('\n');
      checks++;
      for (let i = 0; i < lines.length; i++) {
        if (!HEADLESS.test(lines[i])) continue;
        if (i > 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[i - 1])) continue; // a continuation
        problems.push(
          `${rel(f)}:${i + 1}: comment opens on a bare verb — its subject looks to have been `
          + `stripped: ${lines[i].trim().slice(0, 90)}`
        );
      }
    }
    ok.push(`SPEC: prose and ${sources.length} source files scanned for stripped names`);
  }

  // --- 7c. every path the gate opens without a session must be in the SPEC ------------
  //
  // This is the finding, mechanised. SPEC 28.3 said the open set was "/login, /api/login,
  // /healthz and the static assets /login itself needs (its CSS and nothing more)". The
  // code opens eight paths. The two the sentence lost were /api/logout and — the one that
  // matters — /js/login.js, which public/login.html loads as a module: a gate built from
  // the contract as written answers that request with a 302 to /login, the submit handler
  // never binds, and nobody can log in. An undocumented open path is also a hole in the
  // gate nobody reviewed, so this check is worth having in both directions.
  {
    const serverSrc = existsSync(join(ROOT, 'server.js'))
      ? readFileSync(join(ROOT, 'server.js'), 'utf8')
      : '';
    const block = serverSrc.match(/const\s+OPEN_PATHS\s*=\s*new\s+Set\(\s*\[([^\]]*)\]/);
    if (!block) {
      if (serverSrc) {
        problems.push(
          'server.js: no `const OPEN_PATHS = new Set([...])` found — if the unauthenticated '
          + 'route set moved or was renamed, this check has to move with it, or the open set '
          + 'goes back to being undocumented'
        );
      }
    } else {
      const open = [...block[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]);
      if (!open.length) {
        problems.push('server.js: OPEN_PATHS parsed as empty — the check below would pass vacuously');
      }
      const gate = sectionText(/### 28\.3 /);
      for (const p of open) {
        checks++;
        if (!gate.includes(`\`${p}\``)) {
          problems.push(
            `docs/SPEC.md 28.3: does not name \`${p}\`, which server.js opens without a session `
            + '— a reader building the gate from the contract leaves it closed'
          );
        }
      }
      ok.push(`SPEC 28.3: ${open.length} unauthenticated paths matched against OPEN_PATHS`);
    }
  }

  // --- 7d. clipboard interchange attributes must be documented ------------------------
  //
  // What clipboard.js writes into the markup is an INTERCHANGE FORMAT: another 시트지 tab,
  // and any reimplementation of the paste path, reads it back. `data-sz-origin` was in the
  // code and nowhere in the SPEC, so paste-from-another-tab quietly degraded to verbatim
  // formulas — the wrong-numbers outcome 26.2 says it refuses. Attributes that never leave
  // the process (print.js's iframe marker) are not interchange and are not scanned.
  {
    const clip = join(ROOT, 'public/js/clipboard.js');
    if (existsSync(clip)) {
      const attrs = new Set(
        [...readFileSync(clip, 'utf8').matchAll(/(data-[a-z][a-z0-9-]*)/g)].map((m) => m[1])
      );
      for (const a of attrs) {
        checks++;
        if (!spec.includes(a)) {
          problems.push(
            `docs/SPEC.md: never names \`${a}\`, which public/js/clipboard.js reads or writes `
            + '— the clipboard markup is an interchange format and section 26 is where it is pinned'
          );
        }
      }
      ok.push(`SPEC 26: ${attrs.size} clipboard attributes matched against docs/SPEC.md`);
    }
  }

  // --- 7e. every `SPEC <n>.<n>` citation in the code must resolve --------------------
  //
  // Honesty about the limit of this one: it would NOT have caught the citation that
  // prompted it. main.js pointed its beforeunload exception at "SPEC 28.3", which exists —
  // it is simply about something else, and no checker can see that. What this catches is
  // the rot that follows renumbering: a citation to a section that was merged, split or
  // deleted, which is how a comment stops meaning anything without a single edit to it.
  {
    const headings = new Set();
    for (const m of spec.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)*)[.\s]/gm)) headings.add(m[1]);
    // tools/ is included here and only here: a harness that cites a section which was
    // merged or renumbered is exactly as misleading as a shipped file that does, and it
    // is the file an operator reads when a check fails.
    for (const f of [...sources, ...toolSources]) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bSPEC\s+(\d+(?:\.\d+)?)/g)) {
        checks++;
        if (!headings.has(m[1])) {
          const line = src.slice(0, m.index).split('\n').length;
          problems.push(
            `${rel(f)}:${line}: cites SPEC ${m[1]}, which docs/SPEC.md has no heading for`
          );
        }
      }
    }
    ok.push(
      `SPEC: ${headings.size} numbered sections; every citation in the `
      + `${sources.length + toolSources.length} shipped, test and tool files resolves`
    );
  }
  // --- 7f. every configuration variable must be waiting in .env.example --------------
  //
  // SPEC 28.1 says `SZ_PASSWORD_HASH` is preferred for a real deployment and that
  // `npm run hash-password` prints one; section 0 says .env.example holds the variables of
  // 28.1 and 29.3. Both were true sentences about a file that had no `SZ_PASSWORD_HASH`
  // line in it, and no `SZ_SESSION_DAYS` or `SUPABASE_SCHEMA` line either. The cost is not
  // cosmetic: the operator copies the example, finds no line for the hash, and puts the
  // PLAINTEXT password into an internet-facing environment instead — the exact outcome
  // 28.1 exists to prevent.
  //
  // The source of truth is the CODE, not the prose: every `SZ_*` / `SUPABASE_*` name the
  // shipped tree mentions, plus PORT, which is too generic a word to find by pattern and
  // is named here instead. And the check runs both ways — a variable in the example that
  // nothing reads is a line an operator will fill in and then wonder about for ever.
  {
    const examplePath = join(ROOT, '.env.example');
    if (existsSync(examplePath)) {
      const example = readFileSync(examplePath, 'utf8');

      /**
       * Read but deliberately NOT configuration, so not in the example file.
       *
       * `SUPABASE_ANON_KEY` is read in exactly one place — `redact()` in
       * storage/supabaseStore.js — to blank it out of anything about to be logged, IF the
       * operator happens to have set it for something else. The store never authenticates
       * with it and setting it changes no behaviour, so a line for it in .env.example
       * would invite somebody to paste a key the server has no use for.
       */
      const NOT_CONFIGURATION = new Set(['SUPABASE_ANON_KEY']);

      const wanted = new Set(['PORT']);
      for (const f of shippedSources) {
        const src = readFileSync(f, 'utf8');
        for (const m of src.matchAll(/\b(SZ_[A-Z0-9_]+|SUPABASE_[A-Z0-9_]+)\b/g)) {
          if (!NOT_CONFIGURATION.has(m[1])) wanted.add(m[1]);
        }
      }

      for (const name of [...wanted].sort()) {
        checks++;
        if (!new RegExp(`^${name}=`, 'm').test(example)) {
          problems.push(
            `.env.example: has no \`${name}=\` line, but the shipped code reads it — an `
            + 'operator who copies the example never learns the variable exists'
            + (name === 'SZ_PASSWORD_HASH'
              ? ', and for this one that means deploying the PLAINTEXT password instead,'
                + ' which is the outcome SPEC 28.1 exists to prevent'
              : '')
          );
        }
        checks++;
        if (!new RegExp(`\\b${name}\\b`).test(spec)) {
          problems.push(
            `docs/SPEC.md: never names \`${name}\`, which the shipped code reads — 28.1 and `
            + '29.3 are where the environment is pinned, and an undocumented variable is one '
            + 'nobody reviews'
          );
        }
      }

      // The other direction: a line in the example that nothing reads.
      const offered = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
      for (const name of offered) {
        checks++;
        if (wanted.has(name)) continue;
        problems.push(
          `.env.example offers \`${name}=\`, which no shipped file reads — either the code `
          + 'that used it is gone, or the name is misspelt; an operator filling that line in '
          + 'gets no error and no effect'
        );
      }
      ok.push(
        `.env.example: ${wanted.size} configuration variables present and documented, `
        + `${offered.length} offered lines all read by shipped code`
      );
    }
  }
}

// ------------------------------------------------------------------- report
for (const line of ok) console.log(`  ok  ${line}`);
if (problems.length === 0) {
  console.log(`\ncheck-spec: OK — ${checks} checks passed.`);
  process.exit(0);
}
console.log(`\ncheck-spec: ${problems.length} problem(s)\n`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(1);
