// env.js — put the values in .env into process.env before anything reads them.
//
// WHY THIS FILE EXISTS, AND WHY IT IS IMPORTED FIRST
//
// Node does not read .env on its own. Until this file existed, every instruction we
// give an operator ("put SUPABASE_URL in .env", "put SZ_PASSWORD in .env") was quietly
// false: the file was never opened, so the server started with the FILE backend on a
// disk the operator believed was unused, and — far worse — with no password at all on a
// site that is meant to face the internet.
//
// The load has to happen in a module of its own because of how ESM evaluates. Every
// `import` in a module is evaluated BEFORE the first statement of that module's body,
// and storage/index.js reads `SUPABASE_URL` at ITS module scope. So a loadEnvFile call
// at the top of server.js's body would already be too late — storage/index.js would
// have chosen its backend from an environment that had not been filled in yet. A tiny
// module that loads in its own module scope, imported as the very first import, runs
// before every other module in the graph. That ordering is the whole point of the file.
//
// THE RULES, which the README, .env.example and docs/supabase.sql all repeat:
//
//   1. A variable already set in the real environment WINS over the .env file.
//      A host's dashboard (Render, Railway, Fly.io) and our test harnesses both set
//      real environment variables, and both must keep working unchanged.
//   2. A missing .env is completely normal and silent. `npm start` works without one.
//   3. A .env that EXISTS but cannot be read stops the boot, loudly. Starting with a
//      configuration file the operator wrote and we failed to apply is precisely the
//      half-working outcome this file was written to end.
//
// Nothing here ever prints a VALUE. Variable names are logged so an operator can see
// their file took effect; SZ_PASSWORD and SUPABASE_SERVICE_KEY are secrets and only
// their names ever appear.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from THIS file, never from process.cwd(): starting the server from another
// directory (`node ~/sheetzi/server.js`, a service manager with its own working
// directory) must read the same .env as `npm start` does.
const ROOT = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the .env this process reads. */
export const envPath = join(ROOT, '.env');

/** True when a .env existed and was read. */
export let loadedEnvFile = false;

/** Names — never values — of the variables .env actually set. */
export const appliedKeys = [];

/**
 * Names that appear in .env but were already set in the real environment, so the file
 * did NOT win. Reported because a value that is silently ignored is the exact failure
 * this whole file is here to prevent.
 */
export const overriddenKeys = [];

// `KEY=`, `key = value`, `export KEY=value`. Used only to recover NAMES for the report
// above — values are never parsed here, process.loadEnvFile owns that.
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Editors on Windows often save UTF-8 "with BOM", which puts three invisible bytes in
 * front of the first line. loadEnvFile then reads the first key as "\uFEFFSZ_PASSWORD",
 * which is not the variable anybody meant to set — the lock would stay open and nothing
 * would say why. Repair it: move the value to the real name if that name is still free,
 * and drop the unusable key either way.
 *
 * @returns {string[]} names that had to be repaired
 */
function repairBomKeys() {
  const repaired = [];
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('\uFEFF')) continue;
    const clean = key.slice(1);
    if (clean && process.env[clean] === undefined) {
      process.env[clean] = process.env[key];
      repaired.push(clean);
    }
    delete process.env[key];
  }
  return repaired;
}

/**
 * Names mentioned in the file, best effort.
 *
 * A quoted value may span lines, so a continuation line could look like a key. That
 * would only ever add a wrong name to the informational line below, never change what
 * is loaded, and the caller filters to names that are actually set anyway.
 */
function keyNamesInFile() {
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return [];
  }
  const names = [];
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = KEY_LINE.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function load() {
  // process.loadEnvFile arrived in Node 20.12. On anything older the call would throw a
  // TypeError that reads like a bug in the app, and the operator's configuration would
  // not be applied — the same silent half-working boot this file prevents. Say what is
  // wrong, and refuse, but only when there is actually a .env to lose.
  if (typeof process.loadEnvFile !== 'function') {
    let hasFile = true;
    try { readFileSync(envPath); } catch { hasFile = false; }
    if (!hasFile) return;
    console.error(`[시트지] 지금 쓰는 Node(${process.version})는 .env 파일을 읽지 못합니다. Node 20.12 이상이 필요합니다.`);
    console.error(`[시트지] .env 가 있는데 적용할 수 없어서 시작하지 않습니다: ${envPath}`);
    console.error('[시트지] Node 를 20.12 이상(또는 22 이상)으로 올리거나, .env 대신 환경 변수로 값을 넣으세요.');
    throw new Error('.env 파일을 읽으려면 Node 20.12 이상이 필요합니다.');
  }

  const before = new Set(Object.keys(process.env));

  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;   // rule 2: no file is normal, and silent.

    // Rule 3. Everything else — a directory named .env, a permission problem, a file
    // being written at that moment — means the operator's configuration exists and did
    // not get applied. Booting anyway could publish every document with no password.
    console.error(`[시트지] .env 파일을 읽지 못했습니다: ${envPath}`);
    console.error(`[시트지] 이유: ${err && err.message ? err.message : String(err)}`);
    console.error('[시트지] 설정이 적용되지 않은 채로 켜지면 비밀번호가 풀리거나 문서가 엉뚱한 곳에 저장될 수 있어, 서버를 시작하지 않습니다.');
    console.error('[시트지] .env 를 읽을 수 있게 고치거나, 쓰지 않는다면 파일을 지운 뒤 다시 실행하세요.');
    throw err;
  }

  loadedEnvFile = true;
  const repaired = repairBomKeys();

  for (const key of Object.keys(process.env)) {
    if (!before.has(key)) appliedKeys.push(key);
  }
  appliedKeys.sort();

  for (const name of keyNamesInFile()) {
    if (before.has(name) && !appliedKeys.includes(name)) overriddenKeys.push(name);
  }

  if (appliedKeys.length) {
    console.log(`[시트지] .env 를 읽었습니다 (${envPath})`);
    console.log(`[시트지] .env 에서 적용된 값: ${appliedKeys.join(', ')} (값 자체는 기록하지 않습니다)`);
  } else {
    console.log(`[시트지] .env 를 읽었지만 새로 적용된 값이 없습니다 (${envPath})`);
  }

  if (overriddenKeys.length) {
    console.log(`[시트지] 아래 값은 이미 환경 변수에 있어서 .env 가 아니라 환경 변수 쪽을 씁니다: ${overriddenKeys.join(', ')}`);
  }

  if (repaired.length) {
    console.warn(`[시트지] .env 맨 앞에 BOM 표시가 있어 ${repaired.join(', ')} 을(를) 바로잡았습니다.`);
    console.warn('[시트지] 메모장에서 저장할 때 인코딩을 "UTF-8"(BOM 없음)로 고르면 이 줄이 사라집니다.');
  }
}

load();
