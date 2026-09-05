// test/unread.test.js — a read that FAILED is never an empty document (SPEC 27.6, 29.1, 29.2).
//
// THE FAILURE THESE CASES PIN DOWN
//
// A filesystem answers a read with three different things, and storage/fileStore.js used
// to collapse them into two:
//
//   ABSENT   ENOENT. Nothing is stored. Create it, serve it empty, carry on.
//   CORRUPT  the bytes arrived IN FULL and will not parse. Fall back to a backup, count
//            the bad lines, carry on — we have SEEN the damage.
//   UNREAD   EACCES, EPERM, EIO, EBUSY, EISDIR, ERR_FS_FILE_TOO_LARGE. The data IS there
//            and this process failed to see it.
//
// Filed as ABSENT, an unreadable journal reads as "no records": boot serves the document
// at the snapshot's rev while the acknowledged records sit unread in the log, new edits
// mint revisions that collide with them, and the next compaction truncates them away.
// Filed as CORRUPT, an unreadable `<id>.json` reads as "damaged snapshot": an older
// backup is substituted for a file that was merely busy, and the save that follows rotates
// the good copy down the backup ring until it drops off the end. Both destroy data the
// process never once looked at, and both look like ordinary recovery in the log.
//
// So the property is not "it logs a warning". It is:
//
//   > A document whose stored state could not be READ is never served for editing, never
//   > replayed against, never truncated, and never overwritten.
//
// WHY THE FILES ARE MADE UNREADABLE FOR REAL
//
// test/unreadable.js denies the operating system's read permission on one real file and
// verifies the denial took. Nothing else would do: `readFileSync` is a named import from a
// builtin, so there is no binding a test could swap, and a fake would only prove the store
// copes with a fake. What has to be proven is the behaviour on a real errno — and, in
// tools/crash.mjs, on the errno a DIFFERENT process gets across a real restart.
//
// A NOTE ON THE IDS BELOW
//
// The quarantine of SPEC 27.6 is per document and is never lifted inside a process, which
// is the point of it. Every case therefore uses an id of its own, so one quarantine cannot
// decide the next case's answer — and a quarantined document is torn down with plain fs
// calls, because refusing `deleteDoc` is one of the things it is being tested for. A case
// that could clean up through the store would be a case whose subject was never really
// quarantined.

import { test, eq } from './run.js';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowReads, denyReads, readErrorCode } from './unreadable.js';
import { emptyDoc, sanitizeDoc } from '../shared/model.js';
import * as fileStore from '../storage/fileStore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const BACKUP_COUNT = 5; // mirrors storage/fileStore.js

const docPath = (id) => join(DATA, `${id}.json`);
const journalPath = (id) => join(DATA, `${id}.log`);
const backupPath = (id, n) => join(DATA, `${id}.bak.${n}`);

/** Every file one document can own, in the order the store itself lists them. */
function ownedPaths(id) {
  const paths = [docPath(id), `${docPath(id)}.tmp`, journalPath(id)];
  for (let n = 1; n <= BACKUP_COUNT; n++) paths.push(backupPath(id, n));
  return paths;
}

/**
 * Remove every trace of a synthetic document, releasing any denial first.
 *
 * Denials are released before the unlink and again afterwards because a denied file can be
 * RENAMED: that is exactly the damage these cases are about, so a broken store may have
 * moved the file down the backup ring, and the cleanup has to find it wherever it went.
 */
function scrub(id) {
  for (const path of ownedPaths(id)) allowReads(path);
  for (const path of ownedPaths(id)) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* nothing to remove */
    }
  }
}

/**
 * Let the store close its own handles, then scrub whatever is left.
 *
 * For a document that is NOT quarantined this is the honest teardown: `deleteDoc` drains
 * that document's queue and closes its append handle, which `rmSync` alone cannot do. A
 * quarantined document refuses to be deleted — that is the contract — so the refusal is
 * swallowed and `scrub` finishes the job.
 */
async function dispose(id) {
  try {
    await fileStore.deleteDoc(id);
  } catch {
    /* quarantined: refusing to delete is exactly what it is supposed to do */
  }
  scrub(id);
}

/** A well-formed snapshot for `id` with one cell set, serialised exactly as the store writes it. */
function snapshotBytes(id, input, rev) {
  const doc = emptyDoc(id, '읽기 실패 시험');
  doc.sheets[0].cells.A1 = { input };
  doc.rev = rev;
  return JSON.stringify(sanitizeDoc(doc));
}

/** One journal line, the shape SPEC 27.1 writes. */
function journalLine(sheetId, a1, input, rev) {
  return `${JSON.stringify({ t: 'edit', sheetId, cells: { [a1]: { input } }, rev, at: 1730000000000 + rev })}\n`;
}

/** The sheet id inside a snapshot's bytes, so a journal line can name the same sheet. */
function sheetIdOf(bytes) {
  return JSON.parse(bytes).sheets[0].id;
}

/** Await a promise and report how it settled, without letting a rejection escape. */
async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, error: err };
  }
}

const UNREAD = 'ESTOREUNREAD';

// ---------------------------------------------------------------------------
// (a) an unreadable journal is not an empty one
// ---------------------------------------------------------------------------

test('fileStore: an unreadable journal REJECTS instead of reading as an empty one', async () => {
  const id = 'zzunreadlog';
  scrub(id);
  await fileStore.init();

  const snapshot = snapshotBytes(id, '스냅숏에 있던 값', 4);
  const sheetId = sheetIdOf(snapshot);
  const journal = journalLine(sheetId, 'B1', '저널에만 있는 값', 5)
    + journalLine(sheetId, 'C1', '저널에만 있는 값 둘', 6);

  try {
    writeFileSync(docPath(id), snapshot, 'utf8');
    writeFileSync(journalPath(id), journal, 'utf8');

    const injected = denyReads(journalPath(id));
    eq(injected !== 'ENOENT', true, 'the injection must be a read failure, not a missing file');

    const read = await settle(fileStore.readJournal(id));
    eq(read.ok, false,
      `an unreadable journal must never resolve — it resolved ${JSON.stringify(read.value)}`);
    eq(read.error.code, UNREAD, `the rejection must carry code ${UNREAD}`);
    eq(read.error.docId, id, 'the rejection must name the document');
    eq(!!read.error.cause, true, 'the underlying errno must survive the wrapping');

    // The quarantine covers the DOCUMENT, not the one file that failed. `<id>.json` is
    // perfectly readable here and must still not be served: serving it would advance a rev
    // past records nobody has read, which is precisely how the earlier guard handed the
    // deletion to the next boot.
    const load = await settle(fileStore.loadDoc(id));
    eq(load.ok, false, 'a document with an unreadable journal must not be served for editing');
    eq(load.error.code, UNREAD);

    // The three calls that can overwrite or destroy what was never read.
    const saved = await settle(fileStore.saveSnapshot(id, JSON.parse(snapshot)));
    eq(saved.ok, false, 'saveSnapshot must refuse for a quarantined document');
    eq(saved.error.code, UNREAD);

    const truncated = await settle(fileStore.truncateJournal(id));
    eq(truncated.ok, false, 'truncateJournal must refuse — this is the step that destroys records');
    eq(truncated.error.code, UNREAD);

    const deleted = await settle(fileStore.deleteDoc(id));
    eq(deleted.ok, false, 'deleteDoc must refuse for a document nobody has been able to read');
    eq(deleted.error.code, UNREAD);

    // Appending is the one refusal that is a value rather than a throw: `false` is the
    // existing "not durable" answer, so the ack is withheld and the client keeps the frame.
    const appended = await fileStore.appendJournal(id, {
      t: 'edit', sheetId, cells: { D1: { input: '거절되어야 함' } }, rev: 7, at: 1730000000007,
    });
    eq(appended, false, 'a quarantined document must never acknowledge a new record');

    // Nothing on disk moved. That is what makes the in-memory quarantine safe to lose on a
    // restart: the next boot reads the very same bytes and re-derives the same answer.
    allowReads(journalPath(id));
    eq(readFileSync(journalPath(id), 'utf8'), journal,
      'the journal must be byte-for-byte what it was — not truncated, not appended to');
    eq(readFileSync(docPath(id), 'utf8'), snapshot,
      'the snapshot must be byte-for-byte what it was — not overwritten');
    eq(existsSync(backupPath(id, 1)), false, 'nothing may have been rotated into a backup');

    // And the quarantine does not lift just because the file became readable again. Lifting
    // it inside the process is what turned the previous guard into the deletion it was
    // meant to prevent; a restart re-derives it from the disk for free.
    const again = await settle(fileStore.readJournal(id));
    eq(again.ok, false, 'a quarantine is never lifted inside the process, not even by a good read');
    eq(again.error.code, UNREAD);
  } finally {
    scrub(id);
  }
});

// ---------------------------------------------------------------------------
// (c) an unreadable snapshot is not a corrupt one
// ---------------------------------------------------------------------------

test('fileStore: an unreadable <id>.json is never silently replaced by <id>.bak.1', async () => {
  const id = 'zzunreadjson';
  scrub(id);
  await fileStore.init();

  // The newest state is in `<id>.json`; `<id>.bak.1` is the snapshot it replaced. Falling
  // through to the backup would be a silent rollback of everything between the two.
  const newer = snapshotBytes(id, '최신 스냅숏', 9);
  const older = snapshotBytes(id, '예전 백업', 3);

  try {
    writeFileSync(docPath(id), newer, 'utf8');
    writeFileSync(backupPath(id, 1), older, 'utf8');

    denyReads(docPath(id));

    const load = await settle(fileStore.loadDoc(id));
    eq(load.ok, false,
      'the scan must stop at the file it could not read — it returned '
      + JSON.stringify(load.value && load.value.doc && load.value.doc.sheets[0].cells.A1));
    eq(load.error.code, UNREAD);
    eq(load.error.docId, id);

    // The damage was never the substitution on its own: it was the SAVE that followed.
    // `fromBackup` makes server.js rewrite immediately, rotation renames the good copy to
    // .bak.1, and five more saves push it off the end of the ring. Refusing the snapshot is
    // what stops the ring from ever turning.
    const saved = await settle(fileStore.saveSnapshot(id, JSON.parse(older)));
    eq(saved.ok, false, 'a snapshot must never be written over a file this process could not read');
    eq(saved.error.code, UNREAD);

    // The FILE, not the API. This is the assertion the earlier attempt would have failed.
    allowReads(docPath(id));
    eq(readFileSync(docPath(id), 'utf8'), newer,
      'the newest snapshot must still be at <id>.json, holding exactly the bytes it held');
    eq(readFileSync(backupPath(id, 1), 'utf8'), older,
      '<id>.bak.1 must still be the older snapshot — nothing was rotated');
    eq(existsSync(backupPath(id, 2)), false, 'the backup ring must not have turned at all');
  } finally {
    scrub(id);
  }
});

// ---------------------------------------------------------------------------
// (d) ABSENT and CORRUPT keep exactly the behaviour they had
// ---------------------------------------------------------------------------
//
// The risk in narrowing what counts as recoverable is over-refusing: a server that
// quarantines documents that are merely absent or repairable is an outage dressed up as
// caution. These cases hold the other side of the line.

test('fileStore: a journal that is simply not there is still an empty one (ABSENT)', async () => {
  const id = 'zzabsentlog';
  scrub(id);
  await fileStore.init();
  try {
    eq(readErrorCode(journalPath(id)), 'ENOENT', 'the case needs the file to really be missing');
    const read = await fileStore.readJournal(id);
    eq(read, { records: [], badLines: 0 }, 'ENOENT is the ordinary "no journal yet"');

    // And nothing was quarantined by it: the document is still fully usable.
    const doc = sanitizeDoc(JSON.parse(snapshotBytes(id, '평범한 문서', 1)));
    await fileStore.saveSnapshot(id, doc);
    const loaded = await fileStore.loadDoc(id);
    eq(loaded.doc.sheets[0].cells.A1.input, '평범한 문서');
    eq(loaded.fromBackup, false);
    eq(await fileStore.appendJournal(id, {
      t: 'edit', sheetId: loaded.doc.sheets[0].id, cells: { B2: { input: '이어서' } }, rev: 2, at: 1730000000002,
    }), true, 'an absent journal must not stop the next append being durable');
  } finally {
    await dispose(id);
  }
});

test('fileStore: a document that is simply not stored is still null (ABSENT)', async () => {
  const id = 'zzabsentdoc';
  scrub(id);
  await fileStore.init();
  try {
    eq(await fileStore.loadDoc(id), null, 'nothing stored means null, not a rejection');
  } finally {
    scrub(id);
  }
});

test('fileStore: journal lines that will not parse are still counted, never fatal (CORRUPT)', async () => {
  const id = 'zzcorruptlog';
  scrub(id);
  await fileStore.init();

  const snapshot = snapshotBytes(id, '기준 스냅숏', 1);
  const sheetId = sheetIdOf(snapshot);
  // A whole record, a line of garbage, a second whole record, and the half-written final
  // line a process killed mid-write actually leaves.
  const journal = journalLine(sheetId, 'B1', '멀쩡한 기록', 2)
    + '%%% 이것은 JSON 이 아닙니다 %%%\n'
    + journalLine(sheetId, 'C1', '그다음 기록', 3)
    + '{"t":"edit","sheetId":"' + sheetId + '","cells":{"D1":{"inp';

  try {
    writeFileSync(docPath(id), snapshot, 'utf8');
    writeFileSync(journalPath(id), journal, 'utf8');

    const read = await fileStore.readJournal(id);
    eq(read.records.length, 2, 'every record that parsed must come back');
    eq(read.records.map((r) => Object.keys(r.cells)[0]), ['B1', 'C1']);
    eq(read.badLines, 2, 'the garbage line and the torn tail are counted, not fatal');

    // Bytes we have SEEN are not a quarantine: the document goes on working.
    const load = await fileStore.loadDoc(id);
    eq(load.doc.sheets[0].cells.A1.input, '기준 스냅숏');
    eq(load.fromBackup, false);
    const saved = await settle(fileStore.saveSnapshot(id, load.doc));
    eq(saved.ok, true, 'a corrupt journal line must not stop the document being compacted');
    const truncated = await settle(fileStore.truncateJournal(id));
    eq(truncated.ok, true, 'nor stop the truncate that follows the snapshot');
  } finally {
    await dispose(id);
  }
});

test('fileStore: a <id>.json whose bytes will not parse still falls through to the backup (CORRUPT)', async () => {
  const id = 'zzcorruptjson';
  scrub(id);
  await fileStore.init();

  const older = snapshotBytes(id, '백업에 있는 값', 2);
  try {
    // Read in full, and useless. We know what it holds, so stepping over it is safe.
    writeFileSync(docPath(id), '{ 이건 JSON 이 아니고 ', 'utf8');
    writeFileSync(backupPath(id, 1), older, 'utf8');

    const load = await fileStore.loadDoc(id);
    eq(load !== null, true, 'a damaged snapshot must still recover from its backup');
    eq(load.doc.sheets[0].cells.A1.input, '백업에 있는 값');
    eq(load.fromBackup, true, 'and must say the backup is where it was recovered');

    // Not quarantined: the rewrite server.js schedules for a fromBackup load has to work,
    // or a repairable document would become a permanent outage.
    const saved = await settle(fileStore.saveSnapshot(id, load.doc));
    eq(saved.ok, true, 'a corrupt snapshot must not block the rewrite that repairs it');
    eq(JSON.parse(readFileSync(docPath(id), 'utf8')).sheets[0].cells.A1.input, '백업에 있는 값');
  } finally {
    await dispose(id);
  }
});

test('fileStore: an ENOENT <id>.json falls through to the backup — the rotateBackups window (ABSENT)', async () => {
  const id = 'zzrotatewindow';
  scrub(id);
  await fileStore.init();

  const older = snapshotBytes(id, '회전 중의 백업', 5);
  try {
    // Exactly the one instant inside rotateBackups: `<id>.json` has been renamed away and
    // the temporary is not yet in its place. `<id>.bak.1` is the snapshot the journal was
    // last truncated against, so this fallback is not merely safe, it is exact.
    eq(existsSync(docPath(id)), false);
    writeFileSync(backupPath(id, 1), older, 'utf8');

    const load = await fileStore.loadDoc(id);
    eq(load !== null, true, 'the rotation window must stay recoverable');
    eq(load.doc.sheets[0].cells.A1.input, '회전 중의 백업');
    eq(load.fromBackup, true);
  } finally {
    await dispose(id);
  }
});

test('fileStore: one unreadable document is not an outage for any other', async () => {
  // SPEC 27.6: the quarantine takes ONE document out of service. A store that answered a
  // single permission error by refusing everything would be a worse failure than the one
  // it is guarding against.
  const broken = 'zzoutagebroken';
  const healthy = 'zzoutagehealthy';
  scrub(broken);
  scrub(healthy);
  await fileStore.init();

  const snapshot = snapshotBytes(broken, '못 읽는 문서', 1);
  const sheetId = sheetIdOf(snapshot);
  try {
    writeFileSync(docPath(broken), snapshot, 'utf8');
    writeFileSync(journalPath(broken), journalLine(sheetId, 'B1', '읽지 못한 기록', 2), 'utf8');
    denyReads(journalPath(broken));

    const failed = await settle(fileStore.readJournal(broken));
    eq(failed.ok, false, 'the broken document must be quarantined for the case to mean anything');

    const doc = sanitizeDoc(JSON.parse(snapshotBytes(healthy, '멀쩡한 문서', 1)));
    await fileStore.saveSnapshot(healthy, doc);
    eq(await fileStore.appendJournal(healthy, {
      t: 'edit', sheetId: doc.sheets[0].id, cells: { B1: { input: '계속 동작' } }, rev: 2, at: 1730000000002,
    }), true, 'another document must still be able to acknowledge work');
    const loaded = await fileStore.loadDoc(healthy);
    eq(loaded.doc.sheets[0].cells.A1.input, '멀쩡한 문서');
    const read = await fileStore.readJournal(healthy);
    eq(read.records.length, 1);
    eq((await settle(fileStore.truncateJournal(healthy))).ok, true);
  } finally {
    scrub(broken);
    await dispose(healthy);
  }
});

// A last, blunt guard on the whole file: nothing above may leave a denial behind on the
// data directory. It runs as a registered case so a failure is REPORTED, not printed into
// a log nobody reads.
test('fileStore: the unreadable-file injection left nothing denied behind', () => {
  const ids = ['zzunreadlog', 'zzunreadjson', 'zzabsentlog', 'zzabsentdoc', 'zzcorruptlog',
    'zzcorruptjson', 'zzrotatewindow', 'zzoutagebroken', 'zzoutagehealthy'];
  const left = [];
  for (const id of ids) {
    for (const path of ownedPaths(id)) if (existsSync(path)) left.push(path);
  }
  eq(left, [], `these synthetic files outlived their case: ${left.join(', ')}`);
  eq(existsSync(DATA), true, 'and data/ itself must still be there');
});
