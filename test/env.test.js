// test/env.test.js — .env is read at startup, and the real environment still wins.
//
// WHAT THIS FILE IS DEFENDING
//
// Node does not read .env on its own. Before env.js existed, every instruction the README
// and .env.example give an operator — "put SUPABASE_URL in .env", "put SZ_PASSWORD in
// .env" — was quietly false: the file was never opened. The server came up with the file
// backend on a disk the operator believed was unused, and with no password at all on a
// site meant to face the internet. Nothing said so; it simply worked, wrongly.
//
// That failure is invisible from inside the app, which is exactly why it survived. So the
// cases below check it from outside, in a real child process, the way the operator meets
// it:
//
//   1. a value in .env actually reaches process.env;
//   2. a real environment variable BEATS the file, because every host's dashboard and
//      every harness in tools/ sets real variables and all of them must keep working;
//   3. a missing .env is normal and silent — `npm start` works without one;
//   4. server.js imports env.js BEFORE anything else. This is the half that cannot be
//      checked by exercising env.js alone, and it is the half that breaks silently:
//      storage/index.js reads SUPABASE_URL at ITS module scope, and every import of a
//      module is evaluated before the importing module's first statement. env.js loaded
//      one line too late is env.js not loaded at all;
//   5. and the whole chain end to end — a .env on disk deciding which backend a real
//      `node server.js` announces.
//
// Cases 1 to 3, and the unreadable-.env case with them, run against a COPY of env.js in a
// throwaway directory. env.js resolves its .env from its own file location, so testing it
// in place would mean writing a .env into the project root, next to the operator's own.
// Case 4 reads server.js as text and needs nothing.
//
// Case 5 needs a whole server rather than one module, so it copies one: env.js, server.js
// and the two directories they import go into a SANDBOX, and `node server.js` boots there.
// Nothing it does can reach the operator's .env, which is the entire reason it is built
// that way. The earlier version of this case wrote its .env into the real project root and
// therefore had to stand down whenever a .env was already sitting there — silently, and
// still counted as a pass. That is the state the README instructs every operator to create,
// so the one case that proves the whole chain went dark on exactly the machines that need
// it, and the summary said 870 passed either way. A case that disappears where it matters
// is worse than no case at all, so the collision is removed rather than handled.
//
// The sandbox lives INSIDE the project root on purpose. Node resolves a bare specifier by
// walking up the parent directories looking for node_modules, so a copy one level down
// finds the project's own express and ws; a directory under the system temp folder would
// find neither, and copying node_modules into one is not something a test may do.

import { test, eq } from './run.js';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_JS = join(ROOT, 'env.js');

// Names no host and no operator would ever have set, so a value seen in the child came
// from this test and nothing else.
const KEY_A = 'SZ_ENVTEST_ALPHA';
const KEY_B = 'SZ_ENVTEST_BRAVO';

/**
 * Source for the child. It imports the copied env.js exactly as server.js imports the
 * real one — for its side effect, first — and reports what the environment looks like
 * afterwards.
 *
 * A template literal, so tools/check-imports.mjs does not try to resolve a specifier that
 * belongs to another directory entirely.
 */
const PROBE = `
import * as env from './env.js';

const report = {
  loaded: env.loadedEnvFile,
  applied: env.appliedKeys,
  overridden: env.overriddenKeys,
  values: {},
};
for (const key of process.argv.slice(1)) {
  report.values[key] = process.env[key] === undefined ? null : process.env[key];
}
console.log('ENVTEST ' + JSON.stringify(report));
`;

/**
 * Run the probe in a throwaway directory holding a copy of env.js and, optionally, a
 * .env. Returns the parsed report plus the child's exit status.
 */
function runProbe({ dotenv = null, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sz-env-'));
  try {
    copyFileSync(ENV_JS, join(dir, 'env.js'));
    writeFileSync(join(dir, 'probe.mjs'), PROBE, 'utf8');
    if (dotenv !== null) writeFileSync(join(dir, '.env'), dotenv, 'utf8');

    // The parent's own environment minus the names these cases care about, so a stray
    // value in the shell running the tests cannot change an answer.
    const childEnv = { ...process.env };
    delete childEnv[KEY_A];
    delete childEnv[KEY_B];
    Object.assign(childEnv, env);

    const run = spawnSync(process.execPath, ['probe.mjs', KEY_A, KEY_B], {
      cwd: dir,
      env: childEnv,
      encoding: 'utf8',
      timeout: 30000,
    });
    const stdout = run.stdout || '';
    const line = stdout.split('\n').find((l) => l.startsWith('ENVTEST '));
    return {
      status: run.status,
      stdout,
      stderr: run.stderr || '',
      report: line ? JSON.parse(line.slice('ENVTEST '.length)) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

test('env: a value in .env actually reaches process.env at startup', () => {
  const out = runProbe({ dotenv: `${KEY_A}=파일에서\n${KEY_B}=두번째\n` });
  eq(out.status, 0, `probe exited ${out.status}: ${out.stderr.slice(-400)}`);
  eq(!!out.report, true, `no report on stdout: ${out.stdout.slice(-400)}`);
  eq(out.report.values[KEY_A], '파일에서', 'the .env value did not reach process.env');
  eq(out.report.values[KEY_B], '두번째');
  eq(out.report.loaded, true, 'loadedEnvFile must say the file was read');
  eq(out.report.applied.includes(KEY_A), true, `appliedKeys=${JSON.stringify(out.report.applied)}`);
  eq(out.report.applied.includes(KEY_B), true);
});

test('env: a real environment variable overrides .env', () => {
  const out = runProbe({
    dotenv: `${KEY_A}=파일에서\n${KEY_B}=두번째\n`,
    env: { [KEY_A]: '환경변수에서' },
  });
  eq(out.status, 0, `probe exited ${out.status}: ${out.stderr.slice(-400)}`);
  eq(out.report.values[KEY_A], '환경변수에서',
    'the file must not overwrite a variable the environment already set');
  // The other key is untouched by the override, so the file is still being read.
  eq(out.report.values[KEY_B], '두번째');
  eq(out.report.applied.includes(KEY_A), false,
    'a key the environment already held was not applied FROM the file');
  eq(out.report.overridden.includes(KEY_A), true,
    `overriddenKeys must report it: ${JSON.stringify(out.report.overridden)}`);
});

test('env: a missing .env is normal, silent, and does not stop startup', () => {
  const out = runProbe({ dotenv: null });
  eq(out.status, 0, `probe exited ${out.status}: ${out.stderr.slice(-400)}`);
  eq(out.report.loaded, false, 'there was no file to load');
  eq(out.report.values[KEY_A], null);
  eq(out.report.applied.length, 0, JSON.stringify(out.report.applied));
  eq(out.stderr.trim(), '', `a missing .env must print nothing to stderr: ${out.stderr}`);
});

test('env: an unreadable .env stops the boot instead of starting half-configured', () => {
  // A directory named .env is the cheapest way to produce "the file exists and cannot be
  // read" on every platform. Booting anyway is the failure this whole file is about: the
  // operator's configuration exists, was not applied, and nothing said so.
  const dir = mkdtempSync(join(tmpdir(), 'sz-env-'));
  try {
    copyFileSync(ENV_JS, join(dir, 'env.js'));
    writeFileSync(join(dir, 'probe.mjs'), PROBE, 'utf8');
    mkdirSync(join(dir, '.env'));
    const run = spawnSync(process.execPath, ['probe.mjs', KEY_A], {
      cwd: dir, env: process.env, encoding: 'utf8', timeout: 30000,
    });
    eq(run.status !== 0, true, 'an unreadable .env must not boot successfully');
    eq(/\.env/.test(run.stderr || ''), true,
      `the failure must name the file: ${(run.stderr || '').slice(-300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env: server.js imports env.js before anything else', () => {
  // The ordering IS the feature. storage/index.js reads SUPABASE_URL at its own module
  // scope, and ESM evaluates every import before the importing module's first statement,
  // so an env.js loaded second is an env.js that changed nothing.
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const imports = src
    .split('\n')
    .map((line) => /^\s*import\s+(?:.*\s+from\s+)?['"]([^'"]+)['"]/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
  eq(imports.length > 0, true, 'server.js has no imports at all');
  eq(imports[0], './env.js',
    `server.js must import ./env.js first, but its first import is '${imports[0]}'`);
});

// --------------------------------------------------------------- the sandbox
//
// Case 5 boots a REAL server, so it needs a real tree to boot from. Everything below
// builds one, uses it, and — the half that actually matters — is answerable for removing
// it again.

/**
 * What `node server.js` needs in order to get as far as announcing which store it chose.
 *
 * public/ is deliberately absent: computeBuildId() tolerates a missing directory and the
 * boot line is printed long before anything is served, so copying a client nobody loads
 * would only make the case slower.
 */
const SERVER_TREE = ['env.js', 'server.js', 'storage', 'shared'];

/**
 * The sandbox name. Dot-prefixed because tools/check-imports.mjs and tools/check-spec.mjs
 * both skip names beginning with a dot, so even a sandbox that outlived its run can never
 * become a second copy of server.js that the project's own checks try to analyse.
 */
const SANDBOX_PREFIX = '.sz-envtest-';

/** Sandboxes this process created and has not removed yet. */
const sandboxes = new Set();

/** A private copy of the server, inside the project root so node_modules resolves. */
function makeSandbox() {
  const dir = mkdtempSync(join(ROOT, SANDBOX_PREFIX));
  sandboxes.add(dir);
  for (const entry of SERVER_TREE) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  return dir;
}

/**
 * Remove a sandbox, and never throw doing it.
 *
 * `maxRetries` is not decoration: on Windows a process that has just been killed can hold
 * its working directory open for a moment after its exit event, and a first attempt then
 * fails with EBUSY or EPERM.
 */
function removeSandbox(dir) {
  sandboxes.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    /* the exit hook below and the sweep further down each get another go at it */
  }
}

// The last net, the way test/unreadable.js does it. A run killed between the copy and the
// removal must not leave a copy of the server sitting in the operator's project, and an
// exit hook is the only cleanup that still runs when a case throws or somebody presses
// Ctrl-C.
process.on('exit', () => {
  for (const dir of [...sandboxes]) removeSandbox(dir);
});

/**
 * Clear sandboxes an earlier run was killed before it could remove.
 *
 * Only ones older than an hour, so a second `npm test` started a moment ago keeps its
 * own. Nothing inside a sandbox is precious — every file in it is a copy — but deleting a
 * directory another process is booting out of would produce a failure nobody could read.
 */
function sweepStaleSandboxes() {
  let names;
  try {
    names = readdirSync(ROOT);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const dir = join(ROOT, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
    } catch {
      continue;
    }
    removeSandbox(dir);
  }
}

/**
 * A fingerprint of the operator's own .env, taken WITHOUT opening it.
 *
 * The case below has to be able to prove it left that file alone, and the honest way to
 * prove that is never to read it: size and mtime come from `stat`, so a password or a
 * service key in it cannot reach this process, let alone a failure message. A file that
 * cannot be stat'ed is described by its errno, which is still a stable answer to compare.
 */
function rootEnvFingerprint() {
  try {
    const st = statSync(join(ROOT, '.env'));
    return `${st.size}:${st.mtimeMs}`;
  } catch (err) {
    return err && err.code === 'ENOENT' ? '없음' : `읽을 수 없음:${(err && err.code) || 'UNKNOWN'}`;
  }
}

/**
 * Names that could decide the answer, cleared out of the child's environment.
 *
 * DELETED, never set to `''`. An empty string is still a value as far as env.js is
 * concerned, and a variable the environment already holds beats the file (rule 1) — so
 * blanking them would silence the very thing this case exists to prove. Deleting them
 * also keeps whatever the operator has exported in their own shell out of the result: a
 * stray SZ_PASSWORD_HASH would stop the boot before the line this case reads.
 */
const DECIDING_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SCHEMA',
  'SZ_PASSWORD',
  'SZ_PASSWORD_HASH',
  'SZ_SESSION_SECRET',
  'SZ_SESSION_DAYS',
];

function sandboxEnv(port) {
  const env = { ...process.env, PORT: String(port) };
  for (const key of DECIDING_KEYS) delete env[key];
  return env;
}

/**
 * Boot a real `node server.js` in `cwd` and return everything it printed up to `wanted`.
 *
 * The child is killed the moment that line arrives rather than waited out. A server that
 * boots successfully never exits on its own, and one that fails may exit at any point, so
 * "run it and read the output afterwards" would either hang for the whole timeout or
 * depend on how the failure happens to end. This reads the one line the case is about.
 *
 * It then waits for the child to be GONE before resolving. The caller deletes the
 * directory the child was running in, and a process that is still alive holds it open.
 */
function bootAndReadLog({ cwd, env, wanted, timeoutMs = 25000 }) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let failure = null;
    let stopping = false;
    let settled = false;
    let grace = null;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (failure) fail(failure);
      else done(out);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // If 'close' never arrives, resolve anyway rather than hanging the whole suite.
      grace = setTimeout(settle, 5000);
    };

    const timer = setTimeout(stop, timeoutMs);
    const absorb = (chunk) => {
      out += chunk.toString();
      if (wanted.test(out)) stop();
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);
    child.on('error', (err) => { failure = err; stop(); });
    child.on('close', settle);
  });
}

// The line storage/index.js prints at boot, naming the store it actually chose.
const STORAGE_LINE = /문서 저장소: /;
// Shaped like a service key and worth nothing, so the assertion that it never reaches the
// output is a real one.
const FAKE_KEY = 'sz_envtest_not_a_real_key';

test('env: a .env on disk decides the backend a real server boots with', async () => {
  // The end-to-end version of every case above: env.js in place, server.js importing it
  // first, storage/index.js choosing from what it finds. Nothing else proves the ORDER
  // holds in the real module graph rather than in a copy of one module.
  //
  // BOTH halves are booted, out of the same tree, so the file is demonstrably what changed
  // the answer: with no .env the server must choose the file store, and with one it must
  // choose Supabase. Asserting only the second half would pass just as well against a
  // server that said Supabase whatever it read.
  //
  // The address is 127.0.0.1:1 — this machine, on a port nothing listens on. The backend
  // cannot connect, which is fine and even useful: the boot line naming it is printed
  // before the first request, and a server that cannot reach its database never touches
  // data/ either. A harness must never point itself at anything else (see
  // tools/harness-env.mjs), and neither does this.
  sweepStaleSandboxes();
  const dir = makeSandbox();
  const envBefore = rootEnvFingerprint();
  try {
    const withoutFile = await bootAndReadLog({
      cwd: dir, env: sandboxEnv(39587), wanted: STORAGE_LINE,
    });
    eq(/문서 저장소: 파일/.test(withoutFile), true,
      `with no .env the server must choose the file store: ${withoutFile.slice(0, 800)}`);
    eq(/문서 저장소: Supabase/.test(withoutFile), false,
      'nothing configured Supabase, so nothing may announce it');

    // The only thing that differs between the two boots.
    writeFileSync(
      join(dir, '.env'),
      `SUPABASE_URL=http://127.0.0.1:1\nSUPABASE_SERVICE_KEY=${FAKE_KEY}\n`,
      'utf8',
    );

    const withFile = await bootAndReadLog({
      cwd: dir, env: sandboxEnv(39588), wanted: STORAGE_LINE,
    });
    eq(/문서 저장소: Supabase \(127\.0\.0\.1:1\)/.test(withFile), true,
      `the boot log must show the backend the .env chose: ${withFile.slice(0, 800)}`);
    eq(/문서 저장소: 파일/.test(withFile), false, 'it must not also have chosen the file store');
    eq(withFile.includes(FAKE_KEY), false,
      'the service key must never appear in anything the server prints');
  } finally {
    removeSandbox(dir);
  }
  // And the file this case used to fight over was never created, changed or removed.
  eq(rootEnvFingerprint(), envBefore,
    "the operator's own .env must be exactly as it was before this case ran");
});
