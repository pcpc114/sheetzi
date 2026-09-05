// test/outbox.test.js — the client outbox (SPEC 27.4).
//
// The outbox is the half of the durability promise that lives in the browser: a frame the
// user typed is written to localStorage BEFORE it is handed to the socket, and it stays
// there until the server says the bytes reached the operating system. Everything worth
// testing about it is therefore about what survives — an ack, a cap, a reload, a storage
// that refuses to store.
//
// public/js/outbox.js imports nothing at all, so unlike print.js and chart.js it loads in
// Node directly; no shim is needed. It touches exactly one ambient global,
// `globalThis.localStorage`, and it takes a `storage` override precisely so a test can
// stand in for it. Both paths are exercised below: the injected stand-in for the bulk of
// the cases, and a real global stub for the one case that has to prove the module finds
// localStorage on its own.
//
// What is asserted here is only what SPEC 27.4 promises:
//   - add() returns a unique opId and persists immediately
//   - pending() preserves the order frames were added in
//   - ack() removes exactly one frame
//   - the cap (MAX_OUTBOX) drops the OLDEST and TELLS somebody
//   - a second Outbox for the same docId picks up what the first persisted
//   - a storage that throws leaves `available === false` and the outbox still works
//
// Nothing here reaches into a private field. The tests drive the class through its public
// surface only, so an implementation that keeps its records differently still passes.

import { test, eq } from './run.js';

import {
  Outbox,
  MAX_OUTBOX,
  OUTBOX_KEY_PREFIX,
  outboxKey,
} from '../public/js/outbox.js';

// ---------------------------------------------------------------------------
// a localStorage stand-in
// ---------------------------------------------------------------------------
//
// The Storage interface the outbox actually uses is three methods over a string->string
// map. This implements exactly that, plus counters, so a test can prove a write happened
// on the add rather than at some later flush — "persists immediately" is the whole claim.

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.reads = 0;
    this.writes = 0;
    this.removes = 0;
  }

  getItem(key) {
    this.reads++;
    const v = this.map.get(String(key));
    return v === undefined ? null : v;
  }

  setItem(key, value) {
    this.writes++;
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.removes++;
    this.map.delete(String(key));
  }

  get length() {
    return this.map.size;
  }

  key(i) {
    return [...this.map.keys()][i] ?? null;
  }

  clear() {
    this.map.clear();
  }
}

/** A storage where every single call throws — private mode with site data blocked. */
class HostileStorage {
  getItem() {
    throw new Error('storage is blocked');
  }

  setItem() {
    throw new Error('storage is blocked');
  }

  removeItem() {
    throw new Error('storage is blocked');
  }
}

/** Reads fine, refuses every write — a full quota, which is the realistic failure. */
class ReadOnlyStorage {
  constructor(seed = new Map()) {
    this.map = seed;
    this.setAttempts = 0;
  }

  getItem(key) {
    const v = this.map.get(String(key));
    return v === undefined ? null : v;
  }

  setItem() {
    this.setAttempts++;
    const err = new Error('QuotaExceededError');
    err.name = 'QuotaExceededError';
    throw err;
  }

  removeItem(key) {
    this.map.delete(String(key));
  }
}

/**
 * Run `fn` with console.warn/error captured, so the cases that deliberately provoke a
 * warning do not scribble over the runner's PASS/FAIL output. Returns what was logged so
 * a test can assert the outbox SPOKE UP — silently dropping work is the one thing SPEC 27
 * forbids outright.
 */
function captureConsole(fn) {
  const lines = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    const value = fn();
    return { value, lines };
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
}

/** A minimal edit frame, the shape main.js actually queues. */
function editFrame(a1, input, sheetId = 'sh1a2b') {
  return { t: 'edit', docId: 'docabc', sheetId, cells: { [a1]: { input } } };
}

/** The inputs of a list of pending frames, in order — what "order preserved" means. */
function inputsOf(frames) {
  return frames.map((f) => Object.values(f.cells)[0].input);
}

// ---------------------------------------------------------------------------
// the key
// ---------------------------------------------------------------------------

test('outbox: the storage key is sz.outbox.<docId> (SPEC 27.4)', () => {
  eq(OUTBOX_KEY_PREFIX, 'sz.outbox.');
  eq(outboxKey('abc123def456'), 'sz.outbox.abc123def456');

  const storage = new MemoryStorage();
  const box = new Outbox('abc123def456', { storage });
  box.add(editFrame('A1', '1'));
  eq(storage.map.has('sz.outbox.abc123def456'), true, 'the frame is stored under the spec key');
});

test('outbox: two documents never share a queue', () => {
  const storage = new MemoryStorage();
  const one = new Outbox('docone', { storage });
  const two = new Outbox('doctwo', { storage });

  one.add(editFrame('A1', '하나'));
  eq(one.size(), 1);
  eq(two.size(), 0, 'the other document sees nothing');

  const reopened = new Outbox('doctwo', { storage });
  eq(reopened.pending(), [], 'and still sees nothing after a reload');
});

// ---------------------------------------------------------------------------
// add() -> a unique opId
// ---------------------------------------------------------------------------

test('outbox: add returns a unique, short, non-empty opId', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });

  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(box.add(editFrame(`A${i + 1}`, String(i))));

  eq(ids.length, 500);
  eq(new Set(ids).size, 500, 'every opId is distinct');
  eq(ids.every((id) => typeof id === 'string' && id.length > 0), true, 'every opId is a non-empty string');
  // The server ignores an opId longer than MAX_OP_ID_LEN (64), so a frame carrying one
  // could never be acknowledged and would sit in the outbox for ever.
  eq(ids.every((id) => id.length <= 64), true, 'every opId fits the server\'s 64-char limit');
});

test('outbox: opIds minted after a reload cannot collide with the reloaded ones', () => {
  const storage = new MemoryStorage();
  const first = new Outbox('docabc', { storage });
  const before = [first.add(editFrame('A1', '1')), first.add(editFrame('A2', '2'))];

  const second = new Outbox('docabc', { storage });
  const after = [second.add(editFrame('A3', '3')), second.add(editFrame('A4', '4'))];

  const all = [...before, ...after];
  eq(new Set(all).size, all.length, 'no reloaded id is minted a second time');
  eq(second.pending().map((f) => f.opId), all, 'every queued frame carries its own opId');
});

test('outbox: the queued frame carries its opId, ready to send as-is', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });
  const id = box.add({ t: 'edit', docId: 'docabc', sheetId: 'sh1', cells: { A1: { input: '5' } } });

  const [frame] = box.pending();
  eq(frame.opId, id, 'pending() hands back something net.send() can use unchanged');
  eq(frame.t, 'edit');
  eq(frame.cells, { A1: { input: '5' } }, 'the frame body is untouched');
});

test('outbox: a frame that already has an opId keeps it (a re-send stays one frame)', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });
  const id = box.add({ ...editFrame('A1', '1'), opId: 'kept42' });
  eq(id, 'kept42', 'the caller\'s opId is reused, not replaced');
  eq(box.has('kept42'), true);
  eq(box.ack('kept42'), true, 'and the server\'s ack for it retires the frame');
});

test('outbox: add rejects a non-frame instead of storing rubbish', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });
  for (const bad of [null, undefined, 'edit', 42, ['edit']]) {
    let threw = false;
    try {
      box.add(bad);
    } catch (e) {
      threw = e instanceof TypeError;
    }
    eq(threw, true, `add(${JSON.stringify(bad) ?? String(bad)}) must throw a TypeError`);
  }
  eq(box.size(), 0);
});

// ---------------------------------------------------------------------------
// pending() preserves order
// ---------------------------------------------------------------------------

test('outbox: pending() returns frames in the order they were added', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });

  const words = ['첫째', '둘째', '셋째', '넷째', '다섯째'];
  for (let i = 0; i < words.length; i++) box.add(editFrame(`A${i + 1}`, words[i]));

  eq(inputsOf(box.pending()), words, 'order is the order they were typed in');
  eq(box.size(), words.length);
  eq(box.length, words.length, 'size() and length agree');
});

test('outbox: order survives an ack in the middle', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });

  const ids = ['a', 'b', 'c', 'd'].map((w) => box.add(editFrame('A1', w)));
  box.ack(ids[1]);

  eq(inputsOf(box.pending()), ['a', 'c', 'd'], 'the survivors keep their relative order');
});

test('outbox: pending() is a copy — mutating it cannot corrupt the queue', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });
  box.add(editFrame('A1', '1'));
  box.add(editFrame('A2', '2'));

  const list = box.pending();
  list.length = 0;
  list.push('쓰레기');

  eq(inputsOf(box.pending()), ['1', '2'], 'the outbox is unaffected');
});

// ---------------------------------------------------------------------------
// ack() removes exactly one
// ---------------------------------------------------------------------------

test('outbox: ack removes exactly one frame', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });

  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(box.add(editFrame(`A${i + 1}`, String(i))));

  eq(box.ack(ids[2]), true, 'ack of a queued frame reports success');
  eq(box.size(), 4, 'exactly one frame left');
  eq(box.has(ids[2]), false, 'the acked frame is gone');
  eq(inputsOf(box.pending()), ['0', '1', '3', '4'], 'and no other frame was touched');
});

test('outbox: two identical frames are two frames — one ack retires one of them', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });

  // The same edit typed twice. They differ in nothing but their opId, which is exactly
  // why the opId, not the content, is what an ack matches on.
  const first = box.add(editFrame('A1', '같음'));
  const second = box.add(editFrame('A1', '같음'));
  eq(first === second, false);

  box.ack(first);
  eq(box.size(), 1);
  eq(box.pending()[0].opId, second, 'the SECOND copy is the one still waiting');
});

test('outbox: an ack for something not queued changes nothing', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });
  const id = box.add(editFrame('A1', '1'));

  eq(box.ack('없는아이디'), false);
  eq(box.ack(''), false);
  eq(box.ack(null), false);
  eq(box.ack(undefined), false);
  eq(box.size(), 1, 'the real frame is still waiting');

  eq(box.ack(id), true);
  eq(box.ack(id), false, 'acking twice does not remove a second frame');
  eq(box.size(), 0);
});

test('outbox: an ack persists immediately — a reload does not resurrect the frame', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });
  const a = box.add(editFrame('A1', 'a'));
  box.add(editFrame('A2', 'b'));
  box.ack(a);

  const reloaded = new Outbox('docabc', { storage });
  eq(inputsOf(reloaded.pending()), ['b'], 'only the unacked frame comes back');
});

test('outbox: clear() empties the queue and the stored copy', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage });
  box.add(editFrame('A1', '1'));
  box.add(editFrame('A2', '2'));
  box.clear();

  eq(box.size(), 0);
  eq(box.pending(), []);
  eq(storage.map.has(outboxKey('docabc')), false, 'the stored key is removed, not left as "[]"');
  eq(new Outbox('docabc', { storage }).size(), 0, 'and a reload finds nothing');
});

// ---------------------------------------------------------------------------
// the cap drops the OLDEST and reports it
// ---------------------------------------------------------------------------

test('outbox: MAX_OUTBOX is 2000 (SPEC 27.4)', () => {
  eq(MAX_OUTBOX, 2000);
});

test('outbox: over the cap the OLDEST frames are dropped and the caller is told', () => {
  const storage = new MemoryStorage();
  const dropped = [];
  const infos = [];
  const box = new Outbox('docabc', {
    storage,
    max: 5,
    onDrop: (frames, info) => {
      dropped.push(...frames);
      infos.push(info);
    },
  });

  for (let i = 1; i <= 8; i++) box.add(editFrame('A1', String(i)));

  eq(box.size(), 5, 'the queue is capped');
  eq(inputsOf(box.pending()), ['4', '5', '6', '7', '8'], 'the NEWEST frames are the ones kept');
  eq(inputsOf(dropped), ['1', '2', '3'], 'the OLDEST frames are the ones dropped, in order');
  eq(infos.length, 3, 'every drop was reported');
  eq(infos.every((i) => i.reason === 'overflow'), true);
  eq(infos.every((i) => i.max === 5 && i.docId === 'docabc'), true);
  eq(infos.every((i) => i.count === 1), true);
  eq(infos[0].entries.length, 1, 'the report carries the dropped entries, not just a count');
  eq(typeof infos[0].entries[0].opId, 'string');
});

test('outbox: a drop is never silent, even with no listener', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', { storage, max: 2 });
  const { lines } = captureConsole(() => {
    box.add(editFrame('A1', '1'));
    box.add(editFrame('A2', '2'));
    box.add(editFrame('A3', '3'));
  });

  eq(box.size(), 2);
  eq(inputsOf(box.pending()), ['2', '3']);
  eq(lines.some((l) => /dropped/.test(l)), true, 'a dropped frame is reported to the console at minimum');
});

test('outbox: a listener that throws still leaves the queue correct and warns', () => {
  const storage = new MemoryStorage();
  const box = new Outbox('docabc', {
    storage,
    max: 2,
    onDrop: () => {
      throw new Error('listener exploded');
    },
  });

  const { lines } = captureConsole(() => {
    box.add(editFrame('A1', '1'));
    box.add(editFrame('A2', '2'));
    box.add(editFrame('A3', '3'));
  });

  eq(box.size(), 2, 'the cap was still enforced');
  eq(inputsOf(box.pending()), ['2', '3']);
  eq(lines.length > 0, true, 'the failure was reported rather than swallowed');
});

test('outbox: a stored queue over the cap is trimmed on load, oldest first', () => {
  const storage = new MemoryStorage();
  const big = new Outbox('docabc', { storage, max: 100 });
  for (let i = 1; i <= 10; i++) big.add(editFrame('A1', String(i)));

  const dropped = [];
  const reloaded = new Outbox('docabc', {
    storage,
    max: 4,
    onDrop: (frames, info) => dropped.push({ frames, info }),
  });

  eq(reloaded.size(), 4);
  eq(inputsOf(reloaded.pending()), ['7', '8', '9', '10']);
  eq(dropped.length, 1, 'the load-time trim is reported too');
  eq(dropped[0].info.reason, 'load');
  eq(inputsOf(dropped[0].frames), ['1', '2', '3', '4', '5', '6']);
  // The trimmed list is what a third Outbox must find; leaving the fat copy stored would
  // mean the same six frames were "dropped" again on every load.
  eq(inputsOf(new Outbox('docabc', { storage, max: 4 }).pending()), ['7', '8', '9', '10']);
});

// ---------------------------------------------------------------------------
// a second Outbox sees what the first persisted
// ---------------------------------------------------------------------------

test('outbox: a second Outbox for the same docId sees what the first persisted', () => {
  const storage = new MemoryStorage();

  const first = new Outbox('docabc', { storage });
  const ids = [
    first.add(editFrame('A1', '가')),
    first.add(editFrame('A2', '나')),
    first.add(editFrame('A3', '다')),
  ];
  first.ack(ids[1]);

  // The tab closed here. Nothing was flushed, nothing was cleaned up.
  const second = new Outbox('docabc', { storage });

  eq(second.size(), 2, 'the unacked frames came back');
  eq(inputsOf(second.pending()), ['가', '다'], 'in their original order');
  eq(second.pending().map((f) => f.opId), [ids[0], ids[2]], 'with their original opIds');
  eq(second.has(ids[1]), false, 'the acked one stayed gone');
  eq(second.available, true);

  // And the recovered frames can be acked by the server exactly as if they were new.
  eq(second.ack(ids[0]), true);
  eq(second.ack(ids[2]), true);
  eq(second.size(), 0);
  eq(new Outbox('docabc', { storage }).size(), 0);
});

test('outbox: the persisted frames survive a JSON round-trip through a real string store', () => {
  const storage = new MemoryStorage();
  const first = new Outbox('docabc', { storage });
  const frame = {
    t: 'edit',
    docId: 'docabc',
    sheetId: 'sh1a2b',
    cells: {
      A1: { input: '=SUM(B1:B9)', style: { b: 1, bg: '#e8f0fe' } },
      B2: { input: '한글 "따옴표" 그리고 \\역슬래시', link: 'https://example.com' },
      C3: null,
    },
  };
  const id = first.add(frame);

  const raw = storage.map.get(outboxKey('docabc'));
  eq(typeof raw, 'string', 'localStorage only ever holds strings');

  const second = new Outbox('docabc', { storage });
  eq(second.pending(), [{ ...frame, opId: id }], 'every field came back byte-identical');
});

test('outbox: a corrupt stored value is discarded, not thrown', () => {
  const storage = new MemoryStorage();
  for (const junk of ['not json at all', '{"v":1,"f":', '[1,2,3]', '{"v":1}', 'null', '""']) {
    storage.map.set(outboxKey('docabc'), junk);
    const { value: box } = captureConsole(() => new Outbox('docabc', { storage }));
    eq(box.size(), 0, `a queue stored as ${junk} loads as empty`);
    eq(box.add(editFrame('A1', '1')).length > 0, true, 'and the outbox still works afterwards');
    storage.map.delete(outboxKey('docabc'));
  }
});

test('outbox: unreadable records inside a stored queue are skipped, the good ones kept', () => {
  const storage = new MemoryStorage();
  storage.map.set(
    outboxKey('docabc'),
    JSON.stringify({
      v: 1,
      f: [
        { id: 'x1', at: 1, f: { t: 'edit', cells: { A1: { input: '살아남음' } } } },
        null,
        { id: 'x2', at: 2 },
        { id: 'x3', at: 3, f: 'not an object' },
        { id: 'x4', at: 4, f: { t: 'edit', cells: { A2: { input: '이것도' } } } },
      ],
    }),
  );

  const { value: box } = captureConsole(() => new Outbox('docabc', { storage }));
  eq(inputsOf(box.pending()), ['살아남음', '이것도'], 'one bad record never costs the good ones');
});

test('outbox: duplicate stored opIds are re-minted so one ack cannot retire two frames', () => {
  const storage = new MemoryStorage();
  storage.map.set(
    outboxKey('docabc'),
    JSON.stringify({
      v: 1,
      f: [
        { id: 'same', at: 1, f: { t: 'edit', cells: { A1: { input: '하나' } } } },
        { id: 'same', at: 2, f: { t: 'edit', cells: { A2: { input: '둘' } } } },
      ],
    }),
  );

  const box = new Outbox('docabc', { storage });
  const pending = box.pending();
  eq(pending.length, 2);
  eq(pending[0].opId === pending[1].opId, false, 'the collision was resolved');
  eq(inputsOf(pending), ['하나', '둘'], 'and no frame was thrown away to resolve it');

  box.ack(pending[0].opId);
  eq(inputsOf(box.pending()), ['둘'], 'one ack removed exactly one');
});

// ---------------------------------------------------------------------------
// storage that will not store
// ---------------------------------------------------------------------------

test('outbox: a storage that throws on every call leaves available === false', () => {
  const { value: box, lines } = captureConsole(() => new Outbox('docabc', { storage: new HostileStorage() }));

  eq(box.available, false, 'the outbox must not claim to be durable');
  eq(lines.length > 0, true, 'and it says so rather than failing quietly');
});

test('outbox: a blocked storage still works in memory', () => {
  const { value: box } = captureConsole(() => new Outbox('docabc', { storage: new HostileStorage() }));

  const ids = captureConsole(() => [
    box.add(editFrame('A1', '가')),
    box.add(editFrame('A2', '나')),
    box.add(editFrame('A3', '다')),
  ]).value;

  eq(box.size(), 3, 'frames are queued');
  eq(inputsOf(box.pending()), ['가', '나', '다'], 'in order');
  eq(box.ack(ids[1]), true, 'and they can still be acknowledged');
  eq(inputsOf(box.pending()), ['가', '다']);
  eq(box.available, false, 'it never starts claiming durability');
  captureConsole(() => box.clear());
  eq(box.size(), 0);
});

test('outbox: a storage that refuses writes (quota) is not durable but loses nothing now', () => {
  const storage = new ReadOnlyStorage();
  const { value: box } = captureConsole(() => new Outbox('docabc', { storage }));

  eq(box.available, false, 'an unwritable store is reported before the first edit, not after');
  captureConsole(() => {
    box.add(editFrame('A1', '1'));
    box.add(editFrame('A2', '2'));
  });
  eq(inputsOf(box.pending()), ['1', '2'], 'the frames are still here to be sent');
});

test('outbox: storage:null means memory-only and says so', () => {
  const box = new Outbox('docabc', { storage: null });
  eq(box.available, false);
  box.add(editFrame('A1', '1'));
  eq(box.size(), 1);
  eq(inputsOf(box.pending()), ['1']);
});

test('outbox: an unwritable store still hands back what it managed to read', () => {
  // A tab that filled the quota after queueing work: the previous frames must still be
  // recovered, because they are the whole reason the store exists.
  const seed = new Map([
    [
      outboxKey('docabc'),
      JSON.stringify({ v: 1, f: [{ id: 'q1', at: 1, f: { t: 'edit', cells: { A1: { input: '이전' } } } }] }),
    ],
  ]);
  const { value: box } = captureConsole(() => new Outbox('docabc', { storage: new ReadOnlyStorage(seed) }));

  eq(inputsOf(box.pending()), ['이전'], 'recovery comes first; the quota problem comes second');
  eq(box.available, false);
});

// ---------------------------------------------------------------------------
// the ambient global
// ---------------------------------------------------------------------------

test('outbox: with no storage option it finds globalThis.localStorage by itself', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = had ? globalThis.localStorage : undefined;
  const stub = new MemoryStorage();
  globalThis.localStorage = stub;
  try {
    const box = new Outbox('docabc');
    eq(box.available, true, 'a working localStorage means the outbox IS durable');
    const id = box.add(editFrame('A1', '전역'));
    eq(stub.map.has(outboxKey('docabc')), true, 'the frame went to the ambient store');

    const reloaded = new Outbox('docabc');
    eq(inputsOf(reloaded.pending()), ['전역']);
    eq(reloaded.pending()[0].opId, id);
    reloaded.clear();
  } finally {
    if (had) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
  }
});

test('outbox: with no localStorage at all it degrades to memory instead of throwing', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = had ? globalThis.localStorage : undefined;
  if (had) delete globalThis.localStorage;
  try {
    const box = new Outbox('docabc');
    eq(box.available, false, 'no store, no durability claim');
    box.add(editFrame('A1', '메모리'));
    eq(inputsOf(box.pending()), ['메모리'], 'but the work is still queued');
  } finally {
    if (had) globalThis.localStorage = previous;
  }
});
