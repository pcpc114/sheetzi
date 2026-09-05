// test/harness.test.js — the test tools may never touch anything but a local stand-in.
//
// WHAT THIS IS DEFENDING, AND WHY IT IS A TEST RATHER THAN A CONVENTION
//
// tools/crash.mjs, tools/smoke.mjs, tools/auth.mjs and tools/browser.mjs are destructive
// on purpose. They plant corrupt journal records, SIGKILL the server in the middle of a
// write, and delete documents. That was safe only for as long as nothing outside a
// harness could choose which store the server they boot writes to.
//
// server.js now reads .env at startup — which is what every instruction we give an
// operator always claimed. So an operator who configures Supabase the way the README
// tells them to has SUPABASE_URL for their REAL project sitting in .env, and a plain
// `npm run verify` would point every one of those destructive cases at it. Their own test
// suite would delete their own documents. There is no worse outcome available to this
// codebase, and "we will remember not to" is not a defence.
//
// tools/harness-env.mjs is the defence: one funnel that writes every backend and auth
// variable explicitly, refuses an environment it did not build, checks with a probe what
// the server will really see, and rejects any target that is not on this machine. The
// cases below hold that funnel in place — the ban is checked as a fact about the source,
// so a future harness that reaches for spawn() directly fails `npm test` rather than
// quietly working on the machine of whoever wrote it.

import { test, eq } from './run.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARDED_KEYS, SANDBOX_MARK, harnessEnv, isLocalTarget, spawnServer } from '../tools/harness-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');

/** Every harness that boots server.js. Named, so removing the guard from one is a failure. */
const HARNESSES = ['crash.mjs', 'smoke.mjs', 'auth.mjs', 'browser.mjs'];

function toolSource(name) {
  return readFileSync(join(TOOLS, name), 'utf8');
}

/**
 * Run `fn` with console.error captured.
 *
 * The guard prints a loud banner whenever it refuses, and it prints it unconditionally —
 * a harness that could ask it to be quiet would be a harness that could ask it to look
 * away. So the noise is swallowed here, at the one place that provokes a refusal on
 * purpose, rather than made optional there.
 */
function refusalOf(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  } finally {
    console.error = real;
  }
}

test('harness: nothing in tools/ starts server.js except through harness-env.mjs', () => {
  // The pattern is "spawn a node process whose script is server.js", in any of the shapes
  // node offers. Only the guard itself is allowed to be that place.
  const direct = /(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(\s*process\.execPath[\s\S]{0,240}?server\.js/;
  const offenders = [];
  for (const name of readdirSync(TOOLS)) {
    if (!name.endsWith('.mjs') || name === 'harness-env.mjs') continue;
    if (direct.test(toolSource(name))) offenders.push(name);
  }
  eq(offenders, [],
    `these tools boot server.js without the guard in tools/harness-env.mjs: ${offenders.join(', ')}`);
});

test('harness: every harness that boots the server goes through the guard', () => {
  for (const name of HARNESSES) {
    const src = toolSource(name);
    eq(/from '\.\/harness-env\.mjs'/.test(src), true,
      `tools/${name} must import tools/harness-env.mjs`);
    eq(/\bspawnServer\s*\(/.test(src) || /spawnGuardedServer\s*\(/.test(src), true,
      `tools/${name} must boot the server through the guard's spawnServer`);
    eq(/\bharnessEnv\s*\(/.test(src), true,
      `tools/${name} must build its child environment with harnessEnv`);
  }
});

test('harness: harnessEnv blanks every variable that could select a real backend', () => {
  const before = {};
  for (const key of GUARDED_KEYS) {
    before[key] = process.env[key];
    // Stand in for an operator's own configuration reaching the harness process.
    process.env[key] = 'ambient-value-that-must-not-survive';
  }
  try {
    const env = harnessEnv({ PORT: '39999' }, { label: 'harness.test' });
    for (const key of GUARDED_KEYS) {
      eq(env[key], '', `${key} must be written empty, not inherited`);
    }
    eq(env.PORT, '39999', 'what the harness asked for is kept');
    eq(env[SANDBOX_MARK], '1', 'the environment must carry the marker spawnServer demands');
  } finally {
    for (const key of GUARDED_KEYS) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('harness: a non-local backend target is refused before anything is spawned', () => {
  const err = refusalOf(() => {
    harnessEnv({ SUPABASE_URL: 'https://someproject.supabase.co' }, { label: 'harness.test' });
  });
  eq(!!err && err.harnessGuard === true, true,
    'a hosted Supabase URL must abort the harness, never be run against');

  // And the same judgement, on its own, for every shape a target can take.
  eq(isLocalTarget(''), true, 'no backend configured is the local file store');
  eq(isLocalTarget('http://127.0.0.1:5551'), true);
  eq(isLocalTarget('http://localhost:5551/rest/v1'), true);
  eq(isLocalTarget('https://someproject.supabase.co'), false);
  eq(isLocalTarget('https://127.0.0.1.example.com'), false, 'a look-alike host is not local');
  eq(isLocalTarget('not a url at all'), false, 'an address nobody can parse is not local');
  eq(isLocalTarget('file:///etc/passwd'), false);
});

test('harness: spawnServer refuses an environment the guard did not build', () => {
  // Exactly what a future harness would write without thinking about it — and exactly
  // what carries the operator's .env straight into a destructive suite.
  const err = refusalOf(() => {
    spawnServer({ env: { ...process.env, PORT: '39999' }, label: 'harness.test' });
  });
  eq(!!err && err.harnessGuard === true, true,
    'an environment without the marker must never boot a server');
});
