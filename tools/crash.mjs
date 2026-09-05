#!/usr/bin/env node
/**
 * Durability harness (SPEC sections 27 and 29.5).
 *
 * Durability is a claim about what survives a crash, so the only honest way to test it is
 * to crash. Every case below boots the real server, drives it over the real WebSocket
 * protocol, then SIGKILLs it — no clean shutdown, no flush, no chance to finish anything —
 * and restarts it to see what is still there.
 *
 * THE WHOLE SUITE RUNS TWICE: once against the file store (data/*.json + journal +
 * backups) and once against the Supabase store, pointed at tools/fakesupabase.mjs. The
 * guarantees in SPEC 27 are properties of the storage INTERFACE, not of one
 * implementation, so a guarantee that only holds for files is not a guarantee at all. The
 * stand-in runs in THIS process, not the server's, which is what makes the second run
 * meaningful: SIGKILLing the server leaves the database standing, exactly as a hosted
 * Postgres would.
 *
 * The file run goes FIRST, always, so a regression in the store everyone uses by default
 * is reported before anything Supabase-specific muddies the picture. Every check names
 * its backend.
 *
 * The cases, and the failure each one is aimed at:
 *
 *   1. an acknowledged edit survives an immediate SIGKILL.
 *      This is the exact case the 400 ms save debounce used to lose: the edit existed only
 *      in memory until the timer fired. It is the whole reason the journal exists, so the
 *      harness also proves the bytes were in the journal and NOT yet in the snapshot —
 *      otherwise the case would quietly degrade into "the debounce happened to fire".
 *   2. a burst of 50 edits, killed right after the last ack. Nothing may be lost, and
 *      nothing may be half-applied.
 *   3. a kill BEFORE any ack. Unacknowledged work may be missing — that is precisely what
 *      an ack means and the outbox is what keeps it — but the document must never come
 *      back corrupt, empty, or holding a value nobody typed, and everything acknowledged
 *      EARLIER must still be there.
 *   4. a deliberately corrupted journal. On files: a truncated line mid-file, a line of
 *      garbage, and a half-written final line (the normal artefact of a crash mid-write).
 *      On Supabase: rows whose `rec` is not an object at all. The server must still boot
 *      and must keep every record around the bad ones.
 *   5. the snapshot and every backup deleted, the journal kept. The document must still
 *      load — from the journal alone, with nothing else to fall back on.
 *   6. backups appear after a compaction and GET /api/docs/:id/backups lists them.
 *   7. exactly-once: a replayed frame must not be applied twice.
 *   8. an oversized frame is refused by the socket, not by a handler.
 *
 * Four that only exist on the FILE path, because only a file can be present, correct and
 * impossible to OPEN (SPEC 27.6). They are driven with a real permission denial on a real
 * file, so the errno is the one a locked file really produces, in the server's own process:
 *
 *  14. an unreadable journal is not an empty one. The document is refused rather than
 *      served at a rev that does not include the records still sitting in the log, and
 *      neither the log nor the snapshot is touched for as long as it is refused.
 *  15. THE RESTART, which is the case that actually destroyed data. The boot after the
 *      fault is cleared has to bring those records back. The previous attempt at this fix
 *      passed every in-process test and still lost them here, because it refused the
 *      truncate alone and let the document go on being served: the rev climbed past the
 *      unread records, and the next boot replayed nothing and truncated with a clear
 *      conscience.
 *  16. an unreadable <id>.json is never swapped for <id>.bak.1, and the newer snapshot is
 *      still on disk afterwards. Asserted on the FILE, because the damage was a rename —
 *      rotateBackups grinding the good copy off the end of the backup ring.
 *  17. the other side of that same line: ENOENT and a genuine parse failure keep exactly
 *      the recovery they always had. Over-refusing is an outage of its own.
 *
 * And four that only exist on the Supabase path, because only it has a database to refuse
 * a write and a `seq` to truncate against:
 *
 *   9. the database refuses the insert. The operation is NOT acknowledged — the client
 *      keeps it, re-sends it, and only then is it safe.
 *  10. a journal row appended DURING a snapshot is not lost by the truncate. Driven
 *      deliberately: the snapshot's upsert is held on the wire while a second writer
 *      appends a row, so the window that a blanket delete would swallow is really open.
 *  11. a 2xx whose body cannot be read is never taken for an empty journal. A read that
 *      fails must fail; the one thing it may never do is answer "no rows", because the
 *      compaction that follows deletes against exactly that answer.
 *  12. the service key never appears in anything the server prints or sends, the way
 *      tools/auth.mjs pins the same rule for the password.
 *
 * Usage: node tools/crash.mjs
 * Prints PASS/FAIL per check and exits non-zero if any of them failed.
 */
import { appendFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { start as startFakeSupabase } from './fakesupabase.mjs';
import { harnessEnv, spawnServer as spawnGuardedServer } from './harness-env.mjs';
import { denyReads, releaseAll } from '../test/unreadable.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.CRASH_PORT || 39531);
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}/ws`;

// Mirrors server.js: the debounce a compaction waits for, and how many backups it keeps.
const SAVE_DEBOUNCE_MS = 400;
const BACKUP_COUNT = 5;

// The service key for the Supabase run. It opens the whole database, so the one thing the
// harness must prove about it is that it never leaves the server process — which is why
// it is long, distinctive and ASCII-only (a header value cannot carry anything else).
const SERVICE_KEY = 'sz_crash_service_role_key_do_not_log_4b91d7e2c6a8';

let server = null;
let serverLog = [];
let boots = 0;
let passed = 0;
const failures = [];

// Which backend the current run is exercising; every check and section says so.
let backendLabel = 'file';

// Extra environment for the server process — how the backend is selected (SPEC 29.1).
let serverEnv = {};

// Set the moment the key is seen anywhere it must never be. Checked at the point of
// arrival rather than by accumulating every byte, so the scan is exact and costs nothing.
let keyInServerOutput = false;
let keyInWireFrames = false;

// The child whose output belongs in `serverLog` — the one the current boot spawned.
let logOwner = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function section(title) {
  console.log(`\n---- [${backendLabel}] ${title} ----`);
}

function check(name, cond, detail = '') {
  const tagged = `[${backendLabel}] ${name}`;
  if (cond) {
    passed++;
    console.log(`PASS  ${tagged}`);
  } else {
    failures.push(`${tagged}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${tagged}${detail ? `\n        ${detail}` : ''}`);
  }
}

function note(text) {
  console.log(`note  [${backendLabel}] ${text}`);
}

/**
 * Report a case that died of a throw as a failed check, so the cases after it still run.
 *
 * Each of the file-only cases stands for a different finding, and the case most likely to
 * trip over a real fault is the one that has just proved a store WRONG — its own cleanup
 * reads files the store may have moved. Losing the cases after it to that would hide the
 * answers this section exists to give, above all the one that proves the fix did not
 * over-refuse.
 */
function reportThrow(label, err) {
  const detail = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
  check(`${label} ran to the end`, false, detail);
}

/**
 * Watch everything the server says for the service key, as it is said — and keep the LOG
 * to one process.
 *
 * Every spawned child writes into whatever array `serverLog` currently names, so a
 * predecessor still flushing its last lines used to land them in the next boot's log. That
 * is how "server output (last boot)" came to show two boots interleaved, which is precisely
 * the moment somebody needs it to be plain. The key scan stays unconditional: SPEC 29.3
 * forbids the key in ANY server output, and a superseded child is still a server.
 */
function absorbServerOutput(text, from = null) {
  if (text.includes(SERVICE_KEY)) keyInServerOutput = true;
  if (from === null || from === logOwner) serverLog.push(text);
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

function spawnServer() {
  // Through tools/harness-env.mjs, never spawn() directly: this suite plants corrupt
  // records, SIGKILLs the server mid-write and deletes documents, and server.js now
  // reads .env at startup. The helper writes every backend and auth variable explicitly
  // so the operator's own configuration can never select what these cases run against.
  const label = `crash/${backendLabel}`;
  const child = spawnGuardedServer({
    env: harnessEnv({ PORT: String(PORT), ...serverEnv }, { label }),
    label,
  });
  logOwner = child;
  child.stdout.on('data', (d) => absorbServerOutput(d.toString(), child));
  child.stderr.on('data', (d) => absorbServerOutput(d.toString(), child));
  child.on('error', (e) => absorbServerOutput(`\n[spawn error] ${e && e.message}\n`, child));
  return child;
}

async function waitForHealth(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
      // A port cannot say which process answered it. If the child this boot spawned is
      // already dead — EADDRINUSE, almost always — then somebody else answered, and
      // attaching to it makes every assertion afterwards about a server this suite never
      // started: the document it created is missing, the join is refused, and a harness
      // artefact is reported as lost data. Health is only health if OUR child is alive.
      if (r.ok) return child.exitCode === null && child.signalCode === null;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await sleep(100);
  }
  return false;
}

/**
 * Nothing is listening on the harness's port any more.
 *
 * A SIGKILLed predecessor, or a second copy of this harness on the same machine, answers
 * /healthz exactly as well as the child about to be spawned — so a boot waits for the port
 * to fall silent before it spawns anything, and `waitForHealth` refuses an answer that
 * arrived while its own child was already dead. Together those are what make "the server
 * this case is talking to" a fact rather than an assumption.
 */
async function portSilent(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(700) });
    } catch {
      return true; // refused, or nothing there to refuse it
    }
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/**
 * Boot the server and wait until it answers /healthz.
 *
 * A SIGKILLed predecessor releases its listening socket only when the kernel gets round to
 * it, so a restart can lose the race and exit with EADDRINUSE. That is an artefact of the
 * harness, not a durability failure, so it is retried rather than reported as one.
 */
async function boot(label) {
  boots++;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!(await portSilent())) {
      note(`something else is still answering ${BASE}/healthz before "${label}" — `
        + 'this harness cannot share its port with another server');
    }
    serverLog = [];
    const child = spawnServer();
    if (await waitForHealth(child, 20000)) {
      server = child;
      return;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (attempt === 4) {
      throw new Error(`server did not come up for "${label}"\n${serverLog.join('').slice(-2000)}`);
    }
    await sleep(400 * attempt);
  }
}

/**
 * One boot attempt, reported rather than retried.
 *
 * `boot` retries, which is right when a SIGKILLed predecessor is still holding the port —
 * and wrong for a case whose whole question is "did the server refuse to start?". A retry
 * would consume the injected fault on the first attempt and then succeed on the second,
 * hiding the answer. This one attempt reports the truth about that attempt.
 */
async function bootOnce(label) {
  boots++;
  if (!(await portSilent())) {
    note(`something else is still answering ${BASE}/healthz before "${label}" — `
      + 'this harness cannot share its port with another server');
  }
  serverLog = [];
  const child = spawnServer();
  if (await waitForHealth(child, 15000)) {
    server = child;
    return { healthy: true, log: serverLog.join('') };
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  await sleep(200);
  return { healthy: false, log: serverLog.join('') };
}

/**
 * SIGKILL: no signal handler runs, no shutdown hook, no flush. On Windows every kill is a
 * TerminateProcess, which is the same abrupt death. This is the failure the journal is
 * supposed to survive.
 */
async function crash() {
  if (!server) return;
  const child = server;
  server = null;
  const exited = new Promise((res) => child.once('exit', res));
  try {
    child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
  await Promise.race([exited, sleep(5000)]);
  // Give the OS a moment to release the listening socket and the journal handle.
  await sleep(150);
}

/** A clean stop, used only at the very end of a run. */
async function stopCleanly() {
  if (!server) return;
  const child = server;
  server = null;
  const exited = new Promise((res) => child.once('exit', res));
  try {
    child.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  await Promise.race([exited, sleep(6000)]);
  try {
    child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
}

// ---------------------------------------------------------------------------
// a WebSocket client
// ---------------------------------------------------------------------------

class Client {
  constructor(name) {
    this.name = name;
    this.frames = [];
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(WSURL);
    // A socket whose server was just killed emits 'error'; without a listener that is an
    // unhandled event and takes the harness down with it.
    this.ws.on('error', () => {});
    this.ws.on('message', (buf) => {
      const text = buf.toString();
      // Every byte the server sends a browser passes through here, so this is the place
      // to notice a secret in one of them (SPEC 29.3).
      if (text.includes(SERVICE_KEY)) keyInWireFrames = true;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = { t: '<unparseable>' };
      }
      this.frames.push(msg);
    });
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`${this.name}: ws open timeout`)), 8000);
      this.ws.once('open', () => {
        clearTimeout(to);
        res();
      });
      this.ws.once('error', (e) => {
        clearTimeout(to);
        rej(e);
      });
    });
    return this;
  }

  send(msg) {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* the server may already be gone; that is what the case is testing */
    }
  }

  async await(pred, { timeout = 6000, label = 'frame', from = 0 } = {}) {
    const deadline = Date.now() + timeout;
    let i = from;
    while (Date.now() < deadline) {
      for (; i < this.frames.length; i++) if (pred(this.frames[i])) return this.frames[i];
      await sleep(10);
    }
    throw new Error(`${this.name}: timed out waiting for ${label}. Saw: ${this.frames.map((f) => f.t).join(',')}`);
  }

  acks() {
    return this.frames.filter((f) => f.t === 'ack');
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Open a socket, join `docId`, and return the client once the welcome has arrived. */
async function joinDoc(docId, name) {
  const client = await new Client(name).open();
  client.send({ t: 'hello', docId, name, color: '#1a73e8' });
  await client.await((f) => f.t === 'welcome', { label: `welcome(${name})` });
  return client;
}

/**
 * The same join, for a document that may legitimately REFUSE it.
 *
 * `joinDoc` throws on a refusal, which is right everywhere else: a welcome that does not
 * arrive is a bug. Here the refusal is the expected answer half the time, and the case has
 * to be able to report which answer it got rather than dying of one of them.
 */
async function tryJoin(docId, name) {
  const client = await new Client(name).open();
  client.send({ t: 'hello', docId, name, color: '#1a73e8' });
  const frame = await client
    .await((f) => f.t === 'welcome' || f.t === 'error', { label: `welcome-or-refusal(${name})`, timeout: 6000 })
    .catch(() => null);
  return {
    client,
    welcomed: !!frame && frame.t === 'welcome',
    refusal: frame && frame.t === 'error' ? frame : null,
  };
}

// ---------------------------------------------------------------------------
// reading a document, whatever it is stored in
// ---------------------------------------------------------------------------

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** The `input` of a cell in a document object, or undefined when it is not there. */
function inputIn(doc, sheetId, a1) {
  if (!doc || !Array.isArray(doc.sheets)) return undefined;
  const sheet = doc.sheets.find((s) => s && s.id === sheetId);
  const cell = sheet && sheet.cells ? sheet.cells[a1] : undefined;
  return cell ? cell.input : undefined;
}

async function fetchDoc(id) {
  const res = await fetch(`${BASE}/api/docs/${id}`);
  if (!res.ok) return { status: res.status, doc: null };
  return { status: res.status, doc: await res.json() };
}

/**
 * The same request, but keeping the body of a REFUSAL as well as of a success.
 *
 * A quarantined document answers 503 with an explanation (SPEC 27.6), and the checks in
 * cases 14 to 17 turn on what that body says — a 404 there would read as "no such
 * document" and invite somebody to make a new one on top of the old one's id.
 */
async function fetchDocRaw(id) {
  const res = await fetch(`${BASE}/api/docs/${id}`);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: the checks report `text` instead */
  }
  return { status: res.status, body, text };
}

/** True when some journal record's cells patch names `a1`, in whichever store holds it. */
function journalHasCell(store, id, a1) {
  return store.journalEntries(id).some(({ rec }) => {
    if (!rec) return false;
    if (rec.t === 'edit' && rec.cells && has(rec.cells, a1)) return true;
    if ((rec.t === 'doc' || rec.t === 'sheet') && rec.doc && Array.isArray(rec.doc.sheets)) {
      return rec.doc.sheets.some((s) => s && s.cells && has(s.cells, a1));
    }
    return false;
  });
}

/** True when a journal record names `a1` inside its cells patch (edits only). */
function recordTouches(rec, a1) {
  return !!(rec && rec.t === 'edit' && rec.cells && has(rec.cells, a1));
}

// ---------------------------------------------------------------------------
// backend 1 — the file store (SPEC 29.2)
// ---------------------------------------------------------------------------

const snapshotPath = (id) => join(DATA, `${id}.json`);
const journalPath = (id) => join(DATA, `${id}.log`);
const backupPath = (id, n) => join(DATA, `${id}.bak.${n}`);

/**
 * Every file one document can own.
 *
 * Used to release read denials, and it lists the whole backup ring on purpose: the damage
 * cases 14 and 16 reproduce is a RENAME, so a store that got it wrong will have moved the
 * denied file somewhere else in this list, and a cleanup that only looked where the file
 * started would leave an unreadable file behind on somebody's disk.
 */
function ownedPaths(id) {
  const paths = [snapshotPath(id), `${snapshotPath(id)}.tmp`, journalPath(id)];
  for (let n = 1; n <= BACKUP_COUNT; n++) paths.push(backupPath(id, n));
  return paths;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The bytes at `path`, or null when there are none to be had.
 *
 * Used by every file-level assertion in cases 14 to 17, and it swallows the failure on
 * purpose: those cases run against a store that may have RENAMED a file it was told not to
 * touch, so the read they make to prove that is the read most likely to land on the denied
 * file at its new name. A throw there would abandon the cases after it — including the one
 * that guards against over-refusing — so an unreadable file becomes a failed check with a
 * null in its detail instead.
 */
function bytesAt(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * The file backend, inspected exactly as this harness always inspected it. Nothing here
 * changed: the same paths, the same reads, the same corruption.
 */
function fileBackend() {
  return {
    kind: 'file',
    label: 'file',
    // Explicitly blank, so an operator's own Supabase configuration in the environment
    // cannot turn the default run into something else without anyone noticing.
    env: { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' },
    journalName: 'data/<id>.log',
    ownedNoun: 'file',
    // What "the snapshot a reader sees is never half-written" rests on here.
    atomicNote: 'atomic tmp+rename means a reader never sees a partial snapshot',

    async setup() {
      await mkdir(DATA, { recursive: true });
    },
    async teardown() {},

    /** Every line of data/<id>.log, parsed where possible. */
    journalEntries(id) {
      let text;
      try {
        text = readFileSync(journalPath(id), 'utf8');
      } catch {
        return [];
      }
      return text
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((line) => {
          try {
            return { line, rec: JSON.parse(line) };
          } catch {
            return { line, rec: null };
          }
        });
    },

    /** How much the journal still holds, for the "it was truncated" check. */
    journalWeight(id) {
      const text = existsSync(journalPath(id)) ? readFileSync(journalPath(id), 'utf8').trim() : '';
      return { empty: text === '', detail: `${text.length} bytes still in data/${id}.log` };
    },

    snapshotDoc: (id) => readJson(snapshotPath(id)),
    hasSnapshot: (id) => existsSync(snapshotPath(id)),
    hasJournal: (id) => existsSync(journalPath(id)),

    backupCount(id) {
      let n = 0;
      for (let i = 1; i <= BACKUP_COUNT; i++) if (existsSync(backupPath(id, i))) n++;
      return n;
    },
    backupDoc: (id, n) => readJson(backupPath(id, n)),
    backupSize(id, n) {
      try {
        return statSync(backupPath(id, n)).size;
      } catch {
        return -1;
      }
    },

    async removeSnapshotAndBackups(id) {
      await rm(snapshotPath(id), { force: true });
      for (let i = 1; i <= BACKUP_COUNT; i++) await rm(backupPath(id, i), { force: true });
    },

    /**
     * Three corruptions, in the order a real crash produces them: a truncated record
     * mid-file, a line that is not JSON at all, and — after one more good record — a
     * half-written final line with no newline, which is what a process killed mid-write
     * actually leaves.
     */
    async plantCorruption(id, sheetId, rev) {
      const goodAfterGarbage = JSON.stringify({
        t: 'edit',
        sheetId,
        cells: { F1: { input: '쓰레기뒤' } },
        rev,
        at: Date.now(),
      });
      await appendFile(
        journalPath(id),
        `{"t":"edit","sheetId":"${sheetId}","cells":{"ZZ1":{"input":"잘린 레코드\n` +
          '%%% 이것은 JSON 이 아닙니다 %%%\n' +
          `${goodAfterGarbage}\n` +
          `{"t":"edit","sheetId":"${sheetId}","cells":{"YY1":{"inp`,
        'utf8',
      );
      return {
        good: { a1: 'F1', input: '쓰레기뒤' },
        skipped: [
          { a1: 'ZZ1', label: 'the truncated record was skipped, not half-applied' },
          { a1: 'YY1', label: 'the half-written final line was skipped too' },
        ],
      };
    },

    leftovers(id) {
      const victims = [snapshotPath(id), `${snapshotPath(id)}.tmp`, journalPath(id)];
      for (let i = 1; i <= BACKUP_COUNT; i++) victims.push(backupPath(id, i));
      return victims.filter((f) => existsSync(f));
    },

    async forceCleanup(id) {
      const victims = [snapshotPath(id), `${snapshotPath(id)}.tmp`, journalPath(id)];
      for (let i = 1; i <= BACKUP_COUNT; i++) victims.push(backupPath(id, i));
      for (const file of victims) {
        try {
          await rm(file, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// backend 2 — the Supabase store against tools/fakesupabase.mjs (SPEC 29.5)
// ---------------------------------------------------------------------------

/**
 * A transparent PostgREST proxy the server talks through, with one power: it can HOLD one
 * request in flight until the harness releases it.
 *
 * Nothing else can open the window case 10 needs. One server serialises every storage
 * operation for a document, so it cannot itself append while its own snapshot is being
 * written; the only way to have a row land inside that window is to stop the snapshot on
 * the wire and write from somewhere else — which is exactly what a second writer against
 * the same store, such as another server instance, would be.
 */
function startGate(targetUrl, host = '127.0.0.1') {
  // Only the headers PostgREST actually reads. Copying req.headers wholesale would carry
  // host/connection/content-length into fetch, which rejects them.
  const FORWARD = ['apikey', 'authorization', 'accept', 'accept-profile', 'content-profile', 'content-type', 'prefer', 'range'];
  const sockets = new Set();
  let hold = null;

  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const method = (req.method || 'GET').toUpperCase();
    const path = req.url || '/';

    if (hold && hold.matches(method, path, body)) {
      const current = hold;
      hold = null;
      current.arrive();
      await current.gate;
    }

    const headers = {};
    for (const key of FORWARD) if (req.headers[key] !== undefined) headers[key] = req.headers[key];

    let upstream;
    try {
      upstream = await fetch(new URL(path, targetUrl), {
        method,
        headers,
        body: body.length ? body : undefined,
      });
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'GATE502', details: null, hint: null, message: String(err && err.message) }));
      return;
    }
    const text = await upstream.text();
    const out = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
    const range = upstream.headers.get('content-range');
    if (range) out['content-range'] = range;
    res.writeHead(upstream.status, out);
    res.end(text);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'GATE502', message: String(err && err.message) }));
      } catch {
        res.destroy();
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((done) => {
    server.listen(0, host, () => {
      const { port } = server.address();
      done({
        url: `http://${host}:${port}`,
        /**
         * Catch the next request for `table` whose body names `bodyIncludes`, and hold it
         * open. Returns `{ arrived, release }`.
         */
        holdNext(method, table, bodyIncludes = '') {
          let arrive;
          let release;
          const arrived = new Promise((r) => {
            arrive = r;
          });
          const gate = new Promise((r) => {
            release = r;
          });
          hold = {
            matches: (m, path, body) =>
              m === method.toUpperCase() &&
              path.startsWith(`/rest/v1/${table}`) &&
              (bodyIncludes === '' || body.toString('utf8').includes(bodyIncludes)),
            arrive,
            gate,
          };
          return { arrived, release };
        },
        cancelHold() {
          if (hold) {
            hold = null;
          }
        },
        stop() {
          return new Promise((closed) => {
            server.close(() => closed());
            for (const socket of sockets) socket.destroy();
            sockets.clear();
          });
        },
      });
    });
  });
}

/** One PostgREST request made BY THE HARNESS, straight at the stand-in, bypassing the gate. */
async function rest(fake, method, table, { query, body, prefer } = {}) {
  const url = new URL(`/rest/v1/${table}`, fake.url);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  // SERVICE_KEY is an opaque string, not a JWT, so it goes on `apikey` alone — exactly
  // what storage/supabaseStore.js sends for an sb_secret_ key and what the stand-in (and the
  // real service) accept. Adding `Authorization: Bearer` here would present a non-JWT as a
  // JWT, which PostgREST refuses with 401 PGRST301.
  const headers = {
    apikey: SERVICE_KEY,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text };
}

/**
 * Poll until `pred()` holds, and report whether it ever did.
 *
 * The write-back a boot performs is issued immediately but not awaited before the server
 * starts listening, so /healthz can answer a few milliseconds before the snapshot lands.
 * That is a race in the harness, not a durability failure — the journal still holds
 * everything — so the assertions about it give the write a moment rather than reading
 * once and reporting a phantom. The window is short enough that "at boot" is still
 * distinguishable from "at the next compaction", which is what those checks mean.
 */
async function eventually(pred, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (pred()) return true;
    } catch {
      /* a store that is mid-write can throw; try again */
    }
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

/** Wait until `pred()` holds, polling; throws with `label` when it never does. */
async function waitFor(pred, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Wait until the database has been quiet for `quietMs`, so an injected fault hits what it should. */
async function quiesce(fake, quietMs = 300, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = fake.requests.length;
  let since = Date.now();
  while (Date.now() < deadline) {
    await sleep(50);
    if (fake.requests.length !== last) {
      last = fake.requests.length;
      since = Date.now();
      continue;
    }
    if (Date.now() - since >= quietMs) return;
  }
}

async function supabaseBackend() {
  const fake = await startFakeSupabase(0, { key: SERVICE_KEY });
  const gate = await startGate(fake.url);

  const journalRows = (id) =>
    fake
      .rows('sz_journal')
      .filter((row) => row.doc_id === id)
      .sort((a, b) => Number(a.seq) - Number(b.seq));

  const backupRows = (id) =>
    fake
      .rows('sz_backups')
      .filter((row) => row.doc_id === id)
      .sort((a, b) => Number(b.seq) - Number(a.seq)); // newest first, as listBackups reports

  return {
    kind: 'supabase',
    label: 'supabase',
    fake,
    gate,
    // The server reaches the stand-in THROUGH the gate; the harness reaches it directly.
    env: { SUPABASE_URL: gate.url, SUPABASE_SERVICE_KEY: SERVICE_KEY },
    journalName: 'the sz_journal table',
    ownedNoun: 'row',
    atomicNote: 'a single upsert means a reader never sees a half-replaced row',

    async setup() {},
    async teardown() {
      await gate.stop();
      await fake.stop();
    },

    /**
     * The journal as records. A committed row is whole or absent — there is no torn tail
     * — so `rec` is null only for a row whose value is not a record at all, which is what
     * case 4 plants.
     */
    journalEntries(id) {
      return journalRows(id).map((row) => {
        const rec = row.rec;
        const usable = rec && typeof rec === 'object' && !Array.isArray(rec);
        return { line: JSON.stringify(rec), rec: usable ? rec : null };
      });
    },

    journalWeight(id) {
      const rows = journalRows(id);
      return { empty: rows.length === 0, detail: `${rows.length} rows still in sz_journal for ${id}` };
    },

    snapshotDoc(id) {
      const row = fake.rows('sz_documents').find((r) => r.id === id);
      return row ? row.doc : null;
    },
    hasSnapshot(id) {
      return fake.rows('sz_documents').some((r) => r.id === id);
    },
    hasJournal(id) {
      return journalRows(id).length > 0;
    },

    backupCount: (id) => backupRows(id).length,
    backupDoc(id, n) {
      const row = backupRows(id)[n - 1];
      return row ? row.doc : null;
    },
    backupSize(id, n) {
      const row = backupRows(id)[n - 1];
      if (!row) return -1;
      // The same measure listBackups reports: the byte length of that document as JSON.
      try {
        return Buffer.byteLength(JSON.stringify(row.doc ?? null), 'utf8');
      } catch {
        return -1;
      }
    },

    async removeSnapshotAndBackups(id) {
      await rest(fake, 'DELETE', 'sz_documents', { query: { id: `eq.${id}` }, prefer: 'return=minimal' });
      await rest(fake, 'DELETE', 'sz_backups', { query: { doc_id: `eq.${id}` }, prefer: 'return=minimal' });
    },

    /**
     * The database equivalent of a corrupt journal. Postgres cannot hold a half-written
     * row, so the damage a real deployment can suffer is a row whose `rec` is not a
     * record: a string where an object belongs, or an array. Both must be skipped and
     * counted, and replay must continue past them — the same promise the file store makes
     * about a line that will not parse.
     */
    async plantCorruption(id, sheetId, rev) {
      const now = Date.now();
      const bad1 = await rest(fake, 'POST', 'sz_journal', {
        body: { doc_id: id, rec: '{"t":"edit","cells":{"ZZ1":{"input":"잘린 레코드', at: now },
        prefer: 'return=minimal',
      });
      const garbage = await rest(fake, 'POST', 'sz_journal', {
        body: { doc_id: id, rec: '%%% 이것은 JSON 이 아닙니다 %%%', at: now + 1 },
        prefer: 'return=minimal',
      });
      const good = await rest(fake, 'POST', 'sz_journal', {
        body: {
          doc_id: id,
          rec: { t: 'edit', sheetId, cells: { F1: { input: '쓰레기뒤' } }, rev, at: now + 2 },
          at: now + 2,
        },
        prefer: 'return=minimal',
      });
      const bad2 = await rest(fake, 'POST', 'sz_journal', {
        body: { doc_id: id, rec: [{ t: 'edit', sheetId, cells: { YY1: { input: '배열' } } }], at: now + 3 },
        prefer: 'return=minimal',
      });
      if (!bad1.ok || !garbage.ok || !good.ok || !bad2.ok) {
        throw new Error(`could not plant the corrupt rows: ${bad1.status}/${garbage.status}/${good.status}/${bad2.status}`);
      }
      return {
        good: { a1: 'F1', input: '쓰레기뒤' },
        skipped: [
          { a1: 'ZZ1', label: 'the record that is a string, not an object, was skipped' },
          { a1: 'YY1', label: 'the record that is an array was skipped too' },
        ],
      };
    },

    leftovers(id) {
      const out = [];
      if (fake.rows('sz_documents').some((r) => r.id === id)) out.push('sz_documents row');
      const j = journalRows(id).length;
      if (j) out.push(`${j} sz_journal rows`);
      const b = backupRows(id).length;
      if (b) out.push(`${b} sz_backups rows`);
      return out;
    },

    async forceCleanup(id) {
      try {
        await rest(fake, 'DELETE', 'sz_documents', { query: { id: `eq.${id}` }, prefer: 'return=minimal' });
        await rest(fake, 'DELETE', 'sz_journal', { query: { doc_id: `eq.${id}` }, prefer: 'return=minimal' });
        await rest(fake, 'DELETE', 'sz_backups', { query: { doc_id: `eq.${id}` }, prefer: 'return=minimal' });
      } catch {
        /* the stand-in may already be stopped */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// the suite — run once per backend
// ---------------------------------------------------------------------------

async function runSuite(store) {
  let docId = null;
  let sheet1 = null;
  let client = null;

  try {
    // =========================================================================
    section('1. an acknowledged edit survives an immediate SIGKILL');
    // =========================================================================

    await boot('first');

    const created = await fetch(`${BASE}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '내구성 테스트' }),
    });
    const doc0 = await created.json();
    docId = doc0.id;
    sheet1 = doc0.sheets[0].id;
    check('a document can be created', /^[a-z0-9]{6,24}$/.test(docId || '') && !!sheet1, `id=${docId}`);

    client = await joinDoc(docId, '가나');

    // Creating a document schedules a compaction that server.js does NOT await
    // (POST /api/docs ends with an un-awaited saveNow), and the assertions below are about
    // the snapshot that compaction writes. So the case waits for it to finish before it
    // types anything, and everything after this line is about the edit alone.
    //
    // Without the wait the two runs disagree, which is how it was found. compactDoc hands
    // the store the LIVE document object; the file store serialises it before its first
    // await, but the Supabase store reads the journal's high-water mark first — on purpose,
    // so a record arriving during the save cannot be truncated away — and an edit applied
    // during that read is therefore already inside the snapshot it stringifies afterwards.
    // "the snapshot was still the old one" then failed on a cold or loaded machine and
    // passed on a warm one, which is the worst kind of gate: nothing was lost, because the
    // published mark is still the older seq and the truncate that follows deletes nothing
    // the snapshot lacks, but the run went red for a race in the HARNESS.
    const firstCompaction = await eventually(
      () => store.hasSnapshot(docId) && store.journalWeight(docId).empty,
    );
    check("the document's first compaction finished before this case typed anything",
      firstCompaction,
      `${store.hasSnapshot(docId) ? 'snapshot written' : 'no snapshot yet'}; ${store.journalWeight(docId).detail}`);

    const editSentAt = Date.now();
    client.send({ t: 'edit', docId, sheetId: sheet1, opId: 'op-one', cells: { A1: { input: '42' } } });
    const ack = await client.await((f) => f.t === 'ack' && f.opId === 'op-one', { label: 'ack(op-one)' });
    check('the server acknowledges an edit that carries an opId (SPEC 27.3)', !!ack);
    check('the ack carries the rev the edit produced', Number.isFinite(ack.rev), `rev=${ack.rev}`);
    let lastRev = ack.rev;

    await crash();
    const killGap = Date.now() - editSentAt;

    // The point of the case: at the instant of death the edit was in the journal and the
    // snapshot was still the old one. Only asserted when the kill genuinely beat the
    // debounce, so a slow machine reports a fact rather than a phantom failure.
    const beatTheDebounce = killGap < SAVE_DEBOUNCE_MS;
    const inJournal = journalHasCell(store, docId, 'A1');
    const snapAfterKill = store.snapshotDoc(docId);
    if (beatTheDebounce) {
      check(`the edit was in ${store.journalName} before the 400 ms debounce could fire`, inJournal,
        `killed ${killGap}ms after the edit`);
      check('the snapshot was still the old one (this is what used to be lost)',
        inputIn(snapAfterKill, sheet1, 'A1') === undefined,
        `snapshot A1=${JSON.stringify(inputIn(snapAfterKill, sheet1, 'A1'))}`);
    } else {
      note(`the kill took ${killGap}ms, past the ${SAVE_DEBOUNCE_MS}ms debounce; ` +
        'skipping the two "before the snapshot" assertions');
    }
    check('the killed process left no half-formed journal record before the last one',
      store.journalEntries(docId).slice(0, -1).every(({ rec }) => rec !== null),
      'every record but possibly the last must be complete');

    await boot('after case 1');
    const after1 = await fetchDoc(docId);
    check('the document still loads after a SIGKILL', after1.status === 200, `status=${after1.status}`);
    check('the acknowledged edit survived the crash', inputIn(after1.doc, sheet1, 'A1') === '42',
      `A1=${JSON.stringify(inputIn(after1.doc, sheet1, 'A1'))}`);
    check('the document is not empty', Object.keys(after1.doc?.sheets?.[0]?.cells || {}).length >= 1);

    // =========================================================================
    section('2. a burst of 50 edits, killed right after the last ack');
    // =========================================================================

    client = await joinDoc(docId, '다라');
    const BURST = 50;
    const burstIds = [];
    for (let i = 1; i <= BURST; i++) {
      const opId = `burst-${i}`;
      burstIds.push(opId);
      client.send({ t: 'edit', docId, sheetId: sheet1, opId, cells: { [`B${i}`]: { input: `값${i}` } } });
    }
    const burstStart = Date.now();
    for (const opId of burstIds) {
      const a = await client.await((f) => f.t === 'ack' && f.opId === opId, { label: `ack(${opId})`, timeout: 20000 });
      if (Number.isFinite(a.rev)) lastRev = Math.max(lastRev, a.rev);
    }
    const burstAcked = Date.now() - burstStart;
    check(`all ${BURST} edits were acknowledged`, client.acks().length >= BURST,
      `acks=${client.acks().length} in ${burstAcked}ms`);

    await crash();

    await boot('after case 2');
    const after2 = await fetchDoc(docId);
    const missing = [];
    const wrong = [];
    for (let i = 1; i <= BURST; i++) {
      const got = inputIn(after2.doc, sheet1, `B${i}`);
      if (got === undefined) missing.push(`B${i}`);
      else if (got !== `값${i}`) wrong.push(`B${i}=${JSON.stringify(got)}`);
    }
    check('every one of the 50 acknowledged edits survived the crash', missing.length === 0,
      `missing: ${missing.slice(0, 10).join(',')}${missing.length > 10 ? ` (+${missing.length - 10})` : ''}`);
    check('not one of them came back with a value nobody typed', wrong.length === 0, wrong.slice(0, 5).join(' '));
    check('the earlier edit is still there too', inputIn(after2.doc, sheet1, 'A1') === '42');
    check('rev did not go backwards across the crash', (after2.doc?.rev ?? -1) >= lastRev,
      `rev=${after2.doc?.rev} lastAckedRev=${lastRev}`);

    // =========================================================================
    section('3. killed BEFORE any ack — at worst the unacked work is missing');
    // =========================================================================

    client = await joinDoc(docId, '마바');
    const PRE = 12;
    const preFrames = [];
    for (let i = 1; i <= PRE; i++) {
      preFrames.push({ t: 'edit', docId, sheetId: sheet1, opId: `pre-${i}`, cells: { [`D${i}`]: { input: `미확인${i}` } } });
    }
    // Sent and killed inside ONE synchronous turn. Nothing is awaited in between, so this
    // harness cannot have read an ack before the kill syscall — which is the only way to be
    // sure the case is really testing unacknowledged work rather than a lost race.
    for (const frame of preFrames) client.send(frame);
    const ackedBeforeKill = new Set(client.acks().map((f) => f.opId));
    await crash();
    check('the kill genuinely beat every ack', ackedBeforeKill.size === 0,
      `${ackedBeforeKill.size} frame(s) were acknowledged first`);

    check('the journal left by a mid-flight crash is record-oriented and readable',
      store.journalEntries(docId).slice(0, -1).every(({ rec }) => rec !== null),
      'only the final record may ever be half-written');
    const snapAfterPre = store.snapshotDoc(docId);
    check('the snapshot left behind is a whole document, never a half-written one',
      snapAfterPre === null || (Array.isArray(snapAfterPre.sheets) && snapAfterPre.sheets.length > 0),
      store.atomicNote);

    await boot('after case 3');
    const after3 = await fetchDoc(docId);
    check('the document loads after a crash with work in flight', after3.status === 200, `status=${after3.status}`);
    check('the document is not empty', Object.keys(after3.doc?.sheets?.[0]?.cells || {}).length >= BURST);
    check('nothing acknowledged EARLIER was lost', inputIn(after3.doc, sheet1, 'A1') === '42'
      && inputIn(after3.doc, sheet1, `B${BURST}`) === `값${BURST}`);

    const brokenPre = [];
    let survivedPre = 0;
    for (let i = 1; i <= PRE; i++) {
      const got = inputIn(after3.doc, sheet1, `D${i}`);
      if (got !== undefined && got !== `미확인${i}`) brokenPre.push(`D${i}=${JSON.stringify(got)}`);
      if (got !== undefined) survivedPre++;
    }
    check('every unacknowledged cell is either exactly what was sent or absent — never garbled',
      brokenPre.length === 0, brokenPre.join(' '));
    check('the sheet list survived intact', after3.doc?.sheets?.length >= 1 && after3.doc?.sheets?.[0]?.id === sheet1);
    note(`${survivedPre}/${PRE} unacknowledged frames happened to land before the kill`);

    // This is the other half of the promise, and the reason the outbox keeps a frame until
    // its ack: whatever the crash swallowed is still in the tab, and re-sending it — the
    // same frames, the same opIds, exactly as `outbox.pending()` hands them back after a
    // `welcome` — makes the document whole again. The frames are idempotent
    // (last-write-wins per cell), so the ones that DID land are re-applied harmlessly.
    client = await joinDoc(docId, '마바2');
    for (const frame of preFrames) client.send(frame);
    let replayed = 0;
    for (const frame of preFrames) {
      await client.await((f) => f.t === 'ack' && f.opId === frame.opId, { label: `ack(${frame.opId})`, timeout: 15000 });
      replayed++;
    }
    check('every re-sent frame is acknowledged', replayed === PRE, `${replayed}/${PRE}`);
    const afterReplay = await fetchDoc(docId);
    const stillMissing = [];
    for (let i = 1; i <= PRE; i++) {
      if (inputIn(afterReplay.doc, sheet1, `D${i}`) !== `미확인${i}`) stillMissing.push(`D${i}`);
    }
    check('re-sending the outbox restores every frame the crash swallowed',
      stillMissing.length === 0, stillMissing.join(','));
    check('and re-applying the ones that had landed changed nothing else',
      inputIn(afterReplay.doc, sheet1, 'A1') === '42'
        && inputIn(afterReplay.doc, sheet1, `B${BURST}`) === `값${BURST}`);

    // =========================================================================
    section('4. a deliberately corrupted journal');
    // =========================================================================

    client = await joinDoc(docId, '사아');
    client.send({ t: 'edit', docId, sheetId: sheet1, opId: 'op-e1', cells: { E1: { input: '손상전' } } });
    const ackE = await client.await((f) => f.t === 'ack' && f.opId === 'op-e1', { label: 'ack(op-e1)' });
    lastRev = Math.max(lastRev, ackE.rev);
    await crash();

    check('the good record is in the journal before anything is corrupted', journalHasCell(store, docId, 'E1'),
      'the case is meaningless unless the journal really holds it');

    const damage = await store.plantCorruption(docId, sheet1, lastRev + 1);

    await boot('after corrupting the journal');
    const health = await fetch(`${BASE}/healthz`);
    check('the server still boots with a corrupt journal', health.ok, `status=${health.status}`);
    const after4 = await fetchDoc(docId);
    check('the document still loads', after4.status === 200, `status=${after4.status}`);
    check('every record BEFORE the bad ones survived', inputIn(after4.doc, sheet1, 'E1') === '손상전',
      `E1=${JSON.stringify(inputIn(after4.doc, sheet1, 'E1'))}`);
    check('and so did everything from the earlier cases',
      inputIn(after4.doc, sheet1, 'A1') === '42' && inputIn(after4.doc, sheet1, 'B7') === '값7');
    for (const skipped of damage.skipped) {
      check(skipped.label, inputIn(after4.doc, sheet1, skipped.a1) === undefined,
        `${skipped.a1}=${JSON.stringify(inputIn(after4.doc, sheet1, skipped.a1))}`);
    }
    check('replay continued past the garbage instead of stopping at it',
      inputIn(after4.doc, sheet1, damage.good.a1) === damage.good.input,
      `${damage.good.a1}=${JSON.stringify(inputIn(after4.doc, sheet1, damage.good.a1))}`);
    check('the recovered document was rewritten as a clean snapshot',
      await eventually(() => inputIn(store.snapshotDoc(docId), sheet1, damage.good.a1) === damage.good.input),
      'boot must leave the next boot a clean snapshot and an empty journal');
    lastRev = Math.max(lastRev, after4.doc?.rev ?? 0);

    // =========================================================================
    section('5. the snapshot deleted, the journal kept');
    // =========================================================================

    client = await joinDoc(docId, '자차');
    // A sheet op journals the whole document (SPEC 27.1), so the journal alone can rebuild
    // one from nothing — which is exactly what this case takes away everything else to test.
    client.send({ t: 'sheet', docId, op: 'add', name: '복구', opId: 'op-sheet' });
    const ackSheet = await client.await((f) => f.t === 'ack' && f.opId === 'op-sheet', { label: 'ack(op-sheet)' });
    lastRev = Math.max(lastRev, ackSheet.rev);
    client.send({ t: 'edit', docId, sheetId: sheet1, opId: 'op-g1', cells: { G1: { input: '스냅숏없음' } } });
    const ackG = await client.await((f) => f.t === 'ack' && f.opId === 'op-g1', { label: 'ack(op-g1)' });
    lastRev = Math.max(lastRev, ackG.rev);
    await crash();

    check('the journal holds the whole document plus the later edit',
      journalHasCell(store, docId, 'A1') && journalHasCell(store, docId, 'G1'));

    await store.removeSnapshotAndBackups(docId);
    check(`the snapshot and every backup are gone; only ${store.journalName} is left`,
      !store.hasSnapshot(docId) && store.hasJournal(docId) && store.backupCount(docId) === 0);

    await boot('with only the journal');
    const after5 = await fetchDoc(docId);
    check('the document loads from the journal alone', after5.status === 200, `status=${after5.status}`);
    check('the rebuilt document has its sheets', (after5.doc?.sheets?.length || 0) >= 2,
      `sheets=${after5.doc?.sheets?.map((s) => s.name).join('/')}`);
    check('the sheet added just before the crash is there',
      (after5.doc?.sheets || []).some((s) => s.name === '복구'));
    check('the cells came back', inputIn(after5.doc, sheet1, 'A1') === '42'
      && inputIn(after5.doc, sheet1, 'E1') === '손상전' && inputIn(after5.doc, sheet1, 'F1') === '쓰레기뒤');
    check('including the edit that landed after the sheet op',
      inputIn(after5.doc, sheet1, 'G1') === '스냅숏없음',
      `G1=${JSON.stringify(inputIn(after5.doc, sheet1, 'G1'))}`);
    const burstMissing5 = [];
    for (let i = 1; i <= BURST; i++) if (inputIn(after5.doc, sheet1, `B${i}`) !== `값${i}`) burstMissing5.push(`B${i}`);
    check('and all 50 burst cells', burstMissing5.length === 0, burstMissing5.slice(0, 10).join(','));
    check('a snapshot was written back immediately after the recovery',
      await eventually(() => store.hasSnapshot(docId)));

    // =========================================================================
    section('6. backups after a compaction, and GET /api/docs/:id/backups');
    // =========================================================================

    client = await joinDoc(docId, '카타');
    const rounds = ['첫번째', '두번째', '세번째'];
    for (let i = 0; i < rounds.length; i++) {
      client.send({ t: 'edit', docId, sheetId: sheet1, opId: `save-${i}`, cells: { [`H${i + 1}`]: { input: rounds[i] } } });
      await client.await((f) => f.t === 'ack' && f.opId === `save-${i}`, { label: `ack(save-${i})` });
      // Wait for the COMPACTION, not for a clock. Three separate compactions are what the
      // backup ladder below is counting, and a fixed sleep only happens to outlast the
      // debounce: on a cold machine two rounds can share one, and the ladder then fails for
      // a reason that has nothing to do with backups. The journal being empty is the last
      // step of the compaction in both stores — the file store rotates before it renames,
      // the database inserts its backup before saveSnapshot resolves — so it is the one
      // condition that means "the whole of this round's compaction is behind us".
      const folded = await eventually(
        () => inputIn(store.snapshotDoc(docId), sheet1, `H${i + 1}`) === rounds[i]
          && store.journalWeight(docId).empty,
        8000,
      );
      check(`compaction ${i + 1} of 3 folded its edit into the snapshot`, folded,
        store.journalWeight(docId).detail);
    }

    check('a compaction produced a backup (SPEC 27.2)', store.backupCount(docId) >= 1,
      `backups=${store.backupCount(docId)}`);
    check('a second compaction produced a second', store.backupCount(docId) >= 2);
    check('and a third produced a third', store.backupCount(docId) >= 3);

    const bak1 = store.backupDoc(docId, 1);
    check('a backup is a complete, readable document', !!bak1 && Array.isArray(bak1.sheets) && bak1.id === docId);
    // The ladder, not the offset: each older backup holds strictly less of the three
    // rounds than the one before it. The two stores differ by one step — the file store
    // rotates the snapshot it is REPLACING, the database keeps a copy of the one it just
    // WROTE — and neither reading changes what a backup is for, which is that older work
    // is still there to go back to.
    const ladder = [1, 2, 3].map((n) => {
      const backup = store.backupDoc(docId, n);
      return rounds.filter((_, i) => inputIn(backup, sheet1, `H${i + 1}`) !== undefined).length;
    });
    check('each older backup holds strictly less of the newest work',
      ladder[0] > ladder[1] && ladder[1] > ladder[2], `rounds per backup: ${ladder.join(' > ')}`);
    check('a backup still holds the old work, so a regretted edit is recoverable by hand',
      inputIn(bak1, sheet1, 'A1') === '42');

    if (store.kind === 'file') {
      // Exactly which snapshot each file is, which only the rotating store can promise.
      check('<id>.bak.1 is the snapshot the LAST save replaced',
        inputIn(bak1, sheet1, 'H2') === '두번째' && inputIn(bak1, sheet1, 'H3') === undefined,
        `H2=${JSON.stringify(inputIn(bak1, sheet1, 'H2'))} H3=${JSON.stringify(inputIn(bak1, sheet1, 'H3'))}`);
      const bak2 = store.backupDoc(docId, 2);
      check('<id>.bak.2 is the one before that',
        inputIn(bak2, sheet1, 'H1') === '첫번째' && inputIn(bak2, sheet1, 'H2') === undefined,
        `H1=${JSON.stringify(inputIn(bak2, sheet1, 'H1'))} H2=${JSON.stringify(inputIn(bak2, sheet1, 'H2'))}`);
    }

    const listRes = await fetch(`${BASE}/api/docs/${docId}/backups`);
    const list = listRes.ok ? await listRes.json() : null;
    check('GET /api/docs/:id/backups answers 200 with an array', listRes.ok && Array.isArray(list),
      `status=${listRes.status}`);
    check('it lists the backups that exist', (list || []).length >= 3, `n=${list?.length}`);
    check('newest first — index 1 is the head of the list', list?.[0]?.index === 1, `first=${JSON.stringify(list?.[0])}`);
    check('every entry names its backup', (list || []).every((b) => b.name === `${docId}.bak.${b.index}`));
    check('every entry carries a timestamp and a size', (list || []).every((b) => Number.isFinite(b.at) && b.size > 0),
      JSON.stringify(list?.[0]));
    const listedSize = list?.[0]?.size;
    const realSize = store.backupSize(docId, 1);
    check('the reported size is the real one', listedSize === realSize, `listed=${listedSize} real=${realSize}`);
    check('backups of an unknown document are a 404',
      (await fetch(`${BASE}/api/docs/zzzzzzzz/backups`)).status === 404);

    // Every compaction truncates the journal it just folded in, so the log does not grow
    // without bound — a durability mechanism that fills the disk is its own failure.
    const truncated = await eventually(() => store.journalWeight(docId).empty);
    check('the journal is truncated once its records are in the snapshot', truncated,
      store.journalWeight(docId).detail);

    // =========================================================================
    section('7. the same opId, applied twice, changes nothing twice');
    // =========================================================================
    //
    // A client replays its outbox after every reconnect, because a lost ack and a lost
    // frame look identical from its side. Cell writes survive that — last-write-wins makes
    // them idempotent — but a comment, a structural edit and a sheet op do not: replaying
    // them would post the comment twice, move the rows twice, make a second sheet.
    {
      const made = await fetch(`${BASE}/api/docs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '중복 방지' }),
      });
      const doc = await made.json();
      const sheetId = doc.sheets[0].id;
      const c = await joinDoc(doc.id, '중복');

      const opId = 'dup-comment-1';
      c.send({ t: 'comment', docId: doc.id, sheetId, op: 'add', cell: 'A1',
               text: '한 번만 달려야 합니다', opId });
      const ack1 = await c.await((f) => f.t === 'ack' && f.opId === opId, { label: 'first ack' });
      const mark0 = c.frames.length;
      c.send({ t: 'comment', docId: doc.id, sheetId, op: 'add', cell: 'A1',
               text: '한 번만 달려야 합니다', opId });
      const ack2 = await c.await((f) => f.t === 'ack' && f.opId === opId,
        { label: 'second ack', from: mark0 });
      check('a repeated opId is acknowledged again', !!ack2);
      check('and with the same rev, so the client sees one outcome', ack2.rev === ack1.rev,
        `${ack1.rev} vs ${ack2.rev}`);

      await sleep(400);
      const after = (await fetchDoc(doc.id)).doc;
      const thread = after.sheets[0].comments && after.sheets[0].comments.A1;
      check('the comment was posted exactly once',
        !!thread && thread.messages.length === 1,
        `messages=${thread ? thread.messages.length : 'none'}`);

      c.send({ t: 'edit', docId: doc.id, sheetId, cells: { A5: { input: '기준' } }, opId: 'seed-1' });
      await c.await((f) => f.t === 'ack' && f.opId === 'seed-1', { label: 'seed ack' });

      const structOp = 'dup-struct-1';
      c.send({ t: 'struct', docId: doc.id, sheetId, edit: { kind: 'insertRow', index: 0, count: 1 }, opId: structOp });
      await c.await((f) => f.t === 'ack' && f.opId === structOp, { label: 'struct ack' });
      const mark1 = c.frames.length;
      c.send({ t: 'struct', docId: doc.id, sheetId, edit: { kind: 'insertRow', index: 0, count: 1 }, opId: structOp });
      await c.await((f) => f.t === 'ack' && f.opId === structOp, { label: 'struct ack again', from: mark1 });
      await sleep(400);
      const after2b = (await fetchDoc(doc.id)).doc;
      const cells2 = after2b.sheets[0].cells || {};
      check('a replayed insertRow moved the rows only once',
        !!cells2.A6 && cells2.A6.input === '기준',
        `A6=${JSON.stringify(cells2.A6)} A7=${JSON.stringify(cells2.A7)}`);

      const sheetOp = 'dup-sheet-1';
      const beforeCount = ((await fetchDoc(doc.id)).doc).sheets.length;
      c.send({ t: 'sheet', docId: doc.id, op: 'add', name: '중복시트', opId: sheetOp });
      await c.await((f) => f.t === 'ack' && f.opId === sheetOp, { label: 'sheet ack' });
      const mark2 = c.frames.length;
      c.send({ t: 'sheet', docId: doc.id, op: 'add', name: '중복시트', opId: sheetOp });
      await c.await((f) => f.t === 'ack' && f.opId === sheetOp, { label: 'sheet ack again', from: mark2 });
      await sleep(400);
      const sheetCount = ((await fetchDoc(doc.id)).doc).sheets.length;
      check('a replayed sheet add made only one sheet', sheetCount === beforeCount + 1,
        `${beforeCount} -> ${sheetCount}`);

      c.close();
      await fetch(`${BASE}/api/docs/${doc.id}`, { method: 'DELETE' }).catch(() => {});
    }

    // =========================================================================
    section('8. an oversized frame is refused, and a legal large one is not');
    // =========================================================================
    //
    // The socket is created with maxPayload 256 KB and enforces it by CLOSING, before any
    // handler runs — so an oversized frame produces no error and no opId to retire. A
    // client that kept such a frame in its persisted outbox would replay it on every
    // reconnect, kill the socket every time, and never save that document again. The
    // client chunks by BYTES to stay under the limit; this pins the server side of that
    // contract.
    {
      const made = await fetch(`${BASE}/api/docs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '큰 프레임' }),
      });
      const doc = await made.json();
      const sheetId = doc.sheets[0].id;
      const c = await joinDoc(doc.id, '큰프레임');

      const okCells = {};
      for (let i = 1; i <= 300; i++) okCells['A' + i] = { input: 'x'.repeat(200) };
      c.send({ t: 'edit', docId: doc.id, sheetId, cells: okCells, opId: 'big-ok-1' });
      const okAck = await c.await((f) => f.t === 'ack' && f.opId === 'big-ok-1',
        { timeout: 8000, label: 'ack for a large but legal frame' }).catch(() => null);
      check('a large frame inside the client budget is accepted', !!okAck);

      const closed = new Promise((res) => c.ws.once('close', (code) => res(code)));
      const hugeCells = {};
      for (let i = 1; i <= 4000; i++) hugeCells['B' + i] = { input: 'y'.repeat(200) };
      try { c.send({ t: 'edit', docId: doc.id, sheetId, cells: hugeCells, opId: 'big-bad-1' }); }
      catch { /* the socket may reject it locally */ }
      const code = await Promise.race([closed, sleep(4000).then(() => null)]);
      check('a frame past the socket limit closes the connection rather than being applied',
        code !== null, `close code=${code}`);

      await sleep(500);
      const stored = (await fetchDoc(doc.id)).doc;
      const cells = (stored && stored.sheets[0].cells) || {};
      check('the oversized frame was not applied', !cells.B1);
      check('and the legal one before it survived', !!cells.A1);
      check('the server is still healthy', (await fetch(`${BASE}/healthz`)).ok);

      try { c.close(); } catch { /* already closed */ }
      await fetch(`${BASE}/api/docs/${doc.id}`, { method: 'DELETE' }).catch(() => {});
    }

    // The cases that need a real FILE — one that is present, correct and impossible to
    // open — and the two that need a real database.
    if (store.kind === 'file') await fileOnlyCases(store);
    if (store.kind === 'supabase') await supabaseOnlyCases(store);

    // =========================================================================
    section('cleanup');
    // =========================================================================

    const del = await fetch(`${BASE}/api/docs/${docId}`, { method: 'DELETE' });
    check('DELETE removes the document', del.ok, `status=${del.status}`);
    const cleared = await eventually(() => store.leftovers(docId).length === 0);
    check(`and every ${store.ownedNoun} it owned — snapshot, journal and backups`,
      cleared, store.leftovers(docId).join(', '));
    client.close();
    docId = null;
  } catch (e) {
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e);
    failures.push(`[${backendLabel}] threw: ${detail}`);
    console.log(`FAIL  [${backendLabel}] harness threw\n        ${detail}`);
  } finally {
    if (docId) {
      try {
        await fetch(`${BASE}/api/docs/${docId}`, { method: 'DELETE' });
      } catch {
        /* the server may be dead — fall through to removing it by hand */
      }
      await store.forceCleanup(docId);
    }
    await stopCleanly();
  }
}

// ---------------------------------------------------------------------------
// the file-only cases (SPEC 27.6, 29.2)
// ---------------------------------------------------------------------------

/**
 * A read that FAILED is never an empty document.
 *
 * These cases exist because a filesystem answers a read with three different things and
 * one careless `catch` turns them into two:
 *
 *   ABSENT   ENOENT. Nothing is stored. Create it, serve it empty, carry on.
 *   CORRUPT  the bytes arrived IN FULL and will not parse. Recover from a backup, count
 *            the bad lines, carry on — the damage has been SEEN.
 *   UNREAD   EACCES, EPERM, EIO, EBUSY. The data IS there and this process failed to see
 *            it. It licenses nothing whatsoever.
 *
 * They are file-only for a plain reason: only a file can be present, correct and
 * impossible to open. The database equivalent — a 2xx whose body cannot be read — is case
 * 11, and it pins the identical rule on the other backend.
 *
 * The injection is a real one. test/unreadable.js takes the operating system's read
 * permission off ONE file and verifies the denial took, so the errno the server gets is
 * the errno a locked file really produces, in the server's own process, across a real
 * restart. That last part is the whole point of doing it here rather than only in
 * test/unread.test.js: the earlier attempt at this fix passed every in-process test and
 * still lost the records at the NEXT boot, because refusing one destructive step is not a
 * quarantine — the document has to stop moving.
 */
async function fileOnlyCases(store) {
  // =========================================================================
  section('14. an unreadable journal is not an empty one');
  // =========================================================================
  //
  // Filed as ABSENT, an unreadable journal reads as "no records". Boot then serves the
  // document at the snapshot's rev while the acknowledged records sit unread in the log,
  // the next edit mints a rev that collides with them, and the compaction that follows
  // writes that shortened document over the snapshot and truncates the log.
  //
  // Truncation is the loud half and it is not the half that matters. A record whose rev is
  // no higher than the snapshot's is skipped by replay for ever (server.js replays only
  // what is NEWER), so the collision alone is fatal: the record can sit in a journal nobody
  // ever deleted and never be read again. That is what the assertions below are shaped
  // around, and it is why case 15 exists — the damage is only visible at the NEXT boot.
  //
  // So the record below lives in the journal and nowhere else at the moment the read is
  // denied, and the case drives the edit that used to do the damage.
  {
    const made = await fetch(`${BASE}/api/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '읽지 못한 저널' }),
    });
    const doc = await made.json();
    const id = doc.id;
    const sheetId = doc.sheets[0].id;

    try {
      const writer = await joinDoc(id, '저널쓰기');
      writer.send({ t: 'edit', docId: id, sheetId, opId: 'unread-1', cells: { A1: { input: '압축된 편집' } } });
      await writer.await((f) => f.t === 'ack' && f.opId === 'unread-1', { label: 'ack(unread-1)' });
      writer.close();

      // Let this document's compaction finish, so the snapshot holds A1 and the journal is
      // empty. Everything planted after this point is in the journal alone.
      await sleep(SAVE_DEBOUNCE_MS + 600);
      await stopCleanly();

      const compacted = store.snapshotDoc(id);
      check('the compaction put the first edit in the snapshot',
        inputIn(compacted, sheetId, 'A1') === '압축된 편집',
        `snapshot A1=${JSON.stringify(inputIn(compacted, sheetId, 'A1'))}`);

      // One acknowledged record, written by hand at the rev the server would have minted
      // for it. By hand rather than by racing the 400 ms debounce, because a case whose
      // setup depends on winning a race reports the race rather than the rule — and the
      // journal line IS the contract (SPEC 27.1), so a hand-written one is the real thing.
      const record = {
        t: 'edit', sheetId, cells: { Z9: { input: '읽지 못한 기록' } },
        rev: compacted.rev + 1, at: Date.now(),
      };
      await appendFile(journalPath(id), `${JSON.stringify(record)}\n`, 'utf8');
      check('the acknowledged record is in the journal and not in the snapshot',
        journalHasCell(store, id, 'Z9') && inputIn(compacted, sheetId, 'Z9') === undefined,
        `journal=${journalHasCell(store, id, 'Z9')}`);

      const journalBefore = readFileSync(journalPath(id));
      const snapshotBefore = readFileSync(snapshotPath(id));
      const backupsBefore = store.backupCount(id);

      const errno = denyReads(journalPath(id));
      note(`data/${id}.log is present, ${journalBefore.length} bytes, and now fails to open with ${errno}`);

      await boot('an unreadable journal');
      await sleep(250);
      const bootLog = serverLog.join('');

      const served = await fetchDocRaw(id);
      check('a document whose journal could not be read is never served for editing',
        served.status === 503, `status=${served.status}`);
      check('it is refused as unreadable, never as missing',
        served.status !== 404 && !!served.body && served.body.error === 'doc_unreadable',
        `body=${served.text.slice(0, 160)}`);
      check('the boot log names the document it did not open', bootLog.includes(id) && /읽지 못/.test(bootLog),
        bootLog.split('\n').filter((l) => l.includes(id)).join(' | ').slice(0, 200));

      const listed = await (await fetch(`${BASE}/api/docs`)).json();
      const entry = Array.isArray(listed) ? listed.find((d) => d && d.id === id) : null;
      check('the list still shows it, flagged, rather than pretending it is gone',
        !!entry && entry.unreadable === true, JSON.stringify(entry));

      // One unreadable file must never be an outage. Every OTHER document keeps working.
      const otherRes = await fetch(`${BASE}/api/docs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '멀쩡한 이웃' }),
      });
      const other = await otherRes.json();
      const neighbour = await joinDoc(other.id, '이웃');
      neighbour.send({ t: 'edit', docId: other.id, sheetId: other.sheets[0].id, opId: 'neighbour-1', cells: { A1: { input: '계속 동작' } } });
      const neighbourAck = await neighbour.await((f) => f.t === 'ack' && f.opId === 'neighbour-1',
        { label: 'ack(neighbour-1)', timeout: 8000 }).catch(() => null);
      check('another document is unaffected — one unreadable file is not an outage', !!neighbourAck);
      neighbour.close();

      // The step that actually destroyed the records: an editor gets in and mints a rev the
      // unread record already used, so the snapshot the debounce writes moves the document
      // past a record it does not contain — and replay will never look at it again.
      const attempt = await tryJoin(id, '못읽는문서');
      if (attempt.welcomed) {
        attempt.client.send({ t: 'edit', docId: id, sheetId, opId: 'unread-2', cells: { B1: { input: '덮어쓰는 편집' } } });
        await attempt.client.await((f) => f.t === 'ack' && f.opId === 'unread-2',
          { label: 'ack(unread-2)', timeout: 4000 }).catch(() => null);
        await sleep(SAVE_DEBOUNCE_MS + 800);
      }
      check('a quarantined document seats no editor at all', attempt.welcomed === false,
        'the socket handed out a welcome for a document nobody has been able to read');
      check('and the refusal tells the client to KEEP its unsent work',
        !!attempt.refusal && attempt.refusal.code === 'doc_unreadable' && attempt.refusal.retry === true,
        JSON.stringify(attempt.refusal));
      attempt.client.close();

      await stopCleanly();
      // Every path, not just the denied one: a store that got this wrong will have renamed
      // the file it could not read somewhere else in the ring, and the assertions below
      // have to be able to read it wherever it went.
      releaseAll(ownedPaths(id));

      // The FILES, not the API. SPEC 27.6 rests the whole stateless quarantine on one
      // claim about the disk — while a document is refused, NOTHING about it changes — so
      // that the next boot reads the same bytes and re-derives the same answer.
      const journalAfter = bytesAt(journalPath(id));
      check('the journal is byte for byte what it was',
        !!journalAfter && journalAfter.equals(journalBefore),
        `${journalAfter ? journalAfter.length : 'unreadable'} bytes now, ${journalBefore.length} before`);
      const snapshotAfter = bytesAt(snapshotPath(id));
      check('the snapshot was not overwritten either',
        !!snapshotAfter && snapshotAfter.equals(snapshotBefore),
        `${snapshotAfter ? snapshotAfter.length : 'unreadable'} bytes now, ${snapshotBefore.length} before`);
      check('and nothing was rotated into the backup ring',
        store.backupCount(id) === backupsBefore,
        `${store.backupCount(id)} backups now, ${backupsBefore} before`);

      // The one that says WHY the boot below can recover. Truncation is not the only way
      // to lose a journal record and it was never the interesting one: a snapshot whose
      // rev has climbed past a record makes replay skip it for ever, because replay applies
      // only what is NEWER than the document it is replaying onto. The record can then sit
      // in a journal nobody ever truncated and still never be read again. That is exactly
      // what the earlier attempt at this fix left behind.
      const revOnDisk = (store.snapshotDoc(id) || {}).rev;
      check('the rev on disk never climbed past the record nobody could read',
        Number.isFinite(revOnDisk) && revOnDisk < record.rev,
        `snapshot rev=${revOnDisk}, unread record rev=${record.rev} — replay will skip it for ever`);

      // =======================================================================
      section('15. THE RESTART — the records nobody could read come back');
      // =======================================================================
      //
      // This is the case that matters, and it is the one the previous attempt passed
      // everything else and still failed. Nothing about the document changed on disk while
      // it was quarantined, so this boot reads the very same bytes and reaches the answer
      // the first boot could not: the snapshot's rev never moved past the record the
      // journal is still holding, so replaying it is CORRECT.
      await boot('after the journal became readable again');
      const after = await fetchDocRaw(id);
      check('the document opens again once its journal can be read', after.status === 200,
        `status=${after.status}`);
      check('the acknowledged record nobody could read is in the document',
        inputIn(after.body, sheetId, 'Z9') === '읽지 못한 기록',
        `Z9=${JSON.stringify(inputIn(after.body, sheetId, 'Z9'))} — the record was lost`);
      check('together with everything the snapshot already held',
        inputIn(after.body, sheetId, 'A1') === '압축된 편집',
        `A1=${JSON.stringify(inputIn(after.body, sheetId, 'A1'))}`);
      check('and the document is editable again, so the restart really cleared it',
        !!(await (async () => {
          const c = await tryJoin(id, '복구후');
          const ok = c.welcomed;
          c.client.close();
          return ok;
        })()));

      await fetch(`${BASE}/api/docs/${other.id}`, { method: 'DELETE' }).catch(() => {});
    } catch (e) {
      reportThrow('case 14/15 (an unreadable journal)', e);
    } finally {
      releaseAll(ownedPaths(id));
      if (!server) await boot('recovering the harness after case 14');
      await fetch(`${BASE}/api/docs/${id}`, { method: 'DELETE' }).catch(() => {});
      await store.forceCleanup(id);
    }
  }

  // =========================================================================
  section('16. an unreadable <id>.json is never swapped for an older backup');
  // =========================================================================
  //
  // Filed as CORRUPT, an unreadable snapshot reads as "damaged": loadDoc steps over it to
  // <id>.bak.1 and the caller is told `fromBackup`, which makes server.js rewrite at once.
  // The rewrite rotates — the good copy this process never read becomes .bak.1, then
  // .bak.2 — and after BACKUP_COUNT saves it falls off the end of the ring and is gone.
  // Every edit between the backup and the snapshot goes with it.
  //
  // So the assertions below are about the FILE. "The API refused" is not enough: the
  // damage is a rename, and a rename leaves the API looking perfectly healthy.
  {
    const made = await fetch(`${BASE}/api/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '읽지 못한 스냅숏' }),
    });
    const doc = await made.json();
    const id = doc.id;
    const sheetId = doc.sheets[0].id;

    try {
      const c = await joinDoc(id, '스냅숏');
      c.send({ t: 'edit', docId: id, sheetId, opId: 'snap-1', cells: { A1: { input: '예전 값' } } });
      await c.await((f) => f.t === 'ack' && f.opId === 'snap-1', { label: 'ack(snap-1)' });
      // TWO compactions, waited for one at a time. The whole case rests on <id>.bak.1
      // holding the PREVIOUS snapshot, which only happens if these are two separate saves;
      // a fixed sleep that a loaded machine outruns collapses them into one and the case
      // then reports a rollback that never happened.
      const first = await eventually(
        () => inputIn(store.snapshotDoc(id), sheetId, 'A1') === '예전 값'
          && store.journalWeight(id).empty,
        8000,
      );
      check('the first compaction put the older value in the snapshot', first,
        store.journalWeight(id).detail);
      c.send({ t: 'edit', docId: id, sheetId, opId: 'snap-2', cells: { A1: { input: '최신 값' } } });
      await c.await((f) => f.t === 'ack' && f.opId === 'snap-2', { label: 'ack(snap-2)' });
      const second = await eventually(
        () => inputIn(store.snapshotDoc(id), sheetId, 'A1') === '최신 값'
          && store.journalWeight(id).empty,
        8000,
      );
      check('the second compaction replaced it, rotating the first into the ring', second,
        store.journalWeight(id).detail);
      c.close();
      await stopCleanly();

      check('the newest snapshot holds the newest value',
        inputIn(store.snapshotDoc(id), sheetId, 'A1') === '최신 값',
        `<id>.json A1=${JSON.stringify(inputIn(store.snapshotDoc(id), sheetId, 'A1'))}`);
      check('and <id>.bak.1 holds the one before it',
        inputIn(store.backupDoc(id, 1), sheetId, 'A1') === '예전 값',
        `<id>.bak.1 A1=${JSON.stringify(inputIn(store.backupDoc(id, 1), sheetId, 'A1'))}`);

      const newerBytes = readFileSync(snapshotPath(id));
      const olderBytes = readFileSync(backupPath(id, 1));
      const backupsBefore = store.backupCount(id);

      const errno = denyReads(snapshotPath(id));
      note(`data/${id}.json is present, ${newerBytes.length} bytes, and now fails to open with ${errno}`);

      await boot('an unreadable snapshot');
      await sleep(250);

      const served = await fetchDocRaw(id);
      check('a snapshot that could not be read is refused, never replaced by its backup',
        served.status === 503, `status=${served.status}`);
      check('and the older backup is never served in its place',
        inputIn(served.body, sheetId, 'A1') !== '예전 값',
        `served A1=${JSON.stringify(inputIn(served.body, sheetId, 'A1'))} — this is a silent rollback`);

      await stopCleanly();
      releaseAll(ownedPaths(id));

      const jsonAfter = bytesAt(snapshotPath(id));
      check('<id>.json still holds the newest snapshot, byte for byte',
        !!jsonAfter && jsonAfter.equals(newerBytes),
        'the good copy was renamed down the backup ring');
      const bak1After = bytesAt(backupPath(id, 1));
      check('<id>.bak.1 still holds the snapshot it always held',
        !!bak1After && bak1After.equals(olderBytes),
        bak1After && bak1After.equals(newerBytes) ? 'the unread snapshot was rotated into it' : '');
      check('the backup ring never turned', store.backupCount(id) === backupsBefore,
        `${store.backupCount(id)} backups now, ${backupsBefore} before`);

      await boot('after the snapshot became readable again');
      const after = await fetchDocRaw(id);
      check('and the newest value is what comes back after a restart',
        after.status === 200 && inputIn(after.body, sheetId, 'A1') === '최신 값',
        `status=${after.status} A1=${JSON.stringify(inputIn(after.body, sheetId, 'A1'))}`);
    } catch (e) {
      reportThrow('case 16 (an unreadable snapshot)', e);
    } finally {
      releaseAll(ownedPaths(id));
      if (!server) await boot('recovering the harness after case 16');
      await fetch(`${BASE}/api/docs/${id}`, { method: 'DELETE' }).catch(() => {});
      await store.forceCleanup(id);
    }
  }

  // =========================================================================
  section('17. ABSENT and CORRUPT keep exactly the behaviour they had');
  // =========================================================================
  //
  // The risk in narrowing what counts as recoverable is over-refusing: a server that
  // quarantines documents which are merely missing or repairable is an outage wearing the
  // costume of caution, and a quarantine costs a restart nobody can perform remotely. So
  // the other side of the line is pinned here, against a REAL boot, with the same document
  // planted three ways.
  {
    const made = await fetch(`${BASE}/api/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '복구되는 문서' }),
    });
    const doc = await made.json();
    const id = doc.id;
    const sheetId = doc.sheets[0].id;

    try {
      const c = await joinDoc(id, '복구');
      c.send({ t: 'edit', docId: id, sheetId, opId: 'recover-1', cells: { A1: { input: '되살아날 값' } } });
      await c.await((f) => f.t === 'ack' && f.opId === 'recover-1', { label: 'ack(recover-1)' });
      await sleep(SAVE_DEBOUNCE_MS + 600);
      c.close();
      await stopCleanly();

      // The one good snapshot every sub-case below is planted from, so none of them
      // inherits what the boot before it happened to rewrite.
      const good = readFileSync(snapshotPath(id));
      check('a good snapshot exists for the three plantings below',
        inputIn(JSON.parse(good.toString('utf8')), sheetId, 'A1') === '되살아날 값');

      // (i) CORRUPT: bytes that arrived in full and will not parse.
      await writeFile(snapshotPath(id), '{ 이것은 JSON 이 아닙니다 ', 'utf8');
      await writeFile(backupPath(id, 1), good);
      await boot('a corrupt snapshot with a good backup');
      const corrupt = await fetchDocRaw(id);
      check('a snapshot whose bytes will not parse still recovers from its backup',
        corrupt.status === 200 && inputIn(corrupt.body, sheetId, 'A1') === '되살아날 값',
        `status=${corrupt.status} A1=${JSON.stringify(inputIn(corrupt.body, sheetId, 'A1'))}`);
      check('a corrupt snapshot is NOT quarantined', corrupt.status !== 503);
      await stopCleanly();

      // (ii) ABSENT: the instant inside rotateBackups when <id>.json has been renamed away.
      await rm(snapshotPath(id), { force: true });
      await writeFile(backupPath(id, 1), good);
      await boot('a missing snapshot with a good backup');
      const absent = await fetchDocRaw(id);
      check('a missing <id>.json still recovers from <id>.bak.1 — the rotation window',
        absent.status === 200 && inputIn(absent.body, sheetId, 'A1') === '되살아날 값',
        `status=${absent.status} A1=${JSON.stringify(inputIn(absent.body, sheetId, 'A1'))}`);
      check('a missing snapshot is NOT quarantined', absent.status !== 503);
      await stopCleanly();

      // (iii) ABSENT: no journal at all, which is the ordinary state after a compaction.
      await writeFile(snapshotPath(id), good);
      await rm(journalPath(id), { force: true });
      await boot('a document with no journal');
      const noLog = await fetchDocRaw(id);
      check('a document with no journal at all opens normally',
        noLog.status === 200 && inputIn(noLog.body, sheetId, 'A1') === '되살아날 값',
        `status=${noLog.status}`);
      check('an absent journal is NOT quarantined', noLog.status !== 503);

      // And it is genuinely editable afterwards — the recoveries above did not leave the
      // document in some half-refusing state.
      const back = await joinDoc(id, '복구후편집');
      back.send({ t: 'edit', docId: id, sheetId, opId: 'recover-2', cells: { B1: { input: '이어서 편집' } } });
      const ack = await back.await((f) => f.t === 'ack' && f.opId === 'recover-2',
        { label: 'ack(recover-2)', timeout: 8000 }).catch(() => null);
      check('and a recovered document still acknowledges new work', !!ack);
      back.close();
    } catch (e) {
      reportThrow('case 17 (absent and corrupt)', e);
    } finally {
      if (!server) await boot('recovering the harness after case 17');
      await fetch(`${BASE}/api/docs/${id}`, { method: 'DELETE' }).catch(() => {});
      await store.forceCleanup(id);
    }
  }
}

// ---------------------------------------------------------------------------
// the Supabase-only cases (SPEC 29.3, 29.5)
// ---------------------------------------------------------------------------

async function supabaseOnlyCases(store) {
  const { fake, gate } = store;

  // =========================================================================
  section('9. a write the database refuses is NOT acknowledged');
  // =========================================================================
  //
  // The whole promise of an ack is that the record is safe (SPEC 27.3), and the client
  // stops holding an edit the moment one arrives. So a database that will not take the
  // insert must produce no ack at all — never an optimistic one — and the client must be
  // told to keep the frame and send it again.
  {
    const made = await fetch(`${BASE}/api/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '거절된 쓰기' }),
    });
    const doc = await made.json();
    const sheetId = doc.sheets[0].id;
    const c = await joinDoc(doc.id, '거절');

    // Let the document's own compaction finish first: an injected fault takes the NEXT
    // request, whatever it is, so the database has to be quiet for the fault to land on
    // the insert this case is about.
    await sleep(SAVE_DEBOUNCE_MS + 400);
    await quiesce(fake);
    const before = fake.requests.length;

    // One refused INSERT means every attempt at it refused: the store retries a 5xx twice
    // with a short backoff (SPEC 29.3), which is correct — a transient 502 from a hosted
    // database is ordinary — and it is exactly why "make it fail once" has to mean three.
    fake.failNext(3, 500);
    const frame = { t: 'edit', docId: doc.id, sheetId, opId: 'refused-1', cells: { A1: { input: '거절 후 재전송' } } };
    c.send(frame);

    const refusal = await c.await((f) => f.t === 'error' && f.opId === 'refused-1',
      { label: 'error(refused-1)', timeout: 15000 });
    check('a write the database refused answers with an error, not an ack', !!refusal);
    check('the refusal tells the client the frame is worth sending again', refusal.retry === true,
      JSON.stringify(refusal));
    check('no ack was sent for the refused write', c.acks().every((a) => a.opId !== 'refused-1'),
      `acks=${JSON.stringify(c.acks().map((a) => a.opId))}`);
    check('the refusal message carries no database detail and no key',
      typeof refusal.message === 'string' && !refusal.message.includes(SERVICE_KEY)
        && !refusal.message.includes('sz_journal'),
      JSON.stringify(refusal.message));

    const attempts = fake.requests.slice(before).filter((r) => r.status === 500);
    check('the insert really was attempted three times before giving up', attempts.length === 3,
      `attempts=${attempts.length}`);
    check('and every one of them was refused before it could store anything',
      !journalHasCell(store, doc.id, 'A1'));

    // The other half of SPEC 27.4: the client still holds it. Re-sending the very same
    // frame, with the very same opId, is what the outbox does, and now it must land.
    fake.clearFaults();
    c.send(frame);
    const ack = await c.await((f) => f.t === 'ack' && f.opId === 'refused-1',
      { label: 'ack(refused-1) after recovery', timeout: 15000 });
    check('re-sending the frame the client kept is acknowledged once the database is back', !!ack);
    check('and only then is the record in the journal', journalHasCell(store, doc.id, 'A1'));

    await crash();
    await boot('after a refused write');
    const after = await fetchDoc(doc.id);
    check('the value the client held onto survived a crash', inputIn(after.doc, sheetId, 'A1') === '거절 후 재전송',
      `A1=${JSON.stringify(inputIn(after.doc, sheetId, 'A1'))}`);

    c.close();
    await fetch(`${BASE}/api/docs/${doc.id}`, { method: 'DELETE' }).catch(() => {});
  }

  // =========================================================================
  section('10. a journal row appended DURING a snapshot survives the truncate');
  // =========================================================================
  //
  // SPEC 29.3: the truncate deletes up to the highest seq the snapshot INCLUDED, never
  // blanket. A blanket delete looks identical in every ordinary test, because one server
  // serialises its own operations and never appends while its own snapshot is in flight.
  // So the window is opened deliberately: the snapshot's upsert is held on the wire, and
  // a second writer — another server instance against the same store — appends a row into
  // the gap.
  {
    const made = await fetch(`${BASE}/api/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '스냅숏 중 기록' }),
    });
    const doc = await made.json();
    const sheetId = doc.sheets[0].id;
    const c = await joinDoc(doc.id, '동시');
    await quiesce(fake);

    c.send({ t: 'edit', docId: doc.id, sheetId, opId: 'snap-1', cells: { A1: { input: '스냅숏에 들어감' } } });
    const acked = await c.await((f) => f.t === 'ack' && f.opId === 'snap-1', { label: 'ack(snap-1)' });

    // Catch this document's snapshot upsert and stop it there. saveSnapshot reads the
    // journal's high-water mark BEFORE it writes, so from this instant everything
    // appended is above that mark and must survive the truncate that follows.
    const mark = fake.requests.length;
    const held = gate.holdNext('POST', 'sz_documents', `"${doc.id}"`);
    const caught = await Promise.race([held.arrived.then(() => true), sleep(20000).then(() => false)]);
    check('the compaction was caught with its snapshot upsert in flight', caught,
      'no snapshot upsert for this document reached the gate');
    if (!caught) gate.cancelHold();

    const during = {
      t: 'edit',
      sheetId,
      cells: { B1: { input: '스냅숏 도중' } },
      rev: (Number.isFinite(acked.rev) ? acked.rev : 0) + 1,
      at: Date.now(),
    };
    const inserted = await rest(fake, 'POST', 'sz_journal', {
      body: { doc_id: doc.id, rec: during, at: during.at },
      prefer: 'return=representation',
    });
    check('a second writer appended a journal row while the snapshot was in flight',
      inserted.status === 201 && Array.isArray(inserted.json) && inserted.json.length === 1,
      `status=${inserted.status}`);
    const insertedSeq = Number(inserted.json?.[0]?.seq);

    held.release();

    // The truncate is the last statement of the compaction; wait for it rather than for a
    // clock, so the assertions below are about a finished compaction.
    await waitFor(
      () => fake.requests.slice(mark).some((r) => r.method === 'DELETE' && r.table === 'sz_journal'),
      'the truncate that follows the snapshot',
    );
    await sleep(200);

    const snapshot = store.snapshotDoc(doc.id);
    check('the snapshot holds the edit that preceded it', inputIn(snapshot, sheetId, 'A1') === '스냅숏에 들어감',
      `A1=${JSON.stringify(inputIn(snapshot, sheetId, 'A1'))}`);
    check('and does NOT hold the row appended while it was being written',
      inputIn(snapshot, sheetId, 'B1') === undefined,
      'otherwise the case proves nothing: the row has to be outside the snapshot');

    const truncate = fake.requests.slice(mark)
      .filter((r) => r.method === 'DELETE' && r.table === 'sz_journal').at(-1);
    check('the truncate was bounded by a seq, never a blanket delete',
      !!truncate && truncate.filtered === true && /seq=lte\./.test(truncate.query)
        && /doc_id=eq\./.test(truncate.query),
      JSON.stringify(truncate));

    const remaining = store.journalEntries(doc.id);
    check('the row appended during the snapshot is still in the journal',
      remaining.some(({ rec }) => recordTouches(rec, 'B1')),
      `seq=${insertedSeq} rows left=${remaining.length}`);
    check('while the rows the snapshot did include were truncated away',
      !remaining.some(({ rec }) => recordTouches(rec, 'A1')),
      `rows left=${remaining.length}`);

    // Present is not the same as safe. The row only counts if a restart folds it back in.
    await crash();
    await boot('after a row appended during a snapshot');
    const after = await fetchDoc(doc.id);
    check('a restart replays it into the document', inputIn(after.doc, sheetId, 'B1') === '스냅숏 도중',
      `B1=${JSON.stringify(inputIn(after.doc, sheetId, 'B1'))}`);
    check('together with the edit the snapshot already held',
      inputIn(after.doc, sheetId, 'A1') === '스냅숏에 들어감');

    c.close();
    await fetch(`${BASE}/api/docs/${doc.id}`, { method: 'DELETE' }).catch(() => {});
  }

  // =========================================================================
  section('11. a 2xx whose body cannot be read is never taken for an empty journal');
  // =========================================================================
  //
  // A response can arrive with a 2xx and a body that does not parse: a proxy truncating a
  // large answer, a gateway substituting its own page, bytes lost on the way. The store
  // has exactly one safe reading of that, and it is "this request failed".
  //
  // The unsafe reading is what makes it a data-loss path rather than a nuisance. PostgREST
  // answers a GET with a JSON array, so a body that will not parse becoming `null` becomes
  // "no rows" one layer up, and "no rows" is a FACT the caller acts on: boot replays
  // nothing, the document comes back missing every uncompacted edit, and the first save
  // afterwards writes that shortened document over the good snapshot and truncates the
  // journal rows it never managed to read. Acknowledged work — work a client was told it
  // could forget — is then gone from both copies.
  //
  // So the edit below lives ONLY in the journal at the moment the read is spoiled.
  {
    const made = await fetch(`${BASE}/api/docs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '읽지 못한 응답' }),
    });
    const doc = await made.json();
    const sheetId = doc.sheets[0].id;
    const c = await joinDoc(doc.id, '본문손상');

    // Let this document's first compaction finish, so a snapshot exists and the journal is
    // empty. Everything after this point is in the journal and nowhere else.
    await sleep(SAVE_DEBOUNCE_MS + 400);
    await quiesce(fake);

    c.send({ t: 'edit', docId: doc.id, sheetId, opId: 'body-1', cells: { A1: { input: '저널에만 있는 값' } } });
    await c.await((f) => f.t === 'ack' && f.opId === 'body-1', { label: 'ack(body-1)' });
    await crash(); // before the debounce, so the value cannot be in the snapshot

    const inJournal = journalHasCell(store, doc.id, 'A1');
    const inSnapshot = inputIn(store.snapshotDoc(doc.id), sheetId, 'A1');
    check('the acknowledged edit is in the journal and not yet in the snapshot',
      inJournal && inSnapshot === undefined,
      `journal=${inJournal} snapshot=${JSON.stringify(inSnapshot)}`);

    const rowsBefore = store.journalEntries(doc.id).length;
    const mark = fake.requests.length;

    // Three, because an unreadable body is retried twice before the request gives up
    // (SPEC 29.3); one spoiled answer would simply be retried and would prove nothing.
    // Aimed at this document's rows alone, so the case cannot quietly become about
    // another document that happened to load first.
    fake.corruptNext({ count: 3, table: 'sz_journal', method: 'GET', contains: doc.id, mode: 'truncate' });

    const attempt = await bootOnce('a corrupted journal read');
    fake.clearFaults();

    if (attempt.healthy) {
      // Coming up is RIGHT: one document nobody could read must not be an outage for the
      // rest (SPEC 27.6). What may never happen is this document being SERVED, and there
      // are exactly two acceptable answers for it — the records were really read, or the
      // document is refused as unreadable. Serving it short is the failure, because a rev
      // that climbs past unread records is what the next compaction deletes them with.
      const served = await fetchDocRaw(doc.id);
      const a1 = inputIn(served.body, sheetId, 'A1');
      const refused = served.status === 503 && !!served.body && served.body.error === 'doc_unreadable';
      check('a boot whose journal read was corrupted never serves the document without its acknowledged edit',
        refused || a1 === '저널에만 있는 값',
        `A1=${JSON.stringify(a1)} status=${served.status} — an unreadable answer was read as an empty journal`);
      if (refused) note('the document was quarantined rather than served short');

      // Serving it short is only half the damage, and the recoverable half. The other
      // half arrives with the next save: whatever that boot read becomes the snapshot,
      // and the truncate that follows deletes the rows the snapshot is supposed to
      // contain — including the ones the read never saw. After that the record is in
      // neither copy. So a compaction is driven deliberately wherever the server will
      // still accept one, and afterwards the value has to be SOMEWHERE.
      const rowsAtBoot = store.journalEntries(doc.id).length;
      const follow = await tryJoin(doc.id, '후속');
      if (follow.welcomed) {
        follow.client.send({ t: 'edit', docId: doc.id, sheetId, opId: 'body-2', cells: { B1: { input: '그 뒤의 편집' } } });
        await follow.client.await((f) => f.t === 'ack' && f.opId === 'body-2',
          { label: 'ack(body-2)', timeout: 8000 }).catch(() => null);
        await sleep(SAVE_DEBOUNCE_MS + 600);
        await quiesce(fake);
      } else {
        check('a document refused as unreadable seats no editor either',
          !!follow.refusal && follow.refusal.code === 'doc_unreadable' && follow.refusal.retry === true,
          JSON.stringify(follow.refusal));
      }
      const stillInJournal = journalHasCell(store, doc.id, 'A1');
      const nowInSnapshot = inputIn(store.snapshotDoc(doc.id), sheetId, 'A1');
      check('and the compaction that follows never truncates rows that boot could not read',
        stillInJournal || nowInSnapshot === '저널에만 있는 값',
        `journal=${stillInJournal} (${store.journalEntries(doc.id).length} of ${rowsAtBoot} rows) `
          + `snapshot=${JSON.stringify(nowInSnapshot)} — the record is now in neither copy`);
      follow.client.close();
    } else {
      check('an answer the store could not read stops the boot instead of replaying nothing', true);
      note('the server refused to start rather than treat an unreadable body as an empty journal');
    }

    const deletes = fake.requests.slice(mark)
      .filter((r) => r.method === 'DELETE' && r.table === 'sz_journal');
    check('nothing was truncated on the strength of a read that failed', deletes.length === 0,
      `${deletes.length} DELETE(s) against sz_journal`);
    const rowsAfter = store.journalEntries(doc.id).length;
    check('and every journal row is still in the database', rowsAfter === rowsBefore,
      `${rowsAfter} of ${rowsBefore} rows left`);

    // The record only counts if it comes back. Once the answers are readable again, the
    // edit must replay into the document exactly as it always would have.
    if (server) await crash();
    await boot('after the corrupted journal read');
    const after = await fetchDoc(doc.id);
    check('the acknowledged edit is still there once the journal can be read again',
      inputIn(after.doc, sheetId, 'A1') === '저널에만 있는 값',
      `A1=${JSON.stringify(inputIn(after.doc, sheetId, 'A1'))}`);

    c.close();
    await fetch(`${BASE}/api/docs/${doc.id}`, { method: 'DELETE' }).catch(() => {});
  }

  // =========================================================================
  section('12. the service key never leaves the server');
  // =========================================================================
  //
  // The key bypasses RLS and opens the whole database (SPEC 29.3), so it is checked the
  // way tools/auth.mjs checks the password: not "we were careful" but "it is not there".
  {
    const surfaces = [
      ['GET /api/version', `${BASE}/api/version`],
      ['GET /healthz', `${BASE}/healthz`],
      ['GET /api/docs', `${BASE}/api/docs`],
      ['GET /edit', `${BASE}/edit`],
      ['GET /', `${BASE}/`],
    ];
    for (const [label, url] of surfaces) {
      const res = await fetch(url);
      const text = await res.text();
      check(`${label} does not contain the service key`, !text.includes(SERVICE_KEY));
    }
    // A 404 and a 400 are the two places a careless implementation echoes its request.
    const missing = await fetch(`${BASE}/api/docs/zzzzzzzz`);
    check('a 404 body does not contain the service key', !(await missing.text()).includes(SERVICE_KEY));
    const badBackups = await fetch(`${BASE}/api/docs/!!!/backups`);
    check('a rejected id does not echo the service key', !(await badBackups.text()).includes(SERVICE_KEY));

    check('no WebSocket frame in this whole run carried the service key', keyInWireFrames === false);
  }
}

// ---------------------------------------------------------------------------

function finish() {
  console.log('');
  console.log('========================================');
  if (failures.length === 0) {
    console.log(`crash: OK — ${passed} durability checks passed across ${boots} boots, on both backends.`);
    process.exit(0);
  }
  console.log(`crash: ${failures.length} FAILED (${passed} passed)\n`);
  for (const f of failures) console.log(`  - ${f}`);
  if (serverLog.length) {
    console.log('\n--- server output (last boot) ---');
    console.log(serverLog.join('').slice(-4000));
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------

if (!existsSync(join(ROOT, 'server.js'))) {
  console.error('crash: server.js does not exist yet');
  process.exit(2);
}

await mkdir(DATA, { recursive: true });

console.log(`crash: durability harness on :${PORT}`);

// The file backend runs FIRST, deliberately: it is what every other harness and every
// laptop uses, so a regression there must be visible before anything else.
const backends = [
  { label: 'file', make: fileBackend },
  { label: 'supabase', make: supabaseBackend },
];

for (const { label, make } of backends) {
  backendLabel = label;
  console.log(`\n########## backend: ${label} ##########`);
  // Built inside the try: standing a stand-in up can fail (a port, a missing file), and
  // that has to be reported as a failed backend rather than take the whole harness down
  // with the other backend's results unprinted.
  let store = null;
  try {
    store = await make();
    serverEnv = store.env;
    await store.setup();
    await runSuite(store);
  } catch (e) {
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e);
    failures.push(`[${label}] backend threw: ${detail}`);
    console.log(`FAIL  [${label}] backend threw\n        ${detail}`);
  } finally {
    if (store && store.kind === 'supabase') {
      // Only now is every line the server will ever print in hand, including whatever it
      // said on the way down.
      section('13. nothing the server printed carried the service key');
      check('the service key never appears in the server output', keyInServerOutput === false,
        'grep the boot log above for the key');
    }
    try {
      if (store) await store.teardown();
    } catch {
      /* the stand-in may already be down */
    }
  }
}

finish();
