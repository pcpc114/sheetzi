// server.js — 시트지: express + ws + JSON persistence.
//
// One HTTP server hosts both the static app and the collaboration WebSocket at /ws.
// Documents live in memory and are mirrored to data/<id>.json with a debounced,
// atomic write (tmp file + rename).
//
// A document holds an ORDERED LIST OF SHEETS (SPEC section 10). Every frame that
// touches cell data names its sheet with `sheetId`; a sheet id the document does not
// have is answered with {t:'error'} and applied nowhere — never to "some" sheet.
// Sheet ops (add / rename / delete / reorder / duplicate / color) go through the pure
// helpers in shared/model.js and are broadcast as a full document resend.

// .env FIRST — before every other import, on purpose.
//
// ESM evaluates a module's imports before the first line of its body, and several
// modules below read process.env while they are being evaluated: storage/index.js
// picks its backend from SUPABASE_URL at module scope, and PORT is read a few lines
// into this file. Loading .env anywhere later would be too late for them. env.js does
// the load in its own module scope, so importing it first is what makes .env real.
import './env.js';

import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { createServer } from 'node:http';
// Static assets and the build id only. Document data never touches fs from this file:
// it goes through the storage interface below (SPEC 29.1).
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import * as storage from './storage/index.js';

import { SheetEngine } from './shared/formula/engine.js';
import { a1ToCell, cellToA1, isA1 } from './shared/formula/refs.js';
import {
  MAX_CHARTS,
  MAX_COMMENTS_PER_SHEET,
  MAX_COMMENT_LEN,
  MAX_MERGES,
  MAX_SHEETS,
  addSheet,
  deleteSheet,
  duplicateSheet,
  emptyDoc,
  emptySheet,
  findSheet,
  newId,
  normalizeMergeList,
  renameSheet,
  reorderSheet,
  sanitizeChartList,
  sanitizeComments,
  sanitizeDoc,
  sanitizeFilter,
  sanitizeLink,
  setSheetColor,
  shiftCharts,
  shiftComments,
  shiftFilter,
  shiftMerges,
} from './shared/model.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A short id for the client code this process is serving, derived from the size and
 * modification time of every file under public/ and shared/.
 *
 * It exists to settle one recurring question that is otherwise unanswerable from the
 * outside: is the browser running the code that is on disk? A page that loaded before a
 * restart keeps its old modules in memory, and every fixed bug then looks unfixed. The
 * client prints this id at boot and compares it on every reconnect, so a stale tab says
 * so out loud instead of quietly misleading everyone.
 */
function computeBuildId() {
  let acc = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|css|html)$/.test(e.name)) continue;
      try {
        const st = statSync(full);
        // A 32-bit rolling mix of the path, size and mtime: cheap, and it changes
        // whenever any shipped file does.
        for (const ch of full) acc = (acc * 31 + ch.charCodeAt(0)) | 0;
        acc = (acc * 31 + st.size) | 0;
        acc = (acc * 31 + (st.mtimeMs | 0)) | 0;
      } catch { /* unreadable file: skip it */ }
    }
  };
  walk(join(HERE, 'public'));
  walk(join(HERE, 'shared'));
  return (acc >>> 0).toString(36);
}
const PUBLIC_DIR = join(HERE, 'public');
const SHARED_DIR = join(HERE, 'shared');

const PORT = Number(process.env.PORT) || 3000;
const BUILD_ID = computeBuildId();

const DOC_ID_RE = /^[a-z0-9]{6,24}$/;
// How long a document waits before its journal is compacted into a snapshot. The
// debounce is policy and lives here; the storage backend performs a compaction, it does
// not decide when one happens (SPEC 29.1).
const SAVE_DEBOUNCE_MS = 400;
// A client-generated op id is opaque and echoed back verbatim in the ack, so it is only
// ever length-checked (SPEC 27.3).
const MAX_OP_ID_LEN = 64;
const HEARTBEAT_MS = 30_000;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_CELLS_PER_EDIT = 20_000;
const MAX_STRUCT_COUNT = 1000;
const STARTER_DOC_ID = 'start1';

const LIMIT_ROWS = 5000;
const LIMIT_COLS = 702;

// Placeholder ids used only to run a fragment through sanitizeDoc (see validateSheet).
// They never reach a stored document.
const PROBE_DOC_ID = 'aaaaaa';
const PROBE_SHEET_ID = 'sh0000';
const PROBE_SHEET_NAME = '시트';

// Style keys accepted on the wire. Values are validated by sanitizeDoc before storage;
// this list only decides which keys survive into the broadcast patch.
//
// The cell-formatting keys (SPEC 22.1) are appended after the original ones: ff (font
// family), fs (font size), va (vertical align), wrap (text overflow), rot (rotation) and
// bd (borders). Listing a key here only lets it THROUGH — every value still has to
// survive sanitizeStyle in shared/model.js, which owns the ranges and the closed sets,
// and a cell carrying none of the six keys is untouched by this addition.
const STYLE_KEYS = new Set([
  'b', 'i', 'u', 's', 'align', 'bg', 'fg', 'fmt', 'decimals',
  'ff', 'fs', 'va', 'wrap', 'rot', 'bd',
]);

// `bd` is the only style value that is not a scalar (SPEC 22.3): a nested
// { t?, r?, b?, l? } of { w, s, c } edges — at most 4 sides of 3 fields each. sanitizeStyle
// reads only those names, so a hostile client cannot make it store more, but it can still
// send an object with a million keys and make every copy on the way there walk it. The
// limits below are the real shapes plus slack; see borderTooLarge for the cheap check.
const MAX_BORDER_SIDES = 8;
const MAX_BORDER_EDGE_FIELDS = 8;

const STRUCT_KINDS = new Set(['insertRow', 'deleteRow', 'insertCol', 'deleteCol']);

const SHEET_OPS = new Set(['add', 'rename', 'delete', 'reorder', 'duplicate', 'color']);

const COMMENT_OPS = new Set(['add', 'reply', 'resolve', 'reopen', 'delete']);

// Cheap gates for the one batch-C value with an unbounded shape (SPEC 24.1). A filter's
// `hidden` map is per-column lists of strings, so it can never legitimately name more
// columns than the sheet has, nor hold more values in one column than shared/model.js
// stores (it caps at 5000 and drops the rest). Refusing an over-sized frame outright is
// cheaper than sanitising it entry by entry and then throwing most of it away.
const MAX_FILTER_HIDDEN_COLS = LIMIT_COLS;
const MAX_FILTER_HIDDEN_VALUES = 5000;

// Peer colours — readable on white, distinct from each other.
const PEER_COLORS = [
  '#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6',
  '#12b5cb', '#f9ab00', '#c5221f', '#7627bb', '#0b8043',
];

const CSV_BOM = String.fromCharCode(0xfeff);

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function clampInt(v, min, max, dflt) {
  let n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  n = Math.round(n);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// True when `obj` has more than `limit` enumerable keys. Stops as soon as the limit is
// passed, so an absurd object costs `limit + 1` steps instead of a full enumeration —
// which is the whole point of checking before anything copies or walks the value.
function hasTooManyKeys(obj, limit) {
  let n = 0;
  for (const _key in obj) {
    if (++n > limit) return true;
  }
  return false;
}

// Cheap size gate for the one nested style value (SPEC 22.3). A `bd` that is not an
// object is left alone — sanitizeStyle simply drops it — but one carrying an absurd
// number of sides, or a side carrying an absurd number of fields, is refused before any
// copy touches it. The inner loop runs only after the outer count passed, so it is
// bounded by MAX_BORDER_SIDES.
function borderTooLarge(bd) {
  if (!isPlainObject(bd)) return false;
  if (hasTooManyKeys(bd, MAX_BORDER_SIDES)) return true;
  for (const side in bd) {
    const edge = bd[side];
    if (isPlainObject(edge) && hasTooManyKeys(edge, MAX_BORDER_EDGE_FIELDS)) return true;
  }
  return false;
}

// Cheap size gate for a filter definition (SPEC 24.1). `range`, `header` and `sort` are
// scalars sanitizeFilter reads by name, so their size is bounded by the frame itself; the
// `hidden` map is the only part that can carry an arbitrary number of entries. A map with
// more columns than the sheet can have, or a column list longer than the model stores, is
// refused before anything copies or walks it. The inner loop runs only after the key count
// passed, so it is bounded by MAX_FILTER_HIDDEN_COLS.
function filterTooLarge(filter) {
  if (!isPlainObject(filter)) return false;
  const hidden = filter.hidden;
  if (!isPlainObject(hidden)) return false;
  if (hasTooManyKeys(hidden, MAX_FILTER_HIDDEN_COLS)) return true;
  for (const key in hidden) {
    const list = hidden[key];
    if (Array.isArray(list) && list.length > MAX_FILTER_HIDDEN_VALUES) return true;
  }
  return false;
}

// Count the code points in `str`, but stop as soon as `limit` is passed. MAX_COMMENT_LEN
// counts code points, and a string's UTF-16 length is always >= its code point count, so
// a caller only pays this walk for text that might genuinely be over the cap.
function codePointCount(str, limit) {
  let n = 0;
  for (const _ch of str) {
    if (++n > limit) return n;
  }
  return n;
}

// Copy one style object. Every value is a primitive EXCEPT `bd`, so a plain spread would
// leave the copy SHARING that nested object with the original — the stored document and
// a broadcast patch would then alias the same borders, and a later mutation of either
// would silently show up in the other. Callers hand this validated styles (stored cells,
// or a sanitizeDoc result), which are bounded to four sides; raw client payloads are size
// gated by borderTooLarge first. Key insertion order is preserved, so a style with no
// `bd` produces byte-for-byte the object it produced before borders existed.
function cloneStyle(style) {
  const out = { ...style };
  if (isPlainObject(out.bd)) {
    const bd = {};
    for (const side of Object.keys(out.bd)) {
      const edge = out.bd[side];
      bd[side] = isPlainObject(edge) ? { ...edge } : edge;
    }
    out.bd = bd;
  }
  return out;
}

// 'b2' -> { key:'B2', row:1, col:1 }; anything malformed -> null. Never throws.
// A sheet-qualified reference ('시트2!A1') is NOT a cell key and is rejected here.
function parseCellKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  if (!key || key.includes('$') || key.includes('!') || !isA1(key)) return null;
  try {
    const cell = a1ToCell(key);
    if (!Number.isInteger(cell.row) || !Number.isInteger(cell.col)) return null;
    if (cell.row < 0 || cell.col < 0) return null;
    return { key, row: cell.row, col: cell.col };
  } catch {
    return null;
  }
}

// A detached copy of a sheet's cell map, handed to a throwaway SheetEngine. Styles go
// through cloneStyle so the engine cannot reach into the stored document through a shared
// `bd` object.
//
// `link` is deliberately NOT copied: the engine has no notion of it and would drop it
// from its snapshot anyway. applyStructEdit relocates links itself (see shiftCellLinks),
// and the CSV export wants values, never URLs.
function cloneCells(cells) {
  const out = {};
  for (const key of Object.keys(cells)) {
    const entry = cells[key];
    if (!isPlainObject(entry)) continue;
    const copy = {};
    if (typeof entry.input === 'string') copy.input = entry.input;
    if (isPlainObject(entry.style)) copy.style = cloneStyle(entry.style);
    out[key] = copy;
  }
  return out;
}

// Run a partial SHEET through the shared model so every clamp/whitelist rule lives in
// exactly one place. The probe id/name are stripped by the caller (it only reads the
// geometry fields back).
function validateSheet(fragment) {
  const doc = sanitizeDoc({
    id: PROBE_DOC_ID,
    sheets: [{ id: PROBE_SHEET_ID, name: PROBE_SHEET_NAME, ...fragment }],
  });
  return doc.sheets[0];
}

// Document-level name validation, again through the shared model.
function validateDocName(name) {
  return sanitizeDoc({ id: PROBE_DOC_ID, name }).name;
}

// The first sheet of a document — the fallback tab for a peer that has not said where
// it is looking yet. Documents always hold at least one sheet.
function firstSheetId(doc) {
  const sheet = doc && Array.isArray(doc.sheets) ? doc.sheets[0] : null;
  return sheet ? sheet.id : null;
}

// ---------------------------------------------------------------------------
// document store + persistence
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const docs = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const saveTimers = new Map();

// ---------------------------------------------------------------------------
// quarantine — a document whose stored state could not be READ (SPEC 27.6)
// ---------------------------------------------------------------------------
//
// A store answers a read with one of three things, and only two of them are conclusions:
// ABSENT and CORRUPT were drawn from bytes this process actually saw, while UNREAD means
// the bytes ARE there and we failed to see them. storage/index.js delivers that third one
// as a REJECTION carrying `code === 'ESTOREUNREAD'`, exactly so it can never arrive as an
// empty document (SPEC 29.1) — because an empty one is what licensed the damage: boot
// served the document at the snapshot's rev, new edits minted revs that collided with the
// acknowledged records still unread in the log, and the next compaction truncated them.
//
// This map holds the consequence: the ids this process refuses to touch. A quarantined
// document is not loaded, not served, not edited, not compacted and not deleted, for the
// life of the process. Every OTHER document keeps working — one unreadable file must not
// be an outage.
//
// It is deliberately not written down, and that is what makes it hold across a restart
// rather than what makes it evaporate. While a document is quarantined NOTHING about it
// on disk can change — no snapshot, no append, no truncate — so the next boot reads the
// very same bytes and re-derives the same answer: either the read succeeds, and replay is
// then correct because the rev never moved past the records the journal still holds, or it
// fails again and the document is quarantined again. A marker file would have to be
// written to the disk that just refused a read, and would outlive the fault it described.
//
// This is precisely where the earlier attempt went wrong. It refused ONE destructive step
// and let the document go on being served; the rev climbed past the unread records into
// snapshots that did not contain them, and the next boot read the journal perfectly,
// replayed nothing, and truncated with a clear conscience. Refusing one step is not a
// quarantine. The document has to stop moving.
//
/** @type {Map<string, {reason: string, at: number}>} */
const unreadableDocs = new Map();

/** The name the document list shows for a document whose real name was never read. */
const UNREADABLE_DOC_NAME = '읽지 못한 문서';

/**
 * What a PERSON is told about a quarantined document (SPEC 27.6).
 *
 * It says the three things somebody who cannot open their spreadsheet actually needs:
 * their work is still there, the server could not read the file THIS TIME, and what to do
 * about it. It carries no errno, no path and no stack — those go to the log, where the
 * operator is. Shown to the person who was typing they would say nothing true and would
 * suggest their data is damaged, which is the one thing this refusal proves it is not.
 */
const UNREADABLE_TITLE = '이 문서를 지금은 열 수 없습니다.';
const UNREADABLE_STEPS = [
  '지금까지 입력한 내용은 서버에 그대로 남아 있습니다. 사라진 것이 아닙니다.',
  '이번에 서버가 그 파일을 읽지 못했을 뿐이라, 읽지 못한 내용을 덮어쓰지 않으려고 문서를 열지 않았습니다.',
  '서버를 다시 시작하면 대부분 그대로 다시 열립니다.',
  '다시 시작해도 같은 문제가 이어지면 백신·백업 같은 다른 프로그램이 파일을 붙잡고 있거나 디스크에 문제가 있는 것입니다. 관리자에게 알려 주세요.',
];

/** The 503 body. Same words as the socket frame, so the two can never disagree. */
function unreadablePayload(id) {
  return {
    error: 'doc_unreadable',
    docId: id,
    message: UNREADABLE_TITLE,
    steps: UNREADABLE_STEPS.slice(),
  };
}

/**
 * The one sentence worth logging out of a wrapped rejection.
 *
 * `storage/index.js` wraps whatever the backend threw so every rejection carries the same
 * code, which means `err.message` is usually "<id>: 저장된 내용을 읽지 못했습니다 (<the real
 * one>)". Printed as-is inside a line that already says the same thing, the operator reads
 * the same sentence three times and the errno is at the end of the third. The `cause` is
 * what actually names the syscall or the HTTP status, so that is what goes in the log.
 */
function unreadableDetail(id, err) {
  const inner = err && err.cause && err.cause.message ? err.cause : err;
  let text = inner && inner.message ? inner.message : String(err);
  if (text.startsWith(`${id}: `)) text = text.slice(id.length + 2);
  return text;
}

/**
 * Take a document out of service for the rest of this process (SPEC 27.6).
 *
 * Called with whatever the store rejected: `code === 'ESTOREUNREAD'` when it labelled the
 * failure, and an untagged error when it did not. BOTH quarantine. The three reads that
 * reject — loadDoc, readJournal, listDocIds — reject for UNREAD and for nothing else, so
 * an untagged rejection is an unlabelled UNREAD; reading it as anything milder is the
 * exact mistake this contract exists to prevent (SPEC 29.1).
 *
 * The line is printed ONCE per document, not once per attempt, and at error level. It is
 * the operator's whole cue: the document will not come back without a restart, and nothing
 * else in the log says so.
 */
function quarantineDoc(id, err) {
  if (unreadableDocs.has(id)) return false;
  const detail = unreadableDetail(id, err);
  unreadableDocs.set(id, { reason: detail, at: Date.now() });
  console.error(
    `[시트지] ${id}: 저장된 내용을 읽지 못해 이 문서를 열지 않았습니다. `
    + '내용은 저장소에 그대로 있으며 아무것도 덮어쓰거나 지우지 않습니다. '
    + `원인을 고친 뒤 서버를 다시 시작하세요. (원인: ${detail})`,
  );
  return true;
}

/**
 * Per-document operation order (SPEC 27.1).
 *
 * `opChains` serialises every storage call for one document — journal appends and
 * compactions alike. Two appends therefore can never interleave, and a compaction can
 * never slip between an append and the truncate that is supposed to cover it.
 *
 * Order is policy, so it lives here rather than in a backend: it has to hold whichever
 * store is configured. The backend performs the operations; it does not decide when.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const opChains = new Map();

// Queue one storage operation behind everything already queued for this document. The
// promise put BACK in the map never rejects, so a single failure cannot poison the chain
// for the rest of the process's life — the next append still runs. The promise RETURNED
// carries the task's own result, because the caller has to know whether it landed.
function runExclusive(id, task) {
  const prev = opChains.get(id) || Promise.resolve();
  const done = prev.then(task);
  opChains.set(id, done.then(() => {}, () => {}));
  return done;
}

/**
 * Append one accepted operation to this document's journal (SPEC 27.1).
 *
 * The record is written BEFORE the operation is broadcast and before it is acknowledged,
 * so a process death — the realistic failure — cannot lose it.
 *
 * Resolves `true` only when the backend confirmed the write. `false` is the caller's
 * signal to withhold the ack, because an ack is the client's licence to forget the frame.
 */
function journalAppend(id, record) {
  // A quarantined document accepts no new records (SPEC 27.6). Appending is not itself
  // destructive, but this record's `rev` was minted from a state that does not include
  // whatever the unread journal is holding, so it would collide with those records and
  // make the log impossible to replay unambiguously afterwards. `false` is the answer that
  // already means "not durable": the ack is withheld, the client keeps the frame in its
  // outbox (SPEC 27.4), and nothing is lost while the operator restarts.
  if (unreadableDocs.has(id)) return Promise.resolve(false);
  // The record's VALUE is captured NOW, synchronously, before anything is queued. A
  // 'doc' or 'sheet' record names the LIVE document object, and the write can happen a
  // turn or more later when a compaction is already running; without this snapshot the
  // bytes on disk could be a state newer than the `rev` the record claims, and replay
  // would then fold a structural edit in twice.
  let snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(record));
  } catch (err) {
    console.error(`[시트지] 저널 레코드를 만들지 못했습니다 (${id}): ${err && err.message}`);
    return Promise.resolve(false);
  }
  return runExclusive(id, () => storage.appendJournal(id, snapshot)).then(
    (ok) => ok === true,
    (err) => {
      console.error(`[시트지] 저널 기록 실패 (${id}): ${err && err.message}`);
      return false;
    },
  );
}

/**
 * Compaction (SPEC 27.1). The snapshot is not the source of truth; it is a compaction of
 * the journal, and this order is the whole point: the snapshot is written and made
 * durable FIRST, and only then is the journal truncated. Truncating first would open a
 * window in which neither copy holds the data.
 *
 * Both steps run inside ONE task on this document's chain, so no record can slip in
 * between them and then be truncated away: a record queued after the snapshot is written
 * after the truncate, into the empty journal.
 */
async function compactDoc(id) {
  // A quarantined document is never compacted (SPEC 27.6). Both halves of a compaction are
  // destructive to it: saveSnapshot rotates the file this process could not read down the
  // backup ring and installs a document built without whatever it held, and
  // truncateJournal deletes records that are in no snapshot. The store refuses both as
  // well — this is the earlier of the two refusals, and the one that keeps a refusal per
  // debounce tick out of the error log.
  if (unreadableDocs.has(id)) return;
  const doc = docs.get(id);
  if (!doc) return;
  await storage.saveSnapshot(id, doc);
  await storage.truncateJournal(id);
}

// Serialise writes per document so a debounced flush can never interleave.
function saveNow(id) {
  return runExclusive(id, () => compactDoc(id)).catch((err) => {
    // A store that answers a compaction with ESTOREUNREAD has failed a read for this
    // document since boot. Take it out of service NOW rather than retry a write that will
    // be refused for ever: the point is not the failed save, it is that new edits must
    // stop reaching a document whose stored state nobody has seen (SPEC 27.6).
    if (err && err.code === 'ESTOREUNREAD') {
      if (quarantineDoc(id, err)) notifyUnreadable(id);
      return;
    }
    console.error(`[시트지] 저장 실패 (${id}): ${err && err.message}`);
  });
}

function scheduleSave(id) {
  // Nothing to debounce for a document that must not be written (SPEC 27.6).
  if (unreadableDocs.has(id)) return;
  const existing = saveTimers.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    saveTimers.delete(id);
    saveNow(id);
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(id, timer);
}

async function flushAllSaves() {
  for (const [id, timer] of [...saveTimers]) {
    clearTimeout(timer);
    saveTimers.delete(id);
    saveNow(id);
  }
  await Promise.all([...opChains.values()]);
  // A journal can still hold acknowledged bytes for a document nothing scheduled a save
  // for (its compaction already ran, then one more edit arrived). SPEC 27.1: always make
  // everything durable before a clean exit, then let the backend close what it opened.
  await storage.flush();
}

// True when the file on disk is not yet in the multi-sheet shape: a v1 document (its one
// sheet stored inline on the document) or a half-written file with both shapes. Such a
// file is rewritten once, right after boot, so the migration does not re-run every boot.
function needsMigrationWriteBack(raw) {
  if (!isPlainObject(raw)) return true;
  if (!Array.isArray(raw.sheets) || raw.sheets.length === 0) return true;
  for (const key of ['cells', 'rows', 'cols', 'colWidths', 'rowHeights', 'frozenRows', 'frozenCols']) {
    if (has(raw, key)) return true;
  }
  return false;
}

/**
 * Apply ONE journal record, through exactly the same functions the live socket path uses
 * — applyCellsPatch, applyStructEdit, applySheetMetaPatch, applyDocMetaPatch,
 * sanitizeComments, sanitizeDoc. Replay and live editing therefore cannot drift apart:
 * there is no second implementation of "what an edit means" to fall out of step.
 *
 * Returns the document to carry forward, or null when the record is unusable.
 */
function applyJournalRecord(doc, rec) {
  switch (rec.t) {
    // A whole-document record: written when a document is created, and after every sheet
    // op. Sheet ops mint fresh sheet ids from the clock, so replaying the OPERATION would
    // invent different ids and orphan every later record naming one — the RESULT is
    // journaled instead, which is exactly the shape SPEC 27.1 shows.
    case 'doc':
    case 'sheet': {
      if (!isPlainObject(rec.doc)) return null;
      const next = sanitizeDoc(rec.doc);
      next.id = doc.id; // the file name stays authoritative
      return next;
    }
    case 'edit': {
      const sheet = findSheet(doc, rec.sheetId);
      if (!sheet || !isPlainObject(rec.cells)) return null;
      if (Object.keys(rec.cells).length > MAX_CELLS_PER_EDIT) return null;
      applyCellsPatch(sheet, rec.cells);
      return doc;
    }
    case 'struct': {
      const sheet = findSheet(doc, rec.sheetId);
      if (!sheet) return null;
      // Re-normalised against the sheet as it stands at THIS point of the replay, which
      // is the same state the live path normalised against — so this is the identity for
      // a well-formed record and a guard against a corrupted one.
      const edit = normalizeStructEdit(rec.edit, sheet);
      if (!edit) return null;
      applyStructEdit(sheet, edit);
      return doc;
    }
    case 'meta': {
      const sheet = findSheet(doc, rec.sheetId);
      if (!sheet || !isPlainObject(rec.patch)) return null;
      if (metaPatchRefusal(rec.patch)) return null;
      applySheetMetaPatch(sheet, rec.patch);
      return doc;
    }
    case 'docmeta': {
      return applyDocMetaPatch(doc, rec.patch) ? doc : null;
    }
    // Comment ids, authors and timestamps are stamped by the server from its own clock
    // and the peer record, so — like a sheet op — the RESULT is journaled rather than the
    // operation. It still lands through sanitizeComments, the same gate the live path uses.
    case 'comment': {
      const sheet = findSheet(doc, rec.sheetId);
      if (!sheet || !isPlainObject(rec.comments)) return null;
      sheet.comments = sanitizeComments(rec.comments, sheet.rows, sheet.cols);
      return doc;
    }
    default:
      return null;
  }
}

/**
 * Replay a journal on top of a snapshot (SPEC 27.1). **The journal wins**: a snapshot
 * written while the journal held newer records is harmless, because every record carries
 * the `rev` it produced and only records newer than the snapshot are applied.
 *
 * That same test is what makes replay exactly-once. A compaction that wrote its snapshot
 * and died before truncating leaves records the snapshot already contains; skipping them
 * matters enormously for a structural edit, where applying one twice inserts two rows.
 */
function replayJournal(id, base, records) {
  let doc = base;
  let applied = 0;
  let bad = 0;
  for (const rec of records) {
    if (!isPlainObject(rec) || typeof rec.t !== 'string') {
      bad++;
      continue;
    }
    const rev = typeof rec.rev === 'number' && Number.isFinite(rec.rev) ? Math.round(rec.rev) : null;
    if (rev === null) {
      bad++;
      continue;
    }
    if (rev <= doc.rev) continue; // already folded into the snapshot
    let next = null;
    try {
      next = applyJournalRecord(doc, rec);
    } catch (err) {
      console.warn(`[시트지] 저널 레코드 적용 실패 (${id}, ${rec.t}): ${err && err.message}`);
      next = null;
    }
    if (!next) {
      bad++;
      continue;
    }
    doc = next;
    doc.rev = rev;
    doc.updatedAt = typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : Date.now();
    applied++;
  }
  if (bad) console.warn(`[시트지] ${id}: 적용할 수 없는 저널 레코드 ${bad}개를 건너뛰었습니다.`);
  return { doc, applied, bad };
}

/**
 * Boot (SPEC 27.1): load each document's snapshot, then replay its journal on top. The
 * journal wins, so a snapshot written while the journal held newer records is harmless.
 *
 * Which store this reads from is settled by the environment, not here (SPEC 29.1).
 */
async function loadDocsFromDisk() {
  const rewrite = new Set();
  let migrated = 0;
  let recovered = 0;

  // A store that cannot even LIST is left to reject, and boot dies with it (SPEC 29.1):
  // an unreadable data/ makes every document invisible at once, and carrying on would
  // invite brand-new documents on top of every one of them. An unreadable single
  // DOCUMENT is a different matter and is caught inside the loop.
  for (const id of await storage.listDocIds()) {
    let loaded;
    try {
      loaded = await loadOneDoc(id);
    } catch (err) {
      // loadDoc and readJournal reject for UNREAD and for nothing else, so EVERY rejection
      // here quarantines the document (SPEC 29.1) — including one the backend forgot to
      // tag, because the reading that must never happen is "not the unread error, so I may
      // carry on as though the document were empty".
      //
      // Quarantining is one line because of what it withholds: the document is never put
      // into `docs`, and `docs` is what every route, every socket frame and every
      // compaction resolves through. Not being in it is what makes the document unservable,
      // unwritable and uncompactable in a single step.
      quarantineDoc(id, err);
      continue;
    }
    if (!loaded) continue; // a stray empty file, nothing to load
    docs.set(id, loaded.doc);
    if (loaded.legacy) migrated++;
    if (loaded.rewrite) rewrite.add(id);
    recovered += loaded.recovered;
  }

  for (const id of rewrite) saveNow(id);
  if (migrated) {
    console.log(`[시트지] 이전 형식 문서 ${migrated}개를 시트 목록 형식으로 변환했습니다.`);
  }
  if (recovered) {
    console.log(`[시트지] 저널에서 작업 ${recovered}개를 복구했습니다.`);
  }
  // The count, once, so nobody has to spot one line in a hundred (SPEC 27.6). The
  // per-document lines are already out; this is the summary that says how big the problem
  // is and that it will not fix itself.
  if (unreadableDocs.size) {
    console.error(
      `[시트지] 문서 ${unreadableDocs.size}개를 읽지 못해 열지 않았습니다: `
      + `${[...unreadableDocs.keys()].join(', ')}`,
    );
    console.error(
      '[시트지] 그 문서들의 내용은 저장소에 그대로 있습니다. 서버는 아무것도 덮어쓰거나 지우지 않으며, '
      + '원인을 고친 뒤 다시 시작하면 그대로 다시 열립니다.',
    );
  }
}

/**
 * One document's snapshot plus its journal, or null when the store holds nothing usable
 * for it. It REJECTS when either read failed, and the caller reads that as "quarantine".
 *
 * Split out of the loop above for exactly that reason: a rejection has to abandon this one
 * document without abandoning the boot, and the try/catch that does it must not be able to
 * swallow a failure from any of the other documents.
 */
async function loadOneDoc(id) {
  const found = await storage.loadDoc(id);
  const journal = await storage.readJournal(id);
  const records = journal && Array.isArray(journal.records) ? journal.records : [];
  const badLines = journal && Number.isFinite(journal.badLines) ? journal.badLines : 0;
  // What the store actually holds, before sanitizeDoc migrated it in memory. A backend
  // that does not report it is saying its stored form is already the current shape.
  const stored = found ? (has(found, 'raw') ? found.raw : found.doc) : null;
  let base = found ? found.doc : null;
  if (!base) {
    if (!records.length) return null; // a stray empty file, nothing to load
    console.warn(`[시트지] ${id}: 스냅숏이 없어 저널만으로 복구합니다.`);
    base = emptyDoc(id, undefined);
    base.id = id;
    // With no snapshot there is nothing to be newer than: -1 admits every record,
    // including the `doc` record written when the document was created.
    base.rev = -1;
  }
  const replayed = replayJournal(id, base, records);
  const doc = replayed.doc;
  if (doc.rev < 0) doc.rev = 0;

  const legacy = found ? needsMigrationWriteBack(stored) : false;
  // Rewrite immediately (not debounced) whenever what is stored is not what is now in
  // memory: a v1 document that was just migrated, a snapshot the journal moved past, or
  // a document rebuilt from a backup. The next boot must find a clean snapshot and an
  // empty journal.
  // `badLines` counts too: a journal holding nothing but an unparseable fragment applies
  // nothing, so an `applied`-only test would leave that fragment on disk for ever —
  // and every later append would be concatenated onto it and lost with it.
  const rewrite = !!(replayed.applied || replayed.bad || badLines || !found
    || found.fromBackup || legacy);
  return { doc, legacy, rewrite, recovered: replayed.applied };
}

// A first-time visitor should land on a document that already demonstrates formulas —
// and, since sheets exist now, on one that already has a second tab.
function createStarterDoc() {
  const base = emptyDoc(STARTER_DOC_ID, '시작 시트');

  const head = { b: 1, bg: '#e8f0fe', align: 'center' };
  const money = { fmt: 'number', decimals: 0 };
  const cells = {
    A1: { input: '상반기 매출 현황', style: { b: 1, fg: '#1a73e8' } },
    A2: { input: '숫자를 바꾸면 아래 수식이 즉시 다시 계산됩니다.', style: { fg: '#5f6368' } },
    A3: { input: '월', style: head },
    B3: { input: '매출', style: head },
    C3: { input: '목표', style: head },
    D3: { input: '달성 여부', style: head },
  };
  const months = ['1월', '2월', '3월', '4월', '5월', '6월'];
  const sales = [12500000, 13800000, 11200000, 15400000, 16900000, 14300000];
  const targets = [13000000, 13000000, 13000000, 14000000, 15000000, 15000000];
  months.forEach((label, i) => {
    const r = 4 + i;
    cells[`A${r}`] = { input: label, style: { align: 'center' } };
    cells[`B${r}`] = { input: String(sales[i]), style: money };
    cells[`C${r}`] = { input: String(targets[i]), style: money };
    cells[`D${r}`] = { input: `=IF(B${r}>=C${r},"달성","미달")`, style: { align: 'center' } };
  });
  cells.A11 = { input: '합계', style: { b: 1 } };
  cells.B11 = { input: '=SUM(B4:B9)', style: { b: 1, ...money } };
  cells.C11 = { input: '=SUM(C4:C9)', style: money };
  cells.A12 = { input: '평균', style: { b: 1 } };
  cells.B12 = { input: '=AVERAGE(B4:B9)', style: money };
  cells.C12 = { input: '=AVERAGE(C4:C9)', style: money };
  cells.A13 = { input: '최고 매출', style: { b: 1 } };
  cells.B13 = { input: '=MAX(B4:B9)', style: money };
  cells.A14 = { input: '달성 개월', style: { b: 1 } };
  cells.B14 = { input: '=COUNTIF(D4:D9,"달성")&"개월"', style: { align: 'right' } };

  const first = {
    ...base.sheets[0],
    name: '월별 매출',
    cells,
    colWidths: { 0: 90, 1: 140, 2: 140, 3: 110 },
    frozenRows: 3,
  };

  // A second tab, so the sheet bar demonstrates itself on the very first visit.
  const pct = { fmt: 'percent', decimals: 1 };
  const summary = {
    A1: { input: '분기 요약', style: { b: 1, fg: '#188038' } },
    A2: { input: '아래 탭으로 시트를 오가고, + 버튼으로 새 시트를 추가할 수 있습니다.', style: { fg: '#5f6368' } },
    A3: { input: '탭을 두 번 누르면 이름 변경, 탭 메뉴에서 색상·복사본·삭제를 고를 수 있습니다.', style: { fg: '#5f6368' } },
    A5: { input: '분기', style: head },
    B5: { input: '매출', style: head },
    C5: { input: '비중', style: head },
    A6: { input: '1분기', style: { align: 'center' } },
    B6: { input: '37500000', style: money },
    C6: { input: '=B6/$B$8', style: pct },
    A7: { input: '2분기', style: { align: 'center' } },
    B7: { input: '46600000', style: money },
    C7: { input: '=B7/$B$8', style: pct },
    A8: { input: '합계', style: { b: 1 } },
    B8: { input: '=SUM(B6:B7)', style: { b: 1, ...money } },
    C8: { input: '=SUM(C6:C7)', style: { b: 1, ...pct } },
    A10: { input: '분기 평균', style: { b: 1 } },
    B10: { input: '=AVERAGE(B6:B7)', style: money },
  };
  const second = {
    ...emptySheet(undefined, '분기 요약'),
    cells: summary,
    colWidths: { 0: 110, 1: 150, 2: 110 },
    frozenRows: 5,
    color: '#188038',
  };

  const clean = sanitizeDoc({ ...base, sheets: [first, second] });
  clean.id = STARTER_DOC_ID;
  return clean;
}

// ---------------------------------------------------------------------------
// document mutation (shared by HTTP and WebSocket handlers)
// ---------------------------------------------------------------------------

function touchDoc(doc) {
  doc.rev += 1;
  doc.updatedAt = Date.now();
  scheduleSave(doc.id);
  return doc.rev;
}

/**
 * Merge a `cells` patch into one sheet (last-write-wins per cell).
 * Returns the normalised patch to broadcast: `null` for a removed cell, otherwise
 * `{ input?, style?, link? }` mirroring the operation that was applied.
 */
function applyCellsPatch(sheet, cells) {
  const ops = {};
  const candidates = {};
  const removals = [];

  for (const rawKey of Object.keys(cells)) {
    const pos = parseCellKey(rawKey);
    if (!pos) continue;
    if (pos.row >= sheet.rows || pos.col >= sheet.cols) continue; // outside the sheet
    const key = pos.key;
    const patch = cells[rawKey];

    if (patch === null) {
      removals.push(key);
      ops[key] = null;
      continue;
    }
    if (!isPlainObject(patch)) continue;

    const hasInput = has(patch, 'input');
    const hasStyle = has(patch, 'style');
    const hasLink = has(patch, 'link');
    if (!hasInput && !hasStyle && !hasLink) continue;

    // `input: null` clears the CONTENT only. It is what Delete sends, and a person
    // pressing Delete has not asked to lose the cell's borders, colours or link — every
    // other spreadsheet keeps them. Removing the whole cell here also made the server
    // disagree with the screen, which keeps the formatting, until the next reload.
    // A cut sends `null` for the entry instead, handled above, and that does take
    // everything. The cell is dropped further down if nothing at all survives.

    const current = sheet.cells[key];
    const next = {};
    if (current && typeof current.input === 'string') next.input = current.input;
    if (current && isPlainObject(current.style)) next.style = cloneStyle(current.style);
    if (current && typeof current.link === 'string') next.link = current.link;

    const op = {};
    if (hasInput) {
      let input;
      if (typeof patch.input === 'string') input = patch.input;
      else if (patch.input === null) input = '';   // clear the content, keep the rest
      else if (typeof patch.input === 'number' && Number.isFinite(patch.input)) input = String(patch.input);
      else if (typeof patch.input === 'boolean') input = patch.input ? 'TRUE' : 'FALSE';
      if (input === undefined) continue; // unusable payload, ignore this key
      op.input = input;
      // Clearing the CONTENT does not delete the cell: its formatting and its link are
      // independent things the user did not ask to lose. The cell is dropped further
      // down only if nothing at all remains in it.
      if (input === '') delete next.input;
      else next.input = input;
    }
    if (hasStyle) {
      if (patch.style === null) {
        delete next.style;
        op.style = null;
      } else if (isPlainObject(patch.style)) {
        // Cheap gate before the merge: an absurdly large `bd` is refused outright rather
        // than copied around and handed to sanitizeDoc. Treated like any other unusable
        // style payload — the cell is left exactly as it was and nothing is broadcast.
        if (borderTooLarge(patch.style.bd)) continue;
        const merged = { ...(next.style || {}) };
        const cleanOp = {};
        for (const styleKey of Object.keys(patch.style)) {
          if (!STYLE_KEYS.has(styleKey)) continue;
          const value = patch.style[styleKey];
          cleanOp[styleKey] = value;
          if (value === null) delete merged[styleKey];
          else merged[styleKey] = value;
        }
        if (Object.keys(merged).length) next.style = merged;
        else delete next.style;
        op.style = cleanOp;
      } else {
        continue; // invalid style payload
      }
    }

    // Hyperlinks (SPEC 23.4). A link is attacker-controlled text that every peer will
    // render as an anchor, so what gets STORED is always the output of sanitizeLink —
    // http/https/mailto only — never the string that arrived. Talking to this socket
    // directly buys nothing: the gate is here, not in the client's link panel.
    //
    // Shaped exactly like `input`: a string sets it, `null` clears it, anything else
    // (a number, an object) is ignored. A string that FAILS validation clears rather
    // than being ignored, which is the one judgement call: the sender already applied
    // it optimistically to its own grid, so the broadcast has to carry the truth back.
    // Leaving the key untouched would say nothing about the link and let a rejected
    // `javascript:` URL survive in the sender's DOM while no other peer has it.
    if (hasLink) {
      if (patch.link === null) {
        delete next.link;
        op.link = null;
      } else if (typeof patch.link === 'string') {
        const link = sanitizeLink(patch.link);
        if (link) next.link = link;
        else delete next.link;
        op.link = link;
      }
    }

    // A patch naming only keys this server cannot use (`{link: 42}`) applies nothing;
    // dropping it here keeps it from bumping `rev` and broadcasting an empty operation.
    if (!Object.keys(op).length) continue;

    candidates[key] = next;
    ops[key] = op;
  }

  // Validate every touched entry through the shared model in one pass.
  const candidateKeys = Object.keys(candidates);
  if (candidateKeys.length) {
    const validated = validateSheet({
      rows: sheet.rows,
      cols: sheet.cols,
      cells: candidates,
    }).cells;
    for (const key of candidateKeys) {
      const entry = validated[key];
      if (entry) {
        sheet.cells[key] = entry;
        // Broadcast what was actually STORED, not what arrived. `ops[key]` still holds
        // the client's raw values, which sanitizeDoc may have truncated, clamped or
        // dropped (an over-long input, an out-of-range decimals, a malformed colour).
        // Sending the raw version would leave every peer — and the sender's own engine —
        // holding a value the server does not have. Cells are last-write-wins, so
        // replaying the whole validated cell is always safe.
        // cloneStyle, not the stored object: the patch about to be broadcast must not
        // alias the document's own `bd`.
        // A link joins the broadcast only when there is something to say about it:
        // the stored cell HAS one, or this patch cleared (or rejected) one. A document
        // that never uses links therefore produces exactly the frame it produced before
        // links existed.
        const linkTouched = isPlainObject(ops[key]) && has(ops[key], 'link');
        const out = {
          input: entry.input === undefined ? '' : entry.input,
          style: entry.style ? cloneStyle(entry.style) : null,
        };
        if (entry.link) out.link = entry.link;
        else if (linkTouched) out.link = null;
        ops[key] = out;
      } else {
        delete sheet.cells[key]; // nothing left in the cell
        ops[key] = null;
      }
    }
  }
  for (const key of removals) delete sheet.cells[key];

  return ops;
}

// Shift a { '<index>': px } map across an insert/delete of rows or columns.
function shiftSizeMap(map, edit, limit) {
  const inserting = edit.kind === 'insertRow' || edit.kind === 'insertCol';
  const out = {};
  for (const key of Object.keys(map)) {
    const idx = Number(key);
    if (!Number.isInteger(idx)) continue;
    let target = idx;
    if (inserting) {
      if (idx >= edit.index) target = idx + edit.count;
    } else {
      if (idx >= edit.index && idx < edit.index + edit.count) continue; // removed band
      if (idx >= edit.index + edit.count) target = idx - edit.count;
    }
    if (target < 0 || target >= limit) continue;
    out[String(target)] = map[key];
  }
  return out;
}

function shiftFrozen(frozen, edit, limit) {
  const inserting = edit.kind === 'insertRow' || edit.kind === 'insertCol';
  let value = frozen;
  if (inserting) {
    if (edit.index < frozen) value = frozen + edit.count;
  } else if (edit.index < frozen) {
    const overlap = Math.min(frozen, edit.index + edit.count) - edit.index;
    value = frozen - Math.max(0, overlap);
  }
  return clampInt(value, 0, limit, 0);
}

// Relocate cell hyperlinks across a structural edit.
//
// SheetEngine owns the moving of cell CONTENTS, but it knows nothing about `link` — its
// snapshot carries only { input, style }. Without this, inserting a single row would
// silently drop every hyperlink in the sheet, and a link-only cell would vanish outright.
// The arithmetic mirrors the engine's exactly: an insert pushes everything at or after
// `index` along by `count`; a delete removes that band and pulls the rest back. Keys
// pushed off the addressable sheet are dropped here, and keys outside THIS sheet's
// rows/cols are dropped by validateSheet afterwards.
//
// `edit` is already normalised (kind, index >= 0, count >= 1). -> Map<newA1, link>
function shiftCellLinks(cells, edit) {
  const out = new Map();
  const isRow = edit.kind === 'insertRow' || edit.kind === 'deleteRow';
  const inserting = edit.kind === 'insertRow' || edit.kind === 'insertCol';
  const limit = isRow ? LIMIT_ROWS : LIMIT_COLS;
  for (const key of Object.keys(cells)) {
    const entry = cells[key];
    if (!isPlainObject(entry) || typeof entry.link !== 'string' || !entry.link) continue;
    const pos = parseCellKey(key);
    if (!pos) continue;
    let axis = isRow ? pos.row : pos.col;
    if (inserting) {
      if (axis >= edit.index) axis += edit.count;
    } else if (axis >= edit.index && axis < edit.index + edit.count) {
      continue; // inside the deleted band: the cell, and with it the link, is gone
    } else if (axis >= edit.index + edit.count) {
      axis -= edit.count;
    }
    if (axis < 0 || axis >= limit) continue;
    out.set(isRow ? cellToA1(axis, pos.col) : cellToA1(pos.row, axis), entry.link);
  }
  return out;
}

// Merge relocated links back into the post-edit cell map. Returns `cells` itself when
// there is nothing to merge, so a sheet with no links follows byte-for-byte the path it
// followed before links existed.
function withShiftedLinks(cells, links) {
  if (!links.size) return cells;
  const out = { ...cells };
  for (const [key, link] of links) {
    const entry = out[key];
    out[key] = isPlainObject(entry) ? { ...entry, link } : { link };
  }
  return out;
}

function normalizeStructEdit(edit, sheet) {
  if (!isPlainObject(edit)) return null;
  if (typeof edit.kind !== 'string' || !STRUCT_KINDS.has(edit.kind)) return null;
  const isRow = edit.kind === 'insertRow' || edit.kind === 'deleteRow';
  const limit = isRow ? sheet.rows : sheet.cols;
  // An insert may legitimately target one past the last row/column — that is what
  // "아래에 행 삽입" on the final row means, and both the grid menu and the toolbar send
  // it as `lastIndex + 1`. Clamping that down to `limit - 1` would insert BEFORE the last
  // row instead, pushing its contents to index `limit`, where sanitizeDoc drops them:
  // the user loses a row of data. A delete still has to name an existing index.
  const inserting = edit.kind === 'insertRow' || edit.kind === 'insertCol';
  const maxIndex = inserting ? limit : Math.max(0, limit - 1);
  const index = clampInt(edit.index, 0, maxIndex, null);
  if (index === null) return null;
  const count = clampInt(edit.count, 1, MAX_STRUCT_COUNT, 1);
  return { kind: edit.kind, index, count };
}

/** Apply a structural edit to one sheet, in place. Returns the normalised edit. */
function applyStructEdit(sheet, edit) {
  const engine = new SheetEngine({
    rows: sheet.rows,
    cols: sheet.cols,
    cells: cloneCells(sheet.cells),
  });
  const snapshot = engine.applyStructuralEdit(edit);
  const rows = clampInt(snapshot && snapshot.rows, 1, LIMIT_ROWS, sheet.rows);
  const cols = clampInt(snapshot && snapshot.cols, 1, LIMIT_COLS, sheet.cols);
  const cells = withShiftedLinks(
    snapshot && isPlainObject(snapshot.cells) ? snapshot.cells : sheet.cells,
    shiftCellLinks(sheet.cells, edit),
  );

  const isRow = edit.kind === 'insertRow' || edit.kind === 'deleteRow';
  const nextRowHeights = isRow ? shiftSizeMap(sheet.rowHeights, edit, rows) : sheet.rowHeights;
  const nextColWidths = isRow ? sheet.colWidths : shiftSizeMap(sheet.colWidths, edit, cols);
  const nextFrozenRows = isRow ? shiftFrozen(sheet.frozenRows, edit, rows) : sheet.frozenRows;
  const nextFrozenCols = isRow ? sheet.frozenCols : shiftFrozen(sheet.frozenCols, edit, cols);
  // Merged rectangles move with the cells they cover (SPEC 21.3): an insert inside a
  // rectangle grows it, one before it slides it, a delete shrinks it, and a rectangle
  // whose whole band is deleted disappears. `rows`/`cols` are already the post-edit
  // dimensions, which is exactly what shiftMerges wants.
  const nextMerges = shiftMerges(sheet.merges, edit, rows, cols);
  // Batch-C state follows the cells it points at (SPEC 24). The filter's range, every
  // chart's range and every comment key move with exactly the same arithmetic as a merged
  // rectangle, and whatever falls entirely inside a deleted band is dropped: a filter over
  // deleted columns, a chart plotting deleted rows, a comment on a deleted cell. Each
  // helper short-circuits on empty state, so a sheet using none of the three costs nothing.
  const nextFilter = shiftFilter(sheet.filter, edit, rows, cols);
  const nextCharts = shiftCharts(sheet.charts, edit, rows, cols);
  const nextComments = shiftComments(sheet.comments, edit, rows, cols);

  const clean = validateSheet({
    rows,
    cols,
    cells,
    colWidths: nextColWidths,
    rowHeights: nextRowHeights,
    frozenRows: nextFrozenRows,
    frozenCols: nextFrozenCols,
    merges: nextMerges,
    filter: nextFilter,
    charts: nextCharts,
    comments: nextComments,
  });

  sheet.rows = clean.rows;
  sheet.cols = clean.cols;
  sheet.cells = clean.cells;
  sheet.colWidths = clean.colWidths;
  sheet.rowHeights = clean.rowHeights;
  sheet.frozenRows = clean.frozenRows;
  sheet.frozenCols = clean.frozenCols;
  sheet.merges = clean.merges;
  sheet.filter = clean.filter;
  sheet.charts = clean.charts;
  sheet.comments = clean.comments;
  return edit;
}

/**
 * Where one axis of the sheet should END UP, given what a meta frame asked for (SPEC 25.2).
 *
 * Growth is the ONLY direction this route can move a sheet in. A request BELOW the current
 * extent is not a shrink to be applied — the current value is kept — because shrinking
 * would strand every cell, merge, chart range and comment that lives past the new edge,
 * with no rewriting to make any of them coherent again. Removing rows that hold data is
 * what 행 삭제 is for, and that path already carries the reference rewriting (the engine's
 * `applyStructuralEdit` plus `shiftMerges` / `shiftFilter` / `shiftCharts` / `shiftComments`)
 * that makes removal safe. So: clamp into `[current, limit]`, never below.
 *
 * The junk cases are settled here, in a handful of comparisons, before the caller copies or
 * validates anything else in the frame. A value that is not a finite number (a string, an
 * object, `null`, `NaN`, `Infinity`) is not an opinion about the extent at all and leaves it
 * alone; an absurd one (`1e308`) costs one comparison and lands on `limit`. A fractional
 * request floors, so it can only ever grow by less than it asked for, never by more.
 */
function wantedExtent(value, current, limit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return current;
  if (value <= current) return current;  // never a shrink, and never a no-op rewrite
  if (value >= limit) return limit;
  const n = Math.floor(value);
  return n > current ? n : current;
}

/**
 * The cheap size gates a meta frame must clear before anything sanitises it entry by
 * entry. Length is O(1); normalizing is O(n) with an overlap scan per entry, so the cheap
 * test comes first and a hostile ten-million-entry array is refused outright instead of
 * stalling the event loop for everyone else in the room. The same reasoning covers the two
 * batch-C values: a huge charts array, or a filter hiding a million values per column.
 *
 * Journal replay runs the very same gate, so a corrupted line can never install what a
 * live frame could not.
 *
 * -> the Korean refusal to send back, or null when the patch is within every cap.
 */
function metaPatchRefusal(patch) {
  if (!isPlainObject(patch)) return null; // shapeless: applySheetMetaPatch rejects it
  if (Array.isArray(patch.merges) && patch.merges.length > MAX_MERGES) {
    return `병합은 시트당 ${MAX_MERGES}개까지 사용할 수 있습니다.`;
  }
  if (Array.isArray(patch.charts) && patch.charts.length > MAX_CHARTS) {
    return `차트는 시트당 ${MAX_CHARTS}개까지 만들 수 있습니다.`;
  }
  if (filterTooLarge(patch.filter)) return '필터 설정이 너무 큽니다.';
  return null;
}

/** Merge a meta patch into one sheet. Returns the normalised patch (or null). */
function applySheetMetaPatch(sheet, patch) {
  if (!isPlainObject(patch)) return null;
  const applied = {};

  // The sheet's extent (SPEC 25.2). Resolved FIRST, before a single map below is copied,
  // for two reasons: an unusable request is then thrown away at its cheapest possible
  // moment, and everything else in this frame is validated against the extent the frame
  // DESCRIBES rather than the one the sheet is leaving behind — so a client that grows a
  // sheet and installs a merge past the old edge in the same frame gets both, instead of
  // having the merge silently clipped to the size the sheet used to be.
  //
  // Growth changes these two numbers and nothing else. Cells, merges, filter, charts,
  // comments, colWidths and rowHeights are carried across untouched (this function never
  // assigns `sheet.cells` or `sheet.comments` at all, and the rest are only rewritten when
  // the patch itself names them), so a grow can never move a cell or invalidate a formula.
  const rows = wantedExtent(patch.rows, sheet.rows, LIMIT_ROWS);
  const cols = wantedExtent(patch.cols, sheet.cols, LIMIT_COLS);

  const colWidths = { ...sheet.colWidths };
  if (isPlainObject(patch.colWidths)) {
    for (const key of Object.keys(patch.colWidths)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const value = patch.colWidths[key];
      if (value === null) delete colWidths[String(idx)];
      else colWidths[String(idx)] = value;
    }
  }

  const rowHeights = { ...sheet.rowHeights };
  if (isPlainObject(patch.rowHeights)) {
    for (const key of Object.keys(patch.rowHeights)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0) continue;
      const value = patch.rowHeights[key];
      if (value === null) delete rowHeights[String(idx)];
      else rowHeights[String(idx)] = value;
    }
  }

  const frozenRows = patch.frozenRows === undefined ? sheet.frozenRows : patch.frozenRows;
  const frozenCols = patch.frozenCols === undefined ? sheet.frozenCols : patch.frozenCols;

  // Merges REPLACE the stored list (SPEC 21.3) — they are geometry, not a key/value map,
  // so a key-by-key merge would make "unmerge" impossible to express. Whatever arrives is
  // re-run through normalizeMergeList against THIS sheet's rows/cols, so no client can
  // install an overlapping, out-of-bounds, backwards, 1x1 or malformed rectangle no matter
  // how hostile the frame is. An empty array is legitimate: it clears every merge.
  // The over-long case is refused by the caller; re-checked here so this helper is safe
  // on its own terms.
  const merges =
    Array.isArray(patch.merges) && patch.merges.length <= MAX_MERGES
      ? normalizeMergeList(patch.merges, rows, cols)
      : null;

  // The filter view REPLACES the stored one (SPEC 24.1). It describes ONE view, so a
  // key-by-key merge could not express "turn the filter off" at all. `null` clears it; an
  // object is re-run through sanitizeFilter against THIS sheet's rows/cols, so no client
  // can install a range outside the sheet, a sort on a column its range does not have, or
  // an unbounded hidden-value list. An object that does not survive validation is not a
  // filter this server can store, so it clears too — and because the broadcast carries the
  // VALIDATED value, a sender that applied it optimistically is corrected rather than left
  // holding a view nobody else has. Any other type (a number, an array) is not an opinion
  // about the filter at all and leaves the stored one alone.
  let filter = null;
  let filterTouched = false;
  if (has(patch, 'filter')) {
    if (patch.filter === null) {
      filterTouched = true;
    } else if (isPlainObject(patch.filter) && !filterTooLarge(patch.filter)) {
      filter = sanitizeFilter(patch.filter, rows, cols);
      filterTouched = true;
    }
  }

  // Charts REPLACE the stored list, exactly like `merges` (SPEC 24.2): an empty array is
  // the legitimate way to delete the last chart, and sanitizeChartList re-mints duplicate
  // ids, drops entries whose range is outside the sheet and caps the list at MAX_CHARTS.
  // A non-array says nothing about the charts, so the stored list survives it.
  const charts =
    Array.isArray(patch.charts) && patch.charts.length <= MAX_CHARTS
      ? sanitizeChartList(patch.charts, rows, cols)
      : null;

  const clean = validateSheet({
    rows,
    cols,
    colWidths,
    rowHeights,
    frozenRows,
    frozenCols,
  });

  // Store the extent before anything that was validated against it. What goes out on the
  // wire is the STORED value, never the requested one: a frame asking to shrink, or asking
  // for more rows than a sheet can hold, is answered with the extent the server actually
  // has, so the sender — which grew its own grid optimistically — is corrected instead of
  // being left alone with a size nobody else agrees on. A frame that says nothing about an
  // axis leaves that axis out of the broadcast entirely, so a document that never grows
  // produces exactly the meta frame it produced before growth existed.
  sheet.rows = clean.rows;
  sheet.cols = clean.cols;
  if (patch.rows !== undefined) applied.rows = clean.rows;
  if (patch.cols !== undefined) applied.cols = clean.cols;

  if (isPlainObject(patch.colWidths)) {
    sheet.colWidths = clean.colWidths;
    applied.colWidths = clean.colWidths;
  }
  if (isPlainObject(patch.rowHeights)) {
    sheet.rowHeights = clean.rowHeights;
    applied.rowHeights = clean.rowHeights;
  }
  if (patch.frozenRows !== undefined) {
    sheet.frozenRows = clean.frozenRows;
    applied.frozenRows = clean.frozenRows;
  }
  if (patch.frozenCols !== undefined) {
    sheet.frozenCols = clean.frozenCols;
    applied.frozenCols = clean.frozenCols;
  }
  if (merges) {
    sheet.merges = merges;
    // Echo the NORMALIZED list, never the one that arrived: peers (and the sender) must
    // end up holding exactly the geometry the server stored.
    applied.merges = merges;
  }
  // Same rule for the two batch-C values: what is broadcast is what was STORED.
  if (filterTouched) {
    sheet.filter = filter;
    applied.filter = filter;
  }
  if (charts) {
    sheet.charts = charts;
    applied.charts = charts;
  }
  return Object.keys(applied).length ? applied : null;
}

/** Merge a document-level meta patch (the title). Returns the applied patch or null. */
function applyDocMetaPatch(doc, patch) {
  if (!isPlainObject(patch)) return null;
  if (typeof patch.name !== 'string') return null;
  doc.name = validateDocName(patch.name);
  return { name: doc.name };
}

// ---------------------------------------------------------------------------
// comment threads (SPEC 24.3)
//
// A thread hangs on a cell and is keyed by that cell's A1 string, so a sheet holds at
// most one thread per cell. Everything below is a PLAN: it reads the stored map and
// returns a new one, and nothing is stored until sanitizeComments has agreed with it.
//
// `author`, `authorId` and `at` are stamped by this server from the peer record and its
// own clock. A client-supplied author or timestamp is never read — not validated, not
// preferred, simply never looked at — because anything else lets a socket post as
// somebody else, or backdate a message into the middle of a thread.
// ---------------------------------------------------------------------------

// A fresh short id ('cm…' for a thread, 'ms…' for a message) that is free within `taken`.
// Shaped so shared/model.js keeps it instead of re-minting a duplicate: the client uses
// exactly the id it sees in the broadcast to reply to, resolve and delete the thread.
function newShortId(prefix, taken) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = prefix + newId(Date.now() + attempt).slice(0, 6);
    if (!taken || !taken.has(id)) return id;
  }
  // Deterministic fallback, so a pathological id stream cannot loop forever. `taken` is
  // finite (MAX_COMMENTS_PER_SHEET threads, 200 messages in a thread), so this always
  // finds a free id long before the bound.
  for (let k = 0; k <= 100000; k++) {
    const id = prefix + k.toString(36).padStart(4, '0');
    if (!taken || !taken.has(id)) return id;
  }
  return prefix + Date.now().toString(36);
}

function threadIdsIn(comments) {
  const out = new Set();
  for (const key of Object.keys(comments)) {
    const thread = comments[key];
    if (thread && typeof thread.id === 'string') out.add(thread.id);
  }
  return out;
}

function messageIdsIn(thread) {
  const out = new Set();
  if (!thread || !Array.isArray(thread.messages)) return out;
  for (const message of thread.messages) {
    if (message && typeof message.id === 'string') out.add(message.id);
  }
  return out;
}

// The A1 key of the thread a frame targets, or null when there is no such thread.
// `threadId` is authoritative: a structural edit by another peer can move a thread while
// a panel sits open on it, so a stale `cell` must not stop a reply from landing on the
// right thread. Only a frame carrying no threadId (the first message of a new thread)
// falls back to the cell.
function threadKeyFor(comments, threadId, cellKey) {
  if (threadId) {
    for (const key of Object.keys(comments)) {
      const thread = comments[key];
      if (thread && thread.id === threadId) return key;
    }
    return null;
  }
  return cellKey && comments[cellKey] ? cellKey : null;
}

/**
 * Plan one comment op against a sheet's stored thread map. Pure: it never mutates
 * `comments`, and the map it returns shares only untouched thread objects.
 *
 * @param {object} comments  the sheet's stored (already canonical) thread map
 * @param {string} op        one of COMMENT_OPS
 * @param {object} req       { cellKey, threadId, messageId, text, author, authorId, at }
 * @returns {{next:object, expect:object}|{unchanged:true}|{error:string}}
 */
function planCommentOp(comments, op, req) {
  if (op === 'add' || op === 'reply') {
    // 'add' targets the CELL; an existing thread there gains the message rather than
    // being replaced, because a cell holds exactly one thread and refusing would leave
    // the 댓글 button dead on any cell that already has one. 'reply' targets the thread.
    const key = op === 'add' ? req.cellKey : threadKeyFor(comments, req.threadId, req.cellKey);
    if (!key) return { error: '댓글 스레드를 찾을 수 없습니다.' };

    const existing = comments[key] || null;
    if (!existing && Object.keys(comments).length >= MAX_COMMENTS_PER_SHEET) {
      return { error: `댓글은 시트당 ${MAX_COMMENTS_PER_SHEET}개까지 달 수 있습니다.` };
    }

    const messageId = newShortId('ms', messageIdsIn(existing));
    const message = {
      id: messageId,
      author: req.author,
      authorId: req.authorId,
      text: req.text,
      at: req.at,
    };
    const thread = existing
      ? { ...existing, messages: [...existing.messages, message] }
      : { id: newShortId('cm', threadIdsIn(comments)), cell: key, resolved: false, messages: [message] };
    return { next: { ...comments, [key]: thread }, expect: { key, hasMessage: messageId } };
  }

  if (op === 'resolve' || op === 'reopen') {
    const key = threadKeyFor(comments, req.threadId, req.cellKey);
    if (!key) return { error: '댓글 스레드를 찾을 수 없습니다.' };
    const thread = comments[key];
    const resolved = op === 'resolve';
    if (!!thread.resolved === resolved) return { unchanged: true };
    return { next: { ...comments, [key]: { ...thread, resolved } }, expect: { key, resolved } };
  }

  // 'delete' — with a messageId it removes one message, otherwise the whole thread.
  const key = threadKeyFor(comments, req.threadId, req.cellKey);
  if (!key) return { error: '댓글 스레드를 찾을 수 없습니다.' };
  const thread = comments[key];
  const next = { ...comments };

  if (req.messageId) {
    const kept = thread.messages.filter((message) => message.id !== req.messageId);
    if (kept.length === thread.messages.length) return { error: '댓글을 찾을 수 없습니다.' };
    // A thread with no messages left is not a thread; it goes with its last message.
    if (kept.length) next[key] = { ...thread, messages: kept };
    else delete next[key];
    return { next, expect: { key, goneThread: kept.length === 0, goneMessage: req.messageId } };
  }

  delete next[key];
  return { next, expect: { key, goneThread: true } };
}

// Did the planned op actually survive sanitizeComments? The model owns every cap and every
// hygiene rule (empty text after control characters are stripped, the per-thread message
// limit, the per-sheet thread limit), and it enforces them by DROPPING what does not fit.
// Checking the outcome here turns that silence into an error the sender can see, instead
// of a comment that appears to post and then is not there.
function commentOpTook(comments, expect) {
  const thread = comments[expect.key] || null;
  if (expect.goneThread) return !thread;
  if (!thread) return false;
  if (expect.hasMessage) return thread.messages.some((message) => message.id === expect.hasMessage);
  if (expect.goneMessage) return !thread.messages.some((message) => message.id === expect.goneMessage);
  if (expect.resolved !== undefined) return !!thread.resolved === expect.resolved;
  return true;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function valueToCsvText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '#NUM!';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') {
    if (typeof value.code === 'string') return value.code; // FormulaError
    if (Array.isArray(value.rows)) {
      const first = value.rows[0];
      return Array.isArray(first) ? valueToCsvText(first[0]) : '';
    }
  }
  return String(value);
}

// RFC 4180: quote when the field contains a comma, a quote, CR or LF.
function csvField(text) {
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

// A CSV row holds the cell's computed VALUE. A hyperlink is presentation attached to the
// cell, not its content, so it is never exported — a URL in a data column would silently
// replace the number or label the sheet actually holds (SPEC 23.4).
function sheetToCsv(sheet) {
  const engine = new SheetEngine({
    rows: sheet.rows,
    cols: sheet.cols,
    cells: cloneCells(sheet.cells),
  });
  let maxRow = -1;
  let maxCol = -1;
  for (const key of Object.keys(sheet.cells)) {
    const pos = parseCellKey(key);
    if (!pos) continue;
    if (pos.row > maxRow) maxRow = pos.row;
    if (pos.col > maxCol) maxCol = pos.col;
  }
  if (maxRow < 0 || maxCol < 0) return CSV_BOM;

  const lines = [];
  for (let r = 0; r <= maxRow; r++) {
    const fields = [];
    for (let c = 0; c <= maxCol; c++) {
      let value = null;
      try {
        value = engine.getValue(cellToA1(r, c));
      } catch {
        value = null;
      }
      fields.push(csvField(valueToCsvText(value)));
    }
    lines.push(fields.join(','));
  }
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Access control — ONE shared password for the whole site (SPEC 28)
//
// There are no accounts. Anyone who knows the password reads and writes
// everything; the README says so in as many words, because a shared password is
// not per-user security and must never be mistaken for it.
//
// Two things make this a gate rather than a decoration:
//   1. it is registered BEFORE express.static, so the app's own HTML, CSS and
//      modules sit behind it too, not just the JSON API;
//   2. it covers the WebSocket UPGRADE. /ws can read and write every document in
//      the system, so a gate that stops at HTTP is no gate at all.
//
// Nothing here ever logs, echoes or reflects the password, the hash, the session
// secret or a cookie — not in a log line, not in an error message, not in a
// response body.
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'sz_session';
const SESSION_DAYS_DEFAULT = 14;
const SESSION_DAYS_MAX = 365;
// SPEC 28.4: this many failures inside the window and the address is refused,
// whatever the next password is.
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// The failure table is keyed by address, so it must not be allowed to grow
// without bound when an attacker rotates addresses.
const MAX_LOGIN_IPS = 4096;
const MAX_NEXT_LEN = 512;

// scrypt cost for a plaintext SZ_PASSWORD hashed at boot, and the bounds an
// operator-supplied SZ_PASSWORD_HASH has to fall inside.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MIN_N = 1024;
const SCRYPT_MAX_N = 1 << 20;
const SCRYPT_MAX_R = 32;
const SCRYPT_MAX_P = 16;

// Reachable without a session: the login page, the two endpoints it uses, the
// health check, and exactly the assets that page is built from. Nothing else —
// an unauthenticated visitor cannot pull down the editor, the document list or
// any of the shared modules.
const OPEN_PATHS = new Set([
  '/login',
  '/login.html',
  '/api/login',
  '/api/logout',
  '/healthz',
  '/css/style.css',
  '/js/login.js',
  '/favicon.ico',
]);

/**
 * scrypt memory budget for a given cost. Node refuses the call when
 * 128 * N * r exceeds maxmem, and the default (32 MB) is below what a large
 * operator-chosen N needs, so the budget is computed from the parameters
 * actually in use rather than left at the default.
 */
function scryptMaxmem(N, r) {
  return 128 * N * r + (2 << 20);
}

function toB64(buf) {
  return Buffer.from(buf).toString('base64');
}

/** Decode base64 strictly: text that does not re-encode to itself is refused. */
function fromB64(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let buf;
  try {
    buf = Buffer.from(text, 'base64');
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.toString('base64') !== text) return null;
  return buf;
}

/**
 * Hash a password into the storable form `scrypt$N$r$p$saltB64$hashB64`.
 *
 * Exported so `tools/hash-password.mjs` — and `node server.js hash-password` —
 * can print one, which is how an operator gets a hash without ever putting the
 * plaintext into the environment of the running server.
 */
export function hashPassword(password, options = {}) {
  const N = Number.isInteger(options.N) ? options.N : SCRYPT_N;
  const r = Number.isInteger(options.r) ? options.r : SCRYPT_R;
  const p = Number.isInteger(options.p) ? options.p : SCRYPT_P;
  const salt = options.salt ? Buffer.from(options.salt) : randomBytes(SCRYPT_SALT_BYTES);
  const key = scryptSync(Buffer.from(String(password), 'utf8'), salt, SCRYPT_KEYLEN, {
    N, r, p, maxmem: scryptMaxmem(N, r),
  });
  return `scrypt$${N}$${r}$${p}$${toB64(salt)}$${toB64(key)}`;
}

/** `scrypt$N$r$p$saltB64$hashB64` -> { N, r, p, salt, hash }, or null when malformed. */
function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || N < SCRYPT_MIN_N || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > SCRYPT_MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > SCRYPT_MAX_P) return null;
  const salt = fromB64(parts[4]);
  const hash = fromB64(parts[5]);
  if (!salt || !hash || hash.length < 16) return null;
  return { N, r, p, salt, hash };
}

/**
 * The live gate configuration. `enabled` decides everything: when it is false
 * every check below short-circuits and the server behaves exactly as it did
 * before this section existed, which is what running it on a laptop should feel
 * like.
 */
const auth = {
  enabled: false,
  params: null,          // { N, r, p, salt, hash } — never logged
  secret: null,          // Buffer — never logged
  generatedSecret: false,
  sessionMs: SESSION_DAYS_DEFAULT * 24 * 60 * 60 * 1000,
  sessionDays: SESSION_DAYS_DEFAULT,
  version: '',           // token version; see initAuth
  fatal: '',             // a configuration error that must stop the boot
};

function readSessionDays() {
  const raw = process.env.SZ_SESSION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return SESSION_DAYS_DEFAULT;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return SESSION_DAYS_DEFAULT;
  return Math.min(days, SESSION_DAYS_MAX);
}

/**
 * Read the environment once, at load.
 *
 * A plaintext SZ_PASSWORD is convenient and accepted, but it is hashed here and
 * the variable is then removed from the environment: the process keeps a salted
 * scrypt hash and nothing else, and no child process inherits the plaintext.
 */
function initAuth() {
  const plain = typeof process.env.SZ_PASSWORD === 'string' ? process.env.SZ_PASSWORD : '';
  const encodedEnv = typeof process.env.SZ_PASSWORD_HASH === 'string' ? process.env.SZ_PASSWORD_HASH.trim() : '';

  auth.sessionDays = readSessionDays();
  auth.sessionMs = Math.round(auth.sessionDays * 24 * 60 * 60 * 1000);

  // No hash and an empty or unset password: the gate is off (SPEC 28.1).
  if (!encodedEnv && plain === '') return;

  auth.enabled = true;

  let encoded = '';
  if (encodedEnv) {
    if (!parsePasswordHash(encodedEnv)) {
      // Refusing to boot is the only safe answer. Carrying on with the gate off
      // would silently publish every document; carrying on with the gate on
      // would lock everyone out with no way back in.
      auth.fatal = 'SZ_PASSWORD_HASH 형식이 올바르지 않습니다. scrypt$N$r$p$솔트$해시 형식이어야 합니다.';
      return;
    }
    encoded = encodedEnv;
  } else {
    try {
      encoded = hashPassword(plain);
    } catch (err) {
      auth.fatal = `비밀번호를 처리하지 못했습니다: ${err && err.message}`;
      return;
    }
  }
  // The plaintext is not retained beyond this point.
  delete process.env.SZ_PASSWORD;

  auth.params = parsePasswordHash(encoded);

  const secretEnv = typeof process.env.SZ_SESSION_SECRET === 'string' ? process.env.SZ_SESSION_SECRET : '';
  if (secretEnv.length > 0) {
    auth.secret = Buffer.from(secretEnv, 'utf8');
  } else {
    // A fixed fallback would be the same as having no signing key at all, since
    // anyone could then mint a cookie. A random one costs a logout on restart,
    // and the boot log says so out loud.
    auth.secret = randomBytes(32);
    auth.generatedSecret = true;
  }

  // The token version binds a cookie to the password AND the secret that were in
  // force when it was issued, so rotating either one invalidates every cookie in
  // the wild. It is a one-way digest, so it carries neither back to a client.
  auth.version = createHash('sha256')
    .update(auth.secret)
    .update('sz-token-version')
    .update(encoded, 'utf8')
    .digest('base64url')
    .slice(0, 12);
}

initAuth();

/** Printed once per boot. The OFF case is loud on purpose (SPEC 28.1). */
function logAuthConfig() {
  if (!auth.enabled) {
    console.log('[시트지] 접근 제한이 꺼져 있습니다 — 주소를 아는 사람은 누구나 모든 문서를 읽고 쓸 수 있습니다.');
    console.log('[시트지] 공개된 곳에서 운영한다면 SZ_PASSWORD 또는 SZ_PASSWORD_HASH 환경 변수를 설정하세요.');
    return;
  }
  console.log(`[시트지] 접근 제한이 켜져 있습니다 — 공유 비밀번호 하나로 사이트 전체를 보호합니다 (세션 ${auth.sessionDays}일).`);
  if (auth.generatedSecret) {
    console.warn('[시트지] SZ_SESSION_SECRET이 없어 임시 서명 키를 만들었습니다 — 서버를 다시 시작하면 모두 로그아웃됩니다.');
    console.warn('[시트지] 계속 운영할 서버라면 SZ_SESSION_SECRET에 고정된 임의 문자열을 설정하세요.');
  }
}

// ------------------------------------------------------------------ passwords

const scryptAsync = promisify(scrypt);

/**
 * Constant-time password check.
 *
 * scrypt runs on whatever arrived — including an empty or missing field — so
 * every attempt costs the same work, and the comparison itself is
 * timingSafeEqual. Nothing about the stored password (whether one is set, how
 * long it is, how close the guess was) can be read out of the answer.
 */
async function passwordMatches(input) {
  const cfg = auth.params;
  if (!cfg) return false;
  const candidate = typeof input === 'string' ? input : '';
  let derived;
  try {
    derived = await scryptAsync(Buffer.from(candidate, 'utf8'), cfg.salt, cfg.hash.length, {
      N: cfg.N, r: cfg.r, p: cfg.p, maxmem: scryptMaxmem(cfg.N, cfg.r),
    });
  } catch {
    return false;
  }
  if (derived.length !== cfg.hash.length) return false;
  return timingSafeEqual(derived, cfg.hash);
}

// ------------------------------------------------------------------- sessions

function hmacFor(payloadB64) {
  return createHmac('sha256', auth.secret).update(payloadB64, 'utf8').digest();
}

/** The Set-Cookie header for a fresh session. */
function sessionCookieHeader(req) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + auth.sessionMs, v: auth.version }),
    'utf8',
  ).toString('base64url');
  const token = `${payload}.${hmacFor(payload).toString('base64url')}`;
  return cookieHeader(token, Math.floor(auth.sessionMs / 1000), req);
}

function clearCookieHeader(req) {
  return cookieHeader('', 0, req);
}

function cookieHeader(value, maxAgeSec, req) {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  // Only meaningful over TLS, and actively harmful over plain http — the browser
  // would drop the cookie — so it follows the scheme the request arrived on.
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function isSecureRequest(req) {
  if (!req) return false;
  // express derives req.secure from the trust-proxy setting.
  if (req.secure === true) return true;
  const proto = req.headers ? req.headers['x-forwarded-proto'] : '';
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') return true;
  return !!(req.socket && req.socket.encrypted);
}

/** Read one cookie out of a Cookie header, without a parser dependency. */
function readCookie(header, name) {
  if (typeof header !== 'string' || header.length === 0) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value;
  }
  return '';
}

/** Verify `payloadB64.hmacB64`: signature first, then expiry and token version. */
function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return false;
  if (!auth.secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (sigB64.includes('.')) return false;

  let given;
  try {
    given = Buffer.from(sigB64, 'base64url');
  } catch {
    return false;
  }
  const want = hmacFor(payloadB64);
  if (given.length !== want.length) return false;
  if (!timingSafeEqual(given, want)) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!isPlainObject(payload)) return false;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return false;
  // A password or secret rotation changes the version, which is the only
  // revocation a stateless cookie can have.
  if (payload.v !== auth.version) return false;
  return true;
}

/**
 * The expiry of a request's session, or null when it has none (or the gate is off).
 *
 * The HTTP gate only ever needs a yes/no, but a WebSocket is different: it is checked
 * once at the handshake and then stays open for as long as the tab does. Without the
 * expiry, a socket opened a minute before the cookie ran out would keep full read and
 * write access to every document indefinitely — the session lifetime would apply to
 * page loads and to nothing else.
 */
function sessionExpiryOf(req) {
  if (!auth.enabled) return null;
  if (!req || !req.headers) return null;
  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  if (!verifySessionToken(token)) return null;
  try {
    const payloadB64 = token.slice(0, token.indexOf('.'));
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True when this request may proceed. Used by BOTH the HTTP gate and /ws. */
function requestIsAuthorized(req) {
  if (!auth.enabled) return true;
  if (!req || !req.headers) return false;
  return verifySessionToken(readCookie(req.headers.cookie, COOKIE_NAME));
}

// --------------------------------------------------------------- rate limiting

/** address -> { count, first } inside the current window. */
const loginFailures = new Map();

/**
 * The address to hold responsible.
 *
 * With `trust proxy` set to one hop, the entry to believe is the LAST one in
 * X-Forwarded-For: every proxy appends the peer it actually saw, so the final
 * entry was written by the proxy in front of us and cannot be forged. Whatever
 * the client itself put in that header sits to the left of it and is ignored.
 */
function clientIpOf(req) {
  const direct = req && req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : '';
  const header = req && req.headers ? req.headers['x-forwarded-for'] : '';
  if (typeof header === 'string' && header.length > 0) {
    const hops = header.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return direct || 'unknown';
}

function pruneLoginFailures(now) {
  for (const [ip, rec] of loginFailures) {
    if (now - rec.first >= LOGIN_WINDOW_MS) loginFailures.delete(ip);
  }
}

/** Seconds this address must wait, or 0 when it may try. */
function loginRetryAfter(ip, now = Date.now()) {
  const rec = loginFailures.get(ip);
  if (!rec) return 0;
  if (now - rec.first >= LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
    return 0;
  }
  if (rec.count < MAX_LOGIN_ATTEMPTS) return 0;
  return Math.max(1, Math.ceil((rec.first + LOGIN_WINDOW_MS - now) / 1000));
}

function recordLoginFailure(ip, now = Date.now()) {
  let rec = loginFailures.get(ip);
  if (!rec || now - rec.first >= LOGIN_WINDOW_MS) {
    rec = { count: 0, first: now };
    loginFailures.set(ip, rec);
  }
  rec.count += 1;
  if (loginFailures.size > MAX_LOGIN_IPS) {
    pruneLoginFailures(now);
    // Still full: drop the least recently created entries rather than let an
    // address-rotating attacker grow the table forever.
    while (loginFailures.size > MAX_LOGIN_IPS) {
      const oldest = loginFailures.keys().next().value;
      if (oldest === undefined || oldest === ip) break;
      loginFailures.delete(oldest);
    }
  }
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

// ------------------------------------------------------------- redirect target

/**
 * `next` is only ever a path on this site.
 *
 * A login form that redirects anywhere is an open redirect: a link to our own
 * login page could then land the visitor on someone else's site. Only a single
 * leading '/' followed by something that is not '/' or '\' is accepted, which
 * rules out '//other.example' and '/\other.example' as well as any absolute URL.
 */
function safeNextPath(value) {
  if (typeof value !== 'string') return '/';
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_NEXT_LEN) return '/';
  if (text[0] !== '/') return '/';
  if (text.length > 1 && (text[1] === '/' || text[1] === '\\')) return '/';
  // Control characters (a bare CR or LF above all) would let the value be
  // smuggled into the Location header; nothing legitimate contains one.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  // Never bounce a freshly logged-in visitor back to the login page.
  if (text === '/login' || text.startsWith('/login?') || text.startsWith('/login#')) return '/';
  return text;
}

/** The path (with query) an unauthenticated visitor was trying to reach. */
function requestedTarget(req) {
  const raw = typeof req.originalUrl === 'string' ? req.originalUrl : req.url;
  return safeNextPath(typeof raw === 'string' ? raw : '/');
}

function wantsHtml(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const accept = req.headers && typeof req.headers.accept === 'string' ? req.headers.accept : '';
  return accept.includes('text/html');
}

/**
 * The gate itself. Registered before express.static, so it covers the pages, the
 * client modules and the API alike.
 */
function httpGate(req, res, next) {
  if (!auth.enabled) {
    next();
    return;
  }
  let path = typeof req.path === 'string' ? req.path : '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (OPEN_PATHS.has(path)) {
    next();
    return;
  }
  if (requestIsAuthorized(req)) {
    next();
    return;
  }
  // An API caller gets a machine-readable refusal so the client can send the
  // user to the login page itself; a browser navigation gets the page.
  if (path === '/api' || path.startsWith('/api/') || !wantsHtml(req)) {
    res.status(401).json({ error: 'auth_required', message: '로그인이 필요합니다.' });
    return;
  }
  res.redirect(302, `/login?next=${encodeURIComponent(requestedTarget(req))}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// One reverse proxy in front of us is how every host runs this, and it is what makes
// req.secure (the cookie's Secure flag) and the client address correct instead of
// reporting the proxy for everyone.
app.set('trust proxy', 1);

// The gate goes FIRST — before the body parser and before express.static — so an
// unauthenticated visitor cannot fetch the editor, the document list, the client
// modules or the shared engine, let alone the API, and their request body is never
// even parsed. SPEC 28.3.
app.use(httpGate);

app.use(express.json({ limit: '512kb' }));

// The login page itself. It is in OPEN_PATHS, so it is reachable without a session;
// with the gate off it still renders, and any password it posts is accepted.
app.get('/login', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'login.html'));
});

// POST /api/login { password, next } -> sets the session cookie.
//
// The rate-limit check runs BEFORE the hash, so a blocked address costs nothing to
// refuse; every other outcome costs exactly one scrypt, whatever was sent.
app.post('/api/login', async (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {};
  const next = safeNextPath(body.next);

  if (!auth.enabled) {
    // Nothing to unlock. Answer as if it worked so the page is never a dead end.
    res.json({ ok: true, next });
    return;
  }

  const ip = clientIpOf(req);
  const retryAfter = loginRetryAfter(ip);
  if (retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'too_many_attempts',
      message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    });
    return;
  }

  const ok = await passwordMatches(body.password);
  if (!ok) {
    recordLoginFailure(ip);
    // One refusal for every reason: no password field, wrong password, whatever.
    res.status(401).json({ error: 'invalid_password', message: '비밀번호가 올바르지 않습니다.' });
    return;
  }

  clearLoginFailures(ip);
  res.setHeader('Set-Cookie', sessionCookieHeader(req));
  res.json({ ok: true, next });
});

// POST /api/logout — clears the cookie. Open without a session on purpose: logging
// out of an expired session must not itself require being logged in.
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearCookieHeader(req));
  res.json({ ok: true });
});

// The app's own code must never be served from a stale cache. A browser holding an
// old main.js reports every fixed bug as still broken, and the JSON documents are live
// state that must never be cached at all. `etag` still makes a revalidation cheap: an
// unchanged file comes back as a 304 with no body.
const noStore = (res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
};
app.use(express.static(PUBLIC_DIR, { index: false, etag: true, lastModified: true, setHeaders: noStore }));
app.use('/shared', express.static(SHARED_DIR, { etag: true, lastModified: true, setHeaders: noStore }));

// The site root is the document list; the editor lives at /edit. Both are registered
// here rather than left to the static middleware's automatic index.html so the mapping
// is explicit. Links of the older form '/#doc=<id>' still work: the hash never reaches
// the server, so home.js redirects them to /edit on the client.
app.get('/', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'home.html'));
});

app.get('/edit', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, build: BUILD_ID });
});

// Lets anyone check, from a browser console or curl, which client code this server is
// actually serving. `auth` tells the client whether the gate is on, which is the only
// way it can know whether to show a 로그아웃 button (SPEC 28.5).
app.get('/api/version', (req, res) => {
  res.json({ build: BUILD_ID, auth: auth.enabled });
});

// Resolve :id defensively — validated against the id pattern before any path join.
function resolveDoc(req, res) {
  const id = req.params.id;
  if (typeof id !== 'string' || !DOC_ID_RE.test(id)) {
    res.status(400).json({ error: 'bad_id', message: '문서 아이디가 올바르지 않습니다.' });
    return null;
  }
  // Tested BEFORE the lookup, because a quarantined document is deliberately absent from
  // `docs` and a 404 would say "no such document" — which reads as "make another one", on
  // top of a file this process never read (SPEC 27.6). 503 says the opposite and the true
  // thing: it is there, it is intact, come back after a restart.
  if (unreadableDocs.has(id)) {
    res.status(503).json(unreadablePayload(id));
    return null;
  }
  const doc = docs.get(id);
  if (!doc) {
    res.status(404).json({ error: 'not_found', message: '문서를 찾을 수 없습니다.' });
    return null;
  }
  return doc;
}

app.get('/api/docs', (req, res) => {
  const list = [...docs.values()].map((doc) => {
    const entry = {
      id: doc.id,
      name: doc.name,
      updatedAt: doc.updatedAt,
      rev: doc.rev,
      // The list page shows "시트 N장" without having to fetch every document.
      sheetCount: Array.isArray(doc.sheets) ? doc.sheets.length : 1,
    };
    // Quarantined after boot, so its name and shape are known even though it can no
    // longer be opened (SPEC 27.6).
    if (unreadableDocs.has(doc.id)) entry.unreadable = true;
    return entry;
  });
  // Quarantined AT boot: never loaded, so nothing about it is known but its id. It is
  // listed all the same. Leaving it out would tell somebody their spreadsheet is gone,
  // which is false and is the fastest possible way to get a replacement created in its
  // place; the flag lets the page say the true thing instead.
  for (const id of unreadableDocs.keys()) {
    if (docs.has(id)) continue;
    list.push({ id, name: UNREADABLE_DOC_NAME, updatedAt: 0, rev: 0, sheetCount: 0, unreadable: true });
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

app.post('/api/docs', async (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {};
  let id = newId(Date.now());
  // A quarantined document is not in `docs`, so `docs.has` alone would let a new document
  // be minted onto the id of one this process could not read — a brand-new empty
  // spreadsheet sitting on top of somebody's data (SPEC 27.6).
  while (docs.has(id) || unreadableDocs.has(id)) id = newId(Date.now());
  // emptyDoc gives the document exactly one sheet.
  const doc = emptyDoc(id, typeof body.name === 'string' ? body.name : undefined);
  docs.set(doc.id, doc);
  // Journal the creation before the snapshot is even scheduled, so a brand-new document
  // can never exist only in memory: if the process dies before the first compaction, boot
  // finds a journal with no snapshot and rebuilds the document from this record.
  await journalAppend(doc.id, { t: 'doc', doc, rev: doc.rev, at: doc.updatedAt });
  saveNow(doc.id);
  res.status(201).json(doc);
});

app.get('/api/docs/:id', (req, res) => {
  const doc = resolveDoc(req, res);
  if (!doc) return;
  res.json(doc);
});

app.patch('/api/docs/:id', async (req, res) => {
  const doc = resolveDoc(req, res);
  if (!doc) return;
  const body = isPlainObject(req.body) ? req.body : {};
  if (typeof body.name !== 'string') {
    res.status(400).json({ error: 'bad_request', message: '문서 이름이 필요합니다.' });
    return;
  }
  const applied = applyDocMetaPatch(doc, { name: body.name });
  if (applied) {
    const rev = touchDoc(doc);
    // Journaled and awaited before the 200: a rename that answered "ok" has reached the
    // operating system, exactly like an acknowledged socket frame.
    const saved = await journalAppend(doc.id, { t: 'docmeta', patch: applied, rev, at: doc.updatedAt });
    if (!saved) {
      // Answering 200 here would be the same lie the save indicator is forbidden to
      // tell: the caller would believe the rename is on disk when it is not.
      res.status(500).json({
        error: 'write_failed',
        message: '변경 내용을 디스크에 기록하지 못했습니다.',
      });
      return;
    }
    broadcast(doc.id, { t: 'docmeta', patch: applied, rev, by: null });
  }
  res.json({ ok: true });
});

app.delete('/api/docs/:id', async (req, res) => {
  const doc = resolveDoc(req, res);
  if (!doc) return;
  const id = doc.id;
  const timer = saveTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(id);
  }
  docs.delete(id);
  forgetDocOps(id);   // its accepted-op window has nothing left to protect
  // Let whatever is already queued finish against a document that no longer exists (every
  // task re-reads `docs`, so a pending compaction becomes a no-op) before the store is
  // asked to remove what it holds.
  const pending = opChains.get(id);
  if (pending) {
    try {
      await pending;
    } catch {
      /* already logged by the task that failed */
    }
  }
  opChains.delete(id);

  // Tell anyone still connected, then drop the room.
  broadcast(id, { t: 'error', message: '이 문서는 삭제되었습니다.' });
  const room = rooms.get(id);
  if (room) {
    for (const client of [...room]) {
      try {
        client.close(1000, 'document deleted');
      } catch {
        /* ignore */
      }
    }
    rooms.delete(id);
  }

  // The snapshot, the journal and every backup. Leaving the journal behind would
  // resurrect the document on the next boot, which is the opposite of what DELETE
  // promised.
  try {
    await storage.deleteDoc(id);
  } catch (err) {
    console.warn(`[시트지] 문서 파일 삭제 실패 (${id}): ${err && err.message}`);
  }
  res.json({ ok: true });
});

// GET /api/docs/:id/csv?sheet=<sheetId> — that sheet; without the parameter, the first
// sheet. A sheet id the document does not have is a 404, never a silent fallback.
app.get('/api/docs/:id/csv', (req, res) => {
  const doc = resolveDoc(req, res);
  if (!doc) return;

  const wanted = req.query ? req.query.sheet : undefined;
  let sheet;
  if (wanted === undefined || wanted === '') {
    sheet = doc.sheets[0];
  } else if (typeof wanted !== 'string') {
    sheet = null;
  } else {
    sheet = findSheet(doc, wanted);
  }
  if (!sheet) {
    res.status(404).json({ error: 'sheet_not_found', message: '시트를 찾을 수 없습니다.' });
    return;
  }

  let csv;
  try {
    csv = sheetToCsv(sheet);
  } catch (err) {
    console.error(`[시트지] CSV 생성 실패 (${doc.id}): ${err && err.message}`);
    res.status(500).json({ error: 'csv_failed', message: 'CSV를 만들지 못했습니다.' });
    return;
  }
  // A single-sheet document keeps exactly the file name it had before sheets existed.
  const label = doc.sheets.length > 1 ? `${doc.name} - ${sheet.name}` : doc.name;
  const asciiName = `${doc.id}.csv`;
  const utf8Name = encodeURIComponent(`${label}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`);
  res.send(csv);
});

// GET /api/docs/:id/backups — what SPEC 27.2 kept, newest first. <id>.bak.1 is the
// snapshot the most recent save replaced, so a regretted bulk edit or a corrupt write is
// recoverable by hand: the list says what exists, when it was written and how big it is.
app.get('/api/docs/:id/backups', async (req, res) => {
  const doc = resolveDoc(req, res);
  if (!doc) return;
  let backups;
  try {
    backups = await storage.listBackups(doc.id);
  } catch (err) {
    console.warn(`[시트지] 백업 목록을 읽지 못했습니다 (${doc.id}): ${err && err.message}`);
    res.status(500).json({ error: 'backup_list_failed', message: '백업 목록을 읽지 못했습니다.' });
    return;
  }
  res.json(Array.isArray(backups) ? backups : []);
});

// Graceful 404 for anything else under /api.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: '요청한 API 경로가 없습니다.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  console.error(`[시트지] 요청 처리 오류: ${err && err.message}`);
  res.status(status).json({ error: 'server_error', message: '요청을 처리하지 못했습니다.' });
});

// ---------------------------------------------------------------------------
// WebSocket collaboration
// ---------------------------------------------------------------------------

const server = createServer(app);
// `noServer` rather than `{ server }` on purpose: the upgrade is handled below so the
// session can be checked BEFORE the handshake completes. Letting ws attach its own
// upgrade listener would leave /ws — which reads and writes every document in the
// system — open to anyone who knows the address (SPEC 28.3).
const wss = new WebSocketServer({ noServer: true, path: '/ws', maxPayload: MAX_FRAME_BYTES });

/** Refuse an upgrade without completing it: one status line, then the socket is gone. */
function abortUpgrade(socket, status, reason) {
  try {
    if (socket.writable) {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  } catch {
    /* the peer is already gone */
  }
  try {
    socket.destroy();
  } catch {
    /* already destroyed */
  }
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    // The base is only there to make the parser accept a path-only URL.
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    pathname = '';
  }
  if (pathname !== '/ws') {
    abortUpgrade(socket, 400, 'Bad Request');
    return;
  }
  // The cookie travels on the handshake like any other request header, so the same
  // check the HTTP gate uses answers this one.
  if (!requestIsAuthorized(req)) {
    abortUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Carried on the socket so the heartbeat can retire it when the session runs out.
    ws.sessionExp = sessionExpiryOf(req);
    wss.emit('connection', ws, req);
  });
});

/** @type {Map<string, Set<WebSocket>>} docId -> sockets */
const rooms = new Map();

function roomFor(docId) {
  let room = rooms.get(docId);
  if (!room) {
    room = new Set();
    rooms.set(docId, room);
  }
  return room;
}

function send(ws, msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.warn(`[시트지] 전송 실패: ${err && err.message}`);
  }
}

function broadcast(docId, msg, except) {
  const room = rooms.get(docId);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const client of room) {
    if (client === except) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(payload);
    } catch (err) {
      console.warn(`[시트지] 브로드캐스트 실패: ${err && err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// acknowledgement (SPEC 27.3)
//
// A frame may carry a client-generated `opId`. It is opaque — the server never parses it,
// never stores it and never compares two of them — so the only thing worth checking is
// that it is a short string, which keeps a hostile client from making every reply carry a
// megabyte back.
//
// An ack means THIS IS ON DISK, not "received". That distinction is the whole point of the
// change: it is what lets a client keep an edit in its outbox until it is genuinely safe,
// and what lets the save indicator tell the truth instead of guessing. So an ack is only
// ever sent after the operation's journal line reached the operating system, and never on
// the strength of having merely applied it in memory.
// ---------------------------------------------------------------------------

/**
 * Operations already accepted, per document: opId -> the rev it produced.
 *
 * A client replays its outbox after every reconnect, because an operation whose ack was
 * lost is indistinguishable from one that never arrived. For a cell write that is
 * harmless — last-write-wins makes it idempotent. For everything else it is not: a
 * replayed comment posts twice, a replayed insertRow moves the sheet twice, a replayed
 * sheet-add makes a second sheet. So the server remembers what it has already done and
 * answers a repeat with the SAME ack instead of applying it again.
 *
 * Bounded per document; the oldest entries fall off first. The window only has to
 * outlive a reconnect, not the process.
 */
const acceptedOps = new Map();          // docId -> Map<opId, rev>
const MAX_ACCEPTED_OPS = 5000;

function acceptedFor(docId) {
  let m = acceptedOps.get(docId);
  if (!m) {
    m = new Map();
    acceptedOps.set(docId, m);
  }
  return m;
}

/** The rev this opId already produced, or undefined when it is new. */
function alreadyAccepted(docId, opId) {
  if (!opId) return undefined;
  const m = acceptedOps.get(docId);
  return m ? m.get(opId) : undefined;
}

function rememberAccepted(docId, opId, rev) {
  if (!opId) return;
  const m = acceptedFor(docId);
  // Re-insert so the iteration order is least-recently-accepted first.
  m.delete(opId);
  m.set(opId, rev);
  while (m.size > MAX_ACCEPTED_OPS) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
}

function forgetDocOps(docId) {
  acceptedOps.delete(docId);
}

/**
 * Has this exact operation already been applied? If so, re-acknowledge it and tell the
 * caller to stop. Call it FIRST in every handler that mutates the document.
 */
function replayGuard(ws, docId, msg) {
  const opId = opIdOf(msg);
  if (!opId) return false;
  const rev = alreadyAccepted(docId, opId);
  if (rev === undefined) return false;
  send(ws, { t: 'ack', opId, rev });
  return true;
}

function opIdOf(msg) {
  const opId = msg && msg.opId;
  return typeof opId === 'string' && opId && opId.length <= MAX_OP_ID_LEN ? opId : null;
}

/**
 * Acknowledge an operation whose journal line was (or was not) written.
 *
 * A failed append is answered with an error carrying the same `opId`, never with silence:
 * the frame is still in the sender's outbox, and the sender needs to know it is not safe.
 */
function ackIfSaved(ws, msg, saved, rev) {
  const opId = opIdOf(msg);
  if (!opId) return;
  if (saved) {
    // Remembered before the ack goes out: if the ack is lost the client WILL replay, and
    // the record is what stops the second application.
    rememberAccepted(docIdOf(msg, ws), opId, rev);
    send(ws, { t: 'ack', opId, rev });
  } else {
    // `retry: true` marks the one refusal that is worth sending again — the disk write
    // failed, the operation is still valid. Every other error is permanent, and the
    // client drops those frames instead of retrying them for ever.
    send(ws, { t: 'error', opId, retry: true, message: '변경 내용을 디스크에 기록하지 못했습니다.' });
  }
}

/** The document a frame belongs to, falling back to the socket's seat. */
function docIdOf(msg, ws) {
  if (msg && typeof msg.docId === 'string' && msg.docId) return msg.docId;
  return ws && ws.peer ? ws.peer.docId : '';
}

/**
 * Acknowledge a frame that was accepted but changed nothing — a patch whose every cell was
 * unusable, a rename to the identical name, a resolve on an already-resolved thread.
 *
 * Nothing was journaled because there is nothing to lose, and that is exactly why the ack
 * is honest: the operation is finished. Withholding it would strand the frame in the
 * sender's outbox for ever and leave the save indicator reading 저장 중… with nothing left
 * to save.
 */
function ackNoop(ws, msg, rev) {
  const noopId = opIdOf(msg);
  if (noopId) rememberAccepted(docIdOf(msg, ws), noopId, rev);
  const opId = opIdOf(msg);
  if (opId) send(ws, { t: 'ack', opId, rev });
}

// A refusal echoes the `opId` when the frame carried one, so the sender can drop a frame
// this server will never accept instead of retrying it for ever.
function sendError(ws, msg, message) {
  const opId = opIdOf(msg);
  send(ws, opId ? { t: 'error', opId, message } : { t: 'error', message });
}

/**
 * The refusal a quarantined document answers with (SPEC 27.6).
 *
 * `retry: true` is the load-bearing field and it is not optional. Without it the client
 * DROPS the frame from its outbox — that is what a permanent refusal means there, and it
 * is right for a frame naming a deleted sheet or a malformed payload. This refusal is the
 * opposite: the edit is perfectly valid and simply has nowhere durable to go until the
 * server restarts, so the client must keep holding it (SPEC 27.4). Answering without
 * `retry` would make the guard against losing acknowledged work the cause of losing
 * unacknowledged work.
 *
 * `code` lets the client show the explanation once and stop, instead of one toast per
 * replayed frame; a client that does not know the code still shows `message`, which is
 * written to stand on its own.
 */
function unreadableFrame(id, opId) {
  const frame = {
    t: 'error',
    code: 'doc_unreadable',
    docId: id,
    retry: true,
    message: UNREADABLE_TITLE,
    steps: UNREADABLE_STEPS.slice(),
  };
  if (opId) frame.opId = opId;
  return frame;
}

/**
 * Tell everyone sitting in a document that has just been quarantined mid-session.
 *
 * Their sockets are left OPEN. Closing them would start the reconnect ladder, and each
 * reconnect would re-send the same outbox to be refused again; the client stops itself
 * when it sees the code, and its unsent work stays where it is safe.
 */
function notifyUnreadable(id) {
  broadcast(id, unreadableFrame(id));
}

function peerList(docId) {
  const room = rooms.get(docId);
  if (!room) return [];
  const peers = [];
  for (const client of room) {
    if (!client.peer) continue;
    peers.push({
      id: client.peer.id,
      name: client.peer.name,
      color: client.peer.color,
      sheetId: client.peer.sheetId,
      active: client.peer.active,
      range: client.peer.range,
    });
  }
  return peers;
}

function makePeerId(room) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = newId(Date.now()).slice(0, 6);
    let taken = false;
    for (const client of room) {
      if (client.peer && client.peer.id === id) {
        taken = true;
        break;
      }
    }
    if (!taken) return id;
  }
  return newId(Date.now());
}

function sanitizePeerName(name) {
  if (typeof name !== 'string') return '익명 사용자';
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
  }
  const trimmed = out.trim().slice(0, 40);
  return trimmed || '익명 사용자';
}

function sanitizeHexColor(color) {
  if (typeof color !== 'string') return null;
  const value = color.trim().toLowerCase();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value)) return null;
  if (value.length === 4) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return value;
}

function pickColor(room) {
  const used = new Set();
  for (const client of room) {
    if (client.peer) used.add(client.peer.color);
  }
  for (const color of PEER_COLORS) {
    if (!used.has(color)) return color;
  }
  return PEER_COLORS[used.size % PEER_COLORS.length];
}

function sanitizeSelectionRange(range, sheet) {
  if (!isPlainObject(range) || !isPlainObject(range.s) || !isPlainObject(range.e)) return null;
  const maxRow = Math.max(0, sheet.rows - 1);
  const maxCol = Math.max(0, sheet.cols - 1);
  const sRow = clampInt(range.s.row, 0, maxRow, null);
  const sCol = clampInt(range.s.col, 0, maxCol, null);
  const eRow = clampInt(range.e.row, 0, maxRow, null);
  const eCol = clampInt(range.e.col, 0, maxCol, null);
  if (sRow === null || sCol === null || eRow === null || eCol === null) return null;
  return { s: { row: sRow, col: sCol }, e: { row: eRow, col: eCol } };
}

function leaveRoom(ws) {
  const peer = ws.peer;
  if (!peer) return;
  const room = rooms.get(peer.docId);
  ws.peer = null;
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(peer.docId);
    return;
  }
  broadcast(peer.docId, { t: 'peers', peers: peerList(peer.docId) });
}

// After a sheet disappears, every peer that was looking at it is moved to the first
// remaining tab so the peers payload can never name a sheet the document does not have.
function repointPeersAfterDelete(doc) {
  if (!doc) return;
  const room = rooms.get(doc.id);
  if (!room) return;
  const fallback = firstSheetId(doc);
  let changed = false;
  for (const client of room) {
    const peer = client.peer;
    if (!peer) continue;
    if (findSheet(doc, peer.sheetId)) continue;
    peer.sheetId = fallback;
    peer.active = null;
    peer.range = null;
    changed = true;
  }
  if (changed) broadcast(doc.id, { t: 'peers', peers: peerList(doc.id) });
}

// Resolve the document a client message targets; replies with an error when it cannot.
function docForMessage(ws, msg) {
  if (!ws.peer) {
    sendError(ws, msg, '먼저 문서에 접속해야 합니다.');
    return null;
  }
  if (typeof msg.docId === 'string' && msg.docId !== ws.peer.docId) {
    sendError(ws, msg, '다른 문서로는 편집을 보낼 수 없습니다.');
    return null;
  }
  // A document quarantined after this socket took its seat (SPEC 27.6). handleHello
  // refuses to seat anyone on an already-quarantined document, so this closes the only
  // remaining way in — and it closes it for EVERY mutating frame at once, because every
  // one of them resolves its document through here.
  if (unreadableDocs.has(ws.peer.docId)) {
    send(ws, unreadableFrame(ws.peer.docId, opIdOf(msg)));
    return null;
  }
  const doc = docs.get(ws.peer.docId);
  if (!doc) {
    sendError(ws, msg, '문서를 찾을 수 없습니다.');
    return null;
  }
  return doc;
}

// Resolve the sheet a frame names. An unknown id is an error and applies NOWHERE —
// silently falling back to another sheet would write a user's data into the wrong tab.
function sheetForMessage(ws, doc, msg) {
  const sheet = findSheet(doc, msg && msg.sheetId);
  if (!sheet) {
    sendError(ws, msg, '시트를 찾을 수 없습니다.');
    return null;
  }
  return sheet;
}

function handleHello(ws, msg) {
  const docId = typeof msg.docId === 'string' ? msg.docId : '';
  if (!DOC_ID_RE.test(docId)) {
    send(ws, { t: 'error', message: '문서를 찾을 수 없습니다.' });
    return;
  }
  // Before the `docs` lookup, for the reason the HTTP route checks first: a quarantined
  // document is not in `docs`, and 문서를 찾을 수 없습니다 would send this person off to
  // create a new one on top of it (SPEC 27.6). No seat is taken and no room is joined, so
  // no frame from this socket — including an outbox this client is about to replay — can
  // reach the document at all.
  if (unreadableDocs.has(docId)) {
    if (ws.peer) leaveRoom(ws);
    send(ws, unreadableFrame(docId));
    return;
  }
  if (!docs.has(docId)) {
    send(ws, { t: 'error', message: '문서를 찾을 수 없습니다.' });
    return;
  }
  if (ws.peer) leaveRoom(ws); // re-hello on the same socket (reconnect / doc switch)

  const doc = docs.get(docId);
  const room = roomFor(docId);
  ws.peer = {
    id: makePeerId(room),
    name: sanitizePeerName(msg.name),
    color: sanitizeHexColor(msg.color) || pickColor(room),
    docId,
    // A joiner starts on the first tab; the client's first cursor frame says where it
    // actually is (the URL hash may point at another sheet).
    sheetId: firstSheetId(doc),
    active: null,
    range: null,
  };
  room.add(ws);

  send(ws, {
    t: 'welcome',
    build: BUILD_ID,
    you: { id: ws.peer.id, name: ws.peer.name, color: ws.peer.color },
    doc,
    peers: peerList(docId),
  });
  broadcast(docId, { t: 'peers', peers: peerList(docId) });
}

async function handleEdit(ws, msg) {
  // Exactly-once. A client replays its outbox after a reconnect because a lost ack is
  // indistinguishable from a lost frame; without this, the replay would apply the
  // operation a second time. Cell writes survive that, but a comment, a structural edit
  // and a sheet op do not.
  if (replayGuard(ws, docIdOf(msg, ws), msg)) return;
  const doc = docForMessage(ws, msg);
  if (!doc) return;
  // Captured before the first await: a socket that closes mid-journal has its peer record
  // torn down by leaveRoom, and the broadcast still has to name who made the edit.
  const by = ws.peer.id;
  const sheet = sheetForMessage(ws, doc, msg);
  if (!sheet) return;
  if (!isPlainObject(msg.cells)) {
    sendError(ws, msg, '편집 내용이 올바르지 않습니다.');
    return;
  }
  const keys = Object.keys(msg.cells);
  if (keys.length > MAX_CELLS_PER_EDIT) {
    sendError(ws, msg, `한 번에 편집할 수 있는 셀은 ${MAX_CELLS_PER_EDIT}개까지입니다.`);
    return;
  }
  const applied = applyCellsPatch(sheet, msg.cells);
  if (!Object.keys(applied).length) {
    ackNoop(ws, msg, doc.rev);
    return;
  }
  const rev = touchDoc(doc);
  // Journaled BEFORE the broadcast (SPEC 27.1), and journaled AS RECEIVED rather than as
  // broadcast. The broadcast carries each touched cell's whole resulting style, so it
  // cannot express a style key this edit REMOVED — replaying it would resurrect one. The
  // frame as it arrived replays through applyCellsPatch, the same function, against the
  // same prior state, and reproduces the edit exactly.
  const saved = await journalAppend(doc.id, {
    t: 'edit', sheetId: sheet.id, cells: msg.cells, rev, at: doc.updatedAt,
  });
  // Idempotent: everyone, including the sender, receives the same patch.
  broadcast(doc.id, { t: 'edit', sheetId: sheet.id, cells: applied, rev, by });
  ackIfSaved(ws, msg, saved, rev);
}

async function handleStruct(ws, msg) {
  // Exactly-once. A client replays its outbox after a reconnect because a lost ack is
  // indistinguishable from a lost frame; without this, the replay would apply the
  // operation a second time. Cell writes survive that, but a comment, a structural edit
  // and a sheet op do not.
  if (replayGuard(ws, docIdOf(msg, ws), msg)) return;
  const doc = docForMessage(ws, msg);
  if (!doc) return;
  const by = ws.peer.id;
  const sheet = sheetForMessage(ws, doc, msg);
  if (!sheet) return;
  const edit = normalizeStructEdit(msg.edit, sheet);
  if (!edit) {
    sendError(ws, msg, '행/열 편집 요청이 올바르지 않습니다.');
    return;
  }
  try {
    applyStructEdit(sheet, edit);
  } catch (err) {
    console.error(`[시트지] 구조 편집 실패 (${doc.id}/${sheet.id}): ${err && err.message}`);
    sendError(ws, msg, '행/열 편집을 적용하지 못했습니다.');
    return;
  }
  const rev = touchDoc(doc);
  // The normalised edit, not the whole document: replaying it runs applyStructEdit against
  // the same prior state and produces the same result, for a fraction of the bytes. Doing
  // it twice would insert two rows, which is why replay skips records the snapshot already
  // contains rather than trusting them to be idempotent.
  const saved = await journalAppend(doc.id, {
    t: 'struct', sheetId: sheet.id, edit, rev, at: doc.updatedAt,
  });
  broadcast(doc.id, { t: 'struct', sheetId: sheet.id, edit, doc, rev, by });
  ackIfSaved(ws, msg, saved, rev);
}

async function handleMeta(ws, msg) {
  // Exactly-once. A client replays its outbox after a reconnect because a lost ack is
  // indistinguishable from a lost frame; without this, the replay would apply the
  // operation a second time. Cell writes survive that, but a comment, a structural edit
  // and a sheet op do not.
  if (replayGuard(ws, docIdOf(msg, ws), msg)) return;
  const doc = docForMessage(ws, msg);
  if (!doc) return;
  const by = ws.peer.id;
  const sheet = sheetForMessage(ws, doc, msg);
  if (!sheet) return;
  const refusal = metaPatchRefusal(msg.patch);
  if (refusal) {
    sendError(ws, msg, refusal);
    return;
  }
  const applied = applySheetMetaPatch(sheet, msg.patch);
  if (!applied) {
    sendError(ws, msg, '시트 설정 변경 내용이 올바르지 않습니다.');
    return;
  }
  const rev = touchDoc(doc);
  // As received, for the same reason as an edit: the broadcast carries the FULL resulting
  // colWidths / rowHeights maps, so replaying it could not express a width this patch
  // deleted. The frame itself replays through applySheetMetaPatch and reproduces it.
  const saved = await journalAppend(doc.id, {
    t: 'meta', sheetId: sheet.id, patch: msg.patch, rev, at: doc.updatedAt,
  });
  broadcast(doc.id, { t: 'meta', sheetId: sheet.id, patch: applied, rev, by });
  ackIfSaved(ws, msg, saved, rev);
}

// { t:'comment', docId, sheetId, op, cell, threadId?, messageId?, text? }  (SPEC 24.3)
//
// Answers with { t:'comments', sheetId, comments, rev, by } — the sheet's whole thread map,
// the way a sheet op resends the whole document. Threads are few and small, and a full
// resend removes every chance of a client holding a thread list the server does not have.
async function handleComment(ws, msg) {
  // Exactly-once. A client replays its outbox after a reconnect because a lost ack is
  // indistinguishable from a lost frame; without this, the replay would apply the
  // operation a second time. Cell writes survive that, but a comment, a structural edit
  // and a sheet op do not.
  if (replayGuard(ws, docIdOf(msg, ws), msg)) return;
  const doc = docForMessage(ws, msg);
  if (!doc) return;
  const by = ws.peer.id;
  const sheet = sheetForMessage(ws, doc, msg);
  if (!sheet) return;

  const op = typeof msg.op === 'string' ? msg.op : '';
  if (!COMMENT_OPS.has(op)) {
    sendError(ws, msg, '알 수 없는 댓글 작업입니다.');
    return;
  }

  // A `cell` that is not a valid A1 inside this sheet is refused outright rather than
  // ignored: a thread keyed by something else could never be found again, and the sender
  // has to learn that its panel is pointing at nothing. Only 'add' REQUIRES a cell — the
  // other ops carry it for context and are resolved by `threadId`.
  let cellKey = null;
  if (msg.cell !== undefined && msg.cell !== null) {
    const pos = parseCellKey(msg.cell);
    if (!pos || pos.row >= sheet.rows || pos.col >= sheet.cols) {
      sendError(ws, msg, '댓글을 달 셀이 올바르지 않습니다.');
      return;
    }
    cellKey = pos.key;
  }
  if (op === 'add' && !cellKey) {
    sendError(ws, msg, '댓글을 달 셀이 올바르지 않습니다.');
    return;
  }

  const threadId = typeof msg.threadId === 'string' && msg.threadId ? msg.threadId : null;
  const messageId = typeof msg.messageId === 'string' && msg.messageId ? msg.messageId : null;
  if ((op === 'reply' || op === 'resolve' || op === 'reopen') && !threadId && !cellKey) {
    sendError(ws, msg, '댓글 스레드를 찾을 수 없습니다.');
    return;
  }

  let text = '';
  if (op === 'add' || op === 'reply') {
    if (typeof msg.text !== 'string' || !msg.text.trim()) {
      sendError(ws, msg, '댓글 내용을 입력해 주세요.');
      return;
    }
    // Over-long text is REFUSED, not truncated: silently storing the first 4000 code
    // points of a longer message would tell the author their whole comment posted.
    if (msg.text.length > MAX_COMMENT_LEN && codePointCount(msg.text, MAX_COMMENT_LEN) > MAX_COMMENT_LEN) {
      sendError(ws, msg, `댓글은 ${MAX_COMMENT_LEN}자까지 쓸 수 있습니다.`);
      return;
    }
    text = msg.text;
  }

  const comments = isPlainObject(sheet.comments) ? sheet.comments : {};
  const plan = planCommentOp(comments, op, {
    cellKey,
    threadId,
    messageId,
    text,
    // Server-stamped, always. `msg.author`, `msg.authorId` and `msg.at` are not read
    // anywhere in this file: the identity of a comment comes from the peer record this
    // socket was given at hello time, and its time from this process's clock.
    author: ws.peer.name,
    authorId: ws.peer.id,
    at: Date.now(),
  });

  if (plan.error) {
    sendError(ws, msg, plan.error);
    return;
  }
  if (plan.unchanged) {
    // Already resolved / already open. Nothing to store and nothing for the room to
    // learn, but the sender gets the authoritative map back so an optimistic toggle
    // converges. `rev` is not bumped: no edit was applied.
    send(ws, { t: 'comments', sheetId: sheet.id, comments, rev: doc.rev, by });
    ackNoop(ws, msg, doc.rev);
    return;
  }

  // Everything that is stored has been through the shared model, exactly like a cell.
  const cleaned = sanitizeComments(plan.next, sheet.rows, sheet.cols);
  if (!commentOpTook(cleaned, plan.expect)) {
    sendError(ws, msg, '댓글을 적용하지 못했습니다.');
    return;
  }

  sheet.comments = cleaned;
  const rev = touchDoc(doc);
  // The RESULT, not the operation. Message ids come from the clock and the author and
  // timestamp are stamped from the peer record, so replaying the operation would mint
  // different ids and a different `at` — the stored map is the only faithful record.
  const saved = await journalAppend(doc.id, {
    t: 'comment', sheetId: sheet.id, comments: cleaned, rev, at: doc.updatedAt,
  });
  broadcast(doc.id, { t: 'comments', sheetId: sheet.id, comments: cleaned, rev, by });
  ackIfSaved(ws, msg, saved, rev);
}

async function handleDocMeta(ws, msg) {
  // Exactly-once. A client replays its outbox after a reconnect because a lost ack is
  // indistinguishable from a lost frame; without this, the replay would apply the
  // operation a second time. Cell writes survive that, but a comment, a structural edit
  // and a sheet op do not.
  if (replayGuard(ws, docIdOf(msg, ws), msg)) return;
  const doc = docForMessage(ws, msg);
  if (!doc) return;
  const by = ws.peer.id;
  const applied = applyDocMetaPatch(doc, msg.patch);
  if (!applied) {
    sendError(ws, msg, '문서 설정 변경 내용이 올바르지 않습니다.');
    return;
  }
  const rev = touchDoc(doc);
  // The validated patch: a document name is absolute, and validateDocName is idempotent,
  // so what was stored is exactly what replays.
  const saved = await journalAppend(doc.id, {
    t: 'docmeta', patch: applied, rev, at: doc.updatedAt,
  });
  broadcast(doc.id, { t: 'docmeta', patch: applied, rev, by });
  ackIfSaved(ws, msg, saved, rev);
}

/**
 * Publish the result of a sheet op. The helpers in shared/model.js are pure: they hand
 * back a NEW document, or the SAME reference when nothing was applied.
 * A full document resend (rather than a delta) is deliberate — see SPEC section 11.
 */
async function commitSheetOp(ws, msg, doc, next) {
  const by = ws.peer ? ws.peer.id : null;
  if (next === doc) {
    // Nothing actually changed (a rename to the same name, a reorder that was clamped
    // back onto itself). Resend the document anyway so a client that moved a tab
    // optimistically snaps back, but do not bump `rev`: no edit was applied.
    broadcast(doc.id, { t: 'sheets', doc, rev: doc.rev, by });
    ackNoop(ws, msg, doc.rev);
    return;
  }
  docs.set(doc.id, next);
  const rev = touchDoc(next);
  // The RESULT, not the operation: addSheet and duplicateSheet mint sheet ids from the
  // clock, so replaying the operation would invent different ids and orphan every later
  // record that names one. SPEC 27.1 journals a sheet op as its document, for exactly this.
  const saved = await journalAppend(next.id, {
    t: 'sheet', op: typeof msg.op === 'string' ? msg.op : '', doc: next, rev, at: next.updatedAt,
  });
  broadcast(next.id, { t: 'sheets', doc: next, rev, by });
  ackIfSaved(ws, msg, saved, rev);
}

async function handleSheet(ws, msg) {
  // Exactly-once. A client replays its outbox after a reconnect because a lost ack is
  // indistinguishable from a lost frame; without this, the replay would apply the
  // operation a second time. Cell writes survive that, but a comment, a structural edit
  // and a sheet op do not.
  if (replayGuard(ws, docIdOf(msg, ws), msg)) return;
  const doc = docForMessage(ws, msg);
  if (!doc) return;
  const op = typeof msg.op === 'string' ? msg.op : '';
  if (!SHEET_OPS.has(op)) {
    sendError(ws, msg, '알 수 없는 시트 작업입니다.');
    return;
  }

  // Every op except 'add' names an existing sheet.
  let target = null;
  if (op !== 'add') {
    target = sheetForMessage(ws, doc, msg);
    if (!target) return;
  }

  const wantedName = typeof msg.name === 'string' ? msg.name : undefined;

  switch (op) {
    case 'add': {
      if (doc.sheets.length >= MAX_SHEETS) {
        sendError(ws, msg, `시트는 최대 ${MAX_SHEETS}개까지 만들 수 있습니다.`);
        return;
      }
      const afterId = typeof msg.afterId === 'string' ? msg.afterId : undefined;
      // The model trims the name, caps it at 100 chars and makes it unique; an empty
      // name becomes the lowest free 시트N.
      const { doc: next, sheet } = addSheet(doc, { name: wantedName, afterId, seed: Date.now() });
      if (!sheet) {
        sendError(ws, msg, `시트는 최대 ${MAX_SHEETS}개까지 만들 수 있습니다.`);
        return;
      }
      await commitSheetOp(ws, msg, doc, next);
      return;
    }
    case 'rename': {
      await commitSheetOp(ws, msg, doc, renameSheet(doc, target.id, wantedName === undefined ? '' : wantedName));
      return;
    }
    case 'delete': {
      if (doc.sheets.length <= 1) {
        sendError(ws, msg, '마지막 시트는 삭제할 수 없습니다.');
        return;
      }
      const next = deleteSheet(doc, target.id);
      await commitSheetOp(ws, msg, doc, next);
      repointPeersAfterDelete(docs.get(doc.id));
      return;
    }
    case 'reorder': {
      // A non-numeric index leaves the sheet where it is; a numeric one is clamped.
      await commitSheetOp(ws, msg, doc, reorderSheet(doc, target.id, msg.index));
      return;
    }
    case 'duplicate': {
      if (doc.sheets.length >= MAX_SHEETS) {
        sendError(ws, msg, `시트는 최대 ${MAX_SHEETS}개까지 만들 수 있습니다.`);
        return;
      }
      const { doc: next, sheet } = duplicateSheet(doc, target.id, { name: wantedName, seed: Date.now() });
      if (!sheet) {
        sendError(ws, msg, '시트를 복사하지 못했습니다.');
        return;
      }
      await commitSheetOp(ws, msg, doc, next);
      return;
    }
    default: {
      // 'color' — anything that is not a usable '#rrggbb' clears the tab colour.
      const color = msg.color === null || msg.color === undefined ? null : msg.color;
      await commitSheetOp(ws, msg, doc, setSheetColor(doc, target.id, color));
    }
  }
}

function handleCursor(ws, msg) {
  const doc = docForMessage(ws, msg);
  if (!doc) return;
  const sheet = sheetForMessage(ws, doc, msg);
  if (!sheet) return;
  const activeRaw = typeof msg.active === 'string' ? parseCellKey(msg.active) : null;
  const active = activeRaw && activeRaw.row < sheet.rows && activeRaw.col < sheet.cols ? activeRaw.key : null;
  const range = sanitizeSelectionRange(msg.range, sheet);
  ws.peer.sheetId = sheet.id;
  ws.peer.active = active;
  ws.peer.range = range;
  broadcast(doc.id, { t: 'cursor', id: ws.peer.id, sheetId: sheet.id, active, range }, ws);
}

wss.on('connection', (ws) => {
  ws.peer = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    ws.isAlive = true;
    if (isBinary) {
      send(ws, { t: 'error', message: '텍스트 메시지만 지원합니다.' });
      return;
    }
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (text.length > MAX_FRAME_BYTES) {
      send(ws, { t: 'error', message: '메시지가 너무 큽니다.' });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      send(ws, { t: 'error', message: '메시지 형식이 올바르지 않습니다.' });
      return;
    }
    if (!isPlainObject(msg) || typeof msg.t !== 'string') {
      send(ws, { t: 'error', message: '메시지 형식이 올바르지 않습니다.' });
      return;
    }
    // Every handler that journals is async, so a failure can surface either synchronously
    // (a bad frame) or as a rejected promise (a disk that went away). Both end in the same
    // place: an error frame to the sender, never an unhandled rejection.
    const fail = (err) => {
      console.error(`[시트지] 메시지 처리 오류 (${msg.t}): ${err && err.message}`);
      sendError(ws, msg, '요청을 처리하지 못했습니다.');
    };
    try {
      let running;
      switch (msg.t) {
        case 'hello':
          handleHello(ws, msg);
          break;
        case 'edit':
          running = handleEdit(ws, msg);
          break;
        case 'struct':
          running = handleStruct(ws, msg);
          break;
        case 'meta':
          running = handleMeta(ws, msg);
          break;
        case 'comment':
          running = handleComment(ws, msg);
          break;
        case 'docmeta':
          running = handleDocMeta(ws, msg);
          break;
        case 'sheet':
          running = handleSheet(ws, msg);
          break;
        case 'cursor':
          handleCursor(ws, msg);
          break;
        case 'ping':
          send(ws, { t: 'pong' });
          break;
        default:
          sendError(ws, msg, '알 수 없는 메시지 유형입니다.');
      }
      if (running && typeof running.catch === 'function') running.catch(fail);
    } catch (err) {
      fail(err);
    }
  });

  ws.on('error', (err) => {
    console.warn(`[시트지] 소켓 오류: ${err && err.message}`);
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

// Heartbeat: drop sockets that stopped answering.
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    // A session that expired must actually end the connection. The upgrade is checked
    // once; without this the lifetime in SZ_SESSION_DAYS would bound page loads only,
    // and a tab left open would keep reading and writing every document for ever.
    // 1008 (policy violation) tells the client this is not a transport problem: it
    // reconnects, the next upgrade is refused, and it lands on the login page.
    if (auth.enabled && typeof ws.sessionExp === 'number' && ws.sessionExp <= now) {
      try { ws.close(1008, 'session expired'); } catch { ws.terminate(); }
      continue;
    }
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);
// The listening socket is what keeps the process alive; this timer does not need to.
// That also lets a tool import this file for hashPassword without hanging on exit.
heartbeat.unref();

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// boot / shutdown
// ---------------------------------------------------------------------------

/**
 * Keep the process alive for the whole of boot.
 *
 * Boot is I/O and nothing else, and until `server.listen` runs there is no listening
 * socket — so between two awaits this process can be holding NO ref'd handle at all. An
 * event loop with nothing ref'd does not wait: it exits, code 0, with no error, no stack
 * and no log line, in the middle of booting. Anything a store does with an unref'd timer
 * — a backoff between retries is the obvious one — lands in that window, and one slow read
 * then looks exactly like a clean shutdown while every document in the system goes down
 * with it.
 *
 * That is the opposite of what SPEC 27.6 asks for. A read that fails must produce a loud
 * refusal for ONE document, and the difference between "refused loudly" and "vanished
 * quietly" is the entire subject of that section. One ref'd timer, cleared the moment
 * `listen` gives the process a handle of its own, closes the window.
 */
function holdProcessDuringBoot() {
  // A long interval rather than a timeout: it can be cleared unconditionally in `finally`
  // whether boot took a millisecond or a minute, and it never fires in practice.
  return setInterval(() => {}, 60_000);
}

async function bootServer() {
  const keepAlive = holdProcessDuringBoot();
  try {
    await bootInner();
  } finally {
    clearInterval(keepAlive);
  }
}

async function bootInner() {
  // The gate's state is announced before anything else, every boot, so nobody can
  // deploy this open by accident without having been told.
  if (auth.fatal) {
    console.error(`[시트지] 접근 제한 설정이 잘못되었습니다: ${auth.fatal}`);
    console.error('[시트지] 열린 상태로 실행하지 않고 종료합니다.');
    process.exit(1);
  }
  logAuthConfig();

  // Which document store is running is announced next, alongside the other boot lines,
  // and before anything is read through it (SPEC 29.1).
  await storage.init();

  await loadDocsFromDisk();
  if (docs.size === 0 && unreadableDocs.size === 0) {
    const starter = createStarterDoc();
    docs.set(starter.id, starter);
    saveNow(starter.id);
    console.log(`[시트지] 시작 문서를 만들었습니다: ${starter.name} (${starter.id})`);
  } else if (docs.size === 0) {
    // Documents exist; this process simply could not read any of them. A starter here
    // would put a brand-new empty spreadsheet in front of somebody whose own is sitting
    // unread on the disk — the "no such document, make another" reading SPEC 27.6 exists
    // to forbid — and it would take the fixed starter id, which may be one of theirs.
    console.error(
      '[시트지] 읽을 수 있는 문서가 하나도 없어 시작 문서를 만들지 않았습니다. '
      + '기존 문서를 덮어쓰지 않기 위해서입니다.',
    );
  }
  console.log(`[시트지] 문서 ${docs.size}개를 불러왔습니다.`);
  if (unreadableDocs.size) {
    console.error(
      `[시트지] 문서 ${unreadableDocs.size}개는 열지 못했습니다. 나머지 문서는 정상적으로 동작합니다.`,
    );
  }

  server.on('error', (err) => {
    console.error(`[시트지] 서버를 시작하지 못했습니다: ${err && err.message}`);
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`[시트지] 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`[시트지] 클라이언트 버전 ${BUILD_ID}`);
  });
}

// --------------------------------------------------------------- hash-password
//
// `node server.js hash-password <비밀번호>` (and tools/hash-password.mjs, which calls
// the exported hashPassword) prints a value for SZ_PASSWORD_HASH. That is how an
// operator sets a password without the plaintext ever being in the server's
// environment. Only the hash is printed; the password is never echoed or logged.

async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function runHashPasswordCli(arg) {
  let password = typeof arg === 'string' ? arg : '';
  if (password === '') {
    if (process.stdin.isTTY) {
      console.error('사용법: node server.js hash-password <비밀번호>');
      console.error('또는 표준 입력으로 비밀번호를 전달하세요: echo -n 비밀번호 | node server.js hash-password');
      process.exit(2);
    }
    password = await readPasswordFromStdin();
  }
  if (password === '') {
    console.error('비밀번호가 비어 있습니다.');
    process.exit(2);
  }
  process.stdout.write(`${hashPassword(password)}\n`);
}

/** Same file as the process entry point? Then this is a run, not an import. */
function samePath(a, b) {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isMainModule() {
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry === '') return true;
    const self = fileURLToPath(import.meta.url);
    if (samePath(entry, self)) return true;
    try {
      if (samePath(realpathSync(entry), realpathSync(self))) return true;
    } catch {
      /* one of them is gone; fall through to the comparison already made */
    }
    return false;
  } catch {
    // Undecidable — behave the way this file always has and boot.
    return true;
  }
}

if (process.argv[2] === 'hash-password') {
  runHashPasswordCli(process.argv[3]).catch((err) => {
    console.error(`[시트지] 해시를 만들지 못했습니다: ${err && err.message}`);
    process.exit(1);
  });
} else if (isMainModule()) {
  // Selecting and opening the store is asynchronous, so booting is too. A store the
  // operator configured and that cannot be opened is fatal: running on the local disk
  // they believe is unused would be worse than not starting at all.
  bootServer().catch((err) => {
    console.error(`[시트지] 서버를 시작하지 못했습니다: ${err && err.message}`);
    process.exit(1);
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[시트지] ${signal} 수신 — 저장 후 종료합니다.`);
  clearInterval(heartbeat);
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
  }
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  try {
    await flushAllSaves();
  } catch (err) {
    console.error(`[시트지] 종료 중 저장 실패: ${err && err.message}`);
  }
  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
