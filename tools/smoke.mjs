#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the real server on a scratch port, then drives it exactly like two browsers
 * would: two WebSocket clients joining the same document, editing, watching each
 * other's edits arrive, adding and switching sheets, resizing columns, running a
 * structural edit, exporting CSV, and reconnecting. It also feeds the server
 * deliberately hostile input to prove it degrades instead of crashing.
 *
 * Unlike the unit tests, this exercises the wire protocol, the HTTP routes, the
 * persistence layer and the shared formula engine together — which is where a
 * spec-built-in-parallel codebase actually breaks.
 *
 * It also plants a REAL legacy (single-sheet) document file on disk before boot and
 * proves the server migrates it, because there are already such files in data/ and a
 * broken migration silently destroys a user's work.
 *
 * Usage: node tools/smoke.mjs
 * Exits non-zero on the first failed expectation.
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { harnessEnv, spawnServer } from './harness-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 39517);
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}/ws`;
const LEGACY_ID = 'smokev1';

let server = null;
let passed = 0;
const failures = [];
const serverLog = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (server && server.exitCode !== null) {
      throw new Error(`server exited early (code ${server.exitCode})\n${serverLog.join('')}`);
    }
    await sleep(200);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms\n${serverLog.join('')}`);
}

/** A WebSocket client that records every frame and can await a matching one. */
class Client {
  constructor(name) {
    this.name = name;
    this.frames = [];
    this.ws = null;
  }
  async open() {
    this.ws = new WebSocket(WSURL);
    this.ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { msg = { t: '<unparseable>', raw: buf.toString() }; }
      this.frames.push(msg);
    });
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`${this.name}: ws open timeout`)), 8000);
      this.ws.once('open', () => { clearTimeout(to); res(); });
      this.ws.once('error', (e) => { clearTimeout(to); rej(e); });
    });
    return this;
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  sendRaw(text) { this.ws.send(text); }
  /** Wait until a frame satisfying `pred` arrives (searching frames already received). */
  async await(pred, { timeout = 5000, label = 'frame', from = 0 } = {}) {
    const deadline = Date.now() + timeout;
    let i = from;
    while (Date.now() < deadline) {
      for (; i < this.frames.length; i++) {
        if (pred(this.frames[i])) return this.frames[i];
      }
      await sleep(25);
    }
    throw new Error(`${this.name}: timed out waiting for ${label}. Saw: ${this.frames.map((f) => f.t).join(',')}`);
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

function finish() {
  if (server && server.exitCode === null) server.kill();
  console.log('');
  if (failures.length === 0) {
    console.log(`smoke: OK — ${passed} checks passed.`);
    process.exit(0);
  }
  console.log(`smoke: ${failures.length} FAILED (${passed} passed)\n`);
  for (const f of failures) console.log(`  - ${f}`);
  if (serverLog.length) {
    console.log('\n--- server output ---');
    console.log(serverLog.join('').slice(-4000));
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------

if (!existsSync(join(ROOT, 'server.js'))) {
  console.error('smoke: server.js does not exist yet');
  process.exit(2);
}

await mkdir(join(ROOT, 'data'), { recursive: true });

// Plant a legacy v1 document (the pre-sheets shape) so boot-time migration is exercised
// against a real file rather than only in unit tests.
const legacyPath = join(ROOT, 'data', `${LEGACY_ID}.json`);
await writeFile(legacyPath, JSON.stringify({
  id: LEGACY_ID,
  name: '옛날 문서',
  rows: 120,
  cols: 18,
  cells: {
    A1: { input: '이월', style: { b: 1 } },
    A2: { input: '10' },
    A3: { input: '32' },
    A4: { input: '=SUM(A2:A3)' },
  },
  colWidths: { 0: 150 },
  rowHeights: { 2: 40 },
  frozenRows: 1,
  frozenCols: 0,
  createdAt: 1730000000000,
  updatedAt: 1730000000000,
  rev: 7,
}, null, 2), 'utf8');

console.log(`smoke: booting server on :${PORT}\n`);
// Through tools/harness-env.mjs, never spawn() directly. This harness writes documents
// and deletes them again, and server.js now reads .env at startup — so the backend and
// the gate are settled here, explicitly, instead of being inherited from whatever the
// operator has configured for their real deployment.
server = spawnServer({
  env: harnessEnv({ PORT: String(PORT) }, { label: 'smoke' }),
  label: 'smoke',
});
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));
server.on('exit', (code, sig) => {
  if (code !== 0 && code !== null) serverLog.push(`\n[server exited code=${code} signal=${sig}]\n`);
});

let docId = null;
try {
  await waitForServer();
  check('server boots and answers /healthz', true);

  // ------------------------------------------------- legacy document migration
  const legacyRes = await fetch(`${BASE}/api/docs/${LEGACY_ID}`);
  const legacy = legacyRes.ok ? await legacyRes.json() : null;
  check('a legacy v1 document still loads', !!legacy, `status=${legacyRes.status}`);
  if (legacy) {
    check('legacy document was migrated to sheets[]', Array.isArray(legacy.sheets) && legacy.sheets.length === 1,
      `sheets=${JSON.stringify(legacy.sheets)?.slice(0, 120)}`);
    const s0 = legacy.sheets?.[0] || {};
    check('migration kept the cells', s0.cells?.A4?.input === '=SUM(A2:A3)', `A4=${JSON.stringify(s0.cells?.A4)}`);
    check('migration kept the styles', s0.cells?.A1?.style?.b === 1);
    check('migration kept rows/cols', s0.rows === 120 && s0.cols === 18, `${s0.rows}x${s0.cols}`);
    check('migration kept colWidths/rowHeights', s0.colWidths?.['0'] === 150 && s0.rowHeights?.['2'] === 40);
    check('migration kept frozen panes', s0.frozenRows === 1);
    check('migration kept the document name', legacy.name === '옛날 문서');
    check('the migrated document has no stray top-level cells', legacy.cells === undefined);

    const onDisk = JSON.parse(await readFile(legacyPath, 'utf8'));
    check('the migration was written back to disk (it must not re-run every boot)',
      Array.isArray(onDisk.sheets), `keys=${Object.keys(onDisk).join(',')}`);

    const { SheetEngine } = await import(new URL('../shared/formula/engine.js', import.meta.url));
    const eng = new SheetEngine({ rows: s0.rows, cols: s0.cols, cells: s0.cells });
    check('the migrated sheet still computes its formula', eng.getValue('A4') === 42, `A4=${eng.getValue('A4')}`);
  }

  // ------------------------------------------------------------- HTTP routes
  // Routing: the site root is the document list, the editor is /edit. Old '/#doc='
  // links keep working because the hash never reaches the server — home.js redirects.
  const rootHtml = await (await fetch(`${BASE}/`)).text();
  check('GET / serves the document list page', /home\.js/.test(rootHtml) && /내 문서/.test(rootHtml),
    rootHtml.slice(0, 160).split(String.fromCharCode(10)).join(' '));
  const jsRes = await fetch(`${BASE}/js/main.js`);
  check('the app\'s own code is served with a revalidating cache header',
    /no-cache/.test(jsRes.headers.get('cache-control') || ''),
    `cache-control=${jsRes.headers.get('cache-control')}`);

  const editHtml = await (await fetch(`${BASE}/edit`)).text();
  check('GET /edit serves the editor', /js\/main\.js/.test(editHtml) && /sz-grid-root/.test(editHtml));
  check('the editor logo links to the document list', /class="sz-logo" href="\/"/.test(editHtml));

  const list = await (await fetch(`${BASE}/api/docs`)).json();
  check('GET /api/docs returns an array', Array.isArray(list));
  check('the document list carries a sheet count for the home page',
    list.every((d) => Number.isFinite(d.sheetCount)), JSON.stringify(list[0]));

  const doc = await (await fetch(`${BASE}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '스모크 테스트 시트' }),
  })).json();
  docId = doc.id;
  check('POST /api/docs creates a document', /^[a-z0-9]{6,24}$/.test(docId || ''), `id=${docId}`);
  check('a new document has exactly one sheet', Array.isArray(doc.sheets) && doc.sheets.length === 1,
    `sheets=${doc.sheets?.length}`);
  check('the sheet has an id and a name', !!doc.sheets?.[0]?.id && !!doc.sheets?.[0]?.name,
    JSON.stringify(doc.sheets?.[0])?.slice(0, 100));

  const sheet1 = doc.sheets[0].id;

  check('GET unknown doc returns 404', (await fetch(`${BASE}/api/docs/zzzzzzzz`)).status === 404);
  const trav = await fetch(`${BASE}/api/docs/..%2F..%2Fpackage`);
  check('path traversal in :id is rejected', trav.status === 400 || trav.status === 404, `status=${trav.status}`);

  // ------------------------------------------------------- realtime, two peers
  const a = await new Client('A').open();
  const b = await new Client('B').open();

  a.send({ t: 'hello', docId, name: '가나', color: '#e8710a' });
  const welcomeA = await a.await((f) => f.t === 'welcome', { label: 'welcome(A)' });
  check('A receives welcome with the full document', welcomeA.doc?.sheets?.length === 1 && !!welcomeA.you?.id);

  b.send({ t: 'hello', docId, name: '다라', color: '#1a73e8' });
  await b.await((f) => f.t === 'welcome', { label: 'welcome(B)' });
  const peersA = await a.await((f) => f.t === 'peers' && f.peers.length >= 2, { label: 'peers>=2' });
  check('A is told when B joins', peersA.peers.length >= 2);
  check('a peer record carries the sheet it is on', typeof peersA.peers[0].sheetId === 'string',
    JSON.stringify(peersA.peers[0]));

  a.send({
    t: 'edit', docId, sheetId: sheet1,
    cells: {
      A1: { input: '5' }, A2: { input: '7' }, A3: { input: '=SUM(A1:A2)' },
      B1: { input: '이름' }, B2: { input: '=IF(A3>10,"큼","작음")' },
    },
  });
  const editB = await b.await((f) => f.t === 'edit' && f.cells?.A3, { label: 'edit on B' });
  check('B receives A\'s edit', editB.cells.A3.input === '=SUM(A1:A2)');
  check('the edit broadcast names its sheet', editB.sheetId === sheet1, `sheetId=${editB.sheetId}`);

  // ---------------------------------------------------------------- sheet ops
  let mark = b.frames.length;
  a.send({ t: 'sheet', docId, op: 'add', name: '두번째' });
  const added = await b.await((f) => f.t === 'sheets', { label: 'sheets after add', from: mark });
  check('adding a sheet broadcasts the whole document', added.doc?.sheets?.length === 2,
    `sheets=${added.doc?.sheets?.length}`);
  const sheet2 = added.doc.sheets[1].id;
  check('the new sheet has the requested name', added.doc.sheets[1].name === '두번째');
  check('the new sheet has a distinct id', sheet2 && sheet2 !== sheet1);
  check('the first sheet still holds its cells', !!added.doc.sheets[0].cells?.A3);
  check('the new sheet starts empty', Object.keys(added.doc.sheets[1].cells || {}).length === 0);

  // edits are scoped per sheet
  a.send({ t: 'edit', docId, sheetId: sheet2, cells: { A1: { input: '100' } } });
  await b.await((f) => f.t === 'edit' && f.sheetId === sheet2, { label: 'edit on sheet2' });
  const after = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
  check('an edit lands only on its own sheet',
    after.sheets[1].cells?.A1?.input === '100' && after.sheets[0].cells?.A1?.input === '5',
    `s1.A1=${after.sheets[0].cells?.A1?.input} s2.A1=${after.sheets[1].cells?.A1?.input}`);

  const listWith2 = await (await fetch(`${BASE}/api/docs`)).json();
  check('sheetCount in the list follows a sheet being added',
    listWith2.find((d) => d.id === docId)?.sheetCount === 2,
    `sheetCount=${listWith2.find((d) => d.id === docId)?.sheetCount}`);

  mark = b.frames.length;
  a.send({ t: 'sheet', docId, op: 'rename', sheetId: sheet2, name: '집계' });
  const renamed = await b.await((f) => f.t === 'sheets', { label: 'sheets after rename', from: mark });
  check('renaming a sheet works', renamed.doc.sheets[1].name === '집계');

  mark = b.frames.length;
  a.send({ t: 'sheet', docId, op: 'rename', sheetId: sheet2, name: renamed.doc.sheets[0].name });
  const dup = await b.await((f) => f.t === 'sheets', { label: 'sheets after dup name', from: mark });
  check('a duplicate sheet name is made unique by the server',
    dup.doc.sheets[1].name !== dup.doc.sheets[0].name, `names=${dup.doc.sheets.map((s) => s.name).join('/')}`);

  mark = b.frames.length;
  a.send({ t: 'sheet', docId, op: 'color', sheetId: sheet2, color: '#e8710a' });
  const colored = await b.await((f) => f.t === 'sheets', { label: 'sheets after color', from: mark });
  check('a tab colour is stored', colored.doc.sheets[1].color === '#e8710a');

  mark = b.frames.length;
  a.send({ t: 'sheet', docId, op: 'duplicate', sheetId: sheet1 });
  const duped = await b.await((f) => f.t === 'sheets', { label: 'sheets after duplicate', from: mark });
  check('duplicating a sheet adds a third', duped.doc.sheets.length === 3);
  const copy = duped.doc.sheets.find((s) => s.id !== sheet1 && s.cells?.A3);
  check('the duplicate carries the original cells', copy?.cells?.A3?.input === '=SUM(A1:A2)');
  check('the duplicate has its own id', copy && copy.id !== sheet1);
  check('the duplicate has a distinct name', copy && copy.name !== duped.doc.sheets[0].name);

  mark = b.frames.length;
  a.send({ t: 'sheet', docId, op: 'reorder', sheetId: sheet2, index: 0 });
  const reordered = await b.await((f) => f.t === 'sheets', { label: 'sheets after reorder', from: mark });
  check('reordering moves the tab', reordered.doc.sheets[0].id === sheet2,
    `order=${reordered.doc.sheets.map((s) => s.id).join(',')}`);

  mark = b.frames.length;
  a.send({ t: 'sheet', docId, op: 'delete', sheetId: sheet2 });
  const deleted = await b.await((f) => f.t === 'sheets', { label: 'sheets after delete', from: mark });
  check('deleting a sheet removes it', !deleted.doc.sheets.some((s) => s.id === sheet2));

  // deleting down to one sheet, then refusing the last
  const remaining = deleted.doc.sheets.map((s) => s.id);
  for (const id of remaining.slice(1)) {
    mark = b.frames.length;
    a.send({ t: 'sheet', docId, op: 'delete', sheetId: id });
    await b.await((f) => f.t === 'sheets', { label: `sheets after delete ${id}`, from: mark });
  }
  const oneLeft = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
  check('deleting down to a single sheet works', oneLeft.sheets.length === 1, `n=${oneLeft.sheets.length}`);

  mark = a.frames.length;
  a.send({ t: 'sheet', docId, op: 'delete', sheetId: oneLeft.sheets[0].id });
  const refused = await a.await((f) => f.t === 'error', { timeout: 3000, label: 'error for last-sheet delete', from: mark })
    .catch(() => null);
  check('deleting the LAST sheet is refused', !!refused, 'expected an error frame');
  const stillOne = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
  check('the last sheet survived the refused delete', stillOne.sheets.length === 1);

  // unknown sheet id must never fall back to another sheet
  mark = a.frames.length;
  a.send({ t: 'edit', docId, sheetId: 'nosuch', cells: { Z9: { input: '오염' } } });
  const badSheet = await a.await((f) => f.t === 'error', { timeout: 3000, label: 'error for unknown sheetId', from: mark })
    .catch(() => null);
  check('an edit for an unknown sheetId is refused', !!badSheet);
  const unpolluted = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
  check('the unknown-sheet edit did not land anywhere', !unpolluted.sheets[0].cells?.Z9);

  const liveSheet = stillOne.sheets[0].id;

  // ------------------------------------------------------------- other frames
  b.send({ t: 'cursor', docId, sheetId: liveSheet, active: 'C4', range: { s: { row: 3, col: 2 }, e: { row: 3, col: 2 } } });
  const cur = await a.await((f) => f.t === 'cursor' && f.active === 'C4', { label: 'cursor relay' });
  check('a cursor is relayed with its sheet', cur.sheetId === liveSheet, `sheetId=${cur.sheetId}`);
  check('a cursor is not echoed to its sender', !b.frames.some((f) => f.t === 'cursor' && f.active === 'C4'));

  mark = b.frames.length;
  a.send({ t: 'meta', docId, sheetId: liveSheet, patch: { colWidths: { 2: 180 } } });
  const meta = await b.await((f) => f.t === 'meta', { label: 'meta', from: mark });
  check('a sheet meta patch is broadcast', meta.patch?.colWidths?.['2'] === 180 || meta.patch?.colWidths?.[2] === 180);

  mark = b.frames.length;
  a.send({ t: 'docmeta', docId, patch: { name: '이름 바꾼 문서' } });
  const dmeta = await b.await((f) => f.t === 'docmeta', { label: 'docmeta', from: mark });
  check('a document rename is broadcast', dmeta.patch?.name === '이름 바꾼 문서');

  // --------------------------------------------------- the formula still works
  const { SheetEngine } = await import(new URL('../shared/formula/engine.js', import.meta.url));
  const live = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
  const s = live.sheets[0];
  const eng = new SheetEngine({ rows: s.rows, cols: s.cols, cells: s.cells });
  check('=SUM(A1:A2) computes to 12 from the persisted sheet', eng.getValue('A3') === 12, `${eng.getValue('A3')}`);
  check('=IF(A3>10,"큼","작음") computes to 큼', eng.getValue('B2') === '큼');

  // ------------------------------------------------------------------- CSV
  const csvRes = await fetch(`${BASE}/api/docs/${docId}/csv?sheet=${liveSheet}`);
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
  const csv = new TextDecoder('utf-8').decode(csvBytes);
  check('CSV export responds text/csv', csvRes.ok && /csv/.test(csvRes.headers.get('content-type') || ''));
  check('CSV contains the COMPUTED value, not the formula', csv.includes('12') && !csv.includes('=SUM'));
  check('CSV starts with a UTF-8 BOM', csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf);
  check('CSV keeps Korean text intact', csv.includes('이름'));
  check('CSV for an unknown sheet is a 404',
    (await fetch(`${BASE}/api/docs/${docId}/csv?sheet=nosuch`)).status === 404);
  check('CSV with no sheet parameter still works', (await fetch(`${BASE}/api/docs/${docId}/csv`)).ok);

  // --------------------------------------------------------- structural edit
  mark = b.frames.length;
  a.send({ t: 'struct', docId, sheetId: liveSheet, edit: { kind: 'insertRow', index: 0, count: 1 } });
  const structB = await b.await((f) => f.t === 'struct', { timeout: 6000, label: 'struct', from: mark });
  check('a structural edit names its sheet', structB.sheetId === liveSheet);
  const s2 = structB.doc.sheets.find((x) => x.id === liveSheet);
  const eng2 = new SheetEngine({ rows: s2.rows, cols: s2.cols, cells: s2.cells });
  check('inserting a row moved A1 -> A2', eng2.getValue('A2') === 5, `${eng2.getValue('A2')}`);
  check('inserting a row rewrote the formula', eng2.getInput('A4') === '=SUM(A2:A3)', `${eng2.getInput('A4')}`);
  check('the rewritten formula still computes', eng2.getValue('A4') === 12);

  // ------------------------------------------------------------ hostile input
  const before = server.exitCode;
  a.sendRaw('this is not json at all {{{');
  const errFrame = await a.await((f) => f.t === 'error', { timeout: 3000, label: 'error for bad JSON' }).catch(() => null);
  check('malformed JSON gets an error frame, not a crash', !!errFrame);
  a.send({ t: 'edit', docId, sheetId: liveSheet, cells: null });
  a.send({ t: 'edit', docId: 'nonexistent', sheetId: liveSheet, cells: { A1: { input: '1' } } });
  a.send({ t: 'sheet', docId, op: 'nonsense', sheetId: liveSheet });
  a.send({ t: 'sheet', docId, op: 'reorder', sheetId: liveSheet, index: 9999 });
  a.send({ t: 'sheet', docId, op: 'rename', sheetId: liveSheet, name: 'x'.repeat(5000) });
  a.send({ t: 'cursor', docId, sheetId: 12345, active: {}, range: 'nope' });
  a.send({ t: 'nonsense-type', docId });
  await sleep(500);
  check('server survives a burst of malformed frames', server.exitCode === before && server.exitCode === null);
  check('server is still healthy after hostile input', (await fetch(`${BASE}/healthz`)).ok);
  const sane = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
  check('a 5000-char sheet name was capped', (sane.sheets[0].name || '').length <= 100,
    `len=${sane.sheets[0].name?.length}`);

  // -------------------------------------------------------------- reconnection
  b.close();
  await sleep(300);
  const shrunk = await a.await((f) => f.t === 'peers' && f.peers.length === 1, { timeout: 5000, label: 'peers=1' })
    .catch(() => null);
  check('peers list shrinks when a client disconnects', !!shrunk);

  const c = await new Client('C').open();
  c.send({ t: 'hello', docId, name: '마바', color: '#188038' });
  const welcomeC = await c.await((f) => f.t === 'welcome', { label: 'welcome(C)' });
  check('a late joiner receives the current document with sheets',
    welcomeC.doc.sheets.length === 1 && !!welcomeC.doc.sheets[0].cells?.A4);

  // --------------------------------------------------------------- persistence
  await sleep(900);
  const file = join(ROOT, 'data', `${docId}.json`);
  check('the document was persisted', existsSync(file));
  if (existsSync(file)) {
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    check('the persisted file has sheets[]', Array.isArray(onDisk.sheets));
    check('the persisted file round-trips the cells', !!onDisk.sheets?.[0]?.cells?.A4);
    check('the persisted rev advanced', typeof onDisk.rev === 'number' && onDisk.rev > 0);
  }

  a.close();
  c.close();

  check('DELETE /api/docs/:id removes the document', (await fetch(`${BASE}/api/docs/${docId}`, { method: 'DELETE' })).ok);
  await sleep(200);
  check('the data file is gone after delete', !existsSync(file));
  docId = null;
} catch (e) {
  failures.push(`threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  console.log(`  ✗ ${failures.at(-1)}`);
} finally {
  if (docId) {
    try { await fetch(`${BASE}/api/docs/${docId}`, { method: 'DELETE' }); } catch { /* ignore */ }
    try { await rm(join(ROOT, 'data', `${docId}.json`), { force: true }); } catch { /* ignore */ }
  }
  try { await fetch(`${BASE}/api/docs/${LEGACY_ID}`, { method: 'DELETE' }); } catch { /* ignore */ }
  try { await rm(legacyPath, { force: true }); } catch { /* ignore */ }
}

finish();
