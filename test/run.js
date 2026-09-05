// test/run.js — zero-dependency test runner for the 시트지 project.
//
//   node test/run.js
//
// The *.test.js files register their cases by importing { test, eq, close } from './run.js'.
// That is an import cycle by nature, so the order below matters: this module first defines the
// registry and finishes initialising every export, and only afterwards pulls the test modules in
// with `await import()`. By the time a test file's top-level code calls test(), the registry is
// already live. A static `import './refs.test.js'` at the top would run the test files BEFORE
// this module body and blow up on the temporal dead zone.
//
// THE LAST LINE HAS TO BE TRUE
//
// Everything this runner prints is read by somebody deciding whether the project is safe to
// ship, and the line they actually read is the last one. So the two ways that line could be
// healthy while the suite was not are checked rather than assumed:
//
//   * a *.test.js file that is not in TEST_FILES is never imported, so not one of its cases
//     runs — and nothing anywhere says so. The count simply comes out lower than it would
//     have, which is invisible to anyone who does not know what the number should be;
//   * an empty registry reports "0 passed, 0 failed, 0 total" and exits 0, i.e. a suite that
//     ran nothing at all reports success.
//
// Both are the same mistake as a test case that returns before it asserts: a report of health
// drawn from something nobody looked at. They fail the run, loudly, and say what to do.

import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const registry = [];

// The test files this runner owns, in execution order.
const TEST_FILES = ['./refs.test.js', './formula.test.js', './engine.test.js', './sheets.test.js', './merge.test.js', './format.test.js', './tools.test.js', './data.test.js', './grow.test.js', './outbox.test.js', './import.test.js', './storage.test.js', './journal.test.js', './unread.test.js', './env.test.js', './harness.test.js', './regress.test.js'];

/** Register a test case. `fn` may be synchronous or return a promise. */
export function test(name, fn) {
  if (typeof name !== 'string' || !name) throw new TypeError('test(name, fn): name must be a non-empty string');
  if (typeof fn !== 'function') throw new TypeError('test(name, fn): fn must be a function');
  registry.push({ name, fn, file: '(unregistered)' });
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

// Structural equality: primitives by Object.is (with NaN === NaN), then Date / RegExp / Array /
// Set / Map / plain-or-class objects by their own enumerable keys. Class instances such as
// FormulaError compare by their fields, which is what the tests want.
function deepEqual(a, b, depth) {
  const d = depth || 0;
  if (Object.is(a, b)) return true;
  if (d > 64) return false;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (!isObject(a) || !isObject(b)) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);

  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], d + 1)) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    const rest = Array.from(b);
    for (const x of a) {
      const i = rest.findIndex((y) => deepEqual(x, y, d + 1));
      if (i < 0) return false;
      rest.splice(i, 1);
    }
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k), d + 1)) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k], d + 1)) return false;
  }
  return true;
}

const MAX_FMT = 220;

/** Render any value as a short, readable one-liner for failure messages. */
function fmt(v, depth) {
  const d = depth || 0;
  let out;
  if (typeof v === 'string') out = JSON.stringify(v);
  else if (v === null) out = 'null';
  else if (v === undefined) out = 'undefined';
  else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') out = String(v);
  else if (typeof v === 'function') out = '[Function ' + (v.name || 'anonymous') + ']';
  else if (typeof v === 'symbol') out = String(v);
  else if (d > 4) out = '...';
  else if (v instanceof Date) out = 'Date(' + v.toISOString() + ')';
  else if (Array.isArray(v)) out = '[' + v.map(function (x) { return fmt(x, d + 1); }).join(', ') + ']';
  else if (v instanceof Set) out = 'Set(' + v.size + ') {' + Array.from(v, function (x) { return fmt(x, d + 1); }).join(', ') + '}';
  else if (v instanceof Map) {
    out = 'Map(' + v.size + ') {' + Array.from(v, function (kv) { return fmt(kv[0], d + 1) + ' => ' + fmt(kv[1], d + 1); }).join(', ') + '}';
  } else {
    const name = v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? v.constructor.name + ' ' : '';
    const body = Object.keys(v).map(function (k) { return k + ': ' + fmt(v[k], d + 1); }).join(', ');
    out = name + '{' + body + '}';
  }
  if (d === 0 && out.length > MAX_FMT) out = out.slice(0, MAX_FMT - 3) + '...';
  return out;
}

/** Deep-equality assertion. */
export function eq(actual, expected, msg) {
  if (!deepEqual(actual, expected)) {
    throw new AssertionError((msg ? msg + ': ' : '') + 'expected ' + fmt(expected) + ' but got ' + fmt(actual));
  }
}

/** Numeric assertion with a tolerance (default 1e-9). */
export function close(actual, expected, eps) {
  const tol = eps === undefined ? 1e-9 : eps;
  if (typeof actual !== 'number' || Number.isNaN(actual)) {
    throw new AssertionError('expected a number close to ' + fmt(expected) + ' but got ' + fmt(actual));
  }
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new AssertionError('expected ' + actual + ' to be within ' + tol + ' of ' + expected);
  }
}

function describeError(e) {
  if (e instanceof AssertionError) return e.message;
  if (e && e.stack) return String(e.stack).split('\n').slice(0, 4).join('\n');
  return String(e);
}

function indent(text) {
  return String(text).split('\n').map(function (l) { return '        ' + l; }).join('\n');
}

/**
 * Every *.test.js beside this file that TEST_FILES does not name.
 *
 * A file the list forgot is imported by nothing, so none of its cases exist, so the summary
 * counts them at zero and calls the run green. That is the runner's own version of a case
 * that asserts nothing, and it is silent in exactly the same way.
 *
 * A directory that could not be READ is not an answer either. It is the same distinction the
 * document store draws (SPEC 27.6): "there is nothing missing" is a conclusion, and it may
 * only be drawn from something this process actually saw. So a failed readdir is reported as
 * a problem rather than being quietly treated as an empty list.
 *
 * @returns {string[]} lines to print, empty when everything checks out
 */
function suiteIntegrityProblems() {
  const problems = [];

  let names;
  try {
    names = readdirSync(HERE);
  } catch (e) {
    problems.push(
      'test/ 디렉터리를 읽지 못해, 빠진 테스트 파일이 있는지 확인할 수 없습니다: '
        + ((e && e.message) || String(e))
    );
    return problems;
  }

  const listed = new Set(TEST_FILES);
  const unlisted = names.filter(function (name) {
    return name.endsWith('.test.js') && !listed.has('./' + name);
  }).sort();
  if (unlisted.length) {
    // One entry, not two: the count printed in the summary must be a count of PROBLEMS.
    problems.push(
      'test/run.js 의 TEST_FILES 에 없어서 한 번도 실행되지 않는 테스트 파일이 있습니다: '
        + unlisted.join(', ')
        + ' (TEST_FILES 에 추가하세요. 목록에 없는 파일은 통과도 실패도 하지 않고 그냥 빠집니다.)'
    );
  }

  if (registry.length === 0) {
    problems.push('테스트 케이스가 하나도 등록되지 않았습니다. 아무것도 실행하지 않은 결과는 성공이 아닙니다.');
  }

  return problems;
}

async function main() {
  // Load phase: a test file that fails to import is reported as a load failure instead of
  // taking the whole runner down, so the other files still get a chance to run.
  const loadFailures = [];
  for (const file of TEST_FILES) {
    const from = registry.length;
    try {
      await import(file);
    } catch (e) {
      loadFailures.push({ file, error: e });
    } finally {
      // In `finally`, so the cases a file registered BEFORE it threw are still attributed to
      // it. They run either way — the load failure already fails the whole run — and a case
      // labelled '(unregistered)' in the failure list is a case nobody can find.
      for (let i = from; i < registry.length; i++) registry[i].file = file;
    }
  }

  // Checked after the load phase, so `registry` holds everything the suite is going to run.
  const integrity = suiteIntegrityProblems();

  // Run phase.
  let passed = 0;
  const failures = [];
  let currentFile = null;
  const started = Date.now();

  for (const c of registry) {
    if (c.file !== currentFile) {
      currentFile = c.file;
      console.log('');
      console.log('---- ' + currentFile + ' ----');
    }
    const t0 = Date.now();
    try {
      await c.fn();
      passed++;
      const ms = Date.now() - t0;
      console.log('PASS  ' + c.name + (ms >= 25 ? '  (' + ms + 'ms)' : ''));
    } catch (e) {
      failures.push({ name: c.name, file: c.file, error: e });
      console.log('FAIL  ' + c.name);
      console.log(indent(describeError(e)));
    }
  }

  // Summary.
  const elapsed = Date.now() - started;
  console.log('');
  console.log('========================================');
  for (const lf of loadFailures) {
    console.log('LOAD FAIL  ' + lf.file);
    console.log(indent(describeError(lf.error)));
  }
  if (failures.length) {
    console.log('Failed cases:');
    for (const f of failures) console.log('  - [' + f.file + '] ' + f.name);
  }
  for (const line of integrity) console.log('SUITE FAIL  ' + line);
  console.log(
    passed + ' passed, ' + failures.length + ' failed, ' + registry.length + ' total' +
      (loadFailures.length ? ', ' + loadFailures.length + ' file(s) failed to load' : '') +
      (integrity.length ? ', ' + integrity.length + ' suite problem(s)' : '') +
      '  (' + elapsed + 'ms)'
  );

  if (failures.length || loadFailures.length || integrity.length) process.exit(1);
}

main().catch(function (e) {
  console.error('runner crashed:');
  console.error(e);
  process.exit(1);
});
