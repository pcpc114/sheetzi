#!/usr/bin/env node
/**
 * Static import checker.
 *
 * Walks every .js file in shared/, public/js/, test/ and server.js, extracts every
 * import/export-from specifier, and verifies:
 *   1. the target file actually exists on disk (with the exact extension);
 *   2. every NAMED symbol imported from it is actually exported there;
 *   3. no file under shared/ touches a node: builtin, an npm bare specifier,
 *      or a browser global (that tree runs in BOTH runtimes);
 *   4. no client file imports a bare specifier (there is no bundler).
 *
 * This is the single highest-yield check for a codebase whose modules were written
 * against a spec in isolation: a signature drift shows up here as a missing export
 * long before it shows up as a runtime crash in the browser.
 *
 * Usage: node tools/check-imports.mjs
 * Exits non-zero if anything is wrong.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function add(file, line, msg) {
  problems.push({ file: rel(file), line, msg });
}
function rel(p) {
  return relative(ROOT, p).split(sep).join('/');
}

/** Recursively collect .js files, skipping node_modules and data. */
function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'data' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/**
 * Single-pass scanner that classifies every region of a JS source as code, comment,
 * string, template or regex literal. Everything downstream is built on this, because
 * naive regexes over raw source produce false positives that are worse than no check
 * at all — e.g. the word `document` inside an error message, or a quote character
 * inside a character class like /['"]/ swallowing the rest of the file.
 *
 * Returns two rewritten copies, both byte-for-byte the same length as the input so
 * line numbers stay valid:
 *   codeOnly    — comments AND all literal bodies blanked (quotes kept)
 *   withStrings — comments and regex/template bodies blanked, plain string bodies kept
 *                 (import specifiers live inside those, so they must survive)
 */
function scan(src) {
  const n = src.length;
  const code = new Array(n);
  const strs = new Array(n);
  const keep = (i) => { code[i] = src[i]; strs[i] = src[i]; };
  const blankBoth = (i) => { const c = src[i] === '\n' ? '\n' : ' '; code[i] = c; strs[i] = c; };
  const blankCodeOnly = (i) => { code[i] = src[i] === '\n' ? '\n' : ' '; strs[i] = src[i]; };

  // Tracks the last significant code character, to tell a regex literal from division.
  let prevSig = '';
  const REGEX_OK_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await']);

  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // line comment
    if (c === '/' && c2 === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      for (; i < stop; i++) blankBoth(i);
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) blankBoth(i);
      continue;
    }
    // string literal — quotes survive in `strs` so `from '...'` still matches there
    if (c === '"' || c === "'") {
      keep(i); i++;
      while (i < n) {
        if (src[i] === '\\') { blankCodeOnly(i); if (i + 1 < n) blankCodeOnly(i + 1); i += 2; continue; }
        if (src[i] === c) { keep(i); i++; break; }
        if (src[i] === '\n') break; // unterminated; bail rather than eat the file
        blankCodeOnly(i); i++;
      }
      prevSig = 'x';
      continue;
    }
    // template literal — blanked everywhere (may contain anything, incl. ${})
    if (c === '`') {
      keep(i); i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { blankBoth(i); if (i + 1 < n) blankBoth(i + 1); i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; blankBoth(i); blankBoth(i + 1); i += 2; continue; }
        if (src[i] === '}' && depth > 0) { depth--; blankBoth(i); i++; continue; }
        if (src[i] === '`' && depth === 0) { keep(i); i++; break; }
        blankBoth(i); i++;
      }
      prevSig = 'x';
      continue;
    }
    // regex literal (heuristic: only where an expression may start)
    if (c === '/' && REGEX_OK_BEFORE.has(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        keep(i);
        for (let k = i + 1; k < j; k++) blankBoth(k);
        keep(j);
        i = j + 1;
        while (i < n && /[a-z]/.test(src[i])) { keep(i); i++; } // flags
        prevSig = 'x';
        continue;
      }
    }

    keep(i);
    if (!/\s/.test(c)) {
      // Capture trailing keywords so `return /re/` is recognised.
      if (/[A-Za-z]/.test(c)) {
        let k = i;
        while (k > 0 && /[A-Za-z]/.test(src[k - 1])) k--;
        let e = i;
        while (e + 1 < n && /[A-Za-z]/.test(src[e + 1])) e++;
        prevSig = src.slice(k, e + 1);
      } else {
        prevSig = c;
      }
    }
    i++;
  }

  for (let k = 0; k < n; k++) {
    if (code[k] === undefined) code[k] = src[k] === '\n' ? '\n' : ' ';
    if (strs[k] === undefined) strs[k] = src[k] === '\n' ? '\n' : ' ';
  }
  return { codeOnly: code.join(''), withStrings: strs.join('') };
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/** Extract exported names from a module's source. */
function exportsOf(src) {
  const names = new Set();
  const clean = scan(src).codeOnly;
  const re = /\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of clean.matchAll(re)) names.add(m[1]);
  // export { a, b as c }
  for (const m of clean.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/\bexport\s+default\b/.test(clean)) names.add('default');
  if (/\bexport\s*\*\s*from\b/.test(clean)) names.add('*');
  return names;
}

/** Extract every static import / export-from in a file. */
function importsOf(src) {
  const clean = scan(src).withStrings;
  const found = [];

  // import ... from 'spec'   |   export ... from 'spec'   |   import 'spec'
  const re =
    /\b(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]|(\bimport\s*['"]([^'"]+)['"])/g;
  for (const m of clean.matchAll(re)) {
    if (m[2] !== undefined) {
      found.push({ clause: m[1] || '', spec: m[2], index: m.index });
    } else {
      found.push({ clause: '', spec: m[4], index: m.index, sideEffect: true });
    }
  }
  // dynamic import('spec') with a literal
  for (const m of clean.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ clause: '', spec: m[1], index: m.index, dynamic: true });
  }
  return found;
}

/** Parse the named bindings out of an import clause. */
function namedBindings(clause) {
  const out = [];
  const brace = clause.match(/\{([\s\S]*?)\}/);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const orig = t.split(/\s+as\s+/)[0].trim();
      if (orig) out.push(orig);
    }
  }
  const hasDefault = /^\s*(?:type\s+)?[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause.replace(/\{[\s\S]*?\}/, ''));
  return { named: out, hasDefault, namespace: /\*\s+as\s+/.test(clause) };
}

/** Resolve a specifier to an absolute path, or null when it is a bare/package specifier. */
function resolveSpec(fromFile, spec) {
  if (spec.startsWith('/')) return join(ROOT, spec.slice(1)); // browser-absolute -> web root is ROOT
  if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
  return null;
}

const ALLOWED_SERVER_BARE = new Set([
  'express', 'ws',
  'node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:http', 'node:crypto',
  'node:process', 'node:os', 'node:events', 'node:util', 'node:stream', 'node:buffer',
  'node:timers', 'node:timers/promises', 'node:assert', 'node:child_process',
]);

const files = [
  ...collect(join(ROOT, 'shared')),
  ...collect(join(ROOT, 'public', 'js')),
  ...collect(join(ROOT, 'test')),
  ...collect(join(ROOT, 'tools')),
  ...(existsSync(join(ROOT, 'server.js')) ? [join(ROOT, 'server.js')] : []),
];

if (files.length === 0) {
  console.error('check-imports: no source files found — has the build run?');
  process.exit(2);
}

const exportCache = new Map();
function exportsFor(path) {
  if (!exportCache.has(path)) {
    exportCache.set(path, existsSync(path) ? exportsOf(readFileSync(path, 'utf8')) : null);
  }
  return exportCache.get(path);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const clean = scan(src).codeOnly;
  const isShared = rel(file).startsWith('shared/');
  const isClient = rel(file).startsWith('public/');

  // --- Rule 3: shared/ must be runtime-agnostic ---------------------------------
  if (isShared) {
    for (const m of clean.matchAll(/\b(?:window|document|localStorage|navigator|fetch|alert)\b/g)) {
      add(file, lineOf(src, m.index), `shared/ must not use the browser global \`${m[0]}\``);
    }
    for (const m of clean.matchAll(/\bprocess\s*\./g)) {
      add(file, lineOf(src, m.index), 'shared/ must not use `process` (it runs in the browser too)');
    }
  }

  // --- Import checks ------------------------------------------------------------
  for (const imp of importsOf(src)) {
    const line = lineOf(src, imp.index);
    const target = resolveSpec(file, imp.spec);

    if (target === null) {
      // bare specifier
      if (isShared) {
        add(file, line, `shared/ must not import the bare specifier '${imp.spec}'`);
      } else if (isClient) {
        add(file, line, `client code cannot import bare specifier '${imp.spec}' (there is no bundler)`);
      } else if (!ALLOWED_SERVER_BARE.has(imp.spec)) {
        add(file, line, `unexpected dependency '${imp.spec}' — only express, ws and node: builtins are allowed`);
      }
      continue;
    }

    if (!/\.(?:js|mjs|json|css)$/.test(imp.spec)) {
      add(file, line, `import specifier '${imp.spec}' is missing its file extension (native ESM requires it)`);
      continue;
    }

    if (!existsSync(target)) {
      add(file, line, `import '${imp.spec}' does not resolve — ${rel(target)} does not exist`);
      continue;
    }

    if (imp.sideEffect || imp.dynamic) continue;

    const targetExports = exportsFor(target);
    if (!targetExports || targetExports.has('*')) continue;

    const { named, hasDefault } = namedBindings(imp.clause);
    for (const name of named) {
      if (!targetExports.has(name)) {
        add(file, line, `imports { ${name} } from '${imp.spec}' but ${rel(target)} does not export it`);
      }
    }
    if (hasDefault && !targetExports.has('default')) {
      add(file, line, `imports a default binding from '${imp.spec}' but ${rel(target)} has no default export`);
    }
  }
}

// --- Report --------------------------------------------------------------------
if (notes.length) for (const n of notes) console.log(`note: ${n}`);

if (problems.length === 0) {
  console.log(`check-imports: OK — ${files.length} files, every specifier and named import resolves.`);
  process.exit(0);
}

const byFile = new Map();
for (const p of problems) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
}
console.log(`check-imports: ${problems.length} problem(s) in ${byFile.size} file(s)\n`);
for (const [file, list] of [...byFile].sort()) {
  console.log(file);
  for (const p of list.sort((a, b) => a.line - b.line)) {
    console.log(`  ${String(p.line).padStart(5)}  ${p.msg}`);
  }
  console.log('');
}
process.exit(1);
