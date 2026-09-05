// storage/fileStore.js — the file document store (SPEC 29.2).
//
// This is the persistence the server has always used, moved behind the interface in
// SPEC 29.1 and otherwise unchanged. `data/<id>.json` is a compaction of `data/<id>.log`;
// `data/<id>.bak.1 .. .bak.5` keep the snapshots it replaced. Every durability rule in
// SPEC 27 lives here exactly as it did before: the append that lands before a broadcast,
// the fsync at most every FSYNC_MS, the torn-tail guard on open, the short-write check,
// the atomic tmp+rename snapshot and the backup rotation.
//
// What this module does NOT decide is *when* any of it happens. The save debounce, the
// compaction order (snapshot, then truncate) and the flush before a clean exit are policy
// and stay in server.js; this file only performs the operations it is asked for.
//
// The one rule that shapes everything below is SPEC 27.6: a filesystem answers a read with
// three different things, and this file is careful never to collapse them into two.
//
//   ABSENT   ENOENT. Nothing is stored. Create it, serve it empty, carry on.
//   CORRUPT  the bytes arrived IN FULL and will not parse. We have seen the damage, so a
//            torn journal line is counted and skipped and a damaged snapshot falls through
//            to the next backup — exactly as before; nothing here narrows that.
//   UNREAD   any other errno. EACCES, EIO, EBUSY, EPERM, EISDIR, ERR_FS_FILE_TOO_LARGE, a
//            scanner holding the file for the moment boot touched it. The data IS there and
//            this process failed to see it.
//
// UNREAD is a REJECTION, never a value. Returning an empty journal for it is what let a
// boot serve a document at a snapshot rev that did not include the acknowledged records
// still sitting in the log; returning a backup for it is what let an older snapshot be
// installed over a newer one that was merely busy. Both destroyed data nothing had read.
//
// One UNREAD outcome quarantines that document for the life of the process: saveSnapshot,
// truncateJournal and deleteDoc refuse, appendJournal answers false, and the quarantine is
// never lifted — not even by a later successful read, which is precisely how the previous
// attempt handed the deletion to the next boot. Nothing on disk can then change for that
// document, so the next boot re-derives the same conclusion from the same bytes instead of
// needing a marker written to the disk that just failed (SPEC 27.6).
//
// HOW THAT REFUSAL IS MADE UNSKIPPABLE, which is the shape of this file.
//
// Every syscall that can create, alter, move or destroy a byte under data/ is reached
// through ONE function, `mutate`, and appears nowhere else: the append, the temporary's
// write, the rename, the unlink, the truncate and the newline that closes a torn tail.
// `mutate` asks whether the document is readable as its last statement before issuing the
// call, with no `await` in between, and asks again once the call resolves. The second ask
// is the honest half: a write already on the wire when the quarantine lands may have
// landed, and there is no recalling it — but the answer is still false, because a
// duplicate the client resends costs nothing (replay is idempotent, SPEC 27.4) and a
// record claimed as durable under doubt costs somebody's typing.
//
// This is a structure rather than a rule, on purpose. The same defect was found in three
// consecutive reviews in three different places, and each time it was fixed where it was
// found: the check sat at the function entry, then inside the queued task, then just
// before one destructive step — and every time, the NEXT await down the function reopened
// it. `tools/check-writes.mjs` runs in `npm run verify` and fails the build if any of
// those primitives appears outside the gate, so the arrangement cannot rot back into a
// convention somebody has to remember.

import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, open, rename, stat, truncate, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeDoc } from '../shared/model.js';

/** Which backend this is, for the boot log (SPEC 29.1). */
export const name = 'file';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');

// Durability (SPEC 27). The journal is fsynced at most this often, so a machine losing
// power costs at most this much work rather than whatever the save debounce was holding.
const FSYNC_MS = 200;
// How many previous snapshots are kept as <id>.bak.1 .. <id>.bak.5 (SPEC 27.2).
const BACKUP_COUNT = 5;

// Ids arrive from URLs and from file names, so the pattern is re-checked here at the last
// possible moment rather than trusted.
const DOC_ID_RE = /^[a-z0-9]{6,24}$/;

// The code every UNREAD failure carries (SPEC 29.1). A string, compared the way `ENOENT`
// is compared, so no caller needs an import to recognise one.
const UNREAD_CODE = 'ESTOREUNREAD';

/**
 * Per-document disk state (SPEC 27.1).
 *
 * `chain` serialises EVERY disk operation for one document — journal appends, fsyncs and
 * snapshots alike. Two appends therefore can never interleave, and the timer-driven fsync
 * can never land in the middle of one. `handle` is the open append handle for
 * data/<id>.log; `dirty` says whether bytes written through it are still waiting for an
 * fsync.
 *
 * `handle` and `dirty` move together, and that pairing is an invariant the whole file
 * relies on: whenever `handle` is null, `dirty` is false. Nothing can sync bytes written
 * through a handle that is gone, so a null handle with `dirty` still set would describe a
 * flush that is never going to happen. Every place that drops the handle therefore goes
 * through `discardHandle`, which syncs first and clears the flag afterwards.
 *
 * `unread` is the quarantine of SPEC 27.6: null, or a record of the first read this process
 * could not complete for this document. Once set it is never cleared, because clearing it
 * is the bug — the previous version refused only the truncate and let the document go on
 * being served, its rev climbed past the unread records in snapshots that did not contain
 * them, and the next boot's successful read then replayed none of them and truncated. A
 * quarantined document is not one operation short; it stops moving entirely.
 *
 * `snapshotMark` is the file store's version of the Supabase backend's truncation
 * watermark: true only while a snapshot written in this process is the newest thing this
 * journal has seen. `truncateJournal` empties the file only when it is set, and any append
 * clears it, so a record that landed AFTER the snapshot cannot be truncated away by a
 * caller that let the two calls drift apart. See truncateJournalFile for why the chain
 * alone was not enough.
 *
 * @type {Map<string, {chain: Promise<unknown>, handle: object|null, dirty: boolean, fsyncTimer: object|null, snapshotMark: boolean, unread: {what: string, cause: unknown, at: number, warnedAppend: boolean}|null}>}
 */
const io = new Map();

// Every path join in this file goes through here.
function assertDocId(id) {
  if (typeof id !== 'string' || !DOC_ID_RE.test(id)) throw new Error('invalid document id');
  return id;
}

function docPath(id) {
  return join(DATA_DIR, `${assertDocId(id)}.json`);
}

function journalPath(id) {
  return join(DATA_DIR, `${assertDocId(id)}.log`);
}

function backupPath(id, index) {
  return join(DATA_DIR, `${assertDocId(id)}.bak.${index}`);
}

function ioFor(id) {
  let state = io.get(id);
  if (!state) {
    state = {
      chain: Promise.resolve(),
      handle: null,
      dirty: false,
      fsyncTimer: null,
      snapshotMark: false,
      unread: null,
    };
    io.set(id, state);
  }
  return state;
}

/**
 * The error every UNREAD outcome travels in (SPEC 29.1).
 *
 * `code` is what a caller compares, exactly as it would compare `ENOENT`; `cause` keeps the
 * original errno reachable, so nothing is hidden by the wrapping. The message says what
 * could not be read and what is therefore NOT going to happen to it, because a person
 * reading the log needs the consequence more than the syscall.
 */
function unreadError(id, what, cause) {
  const detail = cause && cause.message ? cause.message : String(cause);
  const err = new Error(
    `${id}: ${what}을 읽지 못했습니다 (${detail}). 내용을 확인할 수 없어 이 문서는 손대지 않습니다.`,
  );
  err.code = UNREAD_CODE;
  err.docId = id;
  err.cause = cause;
  return err;
}

/**
 * Quarantine this document and return the error to throw (SPEC 27.6).
 *
 * The FIRST failure is the one kept: it is the one that names the file this process could
 * not see, and every later refusal is only a consequence of it. The line is printed once
 * per document, at error level, because it is the operator's whole cue — the document will
 * not come back without a restart, and nothing else says so.
 */
function markUnread(id, what, cause) {
  const err = unreadError(id, what, cause);
  const state = ioFor(id);
  if (!state.unread) {
    state.unread = { what, cause, at: Date.now(), warnedAppend: false };
    console.error(`[시트지] ${err.message} 원인을 고친 뒤 서버를 다시 시작하세요.`);
  }
  return err;
}

/**
 * Throw if this document is quarantined (SPEC 29.1).
 *
 * Called in two kinds of place, and only one of them is the guarantee. At the top of a
 * public call and at the top of a queued task it is an EARLY-OUT: it saves the work of
 * opening files for a document that is already refusing everything, and it produces the
 * error before anything has been touched. Inside `mutate` below it is the GUARD, and that
 * one is the whole of the protection.
 *
 * Three review rounds moved this check from the entry point, to inside the queued task, to
 * "just before the destructive step", and each time the next round found another step that
 * had drifted an await away from it. A check whose correctness depends on where somebody
 * remembered to put it is not a guard; it is a convention. So no caller below places one
 * before a write any more. The gate does, on every write, by construction.
 */
function assertReadable(id) {
  const state = io.get(id);
  if (state && state.unread) throw unreadError(id, state.unread.what, state.unread.cause);
}

/** Is this the quarantine refusal, as opposed to an ordinary errno? */
function isUnread(err) {
  return Boolean(err) && err.code === UNREAD_CODE;
}

/**
 * A mutation that DID happen and was then refused by the ack-rule re-check hands whatever
 * it produced back on the error, so an opened file can still be closed rather than leaked.
 */
function orphanOf(err) {
  const value = err && err.mutationResult;
  return value && typeof value.close === 'function' ? value : null;
}

// ---------------------------------------------------------------------------
// the mutation gate — the ONLY code in this file that changes anything on disk
// ---------------------------------------------------------------------------

/**
 * Every syscall that can create, alter, move or destroy a byte under data/ lives in the
 * table below and is reached only through `mutate`. Nothing else in this file writes.
 *
 * That is the point, and it is enforced rather than agreed: `tools/check-writes.mjs` runs
 * in `npm run verify`, allows these primitives only between the two markers around this
 * block, and fails the build if one appears anywhere else. The bug this closes was found
 * three rounds running in three different places — a check before `await rotateBackups`
 * with the rename after it, a check before an `open` with the write after it, a check
 * before an upsert with the backup insert after it — and each round it was fixed where it
 * was found. A fourth place was always going to exist. There is now one place.
 *
 * `mkdir(DATA_DIR)` is deliberately not here: it creates the directory, names no document
 * and cannot alter one. It is the checker's one declared exception, written out in full so
 * that changing it fails the check.
 *
 * >>> MUTATION GATE — begin (tools/check-writes.mjs)
 */
const MUTATORS = {
  /** Open a file for writing. 'a' creates the journal, 'w' creates or truncates the tmp. */
  open: (a) => open(a.path, a.flags),
  /** One write syscall. Short writes are the caller's problem; see writeAllTo. */
  write: (a) => a.handle.write(a.buf, a.off, a.len),
  /** Replace a freshly opened temporary's whole content. */
  writeFile: (a) => a.handle.writeFile(a.text, 'utf8'),
  /** Move a file: the backup ring, and the atomic promotion of the temporary. */
  rename: (a) => rename(a.from, a.to),
  /** Remove a file: the oldest backup, a half-written temporary, a deleted document. */
  unlink: (a) => unlink(a.path),
  /** Empty the journal after a snapshot has been renamed into place. */
  truncate: (a) => truncate(a.path, 0),
};

/**
 * Perform one mutating syscall for one document, or refuse.
 *
 * The check is the last statement before the call: there is no `await` between
 * `assertReadable(id)` and `run(args)`, so no read can fail in the gap — the gap does not
 * exist. That is the property the three earlier fixes each restored in one place and lost
 * in the next.
 *
 * And it checks AGAIN afterwards, which is SPEC 27.6's asymmetry applied to a write that
 * was already on the wire when the quarantine landed. Such a write may have landed too, and
 * there is no recalling it — but there is no obligation to CLAIM it. Answering false costs
 * a duplicate when the client retries, and replay is idempotent (SPEC 27.4), so a duplicate
 * costs nothing; answering true under doubt costs somebody's typing. Where the two cannot
 * be told apart, refuse.
 */
async function mutate(id, op, args) {
  const run = MUTATORS[op];
  if (typeof run !== 'function') throw new Error(`fileStore: 알 수 없는 쓰기 동작 '${op}'`);
  assertDocId(id);
  assertReadable(id);
  const result = await run(args);
  try {
    assertReadable(id);
  } catch (err) {
    err.mutationResult = result;
    throw err;
  }
  return result;
}
// <<< MUTATION GATE — end (tools/check-writes.mjs)

// How many tasks have ever been queued. flush() watches it to tell "everything in flight
// has finished" from "everything I knew about when I started has finished".
let queuedTotal = 0;

// Queue one disk task behind everything already queued for this document, swallowing its
// result. The promise it returns never rejects, so a single failure cannot poison the
// chain for the rest of the process's life — the next append still runs.
function enqueue(id, task, label) {
  queuedTotal++;
  const state = ioFor(id);
  const next = state.chain.then(task).catch((err) => {
    console.error(`[시트지] ${label} 실패 (${id}): ${err && err.message}`);
  });
  state.chain = next;
  return next;
}

// The same queue, but the caller gets the task's own result (or its failure). The chain
// itself is still kept alive with a neutralised copy, for the same reason as above.
function queue(id, task) {
  queuedTotal++;
  const state = ioFor(id);
  const done = state.chain.then(task);
  state.chain = done.then(() => {}, () => {});
  return done;
}

// A missing file is the normal case for every rotation and truncation step below.
function ignoreMissing(err) {
  if (!err || err.code !== 'ENOENT') throw err;
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

/**
 * Append one accepted operation to data/<id>.log as a single JSON line (SPEC 27.1).
 *
 * The caller writes the line BEFORE broadcasting the operation and before acknowledging
 * it, so a process death — the realistic failure — cannot lose it: by the time this
 * resolves the bytes are with the operating system. Surviving a MACHINE death is a
 * separate, weaker promise, bounded by the fsync every FSYNC_MS; nothing here claims more
 * than that.
 *
 * Resolves `true` only when the write actually landed. `false` is the caller's signal to
 * withhold the ack, because an ack is the client's licence to forget the frame.
 *
 * A record is an OBJECT and nothing else. `undefined`, a string, a number, an array and a
 * record whose own `toJSON()` returns nothing are all refused with `false`, and nothing is
 * written. That refusal belongs to the INTERFACE rather than to this backend (SPEC 29.1):
 * the Supabase store makes exactly the same one, so a caller written to the signatures —
 * a script run by hand, a backup job, an exporter, none of which is `server.js` and none
 * of which pre-validates — gets the same answer whichever store is configured.
 * Acknowledging one of those would be the worst answer available here: the line lands in
 * the log, `readJournal` counts it in `badLines` rather than returning it, and the client
 * has been licensed to forget an edit nothing will ever replay.
 *
 * A quarantined document (SPEC 27.6) answers `false` and writes nothing. Appending is not
 * itself destructive, but a record appended to a journal this process could not read would
 * carry a `rev` minted from a snapshot that did not include the unread records — colliding
 * with them, and making the log impossible to replay unambiguously afterwards. `false` is
 * the answer that already exists for "not durable": the ack is withheld, the client keeps
 * the frame in its outbox (SPEC 27.4), and nothing is lost while the operator restarts.
 * This is the one place UNREAD is not a throw, because `false` is what every call site here
 * already handles.
 */
export function appendJournal(id, record) {
  let line;
  try {
    assertDocId(id);
    // The Supabase store's refusal, made here word for word, because SPEC 29.1 puts it on
    // the interface: a record is an object, so a caller cannot be handed a different
    // answer by pointing itself at a different backend.
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('저널 레코드가 객체가 아닙니다');
    }
    // `JSON.stringify` answers `undefined` — not a string, and without throwing — for a
    // value it cannot represent, which is what a record whose `toJSON()` returns nothing
    // really is. Interpolating that writes the nine letters `undefined` as a journal line:
    // a line that parses as nothing, is counted in `badLines`, and was acknowledged TRUE.
    const json = JSON.stringify(record);
    if (typeof json !== 'string') {
      throw new Error('저널 레코드를 JSON 으로 만들 수 없습니다');
    }
    line = `${json}\n`;
  } catch (err) {
    console.error(`[시트지] 저널 레코드를 만들지 못했습니다 (${id}): ${err && err.message}`);
    return Promise.resolve(false);
  }
  // Answered before anything is queued, so a quarantined document does not grow a chain of
  // refusals at typing speed. It is an early-out and nothing more; the decision that counts
  // is the one inside the task.
  if (appendRefused(id)) return Promise.resolve(false);
  return queue(id, async () => {
    // A second early-out, because a read can fail while this task waits its turn. It is
    // not the guard — the guard is the gate, which re-checks with nothing between it and
    // each write syscall, and once more after the syscall resolves. Both of those matter
    // here: the quarantine used to land after `open(..., 'a')` returned and the record was
    // written and acknowledged TRUE anyway, licensing the client to forget an edit whose
    // `rev` was minted from a snapshot that does not contain the unread records (27.6).
    if (appendRefused(id)) return false;
    await appendJournalLine(id, line);
    return true;
  }).then(
    // `ok === true`, never a bare `true`: a refusal inside the task resolves false and has
    // to reach the caller AS false. Converting it to true here would acknowledge a record
    // that was never written, which is the one answer this function may never give.
    (ok) => ok === true,
    (err) => {
      console.error(`[시트지] 저널 기록 실패 (${id}): ${err && err.message}`);
      return false;
    },
  );
}

/**
 * Is this document quarantined, and therefore refusing new records (SPEC 27.6)?
 *
 * The warning is printed once per document: the line that quarantined it already said why,
 * and this one would otherwise repeat itself at typing speed.
 */
function appendRefused(id) {
  const state = io.get(id);
  if (!state || !state.unread) return false;
  if (!state.unread.warnedAppend) {
    state.unread.warnedAppend = true;
    console.warn(
      `[시트지] ${id}: 저장된 내용을 읽지 못한 문서라 새 편집을 기록하지 않습니다. 서버를 다시 시작해야 합니다.`,
    );
  }
  return true;
}

async function appendJournalLine(id, line) {
  const state = ioFor(id);
  // The snapshot on disk is no longer the newest thing this journal has seen, so it may no
  // longer licence a truncate. Cleared BEFORE the bytes are written rather than after,
  // because a write that fails can still have landed a prefix, and the safe direction is
  // to keep a journal that is already compacted rather than to empty one that is not.
  state.snapshotMark = false;
  // Opened in append mode, so a write always lands at the end of the file no matter what
  // else touched it, and a failed open simply leaves the handle null to be retried.
  if (!state.handle) {
    let handle;
    try {
      handle = await mutate(id, 'open', { path: journalPath(id), flags: 'a' });
    } catch (err) {
      // The gate can refuse AFTER the open succeeded (the quarantine landed while the
      // syscall was in flight). The file is then open and nothing references it, so it is
      // closed here rather than leaked; the append fails and is not acknowledged.
      const orphan = orphanOf(err);
      if (orphan) await orphan.close().catch(() => {});
      throw err;
    }
    state.handle = handle;
    try {
      await closeTornTail(id, state.handle);
    } catch (err) {
      // Either the tail could not be inspected or the newline that closes it could not be
      // written. Both leave us unable to say the file ends on a record boundary, and
      // writing this record onto a fragment we failed to close is exactly the loss the
      // guard exists to prevent — so fail the append instead of guessing. The caller then
      // withholds the ack, the client keeps the frame in its outbox (SPEC 27.4), and the
      // next append retries the whole open-and-guard from scratch.
      console.warn(`[시트지] 저널 끝 확인 실패 (${id}): ${err && err.message}`);
      await discardHandle(id, state);
      throw err;
    }
  }
  // Marked dirty BEFORE the write rather than after it, because bytes can land and the
  // call still fail — a short write followed by a disk error, or the gate's ack-rule
  // refusal on a write that had already gone through. `dirty` is the only thing that makes
  // `discardHandle` sync, so setting it afterwards would leave those bytes with nothing
  // scheduled to fsync them. An fsync for a write that turned out to be empty is free.
  state.dirty = true;
  try {
    await writeAllTo(id, state.handle, line);
  } catch (err) {
    // The write can have landed a PREFIX of the line: writeAllTo loops over a partial
    // write, and the disk can fail between iterations. Keeping the handle would let the
    // NEXT append write its record straight onto that fragment, gluing both into one
    // unparseable line — and that next append would resolve `true`, acknowledging a
    // record the client is then licensed to forget while replay can never read it back.
    // Dropping the handle forces a reopen, which re-runs the torn-tail guard above; that
    // guard already knows how to close a fragment.
    await discardHandle(id, state);
    throw err;
  }
  scheduleFsync(id);
}

/**
 * Close a torn last line before anything is appended to it (SPEC 27.1).
 *
 * A previous process can have died mid-line, and so can this one — a write that fails
 * after landing part of a line leaves the same fragment. Appending straight onto it would
 * glue two records into a single unparseable line and cost BOTH of them on the next
 * replay. Run once per open, not per append.
 *
 * Every failure throws, including a failure merely to LOOK at the tail: a tail that could
 * not be inspected is a tail that cannot be called whole, and the caller must not write
 * onto it. Only the read handle's close is best-effort — by then the byte has already been
 * read and has already told us the truth.
 */
async function closeTornTail(id, handle) {
  const st = await handle.stat();
  if (!(st.size > 0)) return;
  const tail = Buffer.alloc(1);
  const rh = await open(journalPath(id), 'r');
  let last;
  try {
    const { bytesRead } = await rh.read(tail, 0, 1, st.size - 1);
    if (bytesRead !== 1) throw new Error('journal tail read returned no byte');
    last = tail[0];
  } finally {
    await rh.close().catch(() => {});
  }
  if (last === 0x0a) return;
  await writeAllTo(id, handle, '\n');
  console.warn(`[시트지] 저널의 잘린 마지막 줄을 닫았습니다 (${id})`);
}

/**
 * Give up the cached append handle (SPEC 27.1).
 *
 * The handle is dropped so the NEXT append reopens the file and re-runs the torn-tail
 * guard, which is the only code that knows how to close a fragment a failed write may have
 * left behind. Cached state that survives a failure is what turns one failed append into a
 * second, silent loss.
 *
 * Everything written through this handle BEFORE the failure is fsynced first, and only
 * then is `dirty` cleared — so clearing it cannot downgrade the durability of a previous
 * record that already resolved `true`. This is the last moment anything can sync those
 * bytes: once the handle is gone, `syncJournal` and `closeJournal` both return early on a
 * null handle. If the sync itself fails there is nothing further to try here — the bytes
 * are still with the operating system, so a process death costs nothing, and the next
 * successful append schedules an fsync that covers the whole file, these bytes included.
 */
async function discardHandle(id, state) {
  const handle = state.handle;
  state.handle = null;
  if (!handle) {
    state.dirty = false;
    return;
  }
  if (state.dirty) {
    try {
      await handle.sync();
    } catch (err) {
      console.warn(`[시트지] 저널 동기화 실패 (${id}): ${err && err.message}`);
    }
  }
  state.dirty = false;
  try {
    await handle.close();
  } catch (err) {
    console.warn(`[시트지] 저널 파일을 닫지 못했습니다 (${id}): ${err && err.message}`);
  }
}

/**
 * Write every byte, or throw.
 *
 * `FileHandle.write` is a single syscall and may write only part of what it was given.
 * It RESOLVES on a short write, so the caller sees success, the record is acknowledged
 * as durable, and only a prefix of the JSON line — with no terminating newline — is on
 * disk. That is the difference between a durability guarantee and a claim.
 *
 * Every iteration is a separate syscall and so passes the gate separately, which is what
 * a loop needs: a quarantine that lands between two chunks stops the rest of the line
 * instead of being noticed only once the whole record is down. The fragment already
 * written is left for the torn-tail guard on the next open, and nothing is acknowledged.
 */
async function writeAllTo(id, handle, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await mutate(id, 'write', { handle, buf, off, len: buf.length - off });
    if (!(bytesWritten > 0)) throw new Error('journal write made no progress');
    off += bytesWritten;
  }
}

// fsync at most every FSYNC_MS: often enough that a power failure costs a fifth of a
// second of work, rarely enough that it is not paid once per keystroke.
function scheduleFsync(id) {
  const state = ioFor(id);
  if (state.fsyncTimer) return;
  const timer = setTimeout(() => {
    state.fsyncTimer = null;
    enqueue(id, () => syncJournal(id), '저널 동기화');
  }, FSYNC_MS);
  if (typeof timer.unref === 'function') timer.unref();
  state.fsyncTimer = timer;
}

async function syncJournal(id) {
  const state = ioFor(id);
  if (!state.dirty || !state.handle) return;
  state.dirty = false;
  try {
    await state.handle.sync();
  } catch (err) {
    state.dirty = true; // still unsynced: the next flush has to try again
    // …and something has to BE that next flush. `scheduleFsync` is otherwise only called
    // from an append, so a document that goes quiet right after a failed fsync would sit
    // with unsynced bytes until the process exits. Re-arming the timer here is what makes
    // the line above true rather than a hope; it stops as soon as one sync succeeds,
    // because `dirty` is then false and this function returns immediately.
    scheduleFsync(id);
    throw err;
  }
}

/**
 * Read data/<id>.log into records. A line that fails to parse is skipped and counted: a
 * half-written last line is the NORMAL state after a crash, and one bad record must never
 * cost the whole document (SPEC 27.1).
 *
 * The skipped count travels with the records. A journal whose ONLY content is a torn
 * fragment yields no records at all, and a caller that saw just an empty list would leave
 * that fragment on disk for the next append to be glued onto.
 *
 * A journal that could not be READ AT ALL — a permission error, an I/O error, a file the
 * virus scanner had locked for the moment boot happened to touch it — is a different thing
 * from an empty one, and this REJECTS for it (SPEC 27.6, 29.1). Returning an empty list was
 * a lie with teeth: the records went unreplayed, the document was served at a rev that did
 * not include them, and the first save afterwards compacted that shortened document over
 * the snapshot and truncated the journal that still held them. A rejection cannot be read
 * as "no records", and the document is quarantined so nothing overwrites what was not read.
 *
 * ENOENT stays exactly what it was: the ordinary "no journal yet", an empty result, nothing
 * to protect. A line that will not parse stays exactly what it was too — counted in
 * `badLines`, never fatal. What is narrowed here is only what may be called corruption.
 *
 * A line that DID parse, but into something that is not a record, is counted the same way.
 * SPEC 27.1 writes one JSON object per line, and SPEC 29.3 makes "a `rec` that is not an
 * object" the Supabase store's version of this very rule — so classifying it here is what
 * lets both backends answer `{ records, badLines }` identically for the same stored content
 * (SPEC 29.1). Nothing is lost by it: `server.js` already discards a replayed record that
 * is not a plain object carrying a `t`, and either count drives the same rewrite on boot.
 */
export async function readJournal(id) {
  assertDocId(id);
  assertReadable(id);
  let text;
  try {
    text = readFileSync(journalPath(id), 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw markUnread(id, '저널', err);
    return { records: [], badLines: 0 };
  }
  const records = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    // Parsed, and still not a record: `42`, `"hello"`, `[1,2]`, `null`. Nothing this store
    // accepts can produce one any more (see appendJournal), so it is a line some other hand
    // wrote — and returning it as a record would be this backend answering differently from
    // the other one for the same bytes.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      bad++;
      continue;
    }
    records.push(parsed);
  }
  if (bad) console.warn(`[시트지] ${id}: 읽을 수 없는 저널 줄 ${bad}개를 건너뜁니다.`);
  return { records, badLines: bad };
}

/**
 * Drop every record the freshly written snapshot already contains. The caller runs this
 * ONLY after that snapshot has been fsynced and renamed into place (SPEC 27.1):
 * truncating first opens a window in which neither copy holds the data.
 *
 * The bound has exactly ONE source, as it does on the Supabase backend: a snapshot written
 * in THIS process that is still the newest thing this journal has seen. With no such mark
 * this does nothing at all — keeping records that are already compacted is free, losing
 * one is not.
 *
 * That mark is what stands in for the seq the Supabase store truncates against, and it is
 * needed for the same reason. `saveSnapshot` and `truncateJournal` are two separate tasks
 * on this document's chain, and the chain is free BETWEEN them: a caller that appends in
 * that gap — `server.js` does not, because it runs both halves of a compaction inside one
 * exclusive task, but SPEC 29.1 is explicit that the next caller is written by someone who
 * has not read this — would have had that record emptied away by a truncate that believed
 * the snapshot covered it. A record appended after the snapshot has a higher seq on the
 * other backend and survives; here the append clears the mark and the truncate declines,
 * so it survives too. Neither store can lose it, and neither leaves the ordering to the
 * caller to get right (SPEC 29.1).
 *
 * The handle is closed and the file truncated BY PATH rather than through the handle,
 * because Windows refuses ftruncate on one opened for append — such a handle carries
 * FILE_APPEND_DATA and nothing else, so it may add bytes but never move the end of the
 * file. The next append reopens it. Both steps run on this document's own chain, so no
 * record can land between the close and the truncate.
 *
 * It REJECTS for a quarantined document (SPEC 27.6): a read failed for it, so records it
 * never saw may be in this file, they are not in any snapshot, and this is the one step
 * that would actually destroy them. A rejection rather than a quiet return, because the
 * caller has just written a snapshot it believes covers this journal and has to be told
 * that belief is wrong. Nothing is lost by refusing — the journal keeps growing, and
 * growing is recoverable.
 */
export function truncateJournal(id) {
  assertDocId(id);
  return queue(id, () => truncateJournalFile(id));
}

async function truncateJournalFile(id) {
  assertReadable(id); // an early-out; the gate below is the guard
  const state = ioFor(id);
  // No snapshot of this process covers what is in the file, so there is nothing this call
  // may safely delete. It returns rather than throwing: the caller has done nothing wrong
  // — a compaction whose snapshot failed is exactly this — and a journal left holding
  // records the next compaction will fold in again costs disk, where emptying it costs
  // work. The quarantine is checked ABOVE this, so a refused document still rejects.
  if (!state.snapshotMark) return;
  const handle = state.handle;
  state.handle = null;
  state.dirty = false;
  if (handle) {
    try {
      await handle.close();
    } catch (err) {
      // The bytes are already in the snapshot that was just renamed into place; a handle
      // that will not close cannot take them back.
      console.warn(`[시트지] 저널 파일을 닫지 못했습니다 (${id}): ${err && err.message}`);
    }
  }
  // Closing the handle above is an await, and a read that fails during it means records
  // this process never saw are in this file and in no snapshot. The gate re-checks with
  // nothing between it and the syscall, so that await cannot open a window; closing the
  // handle costs nothing either way — the next append reopens it and re-runs the torn-tail
  // guard — where truncating would cost everything.
  await mutate(id, 'truncate', { path: journalPath(id) }).catch(ignoreMissing);
  // Only now, with the file actually emptied, is the mark spent. A failed truncate keeps
  // it, so the next compaction's truncate is the one that clears these records.
  state.snapshotMark = false;
}

// Sync and close this document's journal handle. Cancelling the timer first stops a
// pending fsync from re-opening nothing; the sync-then-clear-then-close order is
// discardHandle's, and it is the same order for the same reason — the flag may only be
// cleared once the bytes it stands for have had their chance to reach the disk.
async function closeJournal(id) {
  const state = io.get(id);
  if (!state) return;
  if (state.fsyncTimer) {
    clearTimeout(state.fsyncTimer);
    state.fsyncTimer = null;
  }
  await discardHandle(id, state);
}

// ---------------------------------------------------------------------------
// snapshots and backups
// ---------------------------------------------------------------------------

/**
 * Keep BACKUP_COUNT previous snapshots (SPEC 27.2): <id>.bak.1 is the one this save is
 * replacing, <id>.bak.5 the oldest still kept.
 *
 * Every step is a rename, so a rotation costs metadata operations rather than a copy of
 * the whole document — a save during fast typing must not stall behind a megabyte memcpy.
 * Rotation is best-effort: a failure is logged and never blocks the save. The one instant
 * it leaves <id>.json missing is covered by loadDoc, which falls back to <id>.bak.1 —
 * exactly the snapshot the journal was last truncated against.
 */
async function rotateBackups(id) {
  try {
    await mutate(id, 'unlink', { path: backupPath(id, BACKUP_COUNT) }).catch(ignoreMissing);
    for (let index = BACKUP_COUNT - 1; index >= 1; index--) {
      await mutate(id, 'rename', {
        from: backupPath(id, index),
        to: backupPath(id, index + 1),
      }).catch(ignoreMissing);
    }
    await mutate(id, 'rename', { from: docPath(id), to: backupPath(id, 1) }).catch(ignoreMissing);
  } catch (err) {
    // Best-effort covers a rotation that could not be done. It does not cover a rotation
    // that must not be done: a quarantine landing mid-ring is the caller's business, and
    // swallowing it here would let writeSnapshot go on to rename the temporary into place
    // believing the ring behind it was merely untidy. That is precisely the window that
    // installed a snapshot over an unread document three rounds ago.
    if (isUnread(err)) throw err;
    console.warn(`[시트지] 백업 회전 실패 (${id}): ${err && err.message}`);
  }
}

/**
 * Write the snapshot (SPEC 27.1). It is no longer the source of truth; it is a compaction
 * of the journal, and the order below is the whole point:
 *
 *   1. serialise the document — synchronously, so the payload names one exact `rev`;
 *   2. write and FSYNC the temporary file, so the snapshot is real on disk before
 *      anything is allowed to depend on it;
 *   3. rotate the previous snapshot out of the way (best effort);
 *   4. rename the temporary into place — atomic.
 *
 * Truncating the journal is step 5 and is a separate call, made by the caller only after
 * this one resolved. Every append for this document is queued on the same chain as this
 * snapshot, so none can land in the MIDDLE of it — but the chain is free between step 4
 * and step 5, which are two separate tasks, and a record appended in that gap would once
 * have been emptied away by a truncate that believed this snapshot covered it. What stops
 * that is the mark this step publishes and an append clears: a record written after step 1
 * either lands after step 5 into the empty file, or lands before it and cancels it. It is
 * never truncated away, and that no longer depends on the caller's timing.
 *
 * It REJECTS for a quarantined document (SPEC 27.6). A snapshot is an overwrite: it moves
 * the file this process could not read down the backup ring and installs a document built
 * without whatever that file held. Refusing here is also what makes the quarantine
 * stateless — with no snapshot written, the on-disk rev cannot advance past the unread
 * records, so the next boot either reads them and replays them correctly or fails again.
 */
export function saveSnapshot(id, doc) {
  assertDocId(id);
  return queue(id, () => writeSnapshot(id, doc));
}

async function writeSnapshot(id, doc) {
  assertReadable(id); // an early-out; every step below is gated individually
  const target = docPath(id);
  const tmp = `${target}.tmp`;
  // Serialised BEFORE the backup ring turns, and refused rather than written when it
  // cannot be. `JSON.stringify` answers `undefined` for a value it cannot represent, and
  // interpolating that would put the nine letters `undefined` into <id>.json — a snapshot
  // that parses as nothing — with rotation having already moved the good copy down the
  // ring. The Supabase store refuses the same input, so this is the interface's answer
  // rather than this backend's (SPEC 29.1). Rejecting costs one save, which the caller
  // retries on the next debounce with the journal still holding every record.
  const payload = !doc || typeof doc !== 'object' || Array.isArray(doc)
    ? undefined
    : JSON.stringify(doc);
  if (typeof payload !== 'string') {
    throw new Error(`${id}: 스냅숏으로 만들 수 없는 문서라 저장하지 않았습니다.`);
  }

  try {
    let handle = null;
    try {
      try {
        handle = await mutate(id, 'open', { path: tmp, flags: 'w' });
      } catch (err) {
        // Refused after the open succeeded: the file is open, so it is handed to the
        // `finally` below to be closed rather than leaked.
        handle = orphanOf(err);
        throw err;
      }
      await mutate(id, 'writeFile', { handle, text: payload });
      await handle.sync();
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* the bytes are already synced; a failed close cannot unwrite them */
        }
      }
    }
  } catch (err) {
    // The temporary holds a PREFIX of the document. Nothing promotes a tmp without
    // rewriting it first, so it cannot be mistaken for a snapshot by this process — but a
    // half-written document sitting next to the real one is a trap for whoever looks at
    // data/ next, and the next save would have to truncate it anyway. Removing it is
    // best-effort and must not mask the failure that got us here.
    await removeQuietly(id, tmp);
    throw err;
  }
  // From here the temporary is COMPLETE and fsynced, so it is left alone on failure: if
  // the rename below fails after rotateBackups moved <id>.json aside, that file is the
  // newest copy on disk and is worth more as a recovery artifact than as tidiness. The
  // journal is untouched either way — the caller truncates it only once this resolves —
  // so loadDoc's fallback to <id>.bak.1 plus replay still reproduces the live state.
  //
  // There is no hand-placed re-check here any more, and its absence is the fix rather
  // than a regression. One stood exactly here and was still wrong: it passed, and then
  // `await rotateBackups(id)` ran a ring of renames and `rename(tmp, target)` installed
  // the snapshot with nothing asked in between — verified against a real EPERM, with the
  // journal left holding acknowledged records the new `rev` makes unreplayable. Both steps
  // now go through the gate, which asks immediately before each syscall and again after
  // it, so there is no gap left for a check to be placed in front of.
  await rotateBackups(id);
  await mutate(id, 'rename', { from: tmp, to: target });
  // Only now, with the snapshot actually in place, may the journal behind it be emptied.
  // Published last and never earlier: a mark set before the rename would licence a
  // truncate against a snapshot that never landed.
  ioFor(id).snapshotMark = true;
}

/**
 * Remove a scratch file, best-effort.
 *
 * It must never mask the failure that brought the caller here, so nothing is rethrown —
 * not even the gate's refusal. For a quarantined document the gate declines outright,
 * which is the safe direction twice over: a temporary is not stored state, and leaving one
 * behind costs an untidy directory where removing something under a quarantine costs the
 * one guarantee this file exists to keep.
 */
async function removeQuietly(id, path) {
  try {
    await mutate(id, 'unlink', { path });
  } catch (err) {
    // A quarantine here is expected and already explained by the line that set it; saying
    // it again per save would bury the one message the operator has to act on.
    if (isUnread(err)) return;
    if (err && err.code !== 'ENOENT') {
      console.warn(`[시트지] 임시 파일을 지우지 못했습니다 (${path}): ${err.message}`);
    }
  }
}

/**
 * What SPEC 27.2 kept, newest first. <id>.bak.1 is the snapshot the most recent save
 * replaced, so a regretted bulk edit or a corrupt write is recoverable by hand: the list
 * says what exists, when it was written and how big it is.
 */
export async function listBackups(id) {
  assertDocId(id);
  const backups = [];
  for (let index = 1; index <= BACKUP_COUNT; index++) {
    const file = backupPath(id, index);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      backups.push({
        index,
        name: `${id}.bak.${index}`,
        at: Math.round(info.mtimeMs),
        size: info.size,
      });
    } catch (err) {
      // ENOENT is ABSENT: that slot in the ring really is empty, and leaving it out of the
      // list says so. Every other errno is a backup that EXISTS and could not be looked at,
      // and dropping it silently would tell somebody recovering a regretted bulk edit by
      // hand that a copy they still have is gone — SPEC 27.6's one forbidden collapse, in
      // the very list a person reads while deciding what to restore. The Supabase store
      // already fails the whole list when its query fails; this is the same answer.
      //
      // It quarantines nothing. Listing is read-only, it reads no document's stored state,
      // and SPEC 29.1 keeps listBackups working for a quarantined document.
      if (!err || err.code !== 'ENOENT') {
        const detail = err && err.message ? err.message : String(err);
        console.warn(`[시트지] 백업 정보를 읽지 못했습니다 (${file}): ${detail}`);
        throw new Error(
          `${id}: 백업 ${index}번을 읽지 못해 백업 목록을 만들지 못했습니다 (${detail}).`,
        );
      }
    }
  }
  return backups;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/**
 * Every document id data/ holds something for — a snapshot, a journal, or only a backup.
 * A journal with no snapshot is a real state (a crash before the first compaction, or a
 * snapshot caught between the two renames inside rotateBackups), and it must still load.
 *
 * A directory that could not be READ throws (SPEC 29.1). An empty list is a fact — there
 * are no documents — and boot acts on it: it loads nothing and mints a starter document. A
 * data/ that is merely unreadable would make every document invisible at once and invite
 * new ones on top of them, which is the same lie as an empty journal at a larger scale.
 * ENOENT alone stays an empty list: a data/ that does not exist yet really is empty, and
 * init() is about to create it.
 */
export async function listDocIds() {
  let files = [];
  try {
    files = readdirSync(DATA_DIR);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      const detail = err && err.message ? err.message : String(err);
      const failure = new Error(
        `data 디렉터리를 읽지 못했습니다 (${detail}). 문서가 없는 것인지 못 읽은 것인지 알 수 없어 중단합니다.`,
      );
      failure.code = UNREAD_CODE;
      failure.cause = err;
      throw failure;
    }
    return [];
  }
  const ids = new Set();
  for (const file of files) {
    let id = null;
    if (file.endsWith('.json')) id = file.slice(0, -'.json'.length);
    else if (file.endsWith('.log')) id = file.slice(0, -'.log'.length);
    else {
      const match = /^(.+)\.bak\.\d+$/.exec(file);
      if (match) id = match[1];
    }
    if (id === null) continue; // .tmp leftovers and anything else: not a document
    if (!DOC_ID_RE.test(id)) {
      console.warn(`[시트지] 문서 파일 이름이 올바르지 않아 건너뜁니다: ${file}`);
      continue;
    }
    ids.add(id);
  }
  return [...ids];
}

/**
 * The newest readable snapshot for a document: <id>.json, else the backups newest-first
 * (SPEC 27.2). The fallback is what makes the one instant inside rotateBackups harmless —
 * <id>.bak.1 is precisely the snapshot the journal was last truncated against, so
 * replaying the journal on top of it reproduces the live state exactly.
 *
 * That instant is an ENOENT, and ENOENT is the ONLY missing-file case the fallback was ever
 * for. The scan therefore stops dead at the first file it could not READ (SPEC 27.6): for
 * any other errno the file exists and is the newest state, and stepping over it to an older
 * backup is a silent rollback — the caller sees `fromBackup` and rewrites, rotation renames
 * the good copy down the ring, and a few saves later it falls off the end. A file that is
 * merely CORRUPT is still stepped over exactly as before: its bytes were read in full, so
 * we know what it holds and know it is useless.
 *
 * Returns `{ doc, fromBackup, raw }`, or null when nothing readable exists. `raw` is the
 * parsed file BEFORE sanitizeDoc, which is how the caller can tell that what is on disk is
 * an older document shape and has to be rewritten once (SPEC 10, legacy migration).
 */
export async function loadDoc(id) {
  assertDocId(id);
  assertReadable(id);
  const files = [docPath(id)];
  for (let index = 1; index <= BACKUP_COUNT; index++) files.push(backupPath(id, index));
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        throw markUnread(id, i === 0 ? '문서 파일' : `백업 ${i}번`, err);
      }
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      // An ARRAY is CORRUPT, and the refusal has to be HERE because nothing below makes
      // it: sanitizeDoc rejects only null and non-objects (shared/model.js), and
      // `typeof [] === 'object'`, so an array walks straight through and comes back a
      // brand-new EMPTY document — served as CURRENT, with fromBackup false, no warning,
      // and the backup ring never consulted. server.js then saves that empty document on
      // its next debounce, and BACKUP_COUNT saves later every real generation has been
      // rotated off the ring: the loss is silent, complete and self-inflicted. The
      // Supabase store refuses the same value at the same point (`toDoc`), and SPEC 29.1
      // is explicit that a caller must get the same answer whichever backend it is
      // pointed at. Neither store ever WRITES an array, so one on disk arrived from
      // outside — a hand edit, a restore, another tool — which is exactly what the CORRUPT
      // path is for. Thrown inside this `try` so it falls through to the next backup the
      // way damaged bytes do, warning and all.
      if (Array.isArray(parsed)) throw new Error('문서가 객체가 아니라 배열입니다');
      // sanitizeDoc is where v1 -> v2 migration happens, and it is idempotent.
      const doc = sanitizeDoc(parsed);
      doc.id = id; // the file name is authoritative
      if (i > 0) console.warn(`[시트지] ${id}: 스냅숏 대신 백업 ${i}번을 사용합니다.`);
      return { doc, fromBackup: i > 0, raw: parsed };
    } catch (err) {
      console.warn(`[시트지] 손상된 문서 파일을 건너뜁니다: ${file} (${err && err.message})`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** data/ is created at boot if missing (SPEC 11). */
export async function init() {
  await mkdir(DATA_DIR, { recursive: true });
}

/**
 * Everything this document owned: the snapshot, the half-written temporary, the journal
 * and every backup. Leaving the journal behind would resurrect the document on the next
 * boot, which is the opposite of what DELETE promised.
 *
 * Whatever is already queued is allowed to finish first, and the append handle is closed
 * before its file is unlinked.
 *
 * It REJECTS for a quarantined document (SPEC 27.6). Deleting is the most final thing here,
 * and a document nobody has been able to read is the one nobody can judge: the person
 * asking may well be asking BECAUSE it looked broken. A restart makes it readable again, or
 * proves it is not; either way the decision is then made with the contents in view.
 */
export async function deleteDoc(id) {
  assertDocId(id);
  // An early-out, so a document already quarantined is refused without queuing anything.
  // It is not the guard; the guard is inside the task, where the answer is still current.
  assertReadable(id);
  await queue(id, async () => {
    // Another early-out: a quarantine can land while this call waits on the chain — a
    // concurrent readJournal or loadDoc failing is exactly that. What makes the unlinks
    // themselves safe is the gate, which re-checks immediately before each one, so closing
    // the journal handle below cannot open a window between the decision and the deletion.
    assertReadable(id);
    // Whatever snapshot licenced a truncate is one of the files about to go, so the mark
    // goes with it rather than outliving it for an id that is reused.
    ioFor(id).snapshotMark = false;
    await closeJournal(id);

    const target = docPath(id);
    const victims = [target, `${target}.tmp`, journalPath(id)];
    for (let index = 1; index <= BACKUP_COUNT; index++) victims.push(backupPath(id, index));
    for (const file of victims) {
      try {
        await mutate(id, 'unlink', { path: file });
      } catch (err) {
        // A quarantine stops the whole delete rather than one file of it. Logging and
        // carrying on would remove the rest of a document nobody has managed to read,
        // which is the one outcome SPEC 27.6 forbids outright.
        if (isUnread(err)) throw err;
        if (err && err.code !== 'ENOENT') {
          console.warn(`[시트지] 문서 파일 삭제 실패 (${file}): ${err.message}`);
        }
      }
    }
  });
  // The io entry is deliberately KEPT — `closeJournal` has already emptied the parts of it
  // that hold an open file, and what is left is the chain and the quarantine record.
  //
  // Dropping it did two things, both bad. It discarded `unread`, so a delete that reached
  // this line LIFTED the quarantine: the next appendJournal for the same id saw a clean
  // state, recreated the journal and answered `true`, claiming durability for a document
  // nothing had read. And it let a later operation for this id start on a FRESH chain and
  // overlap with one still queued behind this delete. An empty map entry costs a few bytes
  // per document ever deleted in this process; both of those cost data.
}

/**
 * Before a clean exit (SPEC 27.1): always fsync, then close the handles.
 *
 * A journal can still hold acknowledged bytes for a document nothing scheduled a save for
 * — its compaction already ran, then one more edit arrived — so every open journal is
 * synced here, not only the ones a pending save would have compacted.
 */
export async function flush() {
  // Repeated until a pass adds nothing new. `state.chain` is read at the moment the map
  // below is built, so a save or an append arriving DURING the await is not covered by it
  // — and server.js is still accepting frames until its socket closes. A single pass would
  // then close the handles under those bytes, leaving a record that was acknowledged as
  // durable never fsynced, which is the one thing this call exists to prevent. The counter
  // is what tells the two cases apart; the bound stops a client that never stops typing
  // from holding the shutdown open for ever.
  let settled = false;
  for (let pass = 0; pass < 20 && !settled; pass++) {
    for (const id of [...io.keys()]) enqueue(id, () => syncJournal(id), '저널 동기화');
    const before = queuedTotal;
    await Promise.all([...io.values()].map((state) => state.chain));
    settled = queuedTotal === before;
  }
  if (!settled) {
    console.warn('[시트지] 저장 작업이 계속 추가되어 종료 전 정리를 20회에서 멈춥니다.');
  }
  await Promise.all([...io.keys()].map((id) => closeJournal(id)));
}
