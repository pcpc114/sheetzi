// storage/index.js — picks the document store from the environment (SPEC 29.1).
//
// Two backends implement the same interface: the file store that has always been here,
// and a Supabase store that keeps the identical data in Postgres so the disk stops being
// a single point of failure. Which one runs is a CONFIGURATION decision, never a code
// decision — `SUPABASE_URL` selects Supabase, and its absence means the server behaves
// exactly as it did before this file existed.
//
// server.js imports nothing else for document data. Everything below simply forwards to
// the chosen backend, so the durability rules in SPEC 27 are properties of the interface
// rather than of one implementation.
//
// One of those rules needs a little work here rather than pure forwarding. SPEC 27.6 gives
// a read three possible outcomes — ABSENT, CORRUPT, UNREAD — and says the third is always a
// rejection, never a value. Both backends already reject; what this file adds is that the
// rejection arrives at server.js in ONE shape whichever backend produced it, so the caller
// tests `err.code === 'ESTOREUNREAD'` and never has to know which store is running.

import * as fileStore from './fileStore.js';

// The code SPEC 29.1 pins for "this could not be read". Duplicated as a literal in
// fileStore.js rather than imported from it, because the Supabase backend must satisfy the
// same contract without importing the file backend to do it.
const UNREAD_CODE = 'ESTOREUNREAD';

/**
 * Stamp a read failure with the UNREAD contract (SPEC 29.1).
 *
 * Everything `loadDoc`, `readJournal` and `listDocIds` reject with is tagged, not only what
 * arrives already carrying the code. That is deliberate and it is the safe direction: these
 * three reject ONLY when the stored state could not be read — absence is a value, corruption
 * is a value — so an untagged rejection is an UNREAD whose backend simply did not label it,
 * and the one reading a caller must never make is "this error is not the unread one, so I
 * may carry on as though the document were empty". That reading is the entire finding this
 * contract exists to close.
 *
 * The original error is preserved as `cause`, so the errno or the HTTP status stays
 * reachable, and an error that already carries the code is passed through untouched.
 */
function asUnread(err, id) {
  if (err && err.code === UNREAD_CODE) return err;
  const detail = err && err.message ? err.message : String(err);
  const tagged = new Error(
    id
      ? `${id}: 저장된 내용을 읽지 못했습니다 (${detail})`
      : `저장소를 읽지 못했습니다 (${detail})`,
  );
  tagged.code = UNREAD_CODE;
  if (id) tagged.docId = id;
  tagged.cause = err;
  return tagged;
}

// Trimmed, because an operator's .env commonly holds `SUPABASE_URL=` with nothing after
// it. An empty value is not a configured backend, it is an unset one.
const SUPABASE_URL = typeof process.env.SUPABASE_URL === 'string'
  ? process.env.SUPABASE_URL.trim()
  : '';
const USE_SUPABASE = SUPABASE_URL !== '';

/** 'file' | 'supabase' — for the boot log (SPEC 29.1). */
export const name = USE_SUPABASE ? 'supabase' : 'file';

/**
 * The Supabase store is loaded with a DYNAMIC import, so a deployment that never uses it
 * never even parses it. The promise is memoised, including a rejection: a backend the
 * operator asked for and that failed to load must be a loud, permanent failure, never a
 * silent fall back to the local disk they believe is unused.
 *
 * @type {Promise<object>|null}
 */
let backendPromise = null;

function load() {
  if (!backendPromise) {
    backendPromise = USE_SUPABASE
      ? import('./supabaseStore.js')
      : Promise.resolve(fileStore);
  }
  return backendPromise;
}

// The project host, for the boot line. The URL is not the secret — the service key is —
// and nothing here ever reads, logs or forwards that key.
function describeTarget() {
  try {
    return new URL(SUPABASE_URL).host;
  } catch {
    return '설정된 주소';
  }
}

/**
 * Create or verify whatever the backend needs, and say which one is running.
 *
 * The boot line is printed here rather than at import time so a tool that merely imports
 * server.js does not announce a backend it will never touch, and so the line lands with
 * the other boot lines in the order server.js prints them.
 */
export async function init() {
  if (USE_SUPABASE) {
    console.log(`[시트지] 문서 저장소: Supabase (${describeTarget()}) — 문서가 데이터베이스에 저장됩니다.`);
  } else {
    console.log('[시트지] 문서 저장소: 파일 (data/ 디렉터리) — 이 서버의 디스크에만 저장됩니다.');
  }
  const backend = await load();
  await backend.init();
}

/**
 * Every document the store holds. An empty list means there are none; a list that could not
 * be read rejects, because boot acts on an empty one by creating documents (SPEC 29.1).
 */
export async function listDocIds() {
  const backend = await load();
  try {
    return await backend.listDocIds();
  } catch (err) {
    throw asUnread(err, null);
  }
}

/**
 * `{ doc, fromBackup, raw }`, or null when the document genuinely is not stored. A
 * rejection means UNREAD (SPEC 27.6): the document exists as far as anyone knows and this
 * process could not see it, so it must not be served, replayed against or written over.
 */
export async function loadDoc(id) {
  const backend = await load();
  try {
    return await backend.loadDoc(id);
  } catch (err) {
    throw asUnread(err, id);
  }
}

export async function saveSnapshot(id, doc) {
  const backend = await load();
  return backend.saveSnapshot(id, doc);
}

/**
 * Resolving TRUE means the record is durable — that is the whole contract, because the
 * client stops holding the edit the moment the server acknowledges it. Anything other
 * than a literal `true` from the backend is treated as a failure, so a backend that
 * returns nothing, or something merely truthy, can never be mistaken for a confirmation.
 */
export async function appendJournal(id, record) {
  const backend = await load();
  const ok = await backend.appendJournal(id, record);
  return ok === true;
}

/**
 * `{ records, badLines }`. An empty `records` means the journal is empty — a fact the
 * caller compacts and truncates against — so a journal this process could not read must
 * never arrive here as one. It rejects instead (SPEC 27.6), and the rejection carries
 * `code === 'ESTOREUNREAD'` whichever backend raised it.
 */
export async function readJournal(id) {
  const backend = await load();
  try {
    return await backend.readJournal(id);
  } catch (err) {
    throw asUnread(err, id);
  }
}

export async function truncateJournal(id) {
  const backend = await load();
  return backend.truncateJournal(id);
}

export async function listBackups(id) {
  const backend = await load();
  return backend.listBackups(id);
}

export async function deleteDoc(id) {
  const backend = await load();
  return backend.deleteDoc(id);
}

export async function flush() {
  // Nothing was ever loaded, so nothing can be holding unflushed work.
  if (!backendPromise) return;
  const backend = await load();
  return backend.flush();
}
