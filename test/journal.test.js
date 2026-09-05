// test/journal.test.js — the file store's journal may never acknowledge a record it
// cannot read back (SPEC 27.1, 29.2).
//
// THE FAILURE THIS PINS DOWN
//
// `FileHandle.write` is one syscall. It can land only part of what it was given, and it
// can fail between one part and the next, so an append can leave a PREFIX of a JSON line
// on disk with no terminating newline. That much is unavoidable and is exactly why the
// append that produced it resolves `false` — the client keeps the frame in its outbox and
// nothing was promised.
//
// The damage is in what happens NEXT. If the cached append handle survives the failure,
// the following record is written straight onto that fragment. The two become one line
// that no parser will ever read — and that second append resolves `true`, so the server
// acknowledges it, the client drops it from its outbox, and the record is gone. One
// unacknowledged edit has quietly become two lost ones, and the loss is invisible until
// somebody reboots.
//
// So the property is: an append that resolves `true` is readable back. Not "usually", not
// "unless the write before it failed". The case below tears a line deliberately — a real
// short write cannot be waited for — and then checks the record that WAS acknowledged.
//
// The injection is a wrapper around `FileHandle.write` that only ever touches a buffer
// carrying this test's own marker, so nothing else running in the same process can be
// caught by it.

import { test, eq } from './run.js';
import { mkdir, open, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fileStore from '../storage/fileStore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

// Real ids, matching the store's own /^[a-z0-9]{6,24}$/, in a shape no document created
// by the app will ever collide with.
const TORN_ID = 'zzjournaltorn';

/** The FileHandle prototype, reached the only way there is: through a real handle. */
async function fileHandlePrototype() {
  await mkdir(DATA, { recursive: true });
  const probe = join(DATA, 'zzjournalprobe.tmp');
  const handle = await open(probe, 'w');
  const proto = Object.getPrototypeOf(handle);
  await handle.close();
  await rm(probe, { force: true });
  return proto;
}

/**
 * Make the next write of a buffer containing `marker` land half of it and then fail.
 *
 * That is precisely a torn line: bytes on disk, no newline, and an error reported to the
 * caller. Buffers without the marker are passed through untouched, so a snapshot or
 * another document's append happening at the same moment is unaffected.
 */
function tearNextWriteOf(proto, marker) {
  const real = proto.write;
  const state = { stage: 0, prefixBytes: 0 };
  proto.write = function patched(...args) {
    const buffer = args[0];
    if (state.stage < 2 && Buffer.isBuffer(buffer) && buffer.includes(marker)) {
      if (state.stage === 0) {
        state.stage = 1;
        const offset = Number.isInteger(args[1]) ? args[1] : 0;
        const length = Number.isInteger(args[2]) ? args[2] : buffer.length - offset;
        const prefix = Math.max(1, Math.floor(length / 2));
        state.prefixBytes = prefix;
        return real.call(this, buffer, offset, prefix, args[3]);
      }
      // The retry of the remainder: the disk went away in the middle of the line.
      state.stage = 2;
      const err = new Error('injected disk failure in the middle of a journal line');
      err.code = 'EIO';
      return Promise.reject(err);
    }
    return real.apply(this, args);
  };
  return {
    state,
    restore() {
      proto.write = real;
    },
  };
}

function journalLines(id) {
  let text;
  try {
    text = readFileSync(join(DATA, `${id}.log`), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line !== '');
}

function parseOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

test('fileStore: an append that fails mid-line never lets the next one be acknowledged onto the fragment', async () => {
  const proto = await fileHandlePrototype();
  await fileStore.init();
  // A leftover from an interrupted earlier run would make this case meaningless.
  await fileStore.deleteDoc(TORN_ID);

  const MARK = 'ZZ-TORN-FIRST';
  const torn = {
    t: 'edit', sheetId: 'sh1a2b', mark: MARK,
    cells: { A1: { input: '찢어질 기록' } }, rev: 1, at: 1730000000000,
  };
  const after = {
    t: 'edit', sheetId: 'sh1a2b', mark: 'ZZ-TORN-SECOND',
    cells: { A2: { input: '그다음 기록' } }, rev: 2, at: 1730000000001,
  };
  const later = {
    t: 'edit', sheetId: 'sh1a2b', mark: 'ZZ-TORN-THIRD',
    cells: { A3: { input: '세 번째 기록' } }, rev: 3, at: 1730000000002,
  };

  try {
    const injection = tearNextWriteOf(proto, MARK);
    let tornAck;
    try {
      tornAck = await fileStore.appendJournal(TORN_ID, torn);
    } finally {
      injection.restore();
    }

    eq(injection.state.stage, 2,
      'the injection never fired, so this case would prove nothing');
    eq(injection.state.prefixBytes > 0, true, 'no prefix was left on disk to tear anything');
    eq(tornAck, false, 'an append whose write failed part-way must never resolve true');

    // The record that IS acknowledged. Everything below is about this one.
    const afterAck = await fileStore.appendJournal(TORN_ID, after);
    eq(afterAck, true, 'the next append must succeed once the disk is working again');

    const lines = journalLines(TORN_ID);
    eq(lines.length, 2,
      `the fragment and the new record must be two lines, not one glued line: ${JSON.stringify(lines)}`);
    const lastRecord = parseOrNull(lines[lines.length - 1]);
    eq(lastRecord !== null, true,
      `the acknowledged record must be a line of its own that parses: ${JSON.stringify(lines[lines.length - 1])}`);
    eq(lastRecord.mark, 'ZZ-TORN-SECOND');
    eq(parseOrNull(lines[0]), null,
      'the first line should be the unparseable fragment the failed write left');

    // The property, stated the way SPEC 27.3 states it: an ack means readable back.
    const read = await fileStore.readJournal(TORN_ID);
    eq(read.records.some((r) => r && r.mark === 'ZZ-TORN-SECOND'), true,
      `the acknowledged record was not readable back: ${JSON.stringify(read)}`);
    eq(read.records.some((r) => r && r.mark === MARK), false,
      'the torn record was never acknowledged, so it must not appear either');
    eq(read.badLines, 1, `exactly the fragment should be skipped: badLines=${read.badLines}`);

    // And the journal keeps working afterwards: the fragment is closed once, not
    // re-closed or re-torn on every later append.
    eq(await fileStore.appendJournal(TORN_ID, later), true);
    const afterThird = await fileStore.readJournal(TORN_ID);
    eq(afterThird.records.map((r) => r.mark), ['ZZ-TORN-SECOND', 'ZZ-TORN-THIRD'],
      'every acknowledged record, in order, and nothing else');
    eq(afterThird.badLines, 1, 'still exactly one bad line — the original fragment');
  } finally {
    await fileStore.deleteDoc(TORN_ID);
  }
});

test('fileStore: every append that resolved true survives a burst with a torn write in it', async () => {
  // The same rule as a property rather than a single case: whatever the disk does, the
  // set of records that can be read back must contain every record that was acknowledged.
  const proto = await fileHandlePrototype();
  await fileStore.init();
  await fileStore.deleteDoc(TORN_ID);

  const MARK = 'ZZ-BURST-TEAR';
  const acknowledged = [];
  try {
    for (let i = 0; i < 8; i++) {
      const mark = i === 3 ? MARK : `ZZ-BURST-${i}`;
      const record = {
        t: 'edit', sheetId: 'sh1a2b', mark,
        cells: { [`A${i + 1}`]: { input: `기록 ${i}` } }, rev: i + 1, at: 1730000000000 + i,
      };
      const injection = i === 3 ? tearNextWriteOf(proto, MARK) : null;
      let ok;
      try {
        ok = await fileStore.appendJournal(TORN_ID, record);
      } finally {
        if (injection) injection.restore();
      }
      if (ok) acknowledged.push(mark);
    }

    eq(acknowledged.length, 7, 'only the torn append should have been refused');
    eq(acknowledged.includes(MARK), false, 'the torn record must not be among the acknowledged');

    const { records } = await fileStore.readJournal(TORN_ID);
    const readable = new Set(records.map((r) => r && r.mark));
    const missing = acknowledged.filter((mark) => !readable.has(mark));
    eq(missing, [], `records were acknowledged and cannot be read back: ${JSON.stringify(missing)}`);
  } finally {
    await fileStore.deleteDoc(TORN_ID);
  }
});
