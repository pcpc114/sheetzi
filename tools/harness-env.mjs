// tools/harness-env.mjs — the ONE way a harness is allowed to start server.js.
//
// WHY THIS FILE EXISTS
//
// The harnesses are destructive by design. They plant corrupt records, SIGKILL the
// server mid-write, delete documents and empty tables. That was harmless for as long as
// the server could only ever be pointed at a backend by a variable the harness itself
// set — nothing else in the process's environment reached it.
//
// env.js changed that. server.js now reads .env at startup, which is exactly what an
// operator was always told it did. So the moment somebody configures Supabase the way
// the README tells them to, their .env holds SUPABASE_URL for their REAL project, and a
// plain `npm run verify` would run every one of those destructive cases against it.
// Their own test suite would delete their own documents. That is the single worst thing
// this codebase could do, so it is made impossible here rather than remembered in four
// places.
//
// THE MECHANISM, and why it cannot be forgotten
//
//   1. `harnessEnv()` is the only way to build the child environment. It writes EVERY
//      guarded variable explicitly — empty unless the caller asked for something — so a
//      harness gets a neutral environment by DEFAULT rather than by remembering to ask.
//      A value the harness did not choose can never reach the server.
//   2. `spawnServer()` refuses an environment that did not come from `harnessEnv()`. A
//      future harness that hand-rolls `{ ...process.env }` is rejected at the first boot,
//      not silently trusted.
//   3. Before the first spawn under a given configuration, a PROBE process loads the real
//      env.js and reports what the server would actually see. If .env can still override
//      what the harness set — a platform that drops empty environment variables, say —
//      that is caught before any server exists, not hoped away.
//   4. Every target is checked against the local stand-ins. A non-local host aborts the
//      harness, and the child's boot log is watched for the storage line so even a server
//      that somehow reached a real project is killed as it announces it.
//
// Rule 1 alone would very nearly do it. All four exist because the cost of being wrong
// here is somebody's data, and each of them fails in a different direction.

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The marker `harnessEnv` stamps on the environments it builds, and `spawnServer`
 * demands. server.js never reads it; its only job is to prove where the environment
 * came from.
 */
export const SANDBOX_MARK = 'SZ_HARNESS_SANDBOX';

/**
 * Every variable that can point the server at somebody's real data or change what the
 * harness is testing. All of them are written explicitly on every spawn, so nothing in
 * the ambient environment — a shell export, or the operator's .env — decides anything.
 *
 * Adding a variable that selects a backend, or unlocks one, means adding it here.
 */
export const GUARDED_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SCHEMA',
  'SZ_PASSWORD',
  'SZ_PASSWORD_HASH',
  'SZ_SESSION_SECRET',
  'SZ_SESSION_DAYS',
];

/** Guarded variables that name a host the server will send document data to. */
const TARGET_KEYS = ['SUPABASE_URL'];

/**
 * The only hosts a harness may point a backend at: this machine, where the stand-in in
 * tools/fakesupabase.mjs runs. Anything else is somebody's database.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/**
 * True when `value` names nothing at all (the file backend) or a host on this machine.
 *
 * A value that cannot be parsed as a URL is NOT local. The safe answer to "I do not
 * understand this address" is to refuse, because the alternative is to run a suite that
 * deletes documents against an address nobody checked.
 */
export function isLocalTarget(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return true; // no backend configured: the local file store
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOCAL_HOSTS.has(url.hostname) || LOCAL_HOSTS.has(`[${url.hostname}]`);
}

/** A target host for a message, without the path or any credentials in the URL. */
function describeTarget(value) {
  try {
    return new URL(String(value)).host;
  } catch {
    return '(주소를 해석할 수 없음)';
  }
}

function abort(lines) {
  const banner = '='.repeat(72);
  console.error(`\n${banner}`);
  for (const line of lines) console.error(line);
  console.error(`${banner}\n`);
  const err = new Error(lines[0]);
  err.harnessGuard = true;
  return err;
}

/**
 * Build the environment for a server the harness owns.
 *
 * Everything in `GUARDED_KEYS` is written explicitly: `''` unless `extra` names it. An
 * empty value reads as "not configured" in server.js and in storage/index.js, and — this
 * is the part that matters now — it also WINS over .env, because a variable already
 * present in the real environment takes precedence over the file (the rule env.js is
 * built on). So the operator's own configuration is neutral for this process without
 * their file being touched, moved or read.
 *
 * `extra` is for what the harness deliberately wants: PORT, the stand-in's URL, a
 * password the auth suite is testing. A non-local target in it is refused here.
 */
export function harnessEnv(extra = {}, { label = 'harness' } = {}) {
  const env = { ...process.env };
  for (const key of GUARDED_KEYS) env[key] = '';
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value === undefined || value === null ? '' : String(value);
  }
  env[SANDBOX_MARK] = '1';

  for (const key of TARGET_KEYS) {
    if (isLocalTarget(env[key])) continue;
    throw abort([
      `[시트지] 테스트 도구가 로컬이 아닌 주소를 쓰려고 했습니다: ${key}=${describeTarget(env[key])}`,
      `[시트지] (${label})`,
      '[시트지] 이 도구들은 문서를 지우고 서버를 강제 종료하는 파괴적인 검사를 합니다.',
      '[시트지] 실제 데이터베이스를 향해 돌리면 그 데이터가 사라집니다. 그래서 중단합니다.',
      `[시트지] 허용되는 대상: ${[...LOCAL_HOSTS].join(', ')} (tools/fakesupabase.mjs)`,
    ]);
  }
  return env;
}

/**
 * What the server would ACTUALLY see, asked of the real env.js in a real child process.
 *
 * `harnessEnv` writes empty values on the assumption that an empty variable survives
 * being passed to a child and beats .env. That is true on this platform and is what
 * env.js documents — but it is an assumption about the operating system standing between
 * a test suite and somebody's production data, so it is verified instead of trusted. The
 * probe imports env.js exactly as server.js does and prints the values back.
 *
 * Memoised per configuration: a harness that boots ten times pays for this once.
 */
const probeCache = new Map();

function probeKey(env) {
  return GUARDED_KEYS.map((key) => `${key}=${env[key] ?? ''}`).join('\n');
}

// Written as a template literal on purpose: it is source code for another process, not
// this file's own imports, and tools/check-imports.mjs must not try to resolve the
// specifier inside it against tools/.
const PROBE_SOURCE = `
  const load = import('./env.js');
  load.then(() => {
    const out = {};
    for (const key of process.argv.slice(1)) {
      out[key] = process.env[key] === undefined ? null : process.env[key];
    }
    console.log('SZ-HARNESS-PROBE ' + JSON.stringify(out));
  }).catch((err) => {
    console.log('SZ-HARNESS-PROBE-ERROR ' + JSON.stringify(String((err && err.message) || err)));
  });
`;

function effectiveEnv(env) {
  const result = spawnSync(process.execPath, ['-e', PROBE_SOURCE, ...GUARDED_KEYS], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  const stdout = result.stdout || '';
  const line = stdout.split('\n').find((l) => l.startsWith('SZ-HARNESS-PROBE '));
  if (!line) {
    const failed = stdout.split('\n').find((l) => l.startsWith('SZ-HARNESS-PROBE-ERROR '));
    const detail = failed
      ? failed.slice('SZ-HARNESS-PROBE-ERROR '.length)
      : `${(result.stderr || '').trim().slice(-400)}`;
    throw abort([
      '[시트지] 테스트 도구가 서버의 환경 설정을 확인하지 못했습니다.',
      '[시트지] 무엇이 적용될지 모르는 채로 파괴적인 검사를 시작할 수는 없어 중단합니다.',
      `[시트지] 이유: ${detail || '(출력 없음)'}`,
    ]);
  }
  return JSON.parse(line.slice('SZ-HARNESS-PROBE '.length));
}

/**
 * Prove that the environment the child will boot with is the one the harness chose.
 *
 * The failure this catches is precise: a guarded variable the harness set to one value
 * and .env quietly set to another. For SUPABASE_URL that is the difference between the
 * in-memory stand-in and somebody's project, so a mismatch aborts rather than warns.
 */
export function assertSandboxed(env, label = 'harness') {
  if (!env || env[SANDBOX_MARK] !== '1') {
    throw abort([
      '[시트지] 테스트 도구가 harnessEnv() 로 만들지 않은 환경으로 서버를 켜려고 했습니다.',
      `[시트지] (${label})`,
      '[시트지] 그러면 운영자의 .env 가 그대로 적용되어, 실제 데이터베이스를 상대로 파괴적인 검사가 돕니다.',
      "[시트지] tools/harness-env.mjs 의 harnessEnv() 로 환경을 만들어 넘기세요.",
    ]);
  }

  const key = probeKey(env);
  if (!probeCache.has(key)) {
    const effective = effectiveEnv(env);
    probeCache.set(key, effective);

    const drifted = GUARDED_KEYS.filter((name) => {
      const wanted = env[name] ?? '';
      const got = effective[name] === null ? '' : effective[name];
      return wanted !== got;
    });
    if (drifted.length) {
      probeCache.delete(key);
      throw abort([
        `[시트지] .env 가 테스트 설정을 덮어썼습니다: ${drifted.join(', ')}`,
        `[시트지] (${label})`,
        '[시트지] 테스트 도구가 정한 값이 서버에 그대로 전달되지 않으면, 이 검사들이 어디를 상대로 도는지 알 수 없습니다.',
        '[시트지] 실제 데이터가 지워질 수 있어 시작하지 않습니다. .env 에서 위 값을 지우고 다시 실행하세요.',
      ]);
    }
  }

  const effective = probeCache.get(key);
  for (const name of TARGET_KEYS) {
    const value = effective[name] === null ? '' : effective[name];
    if (isLocalTarget(value)) continue;
    throw abort([
      `[시트지] 서버가 로컬이 아닌 주소를 보게 됩니다: ${name}=${describeTarget(value)}`,
      `[시트지] (${label})`,
      '[시트지] 이 도구들은 문서를 지우고 서버를 강제 종료합니다. 실제 데이터베이스를 상대로는 돌릴 수 없습니다.',
    ]);
  }
}

// The line storage/index.js prints at boot, naming the backend it actually chose.
const STORAGE_LINE = /문서 저장소: (파일|Supabase)(?: \(([^)]*)\))?/;

/**
 * Watch what a child says for the storage line, and kill it if that line names a host
 * this harness has no business touching.
 *
 * This is the last net, and it is the only one that reads the server's OWN account of
 * where it is writing rather than the harness's account of what it asked for. Reaching it
 * means every check above was wrong, so it does not throw into a caller that may not be
 * listening — it kills the child and stops the process.
 */
function watchBackendLine(child, label) {
  let settled = false;
  const inspect = (text) => {
    if (settled) return;
    const match = STORAGE_LINE.exec(text);
    if (!match) return;
    settled = true;
    if (match[1] === '파일') return;
    const host = match[2] || '';
    // The boot line prints the host on its own, so it is compared as a host, not a URL.
    if (LOCAL_HOSTS.has(host.replace(/:\d+$/, '')) || LOCAL_HOSTS.has(host)) return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    console.error(`\n${'='.repeat(72)}`);
    console.error(`[시트지] 서버가 로컬이 아닌 Supabase 를 쓴다고 알렸습니다: ${host}`);
    console.error(`[시트지] (${label}) 파괴적인 검사가 시작되기 전에 서버를 종료하고 멈춥니다.`);
    console.error('[시트지] .env 의 SUPABASE_URL 이 테스트 설정을 덮어쓴 것으로 보입니다.');
    console.error(`${'='.repeat(72)}\n`);
    process.exit(3);
  };
  if (child.stdout) child.stdout.on('data', (d) => inspect(d.toString()));
  if (child.stderr) child.stderr.on('data', (d) => inspect(d.toString()));
}

/**
 * Start server.js for a harness. Every harness goes through here.
 *
 * `env` must have come from `harnessEnv()`. `stdio` is fixed to piped output because the
 * guard above has to be able to read the boot log; a harness that wants the output adds
 * its own listeners as usual, which is why this attaches one rather than replacing any.
 */
export function spawnServer({ env, args = ['server.js'], label = 'server', cwd = ROOT } = {}) {
  assertSandboxed(env, label);
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  watchBackendLine(child, label);
  return child;
}
