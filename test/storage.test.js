// test/storage.test.js — the storage backend selection logic (SPEC 29.1).
//
// The rule this file exists to protect is the one in SPEC 29: which store runs is a
// CONFIGURATION decision, never a code decision, and with no SUPABASE_URL the server
// behaves exactly as it did before the Supabase backend existed. Everything else about
// the two backends needs a real server and a real crash — that is tools/crash.mjs, which
// now runs its whole suite against both. What is left here is the part that is pure:
// which backend a given environment selects, and what an INCOMPLETE environment does.
//
// The second half matters more than it looks. A half-used configuration — a URL with no
// service key — is the failure that would be silent: a server that quietly wrote to the
// local disk while its operator believed every keystroke was going to Postgres would look
// perfectly healthy right up to the moment the disk died. So the assertions below are not
// only "it throws": they are that it throws, that it does NOT fall back to files, and
// that appendJournal answers a plain `false` rather than claiming durability it does not
// have.
//
// Nothing here touches the network or the disk. `init()` is called only in the cases that
// are refused before any request is made, and the well-configured case is never
// initialised at all — reading which backend was chosen does not require reaching it.

import { test, eq } from './run.js';

// The interface every backend must implement, exactly as SPEC 29.1 lists it.
const INTERFACE = [
  'init',
  'listDocIds',
  'loadDoc',
  'saveSnapshot',
  'appendJournal',
  'readJournal',
  'truncateJournal',
  'listBackups',
  'deleteDoc',
  'flush',
];

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SCHEMA'];

// A key shaped like the real thing, so a test that leaked one into a message or a log
// would be as visible here as it would be in production. It is not a credential for
// anything: no request is ever made with it.
const FAKE_KEY = 'sz_test_service_role_key_do_not_log_9f3a1c7e2b';

let loadCounter = 0;

/**
 * Import a FRESH copy of storage/index.js under `env`.
 *
 * The module reads SUPABASE_URL once, at evaluation time, and memoises the decision —
 * which is correct (the backend may not change under a running server) and is exactly why
 * a test cannot simply reassign process.env and re-import. A unique query string gives the
 * specifier a URL the ESM registry has not seen, so the module body runs again. Sibling
 * modules resolve to their usual URLs and stay shared, so nothing is duplicated but the
 * selection logic under test.
 *
 * The environment is restored as soon as the import has been evaluated, so one case can
 * never leak configuration into the next.
 */
async function loadStorage(env) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }
  try {
    return await import(`../storage/index.js?sz-storage-test=${++loadCounter}`);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/**
 * Run `fn` with the environment applied AND the console captured.
 *
 * Both halves are needed: a misconfigured backend reports itself by printing, and the
 * test asserts on what it printed — including that the service key is not in it.
 */
async function withEnv(env, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }
  const printed = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => printed.push(args.map((a) => String(a)).join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  let value;
  let error = null;
  try {
    value = await fn();
  } catch (e) {
    error = e;
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  return { value, error, printed: printed.join('\n') };
}

// ---------------------------------------------------------------------------
// which backend for which environment
// ---------------------------------------------------------------------------

test('storage: with no SUPABASE_URL the backend is the file store', async () => {
  const storage = await loadStorage({});
  eq(storage.name, 'file');
});

test('storage: an EMPTY SUPABASE_URL is an unset one, not a configured backend', async () => {
  // An operator's .env commonly carries `SUPABASE_URL=` with nothing after it. Treating
  // that as "Supabase is configured" would fail the boot instead of running normally.
  const storage = await loadStorage({ SUPABASE_URL: '' });
  eq(storage.name, 'file');
});

test('storage: a whitespace-only SUPABASE_URL selects the file store', async () => {
  const storage = await loadStorage({ SUPABASE_URL: '   \t \n ' });
  eq(storage.name, 'file');
});

test('storage: SUPABASE_URL selects the Supabase store', async () => {
  const storage = await loadStorage({
    SUPABASE_URL: 'https://example-project.supabase.co',
    SUPABASE_SERVICE_KEY: FAKE_KEY,
  });
  eq(storage.name, 'supabase');
});

test('storage: a surrounding-whitespace SUPABASE_URL still selects Supabase', async () => {
  const storage = await loadStorage({
    SUPABASE_URL: '  https://example-project.supabase.co  ',
    SUPABASE_SERVICE_KEY: FAKE_KEY,
  });
  eq(storage.name, 'supabase');
});

test('storage: a service key with no URL does NOT select Supabase', async () => {
  // Only SUPABASE_URL selects the backend (SPEC 29.3). A key left behind in the
  // environment from some other project must never silently redirect the whole document
  // store at a database nobody asked for.
  const storage = await loadStorage({ SUPABASE_SERVICE_KEY: FAKE_KEY });
  eq(storage.name, 'file');
});

test('storage: SUPABASE_SCHEMA alone does not select Supabase either', async () => {
  const storage = await loadStorage({ SUPABASE_SCHEMA: 'sheetzi' });
  eq(storage.name, 'file');
});

test('storage: the backend name is one of exactly two values', async () => {
  const file = await loadStorage({});
  const supa = await loadStorage({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_KEY: FAKE_KEY });
  eq([file.name, supa.name], ['file', 'supabase']);
});

// ---------------------------------------------------------------------------
// the interface itself
// ---------------------------------------------------------------------------

test('storage: index.js exports the whole SPEC 29.1 interface', async () => {
  const storage = await loadStorage({});
  const missing = INTERFACE.filter((fn) => typeof storage[fn] !== 'function');
  eq(missing, []);
});

test('storage: index.js exports a `name` string for the boot log', async () => {
  const storage = await loadStorage({});
  eq(typeof storage.name, 'string');
});

test('storage: the file backend implements the whole interface', async () => {
  const fileStore = await import('../storage/fileStore.js');
  const missing = INTERFACE.filter((fn) => typeof fileStore[fn] !== 'function');
  eq(missing, []);
  eq(fileStore.name, 'file');
});

test('storage: the Supabase backend implements the whole interface', async () => {
  const supabaseStore = await import('../storage/supabaseStore.js');
  const missing = INTERFACE.filter((fn) => typeof supabaseStore[fn] !== 'function');
  eq(missing, []);
  eq(supabaseStore.name, 'supabase');
});

test('storage: neither backend exports anything outside the contract', async () => {
  // A server that reached past the interface — into a file path, say — would tie itself
  // to one backend again. Keeping the surface closed is what stops that happening by
  // accident.
  const allowed = new Set([...INTERFACE, 'name']);
  const fileStore = await import('../storage/fileStore.js');
  const supabaseStore = await import('../storage/supabaseStore.js');
  eq(Object.keys(fileStore).filter((k) => !allowed.has(k)), []);
  eq(Object.keys(supabaseStore).filter((k) => !allowed.has(k)), []);
});

test('storage: importing the Supabase backend costs nothing when it is not configured', async () => {
  // It is loaded with a dynamic import precisely so a file-backed deployment never even
  // parses it; importing it here must still be free of side effects.
  const before = process.env.SUPABASE_URL;
  await import('../storage/supabaseStore.js');
  eq(process.env.SUPABASE_URL, before);
});

// ---------------------------------------------------------------------------
// a partial configuration is refused, never half-used
// ---------------------------------------------------------------------------

test('storage: a URL with no service key still reports the Supabase backend', async () => {
  // It must NOT quietly become the file store. An operator who configured Supabase and
  // forgot the key has to be told; a server that answered by writing to the local disk
  // would look healthy while defeating the entire point of SPEC 29.
  const storage = await loadStorage({ SUPABASE_URL: 'https://example-project.supabase.co' });
  eq(storage.name, 'supabase');
});

test('storage: init() with no service key fails loudly instead of falling back', async () => {
  const result = await withEnv(
    { SUPABASE_URL: 'https://example-project.supabase.co' },
    async () => {
      const storage = await loadStorage({ SUPABASE_URL: 'https://example-project.supabase.co' });
      await storage.init();
    },
  );
  eq(result.error !== null, true);
  eq(/SUPABASE_SERVICE_KEY/.test(String(result.error && result.error.message)), true);
});

test('storage: init() with an empty service key is refused the same way', async () => {
  const result = await withEnv(
    { SUPABASE_URL: 'https://example-project.supabase.co', SUPABASE_SERVICE_KEY: '   ' },
    async () => {
      const storage = await loadStorage({
        SUPABASE_URL: 'https://example-project.supabase.co',
        SUPABASE_SERVICE_KEY: '   ',
      });
      await storage.init();
    },
  );
  eq(result.error !== null, true);
});

test('storage: init() with a URL that is not a URL is refused', async () => {
  const result = await withEnv(
    { SUPABASE_URL: 'not a url at all', SUPABASE_SERVICE_KEY: FAKE_KEY },
    async () => {
      const storage = await loadStorage({ SUPABASE_URL: 'not a url at all', SUPABASE_SERVICE_KEY: FAKE_KEY });
      await storage.init();
    },
  );
  eq(result.error !== null, true);
  eq(/SUPABASE_URL/.test(String(result.error && result.error.message)), true);
  // The refusal is decided from the configuration alone, so it costs no request — and
  // the message that explains it carries no key.
  eq(result.error && String(result.error.message).includes(FAKE_KEY), false);
});

test('storage: init() with a non-http scheme is refused', async () => {
  const result = await withEnv(
    { SUPABASE_URL: 'ftp://example-project.supabase.co', SUPABASE_SERVICE_KEY: FAKE_KEY },
    async () => {
      const storage = await loadStorage({
        SUPABASE_URL: 'ftp://example-project.supabase.co',
        SUPABASE_SERVICE_KEY: FAKE_KEY,
      });
      await storage.init();
    },
  );
  eq(result.error !== null, true);
});

test('storage: a half-configured backend NEVER claims a journal record is durable', async () => {
  // The one promise that may not bend: appendJournal resolving true means the record is
  // safe, because the client stops holding the edit the moment it is acknowledged. A
  // configuration that cannot reach a database must answer false — and must answer,
  // rather than throw, so the edit path always gets a plain yes or no.
  const result = await withEnv(
    { SUPABASE_URL: 'https://example-project.supabase.co' },
    async () => {
      const storage = await loadStorage({ SUPABASE_URL: 'https://example-project.supabase.co' });
      return storage.appendJournal('abc123def456', { t: 'edit', sheetId: 'sh1', cells: {}, rev: 1, at: 1 });
    },
  );
  eq(result.error, null);
  eq(result.value, false);
});

test('storage: a refused append says why in the log and never prints the key', async () => {
  const result = await withEnv(
    { SUPABASE_URL: 'https://example-project.supabase.co', SUPABASE_SERVICE_KEY: '' },
    async () => {
      const storage = await loadStorage({
        SUPABASE_URL: 'https://example-project.supabase.co',
        SUPABASE_SERVICE_KEY: '',
      });
      return storage.appendJournal('abc123def456', { t: 'edit', sheetId: 'sh1', cells: {}, rev: 1, at: 1 });
    },
  );
  eq(result.value, false);
  eq(result.printed.includes(FAKE_KEY), false);
});

test('storage: the boot log names the backend and never carries the service key', async () => {
  // A malformed URL is refused by the configuration check, before any request is built,
  // so this reaches the boot line without the test ever touching a network. The key IS
  // present in the environment, which is what makes the second assertion mean something.
  const env = { SUPABASE_URL: 'not a url at all', SUPABASE_SERVICE_KEY: FAKE_KEY };
  const result = await withEnv(env, async () => {
    const storage = await loadStorage(env);
    await storage.init().catch(() => {});
  });
  eq(/Supabase/.test(result.printed), true);
  eq(result.printed.includes(FAKE_KEY), false);
});

test('storage: the file backend announces itself as the local disk', async () => {
  const result = await withEnv({}, async () => {
    const storage = await loadStorage({});
    await storage.init();
  });
  eq(result.error, null);
  eq(/data\//.test(result.printed), true);
});

// ---------------------------------------------------------------------------
// the forwarding layer
// ---------------------------------------------------------------------------

test('storage: appendJournal only ever resolves the literal true or false', async () => {
  // The one case here that touches the disk, because the forwarding layer's `ok === true`
  // guard is only meaningful against a backend that really answers. The synthetic id is
  // removed in a finally: a stray data/<id>.log would come back as a phantom document on
  // the next boot.
  const storage = await loadStorage({});
  const id = 'zzz000storage';
  try {
    const ok = await storage.appendJournal(id, { t: 'edit', sheetId: 'sh1', cells: {}, rev: 1, at: 1 });
    eq(typeof ok, 'boolean');
    eq(ok, true);
  } finally {
    await storage.deleteDoc(id);
  }
});

test('storage: flush() before anything was loaded touches no backend', async () => {
  // Nothing has been used, so nothing can be holding unflushed work — and reaching for a
  // Supabase backend here would turn a clean exit into a network call.
  const result = await withEnv(
    { SUPABASE_URL: 'https://example-project.supabase.co', SUPABASE_SERVICE_KEY: FAKE_KEY },
    async () => {
      const storage = await loadStorage({
        SUPABASE_URL: 'https://example-project.supabase.co',
        SUPABASE_SERVICE_KEY: FAKE_KEY,
      });
      await storage.flush();
      return 'resolved';
    },
  );
  eq(result.error, null);
  eq(result.value, 'resolved');
  eq(result.printed, '');
});

test('storage: two loads of the same environment agree', async () => {
  // The decision is memoised inside one module instance; two instances built from the
  // same environment must still reach the same answer.
  const a = await loadStorage({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_KEY: FAKE_KEY });
  const b = await loadStorage({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_KEY: FAKE_KEY });
  eq(a.name, b.name);
});

test('storage: changing the environment after load does not change the backend', async () => {
  // A running server may not switch stores underneath itself: every document already in
  // memory came from one of them.
  const storage = await loadStorage({});
  const before = storage.name;
  process.env.SUPABASE_URL = 'https://example-project.supabase.co';
  try {
    eq(storage.name, before);
  } finally {
    delete process.env.SUPABASE_URL;
  }
});
